// The window side of the mod system: the seats (the rail, mod tabs in the side pane, the composer strip, the
// background), the CSS mods inject, the bridge every mod frame talks through, and the card that turns a new mod on.
// docs/mods.md is the protocol; the main process (src/main/mods.ts) owns discovery, permissions and storage. The
// frame a message comes from (event.source) says which mod and view is asking, never the message itself.

import type { AgentEvent, AppConfig, SessionMeta } from '../shared/types';
import type { ModInfo, ModLayout, ModRpcRequest, ModSeat, ModTheme, ModCaller } from '../shared/mods';
import { bus } from './bus.js';
import { onPush, rpc } from './rpc.js';
import { escapeHtml, writeClipboard } from './dom.js';
import { icon, isIconName, type IconName } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { closeMenu, openMenu, type MenuSection } from './popover.js';
import { appendTranscriptItem, registerTranscriptItem } from './transcript-items.js';
import {
  ERR,
  HELLO_TIMEOUT_MS,
  RAIL_DEFAULT,
  activeBackground,
  askLines,
  buildHello,
  clampRailWidth,
  eventsFromAgent,
  frameHeight,
  frameSrc,
  iconSource,
  isHttpUrl,
  isWindowMethod,
  mayReceive,
  methodNeeds,
  modSignature,
  relatedSignature,
  sessionSignature,
  setCollapsed,
  shortDir,
  subscribeMissing,
  toModSession,
  viewKey,
  viewsFor,
  type PermissionTable,
  type ViewRef,
} from './mods/logic.js';

/** What the host needs from the rest of the window (renderer.ts passes these in). */
export interface ModsHostDeps {
  currentSessionId(): string;
  sessions(): SessionMeta[];
  config(): AppConfig | undefined;
  /** Whether the session on screen is running (the window knows best) */
  running(): boolean;
  toast(text: string, kind: 'info' | 'error'): void;
  /** Puts text into the composer at the caret */
  insertText(text: string): void;
  openSettings(section?: string): void;
  switchSession(id: string): Promise<void>;
  newSession(): Promise<void>;
  openLightbox(src: string, name?: string, caption?: string): void;
  /** Shows the side pane on a tab: 'browser', 'diff', 'terminal' or 'mod:<view key>' */
  showPane(tab: string): void;
  /** The mod tabs changed (one appeared or went away): re-apply the pane */
  paneTabsChanged(): void;
  /** The rail opened, closed or changed width: keep the side pane and the native browser view where they belong */
  paneLayoutChanged(): void;
  /** Shows or hides the native browser view as the pane and the dialogs say */
  syncBrowserView(): void;
  /** For __oc_debug.mods.browser(): what was last sent to the native browser view */
  browserDebug(): unknown;
}

/** What renderer.ts's side-pane code asks the host. */
export interface ModPaneTabs {
  /** The mod tab buttons in strip order, after Browser, Diff and Terminal */
  buttons(): { key: string; el: HTMLButtonElement }[];
  has(key: string): boolean;
  /** Which mod tab is in front (null: a built-in one or none) and whether the pane shows at all */
  apply(active: string | null, paneVisible: boolean): void;
}

export interface ModsHost {
  pane: ModPaneTabs;
}

// ---------- Frames and the places they sit ----------

interface Frame {
  id: number;
  slot: Slot;
  iframe: HTMLIFrameElement;
  /** When it said hello (0: not yet) */
  helloAt: number;
  subs: Set<string>;
  timer: number | undefined;
  /** The rev it was made for */
  sig: string;
  /** Last visibility sent (or told in hello) */
  visible: boolean;
}

interface Slot {
  ref: ViewRef;
  seat: ModSeat;
  /** The section, the tab panel, the strip row or the background layer's child */
  el: HTMLElement;
  /** Where the iframe goes */
  body: HTMLElement;
  frame: Frame | null;
  /** A reload in progress: the new frame, shown once it said hello and reported its size */
  next: Frame | null;
  title: string;
  badge: string | null;
  height: number;
  failedEl: HTMLElement | null;
  /** Events waiting for the view to subscribe (a command that opened it) */
  queued: { name: string; data: unknown; at: number }[];
  // rail
  head?: HTMLButtonElement;
  titleEl?: HTMLElement;
  badgeEl?: HTMLElement;
  // tab
  tabBtn?: HTMLButtonElement;
}

interface LogEntry {
  t: number;
  view: string;
  kind: 'request' | 'response' | 'error' | 'event' | 'ignored';
  method: string;
  id?: number | string;
  error?: { code: number; message: string };
}

const LOG_MAX = 400;
const SWAP_FALLBACK_MS = 600;

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

class BridgeError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}
const bad = (message: string) => new BridgeError(ERR.badParams, message);

export function createModsHost(deps: ModsHostDeps): ModsHost {
  const rail = $('mod-rail');
  const railSections = $('mod-rail-sections');
  const railEdge = $('mod-rail-edge');
  const railToggle = $<HTMLButtonElement>('rail-toggle');
  const moreBtn = $<HTMLButtonElement>('mods-more');
  const strip = $('mod-strip');
  const bgLayer = $('mod-background');
  const sidePane = $('side-pane');
  const shellEl = document.querySelector<HTMLElement>('.shell');
  const paneTabs = sidePane?.querySelector<HTMLElement>('.pane-tabs') ?? null;
  const paneSpacer = paneTabs?.querySelector<HTMLElement>(':scope > .spacer') ?? null;

  let mods: ModInfo[] = [];
  let methodPerms: PermissionTable = {};
  let eventPerms: PermissionTable = {};
  let appInfo = { name: 'OpenAgent', version: 'unknown' };
  let ready = false;
  const readyWaiters: (() => void)[] = [];
  const whenReady = () => (ready ? Promise.resolve() : new Promise<void>((r) => readyWaiters.push(r)));

  const slots = new Map<string, Slot>(); // view key → slot (rail, tab, composer, background)
  const sigs = new Map<string, string>(); // mod key → modSignature of what its frames show
  let nextFrameId = 1;
  const log: LogEntry[] = [];
  const note = (e: LogEntry) => {
    log.push(e);
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  };

  // ---------- Layout (config.mods.layout, written with mods.setLayout) ----------

  const fallbackLayout = (): ModLayout => ({ railOpen: true, railWidth: RAIL_DEFAULT, collapsed: [], background: null, backgroundImage: null, backgroundDim: 0.82 });
  let layout: ModLayout = { ...fallbackLayout(), ...(deps.config()?.mods?.layout ?? {}) };
  let writing = 0;
  let widthTimer: number | undefined;

  function saveLayout(patch: Partial<ModLayout>): void {
    layout = { ...layout, ...patch };
    writing++;
    rpc('mods.setLayout', patch)
      .catch((err: unknown) => console.warn('[mods] could not save the layout:', err))
      .finally(() => {
        writing--;
      });
  }

  bus.on('config', (cfg) => {
    const next = cfg?.mods?.layout;
    if (next && !writing) {
      const before = JSON.stringify(layout);
      layout = { ...fallbackLayout(), ...next, collapsed: [...(next.collapsed ?? [])] };
      if (JSON.stringify(layout) !== before) {
        applyRail();
        syncBackground();
      }
    }
    syncTheme();
  });

  // ---------- Theme: the scheme in effect and the app's tokens as they are now ----------

  let tokenNames: string[] | null = null;
  function collectTokenNames(): string[] {
    const names = new Set<string>();
    const walk = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule) {
          if (!/:root|html/.test(r.selectorText)) continue;
          for (let i = 0; i < r.style.length; i++) {
            const p = r.style.item(i);
            if (p.startsWith('--') && !p.startsWith('--mod-') && !p.startsWith('--spin')) names.add(p);
          }
        } else if ('cssRules' in r) {
          try {
            walk((r as CSSGroupingRule).cssRules);
          } catch {
            /* not readable */
          }
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        /* a sheet we may not read */
      }
    }
    return [...names].sort();
  }

  function currentTheme(): ModTheme {
    const root = document.documentElement;
    const set = root.dataset.theme;
    const scheme: 'light' | 'dark' = set === 'dark' || set === 'light' ? set : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    tokenNames ??= collectTokenNames();
    const cs = getComputedStyle(root);
    const tokens: Record<string, string> = {};
    for (const n of tokenNames) {
      const v = cs.getPropertyValue(n).trim();
      if (v) tokens[n] = v;
    }
    return { scheme, tokens };
  }

  let lastTheme = '';
  function syncTheme(force = false): void {
    if (!ready) return;
    const theme = currentTheme();
    const s = JSON.stringify(theme);
    if (s === lastTheme && !force) return;
    lastTheme = s;
    deliver('theme.changed', theme);
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => syncTheme());
  new MutationObserver(() => syncTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------- Styles from mods ----------

  let stylesSeq = 0;
  async function syncStyles(): Promise<void> {
    const my = ++stylesSeq;
    let list: { key: string; css: string }[] = [];
    try {
      list = await rpc('mods.styles');
    } catch {
      list = [];
    }
    if (my !== stylesSeq || !Array.isArray(list)) return;
    const existing = new Map<string, HTMLStyleElement>();
    document.head.querySelectorAll<HTMLStyleElement>('style[data-mod]').forEach((el) => existing.set(el.dataset.mod ?? '', el));
    let changed = false;
    for (const { key, css } of list) {
      let el = existing.get(key);
      existing.delete(key);
      if (!el) {
        el = document.createElement('style');
        el.dataset.mod = key;
        changed = true;
      }
      if (el.textContent !== css) {
        el.textContent = css;
        changed = true;
      }
      // In load order, after everything the app ships (appendChild moves an element that is already there).
      if (document.head.lastElementChild !== el || !el.isConnected) document.head.appendChild(el);
    }
    for (const el of existing.values()) {
      el.remove();
      changed = true;
    }
    if (changed) {
      tokenNames = null;
      syncTheme();
    }
  }

  // ---------- The bridge ----------

  function caller(f: Frame): ModCaller {
    return { mod: f.slot.ref.mod.key, view: f.slot.ref.view.id };
  }

  function post(f: Frame, msg: unknown): void {
    try {
      f.iframe.contentWindow?.postMessage(msg, '*');
    } catch {
      /* the frame went away */
    }
  }

  function frames(): Frame[] {
    const out: Frame[] = [];
    for (const s of slots.values()) {
      if (s.frame) out.push(s.frame);
      if (s.next) out.push(s.next);
    }
    return out;
  }

  function frameOf(source: MessageEventSource | null): Frame | null {
    if (!source) return null;
    for (const f of frames()) if (f.iframe.contentWindow === source) return f;
    return null;
  }

  /** Sends an event to every view that subscribed and may receive it (only `modKey`'s views when given). */
  function deliver(name: string, data: unknown, modKey?: string): void {
    for (const f of frames()) {
      if (modKey && f.slot.ref.mod.key !== modKey) continue;
      sendEvent(f, name, data);
    }
  }

  function sendEvent(f: Frame, name: string, data: unknown): boolean {
    if (!f.helloAt || !f.subs.has(name) || !mayReceive(eventPerms, f.slot.ref.mod, name)) return false;
    note({ t: Date.now(), view: f.slot.ref.key, kind: 'event', method: name });
    post(f, { jsonrpc: '2.0', method: 'event', params: { name, data } });
    return true;
  }

  window.addEventListener('message', (e: MessageEvent) => {
    const f = frameOf(e.source);
    if (!f) {
      // Not a frame this window made: ignored (noted for the live checks when it looks like the protocol).
      const d = e.data as { jsonrpc?: unknown; method?: unknown } | null;
      if (isObj(d) && d.jsonrpc === '2.0') note({ t: Date.now(), view: '(unknown frame)', kind: 'ignored', method: typeof d.method === 'string' ? d.method : '' });
      return;
    }
    const m = e.data as ModRpcRequest | null;
    if (!isObj(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string' || m.method === 'event') return;
    if (m.id === undefined || m.id === null || (typeof m.id !== 'number' && typeof m.id !== 'string')) return;
    void answer(f, m);
  });

  async function answer(f: Frame, m: ModRpcRequest): Promise<void> {
    const view = f.slot.ref.key;
    note({ t: Date.now(), view, kind: 'request', method: m.method, id: m.id });
    let reply: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      await whenReady();
      reply = { result: await handle(f, m.method, m.params) };
      if (reply.result === undefined) reply.result = null;
    } catch (err) {
      reply = err instanceof BridgeError ? { error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } } : { error: { code: ERR.other, message: err instanceof Error ? err.message : String(err) } };
    }
    if (reply.error) note({ t: Date.now(), view, kind: 'error', method: m.method, id: m.id, error: { code: reply.error.code, message: reply.error.message } });
    else note({ t: Date.now(), view, kind: 'response', method: m.method, id: m.id });
    post(f, { jsonrpc: '2.0', id: m.id, ...reply });
  }

  async function handle(f: Frame, method: string, raw: unknown): Promise<unknown> {
    const mod = currentMod(f.slot.ref.mod.key) ?? f.slot.ref.mod;
    if (raw !== undefined && raw !== null && !isObj(raw)) throw bad('params: must be an object');
    const p = (raw ?? {}) as Record<string, unknown>;
    const need = methodNeeds(methodPerms, method);
    if (need === undefined) throw new BridgeError(ERR.unknownMethod, `Unknown method ${method}.`);
    if (mod.state !== 'on') throw new BridgeError(ERR.unavailable, `The mod ${mod.id} is not on.`);
    if (need && !mod.granted.includes(need)) throw new BridgeError(ERR.permission, `${method} needs the ${need} permission; add it to "permissions" in mod.json.`, { permission: need });
    if (!isWindowMethod(method)) {
      const r = await rpc('mods.call', caller(f), method, p);
      if (r && r.error) throw new BridgeError(r.error.code, r.error.message, r.error.data);
      return r?.result ?? null;
    }
    const str = (k: string, max = 100_000): string => {
      const v = p[k];
      if (typeof v !== 'string') throw bad(`${k}: must be a string`);
      if (v.length > max) throw bad(`${k}: at most ${max} characters`);
      return v;
    };
    switch (method) {
      case 'hello': {
        if (p.protocol !== 1) throw bad(`This app speaks mod protocol 1, not ${String(p.protocol)}.`);
        sayHello(f);
        return buildHello(mod, f.slot.ref.view, appInfo, currentTheme(), f.visible);
      }
      case 'events.subscribe':
      case 'events.unsubscribe': {
        const names = p.events;
        if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) throw bad('events: must be a list of event names');
        if (method === 'events.unsubscribe') {
          for (const n of names as string[]) f.subs.delete(n);
          return null;
        }
        const missing = subscribeMissing(eventPerms, mod, names as string[]);
        if (missing) throw new BridgeError(ERR.permission, `Receiving these events needs the ${missing} permission; add it to "permissions" in mod.json.`, { permission: missing });
        for (const n of names as string[]) f.subs.add(n);
        flushQueued(f);
        return null;
      }
      case 'log.error': {
        const message = str('message', 4000);
        const stack = typeof p.stack === 'string' ? p.stack.slice(0, 4000) : undefined;
        void rpc('mods.report', caller(f), { message, stack }).catch(() => {});
        return null;
      }
      case 'ui.theme':
        return currentTheme();
      case 'ui.resize': {
        const hgt = p.height;
        if (typeof hgt !== 'number' || !Number.isFinite(hgt) || hgt < 0) throw bad('height: must be a number of at least 0');
        resized(f, hgt);
        return null;
      }
      case 'ui.setTitle': {
        const t = str('title', 200).trim();
        f.slot.title = t || f.slot.ref.view.title;
        renderSlotHead(f.slot);
        return null;
      }
      case 'ui.setBadge': {
        const b = p.badge;
        if (b !== null && b !== undefined && typeof b !== 'string' && typeof b !== 'number') throw bad('badge: must be a string, a number or null');
        const text = b === null || b === undefined ? null : String(b).slice(0, 24);
        f.slot.badge = text && text.trim() ? text.trim() : null;
        renderSlotHead(f.slot);
        return null;
      }
      case 'ui.toast': {
        const kind = p.kind === undefined ? 'info' : p.kind;
        if (kind !== 'info' && kind !== 'error') throw bad('kind: must be "info" or "error"');
        const text = str('text', 500).trim();
        if (text) deps.toast(text, kind);
        return null;
      }
      case 'ui.open': {
        const id = p.view === undefined ? f.slot.ref.view.id : str('view', 100);
        const target = viewKey(mod.key, id);
        if (!mod.manifest?.contributes?.views?.some((v) => v.id === id)) throw bad(`view: ${mod.id} has no view "${id}"`);
        openView(target);
        return null;
      }
      case 'ui.copy':
        return writeClipboard(str('text', 1_000_000));
      case 'ui.openExternal': {
        const url = str('url', 8000);
        if (!isHttpUrl(url)) throw bad('url: only http and https links open outside the app');
        await window.oc.browser.openExternal(url);
        return null;
      }
      case 'ui.markdown':
        return { html: renderMarkdown(str('text', 500_000)) };
      case 'composer.insert': {
        deps.insertText(str('text', 100_000));
        return null;
      }
      case 'outputs.open':
        return openOutput(p);
      case 'sessions.open': {
        const id = str('id', 200);
        if (!deps.sessions().some((s) => s.id === id) && id !== deps.currentSessionId()) throw new BridgeError(ERR.unavailable, `No session ${id}.`);
        await deps.switchSession(id);
        return null;
      }
      case 'sessions.create': {
        await deps.newSession();
        const id = deps.currentSessionId();
        const meta = deps.sessions().find((s) => s.id === id);
        const cwd = deps.config()?.workingDirectory ?? '';
        return meta ? toModSession(meta, cwd, false) : { id, title: 'New session', cwd, origin: 'user', messageCount: 0, createdAt: Date.now(), updatedAt: Date.now(), running: false };
      }
      default:
        throw new BridgeError(ERR.unknownMethod, `${method} is not available in this version of the app.`);
    }
  }

  async function openOutput(p: Record<string, unknown>): Promise<null> {
    const kind = p.kind;
    const id = p.id;
    if (typeof id !== 'string' || !id) throw bad('id: must be a string');
    if (kind === 'artifact') {
      await window.oc.artifacts.open(id);
      deps.showPane('browser');
      return null;
    }
    if (kind === 'image') {
      let list: { id: string; url: string; name: string; caption?: string }[];
      try {
        list = await rpc('images.list');
      } catch {
        throw new BridgeError(ERR.unavailable, 'Images are not available in this version of the app.');
      }
      const img = list.find((i) => i.id === id);
      if (!img) throw new BridgeError(ERR.unavailable, `No image ${id} in this session.`);
      deps.openLightbox(img.url, img.name, img.caption);
      return null;
    }
    if (kind === 'file') {
      deps.showPane('diff');
      selectChangedFile(id);
      return null;
    }
    throw bad('kind: must be "artifact", "image" or "file"');
  }

  /** The Diff tab lists the changed files as buttons; pick the one for `path` once the list has loaded. */
  function selectChangedFile(path: string): void {
    const until = Date.now() + 3000;
    const tryPick = () => {
      const btn = [...document.querySelectorAll<HTMLButtonElement>('#change-list .change-item')].find((b) => b.dataset.path === path);
      if (btn) {
        btn.click();
        btn.scrollIntoView({ block: 'nearest' });
      } else if (Date.now() < until) window.setTimeout(tryPick, 80);
    };
    tryPick();
  }

  function sayHello(f: Frame): void {
    const first = !f.helloAt;
    f.helloAt = Date.now();
    window.clearTimeout(f.timer);
    f.timer = undefined;
    if (first && f.slot.failedEl && f.slot.frame === f) showFailed(f.slot, false);
    if (first && f.slot.next === f) {
      // A reload: show the new page once it had a moment to lay out (or reported its size).
      window.setTimeout(() => swapIn(f), SWAP_FALLBACK_MS);
    }
  }

  function resized(f: Frame, reported: number): void {
    const s = f.slot;
    const hgt = frameHeight(s.seat, reported, s.ref.view.maxHeight);
    if (s.seat !== 'rail' && s.seat !== 'composer') return;
    if (s.next === f) {
      f.iframe.style.height = `${hgt}px`;
      if (f.helloAt) swapIn(f);
      return;
    }
    if (s.frame !== f) return;
    s.height = hgt;
    f.iframe.style.height = `${hgt}px`;
    if (s.seat === 'composer') syncStrip();
  }

  function flushQueued(f: Frame): void {
    const s = f.slot;
    if (!s.queued.length || s.frame !== f) return;
    const now = Date.now();
    s.queued = s.queued.filter((q) => {
      if (now - q.at > 15_000) return false;
      return !sendEvent(f, q.name, q.data);
    });
  }

  // ---------- Frames ----------

  function makeFrame(s: Slot): Frame {
    const mod = s.ref.mod;
    const iframe = document.createElement('iframe');
    iframe.className = 'mod-frame';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.title = `${s.ref.view.title || mod.manifest?.name || mod.id} (mod ${mod.manifest?.name ?? mod.id})`;
    if (s.seat === 'background') iframe.tabIndex = -1;
    const f: Frame = { id: nextFrameId++, slot: s, iframe, helloAt: 0, subs: new Set(), timer: undefined, sig: modSignature(mod), visible: slotVisible(s) };
    if (s.seat === 'rail' || s.seat === 'composer') iframe.style.height = `${s.height}px`;
    iframe.src = frameSrc(mod, s.ref.view.entry);
    f.timer = window.setTimeout(() => helloMissing(f), HELLO_TIMEOUT_MS);
    return f;
  }

  function helloMissing(f: Frame): void {
    f.timer = undefined;
    if (f.helloAt) return;
    const s = f.slot;
    if (s.next === f) {
      // The edited page does not start: show that instead of the old copy, which no longer matches the files.
      swapIn(f);
    }
    if (s.frame !== f) return;
    showFailed(s, true);
    void rpc('mods.report', caller(f), { message: `The ${s.ref.view.title || s.ref.view.id} view did not say hello within ${HELLO_TIMEOUT_MS / 1000} seconds: does ${s.ref.view.entry} load /@harness/harness.js without an error?` }).catch(() => {});
  }

  function dropFrame(f: Frame | null): void {
    if (!f) return;
    window.clearTimeout(f.timer);
    f.iframe.remove();
  }

  /** Puts a frame in the slot (the first one, or a fresh one for Reload). */
  function mountFrame(s: Slot): void {
    dropFrame(s.next);
    s.next = null;
    dropFrame(s.frame);
    showFailed(s, false);
    s.frame = makeFrame(s);
    s.body.appendChild(s.frame.iframe);
  }

  /** Reloads a slot in place: the old page stays until the new one is up, so a save does not flash. */
  function reloadSlot(s: Slot): void {
    if (!s.frame) return;
    if (s.failedEl && !s.failedEl.hidden) return mountFrame(s);
    dropFrame(s.next);
    const f = makeFrame(s);
    f.iframe.classList.add('mod-frame-next');
    s.next = f;
    s.body.appendChild(f.iframe);
  }

  function swapIn(f: Frame): void {
    const s = f.slot;
    if (s.next !== f) return;
    s.next = null;
    dropFrame(s.frame);
    s.frame = f;
    f.iframe.classList.remove('mod-frame-next');
    const h = parseFloat(f.iframe.style.height);
    if (Number.isFinite(h)) s.height = h;
    if (!f.helloAt) showFailed(s, true);
    if (s.seat === 'composer') syncStrip();
    flushQueued(f);
  }

  function showFailed(s: Slot, failed: boolean): void {
    if (!failed) {
      if (s.failedEl) s.failedEl.hidden = true;
      s.el.classList.remove('mod-failed-view');
      return;
    }
    if (!s.failedEl) {
      const el = document.createElement('div');
      el.className = 'mod-failed';
      el.innerHTML = `<span class="mod-failed-text">${icon('circle-alert', 14)}<span>This panel did not start</span></span><button type="button" class="link-btn mod-failed-reload">Reload</button>`;
      el.querySelector('button')!.addEventListener('click', () => mountFrame(s));
      s.body.prepend(el);
      s.failedEl = el;
    }
    s.failedEl.hidden = false;
    s.el.classList.add('mod-failed-view');
  }

  // ---------- Visibility ----------

  let paneActive: string | null = null;
  let paneVisible = false;

  function railShown(): boolean {
    return layout.railOpen && viewsFor(mods, 'rail').length > 0;
  }

  function slotVisible(s: Slot): boolean {
    switch (s.seat) {
      case 'rail':
        return railShown() && !layout.collapsed.includes(s.ref.key);
      case 'tab':
        return paneVisible && paneActive === s.ref.key;
      default:
        return true;
    }
  }

  function syncVisibility(): void {
    for (const s of slots.values()) {
      const v = slotVisible(s);
      for (const f of [s.frame, s.next]) {
        if (!f || f.visible === v) continue;
        f.visible = v;
        sendEvent(f, 'visibility.changed', { visible: v });
      }
    }
  }

  // ---------- Icons ----------

  function iconHtml(name: string | undefined, mod: ModInfo, size = 16): string {
    const src = iconSource(name, mod.origin, isIconName) ?? iconSource(mod.manifest?.icon, mod.origin, isIconName);
    if (src && 'builtin' in src) return icon(src.builtin as IconName, size);
    if (src && 'url' in src) return `<span class="mod-icon-img" style="width:${size}px;height:${size}px;-webkit-mask-image:url('${escapeHtml(src.url)}');mask-image:url('${escapeHtml(src.url)}')" aria-hidden="true"></span>`;
    return icon('blocks', size);
  }

  // ---------- The rail ----------

  function makeRailSlot(ref: ViewRef): Slot {
    const el = document.createElement('section');
    el.className = 'rail-section';
    el.dataset.view = ref.key;
    const bodyId = `rail-body-${slots.size}-${Math.random().toString(36).slice(2, 7)}`;
    el.innerHTML = `<h2 class="rail-head"><button type="button" class="rail-head-btn" aria-expanded="true" aria-controls="${bodyId}"><span class="rail-title"></span><span class="rail-badge" hidden></span><span class="rail-chev">${icon('chevron-down', 14)}</span></button></h2><div class="rail-body" id="${bodyId}"></div>`;
    const head = el.querySelector<HTMLButtonElement>('.rail-head-btn')!;
    const s: Slot = {
      ref,
      seat: 'rail',
      el,
      body: el.querySelector<HTMLElement>('.rail-body')!,
      frame: null,
      next: null,
      title: ref.view.title,
      badge: null,
      height: 0,
      failedEl: null,
      queued: [],
      head,
      titleEl: el.querySelector<HTMLElement>('.rail-title')!,
      badgeEl: el.querySelector<HTMLElement>('.rail-badge')!,
    };
    head.addEventListener('click', () => {
      const collapsed = !layout.collapsed.includes(s.ref.key);
      saveLayout({ collapsed: setCollapsed(layout.collapsed, s.ref.key, collapsed) });
      applyCollapsed(s);
      syncVisibility();
    });
    renderSlotHead(s);
    return s;
  }

  function applyCollapsed(s: Slot): void {
    if (s.seat !== 'rail') return;
    const collapsed = layout.collapsed.includes(s.ref.key);
    s.el.classList.toggle('collapsed', collapsed);
    s.head?.setAttribute('aria-expanded', String(!collapsed));
    s.body.hidden = collapsed;
  }

  function renderSlotHead(s: Slot): void {
    if (s.seat === 'rail' && s.titleEl && s.badgeEl) {
      s.titleEl.textContent = s.title;
      s.badgeEl.textContent = s.badge ?? '';
      s.badgeEl.hidden = !s.badge;
      s.head?.setAttribute('aria-label', `${s.title}${s.badge ? `, ${s.badge}` : ''}`);
    } else if (s.seat === 'tab' && s.tabBtn) {
      const label = s.tabBtn.querySelector<HTMLElement>('.mod-tab-title');
      const badge = s.tabBtn.querySelector<HTMLElement>('.count-badge');
      if (label) label.textContent = s.title;
      if (badge) {
        badge.textContent = s.badge ?? '';
        badge.hidden = !s.badge;
      }
      s.tabBtn.setAttribute('aria-label', `${s.title}${s.badge ? `, ${s.badge}` : ''}`);
      s.tabBtn.dataset.tip = s.title;
    }
  }

  function applyRail(): void {
    const shown = railShown();
    const any = viewsFor(mods, 'rail').length > 0;
    if (rail) rail.hidden = !shown;
    shellEl?.style.setProperty('--rail-w', `${clampRailWidth(layout.railWidth)}px`);
    shellEl?.classList.toggle('rail-open', shown);
    if (railToggle) {
      railToggle.hidden = !any;
      railToggle.setAttribute('aria-pressed', String(shown));
      railToggle.classList.toggle('active', shown);
    }
    for (const s of slots.values()) applyCollapsed(s);
    syncVisibility();
    deps.paneLayoutChanged();
  }

  function toggleRail(open = !layout.railOpen): void {
    if (open === layout.railOpen) return;
    saveLayout({ railOpen: open });
    applyRail();
  }

  railToggle?.addEventListener('click', () => toggleRail());
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'e') return;
    if (!viewsFor(mods, 'rail').length) return;
    e.preventDefault();
    toggleRail();
  });

  railEdge?.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !rail) return;
    e.preventDefault();
    railEdge.setPointerCapture(e.pointerId);
    railEdge.classList.add('dragging');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startW = rail.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      layout = { ...layout, railWidth: clampRailWidth(startW + (startX - ev.clientX)) };
      shellEl?.style.setProperty('--rail-w', `${layout.railWidth}px`);
      deps.paneLayoutChanged();
    };
    const up = (ev: PointerEvent) => {
      if (railEdge.hasPointerCapture(ev.pointerId)) railEdge.releasePointerCapture(ev.pointerId);
      railEdge.removeEventListener('pointermove', move);
      railEdge.removeEventListener('pointerup', up);
      railEdge.removeEventListener('pointercancel', up);
      railEdge.classList.remove('dragging');
      document.body.classList.remove('resizing');
      saveLayout({ railWidth: layout.railWidth });
      deps.paneLayoutChanged();
    };
    railEdge.addEventListener('pointermove', move);
    railEdge.addEventListener('pointerup', up);
    railEdge.addEventListener('pointercancel', up);
  });
  railEdge?.addEventListener('dblclick', () => {
    saveLayout({ railWidth: RAIL_DEFAULT });
    applyRail();
  });

  /** Sets the rail width as a drag would (used by the live checks through the debug hook). */
  function setRailWidth(w: number): number {
    window.clearTimeout(widthTimer);
    const width = clampRailWidth(w);
    layout = { ...layout, railWidth: width };
    applyRail();
    widthTimer = window.setTimeout(() => saveLayout({ railWidth: width }), 150);
    return width;
  }

  // ---------- Mod tabs in the side pane ----------

  let tabSeq = 0;
  function makeTabSlot(ref: ViewRef): Slot {
    const n = ++tabSeq;
    const panel = document.createElement('section');
    panel.className = 'mod-tab-panel';
    panel.id = `mod-tab-panel-${n}`;
    panel.setAttribute('role', 'tabpanel');
    panel.hidden = true;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pane-tab mod-pane-tab';
    btn.id = `pane-tab-mod-${n}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('aria-controls', panel.id);
    btn.tabIndex = -1;
    btn.dataset.view = ref.key;
    btn.innerHTML = `${iconHtml(ref.view.icon, ref.mod, 14)}<span class="mod-tab-title"></span><span class="count-badge" hidden></span>`;
    panel.setAttribute('aria-labelledby', btn.id);
    btn.addEventListener('click', () => deps.showPane(`mod:${ref.key}`));
    const s: Slot = { ref, seat: 'tab', el: panel, body: panel, frame: null, next: null, title: ref.view.title, badge: null, height: 0, failedEl: null, queued: [], tabBtn: btn };
    renderSlotHead(s);
    return s;
  }

  const pane: ModPaneTabs = {
    buttons: () =>
      viewsFor(mods, 'tab')
        .map((r) => slots.get(r.key))
        .filter((s): s is Slot => !!s?.tabBtn)
        .map((s) => ({ key: s.ref.key, el: s.tabBtn! })),
    has: (key) => slots.get(key)?.seat === 'tab',
    apply(active, visible) {
      paneActive = active;
      paneVisible = visible;
      for (const s of slots.values()) {
        if (s.seat !== 'tab' || !s.tabBtn) continue;
        const on = s.ref.key === active;
        s.tabBtn.classList.toggle('active', on);
        s.tabBtn.setAttribute('aria-selected', String(on));
        s.tabBtn.tabIndex = on ? 0 : -1;
        s.el.hidden = !on;
        // Made the first time it is shown, then kept alive while hidden.
        if (on && visible && !s.frame) mountFrame(s);
      }
      syncVisibility();
    },
  };

  // ---------- The composer strip ----------

  function makeStripSlot(ref: ViewRef): Slot {
    const el = document.createElement('div');
    el.className = 'mod-strip-row';
    el.dataset.view = ref.key;
    return { ref, seat: 'composer', el, body: el, frame: null, next: null, title: ref.view.title, badge: null, height: 0, failedEl: null, queued: [] };
  }

  function syncStrip(): void {
    if (!strip) return;
    const any = [...slots.values()].some((s) => s.seat === 'composer');
    strip.hidden = !any;
  }

  // ---------- The background ----------

  let bgSlot: Slot | null = null;
  function syncBackground(): void {
    const root = document.documentElement;
    const ref = activeBackground(mods, layout);
    const image = !ref && layout.backgroundImage ? `mod://app.background/${encodeURIComponent(layout.backgroundImage.split(/[\\/]/).pop() ?? '')}` : '';
    // The view's slot follows the layout: another view, or none, drops the frame.
    if (bgSlot && (!ref || bgSlot.ref.key !== ref.key)) {
      removeSlot(bgSlot);
      bgSlot = null;
    }
    if (ref && !bgSlot && bgLayer) {
      const el = document.createElement('div');
      el.className = 'mod-background-view';
      bgSlot = { ref, seat: 'background', el, body: el, frame: null, next: null, title: ref.view.title, badge: null, height: 0, failedEl: null, queued: [] };
      slots.set(ref.key, bgSlot);
      bgLayer.appendChild(el);
      mountFrame(bgSlot);
    } else if (ref && bgSlot) bgSlot.ref = ref;
    if (bgLayer) {
      bgLayer.style.backgroundImage = image ? `url("${image}")` : '';
      bgLayer.hidden = !ref && !image;
    }
    const on = !!ref || !!image;
    root.classList.toggle('mod-bg', on);
    if (on) root.style.setProperty('--mod-cover', `${Math.round(Math.min(1, Math.max(0, Number(layout.backgroundDim ?? 0.82))) * 100)}%`);
    else root.style.removeProperty('--mod-cover');
  }

  // ---------- Building the seats from the list ----------

  function currentMod(key: string): ModInfo | undefined {
    return mods.find((m) => m.key === key);
  }

  function removeSlot(s: Slot): void {
    dropFrame(s.frame);
    dropFrame(s.next);
    s.frame = s.next = null;
    s.el.remove();
    s.tabBtn?.remove();
    slots.delete(s.ref.key);
  }

  function applyMods(list: ModInfo[]): void {
    mods = Array.isArray(list) ? list : [];
    const wanted = new Map<string, ViewRef>();
    for (const seat of ['rail', 'tab', 'composer'] as const) for (const r of viewsFor(mods, seat)) wanted.set(r.key, r);
    let tabsChanged = false;
    // Gone, off, paused or no longer that seat: removed at once.
    for (const s of [...slots.values()]) {
      if (s.seat === 'background') continue;
      const r = wanted.get(s.ref.key);
      if (!r || r.view.seat !== s.seat) {
        if (s.seat === 'tab') tabsChanged = true;
        removeSlot(s);
      }
    }
    // New views appear; changed mods reload in place; the rest keep their pages.
    const changedMods = new Set<string>();
    for (const m of mods) {
      if (m.state !== 'on') {
        sigs.delete(m.key);
        continue;
      }
      const sig = modSignature(m);
      if (sigs.has(m.key) && sigs.get(m.key) !== sig) changedMods.add(m.key);
      sigs.set(m.key, sig);
    }
    for (const r of wanted.values()) {
      let s = slots.get(r.key);
      if (!s) {
        if (r.view.seat === 'rail') {
          s = makeRailSlot(r);
          railSections?.appendChild(s.el);
          slots.set(r.key, s);
          mountFrame(s);
        } else if (r.view.seat === 'tab') {
          s = makeTabSlot(r);
          slots.set(r.key, s);
          sidePane?.appendChild(s.el);
          tabsChanged = true;
        } else {
          s = makeStripSlot(r);
          strip?.appendChild(s.el);
          slots.set(r.key, s);
          mountFrame(s);
        }
        continue;
      }
      const titleWasDefault = s.title === s.ref.view.title;
      s.ref = r;
      if (titleWasDefault) s.title = r.view.title;
      renderSlotHead(s);
      if (changedMods.has(r.mod.key)) reloadSlot(s);
    }
    // Rail sections and tabs in order, without moving any frame in the DOM (that would reload it).
    viewsFor(mods, 'rail').forEach((r, i) => {
      const s = slots.get(r.key);
      if (s) s.el.style.order = String(i);
    });
    if (paneTabs) {
      // Tab buttons hold no frame, so they can be put in order directly, just before the strip's spacer.
      const order = pane.buttons().map((b) => b.el);
      const now = [...paneTabs.querySelectorAll<HTMLButtonElement>(':scope > .mod-pane-tab')];
      if (order.length !== now.length || order.some((el, i) => el !== now[i])) {
        for (const el of order) paneTabs.insertBefore(el, paneSpacer);
        tabsChanged = true;
      }
    }
    if (bgSlot && changedMods.has(bgSlot.ref.mod.key)) reloadSlot(bgSlot);
    syncBackground();
    syncStrip();
    applyRail();
    if (tabsChanged) deps.paneTabsChanged();
    void syncStyles();
    syncOffers();
  }

  /** Brings a view to the front: the rail opens and the section expands, a tab comes forward. */
  function openView(key: string): void {
    const s = slots.get(key);
    if (!s) return;
    if (s.seat === 'rail') {
      if (!layout.railOpen) toggleRail(true);
      if (layout.collapsed.includes(key)) {
        saveLayout({ collapsed: setCollapsed(layout.collapsed, key, false) });
        applyCollapsed(s);
        syncVisibility();
      }
      s.el.scrollIntoView({ block: 'nearest' });
    } else if (s.seat === 'tab') deps.showPane(`mod:${key}`);
  }

  // ---------- The "⋯" menu: mod tabs and Manage mods ----------

  moreBtn?.addEventListener('click', () => {
    const tabs = viewsFor(mods, 'tab');
    const sections: MenuSection[] = [];
    if (tabs.length) {
      sections.push({
        label: 'Tabs',
        items: tabs.map((r) => {
          const s = slots.get(r.key);
          return {
            label: s?.title || r.view.title,
            description: r.mod.manifest?.name && r.mod.manifest.name !== r.view.title ? r.mod.manifest.name : undefined,
            icon: (iconSource(r.view.icon, r.mod.origin, isIconName) as { builtin?: IconName } | null)?.builtin ?? (iconSource(r.mod.manifest?.icon, r.mod.origin, isIconName) as { builtin?: IconName } | null)?.builtin ?? 'blocks',
            checked: paneVisible && paneActive === r.key,
            onSelect: () => deps.showPane(`mod:${r.key}`),
          };
        }),
      });
    }
    sections.push({ items: [{ label: 'Manage mods…', icon: 'settings', onSelect: () => deps.openSettings('mods') }] });
    // The native browser view floats above the page: hide it while the menu is open.
    window.oc.browser.setVisible(false);
    moreBtn.setAttribute('aria-expanded', 'true');
    openMenu(sections, {
      anchor: moreBtn,
      placement: 'bottom-end',
      minWidth: 220,
      className: 'mods-menu',
      onClose: () => {
        moreBtn.setAttribute('aria-expanded', 'false');
        deps.syncBrowserView();
      },
    });
  });

  // ---------- Events from the rest of the window ----------

  bus.on('agent-event', (ev: AgentEvent, sessionId: string, onScreen: boolean) => {
    if (!onScreen || !ready) return;
    for (const out of eventsFromAgent(ev, sessionId)) deliver(out.name, out.data);
    if (ev.type === 'session_changed' && ev.session?.id === deps.currentSessionId()) noteSession();
    if (ev.type === 'run_start' || ev.type === 'run_end') window.setTimeout(noteSession, 0);
  });

  let shownId = '';
  let lastSession = '';
  let lastRelated = '';
  let lastPlan = '';

  function onScreenSession() {
    const id = deps.currentSessionId();
    const meta = deps.sessions().find((s) => s.id === id);
    return meta ? toModSession(meta, deps.config()?.workingDirectory ?? '', deps.running()) : null;
  }

  function noteSession(): void {
    if (!ready) return;
    const s = onScreenSession();
    const sig = sessionSignature(s);
    if (s && sig !== lastSession) {
      lastSession = sig;
      deliver('session.changed', s);
    }
  }

  bus.on('session-shown', (id: string) => {
    if (!ready) return;
    if (id !== shownId) {
      shownId = id;
      deliver('session.switched', { id });
    }
    noteSession();
    lastRelated = relatedSignature(deps.sessions(), id);
    lastPlan = planSig();
    reshowOffers();
  });

  function planSig(): string {
    const meta = deps.sessions().find((s) => s.id === deps.currentSessionId());
    return meta?.plan ? JSON.stringify([meta.plan.id, meta.plan.status]) : '';
  }

  bus.on('sessions', (metas: SessionMeta[]) => {
    if (!ready) return;
    noteSession();
    const rel = relatedSignature(metas, deps.currentSessionId());
    if (rel !== lastRelated) {
      if (rel || lastRelated) deliver('related.changed', {});
      lastRelated = rel;
    }
    const ps = planSig();
    if (ps !== lastPlan) {
      const had = lastPlan;
      lastPlan = ps;
      // A plan decided after the fact (approved, built, rejected): plan_proposed covered the proposal itself.
      if (had && ps) deliver('plan.changed', { plan: metas.find((m) => m.id === deps.currentSessionId())?.plan ?? null });
    }
  });

  onPush('mods:changed', (list) => {
    if (ready) applyMods(list);
  });
  onPush('mods:event', (ev) => {
    if (!ready || !isObj(ev) || typeof ev.name !== 'string') return;
    const modKey = typeof ev.mod === 'string' ? ev.mod : undefined;
    if (ev.name === 'command' && modKey) return command(modKey, ev.data);
    deliver(ev.name, ev.data, modKey);
  });
  onPush('schedules:changed', (schedules) => {
    if (ready) deliver('schedules.changed', { schedules: Array.isArray(schedules) ? schedules : [] });
  });
  onPush('remote:changed', (status) => {
    if (ready) deliver('remote.changed', status);
  });

  /** A mod's slash command: the named view comes to the front first, then its views hear it. */
  function command(modKey: string, data: unknown): void {
    const mod = currentMod(modKey);
    const name = isObj(data) && typeof data.name === 'string' ? data.name : '';
    const viewId = mod?.manifest?.contributes?.commands?.find((c) => c.name === name)?.view;
    const target = viewId ? slots.get(viewKey(modKey, viewId)) : undefined;
    if (target) openView(target.ref.key);
    for (const s of slots.values()) {
      if (s.ref.mod.key !== modKey) continue;
      const f = s.frame;
      const sent = f ? sendEvent(f, 'command', data) : false;
      // A view that is only now starting has not subscribed yet: it hears the command once it does.
      if (!sent && (!f || !f.helloAt || !f.subs.size)) s.queued.push({ name: 'command', data, at: Date.now() });
    }
  }

  // ---------- "Turn on" cards ----------

  interface Offer {
    info: ModInfo;
    el: HTMLElement;
    decided: boolean;
  }
  const offers = new Map<string, Offer>();

  registerTranscriptItem('mod-offer', (item) => {
    const o = offers.get(String(item.key));
    return o ? o.el : null;
  });

  function home(): string {
    const cwd = deps.config()?.workingDirectory ?? '';
    const m = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(cwd);
    return m ? m[1] : '';
  }

  const SCOPE_WORDS: Record<string, string> = { user: 'your mods folder', project: 'this project', bundled: 'the app' };

  function makeOfferCard(info: ModInfo): HTMLElement {
    const m = info.manifest;
    const name = m?.name ?? info.id;
    const el = document.createElement('div');
    el.className = 'mod-offer';
    el.dataset.mod = info.key;
    const paused = info.state === 'paused';
    const kicker = paused ? `${name} asks for more` : info.overrides ? `${name} replaces the built-in panel` : 'New mod';
    const lines = askLines(info)
      .map((l) => `<li class="${l.strong ? 'strong' : ''}">${l.strong ? icon('triangle-alert', 14) : icon('check', 14)}<span>${escapeHtml(l.text)}</span></li>`)
      .join('');
    const seats = [...new Set((m?.contributes?.views ?? []).map((v) => ({ rail: 'a panel in the right-hand rail', tab: 'a tab in the side pane', composer: 'a strip above the composer', background: 'a background' })[v.seat]).filter(Boolean))];
    const adds = [...seats, ...(m?.contributes?.styles?.length ? ['styles for the app'] : []), ...(m?.contributes?.commands?.length ? [`${m.contributes.commands.length === 1 ? 'a slash command' : 'slash commands'}`] : [])];
    el.innerHTML = `
      <div class="mod-offer-head">
        <span class="mod-offer-icon">${iconHtml(m?.icon, info, 16)}</span>
        <div class="mod-offer-heading">
          <div class="mod-offer-kicker">${escapeHtml(kicker)}</div>
          <div class="mod-offer-title">${escapeHtml(paused ? `Turn ${name} back on?` : `Turn on ${name}?`)}</div>
        </div>
      </div>
      ${m?.description ? `<p class="mod-offer-desc">${escapeHtml(m.description)}</p>` : ''}
      <dl class="mod-offer-facts">
        ${adds.length ? `<dt>Adds</dt><dd>${escapeHtml(adds.join(', '))}</dd>` : ''}
        <dt>Lives in</dt><dd><code>${escapeHtml(shortDir(info.dir, home()))}</code> <span class="mod-offer-scope">· ${escapeHtml(SCOPE_WORDS[info.scope] ?? info.scope)}</span></dd>
      </dl>
      <div class="mod-offer-asks-label">${paused ? 'Its new version asks to' : 'It asks to'}</div>
      <ul class="mod-offer-asks">${lines}</ul>
      <div class="mod-offer-row">
        <button type="button" class="btn mod-offer-files">${icon('folder', 14)}<span>Show files</span></button>
        <span class="spacer"></span>
        <button type="button" class="btn mod-offer-later">Not now</button>
        <button type="button" class="btn primary mod-offer-on">${escapeHtml(paused ? 'Turn back on' : 'Turn on')}</button>
      </div>`;
    const on = el.querySelector<HTMLButtonElement>('.mod-offer-on')!;
    const later = el.querySelector<HTMLButtonElement>('.mod-offer-later')!;
    const files = el.querySelector<HTMLButtonElement>('.mod-offer-files')!;
    files.addEventListener('click', () => void rpc('mods.reveal', info.key).catch((err: unknown) => deps.toast(`Couldn't show the folder: ${errText(err)}`, 'error')));
    later.addEventListener('click', () => decide(info.key, 'later'));
    on.addEventListener('click', async () => {
      on.disabled = later.disabled = true;
      try {
        const list = await rpc('mods.setEnabled', info.key, true);
        decide(info.key, 'on');
        applyMods(list);
      } catch (err) {
        on.disabled = later.disabled = false;
        let msg = el.querySelector<HTMLElement>('.mod-offer-error');
        if (!msg) {
          msg = document.createElement('p');
          msg.className = 'mod-offer-error';
          msg.setAttribute('role', 'alert');
          el.querySelector('.mod-offer-row')?.before(msg);
        }
        msg.textContent = `Couldn't turn it on: ${errText(err)}`;
      }
    });
    return el;
  }

  function errText(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  function decide(key: string, how: 'on' | 'later' | 'elsewhere'): void {
    const o = offers.get(key);
    if (!o || o.decided) return;
    o.decided = true;
    const name = o.info.manifest?.name ?? o.info.id;
    const text = how === 'later' ? `${name} stays off. Turn it on any time in Settings → Mods.` : how === 'on' ? `${name} is on` : `${name} was turned on in Settings`;
    o.el.classList.add('done');
    o.el.innerHTML = `<div class="mod-offer-decided"><span class="${how === 'later' ? 'no' : 'ok'}">${icon(how === 'later' ? 'x' : 'check', 14)}</span><span>${escapeHtml(text)}</span></div>`;
  }

  function showOffer(info: ModInfo): void {
    if (!info?.key || !info.manifest || info.state === 'on' || info.state === 'invalid') return;
    const prev = offers.get(info.key);
    prev?.el.remove();
    const o: Offer = { info, el: makeOfferCard(info), decided: false };
    offers.set(info.key, o);
    appendTranscriptItem({ role: 'mod-offer', key: info.key });
  }

  /** A switch clears the transcript: the cards still waiting come along to the conversation now on screen. */
  function reshowOffers(): void {
    for (const [key, o] of offers) {
      if (o.decided) {
        offers.delete(key);
        continue;
      }
      if (!o.el.isConnected) appendTranscriptItem({ role: 'mod-offer', key });
    }
  }

  function syncOffers(): void {
    for (const [key, o] of offers) {
      if (o.decided) continue;
      const m = currentMod(key);
      if (!m) {
        o.el.remove();
        offers.delete(key);
      } else if (m.state === 'on') decide(key, 'elsewhere');
    }
  }

  onPush('mods:offer', (info) => {
    if (isObj(info)) showOffer(info as unknown as ModInfo);
  });

  // ---------- Debug hooks (window.__oc_debug.mods) ----------

  const debug = {
    list: () => mods.map((m) => ({ ...m })),
    views: () =>
      [...slots.values()].map((s) => ({
        key: s.ref.key,
        mod: s.ref.mod.key,
        view: s.ref.view.id,
        seat: s.seat,
        title: s.title,
        badge: s.badge,
        hello: !!s.frame?.helloAt,
        helloAt: s.frame?.helloAt ?? 0,
        frameId: s.frame?.id ?? null,
        reloading: !!s.next,
        failed: !!s.failedEl && !s.failedEl.hidden,
        height: s.height,
        visible: slotVisible(s),
        collapsed: layout.collapsed.includes(s.ref.key),
        subs: s.frame ? [...s.frame.subs] : [],
        src: s.frame?.iframe.src ?? null,
      })),
    emit: (name: string, data: unknown) => deliver(String(name), data),
    log: (limit = LOG_MAX) => log.slice(-Math.max(1, limit)),
    clearLog: () => void log.splice(0),
    layout: () => ({ ...layout, collapsed: [...layout.collapsed] }),
    setRailWidth,
    toggleRail: (open?: boolean) => toggleRail(open ?? !layout.railOpen),
    offers: () => [...offers.values()].map((o) => ({ key: o.info.key, decided: o.decided, shown: o.el.isConnected })),
    theme: () => currentTheme(),
    browser: () => deps.browserDebug(),
    open: (key: string) => openView(key),
  };
  const dbgHost = (window as unknown as { __oc_debug?: Record<string, unknown> }).__oc_debug;
  if (dbgHost) dbgHost.mods = debug;

  // ---------- Start ----------

  const appInfoCall = rpc('app.info').then(
    (i) => (i && typeof i.name === 'string' ? { name: i.name, version: String(i.version ?? 'unknown') } : null),
    () => null,
  );
  void (async () => {
    try {
      const [perms, list, info] = await Promise.all([rpc('mods.permissions'), rpc('mods.list'), Promise.race([appInfoCall, new Promise<null>((r) => setTimeout(() => r(null), 1500))])]);
      methodPerms = perms?.methods ?? {};
      eventPerms = perms?.events ?? {};
      if (info) appInfo = info;
      ready = true;
      for (const w of readyWaiters.splice(0)) w();
      lastTheme = JSON.stringify(currentTheme());
      shownId = deps.currentSessionId();
      applyMods(list);
    } catch (err) {
      // An app without the mods main half: the seats stay empty and hidden.
      console.warn('[mods] the mod host is off:', err);
      applyRail();
    }
  })();

  return { pane };
}
