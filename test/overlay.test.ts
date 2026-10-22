import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the page script keeps a single cursor overlay across reinjection', async (t) => {
  const source = await readFile(new URL('../inject.js', import.meta.url), 'utf8');
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    t.skip('playwright is not installed');
    return;
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/executable doesn't exist|browserType.launch|Failed to launch/i.test(message)) {
      t.skip('playwright chromium is not installed');
      return;
    }
    throw error;
  }
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><button id="go">Go</button><input id="name" />');
    await page.addScriptTag({ content: source });
    await page.addScriptTag({ content: source });
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      const api = (globalThis as { __agentHand?: { cursorMove: (x: number, y: number, label: string, duration: number) => Promise<void>; cursorRipple: () => void; syntheticClick: (x: number, y: number) => unknown } }).__agentHand;
      if (!api) throw new Error('missing page api');
      return api.cursorMove(40, 40, 'Click', 0).then(() => {
        api.cursorRipple();
        api.syntheticClick(12, 12);
      });
    });
    await page.addScriptTag({ content: source });
    const count = await page.locator('#agent-hand-root').count();
    assert.equal(count, 1);
    const listeners = await page.evaluate(() => {
      const g = globalThis as { __agentHandInstalled?: boolean };
      return g.__agentHandInstalled === true;
    });
    assert.equal(listeners, true);
  } finally {
    await browser.close();
  }
});
