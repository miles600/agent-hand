import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

export interface Hand {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class BridgeClient implements Hand {
  private readonly pending = new Map<string, Pending>();

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      let msg: { type?: string; id?: string; ok?: boolean; data?: unknown; error?: string };
      try {
        msg = JSON.parse(data.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.type !== 'result' || typeof msg.id !== 'string') return;
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.data);
      else waiter.reject(new Error(msg.error || 'command failed'));
    });
    ws.on('close', () => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('bridge connection closed'));
      }
      this.pending.clear();
    });
  }

  static async connect(port: number, token: string, timeoutMs = 5000): Promise<BridgeClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws, port, timeoutMs);
    try {
      await waitAuth(ws, token, timeoutMs);
    } catch (error) {
      ws.close();
      throw error;
    }
    return new BridgeClient(ws);
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('bridge connection is not open'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'command', id, method, params, timeout: timeoutMs }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

function waitOpen(ws: WebSocket, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`could not connect to the agent-hand bridge at 127.0.0.1:${port}. Is "agent-hand serve" running?`));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitAuth(ws: WebSocket, token: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge auth timed out')), timeoutMs);
    const onMessage = (data: unknown) => {
      let msg: { type?: string; error?: string };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'auth_ok') {
        cleanup();
        resolve();
      } else if (msg.type === 'auth_error') {
        cleanup();
        reject(new Error(msg.error || 'bad token'));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('bridge closed during auth'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.send(JSON.stringify({ type: 'auth', role: 'client', token }));
  });
}
