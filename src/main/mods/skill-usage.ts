// How often each skill is used: when the model loads one with the skill tool, and when a user message starts with
// /<name> of an existing skill. Counted per session and all-time, kept in <userData>/skill-usage.json, and offered
// to other features as the 'skill-usage' service.

import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '../../shared/types';
import type { SkillUsage } from '../../shared/mods';
import type { SkillUsageService } from '../services';
import { SLASH_RE } from '../skills';

const WRITE_DELAY_MS = 1000;
/** Sessions whose counts are kept (the most recently used ones) */
const MAX_SESSIONS = 500;

type Counts = Record<string, { count: number; lastUsedAt: number }>;
interface UsageFile {
  all: Counts;
  sessions: Record<string, Counts>;
}

export interface SkillUsageOptions {
  file: string;
  /** Names of the skills that exist now */
  skillNames: () => string[];
  /** Called after every counted use */
  onUsed?: (name: string, sessionId: string) => void;
  now?: () => number;
}

export class SkillUsageTracker implements SkillUsageService {
  private data: UsageFile = { all: {}, sessions: {} };
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly opts: SkillUsageOptions) {
    try {
      const raw = JSON.parse(fs.readFileSync(opts.file, 'utf8')) as Partial<UsageFile>;
      if (raw && typeof raw.all === 'object' && raw.all) this.data.all = raw.all;
      if (raw && typeof raw.sessions === 'object' && raw.sessions) this.data.sessions = raw.sessions;
    } catch {
      /* first run */
    }
  }

  /** Feed every agent event here (app.events.on). */
  handle(sessionId: string, ev: AgentEvent): void {
    if (ev.type === 'tool_start' && ev.name === 'skill') {
      const args = (typeof ev.args === 'string' ? safeJson(ev.args) : ev.args) as { name?: unknown } | null;
      const name = String(args?.name ?? '').toLowerCase().replace(/^\//, '').trim();
      if (name) this.count(sessionId, name);
    } else if (ev.type === 'user_message') {
      const m = SLASH_RE.exec(String(ev.text ?? '').trim());
      if (m) this.count(sessionId, m[1].toLowerCase());
    }
  }

  /** Counts one use of `name` when it is an existing skill. */
  count(sessionId: string, name: string): boolean {
    if (!this.opts.skillNames().includes(name)) return false;
    const at = this.opts.now?.() ?? Date.now();
    const bump = (c: Counts) => {
      const prev = c[name];
      c[name] = { count: (prev?.count ?? 0) + 1, lastUsedAt: at };
    };
    bump(this.data.all);
    if (sessionId) bump((this.data.sessions[sessionId] ??= {}));
    this.trim();
    this.save();
    this.opts.onUsed?.(name, sessionId);
    return true;
  }

  usage(scope: 'session' | 'all', sessionId?: string): SkillUsage[] {
    const c = scope === 'all' ? this.data.all : (sessionId ? this.data.sessions[sessionId] : undefined) ?? {};
    return Object.entries(c)
      .map(([name, v]) => ({ name, count: v.count, lastUsedAt: v.lastUsedAt }))
      .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name));
  }

  private trim(): void {
    const ids = Object.keys(this.data.sessions);
    if (ids.length <= MAX_SESSIONS) return;
    const last = (id: string) => Math.max(0, ...Object.values(this.data.sessions[id]).map((v) => v.lastUsedAt));
    ids.sort((a, b) => last(a) - last(b));
    for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete this.data.sessions[id];
  }

  private save(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
      fs.writeFileSync(this.opts.file, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[skill-usage] could not save:', err);
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
