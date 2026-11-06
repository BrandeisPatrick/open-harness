// The window's event bus. renderer.ts emits on it; feature modules subscribe instead of editing renderer.ts.
//
//   'agent-event'   (ev, sessionId, onScreen)  every agent event of every session, before renderer.ts handles it
//   'session-shown' (sessionId)                after a switch, new session or fork has rendered
//   'config'        (config)                   whenever the window's config copy changes
//   'sessions'      (metas)                    whenever the session list was refreshed

import type { AgentEvent, AppConfig, SessionMeta } from '../shared/types';

export interface BusEvents {
  'agent-event': [ev: AgentEvent, sessionId: string, onScreen: boolean];
  'session-shown': [sessionId: string];
  config: [config: AppConfig];
  sessions: [metas: SessionMeta[]];
}

type Listener<K extends keyof BusEvents> = (...args: BusEvents[K]) => void;

const listeners = new Map<keyof BusEvents, Set<Listener<keyof BusEvents>>>();

export const bus = {
  /** Subscribes; returns the unsubscribe function. */
  on<K extends keyof BusEvents>(name: K, cb: Listener<K>): () => void {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(cb as Listener<keyof BusEvents>);
    return () => set.delete(cb as Listener<keyof BusEvents>);
  },
  /** Calls every listener in order; one that throws is logged and the others still run. */
  emit<K extends keyof BusEvents>(name: K, ...args: BusEvents[K]): void {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      try {
        (cb as Listener<K>)(...args);
      } catch (err) {
        console.error(`[bus] a ${name} listener failed:`, err);
      }
    }
  },
};
