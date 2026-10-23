import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { homeDir } from './config.js';
import type { Hand } from './client.js';
import { DirectSession } from './direct.js';
import { materializeScreenshot } from './screenshot.js';
import { TRUSTED_INPUT_METHODS } from '../shared/input.js';
import { sleep } from '../shared/sleep.js';
import { normalizeCall } from '../shared/validate.js';
import { Timeline, operationResult, safeUrl, type Operation } from './timeline.js';
import { TimelineHttp } from './timeline-http.js';

type Job = {
  entry?: Operation; generation: number; started: boolean; cancelled: boolean;
  controller: AbortController; timer?: NodeJS.Timeout;
  resolve: (value: unknown) => void; reject: (error: Error) => void;
};

type Waiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type BridgeHandle = Hand & {
  port: number;
  host: string;
  close: () => Promise<void>;
  extensionConnected: () => boolean;
};

export type BridgeOptions = {
  port: number;
  token: string;
  demoDir?: string;
  screenshotDir?: string;
  authTimeoutMs?: number;
  timeline?: false | { dir?: string; maxEntries?: number; maxImageBytes?: number };
  /** When true, pointer, typing, and select commands fail instead of synthetic input. */
  requireTrusted?: boolean;
};

export function defaultDemoDir(): string {
  return fileURLToPath(new URL('../../demo', import.meta.url));
}

export async function startBridge(options: BridgeOptions): Promise<BridgeHandle> {
  const demoDir = options.demoDir ?? defaultDemoDir();
  const screenshotDir = options.screenshotDir ?? join(homeDir(), 'screenshots');
  const authTimeoutMs = options.authTimeoutMs ?? 5000;
  const token = options.token;
  let extension: WebSocket | null = null;
  let extensionId = '';
  const pending = new Map<string, Waiter>();
  const sent = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let direct: DirectSession | null = null;
  let viewport: { cssWidth: number; cssHeight: number; devicePixelRatio: number } | null = null;
  const requireTrusted = options.requireTrusted === true;
  const timelineOptions = options.timeline === false ? undefined : options.timeline;
  const timeline = options.timeline === false ? undefined : new Timeline(timelineOptions?.dir ?? join(homeDir(), 'timeline'), timelineOptions?.maxEntries, timelineOptions?.maxImageBytes);
  const jobs = new Set<Job>();
  let activeJob: Job | undefined;
  let generation = 0;
  let closing = false;
  let latestSnapshot: { tabId: string | number; items?: { ref: number; name: string }[] } | undefined;
  const panel = timeline ? new TimelineHttp(timeline, {
    token, page: fileURLToPath(new URL('../../ui/timeline.html', import.meta.url)), port: addressPort,
    connection: () => ({ extension: extension?.readyState === WebSocket.OPEN, mode: direct ? 'cdp' : 'extension', inFlight: sent.size }),
    pause, resume,
  }) : undefined;

  const httpServer = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (panel && (path === '/timeline' || path.startsWith('/timeline/'))) {
      void panel.handle(req, res).catch(error => {
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
      return;
    }
    void handleHttp(req, res, {
      demoDir,
      port: addressPort(),
      extensionConnected: () => extension?.readyState === WebSocket.OPEN,
      extensionId: () => extensionId,
      mode: () => (direct ? 'cdp' : 'extension'),
      cdp: () => (direct ? String(direct.status().url ?? '') : ''),
      viewport: () => viewport,
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('error', onError);
      reject(error);
    };
    httpServer.once('error', onError);
    httpServer.listen(options.port, '127.0.0.1', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  await timeline?.load();

  const wss = new WebSocketServer({ server: httpServer, maxPayload: 32 * 1024 * 1024 });

  function addressPort(): number {
    const address = httpServer.address();
    return typeof address === 'object' && address ? address.port : options.port;
  }

  const pingTimer = setInterval(() => {
    if (extension && extension.readyState === WebSocket.OPEN) {
      extension.send(JSON.stringify({ type: 'ping' }));
    }
  }, 20000);
  pingTimer.unref?.();

  wss.on('connection', (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !origin.startsWith('chrome-extension://')) {
      socket.close(4003, 'browser origins are not allowed');
      return;
    }
    let authed = false;
    let role: 'extension' | 'client' | null = null;
    const authTimer = setTimeout(() => {
      if (!authed) socket.close(4001, 'auth timeout');
    }, authTimeoutMs);

    socket.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        socket.close(4002, 'invalid json');
        return;
      }
      if (!authed) {
        if (msg.type !== 'auth' || (msg.role !== 'extension' && msg.role !== 'client')) {
          socket.close(4002, 'expected auth');
          return;
        }
        const presented = typeof msg.token === 'string' ? msg.token : '';
        if (presented.length < 8 || presented.length > 256 || !tokenOk(presented, token)) {
          socket.send(JSON.stringify({ type: 'auth_error', error: 'bad token' }));
          socket.close(4001, 'bad token');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        role = msg.role;
        if (role === 'extension') {
          if (extension && extension !== socket) {
            extension.close(4000, 'replaced');
            sent.clear();
            failPending('extension replaced; inspect the page before retrying');
          }
          extension = socket;
          extensionId = typeof msg.extensionId === 'string' ? msg.extensionId : '';
          console.error(`extension connected${extensionId ? ` (${extensionId})` : ''}`);
          socket.on('close', () => {
            if (extension === socket) {
              extension = null;
              extensionId = '';
              console.error('extension disconnected');
              sent.clear();
              failPending('extension disconnected');
            }
          });
        }
        socket.send(JSON.stringify({ type: 'auth_ok', role }));
        return;
      }
      if (msg.type === 'pong' || msg.type === 'ping') {
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (role === 'extension' && msg.type === 'result') {
        const id = typeof msg.id === 'string' ? msg.id : '';
        sent.delete(id);
        const waiter = pending.get(id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        pending.delete(id);
        if (msg.ok === true) waiter.resolve(msg.data);
        else waiter.reject(new Error(typeof msg.error === 'string' ? msg.error : 'command failed'));
        return;
      }
      if (role === 'client' && msg.type === 'command') {
        const id = typeof msg.id === 'string' ? msg.id : '';
        const method = typeof msg.method === 'string' ? msg.method : '';
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const timeout = typeof msg.timeout === 'number' ? msg.timeout : undefined;
        void call(method, params, timeout)
          .then((result) => {
            socket.send(JSON.stringify({ type: 'result', id, ok: true, data: result }));
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            socket.send(JSON.stringify({ type: 'result', id, ok: false, error: message }));
          });
      }
    });

    socket.on('close', () => clearTimeout(authTimer));
    socket.on('error', () => {
      socket.close();
    });
  });

  function failPending(message: string): void {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    pending.clear();
  }

  function forward(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!extension || extension.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('extension not connected. Load the extension and paste the token on its options page.'));
    }
    if (pending.size > 20) return Promise.reject(new Error('too many commands in flight'));
    const id = randomUUID();
    const socket = extension;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for the extension (${method})`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      sent.add(id);
      socket.send(JSON.stringify({ type: 'command', id, method, params }));
    });
  }

  async function dispatch(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (direct && method === 'new_tab') throw new Error('new_tab is only available in Chrome extension mode');
    if (method === 'observe') {
      if (params.tabId != null) await dispatch('select_tab', { tabId: params.tabId }, timeoutMs, signal);
      const snapshot = await dispatch('snapshot', {}, timeoutMs, signal);
      const screenshot = params.includeScreenshot ? await dispatch('screenshot', {}, timeoutMs, signal) : undefined;
      return { snapshot, ...(screenshot ? { screenshot } : {}) };
    }
    if (method === 'wait') {
      if (signal) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, params.ms as number);
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
      });
      else await sleep(params.ms as number);
      return { ms: params.ms };
    }
    if (method === 'attach_cdp') {
      const url = String(params.url ?? '');
      if (direct && direct.status().url === url) return direct.status();
      if (direct) {
        const previous = direct;
        direct = null;
        await previous.detach();
      }
      direct = await DirectSession.attach(url);
      return direct.status();
    }
    if (method === 'detach_cdp') {
      if (direct) {
        await direct.detach();
        direct = null;
      }
      return { attached: false, mode: 'extension' };
    }
    if (direct && DIRECT_METHODS.has(method)) {
      const data = await direct.call(method, params);
      if (method === 'screenshot') {
        const saved = await materializeScreenshot(data, { out: typeof params.out === 'string' ? params.out : undefined, dir: screenshotDir });
        noteViewport(saved);
        return saved;
      }
      noteObservation(method, data);
      return data;
    }
    const data = await forward(method, params, timeoutMs);
    if (method === 'screenshot') {
      const saved = await materializeScreenshot(data, { out: typeof params.out === 'string' ? params.out : undefined, dir: screenshotDir });
      noteViewport(saved);
      return saved;
    }
    noteObservation(method, data);
    return data;
  }

  function noteObservation(method: string, data: unknown): void {
    if (method === 'snapshot' && data && typeof data === 'object') latestSnapshot = data as typeof latestSnapshot;
    noteViewport(data);
  }

  function noteViewport(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const record = data as Record<string, unknown>;
    const cssWidth = record.cssWidth;
    const cssHeight = record.cssHeight;
    const devicePixelRatio = record.devicePixelRatio;
    if (typeof cssWidth !== 'number' || typeof cssHeight !== 'number' || typeof devicePixelRatio !== 'number') return;
    viewport = { cssWidth, cssHeight, devicePixelRatio };
  }

  function pausedError(): Error {
    return new Error('Automation paused for human takeover. Wait for the user to resume it in the timeline; do not retry or resume automatically.');
  }

  function pause(): void {
    if (!timeline) return;
    timeline.paused = true;
    generation += 1;
    for (const job of jobs) {
      if (!job.started) cancelJob(job, 'cancelled', pausedError());
      else job.controller.abort(pausedError());
    }
    timeline.changed();
  }

  function resume(): void {
    if (!timeline) return;
    if (activeJob || sent.size > 0) throw new Error('The action already sent is still finishing. Wait before returning control to the agent.');
    timeline.paused = false;
    timeline.changed();
  }

  function cancelJob(job: Job, status: 'cancelled' | 'expired', error: Error): void {
    if (job.cancelled) return;
    job.cancelled = true;
    clearTimeout(job.timer);
    jobs.delete(job);
    if (job.entry) timeline?.finish(job.entry, status, error.message);
    job.reject(error);
  }

  async function target(timeout: number): Promise<Operation['target']> {
    const result = await dispatch('list_tabs', {}, timeout) as {
      targetTabId?: string | number; tabs?: { id: string | number; title?: string; url?: string; active?: boolean }[];
    };
    const tab = result.tabs?.find(item => item.id === result.targetTabId) ?? result.tabs?.find(item => item.active);
    return tab ? { tabId: tab.id, title: (tab.title ?? '').slice(0, 200), url: safeUrl(tab.url ?? '') } : undefined;
  }

  async function runJob(job: Job, method: string, params: Record<string, unknown>, deadline: number): Promise<void> {
    if (job.cancelled) return;
    if (closing || timeline?.paused || job.generation !== generation) { cancelJob(job, 'cancelled', pausedError()); return; }
    if (Date.now() >= deadline) { cancelJob(job, 'expired', new Error('Request expired while waiting; no browser action was sent.')); return; }
    clearTimeout(job.timer);
    job.started = true;
    activeJob = job;
    const entry = job.entry;
    if (entry) { entry.status = 'running'; entry.startedAt = new Date().toISOString(); timeline?.changed(); }
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error('Request deadline exceeded; inspect the page before retrying.');
      return ms;
    };
    let data: unknown;
    let failure: Error | undefined;
    try {
      if (entry && method !== 'wait' && method !== 'reload_extension') {
        entry.target = await target(remaining()).catch(() => undefined);
        if (latestSnapshot && entry.target?.tabId === latestSnapshot.tabId && typeof params.ref === 'number') {
          entry.element = latestSnapshot.items?.find(item => item.ref === params.ref)?.name;
        }
        timeline?.changed();
      }
      data = await dispatch(method, params, remaining(), job.controller.signal);
      if (entry) entry.result = operationResult(method, data);
    } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    try {
      if (timeline && entry && !closing && !timeline.paused && !job.controller.signal.aborted && Date.now() < deadline) {
        if (method !== 'wait' && method !== 'reload_extension') entry.target = await target(Math.min(remaining(), 1000)).catch(() => entry.target);
        const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const shot = method === 'screenshot' ? data : method === 'observe' ? record.screenshot : undefined;
        if (shot) await timeline.capture(entry, shot);
        else if (timeline.captureScreenshots && CAPTURE_METHODS.has(method) && !isTimelineTarget(entry.target?.url, addressPort())) {
          if (timeline.paused || job.controller.signal.aborted) entry.screenshotError = 'Skipped during human takeover.';
          else {
            const captured = await dispatch('screenshot', { out: join(timeline.dir, `${entry.id}.png`) }, Math.min(remaining(), 2000), job.controller.signal);
            await timeline.capture(entry, captured);
          }
        }
      } else if (entry && CAPTURE_METHODS.has(method)) entry.screenshotError = 'Skipped during takeover, shutdown, or an expired request.';
    } catch (error) {
      if (entry) entry.screenshotError = error instanceof Error ? error.message : String(error);
    } finally {
      jobs.delete(job);
      activeJob = undefined;
      if (entry) timeline?.finish(entry, failure ? closing ? 'interrupted' : failure === job.controller.signal.reason ? 'cancelled' : 'failed' : 'succeeded', failure?.message);
      if (failure) job.reject(failure); else job.resolve(data);
    }
  }

  function call(method: string, rawParams?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (method === 'timeline') return panel ? Promise.resolve(panel.issueUrl()) : Promise.reject(new Error('Timeline is disabled.'));
    let normalized: { method: string; params: Record<string, unknown> };
    const raw = { ...(rawParams ?? {}) };
    if (requireTrusted && TRUSTED_INPUT_METHODS.has(method)) raw.requireTrusted = true;
    try { normalized = normalizeCall(method, raw); }
    catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    const entry = timeline?.add(normalized.method, normalized.params);
    if (closing || timeline?.paused) {
      if (entry) timeline?.finish(entry, 'cancelled', pausedError().message);
      return Promise.reject(pausedError());
    }
    if (jobs.size >= 50) {
      if (entry) timeline?.finish(entry, 'failed', 'The operation queue is full.');
      return Promise.reject(new Error('The operation queue is full.'));
    }
    const timeout = clampTimeout(timeoutMs ?? defaultTimeout(normalized.method, normalized.params));
    const deadline = Date.now() + timeout;
    return new Promise((resolve, reject) => {
      const job: Job = { entry, generation, started: false, cancelled: false, controller: new AbortController(), resolve, reject };
      job.timer = setTimeout(() => {
        if (!job.started) cancelJob(job, 'expired', new Error('Request expired while waiting; no browser action was sent.'));
      }, timeout);
      jobs.add(job);
      const work = chain.then(() => runJob(job, normalized.method, normalized.params, deadline));
      chain = work.catch(error => { jobs.delete(job); clearTimeout(job.timer); reject(error); });
    });
  }

  async function close(): Promise<void> {
    closing = true;
    generation += 1;
    if (activeJob && timeline) timeline.paused = true;
    for (const job of jobs) {
      if (!job.started) cancelJob(job, 'cancelled', new Error('Bridge shutting down; queued work was cancelled.'));
      else job.controller.abort(new Error('Bridge shutting down; inspect the page before retrying.'));
    }
    clearInterval(pingTimer);
    if (direct) {
      const session = direct;
      direct = null;
      await session.detach();
    }
    failPending('bridge shutting down');
    await chain;
    await timeline?.flush();
    for (const client of wss.clients) client.close(1001, 'bridge shutting down');
    wss.close();
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  const listening = httpServer.address();
  if (!listening || typeof listening === 'string') throw new Error('bridge did not bind a tcp port');

  return {
    port: listening.port,
    host: listening.address,
    call,
    close,
    extensionConnected: () => extension?.readyState === WebSocket.OPEN,
  };
}

function tokenOk(presented: string, expected: string): boolean {
  const key = 'agent-hand';
  const left = createHmac('sha256', key).update(presented).digest();
  const right = createHmac('sha256', key).update(expected).digest();
  return timingSafeEqual(left, right);
}

const CAPTURE_METHODS = new Set(['click', 'click_xy', 'hover', 'hover_xy', 'dblclick', 'dblclick_xy', 'right_click', 'right_click_xy', 'type', 'clear', 'fill', 'select', 'press', 'scroll', 'navigate', 'new_tab', 'select_tab', 'emulate']);

function isTimelineTarget(value: string | undefined, port: number): boolean {
  try { const url = new URL(value ?? ''); return ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === String(port) && url.pathname.startsWith('/timeline'); }
  catch { return false; }
}

const DIRECT_METHODS = new Set([
  'list_tabs',
  'select_tab',
  'navigate',
  'snapshot',
  'click',
  'hover',
  'dblclick',
  'right_click',
  'type',
  'clear',
  'fill',
  'select',
  'press',
  'scroll',
  'screenshot',
  'get_text',
  'click_xy',
  'hover_xy',
  'dblclick_xy',
  'right_click_xy',
  'locate',
  'wait_for_text',
  'wait_for_url',
  'wait_for_idle',
  'emulate',
  'console',
  'network_errors',
]);

function defaultTimeout(method: string, params: Record<string, unknown>): number {
  if (method === 'wait') return Number(params.ms) + 2000;
  if (method === 'wait_for_text' || method === 'wait_for_url' || method === 'wait_for_idle') {
    return Number(params.timeout ?? 10000) + 5000;
  }
  if (method === 'navigate' || method === 'new_tab') return 35000;
  return 25000;
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 25000;
  return Math.max(1, Math.min(120000, Math.floor(value)));
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    demoDir: string;
    port: number;
    extensionConnected: () => boolean;
    extensionId: () => string;
    mode: () => string;
    cdp: () => string;
    viewport: () => { cssWidth: number; cssHeight: number; devicePixelRatio: number } | null;
  },
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    const body = JSON.stringify({
      ok: true,
      extension: ctx.extensionConnected(),
      extensionId: ctx.extensionId(),
      mode: ctx.mode(),
      cdp: ctx.cdp(),
      port: ctx.port,
      viewport: ctx.viewport(),
    });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  if (url.pathname === '/demo' || url.pathname === '/demo/') {
    await sendFile(res, join(ctx.demoDir, 'index.html'), 'text/html; charset=utf-8', req.method === 'HEAD');
    return;
  }
  if (url.pathname === '/demo/vision.html') {
    await sendFile(res, join(ctx.demoDir, 'vision.html'), 'text/html; charset=utf-8', req.method === 'HEAD');
    return;
  }
  if (url.pathname === '/demo/iframe.html') {
    await sendFile(res, join(ctx.demoDir, 'iframe.html'), 'text/html; charset=utf-8', req.method === 'HEAD');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

async function sendFile(res: ServerResponse, path: string, contentType: string, head: boolean): Promise<void> {
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    res.end(head ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}
