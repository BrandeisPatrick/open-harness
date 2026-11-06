/*
 * The playground's side of the mod bridge: every ModBridge method (src/shared/mods.ts) on top of the fixture world,
 * with real permission checks. new PlaygroundHost({ world, ui }) — `ui` is the page: theme, toasts, badges, the log.
 */
(function (root) {
  'use strict';

  var ERR = { UNKNOWN: -32601, PARAMS: -32602, PERMISSION: 4003, UNAVAILABLE: 4004, TIMEOUT: 4008, OTHER: 4000 };

  /** Method → the permission it needs (null: always available). docs/mods.md "harness" and "Permissions". */
  var METHOD_PERMS = {
    hello: null, 'events.subscribe': null, 'events.unsubscribe': null, 'log.error': null,
    'ui.theme': null, 'ui.resize': null, 'ui.setTitle': null, 'ui.setBadge': null, 'ui.toast': null, 'ui.open': null,
    'ui.copy': null, 'ui.openExternal': null, 'ui.markdown': null,
    'storage.get': null, 'storage.set': null, 'storage.remove': null, 'storage.keys': null, 'settings.get': null,
    'session.get': 'session:read', 'session.transcript': 'session:read', 'session.tasks': 'session:read', 'session.plan': 'session:read',
    'session.outputs': 'session:read', 'session.context': 'session:read', 'session.related': 'session:read', 'outputs.open': 'session:read',
    'session.send': 'session:send', 'composer.insert': 'session:send',
    'session.stop': 'session:control', 'session.compact': 'session:control', 'sessions.open': 'session:control',
    'sessions.create': 'session:control', 'sessions.spawn': 'session:control', 'sessions.merge': 'session:control',
    'sessions.list': 'sessions:read', 'sessions.search': 'sessions:read',
    'model.complete': 'model', 'model.cancel': 'model',
    'skills.list': 'skills:read', 'skills.usage': 'skills:read',
    'config.get': 'config:read', 'config.set': 'config:write',
    'schedules.list': 'schedules', 'schedules.create': 'schedules', 'schedules.update': 'schedules', 'schedules.remove': 'schedules', 'schedules.runNow': 'schedules',
    'remote.status': 'remote', 'remote.start': 'remote', 'remote.stop': 'remote',
  };

  /** Event → the permission a view needs to receive it. */
  var EVENT_PERMS = {
    'theme.changed': null, 'settings.changed': null, 'visibility.changed': null, command: null, 'session.switched': null,
    'session.changed': 'session:read', 'related.changed': 'session:read', 'run.started': 'session:read', 'run.ended': 'session:read', 'message.user': 'session:read',
    'message.assistant': 'session:read', 'message.delta': 'session:read', 'tool.started': 'session:read', 'tool.ended': 'session:read',
    'tasks.changed': 'session:read', 'plan.changed': 'session:read', 'outputs.changed': 'session:read', 'context.changed': 'session:read',
    'model.delta': 'model', 'skills.used': 'skills:read', 'config.changed': 'config:read', 'schedules.changed': 'schedules', 'remote.changed': 'remote',
  };

  var CONFIG_WRITABLE = ['theme', 'autoCompact', 'compactThreshold', 'keepAwake', 'notifications', 'background'];

  function RpcError(code, message, data) { this.code = code; this.message = message; this.data = data; }
  function fail(code, message, data) { throw new RpcError(code, message, data); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function str(p, k, optional) {
    var v = p && p[k];
    if (v === undefined && optional) return undefined;
    if (typeof v !== 'string') fail(ERR.PARAMS, '"' + k + '" must be a string');
    return v;
  }

  function PlaygroundHost(opts) {
    this.world = opts.world;
    this.ui = opts.ui || {};
    this.mods = {}; // id → { manifest, granted: [], settings: {}, storage: { mod: {}, session: {} } }
    this.views = []; // { key, modId, view, win, subs: {}, visible }
    this.run = null;
    this.models = {};
  }

  PlaygroundHost.prototype.addMod = function (manifest, settings) {
    var prev = this.mods[manifest.id];
    this.mods[manifest.id] = {
      manifest: manifest,
      granted: prev ? prev.granted : (manifest.permissions || []).slice(),
      settings: prev ? Object.assign({}, settings, prev.settings) : Object.assign({}, settings),
      storage: prev ? prev.storage : { mod: {}, session: {} },
    };
  };

  PlaygroundHost.prototype.attach = function (rec) { this.views.push(Object.assign({ subs: {}, visible: true }, rec)); };
  PlaygroundHost.prototype.detach = function (win) { this.views = this.views.filter(function (v) { return v.win !== win; }); };
  PlaygroundHost.prototype.detachAll = function () { this.views = []; };
  PlaygroundHost.prototype.viewFor = function (win) { return this.views.filter(function (v) { return v.win === win; })[0] || null; };

  PlaygroundHost.prototype.cur = function () { return this.world.sessions[this.world.currentId]; };

  PlaygroundHost.prototype.post = function (view, msg) {
    try { view.win.postMessage(msg, '*'); } catch (e) { /* frame gone */ }
  };

  /** A message from a mod frame. */
  PlaygroundHost.prototype.receive = function (win, msg) {
    var view = this.viewFor(win);
    if (!view || !msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || msg.id === undefined) return;
    var self = this;
    this.log(view, 'request', msg.method, msg.params, msg.id);
    var p;
    try { p = Promise.resolve(this.handle(view, msg.method, msg.params || {})); } catch (e) { p = Promise.reject(e); }
    p.then(function (result) {
      var res = { jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result };
      self.log(view, 'response', msg.method, result, msg.id);
      self.post(view, res);
    }, function (e) {
      var error = e instanceof RpcError ? { code: e.code, message: e.message } : { code: ERR.OTHER, message: String((e && e.message) || e) };
      if (e && e.data !== undefined) error.data = e.data;
      self.log(view, 'error', msg.method, error, msg.id);
      self.post(view, { jsonrpc: '2.0', id: msg.id, error: error });
    });
  };

  PlaygroundHost.prototype.log = function (view, kind, method, payload, id) {
    if (this.ui.log) this.ui.log({ t: Date.now(), view: view.key, mod: view.modId, kind: kind, method: method, payload: payload, id: id });
  };

  PlaygroundHost.prototype.granted = function (view, perm) {
    return !perm || this.mods[view.modId].granted.indexOf(perm) >= 0;
  };

  /** Sends an event to every view that subscribed to it and may receive it (only `modId`'s views when given). */
  PlaygroundHost.prototype.emit = function (name, data, modId) {
    var self = this;
    this.views.forEach(function (v) {
      if (modId && v.modId !== modId) return;
      if (!v.subs[name] || !self.granted(v, EVENT_PERMS[name])) return;
      self.log(v, 'event', name, data);
      self.post(v, { jsonrpc: '2.0', method: 'event', params: { name: name, data: clone(data) } });
    });
  };

  /** One view only (visibility.changed, command). */
  PlaygroundHost.prototype.emitTo = function (view, name, data) {
    if (!view.subs[name] || !this.granted(view, EVENT_PERMS[name])) return;
    this.log(view, 'event', name, data);
    this.post(view, { jsonrpc: '2.0', method: 'event', params: { name: name, data: clone(data) } });
  };

  PlaygroundHost.prototype.helloFor = function (view) {
    var mod = this.mods[view.modId];
    return {
      protocol: 1,
      mod: { id: mod.manifest.id, name: mod.manifest.name, version: mod.manifest.version, scope: 'bundled' },
      view: { id: view.view.id, seat: view.view.seat, title: view.view.title },
      app: clone(this.world.app),
      granted: mod.granted.slice(),
      theme: this.ui.theme(),
      settings: clone(mod.settings),
      visible: view.visible !== false,
    };
  };

  // ---------- the world ----------

  PlaygroundHost.prototype.related = function () {
    var w = this.world;
    var s = this.cur().session;
    var list = Object.keys(w.sessions).map(function (k) { return w.sessions[k]; }).filter(function (x) { return !x.merged; });
    var by = function (f) { return list.filter(f).map(function (x) { return clone(x.session); }).sort(function (a, b) { return b.updatedAt - a.updatedAt; }); };
    return {
      parent: s.parentId && w.sessions[s.parentId] ? clone(w.sessions[s.parentId].session) : null,
      children: by(function (x) { return x.session.parentId === s.id && !x.session.forkedFrom; }),
      forks: by(function (x) { return x.session.forkedFrom === s.id; }),
    };
  };

  PlaygroundHost.prototype.sessionChanged = function () { this.emit('session.changed', this.cur().session); };

  PlaygroundHost.prototype.switchTo = function (id) {
    if (!this.world.sessions[id]) return false;
    this.stopRun('switched');
    var changed = this.world.currentId !== id;
    this.world.currentId = id;
    // session.switched needs no permission, so a view without session:read can still reset itself
    if (changed) this.emit('session.switched', { id: id });
    this.sessionChanged();
    if (this.ui.worldChanged) this.ui.worldChanged();
    return true;
  };

  /** A sub-session, fork or the parent of the session on screen changed state. */
  PlaygroundHost.prototype.relatedChanged = function () { this.emit('related.changed', {}); };

  /** Is `id` the parent, a child or a fork of the session on screen? */
  PlaygroundHost.prototype.isRelated = function (id) {
    var s = this.cur().session;
    var x = this.world.sessions[id];
    if (!x || id === s.id) return false;
    return id === s.parentId || x.session.parentId === s.id || x.session.forkedFrom === s.id;
  };

  /** Changes a related session's state (running, attention) and says so with related.changed. */
  PlaygroundHost.prototype.setRelatedState = function (id, patch) {
    var x = this.world.sessions[id];
    if (!x) return false;
    Object.assign(x.session, patch, { updatedAt: Date.now() });
    if (patch.attention === null) delete x.session.attention;
    if (this.isRelated(id)) this.relatedChanged();
    if (this.ui.worldChanged) this.ui.worldChanged();
    return true;
  };

  /** Whether compacting now could free anything: the same test session.compact applies. */
  PlaygroundHost.prototype.compactable = function (cur) {
    cur = cur || this.cur();
    if (cur.session.running) return false;
    var body = cur.context.slices.filter(function (s) { return s.key === 'messages' || s.key === 'toolResults'; }).reduce(function (n, s) { return n + s.tokens; }, 0);
    return cur.context.messages >= 4 && body >= 2000;
  };

  /** The public config as a mod sees it: workingDirectory follows the session on screen. */
  PlaygroundHost.prototype.publicConfig = function () {
    var c = clone(this.world.config);
    c.workingDirectory = this.cur().session.cwd;
    c.home = this.world.home;
    return c;
  };

  PlaygroundHost.prototype.contextChanged = function () {
    var c = this.cur().context;
    c.updatedAt = Date.now();
    this.emit('context.changed', { tokens: c.tokens, limit: c.limit });
  };

  PlaygroundHost.prototype.useSkill = function (name) {
    var w = this.world;
    var cur = this.cur();
    var now = Date.now();
    var bump = function (map) { var e = map[name] || (map[name] = { count: 0, lastUsedAt: 0 }); e.count++; e.lastUsedAt = now; };
    bump(cur.skillUsage);
    bump(w.skillsAll);
    this.emit('skills.used', { name: name });
  };

  PlaygroundHost.prototype.setTasks = function (tasks) {
    this.cur().tasks = tasks;
    this.emit('tasks.changed', { tasks: clone(tasks) });
  };

  PlaygroundHost.prototype.setPlan = function (plan) {
    this.cur().plan = plan;
    this.emit('plan.changed', { plan: clone(plan) });
  };

  PlaygroundHost.prototype.addOutput = function (o) {
    this.cur().outputs.push(o);
    this.emit('outputs.changed', {});
  };

  PlaygroundHost.prototype.slice = function (key) {
    return this.cur().context.slices.filter(function (s) { return s.key === key; })[0];
  };
  PlaygroundHost.prototype.grow = function (key, n) {
    var c = this.cur().context;
    var s = this.slice(key);
    if (!s) {
      s = { key: key, label: root.PlaygroundFixture.LABELS[key], tokens: 0 };
      var at = c.slices.findIndex(function (x) { return x.key === 'reserve'; });
      c.slices.splice(at < 0 ? c.slices.length : at, 0, s);
    }
    s.tokens = Math.max(0, s.tokens + n);
    root.PlaygroundFixture.retotal(c);
  };

  /** run.started → deltas → tool.started/ended → tasks.changed → message.assistant → run.ended → context.changed */
  PlaygroundHost.prototype.simulateRun = function (prompt) {
    if (this.run) return Promise.resolve(false);
    var self = this;
    var cur = this.cur();
    var s = cur.session;
    var token = { stopped: false };
    this.run = token;
    var alive = function () { return !token.stopped && self.run === token; };
    prompt = prompt || 'Wire the settings page to the new loader.';
    var reply = 'I updated the loader so project settings layer over the user file, then ran the tests: all twelve pass. The Settings page now shows managed fields as read-only.';
    var ui = this.ui;

    s.running = true;
    s.updatedAt = Date.now();
    this.emit('run.started', { sessionId: s.id });
    this.sessionChanged();
    cur.transcript.push({ role: 'user', text: prompt });
    s.messageCount++;
    this.emit('message.user', { text: prompt, origin: 'user' });
    if (ui.worldChanged) ui.worldChanged();

    var words = reply.split(/(?= )/);
    var streamed = '';
    var stream = function (from, to) {
      var chain = Promise.resolve();
      words.slice(from, to).forEach(function (w) {
        chain = chain.then(function () {
          if (!alive()) return;
          streamed += w;
          self.emit('message.delta', { text: w });
          if (ui.streaming) ui.streaming(streamed);
          return sleep(45);
        });
      });
      return chain;
    };

    return stream(0, 8).then(function () {
      if (!alive()) return;
      self.emit('tool.started', { id: 'tool-' + Date.now(), name: 'Edit', args: { path: 'src/main/settings.ts' } });
      return sleep(700).then(function () {
        if (!alive()) return;
        self.emit('tool.ended', { id: 'tool-' + Date.now(), name: 'Edit', ok: true, durationMs: 700 });
        cur.transcript.push({ role: 'tool', name: 'Edit', args: '{"path":"src/main/settings.ts"}', text: '+12 −3', ok: true });
        self.grow('toolResults', 3400);
        // advance the task list (or start one)
        var tasks = cur.tasks.length ? clone(cur.tasks) : [
          { id: 'n1', title: 'Read the settings page', status: 'completed' },
          { id: 'n2', title: 'Wire it to the loader', status: 'in_progress' },
          { id: 'n3', title: 'Run the tests', status: 'pending' },
        ];
        if (cur.tasks.length) {
          var ip = tasks.filter(function (t) { return t.status === 'in_progress'; })[0];
          if (ip) ip.status = 'completed';
          var next = tasks.filter(function (t) { return t.status === 'pending'; })[0];
          if (next) next.status = 'in_progress';
        }
        self.setTasks(tasks);
        var existing = cur.outputs.filter(function (o) { return o.id === 'src/renderer/settings.ts'; })[0];
        if (existing) { existing.updatedAt = Date.now(); existing.detail = '+31 −9'; self.emit('outputs.changed', {}); }
        else self.addOutput({ kind: 'file', id: 'src/renderer/settings.ts', title: 'src/renderer/settings.ts', detail: '+24 −6', updatedAt: Date.now() });
        if (self.world.skills.length) self.useSkill(self.world.skills[1] ? self.world.skills[1].name : self.world.skills[0].name);
      });
    }).then(function () { return alive() && stream(8); }).then(function () {
      if (!alive()) return;
      cur.transcript.push({ role: 'assistant', text: reply });
      s.messageCount++;
      self.emit('message.assistant', { text: reply });
      self.grow('messages', 1800);
      self.finishRun('done', reply);
      return true;
    });
  };

  PlaygroundHost.prototype.finishRun = function (reason, text) {
    var cur = this.cur();
    var s = cur.session;
    this.run = null;
    if (!s.running) return;
    s.running = false;
    s.updatedAt = Date.now();
    var data = { sessionId: s.id, reason: reason };
    if (text !== undefined) data.text = text;
    this.emit('run.ended', data);
    this.sessionChanged();
    this.contextChanged();
    if (this.ui.streaming) this.ui.streaming(null);
    if (this.ui.worldChanged) this.ui.worldChanged();
  };

  PlaygroundHost.prototype.stopRun = function (reason) {
    if (this.run) this.run.stopped = true;
    if (this.cur().session.running) this.finishRun(reason || 'stopped');
    this.run = null;
  };

  PlaygroundHost.prototype.schedulesChanged = function () {
    this.emit('schedules.changed', { schedules: this.world.schedules });
    if (this.ui.worldChanged) this.ui.worldChanged();
  };

  /**
   * A schedule fires: lastStatus running, a session for the run (a new one, or the target session), then after a
   * moment the result (`outcome`: ok by default, or error / stopped / skipped / missed) and the next run.
   */
  PlaygroundHost.prototype.fireSchedule = function (sc, outcome) {
    var self = this;
    var w = this.world;
    var now = Date.now();
    sc.lastRunAt = now;
    if (outcome === 'skipped' || outcome === 'missed') {
      sc.lastStatus = outcome;
      sc.nextRunAt = sc.enabled && sc.when.kind !== 'at' ? nextRun(sc.when) : null;
      this.schedulesChanged();
      return;
    }
    var sid = sc.target === 'session' && sc.sessionId && w.sessions[sc.sessionId] ? sc.sessionId : null;
    if (!sid) {
      sid = 's-run-' + now.toString(36);
      w.sessions[sid] = { session: { id: sid, title: sc.name, cwd: sc.cwd, origin: 'schedule', messageCount: 1, createdAt: now, updatedAt: now, running: true }, transcript: [{ role: 'user', text: sc.prompt }], tasks: [], plan: null, outputs: [], skillUsage: {}, context: root.PlaygroundFixture.context(w.config.contextLimit, { system: 2900, tools: 4100 }) };
    }
    sc.lastSessionId = sid;
    sc.lastStatus = 'running';
    sc.runs++;
    if (sc.when.kind === 'at') sc.nextRunAt = null;
    this.schedulesChanged();
    setTimeout(function () {
      if (w.schedules.indexOf(sc) < 0) return;
      sc.lastStatus = outcome || 'ok';
      if (sc.when.kind === 'at') { sc.nextRunAt = null; }
      else sc.nextRunAt = sc.enabled ? nextRun(sc.when) : null;
      var x = w.sessions[sid];
      if (x && x.session.origin === 'schedule') x.session.running = false;
      self.schedulesChanged();
    }, 2500);
  };

  // ---------- methods ----------

  PlaygroundHost.prototype.handle = function (view, method, p) {
    if (!Object.prototype.hasOwnProperty.call(METHOD_PERMS, method)) fail(ERR.UNKNOWN, 'Unknown method: ' + method);
    var perm = METHOD_PERMS[method];
    if (!this.granted(view, perm)) fail(ERR.PERMISSION, 'This mod has no "' + perm + '" permission', { permission: perm });
    if (p === null || typeof p !== 'object' || Array.isArray(p)) fail(ERR.PARAMS, 'params must be an object');
    var w = this.world;
    var mod = this.mods[view.modId];
    var cur = this.cur();
    var ui = this.ui;
    var self = this;

    switch (method) {
      case 'hello':
        if (p.protocol !== 1) fail(ERR.PARAMS, 'This app speaks protocol 1');
        view.helloAt = Date.now();
        return this.helloFor(view);
      case 'events.subscribe':
      case 'events.unsubscribe': {
        if (!Array.isArray(p.events) || p.events.some(function (e) { return typeof e !== 'string'; })) fail(ERR.PARAMS, '"events" must be an array of names');
        if (method === 'events.unsubscribe') { p.events.forEach(function (e) { delete view.subs[e]; }); return null; }
        var missing = null;
        p.events.forEach(function (e) {
          if (!Object.prototype.hasOwnProperty.call(EVENT_PERMS, e)) return; // unknown events are accepted and never sent
          if (!self.granted(view, EVENT_PERMS[e])) missing = missing || EVENT_PERMS[e];
        });
        if (missing) fail(ERR.PERMISSION, 'This mod has no "' + missing + '" permission', { permission: missing });
        p.events.forEach(function (e) { view.subs[e] = true; });
        return null;
      }
      case 'log.error':
        if (ui.pageError) ui.pageError(view, { message: String(p.message), stack: p.stack });
        return null;

      case 'ui.theme': return ui.theme();
      case 'ui.resize':
        if (typeof p.height !== 'number' || !(p.height >= 0)) fail(ERR.PARAMS, '"height" must be a number');
        if (ui.resize) ui.resize(view, p.height);
        return null;
      case 'ui.setTitle': if (ui.setTitle) ui.setTitle(view, str(p, 'title')); return null;
      case 'ui.setBadge': {
        var b = p.badge;
        if (b !== null && typeof b !== 'string' && typeof b !== 'number') fail(ERR.PARAMS, '"badge" must be a string, a number or null');
        if (ui.setBadge) ui.setBadge(view, b);
        return null;
      }
      case 'ui.toast': {
        var kind = p.kind === undefined ? 'info' : p.kind;
        if (kind !== 'info' && kind !== 'error') fail(ERR.PARAMS, '"kind" must be info or error');
        if (ui.toast) ui.toast(str(p, 'text'), kind, view);
        return null;
      }
      case 'ui.open': {
        var vid = str(p, 'view', true);
        var views = (mod.manifest.contributes && mod.manifest.contributes.views) || [];
        if (vid !== undefined && !views.some(function (v) { return v.id === vid; })) fail(ERR.PARAMS, 'No view "' + vid + '" in this mod');
        if (ui.openView) ui.openView(view, vid || view.view.id);
        return null;
      }
      case 'ui.copy': {
        var text = str(p, 'text');
        if (ui.copy) return ui.copy(text);
        return true;
      }
      case 'ui.openExternal': {
        var url = str(p, 'url');
        if (!/^https?:\/\//i.test(url)) fail(ERR.PARAMS, 'Only http(s) links open');
        if (ui.toast) ui.toast('Would open ' + url, 'info', view);
        return null;
      }
      case 'ui.markdown': return { html: markdown(str(p, 'text')) };

      case 'storage.get':
      case 'storage.set':
      case 'storage.remove':
      case 'storage.keys': {
        var scope = p.scope === undefined ? 'mod' : p.scope;
        if (scope !== 'mod' && scope !== 'session') fail(ERR.PARAMS, '"scope" must be mod or session');
        var bag = scope === 'mod' ? mod.storage.mod : (mod.storage.session[w.currentId] || (mod.storage.session[w.currentId] = {}));
        if (method === 'storage.keys') return { keys: Object.keys(bag) };
        var key = str(p, 'key');
        if (method === 'storage.get') return Object.prototype.hasOwnProperty.call(bag, key) ? { value: clone(bag[key]) } : {};
        if (method === 'storage.remove') { delete bag[key]; return null; }
        if (p.value === undefined) fail(ERR.PARAMS, '"value" is required (use storage.remove)');
        var json;
        try { json = JSON.stringify(p.value); } catch (e) { fail(ERR.PARAMS, '"value" must be JSON'); }
        if (json.length > 256 * 1024) fail(ERR.PARAMS, '"value" is larger than 256 KB');
        bag[key] = JSON.parse(json);
        if (ui.worldChanged) ui.worldChanged('storage');
        return null;
      }
      case 'settings.get': return clone(mod.settings);

      case 'session.get': return clone(cur.session);
      case 'session.transcript': {
        if (p.limit !== undefined && (typeof p.limit !== 'number' || p.limit < 0)) fail(ERR.PARAMS, '"limit" must be a positive number');
        var items = cur.transcript.slice(p.limit ? -p.limit : 0);
        return { items: clone(items) };
      }
      case 'session.tasks': return { tasks: clone(cur.tasks) };
      case 'session.plan': return { plan: clone(cur.plan) };
      case 'session.outputs': return { outputs: clone(cur.outputs).sort(function (a, b) { return b.updatedAt - a.updatedAt; }) };
      case 'session.context': return Object.assign(clone(cur.context), { compactable: this.compactable(cur) });
      case 'session.related': return this.related();
      case 'outputs.open': {
        var k = str(p, 'kind');
        var oid = str(p, 'id');
        var out = cur.outputs.filter(function (o) { return o.kind === k && o.id === oid; })[0];
        if (!out) fail(ERR.UNAVAILABLE, 'No such output in this session');
        if (ui.toast) ui.toast('Opened ' + out.title + (k === 'artifact' ? ' in the Browser' : k === 'image' ? ' in the viewer' : ' in the Diff'), 'info', view);
        return null;
      }

      case 'session.send': {
        var t = str(p, 'text');
        if (!t.trim()) fail(ERR.PARAMS, '"text" is empty');
        if (this.run) {
          var id = 'q' + Date.now();
          if (ui.toast) ui.toast('Queued: ' + t, 'info', view);
          return { ok: true, queued: true, id: id };
        }
        this.simulateRun(t);
        return { ok: true };
      }
      case 'composer.insert':
        if (ui.composerInsert) ui.composerInsert(str(p, 'text'));
        return null;

      case 'session.stop': this.stopRun('stopped'); return null;
      case 'session.compact': {
        if (p.focus !== undefined && typeof p.focus !== 'string') fail(ERR.PARAMS, '"focus" must be a string');
        if (cur.session.running) return { ok: false, error: 'A run is in progress; compact when it ends.' };
        var m = this.slice('messages');
        var tr = this.slice('toolResults');
        var body = (m ? m.tokens : 0) + (tr ? tr.tokens : 0);
        if (cur.context.messages < 4 || body < 2000) return { ok: false, error: 'Nothing to compact yet.' };
        return sleep(900).then(function () {
          var before = cur.context.tokens;
          if (m) m.tokens = Math.round(m.tokens * 0.08);
          if (tr) tr.tokens = Math.round(tr.tokens * 0.04);
          self.grow('summary', Math.round(body * 0.06));
          var c = cur.context;
          c.compactions++;
          c.messages = 2;
          c.lastCompaction = { at: Date.now(), reason: 'manual', tokensBefore: before, tokensAfter: c.tokens };
          cur.transcript.push({ role: 'compaction', text: 'Summary' + (p.focus ? ' (focus: ' + p.focus + ')' : '') + ': the loader work so far.' });
          self.contextChanged();
          if (ui.worldChanged) ui.worldChanged();
          return { ok: true };
        });
      }
      case 'sessions.open': {
        var sid = str(p, 'id');
        if (!w.sessions[sid] || w.sessions[sid].merged) fail(ERR.UNAVAILABLE, 'No session ' + sid);
        this.switchTo(sid);
        return null;
      }
      case 'sessions.create':
      case 'sessions.spawn': {
        var spawn = method === 'sessions.spawn';
        var title = spawn ? str(p, 'title') : 'New session';
        if (spawn) str(p, 'prompt');
        var nid = 's-' + Date.now().toString(36);
        var ns = { id: nid, title: title, cwd: cur.session.cwd, origin: spawn ? 'agent' : 'user', messageCount: spawn ? 1 : 0, createdAt: Date.now(), updatedAt: Date.now(), running: spawn };
        if (spawn) ns.parentId = cur.session.id;
        w.sessions[nid] = { session: ns, transcript: spawn ? [{ role: 'user', text: p.prompt }] : [], tasks: [], plan: null, outputs: [], skillUsage: {}, context: root.PlaygroundFixture.context(w.config.contextLimit, { system: 2900, tools: 4100 }) };
        if (spawn) {
          this.relatedChanged();
          setTimeout(function () { self.setRelatedState(nid, { running: false }); }, 4000);
        } else this.switchTo(nid);
        return clone(ns);
      }
      case 'sessions.merge': {
        var mid = str(p, 'id');
        var target = w.sessions[mid];
        if (!target || target.merged) fail(ERR.UNAVAILABLE, 'No session ' + mid);
        var ts = target.session;
        if (ts.parentId !== cur.session.id && ts.forkedFrom !== cur.session.id) return { ok: false, error: 'Only a sub-session or fork of this session can be merged.' };
        if (ts.running) return { ok: false, error: 'It is still running.' };
        if (ts.attention) return { ok: false, error: 'It is waiting for ' + (ts.attention === 'approval' ? 'an approval' : 'its plan to be approved') + '.' };
        return sleep(500).then(function () {
          target.merged = true;
          self.relatedChanged();
          cur.transcript.push({ role: 'assistant', text: 'Merged "' + ts.title + '".' });
          cur.session.messageCount++;
          cur.session.updatedAt = Date.now();
          self.grow('messages', 900);
          self.sessionChanged();
          self.contextChanged();
          if (ui.worldChanged) ui.worldChanged();
          return { ok: true };
        });
      }

      case 'sessions.list':
        return { sessions: Object.keys(w.sessions).map(function (k) { return w.sessions[k]; }).filter(function (x) { return !x.merged; }).map(function (x) { return clone(x.session); }).sort(function (a, b) { return b.updatedAt - a.updatedAt; }) };
      case 'sessions.search': {
        var q = str(p, 'query').toLowerCase().trim();
        if (p.limit !== undefined && typeof p.limit !== 'number') fail(ERR.PARAMS, '"limit" must be a number');
        var hits = [];
        if (q) Object.keys(w.sessions).forEach(function (k) {
          var x = w.sessions[k];
          var cands = [{ role: 'title', text: x.session.title }].concat(x.transcript.filter(function (i) { return i.role === 'user' || i.role === 'assistant' || i.role === 'tool'; }));
          var count = 0;
          var first = null;
          cands.forEach(function (c) {
            var at = String(c.text).toLowerCase().indexOf(q);
            if (at >= 0) { count++; if (!first) first = { c: c, at: at }; }
          });
          if (!first) return;
          var from = Math.max(0, first.at - 60);
          var snippet = String(first.c.text).slice(from, from + 160);
          hits.push({ sessionId: x.session.id, title: x.session.title, updatedAt: x.session.updatedAt, role: first.c.role, snippet: snippet, matchStart: first.at - from, matchEnd: first.at - from + q.length, count: count });
        });
        hits.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
        return { hits: hits.slice(0, p.limit || 20) };
      }

      case 'model.complete': {
        if (!Array.isArray(p.messages) || !p.messages.length) fail(ERR.PARAMS, '"messages" must be a non-empty array');
        p.messages.forEach(function (m) {
          if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') fail(ERR.PARAMS, 'every message needs a role (user or assistant) and a string content');
        });
        if (p.maxTokens !== undefined && (typeof p.maxTokens !== 'number' || p.maxTokens > 4000 || p.maxTokens < 1)) fail(ERR.PARAMS, '"maxTokens" must be 1 to 4000');
        if (p.context !== undefined && p.context !== 'none' && p.context !== 'session') fail(ERR.PARAMS, '"context" must be none or session');
        // world.model.mode: ok (default), slow, hold (streams a little, then waits for a cancel), nokey, unreachable
        var mode = (w.model && w.model.mode) || 'ok';
        if (mode === 'nokey') return sleep(300).then(function () { fail(ERR.UNAVAILABLE, 'No API key is set for ' + w.config.provider + '. Add one in Settings → Model.'); });
        if (mode === 'unreachable') return sleep(900).then(function () { fail(ERR.OTHER, 'Could not reach the model (' + w.config.provider + '): connect ECONNREFUSED 127.0.0.1:11434'); });
        var rid = p.requestId || 'anon-' + Date.now();
        var last = p.messages[p.messages.length - 1];
        var answer = cannedReply(String(last.content), p.context === 'session' ? cur : null, p.messages.length);
        var job = { cancelled: false, wake: null };
        var jobKey = view.key + '|' + rid;
        this.models[jobKey] = job;
        var pieces = answer.split(/(?=[ \n])/);
        var acc = '';
        var chain = Promise.resolve();
        var holdAt = mode === 'hold' ? Math.min(pieces.length, 34) : -1;
        pieces.forEach(function (piece, i) {
          chain = chain.then(function () {
            if (job.cancelled) return;
            if (i === holdAt) return new Promise(function (r) { job.wake = r; });
            acc += piece;
            if (view.subs['model.delta']) {
              self.log(view, 'event', 'model.delta', { requestId: rid, text: piece });
              self.post(view, { jsonrpc: '2.0', method: 'event', params: { name: 'model.delta', data: { requestId: rid, text: piece } } });
            }
            return sleep(mode === 'slow' ? 140 : 35);
          });
        });
        var usage = function () { return { promptTokens: 120 + p.messages.reduce(function (n, m) { return n + Math.ceil(m.content.length / 4); }, 0) + (p.context === 'session' ? cur.context.tokens : 0), completionTokens: Math.ceil(acc.length / 4) }; };
        return chain.then(function () {
          delete self.models[jobKey];
          // After model.cancel the call resolves with what had arrived (docs/mods.md "model")
          if (job.cancelled) return { text: acc, usage: usage(), stopped: true };
          return { text: acc, usage: usage() };
        });
      }
      case 'model.cancel': {
        var cid = str(p, 'requestId', true);
        Object.keys(this.models).forEach(function (k) {
          if (k.indexOf(view.key + '|') !== 0 || (cid && k !== view.key + '|' + cid)) return;
          var job = self.models[k];
          job.cancelled = true;
          if (job.wake) job.wake();
        });
        return null;
      }

      case 'skills.list': return { skills: clone(w.skills) };
      case 'skills.usage': {
        if (p.scope !== 'session' && p.scope !== 'all') fail(ERR.PARAMS, '"scope" must be session or all');
        var map = p.scope === 'session' ? cur.skillUsage : w.skillsAll;
        return { items: Object.keys(map).map(function (n) { return { name: n, count: map[n].count, lastUsedAt: map[n].lastUsedAt }; }).sort(function (a, b) { return b.count - a.count; }) };
      }

      case 'config.get': return this.publicConfig();
      case 'config.set': {
        var patch = p.patch;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(ERR.PARAMS, '"patch" must be an object');
        Object.keys(patch).forEach(function (key) {
          if (CONFIG_WRITABLE.indexOf(key) < 0) fail(ERR.PARAMS, 'A mod cannot change "' + key + '"');
        });
        if (patch.theme !== undefined && ['system', 'light', 'dark'].indexOf(patch.theme) < 0) fail(ERR.PARAMS, '"theme" must be system, light or dark');
        if (patch.keepAwake !== undefined && ['off', 'running', 'always'].indexOf(patch.keepAwake) < 0) fail(ERR.PARAMS, '"keepAwake" must be off, running or always');
        if (patch.compactThreshold !== undefined && !(typeof patch.compactThreshold === 'number' && patch.compactThreshold > 0 && patch.compactThreshold < 1)) fail(ERR.PARAMS, '"compactThreshold" must be between 0 and 1');
        ['autoCompact', 'notifications'].forEach(function (key) { if (patch[key] !== undefined && typeof patch[key] !== 'boolean') fail(ERR.PARAMS, '"' + key + '" must be true or false'); });
        Object.assign(w.config, patch);
        if (patch.compactThreshold !== undefined) cur.context.threshold = patch.compactThreshold;
        if (patch.autoCompact !== undefined) cur.context.autoCompact = patch.autoCompact;
        this.emit('config.changed', this.publicConfig());
        if (patch.theme && patch.theme !== 'system' && ui.setScheme) ui.setScheme(patch.theme);
        if (ui.worldChanged) ui.worldChanged();
        return this.publicConfig();
      }

      case 'schedules.list': return { schedules: clone(w.schedules) };
      case 'schedules.create': {
        var input = p.input;
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail(ERR.PARAMS, '"input" must be an object');
        checkSchedule(input, true);
        var target = input.target || 'new';
        var sch = {
          id: 'sch-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: input.name.trim(), prompt: input.prompt, when: input.when,
          target: target, cwd: input.cwd || cur.session.cwd, enabled: input.enabled !== false, createdAt: Date.now(), createdBy: 'user', runs: 0,
        };
        // "This session" without an id means the session on screen
        if (target === 'session') sch.sessionId = input.sessionId || cur.session.id;
        sch.nextRunAt = sch.enabled ? nextRun(sch.when) : null;
        sch.describe = describeWhen(sch.when);
        w.schedules.push(sch);
        this.schedulesChanged();
        return clone(sch);
      }
      case 'schedules.update':
      case 'schedules.remove':
      case 'schedules.runNow': {
        var schId = str(p, 'id');
        var sc = w.schedules.filter(function (x) { return x.id === schId; })[0];
        if (!sc) fail(ERR.UNAVAILABLE, 'No schedule ' + schId);
        if (method === 'schedules.remove') {
          w.schedules = w.schedules.filter(function (x) { return x !== sc; });
          this.schedulesChanged();
          return null;
        }
        if (method === 'schedules.runNow') {
          if (sc.lastStatus === 'running') fail(ERR.OTHER, 'It is already running.');
          this.fireSchedule(sc);
          return null;
        }
        var sp = p.patch;
        if (!sp || typeof sp !== 'object' || Array.isArray(sp)) fail(ERR.PARAMS, '"patch" must be an object');
        Object.keys(sp).forEach(function (key) { if (['name', 'prompt', 'when', 'enabled', 'target'].indexOf(key) < 0) fail(ERR.PARAMS, 'Cannot change "' + key + '"'); });
        if (sp.enabled !== undefined && typeof sp.enabled !== 'boolean') fail(ERR.PARAMS, '"enabled" must be true or false');
        checkSchedule(Object.assign({}, sc, sp), sp.when !== undefined || (sp.enabled === true && sc.when.kind === 'at'));
        if (sp.name !== undefined) sp.name = sp.name.trim();
        Object.assign(sc, sp);
        if (sp.target === 'session' && !sc.sessionId) sc.sessionId = cur.session.id;
        if (sp.target === 'new') delete sc.sessionId;
        sc.describe = describeWhen(sc.when);
        sc.nextRunAt = sc.enabled ? nextRun(sc.when) : null;
        this.schedulesChanged();
        return clone(sc);
      }

      case 'remote.status': return clone(w.remote);
      case 'remote.start':
      case 'remote.stop': {
        var on = method === 'remote.start';
        return sleep(on ? 350 : 150).then(function () {
          var r = w.remote;
          r.enabled = on;
          r.running = on;
          if (on) { r.port = 7788; r.urls = ['http://192.168.1.23:7788/?t=' + Math.random().toString(16).slice(2, 18)]; r.startedAt = Date.now(); }
          else { r.port = null; r.urls = []; r.clients = 0; delete r.startedAt; }
          self.emit('remote.changed', r);
          if (ui.worldChanged) ui.worldChanged();
          return clone(r);
        });
      }
    }
    fail(ERR.UNKNOWN, 'Unknown method: ' + method);
  };

  /** The playground's model: a canned Markdown answer that depends a little on the question. */
  function cannedReply(question, session, turns) {
    var q = question.replace(/\s+/g, ' ').trim();
    var head = '> ' + (q.length > 80 ? q.slice(0, 80) + '…' : q) + '\n\n';
    var ctx = session ? 'I can see the main conversation (' + session.transcript.length + ' items, "' + session.session.title + '"), so this answer takes it into account.' : 'I cannot see the main conversation, so this answer stands on its own.';
    if (/error|fail|exception|stack/i.test(q)) {
      return head + 'That error usually means the process tried to read a file that was not there yet. ' + ctx + '\n\nThree things to check:\n\n1. The path is resolved from the **working directory**, not the file.\n2. The build ran: `npm run build` writes `dist/`.\n3. Nothing deleted it in between (a `clean` step).\n\n```sh\nls dist/main && node -e "require(\'./dist/main/agent.js\')"\n```\n\nIf the second command prints nothing, the file is fine and the cause is elsewhere.';
    }
    return head + 'Short answer: `--no-verify` skips the pre-commit and commit-msg hooks for that one commit. ' + ctx + '\n\n- It does **not** skip CI, so a lint failure still shows up there.\n- Hooks that run on push (`pre-push`) are not affected.\n- `git commit -n` is the same flag.\n\nUse it for a work-in-progress commit you will squash later, not to get past a failing check.' + (turns > 2 ? '\n\n(This is turn ' + Math.ceil(turns / 2) + ' of the side conversation.)' : '');
  }

  var CRON_FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day of the month', 1, 31], ['month', 1, 12], ['day of the week', 0, 7]];
  /** A five-field cron expression → five arrays of allowed values; throws a bad-params error naming the field. */
  function parseCron(expr) {
    var parts = String(expr).trim().split(/\s+/);
    if (parts.length !== 5) fail(ERR.PARAMS, 'A cron expression has five fields (minute hour day month weekday); this one has ' + parts.length + '.');
    return parts.map(function (part, i) {
      var f = CRON_FIELDS[i];
      var set = {};
      part.split(',').forEach(function (item) {
        var m = item.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
        if (!m) fail(ERR.PARAMS, 'The ' + f[0] + ' field "' + item + '" is not a number, a range, a list or *.');
        var lo = m[1] === '*' ? f[1] : Number(m[2]);
        var hi = m[1] === '*' ? f[2] : m[3] !== undefined ? Number(m[3]) : m[4] ? f[2] : lo;
        var step = m[4] ? Number(m[4]) : 1;
        if (lo < f[1] || hi > f[2] || lo > hi || step < 1) fail(ERR.PARAMS, 'The ' + f[0] + ' field "' + item + '" is out of range (' + f[1] + ' to ' + f[2] + ').');
        for (var v = lo; v <= hi; v += step) set[i === 4 && v === 7 ? 0 : v] = true;
      });
      return set;
    });
  }
  function cronNext(expr, from) {
    var f = parseCron(expr);
    var d = new Date(from);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    for (var i = 0; i < 366 * 24 * 60; i++) {
      if (f[3][d.getMonth() + 1] && f[2][d.getDate()] && f[4][d.getDay()] && f[1][d.getHours()] && f[0][d.getMinutes()]) return d.getTime();
      d.setMinutes(d.getMinutes() + 1);
    }
    return null;
  }

  /** What the app refuses when a schedule is created or changed (the mod is meant to catch most of it first). */
  function checkSchedule(input, checkTime) {
    if (typeof input.name !== 'string' || !input.name.trim()) fail(ERR.PARAMS, 'Give the task a name.');
    if (input.name.length > 120) fail(ERR.PARAMS, 'The name is longer than 120 characters.');
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) fail(ERR.PARAMS, 'The prompt is empty.');
    if (input.target !== undefined && input.target !== 'new' && input.target !== 'session') fail(ERR.PARAMS, '"target" must be new or session');
    var when = input.when;
    if (!when || typeof when !== 'object') fail(ERR.PARAMS, '"when" is required');
    if (when.kind === 'at') {
      var t = typeof when.at === 'string' && /T\d\d:\d\d/.test(when.at) ? Date.parse(when.at) : NaN;
      if (isNaN(t)) fail(ERR.PARAMS, '"when.at" must be an ISO date-time with an offset');
      if (checkTime && t < Date.now() + 30000) fail(ERR.PARAMS, 'That time has passed. Pick one in the future.');
    } else if (when.kind === 'every') {
      if (typeof when.minutes !== 'number' || !isFinite(when.minutes) || Math.round(when.minutes) !== when.minutes) fail(ERR.PARAMS, '"when.minutes" must be a whole number');
      if (when.minutes < 5) fail(ERR.PARAMS, 'The shortest rhythm is every 5 minutes.');
      if (when.minutes > 366 * 24 * 60) fail(ERR.PARAMS, 'The longest rhythm is once a year.');
    } else if (when.kind === 'cron') {
      if (typeof when.expr !== 'string') fail(ERR.PARAMS, '"when.expr" must be a string');
      if (cronNext(when.expr, Date.now()) === null) fail(ERR.PARAMS, 'That cron expression never matches a date.');
    } else fail(ERR.PARAMS, '"when.kind" must be at, every or cron');
  }
  function nextRun(when) {
    if (when.kind === 'at') { var t = Date.parse(when.at); return t > Date.now() ? t : null; }
    if (when.kind === 'every') return Date.now() + when.minutes * 60000;
    return cronNext(when.expr, Date.now());
  }
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function hhmm(h, m) { return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  /** "every 30 minutes", "weekdays at 09:00", "once on Nov 6 at 09:00" (src/shared/schedules.ts) */
  function describeWhen(when) {
    if (when.kind === 'at') {
      var d = new Date(Date.parse(when.at));
      return 'once on ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' at ' + hhmm(d.getHours(), d.getMinutes());
    }
    if (when.kind === 'every') {
      var n = when.minutes;
      if (n % 1440 === 0) return n === 1440 ? 'every day' : 'every ' + n / 1440 + ' days';
      if (n % 60 === 0) return n === 60 ? 'every hour' : 'every ' + n / 60 + ' hours';
      return 'every ' + n + ' minutes';
    }
    var p = String(when.expr).trim().split(/\s+/);
    if (/^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) && p[2] === '*' && p[3] === '*') {
      var at = ' at ' + hhmm(Number(p[1]), Number(p[0]));
      if (p[4] === '*') return 'every day' + at;
      if (p[4] === '1-5') return 'weekdays' + at;
      if (p[4] === '0,6' || p[4] === '6,0') return 'weekends' + at;
      if (/^[0-7]$/.test(p[4])) return DAYS[Number(p[4]) % 7] + 's' + at;
    }
    if (/^\*\/\d+$/.test(p[0]) && p.slice(1).every(function (x) { return x === '*'; })) return 'every ' + p[0].slice(2) + ' minutes';
    return 'cron ' + when.expr;
  }

  // ---------- a small Markdown renderer (headings, lists, task lists, code, emphasis, links) ----------

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function inline(s) {
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + esc(codes[+i]) + '</code>'; });
  }
  function markdown(text) {
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;
    var para = [];
    var flush = function () { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
    while (i < lines.length) {
      var line = lines[i];
      var fence = line.match(/^```(\w*)/);
      if (fence) {
        flush();
        var code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push('<pre><code' + (fence[1] ? ' class="language-' + esc(fence[1]) + '"' : '') + '>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flush(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        flush();
        var ordered = /^\s*\d+\./.test(line);
        var items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          var body = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
          var task = body.match(/^\[( |x|X)\]\s+(.*)$/);
          items.push(task ? '<li class="task' + (task[1] !== ' ' ? ' done' : '') + '"><input type="checkbox" disabled' + (task[1] !== ' ' ? ' checked' : '') + '> ' + inline(task[2]) + '</li>' : '<li>' + inline(body) + '</li>');
          i++;
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (/^>\s?/.test(line)) { flush(); out.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>'); i++; continue; }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line.trim());
      i++;
    }
    flush();
    return out.join('\n');
  }

  PlaygroundHost.METHOD_PERMS = METHOD_PERMS;
  PlaygroundHost.EVENT_PERMS = EVENT_PERMS;
  PlaygroundHost.markdown = markdown;
  PlaygroundHost.describeWhen = describeWhen;
  PlaygroundHost.cronNext = function (expr, from) { return cronNext(expr, from === undefined ? Date.now() : from); };
  root.PlaygroundHost = PlaygroundHost;
})(typeof self !== 'undefined' ? self : this);
