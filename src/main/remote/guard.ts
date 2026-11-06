// The remote server's front door: who may talk to it at all, and the headers every answer carries.
// The server exposes an agent that runs shell commands, so everything here fails closed and says as little as possible.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Headers on every response. The token is in the path, so no Referer may ever carry it off the page. */
export const BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/** The page's policy: its own files only, nothing inline, never framed, no forms posting anywhere. */
export const PAGE_CSP = "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Status and headers only. Every rejection goes through here so a wrong token, an unknown path and a foreign Host look byte-for-byte the same. */
export function bare(res: ServerResponse, status: number, extra?: Record<string, string>): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Length': '0', ...extra });
  res.end();
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(data.length) });
  res.end(data);
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Whether `candidate` is the token. Both sides are hashed first so the comparison takes the same time whatever the
 * candidate's length or content; timingSafeEqual then compares fixed 32-byte digests.
 */
export function tokenMatches(candidate: string, tokenDigest: Buffer): boolean {
  return timingSafeEqual(digest(candidate), tokenDigest);
}

export function tokenDigest(token: string): Buffer {
  return digest(token);
}

/**
 * Splits /r/<token>/<rest> into the token candidate and the rest. Anything else yields an empty candidate, which
 * still goes through the same comparison so an unknown path costs what a wrong token costs.
 */
export function splitPath(pathname: string): { candidate: string; rest: string | null } {
  const m = /^\/r\/([^/]*)(\/.*)?$/.exec(pathname);
  if (!m) return { candidate: '', rest: null };
  return { candidate: m[1], rest: m[2] ?? null };
}

/** The peer's address, with IPv4-mapped IPv6 unwrapped so one machine counts once. */
export function peerAddress(req: IncomingMessage): string {
  const a = req.socket.remoteAddress ?? '';
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

/**
 * Counts wrong-token requests per address: the 10th within a minute locks that address out for a minute. Guessing a
 * 256-bit token is hopeless anyway; this keeps a scanner on the network from hammering the agent's front door.
 */
export class Throttle {
  private fails = new Map<string, number[]>();
  private blocked = new Map<string, number>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 60_000,
    private readonly blockMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(addr: string): boolean {
    const until = this.blocked.get(addr);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.blocked.delete(addr);
    return false;
  }

  fail(addr: string): void {
    const t = this.now();
    const recent = (this.fails.get(addr) ?? []).filter((at) => t - at < this.windowMs);
    recent.push(t);
    if (recent.length >= this.limit) {
      this.blocked.set(addr, t + this.blockMs);
      this.fails.delete(addr);
    } else {
      this.fails.set(addr, recent);
    }
    // Bounded memory: a flood from many addresses must not grow these maps forever.
    if (this.fails.size > 4096) this.fails.clear();
    if (this.blocked.size > 4096) for (const [a, until] of this.blocked) if (t >= until) this.blocked.delete(a);
  }

  reset(): void {
    this.fails.clear();
    this.blocked.clear();
  }
}

export const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reads a JSON object body of at most MAX_BODY bytes. 413 past the limit, 400 when it is not a JSON object. */
export function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      reject(new HttpError(413, 'Request body too large.'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new HttpError(413, 'Request body too large.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text) as unknown;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'The body must be a JSON object.'));
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'The body is not valid JSON.'));
      }
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/** Field readers for request bodies: unknown fields are ignored, a field of the wrong type is a 400 that names it. */
export function str(body: Record<string, unknown>, key: string, opts: { optional?: boolean; max?: number } = {}): string {
  const v = body[key];
  if (v === undefined && opts.optional) return '';
  if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be a string.`);
  if (!opts.optional && !v.trim()) throw new HttpError(400, `"${key}" must not be empty.`);
  if (opts.max && v.length > opts.max) throw new HttpError(400, `"${key}" is too long.`);
  return v;
}

export function bool(body: Record<string, unknown>, key: string, fallback?: boolean): boolean {
  const v = body[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'boolean') throw new HttpError(400, `"${key}" must be true or false.`);
  return v;
}
