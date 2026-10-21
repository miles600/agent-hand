import assert from 'node:assert/strict';
import test from 'node:test';
import { parseKeyCombo } from '../shared/keys.js';

test('parses enter, chords, and letters', () => {
  assert.deepEqual(parseKeyCombo('Enter'), {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    text: '\r',
    modifiers: 0,
  });
  const ctrl = parseKeyCombo('Ctrl+A');
  assert.equal(ctrl.key, 'a');
  assert.equal(ctrl.code, 'KeyA');
  assert.equal(ctrl.keyCode, 65);
  assert.equal(ctrl.modifiers, 2);
  assert.equal(ctrl.text, undefined);
  const shifted = parseKeyCombo('Shift+b');
  assert.equal(shifted.key, 'B');
  assert.equal(shifted.text, 'B');
  assert.equal(shifted.modifiers, 8);
});

test('rejects empty and unknown keys', () => {
  assert.throws(() => parseKeyCombo(''), /empty key/);
  assert.throws(() => parseKeyCombo('Ctrl+'), /expected one key/);
  assert.throws(() => parseKeyCombo('NotAKey'), /unsupported key/);
});
