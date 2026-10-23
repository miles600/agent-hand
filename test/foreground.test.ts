import assert from 'node:assert/strict';
import test from 'node:test';
import { foregroundChrome } from '../bridge/foreground.js';

test('macOS foreground activation verifies the frontmost app', async () => {
  const calls: { file: string; args: string[] }[] = [];
  const result = await foregroundChrome('darwin', async (file, args) => {
    calls.push({ file, args });
    return { stdout: file.endsWith('osascript') ? 'com.google.Chrome\n' : '' };
  });
  assert.deepEqual(result, { supported: true, frontmost: true });
  assert.deepEqual(calls[0], { file: '/usr/bin/open', args: ['-b', 'com.google.Chrome'] });
  assert.match(calls[1].args.at(-1)!, /frontmostApplication/);
});

test('foreground activation reports failures without claiming success', async () => {
  const result = await foregroundChrome('darwin', async () => { throw new Error('activation denied'); });
  assert.equal(result.frontmost, false);
  assert.match(result.warning!, /activation denied/);
  const refused = await foregroundChrome('darwin', async file => ({ stdout: file.endsWith('osascript') ? 'com.example.OtherApp' : '' }));
  assert.equal(refused.frontmost, false);
  assert.match(refused.warning!, /manually/);
});

test('unsupported systems do not invoke native commands', async () => {
  const result = await foregroundChrome('linux', async () => { assert.fail('must not invoke macOS commands'); });
  assert.equal(result.supported, false);
});
