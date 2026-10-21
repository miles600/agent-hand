import assert from 'node:assert/strict';
import test from 'node:test';
import { cssToScreenshotPixel, viewportCssPoint } from '../shared/coords.js';
import { MAX_SNAPSHOT_ITEMS, buildSnapshot, type RawElement } from '../shared/snapshot.js';

function element(partial: Partial<RawElement> & Pick<RawElement, 'ahId' | 'name' | 'x' | 'y'>): RawElement {
  return {
    frameId: 0,
    role: 'button',
    width: 40,
    height: 20,
    disabled: false,
    ...partial,
  };
}

test('snapshot orders by position and assigns stable refs', () => {
  const built = buildSnapshot(
    [
      element({ ahId: 'b', role: 'button', name: 'Save', x: 10.4, y: 40.2, width: 80.2, height: 20.1 }),
      element({ ahId: 'a', role: 'link', name: 'Docs', x: 10, y: 10, width: 40, height: 16 }),
      element({
        ahId: 'c',
        frameId: 1,
        role: 'textbox',
        name: 'Email\naddress',
        x: 5,
        y: 40,
        width: 100,
        height: 30,
        disabled: true,
      }),
    ],
    { cssWidth: 800, cssHeight: 600, devicePixelRatio: 2 },
  );
  assert.equal(
    built.text,
    [
      'viewport 800x600 dpr 2',
      '[1] link "Docs" (10,10 40x16)',
      '[2] textbox "Email address" (5,40 100x30) disabled frame',
      '[3] button "Save" (10,40 80x20)',
    ].join('\n'),
  );
  assert.deepEqual(
    built.items.map((item) => item.ref),
    [1, 2, 3],
  );
  assert.equal(built.items[1].ahId, 'c');
  assert.equal(built.items[1].frameId, 1);
});

test('snapshot caps the list and keeps the viewport line', () => {
  const raw = Array.from({ length: MAX_SNAPSHOT_ITEMS + 3 }, (_, index) =>
    element({ ahId: `e${index}`, name: `Item ${index}`, x: index, y: index }));
  const built = buildSnapshot(raw, { cssWidth: 100, cssHeight: 100, devicePixelRatio: 1 });
  assert.equal(built.items.length, MAX_SNAPSHOT_ITEMS);
  assert.equal(built.items[0].ref, 1);
  assert.match(built.text, /… 3 more$/);
});

test('click coordinates stay in CSS pixels', () => {
  assert.deepEqual(viewportCssPoint(100, 50, 2), { x: 100, y: 50 });
  assert.equal(cssToScreenshotPixel(100, 2), 200);
  assert.throws(() => viewportCssPoint(1, 2, 0), /devicePixelRatio/);
});
