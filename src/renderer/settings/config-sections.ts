// General, Model, Permissions and Context: the sections that are rows over the config.

import type { AppConfig, PermissionMode } from '../../shared/types';
import type { PowerStatus } from '../../shared/schedules';
import { escapeHtml, h } from '../dom.js';
import { icon } from '../icons.js';
import { MODES } from '../modes.js';
import { onPush } from '../rpc.js';
import { COMPACT_AT, KEEP_AWAKE, nearestCompactStep, parseInteger, parseText, parseUrl } from './model.js';
import { button, group, iconButton, row, sectionTitle, tildePath } from './ui.js';
import type { Ctx, Section } from './ctx.js';

export function generalSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('General'));

  const folder = row({ id: 'workingDirectory', title: 'Working folder', desc: '', keywords: 'directory project cwd path folder', field: 'workingDirectory' }, button('Change…', () => void ctx.chooseFolder(), { icon: 'folder' }));
  folder.descEl.classList.add('sp-path');

  const awake = ctx.segField({
    id: 'keepAwake',
    title: 'Keep awake',
    desc: 'Stop this Mac from sleeping while the agent works, or whenever OpenAgent is open.',
    keywords: 'sleep caffeinate power battery lid',
    field: 'keepAwake',
    choices: KEEP_AWAKE,
  });
  const awakeBase = 'Stop this Mac from sleeping while the agent works, or whenever OpenAgent is open.';
  const showPower = (p: PowerStatus | null) => awake.setDesc(p?.active ? `${awakeBase} Keeping it awake now.` : awakeBase);
  onPush('power:changed', (p) => showPower(p));

  el.append(
    group(
      null,
      folder,
      awake,
      ctx.switchField({ id: 'notifications', title: 'Notifications', desc: 'Notify when a run finishes or needs your approval while OpenAgent is in the background.', keywords: 'alert notify banner sound', field: 'notifications' }),
      ctx.switchField({ id: 'autoTitles', title: 'Generated titles', desc: 'Name a session from its first exchange.', keywords: 'session name rename title', field: 'autoTitles' }),
      ctx.textField({ id: 'maxTurns', inputId: 'maxTurns', title: 'Max tool turns', desc: 'How many tool calls one request may make before it stops and asks you to continue.', keywords: 'limit steps iterations', field: 'maxTurns', type: 'number', width: 96, parse: (t) => parseInteger(t, 1, 500) }),
      ctx.textField({
        id: 'systemPromptExtra',
        inputId: 'systemPromptExtra',
        title: 'Extra system prompt',
        desc: 'Added to every request: house rules, coding style, project context. Saved when you leave the field or press ⌘↵.',
        keywords: 'instructions rules prompt',
        field: 'systemPromptExtra',
        multiline: true,
        placeholder: 'House rules, coding style, project context…',
        parse: (t) => ({ ok: true, value: String(t ?? '') }),
      }),
    ),
  );

  return {
    id: 'general',
    el,
    sync(cfg) {
      folder.setDesc(tildePath(cfg.workingDirectory));
      folder.descEl.title = cfg.workingDirectory;
    },
    async load() {
      try {
        showPower(await ctx.call('power.status'));
      } catch {
        showPower(null);
      }
      return 'ok';
    },
  };
}

export function modelSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Model'));
  const providerRows: { el: HTMLElement; provider: AppConfig['provider'] }[] = [];
  const tag = <T extends { el: HTMLElement }>(r: T, provider: AppConfig['provider']): T => {
    r.el.dataset.provider = provider;
    providerRows.push({ el: r.el, provider });
    return r;
  };
  const syncProvider = (p: AppConfig['provider']) => {
    for (const r of providerRows) r.el.classList.toggle('provider-off', r.provider !== p);
    advanced.classList.toggle('provider-off', p !== 'portkey');
  };

  const provider = ctx.segField({
    id: 'provider',
    title: 'Provider',
    desc: 'Where OpenAgent sends model requests: Ollama on this Mac, or an AI gateway such as Portkey.',
    keywords: 'ollama portkey gateway local cloud',
    field: 'provider',
    choices: [
      { value: 'ollama', label: 'Ollama' },
      { value: 'portkey', label: 'Gateway' },
    ],
    onSaved: (v) => {
      syncProvider(v as AppConfig['provider']);
      ctx.refreshSearch();
    },
  });

  // Ollama
  const modelList = h('datalist', { id: 'ollama-models' });
  const ollamaModel = tag(
    ctx.textField({ id: 'ollama-model', inputId: 'ollama-model', title: 'Model', desc: 'A model that supports tool calling, such as qwen3:8b.', keywords: 'tag llm', pill: 'Ollama', field: 'ollama.model', placeholder: 'qwen3:8b', parse: parseText }),
    'ollama',
  );
  const modelInput = ollamaModel.control.querySelector('input')!;
  modelInput.setAttribute('list', 'ollama-models');
  const refreshBtn = iconButton('refresh', 'Refresh the local models', () => void refreshModels());
  ollamaModel.control.append(modelList, refreshBtn);

  async function refreshModels(): Promise<void> {
    if (ctx.config().provider !== 'ollama') return;
    refreshBtn.classList.add('spinning');
    try {
      const models = await window.oc.listOllamaModels();
      modelList.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
      ollamaModel.setDesc(models.length ? `${models.length} local model${models.length === 1 ? '' : 's'}: ${models.slice(0, 6).join(', ')}${models.length > 6 ? ', …' : ''}` : 'Ollama is running but has no models. Try: ollama pull qwen3:8b');
    } catch (err) {
      ollamaModel.setDesc(`Could not reach Ollama (${ctx.cleanError(err)}). Start it with: ollama serve`);
    } finally {
      refreshBtn.classList.remove('spinning');
    }
  }

  const ollama = group(
    null,
    tag(ctx.textField({ id: 'ollama-baseURL', inputId: 'ollama-baseURL', title: 'Base URL', desc: 'The OpenAI-compatible endpoint of your Ollama server.', keywords: 'endpoint address server host', pill: 'Ollama', field: 'ollama.baseURL', placeholder: 'http://localhost:11434/v1', mono: true, width: 260, parse: parseUrl }), 'ollama'),
    ollamaModel,
    tag(
      ctx.textField({
        id: 'ollama-numCtx',
        inputId: 'ollama-numCtx',
        title: 'Context size',
        desc: "Tokens of context Ollama is asked for. Its own default, 4096, is too small for agent work.",
        keywords: 'num_ctx tokens window memory',
        pill: 'Ollama',
        field: 'ollama.numCtx',
        type: 'number',
        width: 120,
        format: (v) => String(v ?? ''),
        parse: (t) => parseInteger(t, 2048, 1_048_576),
      }),
      'ollama',
    ),
    tag(
      ctx.selectField({
        id: 'ollama-think',
        inputId: 'ollama-think',
        title: 'Thinking',
        desc: 'For models that can reason before they answer (qwen3, deepseek-r1, gpt-oss).',
        keywords: 'reasoning think',
        pill: 'Ollama',
        field: 'ollama.think',
        width: 160,
        choices: [
          { value: 'auto', label: 'Model default' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ],
      }),
      'ollama',
    ),
  );

  // Gateway
  const pk = (o: Parameters<Ctx['textField']>[0]) => tag(ctx.textField({ pill: 'Gateway', mono: true, width: 260, ...o }), 'portkey');
  const gateway = group(
    null,
    pk({ id: 'portkey-baseURL', inputId: 'portkey-baseURL', title: 'Base URL', desc: 'The gateway endpoint: Portkey, or a gateway you host.', keywords: 'endpoint address server host', field: 'portkey.baseURL', placeholder: 'https://api.portkey.ai/v1', parse: parseUrl }),
    pk({ id: 'portkey-apiKey', inputId: 'portkey-apiKey', title: 'API key', desc: 'Your gateway key. Without one, OpenAgent uses PORTKEY_API_KEY from the environment.', keywords: 'token secret password credential', field: 'portkey.apiKey', type: 'password', placeholder: 'pk-…', parse: parseText }),
    pk({ id: 'portkey-model', inputId: 'portkey-model', title: 'Model', desc: 'A model-catalog id like @openai/gpt-4o-mini, or a plain id with a virtual key or provider below.', keywords: 'llm', field: 'portkey.model', placeholder: '@openai/gpt-4o-mini', parse: parseText }),
    pk({
      id: 'portkey-contextWindow',
      inputId: 'portkey-contextWindow',
      title: 'Context window',
      desc: "The model's window in tokens. The gateway does not report it; the context meter and auto-compaction go by it.",
      keywords: 'tokens size memory',
      field: 'portkey.contextWindow',
      type: 'number',
      mono: false,
      width: 120,
      parse: (t) => parseInteger(t, 1024, 10_000_000),
    }),
  );

  const advancedToggle = h('button', { type: 'button', class: 'sp-disclosure', 'aria-expanded': 'false' });
  advancedToggle.innerHTML = `${icon('chevron-right', 14)}<span>Advanced routing</span>`;
  const advancedRows = h(
    'div',
    { class: 'sp-advanced-rows' },
    pk({ id: 'portkey-virtualKey', inputId: 'portkey-virtualKey', title: 'Virtual key', desc: 'Sent as x-portkey-virtual-key.', keywords: 'advanced routing', field: 'portkey.virtualKey', placeholder: 'Optional', parse: parseText }).el,
    pk({ id: 'portkey-provider', inputId: 'portkey-provider', title: 'Provider slug', desc: 'Sent as x-portkey-provider, e.g. openai, anthropic, groq.', keywords: 'advanced routing', field: 'portkey.provider', placeholder: 'Optional', parse: parseText }).el,
    pk({ id: 'portkey-providerApiKey', inputId: 'portkey-providerApiKey', title: 'Provider API key', desc: "That provider's own key, sent as Authorization: Bearer.", keywords: 'advanced routing token secret', field: 'portkey.providerApiKey', type: 'password', placeholder: 'Optional', parse: parseText }).el,
    pk({ id: 'portkey-configId', inputId: 'portkey-configId', title: 'Config ID', desc: 'A Portkey config for routing, fallbacks and caching (x-portkey-config).', keywords: 'advanced routing fallback cache', field: 'portkey.configId', placeholder: 'pc-…', parse: parseText }).el,
  );
  const advanced = h('div', { class: 'sp-advanced' }, h('div', { class: 'sp-disclosure-row' }, advancedToggle), advancedRows);
  advancedToggle.addEventListener('click', () => {
    const open = !advanced.classList.contains('open');
    advanced.classList.toggle('open', open);
    advancedToggle.setAttribute('aria-expanded', String(open));
  });
  gateway.append(advanced);

  el.append(group(null, provider), ollama, gateway);

  let lastProvider = '';
  return {
    id: 'model',
    el,
    sync(cfg) {
      syncProvider(cfg.provider);
      if (cfg.provider === 'ollama' && lastProvider !== 'ollama') void refreshModels();
      lastProvider = cfg.provider;
    },
    async load() {
      lastProvider = ctx.config().provider;
      void refreshModels();
      return 'ok';
    },
  };
}

export function permissionsSection(ctx: Ctx, rulesEl: HTMLElement): Section {
  const el = h('section', {}, sectionTitle('Permissions'));
  const order: PermissionMode[] = ['ask', 'acceptEdits', 'auto', 'plan', 'bypass'];
  const SHORT: Record<PermissionMode, string> = { ask: 'Ask', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan', bypass: 'Bypass' };
  const mode = ctx.selectField({
    id: 'permissionMode',
    inputId: 'permissionMode',
    title: 'Default mode',
    desc: '',
    keywords: 'ask accept edits auto plan bypass approval approve',
    field: 'permissionMode',
    width: 340,
    choices: order.map((m) => ({ value: m, label: `${SHORT[m]} · ${MODES[m].desc}` })),
    read: (v) => (order.includes(v as PermissionMode) ? (v as PermissionMode) : 'ask'),
  });
  const rules = row({ id: 'rules', title: 'Saved rules', desc: 'Answers you gave with "Always allow … for this project". Matching actions run without an approval card.', keywords: 'always allow rules project commands programs mcp edits', full: true }, rulesEl);
  rulesEl.classList.add('sp-embedded');
  el.append(group(null, mode), group('This project', rules));
  return {
    id: 'permissions',
    el,
    sync(cfg) {
      const m = order.includes(cfg.permissionMode) ? cfg.permissionMode : 'ask';
      mode.setDesc(`${MODES[m].hint}. The mode chip in the composer changes it for now; this is where it starts.`);
    },
  };
}

export function contextSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Context'));
  el.append(
    group(
      null,
      ctx.switchField({ id: 'autoCompact', title: 'Auto-compact', desc: 'Summarise the conversation on its own when it nears the context window.', keywords: 'compaction summary summarise', field: 'autoCompact' }),
      ctx.selectField({
        id: 'compactThreshold',
        inputId: 'compactThreshold',
        title: 'Compact at',
        desc: 'How full the context window gets before the conversation is summarised.',
        keywords: 'threshold percent compaction',
        field: 'compactThreshold',
        width: 120,
        choices: COMPACT_AT.map((v) => ({ value: v, label: `${Math.round(v * 100)}%` })),
        read: (v) => nearestCompactStep(v),
      }),
      ctx.switchField({ id: 'pruneToolResults', title: 'Trim old tool output', desc: 'Before summarising, shorten old tool results the model no longer needs word for word.', keywords: 'prune shorten compaction', field: 'pruneToolResults' }),
      ctx.switchField({ id: 'sendScreenshotsToModel', title: 'Send browser screenshots to the model', desc: 'Attach browser screenshots to the conversation as images. Needs a vision-capable model.', keywords: 'vision images browser', field: 'sendScreenshotsToModel' }),
    ),
  );
  return { id: 'context', el };
}
