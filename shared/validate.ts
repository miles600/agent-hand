import { parseKeyCombo } from './keys.js';

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
    case 'select_tab':
      return { method, params: { tabId: asInt(input.tabId, 'tabId') } };
    case 'navigate':
      return { method, params: { url: asHttpUrl(input.url) } };
    case 'click':
      return { method, params: withMotion({ ref: asRef(input.ref) }, input) };
    case 'type': {
      const text = asString(input.text, 'text');
      if (text.length === 0) throw new Error('text is required');
      if (text.length > 20000) throw new Error('text is too long');
      return {
        method,
        params: withMotion({ ref: asRef(input.ref), text, submit: Boolean(input.submit) }, input),
      };
    }
    case 'press': {
      const key = asString(input.key, 'key');
      parseKeyCombo(key);
      return { method, params: { key } };
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
      return { method, params };
    }
    case 'screenshot': {
      const params: Record<string, unknown> = {};
      if (input.out != null) params.out = asString(input.out, 'out');
      return { method, params };
    }
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
    default:
      throw new Error(`unknown method: ${method}`);
  }
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
