import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
  /** True when config.json or AGENT_HAND_REQUIRE_TRUSTED asks for trusted input only. */
  requireTrusted: boolean;
};

type FileConfig = {
  port?: number;
  token?: string;
  requireTrusted?: boolean;
};

/** Indirection so tests can make chmod fail without replacing a read-only fs export. */
export const configIo = {
  chmod(path: string, mode: number): Promise<void> {
    return chmod(path, mode);
  },
};

export function homeDir(): string {
  return process.env.AGENT_HAND_HOME || join(homedir(), '.agent-hand');
}

export async function loadConfig(overrides?: { port?: number }): Promise<Config> {
  const home = homeDir();
  await ensureHome(home);
  const path = join(home, 'config.json');
  let stored: FileConfig = {};
  let existed = false;
  try {
    stored = JSON.parse(await readFile(path, 'utf8')) as FileConfig;
    existed = true;
  } catch {
    stored = {};
  }
  const envPort = process.env.AGENT_HAND_PORT ? Number(process.env.AGENT_HAND_PORT) : undefined;
  const port = normalizePort(overrides?.port ?? envPort ?? stored.port ?? DEFAULT_PORT);
  let token = process.env.AGENT_HAND_TOKEN || stored.token || '';
  let created = false;
  if (!token) {
    token = randomBytes(32).toString('hex');
    created = true;
  }
  const requireTrusted = stored.requireTrusted === true || envFlag(process.env.AGENT_HAND_REQUIRE_TRUSTED);
  if (!existed || stored.port !== port || stored.token !== token) {
    const next: FileConfig = { port, token };
    if (stored.requireTrusted === true) next.requireTrusted = true;
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmodQuiet(path, 0o600);
  }
  return { port, token, created, path, home, requireTrusted };
}

async function ensureHome(home: string): Promise<void> {
  try {
    const info = await stat(home);
    if (!info.isDirectory()) throw new Error(`agent-hand home is not a directory: ${home}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmodQuiet(home, 0o700);
}

async function chmodQuiet(path: string, mode: number): Promise<void> {
  try {
    await configIo.chmod(path, mode);
  } catch {
    // A sandbox can reject chmod with EPERM. A read command must still succeed.
  }
}

function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return value;
}
