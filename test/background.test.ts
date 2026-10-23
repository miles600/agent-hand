import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function snapshotFixture(revealAfter: number) {
  const source = await readFile(new URL('../../extension/dist/background.js', import.meta.url), 'utf8');
  let collections = 0;
  const pauses: number[] = [];
  const event = { addListener() {} };
  const tab = { id: 7, windowId: 1, url: 'https://example.test/viewer', title: 'Viewer' };
  const context = vm.createContext({
    console, URL,
    setTimeout: (fn: () => void, ms: number) => { pauses.push(ms); return setTimeout(fn, 1); },
    clearTimeout,
    WebSocket: class { static OPEN = 1; },
    chrome: {
      action: { onClicked: event }, alarms: { create() {}, onAlarm: event },
      storage: { onChanged: event, session: { get: async () => ({}), set: async () => undefined }, local: { get: async () => ({ token: 'test-token', port: 17321 }) } },
      runtime: { onMessage: event, id: 'test-extension' },
      debugger: { onDetach: event, onEvent: event },
      windows: { get: async () => ({ state: 'normal' }), update: async () => undefined },
      webNavigation: { getAllFrames: (_query: unknown, callback: (frames: unknown[]) => void) => callback([{ frameId: 0, parentFrameId: -1, url: tab.url }]) },
      tabs: {
        onRemoved: event, get: async () => tab, query: async () => [tab], update: async () => tab,
        sendMessage: (_id: number, message: { type: string }, _options: unknown, reply: (response: unknown) => void) => {
          let result: unknown;
          if (message.type === 'collect') {
            collections += 1;
            result = { elements: collections >= revealAfter ? [{ ahId: 'close', role: 'button', name: 'Close viewer', x: 30, y: 20, width: 40, height: 30, disabled: false }] : [] };
          } else if (message.type === 'metrics') result = { cssWidth: 800, cssHeight: 600, devicePixelRatio: 1 };
          else if (message.type === 'frame-offset') result = { x: 0, y: 0 };
          reply({ ok: true, result });
        },
      },
    },
  });
  vm.runInContext(source, context);
  const result = await vm.runInContext('snapshot()', context) as { items: { name: string }[] };
  return { result, collections, pauses };
}

test('extension snapshot waits for initially empty fading controls', async () => {
  const fixture = await snapshotFixture(3);
  assert.equal(fixture.collections, 3);
  assert.equal(fixture.result.items[0].name, 'Close viewer');
  assert.equal(fixture.pauses.filter(ms => ms === 150).length, 2);
});

test('extension snapshot stops retrying a genuinely empty page', async () => {
  const fixture = await snapshotFixture(Infinity);
  assert.equal(fixture.collections, 5);
  assert.equal(fixture.result.items.length, 0);
  assert.equal(fixture.pauses.filter(ms => ms === 150).length, 4);
});
