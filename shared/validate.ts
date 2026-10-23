import { normalizeCdpUrl } from './cdp-url.js';
import { normalizeEmulate } from './emulate.js';
import { requiresTrustedInput } from './input.js';
import { parseKeyCombo } from './keys.js';
import { compileUrlPattern, DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS } from './wait.js';

const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

export function normalizeCall(
  method: string,
  raw?: Record<string, unknown>,
): { method: string; params: Record<string, unknown> } {
  const input = raw ?? {};
  switch (method) {
    case 'list_tabs':
    case 'snapshot':
      return { method, params: {} };
    case 'observe': {
      if (input.includeScreenshot != null && typeof input.includeScreenshot !== 'boolean') {
        throw new Error('includeScreenshot must be a boolean');
      }
      const params: Record<string, unknown> = { includeScreenshot: input.includeScreenshot === true };
      if (input.tabId != null) params.tabId = asTargetId(input.tabId);
      return { method, params };
    }
    case 'select_tab':
      return { method, params: { tabId: asTargetId(input.tabId) } };
    case 'new_tab':
    case 'navigate':
      return { method, params: { url: asHttpUrl(input.url) } };
    case 'click':
    case 'hover':
    case 'dblclick':
    case 'right_click':
      return refPoint(method, input);
    case 'type':
    case 'fill': {
      const text = asString(input.text, 'text');
      if (text.length === 0) throw new Error('text is required');
      if (text.length > 20000) throw new Error('text is too long');
      return {
        method,
        params: withTrusted(withMotion({ ref: asRef(input.ref), text, submit: Boolean(input.submit) }, input), input),
      };
    }
    case 'clear':
      return refPoint(method, input);
    case 'select': {
      const value = asString(input.value, 'value').trim();
      if (!value) throw new Error('value is required');
      if (value.length > 500) throw new Error('value is too long');
      return { method, params: withTrusted(withMotion({ ref: asRef(input.ref), value }, input), input) };
    }
    case 'press': {
      const key = asString(input.key, 'key');
      parseKeyCombo(key);
      return { method, params: withTrusted({ key }, input) };
    }
    case 'scroll': {
      const params: Record<string, unknown> = {};
      if (input.ref != null) params.ref = asRef(input.ref);
      if (input.direction != null) {
        const direction = asString(input.direction, 'direction').toLowerCase();
        if (!DIRECTIONS.has(direction)) throw new Error('direction must be up, down, left, or right');
        params.direction = direction;
      }
      if (params.ref == null && params.direction == null) {
        throw new Error('scroll needs a direction or a ref');
      }
      if (input.amount != null) {
        const amount = asInt(input.amount, 'amount');
        if (amount < 1 || amount > 5000) throw new Error('amount out of range');
        params.amount = amount;
      }
      if (typeof input.duration === 'number' || typeof input.duration === 'string') {
        const duration = asDuration(input.duration);
        if (duration != null) params.duration = duration;
      }
      return { method, params: withTrusted(params, input) };
    }
    case 'screenshot': {
      const params: Record<string, unknown> = {};
      if (input.out != null) params.out = asString(input.out, 'out');
      return { method, params };
    }
    case 'click_xy':
    case 'hover_xy':
    case 'dblclick_xy':
    case 'right_click_xy':
      return xyPoint(method, input);
    case 'locate': {
      const text = asString(input.text, 'text');
      if (!text.trim()) throw new Error('text is required');
      if (text.length > 500) throw new Error('text is too long');
      return { method, params: { text } };
    }
    case 'emulate':
      return { method, params: normalizeEmulate(input) };
    case 'console':
    case 'network_errors':
      return { method, params: logParams(input) };
    case 'reload_extension':
    case 'detach_cdp':
      return { method, params: {} };
    case 'attach_cdp':
      return { method, params: { url: normalizeCdpUrl(input.url) } };
    case 'get_text': {
      const max = input.max == null ? 8000 : asInt(input.max, 'max');
      if (max < 1 || max > 50000) throw new Error('max out of range');
      return { method, params: { max } };
    }
    case 'wait': {
      const ms = asInt(input.ms, 'ms');
      if (ms < 0 || ms > 60000) throw new Error('ms out of range');
      return { method, params: { ms } };
    }
    case 'wait_for_text': {
      const text = asString(input.text, 'text');
      if (!text) throw new Error('text is required');
      if (text.length > 500) throw new Error('text is too long');
      return { method, params: { text, ...timeoutParam(input) } };
    }
    case 'wait_for_url': {
      const url = asString(input.url, 'url');
      if (!url.trim()) throw new Error('url is required');
      if (url.length > 500) throw new Error('url is too long');
      compileUrlPattern(url);
      return { method, params: { url, ...timeoutParam(input) } };
    }
    case 'wait_for_idle':
      return { method, params: timeoutParam(input) };
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

function refPoint(method: string, input: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  return { method, params: withTrusted(withMotion({ ref: asRef(input.ref) }, input), input) };
}

function xyPoint(method: string, input: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  const x = asFinite(input.x, 'x');
  const y = asFinite(input.y, 'y');
  if (x < 0 || y < 0 || x > 100000 || y > 100000) throw new Error(`${method} needs viewport CSS pixels`);
  return { method, params: withTrusted(withMotion({ x, y }, input), input) };
}

function timeoutParam(input: Record<string, unknown>): { timeout: number } {
  const timeout = input.timeout == null ? DEFAULT_WAIT_TIMEOUT_MS : asInt(input.timeout, 'timeout');
  if (timeout < 0 || timeout > MAX_WAIT_TIMEOUT_MS) throw new Error('timeout out of range');
  return { timeout };
}

function withTrusted(params: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
  if (requiresTrustedInput(input)) params.requireTrusted = true;
  return params;
}

function withMotion(
  params: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const duration = asDuration(input.duration);
  if (duration != null) params.duration = duration;
  if (input.trace === true) params.trace = true;
  return params;
}

export function asHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('url is required');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http and https urls are allowed');
  }
  return url.toString();
}

function asRef(value: unknown): number {
  const ref = asInt(value, 'ref');
  if (ref < 1 || ref > 100000) throw new Error('ref out of range');
  return ref;
}

function asDuration(value: unknown): number | undefined {
  if (value == null) return undefined;
  const duration = asInt(value, 'duration');
  if (duration < 0 || duration > 4000) throw new Error('duration out of range');
  return duration;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  return value;
}

function logParams(input: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (input.clear === true || input.clear === 'true') params.clear = true;
  if (input.max != null) {
    const max = asInt(input.max, 'max');
    if (max < 1 || max > 500) throw new Error('max out of range');
    params.max = max;
  }
  return params;
}

function asTargetId(value: unknown): number | string {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
    if (/^[A-Za-z0-9._:-]{1,200}$/.test(trimmed)) return trimmed;
  }
  throw new Error('tabId is required');
}

function asFinite(value: unknown, name: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function asInt(value: unknown, name: string): number {
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}
