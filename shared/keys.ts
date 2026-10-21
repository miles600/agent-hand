export type KeyDispatch = {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  modifiers: number;
};

const NAMED: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

const PUNCT: Record<string, { code: string; keyCode: number }> = {
  '-': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ';': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 },
  ',': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 },
};

/** Alt=1, Ctrl=2, Meta=4, Shift=8. Matches the CDP Input.dispatchKeyEvent bitfield. */
export function parseKeyCombo(input: string): KeyDispatch {
  const parts = input.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('empty key');
  let modifiers = 0;
  const mods = new Set<string>();
  const keys: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') {
      modifiers |= 2;
      mods.add('ctrl');
      continue;
    }
    if (lower === 'alt' || lower === 'option') {
      modifiers |= 1;
      mods.add('alt');
      continue;
    }
    if (lower === 'meta' || lower === 'cmd' || lower === 'command') {
      modifiers |= 4;
      mods.add('meta');
      continue;
    }
    if (lower === 'shift') {
      modifiers |= 8;
      mods.add('shift');
      continue;
    }
    keys.push(part);
  }
  if (keys.length !== 1) throw new Error(`expected one key in "${input}"`);
  const raw = keys[0];
  const named = NAMED[raw.toLowerCase()];
  if (named) {
    const text = modifiers === 0 ? named.text : undefined;
    return { key: named.key, code: named.code, keyCode: named.keyCode, text, modifiers };
  }
  if (raw.length !== 1) throw new Error(`unsupported key: ${raw}`);
  const letter = /^[a-zA-Z]$/.test(raw);
  const digit = /^[0-9]$/.test(raw);
  const punct = PUNCT[raw];
  if (!letter && !digit && !punct) throw new Error(`unsupported key: ${raw}`);
  const shifted = mods.has('shift');
  const ch = letter ? (shifted ? raw.toUpperCase() : raw.toLowerCase()) : raw;
  const nonShift = modifiers & ~8;
  let code = '';
  let keyCode = 0;
  if (letter) {
    code = `Key${raw.toUpperCase()}`;
    keyCode = raw.toUpperCase().charCodeAt(0);
  } else if (digit) {
    code = `Digit${raw}`;
    keyCode = raw.charCodeAt(0);
  } else if (punct) {
    code = punct.code;
    keyCode = punct.keyCode;
  }
  return {
    key: ch,
    code,
    keyCode,
    text: nonShift ? undefined : ch,
    modifiers,
  };
}
