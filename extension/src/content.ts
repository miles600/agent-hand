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
type PageApi = {
  collect: () => { elements: PageElement[] };
  prepare: (ahId: string) => Promise<Box | { error: string }>;
  frameOffset: () => { x: number; y: number } | null;
  iframeRects: () => FrameRect[];
  scrollFrame: (url: string) => void;
  focus: (ahId: string) => void;
  metrics: () => { cssWidth: number; cssHeight: number; devicePixelRatio: number };
  text: () => string;
};

type Globals = typeof globalThis & {
  __agentHandInstalled?: boolean;
  __agentHand?: PageApi;
};

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
].join(',');

const globals = globalThis as Globals;
const elementIds = new WeakMap<Element, string>();
let byId = new Map<string, Element>();

let cursorReady = false;
let shown = false;
let cursorX = 36;
let cursorY = 36;
let animToken = 0;
let labelTimer = 0;
let host: HTMLDivElement | null = null;
let cursorEl: HTMLDivElement | null = null;
let labelEl: HTMLDivElement | null = null;

if (!globals.__agentHandInstalled) {
  globals.__agentHandInstalled = true;
  const api = createApi();
  globals.__agentHand = api;
  installListener();
  if (window === window.top) ensureCursor();
}

function createApi(): PageApi {
  return {
    collect,
    prepare,
    frameOffset,
    iframeRects,
    scrollFrame,
    focus,
    metrics,
    text,
  };
}

function installListener(): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.source !== 'agent-hand') return undefined;
    if (msg.type === 'ping-content') {
      sendResponse({ ok: true });
      return undefined;
    }
    const api = globals.__agentHand;
    if (!api) {
      sendResponse({ ok: false, error: 'content script not ready' });
      return undefined;
    }
    if (msg.type === 'collect') {
      sendResponse({ ok: true, result: api.collect() });
      return undefined;
    }
    if (msg.type === 'prepare') {
      void api.prepare(String(msg.ahId)).then((result) => {
        if (result && 'error' in result) sendResponse({ ok: false, error: result.error });
        else sendResponse({ ok: true, result });
      });
      return true;
    }
    if (msg.type === 'frame-offset') {
      sendResponse({ ok: true, result: api.frameOffset() });
      return undefined;
    }
    if (msg.type === 'iframe-rects') {
      sendResponse({ ok: true, result: api.iframeRects() });
      return undefined;
    }
    if (msg.type === 'scroll-frame') {
      api.scrollFrame(String(msg.url ?? ''));
      sendResponse({ ok: true });
      return undefined;
    }
    if (msg.type === 'focus') {
      api.focus(String(msg.ahId));
      sendResponse({ ok: true });
      return undefined;
    }
    if (msg.type === 'metrics') {
      sendResponse({ ok: true, result: api.metrics() });
      return undefined;
    }
    if (msg.type === 'text') {
      sendResponse({ ok: true, result: api.text() });
      return undefined;
    }
    if (window !== window.top) return undefined;
    if (msg.type === 'cursor-move') {
      ensureCursor();
      void animateTo(Number(msg.x), Number(msg.y), String(msg.label ?? ''), Number(msg.duration ?? 700)).then(
        () => sendResponse({ ok: true }),
        (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (msg.type === 'cursor-ripple') {
      ensureCursor();
      playRipple();
      sendResponse({ ok: true });
      return undefined;
    }
    if (msg.type === 'cursor-label') {
      ensureCursor();
      if (!shown) {
        cursorX = window.innerWidth / 2;
        cursorY = window.innerHeight / 2;
        paint();
        showHost();
      }
      showLabel(String(msg.label ?? ''));
      sendResponse({ ok: true });
      return undefined;
    }
    return undefined;
  });
}

function collect(): { elements: PageElement[] } {
  const next = new Map<string, Element>();
  const elements: PageElement[] = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (elements.length >= 200) break;
    if (!isCandidate(el)) continue;
    const id = idFor(el);
    next.set(id, el);
    const rect = el.getBoundingClientRect();
    elements.push({
      ahId: id,
      role: roleOf(el),
      name: accessibleName(el),
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      disabled: isDisabled(el),
    });
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

function isCandidate(el: Element): boolean {
  if (el.id === 'agent-hand-root' || el.closest('#agent-hand-root')) return false;
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
  if (cursorReady) return;
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', () => ensureCursor(), { once: true });
    return;
  }
  host = document.createElement('div');
  host.id = 'agent-hand-root';
  host.setAttribute('aria-hidden', 'true');
  const shadow = host.attachShadow({ mode: 'closed' });
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
  document.documentElement.appendChild(host);
  pinHost();
  paint();
  cursorReady = true;
  const observer = new MutationObserver(() => {
    if (host && !host.isConnected && document.documentElement) {
      document.documentElement.appendChild(host);
      pinHost();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(() => {
    if (!document.documentElement || !host) return;
    if (!host.isConnected) document.documentElement.appendChild(host);
    pinHost();
  }, 1000);
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
  const ripple = document.createElement('div');
  ripple.className = 'ripple';
  cursorEl.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
}
