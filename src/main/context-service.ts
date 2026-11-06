// The context breakdown service (what fills the context window), for the Context panel and the context meter.
import type { App } from './app';
import type { ContextService } from './services';

/** Provides the 'context' service and the context.breakdown RPC. */
export function setupContext(app: App): void {
  const breakdown = (sessionId: string) => {
    if (!app.runtime.get(sessionId)) throw new Error(`No session ${sessionId}`);
    return app.runtime.agentFor(sessionId).contextBreakdown();
  };
  const service: ContextService = { breakdown };
  app.provide('context', service);
  app.rpc.handle('context.breakdown', (sessionId?: string) => breakdown(typeof sessionId === 'string' && sessionId ? sessionId : app.runtime.foregroundId()));
  // The meter's mark and the breakdown's reserve follow the threshold setting (the core only re-sends the estimate for other changes).
  app.onConfig((next, prev) => {
    if (next.compactThreshold === prev.compactThreshold && next.pruneToolResults === prev.pruneToolResults) return;
    const id = app.runtime.foregroundId();
    if (id && app.runtime.get(id)) app.runtime.agentFor(id).emitContext();
  });
}
