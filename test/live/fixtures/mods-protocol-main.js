// Electron main script for test/live/mods-protocol.js. A hidden window plays the app page: it embeds mod pages in
// sandboxed frames (as the window-side host will) and they try everything a mod should not be able to do. A local
// https/wss server stands in for the internet and records every request that reaches it.
const { app, BrowserWindow, protocol, session } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.OA_ROOT;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mods-live-')));
app.setPath('userData', path.join(tmp, 'userData'));
process.env.OPENAGENT_CONFIG_DIR = path.join(tmp, 'home');
app.dock?.hide();

const { setupMods, serveModRequest, MOD_SCHEME, MOD_SCHEME_PRIVILEGES } = require(path.join(ROOT, 'dist', 'main', 'mods.js'));
const { SessionStore } = require(path.join(ROOT, 'dist', 'main', 'sessions.js'));
protocol.registerSchemesAsPrivileged([{ scheme: MOD_SCHEME, privileges: MOD_SCHEME_PRIVILEGES }]);

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`.slice(0, 600));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- The mods ----------
const DOT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const appRoot = path.join(tmp, 'app');
fs.mkdirSync(path.join(appRoot, 'modkit'), { recursive: true });
fs.mkdirSync(path.join(appRoot, 'mods'), { recursive: true });
fs.writeFileSync(path.join(appRoot, 'modkit', 'harness.js'), "window.__kit = 'js';");
fs.writeFileSync(path.join(appRoot, 'modkit', 'harness.css'), ':root { --kit: loaded; }');
const userMods = path.join(tmp, 'home', 'mods');
const project = path.join(tmp, 'project');
fs.mkdirSync(project, { recursive: true });

/** The page every test mod runs: it reports what worked, then tries to navigate away. */
function probePage(id, { navigate = [] } = {}) {
  return `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/@harness/harness.css">
<link rel="stylesheet" href="style.css">
<body><p>${id}</p>
<script src="/@harness/harness.js"></script>
<script>
(async () => {
  const port = new URLSearchParams(location.search).get('port');
  const web = 'https://127.0.0.1:' + port;
  const r = { violations: [] };
  document.addEventListener('securitypolicyviolation', (e) => r.violations.push(e.effectiveDirective));
  const img = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('failed'); i.src = src; setTimeout(() => res('timeout'), 4000); });
  const get = (u) => fetch(u).then((x) => (x.ok ? 'loaded' : 'status ' + x.status)).catch(() => 'blocked');
  r.kitJs = window.__kit === 'js';
  r.kitCss = getComputedStyle(document.documentElement).getPropertyValue('--kit').trim() === 'loaded';
  r.ownCss = getComputedStyle(document.body).getPropertyValue('--own').trim() === 'yes';
  r.ownImg = await img('img/dot.png');
  r.ownFetch = await fetch('data.json').then((x) => x.json()).then((j) => j.mod === '${id}').catch((e) => String(e));
  r.webFetch = await get(web + '/${id}-fetch');
  r.webImg = await img(web + '/${id}-img.png');
  r.webSocket = await new Promise((res) => {
    try {
      const ws = new WebSocket('wss://127.0.0.1:' + port + '/${id}-ws');
      ws.onopen = () => res('open');
      ws.onerror = () => res('error');
      setTimeout(() => res('timeout'), 4000);
    } catch (e) { res('threw'); }
  });
  r.otherMod = await get('mod://other.user/data.json');
  r.background = await get('mod://app.background/pic.png');
  r.storage = (() => { try { localStorage.setItem('x', '1'); return 'available'; } catch (e) { return 'unavailable'; } })();
  parent.postMessage({ mod: '${id}', results: r }, '*');
  const targets = ${JSON.stringify(navigate)};
  for (const t of targets) {
    await new Promise((res) => setTimeout(res, 400));
    location.href = t.replace('PORT', port);
  }
})();
</script>`;
}

function writeMod(id, manifest, files) {
  const dir = path.join(userMods, id);
  fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ protocol: 1, id, name: id, version: '0.1.0', contributes: { views: [{ id: 'main', title: id, entry: 'panel.html', seat: 'rail' }] }, ...manifest }));
  fs.writeFileSync(path.join(dir, 'img', 'dot.png'), DOT);
  fs.writeFileSync(path.join(dir, 'style.css'), 'body { --own: yes; }');
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ mod: id }));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
}
writeMod('plain', {}, { 'panel.html': probePage('plain', { navigate: ['https://127.0.0.1:PORT/plain-nav', 'mod://net.user/panel.html', 'data:text/html,hi'] }) });
writeMod('bare', {}, { 'panel.html': probePage('bare', { navigate: ['https://127.0.0.1:PORT/bare-nav', 'mod://net.user/panel.html'] }) });
writeMod('net', { permissions: ['network'] }, { 'panel.html': probePage('net', { navigate: ['page2.html'] }), 'page2.html': '<!doctype html><script>parent.postMessage({ mod: "net2", results: { at: location.href } }, "*")</script>' });
writeMod('other', {}, { 'panel.html': '<p>other</p>' });
writeMod('offmod', {}, { 'panel.html': '<p>OFF PAGE</p>' });
writeMod('paused', { permissions: ['session:read'] }, { 'panel.html': '<p>PAUSED PAGE</p>' });
fs.mkdirSync(path.join(tmp, 'userData', 'backgrounds'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'userData', 'backgrounds', 'pic.png'), DOT);

// ---------- A minimal App ----------
const grant = (permissions) => ({ permissions, styles: false, at: 1 });
let config = {
  provider: 'ollama',
  ollama: { baseURL: 'http://127.0.0.1:9/v1', model: 'none', numCtx: 4096, think: 'auto' },
  portkey: { baseURL: '', apiKey: '', model: '', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 8192 },
  workingDirectory: project,
  permissionMode: 'ask',
  theme: 'system',
  autoCompact: true,
  compactThreshold: 0.8,
  keepAwake: 'off',
  notifications: false,
  mods: {
    enabled: { plain: grant([]), bare: grant([]), net: grant(['network']), other: grant([]), paused: grant([]) },
    disabledBundled: [],
    settings: {},
    layout: { railOpen: true, railWidth: 300, collapsed: [], background: null, backgroundImage: null, backgroundDim: 0.8 },
    safeMode: false,
  },
};
let win = null;
const store = new SessionStore(path.join(tmp, 'userData', 'sessions'));
const fg = store.create();
const quits = [];
const fakeApp = {
  userData: path.join(tmp, 'userData'),
  appRoot,
  config: () => config,
  updateConfig: (c) => (config = typeof c === 'function' ? c(config) : { ...config, ...c }),
  onConfig: () => () => {},
  window: () => win,
  push: () => {},
  rpc: { handle: () => () => {} },
  store,
  runtime: { foregroundId: () => fg.id, list: () => [], status: () => ({ running: false }), agentFor: () => ({}) },
  events: { on: () => () => {} },
  tools: { register: () => () => {}, list: () => [] },
  prompt: { add: () => () => {} },
  commands: { register: () => () => {}, list: () => [] },
  provide: () => () => {},
  service: () => undefined,
  onQuit: (fn) => quits.push(fn),
};

// ---------- "The internet" ----------
const hits = [];
function startServer() {
  const server = https.createServer({ key: fs.readFileSync(path.join(process.env.OA_CERT_DIR, 'key.pem')), cert: fs.readFileSync(path.join(process.env.OA_CERT_DIR, 'cert.pem')) }, (req, res) => {
    hits.push(req.url);
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' });
      return res.end(DOT);
    }
    if (req.url === '/win2.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><p>web page</p>');
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('ok');
  });
  server.on('upgrade', (req, socket) => {
    hits.push(req.url);
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

app.whenReady().then(async () => {
  try {
    const server = await startServer();
    const port = server.address().port;
    session.defaultSession.setCertificateVerifyProc((req, cb) => cb(req.hostname === '127.0.0.1' ? 0 : -3));

    win = new BrowserWindow({ show: false, paintWhenInitiallyHidden: true, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const ctl = setupMods(fakeApp);
    // Same handler, except that the "bare" mod is served without its CSP: what it cannot do then is the
    // lock-down's doing alone.
    protocol.unhandle(MOD_SCHEME);
    protocol.handle(MOD_SCHEME, async (req) => {
      const res = await serveModRequest(req, ctl.serve);
      if (!req.url.startsWith('mod://bare.user/')) return res;
      const headers = new Headers(res.headers);
      headers.delete('content-security-policy');
      return new Response(res.body, { status: res.status, headers });
    });

    const states = Object.fromEntries(ctl.registry.list().map((m) => [m.id, m.state]));
    check('fixture mods are in the expected states', states.plain === 'on' && states.net === 'on' && states.bare === 'on' && states.offmod === 'off' && states.paused === 'paused', states);

    const hostHtml = `<!doctype html><meta charset="utf-8"><body>
<script>
  window.__results = {};
  addEventListener('message', (e) => { if (e.data && e.data.mod) window.__results[e.data.mod] = e.data.results; });
  const port = ${port};
  window.__app = {};
  fetch('https://127.0.0.1:' + port + '/app-fetch').then((r) => (window.__app.fetch = r.ok ? 'loaded' : r.status)).catch((e) => (window.__app.fetch = 'blocked ' + e));
  const i = new Image(); i.onload = () => (window.__app.img = 'loaded'); i.onerror = () => (window.__app.img = 'failed'); i.src = 'https://127.0.0.1:' + port + '/app-img.png';
  fetch('mod://offmod.user/panel.html').then((r) => (window.__app.off = r.status)).catch(() => (window.__app.off = 'blocked'));
  fetch('mod://paused.user/panel.html').then((r) => (window.__app.paused = r.status)).catch(() => (window.__app.paused = 'blocked'));
  fetch('mod://plain.user/data.json').then((r) => r.json()).then((j) => (window.__app.plainData = j.mod)).catch((e) => (window.__app.plainData = 'blocked ' + e));
  for (const id of ['plain', 'bare', 'net', 'offmod', 'paused']) {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-forms');
    f.src = 'mod://' + id + '.user/panel.html?port=' + port;
    document.body.appendChild(f);
  }
</script>`;
    const hostFile = path.join(tmp, 'host.html');
    fs.writeFileSync(hostFile, hostHtml);
    await win.loadFile(hostFile);

    const results = async () => win.webContents.executeJavaScript('JSON.stringify({ r: window.__results, app: window.__app })').then(JSON.parse);
    const deadline = Date.now() + 20_000;
    let state = await results();
    while (Date.now() < deadline && !(state.r.plain && state.r.bare && state.r.net && state.r.net2)) {
      await sleep(200);
      state = await results();
    }
    await sleep(2000); // the navigation attempts happen after each frame reported
    state = await results();
    const { plain, bare, net, net2 } = state.r;

    // Loading
    check('a mod page loads with its kit files', plain && plain.kitJs && plain.kitCss, plain);
    check('relative assets load (stylesheet, image)', plain && plain.ownCss && plain.ownImg === 'loaded', plain);
    check('a mod can fetch its own files', plain && plain.ownFetch === true, plain && plain.ownFetch);
    check('no localStorage in the sandboxed frame', plain && plain.storage === 'unavailable');

    // Without network, with the CSP
    check('without network: fetch(https) fails', plain && plain.webFetch === 'blocked', plain && plain.webFetch);
    check('without network: <img src="https://…"> fails', plain && plain.webImg === 'failed', plain && plain.webImg);
    check('without network: WebSocket fails', plain && plain.webSocket === 'error', plain && plain.webSocket);
    check('the CSP reported the attempts', plain && ['connect-src', 'img-src'].every((d) => plain.violations.includes(d)), plain && plain.violations);
    check('a mod cannot load another mod\'s files', plain && plain.otherMod === 'blocked', plain && plain.otherMod);
    check('a mod cannot load the background picture', plain && plain.background === 'blocked', plain && plain.background);

    // Without network and without the CSP: the lock-down alone
    check('lock-down alone: the CSP really was removed for "bare"', bare && bare.violations.length === 0, bare && bare.violations);
    check('lock-down alone: fetch(https) fails', bare && bare.webFetch === 'blocked', bare && bare.webFetch);
    check('lock-down alone: <img src="https://…"> fails', bare && bare.webImg === 'failed', bare && bare.webImg);
    check('lock-down alone: WebSocket fails', bare && bare.webSocket === 'error', bare && bare.webSocket);
    check('lock-down alone: another mod\'s files are refused', bare && bare.otherMod === 'blocked', bare && bare.otherMod);
    check('lock-down alone: the background picture is refused', bare && bare.background === 'blocked', bare && bare.background);
    const leaked = hits.filter((h) => /^\/(plain|bare)-/.test(h));
    check('no request of a mod without network reached the server', leaked.length === 0, leaked);

    // With network
    check('with network: fetch(https) works', net && net.webFetch === 'loaded' && hits.includes('/net-fetch'), net && net.webFetch);
    check('with network: <img src="https://…"> works', net && net.webImg === 'loaded');
    check('with network: WebSocket connects', net && net.webSocket === 'open' && hits.includes('/net-ws'), net && net.webSocket);
    check('with network the CSP still keeps other mods out', net && net.otherMod === 'blocked');

    // Navigation
    const frames = win.webContents.mainFrame.framesInSubtree.filter((fr) => fr !== win.webContents.mainFrame).map((fr) => fr.url);
    check('location = https://… is refused: the frame stays where it was', frames.some((u) => u.startsWith('mod://plain.user/panel.html')) && frames.some((u) => u.startsWith('mod://bare.user/panel.html')), frames);
    check('no navigation reached the server', !hits.includes('/plain-nav') && !hits.includes('/bare-nav'), hits);
    check('a mod cannot navigate into another mod or to data:', !frames.some((u) => u.startsWith('data:')) && frames.filter((u) => u.startsWith('mod://net.user/panel.html')).length === 0, frames);
    check('navigating within its own origin works', net2 && /^mod:\/\/net\.user\/page2\.html/.test(net2.at) && frames.some((u) => u.startsWith('mod://net.user/page2.html')), net2);

    // Off and paused
    check('an off mod is not served', state.app.off === 404, state.app.off);
    check('a paused mod is not served', state.app.paused === 404, state.app.paused);
    const text = async (prefix) => {
      const fr = win.webContents.mainFrame.framesInSubtree.find((x) => x.url.startsWith(prefix));
      return fr ? fr.executeJavaScript('document.body ? document.body.innerText : ""') : '(no frame)';
    };
    const offText = await text('mod://offmod.user/');
    const pausedText = await text('mod://paused.user/');
    check('their frames show nothing of the mod', !/OFF PAGE/.test(offText) && !/PAUSED PAGE/.test(pausedText), { offText, pausedText });

    // The app page and other windows
    check('the app page\'s own requests are unaffected', state.app.fetch === 'loaded' && state.app.img === 'loaded' && hits.includes('/app-fetch'), state.app);
    check('the app page can read a mod\'s files', state.app.plainData === 'plain', state.app.plainData);
    const win2 = new BrowserWindow({ show: false, paintWhenInitiallyHidden: true, webPreferences: { sandbox: true, contextIsolation: true } });
    await win2.loadURL(`https://127.0.0.1:${port}/win2.html`);
    const w2 = await win2.webContents.executeJavaScript(`Promise.all([
      fetch('https://127.0.0.1:${port}/win2-fetch').then((r) => (r.ok ? 'loaded' : r.status)).catch((e) => 'blocked'),
      fetch('mod://plain.user/data.json').then((r) => 'status ' + r.status).catch(() => 'blocked'),
      new Promise((res) => { location.hash = 'x'; res(location.hash); }),
    ])`);
    check('a second ordinary window is unaffected', w2[0] === 'loaded' && hits.includes('/win2-fetch') && w2[2] === '#x', w2);
    check('a web page cannot read mod files', w2[1] === 'blocked', w2[1]);
    await win2.loadURL(`https://127.0.0.1:${port}/win2-nav`);
    check('a second window navigates normally', win2.webContents.getURL().endsWith('/win2-nav'));
    win2.destroy();

    // Headers
    const res = await session.defaultSession.fetch('mod://plain.user/panel.html');
    const csp = res.headers.get('content-security-policy') || '';
    check('served with CSP, CORS, no-store and nosniff', res.status === 200 && csp.includes("default-src 'none'") && csp.includes('mod://plain.user') && res.headers.get('access-control-allow-origin') === '*' && res.headers.get('cache-control') === 'no-store' && res.headers.get('x-content-type-options') === 'nosniff', { csp, status: res.status });
    const netRes = await session.defaultSession.fetch('mod://net.user/panel.html');
    check('a network mod\'s CSP allows https', /connect-src mod:\/\/net\.user https: wss:/.test(netRes.headers.get('content-security-policy') || ''));

    server.close();
    for (const q of quits.reverse()) await q();
  } catch (err) {
    failures++;
    console.log('FAIL fixture crashed', err && err.stack);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(failures ? 1 : 0);
});
