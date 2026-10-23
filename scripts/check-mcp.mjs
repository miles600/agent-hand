import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/bridge/config.js';
import { pngSize } from '../dist/bridge/screenshot.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run check:mcp -- [--tab <tabId>] [--vision]\nWithout --tab: test protocol and tool discovery only.\n--tab: also inspect that tab and verify native PNG image content.\n--vision: navigate the specified test tab to the visual challenge and leave it there.');
  process.exit(0);
}
let tabId;
let vision = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--vision') vision = true;
  else if (args[index] === '--tab' && args[index + 1]) tabId = args[++index];
  else throw new Error(`unknown or incomplete argument: ${args[index]}`);
}
if (vision && !tabId) throw new Error('--vision requires --tab: choose a disposable test tab');

const proc = spawn(process.execPath, [fileURLToPath(new URL('../dist/bridge/index.js', import.meta.url)), 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => proc.once('exit', resolve));
// stderr can contain a first-run auth token; never copy it into the report.
proc.stderr.resume();
proc.stdin.on('error', error => failPending(error));
proc.on('error', error => failPending(error));
proc.on('exit', () => failPending(new Error('MCP process exited before replying')));
let buffer = Buffer.alloc(0);
let nextId = 0;
const pending = new Map();
proc.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.includes(10)) {
    const end = buffer.indexOf(10);
    const line = buffer.subarray(0, end).toString('utf8').trim();
    buffer = buffer.subarray(end + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    } catch (error) {
      failPending(new Error(`Invalid MCP stdout: ${error.message}`));
    }
  }
});

function failPending(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}

function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}`));
    }, 60000);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function tool(name, arguments_ = {}) {
  const result = await request('tools/call', { name, arguments: arguments_ });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text ?? `${name} failed`);
  return result;
}

const report = {
  testedAt: new Date().toISOString(),
  checks: { initialize: 'not-run', toolDiscovery: 'not-run', observation: 'not-run', pngImage: 'not-run', modelVision: 'not-tested' },
  note: 'This probes Agent Hand MCP, not another client’s model. A native-image visual challenge inside each client is still required.',
};
try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-hand-check', version: '1' },
  });
  assert.equal(init.serverInfo?.name, 'agent-hand');
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal(typeof init.instructions, 'string');
  report.server = { ...init.serverInfo, protocolVersion: init.protocolVersion };
  report.checks.initialize = 'pass';
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await request('tools/list');
  const names = listed.tools.map(item => item.name);
  for (const name of ['list_tabs', 'select_tab', 'observe', 'screenshot', 'fill', 'click', 'wait_for_text']) assert.ok(names.includes(name), `Missing tool: ${name}`);
  report.toolCount = names.length;
  report.checks.toolDiscovery = 'pass';
  if (tabId) {
    if (vision) {
      const config = await loadConfig();
      await tool('select_tab', { tabId });
      await tool('navigate', { url: `http://127.0.0.1:${config.port}/demo/vision.html` });
    }
    const observed = await tool('observe', { tabId, includeScreenshot: true });
    const metadata = JSON.parse(observed.content.find(item => item.type === 'text').text);
    assert.equal(String(metadata.snapshot.tabId), tabId);
    assert.equal(typeof metadata.snapshot.text, 'string');
    report.checks.observation = 'pass';
    const image = observed.content.find(item => item.type === 'image');
    assert.ok(image, 'No MCP image content. Check AGENT_HAND_MCP_IMAGES and client image support.');
    assert.equal(image.mimeType, 'image/png');
    const bytes = Buffer.from(image.data, 'base64');
    const size = pngSize(bytes);
    assert.ok(size.width > 0 && size.height > 0);
    assert.equal(size.width, metadata.screenshot.width);
    assert.equal(size.height, metadata.screenshot.height);
    report.image = { ...size, bytes: bytes.length, path: metadata.screenshot.path };
    report.checks.pngImage = 'pass';
    if (vision) report.next = 'In the client being tested: observe this test tab with includeScreenshot:true, read the canvas code from the MCP image, fill it, click Verify code, and verify PASS: visual code matched. Do not read the PNG file or page source. Record client/version/model and image delivery mode.';
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(timer);
}
console.log(JSON.stringify(report, null, 2));
