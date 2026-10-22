/** Input.* often never acks while DevTools is docked on the tab. Callers fall back to DOM events. */
export const INPUT_TIMEOUT_MS = 2500;

/**
 * True when trusted CDP input cannot be delivered and the caller should use DOM events.
 * A timeout is not a reason to detach the debugger: Chrome leaves it attached, and
 * detaching makes the next command fail with "Debugger is not attached".
 */
export function isInputFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|not attached|another debugger|detached while/i.test(message);
}
