// dreaming.json: the dreams with their proposals, what applying a proposal replaced (so it can be reverted), the
// per-project cursors and when the daily dream last ran. Written atomically, like schedules.json: a crash mid-write
// leaves the old file or the new one; a file that cannot be read is moved aside and dreaming starts over.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Dream } from '../../shared/dreaming';

const VERSION = 1;
/** Dreams kept in the list; older ones (and what they replaced) are dropped */
export const MAX_DREAMS = 60;

/**
 * What applying one proposal changed, so a revert can put it back. `before`: the file's content (null when it did
 * not exist). A mod's folder: every file it held (null when there was no folder). `wrote`: what the app wrote.
 */
export type Replaced =
  | { kind: 'file'; path: string; before: string | null; wrote: string }
  | { kind: 'folder'; path: string; before: Record<string, string> | null; wrote: Record<string, string> };

export interface DreamingData {
  /** Project folder → the time of the last turn a dream covered there */
  cursors: Record<string, number>;
  /** The daily occurrence (unix ms of that day's dream time) last handled: run, or skipped as missed */
  dailyFor?: number;
  /** When the last dream run started, whatever started it */
  lastRunAt?: number;
  lastCheck?: { at: number; trigger: Dream['trigger']; found: number };
  /** Newest first */
  dreams: Dream[];
  /** Proposal id → what applying it replaced */
  replaced: Record<string, Replaced>;
}

export function emptyData(): DreamingData {
  return { cursors: {}, dreams: [], replaced: {} };
}

export class DreamStore {
  constructor(readonly file: string) {}

  load(): DreamingData {
    this.sweepTemps();
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      const raw = JSON.parse(text) as Partial<DreamingData>;
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.dreams)) throw new Error('no dreams list');
      const isRec = (v: unknown): v is Record<string, never> => !!v && typeof v === 'object' && !Array.isArray(v);
      const out: DreamingData = {
        cursors: isRec(raw.cursors) ? raw.cursors : {},
        dreams: raw.dreams.filter((d): d is Dream => !!d && typeof d === 'object' && typeof d.id === 'string' && Array.isArray(d.proposals)),
        replaced: isRec(raw.replaced) ? raw.replaced : {},
      };
      if (typeof raw.dailyFor === 'number') out.dailyFor = raw.dailyFor;
      if (typeof raw.lastRunAt === 'number') out.lastRunAt = raw.lastRunAt;
      if (raw.lastCheck && typeof raw.lastCheck === 'object') out.lastCheck = raw.lastCheck;
      return out;
    } catch (err) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, aside);
      } catch {
        /* start empty either way */
      }
      console.warn(`[dreaming] could not read ${this.file} (kept as ${path.basename(aside)}):`, err);
      return emptyData();
    }
  }

  save(data: DreamingData): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, ...data }, null, 2));
    try {
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      throw err;
    }
  }

  /** Temp files left by a crash before their rename never became the file; drop them */
  private sweepTemps(): void {
    const dir = path.dirname(this.file);
    const prefix = `${path.basename(this.file)}.tmp-`;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* not ours to worry about */
      }
    }
  }
}
