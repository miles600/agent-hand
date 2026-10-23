import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection } from '../bridge/cdp.js';
import { DirectSession } from '../bridge/direct.js';
import { BridgeClient } from '../bridge/client.js';
import { startBridge } from '../bridge/server.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('direct CDP session falls back without closing the app', async () => {
  const mock = await startMock({ hangInput: true });
  try {
    const session = await DirectSession.attach(mock.origin, { script: '/* injected once */', inputTimeoutMs: 40 });
    try {
      assert.equal(mock.seen.includes('Page.navigate'), false);
      assert.equal(mock.seen.includes('Browser.close'), false);
      const listed = await session.call('list_tabs', {}) as { tabs: { id: string }[] };
      assert.equal(listed.tabs[0].id, 'TARGET1');
      const snap = await session.call('snapshot', {}) as { text: string; items: { ref: number; name: string }[] };
      assert.match(snap.text, /Save/);
      assert.match(snap.text, /Name/);
      const clicked = await session.call('click_xy', { x: 12, y: 20, duration: 0 }) as { via: string; warning?: string };
      assert.equal(clicked.via, 'synthetic');
      assert.match(clicked.warning ?? '', /DevTools/);
      assert.equal(mock.openSockets(), 1);
      const typed = await session.call('type', { ref: snap.items.find((item) => item.name === 'Name')?.ref, text: 'Ada' }) as { via: string; clickVia: string };
      assert.equal(typed.clickVia, 'synthetic');
      assert.equal(typed.via, 'synthetic');
      assert.equal(mock.seen.includes('Input.insertText'), false);
      assert.ok(mock.expressions.some((expression) => expression.includes('api["setValue"]')));
      const saveRef = snap.items.find((item) => item.name === 'Save')?.ref;
      const nameRefEarly = snap.items.find((item) => item.name === 'Name')?.ref;
      const hovered = await session.call('hover', { ref: saveRef, duration: 0 }) as { via: string };
      assert.equal(hovered.via, 'synthetic');
      assert.ok(mock.expressions.some((expression) => expression.includes('api["syntheticHover"]')));
      const doubled = await session.call('dblclick', { ref: saveRef, duration: 0 }) as { via: string };
      assert.equal(doubled.via, 'synthetic');
      const right = await session.call('right_click', { ref: saveRef, duration: 0 }) as { via: string };
      assert.equal(right.via, 'synthetic');
      const filled = await session.call('fill', { ref: nameRefEarly, text: 'Paris', duration: 0 }) as { via: string };
      assert.equal(filled.via, 'synthetic');
      const cleared = await session.call('clear', { ref: nameRefEarly, duration: 0 }) as { via: string; cleared: boolean };
      assert.equal(cleared.via, 'synthetic');
      assert.equal(cleared.cleared, true);
      const chosen = await session.call('select', { ref: saveRef, value: 'Green' }) as { via: string; kind: string; label: string };
      assert.equal(chosen.kind, 'native');
      assert.equal(chosen.via, 'synthetic');
      assert.equal(chosen.label, 'Green');
      await assert.rejects(
        () => session.call('wait_for_text', { text: 'missing-text', timeout: 0 }),
        /timed out after 0ms waiting for visible text/,
      );
      const pressed = await session.call('press', { key: 'Enter' }) as { via: string; warning?: string };
      assert.equal(pressed.via, 'synthetic');
      assert.match(pressed.warning ?? '', /DevTools/);
      assert.ok(mock.expressions.some((expression) => expression.includes('api["syntheticKey"]')));
      const scrolled = await session.call('scroll', { direction: 'down', amount: 100 }) as { via: string };
      assert.equal(scrolled.via, 'synthetic');
      const logs = await session.call('console', {}) as { messages: { text: string }[] };
      assert.ok(logs.messages.some((message) => message.text.includes('from cdp') || message.text.includes('from page')));
      const network = await session.call('network_errors', {}) as { errors: { status: number; url: string }[] };
      assert.ok(network.errors.some((error) => error.status === 404));
      assert.ok(network.errors.some((error) => error.status === 0 && error.url.includes('/api')));
      assert.equal(network.errors.some((error) => error.url.includes('/ok')), false);
      const nameRef = snap.items.find((item) => item.name === 'Name')?.ref;
      const syntheticClicks = () => mock.expressions.filter((expression) => expression.includes('syntheticClick')).length;
      const beforeTrusted = syntheticClicks();
      await assert.rejects(
        () => session.call('click_xy', { x: 12, y: 20, duration: 0, requireTrusted: true }),
        /Trusted input required[\s\S]*DevTools[\s\S]*Synthetic input was not sent/,
      );
      await assert.rejects(
        () => session.call('type', { ref: nameRef, text: 'nope', requireTrusted: true }),
        /Trusted input required[\s\S]*DevTools/,
      );
      await assert.rejects(
        () => session.call('press', { key: 'Enter', requireTrusted: true }),
        /Trusted input required[\s\S]*DevTools/,
      );
      const syntheticHovers = () => mock.expressions.filter((expression) => expression.includes('syntheticHover')).length;
      const beforeHover = syntheticHovers();
      await assert.rejects(
        () => session.call('hover', { ref: saveRef, duration: 0, requireTrusted: true }),
        /Trusted input required[\s\S]*Synthetic input was not sent/,
      );
      await assert.rejects(
        () => session.call('select', { ref: saveRef, value: 'Green', requireTrusted: true }),
        /native select/,
      );
      assert.equal(syntheticClicks(), beforeTrusted);
      assert.equal(syntheticHovers(), beforeHover);
      const emulated = await session.call('emulate', { preset: 'iphone' }) as {
        width: number;
        touch: boolean;
        applied: boolean;
        cssWidth: number;
        cssHeight: number;
      };
      assert.equal(emulated.width, 390);
      assert.equal(emulated.touch, true);
      assert.equal(emulated.applied, true);
      assert.equal(emulated.cssWidth, 390);
      assert.equal(emulated.cssHeight, 844);
      assert.ok(mock.seen.includes('Emulation.setDeviceMetricsOverride'));
      assert.equal(mock.seen.includes('Page.navigate'), false);
      const shot = await session.call('screenshot', {}) as { base64: string };
      assert.equal(shot.base64, PNG.toString('base64'));
      const clip = mock.captures[0] as { captureBeyondViewport?: boolean; clip?: { width: number; height: number; scale: number } };
      assert.equal(clip.captureBeyondViewport, false);
      assert.equal(clip.clip?.width, 390);
      assert.equal(clip.clip?.height, 844);
      assert.equal(clip.clip?.scale, 1);
      await assert.rejects(() => mock.connectAndForbid(), /does not close/);
      assert.equal(mock.seen.includes('Browser.close'), false);
      assert.equal(mock.seen.includes('Target.closeTarget'), false);
      assert.equal(mock.seen.includes('Page.close'), false);
    } finally {
      await session.detach();
    }
    const deadline = Date.now() + 500;
    while (mock.openSockets() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(mock.openSockets(), 0);
    const stillThere = await fetch(`${mock.origin}/json/version`);
    assert.equal(stillThere.ok, true);
    assert.equal(mock.seen.includes('Browser.close'), false);
  } finally {
    await mock.close();
  }
});

test('bridge routes page commands to CDP and then back to the extension', async () => {
  const mock = await startMock({ hangInput: false });
  const dir = await mkdtemp(join(tmpdir(), 'agent-hand-cdp-'));
  const server = await startBridge({
    port: 0,
    token: 'test-token-0123456789abcdef',
    demoDir: join(process.cwd(), 'demo'),
    screenshotDir: dir,
  });
  try {
    const client = await BridgeClient.connect(server.port, 'test-token-0123456789abcdef');
    const attached = await client.call('attach_cdp', { url: mock.origin }) as { mode: string; targetId: string };
    assert.equal(attached.mode, 'cdp');
    assert.equal(attached.targetId, 'TARGET1');
    const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json() as { mode: string; cdp: string };
    assert.equal(health.mode, 'cdp');
    assert.equal(health.cdp, mock.origin);
    const snap = await client.call('snapshot', {}) as { text: string; items: { ref: number; name: string }[] };
    assert.match(snap.text, /\[1\]/);
    const save = snap.items.find((item) => item.name === 'Save');
    const name = snap.items.find((item) => item.name === 'Name');
    const hovered = await client.call('hover', { ref: save?.ref, duration: 0 }) as { via: string };
    assert.equal(hovered.via, 'trusted');
    const filled = await client.call('fill', { ref: name?.ref, text: 'Paris', duration: 0 }) as { via: string };
    assert.equal(filled.via, 'trusted');
    assert.ok(mock.seen.includes('Input.insertText'));
    assert.ok(mock.seen.includes('Input.dispatchKeyEvent'));
    const found = await client.call('wait_for_text', { text: 'hello', timeout: 200 }) as { found: boolean };
    assert.equal(found.found, true);
    const idle = await client.call('wait_for_idle', { timeout: 2000 }) as { idle: boolean; via: string };
    assert.equal(idle.idle, true);
    assert.equal(idle.via, 'network');
    const shot = await client.call('screenshot', {}) as { path: string; base64?: string };
    assert.equal(shot.base64, undefined);
    assert.match(shot.path, /\.png$/);
    await client.call('detach_cdp', {});
    await assert.rejects(() => client.call('snapshot', {}), /extension not connected/);
    client.close();
    assert.equal(mock.seen.includes('Browser.close'), false);
    assert.equal(mock.seen.includes('Page.navigate'), false);
  } finally {
    await server.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

type Mock = {
  origin: string;
  seen: string[];
  expressions: string[];
  captures: Record<string, unknown>[];
  openSockets: () => number;
  connectAndForbid: () => Promise<void>;
  close: () => Promise<void>;
};

async function startMock(options: { hangInput: boolean }): Promise<Mock> {
  const seen: string[] = [];
  const expressions: string[] = [];
  const captures: Record<string, unknown>[] = [];
  const sockets = new Set<WebSocket>();
  const http = createServer((req, res) => handle(req, res, () => address(http)));
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => onCdp(socket, data.toString(), seen, expressions, captures, options.hangInput));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const port = address(http).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    expressions,
    captures,
    openSockets: () => [...sockets].filter((socket) => socket.readyState === 1).length,
    connectAndForbid: async () => {
      const connection = await CdpConnection.connect(`ws://127.0.0.1:${port}/devtools/page/TARGET1`);
      try {
        await connection.send('Browser.close');
      } finally {
        connection.close();
      }
    },
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.close();
      wss.close();
      http.close(() => resolve());
    }),
  };
}

function address(http: ReturnType<typeof createServer>): AddressInfo {
  const value = http.address();
  if (!value || typeof value === 'string') throw new Error('mock cdp port missing');
  return value;
}

function handle(req: IncomingMessage, res: ServerResponse, origin: () => AddressInfo): void {
  const port = origin().port;
  if (req.url?.startsWith('/json/version')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      Browser: 'Chrome/120.0.0.0',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/1`,
    }));
    return;
  }
  if (req.url?.startsWith('/json/list')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{
      id: 'TARGET1',
      type: 'page',
      title: 'Electron',
      url: 'app://./index.html',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/TARGET1`,
    }]));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
}

function onCdp(
  socket: WebSocket,
  raw: string,
  seen: string[],
  expressions: string[],
  captures: Record<string, unknown>[],
  hangInput: boolean,
): void {
  const msg = JSON.parse(raw) as { id?: number; method?: string; params?: { expression?: string } };
  if (msg.method) seen.push(msg.method);
  if (msg.method === 'Page.captureScreenshot') captures.push((msg.params ?? {}) as Record<string, unknown>);
  if (msg.id == null || !msg.method) return;
  if (hangInput && msg.method.startsWith('Input.')) return;
  if (msg.method === 'Runtime.enable') {
    send(socket, {
      method: 'Runtime.executionContextCreated',
      params: { context: { id: 7, origin: 'app://.', auxData: { frameId: 'MAIN', isDefault: true, type: 'default' } } },
    });
    send(socket, {
      method: 'Runtime.consoleAPICalled',
      params: { type: 'warning', args: [{ type: 'string', value: 'from cdp' }] },
    });
    send(socket, {
      method: 'Runtime.exceptionThrown',
      params: { exceptionDetails: { text: 'boom', exception: { description: 'Error: boom' } } },
    });
    reply(socket, msg.id, {});
    return;
  }
  if (msg.method === 'Network.enable') {
    send(socket, { method: 'Network.requestWillBeSent', params: { requestId: 'r1', request: { url: 'https://example.test/api' } } });
    send(socket, { method: 'Network.loadingFailed', params: { requestId: 'r1', errorText: 'net::ERR_FAILED' } });
    send(socket, { method: 'Network.responseReceived', params: { requestId: 'r2', response: { url: 'https://example.test/missing', status: 404, statusText: 'Not Found' } } });
    send(socket, { method: 'Network.responseReceived', params: { requestId: 'r3', response: { url: 'https://example.test/ok', status: 200, statusText: 'OK' } } });
    reply(socket, msg.id, {});
    return;
  }
  if (msg.method === 'Runtime.evaluate') {
    const expression = msg.params?.expression ?? '';
    expressions.push(expression);
    reply(socket, msg.id, { result: { type: 'object', value: evalMock(expression) } });
    return;
  }
  if (msg.method === 'Page.getFrameTree') {
    reply(socket, msg.id, { frameTree: { frame: { id: 'MAIN', url: 'app://./index.html' } } });
    return;
  }
  if (msg.method === 'Page.captureScreenshot') {
    reply(socket, msg.id, { data: PNG.toString('base64') });
    return;
  }
  reply(socket, msg.id, {});
}

function evalMock(expression: string): unknown {
  const method = expression.match(/api\["([^"]+)"\]/)?.[1] ?? '';
  if (method === 'collect') {
    return {
      elements: [
        { ahId: 'btn', role: 'button', name: 'Save', x: 8, y: 12, width: 80, height: 32, disabled: false },
        { ahId: 'field', role: 'textbox', name: 'Name', x: 8, y: 60, width: 120, height: 28, disabled: false },
      ],
    };
  }
  if (method === 'metrics') return { cssWidth: 390, cssHeight: 844, devicePixelRatio: 3 };
  if (method === 'prepare') return { x: 48, y: 28, width: 80, height: 32 };
  if (method === 'frameOffset') return { x: 0, y: 0 };
  if (method === 'pageInfo') return { href: 'app://./index.html', title: 'Electron' };
  if (method === 'text') return 'hello page';
  if (method === 'setValue') return true;
  if (method === 'selectOption') return { action: 'native', value: 'green', label: 'Green' };
  if (method === 'syntheticClick') return { tag: 'uni-button', text: 'OK' };
  if (method === 'syntheticHover') return { tag: 'button', text: 'Hover' };
  if (method === 'syntheticDblclick') return { tag: 'button', text: 'Double' };
  if (method === 'syntheticRightClick') return { tag: 'button', text: 'Menu' };
  if (method === 'syntheticKey') return { acted: true };
  if (method === 'syntheticScroll') return true;
  if (method === 'locate') return [{ text: 'OK', tag: 'uni-button', x: 10, y: 20, width: 40, height: 20 }];
  if (method === 'consoleEntries') return [{ level: 'log', text: 'from page', time: 1, source: 'page' }];
  if (!method) return { installed: true };
  return true;
}

function reply(socket: WebSocket, id: number, result: unknown): void {
  send(socket, { id, result });
}

function send(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}
