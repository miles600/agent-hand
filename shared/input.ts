/**
 * DevTools, docked or undocked, holds the only debugger on the tab.
 * Undocked: chrome.debugger.attach is refused immediately ("Another debugger
 * is already attached"), then Input.* fails at once with "Debugger is not
 * attached". That is not the 2.5s timeout. The total time is just the cursor
 * glide. Docked DevTools sometimes lets attach succeed and then never acks
 * Input.*, so the timeout below fires. Closing DevTools is what makes a
 * click trusted. Callers fall back to DOM events unless trusted input is required.
 * A timeout is not a reason to detach the debugger.
 */
export const INPUT_TIMEOUT_MS = 2500;

export const TRUSTED_INPUT_METHODS = new Set(['click', 'type', 'press', 'scroll', 'click_xy']);

/**
 * True when trusted CDP input cannot be delivered and the caller should use DOM events.
 * A timeout is not a reason to detach the debugger: Chrome leaves it attached, and
 * detaching makes the next command fail with "Debugger is not attached".
 */
export function isInputFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|not attached|another debugger|detached while/i.test(message);
}

export function requiresTrustedInput(params: Record<string, unknown> | undefined): boolean {
  if (!params) return false;
  return params.requireTrusted === true || params.requireTrusted === 'true';
}

export function syntheticInputWarning(reason: string): string {
  return `${inputBlockExplanation(reason)} The page got a synthetic event instead (isTrusted is false). Close DevTools completely, then run emulate (for example 390x844@3) so the phone viewport stays and the next click can be trusted.`;
}

export function trustedInputRequiredError(reason: string): Error {
  return new Error(`Trusted input required but not delivered. ${inputBlockExplanation(reason)} Close DevTools completely (undocking does not help) and retry. Synthetic input was not sent.`);
}

function inputBlockExplanation(reason: string): string {
  const fast = /another debugger|not attached|detached while/i.test(reason);
  if (fast) {
    return `DevTools is open on this tab, so Chrome refused the debugger immediately (${reason}). Undocking does not fix this: DevTools still holds the only debugger, and Input.* fails at once instead of waiting ${INPUT_TIMEOUT_MS}ms.`;
  }
  return `DevTools is likely open and docked: the debugger attached, but Input.* did not acknowledge within ${INPUT_TIMEOUT_MS}ms (${reason}).`;
}
