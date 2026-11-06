// The live feed of the remote page: Server-Sent Events carrying every agent event of every session, plus the session
// list whenever a session's state moves. Text and thinking deltas arrive per token; a phone on Wi-Fi does not need
// fifty messages a second, so runs of them are joined into about one message per 100 ms per session.

import type { ServerResponse } from 'node:http';
import type { AgentEvent, SessionMeta } from '../../shared/types';
import { BASE_HEADERS } from './guard';
import { remoteEvent } from './sanitize';

export const MAX_STREAMS = 8;

type Delta = { type: 'text_delta' | 'thinking_delta'; text: string };

/**
 * Every agent event gets the next number; a streamed message carries the number of the last event it contains.
 * api/transcript answers with the number its snapshot covers, so the page can drop what the snapshot already holds
 * and apply the rest: nothing missed, nothing twice.
 */

/** Events after which the session list (with its run status) is sent again */
const MOVES_STATUS = new Set<AgentEvent['type']>(['run_start', 'run_end', 'session_changed', 'approval_request', 'approval_resolved', 'plan_proposed']);

export class EventStream {
  private clients = new Set<ServerResponse>();
  private pending = new Map<string, { delta: Delta; seq: number; timer: NodeJS.Timeout }>();
  private seq = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private sessionsQueued = false;

  constructor(
    private readonly sessions: () => SessionMeta[],
    private readonly onCount: (n: number) => void,
    private readonly opts = { coalesceMs: 100, heartbeatMs: 20_000, max: MAX_STREAMS },
  ) {}

  get count(): number {
    return this.clients.size;
  }

  /** Opens a stream on `res`; false (and nothing written) when the cap is reached. */
  attach(res: ServerResponse): boolean {
    if (this.clients.size >= this.opts.max) return false;
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.socket?.setNoDelay(true);
    res.write('retry: 2000\n: connected\n\n');
    this.clients.add(res);
    res.on('close', () => {
      if (this.clients.delete(res)) this.changed();
    });
    this.send(res, 'sessions', this.sessions());
    if (!this.heartbeat) {
      // A comment line keeps proxies and the phone's network stack from dropping an idle connection.
      this.heartbeat = setInterval(() => this.broadcastRaw(': ping\n\n'), this.opts.heartbeatMs);
      this.heartbeat.unref();
    }
    this.changed();
    return true;
  }

  publish(sessionId: string, ev: AgentEvent): void {
    const seq = ++this.seq;
    if (ev.type === 'text_delta' || ev.type === 'thinking_delta') {
      const held = this.pending.get(sessionId);
      if (held && held.delta.type === ev.type) {
        held.delta.text += ev.text;
        held.seq = seq;
        return;
      }
      if (held) this.flush(sessionId);
      const timer = setTimeout(() => this.flush(sessionId), this.opts.coalesceMs);
      this.pending.set(sessionId, { delta: { type: ev.type, text: ev.text }, seq, timer });
      return;
    }
    // Anything else goes out at once, after whatever text of that session was still held back.
    this.flush(sessionId);
    const out = remoteEvent(ev);
    if (out) this.broadcast('agent', { sessionId, seq, ev: out });
    if (MOVES_STATUS.has(ev.type)) this.sessionsChanged();
  }

  /** Sends the session list soon; several moves in one tick send it once. */
  sessionsChanged(): void {
    if (this.sessionsQueued) return;
    this.sessionsQueued = true;
    setImmediate(() => {
      this.sessionsQueued = false;
      if (this.clients.size) this.broadcast('sessions', this.sessions());
    });
  }

  closeAll(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    const all = [...this.clients];
    this.clients.clear();
    for (const res of all) res.end();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (all.length) this.onCount(0);
  }

  /**
   * Sends what is held back for a session and returns the number of the last event so far. A snapshot of the
   * session taken right after this covers exactly the events up to that number.
   */
  mark(sessionId: string): number {
    this.flush(sessionId);
    return this.seq;
  }

  private flush(sessionId: string): void {
    const held = this.pending.get(sessionId);
    if (!held) return;
    clearTimeout(held.timer);
    this.pending.delete(sessionId);
    this.broadcast('agent', { sessionId, seq: held.seq, ev: held.delta });
  }

  private changed(): void {
    if (!this.clients.size && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.onCount(this.clients.size);
  }

  private send(res: ServerResponse, event: string, data: unknown): void {
    // JSON.stringify never emits a raw newline, so one data: line always holds the whole message.
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(event: string, data: unknown): void {
    if (!this.clients.size) return;
    this.broadcastRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcastRaw(chunk: string): void {
    for (const res of this.clients) res.write(chunk);
  }
}
