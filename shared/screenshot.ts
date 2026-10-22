export type ScreenshotClip = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
};

/**
 * CDP Page.captureScreenshot of the emulated viewport.
 * scale 1 lets an active deviceScaleFactor size the bitmap.
 * A later call can pass scale = devicePixelRatio when the first image is only CSS pixels.
 */
export function viewportScreenshotParams(
  metrics: { cssWidth: number; cssHeight: number },
  scale = 1,
): { format: 'png'; fromSurface: true; captureBeyondViewport: false; clip?: ScreenshotClip } {
  if (!(metrics.cssWidth >= 2) || !(metrics.cssHeight >= 2)) {
    return { format: 'png', fromSurface: true, captureBeyondViewport: false };
  }
  return {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {
      x: 0,
      y: 0,
      width: metrics.cssWidth,
      height: metrics.cssHeight,
      scale,
    },
  };
}

/**
 * When the first capture is the CSS size instead of CSS times devicePixelRatio, capture once more.
 * A bitmap that already matches css*dpr, or that matches neither, is not retried.
 */
export function nextScreenshotScale(
  image: { width: number; height: number },
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): { retry: boolean; scale: number } {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (near(image.width, cssWidth * dpr) && near(image.height, cssHeight * dpr)) {
    return { retry: false, scale: 1 };
  }
  if (dpr !== 1 && near(image.width, cssWidth) && near(image.height, cssHeight)) {
    return { retry: true, scale: dpr };
  }
  return { retry: false, scale: 1 };
}

/**
 * The number a caller should multiply CSS boxes by to land on this image.
 * When both axes agree, that ratio wins over a reported devicePixelRatio that describes the page but not the file.
 */
export function screenshotScaleReport(
  image: { width: number; height: number },
  cssWidth: number,
  cssHeight: number,
  reported: number,
): { devicePixelRatio: number; warning?: string } {
  if (!(cssWidth > 0) || !(cssHeight > 0)) return { devicePixelRatio: reported };
  const sx = image.width / cssWidth;
  const sy = image.height / cssHeight;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return { devicePixelRatio: reported };
  const dpr = reported > 0 ? reported : 1;
  if (near(image.width, cssWidth * dpr) && near(image.height, cssHeight * dpr)) {
    return { devicePixelRatio: reported };
  }
  const relative = Math.abs(sx - sy) / Math.max(sx, sy);
  const scale = Math.round(sx * 1000) / 1000;
  if (relative <= 0.02) return { devicePixelRatio: scale };
  return {
    devicePixelRatio: scale,
    warning: `Screenshot is ${image.width}x${image.height} px, not ${Math.round(cssWidth * dpr)}x${Math.round(cssHeight * dpr)} (${cssWidth}x${cssHeight} at ${reported}). The reported scale matches the image width only.`,
  };
}

export function pngDimensionsFromBase64(value: string): { width: number; height: number } | null {
  const cleaned = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch {
    return null;
  }
  if (binary.length < 24) return null;
  const bytes = new Uint8Array(24);
  for (let index = 0; index < 24; index += 1) bytes[index] = binary.charCodeAt(index);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return null;
  }
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  return { width: u32(bytes, 16), height: u32(bytes, 20) };
}

function near(actual: number, expected: number): boolean {
  const delta = Math.abs(actual - expected);
  if (delta === 0) return true;
  if (expected >= 8 && delta <= 2) return true;
  return expected > 0 && delta <= 2 && delta / expected <= 0.02;
}

function u32(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
}
