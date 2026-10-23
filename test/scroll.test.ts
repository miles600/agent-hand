import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForScroll } from '../shared/scroll.js';

test('scroll waits for delayed input and for the last scroll event to settle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const target = new EventTarget();
  let settled = false;
  const waiting = waitForScroll(target).then(() => { settled = true; });
  t.mock.timers.tick(100);
  target.dispatchEvent(new Event('scroll'));
  t.mock.timers.tick(100);
  target.dispatchEvent(new Event('scroll'));
  t.mock.timers.tick(149);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await waiting;
  assert.equal(settled, true);
});

test('a scroll at the page boundary completes even when no scroll event fires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = waitForScroll(new EventTarget());
  t.mock.timers.tick(150);
  await waiting;
});

test('continuous scrolling times out and removes its listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const target = new EventTarget();
  const remove = t.mock.method(target, 'removeEventListener');
  const rejected = assert.rejects(waitForScroll(target), /scroll did not settle/);
  for (let i = 0; i < 20; i += 1) {
    t.mock.timers.tick(100);
    target.dispatchEvent(new Event('scroll'));
  }
  await rejected;
  assert.equal(remove.mock.callCount(), 1);
});
