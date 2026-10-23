import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { BridgeClient } from '../bridge/client.js';
import { startBridge } from '../bridge/server.js';
import { safeTitle, Timeline } from '../bridge/timeline.js';

const TOKEN = 'timeline-test-token-0123456789';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('timeline headings mask URL-derived titles and preserve normal titles', async () => {
  for (const title of [
    'https://user:password@example.test/form?token=secret#private',
    'example.test/form?token=secret#private',
    'Read https://example.test/form?token=secret#private',
  ]) {
    const safe = safeTitle(title);
    for (const secret of ['token=secret', 'user:password', '#private']) assert.ok(!safe.includes(secret), safe);
  }
  assert.equal(safeTitle('James Webb Space Telescope - Wikipedia'), 'James Webb Space Telescope - Wikipedia');
  const dir = await mkdtemp(join(tmpdir(), 'agent-hand-title-migration-'));
  try {
    const store = new Timeline(dir);
    const entry = store.add('scroll', { direction: 'down' });
    entry.target = { tabId: 7, title: 'example.test/form?token=secret', url: 'https://example.test/form?token=%5Bredacted%5D' };
    store.finish(entry, 'failed');
    await store.flush();
    const restored = new Timeline(dir);
    await restored.load();
    await restored.flush();
    assert.ok(!JSON.stringify(restored.entries).includes('token=secret'));
    assert.ok(!(await readFile(join(dir, 'history.json'), 'utf8')).includes('token=secret'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('timeline persists bounded records and images, masks inputs, and marks interrupted work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hand-timeline-store-'));
  try {
    const store = new Timeline(dir, 3, PNG.length);
    const png = join(dir, 'source.png');
    await writeFile(png, PNG);
    const first = store.add('fill', { text: 'private-password', url: 'https://user:password@example.test/form?token=secret#private' });
    store.finish(first, 'succeeded');
    await store.capture(first, { path: png });
    const second = store.add('click', { ref: 1 });
    store.finish(second, 'succeeded');
    await store.capture(second, { path: png });
    assert.equal(first.screenshot, undefined);
    assert.ok(second.screenshot);
    const third = store.add('navigate', { url: 'https://example.test' });
    third.status = 'running';
    store.changed();
    await store.flush();
    const saved = await readFile(join(dir, 'history.json'), 'utf8');
    for (const secret of ['private-password', 'token=secret', 'user:password', '#private']) assert.ok(!saved.includes(secret), secret);
    await assert.rejects(store.image(first.id), /not found/);
    assert.deepEqual(await store.image(second.id), PNG);
    await assert.rejects(store.image('../../source'), /not found/);

    const orphan = join(dir, '00000000-0000-4000-8000-000000000000.png');
    await writeFile(orphan, PNG);
    const restored = new Timeline(dir, 3, PNG.length);
    await restored.load();
    await assert.rejects(readFile(orphan), /ENOENT/);
    assert.equal(restored.paused, true);
    assert.equal(restored.entries.at(-1)?.status, 'interrupted');
    const fourth = restored.add('wait', { ms: 1 });
    restored.finish(fourth, 'succeeded');
    assert.equal(restored.entries.length, 3);
    restored.clear();
    await restored.flush();
    await assert.rejects(readFile(join(dir, `${second.id}.png`)), /ENOENT/);
    assert.equal(restored.paused, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('timeline UI requires auth, has one-use pairing, and records target, evidence, and failures', async () => {
  const fixture = await setup();
  try {
    assert.equal((await fetch(fixture.base + '/timeline/api')).status, 401);
    const page = await fetch(fixture.base + '/timeline');
    assert.match(await page.text(), /停止并接管/);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const auth = await fixture.login();
    assert.match(auth.setCookie, /HttpOnly; SameSite=Strict/);
    assert.equal((await fixture.post('/timeline/session', { pair: auth.pair })).status, 401);
    assert.equal((await fixture.post('/timeline/pause', {}, auth.cookie, 'https://other.test')).status, 403);
    assert.equal((await fixture.post('/timeline/pause', {})).status, 401);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(fixture.base + '/timeline/api', { headers: { host: 'other.test', cookie: auth.cookie } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHost, 403);

    await fixture.server.call('snapshot');
    assert.deepEqual(await fixture.server.call('fill', { ref: 1, text: 'never-store-this-text' }), { via: 'trusted', length: 21 });
    await assert.rejects(fixture.server.call('click', { ref: 99 }), /target disappeared/);
    const state = await fixture.state(auth.cookie);
    const fill = state.entries.find((entry: any) => entry.method === 'fill');
    assert.equal(fill.target.tabId, 7);
    assert.equal(fill.target.title, 'Test page');
    assert.ok(!fill.target.url.includes('secret'));
    assert.equal(fill.element, 'Name');
    assert.equal(fill.result.via, 'trusted');
    assert.equal(fill.screenshot.width, 1);
    assert.ok(!JSON.stringify(state).includes('never-store-this-text'));
    const failure = state.entries.find((entry: any) => entry.method === 'click');
    assert.equal(failure.status, 'failed');
    assert.match(failure.error, /target disappeared/);
    assert.ok(failure.screenshot);
    const image = fixture.base + `/timeline/image/${fill.id}.png`;
    assert.equal((await fetch(image)).status, 401);
    const response = await fetch(image, { headers: { cookie: auth.cookie } });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  } finally { await fixture.close(); }
});

test('takeover cancels queued actions, blocks new work, and never replays cancelled work', async () => {
  let release: (() => void) | undefined;
  let started: () => void = () => undefined;
  const running = new Promise<void>(resolve => { started = resolve; });
  const fixture = await setup(async (method, params) => {
    if (method === 'click' && params.ref === 1) {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    }
  });
  try {
    const { cookie } = await fixture.login();
    const first = fixture.server.call('click', { ref: 1 });
    await running;
    await new Promise(resolve => setTimeout(resolve, 20));
    const historyBefore = await readFile(join(fixture.dir, 'history.json'), 'utf8');
    await assert.rejects(startBridge({ port: fixture.server.port, token: TOKEN, timeline: { dir: fixture.dir } }), { code: 'EADDRINUSE' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await readFile(join(fixture.dir, 'history.json'), 'utf8'), historyBefore);
    const second = fixture.server.call('click', { ref: 2 }).catch(error => error);
    const paused = await (await fixture.post('/timeline/pause', {}, cookie)).json() as any;
    assert.equal(paused.mode, 'pausing');
    assert.match((await second as Error).message, /human takeover/);
    await assert.rejects(fixture.server.call('click', { ref: 3 }), /human takeover/);
    assert.ok((await fixture.server.call('timeline') as { url: string }).url.includes('/timeline#pair='));
    assert.equal((await fixture.post('/timeline/resume', {}, cookie)).status, 409);
    release!();
    await first;
    assert.equal((await fixture.state(cookie)).mode, 'paused');
    assert.equal((await fixture.post('/timeline/resume', {}, cookie)).status, 200);
    await fixture.server.call('click', { ref: 4 });
    assert.deepEqual(fixture.seen.filter(item => item.method === 'click').map(item => item.params.ref), [1, 4]);
    const state = await fixture.state(cookie);
    assert.equal(state.entries.find((entry: any) => entry.params.ref === 2).status, 'cancelled');

    const wait = fixture.server.call('wait', { ms: 30000 }).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 20));
    await fixture.post('/timeline/pause', {}, cookie);
    assert.match((await wait as Error).message, /human takeover/);
    assert.equal((await fixture.state(cookie)).mode, 'paused');
  } finally { release?.(); await fixture.close(); }
});

test('takeover stays pending after a sent command times out until Chrome acknowledges it', async () => {
  let release: (() => void) | undefined;
  let started: () => void = () => undefined;
  const running = new Promise<void>(resolve => { started = resolve; });
  const fixture = await setup(async method => {
    if (method === 'click') { started(); await new Promise<void>(resolve => { release = resolve; }); }
  });
  try {
    const { cookie } = await fixture.login();
    const action = fixture.server.call('click', { ref: 1 }, 100).catch(error => error);
    await running;
    await fixture.post('/timeline/pause', {}, cookie);
    assert.match((await action as Error).message, /timed out/);
    const pending = await fixture.state(cookie);
    assert.equal(pending.mode, 'pausing');
    assert.equal(pending.entries[0].status, 'failed');
    assert.equal((await fixture.post('/timeline/resume', {}, cookie)).status, 409);
    assert.equal((await fixture.post('/timeline/clear', {}, cookie)).status, 409);
    release!();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await fixture.state(cookie)).mode, 'paused');
    assert.equal((await fixture.post('/timeline/resume', {}, cookie)).status, 200);
  } finally { release?.(); await fixture.close(); }
});

test('expired queued commands are never sent to the extension after the client times out', async () => {
  const fixture = await setup();
  let client: BridgeClient | undefined;
  try {
    const { cookie } = await fixture.login();
    client = await BridgeClient.connect(fixture.server.port, TOKEN);
    const block = fixture.server.call('wait', { ms: 150 });
    await assert.rejects(client.call('click', { ref: 1 }, 30), /timed out|expired/);
    await block;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(fixture.seen.some(item => item.method === 'click'), false);
    const state = await fixture.state(cookie);
    assert.equal(state.entries.find((entry: any) => entry.method === 'click').status, 'expired');
  } finally { client?.close(); await fixture.close(); }
});

test('a screenshot failure preserves the actual action result and takeover persists across restart', async () => {
  const fixture = await setup(async method => { if (method === 'screenshot') throw new Error('capture denied'); });
  try {
    const { cookie } = await fixture.login();
    assert.deepEqual(await fixture.server.call('click', { ref: 1 }), { via: 'trusted', length: 0 });
    const state = await fixture.state(cookie);
    assert.equal(state.entries[0].status, 'succeeded');
    assert.match(state.entries[0].screenshotError, /capture denied/);
    await fixture.post('/timeline/pause', {}, cookie);
    await fixture.server.close();
    const restarted = await startBridge({ port: 0, token: TOKEN, timeline: { dir: fixture.dir } });
    try { await assert.rejects(restarted.call('click', { ref: 1 }), /human takeover/); }
    finally { await restarted.close(); }
  } finally { await fixture.close(true); }
});

async function setup(before?: (method: string, params: Record<string, unknown>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hand-timeline-'));
  const server = await startBridge({ port: 0, token: TOKEN, timeline: { dir }, screenshotDir: dir });
  const base = `http://127.0.0.1:${server.port}`;
  const extension = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await new Promise<void>((resolve, reject) => { extension.once('open', resolve); extension.once('error', reject); });
  const authed = new Promise(resolve => extension.once('message', resolve));
  extension.send(JSON.stringify({ type: 'auth', role: 'extension', token: TOKEN }));
  await authed;
  const seen: { method: string; params: Record<string, unknown> }[] = [];
  extension.on('message', raw => {
    const msg = JSON.parse(String(raw)) as { type: string; id: string; method: string; params: Record<string, unknown> };
    if (msg.type !== 'command') return;
    seen.push(msg);
    void (async () => {
      try {
        await before?.(msg.method, msg.params);
        if (msg.method === 'click' && msg.params.ref === 99) throw new Error('target disappeared');
        const data = msg.method === 'list_tabs'
          ? { targetTabId: 7, tabs: [{ id: 7, title: 'Test page', url: 'https://example.test/form?token=secret', active: true }] }
          : msg.method === 'snapshot' ? { tabId: 7, items: [{ ref: 1, name: 'Name' }], text: 'Name', url: 'https://example.test' }
          : msg.method === 'screenshot' ? { base64: PNG.toString('base64'), cssWidth: 1, cssHeight: 1, devicePixelRatio: 1 }
          : { via: 'trusted', length: typeof msg.params.text === 'string' ? msg.params.text.length : 0 };
        extension.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data }));
      } catch (error) { extension.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: (error as Error).message })); }
    })();
  });
  function post(path: string, body: unknown, cookie = '', origin = base) {
    return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body) });
  }
  async function login() {
    const { url } = await server.call('timeline') as { url: string };
    const pair = new URLSearchParams(new URL(url).hash.slice(1)).get('pair')!;
    const response = await post('/timeline/session', { pair });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie')!;
    return { pair, setCookie, cookie: setCookie.split(';')[0] };
  }
  return {
    server, base, dir, seen, post, login,
    async state(cookie: string) { return (await (await fetch(base + '/timeline/api', { headers: { cookie } })).json()) as any; },
    async close(alreadyClosed = false) { extension.close(); if (!alreadyClosed) await server.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
