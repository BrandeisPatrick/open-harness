// Running one hook handler and reading what it said, by Claude Code's rules: the event's JSON on stdin (or as the
// POST body), exit 0 with JSON on stdout applied, exit 2 a block with stderr as the reason, any other code a
// non-blocking error; a timeout or a hook that cannot start is a failure, which blocks only with onFailure "block".

import { spawn } from 'node:child_process';
import os from 'node:os';
import type { HookEvent } from '../../shared/hooks';
import type { CommandHandler, HookHandler, HttpHandler } from './config';

const MAX_OUTPUT = 1024 * 1024;
const EXTRA_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${os.homedir()}/.local/bin`, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** What came back from a handler before it is read. */
export type RawResult =
  | { kind: 'exit'; code: number; stdout: string; stderr: string }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

export interface RunOptions {
  cwd: string;
  /** The project folder: $CLAUDE_PROJECT_DIR and $SILO_PROJECT_DIR */
  projectDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

function hookPath(): string {
  const merged = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const p of EXTRA_PATH) if (!merged.includes(p)) merged.push(p);
  return merged.join(':');
}

const expandHome = (s: string) => s.replace(/^~(?=$|\/)/, os.homedir());
const placeholders = (s: string, dir: string) => s.replace(/\$\{(CLAUDE_PROJECT_DIR|SILO_PROJECT_DIR)\}/g, dir).replace(/\$(CLAUDE_PROJECT_DIR|SILO_PROJECT_DIR)\b/g, dir);

/** Runs a command handler: shell form through sh -c, exec form (args) directly. Never rejects. */
export function runCommand(h: CommandHandler, input: string, o: RunOptions): Promise<RawResult> {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: hookPath(), CLAUDE_PROJECT_DIR: o.projectDir, SILO_PROJECT_DIR: o.projectDir };
    let child: ReturnType<typeof spawn>;
    try {
      child = h.args
        ? spawn(expandHome(placeholders(h.command, o.projectDir)), h.args.map((a) => placeholders(a, o.projectDir)), { cwd: o.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn('/bin/sh', ['-c', h.command], { cwd: o.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }
    };
    const finish = (r: RawResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const timer = setTimeout(() => {
      kill();
      finish({ kind: 'timeout' });
    }, o.timeoutMs);
    const onAbort = () => {
      kill();
      finish({ kind: 'error', message: 'the run was stopped' });
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
    });
    child.on('error', (err) => finish({ kind: 'error', message: err.message }));
    child.on('close', (code, sig) => finish({ kind: 'exit', code: code ?? (sig ? 128 : 1), stdout, stderr }));
    child.stdin?.on('error', () => undefined); // a hook that does not read its input
    child.stdin?.end(input);
  });
}

/** POSTs the input; the status is the "exit code" (2xx is success), the body the stdout. Never rejects. */
export async function runHttp(h: HttpHandler, input: string, o: RunOptions): Promise<RawResult> {
  const allowed = new Set(h.allowedEnvVars ?? []);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(h.headers ?? {})) {
    headers[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, b: string | undefined) => {
      const name = (a ?? b) as string;
      return allowed.has(name) ? (process.env[name] ?? '') : '';
    });
  }
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  try {
    const res = await fetch(h.url, { method: 'POST', headers, body: input, signal });
    const body = (await res.text()).slice(0, MAX_OUTPUT);
    if (res.status < 200 || res.status > 299) return { kind: 'exit', code: res.status, stdout: '', stderr: `HTTP ${res.status}${body.trim() ? `: ${body.trim().split('\n')[0]}` : ''}` };
    return { kind: 'exit', code: 0, stdout: body, stderr: '' };
  } catch (err) {
    if (timeout.aborted) return { kind: 'timeout' };
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export function runHandler(h: HookHandler, input: string, o: RunOptions): Promise<RawResult> {
  return h.type === 'http' ? runHttp(h, input, o) : runCommand(h, input, o);
}

// ---------- Reading the output ----------

/** The JSON output fields this app reads. */
export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: 'block' | 'approve';
  reason?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
}

const OUTPUT_FIELDS = ['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'decision', 'reason', 'hookSpecificOutput'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Why an output object does not fit the schema, or null. */
export function outputProblem(o: Record<string, unknown>): string | null {
  const t = (k: string, type: string) => o[k] !== undefined && typeof o[k] !== type;
  if (t('continue', 'boolean')) return 'continue: expected true or false';
  if (t('stopReason', 'string')) return 'stopReason: expected a string';
  if (t('suppressOutput', 'boolean')) return 'suppressOutput: expected true or false';
  if (t('systemMessage', 'string')) return 'systemMessage: expected a string';
  if (o.decision !== undefined && o.decision !== 'block' && o.decision !== 'approve') return 'decision: expected "block"';
  if (t('reason', 'string')) return 'reason: expected a string';
  const s = o.hookSpecificOutput;
  if (s !== undefined) {
    if (!isObj(s)) return 'hookSpecificOutput: expected an object';
    if (s.permissionDecision !== undefined && !['allow', 'deny', 'ask'].includes(String(s.permissionDecision))) return 'hookSpecificOutput.permissionDecision: expected "allow", "deny" or "ask"';
    if (s.permissionDecisionReason !== undefined && typeof s.permissionDecisionReason !== 'string') return 'hookSpecificOutput.permissionDecisionReason: expected a string';
    if (s.updatedInput !== undefined && !isObj(s.updatedInput)) return 'hookSpecificOutput.updatedInput: expected an object';
    if (s.additionalContext !== undefined && typeof s.additionalContext !== 'string') return 'hookSpecificOutput.additionalContext: expected a string';
  }
  return null;
}

/**
 * Stdout read by Claude Code's rule: one JSON object with only whitespace around it is JSON output; anything that does
 * not start with { and end with } is plain text; several lines that each parse are plain text unless one of them sets
 * an output field (then a parse failure); anything else that looks like an object and does not parse is a failure.
 */
export function parseStdout(stdout: string): { json: HookOutput } | { text: string } | { error: string } {
  const t = stdout.trim();
  if (!t) return { text: '' };
  if (!t.startsWith('{') || !t.endsWith('}')) return { text: t };
  try {
    const v = JSON.parse(t);
    if (!isObj(v)) return { text: t };
    const p = outputProblem(v);
    return p ? { error: `JSON output failed validation: ${p}` } : { json: v as HookOutput };
  } catch (e) {
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      const parsed = lines.map((l) => {
        try {
          return { ok: true, v: JSON.parse(l) as unknown };
        } catch {
          return { ok: false, v: null };
        }
      });
      if (parsed.every((p) => p.ok)) {
        const sets = parsed.some((p) => isObj(p.v) && OUTPUT_FIELDS.some((f) => f in (p.v as object)));
        return sets ? { error: 'stdout holds several JSON values; print the output object alone' } : { text: t };
      }
    }
    return { error: `JSON output could not be parsed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** What one handler decided, before the decisions of an event's hooks are merged. */
export interface Verdict {
  /** A failure (cannot start, timeout, bad output, non-blocking exit code): reported, and a block with onFailure "block" */
  failure?: string;
  /** The action is blocked; the reason (stderr, the JSON reason, or the failure with onFailure "block") */
  block?: string;
  permission?: 'allow' | 'deny' | 'ask';
  permissionReason?: string;
  updatedInput?: Record<string, unknown>;
  /** additionalContext, or plain stdout where it is context (UserPromptSubmit, SessionStart, PreCompact) */
  context?: string;
  systemMessage?: string;
  /** continue: false */
  stop?: { reason: string };
  exitCode?: number;
  /** The first line of stderr */
  stderr?: string;
  /** For the runs list: allow, deny, ask, block, context, timeout, error, or "" */
  label: string;
}

const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';

/** Events where plain stdout is context the model sees (PreCompact: instructions for the summary). */
const TEXT_IS_CONTEXT = new Set<HookEvent>(['UserPromptSubmit', 'SessionStart', 'PreCompact']);

/** Reads a JSON output object (from stdout, an HTTP body or a mod handler) into a verdict. */
export function verdictFromOutput(event: HookEvent, out: HookOutput, base: Partial<Verdict> = {}): Verdict {
  const v: Verdict = { label: '', ...base };
  const s = out.hookSpecificOutput ?? {};
  if (out.systemMessage?.trim()) v.systemMessage = out.systemMessage.trim();
  if (out.continue === false) v.stop = { reason: out.stopReason?.trim() ?? '' };
  if (event === 'PreToolUse') {
    // decision "approve"/"block" is the older spelling of permissionDecision allow/deny
    const p = s.permissionDecision ?? (out.decision === 'approve' ? 'allow' : out.decision === 'block' ? 'deny' : undefined);
    if (p) {
      v.permission = p;
      const r = s.permissionDecisionReason ?? out.reason;
      if (r?.trim()) v.permissionReason = r.trim();
    }
    if (s.updatedInput) v.updatedInput = s.updatedInput;
  } else if (out.decision === 'block') {
    v.block = out.reason?.trim() || 'Blocked by a hook.';
  }
  if (typeof s.additionalContext === 'string' && s.additionalContext.trim()) v.context = s.additionalContext.trim();
  v.label = v.block ? 'block' : v.permission ?? (v.stop ? 'stop' : v.context ? 'context' : '');
  return v;
}

/** Reads a raw result into a verdict, by the exit-code table of Claude Code's reference. */
export function readResult(event: HookEvent, h: { onFailure?: 'continue' | 'block' }, r: RawResult): Verdict {
  const blocksOnFailure = h.onFailure === 'block' && event !== 'Stop' && event !== 'SubagentStop';
  const fail = (what: string, detail: string, label: string, exitCode?: number): Verdict => {
    const v: Verdict = { failure: detail ? `${what}: ${detail}` : what, label, ...(exitCode !== undefined ? { exitCode } : {}) };
    if (detail) v.stderr = firstLine(detail);
    if (blocksOnFailure) {
      v.block = `${what === 'timed out' ? 'timed out' : 'failed'}; blocking because onFailure is "block"${detail ? `\n${firstLine(detail)}` : ''}`;
      v.label = 'block';
    }
    return v;
  };
  if (r.kind === 'timeout') return fail('timed out', '', 'timeout');
  if (r.kind === 'error') return fail('could not run', r.message, 'error');
  const parsed = parseStdout(r.stdout);
  const stderr = firstLine(r.stderr);
  const base: Partial<Verdict> = { exitCode: r.code, ...(stderr ? { stderr } : {}) };
  if (r.code === 2) {
    // Stop and SubagentStop: a missing script is not a reason to keep the model working.
    if ((event === 'Stop' || event === 'SubagentStop') && !r.stdout.trim() && /No such file or directory|not found/i.test(r.stderr)) {
      return { ...base, failure: `Failed with non-blocking status code: ${stderr}`, label: 'error' };
    }
    const v: Verdict = 'json' in parsed ? verdictFromOutput(event, parsed.json, base) : { label: '', ...base };
    // Exit 2 blocks whatever the JSON says; a JSON blocking decision's reason is used when it gives one.
    const jsonReason = 'json' in parsed ? (event === 'PreToolUse' && v.permission === 'deny' ? v.permissionReason : v.block) : undefined;
    v.block = jsonReason || r.stderr.trim() || 'Blocked by a hook (exit code 2).';
    delete v.permission;
    delete v.updatedInput;
    v.label = 'block';
    return v;
  }
  if ('error' in parsed) return fail(parsed.error, '', 'error', r.code);
  if (r.code === 0) {
    if ('json' in parsed) return verdictFromOutput(event, parsed.json, base);
    const v: Verdict = { label: '', ...base };
    if (parsed.text && TEXT_IS_CONTEXT.has(event)) {
      v.context = parsed.text;
      v.label = 'context';
    }
    return v;
  }
  // Another exit code: valid JSON decides on its own (a failure with onFailure "block"), plain text is an error.
  if ('json' in parsed && !blocksOnFailure) return verdictFromOutput(event, parsed.json, base);
  return fail('Failed with non-blocking status code', stderr || `exit code ${r.code}`, 'error', r.code);
}
