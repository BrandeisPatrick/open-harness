// ask_user in the window: the question card (the approval card's frame: the question in the header band with its
// header as a chip, the options as rows, an "Other" row with a text field, Skip and Submit ⌘↵ in the footer) and the
// body of the call's row once it is answered (each question with its answer, read back from the tool's result).
// No renderer state here: renderer.ts places the card, sends the answers and folds the row.

import type { QuestionAnswer, UserQuestion } from '../shared/types';
import { escapeHtml } from './dom.js';
import { icon } from './icons.js';

/** The questions of an ask_user call's arguments, read leniently (the main process has checked them already). */
export function questionsOf(args: unknown): UserQuestion[] {
  const raw = args && typeof args === 'object' ? (args as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '');
  return raw
    .filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === 'object')
    .map((q) => ({
      question: str(q.question),
      header: str(q.header),
      options: (Array.isArray(q.options) ? q.options : [])
        .map((o: unknown) => (typeof o === 'string' ? { label: str(o), description: '' } : { label: str((o as { label?: unknown })?.label), description: str((o as { description?: unknown })?.description) }))
        .filter((o) => o.label && !/^other$/i.test(o.label)),
      multiSelect: q.multiSelect === true || q.multiSelect === 'true',
    }))
    .filter((q) => q.question || q.header);
}

/**
 * The answers in an ask_user result ("- Library: D3", one line per question, by header), or null when the user
 * skipped or the text is not one the tool writes.
 */
export function answersFromResult(questions: UserQuestion[], result: string): string[] | null {
  if (!/^The user answered/.test(result.trim())) return null;
  const lines = result.split('\n');
  return questions.map((q) => {
    const line = lines.find((l) => l.startsWith(`- ${q.header}: `));
    return line ? line.slice(q.header.length + 4) : '';
  });
}

/** One answer for reading: what was typed is shown in quotes, without the words the model gets around it. */
function answerHtml(text: string): string {
  if (!text || text === '(no answer)') return '<span class="qa-none">No answer</span>';
  const m = /^(.*?)(?:,? ?(?:and )?in their own words: "([\s\S]*)")$/.exec(text);
  if (!m) return escapeHtml(text);
  const picked = m[1].replace(/,\s*$/, '').trim();
  return `${picked ? `${escapeHtml(picked)}, ` : ''}<q>${escapeHtml(m[2])}</q>`;
}

/** The body of an answered (or skipped) ask_user row: each question, then its answer. */
export function answeredBody(questions: UserQuestion[], result: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'qa-list';
  const answers = answersFromResult(questions, result);
  if (!answers) {
    box.innerHTML = `<div class="tool-note">${/skipped/.test(result) ? 'Skipped: the model went on without an answer.' : escapeHtml(result.trim())}</div>`;
    return box;
  }
  // One question the row's own line already shows in full: only its answer
  const lone = questions.length === 1 && (questions[0].question || questions[0].header).length <= 80;
  box.innerHTML = questions
    .map((q, i) => `<div class="qa">${lone ? '' : `<div class="qa-q">${escapeHtml(q.question || q.header)}</div>`}<div class="qa-a">${answerHtml(answers[i])}</div></div>`)
    .join('');
  return box;
}

/** The row's meta once the call is over: answered or skipped */
export function answerMeta(questions: UserQuestion[], result: string): string {
  const r = result.trim();
  if (/^The user skipped/.test(r)) return 'skipped';
  return answersFromResult(questions, r) ? 'answered' : '';
}

export interface QuestionCard {
  el: HTMLElement;
  /** Moves the keyboard into the card (the first option), unless the user is typing somewhere */
  focus(): void;
  /** ⌘↵: the next question, or send the answers on the last */
  next(): void;
  /** Esc / Skip */
  skip(): void;
  /** Handles a key that came from outside the card (the empty composer); true when it was used */
  key(e: KeyboardEvent): boolean;
}

export interface QuestionCardOptions {
  /** Unique within the page, for ids */
  uid: string;
  questions: UserQuestion[];
  onSubmit(answers: QuestionAnswer[]): void;
  onSkip(): void;
}

/** The card for one ask_user call. Several questions show one at a time ("1 of 3"); the answers go together. */
export function createQuestionCard(o: QuestionCardOptions): QuestionCard {
  const { questions, uid } = o;
  const el = document.createElement('div');
  el.className = 'question-card prompt-card';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-labelledby', `${uid}-title`);
  const picked: Set<string>[] = questions.map(() => new Set());
  const typed: string[] = questions.map(() => '');
  /** The Other row of each question is on (single choice: it replaces the options) */
  const otherOn: boolean[] = questions.map(() => false);
  let step = 0;
  let done = false;

  const head = document.createElement('div');
  head.className = 'prompt-head';
  const body = document.createElement('div');
  body.className = 'prompt-body';
  const foot = document.createElement('div');
  foot.className = 'row prompt-foot';
  const back = button('Back', 'btn back');
  const skip = button('Skip', 'btn skip');
  skip.setAttribute('aria-keyshortcuts', 'Escape');
  const submit = button('', 'btn primary submit');
  submit.setAttribute('aria-keyshortcuts', 'Meta+Enter');
  const main = document.createElement('div');
  main.className = 'row-main';
  main.append(skip, submit);
  foot.append(back, main);
  el.append(head, body, foot);

  const answered = (i: number) => picked[i].size > 0 || (otherOn[i] && typed[i].trim().length > 0);
  const last = () => step === questions.length - 1;

  const options = () => [...body.querySelectorAll<HTMLElement>('.q-option')];

  const syncFoot = () => {
    back.hidden = step === 0;
    const label = last() ? 'Submit' : 'Next';
    submit.innerHTML = `<span>${label}</span><span class="keys" aria-hidden="true"><kbd>⌘</kbd><kbd>↵</kbd></span>`;
    submit.setAttribute('aria-label', label);
    submit.disabled = !answered(step);
  };

  const syncMarks = () => {
    const q = questions[step];
    for (const row of options()) {
      const other = row.classList.contains('other');
      const on = other ? otherOn[step] : picked[step].has(row.dataset.label ?? '');
      row.classList.toggle('on', on);
      row.setAttribute('aria-checked', String(on));
      const mark = row.querySelector<HTMLElement>('.q-mark');
      if (mark) mark.innerHTML = on ? (q.multiSelect ? icon('check', 12) : '<span class="dot"></span>') : '';
    }
    syncFoot();
  };

  /** Turns an option on or off (single choice: on replaces the others) */
  const toggle = (row: HTMLElement, force?: boolean) => {
    const q = questions[step];
    const other = row.classList.contains('other');
    const label = row.dataset.label ?? '';
    const isOn = other ? otherOn[step] : picked[step].has(label);
    const on = force ?? (q.multiSelect ? !isOn : true);
    if (!q.multiSelect && on) {
      picked[step].clear();
      otherOn[step] = false;
    }
    if (other) otherOn[step] = on;
    else if (on) picked[step].add(label);
    else picked[step].delete(label);
    syncMarks();
  };

  const focusRow = (row: HTMLElement | undefined) => {
    if (!row) return;
    for (const r of options()) r.tabIndex = r === row ? 0 : -1;
    row.focus();
  };

  const render = () => {
    const q = questions[step];
    const several = questions.length > 1;
    head.innerHTML =
      `<div class="title" id="${uid}-title">${escapeHtml(q.question || q.header)}</div>` +
      `<span class="q-chip">${escapeHtml(q.header)}${several ? `<span class="q-step"> · ${step + 1} of ${questions.length}</span>` : ''}</span>`;
    body.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'q-options';
    list.setAttribute('role', q.multiSelect ? 'group' : 'radiogroup');
    list.setAttribute('aria-labelledby', `${uid}-title`);
    const role = q.multiSelect ? 'checkbox' : 'radio';
    q.options.forEach((opt, i) => {
      const row = document.createElement('div');
      row.className = 'q-option';
      row.dataset.label = opt.label;
      row.setAttribute('role', role);
      row.tabIndex = -1;
      row.innerHTML =
        `<span class="q-mark ${role}" aria-hidden="true"></span>` +
        `<span class="q-text"><span class="q-label">${escapeHtml(opt.label)}</span>${opt.description ? `<span class="q-desc">${escapeHtml(opt.description)}</span>` : ''}</span>` +
        `<kbd class="q-key" aria-hidden="true">${i + 1}</kbd>`;
      list.appendChild(row);
    });
    // Other: the user's own words, always there
    const other = document.createElement('div');
    other.className = 'q-option other';
    other.setAttribute('role', role);
    other.setAttribute('aria-label', 'Other');
    other.tabIndex = -1;
    other.innerHTML =
      `<span class="q-mark ${role}" aria-hidden="true"></span>` +
      `<span class="q-text"><span class="q-label">Other</span><input class="q-other" type="text" maxlength="2000" placeholder="Type your own answer" aria-label="Other: your own answer" value="${escapeHtml(typed[step])}"></span>`;
    list.appendChild(other);
    body.appendChild(list);
    const first = options()[0];
    if (first) first.tabIndex = 0;
    syncMarks();
  };

  const finish = (answers: QuestionAnswer[] | null) => {
    if (done) return;
    done = true;
    for (const b of el.querySelectorAll('button')) b.disabled = true;
    if (answers) o.onSubmit(answers);
    else o.onSkip();
  };

  const next = () => {
    if (done || !answered(step)) return;
    if (!last()) {
      step++;
      render();
      focusRow(options()[0]);
      return;
    }
    finish(questions.map((_, i) => (otherOn[i] && typed[i].trim() ? { selected: [...picked[i]], other: typed[i].trim() } : { selected: [...picked[i]] })));
  };

  /** Keys inside the card: ↑↓ move, Space and Enter pick, 1–4 pick, Enter in Other's field goes on */
  el.addEventListener('keydown', (e) => {
    if (done || e.isComposing || e.altKey) return;
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('.q-option');
    const inField = t instanceof HTMLInputElement;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return; // the page's handler: next / submit
    if (e.metaKey || e.ctrlKey) return;
    if (inField) {
      if (e.key === 'Enter') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = options();
        focusRow(e.key === 'ArrowUp' ? rows[rows.length - 2] : rows[0]);
      }
      return;
    }
    if (!row) return;
    if (/^[1-9]$/.test(e.key)) {
      if (card.key(e)) e.preventDefault();
      return;
    }
    const rows = options();
    const at = rows.indexOf(row);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(rows[(at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (row.classList.contains('other')) {
        toggle(row, true);
        row.querySelector<HTMLInputElement>('.q-other')?.focus();
      } else toggle(row);
    }
  });
  el.addEventListener('click', (e) => {
    if (done) return;
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('.q-option');
    if (!row || !el.contains(row)) return;
    if (row.classList.contains('other')) {
      toggle(row, t instanceof HTMLInputElement ? true : undefined);
      if (otherOn[step]) row.querySelector<HTMLInputElement>('.q-other')?.focus();
      return;
    }
    toggle(row);
    focusRow(row);
  });
  el.addEventListener('input', (e) => {
    const t = e.target as HTMLElement;
    if (!(t instanceof HTMLInputElement) || !t.classList.contains('q-other')) return;
    typed[step] = t.value;
    const row = t.closest<HTMLElement>('.q-option');
    // Typing turns Other on (single choice: instead of the options); clearing it leaves the choice as it is
    if (row && t.value.trim() && !otherOn[step]) toggle(row, true);
    else syncFoot();
  });
  back.onclick = () => {
    if (done || step === 0) return;
    step--;
    render();
    focusRow(options()[0]);
  };
  skip.onclick = () => finish(null);
  submit.onclick = () => next();

  render();

  const card: QuestionCard = {
    el,
    focus() {
      focusRow(options()[0]);
    },
    next,
    skip: () => finish(null),
    key(e: KeyboardEvent): boolean {
      if (done) return false;
      // 1–4 pick an option of the question on screen; ↓ moves into the card
      if (/^[1-9]$/.test(e.key)) {
        const row = options().filter((r) => !r.classList.contains('other'))[Number(e.key) - 1];
        if (!row) return false;
        toggle(row);
        focusRow(row);
        return true;
      }
      if (e.key === 'ArrowDown') {
        focusRow(options()[0]);
        return true;
      }
      return false;
    },
  };
  return card;
}

function button(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}
