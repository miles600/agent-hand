import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCli } from '../bridge/cli.js';

test('parses the commands from the demo script', () => {
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
  assert.equal(resolveCli(['press', 'Ctrl+A']).kind, 'call');
  assert.throws(() => resolveCli(['navigate', 'file:///tmp/x']), /http/);
  assert.throws(() => resolveCli(['attach', 'http://example.com:9222']), /loopback/);
});
