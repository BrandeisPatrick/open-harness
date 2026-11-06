// The generic RPC contract between the window and the main process: oc.rpc(method, …args) calls a handler
// registered with app.rpc.handle, and app.push(channel, payload) reaches oc.onPush(channel, cb). Features add their
// methods and push channels by extending the two intersections at the bottom, so neither preload nor index.ts
// changes when a feature does.

import type { AppConfig, CommandInfo, CommandResult, LiveState, SessionMeta, TranscriptItem } from './types';

export interface CoreRpc {
  'commands.list': () => CommandInfo[];
  'commands.run': (name: string, args: string) => CommandResult;
  'sessions.live': (id: string) => LiveState;
  /** A session's transcript without bringing it on screen (sessions.switch does both) */
  'sessions.transcript': (id: string) => TranscriptItem[];
}

export interface CoreEvents {
  'config:changed': AppConfig;
  'sessions:changed': SessionMeta[];
  /** Bring this session on screen (a notification was clicked) */
  'sessions:show': string;
}

/** Feature contracts are added to these intersections. */
export type RpcMethods = CoreRpc;
export type RpcEvents = CoreEvents;
