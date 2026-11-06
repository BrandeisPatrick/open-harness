// Live check of the first launch after a rename. Part 1: a data folder left by an earlier name of the app (OpenAgent)
// sits beside the new one. Its settings, sessions and artifacts are moved over and show up in the window; what the
// app never wrote stays behind; a second launch finds everything in place and moves nothing. Both folders are made
// in a temp directory: your own data folders are never read. Part 2, the rename to Silo Harness: the whole
// "Open Harness" data folder is renamed, and ~/.open-harness (in a temporary home) becomes ~/.silo-harness with a
// link left at the old place.
//
//   npm run build && node test/live/carry-over.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

(async () => {
  const { check, done } = checker();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-carry-')));
  const old = path.join(tmp, 'OpenAgent');
  const next = path.join(tmp, 'Silo Harness');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(old, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(old, 'artifacts', 'old-1'), { recursive: true });
  // The settings as the old app saved them. Nothing is sent to the model here, so the address leads nowhere.
  const config = {
    schemaVersion: 2,
    provider: 'portkey',
    portkey: { baseURL: 'http://127.0.0.1:9/v1', apiKey: '', model: 'carried-model', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    workingDirectory: project,
    permissionMode: 'plan',
    notifications: false,
    autoTitles: false,
  };
  fs.writeFileSync(path.join(old, 'config.json'), JSON.stringify(config));
  const at = Date.now() - 60_000;
  const session = {
    id: 'old-1',
    title: 'Carried over from OpenAgent',
    createdAt: at,
    updatedAt: at,
    titleLocked: true,
    messages: [
      { role: 'user', content: 'A question asked in the old app' },
      { role: 'assistant', content: 'An answer given in the old app.' },
    ],
  };
  fs.writeFileSync(path.join(old, 'sessions', 'old-1.json'), JSON.stringify(session));
  fs.writeFileSync(path.join(old, 'artifacts', 'old-1', 'kept.txt'), 'kept');
  fs.writeFileSync(path.join(old, 'Preferences'), '{}'); // Chromium's own file: not the app's to move

  const row = '.session-item[data-id="old-1"]';
  const opts = { profile: next, project, seed: false, mock: true, ownsProfile: false };
  let app = null;
  try {
    app = await launch(opts);
    await app.waitFor(`Boolean(document.querySelector(${JSON.stringify(row)}))`, 10_000, 'the carried-over session in the sidebar');
    check('the old session is in the sidebar under its title', (await app.text(`${row} .label`)) === session.title, await app.text(`${row} .label`));
    await app.click(row);
    await app.waitFor(`document.querySelectorAll('#messages .msg').length >= 2`, 10_000, 'its conversation');
    const shown = (await app.transcript()).map((e) => e.text).join('\n');
    check('its conversation is shown', shown.includes('A question asked in the old app') && shown.includes('An answer given in the old app.'), shown.slice(0, 200));
    const cfg = await app.evaluate(`window.oc.getConfig()`);
    check('the settings came along', cfg.permissionMode === 'plan' && cfg.portkey?.model === 'carried-model' && cfg.workingDirectory === project, { mode: cfg.permissionMode, model: cfg.portkey?.model });
    check('the files are in the new folder', fs.existsSync(path.join(next, 'config.json')) && fs.existsSync(path.join(next, 'sessions', 'old-1.json')) && fs.readFileSync(path.join(next, 'artifacts', 'old-1', 'kept.txt'), 'utf8') === 'kept');
    check('… and no longer in the old one', !fs.existsSync(path.join(old, 'config.json')) && !fs.existsSync(path.join(old, 'sessions')) && !fs.existsSync(path.join(old, 'artifacts')), fs.readdirSync(old));
    check('what the app never wrote stays behind', fs.existsSync(path.join(old, 'Preferences')));
    check('the move is in the log', app.logs.some((l) => /\[data\] moved .*OpenAgent/.test(l)), app.logs.filter((l) => /\[data\]/.test(l)).slice(0, 3));
    await app.close();
    app = null;

    // The second launch: the new folder is set up, so nothing is looked for or moved again.
    fs.mkdirSync(path.join(old, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(old, 'config.json'), JSON.stringify({ ...config, permissionMode: 'bypass' }));
    fs.writeFileSync(path.join(old, 'sessions', 'stale.json'), JSON.stringify({ ...session, id: 'stale', title: 'Must stay behind' }));
    app = await launch(opts);
    await app.waitFor(`Boolean(document.querySelector(${JSON.stringify(row)}))`, 10_000, 'the session after the second launch');
    await sleep(300);
    const again = await app.evaluate(`window.oc.getConfig()`);
    check('a second launch keeps the new folder as it is', again.permissionMode === 'plan' && !(await app.exists('.session-item[data-id="stale"]')) && fs.existsSync(path.join(old, 'sessions', 'stale.json')) && !app.logs.some((l) => /\[data\] moved/.test(l)), { mode: again.permissionMode });
    await app.close();
    app = null;

    // ---- Part 2: Open Harness → Silo Harness ----
    const support = path.join(tmp, 'support');
    const ohData = path.join(support, 'Open Harness');
    const shData = path.join(support, 'Silo Harness');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(ohData, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(ohData, 'config.json'), JSON.stringify({ ...config, permissionMode: 'acceptEdits' }));
    fs.writeFileSync(path.join(ohData, 'sessions', 'oh-1.json'), JSON.stringify({ ...session, id: 'oh-1', title: 'Carried over from Open Harness' }));
    fs.writeFileSync(path.join(ohData, 'Preferences'), '{}');
    fs.mkdirSync(path.join(home, '.open-harness', 'skills', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(home, '.open-harness', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: A skill from before the rename\n---\nDo it.');
    fs.writeFileSync(path.join(home, '.open-harness', 'OPENHARNESS.md'), '- Old user instructions\n');
    // No config-folder override (the rig sets one), and a home of its own, so the move happens in the temp folder
    const opts2 = { profile: shData, project, seed: false, mock: true, ownsProfile: false, env: { HOME: home, SILO_HARNESS_CONFIG_DIR: '', OPEN_HARNESS_CONFIG_DIR: '' } };
    app = await launch(opts2);
    const row2 = '.session-item[data-id="oh-1"]';
    await app.waitFor(`Boolean(document.querySelector(${JSON.stringify(row2)}))`, 10_000, 'the Open Harness session in the sidebar');
    check('rename: the Open Harness session is in the sidebar', (await app.text(`${row2} .label`)) === 'Carried over from Open Harness');
    check('rename: the data folder was renamed whole (Chromium files too) and the old one is gone', fs.existsSync(path.join(shData, 'config.json')) && fs.existsSync(path.join(shData, 'Preferences')) && !fs.existsSync(ohData));
    const cfg2 = await app.evaluate(`window.oc.getConfig()`);
    check('rename: the settings came along', cfg2.permissionMode === 'acceptEdits', cfg2.permissionMode);
    const linkAt = path.join(home, '.open-harness');
    check('rename: ~/.open-harness is now ~/.silo-harness', fs.existsSync(path.join(home, '.silo-harness', 'skills', 'mine', 'SKILL.md')) && fs.lstatSync(path.join(home, '.silo-harness')).isDirectory());
    check('rename: … with a link left at ~/.open-harness', fs.lstatSync(linkAt).isSymbolicLink() && fs.realpathSync(linkAt) === path.join(home, '.silo-harness'));
    const skills = await app.evaluate(`window.oc.skills.list()`);
    check('rename: the skill from ~/.open-harness is listed', Array.isArray(skills) && skills.some((k) => k.name === 'mine' && k.source === 'user'), skills && skills.map((k) => k.name));
    check('rename: the moves are in the log', app.logs.some((l) => /\[migrate\] moved .*Open Harness to .*Silo Harness/.test(l)) && app.logs.some((l) => /\[migrate\] left a link/.test(l)), app.logs.filter((l) => /migrate/.test(l)));
    await app.close();
    app = null;
    // A second launch: both new folders exist, nothing moves
    app = await launch(opts2);
    await app.waitFor(`Boolean(document.querySelector(${JSON.stringify(row2)}))`, 10_000, 'the session after the second launch');
    check('rename: a second launch moves nothing', !app.logs.some((l) => /\[migrate\]/.test(l)) && fs.lstatSync(linkAt).isSymbolicLink(), app.logs.filter((l) => /migrate/.test(l)));
  } catch (err) {
    check(`the run finished without an error: ${err.message}`, false, app ? app.logs.filter((l) => /migrate|data\]/.test(l)).concat(app.logs.slice(-4)) : undefined);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})();
