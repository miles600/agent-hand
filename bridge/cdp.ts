import { WebSocket } from 'ws';
import { assertLoopbackWebSocket, normalizeCdpUrl } from '../shared/cdp-url.js';

export type CdpTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const FORBIDDEN = new Set([
  'Browser.close',
  'Browser.crash',
  'Target.closeTarget',
  'Target.disposeBrowserContext',
  'Page.close',
]);

/**
 * One DevTools socket. Closing it detaches the debugger only.
 * Forbidden methods are refused before they are written, so a timeout cannot kill the app.
 */
export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => this.onMessage(data.toString()));
    socket.on('close', () => {
      this.closed = true;
      this.failAll('debugger connection closed');
    });
    socket.on('error', () => {
      this.socket.close();
    });
  }

  static async connect(wsUrl: string, timeoutMs = 5000): Promise<CdpConnection> {
    const url = assertLoopbackWebSocket(wsUrl);
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('could not open the debugger websocket'));
      }, timeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return new CdpConnection(socket);
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<T> {
    if (FORBIDDEN.has(method)) {
      return Promise.reject(new Error(`refusing ${method}; agent-hand does not close the attached app`));
    }
    if (!this.isOpen) return Promise.reject(new Error('debugger connection is not open'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(handler);
    this.listeners.set(method, set);
    return () => set.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll('debugger connection closed');
    this.socket.close();
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || 'debugger command failed'));
      else waiter.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      for (const handler of this.listeners.get(msg.method) ?? []) handler(msg.params);
    }
  }

  private failAll(message: string): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    this.pending.clear();
  }
}

export async function fetchCdpTargets(endpoint: string): Promise<{ browser: string; targets: CdpTarget[] }> {
  const origin = normalizeCdpUrl(endpoint);
  let version: { Browser?: string };
  let list: unknown;
  try {
    const [versionResponse, listResponse] = await Promise.all([
      fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(5000) }),
    ]);
    if (!versionResponse.ok || !listResponse.ok) {
      throw new Error(`CDP HTTP ${versionResponse.status}/${listResponse.status}`);
    }
    version = await versionResponse.json() as { Browser?: string };
    list = await listResponse.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not reach CDP at ${origin} (${message})`);
  }
  if (!Array.isArray(list)) throw new Error('CDP target list was not an array');
  const targets: CdpTarget[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const ws = typeof record.webSocketDebuggerUrl === 'string' ? record.webSocketDebuggerUrl : '';
    const type = typeof record.type === 'string' ? record.type : '';
    const url = typeof record.url === 'string' ? record.url : '';
    const title = typeof record.title === 'string' ? record.title : '';
    if (!id || !ws || !isDriveable(type, url)) continue;
    targets.push({
      id,
      type,
      title,
      url,
      webSocketDebuggerUrl: assertLoopbackWebSocket(ws),
    });
  }
  return { browser: version.Browser || 'Chromium', targets };
}

function isDriveable(type: string, url: string): boolean {
  if (type === 'browser' || type === 'service_worker' || type === 'worker' || type === 'shared_worker') return false;
  if (/^(devtools|chrome-devtools|chrome):/i.test(url)) return false;
  return type === 'page' || type === 'webview' || type === 'app' || type === 'other' || type === '';
}
