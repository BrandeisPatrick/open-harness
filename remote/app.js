// OpenAgent remote: follow and steer the app's sessions from a phone. Plain script, no framework, no build step,
// nothing from the network. Served by the app under /r/<token>/, so every URL here is relative.
//
// How the view stays exact: the page opens the event stream first, then loads a snapshot of the session
// (api/transcript: finished items plus what is in flight). The snapshot answers with the number of the last event it
// covers; streamed events carry their own numbers, so the page applies only those after the snapshot. Nothing is
// missed and nothing shows twice, on load, on a session switch and after a reconnect.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    title: $('title'),
    mark: $('mark'),
    model: $('model'),
    conn: $('conn'),
    scroll: $('scroll'),
    transcript: $('transcript'),
    input: $('input'),
    send: $('send'),
    stop: $('stop'),
    statusText: $('status-text'),
    queue: $('queue'),
    tasks: $('tasks'),
    toast: $('toast'),
    sheet: $('sheet'),
    list: $('session-list'),
  };

  // ---------------------------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------------------------

  const S = {
    sessions: [],
    /** The session on the Mac's screen */
    foreground: '',
    /** The session this page shows */
    current: '',
    /** Meta of the current session when the list does not hold it (a brand-new empty session) */
    localMeta: null,
    running: false,
    /** Events of the current session up to this number are already in the view; null while a snapshot loads */
    seq: null,
    buffered: [],
    loadId: 0,
    queue: [],
    dead: false,
  };

  /** The live parts of the view, reset with every snapshot */
  let V = freshView();
  function freshView() {
    return { assistant: null, assistantText: '', thinking: null, thinkingText: '', tools: new Map(), approvals: new Map(), plans: new Map(), compacting: null };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------------------------

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  function h(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  const ICONS = {
    chevron: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    plan: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    list: '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>',
    think: '<path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.6 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.6 1.5"/><path d="M18 18a4 4 0 0 0 2-7.46"/><path d="M6 18a4 4 0 0 1-2-7.46"/><path d="M6 18a4 4 0 0 0 6 2 4 4 0 0 0 6-2"/>',
  };
  const icon = (name, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  function parseArgs(args) {
    if (args && typeof args === 'object') return args;
    if (typeof args !== 'string') return {};
    try {
      const v = JSON.parse(args);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function ago(ms) {
    const d = Date.now() - ms;
    if (d < 60_000) return 'just now';
    if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Markdown: a small renderer of our own. Text is escaped before any markup is added, links only to http(s)/mailto.
  // ---------------------------------------------------------------------------------------------------------------

  function emphasis(html) {
    return html
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  }

  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  const link = (url, labelHtml) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;

  /** Links and bare URLs in a stretch of raw text without code spans */
  function inlineText(src) {
    const re = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      out += emphasis(esc(src.slice(last, m.index)));
      if (m[1] !== undefined) out += SAFE_URL.test(m[2]) ? link(m[2], emphasis(esc(m[1]))) : emphasis(esc(m[0]));
      else out += link(m[0], esc(m[0]));
      last = re.lastIndex;
    }
    return out + emphasis(esc(src.slice(last)));
  }

  function inline(src) {
    const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      out += inlineText(src.slice(last, m.index)) + `<code>${esc(m[2].replace(/^ (.+) $/, '$1'))}</code>`;
      last = re.lastIndex;
    }
    return (out + inlineText(src.slice(last))).replace(/\n/g, '<br>');
  }

  const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE = /^\s*\|.*\|\s*$/;
  const indentOf = (s) => /^\s*/.exec(s)[0].replace(/\t/g, '    ').length;
  const startsBlock = (s) => FENCE.test(s) || HEADING.test(s) || HR.test(s) || QUOTE.test(s) || ITEM.test(s);

  function markdown(src) {
    return blocks(String(src).replace(/\r\n?/g, '\n').split('\n'));
  }

  function blocks(lines) {
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) {
        i++;
      } else if ((m = FENCE.exec(line))) {
        const fence = m[1];
        const code = [];
        i++;
        // An unclosed fence runs to the end: that is what a code block looks like while it streams in.
        while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
        i++;
        html += `<pre${m[2] ? ` data-lang="${esc(m[2])}"` : ''}><code>${esc(code.join('\n'))}</code></pre>`;
      } else if ((m = HEADING.exec(line))) {
        html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
        i++;
      } else if (HR.test(line)) {
        html += '<hr>';
        i++;
      } else if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}> ?/, ''));
        html += `<blockquote>${blocks(inner)}</blockquote>`;
      } else if (ITEM.test(line)) {
        const [out, next] = list(lines, i);
        html += out;
        i = next;
      } else if (TABLE.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        // Tables stay as aligned text in a scrollable block: readable on a narrow screen without a grid.
        const rows = [];
        while (i < lines.length && TABLE.test(lines[i])) rows.push(lines[i++].trim());
        html += `<pre>${esc(rows.join('\n'))}</pre>`;
      } else {
        const para = [];
        while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i]))) para.push(lines[i++]);
        html += `<p>${inline(para.map((l) => l.trim()).join('\n'))}</p>`;
      }
    }
    return html;
  }

  function list(lines, i) {
    const first = ITEM.exec(lines[i]);
    const indent = indentOf(first[1]);
    const ordered = /\d/.test(first[2]);
    const items = [];
    while (i < lines.length) {
      const line = lines[i];
      const m = ITEM.exec(line);
      if (m && Math.abs(indentOf(m[1]) - indent) <= 1 && /\d/.test(m[2]) === ordered) {
        items.push([m[3]]);
        i++;
      } else if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length) break;
        const n = ITEM.exec(lines[j]);
        if (indentOf(lines[j]) > indent + 1 || (n && Math.abs(indentOf(n[1]) - indent) <= 1 && /\d/.test(n[2]) === ordered)) {
          if (indentOf(lines[j]) > indent + 1) items[items.length - 1].push('');
          i = j;
        } else break;
      } else if (indentOf(line) > indent + 1) {
        items[items.length - 1].push(line);
        i++;
      } else if (!m && !startsBlock(line)) {
        items[items.length - 1].push(line.trim()); // a lazy continuation line
        i++;
      } else break;
    }
    const body = items
      .map((lines) => {
        let text = lines.shift();
        while (lines.length && lines[0].trim() && !startsBlock(lines[0])) text += '\n' + lines.shift().trim();
        const pad = Math.min(...lines.filter((l) => l.trim()).map(indentOf), Infinity);
        const rest = lines.map((l) => l.slice(Number.isFinite(pad) ? pad : 0));
        const task = /^\[([ xX])\]\s+/.exec(text);
        const head = task ? `<span aria-hidden="true">${task[1] === ' ' ? '☐' : '☑'}</span> ${inline(text.slice(task[0].length))}` : inline(text);
        return `<li>${head}${rest.some((l) => l.trim()) ? blocks(rest) : ''}</li>`;
      })
      .join('');
    const start = ordered ? parseInt(first[2], 10) : 1;
    return [ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${body}</ol>` : `<ul>${body}</ul>`, i];
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Talking to the app
  // ---------------------------------------------------------------------------------------------------------------

  async function api(path, body) {
    const init = { cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit' };
    if (body !== undefined) {
      init.method = 'POST';
      init.headers = { 'content-type': 'application/json', 'x-openagent-remote': '1' };
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch('api/' + path, init);
    } catch {
      throw new Error('Could not reach your Mac.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* bare answers have no body */
    }
    if (!res.ok) {
      if (res.status === 404 && !data) linkDead();
      const err = new Error((data && data.error) || (res.status === 429 ? 'Too many tries. Wait a minute.' : `Request failed (${res.status}).`));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer = 0;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), 5000);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Scrolling: follow the bottom while the reader is there, leave them alone when they scrolled up
  // ---------------------------------------------------------------------------------------------------------------

  // The view is pinned to the bottom until the reader scrolls up. Content growing (streamed text) and the viewport
  // shrinking (the keyboard, the tasks strip, a queued message) both keep a pinned view at the bottom.
  const atBottom = () => el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight < 80;
  let pinned = true;
  el.scroll.addEventListener('scroll', () => (pinned = atBottom()), { passive: true });
  const toBottom = () => {
    if (pinned) el.scroll.scrollTop = el.scroll.scrollHeight;
  };
  const resized = new ResizeObserver(toBottom);
  resized.observe(el.scroll);
  resized.observe(el.transcript);
  function stick(fn) {
    fn();
    toBottom();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Transcript pieces
  // ---------------------------------------------------------------------------------------------------------------

  const ORIGIN_LABEL = { remote: 'Sent from this device', schedule: 'From a schedule', session: 'From another session', mod: 'From a mod', command: 'From a command' };

  function userEl(text, images, origin) {
    const wrap = h('div', 'msg user');
    const bubble = h('div', 'bubble');
    bubble.textContent = text;
    wrap.append(bubble);
    const notes = [];
    if (images) notes.push(images === 1 ? '1 image (on your Mac)' : `${images} images (on your Mac)`);
    if (origin && ORIGIN_LABEL[origin]) notes.push(ORIGIN_LABEL[origin]);
    if (notes.length) wrap.append(h('div', 'from', esc(notes.join(' · '))));
    return wrap;
  }

  function assistantEl(text) {
    const wrap = h('div', 'msg assistant');
    wrap.append(h('div', 'md', markdown(text)));
    return wrap;
  }

  function note(text, cls = '') {
    const n = h('div', 'note' + (cls ? ' ' + cls : ''));
    if (cls === 'error') n.innerHTML = icon('alert', 14);
    n.append(document.createTextNode(text));
    return n;
  }

  function thinkingEl(live) {
    const d = h('details', 'thinking');
    d.innerHTML = `<summary><span class="chev">${icon('chevron', 14)}</span>${icon('think', 15)}<span class="label">${live ? 'Thinking…' : 'Thought'}</span></summary><div class="body"></div>`;
    return d;
  }

  function toolLabel(name, a) {
    const s = (k) => (typeof a[k] === 'string' ? a[k] : '');
    const first = () => Object.values(a).find((v) => typeof v === 'string') || '';
    const line = (k) => s(k).split('\n')[0];
    switch (name) {
      case 'read_file': return ['Read', s('path'), true];
      case 'write_file': return ['Write', s('path'), true];
      case 'edit_file': return ['Edit', s('path'), true];
      case 'list_directory': return ['List', s('path') || '.', true];
      case 'glob': return ['Glob', s('pattern'), true];
      case 'grep': return ['Search', s('pattern'), true];
      case 'bash': return ['Bash', line('command'), true];
      case 'terminal_run': return ['Terminal', line('command'), true];
      case 'terminal_read': return ['Read terminal', s('tab_id'), true];
      case 'skill': return ['Skill', '/' + s('name'), true];
      case 'update_tasks': return ['Tasks', '', false];
      case 'create_artifact': return ['Artifact', s('title'), false];
      case 'show_image': return ['Show image', s('path'), true];
      case 'browser_navigate': return ['Open', s('url'), true];
      case 'browser_click': return ['Click', s('element') || s('text') || s('ref'), false];
      case 'browser_type': return ['Type', s('text'), false];
      case 'browser_screenshot': return ['Screenshot', '', false];
      case 'browser_get_text': return ['Read page text', '', false];
      case 'browser_read_page': return ['Read page outline', '', false];
    }
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    if (mcp) return [mcp[2], short(first(), 80), false, mcp[1]];
    if (name.startsWith('browser_')) return [name.slice(8).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), short(first(), 80), false];
    return [name, short(first(), 80), true];
  }

  /** A one-line tool row; expands to the command and the result. ok: true/false, or undefined while it runs. */
  function toolEl(name, args, result, ok) {
    const a = parseArgs(args);
    const [verb, arg, mono, server] = toolLabel(name, a);
    const d = h('details', 'tool');
    const sum = h('summary');
    sum.innerHTML =
      `<span class="chev">${icon('chevron', 14)}</span>` +
      `<span class="tool-status"></span>` +
      `<span class="tool-verb">${esc(verb)}</span>` +
      `<span class="tool-arg${mono ? ' mono' : ''}">${esc(arg)}</span>` +
      `<span class="tool-meta">${server ? esc(server) : ''}</span>`;
    d.append(sum);
    d._tool = { name, args: a, result, ok };
    d.addEventListener('toggle', () => d.open && fillTool(d));
    setToolState(d, result, ok);
    return d;
  }

  function setToolState(d, result, ok) {
    d._tool.result = result;
    d._tool.ok = ok;
    const st = d.querySelector('.tool-status');
    if (ok === undefined) {
      st.className = 'tool-status';
      st.innerHTML = '<span class="spinner sm"></span>';
    } else {
      st.className = 'tool-status' + (ok ? '' : ' err');
      st.innerHTML = icon(ok ? 'check' : 'x', 14);
      if (!ok) {
        const meta = d.querySelector('.tool-meta');
        meta.className = 'tool-meta err';
        meta.textContent = /^User denied/.test(result || '') ? 'denied' : 'failed';
      }
    }
    if (d.open) fillTool(d);
  }

  function fillTool(d) {
    const t = d._tool;
    let body = d.querySelector('.tool-body');
    if (!body) d.append((body = h('div', 'tool-body')));
    body.textContent = '';
    const cmd = typeof t.args.command === 'string' ? t.args.command : '';
    if (cmd) body.append(h('pre', 'out', `<span class="label">Command</span>${esc(cmd)}`));
    else if (t.name === 'edit_file' || t.name === 'write_file' || !Object.keys(t.args).length) {
      /* the path is in the row; the result says what happened */
    } else body.append(h('pre', 'out', `<span class="label">Input</span>${esc(JSON.stringify(t.args, null, 2))}`));
    if (t.ok === undefined) body.append(h('pre', 'out', '<span class="label">Running…</span>'));
    else body.append(h('pre', 'out' + (t.ok ? '' : ' error'), esc(t.result || '(no output)')));
  }

  function approvalTitle(name) {
    if (name === 'bash' || name === 'terminal_run') return 'Run this command?';
    if (name === 'write_file') return 'Write this file?';
    if (name === 'edit_file') return 'Make this edit?';
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    if (mcp) return `Use ${mcp[2]} from ${mcp[1]}?`;
    return `Allow ${name}?`;
  }

  function approvalEl(ev) {
    const card = h('div', 'card approval');
    card.innerHTML =
      `<div class="card-head"><span class="card-icon">${icon('shield', 16)}</span><div class="card-heading">` +
      `<span class="card-kicker">Waiting for you</span><span class="card-title">${esc(approvalTitle(ev.name))}</span></div></div>` +
      (ev.reason ? `<div class="card-reason">${icon('alert', 14)}<span>${esc(ev.reason[0].toUpperCase() + ev.reason.slice(1))}</span></div>` : '') +
      `<div class="card-body"><pre class="out">${esc(ev.detail || '')}</pre></div>` +
      `<div class="card-actions">` +
      `<button type="button" class="btn" data-a="deny">Deny</button>` +
      `<button type="button" class="btn" data-a="session">${esc(ev.alwaysLabel || 'Allow for this session')}</button>` +
      `<button type="button" class="btn primary" data-a="once">Allow</button></div>`;
    card.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        await api('approve', { id: ev.id, ok: a !== 'deny', always: a === 'session' });
        decideApproval(card, a !== 'deny', a === 'session' ? 'session' : 'once');
      } catch (err) {
        if (err.status === 404) decideApproval(card, null);
        else {
          card.querySelectorAll('button').forEach((x) => (x.disabled = false));
          toast(err.message);
        }
      }
    });
    return card;
  }

  /** ok null: someone answered it elsewhere (on the Mac) */
  function decideApproval(card, ok, scope) {
    if (card.classList.contains('decided')) return;
    card.classList.add('decided');
    const text = ok === null ? 'Answered on your Mac' : ok ? (scope === 'once' ? 'Allowed' : scope === 'project' ? 'Allowed for this project' : 'Allowed for this session') : 'Denied';
    const line = h('div', 'decision', ok === null ? '' : `<span class="${ok ? 'ok' : 'no'}">${icon(ok ? 'check' : 'x', 14)}</span>`);
    line.append(document.createTextNode(text));
    card.querySelector('.card-reason')?.remove();
    card.querySelector('.card-kicker').textContent = 'Approval';
    card.append(line);
  }

  const PLAN_CHIP = { proposed: 'Proposed', approved: 'Approved', rejected: 'Kept planning' };

  function planEl(plan) {
    const card = h('div', 'card plan');
    card.innerHTML =
      `<div class="card-head"><span class="card-icon">${icon('plan', 16)}</span><div class="card-heading">` +
      `<span class="card-kicker">Plan</span><span class="card-title">${esc(plan.title || 'Plan')}</span></div>` +
      `<span class="chip"></span></div>` +
      `<div class="card-body md">${markdown(plan.markdown || '')}</div>` +
      `<div class="card-actions"><button type="button" class="btn" data-d="keep">Keep planning</button>` +
      `<button type="button" class="btn primary" data-d="build-ask">Build</button></div>`;
    card._plan = plan;
    setPlanStatus(card, plan.status);
    card.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-d]');
      if (!b) return;
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        await api('plan', { session: S.current, id: plan.id, decision: b.dataset.d });
        setPlanStatus(card, b.dataset.d === 'keep' ? 'rejected' : 'approved');
      } catch (err) {
        card.querySelectorAll('button').forEach((x) => (x.disabled = false));
        toast(err.message);
      }
    });
    return card;
  }

  function setPlanStatus(card, status) {
    const chip = card.querySelector('.chip');
    chip.className = 'chip ' + status;
    chip.textContent = PLAN_CHIP[status] || status;
    // A plan without an id (an old transcript's synthetic one) cannot be decided from here.
    card.querySelector('.card-actions').hidden = status !== 'proposed' || !card._plan.id;
  }

  function itemEl(item) {
    switch (item.role) {
      case 'user': return userEl(item.text, item.images);
      case 'assistant': return assistantEl(item.text);
      case 'tool': return toolEl(item.name, item.args, item.result, item.ok);
      case 'plan': {
        const card = planEl(item.plan);
        if (item.plan.id) V.plans.set(item.plan.id, card);
        return card;
      }
      case 'artifact': return note(`Artifact: ${item.artifact.title} (open it on your Mac)`);
      case 'image': return note(`Image: ${item.image.caption || item.image.name} (on your Mac)`);
      case 'compaction': return h('div', 'divider', 'Earlier messages summarised');
      default: return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------------------------------------------

  function renderSnapshot(data) {
    V = freshView();
    const t = el.transcript;
    t.textContent = '';
    const live = data.live;
    // A tool call in flight can already sit in the stored messages without its result; the live list shows it.
    let items = data.items;
    if (live.tools.length) {
      const inFlight = new Set(live.tools.map((x) => x.name));
      let end = items.length;
      while (end > 0 && items[end - 1].role === 'tool' && items[end - 1].result === '(no result)' && inFlight.has(items[end - 1].name)) end--;
      items = items.slice(0, end);
    }
    for (const item of items) {
      const n = itemEl(item);
      if (n) t.append(n);
    }
    if (live.thinking) {
      V.thinking = thinkingEl(live.running);
      V.thinkingText = live.thinking;
      V.thinking.querySelector('.body').textContent = live.thinking;
      t.append(V.thinking);
    }
    if (live.text) {
      V.assistant = assistantEl(live.text);
      V.assistant.classList.add('streaming');
      V.assistantText = live.text;
      t.append(V.assistant);
    }
    for (const tool of live.tools) {
      const row = toolEl(tool.name, tool.args, undefined, undefined);
      V.tools.set(tool.id, row);
      t.append(row);
    }
    for (const ap of live.approvals) {
      const card = approvalEl(ap);
      V.approvals.set(ap.id, card);
      t.append(card);
    }
    if (!t.childElementCount) t.append(emptyEl());
    S.queue = live.queue.map((q) => ({ id: q.id, text: q.text }));
    renderQueue();
    setRunning(live.running);
    pinned = true;
    el.scroll.scrollTop = el.scroll.scrollHeight;
  }

  function emptyEl() {
    return h('div', 'empty', '<strong>Nothing here yet</strong>Send a message to start. It runs on your Mac.');
  }

  async function loadTranscript() {
    if (!S.current) {
      el.transcript.textContent = '';
      el.transcript.append(h('div', 'empty', '<strong>No sessions yet</strong>Send a message to start one on your Mac.'));
      setRunning(false);
      return;
    }
    const id = ++S.loadId;
    const session = S.current;
    S.seq = null;
    S.buffered = [];
    try {
      const data = await api('transcript?session=' + encodeURIComponent(session));
      if (id !== S.loadId) return;
      renderSnapshot(data);
      S.seq = data.seq;
      const held = S.buffered;
      S.buffered = [];
      for (const m of held) applyAgent(m);
    } catch (err) {
      if (id !== S.loadId) return;
      S.seq = -1;
      if (err.status === 404 && !S.dead) {
        // The session is gone (deleted on the Mac): fall back to the one on screen there.
        S.current = S.foreground && S.foreground !== session ? S.foreground : '';
        renderTop();
        return loadTranscript();
      }
      toast(err.message);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Live events
  // ---------------------------------------------------------------------------------------------------------------

  function onAgent(msg) {
    if (msg.sessionId !== S.current) return;
    if (S.seq === null) S.buffered.push(msg);
    else applyAgent(msg);
  }

  function endStreaming() {
    if (V.assistant) V.assistant.classList.remove('streaming');
  }

  let paintQueued = false;
  function paintAssistant() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (V.assistant) stick(() => (V.assistant.querySelector('.md').innerHTML = markdown(V.assistantText)));
    });
  }

  function append(node) {
    const empty = el.transcript.querySelector('.empty');
    if (empty) empty.remove();
    stick(() => el.transcript.append(node));
  }

  function applyAgent(msg) {
    if (msg.seq <= S.seq) return; // already in the snapshot
    S.seq = msg.seq;
    const ev = msg.ev;
    switch (ev.type) {
      case 'run_start':
        setRunning(true);
        break;
      case 'user_message':
        endStreaming();
        V.assistant = null;
        append(userEl(ev.text, ev.images, ev.origin));
        break;
      case 'thinking_delta':
        if (!V.thinking) {
          V.thinking = thinkingEl(true);
          V.thinkingText = '';
          append(V.thinking);
        }
        V.thinkingText += ev.text;
        V.thinking.querySelector('.body').textContent = V.thinkingText;
        break;
      case 'thinking_done':
        if (V.thinking) V.thinking.querySelector('.label').textContent = 'Thought';
        V.thinking = null;
        break;
      case 'text_delta':
        if (!V.assistant) {
          V.assistant = assistantEl('');
          V.assistant.classList.add('streaming');
          V.assistantText = '';
          append(V.assistant);
        }
        V.assistantText += ev.text;
        paintAssistant();
        break;
      case 'text_done':
        endStreaming();
        break;
      case 'assistant_message':
        // The finished message is the authority: it replaces what streamed in, or appears if nothing did.
        if (V.assistant) {
          V.assistantText = ev.text;
          if (ev.text) V.assistant.querySelector('.md').innerHTML = markdown(ev.text);
          else V.assistant.remove();
          endStreaming();
        } else if (ev.text) append(assistantEl(ev.text));
        V.assistant = null;
        break;
      case 'tool_start': {
        endStreaming();
        V.assistant = null;
        if (ev.name === 'submit_plan') break; // the plan card stands for it
        const row = toolEl(ev.name, ev.args, undefined, undefined);
        V.tools.set(ev.id, row);
        append(row);
        break;
      }
      case 'tool_end': {
        const row = V.tools.get(ev.id);
        if (row) {
          setToolState(row, ev.result, ev.ok);
          V.tools.delete(ev.id);
        }
        break;
      }
      case 'approval_request': {
        endStreaming();
        const card = approvalEl(ev);
        V.approvals.set(ev.id, card);
        append(card);
        break;
      }
      case 'approval_resolved': {
        const card = V.approvals.get(ev.id);
        if (card) decideApproval(card, ev.ok, ev.scope);
        V.approvals.delete(ev.id);
        break;
      }
      case 'plan_proposed': {
        endStreaming();
        const existing = V.plans.get(ev.plan.id);
        if (existing) setPlanStatus(existing, ev.plan.status);
        else {
          const card = planEl(ev.plan);
          V.plans.set(ev.plan.id, card);
          append(card);
        }
        break;
      }
      case 'tasks_updated':
        renderTasks(ev.tasks);
        break;
      case 'queue_delivered':
      case 'queue_dropped': {
        const q = S.queue.find((x) => x.id === ev.id);
        S.queue = S.queue.filter((x) => x.id !== ev.id);
        renderQueue();
        if (ev.type === 'queue_dropped' && q) {
          if (!el.input.value.trim()) setInput(q.text);
          toast('The run ended before your queued message was sent. It is back in the box.');
        }
        break;
      }
      case 'error':
        endStreaming();
        append(note(ev.message, ev.kind === 'notice' ? '' : 'error'));
        break;
      case 'compact_start':
        V.compacting = note('Summarising the conversation…');
        append(V.compacting);
        break;
      case 'compact_end':
        if (V.compacting) V.compacting.remove();
        V.compacting = null;
        append(ev.compaction ? h('div', 'divider', 'Earlier messages summarised') : note(ev.error || 'Could not summarise.', 'error'));
        break;
      case 'artifact':
        append(note(`Artifact ${ev.action}: ${ev.artifact.title} (open it on your Mac)`));
        break;
      case 'image':
        append(note(`Image: ${ev.image.caption || ev.image.name} (on your Mac)`));
        break;
      case 'session_changed':
        upsertSession(ev.session);
        if (ev.session.plan) V.plans.get(ev.session.plan.id) && setPlanStatus(V.plans.get(ev.session.plan.id), ev.session.plan.status);
        break;
      case 'run_end':
        endStreaming();
        V.assistant = null;
        V.thinking = null;
        // Rows that never got a result were cut off with the run.
        for (const row of V.tools.values()) setToolState(row, 'Interrupted', false);
        V.tools.clear();
        if (ev.reason === 'aborted') append(note('Stopped'));
        else if (ev.reason === 'max_turns') append(note('Stopped after the maximum number of steps'));
        setRunning(false);
        break;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Sessions, the top bar and the sheet
  // ---------------------------------------------------------------------------------------------------------------

  const currentMeta = () => S.sessions.find((s) => s.id === S.current) || (S.localMeta && S.localMeta.id === S.current ? S.localMeta : null);

  function stateOf(meta) {
    const st = (meta && meta.status) || {};
    if (st.attention) return 'waiting';
    if (st.running) return 'running';
    return 'idle';
  }
  const STATE_LABEL = { waiting: 'Waiting for you', running: 'Running', idle: 'Idle' };

  function upsertSession(meta) {
    const i = S.sessions.findIndex((s) => s.id === meta.id);
    if (i >= 0) S.sessions[i] = { ...S.sessions[i], ...meta };
    else if (S.localMeta && S.localMeta.id === meta.id) S.localMeta = { ...S.localMeta, ...meta };
    renderTop();
    if (!el.sheet.hidden) renderSheet();
  }

  function onSessions(list) {
    S.sessions = list;
    if (S.localMeta && list.some((s) => s.id === S.localMeta.id)) S.localMeta = null;
    const meta = currentMeta();
    if (meta && meta.status) setRunning(!!meta.status.running);
    renderTop();
    if (!el.sheet.hidden) renderSheet();
  }

  function markEl(state) {
    const m = h('span', 'mark ' + state);
    m.setAttribute('role', 'img');
    m.setAttribute('aria-label', STATE_LABEL[state]);
    return m;
  }

  function renderTop() {
    const meta = currentMeta();
    el.title.textContent = meta ? meta.title : S.current ? 'Session' : 'OpenAgent';
    document.title = meta ? `${meta.title} · OpenAgent` : 'OpenAgent';
    let state = stateOf(meta);
    if (state === 'idle' && S.running) state = 'running';
    el.mark.className = 'mark ' + state;
    el.mark.setAttribute('aria-label', STATE_LABEL[state]);
    el.statusText.innerHTML = state === 'running' ? '<span class="spinner sm"></span>Working…' : state === 'waiting' ? 'Waiting for you' : '';
  }

  function renderSheet() {
    el.list.textContent = '';
    const list = [...S.sessions];
    if (S.localMeta && !list.some((s) => s.id === S.localMeta.id)) list.unshift(S.localMeta);
    if (!list.length) el.list.append(h('li', 'session-empty', 'No sessions yet.'));
    for (const s of list) {
      const li = h('li');
      const b = h('button');
      b.type = 'button';
      if (s.id === S.current) b.setAttribute('aria-current', 'true');
      const state = stateOf(s);
      b.append(markEl(state));
      const main = h('span', 's-main');
      const title = h('span', 's-title');
      title.textContent = s.title;
      const sub = h('span', 's-sub', state === 'idle' ? esc(ago(s.updatedAt)) : `<span class="${state}">${STATE_LABEL[state]}</span>`);
      main.append(title, sub);
      b.append(main);
      if (s.id === S.foreground) b.append(h('span', 'badge', 'On Mac'));
      b.addEventListener('click', () => {
        closeSheet();
        switchTo(s.id);
      });
      li.append(b);
      el.list.append(li);
    }
  }

  let lastFocus = null;
  function openSheet() {
    lastFocus = document.activeElement;
    renderSheet();
    el.sheet.hidden = false;
    el.sheet.querySelector('.sheet-head .icon-btn').focus({ preventScroll: true });
  }
  function closeSheet() {
    el.sheet.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  function switchTo(id) {
    if (id === S.current) return;
    S.current = id;
    try {
      history.replaceState(null, '', '#' + id);
    } catch {
      /* not essential */
    }
    renderTasks((currentMeta() && currentMeta().tasks) || []);
    renderTop();
    loadTranscript();
  }

  async function newSession() {
    try {
      const meta = await api('new', {});
      S.localMeta = meta;
      closeSheet();
      switchTo(meta.id);
      el.input.focus();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------------------------------------------------

  function setRunning(running) {
    S.running = running;
    el.stop.hidden = !running;
    el.send.setAttribute('aria-label', running ? 'Queue message' : 'Send');
    renderTop();
  }

  function setInput(text) {
    el.input.value = text;
    grow();
    updateSend();
  }

  function grow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 168) + 'px';
  }
  const updateSend = () => (el.send.disabled = S.dead || !el.input.value.trim());

  function renderQueue() {
    el.queue.textContent = '';
    for (const q of S.queue) {
      const row = h('div', 'queued', '<span class="tag">Queued</span>');
      const t = h('span', 'text');
      t.textContent = q.text;
      row.append(t);
      el.queue.append(row);
    }
    el.queue.hidden = !S.queue.length;
  }

  function renderTasks(tasks) {
    if (!tasks || !tasks.length) {
      el.tasks.hidden = true;
      el.tasks.textContent = '';
      return;
    }
    const open = el.tasks.querySelector('details')?.open ?? false;
    const done = tasks.filter((t) => t.status === 'completed').length;
    const now = tasks.find((t) => t.status === 'in_progress');
    const d = h('details');
    d.open = open;
    d.innerHTML = `<summary>${icon('list', 15)}<span>${esc(now ? short(now.title, 48) : 'Tasks')}</span><span class="count">${done}/${tasks.length}</span></summary>`;
    const ul = h('ul');
    for (const t of tasks) {
      const li = h('li', t.status, '<span class="box"></span>');
      li.append(document.createTextNode(t.title));
      ul.append(li);
    }
    d.append(ul);
    el.tasks.textContent = '';
    el.tasks.append(d);
    el.tasks.hidden = false;
  }

  async function send() {
    const text = el.input.value.trim();
    if (!text || S.dead) return;
    el.send.disabled = true;
    try {
      if (!S.current) {
        const meta = await api('new', {});
        S.localMeta = meta;
        switchTo(meta.id);
      }
      setInput('');
      const res = await api('send', { session: S.current, text });
      if (!res.ok) {
        setInput(text);
        toast(res.error || 'Could not send.');
      } else if (res.queued) {
        S.queue.push({ id: res.id, text });
        renderQueue();
      }
    } catch (err) {
      if (!el.input.value) setInput(text);
      toast(err.message);
    } finally {
      updateSend();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The event stream, with backoff and a fresh snapshot after every reconnect
  // ---------------------------------------------------------------------------------------------------------------

  let es = null;
  let backoff = 1000;
  let retryTimer = 0;
  let connTimer = 0;

  function showConn(on) {
    clearTimeout(connTimer);
    // Quiet: a blip shorter than a second and a half is not worth a banner.
    if (on) connTimer = setTimeout(() => (el.conn.hidden = false), 1500);
    else el.conn.hidden = true;
  }

  function connect() {
    clearTimeout(retryTimer);
    if (es) es.close();
    if (S.dead) return;
    es = new EventSource('api/events');
    es.addEventListener('open', () => {
      backoff = 1000;
      showConn(false);
      refresh();
    });
    es.addEventListener('agent', (e) => onAgent(JSON.parse(e.data)));
    es.addEventListener('sessions', (e) => onSessions(JSON.parse(e.data)));
    es.addEventListener('error', () => {
      es.close();
      es = null;
      showConn(true);
      // Find out whether the link itself died (new link on the Mac) before trying again.
      api('state').catch(() => {});
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    });
  }

  /** Every (re)connect: the state, then a snapshot of the shown session; the stream is already open by now. */
  async function refresh() {
    try {
      const st = await api('state');
      S.sessions = st.sessions;
      S.foreground = st.foreground;
      // "@anthropic/claude-sonnet-5" → "claude-sonnet-5": the gateway prefix costs width and says little on a phone.
      el.model.textContent = String(st.model || '').replace(/^@[^/]+\//, '');
      el.model.title = st.model || '';
      if (!S.current || (!st.sessions.some((s) => s.id === S.current) && !(S.localMeta && S.localMeta.id === S.current))) {
        const fromHash = decodeURIComponent(location.hash.slice(1));
        S.current = (fromHash && st.sessions.some((s) => s.id === fromHash) && fromHash) || st.foreground || (st.sessions[0] && st.sessions[0].id) || '';
      }
      renderTasks((currentMeta() && currentMeta().tasks) || []);
      renderTop();
      await loadTranscript();
    } catch (err) {
      if (!S.dead) toast(err.message);
    }
  }

  function linkDead() {
    if (S.dead) return;
    S.dead = true;
    if (es) es.close();
    clearTimeout(retryTimer);
    showConn(false);
    el.transcript.textContent = '';
    el.transcript.append(h('div', 'empty', '<strong>This link no longer works</strong>Open the current link from OpenAgent on your Mac.'));
    el.title.textContent = 'OpenAgent';
    el.mark.hidden = true;
    el.model.hidden = true;
    $('open-sessions').hidden = true;
    closeSheet();
    document.querySelector('.composer-wrap').hidden = true;
    updateSend();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------------------------------------------

  $('open-sessions').addEventListener('click', openSheet);
  $('new-session').addEventListener('click', newSession);
  el.sheet.addEventListener('click', (e) => e.target.closest('[data-close]') && closeSheet());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !el.sheet.hidden && closeSheet());
  el.send.addEventListener('click', send);
  el.stop.addEventListener('click', () => S.current && api('stop', { session: S.current }).catch((err) => toast(err.message)));
  el.input.addEventListener('input', () => {
    grow();
    updateSend();
  });
  // Enter sends with a real keyboard; on a phone it is a new line and the button sends.
  const fineKeyboard = window.matchMedia('(hover: hover) and (pointer: fine)');
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && fineKeyboard.matches) {
      e.preventDefault();
      send();
    }
  });
  // A phone that slept drops the connection without telling the page.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !S.dead && (!es || es.readyState === EventSource.CLOSED)) connect();
  });
  window.addEventListener('pageshow', (e) => e.persisted && connect());

  updateSend();
  connect();
})();
