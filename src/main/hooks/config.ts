// The `hooks` block of a settings.json file, in Claude Code's shape (docs/hooks.md): validated entry by entry, so a
// bad handler is dropped with a problem line and the rest of the block still applies. No Electron, no I/O.

import type { HookEvent } from '../../shared/hooks';
import { kind, type JsonSchema } from '../checks';

/** The events this app fires, in the order Settings lists them. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
];

/** Claude Code events this app does not fire: a file may name them (a problem line says they never run). */
export const OTHER_CLAUDE_EVENTS: readonly string[] = [
  'Setup',
  'UserPromptExpansion',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolBatch',
  'MessageDisplay',
  'SubagentStart',
  'TaskCreated',
  'TaskCompleted',
  'StopFailure',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreModelSwitch',
  'PostModelSwitch',
  'Elicitation',
  'ElicitationResult',
];

/** Events whose matcher filters something; on the others a matcher is ignored, as in Claude Code. */
export const MATCHER_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SessionEnd', 'Notification', 'SubagentStop', 'PreCompact', 'PostCompact']);

/** Events whose handlers may use `if` (a permission rule on the tool call); elsewhere a handler with `if` never runs. */
export const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

export const isHookEvent = (s: unknown): s is HookEvent => typeof s === 'string' && (HOOK_EVENTS as readonly string[]).includes(s);

/** Seconds, as Claude Code: 600 for command and http hooks, 30 on UserPromptSubmit. */
export function defaultTimeout(event: HookEvent): number {
  return event === 'UserPromptSubmit' ? 30 : 600;
}

/** SessionEnd hooks share this budget (ms); a longer timeout set on one raises it, up to 60 s. */
export const SESSION_END_BUDGET_MS = 1500;
export const SESSION_END_MAX_MS = 60_000;

export interface CommandHandler {
  type: 'command';
  command: string;
  /** Exec form: `command` is spawned directly with these arguments, no shell */
  args?: string[];
  async?: boolean;
  timeout?: number;
  onFailure?: 'continue' | 'block';
  if?: string;
  statusMessage?: string;
}

export interface HttpHandler {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeout?: number;
  onFailure?: 'continue' | 'block';
  if?: string;
  statusMessage?: string;
}

export type HookHandler = CommandHandler | HttpHandler;

/** One matcher group of one event. */
export interface HookGroup {
  event: HookEvent;
  /** "" matches everything */
  matcher: string;
  handlers: HookHandler[];
}

export interface HooksBlock {
  groups: HookGroup[];
  problems: { key: string; message: string }[];
  /** "hooks.PreToolUse", one per event that has a usable handler (what the file "sets") */
  keys: string[];
  /** Commands and URLs the block runs, for the trust prompt ("runs commands") */
  commands: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether a matcher would be read as a regular expression, and whether it is a valid one. */
export function matcherProblem(m: string): string | null {
  if (!m || m === '*' || /^[A-Za-z0-9_\- ,|]+$/.test(m)) return null;
  try {
    new RegExp(m);
    return null;
  } catch (e) {
    return `is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`;
  }
}

/** The command line a handler runs, as one string (for Settings and messages). */
export function handlerLabel(h: HookHandler): string {
  if (h.type === 'http') return h.url;
  return h.args?.length ? [h.command, ...h.args].join(' ') : h.command;
}

/** Same handler, for running it once when several files define it. */
export function handlerKey(event: HookEvent, h: HookHandler): string {
  return JSON.stringify([event, h.type, h.type === 'http' ? h.url : h.command, h.type === 'command' ? (h.args ?? null) : null, h.if ?? null]);
}

/**
 * Validates a `hooks` value. Unknown handler fields are ignored (a newer Claude Code may add some); fields this app
 * reads are checked. Handler types this app does not run (mcp_tool, prompt, agent) are reported and skipped.
 */
export function validateHooks(raw: unknown): HooksBlock {
  const out: HooksBlock = { groups: [], problems: [], keys: [], commands: [] };
  const bad = (key: string, message: string) => out.problems.push({ key, message });
  if (!isObj(raw)) {
    bad('hooks', `expected an object of events, e.g. { "PreToolUse": [ { "matcher": "Bash", "hooks": [ … ] } ] }, got ${kind(raw)}`);
    return out;
  }
  for (const [event, list] of Object.entries(raw)) {
    const at = `hooks.${event}`;
    if (!isHookEvent(event)) {
      if (OTHER_CLAUDE_EVENTS.includes(event)) bad(at, `a Claude Code event this app does not fire; its hooks never run (fired: ${HOOK_EVENTS.join(', ')})`);
      else bad(at, `not a hook event (known: ${HOOK_EVENTS.join(', ')})`);
      continue;
    }
    if (!Array.isArray(list)) {
      bad(at, `expected a list of matcher groups, e.g. [ { "matcher": "Bash", "hooks": [ … ] } ], got ${kind(list)}`);
      continue;
    }
    let any = false;
    list.forEach((g, gi) => {
      const gat = `${at}[${gi}]`;
      if (!isObj(g)) return bad(gat, `expected { "matcher": …, "hooks": [ … ] }, got ${kind(g)}`);
      let matcher = '';
      if (g.matcher !== undefined && g.matcher !== null) {
        if (typeof g.matcher !== 'string') return bad(`${gat}.matcher`, `expected a string, got ${kind(g.matcher)}`);
        const p = matcherProblem(g.matcher);
        if (p) return bad(`${gat}.matcher`, `"${g.matcher}" ${p}`);
        matcher = g.matcher;
      }
      if (!Array.isArray(g.hooks)) return bad(`${gat}.hooks`, `expected a list of handlers, got ${kind(g.hooks)}`);
      const handlers: HookHandler[] = [];
      g.hooks.forEach((h, hi) => {
        const hat = `${gat}.hooks[${hi}]`;
        const r = validateHandler(h, hat, bad);
        if (r) handlers.push(r);
      });
      if (!handlers.length) return;
      out.groups.push({ event, matcher, handlers });
      for (const h of handlers) {
        const label = handlerLabel(h);
        if (!out.commands.includes(label)) out.commands.push(label);
      }
      any = true;
    });
    if (any) out.keys.push(at);
  }
  return out;
}

function validateHandler(h: unknown, at: string, bad: (key: string, message: string) => void): HookHandler | null {
  if (!isObj(h)) return bad(at, `expected a handler { "type": "command", "command": … }, got ${kind(h)}`), null;
  const type = h.type;
  if (type === 'mcp_tool' || type === 'prompt' || type === 'agent') return bad(`${at}.type`, `"${type}" hooks are not supported by this app; this handler is skipped (use "command" or "http")`), null;
  if (type !== 'command' && type !== 'http') return bad(`${at}.type`, `${type === undefined ? 'missing' : JSON.stringify(type) + ' is not a handler type'}; use "command" or "http"`), null;
  let ok = true;
  const no = (k: string, m: string) => ((ok = false), bad(`${at}.${k}`, m));
  const common: { timeout?: number; onFailure?: 'continue' | 'block'; if?: string; statusMessage?: string } = {};
  if (h.timeout !== undefined) {
    if (typeof h.timeout !== 'number' || !Number.isFinite(h.timeout) || h.timeout <= 0) no('timeout', `expected a number of seconds above 0, got ${typeof h.timeout === 'number' ? h.timeout : kind(h.timeout)}`);
    else common.timeout = h.timeout;
  }
  if (h.onFailure !== undefined) {
    if (h.onFailure !== 'continue' && h.onFailure !== 'block') no('onFailure', `expected "continue" or "block"`);
    else common.onFailure = h.onFailure;
  }
  if (h.if !== undefined) {
    if (typeof h.if !== 'string' || !h.if.trim()) no('if', 'expected one permission rule, e.g. "Bash(git *)" or "Edit(*.ts)"');
    else if (!/^[A-Za-z0-9_.\-]+(\(.*\))?$/s.test(h.if.trim())) no('if', `"${h.if}" is not a permission rule; write Tool or Tool(pattern), e.g. "Bash(rm *)"`);
    else common.if = h.if.trim();
  }
  if (h.statusMessage !== undefined) {
    if (typeof h.statusMessage !== 'string') no('statusMessage', `expected a string, got ${kind(h.statusMessage)}`);
    else if (h.statusMessage.trim()) common.statusMessage = h.statusMessage.trim().replace(/\s+/g, ' ').slice(0, 120);
  }
  if (type === 'command') {
    if (typeof h.command !== 'string' || !h.command.trim()) no('command', h.command === undefined ? 'missing; add the shell command to run' : `expected a non-empty string, got ${typeof h.command === 'string' ? 'an empty string' : kind(h.command)}`);
    let args: string[] | undefined;
    if (h.args !== undefined) {
      if (!Array.isArray(h.args) || h.args.some((a) => typeof a !== 'string')) no('args', 'expected a list of strings (exec form: command is the program, args its arguments)');
      else args = h.args as string[];
    }
    if (h.async !== undefined && typeof h.async !== 'boolean') no('async', 'expected true or false');
    if (h.asyncRewake !== undefined && typeof h.asyncRewake !== 'boolean') no('asyncRewake', 'expected true or false');
    if (h.shell !== undefined && h.shell !== 'bash' && h.shell !== 'powershell') no('shell', 'expected "bash" or "powershell"');
    if (!ok) return null;
    const out: CommandHandler = { type: 'command', command: (h.command as string).trim(), ...common };
    if (args) out.args = args;
    if (h.async === true || h.asyncRewake === true) out.async = true;
    return out;
  }
  if (typeof h.url !== 'string' || !/^https?:\/\//i.test(h.url.trim())) no('url', h.url === undefined ? 'missing; add the http:// or https:// URL to POST to' : 'expected an http:// or https:// URL');
  let headers: Record<string, string> | undefined;
  if (h.headers !== undefined) {
    if (!isObj(h.headers) || Object.values(h.headers).some((v) => typeof v !== 'string')) no('headers', 'expected an object of "Header-Name": "value" strings');
    else headers = h.headers as Record<string, string>;
  }
  let allowed: string[] | undefined;
  if (h.allowedEnvVars !== undefined) {
    if (!Array.isArray(h.allowedEnvVars) || h.allowedEnvVars.some((v) => typeof v !== 'string')) no('allowedEnvVars', 'expected a list of variable names');
    else allowed = h.allowedEnvVars as string[];
  }
  if (!ok) return null;
  const out: HttpHandler = { type: 'http', url: (h.url as string).trim(), ...common };
  if (headers) out.headers = headers;
  if (allowed) out.allowedEnvVars = allowed;
  return out;
}

/** The JSON Schema of the `hooks` key (docs/settings.schema.json). */
export function hooksSchema(): JsonSchema {
  const common = {
    timeout: { type: 'number', minimum: 0, description: 'Seconds before the hook is cancelled (default 600; 30 on UserPromptSubmit).' },
    if: { type: 'string', description: 'Tool events only: one permission rule, e.g. "Bash(git *)" or "Edit(*.ts)". The handler runs only when the tool call matches it.' },
    statusMessage: { type: 'string', description: 'Shown in the status line while the hook runs.' },
    onFailure: { enum: ['continue', 'block'], description: 'Whether the action goes ahead when the hook fails, times out or cannot start (default "continue").' },
  };
  const handler = {
    type: 'object',
    required: ['type'],
    properties: {
      type: { enum: ['command', 'http', 'mcp_tool', 'prompt', 'agent'], description: 'command and http run; mcp_tool, prompt and agent are Claude Code types this app skips (with a problem line).' },
      ...common,
    },
    allOf: [
      {
        if: { properties: { type: { const: 'command' } } },
        then: {
          required: ['command'],
          properties: {
            command: { type: 'string', minLength: 1, description: 'The shell command (sh -c), or with "args" the program to run directly. Reads the event as JSON on stdin.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Exec form: the arguments, passed as they are with no shell.' },
            async: { type: 'boolean', description: 'Run in the background; its decision is not waited for.' },
            asyncRewake: { type: 'boolean', description: 'Read as async in this app.' },
            shell: { enum: ['bash', 'powershell'], description: 'Accepted for Claude Code compatibility; this app runs shell-form commands with sh.' },
          },
        },
      },
      {
        if: { properties: { type: { const: 'http' } } },
        then: {
          required: ['url'],
          properties: {
            url: { type: 'string', pattern: '^https?://', description: "POSTed the event as JSON; the response body is read like a command hook's stdout." },
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra headers; $VAR and ${VAR} are filled in from allowedEnvVars only.' },
            allowedEnvVars: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    ],
  };
  const group = {
    type: 'object',
    required: ['hooks'],
    properties: {
      matcher: { type: 'string', description: 'Which occurrences fire: a name, names separated by | or ",", or a regular expression; "*" or empty matches all.' },
      hooks: { type: 'array', items: handler },
    },
  };
  return {
    type: 'object',
    description: "Commands and HTTP endpoints run before and after the agent acts, in Claude Code's format. A project file's hooks run only once you trust the file. See docs/hooks.md.",
    propertyNames: { enum: [...HOOK_EVENTS, ...OTHER_CLAUDE_EVENTS] },
    additionalProperties: { type: 'array', items: group },
  };
}
