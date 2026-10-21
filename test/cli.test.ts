import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCli } from '../bridge/cli.js';

test('parses the commands from the demo script', () => {
  assert.deepEqual(resolveCli(['click', '12']), {
    kind: 'call',
    method: 'click',
    params: { ref: 12 },
    port: undefined,
  });
  assert.deepEqual(resolveCli(['--port', '18000', 'type', '2', 'Ada', 'Lovelace', '--submit']), {
    kind: 'call',
    method: 'type',
    params: { ref: 2, text: 'Ada Lovelace', submit: true },
    port: 18000,
  });
  assert.deepEqual(resolveCli(['scroll', 'down', '800']), {
    kind: 'call',
    method: 'scroll',
    params: { direction: 'down', amount: 800 },
    port: undefined,
  });
  assert.deepEqual(resolveCli(['scroll', '4']), {
    kind: 'call',
    method: 'scroll',
    params: { ref: 4 },
    port: undefined,
  });
  assert.deepEqual(resolveCli(['serve', '--port', '17321']), { kind: 'serve', port: 17321 });
  assert.equal(resolveCli(['press', 'Ctrl+A']).kind, 'call');
  assert.throws(() => resolveCli(['navigate', 'file:///tmp/x']), /http/);
});
