// Mods, main-process half: the registry of installed mods, serving their pages on mod://, the lock-down of mod
// frames, the bridge their pages call through the window, and what the agent gets for writing them.
// The core calls setupMods(app) once, after Electron is ready. createMods holds everything that does not need
// Electron itself, so the headless tests can drive it with a fake App.

import fs from 'node:fs';
import path from 'node:path';
import { dialog, protocol, shell } from 'electron';
import type { App } from './app';
import type { ModCaller, ModInfo, ModLayout, ModLookTarget, ModPermission, ModSeat, ModsConfig } from '../shared/mods';
import type { AppConfig } from '../shared/types';
import { configDir, projectConfigDir } from './paths';
import { loadSkills } from './skills';
import { ModRegistry } from './mods/registry';
import { bundledStartsOff, needsStylesApproval, settingFits } from './mods/manifest';
import { BACKGROUND_LABEL, MOD_SCHEME, MOD_SCHEME_PRIVILEGES, resolveModUrl, type ServeContext } from './mods/serve';
import { ModStorage } from './mods/storage';
import { SkillUsageTracker } from './mods/skill-usage';
import { ModBridgeHandler, holds } from './mods/bridge';
import { publicConfig } from './mods/public-config';
import { ModCommands, modCheckTool, modsPrompt } from './mods/assist';
import { ManageError, createMod, customiseMod, installMod } from './mods/manage';
import { installModLockdown } from './mods/lockdown';
import { MOD_EVENT_PERMISSIONS, MOD_LOOK_TARGETS, MOD_METHOD_PERMISSIONS } from './mods/permissions';
import { LOOK_ROOTS, cleanCss, modUrlRewriter, scopeCss } from './mods/css';

export { MOD_SCHEME, MOD_SCHEME_PRIVILEGES };
export { MOD_METHOD_PERMISSIONS } from './mods/permissions';

const STYLE_MAX_BYTES = 500 * 1024;
const REPORT_MAX_CHARS = 2000;
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

/** What the mods code needs from the desktop (Electron in the app; fakes in tests). */
export interface ModsHost {
  /** Moves a folder to the Trash */
  trash(dir: string): Promise<void>;
  reveal(dir: string): void;
  /** The picture the user picked, or null */
  chooseImage(): Promise<string | null>;
}

export interface ModsController {
  registry: ModRegistry;
  storage: ModStorage;
  usage: SkillUsageTracker;
  bridge: ModBridgeHandler;
  commands: ModCommands;
  /** Where mod:// finds things; for the protocol handler */
  serve: ServeContext;
  /** Pushes an event to one mod's views (or every on mod holding the event's permission when `mod` is absent) */
  emit(mod: string | undefined, name: string, data: unknown): void;
  close(): void;
}

function electronHost(app: App): ModsHost {
  return {
    trash: (dir) => shell.trashItem(dir),
    reveal: (dir) => shell.showItemInFolder(path.join(dir, 'mod.json')),
    async chooseImage() {
      const win = app.window();
      const opts: Electron.OpenDialogOptions = { title: 'Choose a background picture', properties: ['openFile'], filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }] };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every region with the app's own look */
export const noLooks = (): Record<ModLookTarget, string | null> => ({ conversation: null, composer: null });

/** The mod key and look id in "<mod key>/<look id>" (a project mod's key holds "/" itself, so the last one splits). */
export function splitRef(ref: string): { key: string; id: string } | null {
  const i = ref.lastIndexOf('/');
  return i > 0 && i < ref.length - 1 ? { key: ref.slice(0, i), id: ref.slice(i + 1) } : null;
}

/** A copy of the mods section to change (never the live one). */
function cloneMods(m: ModsConfig): ModsConfig {
  return {
    enabled: { ...(m.enabled ?? {}) },
    disabledBundled: [...(m.disabledBundled ?? [])],
    settings: { ...(m.settings ?? {}) },
    layout: { ...m.layout, collapsed: [...(m.layout?.collapsed ?? [])], looks: { ...noLooks(), ...(m.layout?.looks ?? {}) } },
    safeMode: !!m.safeMode,
  };
}

export function createMods(app: App, host: ModsHost = electronHost(app)): ModsController {
  const userRoot = () => path.join(configDir(), 'mods');
  const backgroundsDir = path.join(app.userData, 'backgrounds');
  const mods = () => app.config().mods;

  // Late-bound so the registry's first scan can run before the rest exists.
  let ctl: ModsController | null = null;
  const registry = new ModRegistry({
    bundledRoot: path.join(app.appRoot, 'mods'),
    userRoot,
    projectDir: () => app.config().workingDirectory,
    projectRoot: (dir) => path.join(projectConfigDir(dir), 'mods'),
    mods,
    onChange: (list) => {
      app.push('mods:changed', list);
      if (!ctl) return;
      ctl.commands.sync(list);
      for (const key of [...new Set(list.filter((m) => m.state !== 'on').map((m) => m.key))]) ctl.bridge.cancelAll(key);
    },
    onOffer: (info) => app.push('mods:offer', info),
  });

  const emit = (mod: string | undefined, name: string, data: unknown) => {
    if (mod) return app.push('mods:event', { mod, name, data });
    const need = (MOD_EVENT_PERMISSIONS[name] ?? null) as ModPermission | null;
    // Events that need a permission go to each mod that holds it, so a view never receives what it may not see.
    if (!need) return app.push('mods:event', { name, data });
    for (const m of registry.list()) if (holds(m, need)) app.push('mods:event', { mod: m.key, name, data });
  };

  const storage = new ModStorage(path.join(app.userData, 'mods-data'));
  const usage = new SkillUsageTracker({
    file: path.join(app.userData, 'skill-usage.json'),
    skillNames: () => loadSkills(app.config().workingDirectory, app.appRoot).map((s) => s.name),
    onUsed: (name) => emit(undefined, 'skills.used', { name }),
  });
  const bridge = new ModBridgeHandler({ app, registry, storage, usage, emit: (mod, name, data) => emit(mod, name, data) });
  const commands = new ModCommands(
    (cmd) => app.commands.register(cmd),
    (mod, data) => emit(mod, 'command', data),
  );
  const serve: ServeContext = {
    lookup: (label) => {
      const m = registry.byLabel(label);
      return m && m.state === 'on' ? { dir: m.dir, network: m.granted.includes('network') } : null;
    },
    harnessDir: path.join(app.appRoot, 'modkit'),
    backgroundsDir,
  };
  const disposers: (() => void)[] = [];

  // ---------- Config ----------

  const change = (fn: (m: ModsConfig, cfg: AppConfig) => void): AppConfig =>
    app.updateConfig((cur) => {
      const next = cloneMods(cur.mods);
      fn(next, cur);
      return { ...cur, mods: next };
    });

  const must = (key: unknown): ModInfo => {
    const m = registry.get(String(key));
    if (!m) throw new Error(`No mod ${String(key)}.`);
    return m;
  };

  disposers.push(
    app.onConfig((next, prev) => {
      if (next.workingDirectory !== prev.workingDirectory) {
        registry.rewatch();
        registry.scan();
      } else if (JSON.stringify(next.mods) !== JSON.stringify(prev.mods)) registry.recompute();
      const cwd = app.runtime.list().find((m) => m.id === app.runtime.foregroundId())?.cwd;
      const a = publicConfig(next, cwd);
      if (JSON.stringify(a) !== JSON.stringify(publicConfig(prev, cwd))) emit(undefined, 'config.changed', a);
    }),
  );

  // ---------- What the window calls ----------

  const h = app.rpc.handle.bind(app.rpc);
  disposers.push(
    h('mods.list', () => registry.list()),
    h('mods.permissions', () => ({ methods: { ...MOD_METHOD_PERMISSIONS }, events: { ...MOD_EVENT_PERMISSIONS } })),
    h('mods.setEnabled', (key, on) => {
      const m = must(key);
      if (on && !m.manifest) throw new Error(`${m.id} has no valid mod.json, so it cannot be turned on. ${m.problems[0]?.message ?? ''}`.trim());
      change((c) => {
        if (m.scope === 'bundled') {
          c.disabledBundled = c.disabledBundled.filter((id) => id !== m.id);
          if (bundledStartsOff(m.manifest)) {
            if (on) c.enabled[m.key] = { permissions: [...(m.manifest?.permissions ?? [])], styles: true, at: Date.now() };
            else delete c.enabled[m.key];
          } else if (!on) c.disabledBundled.push(m.id);
        } else if (on) {
          // Turning on grants exactly what the manifest asks for now (which also resumes a paused mod).
          c.enabled[m.key] = { permissions: [...(m.manifest!.permissions ?? [])], styles: needsStylesApproval(m.manifest), at: Date.now() };
        } else delete c.enabled[m.key];
      });
      registry.recompute();
      registry.markOffered();
      return registry.list();
    }),
    h('mods.setSetting', (key, setting, value) => {
      const m = must(key);
      const field = m.manifest?.contributes?.settings?.find((f) => f.key === setting);
      if (!field) throw new Error(`${m.id} has no setting ${String(setting)}.`);
      if (!settingFits(field, value)) {
        const want = field.type === 'select' ? `one of ${field.options.join(', ')}` : field.type === 'number' ? `a number${field.min !== undefined ? ` from ${field.min}` : ''}${field.max !== undefined ? ` to ${field.max}` : ''}` : `a ${field.type}`;
        throw new Error(`${field.key}: must be ${want}.`);
      }
      change((c) => {
        c.settings[m.key] = { ...(c.settings[m.key] ?? {}), [field.key]: value };
      });
      registry.recompute();
      const after = registry.get(m.key);
      if (after) emit(m.key, 'settings.changed', after.settings);
      return registry.list();
    }),
    h('mods.setLayout', (patch) => {
      const layout = checkLayout(patch, backgroundsDir);
      return change((c) => {
        // looks is merged region by region: { looks: { conversation: … } } leaves the chat bar's look as it is.
        c.layout = { ...c.layout, ...layout, looks: { ...noLooks(), ...c.layout.looks, ...(layout.looks ?? {}) } };
      }).mods.layout;
    }),
    h('mods.setSafeMode', (on) => {
      change((c) => {
        c.safeMode = !!on;
      });
      registry.recompute();
      registry.markOffered();
      return registry.list();
    }),
    h('mods.reload', () => registry.scan()),
    h('mods.customise', (key) => {
      const m = must(key);
      if (m.scope !== 'bundled') throw new Error(`${m.id} is not a bundled mod; edit its folder directly (${m.dir}).`);
      customiseMod(m.dir, userRoot(), m.id);
      // The copy replaces a panel the user had on, so it starts on with the same grant rather than vanishing.
      if (m.state === 'on' && m.manifest) {
        change((c) => {
          c.enabled[m.id] = { permissions: [...(m.manifest!.permissions ?? [])], styles: needsStylesApproval(m.manifest), at: Date.now() };
        });
      }
      registry.scan();
      registry.markOffered();
      return registry.list();
    }),
    h('mods.create', (input) => {
      if (!isObj(input)) throw new Error('mods.create needs { id, name, seat, scope }.');
      const scope = input.scope === 'project' ? 'project' : 'user';
      const root = scope === 'project' ? path.join(projectConfigDir(app.config().workingDirectory), 'mods') : userRoot();
      const id = String(input.id ?? '');
      if (registry.list().some((m) => m.id === id && (m.scope === scope || (scope === 'user' && m.scope === 'bundled')))) throw new ManageError(`A mod with the id "${id}" already exists.`);
      createMod(root, { id, name: input.name, seat: input.seat as ModSeat, look: input.look as ModLookTarget | undefined });
      registry.scan();
      const made = registry.list().find((m) => m.id === id && m.scope === scope);
      if (!made) throw new Error('The starter mod was written but could not be read back.');
      return made;
    }),
    h('mods.install', async (source) => {
      const taken = (id: string) => registry.list().some((m) => m.id === id && (m.scope === 'user' || m.scope === 'bundled'));
      const dir = await installMod(userRoot(), String(source ?? ''), taken);
      registry.scan();
      const made = registry.list().find((m) => m.dir === dir);
      if (!made) throw new Error('The mod was installed but could not be read back.');
      return made;
    }),
    h('mods.remove', async (key) => {
      const m = must(key);
      if (m.scope !== 'user') throw new Error(m.scope === 'bundled' ? 'Bundled mods cannot be removed; turn it off instead.' : `Project mods belong to the project; delete ${m.dir} there.`);
      await host.trash(m.dir);
      change((c) => {
        delete c.enabled[m.key];
        delete c.settings[m.key];
      });
      registry.scan();
      return registry.list();
    }),
    h('mods.reveal', (key) => host.reveal(must(key).dir)),
    h('mods.chooseBackgroundImage', async () => {
      const picked = await host.chooseImage();
      if (!picked) return app.config().mods.layout;
      const ext = path.extname(picked).toLowerCase().replace('.', '');
      if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error('Choose a PNG, JPEG, WebP or GIF picture.');
      fs.mkdirSync(backgroundsDir, { recursive: true });
      const name = `${Date.now()}-${path.basename(picked, path.extname(picked)).replace(/[^\w-]+/g, '_').slice(0, 60) || 'background'}.${ext}`;
      const dest = path.join(backgroundsDir, name);
      fs.copyFileSync(picked, dest);
      return change((c) => {
        c.layout.backgroundImage = dest;
        c.layout.background = null;
      }).mods.layout;
    }),
    h('mods.call', (caller, method, params) => bridge.call(caller, method, params)),
    h('mods.report', (caller: ModCaller, problem) => {
      const m = registry.get(String(caller?.mod));
      if (!m || !isObj(problem)) return;
      const message = String(problem.message ?? 'Unknown error').slice(0, REPORT_MAX_CHARS);
      const stack = typeof problem.stack === 'string' ? problem.stack.split('\n').slice(0, 6).join('\n').slice(0, REPORT_MAX_CHARS) : '';
      registry.report(m.key, { message: stack && !stack.includes(message) ? `${message}\n${stack}` : stack || message, view: typeof caller.view === 'string' ? caller.view : undefined, at: Date.now() });
    }),
    h('mods.styles', () => {
      const out: { key: string; css: string }[] = [];
      for (const m of registry.list()) {
        if (m.state !== 'on') continue;
        const parts: string[] = [];
        for (const rel of m.manifest?.contributes?.styles ?? []) {
          const css = readStyle(m, rel);
          if (css !== null) parts.push(`/* ${m.id}/${rel} */\n${cleanCss(css, { url: modUrlRewriter(m.origin, rel) })}`);
        }
        if (parts.length) out.push({ key: m.key, css: parts.join('\n') });
      }
      return out;
    }),
    h('mods.looks', () => activeLooks()),
  );

  // ---------- Styles and looks ----------

  /** A CSS file of an on mod, as text (null when it is not there any more) */
  function readStyle(m: ModInfo, rel: string): string | null {
    const r = resolveModUrl(`${m.origin}/${rel.split('/').map(encodeURIComponent).join('/')}`, serve);
    if (!r.file) return null;
    try {
      return fs.readFileSync(r.file).subarray(0, STYLE_MAX_BYTES).toString('utf8');
    } catch {
      return null; // gone since the scan
    }
  }

  /** The look the layout names for each region, when its mod is on and has that look for that region, scoped to the region. */
  function activeLooks(): { target: ModLookTarget; ref: string; mod: string; css: string }[] {
    const chosen = app.config().mods.layout.looks ?? noLooks();
    const out: { target: ModLookTarget; ref: string; mod: string; css: string }[] = [];
    for (const target of MOD_LOOK_TARGETS) {
      const ref = chosen[target];
      const at = ref ? splitRef(ref) : null;
      const m = at ? registry.get(at.key) : undefined;
      const look = m?.state === 'on' ? m.manifest?.contributes?.looks?.find((l) => l.id === at!.id && l.target === target) : undefined;
      if (!m || !look || !ref) continue;
      const parts: string[] = [];
      for (const rel of look.styles) {
        const css = readStyle(m, rel);
        if (css !== null) parts.push(`/* ${m.id}/${rel} */\n${scopeCss(css, LOOK_ROOTS[target], { url: modUrlRewriter(m.origin, rel) })}`);
      }
      out.push({ target, ref, mod: m.key, css: parts.join('\n') });
    }
    return out;
  }

  // ---------- For the agent ----------

  disposers.push(app.tools.register({ ...modCheckTool(registry, () => app.config().mods.layout.looks ?? noLooks()), optional: true }));
  disposers.push(app.prompt.add('mods', () => modsPrompt(registry.list()), { optional: true }));
  disposers.push(app.provide('skill-usage', usage));
  disposers.push(app.events.on((sessionId, ev) => usage.handle(sessionId, ev)));

  ctl = {
    registry,
    storage,
    usage,
    bridge,
    commands,
    serve,
    emit,
    close() {
      registry.close();
      bridge.cancelAll();
      commands.dispose();
      storage.flush();
      usage.flush();
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch {
          /* already gone */
        }
      }
    },
  };
  registry.scan();
  commands.sync(registry.list());
  registry.watch();
  app.onQuit(() => ctl?.close());
  return ctl;
}

/** Validates a layout patch from the window (unknown fields are dropped). */
export function checkLayout(patch: unknown, backgroundsDir: string): Partial<ModLayout> {
  if (!isObj(patch)) throw new Error('The layout change must be an object.');
  const out: Partial<ModLayout> = {};
  if ('railOpen' in patch) out.railOpen = !!patch.railOpen;
  if ('railWidth' in patch) {
    const w = Number(patch.railWidth);
    if (!Number.isFinite(w)) throw new Error('railWidth must be a number.');
    out.railWidth = Math.round(Math.min(480, Math.max(240, w)));
  }
  if ('collapsed' in patch) {
    if (!Array.isArray(patch.collapsed) || patch.collapsed.some((c) => typeof c !== 'string')) throw new Error('collapsed must be a list of "<mod key>/<view id>".');
    out.collapsed = [...new Set(patch.collapsed as string[])].slice(0, 500);
  }
  if ('background' in patch) {
    if (patch.background !== null && typeof patch.background !== 'string') throw new Error('background must be "<mod key>/<view id>" or null.');
    out.background = patch.background as string | null;
  }
  if ('backgroundImage' in patch) {
    const p = patch.backgroundImage;
    // Only a picture chooseBackgroundImage copied in (the window cannot point the app at an arbitrary file).
    if (p !== null && (typeof p !== 'string' || path.dirname(path.resolve(p)) !== path.resolve(backgroundsDir) || !fs.existsSync(p))) throw new Error('backgroundImage must be null or a picture chosen with chooseBackgroundImage.');
    out.backgroundImage = p as string | null;
  }
  if ('looks' in patch) {
    const l = patch.looks;
    if (!isObj(l)) throw new Error('looks must be an object, e.g. { "conversation": "<mod key>/<look id>" }.');
    const looks: Partial<Record<ModLookTarget, string | null>> = {};
    for (const [target, ref] of Object.entries(l)) {
      // A region this app does not know is ignored, like an unknown field.
      if (!(MOD_LOOK_TARGETS as readonly string[]).includes(target)) continue;
      if (ref !== null && (typeof ref !== 'string' || !splitRef(ref))) throw new Error(`looks.${target} must be "<mod key>/<look id>" or null.`);
      looks[target as ModLookTarget] = ref as string | null;
    }
    out.looks = looks as Record<ModLookTarget, string | null>;
  }
  if ('backgroundDim' in patch) {
    const d = Number(patch.backgroundDim);
    if (!Number.isFinite(d)) throw new Error('backgroundDim must be a number from 0 to 1.');
    out.backgroundDim = Math.min(1, Math.max(0, d));
  }
  return out;
}

/** The URL of the user's own background picture for the window */
export function backgroundUrl(file: string): string {
  return `${MOD_SCHEME}://${BACKGROUND_LABEL}/${encodeURIComponent(path.basename(file))}`;
}

/** Serves mod:// from `ctx` (registered with protocol.handle). Exported for the live test. */
export async function serveModRequest(req: Request, ctx: ServeContext): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });
  const r = resolveModUrl(req.url, ctx);
  if (r.status !== 200 || !r.file) return new Response('Not found', { status: r.status, headers: r.headers });
  try {
    const body = req.method === 'HEAD' ? null : await fs.promises.readFile(r.file);
    return new Response(body, { status: 200, headers: r.headers });
  } catch {
    return new Response('Not found', { status: 404, headers: r.headers });
  }
}

/** Called once by the core after Electron is ready. */
export function setupMods(app: App): ModsController {
  const ctl = createMods(app);
  protocol.handle(MOD_SCHEME, (req) => serveModRequest(req, ctl.serve));
  const unlock = installModLockdown({
    windows: () => [app.window()],
    networkAllowed: (label) => !!ctl.serve.lookup(label)?.network,
  });
  app.onQuit(() => {
    unlock();
    protocol.unhandle(MOD_SCHEME);
  });
  return ctl;
}
