/** H5 pages (uni-app custom elements, cursor:pointer rows) list more controls than a typical form. */
export const MAX_SNAPSHOT_ITEMS = 300;

export type RawElement = {
  ahId: string;
  frameId: number;
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  disabled: boolean;
  /** Set for checkbox, radio, and switch. "mixed" is aria-checked="mixed". */
  checked?: boolean | 'mixed';
};

export type SnapshotItem = RawElement & { ref: number };

export type ViewportMeta = {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
};

export function buildSnapshot(
  raw: RawElement[],
  meta: ViewportMeta,
): { text: string; items: SnapshotItem[] } {
  const visible = raw.filter((element) =>
    element.width > 0 && element.height > 0
    && element.x < meta.cssWidth && element.y < meta.cssHeight
    && element.x + element.width > 0 && element.y + element.height > 0);
  const sorted = visible.sort((a, b) => a.y - b.y || a.x - b.x || a.ahId.localeCompare(b.ahId));
  const items = sorted.slice(0, MAX_SNAPSHOT_ITEMS).map((element, index) => ({
    ref: index + 1,
    ahId: element.ahId,
    frameId: element.frameId,
    role: element.role,
    name: cleanName(element.name),
    x: Math.round(element.x),
    y: Math.round(element.y),
    width: Math.round(element.width),
    height: Math.round(element.height),
    disabled: element.disabled,
    ...(element.checked == null ? {} : { checked: element.checked }),
  }));
  const dpr = Number.isFinite(meta.devicePixelRatio) ? meta.devicePixelRatio : 1;
  const lines = [
    `viewport ${Math.round(meta.cssWidth)}x${Math.round(meta.cssHeight)} dpr ${formatDpr(dpr)}`,
    ...items.map(formatItem),
  ];
  if (sorted.length > items.length) {
    lines.push(`… ${sorted.length - items.length} more`);
  }
  return { text: lines.join('\n'), items };
}

function formatItem(item: SnapshotItem): string {
  const box = `${item.x},${item.y} ${item.width}x${item.height}`;
  const toggle = item.checked === true
    ? 'checked'
    : item.checked === false
      ? 'unchecked'
      : item.checked === 'mixed'
        ? 'mixed'
        : '';
  const flags = [
    toggle,
    item.disabled ? 'disabled' : '',
    item.frameId !== 0 ? 'frame' : '',
  ].filter(Boolean);
  const suffix = flags.length ? ` ${flags.join(' ')}` : '';
  return `[${item.ref}] ${item.role} "${item.name}" (${box})${suffix}`;
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().replaceAll('"', "'").slice(0, 80);
}

function formatDpr(dpr: number): string {
  const rounded = Math.round(dpr * 100) / 100;
  return String(rounded);
}
