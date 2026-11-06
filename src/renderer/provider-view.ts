// The provider in use, as the window knows it: the main process sends the providers resolved with the config
// (AppConfig.providerView). A config without it (the debug mocks, an older main process) falls back to the two
// built-in blocks, as the window worked before named providers.

import type { AppConfig, ProviderView } from '../shared/types';

function fromBlocks(config: AppConfig, name: string): ProviderView {
  if (name === 'ollama') {
    const o = config.ollama;
    return { name, type: 'ollama', label: 'Ollama', builtIn: true, baseURL: o?.baseURL ?? '', model: o?.model ?? '', models: [], contextWindow: Number(o?.numCtx) || 0, key: 'none', keySource: '', headers: [] };
  }
  const p = config.portkey;
  return { name: 'portkey', type: 'portkey', label: /portkey\.ai/.test(p?.baseURL ?? '') ? 'Portkey' : 'Gateway', builtIn: true, baseURL: p?.baseURL ?? '', model: p?.model ?? '', models: [], contextWindow: Number(p?.contextWindow) || 0, key: p?.apiKey ? 'set' : 'missing', keySource: 'PORTKEY_API_KEY', headers: [] };
}

/** The provider in use. */
export function activeProvider(config: AppConfig): ProviderView {
  const v = config?.providerView?.active;
  if (v && v.name === (config.provider || 'ollama')) return v;
  return fromBlocks(config, config?.provider === 'portkey' ? 'portkey' : 'ollama');
}

/** Every provider: the built-in ones, then the named ones. */
export function allProviders(config: AppConfig): ProviderView[] {
  const all = config?.providerView?.all;
  return all && all.length ? all : [fromBlocks(config, 'ollama'), fromBlocks(config, 'portkey')];
}

/** True when the provider in use is an Ollama (the block or a named entry): the window's Ollama checks apply. */
export const usesOllama = (config: AppConfig): boolean => activeProvider(config).type === 'ollama';
