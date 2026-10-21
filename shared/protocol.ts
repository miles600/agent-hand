export const VERSION = '0.1.0';

/** Loopback port. Override with --port, AGENT_HAND_PORT, or the config file. */
export const DEFAULT_PORT = 17321;

/** How long the overlay cursor takes to glide to a target. */
export const DEFAULT_CURSOR_MS = 700;

export type Role = 'extension' | 'client';

export type AuthMessage = {
  type: 'auth';
  role: Role;
  token: string;
  version?: string;
  extensionId?: string;
};

export type CommandMessage = {
  type: 'command';
  id: string;
  method: string;
  params?: Record<string, unknown>;
  timeout?: number;
};

export type ResultMessage = {
  type: 'result';
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
};
