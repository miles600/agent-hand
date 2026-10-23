import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { startBridge } from '../bridge/server.js';

for (const reuse of [false, true]) {
  test(`mcp stdio uses newline JSON and ${reuse ? 'reuses a running bridge' : 'starts its bridge'}`, async () => {
    const server = reuse ? await startBridge({ timeline: false, port: 0, token: 'mcp-test-token-0123456789' }) : undefined;
    const home = await mkdtemp(join(tmpdir(), 'agent-hand-mcp-'));
    const proc = spawn('node', ['dist/bridge/index.js', 'mcp'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_HAND_HOME: home,
        AGENT_HAND_TOKEN: 'mcp-test-token-0123456789',
        AGENT_HAND_PORT: String(server?.port ?? 0),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const reader = new RpcReader(proc);
    try {
      proc.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }));
      const init = await reader.next();
      assert.equal(init.id, 1);
      assert.equal(init.result.serverInfo.name, 'agent-hand');
      assert.equal(init.result.protocolVersion, '2024-11-05');
      assert.match(init.result.instructions, /observe.*verify/i);

      proc.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      proc.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
      const tools = await reader.next();
      const names = tools.result.tools.map((tool: { name: string }) => tool.name);
      assert.ok(names.includes('snapshot'));
      assert.ok(names.includes('click'));
      assert.ok(names.includes('screenshot'));
      for (const name of ['hover', 'dblclick', 'right_click', 'clear', 'fill', 'select', 'wait_for_text', 'wait_for_url', 'wait_for_idle']) {
        assert.ok(names.includes(name), name);
      }

      proc.stdin.write('{invalid json}\n');
      assert.equal((await reader.next()).error?.code, -32700);
      proc.stdin.write('null\n');
      assert.equal((await reader.next()).error?.code, -32600);
      const unicode = frame({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: '不存在' } });
      const split = unicode.indexOf(Buffer.from('不')) + 1;
      proc.stdin.write(unicode.subarray(0, split));
      await new Promise((resolve) => setTimeout(resolve, 10));
      proc.stdin.write(Buffer.concat([
        unicode.subarray(split),
        frame({ jsonrpc: '2.0', id: 6, method: 'ping' }),
      ]));
      const replies = [await reader.next(), await reader.next()];
      const unknown = replies.find((reply) => reply.id === 5);
      assert.equal(unknown?.result.isError, true);
      assert.match(unknown?.result.content[0].text ?? '', /不存在/);
      assert.deepEqual(replies.find((reply) => reply.id === 6)?.result, {});

      proc.stdin.write(frame({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'wait', arguments: { ms: 15 } },
      }));
      const waited = await reader.next();
      assert.equal(waited.result.isError, false);
      assert.match(waited.result.content[0].text, /"ms": 15/);

      proc.stdin.write(frame({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'snapshot', arguments: {} },
      }));
      const missing = await reader.next();
      assert.equal(missing.result.isError, true);
      assert.match(missing.result.content[0].text, /extension not connected/);
    } finally {
      proc.stdin.end();
      await Promise.race([
        onceExit(proc),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      if (proc.exitCode == null) proc.kill('SIGKILL');
      await rm(home, { recursive: true, force: true });
      if (server) {
        assert.equal((await fetch(`http://127.0.0.1:${server.port}/health`)).ok, true);
        await server.close();
      }
    }
  });
}

for (const images of [true, false]) {
  test(`MCP screenshots and observe deliver ${images ? 'PNG image content' : 'explicit text-only fallback'}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-hand-images-'));
    const token = 'mcp-image-test-0123456789';
    const server = await startBridge({ timeline: false, port: 0, token, screenshotDir: home });
    const env = { ...process.env, AGENT_HAND_HOME: home, AGENT_HAND_TOKEN: token, AGENT_HAND_PORT: String(server.port), AGENT_HAND_MCP_IMAGES: images ? '1' : '0' };
    const proc = spawn('node', ['dist/bridge/index.js', 'mcp'], { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = new RpcReader(proc);
    const extension = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let failCapture = false;
    try {
      await new Promise<void>((resolve, reject) => { extension.once('open', resolve); extension.once('error', reject); });
      const authed = new Promise(resolve => extension.once('message', resolve));
      extension.send(JSON.stringify({ type: 'auth', role: 'extension', token }));
      await authed;
      extension.on('message', data => {
        const msg = JSON.parse(String(data)) as { type: string; method: string; id: string };
        if (msg.type !== 'command') return;
        const failed = failCapture && msg.method === 'screenshot';
        const payload = msg.method === 'screenshot'
          ? { base64: png, cssWidth: 1, cssHeight: 1, devicePixelRatio: 1, warning: 'capture warning' }
          : { tabId: 7, text: 'viewport 1x1 dpr 1', url: 'http://example.test', title: 'Test' };
        extension.send(JSON.stringify({ type: 'result', id: msg.id, ok: !failed, data: payload, error: failed ? 'capture failed' : undefined }));
      });

      for (const [id, name, args] of [[1, 'screenshot', {}], [2, 'observe', { tabId: 7, includeScreenshot: true }]] as const) {
        proc.stdin.write(frame({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
        const result = (await reader.next()).result;
        assert.equal(result.isError, false);
        const metadata = JSON.parse(result.content[0].text) as Record<string, any>;
        assert.equal(metadata.imageDelivery, images ? 'image' : 'text-only');
        const shot = name === 'observe' ? metadata.screenshot : metadata;
        assert.equal(shot.width, 1);
        assert.equal(shot.warning, 'capture warning');
        assert.equal(shot.base64, undefined);
        if (images) {
          assert.equal(result.content.length, 2);
          assert.equal(result.content[1].type, 'image');
          assert.equal(result.content[1].mimeType, 'image/png');
          assert.equal(result.content[1].data, png);
        } else {
          assert.equal(result.content.length, 1);
          assert.match(metadata.imageWarning, /disabled.*image-viewing/);
        }
      }

      if (images) {
        const { stdout } = await promisify(execFile)(process.execPath, ['scripts/check-mcp.mjs', '--tab', '7'], { env });
        const report = JSON.parse(stdout);
        assert.equal(report.checks.pngImage, 'pass');
        assert.equal(report.checks.observation, 'pass');
        assert.equal(report.checks.modelVision, 'not-tested');
        assert.equal(report.image.width, 1);
        assert.ok(!stdout.includes(token));
        assert.ok(!stdout.includes(png));
      } else {
        await assert.rejects(
          promisify(execFile)(process.execPath, ['scripts/check-mcp.mjs', '--tab', '7'], { env }),
          (error: unknown) => {
            const report = JSON.parse((error as { stdout: string }).stdout);
            assert.match(report.error, /No MCP image content/);
            assert.equal(report.checks.modelVision, 'not-tested');
            return true;
          },
        );
      }

      failCapture = true;
      proc.stdin.write(frame({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screenshot' } }));
      const failed = (await reader.next()).result;
      assert.equal(failed.isError, true);
      assert.equal(failed.content.length, 1);
      assert.match(failed.content[0].text, /capture failed/);
    } finally {
      proc.stdin.end();
      await Promise.race([onceExit(proc), new Promise(resolve => setTimeout(resolve, 1000))]);
      if (proc.exitCode == null) proc.kill('SIGKILL');
      extension.close();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}

function frame(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`);
}

class RpcReader {
  private buffer = Buffer.alloc(0);
  private waiters: ((message: Rpc) => void)[] = [];
  private messages: Rpc[] = [];

  constructor(proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  next(): Promise<Rpc> {
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for an MCP response')), 8000);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  private drain(): void {
    while (true) {
      const end = this.buffer.indexOf('\n');
      if (end === -1) return;
      const body = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      const message = JSON.parse(body) as Rpc;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    }
  }
}

type Rpc = {
  id?: number | null;
  error?: { code: number };
  result: {
    serverInfo: { name: string };
    protocolVersion: string;
    instructions: string;
    tools: { name: string }[];
    isError?: boolean;
    content: { type: string; text: string; data?: string; mimeType?: string }[];
  };
};

function onceExit(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => proc.once('exit', () => resolve()));
}
