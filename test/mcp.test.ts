import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('mcp stdio lists tools and can wait without an extension', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-hand-mcp-'));
  const proc = spawn('node', ['dist/bridge/index.js', 'mcp'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HAND_HOME: home,
      AGENT_HAND_TOKEN: 'mcp-test-token-0123456789',
      AGENT_HAND_PORT: '0',
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
  }
});

function frame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload]);
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
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      const message = JSON.parse(body) as Rpc;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    }
  }
}

type Rpc = {
  id?: number;
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
