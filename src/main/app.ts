// The app's service container: everything a feature needs from the core goes through `App`.
// (Interface only for now; the core refactor on the runtime-refactor branch provides the implementation.)

import type { BrowserWindow } from 'electron';
import type { AgentEvent, AppConfig, CommandInfo, CommandResult, ImageAttachment, LiveState, MessageOrigin, PermissionMode, SendResult, SessionMeta, SessionOrigin, SessionStatus } from '../shared/types';
import type { RpcEvents, RpcMethods } from '../shared/rpc';
import type { Agent } from './agent';
import type { Session, SessionStore } from './sessions';
import type { Tool } from './tools';

export type Disposer = () => void;

export interface SessionRuntime {
  /** The session the window shows */
  foregroundId(): string;
  setForeground(id: string): Session;
  /** The agent bound to a session (created on demand) */
  agentFor(id: string): Agent;
  create(opts?: { cwd?: string; parentId?: string; origin?: SessionOrigin; title?: string; foreground?: boolean }): Session;
  /** Starts a run in the session, or queues the message when it is already running */
  send(id: string, text: string, attachments?: ImageAttachment[], opts?: { origin?: MessageOrigin; from?: string }): SendResult;
  stop(id: string): void;
  isRunning(id: string): boolean;
  running(): string[];
  status(id: string): SessionStatus;
  live(id: string): LiveState;
  /** Every session's meta, with its status */
  list(): SessionMeta[];
}

export interface App {
  /** Electron's userData folder */
  readonly userData: string;
  /** app.getAppPath(): where the bundled skills/, mods/ and modkit/ live */
  readonly appRoot: string;
  /** The effective config */
  config(): AppConfig;
  /** Applies a change, normalises, saves config.json, then tells subscribers and the window ('config:changed'). Returns the new config. */
  updateConfig(change: Partial<AppConfig> | ((current: AppConfig) => AppConfig)): AppConfig;
  onConfig(cb: (next: AppConfig, prev: AppConfig) => void): Disposer;
  /** The main window, or null */
  window(): BrowserWindow | null;
  /** A push event to the window (oc.onPush); dropped when there is no window */
  push<K extends keyof RpcEvents>(channel: K, payload: RpcEvents[K]): void;
  readonly rpc: { handle<K extends keyof RpcMethods>(method: K, fn: (...args: Parameters<RpcMethods[K]>) => ReturnType<RpcMethods[K]> | Promise<ReturnType<RpcMethods[K]>>): Disposer };
  readonly store: SessionStore;
  readonly runtime: SessionRuntime;
  /** Every agent event of every session, in order */
  readonly events: { on(cb: (sessionId: string, ev: AgentEvent) => void): Disposer };
  /** Extra tools offered to the model next to the built-in and MCP ones */
  readonly tools: { register(tool: Tool): Disposer; list(): Tool[] };
  /** Extra system-prompt sections; an empty string adds nothing */
  readonly prompt: { add(id: string, section: (info: { cwd: string; mode: PermissionMode; sessionId: string }) => string): Disposer };
  /** Slash commands that are not skills */
  readonly commands: { register(cmd: CommandInfo & { run(args: string, ctx: { sessionId: string }): CommandResult | Promise<CommandResult> }): Disposer; list(): CommandInfo[] };
  /** Named services features expose to each other, e.g. app.service<HistoryService>('history') */
  provide(name: string, service: unknown): Disposer;
  service<T>(name: string): T | undefined;
  /** Runs at quit, last registered first */
  onQuit(fn: () => void | Promise<void>): void;
}
