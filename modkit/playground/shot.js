#!/usr/bin/env node
/*
 * Screenshots of mods, taken in a hidden Electron window against the playground.
 *
 *   node modkit/playground/shot.js [mod ...|all] [--states empty,busy,full] [--schemes light,dark] [--out DIR] [--mods DIR] [--page]
 *     [--width PX] [--height PX] [--model ok|slow|hold|nokey|unreachable] [--eval JS] [--wait MS] [--tag NAME]
 *
 * Writes <out>/<mod>-<state>-<scheme>[-<tag>].png and prints, per shot, whether any call was denied for a missing
 * permission or the page threw. Exits 1 when one was.
 *   The rail at 300 px; a mod whose only views are tabs: the side pane at 640×760 (--width / --height change it);
 *   --page: the whole playground at 1440×900.
 *   --model sets how the playground's model answers (hold: it streams a little, then waits).
 *   --eval runs JS in every mod frame once the views are settled (clicks, typing), then waits for the traffic to go
 *   quiet again (at least --wait ms, default 400) before the picture. The script may return a promise.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { start, listMods } = require('./serve.js');

const ROOT = path.join(__dirname, '..', '..');

function parse(argv) {
  const o = { mods: [], states: ['empty', 'busy', 'full'], schemes: ['light', 'dark'], out: path.join(process.cwd(), 'shots'), modsDir: path.join(ROOT, 'mods'), page: false, width: 0, height: 0, model: '', evalJs: '', wait: 400, tag: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--states') o.states = argv[++i].split(',');
    else if (a === '--schemes') o.schemes = argv[++i].split(',');
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--mods') o.modsDir = path.resolve(argv[++i]);
    else if (a === '--page') o.page = true;
    else if (a === '--width') o.width = Number(argv[++i]) || 0;
    else if (a === '--height') o.height = Number(argv[++i]) || 0;
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--eval') o.evalJs = argv[++i];
    else if (a === '--wait') o.wait = Number(argv[++i]) || 0;
    else if (a === '--tag') o.tag = argv[++i];
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
  const listed = listMods(o.modsDir).filter((m) => m.valid);
  const found = listed.map((m) => m.folder);
  const views = (folder) => { const m = listed.find((x) => x.folder === folder); return (m && m.manifest.contributes && m.manifest.contributes.views) || []; };
  const tabOnly = (folder) => folder !== 'all' && views(folder).length > 0 && views(folder).every((v) => v.seat !== 'rail') && views(folder).some((v) => v.seat === 'tab');
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
    if (o.model) q.set('model', o.model);
    const tab = !o.page && tabOnly(mod);
    const width = o.width || (o.page ? 1440 : tab ? 640 : 300);
    const height = o.height || (o.page ? 900 : tab ? 760 : 0);
    const tag = (o.page ? '-page' : '') + (o.tag ? '-' + o.tag : '');
    jobs.push({ url: server.url + '?' + q, file: path.join(o.out, `${mod}-${state}-${scheme}${tag}.png`), width, height, evalJs: o.evalJs, wait: o.wait, label: `${mod} ${state} ${scheme}${o.tag ? ' ' + o.tag : ''}` });
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
