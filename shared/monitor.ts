export type ConsoleMessage = {
  level: string;
  text: string;
  time: number;
  source: string;
};

export type NetworkError = {
  url: string;
  status: number;
  error: string;
  time: number;
};

export function pushCapped<T>(list: T[], item: T, cap = 200): void {
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
}

export function mergeConsole(parts: ConsoleMessage[], max: number): ConsoleMessage[] {
  const seen = new Set<string>();
  const out: ConsoleMessage[] = [];
  for (const item of parts) {
    const key = `${item.level}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  const cap = max > 0 ? max : out.length;
  return out.slice(-cap);
}

export function consoleFromCdp(method: string, params: unknown, now = Date.now()): ConsoleMessage | null {
  const record = asRecord(params);
  if (method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(record.args) ? record.args : [];
    const text = args.map((arg) => formatRemote(arg)).filter(Boolean).join(' ');
    const raw = typeof record.type === 'string' ? record.type : 'log';
    const level = raw === 'warning' ? 'warn' : raw;
    return { level, text, time: now, source: 'cdp' };
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = asRecord(record.exceptionDetails);
    const exception = asRecord(details.exception);
    const text = stringOr(exception.description, stringOr(details.text, 'exception'));
    return { level: 'error', text, time: now, source: 'cdp' };
  }
  return null;
}

export function noteCdpRequest(requests: Map<string, string>, params: unknown): void {
  const record = asRecord(params);
  const id = stringOr(record.requestId, '');
  const request = asRecord(record.request);
  const url = stringOr(request.url, '');
  if (id && url) requests.set(id, url);
}

export function networkFromCdp(
  method: string,
  params: unknown,
  requests: Map<string, string>,
  now = Date.now(),
): NetworkError | null {
  const record = asRecord(params);
  if (method === 'Network.requestWillBeSent') {
    noteCdpRequest(requests, params);
    return null;
  }
  if (method === 'Network.loadingFailed') {
    const id = stringOr(record.requestId, '');
    const url = requests.get(id) || stringOr(record.documentURL, id || 'unknown');
    return { url, status: 0, error: stringOr(record.errorText, 'failed'), time: now };
  }
  if (method === 'Network.responseReceived') {
    const response = asRecord(record.response);
    const status = typeof response.status === 'number' ? response.status : 0;
    if (status < 400) return null;
    const id = stringOr(record.requestId, '');
    const url = stringOr(response.url, requests.get(id) || id || 'unknown');
    return { url, status, error: stringOr(response.statusText, 'HTTP error'), time: now };
  }
  return null;
}

function formatRemote(value: unknown): string {
  const arg = asRecord(value);
  if (typeof arg.value === 'string') return arg.value;
  if (typeof arg.value === 'number' || typeof arg.value === 'boolean') return String(arg.value);
  if (typeof arg.description === 'string') return arg.description;
  if (typeof arg.unserializableValue === 'string') return arg.unserializableValue;
  if (typeof arg.type === 'string') return `[${arg.type}]`;
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}
