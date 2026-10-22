import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIT_TOLERANCE_PX,
  contentFromWindow,
  fitWindowSize,
  planFitCorrection,
  restoreFittedWindow,
  restoreWindowUpdate,
  runFittedEmulation,
  type FitController,
  type FitMeasure,
  type WindowBox,
} from '../shared/emulate.js';

const target = { width: 390, height: 844 };

function desktop(overrides: Partial<FitMeasure> = {}): FitMeasure {
  return {
    outerWidth: 1216,
    outerHeight: 800,
    innerWidth: 1200,
    innerHeight: 700,
    devicePixelRatio: 1,
    windowWidth: 1216,
    windowHeight: 800,
    ...overrides,
  };
}

test('fit size keeps a 1.25 display in DIPs and scales only physical window units', () => {
  assert.equal(FIT_TOLERANCE_PX, 2);
  const dip = desktop({ devicePixelRatio: 1.25, windowWidth: 1216, windowHeight: 800 });
  assert.deepEqual(fitWindowSize(dip, target), { width: 406, height: 944, scale: 1 });

  const physical = desktop({
    devicePixelRatio: 1.25,
    windowWidth: 1216 * 1.25,
    windowHeight: 800 * 1.25,
  });
  assert.deepEqual(fitWindowSize(physical, target), { width: 508, height: 1180, scale: 1.25 });
  assert.deepEqual(contentFromWindow({ width: 508, height: 1180 }, physical), { width: 390, height: 844 });
});

test('an infobar measured apart from the frame is added once', () => {
  const measure = desktop({ devicePixelRatio: 1.25, infobarHeight: 40 });
  const sized = fitWindowSize(measure, target);
  assert.equal(sized.scale, 1);
  assert.equal(sized.width, 406);
  assert.equal(sized.height, 984);
  assert.deepEqual(contentFromWindow({ width: sized.width, height: sized.height }, measure), target);
});

test('one correction pass runs only when the content box is off by more than 2px', () => {
  const measure = desktop({ devicePixelRatio: 1.25, windowWidth: 1216 * 1.25, windowHeight: 800 * 1.25 });
  const close = contentFromWindow({ width: 508, height: 1180 - Math.round(2 * 1.25) }, measure);
  assert.equal(planFitCorrection({ width: 508, height: 1178 }, close, target, 1.25), null);

  const short = contentFromWindow({ width: 508, height: 1180 - Math.round(8 * 1.25) }, measure);
  assert.deepEqual(
    planFitCorrection({ width: 508, height: 1170 }, short, target, 1.25),
    { width: 508, height: 1180 },
  );
});

test('emulate off restores maximized state, and a normal window keeps its bounds', () => {
  assert.deepEqual(
    restoreWindowUpdate({ left: 0, top: 0, width: 1600, height: 1000, state: 'maximized' }),
    { state: 'maximized' },
  );
  assert.deepEqual(
    restoreWindowUpdate({ left: 12, top: 24, width: 900, height: 700, state: 'normal' }),
    { state: 'normal', left: 12, top: 24, width: 900, height: 700 },
  );
  assert.deepEqual(
    restoreWindowUpdate({ left: 0, top: 0, width: 800, height: 600, state: 'fullscreen' }),
    { state: 'fullscreen' },
  );
});

test('fit resizes after emulation, corrects once, and restore puts a maximized window back', async () => {
  let win: WindowBox = { left: 8, top: 8, width: 1600, height: 1000, state: 'maximized' };
  const calls: Partial<WindowBox>[] = [];
  let sized = 0;
  const measure = desktop({ devicePixelRatio: 1.25 });
  const io: FitController = {
    getWindow: async () => ({ ...win }),
    setWindow: async (update) => {
      calls.push(update);
      if (update.width != null) {
        sized += 1;
        win = {
          ...win,
          ...update,
          state: update.state ?? win.state,
          height: sized === 1 ? (update.height ?? win.height) - 8 : (update.height ?? win.height),
        };
        return;
      }
      win = { ...win, ...update, state: update.state ?? win.state };
    },
    measure: async () => ({ ...measure, windowWidth: win.width, windowHeight: win.height }),
  };
  let applied = false;
  const fitted = await runFittedEmulation(io, null, target, async () => {
    applied = true;
    assert.equal(win.state, 'normal');
    return { applied: true, cssWidth: 390, cssHeight: 844, devicePixelRatio: 2 };
  });
  assert.equal(applied, true);
  assert.equal(fitted.corrected, true);
  assert.equal(fitted.fitWindow, true);
  assert.deepEqual(fitted.content, target);
  assert.equal((fitted.windowBefore as WindowBox).state, 'maximized');
  assert.equal((fitted.restoreWindow as WindowBox).state, 'maximized');
  const saved = fitted.restoreWindow as WindowBox;
  await restoreFittedWindow(io, saved);
  assert.deepEqual(calls.at(-1), { state: 'maximized' });

  win = { left: 8, top: 8, width: 1600, height: 1000, state: 'maximized' };
  const refused = await runFittedEmulation(io, null, target, async () => ({ applied: false, warning: 'no debugger' }));
  assert.equal(refused.fitWindow, false);
  assert.match(String(refused.warning), /not resized/);
  assert.equal(win.state, 'maximized');
});
