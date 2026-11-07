// Feature: hooks. Commands and HTTP endpoints from the settings files (Claude Code's `hooks` setting) and mods'
// hook handlers, run around the agent's actions (agent.ts fires them; hooks/engine.ts runs and merges them). This
// file makes the engine, offers it as the 'hooks' service, answers Settings → Hooks and fires SessionEnd at quit.

import type { App } from './app';
import type { HooksInfo } from '../shared/hooks';
import { settingsLayer } from './settings';
import { HookEngine } from './hooks/engine';
import { SettingsHooks } from './hooks/settings-source';

export type { HookEngine } from './hooks/engine';

export interface HooksFeature {
  engine: HookEngine;
  info(): HooksInfo;
  dispose(): void;
}

export function setupHooks(app: App, opts: { userFile?: () => string } = {}): HooksFeature {
  const settings = new SettingsHooks({ config: () => app.config(), userFile: opts.userFile ?? (() => settingsLayer.userFile()) });
  let timer: NodeJS.Timeout | null = null;
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      app.push('hooks:changed', info());
    }, 150);
  };
  const engine = new HookEngine({
    settings: (cwd) => settings.forCwd(cwd),
    onRuns: changed,
    log: (line) => console.warn(line),
  });
  const cwd = () => app.config().workingDirectory;
  function info(): HooksInfo {
    const here = cwd();
    return { hooks: engine.entries(here), runs: engine.recentRuns(), disabled: engine.disabled(here), problems: settings.problems(here) };
  }
  const disposers = [
    app.provide('hooks', engine),
    app.rpc.handle('hooks.info', () => info()),
    app.rpc.handle('hooks.clearRuns', () => {
      engine.clearRuns();
      return info();
    }),
    // The folder or a trust decision changed: the hooks in effect may have too.
    app.onConfig((next, prev) => {
      if (next.workingDirectory !== prev.workingDirectory || JSON.stringify(next.settingsTrusted) !== JSON.stringify(prev.settingsTrusted)) changed();
    }),
  ];
  // SessionEnd for the sessions that started, within its budget (the quit handlers get 3 s each).
  app.onQuit(() => app.runtime.endSessions('quit'));
  const dispose = () => {
    if (timer) clearTimeout(timer);
    for (const d of disposers.splice(0)) d();
  };
  return { engine, info, dispose };
}
