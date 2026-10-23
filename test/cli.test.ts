import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveCli } from '../bridge/cli.js';

test('parses the commands from the demo script', () => {
  assert.deepEqual(resolveCli(['observe', '--screenshot']), {
    kind: 'call', method: 'observe', params: { includeScreenshot: true }, port: undefined, cdp: undefined,
  });
  assert.deepEqual(resolveCli(['click', '12']), {
    kind: 'call',
    method: 'click',
    params: { ref: 12 },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['--port', '18000', 'type', '2', 'Ada', 'Lovelace', '--submit']), {
    kind: 'call',
    method: 'type',
    params: { ref: 2, text: 'Ada Lovelace', submit: true },
    port: 18000,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['scroll', 'down', '800']), {
    kind: 'call',
    method: 'scroll',
    params: { direction: 'down', amount: 800 },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['scroll', '4']), {
    kind: 'call',
    method: 'scroll',
    params: { ref: 4 },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['serve', '--port', '17321']), { kind: 'serve', port: 17321, cdp: undefined });
  assert.deepEqual(resolveCli(['click-xy', '12.5', '40']), {
    kind: 'call',
    method: 'click_xy',
    params: { x: 12.5, y: 40 },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['locate', '提交', '订单']), {
    kind: 'call',
    method: 'locate',
    params: { text: '提交 订单' },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['--cdp', 'http://127.0.0.1:9222', 'snapshot']), {
    kind: 'call',
    method: 'snapshot',
    params: {},
    port: undefined,
    cdp: 'http://127.0.0.1:9222',
  });
  assert.equal(resolveCli(['attach', 'http://127.0.0.1:9222']).kind, 'call');
  assert.equal(resolveCli(['emulate', 'iphone']).kind, 'call');
  assert.deepEqual(resolveCli(['emulate', '390x844@3']), {
    kind: 'call',
    method: 'emulate',
    params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['emulate', '390x844', '--fit-window']), {
    kind: 'call',
    method: 'emulate',
    params: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, fitWindow: true },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['--fit-window', 'emulate', 'off']), {
    kind: 'call',
    method: 'emulate',
    params: { preset: 'off', fitWindow: true },
    port: undefined,
    cdp: undefined,
  });
  assert.throws(() => resolveCli(['--fit-window', 'click', '1']), /only for emulate/);
  assert.deepEqual(resolveCli(['--require-trusted', 'click', '3']), {
    kind: 'call',
    method: 'click',
    params: { ref: 3, requireTrusted: true },
    port: undefined,
    cdp: undefined,
    requireTrusted: true,
  });
  assert.equal(resolveCli(['press', 'Ctrl+A']).kind, 'call');
  assert.throws(() => resolveCli(['navigate', 'file:///tmp/x']), /http/);
  assert.throws(() => resolveCli(['attach', 'http://example.com:9222']), /loopback/);
  assert.deepEqual(resolveCli(['double-click', '4']), {
    kind: 'call',
    method: 'dblclick',
    params: { ref: 4 },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['context-click-xy', '8', '9']), {
    kind: 'call',
    method: 'right_click_xy',
    params: { x: 8, y: 9 },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['fill', '2', 'Ada', 'Lovelace']), {
    kind: 'call',
    method: 'fill',
    params: { ref: 2, text: 'Ada Lovelace', submit: false },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['select', '6', 'Green', 'tea']), {
    kind: 'call',
    method: 'select',
    params: { ref: 6, value: 'Green tea' },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['wait-for', 'text', 'Status', 'ready', '--timeout', '1500']), {
    kind: 'call',
    method: 'wait_for_text',
    params: { text: 'Status ready', timeout: 1500 },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['wait-for', 'idle', '--timeout', '2000']), {
    kind: 'call',
    method: 'wait_for_idle',
    params: { timeout: 2000 },
    port: undefined,
    cdp: undefined,
  });
  assert.deepEqual(resolveCli(['--require-trusted', 'hover', '3']), {
    kind: 'call',
    method: 'hover',
    params: { ref: 3, requireTrusted: true },
    port: undefined,
    cdp: undefined,
    requireTrusted: true,
  });
});

test('help mentions exact viewport sizes and require-trusted', () => {
  const result = spawnSync(process.execPath, ['dist/bridge/index.js', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /390x844/);
  assert.match(result.stdout, /require-trusted/);
  assert.match(result.stdout, /fit-window/);
  assert.match(result.stdout, /wait-for text/);
  assert.match(result.stdout, /fill <ref>/);
});
