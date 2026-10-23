import { MAX_SNAPSHOT_ITEMS } from '../../shared/snapshot.js';
import { waitForScroll } from '../../shared/scroll.js';

type Box = { x: number; y: number; width: number; height: number };
type PageElement = {
  ahId: string;
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  disabled: boolean;
  checked?: boolean | 'mixed';
};
type FrameRect = { src: string; x: number; y: number; width: number; height: number };
type LocateHit = { text: string; tag: string; x: number; y: number; width: number; height: number };
type ConsoleLine = { level: string; text: string; time: number; source: 'page' };
type KeySpec = { key?: string; code?: string; keyCode?: number; text?: string; modifiers?: number };
type SelectPlan =
  | { action: 'native'; value: string; label: string }
  | { action: 'click'; x: number; y: number; label: string }
  | { action: 'open' }
  | { action: 'error'; error: string };

export type PageApi = {
  collect: () => { elements: PageElement[] };
  prepare: (ahId: string) => Promise<Box | { error: string }>;
  frameOffset: () => { x: number; y: number } | null;
  iframeRects: () => FrameRect[];
  scrollFrame: (url: string) => void;
  waitForScroll: () => Promise<void>;
  focus: (ahId: string) => void;
  metrics: () => { cssWidth: number; cssHeight: number; devicePixelRatio: number };
  /** Real window chrome, read before a device-metrics override replaces innerWidth. */
  windowChrome: () => { outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number; devicePixelRatio: number };
  text: () => string;
  pageInfo: () => { href: string; title: string };
  syntheticClick: (x: number, y: number, pointerType?: string) => { tag: string; text: string } | null;
  syntheticHover: (x: number, y: number) => { tag: string; text: string } | null;
  syntheticDblclick: (x: number, y: number, pointerType?: string) => { tag: string; text: string } | null;
  syntheticRightClick: (x: number, y: number) => { tag: string; text: string } | null;
  /** Drop pointer-events on a disabled picker field so a trusted click hits its wrapper. */
  armClick: (x: number, y: number) => void;
  locate: (text: string) => LocateHit[];
  setValue: (ahId: string, value: string) => boolean;
  selectContents: (ahId: string) => boolean;
  selectOption: (ahId: string, query: string, opened?: boolean, apply?: boolean) => SelectPlan;
  resourceTiming: () => { readyState: string; resources: number };
  syntheticKey: (spec: KeySpec, force?: boolean) => { acted: boolean };
  syntheticScroll: (x: number, y: number, deltaX: number, deltaY: number) => boolean;
  cursorMove: (x: number, y: number, label: string, duration: number) => Promise<void>;
  cursorRipple: () => void;
  cursorLabel: (label: string) => void;
  consoleEntries: (clear: boolean, max: number) => ConsoleLine[];
};

const OVERLAY_ID = 'agent-hand-root';
const OWNER = `ah-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

const SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"]):not([type="file"])',
  'textarea',
  'select',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="slider"]',
  'uni-button',
  'uni-checkbox',
  'uni-radio',
  'uni-switch',
  'uni-picker',
  'uni-navigator',
  'uni-label',
  '.uni-select',
  '.uni-select__selector-item',
  '.uni-combox__selector-item',
  '.checklist-box',
  '[onclick]',
].join(',');

const elementIds = new WeakMap<Element, string>();
let byId = new Map<string, Element>();
const consoleLog: ConsoleLine[] = [];
let consolePatched = false;

let cursorWait = false;
let shown = false;
let cursorX = 36;
let cursorY = 36;
let animToken = 0;
let labelTimer = 0;
let keeperTimer = 0;
let keeperObserver: MutationObserver | null = null;
let host: HTMLDivElement | null = null;
let cursorEl: HTMLDivElement | null = null;
let labelEl: HTMLDivElement | null = null;

/** Drop duplicate #agent-hand-root nodes, keeping the current owner if one is stamped. */
export function collapseOverlays(): void {
  const owner = document.documentElement?.getAttribute('data-agent-hand-owner');
  const nodes = [...document.querySelectorAll(`#${OVERLAY_ID}`)];
  if (nodes.length <= 1) return;
  const keep = (owner && nodes.find((node) => node.getAttribute('data-agent-hand-owner') === owner)) || nodes[0];
  for (const node of nodes) {
    if (node !== keep) node.remove();
  }
}

export function installPageApi(): PageApi {
  patchConsole();
  if (window === window.top) ensureCursor();
  return {
    collect,
    prepare,
    frameOffset,
    iframeRects,
    scrollFrame,
    waitForScroll: () => waitForScroll(window),
    focus,
    metrics,
    windowChrome,
    text,
    pageInfo,
    syntheticClick,
    syntheticHover,
    syntheticDblclick,
    syntheticRightClick,
    armClick,
    locate,
    setValue,
    selectContents,
    selectOption,
    resourceTiming,
    syntheticKey,
    syntheticScroll,
    cursorMove,
    cursorRipple,
    cursorLabel,
    consoleEntries,
  };
}

function collect(): { elements: PageElement[] } {
  const next = new Map<string, Element>();
  const elements: PageElement[] = [];
  const seen = new Set<Element>();
  const indexOf = new Map<Element, number>();
  const add = (el: Element, role?: string, name?: string, boxFrom?: Element) => {
    const resolvedRole = role ?? roleOf(el);
    const resolvedName = name ?? accessibleName(el);
    if (seen.has(el)) {
      const index = indexOf.get(el);
      if (index == null) return;
      if (resolvedName && !elements[index].name) elements[index].name = resolvedName;
      return;
    }
    if (elements.length >= MAX_SNAPSHOT_ITEMS) return;
    seen.add(el);
    const id = idFor(el);
    next.set(id, el);
    const rect = visibleBox(el, boxFrom);
    const item: PageElement = {
      ahId: id,
      role: resolvedRole,
      name: resolvedName,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      disabled: isDisabled(el),
    };
    const checked = checkedOf(el, resolvedRole);
    if (checked !== undefined) item.checked = checked;
    indexOf.set(el, elements.length);
    elements.push(item);
  };
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (elements.length >= MAX_SNAPSHOT_ITEMS) break;
    if (!isCandidate(el)) continue;
    const lifted = liftField(el);
    if (lifted) {
      add(lifted.host, lifted.role, lifted.name, el);
      continue;
    }
    add(el);
  }
  if (elements.length < MAX_SNAPSHOT_ITEMS) {
    for (const img of document.querySelectorAll('img, uni-image, [role="img"]')) {
      if (elements.length >= MAX_SNAPSHOT_ITEMS) break;
      const card = imageCard(img);
      if (!card || seen.has(card) || !isCandidate(card)) continue;
      add(card, 'clickable', nameForCard(card, img));
    }
  }
  if (elements.length < MAX_SNAPSHOT_ITEMS) addTabLike(add, seen);
  if (elements.length < MAX_SNAPSHOT_ITEMS && document.body) {
    for (const el of document.body.querySelectorAll('*')) {
      if (elements.length >= MAX_SNAPSHOT_ITEMS) break;
      if (seen.has(el) || !(el instanceof HTMLElement)) continue;
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      const parent = el.parentElement;
      if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
      if ([...el.children].some((child) => seen.has(child))) continue;
      const listed = el.closest(SELECTOR);
      if (listed && listed !== el) continue;
      if (!isCandidate(el)) continue;
      add(el, 'clickable');
    }
  }
  // A generic pointer container adds no distinct target when its actionable
  // descendants already have refs. Keep explicit buttons and links intact.
  const targets = [...next.values()];
  const actionable = elements.filter((item) => {
    const el = next.get(item.ahId)!;
    return item.role !== 'clickable' || !targets.some((child) => child !== el && el.contains(child));
  });
  byId = new Map(actionable.map((item) => [item.ahId, next.get(item.ahId)!]));
  return { elements: actionable };
}

function prepare(ahId: string): Promise<Box | { error: string }> {
  const el = byId.get(ahId);
  if (!el || !el.isConnected) return Promise.resolve({ error: 'element is gone; take a new snapshot' });
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  suppressBlockedFields(el);
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const rect = visibleBox(el);
        if (rect.width < 1 || rect.height < 1) {
          resolve({ error: 'element has no box after scroll' });
          return;
        }
        resolve({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
        });
      });
    });
  });
}

function frameOffset(): { x: number; y: number } | null {
  try {
    if (window === window.top) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    let current: Window = window;
    const guard = new Set<Window>();
    while (current !== current.top) {
      if (guard.has(current)) return null;
      guard.add(current);
      const frameEl = current.frameElement;
      if (!frameEl) return null;
      const parent = current.parent;
      const rect = frameEl.getBoundingClientRect();
      const style = parent.getComputedStyle(frameEl);
      x += rect.left + frameEl.clientLeft + (Number.parseFloat(style.paddingLeft) || 0);
      y += rect.top + frameEl.clientTop + (Number.parseFloat(style.paddingTop) || 0);
      current = parent;
    }
    return { x, y };
  } catch {
    return null;
  }
}

function iframeRects(): FrameRect[] {
  return [...document.querySelectorAll('iframe,frame')].map((node) => {
    const el = node as HTMLIFrameElement;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      src: el.src,
      x: rect.left + el.clientLeft + (Number.parseFloat(style.paddingLeft) || 0),
      y: rect.top + el.clientTop + (Number.parseFloat(style.paddingTop) || 0),
      width: el.clientWidth,
      height: el.clientHeight,
    };
  });
}

function scrollFrame(url: string): void {
  const frames = [...document.querySelectorAll('iframe,frame')] as HTMLIFrameElement[];
  const match = frames.find((frame) => frame.src === url) ?? (frames.length === 1 ? frames[0] : undefined);
  match?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
}

function focus(ahId: string): void {
  const el = byId.get(ahId);
  if (el instanceof HTMLElement) el.focus();
}

function metrics(): { cssWidth: number; cssHeight: number; devicePixelRatio: number } {
  return {
    cssWidth: window.innerWidth,
    cssHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function windowChrome(): { outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number; devicePixelRatio: number } {
  return {
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function text(): string {
  return document.body?.innerText ?? '';
}

function pageInfo(): { href: string; title: string } {
  return { href: location.href, title: document.title };
}

function syntheticClick(x: number, y: number, pointerType = 'mouse'): { tag: string; text: string } | null {
  const target = hitTarget(x, y);
  if (!(target instanceof HTMLElement) && !(target instanceof SVGElement)) return null;
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
  if (pointerType === 'touch') {
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    dispatchTouch(target, 'touchstart', x, y);
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.focus();
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    dispatchTouch(target, 'touchend', x, y);
    target.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
  } else {
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.focus();
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
  }
  const label = target instanceof HTMLElement ? target.innerText : target.textContent || '';
  return { tag: target.tagName.toLowerCase(), text: clean(label).slice(0, 40) };
}

function syntheticHover(x: number, y: number): { tag: string; text: string } | null {
  const target = hitTarget(x, y);
  if (!(target instanceof HTMLElement) && !(target instanceof SVGElement)) return null;
  const init = pointInit(x, y, 0);
  target.dispatchEvent(new PointerEvent('pointerover', { ...init, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mouseover', init));
  target.dispatchEvent(new PointerEvent('pointerenter', { ...init, pointerType: 'mouse', isPrimary: true, bubbles: false }));
  target.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
  target.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mousemove', init));
  return described(target);
}

function syntheticDblclick(x: number, y: number, pointerType = 'mouse'): { tag: string; text: string } | null {
  const first = syntheticClick(x, y, pointerType);
  if (!first) return null;
  const target = hitTarget(x, y);
  if (!(target instanceof HTMLElement) && !(target instanceof SVGElement)) return first;
  const init = pointInit(x, y, 0);
  if (pointerType === 'touch') {
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    dispatchTouch(target, 'touchstart', x, y);
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    dispatchTouch(target, 'touchend', x, y);
  } else {
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', init));
  }
  target.dispatchEvent(new MouseEvent('click', { ...init, detail: 2 }));
  target.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
  return described(target);
}

function syntheticRightClick(x: number, y: number): { tag: string; text: string } | null {
  const target = hitTarget(x, y);
  if (!(target instanceof HTMLElement) && !(target instanceof SVGElement)) return null;
  const init = pointInit(x, y, 2);
  target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true, button: 2, buttons: 2 }));
  target.dispatchEvent(new MouseEvent('mousedown', { ...init, button: 2, buttons: 2 }));
  target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true, button: 2, buttons: 0 }));
  target.dispatchEvent(new MouseEvent('mouseup', { ...init, button: 2, buttons: 0 }));
  target.dispatchEvent(new MouseEvent('contextmenu', { ...init, button: 2, buttons: 0 }));
  return described(target);
}

function pointInit(x: number, y: number, button: number): MouseEventInit {
  return { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button };
}

function described(target: Element): { tag: string; text: string } {
  const label = target instanceof HTMLElement ? target.innerText : target.textContent || '';
  return { tag: target.tagName.toLowerCase(), text: clean(label).slice(0, 40) };
}

function locate(query: string): LocateHit[] {
  const wanted = query.trim();
  if (!wanted) return [];
  const all = [...document.querySelectorAll('body *')].filter((el) => el instanceof HTMLElement && !el.closest(`#${OVERLAY_ID}`)) as HTMLElement[];
  const norm = (value: string) => value.replace(/\s+/g, '').trim();
  const needle = norm(wanted);
  const pick = (exact: boolean) => all.filter((el) => {
    const value = norm(el.innerText || '');
    if (!(exact ? value === needle : value.includes(needle))) return false;
    return ![...el.children].some((child) => {
      const childText = norm((child as HTMLElement).innerText || '');
      return exact ? childText === needle : childText.includes(needle);
    });
  }).filter((el) => isVisible(el));
  const found = pick(true).length ? pick(true) : pick(false);
  return found.slice(0, 10).map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      text: clean(el.innerText || ''),
      tag: el.tagName.toLowerCase(),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
}

function setValue(ahId: string, value: string): boolean {
  const el = byId.get(ahId);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    writeNativeValue(el, value);
    return true;
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    el.focus();
    el.innerText = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

function writeNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus();
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectContents(ahId: string): boolean {
  const el = byId.get(ahId);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    try {
      el.setSelectionRange(0, el.value.length);
    } catch {
      return false;
    }
    return true;
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }
  return false;
}

function resourceTiming(): { readyState: string; resources: number } {
  return {
    readyState: document.readyState,
    resources: performance.getEntriesByType('resource').length,
  };
}

const OPTION_QUERY = '[role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

function selectOption(ahId: string, query: string, opened = false, apply = true): SelectPlan {
  const el = byId.get(ahId);
  if (!el || !el.isConnected) return { action: 'error', error: 'element is gone; take a new snapshot' };
  const wanted = query.trim();
  if (!wanted) return { action: 'error', error: 'value is required' };
  if (el instanceof HTMLSelectElement) {
    const chosen = matchNative(el, wanted);
    if (!chosen) return { action: 'error', error: `no option matching ${JSON.stringify(wanted)}. A native select matches the option value or its visible label.` };
    if ('error' in chosen) return { action: 'error', error: chosen.error };
    if (apply) applyNative(el, chosen.option);
    return { action: 'native', value: chosen.option.value, label: optionLabel(chosen.option) };
  }
  if (el instanceof HTMLElement && isOptionLike(el)) {
    const own = pickElements([el], wanted);
    if (own && 'el' in own) {
      const point = centerOf(own.el);
      if (!point) return { action: 'error', error: 'option is not visible' };
      return { action: 'click', ...point, label: optionName(own.el) };
    }
  }
  const scope = optionScope(el, opened);
  const found = pickElements(visibleOptions(scope), wanted);
  if (found && 'error' in found) return { action: 'error', error: found.error };
  if (found && 'el' in found) {
    const point = centerOf(found.el);
    if (!point) return { action: 'error', error: 'option is not visible' };
    return { action: 'click', ...point, label: optionName(found.el) };
  }
  if (!opened && canOpen(el)) return { action: 'open' };
  return {
    action: 'error',
    error: `no option matching ${JSON.stringify(wanted)}. Custom dropdowns need a visible role=option or role=menuitem in this document. Closed shadow DOM and other frames are not searched.`,
  };
}

function applyNative(select: HTMLSelectElement, option: HTMLOptionElement): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter) setter.call(select, option.value);
  else select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function matchNative(select: HTMLSelectElement, query: string): { option: HTMLOptionElement } | { error: string } | null {
  const options = [...select.options].filter((option) => !option.disabled);
  const exactValue = options.filter((option) => option.value === query);
  if (exactValue.length === 1) return { option: exactValue[0] };
  if (exactValue.length > 1) return { error: `ambiguous option ${JSON.stringify(query)}` };
  const exactLabel = options.filter((option) => optionLabel(option) === query);
  if (exactLabel.length === 1) return { option: exactLabel[0] };
  if (exactLabel.length > 1) return { error: `ambiguous option ${JSON.stringify(query)}` };
  const partial = options.filter((option) => optionLabel(option).includes(query) || option.value.includes(query));
  if (partial.length === 1) return { option: partial[0] };
  if (partial.length > 1) return { error: `ambiguous option ${JSON.stringify(query)}` };
  return null;
}

function optionLabel(option: HTMLOptionElement): string {
  return clean(option.label || option.text);
}

function optionScope(el: Element, opened: boolean): ParentNode {
  const controlled = controlledPopup(el);
  if (controlled) return controlled;
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'listbox' || role === 'menu') return el;
  const owner = el.closest('[role="listbox"], [role="menu"]');
  if (owner) return owner;
  if (opened) return document;
  return el;
}

function controlledPopup(el: Element): HTMLElement | null {
  const ids = `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''}`.trim().split(/\s+/);
  for (const id of ids) {
    if (!id) continue;
    const node = document.getElementById(id);
    if (node instanceof HTMLElement) return node;
  }
  return null;
}

function canOpen(el: Element): boolean {
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'combobox' || role === 'listbox' || role === 'menu') return true;
  if (roleOf(el) === 'combobox') return true;
  return el.hasAttribute('aria-controls') || el.hasAttribute('aria-owns') || el.hasAttribute('aria-haspopup');
}

function visibleOptions(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll(OPTION_QUERY)].filter((node): node is HTMLElement => {
    return node instanceof HTMLElement && isOptionLike(node) && isVisible(node) && node.getAttribute('aria-disabled') !== 'true';
  });
}

function isOptionLike(el: Element): boolean {
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'option' || role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') return true;
  return roleOf(el) === 'option';
}

function pickElements(elements: HTMLElement[], query: string): { el: HTMLElement } | { error: string } | null {
  const exact = elements.filter((el) => exactOption(el, query));
  if (exact.length === 1) return { el: exact[0] };
  if (exact.length > 1) return { error: `ambiguous option ${JSON.stringify(query)}` };
  const partial = elements.filter((el) => partialOption(el, query));
  if (partial.length === 1) return { el: partial[0] };
  if (partial.length > 1) return { error: `ambiguous option ${JSON.stringify(query)}` };
  return null;
}

function exactOption(el: HTMLElement, query: string): boolean {
  return optionName(el) === query || optionValue(el) === query;
}

function partialOption(el: HTMLElement, query: string): boolean {
  const name = optionName(el);
  const value = optionValue(el);
  return Boolean((name && name.includes(query)) || (value && value.includes(query)));
}

function optionName(el: HTMLElement): string {
  return clean(accessibleName(el) || el.innerText || el.textContent || '');
}

function optionValue(el: HTMLElement): string {
  return clean(el.getAttribute('data-value') || el.getAttribute('value') || '');
}

function centerOf(el: Element): { x: number; y: number } | null {
  if (!isVisible(el)) return null;
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function syntheticKey(spec: KeySpec, force = false): { acted: boolean } {
  const active = document.activeElement;
  if (active instanceof HTMLIFrameElement || active instanceof HTMLFrameElement) return { acted: false };
  const specific = active instanceof HTMLElement && active !== document.body && active !== document.documentElement;
  if (!force && !document.hasFocus()) return { acted: false };
  if (!specific && window !== window.top) return { acted: false };
  const target = specific ? active : document.body;
  if (!target) return { acted: false };
  const modifiers = typeof spec.modifiers === 'number' ? spec.modifiers : 0;
  const init: KeyboardEventInit = {
    key: spec.key || '',
    code: spec.code || '',
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: (modifiers & 2) !== 0,
    altKey: (modifiers & 1) !== 0,
    metaKey: (modifiers & 4) !== 0,
    shiftKey: (modifiers & 8) !== 0,
  };
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  const text = spec.text;
  if (text && text.length === 1 && text >= ' ' && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const next = target.value.slice(0, start) + text + target.value.slice(end);
    const proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(target, next);
    else target.value = next;
    if (typeof target.setSelectionRange === 'function') target.setSelectionRange(start + text.length, start + text.length);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return { acted: true };
}

function syntheticScroll(x: number, y: number, deltaX: number, deltaY: number): boolean {
  const restore = hideOverlays();
  const hit = document.elementFromPoint(x, y);
  restore();
  const target = hit instanceof Element ? hit : document.scrollingElement || document.documentElement;
  if (!target) return false;
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    deltaX,
    deltaY,
  });
  target.dispatchEvent(event);
  if (!event.defaultPrevented) window.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
  return true;
}

function consoleEntries(clear: boolean, max: number): ConsoleLine[] {
  const cap = Number.isFinite(max) && max > 0 ? Math.min(500, Math.floor(max)) : 100;
  const out = consoleLog.slice(-cap);
  if (clear) consoleLog.length = 0;
  return out;
}

function patchConsole(): void {
  if (consolePatched) return;
  consolePatched = true;
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const level of methods) {
    const original = console[level]?.bind(console);
    if (!original) continue;
    console[level] = ((...args: unknown[]) => {
      pushConsole(level, args.map(formatConsole).join(' '));
      original(...args);
    }) as typeof console.log;
  }
  window.addEventListener('error', (event) => {
    pushConsole('error', event.message || 'error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'unhandledrejection';
    pushConsole('error', text);
  });
}

function pushConsole(level: string, text: string): void {
  consoleLog.push({ level, text: text.slice(0, 500), time: Date.now(), source: 'page' });
  if (consoleLog.length > 200) consoleLog.splice(0, consoleLog.length - 200);
}

function formatConsole(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function dispatchTouch(target: Element, type: string, x: number, y: number): void {
  try {
    const touch = new Touch({
      identifier: 1,
      target,
      clientX: x,
      clientY: y,
      pageX: x + window.scrollX,
      pageY: y + window.scrollY,
      radiusX: 1,
      radiusY: 1,
      force: type === 'touchend' ? 0 : 1,
    });
    const ended = type === 'touchend';
    target.dispatchEvent(new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      touches: ended ? [] : [touch],
      targetTouches: ended ? [] : [touch],
      changedTouches: [touch],
    }));
  } catch {
    // PointerEvent was already sent. Some webviews reject Touch construction.
  }
}

function hideOverlays(): () => void {
  const nodes = [...document.querySelectorAll(`#${OVERLAY_ID}`)] as HTMLElement[];
  const previous = nodes.map((node) => node.style.display);
  for (const node of nodes) node.style.setProperty('display', 'none', 'important');
  return () => {
    nodes.forEach((node, index) => {
      if (previous[index]) node.style.display = previous[index];
      else node.style.removeProperty('display');
    });
    if (host) pinHost();
  };
}

function isCandidate(el: Element): boolean {
  if (el.id === OVERLAY_ID || el.closest(`#${OVERLAY_ID}`)) return false;
  if (el.closest('[inert]')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  return isVisible(el);
}

const TAB_SELECTOR = '.uni-tab, .uni-tabbar__item, .tabs-item, .tab-item, .tab';

function addTabLike(
  add: (el: Element, role?: string, name?: string) => void,
  seen: Set<Element>,
): void {
  for (const el of document.querySelectorAll(TAB_SELECTOR)) {
    const name = tabLabel(el);
    if (!name || !canListTab(el, seen)) continue;
    add(el, 'tab', name);
  }
  for (const el of document.querySelectorAll('div, span, li, uni-view, view')) {
    if (!hasVueClick(el)) continue;
    const name = tabLabel(el);
    if (!name || !canListTab(el, seen)) continue;
    add(el, 'clickable', name);
  }
  if (!document.body) return;
  const parents = new Set<Element>();
  for (const el of document.body.querySelectorAll('div, uni-view, view')) {
    if (el.parentElement) parents.add(el.parentElement);
  }
  for (const parent of parents) {
    const row = horizontalTabs(parent);
    if (!row) continue;
    for (const el of row) {
      if (seen.has(el)) continue;
      const name = tabLabel(el);
      if (!name) continue;
      add(el, 'tab', name);
    }
  }
}

function canListTab(el: Element, seen: Set<Element>): boolean {
  if (seen.has(el) || !isCandidate(el)) return false;
  if (el.closest(`#${OVERLAY_ID}, button, a[href], [role="button"], uni-button, uni-picker, label`)) return false;
  if (el.querySelector('input, textarea, select, img, uni-image')) return false;
  const rect = el.getBoundingClientRect();
  return rect.height >= 2 && rect.height <= 64 && rect.width >= 2 && rect.width <= 240;
}

function tabLabel(el: Element): string {
  const text = clean((el as HTMLElement).innerText || el.textContent || '');
  if (!text || text.length > 12) return '';
  return text;
}

function hasVueClick(el: Element): boolean {
  const host = el as Element & {
    __vnode?: { props?: Record<string, unknown> | null };
    __vue__?: { $listeners?: { click?: unknown } };
  };
  if (host.__vue__?.$listeners?.click) return true;
  const props = host.__vnode?.props;
  if (!props) return false;
  return Boolean(props.onClick || props.onClickOnce || props.onTap);
}

function horizontalTabs(parent: Element): Element[] | null {
  const kids = [...parent.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
  if (kids.length < 2 || kids.length > 8) return null;
  const boxes = kids.map((el) => ({ el, rect: el.getBoundingClientRect(), name: tabLabel(el) }));
  if (!boxes.every((item) => item.name && item.rect.height >= 2 && item.rect.height <= 64 && item.rect.width <= 240)) return null;
  if (boxes.some((item) => item.el.querySelector('img, uni-image, input, textarea, select'))) return null;
  const top = boxes[0].rect.top;
  if (!boxes.every((item) => Math.abs(item.rect.top - top) <= 12)) return null;
  for (let index = 1; index < boxes.length; index += 1) {
    if (boxes[index].rect.left + 4 < boxes[index - 1].rect.left) return null;
  }
  if (boxes.some((item) => !isCandidate(item.el))) return null;
  if (boxes.some((item) => item.el.closest('button, a[href], [role="button"], uni-button, uni-picker, label'))) return null;
  return boxes.map((item) => item.el);
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (Number.parseFloat(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
    return false;
  }
  return true;
}

function idFor(el: Element): string {
  let id = elementIds.get(el);
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `ah-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    elementIds.set(el, id);
  }
  return id;
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'uni-button') return 'button';
  if (tag === 'uni-checkbox') return 'checkbox';
  if (tag === 'uni-radio') return 'radio';
  if (tag === 'uni-switch') return 'switch';
  if (tag === 'uni-picker' || (el instanceof HTMLElement && el.classList.contains('uni-select'))) return 'combobox';
  if (
    el instanceof HTMLElement
    && (el.classList.contains('uni-select__selector-item') || el.classList.contains('uni-combox__selector-item'))
  ) {
    return 'option';
  }
  if (tag.startsWith('uni-') || el.hasAttribute('onclick') || (el instanceof HTMLElement && el.classList.contains('checklist-box'))) {
    return 'clickable';
  }
  if (tag === 'a') return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
    return 'textbox';
  }
  if (el.getAttribute('contenteditable') === 'true') return 'textbox';
  return tag;
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return clean(aria);
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (text.trim()) return clean(text);
  }
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.textContent?.trim()) return clean(label.textContent);
  }
  const wrapping = el.closest('label');
  if (wrapping) {
    const clone = wrapping.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input,textarea,select,button').forEach((node) => node.remove());
    if (clone.textContent?.trim()) return clean(clone.textContent);
  }
  const placeholder = el.getAttribute('placeholder');
  if (placeholder?.trim()) return clean(placeholder);
  const alt = el.getAttribute('alt') || el.getAttribute('title');
  if (alt?.trim()) return clean(alt);
  if (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'button') && el.value) {
    return clean(el.value);
  }
  const text = clean((el as HTMLElement).innerText || el.textContent || '');
  if (text) return text;
  const fromImage = imageAlt(el);
  if (fromImage) return fromImage;
  return nearbyLabel(el);
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function isDisabled(el: Element): boolean {
  if (
    el instanceof HTMLInputElement
    || el instanceof HTMLButtonElement
    || el instanceof HTMLSelectElement
    || el instanceof HTMLTextAreaElement
  ) {
    if (el.disabled) return true;
  }
  return el.getAttribute('aria-disabled') === 'true';
}

let suppressedRestore: (() => void) | null = null;

function visibleBox(el: Element, fallback?: Element): { left: number; top: number; width: number; height: number } {
  const rect = el.getBoundingClientRect();
  if (rect.width >= 2 && rect.height >= 2) return rect;
  if (fallback) {
    const inner = fallback.getBoundingClientRect();
    if (inner.width >= 2 && inner.height >= 2) return inner;
  }
  const nested = el.querySelector('input, textarea, button, img');
  if (nested) {
    const inner = nested.getBoundingClientRect();
    if (inner.width >= 2 && inner.height >= 2) return inner;
  }
  return rect;
}

function liftField(el: Element): { host: Element; role: string; name: string } | null {
  if (!isBlockedTextField(el)) return null;
  const host = pickerHost(el);
  if (!host || host === el) return null;
  const role = isPickerish(host) ? 'combobox' : 'clickable';
  return { host, role, name: fieldFaceName(host, el) };
}

function fieldFaceName(host: Element, field: Element): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const value = field.value.trim();
    if (value) return clean(value);
  }
  return accessibleName(field) || accessibleName(host) || field.getAttribute('placeholder') || '';
}

function isBlockedTextField(el: Element): boolean {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
  const type = (el instanceof HTMLInputElement ? el.type : 'text').toLowerCase();
  if (['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range'].includes(type)) return false;
  return el.disabled || el.readOnly || el.hasAttribute('readonly') || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-readonly') === 'true';
}

function pickerHost(el: Element): Element | null {
  const inputRect = el.getBoundingClientRect();
  let node = el.parentElement;
  let depth = 0;
  let uniCandidate: Element | null = null;
  while (node && node !== document.body && node !== document.documentElement && depth < 8) {
    if (isPickerHost(node)) return node;
    const tag = node.tagName.toLowerCase();
    if (!uniCandidate && (tag === 'uni-view' || tag === 'view')) {
      const rect = node.getBoundingClientRect();
      if (
        rect.height >= 2
        && rect.height <= Math.max(96, inputRect.height * 3)
        && rect.width <= Math.max(480, inputRect.width * 2)
      ) {
        uniCandidate = node;
      }
    }
    node = node.parentElement;
    depth += 1;
  }
  return uniCandidate;
}

function isPickerHost(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'uni-picker' || tag === 'uni-datetime-picker' || tag === 'uni-data-picker') return true;
  if (el.classList.contains('uni-date-editor') || el.classList.contains('uni-date') || el.classList.contains('uni-picker')) return true;
  if (el.hasAttribute('onclick')) return true;
  const role = el.getAttribute('role');
  if (role === 'button' || role === 'combobox') return true;
  return el instanceof HTMLElement && getComputedStyle(el).cursor === 'pointer';
}

function isPickerish(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === 'uni-picker'
    || tag === 'uni-datetime-picker'
    || tag === 'uni-data-picker'
    || el.classList.contains('uni-date-editor')
    || el.classList.contains('uni-date')
    || el.classList.contains('uni-picker');
}

function imageCard(img: Element): Element | null {
  if (img.closest(`#${OVERLAY_ID}`)) return null;
  if (img.closest('button, a[href], [role="button"], uni-button, uni-picker')) return null;
  if (isClickableHint(img)) return img;
  const hinted = clickableHintAncestor(img);
  if (hinted) return hinted;
  let node = img.parentElement;
  while (node && node !== document.body) {
    if (looksLikeTile(node) && hasImageSibling(node)) return node;
    node = node.parentElement;
  }
  return null;
}

function isClickableHint(el: Element): boolean {
  if (el.hasAttribute('onclick')) return true;
  const role = el.getAttribute('role');
  if (role === 'button' || role === 'link') return true;
  if (!(el instanceof HTMLElement) || getComputedStyle(el).cursor !== 'pointer') return false;
  // cursor inherits. A child of a pointer card is not its own target.
  const parent = el.parentElement;
  return !parent || getComputedStyle(parent).cursor !== 'pointer';
}

function clickableHintAncestor(el: Element): Element | null {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    if (isClickableHint(node)) return node;
    node = node.parentElement;
  }
  return null;
}

function looksLikeTile(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width >= 24 && rect.height >= 24 && rect.width <= 480 && rect.height <= 640;
}

function hasImageSibling(el: Element): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  let count = 0;
  for (const child of parent.children) {
    const tag = child.tagName.toLowerCase();
    if (child === el || tag === 'img' || tag === 'uni-image' || child.querySelector('img, uni-image')) count += 1;
    if (count >= 2) return true;
  }
  return false;
}

function nameForCard(card: Element, img: Element): string {
  const own = accessibleName(card);
  if (own) return own;
  const alt = img.getAttribute('alt') || img.getAttribute('aria-label') || '';
  if (alt.trim()) return clean(alt);
  return nearbyLabel(card) || nearbyLabel(img);
}

function imageAlt(el: Element): string {
  if (el.matches('img, uni-image, [role="img"]')) {
    const own = el.getAttribute('alt') || el.getAttribute('aria-label') || '';
    if (own.trim()) return clean(own);
  }
  for (const img of el.querySelectorAll('img, uni-image, [role="img"]')) {
    const alt = img.getAttribute('alt') || img.getAttribute('aria-label') || '';
    if (alt.trim()) return clean(alt);
  }
  return '';
}

function nearbyLabel(el: Element): string {
  for (const sib of [el.previousElementSibling, el.nextElementSibling]) {
    if (!sib) continue;
    const text = clean(sib.textContent || '');
    if (text && text.length <= 40) return text;
  }
  return '';
}

function checkedOf(el: Element, role: string): boolean | 'mixed' | undefined {
  if (role !== 'checkbox' && role !== 'radio' && role !== 'switch') return undefined;
  const aria = el.getAttribute('aria-checked');
  if (aria === 'mixed') return 'mixed';
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
  if (el.matches('.uni-checkbox-input-checked, .uni-radio-input-checked, .uni-switch-input-checked')) return true;
  if (el.querySelector('.uni-checkbox-input-checked, .uni-radio-input-checked, .uni-switch-input-checked')) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'uni-checkbox' || tag === 'uni-radio' || tag === 'uni-switch') return false;
  if (el.querySelector('.uni-checkbox-input, .uni-radio-input, .uni-switch-input')) return false;
  const inner = el.querySelector('input[type="checkbox"], input[type="radio"]');
  if (inner instanceof HTMLInputElement) return inner.checked;
  return undefined;
}

function armClick(x: number, y: number): void {
  const restoreOverlay = hideOverlays();
  const el = document.elementFromPoint(x, y);
  restoreOverlay();
  if (!(el instanceof HTMLElement) || !isBlockedTextField(el) || !pickerHost(el)) return;
  suppressElement(el);
}

function hitTarget(x: number, y: number): Element | null {
  const restoreOverlay = hideOverlays();
  let el = document.elementFromPoint(x, y);
  restoreOverlay();
  if (!(el instanceof HTMLElement) || !isBlockedTextField(el)) return el;
  const host = pickerHost(el);
  if (!host) return el;
  suppressElement(el);
  const again = hideOverlays();
  const under = document.elementFromPoint(x, y);
  again();
  if (under && under !== el) return under;
  return host;
}

function suppressBlockedFields(root: Element): void {
  const fields = [...root.querySelectorAll('input, textarea')].filter(isBlockedTextField);
  if (isBlockedTextField(root)) fields.unshift(root);
  if (!fields.length) return;
  restoreSuppressed();
  const saved = fields.map((node) => {
    const style = (node as HTMLElement).style;
    const prev = style.pointerEvents;
    const priority = style.getPropertyPriority('pointer-events');
    style.setProperty('pointer-events', 'none', 'important');
    return { node: node as HTMLElement, prev, priority };
  });
  const restore = () => {
    for (const item of saved) {
      if (item.prev) item.node.style.setProperty('pointer-events', item.prev, item.priority);
      else item.node.style.removeProperty('pointer-events');
    }
    if (suppressedRestore === restore) suppressedRestore = null;
  };
  suppressedRestore = restore;
  window.setTimeout(() => {
    if (suppressedRestore === restore) restore();
  }, 1500);
}

function suppressElement(el: HTMLElement): void {
  restoreSuppressed();
  const prev = el.style.pointerEvents;
  const priority = el.style.getPropertyPriority('pointer-events');
  el.style.setProperty('pointer-events', 'none', 'important');
  const restore = () => {
    if (prev) el.style.setProperty('pointer-events', prev, priority);
    else el.style.removeProperty('pointer-events');
    if (suppressedRestore === restore) suppressedRestore = null;
  };
  suppressedRestore = restore;
  window.setTimeout(() => {
    if (suppressedRestore === restore) restore();
  }, 1500);
}

function restoreSuppressed(): void {
  const restore = suppressedRestore;
  suppressedRestore = null;
  restore?.();
}

function ensureCursor(): void {
  if (window !== window.top) return;
  if (!document.documentElement) {
    if (cursorWait) return;
    cursorWait = true;
    document.addEventListener('DOMContentLoaded', () => {
      cursorWait = false;
      ensureCursor();
    }, { once: true });
    return;
  }
  if (host?.isConnected) {
    removeOtherOverlays(host);
    pinHost();
    return;
  }
  takeOwnership();
  removeOtherOverlays(null);
  host = buildHost();
  document.documentElement.appendChild(host);
  pinHost();
  startKeeper();
}

function takeOwnership(): void {
  document.documentElement?.setAttribute('data-agent-hand-owner', OWNER);
}

function removeOtherOverlays(keep: Element | null): void {
  for (const node of document.querySelectorAll(`#${OVERLAY_ID}`)) {
    if (keep && node === keep) continue;
    node.remove();
  }
}

function buildHost(): HTMLDivElement {
  const node = document.createElement('div');
  node.id = OVERLAY_ID;
  node.dataset.agentHandOwner = OWNER;
  node.setAttribute('aria-hidden', 'true');
  const shadow = node.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { pointer-events: none !important; box-sizing: border-box; }
    .cursor {
      position: absolute;
      top: 0;
      left: 0;
      width: 32px;
      height: 32px;
      will-change: transform;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
    }
    svg { display: block; overflow: visible; }
    .label {
      position: absolute;
      left: 20px;
      top: 18px;
      padding: 3px 7px;
      border-radius: 999px;
      background: #1c1917;
      color: #fff;
      font: 600 12px/1.2 ui-sans-serif, system-ui, sans-serif;
      white-space: nowrap;
      opacity: 0;
    }
    .ripple {
      position: absolute;
      left: 0;
      top: 0;
      width: 14px;
      height: 14px;
      margin: -7px 0 0 -7px;
      border: 2px solid #1d4ed8;
      border-radius: 50%;
      opacity: 0.9;
      animation: agent-hand-ripple 450ms ease-out forwards;
    }
    @keyframes agent-hand-ripple {
      from { transform: scale(0.35); opacity: 0.9; }
      to { transform: scale(2.8); opacity: 0; }
    }
  `;
  cursorEl = document.createElement('div');
  cursorEl.className = 'cursor';
  cursorEl.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M1 1 L1 22 L7.2 16.2 L12.4 26.4 L16.2 24.7 L11 14.6 L20 14 Z" fill="#1d4ed8" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
  `;
  labelEl = document.createElement('div');
  labelEl.className = 'label';
  cursorEl.append(labelEl);
  shadow.append(style, cursorEl);
  return node;
}

function startKeeper(): void {
  if (keeperObserver || keeperTimer) return;
  const root = document.documentElement;
  if (!root) return;
  keeperObserver = new MutationObserver(() => reconcileOverlay());
  keeperObserver.observe(root, { childList: true });
  keeperTimer = window.setInterval(reconcileOverlay, 1000);
}

function stopKeeper(): void {
  keeperObserver?.disconnect();
  keeperObserver = null;
  if (keeperTimer) window.clearInterval(keeperTimer);
  keeperTimer = 0;
}

function reconcileOverlay(): void {
  const root = document.documentElement;
  if (!root) return;
  if (root.getAttribute('data-agent-hand-owner') !== OWNER) {
    stopKeeper();
    host = null;
    cursorEl = null;
    labelEl = null;
    return;
  }
  if (!host) return;
  if (host.isConnected) {
    removeOtherOverlays(host);
    pinHost();
    return;
  }
  if (root.getAttribute('data-agent-hand-owner') !== OWNER) {
    stopKeeper();
    host = null;
    cursorEl = null;
    labelEl = null;
    return;
  }
  const live = document.getElementById(OVERLAY_ID);
  if (live && live !== host) return;
  root.appendChild(host);
  pinHost();
}

function pinHost(): void {
  if (!host) return;
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('top', '0', 'important');
  host.style.setProperty('left', '0', 'important');
  host.style.setProperty('width', '0', 'important');
  host.style.setProperty('height', '0', 'important');
  host.style.setProperty('margin', '0', 'important');
  host.style.setProperty('padding', '0', 'important');
  host.style.setProperty('border', '0', 'important');
  host.style.setProperty('overflow', 'visible', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  host.style.setProperty('opacity', '1', 'important');
  host.style.setProperty('visibility', 'visible', 'important');
  host.style.setProperty('transform', 'none', 'important');
  host.style.setProperty('display', shown ? 'block' : 'none', 'important');
}

function showHost(): void {
  shown = true;
  pinHost();
}

function paint(): void {
  if (!cursorEl) return;
  cursorEl.style.transform = `translate(${cursorX}px, ${cursorY}px)`;
}

function showLabel(text: string): void {
  if (!labelEl) return;
  labelEl.textContent = text;
  labelEl.style.opacity = text ? '1' : '0';
  window.clearTimeout(labelTimer);
  labelTimer = window.setTimeout(() => {
    if (labelEl) labelEl.style.opacity = '0';
  }, 1400);
}

function cursorMove(x: number, y: number, label: string, duration: number): Promise<void> {
  if (window !== window.top) return Promise.resolve();
  ensureCursor();
  return animateTo(x, y, label, duration);
}

function cursorRipple(): void {
  if (window !== window.top) return;
  ensureCursor();
  playRipple();
}

function cursorLabel(label: string): void {
  if (window !== window.top) return;
  ensureCursor();
  if (!shown) {
    cursorX = window.innerWidth / 2;
    cursorY = window.innerHeight / 2;
    paint();
    showHost();
  }
  showLabel(label);
}

function animateTo(x: number, y: number, label: string, duration: number): Promise<void> {
  ensureCursor();
  showHost();
  showLabel(label);
  const fromX = cursorX;
  const fromY = cursorY;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ms = reduce ? 0 : Math.max(0, Math.min(4000, Number.isFinite(duration) ? duration : 700));
  const token = ++animToken;
  if (ms === 0 || (Math.abs(x - fromX) < 1 && Math.abs(y - fromY) < 1)) {
    cursorX = x;
    cursorY = y;
    paint();
    return Promise.resolve();
  }
  const start = performance.now();
  return new Promise((resolve) => {
    const frame = (now: number) => {
      if (token !== animToken) {
        resolve();
        return;
      }
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      cursorX = fromX + (x - fromX) * eased;
      cursorY = fromY + (y - fromY) * eased;
      paint();
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

function playRipple(): void {
  if (!cursorEl) return;
  for (const old of cursorEl.querySelectorAll('.ripple')) old.remove();
  const ripple = document.createElement('div');
  ripple.className = 'ripple';
  cursorEl.appendChild(ripple);
  const remove = () => ripple.remove();
  ripple.addEventListener('animationend', remove);
  window.setTimeout(remove, 500);
}
