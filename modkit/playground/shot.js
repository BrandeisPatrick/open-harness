#!/usr/bin/env node
/*
 * Screenshots of mods, taken in a hidden Electron window against the playground.
 *
 *   node modkit/playground/shot.js [mod ...|all] [--states empty,busy,full] [--schemes light,dark] [--out DIR] [--mods DIR] [--page]
 *
 * Writes <out>/<mod>-<state>-<scheme>.png (the rail at 300 px; --page: the whole playground at 1440×900) and prints,
 * per shot, whether any call was denied for a missing permission or the page threw. Exits 1 when one was.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { start, listMods } = require('./serve.js');

const ROOT = path.join(__dirname, '..', '..');

function parse(argv) {
  const o = { mods: [], states: ['empty', 'busy', 'full'], schemes: ['light', 'dark'], out: path.join(process.cwd(), 'shots'), modsDir: path.join(ROOT, 'mods'), page: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--states') o.states = argv[++i].split(',');
    else if (a === '--schemes') o.schemes = argv[++i].split(',');
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--mods') o.modsDir = path.resolve(argv[++i]);
    else if (a === '--page') o.page = true;
    else o.mods.push(a);
  }
  return o;
}

function electronBinary() {
  // The electron package's main export is the path of its binary
  try { return require(path.join(ROOT, 'node_modules', 'electron')); } catch (e) { /* fall through */ }
  return require('electron');
}

async function main() {
  const o = parse(process.argv.slice(2));
  const found = listMods(o.modsDir).filter((m) => m.valid).map((m) => m.folder);
  // No names: every valid mod, one shot each. "all": every mod together in one rail.
  const mods = o.mods.length ? o.mods : found;
  const missing = mods.filter((m) => m !== 'all' && !found.includes(m));
  if (missing.length) { console.error('Not a valid mod: ' + missing.join(', ')); process.exit(2); }
  fs.mkdirSync(o.out, { recursive: true });

  const server = await start({ modsDir: o.modsDir });
  const jobs = [];
  for (const mod of mods) for (const state of o.states) for (const scheme of o.schemes) {
    const q = new URLSearchParams({ mod, state, scheme });
    if (!o.page) q.set('shot', '1');
    jobs.push({ url: server.url + '?' + q, file: path.join(o.out, `${mod}-${state}-${scheme}${o.page ? '-page' : ''}.png`), width: o.page ? 1440 : 300, height: o.page ? 900 : 0, label: `${mod} ${state} ${scheme}` });
  }

  const child = spawn(electronBinary(), [path.join(__dirname, 'shot-main.js')], {
    env: Object.assign({}, process.env, { SHOT_JOBS: JSON.stringify(jobs), ELECTRON_RUN_AS_NODE: '' }),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let failed = false;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let r;
      try { r = JSON.parse(line); } catch { if (line.trim()) console.log(line); continue; }
      const bad = r.error || r.denied.length || r.errors.length || r.timedOut;
      if (bad) failed = true;
      console.log(`${bad ? 'FAIL' : 'ok  '} ${r.label} → ${path.relative(process.cwd(), r.file) || r.file}` +
        (r.error ? ` | ${r.error}` : '') +
        (r.timedOut ? ' | timed out waiting for the views' : '') +
        (r.denied.length ? ` | denied: ${r.denied.map((d) => `${d.view} ${d.method} (${d.permission})`).join(', ')}` : '') +
        (r.errors.length ? ` | page errors: ${r.errors.map((e) => `${e.view}: ${e.message}`).join(' / ')}` : '') +
        ` | ${r.requests} requests`);
    }
  });
  const code = await new Promise((r) => child.on('exit', r));
  await server.close();
  if (code) { console.error('Electron exited with ' + code); process.exit(1); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
