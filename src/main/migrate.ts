// The app has been renamed: OpenCoder, then OpenAgent, then Open Harness, now Silo Harness. On the first launch under
// the new name the folders an older copy left are carried over so nothing is lost: ~/.open-harness becomes
// ~/.silo-harness (with a link left at the old place, so older scripts and an older copy of the app still find it),
// and the data folder in ~/Library/Application Support moves to the new name. Each step is a rename, never a copy
// (sessions can be large), and a step that fails is logged and leaves the old folder in use; it never stops the app.
// Pure functions of the paths they are given, so the tests run them on temporary folders.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR_NAME, OLD_CONFIG_DIR_NAME } from './paths';

export type MoveResult =
  /** Moved (and, for the config folder, linked) */
  | 'moved'
  /** Moved, but the link at the old place could not be made */
  | 'moved-unlinked'
  /** The new folder is already there: nothing done */
  | 'exists'
  /** No old folder: nothing to do */
  | 'none'
  /** The old one is a link or not a folder: left alone */
  | 'not-a-folder'
  /** The rename failed: the old folder stays in use */
  | 'failed';

type Log = (line: string) => void;

const lstat = (p: string): fs.Stats | null => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/** An empty folder (Chromium may make the data folder before the app's code runs) counts as absent */
function isEmptyDir(p: string): boolean {
  try {
    return fs.readdirSync(p).filter((n) => n !== '.DS_Store').length === 0;
  } catch {
    return false;
  }
}

/**
 * Renames `from` to `to` when `to` is absent (or an empty folder) and `from` is a real folder (not a link).
 * `rename` is the step itself, replaceable so a test can make it fail.
 */
export function moveFolder(from: string, to: string, log: Log = console.log, rename: (a: string, b: string) => void = fs.renameSync): MoveResult {
  const next = lstat(to);
  if (next && !(next.isDirectory() && isEmptyDir(to))) return 'exists';
  const old = lstat(from);
  if (!old) return 'none';
  if (old.isSymbolicLink() || !old.isDirectory()) return 'not-a-folder';
  try {
    if (next) fs.rmdirSync(to);
    rename(from, to);
  } catch (err) {
    log(`[migrate] could not move ${from} to ${to}, still using ${from}: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
  log(`[migrate] moved ${from} to ${to}`);
  return 'moved';
}

/**
 * ~/.open-harness → ~/.silo-harness, leaving the link ~/.open-harness → ~/.silo-harness. Skipped when an override
 * names the config folder. When the rename fails, configDir() keeps finding ~/.open-harness for this run.
 */
export function moveConfigDir(home: string, log: Log = console.log, rename?: (a: string, b: string) => void): MoveResult {
  const from = path.join(home, OLD_CONFIG_DIR_NAME);
  const to = path.join(home, CONFIG_DIR_NAME);
  const r = moveFolder(from, to, log, rename);
  if (r !== 'moved') return r;
  try {
    fs.symlinkSync(to, from);
    log(`[migrate] left a link ${from} → ${to}`);
  } catch (err) {
    log(`[migrate] moved ${from}, but could not leave a link there: ${err instanceof Error ? err.message : String(err)}`);
    return 'moved-unlinked';
  }
  return 'moved';
}

/**
 * The data folder: <Application Support>/Open Harness → <Application Support>/Silo Harness (`next` is the new one,
 * app.getPath('userData')). When that fails the app starts with the new, empty folder and says so in the log.
 */
export function moveDataFolder(next: string, log: Log = console.log, rename?: (a: string, b: string) => void): MoveResult {
  return moveFolder(path.join(path.dirname(next), 'Open Harness'), next, log, rename);
}

/**
 * The older names (OpenAgent, OpenCoder): their data folder's entries are moved into the new one, config.json last;
 * it is what marks the old folder as holding data and the new one as set up, so a carry-over that was cut short picks
 * up where it stopped on the next launch.
 */
export function carryOverOlderDataFolder(next: string, log: Log = console.log): void {
  if (fs.existsSync(path.join(next, 'config.json'))) return; // already set up under the new name
  const prev = ['OpenAgent', 'opencoder', 'OpenCoder'].map((n) => path.join(path.dirname(next), n)).find((p) => fs.existsSync(path.join(p, 'config.json')));
  if (!prev) return;
  fs.mkdirSync(next, { recursive: true });
  for (const entry of ['sessions', 'artifacts', 'history', 'trash', 'schedules.json', 'dreaming.json', 'skill-usage.json', 'mods-data', 'backgrounds', 'remote.json', 'config.json']) {
    const from = path.join(prev, entry);
    const to = path.join(next, entry);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.renameSync(from, to);
      log(`[data] moved ${from} to ${to}`);
    } catch (err) {
      log(`[data] could not move ${from}: ${String(err)}`);
    }
  }
}
