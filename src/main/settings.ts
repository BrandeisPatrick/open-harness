// A Claude Code-style settings.json layer over the GUI's config.json.
//
//   ~/.openagent/settings.json              user scope
//   <workingDirectory>/.openagent/settings.json   project scope, wins over user
//
// Precedence: defaults < config.json < user settings.json < project settings.json.
// `env` is applied to process.env before anything else is read, so a key can live
// there instead of in plaintext config.json — providers.ts already falls back to
// process.env.PORTKEY_API_KEY. `${VAR}` and `${VAR:-default}` are expanded in every
// string, the same way .mcp.json expands them.
//
// Fields settings.json sets are treated as read-only: saveConfig restores them to
// whatever config.json held (see withoutSettings), so the Settings panel can never
// bake an override — or a secret — into config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../shared/types';
import { expandEnvRefs } from './mcp';

export const USER_SETTINGS = path.join(os.homedir(), '.openagent', 'settings.json');
export const PROJECT_SETTINGS = path.join('.openagent', 'settings.json');

/** The subset of AppConfig a settings file may set, plus `env`. */
export interface Settings {
  env?: Record<string, string>;
  provider?: AppConfig['provider'];
  ollama?: Partial<AppConfig['ollama']>;
  portkey?: Partial<AppConfig['portkey']>;
  workingDirectory?: string;
  permissionMode?: AppConfig['permissionMode'];
  maxTurns?: number;
  sendScreenshotsToModel?: boolean;
  systemPromptExtra?: string;
  theme?: AppConfig['theme'];
  autoTitles?: boolean;
  autoCompact?: boolean;
  notifications?: boolean;
}

/** Scalar AppConfig keys a settings file may set. */
const SCALARS = [
  'provider',
  'workingDirectory',
  'permissionMode',
  'maxTurns',
  'sendScreenshotsToModel',
  'systemPromptExtra',
  'theme',
  'autoTitles',
  'autoCompact',
  'notifications',
] as const;

/** Index-signature view of a typed config object, for the field-by-field copying below. */
const rec = (o: object): Record<string, unknown> => o as unknown as Record<string, unknown>;

/** config.json as it was on disk, before any override — what saves are restored to. */
let baseline: AppConfig | null = null;
/** The union of the settings files that were applied, so we know which fields they own. */
let applied: Settings = {};
/** Files that exist but could not be parsed, surfaced in Settings rather than failing silently. */
let problems: { file: string; error: string }[] = [];

export function settingsProblems(): { file: string; error: string }[] {
  return problems;
}

/** Which files are in effect, for display. */
export function settingsFiles(cwd: string): string[] {
  return [USER_SETTINGS, path.join(cwd, PROJECT_SETTINGS)].filter((f) => fs.existsSync(f));
}

function read(file: string): Settings | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // absent is the normal case
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return parsed as Settings;
  } catch (e) {
    problems.push({ file, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Sets process.env from an `env` block. Later files win, matching Claude Code. */
function applyEnv(s: Settings | null): void {
  if (!s?.env || typeof s.env !== 'object') return;
  for (const [k, v] of Object.entries(s.env)) {
    if (typeof v === 'string') process.env[k] = expandEnvRefs(v);
  }
}

/** Expands `${VAR}` through every string, at any depth. */
function expand<T>(value: T): T {
  if (typeof value === 'string') return expandEnvRefs(value) as unknown as T;
  if (Array.isArray(value)) return value.map(expand) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expand(v);
    return out as T;
  }
  return value;
}

function merge(cfg: AppConfig, s: Settings | null): AppConfig {
  if (!s) return cfg;
  const out: AppConfig = { ...cfg };
  for (const k of SCALARS) {
    if (s[k] !== undefined) rec(out)[k] = s[k];
  }
  if (s.ollama && typeof s.ollama === 'object') out.ollama = { ...cfg.ollama, ...s.ollama };
  if (s.portkey && typeof s.portkey === 'object') out.portkey = { ...cfg.portkey, ...s.portkey };
  return out;
}

/** Records which fields a settings file owns, so withoutSettings can restore them. */
function remember(s: Settings | null): void {
  if (!s) return;
  for (const k of SCALARS) if (s[k] !== undefined) rec(applied)[k] = s[k];
  if (s.ollama) applied.ollama = { ...applied.ollama, ...s.ollama };
  if (s.portkey) applied.portkey = { ...applied.portkey, ...s.portkey };
}

/**
 * Applies the user then project settings files over a config loaded from disk.
 * The project file is looked up under the working directory the earlier layers resolved to.
 */
export function applySettings(fromDisk: AppConfig, opts: { userFile?: string } = {}): AppConfig {
  const userFile = opts.userFile ?? USER_SETTINGS;
  baseline = structuredClone(fromDisk);
  applied = {};
  problems = [];

  const user = read(userFile);
  applyEnv(user);
  let cfg = merge(fromDisk, expand(user));
  remember(user);

  const projectFile = path.join(cfg.workingDirectory, PROJECT_SETTINGS);
  // Guard against a user-scope file whose workingDirectory points back at its own location.
  if (path.resolve(projectFile) !== path.resolve(userFile)) {
    const project = read(projectFile);
    applyEnv(project);
    cfg = merge(cfg, expand(project));
    remember(project);
  }
  return cfg;
}

/**
 * Strips settings-owned fields back to their config.json values, so writing the
 * Settings panel never persists an override. Returns `current` unchanged when no
 * settings file is in play.
 */
export function withoutSettings(current: AppConfig): AppConfig {
  if (!baseline) return current;
  const out: AppConfig = { ...current };
  for (const k of SCALARS) {
    if (applied[k] !== undefined) rec(out)[k] = rec(baseline)[k];
  }
  if (applied.ollama) {
    out.ollama = { ...current.ollama };
    for (const k of Object.keys(applied.ollama)) rec(out.ollama)[k] = rec(baseline.ollama)[k];
  }
  if (applied.portkey) {
    out.portkey = { ...current.portkey };
    for (const k of Object.keys(applied.portkey)) rec(out.portkey)[k] = rec(baseline.portkey)[k];
  }
  return out;
}

/** Field paths settings.json currently owns, e.g. ["portkey.model"]. For the Settings panel. */
export function settingsOwned(): string[] {
  const out: string[] = [];
  for (const k of SCALARS) if (applied[k] !== undefined) out.push(k);
  for (const k of Object.keys(applied.ollama ?? {})) out.push(`ollama.${k}`);
  for (const k of Object.keys(applied.portkey ?? {})) out.push(`portkey.${k}`);
  return out;
}
