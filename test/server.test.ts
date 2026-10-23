import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { BridgeClient } from '../bridge/client.js';
import { startBridge } from '../bridge/server.js';
import { pngSize } from '../bridge/screenshot.js';

const TOKEN = 'test-token-0123456789abcdef';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('png header reports pixel size', () => {
  assert.deepEqual(pngSize(PNG), { width: 1, height: 1 });
});

test('bridge auth, queue, screenshot file, and demo page', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hand-server-'));
  const server = await startBridge({ timeline: false,
    port: 0,
    token: TOKEN,
    demoDir: join(process.cwd(), 'demo'),
    screenshotDir: dir,
    authTimeoutMs: 300,
  });
  assert.equal(server.host, '127.0.0.1');
  try {
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    const healthBody = await health.json() as { extension: boolean; viewport: unknown };
    assert.equal(healthBody.extension, false);
    assert.equal(healthBody.viewport, null);
    const demo = await fetch(`http://127.0.0.1:${server.port}/demo`);
    const html = await demo.text();
    assert.match(html, /isTrusted/);
    assert.match(html, /Count trusted clicks/);
    assert.match(html, /Hover target/);
    assert.match(html, /role="combobox"/);

    await assert.rejects(() => BridgeClient.connect(server.port, 'not-the-token', 1000), /bad token/);
    await rejectedOrigin(server.port);

    const extension = await connectExtension(server.port);
    let active = 0;
    let maxActive = 0;
    extension.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; id?: string; method?: string; params?: { ref?: number } };
      if (msg.type !== 'command' || !msg.id) return;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const id = msg.id;
      const method = msg.method;
      setTimeout(() => {
        active -= 1;
        const payload = method === 'screenshot'
          ? { base64: PNG.toString('base64'), devicePixelRatio: 2, cssWidth: 100, cssHeight: 50 }
          : { method, ref: msg.params?.ref };
        extension.send(JSON.stringify({ type: 'result', id, ok: true, data: payload }));
      }, 40);
    });

    const client = await BridgeClient.connect(server.port, TOKEN);
    const [first, second] = await Promise.all([
      client.call('click', { ref: 1 }),
      client.call('click', { ref: 2 }),
    ]);
    assert.deepEqual(first, { method: 'click', ref: 1 });
    assert.deepEqual(second, { method: 'click', ref: 2 });
    assert.equal(maxActive, 1);

    const waited = await client.call('wait', { ms: 20 });
    assert.deepEqual(waited, { ms: 20 });

    const shot = await client.call('screenshot', {}) as { path: string; width: number; height: number; base64?: string };
    assert.equal(shot.base64, undefined);
    assert.equal(shot.width, 1);
    assert.equal(shot.height, 1);
    const bytes = await readFile(shot.path);
    assert.equal(bytes[0], 137);
    const after = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json() as { viewport: unknown };
    assert.deepEqual(after.viewport, { cssWidth: 100, cssHeight: 50, devicePixelRatio: 2 });
    client.close();
    extension.close();
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('observe keeps tab selection, snapshot, and screenshot in one queue job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hand-observe-'));
  const server = await startBridge({ timeline: false, port: 0, token: TOKEN, screenshotDir: dir });
  const extension = await connectExtension(server.port);
  const seen: string[] = [];
  extension.on('message', data => {
    const msg = JSON.parse(String(data)) as { type: string; id: string; method: string };
    if (msg.type !== 'command') return;
    seen.push(msg.method);
    const payload = msg.method === 'screenshot'
      ? { base64: PNG.toString('base64'), cssWidth: 1, cssHeight: 1, devicePixelRatio: 1 }
      : { tabId: 7, text: 'viewport 1x1 dpr 1', method: msg.method };
    setTimeout(() => extension.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data: payload })), 10);
  });
  try {
    const [observed] = await Promise.all([
      server.call('observe', { tabId: 7, includeScreenshot: true }),
      server.call('click', { ref: 1 }),
    ]) as [{ snapshot: { tabId: number }; screenshot: { path: string } }, unknown];
    assert.deepEqual(seen, ['select_tab', 'snapshot', 'screenshot', 'click']);
    assert.equal(observed.snapshot.tabId, 7);
    assert.deepEqual(await readFile(observed.screenshot.path), PNG);
    seen.length = 0;
    const textOnly = await server.call('observe') as { screenshot?: unknown };
    assert.deepEqual(seen, ['snapshot']);
    assert.equal(textOnly.screenshot, undefined);
  } finally {
    extension.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a bridge started with requireTrusted forwards it on click', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hand-server-'));
  const server = await startBridge({ timeline: false,
    port: 0,
    token: TOKEN,
    demoDir: join(process.cwd(), 'demo'),
    screenshotDir: dir,
    requireTrusted: true,
  });
  try {
    const extension = await connectExtension(server.port);
    const seen: Record<string, unknown>[] = [];
    extension.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; id?: string; params?: Record<string, unknown> };
      if (msg.type !== 'command' || !msg.id) return;
      seen.push(msg.params ?? {});
      extension.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data: { ok: true } }));
    });
    const client = await BridgeClient.connect(server.port, TOKEN);
    await client.call('click', { ref: 3 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ref, 3);
    assert.equal(seen[0].requireTrusted, true);
    client.close();
    extension.close();
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an occupied bridge port rejects without an unhandled WebSocket server error', async () => {
  const server = await startBridge({ timeline: false, port: 0, token: TOKEN });
  try {
    await assert.rejects(() => startBridge({ timeline: false, port: server.port, token: TOKEN }), { code: 'EADDRINUSE' });
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/health`)).ok, true);
  } finally {
    await server.close();
  }
});

async function connectExtension(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', role: 'extension', token: TOKEN, extensionId: 'test-extension' }));
  const raw = await once(ws, 'message');
  const msg = JSON.parse(String(raw)) as { type?: string };
  assert.equal(msg.type, 'auth_ok');
  return ws;
}

function rejectedOrigin(port: number): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://evil.example' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser origin was not rejected')), 2000);
    ws.on('error', () => undefined);
    ws.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function once(ws: WebSocket, event: 'open' | 'message'): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 2000);
    ws.once(event, (data: Buffer) => {
      clearTimeout(timer);
      resolve(data);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
