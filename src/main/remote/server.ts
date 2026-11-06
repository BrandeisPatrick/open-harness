// The remote-control HTTP server: listening, the request pipeline with its checks, and the page's static files.
//
// Every request goes through, in order:
//   1. the per-address throttle (429 while an address is locked out),
//   2. the Host check (DNS rebinding: a foreign name pointing at this machine gets a bare 404),
//   3. the token in the path, compared in constant time (bare 404, counted by the throttle),
//   4. the Origin check (403 for another site's page),
//   5. for POSTs, the JSON content type and the x-openagent-remote header (no form or "simple" request qualifies).

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { App } from '../app';
import { Api } from './api';
import { bare, BASE_HEADERS, HttpError, json, PAGE_CSP, peerAddress, splitPath, Throttle, tokenDigest, tokenMatches } from './guard';
import { EventStream } from './stream';

export type Bind = 'localhost' | 'lan';

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
/** A file name of the page folder: no directories, no dot files, nothing to traverse with */
const STATIC_NAME = /^[a-z0-9][a-z0-9-]*\.[a-z]+$/;

/** The IPv4 addresses the server answers on: loopback, plus every non-internal interface for `lan`. */
export function listenAddresses(bind: Bind): string[] {
  const out = ['127.0.0.1'];
  if (bind === 'lan') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

export class RemoteServer {
  private server: http.Server | null = null;
  private digest: Buffer;
  readonly throttle = new Throttle();
  readonly stream: EventStream;
  private readonly api: Api;
  private bind: Bind = 'localhost';
  private port: number | null = null;

  constructor(
    private readonly app: App,
    private token: string,
    onClients: (n: number) => void,
  ) {
    this.digest = tokenDigest(token);
    this.stream = new EventStream(() => app.runtime.list(), onClients);
    this.api = new Api(app, { sessionsMoved: () => this.stream.sessionsChanged(), mark: (id) => this.stream.mark(id) });
  }

  get listening(): { bind: Bind; port: number } | null {
    return this.server && this.port ? { bind: this.bind, port: this.port } : null;
  }

  urls(): string[] {
    const l = this.listening;
    return l ? listenAddresses(l.bind).map((a) => `http://${a}:${l.port}/r/${this.token}/`) : [];
  }

  /** Swaps the token: open streams and kept-alive connections made with the old one are closed. */
  setToken(token: string): void {
    this.token = token;
    this.digest = tokenDigest(token);
    this.stream.closeAll();
    this.server?.closeIdleConnections();
  }

  /** Listens on 127.0.0.1 (localhost) or every IPv4 interface (lan). Rejects with a readable message. */
  listen(bind: Bind, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          if (res.headersSent) return void res.destroy();
          if (err instanceof HttpError) json(res, err.status, { error: err.message });
          else {
            console.warn('[remote] request failed:', err);
            json(res, 500, { error: err instanceof Error ? err.message : 'Something went wrong.' });
          }
        });
      });
      // Slow or idle clients must not hold sockets forever; SSE streams send a heartbeat well inside this.
      server.headersTimeout = 10_000;
      server.requestTimeout = 30_000;
      server.keepAliveTimeout = 5_000;
      server.on('error', (err: NodeJS.ErrnoException) => {
        server.close();
        if (err.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use.`));
        else if (err.code === 'EACCES') reject(new Error(`Not allowed to listen on port ${port}.`));
        else if (err.code === 'EADDRNOTAVAIL') reject(new Error('That network address is not available.'));
        else reject(new Error(err.message));
      });
      server.listen({ host: bind === 'lan' ? '0.0.0.0' : '127.0.0.1', port }, () => {
        server.removeAllListeners('error');
        server.on('error', (err) => console.warn('[remote] server error:', err));
        this.server = server;
        this.bind = bind;
        this.port = (server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.stream.closeAll();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private hostAllowed(host: string | undefined): boolean {
    const l = this.listening;
    if (!host || !l) return false;
    const h = host.toLowerCase();
    if (h === `localhost:${l.port}`) return true;
    return listenAddresses(l.bind).some((a) => h === `${a}:${l.port}`);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // No Date header: rejections must be byte-identical whenever they are sent.
    res.sendDate = false;
    const peer = peerAddress(req);
    if (this.throttle.isBlocked(peer)) return bare(res, 429, { 'Retry-After': '60' });

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://remote.invalid');
    } catch {
      url = new URL('http://remote.invalid/');
    }
    const { candidate, rest } = splitPath(url.pathname);
    // The comparison runs for every request, valid Host or not, so nothing about the token leaks through timing.
    const tokenOk = tokenMatches(candidate, this.digest);
    if (!this.hostAllowed(req.headers.host)) return bare(res, 404);
    if (!tokenOk) {
      this.throttle.fail(peer);
      return bare(res, 404);
    }

    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host!.toLowerCase()}`) return bare(res, 403);

    // /r/<token> without the slash: the page's relative links need it.
    if (rest === null) return bare(res, 308, { Location: `${candidate}/` });

    const method = req.method ?? 'GET';
    if (method === 'POST') {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') return json(res, 415, { error: 'Send JSON (content-type: application/json).' });
      if (req.headers['x-openagent-remote'] !== '1') return bare(res, 403);
    } else if (method !== 'GET' && method !== 'HEAD') {
      return bare(res, 405, { Allow: 'GET, POST' });
    }

    if (rest === '/api/events') {
      if (method !== 'GET') return json(res, 405, { error: 'Use GET.' });
      if (!this.stream.attach(res)) json(res, 503, { error: 'Too many open connections.' });
      return;
    }
    if (rest.startsWith('/api/')) {
      if (!(await this.api.handle(rest.slice(5), url, req, res))) bare(res, 404);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') return bare(res, 404);
    return this.serveStatic(rest === '/' ? 'index.html' : rest.slice(1), method === 'HEAD', res);
  }

  private serveStatic(name: string, head: boolean, res: http.ServerResponse): void {
    const type = STATIC_TYPES[path.extname(name)];
    if (!STATIC_NAME.test(name) || !type) return bare(res, 404);
    let data: Buffer;
    try {
      data = fs.readFileSync(path.join(this.app.appRoot, 'remote', name));
    } catch {
      return bare(res, 404);
    }
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Security-Policy': PAGE_CSP, 'Content-Type': type, 'Content-Length': String(data.length) });
    res.end(head ? undefined : data);
  }
}
