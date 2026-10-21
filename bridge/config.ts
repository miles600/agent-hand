import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_PORT } from '../shared/protocol.js';

export type Config = {
  port: number;
  token: string;
  created: boolean;
  path: string;
  home: string;
};

export function homeDir(): string {
  return process.env.AGENT_HAND_HOME || join(homedir(), '.agent-hand');
}

export async function loadConfig(overrides?: { port?: number }): Promise<Config> {
  const home = homeDir();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const path = join(home, 'config.json');
  let file: { port?: number; token?: string } = {};
  try {
    file = JSON.parse(await readFile(path, 'utf8')) as { port?: number; token?: string };
  } catch {
    file = {};
  }
  const envPort = process.env.AGENT_HAND_PORT ? Number(process.env.AGENT_HAND_PORT) : undefined;
  const port = normalizePort(overrides?.port ?? envPort ?? file.port ?? DEFAULT_PORT);
  let token = process.env.AGENT_HAND_TOKEN || file.token || '';
  let created = false;
  if (!token) {
    token = randomBytes(32).toString('hex');
    created = true;
  }
  if (file.port !== port || file.token !== token) {
    await writeFile(path, `${JSON.stringify({ port, token }, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }
  return { port, token, created, path, home };
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return value;
}
