import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, PermissionMode } from '../shared/types';
import { applySettings, withoutSettings } from './settings';

/** Bumped when stored values change meaning: v2 renamed the old "auto" (run everything) to "bypass" and "readonly" to "plan". */
const SCHEMA_VERSION = 2;
const MODES: PermissionMode[] = ['ask', 'acceptEdits', 'auto', 'plan', 'bypass'];

export function defaultConfig(): AppConfig {
  return {
    provider: 'ollama',
    ollama: {
      baseURL: process.env.OLLAMA_HOST ? normalizeOllamaHost(process.env.OLLAMA_HOST) : 'http://localhost:11434/v1',
      model: 'qwen3:8b',
      numCtx: 16384,
      think: 'auto',
    },
    portkey: {
      baseURL: 'https://api.portkey.ai/v1',
      apiKey: '',
      model: '@openai/gpt-4o-mini',
      virtualKey: '',
      provider: '',
      providerApiKey: '',
      configId: '',
      contextWindow: 128000,
    },
    workingDirectory: os.homedir(),
    permissionMode: 'ask',
    autoApprove: false,
    maxTurns: 40,
    sendScreenshotsToModel: false,
    systemPromptExtra: '',
    theme: 'system',
    autoTitles: true,
    mcpServers: {},
    mcpTrusted: {},
    autoCompact: true,
    notifications: true,
    allowRules: {},
    recentDirs: [],
    keepAwake: 'running',
    compactThreshold: 0.8,
    pruneToolResults: true,
    toolSet: 'auto',
    historyTrashDays: 30,
    mods: {
      enabled: {},
      disabledBundled: [],
      settings: {},
      layout: { railOpen: true, railWidth: 300, collapsed: [], background: null, backgroundImage: null, backgroundDim: 0.82, looks: { conversation: null, composer: null } },
      safeMode: false,
    },
    remote: { enabled: false, bind: 'lan', port: 0 },
    settingsTrusted: {},
  };
}

const MAX_RECENT = 8;

/**
 * The recent list with `dir` first, then the folder just left, then the others; the home folder and folders that no
 * longer exist are dropped, duplicates removed, at most MAX_RECENT kept.
 */
export function withRecentDir(list: string[] | undefined, dir: string, previous?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [dir, previous ?? '', ...(list ?? [])]) {
    if (!d || seen.has(d) || d === os.homedir()) continue;
    seen.add(d);
    try {
      if (fs.statSync(d).isDirectory()) out.push(d);
    } catch {
      /* gone */
    }
  }
  return out.slice(0, MAX_RECENT);
}

function isRecord(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The mods section of a stored config over the defaults: an older file has none of it, a hand-edited one part of it. */
function modsSection(d: AppConfig['mods'], raw: unknown): AppConfig['mods'] {
  const m = isRecord(raw) ? raw : {};
  const layout = isRecord(m.layout) ? m.layout : {};
  const looks = isRecord(layout.looks) ? layout.looks : {};
  const ref = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    ...d,
    ...m,
    layout: { ...d.layout, ...layout, looks: { conversation: ref(looks.conversation), composer: ref(looks.composer) } },
  } as AppConfig['mods'];
}

function normalizeOllamaHost(host: string): string {
  let h = host.trim();
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, '') + '/v1';
}

export function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

/** Maps a stored mode (any version) to a current one. */
export function migrateMode(raw: unknown, autoApprove: unknown, schemaVersion: number): PermissionMode {
  let mode = typeof raw === 'string' ? raw : autoApprove ? 'bypass' : 'ask';
  if (mode === 'readonly') mode = 'plan';
  if (schemaVersion < SCHEMA_VERSION && mode === 'auto') mode = 'bypass'; // "auto" used to mean "run everything"
  return (MODES as string[]).includes(mode) ? (mode as PermissionMode) : 'ask';
}

/** config.json on its own, before any settings.json layer. */
function storedConfig(): AppConfig {
  const d = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<AppConfig> & { schemaVersion?: number };
    const version = Number(raw.schemaVersion) || 1;
    delete raw.schemaVersion;
    return normalizeConfig({
      ...d,
      ...raw,
      permissionMode: migrateMode(raw.permissionMode, raw.autoApprove, version),
      // Settings files written before generated titles existed have no flag: on by default.
      autoTitles: raw.autoTitles ?? d.autoTitles,
      autoCompact: raw.autoCompact ?? d.autoCompact,
      notifications: raw.notifications ?? d.notifications,
      allowRules: raw.allowRules && typeof raw.allowRules === 'object' && !Array.isArray(raw.allowRules) ? raw.allowRules : {},
      recentDirs: Array.isArray(raw.recentDirs) ? raw.recentDirs.filter((d): d is string => typeof d === 'string') : [],
      mcpServers: raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? raw.mcpServers : {},
      mcpTrusted: raw.mcpTrusted && typeof raw.mcpTrusted === 'object' && !Array.isArray(raw.mcpTrusted) ? raw.mcpTrusted : {},
      ollama: { ...d.ollama, ...(raw.ollama ?? {}) },
      portkey: { ...d.portkey, ...(raw.portkey ?? {}) },
      // Sections added after 0.1: an older file has none of them, a hand-edited one may have part of one.
      mods: modsSection(d.mods, raw.mods),
      remote: { ...d.remote, ...(isRecord(raw.remote) ? raw.remote : {}) },
      settingsTrusted: isRecord(raw.settingsTrusted) ? (raw.settingsTrusted as Record<string, string>) : {},
    });
  } catch {
    return d;
  }
}

/**
 * config.json with the user's settings.json and then the project's (when trusted) applied over it, at launch.
 * Afterwards settings-service.ts recomputes the layer; saveConfig restores the fields a file owns before writing,
 * so neither the Settings panel nor a recompute can bake an override into config.json.
 */
export function loadConfig(): AppConfig {
  return normalizeConfig(applySettings(storedConfig()));
}

/** Keeps the legacy autoApprove flag consistent with permissionMode, and autoTitles a boolean (default on). */
export function normalizeConfig(cfg: AppConfig): AppConfig {
  const mode: PermissionMode = (MODES as string[]).includes(cfg.permissionMode) ? cfg.permissionMode : 'ask';
  return { ...cfg, permissionMode: mode, autoApprove: mode === 'bypass', autoTitles: cfg.autoTitles !== false };
}

export function saveConfig(cfg: AppConfig): void {
  const stored = withoutSettings(cfg);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ ...stored, schemaVersion: SCHEMA_VERSION }, null, 2));
}
