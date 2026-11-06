// Remote control: a small web server inside the app, off by default, that lets the owner follow and steer their
// sessions from another device (a phone on the same network). The page lives in <appRoot>/remote/; the server
// pieces are under ./remote/. Loads under plain Node (no Electron import), so the test suite can run it.

import type { App } from './app';
import type { RemoteService } from './services';
import type { RemoteStatus } from '../shared/remote';
import { loadState, newToken, saveState, type RemoteState } from './remote/store';
import { RemoteServer, type Bind } from './remote/server';

export interface RemoteController extends RemoteService {
  configure(patch: { bind?: Bind; port?: number }): Promise<RemoteStatus>;
  newLink(): Promise<RemoteStatus>;
  /** Stops the server without changing the setting (quit) */
  shutdown(): Promise<void>;
}

/** Validates a configure patch from the window: unknown values are refused, not guessed at. */
function cleanPatch(patch: unknown): { bind?: Bind; port?: number } {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const out: { bind?: Bind; port?: number } = {};
  if (p.bind !== undefined) {
    if (p.bind !== 'localhost' && p.bind !== 'lan') throw new Error('bind must be "localhost" or "lan".');
    out.bind = p.bind;
  }
  if (p.port !== undefined) {
    if (typeof p.port !== 'number' || !Number.isInteger(p.port) || p.port < 0 || p.port > 65535) throw new Error('port must be a whole number from 0 to 65535 (0: any free port).');
    out.port = p.port;
  }
  return out;
}

export function createRemote(app: App): RemoteController {
  let state: RemoteState = loadState(app.userData);
  let clients = 0;
  let startedAt: number | undefined;
  let error: string | undefined;
  const server = new RemoteServer(app, state.token, (n) => {
    if (n === clients) return;
    clients = n;
    push();
  });

  const status = (): RemoteStatus => {
    const cfg = app.config().remote;
    const l = server.listening;
    return {
      enabled: cfg.enabled,
      running: !!l,
      bind: l?.bind ?? cfg.bind,
      port: l?.port ?? null,
      urls: server.urls(),
      clients,
      ...(l && startedAt ? { startedAt } : {}),
      ...(error ? { error } : {}),
    };
  };
  const push = () => app.push('remote:changed', status());

  /** Where the server should listen, per the setting; null when it should be off. */
  const desired = (): { bind: Bind; port: number } | null => {
    const r = app.config().remote;
    return r.enabled ? { bind: r.bind === 'localhost' ? 'localhost' : 'lan', port: r.port } : null;
  };

  // One change at a time: a start racing a stop must not leave a server nobody tracks.
  let chain: Promise<void> = Promise.resolve();
  let quitting = false;
  let latest: Promise<RemoteStatus> | null = null;
  const reconcile = (): Promise<RemoteStatus> => {
    chain = chain.then(async () => {
      const want = quitting ? null : desired();
      const have = server.listening;
      const samePort = (port: number) => (want!.port === 0 ? port === state.port || state.port === null : port === want!.port);
      if (want && have && have.bind === want.bind && samePort(have.port)) return;
      if (have) {
        await server.close();
        startedAt = undefined;
      }
      if (!want) {
        error = undefined;
        return;
      }
      try {
        let port: number;
        if (want.port !== 0) {
          port = await server.listen(want.bind, want.port);
        } else {
          // 0: the port picked last time keeps old links working; if something else took it, pick a new one.
          try {
            port = await server.listen(want.bind, state.port ?? 0);
          } catch {
            port = await server.listen(want.bind, 0);
          }
          if (port !== state.port) {
            state = { ...state, port };
            saveState(app.userData, state);
          }
        }
        startedAt = Date.now();
        error = undefined;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        console.warn('[remote] could not start:', error);
      }
    });
    latest = chain.then(() => {
      push();
      return status();
    });
    return latest;
  };

  /**
   * Saves the setting. When that changed it, the config subscription below has already queued the restart, and its
   * result is what the caller gets; otherwise (nothing changed, e.g. a retry after an error) it runs here.
   */
  const apply = (patch: Partial<{ enabled: boolean; bind: Bind; port: number }>): Promise<RemoteStatus> => {
    const before = latest;
    app.updateConfig((c) => ({ ...c, remote: { ...c.remote, ...patch } }));
    return latest !== before && latest ? latest : reconcile();
  };

  // A change from anywhere (the Settings panel saving the whole config, a settings file) is applied the same way.
  app.onConfig((next, prev) => {
    const a = next.remote;
    const b = prev.remote;
    if (a.enabled !== b.enabled || a.bind !== b.bind || a.port !== b.port) void reconcile();
  });

  // Every session's events feed the open streams.
  app.events.on((sessionId, ev) => server.stream.publish(sessionId, ev));

  return {
    status,
    start: () => apply({ enabled: true }),
    stop: () => apply({ enabled: false }),
    configure: async (patch) => apply(cleanPatch(patch)),
    newLink: async () => {
      await chain;
      state = { ...state, token: newToken() };
      saveState(app.userData, state);
      server.setToken(state.token);
      push();
      return status();
    },
    shutdown: async () => {
      quitting = true;
      await reconcile();
    },
  };
}

export function setupRemote(app: App): void {
  const remote = createRemote(app);
  app.rpc.handle('remote.status', () => remote.status());
  app.rpc.handle('remote.start', () => remote.start());
  app.rpc.handle('remote.stop', () => remote.stop());
  app.rpc.handle('remote.configure', (patch) => remote.configure(patch));
  app.rpc.handle('remote.newLink', () => remote.newLink());
  app.provide('remote', { status: remote.status, start: remote.start, stop: remote.stop } satisfies RemoteService);
  app.onQuit(() => remote.shutdown());
  if (app.config().remote.enabled) void remote.start();
}
