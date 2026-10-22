import assert from 'node:assert/strict';
import test from 'node:test';
import { INPUT_TIMEOUT_MS, isInputFallbackError } from '../shared/input.js';

test('input failures that should fall back do not look like a detach request', () => {
  assert.equal(INPUT_TIMEOUT_MS, 2500);
  assert.equal(isInputFallbackError(new Error('Input.dispatchMouseEvent timed out')), true);
  assert.equal(isInputFallbackError(new Error('Debugger is not attached to the tab')), true);
  assert.equal(isInputFallbackError(new Error('Another debugger is already attached')), true);
  assert.equal(isInputFallbackError(new Error('Detached while handling command')), true);
  assert.equal(isInputFallbackError(new Error('no tab')), false);
});
