import { sleep } from './sleep.js';

export const DEFAULT_WAIT_TIMEOUT_MS = 10000;
export const MAX_WAIT_TIMEOUT_MS = 60000;
/** How long the network must stay quiet before wait-for idle returns. */
export const NETWORK_IDLE_QUIET_MS = 500;

export const RESOURCE_IDLE_WARNING =
  'The debugger is not attached, so idle waited for document.readyState complete and stable resource timing instead of Chrome network events.';

export function compileUrlPattern(pattern: string): string | RegExp {
  const trimmed = pattern.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('/')) {
    const last = trimmed.lastIndexOf('/');
    if (last > 0) {
      const flags = trimmed.slice(last + 1);
      if (/^[gimsuy]*$/.test(flags)) {
        try {
          return new RegExp(trimmed.slice(1, last), flags);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`invalid url pattern: ${message}`);
        }
      }
    }
  }
  return pattern;
}

export function urlMatches(href: string, pattern: string): boolean {
  const compiled = compileUrlPattern(pattern);
  if (typeof compiled === 'string') return href.includes(compiled);
  return compiled.test(href);
}

/** Returns elapsed milliseconds, or -1 when the timeout expires. */
export async function pollUntil(
  timeoutMs: number,
  intervalMs: number,
  read: () => Promise<boolean>,
): Promise<number> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (true) {
    if (await read()) return Date.now() - started;
    const now = Date.now();
    if (now >= deadline) return -1;
    await sleep(Math.min(intervalMs, deadline - now));
  }
}

export function textTimeout(timeout: number, text: string): Error {
  return new Error(`timed out after ${timeout}ms waiting for visible text to include ${JSON.stringify(text)}`);
}

export function urlTimeout(timeout: number, pattern: string, href: string): Error {
  return new Error(`timed out after ${timeout}ms waiting for the url to match ${JSON.stringify(pattern)} (now ${href || 'blank'})`);
}

export function networkIdleTimeout(timeout: number, inflight: number): Error {
  return new Error(
    `timed out after ${timeout}ms waiting for network idle (${inflight} request(s) still in flight). Idle means no tracked Chrome Network request has been in flight for ${NETWORK_IDLE_QUIET_MS}ms. Tracking starts when the debugger attaches. WebSockets and long polls may never go idle.`,
  );
}

export function resourceIdleTimeout(timeout: number): Error {
  return new Error(
    `timed out after ${timeout}ms waiting for idle. The debugger is not attached, so idle means document.readyState is complete and resource timing is unchanged for ${NETWORK_IDLE_QUIET_MS}ms.`,
  );
}
