// The hook engine: for one occurrence of an event, the hooks that match it (from the settings files and from mods),
// run in parallel, each within its timeout, and their decisions merged: deny wins over ask wins over allow, and any
// block blocks. It keeps the recent runs for Settings → Hooks. No Electron: the headless tests drive it directly.

import type { HookEntryInfo, HookEvent, HookRunInfo, HookSourceKind } from '../../shared/hooks';
import { defaultTimeout, handlerKey, handlerLabel, MATCHER_EVENTS, SESSION_END_BUDGET_MS, SESSION_END_MAX_MS, TOOL_EVENTS, type HookGroup, type HookHandler } from './config';
import { ifRuleMatches, matcherMatches } from './match';
import { readResult, runHandler, verdictFromOutput, outputProblem, type HookOutput, type RawResult, type Verdict } from './run';

const RUNS_MAX = 200;
/** How long a mod's handler may take unless its manifest says otherwise (ms) */
export const MOD_HOOK_TIMEOUT_MS = 10_000;

/** A settings file's hooks, with where they come from. */
export interface SettingsHookSet {
  groups: HookGroup[];
  source: 'user' | 'project';
  /** The file's path */
  label: string;
}

/** A mod that handles hooks: which events, and how long each may take. */
export interface ModHookSet {
  key: string;
  name: string;
  events: { event: HookEvent; timeoutMs: number }[];
}

export type ModHookReply = { result?: unknown; error?: string; skipped?: string };

export interface EngineOptions {
  /** The settings files' hooks that apply to a session in `cwd`, and whether disableAllHooks is set */
  settings: (cwd: string) => { sets: SettingsHookSet[]; disabled: boolean };
  /** The mods that handle hooks now */
  mods?: () => ModHookSet[];
  /** Asks a mod's views to handle a hook */
  runMod?: (mod: string, event: HookEvent, input: Record<string, unknown>, timeoutMs: number) => Promise<ModHookReply>;
  /** The recent runs changed */
  onRuns?: () => void;
  log?: (line: string) => void;
}

/** What one occurrence of an event is, for the hooks that may handle it. */
export interface FireContext {
  sessionId: string;
  cwd: string;
  /** $CLAUDE_PROJECT_DIR (default: cwd) */
  projectDir?: string;
  transcriptPath: string;
  /** This app's permission mode; the input carries Claude Code's name for it */
  permissionMode: string;
  /** The event's own fields of the input */
  fields: Record<string, unknown>;
  /** The values the matcher is tested against (tool names, the source, the trigger …) */
  match?: string[];
  /** Tool events: the tool's names and its Claude Code-shaped input, for `if` rules */
  tool?: { names: string[]; input: Record<string, unknown> };
  signal?: AbortSignal;
  /** Called with a handler's statusMessage while it runs, then with null */
  status?: (text: string | null) => void;
  /** SessionEnd: the shared budget (ms) */
  budgetMs?: number;
}

/** The merged decision of an event's hooks. */
export interface HookOutcome {
  /** Hooks that ran (async ones included) */
  ran: number;
  /** Set when the action is blocked: what the model (or the user) is told */
  block?: string;
  /** A hook blocked with a JSON decision (not exit code 2 or a failure) */
  jsonBlock?: boolean;
  permission?: 'allow' | 'deny' | 'ask';
  permissionReason?: string;
  updatedInput?: Record<string, unknown>;
  /** additionalContext and plain-stdout context, in the order the hooks are listed */
  context: string[];
  /** systemMessage of each hook, and the non-blocking errors: quiet notices in the transcript */
  notices: string[];
  /** continue: false. The run stops after this step; `reason` is shown to the user */
  stop?: { reason: string };
}

interface Candidate {
  event: HookEvent;
  matcher: string;
  handler: HookHandler | { type: 'mod'; mod: string; name: string; timeoutMs: number };
  source: HookSourceKind;
  sourceLabel: string;
}

const PERMISSION_MODES: Record<string, string> = { ask: 'default', bypass: 'bypassPermissions' };

/** This app's permission mode as Claude Code names it. */
export function claudePermissionMode(mode: string): string {
  return PERMISSION_MODES[mode] ?? mode;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export class HookEngine {
  private runs: HookRunInfo[] = [];
  private nextRun = 1;
  private readonly o: EngineOptions;


  constructor(o: EngineOptions) {
    this.o = o;
  }

  /** Every hook in effect for a session in `cwd`, in the order they would run. */
  entries(cwd: string): HookEntryInfo[] {
    return this.candidates(cwd).map((c) => {
      const h = c.handler;
      const e: HookEntryInfo = {
        event: c.event,
        matcher: c.matcher,
        type: h.type,
        command: h.type === 'mod' ? h.name : handlerLabel(h),
        timeout: h.type === 'mod' ? h.timeoutMs / 1000 : (h.timeout ?? defaultTimeout(c.event)),
        source: c.source,
        sourceLabel: c.sourceLabel,
      };
      if (h.type !== 'mod') {
        if (h.if) e.if = h.if;
        if (h.onFailure) e.onFailure = h.onFailure;
        if (h.statusMessage) e.statusMessage = h.statusMessage;
        if (h.type === 'command' && h.async) e.async = true;
      }
      return e;
    });
  }

  /** Plugs the mods in: the ones that handle hooks, and how to ask their views (the mods feature calls this). */
  attachMods(list: () => ModHookSet[], run: NonNullable<EngineOptions['runMod']>): () => void {
    this.o.mods = list;
    this.o.runMod = run;
    return () => {
      if (this.o.mods === list) {
        this.o.mods = undefined;
        this.o.runMod = undefined;
      }
    };
  }

  disabled(cwd: string): boolean {
    return this.o.settings(cwd).disabled;
  }

  /** The settings hooks first (user, then project; the same handler once), then each mod's. */
  private candidates(cwd: string, event?: HookEvent): Candidate[] {
    const out: Candidate[] = [];
    const s = this.o.settings(cwd);
    if (!s.disabled) {
      const seen = new Set<string>();
      for (const set of s.sets) {
        for (const g of set.groups) {
          if (event && g.event !== event) continue;
          for (const h of g.handlers) {
            const key = `${g.matcher}\u0000${handlerKey(g.event, h)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ event: g.event, matcher: g.matcher, handler: h, source: set.source, sourceLabel: set.label });
          }
        }
      }
    }
    for (const m of this.o.mods?.() ?? []) {
      for (const e of m.events) {
        if (event && e.event !== event) continue;
        out.push({ event: e.event, matcher: '', handler: { type: 'mod', mod: m.key, name: m.name, timeoutMs: e.timeoutMs }, source: 'mod', sourceLabel: m.name });
      }
    }
    return out;
  }

  /** Whether any hook could fire for `event` (so the caller can skip building the input). */
  has(event: HookEvent, cwd: string): boolean {
    return this.candidates(cwd, event).length > 0;
  }

  /** The input JSON a handler receives. */
  input(event: HookEvent, ctx: FireContext): Record<string, unknown> {
    return { session_id: ctx.sessionId, transcript_path: ctx.transcriptPath, cwd: ctx.cwd, permission_mode: claudePermissionMode(ctx.permissionMode), hook_event_name: event, ...ctx.fields };
  }

  /** Runs the hooks of one occurrence and merges what they decided. Never throws. */
  async fire(event: HookEvent, ctx: FireContext): Promise<HookOutcome> {
    const outcome: HookOutcome = { ran: 0, context: [], notices: [] };
    let list: Candidate[];
    try {
      list = this.candidates(ctx.cwd, event).filter((c) => this.applies(c, event, ctx));
    } catch (err) {
      this.o.log?.(`[hooks] ${event}: could not read the hooks: ${err instanceof Error ? err.message : String(err)}`);
      return outcome;
    }
    if (!list.length) return outcome;
    const input = this.input(event, ctx);
    const json = JSON.stringify(input);
    const label = ctx.tool ? `${event}:${ctx.tool.names[0]}` : event;
    const target = ctx.tool?.names[0] ?? ctx.match?.[0] ?? '';
    // SessionEnd shares one budget, raised by a longer timeout set on one of its hooks (up to 60 s).
    let budget = ctx.budgetMs;
    if (event === 'SessionEnd') {
      const longest = Math.max(0, ...list.map((c) => (c.handler.type === 'mod' ? 0 : (c.handler.timeout ?? 0) * 1000)));
      budget = Math.min(SESSION_END_MAX_MS, Math.max(budget ?? SESSION_END_BUDGET_MS, longest));
    }
    const started = Date.now();
    const statuses = list.map((c) => (c.handler.type !== 'mod' ? c.handler.statusMessage : undefined)).filter((s): s is string => !!s);
    if (statuses.length) ctx.status?.(statuses[0]);
    const verdicts = await Promise.all(
      list.map(async (c): Promise<{ c: Candidate; v: Verdict | null }> => {
        outcome.ran++;
        const h = c.handler;
        const timeoutMs = budget !== undefined ? Math.max(1, budget - (Date.now() - started)) : h.type === 'mod' ? h.timeoutMs : (h.timeout ?? defaultTimeout(event)) * 1000;
        const t0 = Date.now();
        if (h.type === 'command' && h.async) {
          // In the background: no decision is waited for; its output is reported when it ends.
          void runHandler(h, json, { cwd: ctx.cwd, projectDir: ctx.projectDir ?? ctx.cwd, timeoutMs: (h.timeout ?? defaultTimeout(event)) * 1000 }).then((r) => {
            const v = readResult(event, {}, r);
            this.record(c, event, target, v, Date.now() - t0, ctx.sessionId, r);
          });
          return { c, v: null };
        }
        if (h.type === 'mod') {
          const v = await this.runModHandler(h.mod, h.name, event, input, timeoutMs);
          this.record(c, event, target, v, Date.now() - t0, ctx.sessionId);
          return { c, v };
        }
        const r = await runHandler(h, json, { cwd: ctx.cwd, projectDir: ctx.projectDir ?? ctx.cwd, timeoutMs, signal: ctx.signal });
        const v = readResult(event, h, r);
        this.record(c, event, target, v, Date.now() - t0, ctx.sessionId, r);
        return { c, v };
      }),
    );
    if (statuses.length) ctx.status?.(null);
    this.merge(event, label, verdicts, outcome);
    return outcome;
  }

  private applies(c: Candidate, event: HookEvent, ctx: FireContext): boolean {
    if (MATCHER_EVENTS.has(event) && !matcherMatches(c.matcher, ctx.match ?? [])) return false;
    const rule = c.handler.type !== 'mod' ? c.handler.if : undefined;
    if (rule) {
      // `if` belongs to tool events; elsewhere a handler with it never runs.
      if (!TOOL_EVENTS.has(event) || !ctx.tool) return false;
      if (!ifRuleMatches(rule, ctx.tool.names, ctx.tool.input, ctx.cwd)) return false;
    }
    return true;
  }

  private async runModHandler(mod: string, name: string, event: HookEvent, input: Record<string, unknown>, timeoutMs: number): Promise<Verdict> {
    if (!this.o.runMod) return { label: 'skipped', failure: undefined };
    let reply: ModHookReply;
    try {
      reply = await Promise.race([
        this.o.runMod(mod, event, input, timeoutMs),
        new Promise<ModHookReply>((r) => setTimeout(() => r({ skipped: `did not answer within ${Math.round(timeoutMs / 100) / 10} s` }), timeoutMs + 50)),
      ]);
    } catch (err) {
      reply = { error: err instanceof Error ? err.message : String(err) };
    }
    if (reply.skipped) {
      this.o.log?.(`[hooks] ${event}: the mod ${name} was skipped: ${reply.skipped}`);
      return { label: 'skipped', stderr: reply.skipped };
    }
    if (reply.error) return { label: 'error', failure: `the mod's handler failed: ${reply.error}`, stderr: reply.error.split('\n')[0] };
    const r = reply.result;
    if (r === undefined || r === null) return { label: '' };
    if (!isObj(r)) return { label: 'error', failure: 'the mod\'s handler returned something that is not an output object', stderr: 'not an object' };
    const p = outputProblem(r);
    if (p) return { label: 'error', failure: `the mod's output failed validation: ${p}`, stderr: p };
    return verdictFromOutput(event, r as HookOutput);
  }

  private merge(event: HookEvent, label: string, verdicts: { c: Candidate; v: Verdict | null }[], out: HookOutcome): void {
    const blocks: string[] = [];
    const rank = { allow: 1, ask: 2, deny: 3 } as const;
    for (const { c, v } of verdicts) {
      if (!v) continue;
      const cmd = c.handler.type === 'mod' ? `mod ${c.handler.name}` : handlerLabel(c.handler);
      if (v.failure && !v.block) out.notices.push(`${label} hook error: [${cmd}]: ${v.failure}`);
      if (v.block) {
        const viaExit = v.exitCode === 2 || !!v.failure;
        blocks.push(viaExit ? `${label} hook error: [${cmd}]: ${v.block}` : v.block);
        if (!viaExit) out.jsonBlock = true;
      }
      if (v.permission && (!out.permission || rank[v.permission] > rank[out.permission])) {
        out.permission = v.permission;
        out.permissionReason = v.permissionReason;
        out.updatedInput = v.permission === 'allow' || v.permission === 'ask' ? v.updatedInput : undefined;
      } else if (v.permission && v.permission === out.permission && !out.updatedInput && v.updatedInput) {
        out.updatedInput = v.updatedInput;
      } else if (!v.permission && v.updatedInput && !out.permission && !out.updatedInput) out.updatedInput = v.updatedInput;
      if (v.context) out.context.push(v.context);
      if (v.systemMessage) out.notices.push(v.systemMessage);
      if (v.stop && !out.stop) out.stop = v.stop;
    }
    // A hook that leaves the permission alone may still rewrite the input; one that denies takes any rewrite away.
    if (out.permission === 'deny') delete out.updatedInput;
    if (blocks.length) out.block = blocks.join('\n');
    void event;
  }

  private record(c: Candidate, event: HookEvent, target: string, v: Verdict, durationMs: number, sessionId: string, raw?: RawResult): void {
    const h = c.handler;
    const run: HookRunInfo = {
      id: this.nextRun++,
      at: Date.now(),
      event,
      target,
      type: h.type,
      command: h.type === 'mod' ? h.name : handlerLabel(h),
      source: c.source,
      sourceLabel: c.sourceLabel,
      decision: v.label,
      durationMs,
      sessionId,
    };
    if (raw?.kind === 'exit') run.exitCode = raw.code;
    const err = v.stderr ?? (v.failure ? v.failure.split('\n')[0] : undefined);
    if (err) run.stderr = err.slice(0, 300);
    this.runs.push(run);
    if (this.runs.length > RUNS_MAX) this.runs.splice(0, this.runs.length - RUNS_MAX);
    if (v.label === 'error' || v.label === 'timeout' || v.label === 'skipped') this.o.log?.(`[hooks] ${event}${target ? ` (${target})` : ''}: ${run.command}: ${v.label}${err ? `: ${err}` : ''}`);
    this.o.onRuns?.();
  }

  recentRuns(): HookRunInfo[] {
    return this.runs.map((r) => ({ ...r }));
  }

  clearRuns(): void {
    this.runs = [];
    this.o.onRuns?.();
  }
}
