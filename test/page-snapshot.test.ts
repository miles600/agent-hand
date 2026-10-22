import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildSnapshot, type RawElement } from '../shared/snapshot.js';

type PickerNode = {
  addEventListener: (type: string, listener: () => void) => void;
  querySelector: (selector: string) => InputNode | null;
};

type InputNode = {
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  style: { pointerEvents: string };
};

test('uni-app-like controls get actionable refs, names, and checked state', async (t) => {
  const html = await readFile(new URL('../../test/fixtures/uni-h5.html', import.meta.url), 'utf8');
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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(html);
    await page.addScriptTag({ content: source });
    const collected = await page.evaluate(() => {
      const api = (globalThis as { __agentHand?: { collect: () => { elements: RawElement[] }; metrics: () => { cssWidth: number; cssHeight: number; devicePixelRatio: number } } }).__agentHand;
      if (!api) throw new Error('missing page api');
      return { elements: api.collect().elements, metrics: api.metrics() };
    });
    const built = buildSnapshot(
      collected.elements.map((element) => ({ ...element, frameId: element.frameId ?? 0 })),
      collected.metrics,
    );
    const line = (role: string, name: string) => built.items.find((item) => item.role === role && item.name === name);
    const picker = line('combobox', '2024-01-02');
    assert.ok(picker, built.text);
    assert.equal(picker.disabled, false);
    assert.equal(built.items.some((item) => item.role === 'textbox' && item.name.includes('2024')), false);
    const date = line('clickable', '请选择日期');
    assert.ok(date, built.text);
    assert.equal(date.disabled, false);
    assert.equal(line('checkbox', '同意协议')?.checked, true);
    assert.equal(line('radio', '否')?.checked, false);
    assert.equal(line('checkbox', '条款')?.checked, true);
    assert.equal(line('checkbox', '未选')?.checked, false);
    assert.ok(line('clickable', '学生'), built.text);
    assert.ok(line('clickable', '教师'), built.text);
    assert.ok(line('clickable', '游客'), built.text);
    assert.ok(line('clickable', '家长'), built.text);
    assert.match(built.text, /^viewport 390x844 dpr /);

    const clicked = await page.evaluate(() => {
      const doc = (globalThis as unknown as {
        document: {
          querySelector: (selector: string) => PickerNode | null;
        };
      }).document;
      const pickerEl = doc.querySelector('uni-picker');
      const input = pickerEl?.querySelector('input') ?? null;
      if (!pickerEl || !input) throw new Error('picker missing');
      let clicks = 0;
      pickerEl.addEventListener('click', () => { clicks += 1; });
      const rect = input.getBoundingClientRect();
      const api = (globalThis as { __agentHand?: { syntheticClick: (x: number, y: number) => { tag: string } | null } }).__agentHand;
      const hit = api?.syntheticClick(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { clicks, tag: hit?.tag ?? '', pointerEvents: input.style.pointerEvents };
    });
    assert.equal(clicked.clicks, 1);
    assert.equal(clicked.tag, 'uni-picker');
    assert.equal(clicked.pointerEvents, 'none');
  } finally {
    await browser.close();
  }
});
