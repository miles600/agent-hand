import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CdpConnection, fetchCdpTargets, type CdpTarget } from './cdp.js';
import { normalizeCdpUrl } from '../shared/cdp-url.js';
import { matchFrameRect, type FrameRect } from '../shared/frames.js';
import { applyEmulation, resolveEmulation, viewportMatches, type EmulationSpec } from '../shared/emulate.js';
import {
  INPUT_TIMEOUT_MS,
  isInputFallbackError,
  requiresTrustedInput,
  syntheticInputWarning,
  trustedInputRequiredError,
} from '../shared/input.js';
import { parseKeyCombo, type KeyDispatch } from '../shared/keys.js';
import {
  consoleFromCdp,
  mergeConsole,
  networkFromCdp,
  pushCapped,
  type ConsoleMessage,
  type NetworkError,
} from '../shared/monitor.js';
import { DEFAULT_CURSOR_MS } from '../shared/protocol.js';
import { sleep } from '../shared/sleep.js';
import { buildSnapshot, type RawElement } from '../shared/snapshot.js';

type Ctx = { id: number; frameId: string; url: string };
type FrameNode = { id: string; url: string; parentId: string | null };
type DirectRef = { ref: number; ahId: string; contextId: number; frameId: number };
type Box = { x: number; y: number; width: number; height: number };
type PageElement = Omit<RawElement, 'frameId'>;
type Metrics = { cssWidth: number; cssHeight: number; devicePixelRatio: number };
type Via = 'trusted' | 'synthetic';

export type DirectOptions = {
  script?: string;
  inputTimeoutMs?: number;
};

export async function loadInjectedPageScript(): Promise<string> {
  const path = fileURLToPath(new URL('../inject.js', import.meta.url));
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error('missing dist/inject.js. Run npm run build.');
  }
}

export class DirectSession {
  private page: CdpConnection | null = null;
  private selectedId: string | null = null;
  private contexts = new Map<number, Ctx>();
  private frames: FrameNode[] = [];
  private frameNumbers = new Map<string, number>();
  private installed = new Set<number>();
  private refs = new Map<number, DirectRef>();
  private consoleLog: ConsoleMessage[] = [];
  private networkLog: NetworkError[] = [];
  private requestUrls = new Map<string, string>();
  private touch = false;
  private emulation: EmulationSpec | null = null;
  private scriptArmed = false;

  private constructor(
    private endpoint: string,
    private browser: string,
    private targets: CdpTarget[],
    private readonly script: string,
    private readonly inputTimeoutMs: number,
  ) {}

  static async attach(endpoint: string, options: DirectOptions = {}): Promise<DirectSession> {
    const script = options.script ?? await loadInjectedPageScript();
    const timeout = clampTimeout(options.inputTimeoutMs);
    const origin = normalizeCdpUrl(endpoint);
    const listed = await fetchCdpTargets(origin);
    const session = new DirectSession(origin, listed.browser, listed.targets, script, timeout);
    const first = listed.targets.find((target) => target.type === 'page') ?? listed.targets[0];
    if (first) await session.select(first.id);
    return session;
  }

  status(): Record<string, unknown> {
    const current = this.targets.find((target) => target.id === this.selectedId);
    return {
      attached: true,
      mode: 'cdp',
      url: this.endpoint,
      browser: this.browser,
      targetId: this.selectedId,
      title: current?.title ?? '',
      pageUrl: current?.url ?? '',
      targets: this.publicTargets(),
    };
  }

  async detach(): Promise<void> {
    const page = this.page;
    this.page = null;
    this.selectedId = null;
    this.contexts.clear();
    this.installed.clear();
    this.refs.clear();
    this.scriptArmed = false;
    page?.close();
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'list_tabs':
        return this.listTargets();
      case 'select_tab':
        return this.select(String(params.tabId ?? ''));
      case 'navigate':
        return this.navigate(String(params.url ?? ''));
      case 'snapshot':
        return this.snapshot();
      case 'click':
        return this.click(params);
      case 'type':
        return this.typeText(params);
      case 'press':
        return this.press(String(params.key ?? ''), requiresTrustedInput(params));
      case 'scroll':
        return this.scroll(params);
      case 'screenshot':
        return this.screenshot();
      case 'get_text':
        return this.getText(typeof params.max === 'number' ? params.max : 8000);
      case 'click_xy':
        return this.clickXY(params);
      case 'locate':
        return this.locate(String(params.text ?? ''));
      case 'emulate':
        return this.emulate(params);
      case 'console':
        return this.readConsole(params);
      case 'network_errors':
        return this.readNetwork(params);
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private async listTargets(): Promise<unknown> {
    const listed = await fetchCdpTargets(this.endpoint);
    this.browser = listed.browser;
    this.targets = listed.targets;
    if (this.selectedId && !this.targets.some((target) => target.id === this.selectedId)) {
      await this.detach();
    }
    return { mode: 'cdp', targetTabId: this.selectedId, tabs: this.publicTargets() };
  }

  private async select(id: string): Promise<unknown> {
    await this.listTargets();
    const target = this.targets.find((item) => item.id === id);
    if (!target) throw new Error(`unknown target ${id || '(empty)'}. Call list-tabs.`);
    if (this.selectedId === id && this.page?.isOpen) {
      return { id: target.id, title: target.title, url: target.url, mode: 'cdp' };
    }
    const previous = this.page;
    this.page = null;
    this.selectedId = null;
    this.contexts.clear();
    this.installed.clear();
    this.refs.clear();
    this.frames = [];
    this.frameNumbers.clear();
    this.scriptArmed = false;
    previous?.close();
    const page = await CdpConnection.connect(target.webSocketDebuggerUrl);
    this.page = page;
    this.selectedId = id;
    this.bindEvents(page);
    await page.send('Page.enable').catch(() => undefined);
    await page.send('Runtime.enable');
    await page.send('Network.enable').catch(() => undefined);
    await this.waitForMain(1500);
    if (!this.scriptArmed) {
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: this.script }).catch(() => undefined);
      this.scriptArmed = true;
    }
    const tree = await page.send<{ frameTree?: unknown }>('Page.getFrameTree').catch(() => ({ frameTree: undefined }));
    this.frames = flattenFrames(tree.frameTree);
    await page.send('Page.bringToFront').catch(() => undefined);
    return { id: target.id, title: target.title, url: target.url, mode: 'cdp' };
  }

  private bindEvents(page: CdpConnection): void {
    page.on('Runtime.executionContextCreated', (params) => {
      const record = asRecord(params);
      const context = asRecord(record.context);
      const aux = asRecord(context.auxData);
      const id = typeof context.id === 'number' ? context.id : -1;
      const frameId = typeof aux.frameId === 'string' ? aux.frameId : '';
      const type = typeof aux.type === 'string' ? aux.type : 'default';
      if (id < 0 || aux.isDefault === false || (type && type !== 'default')) return;
      this.contexts.set(id, { id, frameId, url: typeof context.origin === 'string' ? context.origin : '' });
    });
    page.on('Runtime.executionContextDestroyed', (params) => {
      const id = asRecord(params).executionContextId;
      if (typeof id === 'number') {
        this.contexts.delete(id);
        this.installed.delete(id);
      }
    });
    page.on('Runtime.executionContextsCleared', () => {
      this.contexts.clear();
      this.installed.clear();
    });
    page.on('Runtime.consoleAPICalled', (params) => {
      const line = consoleFromCdp('Runtime.consoleAPICalled', params);
      if (line) pushCapped(this.consoleLog, line);
    });
    page.on('Runtime.exceptionThrown', (params) => {
      const line = consoleFromCdp('Runtime.exceptionThrown', params);
      if (line) pushCapped(this.consoleLog, line);
    });
    page.on('Network.requestWillBeSent', (params) => {
      networkFromCdp('Network.requestWillBeSent', params, this.requestUrls);
    });
    page.on('Network.loadingFailed', (params) => {
      const failure = networkFromCdp('Network.loadingFailed', params, this.requestUrls);
      if (failure) pushCapped(this.networkLog, failure);
    });
    page.on('Network.responseReceived', (params) => {
      const failure = networkFromCdp('Network.responseReceived', params, this.requestUrls);
      if (failure) pushCapped(this.networkLog, failure);
    });
  }

  private async navigate(url: string): Promise<unknown> {
    const page = await this.requirePage();
    const loaded = this.waitForLoad(page);
    await page.send('Page.navigate', { url });
    await loaded;
    this.installed.clear();
    await this.holdEmulation();
    const info = await this.pageInfo();
    return { url: info.href || url, title: info.title, mode: 'cdp' };
  }

  private async snapshot(): Promise<unknown> {
    const page = await this.requirePage();
    await page.send('Page.bringToFront').catch(() => undefined);
    await this.waitForMain(1500);
    await this.holdEmulation();
    const contexts = this.defaultContexts();
    if (!contexts.length) throw new Error('page script is not available on this target');
    const collected: { ctx: Ctx; elements: PageElement[] }[] = [];
    for (const ctx of contexts) {
      try {
        const result = await this.callApi<{ elements?: PageElement[] }>(ctx.id, 'collect', []);
        collected.push({ ctx, elements: result?.elements ?? [] });
      } catch (error) {
        if (this.frameNo(ctx.frameId) === 0) throw error;
      }
    }
    const main = this.mainContext();
    if (!main || !collected.some((item) => item.ctx.id === main.id)) {
      throw new Error('page script is not available on this target');
    }
    const origins = await this.originsFor(collected.map((item) => item.ctx));
    const raw: RawElement[] = [];
    for (const item of collected) {
      const origin = origins.get(item.ctx.id) ?? { x: 0, y: 0 };
      const frameId = this.frameNo(item.ctx.frameId);
      for (const element of item.elements) {
        raw.push({
          ...element,
          frameId,
          x: element.x + origin.x,
          y: element.y + origin.y,
        });
      }
    }
    const metrics = await this.callApi<Metrics>(main.id, 'metrics', []);
    const built = buildSnapshot(raw, metrics);
    this.refs = new Map(built.items.map((item) => {
      const source = collected.find((group) => group.elements.some((element) => element.ahId === item.ahId));
      return [item.ref, {
        ref: item.ref,
        ahId: item.ahId,
        contextId: source?.ctx.id ?? main.id,
        frameId: item.frameId,
      }];
    }));
    const info = await this.pageInfo();
    return {
      text: built.text,
      url: info.href,
      title: info.title,
      devicePixelRatio: metrics.devicePixelRatio,
      cssWidth: metrics.cssWidth,
      cssHeight: metrics.cssHeight,
      mode: 'cdp',
      items: built.items.map(({ ahId: _ahId, ...item }) => item),
    };
  }

  private async click(params: Record<string, unknown>): Promise<unknown> {
    const ref = requiredInt(params.ref, 'ref');
    const entry = this.refEntry(ref);
    const at = await this.reveal(entry);
    const duration = durationOf(params);
    await this.cursor(at.x, at.y, 'Click', duration);
    await this.ripple();
    const delivered = await this.clickAt(at.x, at.y, entry.contextId, at.localX, at.localY, requiresTrustedInput(params));
    return {
      ...(delivered.warning ? { warning: delivered.warning } : {}),
      ref,
      via: delivered.via,
      x: at.x,
      y: at.y,
      devicePixelRatio: at.devicePixelRatio,
      mode: 'cdp',
    };
  }

  private async typeText(params: Record<string, unknown>): Promise<unknown> {
    const ref = requiredInt(params.ref, 'ref');
    const text = typeof params.text === 'string' ? params.text : '';
    const entry = this.refEntry(ref);
    const at = await this.reveal(entry);
    await this.cursor(at.x, at.y, 'Type', durationOf(params));
    await this.ripple();
    const requireTrusted = requiresTrustedInput(params);
    const clicked = await this.clickAt(at.x, at.y, entry.contextId, at.localX, at.localY, requireTrusted);
    await this.callApi(entry.contextId, 'focus', [entry.ahId]);
    await sleep(40);
    let via: Via = 'trusted';
    let warning = clicked.warning;
    if (clicked.via !== 'trusted') {
      via = 'synthetic';
      await this.setFieldValue(entry, text);
    } else {
      try {
        await this.input('Input.insertText', { text });
      } catch (error) {
        if (!isInputFallbackError(error)) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        if (requireTrusted) throw trustedInputRequiredError(reason);
        via = 'synthetic';
        warning = syntheticInputWarning(reason);
        await this.setFieldValue(entry, text);
      }
    }
    if (params.submit === true) {
      await this.label('Submit');
      const enter = parseKeyCombo('Enter');
      if (via === 'trusted') {
        try {
          await this.keyDownUp(enter);
        } catch (error) {
          if (!isInputFallbackError(error)) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          if (requireTrusted) throw trustedInputRequiredError(reason);
          warning = syntheticInputWarning(reason);
          await this.syntheticKey(enter);
        }
      } else if (!requireTrusted) {
        await this.syntheticKey(enter);
      } else {
        throw trustedInputRequiredError(warning || 'click was not trusted');
      }
    }
    return {
      ...(warning ? { warning } : {}),
      ref,
      length: text.length,
      submitted: params.submit === true,
      via,
      clickVia: clicked.via,
      mode: 'cdp',
    };
  }

  private async press(key: string, requireTrusted = false): Promise<unknown> {
    const page = await this.requirePage();
    await page.send('Page.bringToFront').catch(() => undefined);
    const parsed = parseKeyCombo(key);
    await this.label(`Press ${parsed.key}`);
    try {
      await this.keyDownUp(parsed);
      return { key: parsed.key, via: 'trusted', mode: 'cdp' };
    } catch (error) {
      if (!isInputFallbackError(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (requireTrusted) throw trustedInputRequiredError(reason);
      await this.syntheticKey(parsed);
      return { warning: syntheticInputWarning(reason), key: parsed.key, via: 'synthetic', mode: 'cdp' };
    }
  }

  private async scroll(params: Record<string, unknown>): Promise<unknown> {
    if (typeof params.ref === 'number') {
      const entry = this.refEntry(params.ref);
      const at = await this.reveal(entry);
      await this.cursor(at.x, at.y, 'Scroll', durationOf(params));
      return { ref: params.ref, x: at.x, y: at.y, devicePixelRatio: at.devicePixelRatio, mode: 'cdp' };
    }
    const page = await this.requirePage();
    await page.send('Page.bringToFront').catch(() => undefined);
    const main = this.mainContext();
    if (!main) throw new Error('page script is not available on this target');
    const metrics = await this.callApi<Metrics>(main.id, 'metrics', []);
    const x = metrics.cssWidth / 2;
    const y = metrics.cssHeight / 2;
    const direction = String(params.direction ?? '');
    await this.cursor(x, y, `Scroll ${direction}`, 420);
    const amount = typeof params.amount === 'number' ? params.amount : 480;
    const delta = wheelDelta(direction, amount);
    try {
      await this.input('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: delta.x,
        deltaY: delta.y,
        pointerType: 'mouse',
      });
      return { direction, amount, x, y, devicePixelRatio: metrics.devicePixelRatio, via: 'trusted', mode: 'cdp' };
    } catch (error) {
      if (!isInputFallbackError(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (requiresTrustedInput(params)) throw trustedInputRequiredError(reason);
      await this.callApi(main.id, 'syntheticScroll', [x, y, delta.x, delta.y]);
      return {
        warning: syntheticInputWarning(reason),
        direction,
        amount,
        x,
        y,
        devicePixelRatio: metrics.devicePixelRatio,
        via: 'synthetic',
        mode: 'cdp',
      };
    }
  }

  private async screenshot(): Promise<unknown> {
    const page = await this.requirePage();
    await page.send('Page.bringToFront').catch(() => undefined);
    await sleep(80);
    const shot = await page.send<{ data?: string }>('Page.captureScreenshot', { format: 'png' });
    const main = this.mainContext();
    const metrics = main
      ? await this.callApi<Metrics>(main.id, 'metrics', [])
      : { cssWidth: 0, cssHeight: 0, devicePixelRatio: 1 };
    if (!shot.data) throw new Error('screenshot payload was empty');
    return {
      base64: shot.data,
      devicePixelRatio: metrics.devicePixelRatio,
      cssWidth: metrics.cssWidth,
      cssHeight: metrics.cssHeight,
    };
  }

  private async getText(max: number): Promise<unknown> {
    await this.requirePage();
    const parts: string[] = [];
    for (const ctx of this.defaultContexts()) {
      try {
        const value = await this.callApi<string>(ctx.id, 'text', []);
        if (value) parts.push(value);
      } catch {
        // skip frames that cannot answer
      }
    }
    const combined = parts.join('\n\n');
    return { text: combined.slice(0, max), truncated: combined.length > max, length: combined.length, mode: 'cdp' };
  }

  private async clickXY(params: Record<string, unknown>): Promise<unknown> {
    const x = Number(params.x);
    const y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y are required');
    const page = await this.requirePage();
    await page.send('Page.bringToFront').catch(() => undefined);
    const main = this.mainContext();
    if (!main) throw new Error('page script is not available on this target');
    await this.cursor(x, y, 'Click', durationOf(params));
    await this.ripple();
    const delivered = await this.clickAt(x, y, main.id, x, y, requiresTrustedInput(params));
    return { ...(delivered.warning ? { warning: delivered.warning } : {}), x, y, via: delivered.via, mode: 'cdp' };
  }

  private async locate(text: string): Promise<unknown> {
    await this.requirePage();
    const main = this.mainContext();
    if (!main) throw new Error('page script is not available on this target');
    const matches = await this.callApi(main.id, 'locate', [text]);
    return { text, matches, mode: 'cdp' };
  }

  private async emulate(params: Record<string, unknown>): Promise<unknown> {
    const page = await this.requirePage();
    const spec = resolveEmulation(params);
    if (spec.preset === 'off') this.emulation = null;
    const result = await applyEmulation(spec, {
      send: (method, commandParams) => page.send(method, commandParams ?? {}),
      readViewport: () => this.readViewport(),
    });
    if (spec.preset === 'off') {
      this.touch = false;
      return { ...result, mode: 'cdp' };
    }
    this.emulation = spec;
    this.touch = spec.mobile && result.applied !== false;
    return { ...result, mode: 'cdp' };
  }

  private async readViewport(): Promise<Metrics | undefined> {
    const main = this.mainContext();
    if (!main) return undefined;
    return this.callApi<Metrics>(main.id, 'metrics', []);
  }

  private async holdEmulation(): Promise<void> {
    if (!this.emulation) return;
    const page = await this.requirePage();
    const current = await this.readViewport().catch(() => undefined);
    if (current && viewportMatches(this.emulation, current)) return;
    await applyEmulation(this.emulation, {
      send: (method, commandParams) => page.send(method, commandParams ?? {}),
      readViewport: () => this.readViewport(),
    });
  }

  private async readConsole(params: Record<string, unknown>): Promise<unknown> {
    await this.requirePage();
    const max = typeof params.max === 'number' ? params.max : 100;
    const clear = params.clear === true;
    const pageLogs: ConsoleMessage[] = [];
    for (const ctx of this.defaultContexts()) {
      try {
        const rows = await this.callApi<ConsoleMessage[]>(ctx.id, 'consoleEntries', [clear, max]);
        if (Array.isArray(rows)) pageLogs.push(...rows);
      } catch {
        // frame has no page script yet
      }
    }
    const merged = mergeConsole([...this.consoleLog, ...pageLogs], max);
    if (clear) this.consoleLog = [];
    return { messages: merged, mode: 'cdp' };
  }

  private async readNetwork(params: Record<string, unknown>): Promise<unknown> {
    await this.requirePage();
    const max = typeof params.max === 'number' ? params.max : 100;
    const errors = this.networkLog.slice(-max);
    if (params.clear === true) this.networkLog = [];
    return { errors, mode: 'cdp' };
  }

  private async reveal(entry: DirectRef): Promise<{ x: number; y: number; localX: number; localY: number; devicePixelRatio: number }> {
    const box = await this.callApi<Box | { error: string }>(entry.contextId, 'prepare', [entry.ahId], 8000);
    if (box && typeof box === 'object' && 'error' in box) throw new Error(String(box.error));
    const point = box as Box;
    const origin = (await this.originsFor([this.contexts.get(entry.contextId) ?? { id: entry.contextId, frameId: '', url: '' }])).get(entry.contextId) ?? { x: 0, y: 0 };
    const main = this.mainContext();
    const metrics = main
      ? await this.callApi<Metrics>(main.id, 'metrics', [])
      : { cssWidth: 0, cssHeight: 0, devicePixelRatio: 1 };
    return {
      x: point.x + origin.x,
      y: point.y + origin.y,
      localX: point.x,
      localY: point.y,
      devicePixelRatio: metrics.devicePixelRatio,
    };
  }

  private async originsFor(contexts: Ctx[]): Promise<Map<number, { x: number; y: number }>> {
    const map = new Map<number, { x: number; y: number }>();
    const pending: Ctx[] = [];
    await Promise.all(contexts.map(async (ctx) => {
      if (this.frameNo(ctx.frameId) === 0) {
        map.set(ctx.id, { x: 0, y: 0 });
        return;
      }
      try {
        const offset = await this.callApi<{ x: number; y: number } | null>(ctx.id, 'frameOffset', []);
        if (offset && Number.isFinite(offset.x) && Number.isFinite(offset.y)) {
          map.set(ctx.id, offset);
          return;
        }
      } catch {
        // measured from the parent instead
      }
      pending.push(ctx);
    }));
    const usedByParent = new Map<string, Set<number>>();
    for (const ctx of pending) {
      const node = this.frames.find((frame) => frame.id === ctx.frameId);
      const parent = node?.parentId ? this.contextsByFrame(node.parentId) : undefined;
      const parentOrigin = parent ? map.get(parent.id) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
      let rects: FrameRect[] = [];
      if (parent) {
        try {
          rects = await this.callApi<FrameRect[]>(parent.id, 'iframeRects', []);
        } catch {
          rects = [];
        }
      }
      const used = usedByParent.get(node?.parentId ?? '') ?? new Set<number>();
      if (node?.parentId) usedByParent.set(node.parentId, used);
      const index = matchFrameRect(Array.isArray(rects) ? rects : [], node?.url || ctx.url, used);
      if (index < 0) {
        map.set(ctx.id, parentOrigin);
        continue;
      }
      used.add(index);
      map.set(ctx.id, { x: parentOrigin.x + rects[index].x, y: parentOrigin.y + rects[index].y });
    }
    return map;
  }

  private async clickAt(
    x: number,
    y: number,
    contextId: number,
    localX: number,
    localY: number,
    requireTrusted = false,
  ): Promise<{ via: Via; warning?: string }> {
    try {
      await this.callApi(contextId, 'armClick', [localX, localY]).catch(() => undefined);
      await this.mouseClick(x, y);
      return { via: 'trusted' };
    } catch (error) {
      if (!isInputFallbackError(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (requireTrusted) throw trustedInputRequiredError(reason);
      await this.callApi(contextId, 'syntheticClick', [localX, localY, this.touch ? 'touch' : 'mouse']);
      return { via: 'synthetic', warning: syntheticInputWarning(reason) };
    }
  }

  private async mouseClick(x: number, y: number): Promise<void> {
    const px = Math.round(x * 100) / 100;
    const py = Math.round(y * 100) / 100;
    await this.input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', pointerType: 'mouse' });
    await this.input('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: px,
      y: py,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    });
    await sleep(30);
    await this.input('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: px,
      y: py,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    });
  }

  private async keyDownUp(key: KeyDispatch): Promise<void> {
    const base = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      modifiers: key.modifiers,
    };
    await this.input('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: key.text, unmodifiedText: key.text });
    await sleep(20);
    await this.input('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  private async input(method: string, params: Record<string, unknown>): Promise<void> {
    const page = await this.requirePage();
    await page.send(method, params, this.inputTimeoutMs);
  }

  private async syntheticKey(key: KeyDispatch): Promise<void> {
    let acted = false;
    for (const ctx of this.defaultContexts()) {
      try {
        const result = await this.callApi<{ acted?: boolean }>(ctx.id, 'syntheticKey', [key, true]);
        if (result?.acted) acted = true;
      } catch {
        // frame went away
      }
    }
    if (!acted) {
      const main = this.mainContext();
      if (main) await this.callApi(main.id, 'syntheticKey', [key, true]);
    }
  }

  private async setFieldValue(entry: DirectRef, text: string): Promise<void> {
    const ok = await this.callApi<boolean>(entry.contextId, 'setValue', [entry.ahId, text]);
    if (!ok) throw new Error('could not set the field value');
  }

  private async cursor(x: number, y: number, label: string, duration: number): Promise<void> {
    const main = this.mainContext();
    if (!main) return;
    await this.callApi(main.id, 'cursorMove', [x, y, label, duration], Math.max(8000, duration + 2000));
  }

  private async ripple(): Promise<void> {
    const main = this.mainContext();
    if (!main) return;
    await this.callApi(main.id, 'cursorRipple', []);
  }

  private async label(text: string): Promise<void> {
    const main = this.mainContext();
    if (!main) return;
    await this.callApi(main.id, 'cursorLabel', [text]);
  }

  private async pageInfo(): Promise<{ href: string; title: string }> {
    const main = this.mainContext();
    if (!main) return { href: '', title: '' };
    try {
      return await this.callApi<{ href: string; title: string }>(main.id, 'pageInfo', []);
    } catch {
      const target = this.targets.find((item) => item.id === this.selectedId);
      return { href: target?.url ?? '', title: target?.title ?? '' };
    }
  }

  private async callApi<T>(contextId: number, method: string, args: unknown[], timeoutMs = 8000): Promise<T> {
    await this.ensureApi(contextId);
    const value = await this.evaluate(callExpression(method, args), contextId, timeoutMs);
    if (isMissing(value)) {
      this.installed.delete(contextId);
      await this.ensureApi(contextId);
      const retry = await this.evaluate(callExpression(method, args), contextId, timeoutMs);
      if (isMissing(retry)) throw new Error('page script is not available on this target');
      return retry as T;
    }
    return value as T;
  }

  private async ensureApi(contextId: number): Promise<void> {
    if (this.installed.has(contextId)) return;
    await this.evaluate(this.script, contextId, 8000);
    this.installed.add(contextId);
  }

  private async evaluate(expression: string, contextId: number, timeoutMs: number): Promise<unknown> {
    const page = await this.requirePage();
    const result = await page.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      contextId,
    }, timeoutMs);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || 'page script failed');
    }
    return result.result?.value;
  }

  private async requirePage(): Promise<CdpConnection> {
    if (!this.page?.isOpen) {
      const id = this.selectedId ?? this.targets.find((target) => target.type === 'page')?.id ?? this.targets[0]?.id;
      if (!id) throw new Error('no page target. Open a window in the app, then list-tabs.');
      await this.select(id);
    }
    if (!this.page?.isOpen) throw new Error('debugger connection is not open');
    return this.page;
  }

  private async waitForMain(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.mainContext()) return;
      await sleep(20);
    }
  }

  private waitForLoad(page: CdpConnection): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(finish, 15000);
      const off = page.on('Page.loadEventFired', finish);
    });
  }

  private mainContext(): Ctx | undefined {
    const mainFrame = this.frames[0]?.id;
    if (mainFrame) {
      const match = [...this.contexts.values()].find((ctx) => ctx.frameId === mainFrame);
      if (match) return match;
    }
    return [...this.contexts.values()][0];
  }

  private defaultContexts(): Ctx[] {
    const main = this.mainContext();
    const rest = [...this.contexts.values()].filter((ctx) => ctx !== main).slice(0, 25);
    return main ? [main, ...rest] : rest;
  }

  private contextsByFrame(frameId: string): Ctx | undefined {
    return [...this.contexts.values()].find((ctx) => ctx.frameId === frameId);
  }

  private frameNo(frameId: string): number {
    const main = this.frames[0]?.id;
    if (!frameId || frameId === main) return 0;
    const known = this.frameNumbers.get(frameId);
    if (known != null) return known;
    const next = this.frameNumbers.size + 1;
    this.frameNumbers.set(frameId, next);
    return next;
  }

  private refEntry(ref: number): DirectRef {
    const entry = this.refs.get(ref);
    if (!entry) throw new Error(`unknown ref ${ref}; call snapshot first`);
    return entry;
  }

  private publicTargets(): Record<string, unknown>[] {
    return this.targets.map((target) => ({
      id: target.id,
      title: target.title,
      url: target.url,
      type: target.type,
      active: target.id === this.selectedId,
      selected: target.id === this.selectedId,
    }));
  }
}

function callExpression(method: string, args: unknown[]): string {
  const rendered = args.map((arg) => JSON.stringify(arg) ?? 'null').join(', ');
  return `(() => { const api = globalThis.__agentHand; const fn = api && api[${JSON.stringify(method)}]; if (typeof fn !== "function") return { __agentHandMissing: true }; return fn(${rendered}); })()`;
}

function isMissing(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && '__agentHandMissing' in value);
}

function flattenFrames(tree: unknown, parentId: string | null = null): FrameNode[] {
  const node = asRecord(tree);
  const frame = asRecord(node.frame);
  const id = typeof frame.id === 'string' ? frame.id : '';
  if (!id) return [];
  const url = typeof frame.url === 'string' ? frame.url : '';
  const children = Array.isArray(node.childFrames) ? node.childFrames : [];
  return [
    { id, url, parentId },
    ...children.flatMap((child) => flattenFrames(child, id)),
  ];
}

function wheelDelta(direction: string, amount: number): { x: number; y: number } {
  if (direction === 'up') return { x: 0, y: -amount };
  if (direction === 'down') return { x: 0, y: amount };
  if (direction === 'left') return { x: -amount, y: 0 };
  if (direction === 'right') return { x: amount, y: 0 };
  throw new Error('direction must be up, down, left, or right');
}

function durationOf(params: Record<string, unknown>): number {
  return typeof params.duration === 'number' ? params.duration : DEFAULT_CURSOR_MS;
}

function requiredInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} is required`);
  return value;
}

function clampTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return INPUT_TIMEOUT_MS;
  return Math.max(20, Math.min(10000, Math.floor(value)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
