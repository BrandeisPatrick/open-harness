// Settings → Dreaming: the run control, the daily time, the mode, what to look for, a plain word on privacy and cost,
// and the dreams, newest first. Opening a dream shows its proposals with Apply, Dismiss, Apply all and Revert; its
// "Open" button brings the dream's session on screen.

import type { AppConfig } from '../../shared/types';
import type { Dream, DreamingState, DreamMode } from '../../shared/dreaming';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { adoptDreaming, dreamStatus, onDreaming, proposalCard, refreshDreaming } from '../dreaming.js';
import { formatWhenAt } from './model.js';
import { button, group, note, row, sectionTitle, switchControl, tildePath } from './ui.js';
import type { Ctx, Section } from './ctx.js';

const MODE_LINES: Record<DreamMode, string> = {
  auto: 'Each suggestion is applied as soon as the dream makes it; you can revert it afterwards. New mods still stay off until you turn them on.',
  approve: 'The dream finishes its review, then each suggestion waits for you to apply or dismiss it.',
  plan: 'Nothing is applied: the suggestions become one plan in the dream’s session. Approve it to apply them all, or answer to change it.',
};

const TRIGGER_WORDS: Record<Dream['trigger'], string> = { daily: 'every day', manual: 'by hand', command: 'with /dream' };

export function dreamingSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Dreaming'));
  el.append(note('A dream reads what happened in your recent sessions and suggests skills, mods and memory that would help the agent work better for you. It reads; it changes nothing by itself unless the mode is Auto.', 'sp-intro'));
  let state: DreamingState | null = null;
  const cfg = () => ctx.config().dreaming;
  const open = new Set<string>();

  // ---------- The run control: a play glyph, or a stop square while a dream runs ----------
  const runBtn = h('button', { type: 'button', class: 'icon-btn sp-icon-btn dream-run', id: 'dream-run' });
  const runText = h('span', { class: 'dream-run-text', id: 'dream-run-text' });
  const runProblem = h('div', { class: 'sp-problem', role: 'alert', hidden: true });
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runProblem.hidden = true;
    try {
      adoptDreaming(await ctx.call(state?.running ? 'dreaming.stop' : 'dreaming.run'));
      if (state && !state.running && state.lastCheck?.found === 0) runText.textContent = 'Nothing new to dream about since the last dream.';
    } catch (err) {
      runProblem.hidden = false;
      runProblem.innerHTML = `${icon('circle-alert', 14)}<span></span>`;
      runProblem.querySelector('span')!.textContent = ctx.cleanError(err);
    } finally {
      runBtn.disabled = false;
    }
  });
  const toolbar = h('div', { class: 'sp-toolbar sp-only-browse dream-toolbar' }, runBtn, runText);
  el.append(toolbar, runProblem);

  // ---------- Daily, mode ----------
  const timeInput = h('input', { type: 'time', class: 'sp-input dream-time', id: 'dream-time', 'aria-label': 'Time of the daily dream' }) as HTMLInputElement;
  const dailySwitch = switchControl(false, (on) => void ctx.save(dailyRow, 'dreaming.daily', on).then((ok) => !ok && (dailySwitch.checked = cfg().daily)));
  dailySwitch.id = 'dream-daily';
  timeInput.addEventListener('change', () => {
    const v = timeInput.value;
    if (!/^\d{2}:\d{2}$/.test(v)) return;
    void ctx.save(dailyRow, 'dreaming.time', v).then((ok) => !ok && (timeInput.value = cfg().time));
  });
  const dailyRow = row({ id: 'dreaming-daily', title: 'Dream every day', desc: '', keywords: 'schedule daily time night automatic', field: 'dreaming.daily' }, h('span', { class: 'sp-control-group' }, timeInput, dailySwitch));
  const modeRow = ctx.segField<DreamMode>({
    id: 'dreaming-mode',
    title: 'Mode',
    desc: '',
    keywords: 'auto approve plan apply',
    field: 'dreaming.mode',
    choices: [
      { value: 'auto', label: 'Auto' },
      { value: 'approve', label: 'Approve' },
      { value: 'plan', label: 'Plan' },
    ],
    onSaved: (v) => modeRow.setDesc(MODE_LINES[v]),
  });
  el.append(group(null, dailyRow, modeRow));
  el.append(
    group(
      'Look for',
      ctx.switchField({ id: 'dreaming-skills', title: 'Skills', desc: 'A procedure you asked for more than once, written down so /name runs it.', keywords: 'dream skill procedure', field: 'dreaming.skills' }),
      ctx.switchField({ id: 'dreaming-mods', title: 'Mods', desc: 'A view or a status you keep asking for, as a small panel. It stays off until you turn it on.', keywords: 'dream mod panel view', field: 'dreaming.mods' }),
      ctx.switchField({ id: 'dreaming-memory', title: 'Memory', desc: 'Preferences, corrections and facts about a project, as lines in its instructions file.', keywords: 'dream memory instructions preferences', field: 'dreaming.memory' }),
    ),
  );
  el.append(note('A dream sends parts of your past conversations to the model you configured, and it uses tokens: about as many as a long message, once per project with new activity.', 'sp-explain dream-privacy'));

  // ---------- The dreams ----------
  const listEl = h('div', { class: 'dream-list', id: 'dream-list' });
  el.append(listEl);

  function syncConfig(c: AppConfig | undefined = ctx.config()): void {
    const d = c?.dreaming;
    if (!d) return;
    dailySwitch.checked = d.daily;
    if (document.activeElement !== timeInput) timeInput.value = d.time;
    modeRow.setDesc(MODE_LINES[d.mode] ?? '');
    syncDaily();
  }

  function syncDaily(): void {
    const d = cfg();
    const next = state?.nextRunAt;
    dailyRow.setDesc(d?.daily && next ? `Next: ${formatWhenAt(next)}. A dream missed while the app was closed runs once at the next launch.` : 'Off. When it is on, a dream runs once a day at this time, local time.');
  }

  function syncRun(): void {
    const r = state?.running;
    runBtn.innerHTML = icon(r ? 'square' : 'play', 16);
    runBtn.classList.toggle('running', Boolean(r));
    const label = r ? 'Stop the dream' : 'Dream now';
    runBtn.setAttribute('aria-label', label);
    runBtn.dataset.tip = label;
    runBtn.title = label;
    if (r) runText.textContent = `Dreaming about ${tildePath(r.cwd)}…${r.queued ? ` ${r.queued} more project${r.queued === 1 ? '' : 's'} after it.` : ''}`;
    else if (state?.lastCheck) runText.textContent = `Last looked ${formatWhenAt(state.lastCheck.at).replace(/^(Today|Yesterday|Tomorrow)/, (m) => m.toLowerCase())}${state.lastCheck.found ? '' : ': nothing new'}.`;
    else runText.textContent = 'Dream now about the projects with new sessions.';
  }

  function dreamEl(d: Dream): HTMLElement {
    const st = dreamStatus(d);
    const wrap = h('div', { class: `dream-item${open.has(d.id) ? ' open' : ''}`, 'data-dream': d.id });
    const chev = h('span', { class: 'dream-chev', html: icon('chevron-right', 14) });
    const title = h('span', { class: 'dream-project', title: tildePath(d.cwd) }, d.cwd.split('/').filter(Boolean).pop() || d.cwd);
    const meta = h('span', { class: 'dream-meta', title: tildePath(d.cwd) }, `${formatWhenAt(d.startedAt)} · ${TRIGGER_WORDS[d.trigger] ?? d.trigger} · ${d.mode[0].toUpperCase()}${d.mode.slice(1)} · ${d.covered.sessions} session${d.covered.sessions === 1 ? '' : 's'}`);
    const status = h('span', { class: `dream-status ${st.tone}` }, st.text);
    const head = h('button', { type: 'button', class: 'dream-head', 'aria-expanded': String(open.has(d.id)) }, chev, h('span', { class: 'dream-text' }, title, meta), status);
    head.addEventListener('click', () => {
      if (open.has(d.id)) open.delete(d.id);
      else open.add(d.id);
      render();
    });
    const openBtn = button('Open', () => ctx.openSession(d.sessionId), { aria: `Open the session of the dream about ${tildePath(d.cwd)}` });
    openBtn.classList.add('dream-open');
    // A session that was deleted (it may be in the trash) cannot be opened from here
    if (!ctx.sessionTitle(d.sessionId)) {
      openBtn.disabled = true;
      openBtn.title = 'Its session was deleted';
    }
    wrap.append(h('div', { class: 'dream-line' }, head, openBtn));
    if (open.has(d.id)) {
      const body = h('div', { class: 'dream-body' });
      const shown = d.proposals.filter((p) => p.state !== 'withdrawn');
      if (!shown.length) body.append(note(d.status === 'running' ? 'Still reading.' : d.status === 'failed' ? `It failed: ${d.error ?? 'unknown error'}` : 'Nothing worth suggesting this time.'));
      const pending = shown.filter((p) => p.state === 'waiting' || p.state === 'planned');
      if (pending.length > 1) {
        const all = button(`Apply all ${pending.length}`, async (b) => {
          b.disabled = true;
          try {
            await ctx.call('dreaming.applyAll', d.id);
          } catch (err) {
            body.prepend(note(ctx.cleanError(err), 'error'));
          } finally {
            b.disabled = false;
            await refreshDreaming();
          }
        }, { primary: true });
        all.classList.add('dream-apply-all');
        body.append(h('div', { class: 'dream-actions' }, all));
      }
      for (const p of shown) body.append(proposalCard(p.id));
      wrap.append(body);
    }
    return wrap;
  }

  function render(): void {
    syncRun();
    syncDaily();
    listEl.innerHTML = '';
    const grp = group('Dreams');
    const dreams = state?.dreams ?? [];
    if (!dreams.length) grp.append(note('No dreams yet. Turn on “Dream every day”, or dream now with the play button or /dream in a session.'));
    for (const d of dreams) grp.append(dreamEl(d));
    listEl.append(grp);
    ctx.refreshSearch();
  }

  onDreaming((s) => {
    state = s;
    if (el.isConnected) render();
  });

  return {
    id: 'dreaming',
    el,
    async load() {
      try {
        state = await ctx.call('dreaming.get');
      } catch (err) {
        if (ctx.isUnknown(err)) return 'absent';
        listEl.innerHTML = '';
        listEl.append(note(`Couldn't load the dreams: ${ctx.cleanError(err)}`, 'error'));
        return 'ok';
      }
      adoptDreaming(state);
      syncConfig();
      render();
      return 'ok';
    },
    sync(c) {
      syncConfig(c);
    },
  };
}
