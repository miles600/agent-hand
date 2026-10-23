import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCall } from '../shared/validate.js';

test('normalizes the commands an agent sends', () => {
  assert.deepEqual(normalizeCall('observe', { tabId: '7', includeScreenshot: true }), {
    method: 'observe', params: { tabId: 7, includeScreenshot: true },
  });
  assert.deepEqual(normalizeCall('observe'), { method: 'observe', params: { includeScreenshot: false } });
  assert.throws(() => normalizeCall('observe', { includeScreenshot: 'false' }), /must be a boolean/);

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
  assert.equal(normalizeCall('new_tab', { url: 'https://example.com' }).method, 'new_tab');
  assert.throws(() => normalizeCall('new_tab', { url: 'file:///tmp/test' }), /http/);
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
  assert.deepEqual(normalizeCall('emulate', { size: '390x844' }), {
    method: 'emulate',
    params: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  });
  assert.deepEqual(normalizeCall('click', { ref: 4, requireTrusted: true }), {
    method: 'click',
    params: { ref: 4, requireTrusted: true },
  });
  assert.deepEqual(normalizeCall('press', { key: 'Enter', requireTrusted: 'true' }), {
    method: 'press',
    params: { key: 'Enter', requireTrusted: true },
  });
  assert.equal(normalizeCall('attach_cdp', { url: 'http://127.0.0.1:9222/json' }).params.url, 'http://127.0.0.1:9222');
  assert.deepEqual(normalizeCall('select_tab', { tabId: 'TARGET-1' }).params, { tabId: 'TARGET-1' });
  assert.throws(() => normalizeCall('attach_cdp', { url: 'http://example.com:9222' }), /loopback/);
  assert.throws(() => normalizeCall('click_xy', { x: -1, y: 1 }), /CSS pixels/);
  assert.deepEqual(normalizeCall('hover', { ref: '3' }), { method: 'hover', params: { ref: 3 } });
  assert.deepEqual(normalizeCall('dblclick_xy', { x: 1, y: 2 }), { method: 'dblclick_xy', params: { x: 1, y: 2 } });
  assert.deepEqual(normalizeCall('right_click', { ref: 4, requireTrusted: true }), {
    method: 'right_click',
    params: { ref: 4, requireTrusted: true },
  });
  assert.deepEqual(normalizeCall('fill', { ref: 2, text: 'Paris' }), {
    method: 'fill',
    params: { ref: 2, text: 'Paris', submit: false },
  });
  assert.deepEqual(normalizeCall('clear', { ref: 2 }), { method: 'clear', params: { ref: 2 } });
  assert.deepEqual(normalizeCall('select', { ref: 5, value: ' Green ' }), {
    method: 'select',
    params: { ref: 5, value: 'Green' },
  });
  assert.deepEqual(normalizeCall('wait_for_text', { text: 'Ready' }), {
    method: 'wait_for_text',
    params: { text: 'Ready', timeout: 10000 },
  });
  assert.deepEqual(normalizeCall('wait_for_url', { url: '/ready/i', timeout: '1500' }), {
    method: 'wait_for_url',
    params: { url: '/ready/i', timeout: 1500 },
  });
  assert.deepEqual(normalizeCall('wait_for_idle', {}), { method: 'wait_for_idle', params: { timeout: 10000 } });
  assert.throws(() => normalizeCall('wait_for_url', { url: '/[/' }), /invalid url pattern/);
  assert.throws(() => normalizeCall('wait_for_idle', { timeout: 60001 }), /timeout out of range/);
  assert.throws(() => normalizeCall('select', { ref: 1, value: '   ' }), /value is required/);
});
