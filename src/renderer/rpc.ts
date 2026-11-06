// Typed helpers over window.oc's two generic bridges (see src/shared/rpc.ts for the contract).

import type { RpcEvents, RpcMethods } from '../shared/rpc';
import type { OpenHarnessApi } from '../shared/types';

const oc = (): OpenHarnessApi => (window as unknown as { oc: OpenHarnessApi }).oc;

/** Calls a main-process method registered with app.rpc.handle. */
export function rpc<K extends keyof RpcMethods>(method: K, ...args: Parameters<RpcMethods[K]>): Promise<Awaited<ReturnType<RpcMethods[K]>>> {
  const api = oc();
  if (typeof api?.rpc !== 'function') return Promise.reject(new Error('No handler registered'));
  return api.rpc(method, ...args);
}

/** Follows a push channel the main process sends with app.push; returns the unsubscribe function. */
export function onPush<K extends keyof RpcEvents>(channel: K, cb: (payload: RpcEvents[K]) => void): () => void {
  const api = oc();
  if (typeof api?.onPush !== 'function') return () => {};
  return api.onPush(channel, cb);
}
