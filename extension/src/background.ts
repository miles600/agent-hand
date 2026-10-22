import { viewportCssPoint } from '../../shared/coords.js';
import {
  applyEmulation,
  deviceMetricsOverride,
  resolveEmulation,
  restoreFittedWindow,
  runFittedEmulation,
  viewportMatches,
  wantsFitWindow,
  type EmulationSpec,
  type WindowBox,
  type WindowState,
} from '../../shared/emulate.js';
import { matchFrameRect, type FrameRect } from '../../shared/frames.js';
import {
  INPUT_TIMEOUT_MS,
  isInputFallbackError,
  requiresTrustedInput,
  syntheticInputWarning,
  trustedInputRequiredError,
} from '../../shared/input.js';
import { parseKeyCombo, type KeyDispatch } from '../../shared/keys.js';
import {
  consoleFromCdp,
  mergeConsole,
  networkFromCdp,
  pushCapped,
  type ConsoleMessage,
  type NetworkError,
} from '../../shared/monitor.js';
import { DEFAULT_CURSOR_MS, DEFAULT_PORT } from '../../shared/protocol.js';
import { sleep } from '../../shared/sleep.js';
import { buildSnapshot, type RawElement, type SnapshotItem } from '../../shared/snapshot.js';
import {
  nextScreenshotScale,
  pngDimensionsFromBase64,
  screenshotScaleReport,
  viewportScreenshotParams,
} from '../../shared/screenshot.js';

type RefRecord = { ref: number; ahId: string; frameId: number };
type PageElement = Omit<RawElement, 'frameId'>;
type Box = { x: number; y: number; width: number; height: number };
type Metrics = { cssWidth: number; cssHeight: number; devicePixelRatio: number };
type Origin = { x: number; y: number };
type FrameInfo = chrome.webNavigation.GetAllFrameResultDetails;

let socket: WebSocket | null = null;
let connectChain: Promise<void> = Promise.resolve();
let reconnectTimer: number | undefined;
let attempt = 0;
let lastError = 'Paste the bridge token on the options page';
let selectedTabId: number | null = null;
let refMap = new Map<number, RefRecord>();
let touchEmulated = false;
let activeEmulation: EmulationSpec | null = null;
/** Original window, kept when --fit-window resized it, so emulate off can put it back. */
let savedFit: (WindowBox & { windowId: number }) | null = null;
/** Set when attach is refused because DevTools already holds the debugger. */
let lastAttachProblem = '';
const attached = new Set<number>();
const consoleByTab = new Map<number, ConsoleMessage[]>();
const networkByTab = new Map<number, NetworkError[]>();
const requestUrls = new Map<number, Map<string, string>>();

void startup();

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepalive') return;
  if (!socket || socket.readyState !== WebSocket.OPEN) requestConnect();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.port)) requestConnect();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.source !== 'agent-hand') return undefined;
  if (msg.type === 'status') {
    sendResponse({
      ok: true,
      connected: socket?.readyState === WebSocket.OPEN,
      error: lastError,
    });
    return undefined;
  }
  if (msg.type === 'config-updated') {
    requestConnect();
    sendResponse({ ok: true });
    return undefined;
  }
  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  if (selectedTabId === tabId) selectedTabId = null;
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const logged = consoleFromCdp(method, params);
  if (logged) {
    const list = consoleByTab.get(tabId) ?? [];
    pushCapped(list, logged);
    consoleByTab.set(tabId, list);
  }
  const urls = requestUrls.get(tabId) ?? new Map<string, string>();
  requestUrls.set(tabId, urls);
  const failure = networkFromCdp(method, params, urls);
  if (failure) {
    const list = networkByTab.get(tabId) ?? [];
    pushCapped(list, failure);
    networkByTab.set(tabId, list);
  }
});

async function startup(): Promise<void> {
  try {
    await recallRefs();
  } catch {
    // session storage can be empty on a fresh install
  }
  try {
    await recallEmulation();
  } catch {
    // same as above
  }
  try {
    await recallTab();
  } catch {
    // same as above
  }
  requestConnect();
}

function requestConnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  connectChain = connectChain.then(connectOnce, connectOnce);
}

async function connectOnce(): Promise<void> {
  const previous = socket;
  socket = null;
  if (previous) {
    previous.onopen = null;
    previous.onclose = null;
    previous.onmessage = null;
    previous.onerror = null;
    try {
      previous.close();
    } catch {
      // already closed
    }
  }
  const config = await loadConfig();
  if (!config.token) {
    lastError = 'Paste the bridge token on the options page';
    setBadge(false);
    scheduleReconnect(5000);
    return;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    setBadge(false);
    scheduleReconnect(backoff());
    return;
  }
  socket = ws;
  const token = config.token;
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'auth',
      role: 'extension',
      token,
      version: '0.1.0',
      extensionId: chrome.runtime.id,
    }));
  };
  ws.onmessage = (event) => {
    void onSocketMessage(ws, event.data);
  };
  ws.onerror = () => {
    lastError = `Cannot reach the bridge at 127.0.0.1:${config.port}`;
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    setBadge(false);
    void detachAll();
    scheduleReconnect(backoff());
  };
}

function scheduleReconnect(delay: number): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    requestConnect();
  }, delay) as unknown as number;
}

function backoff(): number {
  const delay = Math.min(10000, 400 * 2 ** Math.min(attempt, 5));
  attempt += 1;
  return delay;
}

async function onSocketMessage(ws: WebSocket, data: unknown): Promise<void> {
  let msg: { type?: string; id?: string; method?: string; params?: Record<string, unknown>; error?: string };
  try {
    msg = JSON.parse(String(data)) as typeof msg;
  } catch {
    return;
  }
  if (msg.type === 'auth_ok') {
    attempt = 0;
    lastError = '';
    setBadge(true);
    return;
  }
  if (msg.type === 'auth_error') {
    lastError = msg.error || 'The bridge rejected the token';
    setBadge(false);
    return;
  }
  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  if (msg.type !== 'command' || typeof msg.id !== 'string' || typeof msg.method !== 'string') return;
  try {
    const result = await dispatch(msg.method, msg.params ?? {});
    ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data: result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: message }));
  }
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'list_tabs':
      return listTabs();
    case 'select_tab':
      if (typeof params.tabId !== 'number') throw new Error('tabId must be a number from list-tabs');
      return selectTab(params.tabId);
    case 'navigate':
      return navigate(requiredString(params.url, 'url'));
    case 'snapshot':
      return snapshot();
    case 'click':
      return click(params);
    case 'type':
      return typeText(params);
    case 'press':
      return press(requiredString(params.key, 'key'), requiresTrustedInput(params));
    case 'scroll':
      return scroll(params);
    case 'screenshot':
      return screenshot();
    case 'get_text':
      return getText(typeof params.max === 'number' ? params.max : 8000);
    case 'click_xy':
      return clickXY(params);
    case 'locate':
      return locateText(requiredString(params.text, 'text'));
    case 'emulate':
      return emulate(params);
    case 'console':
      return readConsole(params);
    case 'network_errors':
      return readNetwork(params);
    case 'reload_extension':
      return reloadExtension();
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

async function listTabs(): Promise<unknown> {
  const tabs = await chrome.tabs.query({});
  return {
    targetTabId: selectedTabId,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title ?? '',
      url: tab.url ?? '',
      active: Boolean(tab.active),
      selected: tab.id === selectedTabId,
    })),
  };
}

async function selectTab(tabId: number): Promise<unknown> {
  const tab = await chrome.tabs.get(tabId);
  await rememberTab(tabId);
  await focusTab(tab);
  return { id: tab.id, title: tab.title ?? '', url: tab.url ?? '' };
}

async function navigate(url: string): Promise<unknown> {
  const tab = await targetTab();
  if (tab.id == null) throw new Error('no tab');
  const tabId = tab.id;
  let resolveDone = () => undefined as void;
  let rejectDone = (_error: Error) => undefined as void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const timer = setTimeout(() => {
    chrome.tabs.onUpdated.removeListener(onUpdated);
    rejectDone(new Error('navigation timed out'));
  }, 30000);
  const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
    if (id === tabId && info.status === 'complete') {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolveDone();
    }
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    if (tab.url === url) await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url });
  } catch (error) {
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    throw error;
  }
  await done;
  const fresh = await chrome.tabs.get(tabId);
  await focusTab(fresh);
  await holdEmulation(tabId);
  return { tabId, url: fresh.url ?? url };
}

async function snapshot(): Promise<unknown> {
  const tab = await controllableTab();
  const tabId = tab.id as number;
  await focusTab(tab);
  const frames = await ensureReady(tabId);
  await holdEmulation(tabId);
  const wanted = relevantFrames(frames);
  const collected: { frameId: number; elements: PageElement[] }[] = [];
  let mainOk = false;
  for (const frame of wanted) {
    try {
      const result = await ask<{ elements: PageElement[] }>(tabId, frame.frameId, 'collect');
      if (frame.frameId === 0) mainOk = true;
      collected.push({ frameId: frame.frameId, elements: result?.elements ?? [] });
    } catch (error) {
      if (frame.frameId === 0) throw error;
    }
  }
  if (!mainOk) throw new Error('content script is not available on this page');
  const origins = await originsFor(tabId, wanted.map((frame) => frame.frameId));
  const raw: RawElement[] = [];
  for (const frame of collected) {
    const origin = origins.get(frame.frameId) ?? { x: 0, y: 0 };
    for (const element of frame.elements) {
      raw.push({
        ...element,
        frameId: frame.frameId,
        x: element.x + origin.x,
        y: element.y + origin.y,
      });
    }
  }
  const metrics = await ask<Metrics>(tabId, 0, 'metrics');
  const built = buildSnapshot(raw, metrics);
  await rememberRefs(built.items.map((item) => ({ ref: item.ref, ahId: item.ahId, frameId: item.frameId })));
  const fresh = await chrome.tabs.get(tabId);
  return {
    text: built.text,
    url: fresh.url ?? '',
    title: fresh.title ?? '',
    devicePixelRatio: metrics.devicePixelRatio,
    cssWidth: metrics.cssWidth,
    cssHeight: metrics.cssHeight,
    items: built.items.map(publicItem),
  };
}

async function click(params: Record<string, unknown>): Promise<unknown> {
  const ref = requiredInt(params.ref, 'ref');
  const tab = await controllableTab();
  const tabId = tab.id as number;
  await focusTab(tab);
  await ensureReady(tabId);
  await attachSettled(tabId);
  const entry = await refEntry(ref);
  const at = await reveal(tabId, entry);
  const duration = durationOf(params);
  const move = cursorMove(tabId, at.x, at.y, 'Click', duration);
  const frames: string[] = [];
  if (params.trace === true && tab.windowId != null) {
    const deadline = Date.now() + duration;
    while (Date.now() < deadline && frames.length < 4) {
      await sleep(220);
      if (Date.now() >= deadline) break;
      const shot = await captureJpeg(tab.windowId);
      if (shot) frames.push(shot);
    }
  }
  await move;
  await cursorRipple(tabId);
  const delivered = await clickAt(tabId, at.x, at.y, entry.frameId, at.localX, at.localY, requiresTrustedInput(params));
  return {
    ...(delivered.warning ? { warning: delivered.warning } : {}),
    ref,
    via: delivered.via,
    x: at.x,
    y: at.y,
    devicePixelRatio: at.devicePixelRatio,
    ...(frames.length ? { frames } : {}),
  };
}

async function typeText(params: Record<string, unknown>): Promise<unknown> {
  const ref = requiredInt(params.ref, 'ref');
  const text = requiredString(params.text, 'text');
  const tab = await controllableTab();
  const tabId = tab.id as number;
  await focusTab(tab);
  await ensureReady(tabId);
  await attachSettled(tabId);
  const entry = await refEntry(ref);
  const at = await reveal(tabId, entry);
  await cursorMove(tabId, at.x, at.y, 'Type', durationOf(params));
  await cursorRipple(tabId);
  const requireTrusted = requiresTrustedInput(params);
  const clicked = await clickAt(tabId, at.x, at.y, entry.frameId, at.localX, at.localY, requireTrusted);
  await ask(tabId, entry.frameId, 'focus', { ahId: entry.ahId });
  await sleep(40);
  let via: 'trusted' | 'synthetic' = 'trusted';
  let warning = clicked.warning;
  if (clicked.via !== 'trusted') {
    via = 'synthetic';
    await setFieldValue(tabId, entry.frameId, entry.ahId, text);
  } else {
    try {
      await sendCommand(tabId, 'Input.insertText', { text });
    } catch (error) {
      if (!isInputFallbackError(error)) throw error;
      const reason = inputReason(error);
      if (requireTrusted) throw trustedInputRequiredError(reason);
      via = 'synthetic';
      warning = syntheticInputWarning(reason);
      await restoreAttached(tabId);
      await setFieldValue(tabId, entry.frameId, entry.ahId, text);
    }
  }
  if (params.submit === true) {
    await cursorLabel(tabId, 'Submit');
    await pressEnter(tabId, via, requireTrusted);
  }
  return {
    ...(warning ? { warning } : {}),
    ref,
    length: text.length,
    submitted: params.submit === true,
    via,
    clickVia: clicked.via,
  };
}

async function press(key: string, requireTrusted = false): Promise<unknown> {
  const tab = await controllableTab();
  const tabId = tab.id as number;
  await focusTab(tab);
  await ensureReady(tabId);
  await attachSettled(tabId);
  const parsed = parseKeyCombo(key);
  await cursorLabel(tabId, `Press ${parsed.key}`);
  try {
    await keyDownUp(tabId, parsed);
    return { key: parsed.key, via: 'trusted' };
  } catch (error) {
    if (!isInputFallbackError(error)) throw error;
    const reason = inputReason(error);
    if (requireTrusted) throw trustedInputRequiredError(reason);
    await restoreAttached(tabId);
    await deliverSyntheticKey(tabId, parsed);
    return { warning: syntheticInputWarning(reason), key: parsed.key, via: 'synthetic' };
  }
}

async function scroll(params: Record<string, unknown>): Promise<unknown> {
  const tab = await controllableTab();
  const tabId = tab.id as number;
  await focusTab(tab);
  await ensureReady(tabId);
  if (typeof params.ref === 'number') {
    const entry = await refEntry(params.ref);
    const at = await reveal(tabId, entry);
    await cursorMove(tabId, at.x, at.y, 'Scroll', durationOf(params));
    return { ref: params.ref, x: at.x, y: at.y, devicePixelRatio: at.devicePixelRatio };
  }
  await attachSettled(tabId);
  const metrics = await ask<Metrics>(tabId, 0, 'metrics');
  const at = viewportCssPoint(metrics.cssWidth / 2, metrics.cssHeight / 2, metrics.devicePixelRatio);
  const direction = requiredString(params.direction, 'direction');
  await cursorMove(tabId, at.x, at.y, `Scroll ${direction}`, 420);
  const amount = typeof params.amount === 'number' ? params.amount : 480;
  const delta = wheelDelta(direction, amount);
  try {
    await mouseWheel(tabId, at.x, at.y, delta.x, delta.y);
    return { direction, amount, x: at.x, y: at.y, devicePixelRatio: metrics.devicePixelRatio, via: 'trusted' };
  } catch (error) {
    if (!isInputFallbackError(error)) throw error;
    const reason = inputReason(error);
    if (requiresTrustedInput(params)) throw trustedInputRequiredError(reason);
    await restoreAttached(tabId);
    await ask(tabId, 0, 'synthetic-scroll', { x: at.x, y: at.y, deltaX: delta.x, deltaY: delta.y });
    return { warning: syntheticInputWarning(reason), direction, amount, x: at.x, y: at.y, devicePixelRatio: metrics.devicePixelRatio, via: 'synthetic' };
  }
}

async function screenshot(): Promise<unknown> {
  const tab = await controllableTab();
  const tabId = tab.id as number;
  await focusTab(tab);
  await ensureReady(tabId);
  await sleep(80);
  if (tab.windowId == null) throw new Error('tab has no window');
  const metrics = await ask<Metrics>(tabId, 0, 'metrics').catch(() => ({ cssWidth: 0, cssHeight: 0, devicePixelRatio: 1 }));
  if (attached.has(tabId)) {
    try {
      const captured = await captureViewportPng(tabId, metrics);
      return { ...captured, cssWidth: metrics.cssWidth, cssHeight: metrics.cssHeight, via: 'cdp' };
    } catch {
      // DevTools or a dropped debugger: the visible-tab image is the fallback.
    }
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const size = pngDimensionsFromBase64(base64);
  const report = size
    ? screenshotScaleReport(size, metrics.cssWidth, metrics.cssHeight, metrics.devicePixelRatio)
    : { devicePixelRatio: metrics.devicePixelRatio };
  return {
    base64,
    cssWidth: metrics.cssWidth,
    cssHeight: metrics.cssHeight,
    via: 'visible-tab',
    ...report,
  };
}

async function captureViewportPng(
  tabId: number,
  metrics: Metrics,
): Promise<{ base64: string; devicePixelRatio: number; warning?: string }> {
  const first = await shootViewport(tabId, metrics, 1);
  const size = pngDimensionsFromBase64(first);
  if (!size) return { base64: first, devicePixelRatio: metrics.devicePixelRatio };
  const again = nextScreenshotScale(size, metrics.cssWidth, metrics.cssHeight, metrics.devicePixelRatio);
  const base64 = again.retry ? await shootViewport(tabId, metrics, again.scale) : first;
  const finalSize = pngDimensionsFromBase64(base64) ?? size;
  return { base64, ...screenshotScaleReport(finalSize, metrics.cssWidth, metrics.cssHeight, metrics.devicePixelRatio) };
}

async function shootViewport(tabId: number, metrics: Metrics, scale: number): Promise<string> {
  const shot = await sendCommand(tabId, 'Page.captureScreenshot', viewportScreenshotParams(metrics, scale), 15000) as { data?: string };
  if (!shot?.data) throw new Error('screenshot payload was empty');
  return shot.data;
}

async function getText(max: number): Promise<unknown> {
  const tab = await controllableTab();
  const tabId = tab.id as number;
  const frames = await ensureReady(tabId);
  const parts: { frameId: number; text: string }[] = [];
  for (const frame of relevantFrames(frames)) {
    try {
      const value = await ask<string>(tabId, frame.frameId, 'text', {}, 4000);
      if (value) parts.push({ frameId: frame.frameId, text: value });
    } catch {
      // skip frames that cannot answer
    }
  }
  parts.sort((a, b) => a.frameId - b.frameId);
  const combined = parts.map((part) => part.text).join('\n\n');
  return { text: combined.slice(0, max), truncated: combined.length > max, length: combined.length };
}

async function reveal(tabId: number, entry: RefRecord): Promise<{ x: number; y: number; localX: number; localY: number; devicePixelRatio: number }> {
  await scrollFramesIntoView(tabId, entry.frameId);
  const box = await ask<Box>(tabId, entry.frameId, 'prepare', { ahId: entry.ahId });
  const origin = await originOf(tabId, entry.frameId);
  const metrics = await ask<Metrics>(tabId, 0, 'metrics');
  const point = viewportCssPoint(box.x + origin.x, box.y + origin.y, metrics.devicePixelRatio);
  return { ...point, localX: box.x, localY: box.y, devicePixelRatio: metrics.devicePixelRatio };
}

async function scrollFramesIntoView(tabId: number, frameId: number): Promise<void> {
  if (frameId === 0) return;
  const frames = await getAllFrames(tabId);
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const chain: FrameInfo[] = [];
  let current = byId.get(frameId);
  const guard = new Set<number>();
  while (current && current.parentFrameId >= 0 && !guard.has(current.frameId)) {
    guard.add(current.frameId);
    chain.push(current);
    current = byId.get(current.parentFrameId);
  }
  for (const frame of chain.reverse()) {
    try {
      await ask(tabId, frame.parentFrameId, 'scroll-frame', { url: frame.url }, 2000);
    } catch {
      // best effort for cross-origin parents
    }
  }
}

async function originOf(tabId: number, frameId: number): Promise<Origin> {
  const frames = await getAllFrames(tabId);
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const ids = new Set<number>([0, frameId]);
  let current = byId.get(frameId);
  const guard = new Set<number>();
  while (current && !guard.has(current.frameId)) {
    guard.add(current.frameId);
    ids.add(current.frameId);
    if (current.parentFrameId < 0) break;
    current = byId.get(current.parentFrameId);
  }
  const map = await originsFor(tabId, [...ids]);
  return map.get(frameId) ?? { x: 0, y: 0 };
}

async function originsFor(tabId: number, frameIds: number[]): Promise<Map<number, Origin>> {
  const map = new Map<number, Origin>();
  map.set(0, { x: 0, y: 0 });
  const pending: number[] = [];
  await Promise.all(frameIds.map(async (frameId) => {
    if (frameId === 0) return;
    try {
      const offset = await ask<Origin | null>(tabId, frameId, 'frame-offset', {}, 2000);
      if (offset && Number.isFinite(offset.x) && Number.isFinite(offset.y)) {
        map.set(frameId, offset);
        return;
      }
    } catch {
      // measured from the parent instead
    }
    pending.push(frameId);
  }));
  if (!pending.length) return map;
  const frames = await getAllFrames(tabId);
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const depth = (frameId: number): number => {
    let steps = 0;
    let current = byId.get(frameId);
    const guard = new Set<number>();
    while (current && current.parentFrameId >= 0 && !guard.has(current.frameId)) {
      guard.add(current.frameId);
      steps += 1;
      current = byId.get(current.parentFrameId);
    }
    return steps;
  };
  pending.sort((a, b) => depth(a) - depth(b));
  const usedByParent = new Map<number, Set<number>>();
  for (const frameId of pending) {
    const frame = byId.get(frameId);
    if (!frame || frame.parentFrameId < 0) {
      map.set(frameId, { x: 0, y: 0 });
      continue;
    }
    const parentOrigin = map.get(frame.parentFrameId) ?? { x: 0, y: 0 };
    let rects: FrameRect[] = [];
    try {
      rects = await ask<FrameRect[]>(tabId, frame.parentFrameId, 'iframe-rects', {}, 2000);
    } catch {
      rects = [];
    }
    const used = usedByParent.get(frame.parentFrameId) ?? new Set<number>();
    usedByParent.set(frame.parentFrameId, used);
    const index = matchFrameRect(rects, frame.url, used);
    if (index < 0) {
      map.set(frameId, parentOrigin);
      continue;
    }
    used.add(index);
    map.set(frameId, { x: parentOrigin.x + rects[index].x, y: parentOrigin.y + rects[index].y });
  }
  return map;
}

async function controllableTab(): Promise<chrome.tabs.Tab> {
  const tab = await targetTab();
  assertControllable(tab);
  return tab;
}

async function targetTab(): Promise<chrome.tabs.Tab> {
  if (selectedTabId != null) {
    try {
      return await chrome.tabs.get(selectedTabId);
    } catch {
      selectedTabId = null;
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id != null) return active;
  return chrome.tabs.create({ url: 'about:blank', active: true });
}

function assertControllable(tab: chrome.tabs.Tab): void {
  const url = tab.url ?? '';
  if (!/^https?:/i.test(url)) {
    throw new Error(`cannot control this page (${url || 'empty url'}). Open an http(s) page first.`);
  }
  if (tab.id == null) throw new Error('tab has no id');
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id == null || tab.windowId == null) throw new Error('tab has no window');
  const win = await chrome.windows.get(tab.windowId);
  if (win.state === 'minimized') {
    await chrome.windows.update(tab.windowId, { state: 'normal', focused: true });
  } else {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await chrome.tabs.update(tab.id, { active: true });
}

async function ensureReady(tabId: number): Promise<FrameInfo[]> {
  let frames = await getAllFrames(tabId);
  const missing: number[] = [];
  await Promise.all(frames.map(async (frame) => {
    try {
      const response = await sendToFrame(tabId, frame.frameId, { source: 'agent-hand', type: 'ping-content' }, 800);
      if (!response?.ok) missing.push(frame.frameId);
    } catch {
      missing.push(frame.frameId);
    }
  }));
  for (const frameId of missing) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ['content.js'],
      });
    } catch {
      // chrome:// and some guest frames cannot host the script
    }
  }
  if (missing.length) frames = await getAllFrames(tabId);
  return frames;
}

function relevantFrames(frames: FrameInfo[]): FrameInfo[] {
  const main = frames.filter((frame) => frame.frameId === 0);
  const rest = frames.filter((frame) => frame.frameId !== 0).slice(0, 25);
  return [...main, ...rest];
}

async function holdEmulation(tabId: number): Promise<void> {
  await recallEmulation();
  if (!activeEmulation) return;
  try {
    await attachSettled(tabId);
    if (lastAttachProblem) return;
    const metrics = await ask<Metrics>(tabId, 0, 'metrics');
    if (!viewportMatches(activeEmulation, metrics)) await sendEmulation(tabId, activeEmulation);
  } catch {
    // Snapshot still reports the viewport the page actually has.
  }
}

async function sendEmulation(tabId: number, spec: EmulationSpec): Promise<void> {
  await sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', deviceMetricsOverride(spec), 5000);
  await sendCommand(tabId, 'Emulation.setTouchEmulationEnabled', {
    enabled: spec.mobile,
    maxTouchPoints: spec.mobile ? 5 : 1,
  }, 5000);
  if (spec.userAgent) {
    await sendCommand(tabId, 'Emulation.setUserAgentOverride', { userAgent: spec.userAgent }, 5000);
  }
  touchEmulated = spec.mobile;
}

async function persistEmulation(spec: EmulationSpec | null): Promise<void> {
  activeEmulation = spec;
  try {
    await chrome.storage.session.set({ emulation: spec });
  } catch {
    // session storage can be unavailable
  }
}

async function recallEmulation(): Promise<void> {
  if (activeEmulation) return;
  try {
    const stored = await chrome.storage.session.get('emulation');
    const value = stored.emulation;
    if (!value || typeof value !== 'object') return;
    const spec = value as EmulationSpec;
    if (typeof spec.width !== 'number' || typeof spec.height !== 'number') return;
    activeEmulation = spec;
  } catch {
    // ignore
  }
}

function inputReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (lastAttachProblem && !reason.includes(lastAttachProblem)) return `${lastAttachProblem}; ${reason}`;
  return reason;
}

async function attachSettled(tabId: number): Promise<void> {
  await recallEmulation();
  if (attached.has(tabId)) return;
  lastAttachProblem = '';
  try {
    await debuggerAttach(tabId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already attached/i.test(message)) throw new Error(message);
    // DevTools (docked or undocked) already owns the tab. Input.* will be
    // refused immediately with "not attached"; it does not wait 2.5s.
    lastAttachProblem = message;
  }
  for (const other of [...attached]) {
    if (other !== tabId) await detach(other);
  }
  attached.add(tabId);
  await sleep(300);
  await enableMonitoring(tabId);
  if (!activeEmulation) return;
  try {
    await sendEmulation(tabId, activeEmulation);
    lastAttachProblem = '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!lastAttachProblem) lastAttachProblem = message;
  }
}

function debuggerAttach(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message ?? 'debugger attach failed'));
      else resolve();
    });
  });
}

function detach(tabId: number): Promise<void> {
  attached.delete(tabId);
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function detachAll(): Promise<void> {
  for (const tabId of [...attached]) {
    await detach(tabId);
  }
}

function sendCommand(tabId: number, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  const limit = timeoutMs ?? (method.startsWith('Input.') ? INPUT_TIMEOUT_MS : 0);
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = limit
      ? setTimeout(() => {
        if (done) return;
        done = true;
        // Leave the debugger attached. Detaching here makes the next command fail
        // with "Debugger is not attached" while Chrome still considers us attached,
        // or drops the session the page still needs.
        reject(new Error(`${method} timed out`));
      }, limit) as unknown as number
      : 0;
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (err) {
        const message = err.message ?? `${method} failed`;
        if (/not attached|detached while/i.test(message)) attached.delete(tabId);
        reject(new Error(message));
      } else resolve(result);
    });
  });
}

async function enableMonitoring(tabId: number): Promise<void> {
  await sendCommand(tabId, 'Runtime.enable', {}, 1500).catch(() => undefined);
  await sendCommand(tabId, 'Network.enable', {}, 1500).catch(() => undefined);
}

async function restoreAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  try {
    await debuggerAttach(tabId);
    attached.add(tabId);
    await enableMonitoring(tabId);
  } catch {
    // DevTools may own the tab. DOM fallbacks still run without the debugger.
  }
}

async function clickAt(
  tabId: number,
  x: number,
  y: number,
  frameId = 0,
  localX = x,
  localY = y,
  requireTrusted = false,
): Promise<{ via: 'trusted' | 'synthetic'; warning?: string }> {
  try {
    await ask(tabId, frameId, 'arm-click', { x: localX, y: localY }, 1500).catch(() => undefined);
    await mouseClick(tabId, x, y);
    lastAttachProblem = '';
    return { via: 'trusted' };
  } catch (error) {
    if (!isInputFallbackError(error)) throw error;
    const reason = inputReason(error);
    if (requireTrusted) throw trustedInputRequiredError(reason);
    await restoreAttached(tabId);
    await ask(tabId, frameId, 'synthetic-click', {
      x: localX,
      y: localY,
      pointerType: touchEmulated ? 'touch' : 'mouse',
    });
    return { via: 'synthetic', warning: syntheticInputWarning(reason) };
  }
}

async function clickXY(params: Record<string, unknown>): Promise<unknown> {
  const x = Number(params.x);
  const y = Number(params.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y are required');
  const tab = await controllableTab();
  const tabId = tab.id as number;
  await focusTab(tab);
  await ensureReady(tabId);
  await attachSettled(tabId);
  await cursorMove(tabId, x, y, 'Click', durationOf(params));
  await cursorRipple(tabId);
  const delivered = await clickAt(tabId, x, y, 0, x, y, requiresTrustedInput(params));
  return { ...(delivered.warning ? { warning: delivered.warning } : {}), x, y, via: delivered.via };
}

async function locateText(text: string): Promise<unknown> {
  const tab = await controllableTab();
  const tabId = tab.id as number;
  await ensureReady(tabId);
  const matches = await ask(tabId, 0, 'locate', { text });
  return { text, matches };
}

async function setFieldValue(tabId: number, frameId: number, ahId: string, text: string): Promise<void> {
  const ok = await ask<boolean>(tabId, frameId, 'set-value', { ahId, text });
  if (!ok) throw new Error('could not set the field value');
}

async function pressEnter(tabId: number, via: 'trusted' | 'synthetic', requireTrusted: boolean): Promise<void> {
  const enter = parseKeyCombo('Enter');
  if (via !== 'trusted') {
    if (requireTrusted) throw trustedInputRequiredError('click was not trusted');
    await deliverSyntheticKey(tabId, enter);
    return;
  }
  try {
    await keyDownUp(tabId, enter);
  } catch (error) {
    if (!isInputFallbackError(error)) throw error;
    if (requireTrusted) throw trustedInputRequiredError(inputReason(error));
    await restoreAttached(tabId);
    await deliverSyntheticKey(tabId, enter);
  }
}

async function deliverSyntheticKey(tabId: number, key: KeyDispatch): Promise<void> {
  const frames = await getAllFrames(tabId).catch(() => [] as FrameInfo[]);
  const targets = frames.length ? relevantFrames(frames) : [];
  let acted = false;
  for (const frame of targets) {
    try {
      const result = await ask<{ acted?: boolean }>(tabId, frame.frameId, 'synthetic-key', { key, force: true }, 2000);
      if (result?.acted) acted = true;
    } catch {
      // that frame has no content script
    }
  }
  if (!acted) await ask(tabId, 0, 'synthetic-key', { key, force: true });
}

async function emulate(params: Record<string, unknown>): Promise<unknown> {
  const tab = await controllableTab();
  const tabId = tab.id as number;
  await focusTab(tab);
  await ensureReady(tabId);
  const spec = resolveEmulation(params);
  const fit = wantsFitWindow(params);
  if (spec.preset === 'off') {
    activeEmulation = null;
    touchEmulated = false;
    await persistEmulation(null);
    await attachSettled(tabId);
    const result = await applyEmulation(spec, {
      send: (method, commandParams) => sendCommand(tabId, method, commandParams, 5000),
      readViewport: () => ask<Metrics>(tabId, 0, 'metrics'),
    });
    const restored = await restoreFitIfSaved();
    return { ...result, ...restored };
  }
  const apply = async () => {
    await attachSettled(tabId);
    const result = await applyEmulation(spec, {
      send: (method, commandParams) => sendCommand(tabId, method, commandParams, 5000),
      readViewport: () => ask<Metrics>(tabId, 0, 'metrics'),
    });
    activeEmulation = spec;
    touchEmulated = spec.mobile && result.applied !== false;
    await persistEmulation(spec);
    return result;
  };
  if (!fit || tab.windowId == null) return apply();
  const windowId = tab.windowId;
  const existing = await loadSavedFit();
  if (existing && existing.windowId !== windowId) await restoreFitIfSaved();
  const kept = existing && existing.windowId === windowId ? stripWindowId(existing) : null;
  if (attached.has(tabId)) {
    try {
      await sendCommand(tabId, 'Emulation.clearDeviceMetricsOverride', {}, 5000);
      await sendCommand(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false }, 5000);
    } catch {
      // The next read still reports whatever viewport the page actually has.
    }
  }
  await persistEmulation(null);
  const note = { infobar: 0 };
  const fitted = await runFittedEmulation(fitController(windowId, tabId, note), kept, spec, apply);
  if (note.infobar > 0) fitted.infobarHeight = note.infobar;
  if (fitted.fitWindow === true && !kept && isWindowBox(fitted.restoreWindow)) {
    await storeFit(windowId, fitted.restoreWindow);
  }
  return fitted;
}

type PageChrome = {
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
};

function fitController(windowId: number, tabId: number, note: { infobar: number }) {
  return {
    getWindow: async () => boxFromChrome(await chrome.windows.get(windowId)),
    setWindow: async (update: Partial<WindowBox>) => {
      await chrome.windows.update(windowId, {
        ...(update.state ? { state: update.state } : {}),
        ...(update.left != null ? { left: Math.round(update.left) } : {}),
        ...(update.top != null ? { top: Math.round(update.top) } : {}),
        ...(update.width != null ? { width: Math.round(update.width) } : {}),
        ...(update.height != null ? { height: Math.round(update.height) } : {}),
      });
    },
    measure: async () => {
      const wasAttached = attached.has(tabId);
      const before = wasAttached ? null : await ask<PageChrome>(tabId, 0, 'window-chrome');
      await attachSettled(tabId);
      const after = await ask<PageChrome>(tabId, 0, 'window-chrome');
      if (before) note.infobar = Math.max(0, Math.round(before.innerHeight - after.innerHeight));
      const win = await chrome.windows.get(windowId);
      // innerHeight here is after the infobar, so outer-inner already includes that bar.
      return {
        outerWidth: after.outerWidth,
        outerHeight: after.outerHeight,
        innerWidth: after.innerWidth,
        innerHeight: after.innerHeight,
        devicePixelRatio: after.devicePixelRatio || 1,
        windowWidth: win.width ?? after.outerWidth,
        windowHeight: win.height ?? after.outerHeight,
      };
    },
  };
}

function boxFromChrome(win: chrome.windows.Window): WindowBox {
  return {
    left: win.left ?? 0,
    top: win.top ?? 0,
    width: win.width ?? 0,
    height: win.height ?? 0,
    state: asWindowState(win.state),
  };
}

function asWindowState(state: string | undefined): WindowState {
  if (state === 'minimized' || state === 'maximized' || state === 'fullscreen' || state === 'locked-fullscreen') return state;
  return 'normal';
}

function isWindowBox(value: unknown): value is WindowBox {
  if (!value || typeof value !== 'object') return false;
  const box = value as WindowBox;
  return typeof box.width === 'number' && typeof box.height === 'number' && typeof box.state === 'string';
}

function stripWindowId(saved: WindowBox & { windowId: number }): WindowBox {
  return { left: saved.left, top: saved.top, width: saved.width, height: saved.height, state: saved.state };
}

async function loadSavedFit(): Promise<(WindowBox & { windowId: number }) | null> {
  if (savedFit) return savedFit;
  try {
    const stored = await chrome.storage.session.get('fitWindow');
    const value = stored.fitWindow;
    if (!isWindowBox(value) || typeof (value as { windowId?: unknown }).windowId !== 'number') return null;
    savedFit = value as WindowBox & { windowId: number };
    return savedFit;
  } catch {
    return null;
  }
}

async function storeFit(windowId: number, box: WindowBox): Promise<void> {
  savedFit = { ...box, windowId };
  try {
    await chrome.storage.session.set({ fitWindow: savedFit });
  } catch {
    // session storage can be unavailable; the in-memory copy still restores
  }
}

async function restoreFitIfSaved(): Promise<Record<string, unknown>> {
  const saved = await loadSavedFit();
  if (!saved) return {};
  try {
    await restoreFittedWindow(fitController(saved.windowId, 0, { infobar: 0 }), stripWindowId(saved));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warning: `Could not restore the Chrome window (${message}).` };
  }
  savedFit = null;
  try {
    await chrome.storage.session.remove('fitWindow');
  } catch {
    // the in-memory copy is already cleared
  }
  return { restoredWindow: stripWindowId(saved) };
}

async function readConsole(params: Record<string, unknown>): Promise<unknown> {
  const tab = await controllableTab();
  const tabId = tab.id as number;
  const max = typeof params.max === 'number' ? params.max : 100;
  const clear = params.clear === true;
  const frames = await ensureReady(tabId);
  const pageLogs: ConsoleMessage[] = [];
  for (const frame of relevantFrames(frames)) {
    try {
      const rows = await ask<ConsoleMessage[]>(tabId, frame.frameId, 'console', { clear, max }, 2000);
      if (Array.isArray(rows)) pageLogs.push(...rows);
    } catch {
      // frame cannot answer
    }
  }
  const cdpLogs = consoleByTab.get(tabId) ?? [];
  if (clear) consoleByTab.set(tabId, []);
  return { messages: mergeConsole([...cdpLogs, ...pageLogs], max) };
}

async function readNetwork(params: Record<string, unknown>): Promise<unknown> {
  const tab = await controllableTab();
  const tabId = tab.id as number;
  const max = typeof params.max === 'number' ? params.max : 100;
  const clear = params.clear === true;
  let warning = '';
  try {
    await attachSettled(tabId);
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
  }
  const errors = (networkByTab.get(tabId) ?? []).slice(-max);
  if (clear) networkByTab.set(tabId, []);
  return warning ? { errors, warning } : { errors };
}

function reloadExtension(): { reloading: true } {
  setTimeout(() => chrome.runtime.reload(), 150);
  return { reloading: true };
}

async function mouseClick(tabId: number, x: number, y: number): Promise<void> {
  const px = Math.round(x * 100) / 100;
  const py = Math.round(y * 100) / 100;
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: px,
    y: py,
    button: 'none',
    pointerType: 'mouse',
  });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: px,
    y: py,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: 'mouse',
  });
  await sleep(30);
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: px,
    y: py,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    pointerType: 'mouse',
  });
}

async function mouseWheel(tabId: number, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX,
    deltaY,
    pointerType: 'mouse',
  });
}

async function keyDownUp(tabId: number, key: KeyDispatch): Promise<void> {
  const base = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    nativeVirtualKeyCode: key.keyCode,
    modifiers: key.modifiers,
  };
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    ...base,
    type: 'keyDown',
    text: key.text,
    unmodifiedText: key.text,
  });
  await sleep(20);
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

function wheelDelta(direction: string, amount: number): { x: number; y: number } {
  if (direction === 'up') return { x: 0, y: -amount };
  if (direction === 'down') return { x: 0, y: amount };
  if (direction === 'left') return { x: -amount, y: 0 };
  if (direction === 'right') return { x: amount, y: 0 };
  throw new Error('direction must be up, down, left, or right');
}

async function cursorMove(tabId: number, x: number, y: number, label: string, duration: number): Promise<void> {
  await sendToFrame(tabId, 0, {
    source: 'agent-hand',
    type: 'cursor-move',
    x,
    y,
    label,
    duration,
  }, Math.max(8000, duration + 2000));
}

async function cursorRipple(tabId: number): Promise<void> {
  await sendToFrame(tabId, 0, { source: 'agent-hand', type: 'cursor-ripple' }, 2000);
}

async function cursorLabel(tabId: number, label: string): Promise<void> {
  await sendToFrame(tabId, 0, { source: 'agent-hand', type: 'cursor-label', label }, 2000);
}

async function captureJpeg(windowId: number): Promise<string | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 });
    return dataUrl.replace(/^data:image\/jpeg;base64,/, '');
  } catch {
    return null;
  }
}

function sendToFrame(tabId: number, frameId: number, message: unknown, timeoutMs: number): Promise<{ ok?: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('content script timed out')), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message ?? 'content script unavailable'));
      else resolve(response ?? { ok: false, error: 'empty response' });
    });
  });
}

async function ask<T>(tabId: number, frameId: number, type: string, extra: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
  const response = await sendToFrame(tabId, frameId, { source: 'agent-hand', type, ...extra }, timeoutMs);
  if (!response || response.ok === false) throw new Error(response?.error || `${type} failed`);
  return response.result as T;
}

function getAllFrames(tabId: number): Promise<FrameInfo[]> {
  return new Promise((resolve, reject) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message ?? 'could not list frames'));
      else resolve(frames ?? []);
    });
  });
}

async function loadConfig(): Promise<{ port: number; token: string }> {
  const stored = await chrome.storage.local.get(['port', 'token']);
  if (typeof stored.token === 'string' && stored.token) {
    return { port: normalizePort(stored.port), token: stored.token };
  }
  try {
    const response = await fetch(chrome.runtime.getURL('dev-config.json'));
    if (response.ok) {
      const json = (await response.json()) as { port?: number; token?: string };
      if (json && typeof json.token === 'string' && json.token) {
        const port = normalizePort(json.port);
        await chrome.storage.local.set({ port, token: json.token });
        return { port, token: json.token };
      }
    }
  } catch {
    // optional file used by the end-to-end test
  }
  return { port: normalizePort(stored.port), token: '' };
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_PORT;
  return port;
}

async function rememberRefs(entries: RefRecord[]): Promise<void> {
  refMap = new Map(entries.map((entry) => [entry.ref, entry]));
  await chrome.storage.session.set({ refs: entries });
}

async function recallRefs(): Promise<void> {
  const stored = await chrome.storage.session.get('refs');
  if (!Array.isArray(stored.refs)) return;
  const entries = stored.refs.filter(isRefRecord);
  refMap = new Map(entries.map((entry) => [entry.ref, entry]));
}

async function refEntry(ref: number): Promise<RefRecord> {
  if (refMap.size === 0) await recallRefs();
  const entry = refMap.get(ref);
  if (!entry) throw new Error(`unknown ref ${ref}; call snapshot first`);
  return entry;
}

function isRefRecord(value: unknown): value is RefRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as RefRecord;
  return Number.isInteger(record.ref) && typeof record.ahId === 'string' && Number.isInteger(record.frameId);
}

async function rememberTab(tabId: number | null): Promise<void> {
  selectedTabId = tabId;
  await chrome.storage.session.set({ selectedTabId: tabId });
}

async function recallTab(): Promise<void> {
  const stored = await chrome.storage.session.get('selectedTabId');
  if (typeof stored.selectedTabId === 'number') selectedTabId = stored.selectedTabId;
}

function publicItem(item: SnapshotItem): Omit<SnapshotItem, 'ahId'> {
  return {
    ref: item.ref,
    frameId: item.frameId,
    role: item.role,
    name: item.name,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    disabled: item.disabled,
    ...(item.checked == null ? {} : { checked: item.checked }),
  };
}

function durationOf(params: Record<string, unknown>): number {
  return typeof params.duration === 'number' ? params.duration : DEFAULT_CURSOR_MS;
}

function requiredInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`);
  return value;
}

function setBadge(connected: boolean): void {
  const text = connected ? 'ON' : 'OFF';
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color: connected ? '#1d6b3a' : '#9a3412' });
  void chrome.action.setTitle({
    title: connected ? 'Agent Hand connected' : `Agent Hand: ${lastError || 'not connected'}`,
  });
}
