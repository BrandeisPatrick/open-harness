// Sub-sessions, messages between sessions, reports back to the parent, and merge. Everything goes through the App:
// sub-sessions are ordinary sessions of the runtime (origin 'spawn', parentId set), so the sidebar, the transcript
// and the queue treat them like any other.

import type { RelatedSessions } from '../../shared/subagents';
import type { AgentEvent, MessageOrigin, SendResult, SessionMeta } from '../../shared/types';
import type { App } from '../app';
import { MAX_RUNNING } from '../runtime';
import { clip, toMeta, type Msg, type Session, type Turn } from '../sessions';
import { writeMergeReport } from './summary';

/** A sub-session of a sub-session may not spawn: depth counts the parent links above a session. */
export const MAX_DEPTH = 2;
export const MAX_RUNNING_CHILDREN = 4;
export const MAX_CHILDREN = 12;
/** Reports a parent takes without a message from the user in between before they stop */
export const NOTE_CAP = 20;
export const NOTE_REPLY_CHARS = 600;

export type Relation = 'parent' | 'sub-session' | 'fork' | 'forked from' | 'other';

/** A refusal the caller (tool, command, RPC) shows as it is. */
export class SubagentError extends Error {}

// The frames below (and the report in Subagents.noteText) tell the model who is speaking. The window takes them off
// again for display (src/renderer/origin.ts); test/origin.js holds the two together.

/** The line above a message from another session */
export function messageHead(from: Pick<Session, 'title' | 'id'> | undefined, relation: string): string {
  return from ? `[Message from session "${from.title}" (${from.id}), your ${relation}]` : '[Message from another session]';
}

/** What a merge adds to the target session: where it came from, then the summary */
export function mergedText(title: string, report: string): string {
  return `[Merged from "${title}"]\n\n${report}`;
}

export interface MergeOutcome {
  ok: boolean;
  error?: string;
  /** The text added to the target (or, through the tool, returned to the model) */
  text?: string;
  title?: string;
}

export interface SubagentsOptions {
  /** The merge report; default: the configured model (summary.ts). Tests and the live rig use the real one. */
  summarize?: (title: string, kind: 'sub-session' | 'fork', messages: Msg[]) => Promise<string>;
  /** Delay before a report that could not be delivered (all run slots busy) is tried again */
  retryMs?: number;
}

const one = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class Subagents {
  /** Per session with a run in progress: the origin of the message that started it (set by its first user_message) */
  private readonly runOrigin = new Map<string, MessageOrigin | null>();
  /** Per parent: reports delivered since the user last wrote there, and whether the pause was announced */
  private readonly notes = new Map<string, number>();
  private readonly capNoticed = new Set<string>();
  /** Sources being merged right now (the summary takes a while; a second merge of the same one is refused) */
  private readonly merging = new Set<string>();
  private readonly summarize: NonNullable<SubagentsOptions['summarize']>;
  private readonly retryMs: number;

  constructor(
    private readonly app: App,
    opts: SubagentsOptions = {},
  ) {
    this.summarize = opts.summarize ?? ((title, kind, messages) => writeMergeReport(app.config(), title, kind, messages));
    this.retryMs = opts.retryMs ?? 3000;
  }

  // ---------- Looking sessions up ----------

  private session(id: string): Session {
    const s = this.app.store.get(String(id ?? ''));
    if (!s) throw new SubagentError(`No session with id "${id}".`);
    return s;
  }

  private meta(id: string): SessionMeta {
    return this.app.runtime.meta(id);
  }

  /** Every stored session (those with messages) plus `extra`, as Session objects. */
  private all(): Session[] {
    return this.app.store
      .list()
      .map((m) => this.app.store.get(m.id))
      .filter((s): s is Session => !!s);
  }

  /** How many parent links are above a session. */
  depth(id: string): number {
    let n = 0;
    let s = this.app.store.get(id);
    const seen = new Set<string>();
    while (s?.parentId && !seen.has(s.id)) {
      seen.add(s.id);
      n++;
      s = this.app.store.get(s.parentId);
    }
    return n;
  }

  children(id: string): Session[] {
    return this.all()
      .filter((s) => s.parentId === id && s.origin === 'spawn')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  forks(id: string): Session[] {
    return this.all()
      .filter((s) => s.forkedFrom === id)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  relation(of: string, to: Session): Relation {
    const me = this.app.store.get(of);
    if (me?.parentId === to.id) return 'parent';
    if (me?.forkedFrom === to.id) return 'forked from';
    if (to.parentId === of && to.origin === 'spawn') return 'sub-session';
    if (to.forkedFrom === of) return 'fork';
    return 'other';
  }

  related(id: string): RelatedSessions {
    const s = this.session(id);
    const parent = s.parentId && this.app.store.get(s.parentId) ? this.meta(s.parentId) : null;
    return { parent, children: this.children(s.id).map((c) => this.meta(c.id)), forks: this.forks(s.id).map((f) => this.meta(f.id)) };
  }

  /**
   * A session named by id, or by its exact title (case-insensitive only when that is unambiguous). `among` limits
   * the search; an ambiguous title is refused with the ids to choose from.
   */
  resolve(ref: string, among?: Session[]): Session {
    const key = String(ref ?? '').trim();
    if (!key) throw new SubagentError('Name a session by id or title.');
    const pool = among ?? this.all();
    const byId = pool.find((s) => s.id === key) ?? (among ? undefined : this.app.store.get(key));
    if (byId) return byId;
    let hits = pool.filter((s) => s.title === key);
    if (!hits.length) hits = pool.filter((s) => s.title.toLowerCase() === key.toLowerCase());
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new SubagentError(`${hits.length} sessions are titled "${key}"; name one by id: ${hits.map((s) => s.id).join(', ')}.`);
    throw new SubagentError(`No session with the id or title "${key}".`);
  }

  /** running, waiting for the user, merged, or idle */
  state(id: string): string {
    const st = this.app.runtime.status(id);
    if (st.attention === 'approval') return 'waiting for the user (approval)';
    if (st.attention === 'plan') return 'waiting for the user (plan)';
    if (st.running) return 'running';
    if (this.app.store.get(id)?.mergedInto) return 'merged';
    return 'idle';
  }

  /** First line of the session's last assistant text, or '' */
  lastReplyLine(s: Session, max = 120): string {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i];
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        const line = m.content.trim().split('\n').find((l) => l.trim()) ?? '';
        return clip(line.trim(), max) + (line.trim().length > max ? '…' : '');
      }
    }
    return '';
  }

  // ---------- Events: who started each run, reports, the cap ----------

  /** Wired to app.events by setupSubagents. */
  onEvent(sessionId: string, ev: AgentEvent): void {
    if (ev.type === 'run_start') this.runOrigin.set(sessionId, null);
    else if (ev.type === 'user_message') {
      if (this.runOrigin.has(sessionId) && this.runOrigin.get(sessionId) === null) this.runOrigin.set(sessionId, ev.origin);
      // The user wrote here (typed, or queued while it ran): reports may flow again
      if (ev.origin === 'user' || ev.origin === 'queue' || ev.origin === 'remote') {
        this.notes.delete(sessionId);
        this.capNoticed.delete(sessionId);
      }
    } else if (ev.type === 'run_end') {
      const origin = this.runOrigin.get(sessionId);
      this.runOrigin.delete(sessionId);
      // Only a run another session started (the spawn, or a session_send) reports back; a turn the user drove by hand does not.
      if (origin === 'session') this.report(sessionId, ev);
    }
  }

  private report(childId: string, ev: Extract<AgentEvent, { type: 'run_end' }>): void {
    const child = this.app.store.get(childId);
    if (!child || child.origin !== 'spawn' || !child.parentId || child.mergedInto) return;
    const parentId = child.parentId;
    if (!this.app.store.get(parentId)) return;
    const count = this.notes.get(parentId) ?? 0;
    if (count >= NOTE_CAP) {
      if (!this.capNoticed.has(parentId)) {
        this.capNoticed.add(parentId);
        this.notice(
          parentId,
          `[Reports from sub-sessions are paused: ${NOTE_CAP} arrived here without a message from the user in between. They resume after the user's next message; session_list and session_read still show what the sub-sessions did.]`,
        );
      }
      return;
    }
    this.notes.set(parentId, count + 1);
    this.deliver(parentId, this.noteText(child, ev), childId);
  }

  noteText(child: Session, ev: Extract<AgentEvent, { type: 'run_end' }>): string {
    const reason = { done: 'done', error: 'it ended with an error', max_turns: 'it reached the turn limit', plan: 'a plan waits for approval', aborted: 'it was stopped' }[ev.reason] ?? ev.reason;
    const text = (ev.text ?? '').trim();
    const reply = text ? clip(text, NOTE_REPLY_CHARS) + (Array.from(text).length > NOTE_REPLY_CHARS ? ' …' : '') : '(no reply text)';
    return [
      `[Sub-session "${child.title}" (${child.id}) finished a turn: ${reason}]`,
      reply,
      '',
      `Next: read more with session_read, answer it with session_send, or bring the result in with session_merge (id ${child.id}).`,
    ].join('\n');
  }

  /** Sends a report; when every run slot is busy it is tried again a little later (a few times). */
  private deliver(parentId: string, text: string, from: string, attempt = 0): void {
    const r = this.app.runtime.send(parentId, text, [], { origin: 'session', from });
    if (r.ok || attempt >= 20 || !this.app.store.get(parentId)) {
      if (!r.ok) console.warn('[subagents] a report could not be delivered:', r.error);
      return;
    }
    const t = setTimeout(() => this.deliver(parentId, text, from, attempt + 1), this.retryMs);
    t.unref?.();
  }

  /**
   * Adds a user-role message to a session without starting a run, and shows it in its transcript (a checkpoint with
   * origin 'command' keeps the label after a reload). While the session runs it is queued instead, so it cannot land
   * between a tool call and its result.
   */
  notice(sessionId: string, text: string, from = 'sessions'): void {
    const s = this.app.store.get(sessionId);
    if (!s) return;
    if (this.app.runtime.isRunning(sessionId)) {
      this.app.runtime.send(sessionId, text, [], { origin: 'command', from });
      return;
    }
    s.turns ??= [];
    const turn: Turn = { at: s.messages.length, createdAt: Date.now(), text, files: {}, origin: 'command', from };
    s.turns.push(turn);
    this.app.store.append(s, { role: 'user', content: text });
    this.app.store.save(s);
    this.emit(sessionId, { type: 'user_message', text, images: 0, origin: 'command', turn: s.turns.length - 1, from });
    this.emit(sessionId, { type: 'session_changed', session: toMeta(s) });
  }

  /** Hands an event to a session's stream (app.events listeners and the window) the way its agent would. */
  private emit(sessionId: string, ev: AgentEvent): void {
    this.app.runtime.emit(sessionId, ev);
  }

  /** The window's session list (mergedInto changed). */
  private listChanged(): void {
    this.app.push('sessions:changed', this.app.runtime.list());
  }

  // ---------- Spawn ----------

  /** Throws a SubagentError when `parentId` may not start another sub-session now. */
  checkSpawn(parentId: string): Session {
    const parent = this.session(parentId);
    if (this.depth(parent.id) >= MAX_DEPTH) throw new SubagentError(`This session is already a sub-session of a sub-session (depth ${MAX_DEPTH}); it cannot start sub-sessions of its own. Do the work here, or report back and let the parent start one.`);
    const kids = this.children(parent.id);
    if (kids.length >= MAX_CHILDREN) throw new SubagentError(`This session has already started ${MAX_CHILDREN} sub-sessions, the limit. Reuse one with session_send, or do the work here.`);
    const running = kids.filter((k) => this.app.runtime.isRunning(k.id)).length;
    if (running >= MAX_RUNNING_CHILDREN) throw new SubagentError(`${MAX_RUNNING_CHILDREN} sub-sessions of this session are running, the limit. Wait for one to report, then start the next.`);
    if (this.app.runtime.running().length >= MAX_RUNNING) throw new SubagentError(`${MAX_RUNNING} sessions are running in the app, the limit. Wait for one to finish, then start the sub-session.`);
    return parent;
  }

  spawn(parentId: string, input: { title: string; prompt: string }): SessionMeta {
    const title = clip(String(input?.title ?? '').replace(/\s+/g, ' ').trim(), 80).trim();
    const prompt = String(input?.prompt ?? '').trim();
    if (!title) throw new SubagentError('A sub-session needs a title.');
    if (!prompt) throw new SubagentError('A sub-session needs a prompt: its whole brief.');
    const parent = this.checkSpawn(parentId);
    const cwd = parent.cwd ?? this.app.config().workingDirectory;
    const meta = this.app.runtime.create({ cwd, parentId: parent.id, origin: 'spawn', title, foreground: false });
    const r = this.app.runtime.send(meta.id, prompt, [], { origin: 'session', from: parent.id });
    if (!r.ok) {
      this.app.runtime.forget(meta.id);
      this.app.store.delete(meta.id);
      throw new SubagentError(`The sub-session could not start: ${r.error ?? 'unknown error'}`);
    }
    return this.meta(meta.id);
  }

  // ---------- Messages ----------

  /** Frames the text so the receiving model knows who wrote it, and delivers it (a run there, or queued). */
  message(fromId: string, toId: string, text: string): SendResult {
    const body = String(text ?? '').trim();
    if (!body) return { ok: false, error: 'Nothing to send.' };
    const from = this.app.store.get(String(fromId));
    const to = this.app.store.get(String(toId));
    if (!to) return { ok: false, error: `No session with id "${toId}".` };
    if (from && from.id === to.id) return { ok: false, error: 'A session cannot send a message to itself.' };
    const head = messageHead(from, from ? this.relationWord(to.id, from) : '');
    return this.app.runtime.send(to.id, `${head}\n${body}`, [], { origin: 'session', from: from?.id });
  }

  private relationWord(of: string, other: Session): string {
    const r = this.relation(of, other);
    return r === 'other' ? 'peer session' : r === 'forked from' ? 'source session' : r;
  }

  /** True when `from` may write to `to` without an approval: its parent or one of its own sub-sessions. */
  closeKin(fromId: string, to: Session): boolean {
    const from = this.app.store.get(fromId);
    return !!from && (from.parentId === to.id || (to.parentId === from.id && to.origin === 'spawn'));
  }

  // ---------- Merge ----------

  /** What a merge of `from` into `into` would summarise, or a refusal. */
  private mergeSource(intoId: string, fromId: string, viaTool: boolean): { into: Session; from: Session; kind: 'sub-session' | 'fork'; messages: Msg[] } {
    const into = this.session(intoId);
    const from = this.session(fromId);
    if (into.id === from.id) throw new SubagentError('A session cannot be merged into itself.');
    const kind = from.parentId === into.id && from.origin === 'spawn' ? 'sub-session' : from.forkedFrom === into.id ? 'fork' : null;
    if (!kind) throw new SubagentError(`"${from.title}" is not a sub-session or fork of "${into.title}"; only those can be merged into it.`);
    if (from.mergedInto) {
      const target = this.app.store.get(from.mergedInto);
      throw new SubagentError(`"${from.title}" was already merged${target ? ` into "${target.title}"` : ''}. It stays readable with session_read.`);
    }
    if (this.merging.has(from.id)) throw new SubagentError(`"${from.title}" is being merged right now.`);
    if (this.app.runtime.isRunning(from.id)) throw new SubagentError(`"${from.title}" is still running. Wait for it to report, then merge it.`);
    if (!viaTool && this.app.runtime.isRunning(into.id)) throw new SubagentError(`"${into.title}" is running. Wait for the run to end, then merge.`);
    let messages: Msg[];
    if (kind === 'sub-session') messages = [...(from.compactions ?? []).flatMap((c) => c.folded), ...from.messages];
    else {
      // A fork that compacted after the split no longer has its seed in front; its live messages are then all its own.
      const seed = from.seedLength ?? 0;
      messages = seed <= from.messages.length ? from.messages.slice(seed) : from.messages;
    }
    if (!messages.some((m) => m.role === 'assistant')) throw new SubagentError(`Nothing to merge: "${from.title}" has done nothing ${kind === 'fork' ? 'since it split off' : 'yet'}.`);
    return { into, from, kind, messages };
  }

  /**
   * Merges a sub-session or fork into the session it came from. With `viaTool` the report is only returned (the
   * tool result puts it in the caller's context); otherwise it is added to the target's conversation.
   */
  async mergeFull(intoId: string, fromId: string, opts: { viaTool?: boolean } = {}): Promise<MergeOutcome> {
    let src: ReturnType<Subagents['mergeSource']>;
    try {
      src = this.mergeSource(intoId, fromId, opts.viaTool === true);
    } catch (err) {
      if (err instanceof SubagentError) return { ok: false, error: err.message };
      throw err;
    }
    const { into, from, kind, messages } = src;
    this.merging.add(from.id);
    let report: string;
    try {
      report = await this.summarize(from.title, kind, messages);
    } catch (err) {
      return { ok: false, error: `The merge summary could not be written: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.merging.delete(from.id);
    }
    if (from.mergedInto) return { ok: false, error: `"${from.title}" was merged meanwhile.` };
    if (!this.app.store.get(into.id)) return { ok: false, error: 'The target session was deleted.' };
    const text = mergedText(from.title, report);
    if (!opts.viaTool) this.notice(into.id, text, from.id);
    from.mergedInto = into.id;
    from.mergedAt = Date.now();
    this.app.store.save(from, false);
    this.emit(from.id, { type: 'session_changed', session: toMeta(from) });
    this.listChanged();
    return { ok: true, text, title: from.title };
  }

  async merge(intoId: string, fromId: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.mergeFull(intoId, fromId);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** Sub-sessions and forks of `id` that /merge could take now: not merged, not running. */
  mergeable(id: string): Session[] {
    return [...this.children(id), ...this.forks(id)].filter((s) => !s.mergedInto && !this.app.runtime.isRunning(s.id));
  }

  // ---------- Text views (session_list, /sessions, session_read) ----------

  line(of: string, s: Session, relation = this.relation(of, s)): string {
    const last = this.lastReplyLine(s);
    return `${s.id}  "${s.title}"  ${relation}  ${this.state(s.id)}${last ? `  last: ${last}` : ''}`;
  }

  /** The related sessions, then up to `others` recent other ones. */
  listText(id: string, others = 10): string {
    const me = this.session(id);
    const rel: { s: Session; r: Relation }[] = [];
    const seen = new Set<string>([me.id]);
    const add = (s: Session | undefined, r: Relation) => {
      if (s && !seen.has(s.id)) {
        seen.add(s.id);
        rel.push({ s, r });
      }
    };
    if (me.parentId) add(this.app.store.get(me.parentId), 'parent');
    if (me.forkedFrom) add(this.app.store.get(me.forkedFrom), 'forked from');
    for (const c of this.children(me.id)) add(c, 'sub-session');
    for (const f of this.forks(me.id)) add(f, 'fork');
    const rest = this.all()
      .filter((s) => !seen.has(s.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, others);
    const out: string[] = [`This session: ${me.id} "${me.title}"`];
    out.push(rel.length ? `Related (${rel.length}):` : 'Related: none.');
    for (const { s, r } of rel) out.push(`  ${this.line(me.id, s, r)}`);
    if (rest.length) {
      out.push(`Other recent sessions (${rest.length}):`);
      for (const s of rest) out.push(`  ${this.line(me.id, s, 'other')}`);
    }
    return out.join('\n');
  }

  /** The last `last` messages of a session as text. */
  readText(id: string, last = 6): string {
    const s = this.session(id);
    const n = Math.max(1, Math.min(30, Math.floor(Number(last) || 6)));
    const msgs = s.messages.slice(-n);
    const names = new Map<string, string>();
    for (const m of s.messages) if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) if (tc.type === 'function') names.set(tc.id, tc.function.name);
    const text = (c: unknown) =>
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: string }).text) : '[image]')).join('\n')
          : '';
    const cut = (t: string, max: number) => (t.length <= max ? t : `${t.slice(0, max)} …[${t.length - max} more characters]`);
    const lines = msgs.map((m) => {
      if (m.role === 'user') return `USER: ${cut(text(m.content).trim(), 4000)}`;
      if (m.role === 'assistant') {
        const parts = [];
        const t = text(m.content).trim();
        if (t) parts.push(`ASSISTANT: ${cut(t, 4000)}`);
        for (const tc of m.tool_calls ?? []) if (tc.type === 'function') parts.push(`ASSISTANT CALLS ${tc.function.name}(${cut(tc.function.arguments, 300)})`);
        return parts.join('\n') || 'ASSISTANT: (empty)';
      }
      if (m.role === 'tool') return `RESULT OF ${names.get(m.tool_call_id) ?? 'tool'}: ${cut(text(m.content).trim(), 500)}`;
      return '';
    });
    const head = `Session ${s.id} "${s.title}" (${this.state(s.id)}): the last ${one(msgs.length, 'message')} of ${s.messages.length}.`;
    return [head, '', ...lines.filter(Boolean)].join('\n\n').replace(/\n\n\n/, '\n');
  }
}
