// Defence in depth behind the sandbox and the CSP: a mod frame may only navigate within its own origin, a mod frame
// without the network permission cannot cause any http(s)/ws(s) request at all, a mod frame cannot load another
// mod's files (or the background picture), and a web page (the built-in browser, say) cannot load mod files. Only
// requests from mod frames, and mod:// requests from web pages, are affected: the app page, the built-in browser
// view and other windows behave as before.
// Electron only: everything here is called from setupMods (or the live test), never at load time.

import { app as electronApp, type BrowserWindow, type Session, type WebContents, type WebFrameMain } from 'electron';
import { MOD_SCHEME, labelOfUrl } from './serve';

export interface LockdownOptions {
  /** The windows that exist now (more are picked up as they are created) */
  windows: () => (BrowserWindow | null)[];
  /** Whether the mod on this origin label is on and holds the network permission */
  networkAllowed: (label: string) => boolean;
  /** Every refused navigation or request (for logs and tests) */
  onBlock?: (what: { kind: 'navigation' | 'request'; label: string; url: string }) => void;
}

const NETWORK_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];
const MOD_URLS = [`${MOD_SCHEME}://*/*`];

function frameUrl(frame: WebFrameMain | null | undefined): string {
  try {
    return frame?.url ?? '';
  } catch {
    return ''; // a frame that has gone away
  }
}

/** Who a request comes from: the label of the mod frame (the frame itself or any frame above it), and whether a web page is in the chain. */
function requester(frame: WebFrameMain | null | undefined, referrer?: string): { label: string; web: boolean } {
  let f: WebFrameMain | null | undefined = frame;
  let label = '';
  let web = false;
  for (let i = 0; f && i < 32; i++) {
    const url = frameUrl(f);
    label ||= labelOfUrl(url);
    web ||= /^(https?|wss?):/i.test(url);
    try {
      f = f.parent;
    } catch {
      break;
    }
  }
  // Workers and requests whose frame is already gone: the referrer still names the page.
  if (!label) label = labelOfUrl(referrer);
  if (!frame && referrer) web ||= /^(https?|wss?):/i.test(referrer);
  return { label, web };
}

const frameOf = (details: { frame?: WebFrameMain | null }): WebFrameMain | null | undefined => {
  try {
    return details.frame;
  } catch {
    return null;
  }
};

export function installModLockdown(opts: LockdownOptions): () => void {
  const guarded = new WeakSet<WebContents>();
  const sessions = new Set<Session>();
  const cleanups: (() => void)[] = [];

  const onNavigate = (details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
    const from = labelOfUrl(frameUrl(details.frame));
    const to = labelOfUrl(details.url);
    // A navigation a mod page starts stays on its own origin. One the app page starts (the host pointing a frame at
    // a view) is the app's business. Without a known initiator, the frame's own origin decides.
    const by = details.initiator ? labelOfUrl(frameUrl(details.initiator)) : from;
    if (by && to !== by) {
      details.preventDefault();
      opts.onBlock?.({ kind: 'navigation', label: by, url: details.url });
    }
  };

  const guardSession = (ses: Session) => {
    if (sessions.has(ses)) return;
    sessions.add(ses);
    ses.webRequest.onBeforeRequest({ urls: [...NETWORK_URLS, ...MOD_URLS] }, (details, callback) => {
      const target = labelOfUrl(details.url);
      const isNavigation = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
      const { label, web } = requester(frameOf(details), details.referrer);
      let cancel = false;
      if (target) {
        // mod://: a mod page loads only its own files; a web page loads none. Frame navigations are will-frame-navigate's.
        if (!isNavigation) cancel = (!!label && label !== target) || (!label && web);
      } else cancel = !!label && !opts.networkAllowed(label);
      if (cancel) opts.onBlock?.({ kind: 'request', label: label || 'web page', url: details.url });
      callback({ cancel });
    });
    cleanups.push(() => ses.webRequest.onBeforeRequest(null));
  };

  const guard = (wc: WebContents) => {
    if (guarded.has(wc) || wc.isDestroyed()) return;
    guarded.add(wc);
    wc.on('will-frame-navigate', onNavigate);
    cleanups.push(() => {
      if (!wc.isDestroyed()) wc.off('will-frame-navigate', onNavigate);
    });
    guardSession(wc.session);
  };

  for (const w of opts.windows()) if (w && !w.isDestroyed()) guard(w.webContents);
  const onCreated = (_e: unknown, w: BrowserWindow) => guard(w.webContents);
  electronApp.on('browser-window-created', onCreated);
  cleanups.push(() => electronApp.off('browser-window-created', onCreated));
  return () => {
    for (const c of cleanups.splice(0)) c();
    sessions.clear();
  };
}
