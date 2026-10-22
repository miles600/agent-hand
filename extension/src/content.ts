import { collapseOverlays, installPageApi, type PageApi } from './page.js';

type Globals = typeof globalThis & {
  __agentHandInstalled?: boolean;
  __agentHand?: PageApi;
};

const globals = globalThis as Globals;

// Programmatic reinjection (chrome.scripting.executeScript) evaluates this file again.
// Collapse leftover overlays first, then refuse a second listener in this realm.
collapseOverlays();
if (!globals.__agentHandInstalled) {
  globals.__agentHandInstalled = true;
  const api = installPageApi();
  globals.__agentHand = api;
  installListener(api);
}

function installListener(api: PageApi): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.source !== 'agent-hand') return undefined;
    if (msg.type === 'ping-content') {
      sendResponse({ ok: true });
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
    if (msg.type === 'page-info') {
      sendResponse({ ok: true, result: api.pageInfo() });
      return undefined;
    }
    if (msg.type === 'synthetic-click') {
      sendResponse({
        ok: true,
        result: api.syntheticClick(Number(msg.x), Number(msg.y), typeof msg.pointerType === 'string' ? msg.pointerType : 'mouse'),
      });
      return undefined;
    }
    if (msg.type === 'locate') {
      sendResponse({ ok: true, result: api.locate(String(msg.text ?? '')) });
      return undefined;
    }
    if (msg.type === 'set-value') {
      sendResponse({ ok: true, result: api.setValue(String(msg.ahId), String(msg.text ?? '')) });
      return undefined;
    }
    if (msg.type === 'synthetic-key') {
      const key = msg.key && typeof msg.key === 'object' ? msg.key as { key?: string; code?: string; keyCode?: number; text?: string; modifiers?: number } : {};
      sendResponse({ ok: true, result: api.syntheticKey(key, msg.force === true) });
      return undefined;
    }
    if (msg.type === 'synthetic-scroll') {
      sendResponse({
        ok: true,
        result: api.syntheticScroll(Number(msg.x), Number(msg.y), Number(msg.deltaX), Number(msg.deltaY)),
      });
      return undefined;
    }
    if (msg.type === 'console') {
      sendResponse({ ok: true, result: api.consoleEntries(msg.clear === true, Number(msg.max ?? 100)) });
      return undefined;
    }
    if (window !== window.top) return undefined;
    if (msg.type === 'cursor-move') {
      void api.cursorMove(Number(msg.x), Number(msg.y), String(msg.label ?? ''), Number(msg.duration ?? 700)).then(
        () => sendResponse({ ok: true }),
        (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (msg.type === 'cursor-ripple') {
      api.cursorRipple();
      sendResponse({ ok: true });
      return undefined;
    }
    if (msg.type === 'cursor-label') {
      api.cursorLabel(String(msg.label ?? ''));
      sendResponse({ ok: true });
      return undefined;
    }
    return undefined;
  });
}
