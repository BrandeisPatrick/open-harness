// The generic bridge between the window and the main process: named methods (oc.rpc) and push events (oc.onPush).
// Each feature declares its part in its own contract file; this file only joins them. Types only.

import type { AppConfig, CommandInfo, CommandResult, LiveState, SessionMeta } from './types';
import type { ModsEvents, ModsRpc } from './mods';
import type { ContextRpc } from './context';
import type { HistoryRpc } from './history';
import type { ImagesRpc } from './images';
import type { PowerEvents, PowerRpc, SchedulesEvents, SchedulesRpc } from './schedules';
import type { SubagentsRpc } from './subagents';
import type { RemoteEvents, RemoteRpc } from './remote';
import type { SettingsEvents, SettingsRpc } from './settings-info';

export interface CoreRpc {
  'commands.list': () => CommandInfo[];
  'commands.run': (name: string, args: string) => CommandResult;
  'sessions.live': (id: string) => LiveState;
}

export interface CoreEvents {
  'config:changed': AppConfig;
  'sessions:changed': SessionMeta[];
}

export type RpcMethods = CoreRpc & ModsRpc & ContextRpc & HistoryRpc & ImagesRpc & SchedulesRpc & PowerRpc & SubagentsRpc & RemoteRpc & SettingsRpc;
export type RpcEvents = CoreEvents & ModsEvents & SchedulesEvents & PowerEvents & RemoteEvents & SettingsEvents;
