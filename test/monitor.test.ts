import assert from 'node:assert/strict';
import test from 'node:test';
import { consoleFromCdp, mergeConsole, networkFromCdp } from '../shared/monitor.js';

test('console and network events become report rows', () => {
  const requests = new Map<string, string>();
  assert.equal(networkFromCdp('Network.requestWillBeSent', {
    requestId: 'r1',
    request: { url: 'https://example.test/api' },
  }, requests), null);
  assert.deepEqual(networkFromCdp('Network.loadingFailed', {
    requestId: 'r1',
    errorText: 'net::ERR_FAILED',
  }, requests, 5), {
    url: 'https://example.test/api',
    status: 0,
    error: 'net::ERR_FAILED',
    time: 5,
  });
  assert.equal(networkFromCdp('Network.responseReceived', {
    requestId: 'ok',
    response: { url: 'https://example.test/ok', status: 200, statusText: 'OK' },
  }, requests), null);
  const missing = networkFromCdp('Network.responseReceived', {
    requestId: 'missing',
    response: { url: 'https://example.test/missing', status: 404, statusText: 'Not Found' },
  }, requests, 6);
  assert.equal(missing?.status, 404);

  const logged = consoleFromCdp('Runtime.consoleAPICalled', {
    type: 'warning',
    args: [{ type: 'string', value: 'from cdp' }],
  }, 7);
  assert.equal(logged?.level, 'warn');
  assert.equal(logged?.text, 'from cdp');
  const merged = mergeConsole([
    { level: 'warn', text: 'from cdp', time: 7, source: 'cdp' },
    { level: 'warn', text: 'from cdp', time: 8, source: 'page' },
    { level: 'error', text: 'boom', time: 9, source: 'page' },
  ], 10);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].text, 'boom');
});
