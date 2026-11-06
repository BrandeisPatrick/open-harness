// Rebuilding the conversation from the log's conversation records. Used by crash recovery and by the tests that
// prove the log is complete: replaying a whole log from nothing gives the session's current messages exactly.

import type { HistoryRecord } from '../../shared/history';
import type { Msg } from '../sessions';

/** The agent's own text for a tool call that never produced a result (agent.ts repairTail). */
export const INTERRUPTED_RESULT = 'Tool call was interrupted before it produced a result.';

export const CONVERSATION_TYPES = new Set(['message.append', 'messages.truncate', 'messages.replace']);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface ReplayResult {
  messages: Msg[];
  /** An append pointed past the end of what was known: records are missing before it */
  gap: boolean;
}

/**
 * Applies conversation records to `base` (default: nothing) and returns the result; `base` is not changed.
 * Idempotent against a base that already holds some of the records' effects (a session file saved just before
 * a crash, or a second recovery): an append whose message is already at its index is skipped, so nothing is
 * ever duplicated. A `messages.replace` is applied the same way whatever its reason (compaction, prune, fork, …).
 */
export function replayConversation(records: HistoryRecord[], base: Msg[] = []): ReplayResult {
  const msgs: Msg[] = structuredClone(base);
  let gap = false;
  for (const r of records) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    if (r.type === 'message.append') {
      const index = typeof d.index === 'number' ? d.index : msgs.length;
      const message = d.message as Msg | undefined;
      if (!message) continue;
      if (index < msgs.length) {
        if (same(msgs[index], message)) continue;
        msgs.splice(index); // the log says the conversation went another way from here
      } else if (index > msgs.length) gap = true;
      msgs.push(structuredClone(message));
    } else if (r.type === 'messages.truncate') {
      const length = typeof d.length === 'number' ? Math.max(0, d.length) : msgs.length;
      if (length < msgs.length) msgs.splice(length);
    } else if (r.type === 'messages.replace') {
      if (Array.isArray(d.messages)) msgs.splice(0, msgs.length, ...structuredClone(d.messages as Msg[]));
    }
  }
  return { messages: msgs, gap };
}

/** The results missing after the last assistant turn's tool calls (the shape agent.ts repairTail fixes). */
export function missingToolResults(msgs: Msg[]): Msg[] {
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].role !== 'assistant') i--;
  const last = msgs[i];
  if (!last || last.role !== 'assistant' || !last.tool_calls?.length) return [];
  const answered = new Set(msgs.slice(i + 1).flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : [])));
  return last.tool_calls.filter((c) => !answered.has(c.id)).map((c) => ({ role: 'tool', tool_call_id: c.id, content: INTERRUPTED_RESULT }) as Msg);
}

/** True when the log's last run.start has no run.end after it. */
export function hasOpenRun(records: HistoryRecord[]): boolean {
  let open = false;
  for (const r of records) {
    if (r.type === 'run.start') open = true;
    else if (r.type === 'run.end') open = false;
  }
  return open;
}

/** Index of the last snapshot record, or -1. */
export function lastSnapshot(records: HistoryRecord[]): number {
  for (let i = records.length - 1; i >= 0; i--) if (records[i].type === 'snapshot') return i;
  return -1;
}
