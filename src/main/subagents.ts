// Feature: sub-sessions, messages between sessions, reports back to the parent, and merge (by tool and by slash
// command). Wires the Subagents service into the app: service, RPC, tools, prompt section, commands, event listener.

import type { App } from './app';
import type { SubagentsService } from './services';
import { Subagents, MAX_DEPTH, type SubagentsOptions } from './subagents/service';
import { subagentTools } from './subagents/tools';
import { subagentCommands } from './subagents/commands';

export { Subagents, SubagentError } from './subagents/service';
export type { SubagentsOptions } from './subagents/service';

const PROMPT_SECTION = [
  '## Sub-sessions',
  'You can start sub-sessions with session_spawn: real sessions in the same folder that run in the background, side by side with this one. They fit independent pieces of work that can run in parallel, or a side investigation that would otherwise fill this conversation; a small step you can do right away is quicker done yourself.',
  'A sub-session knows nothing of this conversation: its prompt is its whole brief. Make it self-contained: the goal, the files or area, what done looks like, and what to report.',
  'Each one reports here by itself when it finishes a turn, so do not poll it; end your turn if there is nothing else to do meanwhile. session_read shows what it did, session_send answers or steers it, session_list shows related sessions. Merge a finished one with session_merge before you use its result.',
].join('\n');

/** Called once from index.ts after the core is up. `opts` is for tests. Returns the service (also provided as 'subagents'). */
export function setupSubagents(app: App, opts: SubagentsOptions = {}): Subagents {
  const svc = new Subagents(app, opts);
  const service: SubagentsService = {
    spawn: (parentId, input) => svc.spawn(parentId, input),
    merge: (intoId, fromId) => svc.merge(intoId, fromId),
    related: (id) => svc.related(id),
  };
  app.provide('subagents', service);

  app.events.on((sessionId, ev) => svc.onEvent(sessionId, ev));

  // From the window: the user is the one asking, so no approval card
  app.rpc.handle('sessions.spawn', (parentId, input) => svc.spawn(String(parentId), input));
  app.rpc.handle('sessions.merge', (intoId, fromId) => svc.merge(String(intoId), String(fromId)));
  app.rpc.handle('sessions.related', (id) => svc.related(String(id)));
  app.rpc.handle('sessions.message', (fromId, toId, text) => svc.message(String(fromId), String(toId), String(text ?? '')));

  for (const tool of subagentTools(svc)) app.tools.register({ ...tool, optional: true });
  // How to use the session tools: left out with them when the tool set is trimmed for a small window.
  app.prompt.add('sessions', () => PROMPT_SECTION, { optional: true });
  // What a sub-session must know about itself, whatever tools it has (the user can start one with /spawn).
  app.prompt.add('sub-session', ({ sessionId }) => {
    const me = app.store.get(sessionId);
    const parent = me?.parentId ? app.store.get(me.parentId) : undefined;
    if (!me || me.origin !== 'spawn' || !parent) return '';
    const lines = [
      `This session is itself a sub-session of "${parent.title}" (${parent.id}). The last reply of each of your turns is reported to it automatically, so end every turn with a clear, self-contained report: what you did, what you found or answered (with the numbers and names), and the files you changed. Use session_send to it only for a question you cannot go on without.`,
    ];
    if (svc.depth(me.id) >= MAX_DEPTH) lines.push('It is nested as deep as allowed, so it cannot start sub-sessions of its own.');
    return lines.join('\n');
  });
  for (const cmd of subagentCommands(svc)) app.commands.register(cmd);
  return svc;
}
