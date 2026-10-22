import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextScreenshotScale,
  pngDimensionsFromBase64,
  screenshotScaleReport,
  viewportScreenshotParams,
} from '../shared/screenshot.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('an attached debugger captures the emulated viewport, not the window', () => {
  const params = viewportScreenshotParams({ cssWidth: 390, cssHeight: 844 }, 1);
  assert.equal(params.captureBeyondViewport, false);
  assert.equal(params.fromSurface, true);
  assert.deepEqual(params.clip, { x: 0, y: 0, width: 390, height: 844, scale: 1 });
  assert.deepEqual(pngDimensionsFromBase64(PNG), { width: 1, height: 1 });
});

test('a CSS-sized capture is retried at devicePixelRatio, and the report matches the image', () => {
  assert.deepEqual(nextScreenshotScale({ width: 390, height: 844 }, 390, 844, 2), { retry: true, scale: 2 });
  assert.deepEqual(nextScreenshotScale({ width: 780, height: 1688 }, 390, 844, 2), { retry: false, scale: 1 });
  assert.deepEqual(nextScreenshotScale({ width: 625, height: 910 }, 390, 844, 2), { retry: false, scale: 1 });

  assert.deepEqual(screenshotScaleReport({ width: 780, height: 1688 }, 390, 844, 2), { devicePixelRatio: 2 });
  const mismatched = screenshotScaleReport({ width: 625, height: 910 }, 390, 844, 2);
  assert.equal(mismatched.devicePixelRatio, Math.round((625 / 390) * 1000) / 1000);
  assert.match(mismatched.warning ?? '', /625x910/);
  assert.deepEqual(screenshotScaleReport({ width: 1, height: 1 }, 1, 1, 2), { devicePixelRatio: 1 });
});
