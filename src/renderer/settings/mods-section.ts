// Settings → Mods: a tab strip (Mods, Backgrounds, Chat bar, Conversation, Themes), each tab's picker at the top
// (the background, the chat bar look, the conversation look in use, or the themes in the order they apply), then
// install, create and reload, and the list (Built-in / Yours / This project) of the tab's kind of mod with each mod's
// switch, what it asks for, what it adds, its problems and its own settings. A mod of several kinds is one card,
// shown in each of its tabs; while searching, every card and every tab's rows are searched. Follows mods:changed live.

import type { ModInfo, ModLayout, ModLookTarget, ModPermission, ModSettingField } from '../../shared/mods';
import { basename, escapeHtml, h } from '../dom.js';
import { icon, isIconName } from '../icons.js';
import { onPush } from '../rpc.js';
import {
  backgroundChoices,
  currentLookSet,
  deriveModId,
  grantSheet,
  isModTab,
  lookChoices,
  lookSetPatch,
  lookSets,
  LOOK_WORDS,
  MOD_GROUPS,
  MOD_TABS,
  modChip,
  modIconFile,
  modTabs,
  offModsOfTab,
  parseInteger,
  permissionWords,
  refMod,
  SEAT_WORDS,
  themeMods,
  validModId,
  type ModTab,
  type NewModKind,
} from './model.js';
import { actions, button, chip, group, note, row, sectionTitle, segmented, selectControl, switchControl, textControl, tildePath, type Row } from './ui.js';
import type { Ctx, Section } from './ctx.js';

const NEW_LABEL: Record<ModTab, string> = { mods: 'New mod…', backgrounds: 'New background…', 'chat-bar': 'New chat bar look…', conversation: 'New conversation look…', themes: 'New theme…' };
const EMPTY_WORDS: Record<ModTab, string> = {
  mods: 'None yet. Install one, make one with New mod…, or ask the agent to build one.',
  backgrounds: 'No backgrounds of yours yet. Install one, make one with New background…, or ask the agent to build one.',
  'chat-bar': 'No chat bar looks of yours yet. Install one, make one with New chat bar look…, or ask the agent to build one.',
  conversation: 'No conversation looks of yours yet. Install one, make one with New conversation look…, or ask the agent to build one.',
  themes: 'No themes of yours yet. Install one, make one with New theme…, or ask the agent to build one.',
};
const safeKey = (key: string) => key.replace(/[^a-z0-9-]+/gi, '_');

export function modsSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Mods'));
  el.append(note('Mods add panels, tabs, looks, styles and commands to Silo Harness. Built-in mods are on, except the ones that restyle the app; mods of yours and of a project stay off until you turn them on. Backgrounds, chat bar looks, conversation looks and themes have tabs of their own, where you pick the one in use.', 'sp-intro'));

  let mods: ModInfo[] = [];
  const expanded = new Set<string>();
  let pendingRender = false;
  /** The tab on screen; kept while the app runs, so Settings reopens at it */
  let tab: ModTab = 'mods';

  // ---------- Toolbar: Install…, New mod…, Reload ----------

  const status = h('div', { class: 'sp-inline-status', role: 'status', hidden: true });
  const showStatus = (text: string, error = false) => {
    status.hidden = !text;
    status.classList.toggle('error', error);
    status.innerHTML = text ? `${icon(error ? 'circle-alert' : 'circle-check', 14)}<span>${escapeHtml(text)}</span>` : '';
  };

  const installBtn = button('Install…', () => toggleForm(installForm, installBtn), { icon: 'download' });
  const newBtn = button(NEW_LABEL.mods, () => toggleForm(createForm, newBtn), { icon: 'plus' });
  const reloadBtn = button('Reload', async (b) => {
    b.disabled = true;
    try {
      mods = await ctx.call('mods.reload');
      renderAll();
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
      renderAll();
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
  // A view in a seat, a look for a region ("look:conversation"), or a theme; preset to the tab's kind
  let seat: NewModKind = 'rail';
  const seatSel = selectControl<NewModKind>(
    [
      { value: 'rail', label: 'Rail panel' },
      { value: 'tab', label: 'Side pane tab' },
      { value: 'composer', label: 'Composer strip' },
      { value: 'background', label: 'Background' },
      { value: 'look:conversation', label: 'Conversation look' },
      { value: 'look:composer', label: 'Chat bar look' },
      { value: 'theme', label: 'Theme' },
    ],
    'rail',
    (v) => (seat = v),
    180,
  );
  seatSel.select.setAttribute('aria-label', 'What it adds: a view and where it sits, a look, or a theme');
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
      const made = await ctx.call('mods.create', seat === 'theme' ? { id, name, theme: true, scope } : seat.startsWith('look:') ? { id, name, look: seat.slice(5) as ModLookTarget, scope } : { id, name, seat: seat as Exclude<NewModKind, 'theme' | `look:${string}`>, scope });
      formProblem(createProblem, null);
      nameInput.set('');
      idInput.set('');
      idEdited = false;
      closeForms();
      expanded.add(made.key);
      mods = await ctx.call('mods.list');
      const madeTabs = modTabs(made);
      if (!madeTabs.includes(tab)) showTab(madeTabs[0]);
      renderAll();
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
    h('p', { class: 'sp-form-hint' }, 'Writes a starter mod (mod.json and one page, or one stylesheet for a look or a theme) and shows its folder. Ask the agent to build it out.'),
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
    if (show && form === createForm) {
      seat = MOD_TABS.find((t) => t.id === tab)!.newKind;
      seatSel.set(seat);
    }
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
      renderAll();
    } catch (err) {
      safeInput.checked = !on;
      safe.problem(`Couldn't change safe mode: ${ctx.cleanError(err)}`);
    }
  });
  const safe = row({ id: 'mods-safe', title: 'Safe mode', desc: 'Turns every mod of yours and of a project off at once, without forgetting which were on. Built-in mods keep running.', keywords: 'disable all off trouble' }, safeInput);
  safe.el.classList.add('clickable');

  const listEl = h('div', { class: 'sp-mod-list' });

  // ---------- The tab strip ----------

  const tabsEl = h('div', { class: 'sp-tabs sp-only-browse', role: 'tablist', 'aria-label': 'Kinds of mod' });
  const tabBtns = new Map<ModTab, HTMLButtonElement>();
  for (const t of MOD_TABS) {
    const b = h('button', { type: 'button', class: 'sp-nav-item sp-tab', id: `sp-modtab-${t.id}`, role: 'tab', 'aria-controls': 'sp-modpanel', 'data-tab': t.id }, h('span', {}, t.title));
    b.addEventListener('click', () => showTab(t.id));
    tabBtns.set(t.id, b);
    tabsEl.append(b);
  }
  tabsEl.addEventListener('keydown', (e) => {
    const ids = MOD_TABS.map((t) => t.id);
    const i = ids.indexOf((document.activeElement as HTMLElement | null)?.dataset.tab as ModTab);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    showTab(ids[next]);
    tabBtns.get(ids[next])!.focus();
  });

  // ---------- Each tab's head: its picker (or safe mode on the Mods tab) ----------

  const liveSelect = (first: string, onChange: (v: string) => void) => {
    const c = selectControl<string>([{ value: '', label: first }], '', () => {}, 240);
    c.select.addEventListener('change', () => onChange(c.select.value));
    return c;
  };
  const offNote = () => {
    const text = h('span', {});
    const n = h('p', { class: 'sp-note sp-tab-off', hidden: true }, text);
    return { el: n, set: (t: string) => ((text.textContent = t), (n.hidden = !t)) };
  };
  /** The settings of the mod whose part is chosen, under the picker */
  const ownerBox = () => h('div', { class: 'sp-mod-settings sp-pick-settings' });

  // Backgrounds
  const bgSelect = liveSelect('None', (v) => void setBackground(v));
  const bgRow = row({ id: 'background', title: 'Background', desc: 'A picture or a mod’s live background behind the window. The app’s surfaces turn translucent over it.', keywords: 'wallpaper image picture mod' }, bgSelect);
  const bgOwner = ownerBox();
  const pictureName = h('span', { class: 'sp-file-name' });
  const pictureRow = row(
    { id: 'background-image', title: 'Your picture', desc: 'A PNG, JPEG, WebP or GIF. Silo Harness keeps its own copy.', keywords: 'wallpaper image picture choose background' },
    h('span', { class: 'sp-control-group' }, pictureName, button('Choose image…', () => void chooseImage(), { icon: 'image' })),
  );
  const dim = h('input', { type: 'range', min: '0', max: '100', step: '5', class: 'sp-range' });
  const dimValue = h('span', { class: 'sp-range-value' });
  dim.addEventListener('input', () => (dimValue.textContent = `${dim.value}%`));
  dim.addEventListener('change', async () => {
    try {
      await ctx.call('mods.setLayout', { backgroundDim: Number(dim.value) / 100 });
      dimRow.saved();
      dimRow.problem(null);
    } catch (err) {
      dimRow.problem(`Couldn't save: ${ctx.cleanError(err)}`);
    }
  });
  const dimRow = row({ id: 'background-dim', title: 'Dim', desc: 'How strongly the app’s surfaces cover the background.', keywords: 'opacity translucent background' }, h('span', { class: 'sp-control-group' }, dim, dimValue));
  const bgOff = offNote();

  // Chat bar and conversation
  const lookPicker = (target: ModLookTarget) => {
    const select = liveSelect('Default', (v) => void setLook(target, v));
    const r = target === 'conversation'
      ? row({ id: 'look-conversation', title: 'Conversation look', desc: 'How the messages, tool rows and code blocks look.', keywords: 'look transcript messages chat style mod conversation' }, select)
      : row({ id: 'look-composer', title: 'Chat bar look', desc: 'How the box you type in looks.', keywords: 'look composer input message box style mod chat bar' }, select);
    return { row: r, select, owner: ownerBox(), off: offNote() };
  };
  const looks: Record<ModLookTarget, ReturnType<typeof lookPicker>> = { conversation: lookPicker('conversation'), composer: lookPicker('composer') };

  // Themes
  const themeList = h('div', { class: 'sp-theme-list' });
  const themeOff = offNote();

  const heads: Record<ModTab, HTMLElement> = {
    mods: group(null, safe),
    backgrounds: group(null, bgRow, bgOwner, pictureRow, dimRow, bgOff.el),
    'chat-bar': group(null, looks.composer.row, looks.composer.owner, looks.composer.off.el),
    conversation: group(null, looks.conversation.row, looks.conversation.owner, looks.conversation.off.el),
    themes: group(null, note('Themes apply in this order: where two change the same thing, the later one wins.', 'sp-tab-order'), themeList, themeOff.el),
  };
  for (const [id, head] of Object.entries(heads)) {
    head.classList.add('sp-tab-head');
    head.dataset.subtab = id;
  }

  const panel = h('div', { id: 'sp-modpanel', role: 'tabpanel' }, ...Object.values(heads), toolbar, installForm, createForm, status, listEl);
  el.append(tabsEl, panel);

  function showTab(next: ModTab): void {
    if (!isModTab(next)) return;
    if (next !== tab) closeForms();
    tab = next;
    for (const [id, b] of tabBtns) {
      const on = id === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `sp-modtab-${tab}`);
    for (const [id, head] of Object.entries(heads)) head.classList.toggle('current', id === tab);
    newBtn.querySelector('span')!.textContent = NEW_LABEL[tab];
    applyTab();
  }

  /** Shows the cards of the tab's kind (the rest stay in the page for the search) and each group's empty note. */
  function applyTab(): void {
    for (const card of listEl.querySelectorAll<HTMLElement>('.sp-mod[data-tabs]')) card.classList.toggle('sp-tab-out', !card.dataset.tabs!.split(' ').includes(tab));
    for (const grp of listEl.querySelectorAll<HTMLElement>('.sp-group')) {
      const shown = grp.querySelectorAll('.sp-mod:not(.sp-tab-out)').length;
      const emptyNote = grp.querySelector<HTMLElement>('.sp-empty-group');
      if (emptyNote) {
        emptyNote.hidden = shown > 0;
        emptyNote.textContent = EMPTY_WORDS[tab];
      }
      grp.classList.toggle('sp-tab-out', !shown && !emptyNote);
    }
  }

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
      // Yours always has its group, with a note while none of its mods are of the tab's kind
      if (g.scope === 'user') grp.append(h('p', { class: 'sp-note sp-empty-group' }));
      for (const m of items) grp.append(modRow(m));
      listEl.append(grp);
    }
    applyTab();
    updateSetLines();
    ctx.refreshSearch();
    if (active instanceof HTMLElement && active.dataset.focusKey) listEl.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(active.dataset.focusKey)}"]`)?.focus();
  }
  listEl.addEventListener('focusout', () => {
    if (pendingRender) setTimeout(() => pendingRender && render(), 0);
  });

  function renderAll(): void {
    renderPickers();
    render();
  }

  // ---------- The pickers ----------

  let lastImage: string | null = null;
  const layout = (): ModLayout | null => ctx.config().mods?.layout ?? null;
  const modName = (key: string) => mods.find((x) => x.key === key)?.manifest?.name ?? key;

  /** Options with the chosen value kept visible: a choice whose mod is off or gone shows as "… (off)". */
  function fill(sel: HTMLSelectElement, choices: { value: string; label: string }[], value: string): void {
    sel.innerHTML = '';
    for (const c of choices) sel.append(h('option', { value: c.value }, c.label));
    if (value && !choices.some((c) => c.value === value)) {
      const i = value.lastIndexOf('/');
      sel.append(h('option', { value }, i > 0 ? `${modName(value.slice(0, i))}: ${value.slice(i + 1)} (off)` : `${value} (off)`));
    }
    sel.value = value;
  }

  /** The chosen part's mod's own settings under the picker; rebuilt only when they change and nothing in them has focus. */
  function fillOwner(box: HTMLElement, ref: string | null): void {
    const m = ref ? mods.find((x) => x.key === refMod(ref) && x.state === 'on') : undefined;
    const fields = m?.manifest?.contributes?.settings ?? [];
    const sig = m && fields.length ? `${m.key}|${m.rev}|${JSON.stringify(m.settings)}` : '';
    if (box.dataset.sig === sig) return;
    if (box.contains(document.activeElement) && (document.activeElement as HTMLElement).matches('input:not([type=checkbox]), textarea')) return;
    box.dataset.sig = sig;
    box.innerHTML = '';
    if (m) for (const f of fields) box.append(settingRow(m, f, `pick-${tabOf(box)}`, m.manifest?.name ?? m.id));
  }
  const tabOf = (box: HTMLElement) => box.closest<HTMLElement>('[data-subtab]')?.dataset.subtab ?? '';

  function renderPickers(): void {
    const l = layout();
    if (!l) return;
    // Backgrounds
    if (l.backgroundImage) lastImage = l.backgroundImage;
    const bgNow = l.background ?? (l.backgroundImage ? 'image' : '');
    fill(bgSelect.select, [{ value: '', label: 'None' }, ...backgroundChoices(mods), ...(lastImage ? [{ value: 'image', label: 'Your picture' }] : [])], bgNow);
    fillOwner(bgOwner, l.background);
    pictureName.textContent = lastImage ? basename(lastImage).replace(/^\d+-/, '') : 'None chosen';
    pictureName.title = lastImage ?? '';
    dim.value = String(Math.round((l.backgroundDim ?? 0.5) * 100));
    dimValue.textContent = `${dim.value}%`;
    dimRow.el.classList.toggle('sp-off', !bgNow);
    dim.disabled = !bgNow;
    bgOff.set(offWords('backgrounds', 'background'));
    // Looks
    for (const target of ['conversation', 'composer'] as const) {
      const p = looks[target];
      const ref = l.looks?.[target] ?? '';
      fill(p.select.select, [{ value: '', label: 'Default' }, ...lookChoices(mods, target)], ref);
      fillOwner(p.owner, ref || null);
      p.off.set(offWords(target === 'composer' ? 'chat-bar' : 'conversation', target === 'composer' ? 'chat bar look' : 'conversation look'));
    }
    renderThemes();
    updateSetLines();
  }

  function offWords(t: ModTab, what: string): string {
    const off = offModsOfTab(mods, t);
    if (!off.length) return '';
    return `${off.join(', ')} ${off.length === 1 ? 'has a' : 'have a'} ${what} too, and ${off.length === 1 ? 'is' : 'are'} off: turn ${off.length === 1 ? 'it' : 'them'} on below to pick ${off.length === 1 ? 'it' : 'one'} here.`;
  }

  function renderThemes(): void {
    if (themeList.contains(document.activeElement)) return;
    themeList.innerHTML = '';
    const list = themeMods(mods);
    if (!list.length) themeList.append(note('No themes yet. Make one with New theme…, or install one.', 'sp-empty-group'));
    list.forEach((m, i) => {
      const name = m.manifest?.name ?? m.id;
      const sw = switchControl(m.state === 'on', (on) => void setEnabled(m, on, sw));
      sw.setAttribute('aria-label', `${name}: ${m.state === 'on' ? 'on' : 'off'}`);
      sw.disabled = m.state === 'invalid';
      const r = row({ id: `theme-${safeKey(m.key)}`, title: `${i + 1}. ${name}`, desc: m.manifest?.description ?? '', keywords: `${m.id} theme styles colours colors` }, sw);
      const c = modChip(m);
      if (c && m.state !== 'off') r.el.querySelector('.sp-row-title')!.append(chip(c.label, c.tone));
      r.el.classList.add('clickable');
      themeList.append(r.el);
    });
  }

  async function setLook(target: ModLookTarget, v: string): Promise<void> {
    const r = looks[target].row;
    try {
      await ctx.call('mods.setLayout', { looks: { [target]: v || null } as ModLayout['looks'] });
      r.saved();
      r.problem(null);
    } catch (err) {
      r.problem(`Couldn't change the look: ${ctx.cleanError(err)}`);
      renderPickers();
    }
  }

  async function setBackground(v: string): Promise<void> {
    try {
      if (v === 'image') {
        if (!lastImage) return void chooseImage();
        await ctx.call('mods.setLayout', { background: null, backgroundImage: lastImage });
      } else if (v === '') await ctx.call('mods.setLayout', { background: null, backgroundImage: null });
      else await ctx.call('mods.setLayout', { background: v });
      bgRow.saved();
      bgRow.problem(null);
    } catch (err) {
      bgRow.problem(`Couldn't change the background: ${ctx.cleanError(err)}`);
      renderPickers();
    }
  }

  async function chooseImage(): Promise<void> {
    try {
      const before = layout()?.backgroundImage ?? null;
      const l = await ctx.call('mods.chooseBackgroundImage');
      if (l.backgroundImage && l.backgroundImage !== before) {
        lastImage = l.backgroundImage;
        pictureRow.saved();
      }
      pictureRow.problem(null);
      renderPickers();
    } catch (err) {
      pictureRow.problem(ctx.cleanError(err));
    }
  }

  // ---------- "Use the whole set" on the card of a mod that brings several parts ----------

  function updateSetLines(): void {
    const l = layout();
    const now = l ? currentLookSet(mods, l) : '';
    for (const line of listEl.querySelectorAll<HTMLElement>('.sp-mod-set')) {
      const key = line.dataset.set!;
      const inUse = now === key;
      if (line.dataset.state === String(inUse)) continue;
      line.dataset.state = String(inUse);
      line.innerHTML = '';
      const act = h('button', { type: 'button', class: 'link-btn', 'data-focus-key': `${key}|set` }, inUse ? 'Stop using the set' : 'Use the whole set');
      act.addEventListener('click', () => void useSet(key, !inUse, line));
      if (inUse) line.append(chip('Whole set in use', 'ok'), act);
      else line.append(act, h('span', { class: 'sp-detail-muted' }, ' its conversation look, chat bar look and background together'));
    }
  }

  async function useSet(key: string, on: boolean, line: HTMLElement): Promise<void> {
    const set = lookSets(mods).find((x) => x.key === key) ?? null;
    if (on && !set) return;
    try {
      await ctx.call('mods.setLayout', lookSetPatch(on ? set : null));
      setRowProblem(line, null);
    } catch (err) {
      setRowProblem(line, `Couldn't apply the set: ${ctx.cleanError(err)}`);
    }
  }

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
    const tabs = modTabs(m);
    const r = row({ id: `mod-${safeKey(m.key)}`, title: name, desc: m.manifest?.description ?? (m.problems[0]?.message || ''), keywords: `${m.id} mod ${m.manifest?.author ?? ''} ${tabs.map((t) => MOD_TABS.find((x) => x.id === t)!.title).join(' ')}` });
    r.el.classList.add('sp-mod');
    r.el.dataset.tabs = tabs.join(' ');
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
    // A mod that brings several parts (a conversation look, a chat bar look, a background) can be used as a whole
    if (lookSets(mods).some((x) => x.key === m.key)) r.descEl.after(h('div', { class: 'sp-mod-set', 'data-set': m.key }));

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
      renderAll();
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
    for (const v of m.manifest?.contributes?.views ?? []) adds.push(`${v.title}: ${SEAT_WORDS[v.seat] ?? v.seat}${v.seat === 'background' ? ' (pick it on the Backgrounds tab)' : ''}`);
    for (const l of m.manifest?.contributes?.looks ?? []) adds.push(`${l.title}: ${LOOK_WORDS[l.target] ?? l.target} (pick it on the ${l.target === 'composer' ? 'Chat bar' : 'Conversation'} tab)`);
    for (const c of m.manifest?.contributes?.commands ?? []) adds.push(`/${c.name}: ${c.description}`);
    const styles = m.manifest?.contributes?.styles ?? [];
    if (styles.length) adds.push(`Styles for the whole app: ${styles.join(', ')} (in order on the Themes tab)`);
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
              renderAll();
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
              renderAll();
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

  /** One of a mod's own settings; `prefix` keeps the ids apart where the same setting shows twice (a card and a picker). */
  function settingRow(m: ModInfo, f: ModSettingField, prefix = '', pill?: string): HTMLElement {
    const value = m.settings[f.key] ?? (f as { default?: unknown }).default;
    const id = `${prefix ? `${prefix}-` : ''}modset-${safeKey(m.key)}-${f.key}`;
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
      r = row({ id, title: f.title, desc: f.description, pill }, sw);
      r.el.classList.add('clickable');
    } else if (f.type === 'select') {
      const sel = selectControl(f.options.map((o) => ({ value: o, label: o })), String(value ?? f.options[0] ?? ''), (v) => void setValue(r, v), 180);
      r = row({ id, title: f.title, desc: f.description, pill }, sel);
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
      r = row({ id, title: f.title, desc: f.description, pill }, ctl);
    }
    r.el.classList.add('sp-sub-row');
    return r.el;
  }

  onPush('mods:changed', (list) => {
    if (!Array.isArray(list)) return;
    mods = list;
    renderAll();
  });

  showTab(tab);

  return {
    id: 'mods',
    el,
    sync(cfg) {
      safeInput.checked = Boolean(cfg.mods?.safeMode);
      renderPickers();
    },
    tab: () => tab,
    showTab: (t) => {
      if (isModTab(t)) showTab(t);
    },
    uncover(target) {
      const head = target.closest<HTMLElement>('[data-subtab]');
      if (head && isModTab(head.dataset.subtab)) return showTab(head.dataset.subtab);
      const card = target.closest<HTMLElement>('.sp-mod[data-tabs]');
      const tabs = (card?.dataset.tabs ?? '').split(' ').filter(isModTab);
      if (tabs.length && !tabs.includes(tab)) showTab(tabs[0]);
    },
    async load() {
      try {
        mods = await ctx.call('mods.list');
      } catch (err) {
        if (ctx.isUnknown(err)) return 'absent';
        showStatus(`Couldn't load the mods: ${ctx.cleanError(err)}`, true);
        return 'ok';
      }
      renderAll();
      return 'ok';
    },
    closed() {
      closeForms();
      showStatus('');
    },
  };
}
