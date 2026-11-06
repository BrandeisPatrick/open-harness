// Settings → Mods: install, create and reload mods, safe mode, and the list (Built-in / Yours / This project) with
// each mod's switch, what it asks for, what it adds, its problems and its own settings. Follows mods:changed live.

import type { ModInfo, ModLookTarget, ModPermission, ModSeat, ModSettingField } from '../../shared/mods';
import { escapeHtml, h } from '../dom.js';
import { icon, isIconName } from '../icons.js';
import { onPush } from '../rpc.js';
import { deriveModId, grantSheet, LOOK_WORDS, MOD_GROUPS, modChip, modIconFile, parseInteger, permissionWords, SEAT_WORDS, validModId } from './model.js';
import { actions, button, chip, group, note, row, sectionTitle, segmented, selectControl, switchControl, textControl, tildePath, type Row } from './ui.js';
import type { Ctx, Section } from './ctx.js';

export function modsSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Mods'));
  el.append(note('Mods add panels, tabs, looks, styles and commands to Open Harness. Built-in mods are on, except the ones that restyle the app; mods of yours and of a project stay off until you turn them on. Pick a mod’s looks in Appearance.', 'sp-intro'));

  let mods: ModInfo[] = [];
  const expanded = new Set<string>();
  let pendingRender = false;

  // ---------- Toolbar: Install…, New mod…, Reload ----------

  const status = h('div', { class: 'sp-inline-status', role: 'status', hidden: true });
  const showStatus = (text: string, error = false) => {
    status.hidden = !text;
    status.classList.toggle('error', error);
    status.innerHTML = text ? `${icon(error ? 'circle-alert' : 'circle-check', 14)}<span>${escapeHtml(text)}</span>` : '';
  };

  const installBtn = button('Install…', () => toggleForm(installForm, installBtn), { icon: 'download' });
  const newBtn = button('New mod…', () => toggleForm(createForm, newBtn), { icon: 'plus' });
  const reloadBtn = button('Reload', async (b) => {
    b.disabled = true;
    try {
      mods = await ctx.call('mods.reload');
      render();
      showStatus('Read every mod folder again.');
    } catch (err) {
      showStatus(`Couldn't reload: ${ctx.cleanError(err)}`, true);
    } finally {
      b.disabled = false;
    }
  }, { icon: 'refresh' });
  const toolbar = h('div', { class: 'sp-toolbar sp-only-browse' }, installBtn, newBtn, reloadBtn);

  // Install: a folder or a Git URL
  const installInput = textControl({ value: '', placeholder: '~/Downloads/my-mod or https://github.com/you/mod.git', width: 420, mono: true, onCommit: () => {} });
  installInput.input.setAttribute('aria-label', 'Folder or Git URL of the mod to install');
  const installProblem = h('div', { class: 'sp-problem', role: 'alert', hidden: true });
  const doInstall = async (b: HTMLButtonElement) => {
    const source = installInput.input.value.trim();
    if (!source) return formProblem(installProblem, 'Enter the path of a folder with a mod.json, or a Git URL.');
    b.disabled = true;
    try {
      const made = await ctx.call('mods.install', source);
      formProblem(installProblem, null);
      installInput.set('');
      closeForms();
      expanded.add(made.key);
      mods = await ctx.call('mods.list');
      render();
      showStatus(`Installed ${made.manifest?.name ?? made.id}. It stays off until you turn it on.`);
    } catch (err) {
      formProblem(installProblem, ctx.cleanError(err));
    } finally {
      b.disabled = false;
    }
  };
  installInput.input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void doInstall(installGo);
  });
  const installGo = button('Install', (b) => void doInstall(b), { primary: true });
  const installForm = h(
    'div',
    { class: 'sp-form sp-only-browse', hidden: true, role: 'group', 'aria-label': 'Install a mod' },
    h('div', { class: 'sp-form-title' }, 'Install a mod'),
    h('p', { class: 'sp-form-hint' }, 'A folder is copied into your mods folder; a Git URL is cloned there. It stays off until you turn it on.'),
    h('div', { class: 'sp-form-line' }, installInput, installGo, button('Cancel', () => closeForms())),
    installProblem,
  );

  // New mod: name → id, seat, user or project
  let idEdited = false;
  const nameInput = textControl({ value: '', placeholder: 'Word count', width: 220, onCommit: () => {} });
  nameInput.input.setAttribute('aria-label', 'Name of the new mod');
  const idInput = textControl({ value: '', placeholder: 'word-count', width: 180, mono: true, onCommit: () => {} });
  idInput.input.setAttribute('aria-label', 'Id of the new mod (its folder name)');
  nameInput.input.addEventListener('input', () => {
    if (!idEdited) idInput.input.value = deriveModId(nameInput.input.value);
  });
  idInput.input.addEventListener('input', () => (idEdited = idInput.input.value !== ''));
  // A view in a seat, or a look for a region ("look:conversation")
  let seat: ModSeat | `look:${ModLookTarget}` = 'rail';
  const seatSel = selectControl<ModSeat | `look:${ModLookTarget}`>(
    [
      { value: 'rail', label: 'Rail panel' },
      { value: 'tab', label: 'Side pane tab' },
      { value: 'composer', label: 'Composer strip' },
      { value: 'background', label: 'Background' },
      { value: 'look:conversation', label: 'Conversation look' },
      { value: 'look:composer', label: 'Chat bar look' },
    ],
    'rail',
    (v) => (seat = v),
    180,
  );
  seatSel.select.setAttribute('aria-label', 'What it adds: a view and where it sits, or a look');
  let scope: 'user' | 'project' = 'user';
  const scopeSeg = segmented<'user' | 'project'>(
    [
      { value: 'user', label: 'Yours' },
      { value: 'project', label: 'This project' },
    ],
    'user',
    (v) => (scope = v),
  );
  scopeSeg.setAttribute('aria-label', 'Where the mod lives');
  const createProblem = h('div', { class: 'sp-problem', role: 'alert', hidden: true });
  const createGo = button('Create', async (b) => {
    const name = nameInput.input.value.trim();
    const id = idInput.input.value.trim() || deriveModId(name);
    if (!name) return formProblem(createProblem, 'Give the mod a name.');
    if (!validModId(id)) return formProblem(createProblem, 'The id needs lower-case letters, digits and -, 2 to 40 characters, starting with a letter.');
    b.disabled = true;
    try {
      const made = await ctx.call('mods.create', seat.startsWith('look:') ? { id, name, look: seat.slice(5) as ModLookTarget, scope } : { id, name, seat: seat as ModSeat, scope });
      formProblem(createProblem, null);
      nameInput.set('');
      idInput.set('');
      idEdited = false;
      closeForms();
      expanded.add(made.key);
      mods = await ctx.call('mods.list');
      render();
      showStatus(`Created ${name} in ${tildePath(made.dir)}. Edit its files, then turn it on.`);
      void ctx.call('mods.reveal', made.key).catch(() => {});
    } catch (err) {
      formProblem(createProblem, ctx.cleanError(err));
    } finally {
      b.disabled = false;
    }
  }, { primary: true });
  const field = (label: string, control: HTMLElement) => h('label', { class: 'sp-form-field' }, h('span', { class: 'sp-form-label' }, label), control);
  const createForm = h(
    'div',
    { class: 'sp-form sp-only-browse', hidden: true, role: 'group', 'aria-label': 'Create a mod' },
    h('div', { class: 'sp-form-title' }, 'New mod'),
    h('p', { class: 'sp-form-hint' }, 'Writes a starter mod (mod.json and one page, or one stylesheet for a look) and shows its folder. Ask the agent to build it out.'),
    h('div', { class: 'sp-form-grid' }, field('Name', nameInput), field('Id', idInput), field('Adds', seatSel), h('div', { class: 'sp-form-field' }, h('span', { class: 'sp-form-label' }, 'Where'), scopeSeg)),
    h('div', { class: 'sp-form-line end' }, button('Cancel', () => closeForms()), createGo),
    createProblem,
  );

  function formProblem(elp: HTMLElement, message: string | null): void {
    elp.hidden = !message;
    elp.innerHTML = message ? `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>` : '';
  }
  function closeForms(): void {
    installForm.hidden = true;
    createForm.hidden = true;
    installBtn.classList.remove('active');
    newBtn.classList.remove('active');
  }
  function toggleForm(form: HTMLElement, btn: HTMLButtonElement): void {
    const show = Boolean(form.hidden);
    closeForms();
    form.hidden = !show;
    btn.classList.toggle('active', show);
    if (show) form.querySelector<HTMLElement>('input')?.focus();
  }

  // ---------- Safe mode ----------

  const safeInput = switchControl(false, async (on) => {
    try {
      mods = await ctx.call('mods.setSafeMode', on);
      safe.saved();
      safe.problem(null);
      render();
    } catch (err) {
      safeInput.checked = !on;
      safe.problem(`Couldn't change safe mode: ${ctx.cleanError(err)}`);
    }
  });
  const safe = row({ id: 'mods-safe', title: 'Safe mode', desc: 'Turns every mod of yours and of a project off at once, without forgetting which were on. Built-in mods keep running.', keywords: 'disable all off trouble' }, safeInput);
  safe.el.classList.add('clickable');

  const listEl = h('div', { class: 'sp-mod-list' });
  el.append(toolbar, installForm, createForm, status, group(null, safe), listEl);

  // ---------- The list ----------

  function render(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && listEl.contains(active) && (active.matches('input:not([type=checkbox]), textarea'))) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    listEl.innerHTML = '';
    for (const g of MOD_GROUPS) {
      const items = mods.filter((m) => m.scope === g.scope);
      if (!items.length && g.scope !== 'user') continue;
      const grp = group(g.title);
      if (!items.length) grp.append(h('p', { class: 'sp-note sp-empty-group' }, 'None yet. Install one, make one with New mod…, or ask the agent to build one.'));
      for (const m of items) grp.append(modRow(m));
      listEl.append(grp);
    }
    ctx.refreshSearch();
    if (active instanceof HTMLElement && active.dataset.focusKey) listEl.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(active.dataset.focusKey)}"]`)?.focus();
  }
  listEl.addEventListener('focusout', () => {
    if (pendingRender) setTimeout(() => pendingRender && render(), 0);
  });

  function modIcon(m: ModInfo): string {
    const name = m.manifest?.icon ?? '';
    if (isIconName(name)) return icon(name);
    const file = modIconFile(name);
    if (file) return `<img src="${escapeHtml(`${m.origin}/${file}`)}" alt="" width="16" height="16">`;
    return icon('puzzle');
  }

  function modRow(m: ModInfo): HTMLElement {
    const name = m.manifest?.name ?? m.id;
    const open = expanded.has(m.key);
    const r = row({ id: `mod-${m.key.replace(/[^a-z0-9-]+/gi, '_')}`, title: name, desc: m.manifest?.description ?? (m.problems[0]?.message || ''), keywords: `${m.id} mod ${m.manifest?.author ?? ''}` });
    r.el.classList.add('sp-mod');
    r.el.classList.toggle('open', open);
    const titleEl = r.el.querySelector('.sp-row-title')!;
    if (m.manifest?.version) titleEl.append(h('span', { class: 'sp-mod-version' }, m.manifest.version));
    if (m.overrides) titleEl.append(h('span', { class: 'sp-pill' }, 'Customised'));
    const c = modChip(m);
    if (c) titleEl.append(chip(c.label, c.tone));

    const expand = h('button', { type: 'button', class: 'sp-mod-expand', 'aria-expanded': String(open), 'aria-label': `Details of ${name}`, 'data-focus-key': `${m.key}|expand`, html: icon('chevron-right', 14) });
    const iconEl = h('span', { class: 'sp-mod-icon', html: modIcon(m) });
    const text = r.el.querySelector<HTMLElement>('.sp-row-text')!;
    text.before(expand, iconEl);

    const sw = switchControl(m.state === 'on', (on) => void setEnabled(m, on, sw));
    sw.setAttribute('aria-label', `${name}: ${m.state === 'on' ? 'on' : 'off'}`);
    sw.dataset.focusKey = `${m.key}|switch`;
    sw.disabled = m.state === 'invalid';
    r.control.append(sw);

    const detail = h('div', { class: 'sp-mod-detail', hidden: !open });
    if (open) fillDetail(detail, m, r);
    const toggle = () => {
      const now = !expanded.has(m.key);
      if (now) expanded.add(m.key);
      else expanded.delete(m.key);
      r.el.classList.toggle('open', now);
      expand.setAttribute('aria-expanded', String(now));
      detail.hidden = !now;
      if (now && !detail.childElementCount) fillDetail(detail, m, r);
    };
    expand.addEventListener('click', toggle);
    // A click on the row's text opens it too (not on the switch).
    text.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      toggle();
    });
    iconEl.addEventListener('click', toggle);
    r.el.append(detail);
    return r.el;
  }

  async function setEnabled(m: ModInfo, on: boolean, sw: HTMLInputElement): Promise<void> {
    const r = { problem: (msg: string | null) => setRowProblem(sw, msg) };
    if (on && (m.scope !== 'bundled' || m.state === 'paused')) {
      const sheet = grantSheet(m);
      const ok = await ctx.confirm({
        title: sheet.title,
        icon: 'puzzle',
        quote: { label: sheet.lines.length ? 'It will be able to' : 'It asks for nothing', text: sheet.lines.length ? sheet.lines.map((l) => `•  ${l}`).join('\n') : 'It only shows its own views and keeps its own storage.' },
        description: [...sheet.warnings, 'You can turn it off here at any time.'].join(' '),
        confirmLabel: m.state === 'paused' ? 'Allow and resume' : 'Turn on',
      });
      if (!ok) {
        sw.checked = false;
        return;
      }
    }
    try {
      mods = await ctx.call('mods.setEnabled', m.key, on);
      r.problem(null);
      render();
    } catch (err) {
      sw.checked = !on;
      r.problem(`Couldn't turn it ${on ? 'on' : 'off'}: ${ctx.cleanError(err)}`);
    }
  }

  function setRowProblem(inside: HTMLElement, message: string | null): void {
    const p = inside.closest('.sp-row')?.querySelector<HTMLElement>('.sp-problem');
    if (!p) return;
    p.hidden = !message;
    p.innerHTML = message ? `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>` : '';
  }

  function fillDetail(d: HTMLElement, m: ModInfo, r: Row): void {
    d.innerHTML = '';
    const block = (title: string, ...children: (Node | string)[]) => h('div', { class: 'sp-detail-block' }, h('div', { class: 'sp-detail-title' }, title), ...children);

    // Where it lives
    d.append(
      block(
        'Where it lives',
        h(
          'div',
          { class: 'sp-detail-line' },
          h('code', { class: 'sp-path', title: m.dir }, tildePath(m.dir)),
          button('Reveal', () => void ctx.call('mods.reveal', m.key).catch((err) => r.problem(ctx.cleanError(err))), { icon: 'folder' }),
        ),
      ),
    );

    // What it adds
    const adds: string[] = [];
    for (const v of m.manifest?.contributes?.views ?? []) adds.push(`${v.title}: ${SEAT_WORDS[v.seat] ?? v.seat}`);
    for (const l of m.manifest?.contributes?.looks ?? []) adds.push(`${l.title}: ${LOOK_WORDS[l.target] ?? l.target} (pick it in Appearance)`);
    for (const c of m.manifest?.contributes?.commands ?? []) adds.push(`/${c.name}: ${c.description}`);
    const styles = m.manifest?.contributes?.styles ?? [];
    if (styles.length) adds.push(`Styles for the whole app: ${styles.join(', ')}`);
    d.append(block('What it adds', adds.length ? h('ul', { class: 'sp-detail-list' }, ...adds.map((a) => h('li', {}, a))) : h('p', { class: 'sp-detail-muted' }, 'Nothing yet.')));

    // Permissions
    const asked = [...new Set<ModPermission>([...(m.manifest?.permissions ?? []), ...m.granted, ...m.wants])];
    const permList = h('ul', { class: 'sp-perm-list' });
    for (const p of asked) {
      const wanted = m.wants.includes(p);
      const granted = m.granted.includes(p) || (m.scope === 'bundled' && m.state === 'on' && !wanted);
      const li = h('li', { class: wanted ? 'wanted' : granted ? 'granted' : '' });
      li.innerHTML = `${icon(granted ? 'check' : wanted ? 'circle-alert' : 'circle', 14)}<span>${escapeHtml(permissionWords(p))}</span>${wanted ? '<span class="sp-chip warn">Not granted yet</span>' : ''}`;
      permList.append(li);
    }
    if (m.wantsStyles) permList.append(h('li', { class: 'wanted', html: `${icon('circle-alert', 14)}<span>Restyle the app (styles, looks or a background)</span><span class="sp-chip warn">Not granted yet</span>` }));
    d.append(block('Permissions', asked.length || m.wantsStyles ? permList : h('p', { class: 'sp-detail-muted' }, 'None: it only shows its own views and keeps its own storage.')));

    // Problems
    if (m.problems.length) {
      const probs = [...m.problems].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      d.append(
        block(
          'Problems',
          h(
            'ul',
            { class: 'sp-problem-list' },
            ...probs.map((p) => h('li', {}, h('span', { class: 'sp-problem-kind' }, p.kind === 'runtime' ? `Page${p.view ? ` ${p.view}` : ''}` : p.kind === 'file' ? 'Missing file' : p.warning ? 'mod.json (warning)' : 'mod.json'), h('pre', {}, p.message))),
          ),
        ),
      );
    }

    // Its settings
    const fields = m.manifest?.contributes?.settings ?? [];
    if (fields.length) {
      const form = h('div', { class: 'sp-mod-settings' });
      for (const f of fields) form.append(settingRow(m, f));
      d.append(block('Settings', form));
    }

    // Actions
    const meta = [m.manifest?.author && `By ${m.manifest.author}`, m.manifest?.license].filter(Boolean).join(' · ');
    const acts = actions(
      meta ? h('span', { class: 'sp-detail-muted' }, meta) : null,
      h('span', { class: 'spacer' }),
      m.scope === 'bundled'
        ? button('Customise', async (b) => {
            b.disabled = true;
            try {
              mods = await ctx.call('mods.customise', m.key);
              const copy = mods.find((x) => x.id === m.id && x.scope === 'user');
              if (copy) expanded.add(copy.key);
              render();
              showStatus(`Copied ${m.manifest?.name ?? m.id} to your mods folder. Your copy replaces the built-in one.`);
            } catch (err) {
              r.problem(`Couldn't customise: ${ctx.cleanError(err)}`);
            } finally {
              b.disabled = false;
            }
          }, { icon: 'copy' })
        : null,
      m.scope === 'user'
        ? button('Remove', async (b) => {
            const ok = await ctx.confirm({ title: `Remove ${m.manifest?.name ?? m.id}?`, description: `Its folder moves to the Trash${m.overrides ? ' and the built-in mod comes back' : ''}.`, confirmLabel: 'Move to Trash', danger: true });
            if (!ok) return;
            b.disabled = true;
            try {
              mods = await ctx.call('mods.remove', m.key);
              expanded.delete(m.key);
              render();
            } catch (err) {
              r.problem(`Couldn't remove: ${ctx.cleanError(err)}`);
            } finally {
              b.disabled = false;
            }
          }, { icon: 'trash', danger: true })
        : null,
    );
    d.append(acts);
  }

  function settingRow(m: ModInfo, f: ModSettingField): HTMLElement {
    const value = m.settings[f.key] ?? (f as { default?: unknown }).default;
    const id = `modset-${m.key.replace(/[^a-z0-9-]+/gi, '_')}-${f.key}`;
    const setValue = async (r: Row, v: unknown): Promise<boolean> => {
      try {
        mods = await ctx.call('mods.setSetting', m.key, f.key, v);
        const next = mods.find((x) => x.key === m.key);
        if (next) m.settings = next.settings;
        r.problem(null);
        r.saved();
        return true;
      } catch (err) {
        r.problem(ctx.cleanError(err));
        return false;
      }
    };
    let r: Row;
    if (f.type === 'boolean') {
      const sw = switchControl(Boolean(value), (on) => void setValue(r, on).then((ok) => !ok && (sw.checked = !on)));
      r = row({ id, title: f.title, desc: f.description }, sw);
      r.el.classList.add('clickable');
    } else if (f.type === 'select') {
      const sel = selectControl(f.options.map((o) => ({ value: o, label: o })), String(value ?? f.options[0] ?? ''), (v) => void setValue(r, v), 180);
      r = row({ id, title: f.title, desc: f.description }, sel);
    } else {
      const ctl = textControl({
        value: value === undefined || value === null ? '' : String(value),
        placeholder: f.type === 'string' ? f.placeholder : undefined,
        type: f.type === 'number' ? 'number' : 'text',
        width: f.type === 'number' ? 120 : 220,
        onCommit: async (text) => {
          let v: unknown = text;
          if (f.type === 'number') {
            const n = Number(String(text).trim());
            if (!String(text).trim() || !Number.isFinite(n)) return r.problem('Enter a number.');
            if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) return r.problem(`Must be${f.min !== undefined ? ` from ${f.min}` : ''}${f.max !== undefined ? ` to ${f.max}` : ''}.`);
            if (f.step === 1 || (f.step === undefined && Number.isInteger(f.min ?? 0) && Number.isInteger(f.max ?? 0) && /^-?\d+$/.test(String(text).trim()))) {
              const p = parseInteger(text, f.min ?? -1e12, f.max ?? 1e12);
              if (!p.ok) return r.problem(p.error);
              v = p.value;
            } else v = n;
          }
          if (await setValue(r, v)) ctl.set(String(v));
        },
      });
      r = row({ id, title: f.title, desc: f.description }, ctl);
    }
    r.el.classList.add('sp-sub-row');
    return r.el;
  }

  onPush('mods:changed', (list) => {
    if (!Array.isArray(list)) return;
    mods = list;
    render();
  });

  return {
    id: 'mods',
    el,
    sync(cfg) {
      safeInput.checked = Boolean(cfg.mods?.safeMode);
    },
    async load() {
      try {
        mods = await ctx.call('mods.list');
      } catch (err) {
        if (ctx.isUnknown(err)) return 'absent';
        showStatus(`Couldn't load the mods: ${ctx.cleanError(err)}`, true);
        return 'ok';
      }
      render();
      return 'ok';
    },
    closed() {
      closeForms();
      showStatus('');
    },
  };
}
