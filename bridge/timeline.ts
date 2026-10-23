import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pngSize } from './screenshot.js';

export type Operation = {
  id: string;
  method: string;
  element?: string;
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'interrupted';
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  target?: { tabId: number | string; title: string; url: string };
  result?: Record<string, unknown>;
  error?: string;
  screenshot?: { width: number; height: number; bytes: number };
  screenshotError?: string;
};

export class Timeline {
  readonly entries: Operation[] = [];
  paused = false;
  captureScreenshots = true;
  storageError = '';
  private writes: Promise<void> = Promise.resolve();
  private garbage = new Set<string>();

  constructor(readonly dir: string, private readonly maxEntries = 100, private readonly maxImageBytes = 64 * 1024 * 1024) {}

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(join(this.dir, 'history.json'), 'utf8')) as {
        paused?: boolean; captureScreenshots?: boolean; entries?: Operation[];
      };
      this.paused = saved.paused === true;
      this.captureScreenshots = saved.captureScreenshots !== false;
      for (const entry of Array.isArray(saved.entries) ? saved.entries : []) {
        if (!entry || !validId(entry.id) || typeof entry.method !== 'string' || typeof entry.status !== 'string') continue;
        if (entry.status === 'queued' || entry.status === 'running') {
          entry.status = 'interrupted';
          entry.error = 'Bridge restarted; the previous outcome is unknown. Inspect the page before retrying.';
          entry.finishedAt = new Date().toISOString();
          this.paused = true;
        }
        this.entries.push(entry);
      }
      this.changed();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.storageError = `Could not load timeline: ${error instanceof Error ? error.message : String(error)}`;
        this.paused = true;
      }
    }
    if (!this.storageError) {
      const retained = new Set(this.entries.filter(entry => entry.screenshot).map(entry => `${entry.id}.png`));
      for (const name of await readdir(this.dir).catch(() => [] as string[])) {
        if (name.endsWith('.png') && validId(name.slice(0, -4)) && !retained.has(name)) {
          await unlink(join(this.dir, name)).catch(() => undefined);
        }
      }
    }
  }

  add(method: string, params: Record<string, unknown>): Operation {
    const entry: Operation = {
      id: randomUUID(), method, params: safeParams(params), status: 'queued', queuedAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.changed();
    return entry;
  }

  finish(entry: Operation, status: Operation['status'], error?: string): void {
    entry.status = status;
    entry.finishedAt = new Date().toISOString();
    if (error) entry.error = error.slice(0, 1200);
    this.changed();
  }

  view(): Record<string, unknown> {
    const active = this.entries.find(entry => entry.status === 'running');
    return {
      mode: this.paused ? active ? 'pausing' : 'paused' : 'ready',
      paused: this.paused,
      activeId: active?.id ?? null,
      captureScreenshots: this.captureScreenshots,
      storageError: this.storageError,
      maxEntries: this.maxEntries,
      maxImageBytes: this.maxImageBytes,
      entries: [...this.entries].reverse(),
    };
  }

  changed(): void {
    while (this.entries.length > this.maxEntries) {
      const index = this.entries.findIndex(entry => entry.status !== 'running' && entry.status !== 'queued');
      if (index < 0) break;
      const [entry] = this.entries.splice(index, 1);
      if (entry.screenshot) this.garbage.add(entry.id);
    }
    let total = this.entries.reduce((sum, entry) => sum + (entry.screenshot?.bytes ?? 0), 0);
    for (const entry of this.entries) {
      if (total <= this.maxImageBytes) break;
      if (!entry.screenshot) continue;
      total -= entry.screenshot.bytes;
      delete entry.screenshot;
      entry.screenshotError = 'Screenshot removed by the local storage limit.';
      this.garbage.add(entry.id);
    }
    this.writes = this.writes.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const garbage = [...this.garbage];
      this.garbage.clear();
      for (const id of garbage) await unlink(this.imagePath(id)).catch(() => undefined);
      const temporary = join(this.dir, 'history.json.tmp');
      await writeFile(temporary, JSON.stringify({ paused: this.paused, captureScreenshots: this.captureScreenshots, entries: this.entries }), { mode: 0o600 });
      await rename(temporary, join(this.dir, 'history.json'));
    }).catch(error => {
      this.storageError = `Could not save timeline: ${error instanceof Error ? error.message : String(error)}`;
    });
  }

  async capture(entry: Operation, data: unknown): Promise<void> {
    const path = data && typeof data === 'object' && 'path' in data ? data.path : undefined;
    if (typeof path !== 'string') throw new Error('No screenshot file was returned');
    const bytes = await readFile(path);
    const size = pngSize(bytes);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.imagePath(entry.id), bytes, { mode: 0o600 });
    entry.screenshot = { ...size, bytes: bytes.length };
    this.changed();
  }

  async image(id: string): Promise<Buffer> {
    if (!validId(id) || !this.entries.some(entry => entry.id === id && entry.screenshot)) throw new Error('Screenshot not found');
    return readFile(this.imagePath(id));
  }

  clear(): void {
    if (this.entries.some(entry => entry.status === 'running' || entry.status === 'queued')) throw new Error('Wait for the current operation to finish before clearing history.');
    for (const entry of this.entries) if (entry.screenshot) this.garbage.add(entry.id);
    this.entries.length = 0;
    this.changed();
  }

  flush(): Promise<void> { return this.writes; }
  private imagePath(id: string): string { return join(this.dir, `${id}.png`); }
}

function validId(id: unknown): id is string { return typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id); }

export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = ''; url.password = '';
    for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, '[redacted]');
    url.hash = '';
    return url.toString();
  } catch { return value.slice(0, 500); }
}

function safeParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key,
    (key === 'text' || key === 'value') && typeof value === 'string' ? `[${value.length} characters]`
      : key === 'url' && typeof value === 'string' ? safeUrl(value)
      : key === 'key' && typeof value === 'string' && value.length === 1 ? '[character]'
      : typeof value === 'string' ? value.slice(0, 500) : value,
  ]));
}

export function operationResult(method: string, data: unknown): Record<string, unknown> {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const result: Record<string, unknown> = {};
  for (const key of ['via', 'clickVia', 'warning', 'found', 'waited', 'applied', 'submitted', 'length', 'truncated', 'ms', 'width', 'height']) {
    const value = record[key];
    if (value != null) result[key] = typeof value === 'string' ? value.slice(0, 500) : value;
  }
  if (typeof record.url === 'string') result.url = safeUrl(record.url);
  if (method === 'list_tabs' && Array.isArray(record.tabs)) result.tabCount = record.tabs.length;
  if (method === 'snapshot' && Array.isArray(record.items)) result.elementCount = record.items.length;
  if (method === 'observe' && record.snapshot && typeof record.snapshot === 'object') {
    result.observation = operationResult('snapshot', record.snapshot);
  }
  return result;
}
