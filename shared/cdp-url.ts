const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Accept only an http loopback DevTools endpoint, and return its origin. */
export function normalizeCdpUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('cdp url is required');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('invalid cdp url');
  }
  if (url.protocol !== 'http:') throw new Error('cdp url must be http://127.0.0.1:<port>');
  if (!LOOPBACK.has(url.hostname)) throw new Error('cdp url must point at loopback');
  if (!url.port) throw new Error('cdp url needs a port');
  return url.origin;
}

/** Page debugger sockets must stay on loopback. A target list can otherwise point off-box. */
export function assertLoopbackWebSocket(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('bad debugger websocket');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('bad debugger websocket');
  if (!LOOPBACK.has(url.hostname)) throw new Error('refusing a non-loopback debugger websocket');
  return url.toString();
}
