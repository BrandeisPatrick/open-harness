// Serving mod pages on the mod:// scheme. resolveModUrl is pure (apart from reading the file system) and does all
// the deciding: which file a URL names, whether it may be served, and the headers, including each mod's
// Content-Security-Policy. The Electron handler in mods.ts only reads the file it returns.

import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './manifest';
import { MOD_SCHEME } from './registry';

export { MOD_SCHEME };

/** For protocol.registerSchemesAsPrivileged (index.ts) */
export const MOD_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true };

/** The label of the user's own background picture: mod://app.background/<file> */
export const BACKGROUND_LABEL = 'app.background';
const HARNESS_FILES = new Set(['harness.js', 'harness.css']);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The policy for one mod's pages. The origin is named explicitly: the frame is sandboxed without allow-same-origin, so
 * its own origin is opaque and 'self' would match nothing.
 */
export function modCsp(origin: string, network: boolean): string {
  const net = network ? ' https:' : '';
  return [
    `default-src 'none'`,
    `script-src ${origin} 'unsafe-inline'`,
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data: blob:${net}`,
    `font-src ${origin} data:${net}`,
    `media-src ${origin} data: blob:${net}`,
    `connect-src ${origin}${network ? ' https: wss:' : ''}`,
    `worker-src ${origin}`,
    `frame-src 'none'`,
    `child-src 'none'`,
    `object-src 'none'`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join('; ');
}

export interface ServeContext {
  /** The mod on a label, only when it is on (anything else is not served) */
  lookup(label: string): { dir: string; network: boolean } | null;
  /** <appRoot>/modkit: harness.js and harness.css */
  harnessDir: string;
  /** <userData>/backgrounds */
  backgroundsDir: string;
}

export interface ServeResult {
  status: number;
  /** The file to send with status 200 */
  file?: string;
  headers: Record<string, string>;
}

function baseHeaders(type: string, csp: string): Record<string, string> {
  return {
    'Content-Type': type,
    // The frame is sandboxed without allow-same-origin, so even its own files are cross-origin to it.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': csp,
  };
}

const NONE_CSP = `default-src 'none'; frame-ancestors 'none'`;

function notFound(csp = NONE_CSP): ServeResult {
  return { status: 404, headers: baseHeaders('text/plain; charset=utf-8', csp) };
}

/** The decoded path segments, or null when any is unsafe (.., ., dotfiles, encoded separators, NUL, empty). */
function segments(pathname: string): string[] | null {
  const raw = pathname.split('/').slice(1);
  if (!raw.length) return null;
  const out: string[] = [];
  for (const r of raw) {
    let s: string;
    try {
      s = decodeURIComponent(r);
    } catch {
      return null;
    }
    if (!s || s === '.' || s === '..' || s.startsWith('.') || /[\\/\0]/.test(s) || /^[A-Za-z]:/.test(s)) return null;
    out.push(s);
  }
  return out;
}

/** The real file at `parts` under `root`, or null when it does not exist, is not a file, or (via a symlink) leaves `root`. */
function fileInside(root: string, parts: string[]): string | null {
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(path.join(root, ...parts));
  } catch {
    return null;
  }
  if (!isInside(realRoot, real) || real === realRoot) return null;
  // No hidden file anywhere on the resolved path either (a symlink named "a.js" pointing at ".env" inside the mod).
  if (path.relative(realRoot, real).split(path.sep).some((p) => p.startsWith('.'))) return null;
  try {
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Maps a mod:// URL to the file to send (or a refusal) and the response headers. Who is asking is not known here
 * (Electron does not hand protocol.handle the Origin or Referer): the CSP and the lock-down's request hook keep mod
 * pages to their own files and web pages out.
 */
export function resolveModUrl(url: string, ctx: ServeContext): ServeResult {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return notFound();
  }
  if (u.protocol !== `${MOD_SCHEME}:` || u.username || u.password || u.port) return notFound();
  const label = u.hostname.toLowerCase();
  const parts = segments(u.pathname);
  if (!parts) return notFound();

  if (label === BACKGROUND_LABEL) {
    if (parts.length !== 1 || !IMAGE_EXT.has(path.extname(parts[0]).toLowerCase())) return notFound();
    const file = fileInside(ctx.backgroundsDir, parts);
    return file ? { status: 200, file, headers: baseHeaders(contentType(file), NONE_CSP) } : notFound();
  }

  const mod = ctx.lookup(label);
  if (!mod) return notFound();
  const origin = `${MOD_SCHEME}://${label}`;
  const csp = modCsp(origin, mod.network);
  if (parts[0] === '@harness') {
    if (parts.length !== 2 || !HARNESS_FILES.has(parts[1])) return notFound(csp);
    const file = fileInside(ctx.harnessDir, [parts[1]]);
    return file ? { status: 200, file, headers: baseHeaders(contentType(file), csp) } : notFound(csp);
  }
  const file = fileInside(mod.dir, parts);
  return file ? { status: 200, file, headers: baseHeaders(contentType(file), csp) } : notFound(csp);
}

/** The label of a mod:// URL ("" for anything else) */
export function labelOfUrl(url: string | undefined | null): string {
  if (!url || !url.startsWith(`${MOD_SCHEME}:`)) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
