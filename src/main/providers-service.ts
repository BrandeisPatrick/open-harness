// Feature: providers. What the window asks about providers beyond the config itself (which already carries them
// resolved, see windowConfig in providers.ts): the models one offers, choosing a model, a quick test; and the
// command-line tool's row in Settings → General, which links the bundled `silo` into ~/.local/bin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliStatus } from '../shared/providers';
import type { App } from './app';
import { loginPath } from './mcp';
import { listModels, resolveProvider, testProvider } from './providers';
import { envVar } from './paths';

/** The command's name (it was open-harness before the rename) */
export const CLI_NAME = 'silo';

export interface ProvidersServiceOptions {
  /** The folder the link goes in (default: SILO_HARNESS_CLI_LINK_DIR, else OPEN_HARNESS_CLI_LINK_DIR, else ~/.local/bin) */
  linkDir?: string;
  /** The command the link points at (default: the app's bin/silo) */
  command?: string;
  /** The PATH of a login shell (default: mcp.ts loginPath) */
  pathOf?: () => Promise<string>;
}

/** The bundled command: Contents/Resources/bin/silo in the app, bin/silo in a checkout. */
export function cliCommandPath(appRoot: string): string {
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = res ? path.join(res, 'bin', CLI_NAME) : '';
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(appRoot, 'bin', CLI_NAME);
}

/**
 * The link the app made under the command's old name (open-harness, pointing at an app's bin/open-harness): taken
 * away once the new one is in, since it stops working when the old app is deleted. Anything else there is left alone.
 */
export function removeOldLink(dir: string): void {
  const old = path.join(dir, 'open-harness');
  try {
    if (fs.lstatSync(old).isSymbolicLink() && fs.readlinkSync(old).endsWith(path.join('bin', 'open-harness'))) fs.unlinkSync(old);
  } catch {
    /* nothing there */
  }
}

export function setupProviders(app: App, opts: ProvidersServiceOptions = {}): () => void {
  const linkDir = () => opts.linkDir ?? (envVar('CLI_LINK_DIR') || path.join(os.homedir(), '.local', 'bin'));
  const command = () => opts.command ?? cliCommandPath(app.appRoot);
  const pathOf = opts.pathOf ?? loginPath;

  async function status(): Promise<CliStatus> {
    const cmd = command();
    const link = path.join(linkDir(), CLI_NAME);
    let installed = false;
    let conflict: string | undefined;
    try {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink()) {
        const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
        if (target === path.resolve(cmd)) installed = true;
        else conflict = `${link} already links to ${target}`;
      } else conflict = `${link} already exists and is not a link`;
    } catch {
      /* nothing there */
    }
    let onPath = false;
    try {
      const dirs = (await pathOf()).split(':').map((d) => path.resolve(d.replace(/^~(?=\/|$)/, os.homedir())));
      onPath = dirs.includes(path.resolve(linkDir()));
    } catch {
      onPath = false;
    }
    return { command: cmd, available: fs.existsSync(cmd), link, installed, ...(conflict ? { conflict } : {}), onPath };
  }

  const disposers = [
    app.rpc.handle('providers.models', async (name) => listModels(resolveProvider(app.config(), String(name || app.config().provider)))),
    app.rpc.handle('providers.setModel', (name, model) => {
      const n = String(name || app.config().provider);
      const m = String(model ?? '').trim();
      if (!m) throw new Error('Choose a model.');
      app.updateConfig((c) => {
        if (n === 'ollama') return { ...c, ollama: { ...c.ollama, model: m } };
        if (n === 'portkey') return { ...c, portkey: { ...c.portkey, model: m } };
        const entry = c.providers?.[n];
        if (!entry) throw new Error(`There is no provider named "${n}".`);
        return { ...c, providers: { ...c.providers, [n]: { ...entry, model: m } } };
      });
    }),
    app.rpc.handle('providers.test', async (name) => testProvider(resolveProvider(app.config(), name ? String(name) : undefined))),
    app.rpc.handle('cli.status', () => status()),
    app.rpc.handle('cli.install', async () => {
      const s = await status();
      if (!s.available) throw new Error(`The command is not in this copy of the app (${s.command}).`);
      if (s.installed) return s;
      if (s.conflict) throw new Error(`${s.conflict}. Remove it first, then try again.`);
      fs.mkdirSync(path.dirname(s.link), { recursive: true });
      fs.symlinkSync(s.command, s.link);
      removeOldLink(path.dirname(s.link));
      return status();
    }),
    app.rpc.handle('cli.uninstall', async () => {
      const s = await status();
      // Only our own link is removed, never a file or a link someone else put there.
      if (s.installed) fs.unlinkSync(s.link);
      return status();
    }),
  ];
  const dispose = () => {
    for (const d of disposers) d();
  };
  app.onQuit(dispose);
  return dispose;
}
