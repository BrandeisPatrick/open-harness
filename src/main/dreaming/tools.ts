// The tools only a dream's session has: two for looking further into history, one per kind of proposal, and one to
// take a proposal back. Proposals go to the Dreaming service, which records them and, in Auto mode, applies them.

import type { DreamProposal, ProposalKind } from '../../shared/dreaming';
import type { HistoryService } from '../services';
import type { Tool, ToolContext, ToolResult } from '../tools/types';
import { DreamError } from './apply';
import { clipText, conversationText, when } from './digest';
import type { App } from '../app';

/** What the tools need of the service */
export interface ProposalSink {
  propose(sessionId: string, kind: ProposalKind, input: Record<string, unknown>): DreamProposal;
  withdraw(sessionId: string, proposalId: string, reason: string): DreamProposal;
}

/** The reading tools a dream gets besides these (built in, and the session tools when that feature is there) */
export const READING_TOOLS = ['read_file', 'glob', 'grep', 'list_directory', 'session_list', 'session_read'];
export const HISTORY_TOOLS = ['history_read', 'history_search'];
export const KIND_TOOLS: Record<ProposalKind, string> = { skill: 'propose_skill', memory: 'propose_memory', mod: 'propose_mod' };
export const WITHDRAW_TOOL = 'withdraw_proposal';

/** A dream session's tool set: reading, history, the proposal tools for what the user wants looked for. */
export function dreamToolNames(lookFor: { skills: boolean; mods: boolean; memory: boolean }): string[] {
  const kinds: ProposalKind[] = [];
  if (lookFor.skills) kinds.push('skill');
  if (lookFor.memory) kinds.push('memory');
  if (lookFor.mods) kinds.push('mod');
  return [...READING_TOOLS, ...HISTORY_TOOLS, ...kinds.map((k) => KIND_TOOLS[k]), WITHDRAW_TOOL];
}

async function guarded(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DreamError) return { content: `Error: ${err.message}` };
    throw err;
  }
}

const STATE_WORDS: Record<DreamProposal['state'], string> = {
  waiting: 'it waits for the user to apply or dismiss it',
  planned: 'it is part of the plan the user will see when this review ends',
  applied: 'the app applied it',
  dismissed: 'the user dismissed it',
  withdrawn: 'withdrawn',
  reverted: 'the user reverted it',
  failed: 'applying it failed',
};

/** The tool result for a proposal just made (the window turns it into the proposal's card by the id in it). */
export function proposalResult(p: DreamProposal): string {
  const where = p.kind === 'memory' ? p.target : p.target;
  if (p.state === 'failed') return `Error: recorded proposal ${p.id}, but applying it failed: ${p.error ?? 'unknown error'}. Fix what the error says and propose again with replaces "${p.id}", or leave it.`;
  return `Recorded proposal ${p.id} (${p.title}${p.changesExisting ? ', changes what exists' : ''}): ${STATE_WORDS[p.state]}${p.state === 'applied' ? ` (${where})` : ''}.`;
}

const why = { type: 'string', description: 'Why, with the evidence: quote the user\'s own words from the sessions, and say how often it came up' };
const sessions = { type: 'array', items: { type: 'string' }, description: 'The ids of the sessions this is based on (from the digest)' };
const changes = { type: 'boolean', description: 'true when this changes something that exists (a skill or mod of that name, memory lines you remove); required then' };
const replaces = { type: 'string', description: 'The id of one of your proposals that this one replaces (it is withdrawn)' };
const scope = { type: 'string', enum: ['project', 'user'], description: 'project: only this project. user: every project of this user' };

export function dreamTools(app: App, sink: ProposalSink): Tool[] {
  const propose = (kind: ProposalKind) => (args: Record<string, unknown>, ctx: ToolContext) => guarded(() => ({ content: proposalResult(sink.propose(ctx.sessionId, kind, args ?? {})) }));

  const skill: Tool = {
    name: 'propose_skill',
    description:
      'Propose a skill: a procedure the user asked for more than once, written as instructions the agent follows when the user runs /<name> or the task matches the description. The app writes <scope>/skills/<name>/SKILL.md when the proposal is applied, never you.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lower-case letters, digits and -, e.g. "release-notes"' },
        description: { type: 'string', description: 'One line: when to use it' },
        body: { type: 'string', description: 'The instructions in Markdown: the steps, in order, with the commands and checks the user wanted' },
        scope,
        why,
        sessions,
        changes_existing: changes,
        replaces,
      },
      required: ['name', 'description', 'body', 'scope', 'why', 'sessions'],
    },
    scoped: true,
    run: propose('skill'),
  };

  const memory: Tool = {
    name: 'propose_memory',
    description:
      "Propose memory: lines for the instructions file the agent reads at the start of every run (the project's, or the user's for every project), for durable preferences, corrections and facts. Lines to remove must be written exactly as the file has them.",
    parameters: {
      type: 'object',
      properties: {
        scope,
        add: { type: 'array', items: { type: 'string' }, description: 'Lines to add, one fact or preference each (each becomes a "- " bullet)' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Lines of the file that are wrong or outdated, exactly as written there' },
        why,
        sessions,
        changes_existing: changes,
        replaces,
      },
      required: ['scope', 'why', 'sessions'],
    },
    scoped: true,
    run: propose('memory'),
  };

  const mod: Tool = {
    name: 'propose_mod',
    description:
      'Propose a mod: a view or status the user keeps asking for, as a folder of web files with a mod.json (see the mods documentation the app follows: protocol 1, id, name, version, contributes.views with a seat). It is checked the way the app checks every mod, written to <scope>/mods/<id>/ when applied, and stays off until the user turns it on.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The mod id and folder name: lower-case letters, digits and -' },
        name: { type: 'string' },
        description: { type: 'string' },
        scope,
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string', description: 'Relative path inside the mod folder, e.g. "mod.json", "panel.html"' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
        why,
        sessions,
        changes_existing: changes,
        replaces,
      },
      required: ['id', 'name', 'scope', 'files', 'why', 'sessions'],
    },
    scoped: true,
    run: propose('mod'),
  };

  const withdraw: Tool = {
    name: 'withdraw_proposal',
    description: 'Take back one of your proposals in this dream (one that has not been applied), e.g. when the user says it is wrong.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The proposal id (pr_…)' }, reason: { type: 'string' } }, required: ['id'] },
    scoped: true,
    run: (args: { id?: unknown; reason?: unknown }, ctx: ToolContext) =>
      guarded(() => {
        const p = sink.withdraw(ctx.sessionId, String(args?.id ?? ''), String(args?.reason ?? ''));
        return { content: `Withdrew ${p.id} (${p.title}).` };
      }),
  };

  const historyRead: Tool = {
    name: 'history_read',
    description:
      "Read any part of one session's whole conversation (also what compactions folded away), numbered from #0, tool results cut short. Use it when the digest's skeleton is not enough to judge a pattern.",
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The session id' },
        start: { type: 'number', description: 'The first message number (default 0)' },
        count: { type: 'number', description: 'How many messages (default 40, at most 120)' },
      },
      required: ['session'],
    },
    readOnly: true,
    scoped: true,
    run: (args: { session?: unknown; start?: unknown; count?: unknown }) =>
      guarded(() => {
        const id = String(args?.session ?? '').trim();
        const s = app.store.get(id);
        if (!s) throw new DreamError(`no session with the id "${id}".`);
        const count = Math.min(120, Math.max(1, Number(args?.count) || 40));
        const { text, total } = conversationText(s, Number(args?.start) || 0, count);
        return { content: `Session "${s.title}" (${s.id}), ${total} messages:\n${text || '(nothing in that range)'}` };
      }),
  };

  const historySearch: Tool = {
    name: 'history_search',
    description: 'Search the text of every session (messages, tool calls and results) for words; every word must match. Returns one line per session, newest first, with a snippet. Use it to see whether something the user asked came up in other sessions too.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'At most this many sessions (default 15)' } }, required: ['query'] },
    readOnly: true,
    scoped: true,
    run: (args: { query?: unknown; limit?: unknown }) =>
      guarded(() => {
        const svc = app.service<HistoryService>('history');
        if (!svc) throw new DreamError('search is not available in this app.');
        const query = String(args?.query ?? '').trim();
        if (!query) throw new DreamError('give the words to search for.');
        const limit = Math.min(40, Math.max(1, Number(args?.limit) || 15));
        const hits = svc.search(query, { limit: limit + 10 }).filter((h) => app.store.get(h.sessionId)?.origin !== 'dream').slice(0, limit);
        if (!hits.length) return { content: `No session matches "${query}".` };
        const cwd = (id: string) => app.store.get(id)?.cwd ?? '';
        return { content: hits.map((h) => `${h.sessionId} · "${h.title}" · ${when(h.updatedAt)} · ${cwd(h.sessionId)} · ${h.count} match${h.count === 1 ? '' : 'es'} · ${h.role}: ${clipText(h.snippet, 200)}`).join('\n') };
      }),
  };

  return [historyRead, historySearch, skill, memory, mod, withdraw];
}
