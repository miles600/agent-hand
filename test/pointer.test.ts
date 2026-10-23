import assert from 'node:assert/strict';
import test from 'node:test';
import { pointerEvents } from '../shared/pointer.js';

test('trusted pointer sequences keep the existing click and add hover, double, and right', () => {
  assert.deepEqual(pointerEvents(10.006, 20, 'click'), [
    { type: 'mouseMoved', x: 10.01, y: 20, button: 'none', pointerType: 'mouse' },
    { type: 'mousePressed', x: 10.01, y: 20, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' },
    { type: 'mouseReleased', x: 10.01, y: 20, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' },
  ]);
  assert.deepEqual(pointerEvents(1, 2, 'hover').map((event) => event.type), ['mouseMoved']);
  const doubled = pointerEvents(1, 2, 'double');
  assert.deepEqual(doubled.map((event) => event.clickCount), [undefined, 1, 1, 2, 2]);
  const right = pointerEvents(1, 2, 'right');
  assert.equal(right[1].button, 'right');
  assert.equal(right[1].buttons, 2);
  assert.equal(right[2].buttons, 0);
});
