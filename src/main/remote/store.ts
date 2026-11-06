// What the remote server keeps between launches: the access token and the port it picked. Both live in
// <userData>/remote.json (mode 0600) so links handed out keep working across restarts until the owner asks for a
// new one. Kept out of config.json on purpose: the token is a secret, and config.json is read by many features.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface RemoteState {
  /** 32 random bytes, hex */
  token: string;
  /** The port picked when the config says 0 (any free one); null until the server first listened */
  port: number | null;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function statePath(userData: string): string {
  return path.join(userData, 'remote.json');
}

/** The stored state, or a fresh token when the file is missing or damaged (the old links are then dead anyway). */
export function loadState(userData: string): RemoteState {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(userData), 'utf8')) as Partial<RemoteState>;
    const token = typeof raw.token === 'string' && TOKEN_RE.test(raw.token) ? raw.token : null;
    const port = Number.isInteger(raw.port) && (raw.port as number) > 0 && (raw.port as number) < 65536 ? (raw.port as number) : null;
    if (token) return { token, port };
  } catch {
    /* missing or unreadable: start over */
  }
  const fresh = { token: newToken(), port: null };
  saveState(userData, fresh);
  return fresh;
}

/** Writes through a temp file created 0600, so the token is never readable by other users, not even for a moment. */
export function saveState(userData: string, state: RemoteState): void {
  const file = statePath(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // mode only applies when the file is created; a stale temp file keeps its old one
  fs.renameSync(tmp, file);
}
