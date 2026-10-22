import { MAX_SNAPSHOT_ITEMS } from '../../shared/snapshot.js';

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
};
type FrameRect = { src: string; x: number; y: number; width: number; height: number };
type LocateHit = { text: string; tag: string; x: number; y: number; width: number; height: number };
type ConsoleLine = { level: string; text: string; time: number; source: 'page' };
type KeySpec = { key?: string; code?: string; keyCode?: number; text?: string; modifiers?: number };

export type PageApi = {
  collect: () => { elements: PageElement[] };
  prepare: (ahId: string) => Promise<Box | { error: string }>;
  frameOffset: () => { x: number; y: number } | null;
  iframeRects: () => FrameRect[];
  scrollFrame: (url: string) => void;
  focus: (ahId: string) => void;
  metrics: () => { cssWidth: number; cssHeight: number; devicePixelRatio: number };
  text: () => string;
  pageInfo: () => { href: string; title: string };
  syntheticClick: (x: number, y: number, pointerType?: string) => { tag: string; text: string } | null;
  locate: (text: string) => LocateHit[];
  setValue: (ahId: string, value: string) => boolean;
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
    focus,
    metrics,
    text,
    pageInfo,
    syntheticClick,
    locate,
    setValue,
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
  const add = (el: Element, role?: string) => {
    if (seen.has(el) || elements.length >= MAX_SNAPSHOT_ITEMS) return;
    seen.add(el);
    const id = idFor(el);
    next.set(id, el);
    const rect = el.getBoundingClientRect();
    elements.push({
      ahId: id,
      role: role ?? roleOf(el),
      name: accessibleName(el),
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      disabled: isDisabled(el),
    });
  };
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (elements.length >= MAX_SNAPSHOT_ITEMS) break;
    if (!isCandidate(el)) continue;
    add(el);
  }
  if (elements.length < MAX_SNAPSHOT_ITEMS && document.body) {
    for (const el of document.body.querySelectorAll('*')) {
      if (elements.length >= MAX_SNAPSHOT_ITEMS) break;
      if (seen.has(el) || !(el instanceof HTMLElement)) continue;
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      const parent = el.parentElement;
      if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
      const listed = el.closest(SELECTOR);
      if (listed && listed !== el) continue;
      if (!isCandidate(el)) continue;
      add(el, 'clickable');
    }
  }
  byId = next;
  return { elements };
}

function prepare(ahId: string): Promise<Box | { error: string }> {
  const el = byId.get(ahId);
  if (!el || !el.isConnected) return Promise.resolve({ error: 'element is gone; take a new snapshot' });
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
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

function text(): string {
  return document.body?.innerText ?? '';
}

function pageInfo(): { href: string; title: string } {
  return { href: location.href, title: document.title };
}

function syntheticClick(x: number, y: number, pointerType = 'mouse'): { tag: string; text: string } | null {
  const restore = hideOverlays();
  const el = document.elementFromPoint(x, y);
  restore();
  if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return null;
  const target = el;
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
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
  el.focus();
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
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
  return clean((el as HTMLElement).innerText || el.textContent || '');
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
