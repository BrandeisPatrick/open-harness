// harness.storage: a small JSON store per mod in <userData>/mods-data/, with a scope for the mod as a whole and one
// per session. Pages have no localStorage (their frame is sandboxed), so this is where they keep things.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STORAGE_MAX_VALUE = 256 * 1024;
export const STORAGE_MAX_MOD = 5 * 1024 * 1024;
export const STORAGE_MAX_KEY = 200;
const WRITE_DELAY_MS = 400;

interface ModData {
  mod: Record<string, unknown>;
  sessions: Record<string, Record<string, unknown>>;
}

export class StorageError extends Error {
  constructor(message: string, readonly kind: 'params' | 'quota') {
    super(message);
  }
}

/** A file name for a mod key ("word-count", "notes@/Users/me/project") that is safe and does not collide. */
export function storageFileName(key: string): string {
  const slug = key.replace(/[^a-z0-9-]+/gi, '_').slice(0, 60);
  return `${slug}-${createHash('sha256').update(key).digest('hex').slice(0, 10)}.json`;
}

export class ModStorage {
  private data = new Map<string, ModData>();
  private sizes = new Map<string, number>();
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dir: string) {}

  private file(key: string): string {
    return path.join(this.dir, storageFileName(key));
  }

  private load(key: string): ModData {
    let d = this.data.get(key);
    if (d) return d;
    d = { mod: {}, sessions: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(key), 'utf8')) as Partial<ModData>;
      if (raw && typeof raw === 'object') {
        if (raw.mod && typeof raw.mod === 'object' && !Array.isArray(raw.mod)) d.mod = raw.mod;
        if (raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)) d.sessions = raw.sessions;
      }
    } catch {
      /* nothing stored yet */
    }
    this.data.set(key, d);
    this.sizes.set(key, Buffer.byteLength(JSON.stringify(d)));
    return d;
  }

  private bucket(key: string, scope: 'mod' | 'session', sessionId: string, create: boolean): Record<string, unknown> | undefined {
    const d = this.load(key);
    if (scope === 'mod') return d.mod;
    if (!d.sessions[sessionId] && create) d.sessions[sessionId] = {};
    return d.sessions[sessionId];
  }

  static checkKey(k: unknown): string {
    if (typeof k !== 'string' || !k) throw new StorageError('key: must be a non-empty string', 'params');
    if (k.length > STORAGE_MAX_KEY) throw new StorageError(`key: at most ${STORAGE_MAX_KEY} characters (got ${k.length})`, 'params');
    return k;
  }

  get(key: string, scope: 'mod' | 'session', sessionId: string, k: string): unknown {
    const b = this.bucket(key, scope, sessionId, false);
    return b && Object.prototype.hasOwnProperty.call(b, k) ? structuredClone(b[k]) : null;
  }

  keys(key: string, scope: 'mod' | 'session', sessionId: string): string[] {
    return Object.keys(this.bucket(key, scope, sessionId, false) ?? {}).sort();
  }

  set(key: string, scope: 'mod' | 'session', sessionId: string, k: string, value: unknown): void {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      json = undefined;
    }
    if (json === undefined) throw new StorageError('value: must be JSON (an object, list, string, number, boolean or null)', 'params');
    const bytes = Buffer.byteLength(json);
    if (bytes > STORAGE_MAX_VALUE) throw new StorageError(`value: ${Math.ceil(bytes / 1024)} KB is over the ${STORAGE_MAX_VALUE / 1024} KB limit for one value`, 'params');
    const b = this.bucket(key, scope, sessionId, true)!;
    const before = Object.prototype.hasOwnProperty.call(b, k) ? Buffer.byteLength(JSON.stringify(b[k])) + Buffer.byteLength(JSON.stringify(k)) + 2 : 0;
    const after = bytes + Buffer.byteLength(JSON.stringify(k)) + 2;
    const total = (this.sizes.get(key) ?? 0) - before + after;
    if (total > STORAGE_MAX_MOD) throw new StorageError(`storage is full: a mod may keep ${STORAGE_MAX_MOD / 1024 / 1024} MB; remove keys it no longer needs`, 'quota');
    b[k] = JSON.parse(json);
    this.sizes.set(key, total);
    this.touch(key);
  }

  remove(key: string, scope: 'mod' | 'session', sessionId: string, k: string): void {
    const b = this.bucket(key, scope, sessionId, false);
    if (!b || !Object.prototype.hasOwnProperty.call(b, k)) return;
    this.sizes.set(key, Math.max(0, (this.sizes.get(key) ?? 0) - Buffer.byteLength(JSON.stringify(b[k])) - Buffer.byteLength(JSON.stringify(k)) - 2));
    delete b[k];
    if (scope === 'session' && !Object.keys(b).length) delete this.load(key).sessions[sessionId];
    this.touch(key);
  }

  /** Bytes a mod uses (approximately the size of its file) */
  size(key: string): number {
    this.load(key);
    return this.sizes.get(key) ?? 0;
  }

  private touch(key: string): void {
    this.dirty.add(key);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Writes every changed mod's file now (also at quit) */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty.size) return;
    fs.mkdirSync(this.dir, { recursive: true });
    for (const key of this.dirty) {
      const d = this.data.get(key);
      if (!d) continue;
      const file = this.file(key);
      try {
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(d));
        fs.renameSync(`${file}.tmp`, file);
      } catch (err) {
        console.warn('[mods] storage write failed:', key, err);
      }
    }
    this.dirty.clear();
  }
}
