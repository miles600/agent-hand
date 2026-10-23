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
  let chain: Promise<void> = Promise.resolve();
  let direct: DirectSession | null = null;
  let viewport: { cssWidth: number; cssHeight: number; devicePixelRatio: number } | null = null;
  const requireTrusted = options.requireTrusted === true;

  const httpServer = createServer((req, res) => {
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
          if (extension && extension !== socket) extension.close(4000, 'replaced');
          extension = socket;
          extensionId = typeof msg.extensionId === 'string' ? msg.extensionId : '';
          console.error(`extension connected${extensionId ? ` (${extensionId})` : ''}`);
          socket.on('close', () => {
            if (extension === socket) {
              extension = null;
              extensionId = '';
              console.error('extension disconnected');
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
      socket.send(JSON.stringify({ type: 'command', id, method, params }));
    });
  }

  async function dispatch(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (method === 'wait') {
      await sleep(params.ms as number);
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
      noteViewport(data);
      return data;
    }
    const data = await forward(method, params, timeoutMs);
    if (method === 'screenshot') {
      const saved = await materializeScreenshot(data, { out: typeof params.out === 'string' ? params.out : undefined, dir: screenshotDir });
      noteViewport(saved);
      return saved;
    }
    noteViewport(data);
    return data;
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

  function call(method: string, rawParams?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    let normalized: { method: string; params: Record<string, unknown> };
    const raw = { ...(rawParams ?? {}) };
    if (requireTrusted && TRUSTED_INPUT_METHODS.has(method)) raw.requireTrusted = true;
    try {
      normalized = normalizeCall(method, raw);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const timeout = clampTimeout(timeoutMs ?? defaultTimeout(normalized.method, normalized.params));
    const job = chain.then(() => dispatch(normalized.method, normalized.params, timeout));
    chain = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  async function close(): Promise<void> {
    clearInterval(pingTimer);
    if (direct) {
      const session = direct;
      direct = null;
      await session.detach();
    }
    failPending('bridge shutting down');
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
  if (method === 'navigate') return 35000;
  return 25000;
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 25000;
  return Math.max(1000, Math.min(120000, Math.floor(value)));
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
