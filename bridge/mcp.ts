import { TOOLS } from '../shared/tools.js';
import { VERSION } from '../shared/protocol.js';
import type { Hand } from './client.js';

const SUPPORTED = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export function serveMcp(hand: Hand): Promise<void> {
  const stdin = process.stdin;
  stdin.resume();
  let buffer = Buffer.alloc(0);

  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = buffer.subarray(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        const body = buffer.subarray(start, start + length).toString('utf8');
        buffer = buffer.subarray(start + length);
        let message: Rpc;
        try {
          message = JSON.parse(body) as Rpc;
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
          continue;
        }
        void handle(hand, message);
      }
    };
    stdin.on('data', onData);
    stdin.on('end', () => {
      stdin.off('data', onData);
      resolve();
    });
  });
}

async function handle(hand: Hand, message: Rpc): Promise<void> {
  const id = message.id;
  const method = message.method ?? '';
  const params = message.params ?? {};
  if (id === undefined || id === null) {
    return;
  }
  try {
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED.has(requested) ? requested : '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-hand', version: VERSION },
        },
      });
      return;
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'resources/list' || method === 'prompts/list') {
      send({ jsonrpc: '2.0', id, result: method === 'resources/list' ? { resources: [] } : { prompts: [] } });
      return;
    }
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const data = await hand.call(name, args);
        const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], isError: false },
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], isError: true },
        });
      }
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: text } });
  }
}

function send(message: unknown): void {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}
