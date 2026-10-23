import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startBridge } from '../bridge/server.js';

for (const reuse of [false, true]) {
  test(`mcp stdio uses newline JSON and ${reuse ? 'reuses a running bridge' : 'starts its bridge'}`, async () => {
    const server = reuse ? await startBridge({ port: 0, token: 'mcp-test-token-0123456789' }) : undefined;
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
    tools: { name: string }[];
    isError?: boolean;
    content: { text: string }[];
  };
};

function onceExit(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => proc.once('exit', () => resolve()));
}
