import { BridgeClient, type Hand } from './client.js';
import { loadConfig, type Config } from './config.js';
import { serveMcp } from './mcp.js';
import { startBridge } from './server.js';
import { TRUSTED_INPUT_METHODS } from '../shared/input.js';
import { VERSION } from '../shared/protocol.js';
import { normalizeCall } from '../shared/validate.js';

export type CliAction =
  | { kind: 'help' | 'version' | 'token'; port?: number; cdp?: string; requireTrusted?: boolean }
  | { kind: 'serve' | 'mcp' | 'status'; port?: number; cdp?: string; requireTrusted?: boolean }
  | { kind: 'call'; method: string; params: Record<string, unknown>; port?: number; cdp?: string; requireTrusted?: boolean };

export function resolveCli(argv: string[]): CliAction {
  const { port, cdp, requireTrusted, rest } = takeFlags(argv);
  const trusted = requireTrusted ? { requireTrusted: true as const } : {};
  const [command, ...args] = rest;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { kind: 'help', port, cdp, ...trusted };
  }
  if (command === 'version' || command === '--version') return { kind: 'version', port, cdp, ...trusted };
  if (command === 'token') return { kind: 'token', port, cdp, ...trusted };
  if (command === 'serve') return { kind: 'serve', port, cdp, ...trusted };
  if (command === 'mcp') return { kind: 'mcp', port, cdp, ...trusted };
  if (command === 'status') return { kind: 'status', port, cdp, ...trusted };
  const call = commandCall(command, args);
  if (call.method === 'attach_cdp' && !call.params.url && cdp) call.params.url = cdp;
  const normalized = normalizeCall(call.method, requireTrusted ? { ...call.params, requireTrusted: true } : call.params);
  return { kind: 'call', method: normalized.method, params: normalized.params, port, cdp, ...trusted };
}

export async function main(argv: string[]): Promise<void> {
  const action = resolveCli(argv);
  if (action.kind === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (action.kind === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const config = await loadConfig({ port: action.port });
  const requireTrusted = action.requireTrusted === true || config.requireTrusted;
  if (action.kind === 'token') {
    process.stdout.write(`${config.token}\n`);
    return;
  }
  if (action.kind === 'serve') {
    await runServe(config, action.cdp, requireTrusted);
    return;
  }
  if (action.kind === 'mcp') {
    await runMcp(config, requireTrusted);
    return;
  }
  if (action.kind === 'status') {
    await runStatus(config.port);
    return;
  }
  if (action.kind !== 'call') throw new Error(`unhandled command: ${action.kind}`);
  const client = await BridgeClient.connect(config.port, config.token);
  try {
    if (action.cdp && action.method !== 'attach_cdp') {
      await client.call('attach_cdp', { url: action.cdp }, 20000);
    }
    const params = { ...action.params };
    if (requireTrusted && TRUSTED_INPUT_METHODS.has(action.method)) params.requireTrusted = true;
    const result = await client.call(action.method, params, clientTimeout(action.method, action.params));
    if (result && typeof result === 'object' && 'warning' in result && typeof (result as { warning?: unknown }).warning === 'string') {
      console.error((result as { warning: string }).warning);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    client.close();
  }
}

async function runServe(config: Config, cdp: string | undefined, requireTrusted: boolean): Promise<void> {
  const server = await startBridge({ port: config.port, token: config.token, requireTrusted });
  console.error(`agent-hand bridge listening on ws://127.0.0.1:${server.port}`);
  console.error(`demo page: http://127.0.0.1:${server.port}/demo`);
  if (cdp) {
    try {
      const status = await server.call('attach_cdp', { url: cdp });
      console.error(`attached over CDP at ${cdp}`);
      console.error(JSON.stringify(status));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`CDP attach failed (${cdp}): ${message}`);
      console.error('The bridge is still serving the extension. Retry with: agent-hand attach <url>');
    }
  }
  if (config.created) {
    console.error('');
    console.error('First run. Paste this token into the extension options page:');
    console.error(config.token);
  } else {
    console.error(`token file: ${config.path}`);
    console.error('Show the token with: agent-hand token');
  }
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void server.close().finally(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

async function runMcp(config: Config, requireTrusted: boolean): Promise<void> {
  const session = await hostOrConnect(config, requireTrusted);
  if (session.hosted) {
    console.error(`agent-hand bridge listening on ws://127.0.0.1:${session.port}`);
    console.error(`demo page: http://127.0.0.1:${session.port}/demo`);
    if (config.created) {
      console.error('First run. Paste this token into the extension options page:');
      console.error(config.token);
    }
  } else {
    console.error(`using the agent-hand bridge at 127.0.0.1:${session.port}`);
  }
  try {
    await serveMcp(session.hand, { requireTrusted });
  } finally {
    await session.close();
  }
}

async function hostOrConnect(config: Config, requireTrusted: boolean): Promise<{ hand: Hand; close: () => Promise<void>; hosted: boolean; port: number }> {
  try {
    const server = await startBridge({ port: config.port, token: config.token, requireTrusted });
    return { hand: server, close: () => server.close(), hosted: true, port: server.port };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw error;
    try {
      const client = await BridgeClient.connect(config.port, config.token);
      return {
        hand: client,
        close: async () => {
          client.close();
        },
        hosted: false,
        port: config.port,
      };
    } catch (connectError) {
      const message = connectError instanceof Error ? connectError.message : String(connectError);
      throw new Error(`port ${config.port} is already in use (${message}). Pass --port to choose another.`);
    }
  }
}

async function runStatus(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok) throw new Error(`health check failed: ${response.status}`);
  const body = (await response.json()) as unknown;
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

function commandCall(command: string, args: string[]): { method: string; params: Record<string, unknown> } {
  switch (command) {
    case 'list-tabs':
      return { method: 'list_tabs', params: {} };
    case 'select-tab':
      return { method: 'select_tab', params: { tabId: requiredArg(args, 0, 'tab id') } };
    case 'navigate':
      return { method: 'navigate', params: { url: requiredArg(args, 0, 'url') } };
    case 'snapshot':
      return { method: 'snapshot', params: {} };
    case 'click':
      return { method: 'click', params: { ref: requiredArg(args, 0, 'ref') } };
    case 'type': {
      const submit = args.includes('--submit');
      const rest = args.filter((arg) => arg !== '--submit');
      const ref = requiredArg(rest, 0, 'ref');
      const text = rest.slice(1).join(' ');
      if (!text) throw new Error('type needs the text to insert');
      return { method: 'type', params: { ref, text, submit } };
    }
    case 'press': {
      const key = args.join('+');
      if (!key) throw new Error('press needs a key, for example Enter or Ctrl+A');
      return { method: 'press', params: { key } };
    }
    case 'scroll': {
      const target = requiredArg(args, 0, 'direction or ref');
      if (/^\d+$/.test(target)) return { method: 'scroll', params: { ref: Number(target) } };
      const params: Record<string, unknown> = { direction: target };
      if (args[1] != null) params.amount = args[1];
      return { method: 'scroll', params };
    }
    case 'screenshot': {
      const index = args.indexOf('--out');
      const params: Record<string, unknown> = {};
      if (index >= 0) {
        const out = args[index + 1];
        if (!out) throw new Error('screenshot --out needs a path');
        params.out = out;
      }
      return { method: 'screenshot', params };
    }
    case 'text': {
      const index = args.indexOf('--max');
      const params: Record<string, unknown> = {};
      if (index >= 0) {
        const max = args[index + 1];
        if (!max) throw new Error('text --max needs a number');
        params.max = max;
      }
      return { method: 'get_text', params };
    }
    case 'wait':
      return { method: 'wait', params: { ms: requiredArg(args, 0, 'milliseconds') } };
    case 'click-xy':
      return { method: 'click_xy', params: { x: requiredArg(args, 0, 'x'), y: requiredArg(args, 1, 'y') } };
    case 'locate': {
      const text = args.join(' ').trim();
      if (!text) throw new Error('locate needs the text to find');
      return { method: 'locate', params: { text } };
    }
    case 'emulate': {
      const name = (args[0] ?? '').trim();
      const lower = name.toLowerCase();
      if (!name) throw new Error('emulate needs iphone, pixel, off, or a size like 390x844 or 390x844@3');
      if (lower === 'off' || lower === 'iphone' || lower === 'pixel') return { method: 'emulate', params: { preset: lower } };
      if (/^\d+x\d+(?:@[\d.]+)?$/i.test(name)) return { method: 'emulate', params: { size: name } };
      const params: Record<string, unknown> = { width: args[0], height: requiredArg(args, 1, 'height') };
      if (args[2] != null) params.deviceScaleFactor = args[2];
      return { method: 'emulate', params };
    }
    case 'console':
      return { method: 'console', params: logArgs(args) };
    case 'network-errors':
      return { method: 'network_errors', params: logArgs(args) };
    case 'attach':
      return { method: 'attach_cdp', params: args[0] ? { url: args[0] } : {} };
    case 'detach':
      return { method: 'detach_cdp', params: {} };
    case 'reload-extension':
      return { method: 'reload_extension', params: {} };
    default:
      throw new Error(`unknown command: ${command}\n\n${HELP}`);
  }
}

function logArgs(args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (args.includes('--clear')) params.clear = true;
  const index = args.indexOf('--max');
  if (index >= 0) {
    const max = args[index + 1];
    if (!max) throw new Error('--max needs a number');
    params.max = max;
  }
  return params;
}

function requiredArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (value == null || value === '') throw new Error(`missing ${name}`);
  return value;
}

function takeFlags(argv: string[]): { port?: number; cdp?: string; requireTrusted: boolean; rest: string[] } {
  const rest: string[] = [];
  let port: number | undefined;
  let cdp: string | undefined;
  let requireTrusted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      const value = argv[index + 1];
      if (!value) throw new Error('--port needs a number');
      port = Number(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
      continue;
    }
    if (arg === '--cdp') {
      const value = argv[index + 1];
      if (!value) throw new Error('--cdp needs an http://127.0.0.1:<port> url');
      cdp = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--cdp=')) {
      cdp = arg.slice('--cdp='.length);
      continue;
    }
    if (arg === '--require-trusted') {
      requireTrusted = true;
      continue;
    }
    rest.push(arg);
  }
  if (port != null && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`invalid port: ${port}`);
  }
  return { port, cdp, requireTrusted, rest };
}

function clientTimeout(method: string, params: Record<string, unknown>): number {
  if (method === 'wait') return Number(params.ms) + 15000;
  if (method === 'navigate') return 45000;
  return 30000;
}

const HELP = `agent-hand — drive Chrome, mobile H5, or Electron with a visible cursor

Usage:
  agent-hand serve [--port 17321] [--cdp http://127.0.0.1:9222]
  agent-hand mcp [--port 17321]
  agent-hand token
  agent-hand status
  agent-hand attach <http://127.0.0.1:port>   direct CDP (Electron / Chromium)
  agent-hand detach                           close the CDP socket; the app stays open
  agent-hand list-tabs
  agent-hand select-tab <tabId>
  agent-hand navigate <url>
  agent-hand snapshot
  agent-hand click <ref>
  agent-hand click-xy <x> <y>                 CSS px, same space as snapshot boxes
  agent-hand locate <text>
  agent-hand type <ref> <text> [--submit]
  agent-hand press <key>
  agent-hand scroll <up|down|left|right|ref> [amount]
  agent-hand emulate <iphone|pixel|off|390x844|390x844@3|width height [dpr]>
  agent-hand screenshot [--out <path>]
  agent-hand text [--max <n>]
  agent-hand console [--clear] [--max <n>]
  agent-hand network-errors [--clear] [--max <n>]
  agent-hand reload-extension
  agent-hand wait <ms>

--require-trusted    fail click, type, press, scroll, and click-xy instead of
                     sending a synthetic event. Also set by
                     AGENT_HAND_REQUIRE_TRUSTED=1 or "requireTrusted": true
                     in the config file. Default is the synthetic fallback.

The bridge listens on 127.0.0.1 only. On first run it writes a token to
~/.agent-hand/config.json. Paste that token into the extension options page.
--cdp attaches to an app that was started with --remote-debugging-port.
It does not close that app and does not navigate unless you ask.
emulate 390x844@3 sets a 390 by 844 CSS viewport at device pixel ratio 3,
with mobile and touch, and keeps it while DevTools is closed.
`;
