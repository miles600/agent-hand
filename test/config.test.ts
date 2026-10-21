import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../bridge/config.js';

test('first run writes a private token and keeps it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-hand-config-'));
  const previous = {
    home: process.env.AGENT_HAND_HOME,
    token: process.env.AGENT_HAND_TOKEN,
    port: process.env.AGENT_HAND_PORT,
  };
  process.env.AGENT_HAND_HOME = home;
  delete process.env.AGENT_HAND_TOKEN;
  delete process.env.AGENT_HAND_PORT;
  try {
    const created = await loadConfig();
    assert.equal(created.created, true);
    assert.equal(created.token.length, 64);
    assert.equal(created.port, 17321);
    const info = await stat(created.path);
    assert.equal(info.mode & 0o777, 0o600);
    const again = await loadConfig();
    assert.equal(again.created, false);
    assert.equal(again.token, created.token);
  } finally {
    restore('AGENT_HAND_HOME', previous.home);
    restore('AGENT_HAND_TOKEN', previous.token);
    restore('AGENT_HAND_PORT', previous.port);
    await rm(home, { recursive: true, force: true });
  }
});

function restore(name: 'AGENT_HAND_HOME' | 'AGENT_HAND_TOKEN' | 'AGENT_HAND_PORT', value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}
