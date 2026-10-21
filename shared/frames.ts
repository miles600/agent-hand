export type FrameRect = {
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * Pick the iframe element in a parent frame that corresponds to a child frame.
 * Same-origin frames do not need this; they measure through frameElement.
 * Cross-origin frames are matched by URL, then by "only one iframe" as a fallback.
 */
export function matchFrameRect(rects: FrameRect[], frameUrl: string, used: Set<number>): number {
  const matches: number[] = [];
  for (let index = 0; index < rects.length; index += 1) {
    if (used.has(index)) continue;
    if (sameUrl(rects[index].src, frameUrl)) matches.push(index);
  }
  if (matches.length >= 1) return matches[0];
  if (rects.length === 1 && !used.has(0)) return 0;
  return -1;
}
