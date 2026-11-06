// The model's side: start sub-sessions, message other sessions, list and read them, and merge a finished one.

import type { Tool, ToolContext, ToolResult } from '../tools/types';
import { SubagentError, type Subagents } from './service';

async function guarded(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SubagentError) return { content: `Error: ${err.message}` };
    throw err;
  }
}

export function subagentTools(svc: Subagents): Tool[] {
  const spawn: Tool = {
    name: 'session_spawn',
    description:
      'Start a sub-session: a separate agent session in the same folder that works on a piece of the job in the background, side by side with this one, and shows under this session in the sidebar. Returns at once; the sub-session reports here by itself each time it finishes a turn, so do not wait or poll. ' +
      'The sub-session knows nothing of this conversation: `prompt` is its whole brief. Make it self-contained: the goal, the files or area to work on, what done looks like, and what to report back. ' +
      'Use it for independent pieces of work that can run in parallel, or a side investigation that should not fill this conversation. Limits: at most 4 running and 12 in all per session; a sub-session of a sub-session cannot start more.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the sidebar, a few words' },
        prompt: { type: 'string', description: 'The complete, self-contained brief for the sub-session' },
      },
      required: ['title', 'prompt'],
    },
    run: (args: { title?: unknown; prompt?: unknown }, ctx: ToolContext) =>
      guarded(async () => {
        const title = String(args?.title ?? '').trim();
        const prompt = String(args?.prompt ?? '').trim();
        if (!title) throw new SubagentError('give the sub-session a title.');
        if (!prompt) throw new SubagentError('give the sub-session a prompt: its whole, self-contained brief.');
        // Check the limits first, so the user is never asked about a sub-session that cannot start
        svc.checkSpawn(ctx.sessionId);
        const ok = await ctx.approve('session_spawn', `Start sub-session "${title}"\n\n${prompt}`, undefined, { custom: true });
        if (!ok.ok) return { content: `Not started: ${ok.message}` };
        const meta = svc.spawn(ctx.sessionId, { title, prompt });
        return { content: `Started sub-session "${meta.title}" (id ${meta.id}). It runs in the background and will report here when it finishes a turn; carry on with other work meanwhile.` };
      }),
  };

  const send: Tool = {
    name: 'session_send',
    description:
      'Send a message to another session, named by id or exact title. It starts a turn there, or waits behind the turn in progress. Use it to answer or steer one of your sub-sessions, or to tell your parent session something it needs before you finish. Messages to sessions other than your parent or your own sub-sessions need the user\'s approval.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The session id, or its exact title' },
        message: { type: 'string', description: 'What to say; the receiving session sees who sent it' },
      },
      required: ['to', 'message'],
    },
    run: (args: { to?: unknown; message?: unknown }, ctx: ToolContext) =>
      guarded(async () => {
        const target = svc.resolve(String(args?.to ?? ''));
        const message = String(args?.message ?? '').trim();
        if (!message) throw new SubagentError('the message is empty.');
        if (target.id === ctx.sessionId) throw new SubagentError('that is this session.');
        if (!svc.closeKin(ctx.sessionId, target)) {
          // Words put into a conversation this model was never part of: the user decides
          const ok = await ctx.approve('session_send', `Send to session "${target.title}" (${target.id}):\n\n${message}`, undefined, { custom: true });
          if (!ok.ok) return { content: `Not sent: ${ok.message}` };
        }
        const r = svc.message(ctx.sessionId, target.id, message);
        if (!r.ok) return { content: `Error: ${r.error ?? 'the message could not be delivered.'}` };
        return { content: `Delivered to "${target.title}" (${target.id})${r.queued ? '; it is busy, so the message waits for its current step to end' : ' and it started working on it'}.` };
      }),
  };

  const list: Tool = {
    name: 'session_list',
    description: 'List the sessions related to this one (parent, sub-sessions, forks), then other recent sessions: id, title, relation, state (running, waiting for the user, idle, merged) and the first line of the last reply.',
    parameters: { type: 'object', properties: {} },
    readOnly: true,
    run: (_args: unknown, ctx: ToolContext) => guarded(() => ({ content: svc.listText(ctx.sessionId) })),
  };

  const read: Tool = {
    name: 'session_read',
    description: 'Read the last messages of another session (a sub-session, a fork, the parent, …) as text; tool results are cut short. This is how you look at what a sub-session did in detail.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The session id (or its exact title)' },
        last: { type: 'number', description: 'How many of its last messages, default 6, at most 30' },
      },
      required: ['id'],
    },
    readOnly: true,
    run: (args: { id?: unknown; last?: unknown }) => guarded(() => ({ content: svc.readText(svc.resolve(String(args?.id ?? '')).id, args?.last === undefined ? 6 : Number(args.last)) })),
  };

  const merge: Tool = {
    name: 'session_merge',
    description:
      'Merge a finished sub-session or fork of this session into this one: a summary of what it did (for a fork: since it split off) comes back as the result, and it is marked merged. Merge one before relying on its result. ' +
      'Only the conversation is merged: file changes need no merging, since all sessions work in the same folder (this is not a git merge). Refused while it is running or when it was merged already.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The sub-session or fork, by id (or exact title)' } }, required: ['id'] },
    run: (args: { id?: unknown }, ctx: ToolContext) =>
      guarded(async () => {
        const ref = String(args?.id ?? '');
        const related = [...svc.children(ctx.sessionId), ...svc.forks(ctx.sessionId)];
        let id: string;
        try {
          id = svc.resolve(ref, related).id;
        } catch {
          id = svc.resolve(ref).id; // not related: let the merge say why it is refused
        }
        const r = await svc.mergeFull(ctx.sessionId, id, { viaTool: true });
        if (!r.ok) return { content: `Error: ${r.error}` };
        return { content: r.text ?? '' };
      }),
  };

  return [spawn, send, list, read, merge];
}
