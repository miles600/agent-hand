import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEmulate, resolveEmulation } from '../shared/emulate.js';

test('mobile presets resolve to a viewport and a user agent', () => {
  assert.deepEqual(normalizeEmulate({ preset: 'iPhone' }), { preset: 'iphone' });
  const iphone = resolveEmulation({ preset: 'iphone' });
  assert.equal(iphone.preset, 'iphone');
  if (iphone.preset === 'iphone') {
    assert.equal(iphone.width, 390);
    assert.equal(iphone.height, 844);
    assert.equal(iphone.mobile, true);
    assert.match(iphone.userAgent, /iPhone/);
  }
  const custom = resolveEmulation(normalizeEmulate({ width: '800', height: 600, mobile: false }));
  assert.equal(custom.preset, 'custom');
  if (custom.preset === 'custom') {
    assert.equal(custom.width, 800);
    assert.equal(custom.mobile, false);
    assert.equal(custom.userAgent, '');
  }
  assert.deepEqual(normalizeEmulate({ preset: 'off' }), { preset: 'off' });
  assert.throws(() => normalizeEmulate({ preset: 'ipad' }), /iphone, pixel, or off/);
});
