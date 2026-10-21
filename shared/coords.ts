/**
 * CDP Input.dispatchMouseEvent and Input.dispatchKeyEvent take CSS pixels,
 * the same space as getBoundingClientRect. Device pixel ratio scales the
 * screenshot bitmap, not the input coordinates. Multiplying a click by
 * devicePixelRatio misses on retina displays and on zoomed pages.
 */
export function viewportCssPoint(
  x: number,
  y: number,
  devicePixelRatio: number,
): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('click point is not a finite coordinate');
  }
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error('invalid devicePixelRatio');
  }
  return { x, y };
}

export function cssToScreenshotPixel(css: number, devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error('invalid devicePixelRatio');
  }
  return css * devicePixelRatio;
}
