#!/usr/bin/env node
/*
 * The mod playground's server: node modkit/playground/serve.js [modsDir] [--port N]
 * Serves the playground page, the kit under /@harness/, and each mod's files under /mods/<id>/…, on 127.0.0.1.
 * No dependencies. require('./serve.js').start({ modsDir, port }) → Promise<{ url, server, close }> for scripts.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { validateManifest, defaultSettings } = require('./validate.js');

const KIT_DIR = path.join(__dirname, '..');
const PLAYGROUND_DIR = __dirname;
const DEFAULT_MODS = path.join(__dirname, '..', '..', 'mods');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/** A path under `base`, or null when it would leave it. */
function inside(base, rel) {
  const p = path.resolve(base, '.' + path.sep + rel);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

/** Newest mtime and file count under a folder (skips node_modules and dot folders). */
function folderRev(dir) {
  let newest = 0;
  let count = 0;
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 6) walk(p, depth + 1); continue; }
      try { const st = fs.statSync(p); newest = Math.max(newest, st.mtimeMs); count++; } catch { /* gone */ }
    }
  };
  walk(dir, 0);
  return `${Math.round(newest)}-${count}`;
}

function listMods(modsDir) {
  let dirs = [];
  const isDir = (e) => e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(modsDir, e.name)).isDirectory(); } catch { return false; } })());
  try { dirs = fs.readdirSync(modsDir, { withFileTypes: true }).filter((e) => isDir(e) && !e.name.startsWith('.')).map((e) => e.name); } catch { /* none */ }
  return dirs.sort().map((folder) => {
    const dir = path.join(modsDir, folder);
    const file = path.join(dir, 'mod.json');
    let manifest = null;
    let problems;
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
    if (raw === null) problems = [{ level: 'error', message: 'mod.json is missing' }];
    else {
      problems = validateManifest(raw, { folder, exists: (rel) => { const p = inside(dir, rel); return !!p && fs.existsSync(p) && fs.statSync(p).isFile(); } });
      try { manifest = JSON.parse(raw); } catch { manifest = null; }
    }
    const valid = !!manifest && !problems.some((p) => p.level === 'error');
    return { folder, dir, manifest, valid, problems, settings: manifest ? defaultSettings(manifest) : {}, rev: folderRev(dir) };
  });
}

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, extra || {}));
  res.end(body);
}

function sendFile(res, file, extra) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', undefined, extra);
    res.writeHead(200, Object.assign({ 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': st.size }, extra || {}));
    fs.createReadStream(file).pipe(res);
  });
}

function start(opts) {
  opts = opts || {};
  const modsDir = path.resolve(opts.modsDir || DEFAULT_MODS);
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(res, 400, 'Bad request'); }
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }
    // Mod pages run in sandboxed frames with an opaque origin: their fetches to their own files are cross-origin.
    const cors = { 'access-control-allow-origin': '*' };

    if (p === '/' || p === '/index.html') return sendFile(res, path.join(PLAYGROUND_DIR, 'index.html'));
    if (p === '/api/mods') return send(res, 200, JSON.stringify({ modsDir, kitRev: kitRev(), mods: listMods(modsDir) }), TYPES['.json']);
    if (p === '/api/rev') {
      const revs = {};
      for (const m of listMods(modsDir)) revs[m.folder] = m.rev;
      return send(res, 200, JSON.stringify({ kit: kitRev(), mods: revs }), TYPES['.json']);
    }
    // The kit, at the root (what mod pages ask for) and under any mod folder (a page that uses a relative path)
    const kit = p.match(/^(?:\/mods\/[^/]+)?\/@harness\/(harness\.(?:js|css))$/);
    if (kit) return sendFile(res, path.join(KIT_DIR, kit[1]), cors);
    if (p.startsWith('/playground/')) {
      const f = inside(PLAYGROUND_DIR, p.slice('/playground/'.length));
      return f ? sendFile(res, f) : send(res, 403, 'Forbidden');
    }
    const mod = p.match(/^\/mods\/([^/]+)\/(.*)$/);
    if (mod) {
      const dir = inside(modsDir, mod[1]);
      const f = dir && inside(dir, mod[2] || 'index.html');
      return f ? sendFile(res, f, cors) : send(res, 403, 'Forbidden', undefined, cors);
    }
    send(res, 404, 'Not found');
  });

  function kitRev() {
    let newest = 0;
    for (const f of ['harness.js', 'harness.css']) { try { newest = Math.max(newest, fs.statSync(path.join(KIT_DIR, f)).mtimeMs); } catch { /* */ } }
    return String(Math.round(newest));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      resolve({ url, server, modsDir, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

module.exports = { start, listMods };

if (require.main === module) {
  const args = process.argv.slice(2);
  let port = 0;
  const i = args.indexOf('--port');
  if (i >= 0) { port = Number(args[i + 1]) || 0; args.splice(i, 2); }
  start({ modsDir: args[0], port }).then(({ url, modsDir }) => {
    console.log(`Mod playground: ${url}`);
    console.log(`Mods from ${modsDir}`);
  }, (e) => { console.error(e.message); process.exit(1); });
}
