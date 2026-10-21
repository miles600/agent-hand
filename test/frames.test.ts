import assert from 'node:assert/strict';
import test from 'node:test';
import { matchFrameRect, type FrameRect } from '../shared/frames.js';

const rects: FrameRect[] = [
  { src: 'http://127.0.0.1:17321/demo/iframe.html', x: 10, y: 400, width: 300, height: 120 },
  { src: 'https://example.com/embed', x: 10, y: 20, width: 200, height: 80 },
];

test('matches an iframe by absolute url and skips used slots', () => {
  const used = new Set<number>();
  const first = matchFrameRect(rects, 'https://example.com/embed', used);
  assert.equal(first, 1);
  used.add(first);
  const second = matchFrameRect(rects, 'http://127.0.0.1:17321/demo/iframe.html#ignored', used);
  assert.equal(second, -1);
  const demo = matchFrameRect(rects, 'http://127.0.0.1:17321/demo/iframe.html', used);
  assert.equal(demo, 0);
});

test('falls back when a parent has a single iframe', () => {
  const only = [rects[0]];
  assert.equal(matchFrameRect(only, 'about:blank', new Set()), 0);
  assert.equal(matchFrameRect(rects, 'about:blank', new Set()), -1);
});
