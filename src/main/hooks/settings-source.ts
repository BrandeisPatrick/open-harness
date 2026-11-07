// The hooks of the settings files, for a session in a given folder: the user's settings.json always, the folder's
// project settings.json only while the user trusts its exact content (the same SHA-256 approval the settings layer
// uses). Files are read again when they change on disk (by size and mtime), so an edit applies to the next event.

import fs from 'node:fs';
import type { AppConfig } from '../../shared/types';
import { contentHash, projectSettingsPath, trustKey, userSettingsPath } from '../settings';
import { validateHooks, type HooksBlock } from './config';
import type { SettingsHookSet } from './engine';

interface Read {
  sig: string;
  hash: string;
  block: HooksBlock | null;
  disabled?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export class SettingsHooks {
  private cache = new Map<string, Read>();

  constructor(private readonly opts: { config: () => AppConfig; userFile?: () => string }) {}

  private read(file: string): Read | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.cache.delete(file);
      return null;
    }
    const sig = `${st.size}:${st.mtimeMs}:${st.ino}`;
    const known = this.cache.get(file);
    if (known && known.sig === sig) return known;
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const r: Read = { sig, hash: contentHash(raw), block: null };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isObj(parsed)) {
        if (parsed.hooks !== undefined) r.block = validateHooks(parsed.hooks);
        if (parsed.disableAllHooks === true) r.disabled = true;
      }
    } catch {
      /* the settings layer reports a file that does not parse */
    }
    this.cache.set(file, r);
    return r;
  }

  /** The hook sets that apply in `cwd`, and whether a file turns every hook off. */
  forCwd(cwd: string): { sets: SettingsHookSet[]; disabled: boolean } {
    const sets: SettingsHookSet[] = [];
    let disabled = false;
    const userFile = this.opts.userFile?.() ?? userSettingsPath();
    const user = this.read(userFile);
    if (user?.block?.groups.length) sets.push({ groups: user.block.groups, source: 'user', label: userFile });
    if (user?.disabled) disabled = true;
    const projectFile = projectSettingsPath(cwd);
    if (projectFile !== userFile) {
      const project = this.read(projectFile);
      const trusted = project && (this.opts.config().settingsTrusted ?? {})[trustKey(cwd)] === project.hash;
      if (project && trusted) {
        if (project.block?.groups.length) sets.push({ groups: project.block.groups, source: 'project', label: projectFile });
        if (project.disabled) disabled = true;
      }
    }
    return { sets, disabled };
  }

  /** The problems of the files' hooks blocks (applied or not), for Settings → Hooks. */
  problems(cwd: string): { file: string; key: string; message: string }[] {
    const out: { file: string; key: string; message: string }[] = [];
    const userFile = this.opts.userFile?.() ?? userSettingsPath();
    for (const file of [userFile, projectSettingsPath(cwd)]) {
      const r = this.read(file);
      for (const p of r?.block?.problems ?? []) out.push({ file, ...p });
    }
    return out;
  }
}
