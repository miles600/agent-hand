import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { configIo, loadConfig } from '../bridge/config.js';

describe('config file permissions and trusted-input flag', { concurrency: 1 }, () => {
  test('first run writes a private token and keeps it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-hand-config-'));
    const previous = envSnapshot();
    process.env.AGENT_HAND_HOME = home;
    delete process.env.AGENT_HAND_TOKEN;
    delete process.env.AGENT_HAND_PORT;
    delete process.env.AGENT_HAND_REQUIRE_TRUSTED;
    try {
      const created = await loadConfig();
      assert.equal(created.created, true);
      assert.equal(created.token.length, 64);
      assert.equal(created.port, 17321);
      assert.equal(created.requireTrusted, false);
      const info = await stat(created.path);
      assert.equal(info.mode & 0o777, 0o600);
      const again = await loadConfig();
      assert.equal(again.created, false);
      assert.equal(again.token, created.token);
    } finally {
      restoreEnv(previous);
      await rm(home, { recursive: true, force: true });
    }
  });

  test('a later read does not chmod', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-hand-config-'));
    const previous = envSnapshot();
    process.env.AGENT_HAND_HOME = home;
    delete process.env.AGENT_HAND_TOKEN;
    delete process.env.AGENT_HAND_PORT;
    delete process.env.AGENT_HAND_REQUIRE_TRUSTED;
    const original = configIo.chmod;
    try {
      const created = await loadConfig();
      let calls = 0;
      configIo.chmod = async () => {
        calls += 1;
        throw new Error('EPERM');
      };
      const again = await loadConfig();
      assert.equal(again.created, false);
      assert.equal(again.token, created.token);
      assert.equal(calls, 0);
    } finally {
      configIo.chmod = original;
      restoreEnv(previous);
      await rm(home, { recursive: true, force: true });
    }
  });

  test('a failed chmod does not stop the first write', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-hand-config-'));
    const previous = envSnapshot();
    process.env.AGENT_HAND_HOME = home;
    delete process.env.AGENT_HAND_TOKEN;
    delete process.env.AGENT_HAND_PORT;
    delete process.env.AGENT_HAND_REQUIRE_TRUSTED;
    const original = configIo.chmod;
    configIo.chmod = async () => {
      throw new Error('EPERM');
    };
    try {
      const created = await loadConfig();
      assert.equal(created.created, true);
      assert.equal(created.token.length, 64);
      const raw = await readFile(created.path, 'utf8');
      assert.match(raw, new RegExp(created.token));
    } finally {
      configIo.chmod = original;
      restoreEnv(previous);
      await rm(home, { recursive: true, force: true });
    }
  });

  test('requireTrusted in the file survives a rewrite and the env flag is not persisted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-hand-config-'));
    const previous = envSnapshot();
    process.env.AGENT_HAND_HOME = home;
    delete process.env.AGENT_HAND_TOKEN;
    delete process.env.AGENT_HAND_PORT;
    delete process.env.AGENT_HAND_REQUIRE_TRUSTED;
    try {
      const created = await loadConfig();
      const stored = JSON.parse(await readFile(created.path, 'utf8')) as { port: number; token: string; requireTrusted?: boolean };
      stored.requireTrusted = true;
      await writeFile(created.path, `${JSON.stringify(stored, null, 2)}\n`);
      process.env.AGENT_HAND_PORT = '18001';
      const kept = await loadConfig();
      assert.equal(kept.requireTrusted, true);
      assert.equal(kept.port, 18001);
      const rewritten = JSON.parse(await readFile(created.path, 'utf8')) as { port: number; token: string; requireTrusted?: boolean };
      assert.equal(rewritten.requireTrusted, true);
      assert.equal(rewritten.port, 18001);

      await writeFile(created.path, `${JSON.stringify({ port: 18001, token: kept.token }, null, 2)}\n`);
      delete process.env.AGENT_HAND_PORT;
      process.env.AGENT_HAND_REQUIRE_TRUSTED = 'yes';
      const fromEnv = await loadConfig();
      assert.equal(fromEnv.requireTrusted, true);
      const disk = JSON.parse(await readFile(created.path, 'utf8')) as { requireTrusted?: boolean };
      assert.equal(disk.requireTrusted, undefined);
    } finally {
      restoreEnv(previous);
      await rm(home, { recursive: true, force: true });
    }
  });
});

function envSnapshot(): Record<string, string | undefined> {
  return {
    AGENT_HAND_HOME: process.env.AGENT_HAND_HOME,
    AGENT_HAND_TOKEN: process.env.AGENT_HAND_TOKEN,
    AGENT_HAND_PORT: process.env.AGENT_HAND_PORT,
    AGENT_HAND_REQUIRE_TRUSTED: process.env.AGENT_HAND_REQUIRE_TRUSTED,
  };
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
}
