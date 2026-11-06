// The user's side: /spawn, /merge, /sessions and /send, on the session on screen.

import type { Command } from '../app';
import type { CommandResult } from '../../shared/types';
import { SubagentError, type Relation, type Subagents } from './service';
import type { Session } from '../sessions';

/** A sidebar title from the first words of a task. */
export function titleFromTask(task: string): string {
  const words = task.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  const t = words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words;
  return t.replace(/[\s.,;:!?]+$/, '') || 'Sub-session';
}

function refused(err: unknown): CommandResult {
  if (err instanceof SubagentError) return { error: err.message };
  throw err;
}

/** A related session by id, or by a case-insensitive title that matches exactly one. */
function pick(pool: Session[], ref: string): Session {
  const key = ref.trim();
  const byId = pool.find((s) => s.id === key);
  if (byId) return byId;
  const hits = pool.filter((s) => s.title.toLowerCase() === key.toLowerCase());
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new SubagentError(`${hits.length} sessions here are titled "${key}"; use an id:\n${hits.map((s) => `${s.id}  "${s.title}"`).join('\n')}`);
  throw new SubagentError(`No sub-session or fork of this session matches "${key}". /sessions lists them.`);
}

export function subagentCommands(svc: Subagents): Command[] {
  return [
    {
      name: 'spawn',
      description: 'Start a sub-session with this task; it runs in the background and reports here',
      source: 'app',
      argsHint: '<task>',
      run: (args, { sessionId }) => {
        const task = args.trim();
        if (!task) return { error: 'Usage: /spawn <task>. The task is the sub-session\'s whole brief.' };
        try {
          const meta = svc.spawn(sessionId, { title: titleFromTask(task), prompt: task });
          return { notice: `Started sub-session "${meta.title}". It runs in the background and reports here when it finishes a turn.` };
        } catch (err) {
          return refused(err);
        }
      },
    },
    {
      name: 'merge',
      description: 'Merge a finished sub-session or fork into this session',
      source: 'app',
      argsHint: '[title or id]',
      run: async (args, { sessionId }) => {
        try {
          const ref = args.trim();
          let src: Session;
          if (ref) src = pick([...svc.children(sessionId), ...svc.forks(sessionId)], ref);
          else {
            const ready = svc.mergeable(sessionId);
            if (!ready.length) {
              const running = [...svc.children(sessionId), ...svc.forks(sessionId)].filter((s) => !s.mergedInto).length;
              return { notice: running ? 'Nothing to merge yet: the sub-sessions and forks of this session are still running.' : 'Nothing to merge: this session has no unmerged sub-sessions or forks.' };
            }
            if (ready.length > 1) return { notice: `${ready.length} sessions can be merged; name one with /merge <title or id>:\n${ready.map((s) => `${s.id}  "${s.title}"  ${svc.relation(sessionId, s)}`).join('\n')}` };
            src = ready[0];
          }
          const r = await svc.mergeFull(sessionId, src.id);
          if (!r.ok) return { error: r.error };
          return { notice: `Merged "${r.title}" into this session.` };
        } catch (err) {
          return refused(err);
        }
      },
    },
    {
      name: 'sessions',
      description: 'List the sub-sessions, forks and parent of this session with their state',
      source: 'app',
      run: (_args, { sessionId }) => {
        try {
          const rel = svc.related(sessionId);
          const rows: string[] = [];
          const add = (id: string, r: Relation) => {
            const s = svc.resolve(id);
            rows.push(svc.line(sessionId, s, r));
          };
          if (rel.parent) add(rel.parent.id, 'parent');
          for (const c of rel.children) add(c.id, 'sub-session');
          for (const f of rel.forks) add(f.id, 'fork');
          if (!rows.length) return { notice: 'This session has no parent, sub-sessions or forks. Start one with /spawn <task>.' };
          return { notice: `${rows.length} related session${rows.length === 1 ? '' : 's'}:\n${rows.join('\n')}` };
        } catch (err) {
          return refused(err);
        }
      },
    },
    {
      name: 'send',
      description: 'Send a message to another session',
      source: 'app',
      argsHint: '<title or id>: <message>',
      run: (args, { sessionId }) => {
        const text = args.trim();
        const usage = { error: 'Usage: /send <title or id>: <message>' };
        if (!text.includes(':')) return usage;
        // A title may hold a colon itself: the first prefix that names a session wins
        let lastErr: unknown = null;
        for (let i = text.indexOf(':'); i >= 0; i = text.indexOf(':', i + 1)) {
          const ref = text.slice(0, i).trim();
          const message = text.slice(i + 1).trim();
          if (!ref) continue;
          let target: Session;
          try {
            target = svc.resolve(ref);
          } catch (err) {
            lastErr = err;
            continue;
          }
          if (!message) return usage;
          if (target.id === sessionId) return { error: 'That is this session.' };
          const r = svc.message(sessionId, target.id, message);
          if (!r.ok) return { error: r.error ?? 'The message could not be delivered.' };
          return { notice: `Sent to "${target.title}"${r.queued ? ' (queued behind its current run)' : ''}.` };
        }
        return lastErr ? refused(lastErr) : usage;
      },
    },
  ];
}
