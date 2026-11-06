// schedules.json: the list, written atomically. A crash mid-write leaves either the old file or the new one,
// never half of one; a file that cannot be read is moved aside (so nothing is silently lost) and the list starts empty.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Schedule } from '../../shared/schedules';

const VERSION = 1;

export interface StoreIo {
  /** Swappable so tests can simulate a crash between writing the temp file and renaming it */
  rename(from: string, to: string): void;
}

export class ScheduleStore {
  constructor(
    readonly file: string,
    private readonly io: StoreIo = { rename: (a, b) => fs.renameSync(a, b) },
  ) {}

  load(): Schedule[] {
    this.sweepTemps();
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    try {
      const data = JSON.parse(text) as { schedules?: unknown };
      if (!data || !Array.isArray(data.schedules)) throw new Error('no schedules list');
      return data.schedules.filter((s): s is Schedule => !!s && typeof s === 'object' && typeof (s as Schedule).id === 'string');
    } catch (err) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, aside);
      } catch {
        /* keep going with an empty list either way */
      }
      console.warn(`[schedules] could not read ${this.file} (kept as ${path.basename(aside)}):`, err);
      return [];
    }
  }

  save(list: Schedule[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, schedules: list }, null, 2));
    try {
      this.io.rename(tmp, this.file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      throw err;
    }
  }

  /** Temp files left by a crash before their rename never became the list; drop them */
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
