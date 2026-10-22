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
        tabId: {
          anyOf: [{ type: 'integer' }, { type: 'string' }],
          description: 'Tab id from list_tabs. Chrome tabs are numbers. CDP targets are strings.',
        },
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
      'List visible interactive elements. The first line is the effective viewport in CSS pixels, for example "viewport 390x844 dpr 3". Use that line to verify emulate. Each later line starts with a numeric ref. Refs stay valid until the next snapshot. Boxes are CSS pixels: x,y widthxheight. "checked" or "unchecked" is the state of a checkbox, radio, or switch. "frame" marks an element inside an iframe. A uni-app date picker is listed as the clickable wrapper, not as a disabled textbox. Image and card tiles are named from alt text, aria-label, inner text, or a nearby label.',
    inputSchema: empty,
  },
  {
    name: 'click',
    description:
      'Scroll the ref into view, glide the on-screen agent cursor to its center, then send a trusted left click through the Chrome debugger. If DevTools is open (docked or undocked) the click is synthetic and the result includes a warning: isTrusted is false. Pass requireTrusted:true, or set AGENT_HAND_REQUIRE_TRUSTED / --require-trusted, to fail instead of falling back. Close DevTools and use emulate for a trusted phone click.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'Ref from the latest snapshot.' },
        requireTrusted: { type: 'boolean', description: 'Fail if the click cannot be trusted. DevTools must be closed.' },
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
        requireTrusted: { type: 'boolean', description: 'Fail if the click or typing cannot be trusted. DevTools must be closed.' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press',
    description: 'Send a trusted key chord, for example Enter, Tab, Escape, ArrowDown, Ctrl+A, or Shift+Tab. Falls back to a synthetic key when DevTools is open unless requireTrusted is set.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        requireTrusted: { type: 'boolean' },
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
        requireTrusted: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description:
      'Capture a PNG of the page. When the debugger is attached the image is the emulated viewport (cssWidth times devicePixelRatio by cssHeight times devicePixelRatio), not the white margin around it. Otherwise it is the visible tab, and devicePixelRatio is the scale of that image. The agent cursor is part of the page, so it appears in the image.',
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
  {
    name: 'click_xy',
    description:
      'Glide the cursor to a viewport point (CSS px, the same space as snapshot boxes) and click. If trusted input is not delivered, falls back to DOM events at that point.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        duration: { type: 'integer' },
        requireTrusted: { type: 'boolean', description: 'Fail if the click cannot be trusted. DevTools must be closed.' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'locate',
    description: 'Find visible elements by their text and return center points in CSS px, for use with click_xy.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'emulate',
    description:
      'Phone viewport via chrome.debugger Emulation (mobile + touch), same idea as DevTools device mode. preset: iphone (390x844 @3), pixel (412x915 @2.625), or off. Or size "390x844" or "390x844@3" (CSS px, optional device pixel ratio; default 2). Custom sizes turn on mobile and touch. The result includes cssWidth, cssHeight, devicePixelRatio read back from the page, and applied:true when they match. snapshot\'s first line repeats the effective viewport. Close DevTools first: the extension cannot toggle the device toolbar, and opening DevTools clears this override. With DevTools closed the size sticks and clicks stay trusted. With DevTools open, emulate does not stick and clicks are synthetic. fitWindow:true resizes the real Chrome window (and every other tab in it) so the content area matches the emulated CSS size. It accounts for display scaling and the debugger infobar, then emulate off restores the previous bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', description: 'iphone, pixel, off, or a size such as 390x844 or 390x844@3.' },
        size: { type: 'string', description: 'Exact CSS size, for example 390x844 or 390x844@3.' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        deviceScaleFactor: { type: 'number', description: 'Device pixel ratio. Default 2. Use 3 for 390x844@3.' },
        mobile: { type: 'boolean', description: 'Default true. Turns on touch emulation and a mobile user agent.' },
        fitWindow: { type: 'boolean', description: 'Resize the real Chrome window so its content matches the emulated CSS size. Also restores that window on preset off. Default false: the window is not moved.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'console',
    description: 'Return console messages and uncaught exceptions captured for the target since attach or page load. Pass clear:true to drop the buffer.',
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean' },
        max: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'network_errors',
    description: 'Return failed network requests and HTTP status >= 400 captured for the target. Capture starts when the debugger attaches. Pass clear:true to drop the buffer.',
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean' },
        max: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'attach_cdp',
    description:
      'Attach the bridge directly to a loopback Chrome DevTools port (Electron or Chromium). Does not close the app or navigate. Later commands target that app until detach_cdp.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http://127.0.0.1:<port>' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'detach_cdp',
    description: 'Close the direct DevTools connection. The attached app keeps running. Later commands go back to the Chrome extension.',
    inputSchema: empty,
  },
  {
    name: 'reload_extension',
    description: 'Reload the unpacked Agent Hand extension (chrome.runtime.reload) so a rebuilt background script is picked up. Chrome itself stays open.',
    inputSchema: empty,
  },
];
