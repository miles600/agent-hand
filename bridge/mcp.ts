import { readFile } from 'node:fs/promises';
import { pngSize } from './screenshot.js';
import { TRUSTED_INPUT_METHODS } from '../shared/input.js';
import { TOOLS } from '../shared/tools.js';
import { VERSION } from '../shared/protocol.js';
import type { Hand } from './client.js';

const INSTRUCTIONS = 'Use timeline to show operation history and takeover controls. If paused, stop browser calls until the user resumes. Use list_tabs to find the user’s tab, then observe with tabId to select it and inspect current refs. Use includeScreenshot:true for visual work. Act on refs from the latest observation; observe again after navigation, scrolling, or page changes. Verify the expected page result before claiming success. Tool success only confirms delivery. Screenshots are MCP image content plus local file metadata; a client must pass the image to its model. Use one browser controller at a time.';

const SUPPORTED = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export function serveMcp(hand: Hand, options?: { requireTrusted?: boolean; images?: boolean }): Promise<void> {
  const images = options?.images ?? process.env.AGENT_HAND_MCP_IMAGES !== '0';
  const stdin = process.stdin;
  stdin.resume();
  let buffer = Buffer.alloc(0);

  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const end = buffer.indexOf('\n');
        if (end === -1) return;
        const body = buffer.subarray(0, end).toString('utf8').trim();
        buffer = buffer.subarray(end + 1);
        if (!body) continue;
        let message: Rpc;
        try {
          const parsed: unknown = JSON.parse(body);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
              (parsed as Rpc).jsonrpc !== '2.0' || typeof (parsed as Rpc).method !== 'string') {
            send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
            continue;
          }
          message = parsed as Rpc;
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
          continue;
        }
        void handle(hand, message, options?.requireTrusted === true, images);
      }
    };
    stdin.on('data', onData);
    stdin.on('end', () => {
      stdin.off('data', onData);
      resolve();
    });
  });
}

async function handle(hand: Hand, message: Rpc, requireTrusted: boolean, images: boolean): Promise<void> {
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
          instructions: INSTRUCTIONS,
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
      const args = { ...((params.arguments ?? {}) as Record<string, unknown>) };
      if (requireTrusted && TRUSTED_INPUT_METHODS.has(name)) args.requireTrusted = true;
      try {
        const data = await hand.call(name, args);
        const result = await toolResult(name, data, images);
        send({ jsonrpc: '2.0', id, result });
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

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };

async function toolResult(name: string, data: unknown, images: boolean): Promise<{ content: Content[]; isError: boolean }> {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const shot = name === 'screenshot' ? record : name === 'observe' ? record.screenshot : undefined;
  const content: Content[] = [];
  if (shot && typeof shot === 'object' && 'path' in shot && typeof shot.path === 'string') {
    if (images) {
      const bytes = await readFile(shot.path);
      pngSize(bytes);
      content.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
    }
    data = {
      ...record,
      imageDelivery: images ? 'image' : 'text-only',
      ...(images ? {} : { imageWarning: 'MCP images disabled by AGENT_HAND_MCP_IMAGES=0. Open the PNG with the client’s image-viewing tool before using visual coordinates.' }),
    };
  }
  content.unshift({ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  return { content, isError: false };
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
