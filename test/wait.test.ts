import assert from 'node:assert/strict';
import test from 'node:test';
import { compileUrlPattern, pollUntil, urlMatches } from '../shared/wait.js';

test('url waits accept a substring or a slash-delimited pattern', () => {
  assert.equal(urlMatches('http://127.0.0.1:17321/demo#ready', '#ready'), true);
  assert.equal(urlMatches('http://127.0.0.1:17321/demo', '#ready'), false);
  assert.equal(urlMatches('http://127.0.0.1:17321/demo#Ready', '/ready/i'), true);
  assert.equal(compileUrlPattern('/demo'), '/demo');
  assert.throws(() => compileUrlPattern('/[/'), /invalid url pattern/);
});

test('pollUntil reports elapsed time and a timeout', async () => {
  const hit = await pollUntil(200, 20, async () => true);
  assert.ok(hit >= 0);
  const miss = await pollUntil(0, 20, async () => false);
  assert.equal(miss, -1);
});
