export type EmulationSpec = {
  preset: 'iphone' | 'pixel' | 'custom';
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
};

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PIXEL_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const PRESETS: Record<string, EmulationSpec> = {
  iphone: {
    preset: 'iphone',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: IPHONE_UA,
  },
  pixel: {
    preset: 'pixel',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: PIXEL_UA,
  },
};

/** CLI / MCP arguments → either clear overrides or a concrete device. */
export function normalizeEmulate(input: Record<string, unknown>): Record<string, unknown> {
  const name = stringish(input.preset ?? input.device);
  if (name === 'off' || name === 'clear' || input.off === true) return { preset: 'off' };
  if (name && PRESETS[name]) return { preset: name };
  if (name) throw new Error('emulate preset must be iphone, pixel, or off');
  const width = asInt(input.width, 'width');
  const height = asInt(input.height, 'height');
  if (width < 200 || width > 2000 || height < 200 || height > 2000) throw new Error('emulate size out of range');
  const scale = input.deviceScaleFactor == null ? 2 : Number(input.deviceScaleFactor);
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new Error('deviceScaleFactor out of range');
  const mobile = input.mobile == null ? true : Boolean(input.mobile);
  return { width, height, deviceScaleFactor: scale, mobile };
}

export function resolveEmulation(params: Record<string, unknown>): EmulationSpec | { preset: 'off' } {
  if (params.preset === 'off') return { preset: 'off' };
  if (typeof params.preset === 'string' && PRESETS[params.preset]) return { ...PRESETS[params.preset] };
  const width = Number(params.width);
  const height = Number(params.height);
  const mobile = params.mobile !== false;
  return {
    preset: 'custom',
    width,
    height,
    deviceScaleFactor: Number(params.deviceScaleFactor ?? 2),
    mobile,
    userAgent: mobile ? PIXEL_UA : '',
  };
}

function stringish(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function asInt(value: unknown, name: string): number {
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
