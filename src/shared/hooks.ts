// Hooks: commands, HTTP endpoints and mod handlers that run before and after the agent acts, in the shape of Claude
// Code's `hooks` setting (docs/hooks.md). What the Settings page and the window see of them. Types only.

/** The events this app fires. Claude Code's other events are accepted in a file but never fire (a problem line says so). */
export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'SessionEnd';

/** Where a hook comes from: a settings.json file, or a mod (its key). */
export type HookSourceKind = 'user' | 'project' | 'mod';

/** One hook in effect, as Settings → Hooks lists it. */
export interface HookEntryInfo {
  event: HookEvent;
  /** The group's matcher ("" when it has none, which matches everything) */
  matcher: string;
  type: 'command' | 'http' | 'mod';
  /** The command line (with its args), the URL, or the mod's name */
  command: string;
  /** The `if` rule, when the handler has one */
  if?: string;
  async?: boolean;
  /** Seconds */
  timeout: number;
  onFailure?: 'continue' | 'block';
  statusMessage?: string;
  source: HookSourceKind;
  /** The settings file's path, or the mod's name */
  sourceLabel: string;
}

/** One run of a hook in this app session. */
export interface HookRunInfo {
  id: number;
  at: number;
  event: HookEvent;
  /** The tool name, the matcher value (startup, manual, permission_prompt …) or "" */
  target: string;
  type: 'command' | 'http' | 'mod';
  command: string;
  source: HookSourceKind;
  sourceLabel: string;
  /** The exit code (command), the HTTP status (http); absent for a mod or a hook that did not start */
  exitCode?: number;
  /** What it decided: allow, deny, ask, block, context, timeout, error, skipped, or "" for nothing */
  decision: string;
  durationMs: number;
  /** The first line of stderr, or of the error */
  stderr?: string;
  sessionId?: string;
}

export interface HooksInfo {
  hooks: HookEntryInfo[];
  runs: HookRunInfo[];
  /** disableAllHooks is set in a settings file */
  disabled: boolean;
  /** Problems in the files' hooks blocks, as "file: key: message" */
  problems: { file: string; key: string; message: string }[];
}

export interface HooksRpc {
  'hooks.info': () => HooksInfo;
  'hooks.clearRuns': () => HooksInfo;
  /** A mod view answered a hook request (the window relays it): `result` is the output object or null */
  'mods.hookResult': (id: string, reply: { result?: unknown; error?: string; skipped?: string }) => void;
}

/** A hook request for a mod's views: the window sends it to every view of `mod` that registered a handler for `event`. */
export interface ModHookRequest {
  id: string;
  mod: string;
  event: HookEvent;
  input: Record<string, unknown>;
  timeoutMs: number;
}

export interface HooksEvents {
  /** The hooks in effect or the recent runs changed */
  'hooks:changed': HooksInfo;
  /** Ask a mod's views to handle a hook; the answer comes back with mods.hookResult */
  'mods:hook': ModHookRequest;
}
