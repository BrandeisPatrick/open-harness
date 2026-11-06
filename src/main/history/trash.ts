// The trash: a deleted session's files moved to <userData>/trash/<id>/ instead of being removed:
//   session.json   the session object as it was in memory when it was deleted
//   history.jsonl  its log
//   artifacts/     its artifacts folder (artifact sources and images)
//   meta.json      { id, title, deletedAt, messageCount }
// Entries are removed for good by purge(), or by the retention sweep once they are older than historyTrashDays.

import fs from 'node:fs';
import path from 'node:path';
import type { TrashEntry } from '../../shared/history';
import type { Session } from '../sessions';
import { safeId } from './log';

export const DAY_MS = 24 * 60 * 60 * 1000;

interface TrashMeta {
  id: string;
  title: string;
  deletedAt: number;
  messageCount: number;
}

/** Bytes of a file or a folder (recursively); 0 when it does not exist. */
export function sizeOf(p: string): number {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of fs.readdirSync(p)) total += sizeOf(path.join(p, name));
  return total;
}

/** Moves a file or folder; across volumes it copies and removes. Nothing happens when `from` does not exist. */
export function move(from: string, to: string): boolean {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
  return true;
}

export class Trash {
  constructor(readonly dir: string) {}

  private entryDir(id: string): string {
    return path.join(this.dir, safeId(id) ?? 'invalid');
  }

  has(id: string): boolean {
    return Boolean(safeId(id)) && fs.existsSync(path.join(this.entryDir(id), 'session.json'));
  }

  /** Puts a session into the trash: its object, and its log and artifacts folder moved in (when they exist). */
  put(s: Session, files: { log: string; artifacts: string }, deletedAt: number): void {
    const dir = this.entryDir(s.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // The object first: once it is here, nothing of the session can be lost, whatever happens next.
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s));
    move(files.log, path.join(dir, 'history.jsonl'));
    move(files.artifacts, path.join(dir, 'artifacts'));
    const meta: TrashMeta = { id: s.id, title: s.title, deletedAt, messageCount: s.messages.length };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  }

  /** The stored session object of a trashed session. */
  session(id: string): Session | null {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.entryDir(id), 'session.json'), 'utf8')) as Session;
      return s && s.id === id && Array.isArray(s.messages) ? s : null;
    } catch {
      return null;
    }
  }

  /** Moves a trashed session's log and artifacts back and removes the entry; returns the session object. */
  take(id: string, files: { log: string; artifacts: string }): Session {
    const s = this.session(id);
    if (!s) throw new Error('That session is not in the trash.');
    const dir = this.entryDir(id);
    move(path.join(dir, 'history.jsonl'), files.log);
    move(path.join(dir, 'artifacts'), files.artifacts);
    fs.rmSync(dir, { recursive: true, force: true });
    return s;
  }

  list(trashDays: number): TrashEntry[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: TrashEntry[] = [];
    for (const name of names) {
      if (!safeId(name)) continue;
      const dir = path.join(this.dir, name);
      let meta: TrashMeta | null = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as TrashMeta;
      } catch {
        // A put() cut short before meta.json: the session object tells the rest.
        const s = this.session(name);
        if (!s) continue;
        let deletedAt = Date.now();
        try {
          deletedAt = fs.statSync(path.join(dir, 'session.json')).mtimeMs;
        } catch {
          /* keep now */
        }
        meta = { id: s.id, title: s.title, deletedAt, messageCount: s.messages.length };
      }
      out.push({ id: name, title: meta.title, deletedAt: meta.deletedAt, purgeAt: meta.deletedAt + Math.max(0, trashDays) * DAY_MS, messageCount: meta.messageCount, bytes: sizeOf(dir) });
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** Removes one entry for good, or all of them. */
  purge(id?: string): void {
    if (id === undefined) {
      for (const e of this.list(0)) fs.rmSync(this.entryDir(e.id), { recursive: true, force: true });
      return;
    }
    if (safeId(id)) fs.rmSync(this.entryDir(id), { recursive: true, force: true });
  }

  /** Removes the entries whose purge date has passed; returns their ids. */
  sweep(trashDays: number, now: number): string[] {
    const gone: string[] = [];
    for (const e of this.list(trashDays)) {
      if (e.purgeAt <= now) {
        this.purge(e.id);
        gone.push(e.id);
      }
    }
    return gone;
  }
}
