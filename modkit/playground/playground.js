/*
 * The playground page: lists the mods the server found, mounts the selected mod's views in mock seats, wires them to
 * PlaygroundHost, and offers controls that change the fixture world and emit the events.
 * URL parameters: ?mod=<id>|all &state=empty|busy|full &scheme=light|dark &model=ok|slow|hold|nokey|unreachable
 *   &shot=1 (only the rail, or the tab pane for a mod with tab views and no rail view, for shot.js) &pane=<px> (tab width)
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var SHOT = params.has('shot');
  var store = {
    get: function (k) { try { return localStorage.getItem('pg.' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('pg.' + k, v); } catch (e) { /* private mode */ } },
  };

  var state = {
    mods: [],
    modsDir: '',
    kitRev: '',
    selected: params.get('mod') || store.get('mod') || 'all',
    fixture: params.get('state') || store.get('state') || 'full',
    scheme: params.get('scheme') || store.get('scheme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    collapsed: {},
    log: [],
    frames: {}, // view key → { iframe, section, rec }
    activeTab: params.get('tab') || 'browser',
    modelMode: params.get('model') || store.get('model') || 'ok',
    pane: Number(params.get('pane')) || Number(store.get('pane')) || 0,
    streaming: null,
  };

  // Shot and verification hooks (read by shot.js)
  var pg = (window.__pg = { ready: false, errors: [], denied: [], requests: 0, lastTraffic: Date.now(), timedOut: false });

  if (SHOT) { document.body.classList.add('shot'); document.documentElement.classList.add('shot'); }

  // ---------- theme ----------

  var TOKEN_NAMES = (function () {
    var names = {};
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      var rules;
      try { rules = sheet.cssRules; } catch (e) { return; }
      var walk = function (list) {
        Array.prototype.forEach.call(list, function (r) {
          if (r.cssRules && !r.style) walk(r.cssRules);
          if (!r.style || !/:root/.test(r.selectorText || '')) return;
          for (var i = 0; i < r.style.length; i++) {
            var n = r.style[i];
            if (n.indexOf('--') === 0 && n.indexOf('--h-') !== 0 && n.indexOf('--pg-') !== 0) names[n] = true;
          }
        });
      };
      walk(rules);
    });
    return Object.keys(names);
  })();

  function theme() {
    var cs = getComputedStyle(document.documentElement);
    var tokens = {};
    TOKEN_NAMES.forEach(function (n) { tokens[n] = cs.getPropertyValue(n).trim(); });
    return { scheme: state.scheme, tokens: tokens };
  }

  function setScheme(s) {
    state.scheme = s;
    store.set('scheme', s);
    document.documentElement.setAttribute('data-theme', s);
    if (host) host.emit('theme.changed', theme());
    renderSegs();
  }
  document.documentElement.setAttribute('data-theme', state.scheme);

  // ---------- the host ----------

  function buildWorld(name) {
    var w = PlaygroundFixture.build(name);
    w.model.mode = state.modelMode;
    return w;
  }

  var host = new PlaygroundHost({
    world: buildWorld(state.fixture),
    ui: {
      theme: theme,
      setScheme: setScheme,
      log: addLog,
      resize: function (view, h) {
        var f = state.frames[view.key];
        if (!f) return;
        f.resized = true;
        var seat = view.view.seat;
        var max = seat === 'rail' ? (view.view.maxHeight || 360) : seat === 'composer' ? 120 : Infinity;
        if (seat === 'rail' || seat === 'composer') f.iframe.style.height = Math.min(Math.max(0, h), max) + 'px';
      },
      setTitle: function (view, t) { var f = state.frames[view.key]; if (f && f.title) f.title.textContent = t; if (f && f.tab) f.tab.textContent = t; },
      setBadge: function (view, b) { var f = state.frames[view.key]; if (f && f.badge) f.badge.textContent = b === null || b === '' ? '' : String(b); },
      toast: toast,
      openView: function (view, vid) {
        var f = state.frames[view.modId + '/' + vid];
        if (!f) return;
        if (f.section) { setCollapsed(f, false); f.section.classList.remove('flash'); void f.section.offsetWidth; f.section.classList.add('flash'); f.section.scrollIntoView({ block: 'nearest' }); }
        if (f.tab) selectTab(view.modId + '/' + vid);
      },
      copy: function (text) {
        try { navigator.clipboard.writeText(text).catch(function () {}); } catch (e) { /* not allowed */ }
        toast('Copied: ' + (text.length > 60 ? text.slice(0, 60) + '…' : text));
        return true;
      },
      composerInsert: function (text) { var t = $('composer-text'); if (t) { t.value += text; t.focus(); } },
      pageError: function (view, err) {
        pg.errors.push({ view: view.key, message: err.message, stack: err.stack });
        renderProblems();
        if (!SHOT) toast(view.key + ': ' + err.message, 'error');
      },
      worldChanged: function () { if (!SHOT) renderWorld(); },
      streaming: function (text) { state.streaming = text; if (!SHOT) renderTranscript(); },
    },
  });

  window.addEventListener('message', function (e) {
    if (!e.source || e.source === window) return;
    host.receive(e.source, e.data);
  });

  // ---------- log ----------

  function short(v) {
    if (v === undefined) return '';
    var s;
    try { s = JSON.stringify(v); } catch (e) { s = String(v); }
    return s && s.length > 300 ? s.slice(0, 300) + '…' : s;
  }

  function addLog(entry) {
    pg.lastTraffic = Date.now();
    if (entry.kind === 'request') pg.requests++;
    if (entry.kind === 'error' && entry.payload && entry.payload.code === 4003) pg.denied.push({ view: entry.view, method: entry.method, permission: entry.payload.data && entry.payload.data.permission });
    if (SHOT) return;
    state.log.push(entry);
    if (state.log.length > 1500) state.log.splice(0, 500);
    if (passes(entry)) appendLogRow(entry);
    renderLogStats();
  }

  function passes(e) {
    var f = $('log-filter').value;
    if (f && e.view !== f) return false;
    if (!$('log-deltas').checked && (e.method === 'message.delta' || e.method === 'model.delta')) return false;
    return true;
  }

  function appendLogRow(e) {
    var body = $('log');
    var stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
    var row = document.createElement('div');
    row.className = 'pg-log-row' + (e.kind === 'error' ? ' error' : '');
    var arrow = e.kind === 'request' ? '→' : e.kind === 'event' ? '⚡' : '←';
    var t = new Date(e.t);
    var time = t.toTimeString().slice(0, 8);
    [time, e.view, arrow, (e.id !== undefined ? '#' + e.id + ' ' : '') + e.method, short(e.payload)].forEach(function (text, i) {
      var s = document.createElement('span');
      s.textContent = text;
      s.className = ['time', 'who', 'k-' + e.kind, 'method k-' + e.kind, 'payload'][i];
      if (i === 4) s.title = text;
      row.appendChild(s);
    });
    body.appendChild(row);
    while (body.childNodes.length > 800) body.removeChild(body.firstChild);
    if (stick) body.scrollTop = body.scrollHeight;
  }

  function renderLog() {
    var body = $('log');
    body.textContent = '';
    state.log.filter(passes).slice(-600).forEach(appendLogRow);
    renderLogStats();
  }

  function renderLogStats() {
    var errs = state.log.filter(function (e) { return e.kind === 'error'; }).length;
    $('log-stats').textContent = pg.requests + ' requests · ' + errs + ' errors · ' + pg.denied.length + ' denied · ' + pg.errors.length + ' page errors';
  }

  // ---------- toasts ----------

  function toast(text, kind) {
    if (SHOT) return;
    var el = document.createElement('div');
    el.className = 'pg-toast' + (kind === 'error' ? ' error' : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }

  // ---------- mods ----------

  function loadMods() {
    return fetch('/api/mods', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (data) {
      state.mods = data.mods;
      state.modsDir = data.modsDir;
      state.kitRev = data.kitRev;
      data.mods.forEach(function (m) { if (m.valid) host.addMod(m.manifest, m.settings); });
      if (state.selected !== 'all' && !data.mods.some(function (m) { return m.folder === state.selected; })) state.selected = 'all';
    });
  }

  function selectedMods() {
    return state.mods.filter(function (m) { return m.valid && (state.selected === 'all' || m.folder === state.selected); });
  }

  function viewsOf(m) { return (m.manifest.contributes && m.manifest.contributes.views) || []; }

  // ---------- seats ----------

  function makeFrame(m, v) {
    var iframe = document.createElement('iframe');
    iframe.className = 'pg-frame';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
    iframe.setAttribute('title', m.manifest.name + ': ' + v.title);
    iframe.src = '/mods/' + encodeURIComponent(m.folder) + '/' + v.entry.split('/').map(encodeURIComponent).join('/') + '?rev=' + encodeURIComponent(m.rev + '-' + state.kitRev);
    return iframe;
  }

  function attach(m, v, iframe, extra) {
    var key = m.manifest.id + '/' + v.id;
    var rec = { key: key, modId: m.manifest.id, view: v, win: iframe.contentWindow };
    host.attach(rec);
    rec = host.views[host.views.length - 1];
    state.frames[key] = Object.assign({ iframe: iframe, rec: rec }, extra || {});
    return state.frames[key];
  }

  function setCollapsed(f, on) {
    if (!f.section) return;
    state.collapsed[f.rec.key] = on;
    f.section.classList.toggle('collapsed', on);
    f.head.setAttribute('aria-expanded', String(!on));
    f.rec.visible = !on;
    host.emitTo(f.rec, 'visibility.changed', { visible: !on });
  }

  function mount() {
    host.detachAll();
    state.frames = {};
    pg.ready = false;
    pg.mountedAt = Date.now();
    ['seat-rail', 'seat-composer', 'seat-tab', 'seat-background', 'tabs'].forEach(function (id) { $(id).textContent = ''; });
    document.body.classList.remove('has-bg');

    var mods = selectedMods();
    var rail = [];
    var tabs = [];
    var bg = null;
    mods.forEach(function (m) {
      viewsOf(m).forEach(function (v) {
        if (v.seat === 'rail') rail.push({ m: m, v: v });
        else if (v.seat === 'tab') tabs.push({ m: m, v: v });
        else if (v.seat === 'composer' && !SHOT) mountComposer(m, v);
        else if (v.seat === 'background' && !bg) bg = { m: m, v: v };
      });
    });

    rail.sort(function (a, b) { return (a.v.order === undefined ? 100 : a.v.order) - (b.v.order === undefined ? 100 : b.v.order); });
    rail.forEach(function (x) { mountRail(x.m, x.v); });
    var mainEl = document.querySelector('.pg-main');
    mainEl.classList.toggle('no-rail', !SHOT && !rail.length && !!tabs.length);
    applyPane();

    // shot.js and a mod whose only views are tabs: the side pane alone, filling the window
    document.body.classList.toggle('shot-tab', SHOT && !rail.length && !!tabs.length);
    if (SHOT && !rail.length && tabs.length) {
      var pick = tabs.filter(function (x) { return x.m.manifest.id + '/' + x.v.id === state.activeTab || x.v.id === state.activeTab; })[0] || tabs[0];
      mountTab(pick.m, pick.v);
      selectTab(pick.m.manifest.id + '/' + pick.v.id);
    }

    if (!SHOT) {
      var browserTab = document.createElement('button');
      browserTab.className = 'pg-tab';
      browserTab.textContent = 'Browser';
      browserTab.dataset.key = 'browser';
      browserTab.onclick = function () { selectTab('browser'); };
      $('tabs').appendChild(browserTab);
      var browser = document.createElement('div');
      browser.className = 'pg-browser';
      browser.dataset.key = 'browser';
      browser.textContent = 'The built-in browser renders here. Tab views of the selected mod appear as tabs next to it.';
      $('seat-tab').appendChild(browser);
      tabs.forEach(function (x) { mountTab(x.m, x.v); });
      if (!state.frames[state.activeTab]) state.activeTab = 'browser';
      selectTab(state.activeTab);
      if (bg) {
        var bif = makeFrame(bg.m, bg.v);
        $('seat-background').appendChild(bif);
        attach(bg.m, bg.v, bif);
        document.body.classList.add('has-bg');
      }
    }
    renderPanels();
  }

  function mountRail(m, v) {
    var key = m.manifest.id + '/' + v.id;
    var section = document.createElement('section');
    section.className = 'pg-section';
    var head = document.createElement('button');
    head.className = 'pg-section-head';
    head.setAttribute('aria-expanded', 'true');
    var title = document.createElement('span');
    title.className = 'pg-section-title';
    title.textContent = v.title;
    var badge = document.createElement('span');
    badge.className = 'pg-badge';
    var chev = document.createElement('span');
    chev.className = 'pg-chev';
    chev.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.75 6.25L8 10.5l4.25-4.25"/></svg>';
    head.append(title, badge, chev);
    section.appendChild(head);
    var iframe = makeFrame(m, v);
    section.appendChild(iframe);
    $('seat-rail').appendChild(section);
    var f = attach(m, v, iframe, { section: section, head: head, title: title, badge: badge });
    head.onclick = function () { setCollapsed(f, !section.classList.contains('collapsed')); };
    if (state.collapsed[key]) { section.classList.add('collapsed'); head.setAttribute('aria-expanded', 'false'); f.rec.visible = false; }
  }

  function mountComposer(m, v) {
    var iframe = makeFrame(m, v);
    $('seat-composer').appendChild(iframe);
    attach(m, v, iframe);
  }

  function mountTab(m, v) {
    var key = m.manifest.id + '/' + v.id;
    var tab = document.createElement('button');
    tab.className = 'pg-tab';
    tab.textContent = v.title;
    tab.dataset.key = key;
    tab.onclick = function () { selectTab(key); };
    $('tabs').appendChild(tab);
    var iframe = makeFrame(m, v);
    iframe.dataset.key = key;
    $('seat-tab').appendChild(iframe);
    attach(m, v, iframe, { tab: tab });
  }

  function selectTab(key) {
    state.activeTab = key;
    Array.prototype.forEach.call($('tabs').children, function (t) { t.setAttribute('aria-selected', String(t.dataset.key === key)); });
    Array.prototype.forEach.call($('seat-tab').children, function (c) {
      var on = c.dataset.key === key;
      c.style.display = on ? '' : 'none';
      var f = state.frames[c.dataset.key];
      if (f && f.rec.visible !== on) { f.rec.visible = on; host.emitTo(f.rec, 'visibility.changed', { visible: on }); }
    });
  }

  /** The side pane's width in the mock window (0: the grid decides). */
  function applyPane() {
    var main = document.querySelector('.pg-main');
    if (!main || SHOT) return;
    var rail = main.classList.contains('no-rail') ? '0' : '300px';
    main.style.gridTemplateColumns = state.pane ? 'minmax(320px, 1fr) ' + rail + ' ' + state.pane + 'px' : '';
  }

  // ---------- side panels ----------

  function seg(el, options, value, onPick) {
    el.textContent = '';
    options.forEach(function (o) {
      var b = document.createElement('button');
      b.textContent = o[1];
      b.setAttribute('aria-pressed', String(o[0] === value));
      b.onclick = function () { onPick(o[0]); };
      el.appendChild(b);
    });
  }

  function renderSegs() {
    if (SHOT) return;
    seg($('state-seg'), [['empty', 'Empty'], ['busy', 'Busy'], ['full', 'Full']], state.fixture, function (s) {
      state.fixture = s;
      store.set('state', s);
      host.stopRun('switched');
      host.world = buildWorld(s);
      renderSegs();
      renderWorld();
      mount();
    });
    seg($('scheme-seg'), [['light', 'Light'], ['dark', 'Dark']], state.scheme, setScheme);
    seg($('model-seg'), [['ok', 'Works'], ['slow', 'Slow'], ['hold', 'Hangs'], ['nokey', 'No key'], ['unreachable', 'Down']], state.modelMode, function (m) {
      state.modelMode = m;
      store.set('model', m);
      host.world.model = { mode: m };
      renderSegs();
    });
    seg($('pane-seg'), [[0, 'Auto'], [420, '420'], [640, '640'], [900, '900']], state.pane, function (px) {
      state.pane = px;
      store.set('pane', String(px));
      applyPane();
      renderSegs();
    });
  }

  function renderModList() {
    var list = $('mod-list');
    list.textContent = '';
    var add = function (key, name, meta, problems) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.className = 'pg-mod';
      b.setAttribute('aria-current', String(state.selected === key));
      var n = document.createElement('span');
      n.className = 'pg-mod-name';
      n.textContent = name;
      b.appendChild(n);
      if (problems && problems.length) {
        var dot = document.createElement('span');
        dot.className = 'pg-mod-bad' + (problems.some(function (p) { return p.level === 'error'; }) ? '' : ' pg-mod-warn');
        dot.title = problems.map(function (p) { return p.message; }).join('\n');
        b.appendChild(dot);
      }
      var mt = document.createElement('span');
      mt.className = 'pg-mod-meta';
      mt.textContent = meta;
      b.appendChild(mt);
      b.onclick = function () { state.selected = key; store.set('mod', key); renderModList(); mount(); };
      li.appendChild(b);
      list.appendChild(li);
    };
    add('all', 'All mods', state.mods.filter(function (m) { return m.valid; }).length + ' on');
    state.mods.forEach(function (m) {
      add(m.folder, (m.manifest && m.manifest.name) || m.folder, m.manifest && m.manifest.version ? 'v' + m.manifest.version : 'invalid', m.problems);
    });
    $('mods-dir').textContent = state.modsDir;
    $('mods-dir').title = state.modsDir;
  }

  function renderProblems() {
    if (SHOT) return;
    var box = $('problems');
    box.textContent = '';
    var mods = state.selected === 'all' ? state.mods : state.mods.filter(function (m) { return m.folder === state.selected; });
    mods.forEach(function (m) {
      m.problems.forEach(function (p) {
        var d = document.createElement('div');
        d.className = 'pg-problem ' + p.level;
        d.textContent = (state.selected === 'all' ? m.folder + ': ' : '') + p.message;
        box.appendChild(d);
      });
    });
    pg.errors.forEach(function (e) {
      if (state.selected !== 'all' && e.view.split('/')[0] !== state.selected) return;
      var d = document.createElement('div');
      d.className = 'pg-problem runtime';
      d.textContent = e.view + ': ' + e.message;
      d.title = e.stack || '';
      box.appendChild(d);
    });
  }

  function currentMod() {
    if (state.selected === 'all') return null;
    var m = state.mods.filter(function (x) { return x.folder === state.selected && x.valid; })[0];
    return m ? host.mods[m.manifest.id] : null;
  }

  function renderPanels() {
    if (SHOT) return;
    renderProblems();
    var mod = currentMod();
    $('settings-block').hidden = !mod;
    $('perms-block').hidden = !mod;
    var filter = $('log-filter');
    var keep = filter.value;
    filter.innerHTML = '<option value="">All views</option>';
    Object.keys(state.frames).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k; filter.appendChild(o); });
    filter.value = state.frames[keep] ? keep : '';
    if (!mod) return;

    var form = $('settings-form');
    form.textContent = '';
    var fields = (mod.manifest.contributes && mod.manifest.contributes.settings) || [];
    fields.forEach(function (s) {
      var label = document.createElement('label');
      var span = document.createElement('span');
      span.textContent = s.title;
      label.appendChild(span);
      var input;
      if (s.type === 'boolean') { input = document.createElement('input'); input.type = 'checkbox'; input.className = 'h-switch'; input.checked = !!mod.settings[s.key]; }
      else if (s.type === 'select') { input = document.createElement('select'); input.className = 'h-input'; s.options.forEach(function (o) { var op = document.createElement('option'); op.textContent = o; input.appendChild(op); }); input.value = mod.settings[s.key]; }
      else { input = document.createElement('input'); input.className = 'h-input'; input.type = s.type === 'number' ? 'number' : 'text'; input.value = mod.settings[s.key]; ['min', 'max', 'step'].forEach(function (k) { if (s[k] !== undefined) input[k] = s[k]; }); }
      input.onchange = function () {
        mod.settings[s.key] = s.type === 'boolean' ? input.checked : s.type === 'number' ? Number(input.value) : input.value;
        host.emit('settings.changed', mod.settings, mod.manifest.id);
      };
      label.appendChild(input);
      form.appendChild(label);
    });

    var perms = $('perms');
    perms.textContent = '';
    var asked = mod.manifest.permissions || [];
    ModValidate.PERMISSIONS.forEach(function (p) {
      var label = document.createElement('label');
      if (asked.indexOf(p) >= 0) { label.className = 'asked'; label.title = 'Asked for in mod.json'; }
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = mod.granted.indexOf(p) >= 0;
      cb.onchange = function () {
        mod.granted = cb.checked ? mod.granted.concat([p]) : mod.granted.filter(function (x) { return x !== p; });
        toast((cb.checked ? 'Granted ' : 'Revoked ') + p + '; views reload');
        mount();
      };
      label.append(cb, document.createTextNode(p));
      perms.appendChild(label);
    });
  }

  // ---------- the chat ----------

  function renderTranscript() {
    var box = $('transcript');
    var cur = host.cur();
    box.textContent = '';
    cur.transcript.forEach(function (i) {
      var d = document.createElement('div');
      if (i.role === 'user' || i.role === 'assistant') { d.className = 'pg-msg ' + i.role; d.textContent = i.text; }
      else {
        d.className = 'pg-msg meta';
        d.textContent = i.role === 'tool' ? '⚙ ' + i.name + ' ' + (i.args || '') + (i.ok === false ? ' · failed' : ' · ' + i.text)
          : i.role === 'plan' ? '▤ Plan proposed' : i.role === 'artifact' ? '◆ Artifact: ' + i.text : i.role === 'image' ? '▣ Image: ' + i.text : '— Compacted: ' + i.text;
      }
      box.appendChild(d);
    });
    if (state.streaming) {
      var s = document.createElement('div');
      s.className = 'pg-msg assistant streaming';
      s.textContent = state.streaming;
      box.appendChild(s);
    }
    if (!box.childNodes.length) { var e = document.createElement('div'); e.className = 'pg-msg meta'; e.textContent = 'No messages yet.'; box.appendChild(e); }
    box.scrollTop = box.scrollHeight;
  }

  var MODES = { ask: 'Ask before actions', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan', bypass: 'Bypass permissions' };
  function renderWorld() {
    var w = host.world;
    var cur = host.cur();
    $('session-title').textContent = cur.session.title + (cur.session.running ? ' · running' : '');
    $('session-cwd').textContent = cur.session.cwd;
    $('mode-chip').textContent = MODES[w.config.permissionMode] || w.config.permissionMode;
    $('model-chip').textContent = w.config.model;
    renderTranscript();
    var ta = $('tasks-edit');
    if (document.activeElement !== ta) ta.value = cur.tasks.map(function (t) { return (t.status === 'completed' ? '[x] ' : t.status === 'in_progress' ? '[~] ' : '[ ] ') + t.title; }).join('\n');
    var wj = $('world-json');
    if (document.activeElement !== wj && wj.closest('details').open) wj.value = JSON.stringify(w, null, 1);
  }

  // ---------- controls ----------

  var outputN = 0;
  var PLANS = [
    { title: 'Add a keyboard shortcut for the rail', markdown: '## Goal\nToggle the right-hand rail with **⌘⌥R**.\n\n## Steps\n1. Register the accelerator in `src/main/menu.ts`.\n2. Send `rail:toggle` to the window.\n3. Persist `railOpen` in the layout.\n\n## Verification\n- Press it twice; the rail closes and opens.' },
  ];

  function wire() {
    $('act-run').onclick = function () { host.simulateRun(); };
    $('act-stop').onclick = function () { host.stopRun('stopped'); };
    $('act-plan').onclick = function () {
      var p = PLANS[0];
      host.setPlan({ id: 'p' + Date.now(), title: p.title, markdown: p.markdown, status: 'proposed', createdAt: Date.now() });
      host.cur().transcript.push({ role: 'plan', text: p.markdown });
      renderWorld();
    };
    $('act-approve').onclick = function () {
      var plan = host.cur().plan;
      if (!plan) return toast('No plan to approve', 'error');
      plan.status = plan.status === 'approved' ? 'rejected' : 'approved';
      host.setPlan(plan);
      toast('Plan ' + (plan.status === 'approved' ? 'approved' : 'not approved'));
    };
    $('act-output').onclick = function () {
      var kinds = [
        { kind: 'artifact', title: 'Release checklist', detail: 'HTML · v1' },
        { kind: 'image', title: 'screenshot-' + (outputN + 1) + '.png', detail: 'PNG · 1280×800' },
        { kind: 'file', title: 'src/renderer/rail.ts', detail: '+48 −7' },
      ];
      var o = kinds[outputN++ % 3];
      host.addOutput({ kind: o.kind, id: o.kind === 'file' ? o.title + '#' + outputN : 'o' + Date.now(), title: o.title, detail: o.detail, updatedAt: Date.now() });
    };
    $('act-switch').onclick = function () { host.switchTo(host.world.currentId === 's-main' ? 's-other' : 's-main'); };
    $('act-related').onclick = function () {
      // The first related session that is going finishes; if none is, the first finished one starts again
      var rel = host.related();
      var all = rel.children.concat(rel.forks);
      if (!all.length) return toast('This session has no sub-sessions or forks', 'error');
      var going = all.filter(function (s) { return s.running || s.attention; })[0];
      if (going) host.setRelatedState(going.id, { running: false, attention: null });
      else host.setRelatedState(all[0].id, { running: true });
      toast((going ? 'Finished: ' : 'Started: ') + (going || all[0]).title);
    };
    var fireN = 0;
    $('act-fire').onclick = function () {
      var list = host.world.schedules.filter(function (x) { return x.lastStatus !== 'running'; });
      if (!list.length) return toast('No schedule to fire', 'error');
      var outcomes = ['ok', 'error', 'skipped', 'missed', 'stopped'];
      var o = outcomes[fireN++ % outcomes.length];
      host.fireSchedule(list[0], o);
      toast('Fired "' + list[0].name + '" → ' + o);
    };
    $('act-skill').onclick = function () {
      var sk = host.world.skills;
      if (!sk.length) return toast('No skills in this fixture', 'error');
      host.useSkill(sk[Math.floor(Math.random() * sk.length)].name);
    };
    $('act-device').onclick = function () {
      var r = host.world.remote;
      if (!r.running) return toast('Remote control is off', 'error');
      r.clients++;
      host.emit('remote.changed', r);
    };
    $('act-command').onclick = function () {
      var mod = currentMod();
      var cmds = mod && mod.manifest.contributes && mod.manifest.contributes.commands;
      if (!cmds || !cmds.length) return toast('This mod has no commands', 'error');
      host.emit('command', { name: cmds[0].name, args: 'from the playground' }, mod.manifest.id);
    };
    $('act-reload').onclick = function () { mount(); };
    $('tasks-apply').onclick = function () {
      var tasks = $('tasks-edit').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (l, i) {
        var m = l.match(/^\[(.)\]\s*(.*)$/);
        var mark = m ? m[1] : ' ';
        return { id: 'e' + i, title: m ? m[2] : l, status: /x/i.test(mark) ? 'completed' : /[~>\-*]/.test(mark) ? 'in_progress' : 'pending' };
      });
      host.setTasks(tasks);
    };
    $('tasks-clear').onclick = function () { $('tasks-edit').value = ''; host.setTasks([]); };
    $('world-apply').onclick = function () {
      try { host.world = JSON.parse($('world-json').value); } catch (e) { return toast('Not JSON: ' + e.message, 'error'); }
      renderWorld();
      mount();
    };
    $('world-json').closest('details').addEventListener('toggle', renderWorld);
    $('composer-send').onclick = function () {
      var t = $('composer-text').value.trim();
      if (!t) return;
      $('composer-text').value = '';
      host.simulateRun(t);
    };
    $('log-toggle').onclick = function () {
      var on = $('log-panel').classList.toggle('collapsed');
      $('log-toggle').setAttribute('aria-expanded', String(!on));
    };
    $('log-filter').onchange = renderLog;
    $('log-deltas').onchange = renderLog;
    $('log-clear').onclick = function () { state.log = []; renderLog(); };
  }

  // ---------- live reload ----------

  function poll() {
    fetch('/api/rev', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (rev) {
      var changed = rev.kit !== state.kitRev;
      var listChanged = Object.keys(rev.mods).length !== state.mods.length;
      state.mods.forEach(function (m) { if (rev.mods[m.folder] !== m.rev) { changed = changed || selectedMods().indexOf(m) >= 0 || state.selected === m.folder; listChanged = true; } });
      if (!changed && !listChanged) return;
      return loadMods().then(function () {
        renderModList();
        if (changed) { toast('Files changed; views reloaded'); mount(); } else renderPanels();
      });
    }).catch(function () { /* server gone */ }).then(function () { setTimeout(poll, 1000); });
  }

  // ---------- shot readiness ----------

  function watchReady() {
    var check = function () {
      var keys = Object.keys(state.frames);
      var all = keys.every(function (k) {
        var f = state.frames[k];
        return f.rec.helloAt && (f.rec.view.seat !== 'rail' && f.rec.view.seat !== 'composer' || f.resized);
      });
      var quiet = Date.now() - pg.lastTraffic > 700;
      if (all && quiet) { pg.ready = true; return; }
      if (Date.now() - pg.mountedAt > 10000) { pg.ready = true; pg.timedOut = true; return; }
      setTimeout(check, 100);
    };
    check();
  }

  // ---------- go ----------

  loadMods().then(function () {
    if (!SHOT) { wire(); renderSegs(); renderModList(); renderWorld(); applyPane(); }
    mount();
    if (SHOT) watchReady();
    else poll();
  }, function (e) { document.body.textContent = 'Could not load the mods: ' + e.message; });

  window.__playground = { host: host, state: state, mount: mount, setScheme: setScheme, watchReady: watchReady };
})();
