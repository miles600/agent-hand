import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type SavedScreenshot = {
  path: string;
  width: number;
  height: number;
  devicePixelRatio: number;
  cssWidth: number;
  cssHeight: number;
  note: string;
  warning?: string;
  /** cdp when the debugger captured the emulated viewport; visible-tab is the fallback. */
  via?: string;
};

export function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('screenshot was not a png');
  }
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('screenshot png is missing IHDR');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

export async function materializeScreenshot(
  data: unknown,
  options: { out?: string; dir: string },
): Promise<SavedScreenshot> {
  if (!data || typeof data !== 'object') throw new Error('bad screenshot payload');
  const record = data as Record<string, unknown>;
  const raw = typeof record.base64 === 'string' ? record.base64 : '';
  const cleaned = raw.replace(/^data:image\/png;base64,/, '');
  if (!cleaned) throw new Error('screenshot payload was empty');
  const buffer = Buffer.from(cleaned, 'base64');
  const size = pngSize(buffer);
  const path = options.out
    ? resolve(options.out)
    : join(options.dir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, buffer, { mode: 0o600 });
  const saved: SavedScreenshot = {
    path,
    width: size.width,
    height: size.height,
    devicePixelRatio: numberOr(record.devicePixelRatio, 1),
    cssWidth: numberOr(record.cssWidth, 0),
    cssHeight: numberOr(record.cssHeight, 0),
    note: 'Bounding boxes from snapshot are CSS pixels. Multiply by devicePixelRatio to map onto this image.',
  };
  if (typeof record.warning === 'string' && record.warning) saved.warning = record.warning;
  if (typeof record.via === 'string' && record.via) saved.via = record.via;
  return saved;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
