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

test('snapshot reports checkbox and radio state', () => {
  const built = buildSnapshot(
    [
      element({ ahId: 'c', role: 'checkbox', name: 'Agree', x: 1, y: 1, checked: true }),
      element({ ahId: 'r', role: 'radio', name: 'No', x: 1, y: 30, checked: false }),
      element({ ahId: 'm', role: 'checkbox', name: 'Some', x: 1, y: 60, checked: 'mixed' }),
    ],
    { cssWidth: 100, cssHeight: 100, devicePixelRatio: 1 },
  );
  assert.match(built.text, /checkbox "Agree" \(1,1 40x20\) checked/);
  assert.match(built.text, /radio "No" \(1,30 40x20\) unchecked/);
  assert.match(built.text, /checkbox "Some" \(1,60 40x20\) mixed/);
  assert.equal(built.items[0].checked, true);
});

test('snapshot caps the list and keeps the viewport line', () => {
  const raw = Array.from({ length: MAX_SNAPSHOT_ITEMS + 3 }, (_, index) =>
    element({ ahId: `e${index}`, name: `Item ${index}`, x: index, y: index }));
  const built = buildSnapshot(raw, { cssWidth: 1000, cssHeight: 1000, devicePixelRatio: 1 });
  assert.equal(built.items.length, MAX_SNAPSHOT_ITEMS);
  assert.equal(built.items[0].ref, 1);
  assert.match(built.text, /… 3 more$/);
});

test('snapshot excludes controls outside the top viewport before assigning refs or applying the cap', () => {
  const offscreen = Array.from({ length: MAX_SNAPSHOT_ITEMS }, (_, index) =>
    element({ ahId: `off${index}`, frameId: 1, name: 'Offscreen iframe', x: 10, y: -100 }));
  const built = buildSnapshot([
    ...offscreen,
    element({ ahId: 'below', frameId: 1, name: 'Below', x: 10, y: 100 }),
    element({ ahId: 'left', name: 'Left', x: -40, y: 10 }),
    element({ ahId: 'right', name: 'Right', x: 100, y: 10 }),
    element({ ahId: 'empty', name: 'Empty', x: 10, y: 10, width: 0 }),
    element({ ahId: 'partial', frameId: 1, name: 'Partial iframe', x: -10, y: -10 }),
    element({ ahId: 'visible', name: 'Visible', x: 10, y: 80 }),
  ], { cssWidth: 100, cssHeight: 100, devicePixelRatio: 2 });
  assert.deepEqual(built.items.map((item) => [item.ref, item.name]), [[1, 'Partial iframe'], [2, 'Visible']]);
  assert.doesNotMatch(built.text, /more|Offscreen|Below|Left|Right|Empty/);
});

test('click coordinates stay in CSS pixels', () => {
  assert.deepEqual(viewportCssPoint(100, 50, 2), { x: 100, y: 50 });
  assert.equal(cssToScreenshotPixel(100, 2), 200);
  assert.throws(() => viewportCssPoint(1, 2, 0), /devicePixelRatio/);
});
