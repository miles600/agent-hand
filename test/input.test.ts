import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_TIMEOUT_MS,
  isInputFallbackError,
  requiresTrustedInput,
  syntheticInputWarning,
  trustedInputRequiredError,
} from '../shared/input.js';

test('input failures that should fall back do not look like a detach request', () => {
  assert.equal(INPUT_TIMEOUT_MS, 2500);
  assert.equal(isInputFallbackError(new Error('Input.dispatchMouseEvent timed out')), true);
  assert.equal(isInputFallbackError(new Error('Debugger is not attached to the tab')), true);
  assert.equal(isInputFallbackError(new Error('Another debugger is already attached')), true);
  assert.equal(isInputFallbackError(new Error('Detached while handling command')), true);
  assert.equal(isInputFallbackError(new Error('no tab')), false);
});

test('requiring trusted input names DevTools instead of hiding the fallback', () => {
  assert.equal(requiresTrustedInput(undefined), false);
  assert.equal(requiresTrustedInput({}), false);
  assert.equal(requiresTrustedInput({ requireTrusted: true }), true);
  assert.equal(requiresTrustedInput({ requireTrusted: 'true' }), true);
  const fast = syntheticInputWarning('Another debugger is already attached');
  assert.match(fast, /DevTools/);
  assert.match(fast, /Undocking does not fix this/);
  assert.match(fast, /at once/);
  const slow = syntheticInputWarning('Input.dispatchMouseEvent timed out');
  assert.match(slow, /DevTools/);
  assert.match(slow, /2500ms/);
  const error = trustedInputRequiredError('Debugger is not attached to the tab');
  assert.match(error.message, /Trusted input required/);
  assert.match(error.message, /DevTools/);
  assert.match(error.message, /Synthetic input was not sent/);
});
