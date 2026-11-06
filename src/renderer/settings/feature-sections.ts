// Skills, Scheduled and Remote control: sections over a feature's own data rather than the config.

import type { SkillInfo } from '../../shared/types';
import type { Schedule, ScheduleInput } from '../../shared/schedules';
import type { RemoteStatus } from '../../shared/remote';
import { copyWithFeedback, dirname, escapeHtml, h } from '../dom.js';
import { icon } from '../icons.js';
import { onPush } from '../rpc.js';
import { formatWhenAt, LAST_STATUS_WORDS, parseWhen } from './model.js';
import { button, chip, group, iconButton, note, row, sectionTitle, segmented, switchControl, textControl, tildePath, type Row } from './ui.js';
import type { Ctx, Section } from './ctx.js';

// ---------- Skills ----------

export function skillsSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Skills'));
  const where = note('', 'sp-intro');
  const listEl = h('div', {});
  el.append(where, listEl);
  const GROUPS: { source: SkillInfo['source']; title: string }[] = [
    { source: 'project', title: 'This project' },
    { source: 'user', title: 'Yours' },
    { source: 'bundled', title: 'Built-in' },
  ];

  function render(skills: SkillInfo[], configDir: string): void {
    const project = ctx.config().workingDirectory;
    where.textContent = `A skill is a folder with a SKILL.md. Put new ones in ${tildePath(configDir)}/skills/<name>/ for every project, or in ${tildePath(project)}/.open-harness/skills/<name>/ for this one. The agent loads a skill when its description fits the task, and / in the composer lists them.`;
    listEl.innerHTML = '';
    for (const g of GROUPS) {
      const items = skills.filter((s) => s.source === g.source);
      if (!items.length) continue;
      const grp = group(g.title);
      for (const s of items) {
        const r = row(
          { id: `skill-${g.source}-${s.name.replace(/[^a-z0-9-]+/gi, '_')}`, title: s.name, desc: s.description || 'No description.', keywords: `skill ${g.title}` },
          button('Reveal', async () => {
            try {
              await window.oc.changes.openInEditor(dirname(s.path).replace(/\/$/, ''));
            } catch (err) {
              r.problem(`Couldn't show the folder: ${ctx.cleanError(err)}`);
            }
          }, { icon: 'folder', aria: `Reveal ${s.name}` }),
        );
        r.el.title = s.path;
        grp.append(r.el);
      }
      listEl.append(grp);
    }
    if (!skills.length) listEl.append(note('No skills found yet.'));
    ctx.refreshSearch();
  }

  return {
    id: 'skills',
    el,
    async load() {
      if (typeof window.oc?.skills?.list !== 'function') return 'absent';
      let configDir = '~/.open-harness';
      try {
        configDir = (await ctx.call('app.info')).configDir || configDir;
      } catch {
        /* an older app: the default folder */
      }
      try {
        render(await window.oc.skills.list(), configDir);
      } catch (err) {
        listEl.innerHTML = '';
        listEl.append(note(`Couldn't list the skills: ${ctx.cleanError(err)}`, 'error'));
      }
      return 'ok';
    },
  };
}

// ---------- Scheduled ----------

export function scheduledSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Scheduled'));
  el.append(note('Prompts that run later or on a rhythm, in a session of their own or in one you pick. They run while Open Harness is open.', 'sp-intro'));
  const listEl = h('div', {});
  let schedules: Schedule[] = [];

  // New task form
  const nameCtl = textControl({ value: '', placeholder: 'Morning summary', width: 260, onCommit: () => {} });
  nameCtl.input.setAttribute('aria-label', 'Name of the task');
  const promptCtl = textControl({ value: '', placeholder: 'Summarise what changed in the repo since yesterday…', multiline: true, onCommit: () => {} });
  promptCtl.input.setAttribute('aria-label', 'Prompt to send');
  let kind: 'at' | 'every' | 'cron' = 'every';
  const atInput = h('input', { type: 'datetime-local', class: 'sp-input', 'aria-label': 'Date and time' });
  const everyInput = h('input', { type: 'text', inputmode: 'numeric', class: 'sp-input', value: '60', 'aria-label': 'Every how many minutes' });
  const cronInput = h('input', { type: 'text', class: 'sp-input mono', placeholder: '0 9 * * 1-5', spellcheck: 'false', 'aria-label': 'Cron expression' });
  const whenBox = h('span', { class: 'sp-when' });
  const showKind = () => {
    whenBox.innerHTML = '';
    if (kind === 'at') whenBox.append(atInput);
    else if (kind === 'every') whenBox.append(everyInput, h('span', { class: 'sp-unit' }, 'minutes'));
    else whenBox.append(cronInput, h('span', { class: 'sp-unit' }, 'local time'));
  };
  showKind();
  const kindSeg = segmented<'at' | 'every' | 'cron'>(
    [
      { value: 'at', label: 'Once' },
      { value: 'every', label: 'Every' },
      { value: 'cron', label: 'Cron' },
    ],
    'every',
    (v) => {
      kind = v;
      showKind();
    },
  );
  kindSeg.setAttribute('aria-label', 'When it runs');
  let target: 'new' | 'session' = 'new';
  const targetSeg = segmented<'new' | 'session'>(
    [
      { value: 'new', label: 'A new session' },
      { value: 'session', label: 'The session on screen' },
    ],
    'new',
    (v) => (target = v),
  );
  targetSeg.setAttribute('aria-label', 'Where it runs');
  const formProblem = h('div', { class: 'sp-problem', role: 'alert', hidden: true });
  const setProblem = (m: string | null) => {
    formProblem.hidden = !m;
    formProblem.innerHTML = m ? `${icon('circle-alert', 14)}<span>${escapeHtml(m)}</span>` : '';
  };
  const createBtn = button('Create', async (b) => {
    const name = nameCtl.input.value.trim();
    const prompt = promptCtl.input.value.trim();
    if (!name) return setProblem('Give the task a name.');
    if (!prompt) return setProblem('Write the prompt it sends.');
    const when = parseWhen(kind, kind === 'at' ? atInput.value : kind === 'every' ? everyInput.value : cronInput.value);
    if (!when.ok) return setProblem(when.error);
    const input: ScheduleInput = { name, prompt, when: when.value, target };
    if (target === 'session') {
      const id = ctx.currentSessionId();
      if (!id) return setProblem('There is no session on screen.');
      input.sessionId = id;
    }
    b.disabled = true;
    try {
      await ctx.call('schedules.create', input);
      setProblem(null);
      nameCtl.set('');
      promptCtl.set('');
      form.hidden = true;
      newBtn.classList.remove('active');
      schedules = await ctx.call('schedules.list');
      render();
    } catch (err) {
      setProblem(ctx.cleanError(err));
    } finally {
      b.disabled = false;
    }
  }, { primary: true });
  const field = (label: string, control: HTMLElement) => h('div', { class: 'sp-form-field' }, h('span', { class: 'sp-form-label' }, label), control);
  const form = h(
    'div',
    { class: 'sp-form sp-only-browse', hidden: true, role: 'group', 'aria-label': 'New scheduled task' },
    h('div', { class: 'sp-form-title' }, 'New scheduled task'),
    field('Name', nameCtl),
    field('Prompt', promptCtl),
    h('div', { class: 'sp-form-grid' }, field('When', h('div', { class: 'sp-form-inline' }, kindSeg, whenBox)), field('Run in', targetSeg)),
    h('div', { class: 'sp-form-line end' }, button('Cancel', () => ((form.hidden = true), newBtn.classList.remove('active'))), createBtn),
    formProblem,
  );
  const newBtn = button('New scheduled task', () => {
    form.hidden = !form.hidden;
    newBtn.classList.toggle('active', !form.hidden);
    if (!form.hidden) {
      const soon = new Date(Date.now() + 3_600_000);
      soon.setMinutes(0, 0, 0);
      const pad = (n: number) => String(n).padStart(2, '0');
      if (!atInput.value) atInput.value = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:00`;
      nameCtl.input.focus();
    }
  }, { icon: 'plus' });
  el.append(h('div', { class: 'sp-toolbar sp-only-browse' }, newBtn), form, listEl);

  function render(): void {
    listEl.innerHTML = '';
    const grp = group(null);
    if (!schedules.length) grp.append(note('No scheduled tasks. Create one here, or ask the agent: "every weekday at 9, summarise the open pull requests".'));
    for (const s of schedules) grp.append(scheduleRow(s).el);
    listEl.append(grp);
    ctx.refreshSearch();
  }

  function scheduleRow(s: Schedule): Row {
    const bits = [s.describe];
    bits.push(s.nextRunAt ? `Next: ${formatWhenAt(s.nextRunAt)}` : 'Will not run again');
    if (s.lastStatus) bits.push(`${LAST_STATUS_WORDS[s.lastStatus] ?? s.lastStatus}${s.lastRunAt && s.lastStatus !== 'running' ? ` (${formatWhenAt(s.lastRunAt)})` : ''}`);
    const r = row({ id: `sched-${s.id}`, title: s.name, desc: bits.join(' · '), keywords: `schedule task ${s.prompt.slice(0, 200)}` });
    if (s.createdBy === 'agent') r.el.querySelector('.sp-row-title')!.append(h('span', { class: 'sp-pill' }, 'Made by the agent'));
    if (s.lastStatus === 'error') r.el.querySelector('.sp-row-title')!.append(chip('Failed', 'danger'));
    r.el.title = s.prompt;
    const run = button('Run now', async (b) => {
      b.disabled = true;
      try {
        await ctx.call('schedules.runNow', s.id);
        r.problem(null);
        r.saved();
      } catch (err) {
        r.problem(`Couldn't run it: ${ctx.cleanError(err)}`);
      } finally {
        b.disabled = false;
      }
    }, { icon: 'arrow-filled', aria: `Run ${s.name} now` });
    const del = iconButton('trash', `Delete ${s.name}`, async () => {
      const ok = await ctx.confirm({ title: `Delete “${s.name}”?`, description: 'It will not run again. Sessions it already ran stay.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        schedules = await ctx.call('schedules.remove', s.id);
        render();
      } catch (err) {
        r.problem(`Couldn't delete it: ${ctx.cleanError(err)}`);
      }
    });
    const sw = switchControl(s.enabled, async (on) => {
      try {
        await ctx.call('schedules.update', s.id, { enabled: on });
        r.problem(null);
        r.saved();
      } catch (err) {
        sw.checked = !on;
        r.problem(`Couldn't ${on ? 'turn it on' : 'pause it'}: ${ctx.cleanError(err)}`);
      }
    });
    sw.setAttribute('aria-label', `${s.name}: ${s.enabled ? 'on' : 'paused'}`);
    r.control.append(h('span', { class: 'sp-control-group' }, run, del, sw));
    return r;
  }

  onPush('schedules:changed', (list) => {
    if (!Array.isArray(list)) return;
    schedules = list;
    render();
  });

  return {
    id: 'scheduled',
    el,
    async load() {
      try {
        schedules = await ctx.call('schedules.list');
      } catch (err) {
        if (ctx.isUnknown(err)) return 'absent';
        listEl.innerHTML = '';
        listEl.append(note(`Couldn't load the tasks: ${ctx.cleanError(err)}`, 'error'));
        return 'ok';
      }
      render();
      return 'ok';
    },
    closed() {
      form.hidden = true;
      newBtn.classList.remove('active');
      setProblem(null);
    },
  };
}

// ---------- Remote control ----------

export function remoteSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Remote control'));
  let status: RemoteStatus | null = null;

  const onInput = switchControl(false, async (on) => {
    try {
      status = await ctx.call(on ? 'remote.start' : 'remote.stop');
      onRow.problem(status.error ?? null);
      if (!status.error) onRow.saved();
      render();
    } catch (err) {
      onInput.checked = !on;
      onRow.problem(`Couldn't turn it ${on ? 'on' : 'off'}: ${ctx.cleanError(err)}`);
    }
  });
  const onRow = row({ id: 'remote-enabled', title: 'Remote control', desc: 'Follow and steer your sessions from a phone or another computer, through a small page Open Harness serves.', keywords: 'phone mobile web server access' }, onInput);
  onRow.el.classList.add('clickable');

  const bindSeg = segmented<'localhost' | 'lan'>(
    [
      { value: 'localhost', label: 'This Mac only' },
      { value: 'lan', label: 'Devices on this network' },
    ],
    'localhost',
    async (v) => {
      try {
        status = await ctx.call('remote.configure', { bind: v });
        bindRow.problem(status.error ?? null);
        if (!status.error) bindRow.saved();
        render();
      } catch (err) {
        bindRow.problem(`Couldn't change it: ${ctx.cleanError(err)}`);
        if (status) bindSeg.set(status.bind);
      }
    },
  );
  const bindRow = row({ id: 'remote-bind', title: 'Who can reach it', desc: 'Devices on this network means anyone on the same Wi-Fi who has the link.', keywords: 'lan localhost network wifi bind' }, bindSeg);

  const linksGroup = group('Links');
  const devicesRow = row({ id: 'remote-clients', title: 'Connected devices', desc: '', keywords: 'clients phones connected' });
  const newLinkRow = row(
    { id: 'remote-newlink', title: 'New link', desc: 'Replaces the access token: every link handed out so far stops working.', keywords: 'token reset revoke' },
    button('New link', async (b) => {
      const ok = await ctx.confirm({ title: 'Make a new link?', description: 'Every link handed out so far stops working, and connected devices are disconnected.', confirmLabel: 'New link', danger: true });
      if (!ok) return;
      b.disabled = true;
      try {
        status = await ctx.call('remote.newLink');
        newLinkRow.problem(null);
        newLinkRow.saved();
        render();
      } catch (err) {
        newLinkRow.problem(`Couldn't make a new link: ${ctx.cleanError(err)}`);
      } finally {
        b.disabled = false;
      }
    }, { icon: 'refresh' }),
  );
  const explain = note(
    'While it is on, anyone with a link can read your sessions, send messages, stop runs, answer approval cards and decide plans, and start new sessions. It cannot change settings, the permission mode, mods, schedules or files. Each link carries its access token, so share it like a password.',
    'sp-explain',
  );
  el.append(group(null, onRow, bindRow), linksGroup, group('Devices', devicesRow, newLinkRow), explain);

  function render(): void {
    if (!status) return;
    onInput.checked = status.enabled;
    bindSeg.set(status.bind);
    linksGroup.querySelectorAll('.sp-row, .sp-note').forEach((n) => n.remove());
    if (status.running && status.urls.length) {
      status.urls.forEach((u, i) => {
        const host = (() => {
          try {
            return new URL(u).hostname;
          } catch {
            return '';
          }
        })();
        const label = host === 'localhost' || host === '127.0.0.1' ? 'On this Mac' : status!.urls.length > 1 ? `On the network (${host})` : 'Link';
        const copy = h('button', { type: 'button', class: 'btn sm', 'aria-label': `Copy the link ${label}`, html: `${icon('copy', 14)}<span>Copy</span>` });
        copy.addEventListener('click', () => void copyWithFeedback(copy, u));
        const r = row({ id: `remote-url-${i}`, title: label, desc: u.replace(/\/r\/[^/]+/, '/r/••••••'), keywords: 'link url address copy' }, copy);
        r.descEl.classList.add('sp-path');
        r.descEl.title = 'The full link, token included, is copied';
        linksGroup.append(r.el);
      });
    } else linksGroup.append(note(status.enabled ? (status.error ? `It could not start: ${status.error}` : 'Starting…') : 'Turn remote control on to get a link.', status.error ? 'error' : ''));
    devicesRow.setDesc(status.running ? (status.clients ? `${status.clients} connected now.` : 'None connected right now.') : 'None: remote control is off.');
    ctx.refreshSearch();
  }

  onPush('remote:changed', (s) => {
    if (!s || typeof s !== 'object') return;
    status = s;
    render();
  });

  return {
    id: 'remote',
    el,
    async load() {
      try {
        status = await ctx.call('remote.status');
      } catch (err) {
        if (ctx.isUnknown(err)) return 'absent';
        onRow.problem(`Couldn't read its state: ${ctx.cleanError(err)}`);
        return 'ok';
      }
      render();
      return 'ok';
    },
  };
}
