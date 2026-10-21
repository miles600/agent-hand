export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const empty = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export const TOOLS: Tool[] = [
  {
    name: 'list_tabs',
    description: 'List Chrome tabs. Later commands use the target tab (the last select_tab, otherwise the active tab).',
    inputSchema: empty,
  },
  {
    name: 'select_tab',
    description: 'Focus a tab and make it the target for later commands.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: 'Tab id from list_tabs.' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'navigate',
    description: 'Open an http(s) URL in the target tab and wait until it finishes loading.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http or https URL.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'snapshot',
    description:
      'List visible interactive elements. Each line starts with a numeric ref. Refs stay valid until the next snapshot. Boxes are CSS pixels: x,y widthxheight. "frame" marks an element inside an iframe. Multiply by devicePixelRatio to map a box onto a screenshot.',
    inputSchema: empty,
  },
  {
    name: 'click',
    description:
      'Scroll the ref into view, glide the on-screen agent cursor to its center, then send a trusted left click through the Chrome debugger.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'Ref from the latest snapshot.' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description:
      'Click a ref with the agent cursor, then insert text with Input.insertText. Pass submit:true to press Enter afterwards. Text is appended; the tool does not clear the field.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'integer' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press',
    description: 'Send a trusted key chord, for example Enter, Tab, Escape, ArrowDown, Ctrl+A, or Shift+Tab.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description:
      'Scroll the page with the wheel (direction up, down, left, or right) or scroll a snapshot ref into view. The agent cursor moves to where the scroll happens.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        ref: { type: 'integer' },
        amount: { type: 'integer', description: 'Wheel delta in pixels. Default 480.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description:
      'Capture the visible tab to a PNG file and return its path. Image pixels are CSS pixels times devicePixelRatio. The agent cursor is part of the page, so it appears in the image.',
    inputSchema: {
      type: 'object',
      properties: {
        out: { type: 'string', description: 'Optional output path. Default is under the agent-hand home directory.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_text',
    description: 'Return the page innerText, including same-process iframes, truncated to max characters (default 8000).',
    inputSchema: {
      type: 'object',
      properties: {
        max: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description: 'Pause the bridge for ms milliseconds, up to 60000.',
    inputSchema: {
      type: 'object',
      properties: {
        ms: { type: 'integer' },
      },
      required: ['ms'],
      additionalProperties: false,
    },
  },
];
