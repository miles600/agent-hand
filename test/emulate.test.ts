import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEmulation, normalizeEmulate, resolveEmulation, viewportMatches } from '../shared/emulate.js';

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

test('a size token sets mobile metrics and retries a mismatched readback', async () => {
  assert.deepEqual(normalizeEmulate({ size: '390x844@3' }), {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  const plain = normalizeEmulate({ preset: '390x844' });
  assert.equal(plain.deviceScaleFactor, 2);
  assert.equal(plain.mobile, true);
  assert.equal(viewportMatches(
    { width: 390, height: 844, deviceScaleFactor: 3 },
    { cssWidth: 390.2, cssHeight: 843.6, devicePixelRatio: 3.01 },
  ), true);

  const spec = resolveEmulation(normalizeEmulate({ size: '390x844@3' }));
  const sent: string[] = [];
  let reads = 0;
  const matched = await applyEmulation(spec, {
    send: async (method) => { sent.push(method); },
    readViewport: async () => {
      reads += 1;
      if (reads === 1) return { cssWidth: 508, cssHeight: 728, devicePixelRatio: 1.25 };
      return { cssWidth: 390, cssHeight: 844, devicePixelRatio: 3 };
    },
  });
  assert.equal(sent.filter((method) => method === 'Emulation.setDeviceMetricsOverride').length, 2);
  assert.equal(matched.applied, true);
  assert.equal(matched.cssWidth, 390);
  assert.equal(matched.cssHeight, 844);

  const stuck = await applyEmulation(spec, {
    send: async () => undefined,
    readViewport: async () => ({ cssWidth: 1536, cssHeight: 735, devicePixelRatio: 1.25 }),
  });
  assert.equal(stuck.applied, false);
  assert.match(String(stuck.warning), /DevTools/);

  const refused = await applyEmulation(spec, {
    send: async () => { throw new Error('Another debugger is already attached'); },
    readViewport: async () => ({ cssWidth: 1536, cssHeight: 735, devicePixelRatio: 1.25 }),
  });
  assert.equal(refused.applied, false);
  assert.match(String(refused.warning), /Another debugger is already attached/);

  const cleared: string[] = [];
  const off = await applyEmulation({ preset: 'off' }, {
    send: async (method) => { cleared.push(method); },
    readViewport: async () => ({ cssWidth: 1536, cssHeight: 735, devicePixelRatio: 1.25 }),
  });
  assert.ok(cleared.includes('Emulation.clearDeviceMetricsOverride'));
  assert.equal(off.preset, 'off');
  assert.equal(off.touch, false);
});
