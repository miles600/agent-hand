import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = `<!doctype html>
<input id="city" aria-label="City" value="old" />
<p id="city-state"></p>
<div id="note" contenteditable="true" aria-label="Note">old note</div>
<select id="color" aria-label="Color">
  <option value="red">Red</option>
  <option value="green">Green</option>
  <option value="blue">Blue</option>
</select>
<p id="color-state"></p>
<button id="pet" type="button" role="combobox" aria-controls="pet-list">Pet</button>
<ul id="pet-list" role="listbox" hidden>
  <li role="option" data-value="cat">Cat</li>
  <li role="option" data-value="dog">Dog</li>
</ul>
<button id="hover" type="button">Hover target</button>
<button id="dbl" type="button">Double click</button>
<button id="menu" type="button">Right click</button>`;

test('page actions cover hover, double-click, right-click, fill, and select', async (t) => {
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
    await page.setContent(html);
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(() => {
      type El = {
        value: string;
        textContent: string | null;
        addEventListener: (type: string, listener: (event: { target: El | null; preventDefault: () => void }) => void) => void;
        removeAttribute: (name: string) => void;
        click: () => void;
        getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
        closest: (selector: string) => El | null;
      };
      type InputProto = { prototype: object };
      const g = globalThis as {
        document: { getElementById: (id: string) => El | null };
        HTMLInputElement: InputProto;
        __agentHand?: {
          collect: () => { elements: { ahId: string; name: string }[] };
          setValue: (ahId: string, value: string) => boolean;
          selectOption: (ahId: string, query: string, opened?: boolean, apply?: boolean) => { action: string; value?: string; label?: string; x?: number; y?: number; error?: string };
          syntheticHover: (x: number, y: number) => { tag: string } | null;
          syntheticDblclick: (x: number, y: number) => { tag: string } | null;
          syntheticRightClick: (x: number, y: number) => { tag: string } | null;
          syntheticClick: (x: number, y: number) => { tag: string } | null;
        };
      };
      const api = g.__agentHand;
      if (!api) throw new Error('missing page api');
      const doc = g.document;
      const city = doc.getElementById('city');
      if (!city) throw new Error('missing city');
      let protoSets = 0;
      const desc = Object.getOwnPropertyDescriptor(g.HTMLInputElement.prototype, 'value') as { get?: () => string; set?: (value: string) => void } | undefined;
      if (!desc?.set || !desc.get) throw new Error('missing value descriptor');
      const setter = desc.set;
      const getter = desc.get;
      Object.defineProperty(g.HTMLInputElement.prototype, 'value', {
        configurable: true,
        get(this: object) { return getter.call(this); },
        set(this: object, value: string) {
          protoSets += 1;
          setter.call(this, value);
        },
      });
      let model = city.value;
      city.addEventListener('input', () => { model = city.value; });
      const color = doc.getElementById('color');
      if (!color) throw new Error('missing color');
      color.addEventListener('change', () => {
        const state = doc.getElementById('color-state');
        if (state) state.textContent = color.value;
      });
      const pet = doc.getElementById('pet');
      const petList = doc.getElementById('pet-list');
      if (!pet || !petList) throw new Error('missing pet');
      pet.addEventListener('click', () => petList.removeAttribute('hidden'));
      let petChoice = '';
      petList.addEventListener('click', (event) => {
        const option = event.target?.closest('[role="option"]');
        petChoice = option?.textContent?.trim() ?? '';
      });
      let hovered = 0;
      let doubled = 0;
      let right = 0;
      doc.getElementById('hover')?.addEventListener('mouseover', () => { hovered += 1; });
      doc.getElementById('dbl')?.addEventListener('dblclick', () => { doubled += 1; });
      doc.getElementById('menu')?.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        right += 1;
      });
      const elements = api.collect().elements;
      const id = (name: string) => {
        const found = elements.find((item) => item.name === name);
        if (!found) throw new Error(`missing ${name}`);
        return found.ahId;
      };
      const filled = api.setValue(id('City'), 'Paris');
      const noteSet = api.setValue(id('Note'), 'Fresh');
      const native = api.selectOption(id('Color'), 'Green', false, true);
      const closed = api.selectOption(id('Pet'), 'Dog', false, true);
      pet.click();
      const opened = api.selectOption(id('Pet'), 'Dog', true, true);
      if (opened.action === 'click' && opened.x != null && opened.y != null) api.syntheticClick(opened.x, opened.y);
      const ambiguous = api.selectOption(id('Color'), 'e', false, false);
      const center = (elementId: string) => {
        const node = doc.getElementById(elementId);
        const rect = node?.getBoundingClientRect();
        return { x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2 };
      };
      const hoverAt = center('hover');
      const dblAt = center('dbl');
      const menuAt = center('menu');
      api.syntheticHover(hoverAt.x, hoverAt.y);
      api.syntheticDblclick(dblAt.x, dblAt.y);
      api.syntheticRightClick(menuAt.x, menuAt.y);
      return {
        filled,
        noteSet,
        protoSets,
        model,
        noteText: doc.getElementById('note')?.textContent,
        native,
        color: doc.getElementById('color-state')?.textContent,
        closed,
        opened,
        petChoice,
        ambiguous,
        hovered,
        doubled,
        right,
      };
    });
    assert.equal(result.filled, true);
    assert.equal(result.noteSet, true);
    assert.ok(result.protoSets >= 1);
    assert.equal(result.model, 'Paris');
    assert.equal(result.noteText, 'Fresh');
    assert.equal(result.native.action, 'native');
    assert.equal(result.native.value, 'green');
    assert.equal(result.color, 'green');
    assert.equal(result.closed.action, 'open');
    assert.equal(result.opened.action, 'click');
    assert.equal(result.petChoice, 'Dog');
    assert.equal(result.ambiguous.action, 'error');
    assert.match(result.ambiguous.error ?? '', /ambiguous/);
    assert.equal(result.hovered, 1);
    assert.equal(result.doubled, 1);
    assert.equal(result.right, 1);
  } finally {
    await browser.close();
  }
});
