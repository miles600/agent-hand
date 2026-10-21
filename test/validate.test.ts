import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCall } from '../shared/validate.js';

test('normalizes the commands an agent sends', () => {
  assert.deepEqual(normalizeCall('click', { ref: '12', trace: true, duration: 900 }), {
    method: 'click',
    params: { ref: 12, trace: true, duration: 900 },
  });
  assert.deepEqual(normalizeCall('type', { ref: 2, text: 'Ada', submit: true }), {
    method: 'type',
    params: { ref: 2, text: 'Ada', submit: true },
  });
  assert.equal(normalizeCall('navigate', { url: 'http://127.0.0.1:17321/demo' }).params.url, 'http://127.0.0.1:17321/demo');
  assert.throws(() => normalizeCall('navigate', { url: 'javascript:alert(1)' }), /http/);
  assert.throws(() => normalizeCall('press', { key: 'Nope' }), /unsupported key/);
  assert.throws(() => normalizeCall('scroll', {}), /direction or a ref/);
  assert.throws(() => normalizeCall('dance', {}), /unknown method/);
  assert.deepEqual(normalizeCall('click_xy', { x: '12.5', y: 8, duration: 0 }), {
    method: 'click_xy',
    params: { x: 12.5, y: 8, duration: 0 },
  });
  assert.deepEqual(normalizeCall('emulate', { preset: 'iphone' }), {
    method: 'emulate',
    params: { preset: 'iphone' },
  });
  assert.equal(normalizeCall('attach_cdp', { url: 'http://127.0.0.1:9222/json' }).params.url, 'http://127.0.0.1:9222');
  assert.deepEqual(normalizeCall('select_tab', { tabId: 'TARGET-1' }).params, { tabId: 'TARGET-1' });
  assert.throws(() => normalizeCall('attach_cdp', { url: 'http://example.com:9222' }), /loopback/);
  assert.throws(() => normalizeCall('click_xy', { x: -1, y: 1 }), /CSS pixels/);
});
