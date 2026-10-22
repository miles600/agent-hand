export type EmulationSpec = {
  preset: 'iphone' | 'pixel' | 'custom';
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
};

export type ViewportReading = {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
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

const SIZE_TOKEN = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/i;

/**
 * DevTools device mode and chrome.debugger write the same Emulation override.
 * The extension cannot toggle the device toolbar. With DevTools closed the
 * override stays for as long as this debugger stays attached.
 */
export const VIEWPORT_MISMATCH_WARNING =
  'The page viewport does not match the requested size. Close DevTools before emulate. Closing DevTools drops the device toolbar and the window goes back to desktop size (often ~1536x735 @1.25 on a 125% Windows display). This extension cannot toggle DevTools\' device toolbar. chrome.debugger Emulation.setDeviceMetricsOverride then sets the phone viewport and keeps it while the debugger stays attached. Opening DevTools clears it. Trust cssWidth, cssHeight, devicePixelRatio, and the snapshot viewport line.';

/** CLI / MCP arguments → either clear overrides or a concrete device. */
export function normalizeEmulate(input: Record<string, unknown>): Record<string, unknown> {
  const name = stringish(input.preset ?? input.device ?? input.size);
  if (name === 'off' || name === 'clear' || input.off === true) return withFit({ preset: 'off' }, input);
  if (name && PRESETS[name]) return withFit({ preset: name }, input);
  const sized = name ? parseSizeToken(name) : null;
  if (name && !sized) {
    throw new Error('emulate preset must be iphone, pixel, or off, or a size like 390x844 or 390x844@3');
  }
  const width = sized ? sized.width : asInt(input.width, 'width');
  const height = sized ? sized.height : asInt(input.height, 'height');
  if (width < 200 || width > 2000 || height < 200 || height > 2000) throw new Error('emulate size out of range');
  const scaleSource = sized?.deviceScaleFactor ?? input.deviceScaleFactor;
  const scale = scaleSource == null || scaleSource === '' ? 2 : Number(scaleSource);
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new Error('deviceScaleFactor out of range');
  const mobile = input.mobile == null ? true : Boolean(input.mobile);
  return withFit({ width, height, deviceScaleFactor: scale, mobile }, input);
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

export function deviceMetricsOverride(spec: EmulationSpec): Record<string, unknown> {
  const landscape = spec.width > spec.height;
  return {
    width: spec.width,
    height: spec.height,
    deviceScaleFactor: spec.deviceScaleFactor,
    mobile: spec.mobile,
    screenWidth: spec.width,
    screenHeight: spec.height,
    screenOrientation: landscape
      ? { angle: 90, type: 'landscapePrimary' }
      : { angle: 0, type: 'portraitPrimary' },
  };
}

export function viewportMatches(
  spec: Pick<EmulationSpec, 'width' | 'height' | 'deviceScaleFactor'>,
  effective: ViewportReading,
): boolean {
  if (!Number.isFinite(effective.cssWidth) || !Number.isFinite(effective.cssHeight) || !Number.isFinite(effective.devicePixelRatio)) {
    return false;
  }
  return Math.round(effective.cssWidth) === spec.width
    && Math.round(effective.cssHeight) === spec.height
    && Math.abs(effective.devicePixelRatio - spec.deviceScaleFactor) < 0.05;
}

export function describeEmulation(
  spec: EmulationSpec | { preset: 'off' },
  effective?: ViewportReading,
): Record<string, unknown> {
  const reading = readingFields(effective);
  if (spec.preset === 'off') return { preset: 'off', touch: false, ...reading };
  const applied = effective ? viewportMatches(spec, effective) : undefined;
  const warning = applied === false && effective
    ? `Requested ${spec.width}x${spec.height} @${spec.deviceScaleFactor} but the page is ${Math.round(effective.cssWidth)}x${Math.round(effective.cssHeight)} @${formatScale(effective.devicePixelRatio)}. ${VIEWPORT_MISMATCH_WARNING}`
    : undefined;
  return {
    preset: spec.preset,
    width: spec.width,
    height: spec.height,
    deviceScaleFactor: spec.deviceScaleFactor,
    mobile: spec.mobile,
    touch: spec.mobile,
    ...reading,
    ...(applied == null ? {} : { applied }),
    ...(warning ? { warning } : {}),
  };
}

export async function applyEmulation(
  spec: EmulationSpec | { preset: 'off' },
  io: {
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    readViewport?: () => Promise<ViewportReading | undefined>;
  },
): Promise<Record<string, unknown>> {
  const read = async () => {
    try {
      return await io.readViewport?.();
    } catch {
      return undefined;
    }
  };
  if (spec.preset === 'off') {
    await io.send('Emulation.clearDeviceMetricsOverride', {});
    await io.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await io.send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => undefined);
    return describeEmulation(spec, await read());
  }
  const sendSpec = () => sendDevice(spec, io.send);
  try {
    await sendSpec();
  } catch (error) {
    const effective = await read();
    const message = error instanceof Error ? error.message : String(error);
    const described = describeEmulation(spec, effective);
    return {
      ...described,
      applied: false,
      warning: `${message}. ${described.warning ?? VIEWPORT_MISMATCH_WARNING}`,
    };
  }
  let effective = await read();
  if (effective && !viewportMatches(spec, effective)) {
    try {
      await sendSpec();
    } catch {
      // The first override was accepted and then cleared. Report the readback.
    }
    effective = await read();
  }
  return describeEmulation(spec, effective);
}

async function sendDevice(
  spec: EmulationSpec,
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  await send('Emulation.setDeviceMetricsOverride', deviceMetricsOverride(spec));
  await send('Emulation.setTouchEmulationEnabled', {
    enabled: spec.mobile,
    maxTouchPoints: spec.mobile ? 5 : 1,
  });
  if (spec.userAgent) await send('Emulation.setUserAgentOverride', { userAgent: spec.userAgent });
}

function readingFields(effective?: ViewportReading): Record<string, unknown> {
  if (!effective || !Number.isFinite(effective.cssWidth) || !Number.isFinite(effective.cssHeight)) return {};
  return {
    cssWidth: effective.cssWidth,
    cssHeight: effective.cssHeight,
    devicePixelRatio: effective.devicePixelRatio,
  };
}

function formatScale(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function parseSizeToken(value: string): { width: number; height: number; deviceScaleFactor?: number } | null {
  const match = SIZE_TOKEN.exec(value.trim());
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    deviceScaleFactor: match[3] != null ? Number(match[3]) : undefined,
  };
}

function stringish(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Resize again when the content box is off by more than this many CSS pixels. */
export const FIT_TOLERANCE_PX = 2;

export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen';

export type WindowBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  state: WindowState;
};

/**
 * Page geometry measured before Emulation.setDeviceMetricsOverride.
 * outer/inner are CSS pixels. windowWidth/windowHeight are whatever
 * chrome.windows.get returns (DIPs, or physical pixels on some Windows builds).
 * infobarHeight is extra CSS px of browser UI that is NOT already inside
 * outerHeight-innerHeight, such as the debugger infobar measured separately.
 */
export type FitMeasure = {
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  windowWidth: number;
  windowHeight: number;
  infobarHeight?: number;
};

export type FitController = {
  getWindow: () => Promise<WindowBox>;
  setWindow: (update: Partial<WindowBox>) => Promise<void>;
  measure: () => Promise<FitMeasure>;
};

/** Browser chrome around the page, in CSS pixels. */
export function frameCss(measure: Pick<FitMeasure, 'outerWidth' | 'outerHeight' | 'innerWidth' | 'innerHeight' | 'infobarHeight'>): { width: number; height: number } {
  return {
    width: measure.outerWidth - measure.innerWidth,
    height: measure.outerHeight - measure.innerHeight + (measure.infobarHeight ?? 0),
  };
}

/**
 * CSS pixels → chrome.windows.update pixels.
 * At 125% Windows scaling, devicePixelRatio is 1.25 but chrome.windows width
 * usually still equals window.outerWidth (one DIP is one CSS pixel). Scale stays 1.
 * If the reported window width instead matches outerWidth * devicePixelRatio,
 * the API is speaking physical pixels and the scale is the native devicePixelRatio.
 */
export function windowUnitScale(measure: Pick<FitMeasure, 'outerWidth' | 'windowWidth' | 'devicePixelRatio'>): number {
  if (!(measure.outerWidth > 0) || !(measure.windowWidth > 0)) return 1;
  const ratio = measure.windowWidth / measure.outerWidth;
  if (Math.abs(ratio - 1) <= 0.02) return 1;
  if (measure.devicePixelRatio > 0 && Math.abs(ratio - measure.devicePixelRatio) / measure.devicePixelRatio <= 0.05) {
    return measure.devicePixelRatio;
  }
  return ratio;
}

export function fitWindowSize(
  measure: FitMeasure,
  target: { width: number; height: number },
): { width: number; height: number; scale: number } {
  const frame = frameCss(measure);
  const scale = windowUnitScale(measure);
  return {
    width: Math.max(1, Math.round((target.width + frame.width) * scale)),
    height: Math.max(1, Math.round((target.height + frame.height) * scale)),
    scale,
  };
}

/** Real content box implied by a window size and the pre-override frame. */
export function contentFromWindow(box: { width: number; height: number }, measure: FitMeasure): { width: number; height: number } {
  const frame = frameCss(measure);
  const scale = windowUnitScale(measure);
  return {
    width: Math.round(box.width / scale - frame.width),
    height: Math.round(box.height / scale - frame.height),
  };
}

/** One correction, or null when the content box is already within FIT_TOLERANCE_PX. */
export function planFitCorrection(
  box: { width: number; height: number },
  content: { width: number; height: number },
  target: { width: number; height: number },
  scale: number,
): { width: number; height: number } | null {
  const dw = target.width - content.width;
  const dh = target.height - content.height;
  if (Math.abs(dw) <= FIT_TOLERANCE_PX && Math.abs(dh) <= FIT_TOLERANCE_PX) return null;
  return {
    width: Math.round(box.width + dw * scale),
    height: Math.round(box.height + dh * scale),
  };
}

export function restoreWindowUpdate(saved: WindowBox): Partial<WindowBox> {
  if (saved.state === 'maximized' || saved.state === 'fullscreen' || saved.state === 'locked-fullscreen') {
    return { state: saved.state };
  }
  return {
    state: 'normal',
    left: saved.left,
    top: saved.top,
    width: saved.width,
    height: saved.height,
  };
}

export async function runFittedEmulation(
  io: FitController,
  saved: WindowBox | null,
  target: { width: number; height: number },
  apply: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const initial = await io.getWindow();
  const restoreWindow = saved ?? initial;
  if (initial.state !== 'normal') await io.setWindow({ state: 'normal' });
  const measurement = await io.measure();
  const applied = await apply();
  if (applied.applied === false) {
    if (!saved && initial.state !== 'normal') await io.setWindow(restoreWindowUpdate(initial));
    const warning = [applied.warning, 'Window was not resized because the emulated viewport did not apply.']
      .filter((part) => typeof part === 'string' && part)
      .join(' ');
    return { ...applied, fitWindow: false, windowBefore: initial, warning };
  }
  const sized = fitWindowSize(measurement, target);
  await io.setWindow({ state: 'normal', width: sized.width, height: sized.height });
  let current = await io.getWindow();
  let content = contentFromWindow(current, measurement);
  const fix = planFitCorrection(current, content, target, sized.scale);
  const corrected = fix != null;
  if (fix) {
    await io.setWindow({ width: fix.width, height: fix.height });
    current = await io.getWindow();
    content = contentFromWindow(current, measurement);
  }
  return {
    ...applied,
    fitWindow: true,
    corrected,
    infobarHeight: measurement.infobarHeight ?? 0,
    windowBefore: initial,
    windowAfter: current,
    restoreWindow,
    content,
  };
}

export async function restoreFittedWindow(io: FitController, saved: WindowBox): Promise<void> {
  await io.setWindow(restoreWindowUpdate(saved));
}

function asInt(value: unknown, name: string): number {
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

export function wantsFitWindow(input: Record<string, unknown> | undefined): boolean {
  if (!input) return false;
  return input.fitWindow === true || input.fitWindow === 'true';
}

function withFit(params: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
  if (wantsFitWindow(input)) params.fitWindow = true;
  return params;
}
