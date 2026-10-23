import assert from 'node:assert/strict';
import test from 'node:test';
import { contentRequest } from '../shared/content-channel.js';

const transition = new Error('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.');
const immediate = async () => undefined;

test('read-only content requests reconnect after a document transition', async () => {
  let sent = 0;
  let recovered = 0;
  const result = await contentRequest('collect', async () => {
    if (++sent < 3) throw transition;
    return { elements: ['Close viewer'] };
  }, async () => { recovered += 1; }, immediate);
  assert.deepEqual(result, { elements: ['Close viewer'] });
  assert.equal(sent, 3);
  assert.equal(recovered, 2);
});

test('transitions never replay page mutations, including uncertain submissions', async () => {
  for (const type of ['synthetic-click', 'set-value', 'synthetic-key', 'select-option', 'prepare']) {
    let sent = 0;
    await assert.rejects(contentRequest(type, async () => { sent += 1; throw transition; },
      async () => { assert.fail('must not reconnect and replay an action'); }, immediate), /fresh observation.*may already have completed/);
    assert.equal(sent, 1);
  }
});

test('read recovery is bounded and unrelated errors are not retried', async () => {
  let sent = 0;
  await assert.rejects(contentRequest('metrics', async () => { sent += 1; throw transition; }, immediate, immediate), /Page changed during metrics/);
  assert.equal(sent, 3);
  sent = 0;
  await assert.rejects(contentRequest('metrics', async () => { sent += 1; throw new Error('permission denied'); }, immediate, immediate), /permission denied/);
  assert.equal(sent, 1);
});
