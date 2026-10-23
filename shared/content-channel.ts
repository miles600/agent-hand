import { sleep } from './sleep.js';

// Only observations and cursor feedback may be repeated after a document change.
const SAFE_READS = new Set([
  'ping-content', 'collect', 'metrics', 'text', 'page-info', 'frame-offset',
  'iframe-rects', 'window-chrome', 'resource-timing', 'wait-for-scroll',
  'cursor-move', 'cursor-label', 'cursor-ripple',
]);

export function isContentTransition(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /back[ /]forward cache|bfcache|receiving end does not exist|message (?:channel|port) closed|no frame with id|frame (?:was )?removed/i.test(message);
}

export async function contentRequest<T>(
  type: string, send: () => Promise<T>, recover: () => Promise<unknown>,
  wait: () => Promise<void> = () => sleep(100),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await send(); }
    catch (error) {
      if (!isContentTransition(error)) throw error;
      if (!SAFE_READS.has(type) || attempt >= 2) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Page changed during ${type}. Take a fresh observation before retrying; any previous action may already have completed. (${reason})`);
      }
      await wait();
      await recover();
    }
  }
}
