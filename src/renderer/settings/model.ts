// The settings page's pure pieces: the sections, the field validators, the search matcher, the plain words for mod
// permissions and the small derivations the sections show. Nothing here touches the DOM, so the headless suite
// (test/settings-page.js) loads the compiled file directly.

import type { AppConfig } from '../../shared/types';
import type { ModInfo, ModLayout, ModLookTarget, ModPermission, ModSeat } from '../../shared/mods';
import type { ScheduleWhen } from '../../shared/schedules';
import type { SettingsFileInfo } from '../../shared/settings-info';
import type { IconName } from '../icons.js';

// ---------- Sections ----------

export type SectionId = 'general' | 'model' | 'permissions' | 'context' | 'mods' | 'mcp' | 'skills' | 'scheduled' | 'remote' | 'history' | 'appearance' | 'files' | 'about';

export interface SectionInfo {
  id: SectionId;
  title: string;
  icon: IconName;
  /** Navigation group; a hairline separates groups */
  group: number;
}

export const SECTIONS: SectionInfo[] = [
  { id: 'general', title: 'General', icon: 'settings', group: 0 },
  { id: 'model', title: 'Model', icon: 'server', group: 0 },
  { id: 'permissions', title: 'Permissions', icon: 'shield-check', group: 0 },
  { id: 'context', title: 'Context', icon: 'gauge', group: 0 },
  { id: 'mods', title: 'Mods', icon: 'puzzle', group: 1 },
  { id: 'mcp', title: 'MCP servers', icon: 'plug', group: 1 },
  { id: 'skills', title: 'Skills', icon: 'sparkles', group: 1 },
  { id: 'scheduled', title: 'Scheduled', icon: 'clock', group: 1 },
  { id: 'remote', title: 'Remote control', icon: 'smartphone', group: 1 },
  { id: 'history', title: 'History', icon: 'archive', group: 2 },
  { id: 'appearance', title: 'Appearance', icon: 'palette', group: 2 },
  { id: 'files', title: 'Configuration files', icon: 'file-text', group: 2 },
  { id: 'about', title: 'About', icon: 'info', group: 3 },
];

export function isSectionId(s: unknown): s is SectionId {
  return typeof s === 'string' && SECTIONS.some((x) => x.id === s);
}

/** Older callers name an element of the old form; these ids stand for a whole section. */
export const LEGACY_SECTIONS: Record<string, SectionId> = {
  'mcp-section': 'mcp',
  'rules-section': 'permissions',
  'ollama-fields': 'model',
  'portkey-fields': 'model',
};

/** The section an openSettings(target) call means, when the target names one (else null: look for an element). */
export function sectionForTarget(target: string): SectionId | null {
  if (isSectionId(target)) return target;
  return LEGACY_SECTIONS[target] ?? null;
}

// ---------- Search ----------

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Every word of the query starts a word of the haystack (title, description, keywords): "api k" finds "API key". */
export function matchesQuery(fields: (string | undefined)[], query: string): boolean {
  const words = normalizeText(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = ` ${normalizeText(fields.filter(Boolean).join(' '))}`;
  return words.every((w) => hay.includes(` ${w}`));
}

// ---------- Validators ----------

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A whole number in [min, max]; thousands separators and an underscore are allowed ("16,384"). */
export function parseInteger(text: string, min: number, max: number): Parsed<number> {
  const t = String(text ?? '').trim().replace(/[,_\s]/g, '');
  if (!t) return { ok: false, error: 'Enter a number.' };
  if (!/^-?\d+$/.test(t)) return { ok: false, error: `Enter a whole number from ${fmt(min)} to ${fmt(max)}.` };
  const n = Number(t);
  if (n < min || n > max) return { ok: false, error: `Must be from ${fmt(min)} to ${fmt(max)}.` };
  return { ok: true, value: n };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** An http(s) URL; the trailing slash is dropped. */
export function parseUrl(text: string): Parsed<string> {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, error: 'Enter a URL, like http://localhost:11434/v1.' };
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { ok: false, error: 'This is not a URL. It should start with http:// or https://.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Use an http:// or https:// address.' };
  return { ok: true, value: t.replace(/\/+$/, '') };
}

/** Free text with surrounding space removed (an empty value is allowed). */
export function parseText(text: string): Parsed<string> {
  return { ok: true, value: String(text ?? '').trim() };
}

export function parseRequired(text: string, what: string): Parsed<string> {
  const t = String(text ?? '').trim();
  return t ? { ok: true, value: t } : { ok: false, error: `Enter ${what}.` };
}

// ---------- Config paths ----------

/** The value at "portkey.model" in the config. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * The smallest change that sets one field: { portkey: { model } }. The main process merges a change over its own
 * copy (the provider objects field by field), so the rest of the window's copy, possibly stale, is never sent back.
 */
export function patchFor(path: string, value: unknown): Partial<AppConfig> {
  const parts = path.split('.');
  let out: Record<string, unknown> = { [parts[parts.length - 1]]: value };
  for (let i = parts.length - 2; i >= 0; i--) out = { [parts[i]]: out };
  if (path === 'permissionMode') out.autoApprove = value === 'bypass';
  return out as Partial<AppConfig>;
}

// ---------- Choices ----------

export const TOOL_SET: { value: AppConfig['toolSet']; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'all', label: 'All' },
  { value: 'essential', label: 'Essential' },
];

export const KEEP_AWAKE: { value: AppConfig['keepAwake']; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'running', label: 'While running' },
  { value: 'always', label: 'Always' },
];

export const COMPACT_AT: number[] = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

/** The nearest offered step to a stored threshold (older files may hold any fraction). */
export function nearestCompactStep(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.8;
  return COMPACT_AT.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), COMPACT_AT[0]);
}

export const TRASH_DAYS: { value: number; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
];

// ---------- Mods ----------

/** docs/mods.md, "Permissions": what each permission lets a mod do, in plain words. */
export const PERMISSION_WORDS: Record<ModPermission, string> = {
  'session:read': 'Read the session on screen: its messages, tool calls, tasks, plan, outputs and context use',
  'session:send': 'Send messages as you and fill the composer',
  'session:control': 'Stop a run, compact, open or start sessions, start and merge sub-sessions',
  'sessions:read': 'List and search all your conversations',
  model: 'Call the model (uses tokens)',
  'skills:read': 'List skills and how often they are used',
  'config:read': 'Read non-secret settings',
  'config:write': 'Change the theme, auto-compact, keep-awake, notifications and background',
  schedules: 'List, create, change and delete scheduled tasks',
  remote: 'See and switch remote control',
  network: 'Reach the internet',
};

export function permissionWords(p: string): string {
  return (PERMISSION_WORDS as Record<string, string>)[p] ?? p;
}

export const SEAT_WORDS: Record<ModSeat, string> = {
  rail: 'a panel in the right-hand rail',
  tab: 'a tab in the side pane',
  composer: 'a strip above the composer',
  background: 'a background behind the window',
};

export const LOOK_WORDS: Record<ModLookTarget, string> = {
  conversation: 'a look for the conversation',
  composer: 'a look for the chat bar',
};

// ---------- Looks (Settings → Appearance → Looks) ----------

export interface LookChoice {
  value: string;
  label: string;
}

const refMod = (ref: string): string => ref.slice(0, Math.max(0, ref.lastIndexOf('/')));

/** The choices of a region's select: every look for it from mods that are on ("<mod>: <look>"), in list order. */
export function lookChoices(mods: readonly ModInfo[], target: ModLookTarget): LookChoice[] {
  const out: LookChoice[] = [];
  for (const m of mods) {
    if (m.state !== 'on') continue;
    for (const l of m.manifest?.contributes?.looks ?? []) if (l.target === target) out.push({ value: `${m.key}/${l.id}`, label: `${m.manifest?.name ?? m.id}: ${l.title}` });
  }
  return out;
}

/** A mod's matching parts: its first conversation look, chat bar look and background view. */
export interface LookSet {
  key: string;
  name: string;
  conversation: string | null;
  composer: string | null;
  background: string | null;
}

function setOf(m: ModInfo): LookSet {
  const looks = m.manifest?.contributes?.looks ?? [];
  const look = (t: ModLookTarget) => {
    const l = looks.find((x) => x.target === t);
    return l ? `${m.key}/${l.id}` : null;
  };
  const bg = m.manifest?.contributes?.views?.find((v) => v.seat === 'background');
  return { key: m.key, name: m.manifest?.name ?? m.id, conversation: look('conversation'), composer: look('composer'), background: bg ? `${m.key}/${bg.id}` : null };
}

const parts = (s: LookSet) => [s.conversation, s.composer, s.background].filter(Boolean).length;

/** The sets the Set row offers: every mod that is on and contributes at least two of a conversation look, a chat bar look and a background. */
export function lookSets(mods: readonly ModInfo[]): LookSet[] {
  return mods.filter((m) => m.state === 'on' && m.manifest).map(setOf).filter((s) => parts(s) >= 2);
}

/** What the layout shows in the three places a set covers (a picture of the user's own counts as a background). */
function shown(layout: Pick<ModLayout, 'looks' | 'background' | 'backgroundImage'>): { conversation: string | null; composer: string | null; background: string | null } {
  return { conversation: layout.looks?.conversation ?? null, composer: layout.looks?.composer ?? null, background: layout.background ?? (layout.backgroundImage ? 'image' : null) };
}

/**
 * The Set row's value: "" (None) when all three are the app's own, a set's mod key when the three are exactly that
 * set's parts (a part it lacks is the app's own), "off:<mod key>" when they all come from one mod that is not on
 * (or not installed any more), and "custom" otherwise.
 */
export function currentLookSet(mods: readonly ModInfo[], layout: Pick<ModLayout, 'looks' | 'background' | 'backgroundImage'>): string {
  const now = shown(layout);
  if (!now.conversation && !now.composer && !now.background) return '';
  for (const s of lookSets(mods)) if (s.conversation === now.conversation && s.composer === now.composer && s.background === now.background) return s.key;
  const owners = [now.conversation, now.composer, now.background].filter((r): r is string => !!r).map((r) => (r === 'image' ? '' : refMod(r)));
  const one = owners.every((k) => k && k === owners[0]) ? owners[0] : '';
  if (one && owners.length >= 2 && !lookSets(mods).some((s) => s.key === one)) {
    const m = mods.find((x) => x.key === one);
    if (!m || m.state !== 'on' || !m.manifest) return `off:${one}`;
  }
  return 'custom';
}

/** The layout change that applies a set (null: None, the app's own look everywhere). */
export function lookSetPatch(set: LookSet | null): Pick<ModLayout, 'looks' | 'background'> & { backgroundImage?: null } {
  const patch = { looks: { conversation: set?.conversation ?? null, composer: set?.composer ?? null }, background: set?.background ?? null } as Pick<ModLayout, 'looks' | 'background'> & { backgroundImage?: null };
  // A set without a background (or None) means no background: the user's own picture goes too, as None does in the Background row.
  if (!set?.background) patch.backgroundImage = null;
  return patch;
}

/** Mods that are off and have looks: the Looks group says where to turn them on. */
export function offLookMods(mods: readonly ModInfo[]): string[] {
  return mods.filter((m) => m.state !== 'on' && m.state !== 'invalid' && m.manifest?.contributes?.looks?.length).map((m) => m.manifest?.name ?? m.id);
}

export type ChipTone = 'neutral' | 'warn' | 'danger' | 'ok';

/** The chip after a mod's name when it is not simply on. A warning alone (a look for a region this app lacks) is no problem. */
export function modChip(m: Pick<ModInfo, 'state' | 'problems'>): { label: string; tone: ChipTone } | null {
  if (m.state === 'invalid') return { label: 'Problem', tone: 'danger' };
  if (m.state === 'paused') return { label: 'Paused: wants more access', tone: 'warn' };
  if (m.state === 'off') return { label: 'Off', tone: 'neutral' };
  if (m.problems.some((p) => !p.warning)) return { label: 'Problem', tone: 'danger' };
  return null;
}

export const MOD_GROUPS: { scope: ModInfo['scope']; title: string }[] = [
  { scope: 'bundled', title: 'Built-in' },
  { scope: 'user', title: 'Yours' },
  { scope: 'project', title: 'This project' },
];

/** What turning a mod on (or resuming it) grants, as lines for the confirmation, and the warnings that go with them. */
export function grantSheet(m: Pick<ModInfo, 'state' | 'manifest' | 'wants' | 'wantsStyles' | 'granted'>): { title: string; lines: string[]; warnings: string[] } {
  const resuming = m.state === 'paused';
  const asked = resuming ? m.wants : (m.manifest?.permissions ?? []);
  const lines = asked.map(permissionWords);
  const contributesStyles = !!m.manifest?.contributes?.styles?.length || !!m.manifest?.contributes?.looks?.length || !!m.manifest?.contributes?.views?.some((v) => v.seat === 'background');
  const warnings: string[] = [];
  if (resuming ? m.wantsStyles : contributesStyles) warnings.push('It adds styles, looks or a background, so it can restyle the whole app, approval cards included.');
  if (asked.includes('network')) warnings.push('It can reach the internet, so what it reads can leave this Mac.');
  const name = m.manifest?.name ?? 'This mod';
  return { title: resuming ? `${name} wants more access` : `Turn on ${name}?`, lines, warnings };
}

/** A mod id from its name: "Word count!" → "word-count" (lower-case letters, digits and -, 2 to 40, starts with a letter). */
export function deriveModId(name: string): string {
  let id = normalizeText(name).replace(/ /g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '');
  id = id.slice(0, 40).replace(/-+$/, '');
  return id.length >= 2 ? id : id ? `${id}-mod` : '';
}

export function validModId(id: string): boolean {
  return /^[a-z][a-z0-9-]{1,39}$/.test(id);
}

/** A built-in icon name a manifest may use, else null (an SVG file in the mod is shown as an image instead). */
export function modIconFile(icon: string | undefined): string | null {
  return icon && /\.svg$/i.test(icon) && !icon.includes('..') ? icon : null;
}

// ---------- Configuration files ----------

/** The state chip of a settings.json file. */
export function fileState(f: SettingsFileInfo): { label: string; tone: ChipTone } {
  if (!f.exists) return { label: 'Not found', tone: 'neutral' };
  if (f.error) return { label: 'Could not be read', tone: 'danger' };
  if (f.scope === 'project' && f.changed) return { label: 'Changed since you approved it', tone: 'warn' };
  if (f.scope === 'project' && !f.trusted) return { label: 'Needs your approval', tone: 'warn' };
  if (f.applied) return { label: 'Applied', tone: 'ok' };
  return { label: 'Not applied', tone: 'neutral' };
}

// ---------- Schedules ----------

/** "2026-11-06T09:00" (a datetime-local value) → "2026-11-06T09:00:00-05:00", in the offset that local time has then. */
export function localToIso(value: string, offsetMinutes?: number): Parsed<string> {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!m) return { ok: false, error: 'Pick a date and a time.' };
  const [, y, mo, d, hh, mm, ss] = m;
  const local = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss ?? 0));
  if (Number.isNaN(local.getTime())) return { ok: false, error: 'Pick a date and a time.' };
  const off = offsetMinutes ?? local.getTimezoneOffset();
  const sign = off <= 0 ? '+' : '-';
  const a = Math.abs(off);
  const tz = `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  return { ok: true, value: `${y}-${mo}-${d}T${hh}:${mm}:${ss ?? '00'}${tz}` };
}

/** The rhythm of a new task from the form's fields. */
export function parseWhen(kind: 'at' | 'every' | 'cron', text: string, now = Date.now()): Parsed<ScheduleWhen> {
  if (kind === 'at') {
    const iso = localToIso(text);
    if (!iso.ok) return iso;
    if (new Date(iso.value).getTime() <= now) return { ok: false, error: 'Pick a time in the future.' };
    return { ok: true, value: { kind: 'at', at: iso.value } };
  }
  if (kind === 'every') {
    const n = parseInteger(text, 5, 60 * 24 * 7);
    if (!n.ok) return { ok: false, error: n.error.replace('Must be', 'Minutes must be') };
    return { ok: true, value: { kind: 'every', minutes: n.value } };
  }
  const expr = String(text ?? '').trim().replace(/\s+/g, ' ');
  const fields = expr.split(' ');
  if (fields.length !== 5 || fields.some((f) => !/^[\d*/,\-A-Za-z]+$/.test(f))) return { ok: false, error: 'A cron expression has five fields: minute hour day month weekday, like 0 9 * * 1-5.' };
  return { ok: true, value: { kind: 'cron', expr } };
}

/** "Today at 09:00", "Tomorrow at 14:30", "Nov 6 at 09:00", "Nov 6, 2027 at 09:00" */
export function formatWhenAt(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(d) - dayStart(n)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  if (days === -1) return `Yesterday at ${time}`;
  const month = d.toLocaleString('en-US', { month: 'short' });
  return `${month} ${d.getDate()}${d.getFullYear() !== n.getFullYear() ? `, ${d.getFullYear()}` : ''} at ${time}`;
}

/** "in 3 days", "2 hours ago" for dates in the trash. */
export function relativeDays(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const a = Math.abs(diff);
  const unit = a >= 86_400_000 ? ['day', 86_400_000] : a >= 3_600_000 ? ['hour', 3_600_000] : ['minute', 60_000];
  const v = Math.max(1, Math.round(a / (unit[1] as number)));
  const words = `${v} ${unit[0]}${v === 1 ? '' : 's'}`;
  return diff >= 0 ? `in ${words}` : `${words} ago`;
}

export const LAST_STATUS_WORDS: Record<string, string> = {
  running: 'Running now',
  ok: 'Last run finished',
  error: 'Last run failed',
  stopped: 'Last run was stopped',
  skipped: 'Skipped: the previous run was still going',
  missed: 'Missed: the app was closed',
};
