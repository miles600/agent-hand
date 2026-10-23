import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Timeline } from './timeline.js';

export class TimelineHttp {
  private readonly tickets = new Map<string, number>();
  private readonly sessions = new Map<string, number>();

  constructor(private readonly timeline: Timeline, private readonly options: {
    token: string; page: string; port: () => number; connection: () => Record<string, unknown>;
    pause: () => void; resume: () => void;
  }) {}

  issueUrl(): { url: string; expiresIn: number } {
    const pair = randomBytes(24).toString('hex');
    this.tickets.set(pair, Date.now() + 60000);
    while (this.tickets.size > 8) this.tickets.delete(this.tickets.keys().next().value!);
    return { url: `http://127.0.0.1:${this.options.port()}/timeline#pair=${pair}`, expiresIn: 60 };
  }

  private state(): Record<string, unknown> {
    const state = this.timeline.view();
    const connection = this.options.connection();
    if (state.paused && Number(connection.inFlight) > 0) state.mode = 'pausing';
    return { ...state, connection };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    const allowed = [`127.0.0.1:${this.options.port()}`, `localhost:${this.options.port()}`];
    if (!allowed.includes(host)) { reply(res, 403, { error: 'Use the local Agent Hand address.' }); return; }
    const url = new URL(req.url ?? '/', `http://${host}`);
    const cookieName = `ah_timeline_${this.options.port()}`;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/timeline' || url.pathname === '/timeline/')) {
      res.setHeader('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      const page = await readFile(this.options.page);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : page);
      return;
    }
    if (req.method === 'POST' && req.headers.origin !== `http://${host}`) {
      reply(res, 403, { error: 'Cross-origin controls are not allowed.' }); return;
    }
    if (url.pathname === '/timeline/session' && req.method === 'POST') {
      const body = await jsonBody(req);
      const pair = typeof body.pair === 'string' ? body.pair : '';
      const token = typeof body.token === 'string' ? body.token : '';
      const expires = this.tickets.get(pair) ?? 0;
      const valid = expires > Date.now() || (token.length >= 8 && token.length <= 256 && equalToken(token, this.options.token));
      if (!valid) { reply(res, 401, { error: 'Connection link expired. Reopen the timeline from Agent Hand, or enter its token.' }); return; }
      this.tickets.delete(pair);
      const session = randomBytes(24).toString('hex');
      this.sessions.set(session, Date.now() + 12 * 60 * 60 * 1000);
      while (this.sessions.size > 32) this.sessions.delete(this.sessions.keys().next().value!);
      res.setHeader('set-cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/timeline; Max-Age=43200`);
      reply(res, 200, { ok: true }); return;
    }
    const session = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
    if ((this.sessions.get(session) ?? 0) <= Date.now()) { reply(res, 401, { error: 'Connect to Agent Hand first.' }); return; }
    if (url.pathname === '/timeline/api' && req.method === 'GET') {
      reply(res, 200, this.state()); return;
    }
    const image = /^\/timeline\/image\/([a-f0-9-]{36})\.png$/.exec(url.pathname);
    if (image && req.method === 'GET') {
      try {
        const bytes = await this.timeline.image(image[1]);
        res.writeHead(200, { 'content-type': 'image/png' }); res.end(bytes);
      } catch { reply(res, 404, { error: 'Screenshot no longer available.' }); }
      return;
    }
    if (req.method === 'POST') {
      try {
        if (url.pathname === '/timeline/pause') this.options.pause();
        else if (url.pathname === '/timeline/resume') this.options.resume();
        else if (url.pathname === '/timeline/clear') {
          if (Number(this.options.connection().inFlight) > 0) throw new Error('An action already sent is still finishing.');
          this.timeline.clear();
        }
        else if (url.pathname === '/timeline/settings') {
          const body = await jsonBody(req);
          if (typeof body.captureScreenshots !== 'boolean') throw new Error('captureScreenshots must be a boolean');
          this.timeline.captureScreenshots = body.captureScreenshots;
          this.timeline.changed();
        } else { reply(res, 404, { error: 'Not found' }); return; }
        reply(res, 200, this.state());
      } catch (error) { reply(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    reply(res, 404, { error: 'Not found' });
  }
}

function equalToken(left: string, right: string): boolean {
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 4096) throw new Error('Request body too large');
  }
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function reply(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
