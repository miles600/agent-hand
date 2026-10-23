export type PointerKind = 'hover' | 'click' | 'double' | 'right';

export type MouseDispatch = {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased';
  x: number;
  y: number;
  button: 'none' | 'left' | 'right';
  buttons?: number;
  clickCount?: number;
  pointerType: 'mouse';
};

export function pointerLabel(kind: PointerKind): string {
  if (kind === 'hover') return 'Hover';
  if (kind === 'double') return 'Double click';
  if (kind === 'right') return 'Right click';
  return 'Click';
}

/** CDP mouse sequence. Click matches the historical left press/release with clickCount 1. */
export function pointerEvents(x: number, y: number, kind: PointerKind): MouseDispatch[] {
  const px = Math.round(x * 100) / 100;
  const py = Math.round(y * 100) / 100;
  const moved: MouseDispatch = { type: 'mouseMoved', x: px, y: py, button: 'none', pointerType: 'mouse' };
  if (kind === 'hover') return [moved];
  const button = kind === 'right' ? 'right' : 'left';
  const down = kind === 'right' ? 2 : 1;
  const rounds = kind === 'double' ? 2 : 1;
  const events: MouseDispatch[] = [moved];
  for (let count = 1; count <= rounds; count += 1) {
    events.push({
      type: 'mousePressed',
      x: px,
      y: py,
      button,
      buttons: down,
      clickCount: count,
      pointerType: 'mouse',
    });
    events.push({
      type: 'mouseReleased',
      x: px,
      y: py,
      button,
      buttons: 0,
      clickCount: count,
      pointerType: 'mouse',
    });
  }
  return events;
}

export async function dispatchPointer(
  x: number,
  y: number,
  kind: PointerKind,
  send: (event: MouseDispatch) => Promise<void>,
  pause: (ms: number) => Promise<void>,
): Promise<void> {
  const events = pointerEvents(x, y, kind);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    await send(event);
    if (event.type === 'mousePressed') await pause(30);
    else if (event.type === 'mouseReleased' && events[index + 1]?.type === 'mousePressed') await pause(40);
  }
}
