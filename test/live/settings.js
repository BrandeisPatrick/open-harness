// Live check of the settings.json layer in the real app: the user file applies and is reported owned, a project
// file waits for approval, applies once trusted, stops applying after an edit, the user file is followed while the
// app runs, and config.json never receives an owned value.
// Run: npm run build && node test/live/settings.js [screenshot-dir]   (no model call is made)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  // Our own profile, so config.json can be read after the app quit; the rig's config directory is <profile>/home-config.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-profile-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-project-'));
  const home = path.join(profile, 'home-config');
  const userFile = path.join(home, 'settings.json');
  const projectFile = path.join(project, '.openagent', 'settings.json');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify({ maxTurns: 17, theme: 'dark' }));
  const cfg = () => app.evaluate('window.oc.getConfig()');
  const info = () => app.evaluate("window.oc.rpc('settings.info')");
  const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v || Date.now() > end) return v;
      await sleep(100);
    }
  };
  let app;
  try {
    app = await launch({ profile, project });
    let c = await cfg();
    let i = await info();
    check('user settings.json applies', c.maxTurns === 17 && c.theme === 'dark', { maxTurns: c.maxTurns, theme: c.theme });
    check('settings.info reports them owned by the user file', i.owned.maxTurns === 'user' && i.owned.theme === 'user', i.owned);
    const theme = await app.evaluate('document.documentElement.dataset.theme');
    check('the window follows the theme', theme === 'dark', theme);
    await app.screenshot(path.join(shots, 'settings-1-user-dark.png'));

    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, JSON.stringify({ permissionMode: 'bypass', systemPromptExtra: 'LIVE-PROJECT-EXTRA' }));
    i = await until(async () => {
      const x = await info();
      return x.files[1].exists ? x : null;
    });
    c = await cfg();
    check('a new project file is seen without a restart', Boolean(i && i.files[1].exists), i && i.files[1]);
    check('… and is NOT applied', c.permissionMode === 'ask' && c.systemPromptExtra === '', { mode: c.permissionMode });
    check('… the info says it needs approval', i && !i.files[1].trusted && !i.files[1].applied && i.files[1].keys.sort().join() === 'permissionMode,systemPromptExtra');

    i = await app.evaluate("window.oc.rpc('settings.trustProject', true)");
    c = await cfg();
    check('trusted: it applies', c.permissionMode === 'bypass' && c.systemPromptExtra === 'LIVE-PROJECT-EXTRA' && i.files[1].applied && i.owned.permissionMode === 'project');
    const chip = await until(async () => {
      const t = await app.text('#mode-btn');
      return /bypass/i.test(t || '') ? t : null;
    });
    check('the mode chip follows', Boolean(chip), await app.text('#mode-btn'));

    fs.writeFileSync(projectFile, JSON.stringify({ permissionMode: 'bypass', systemPromptExtra: 'EDITED' }));
    c = await until(async () => {
      const x = await cfg();
      return x.permissionMode === 'ask' ? x : null;
    });
    i = await info();
    check('edited: it stops applying', c && c.permissionMode === 'ask' && c.systemPromptExtra === '', c && c.permissionMode);
    check('edited: the info says changed', i.files[1].changed === true && !i.files[1].applied);

    const t0 = Date.now();
    fs.writeFileSync(userFile, JSON.stringify({ maxTurns: 18, theme: 'dark' }));
    c = await until(async () => {
      const x = await cfg();
      return x.maxTurns === 18 ? x : null;
    }, 4000);
    check('the user file is followed while the app runs', c && c.maxTurns === 18, `${Date.now() - t0} ms`);
    check('within a couple of seconds', Date.now() - t0 < 2500, `${Date.now() - t0} ms`);

    // A save from the window of a non-owned field, with the owned values in the copy it sends.
    const before = await cfg();
    await app.evaluate(`window.oc.setConfig(${JSON.stringify({ ...before, autoCompact: false })})`).catch(() => undefined);
    await app.screenshot(path.join(shots, 'settings-2-after.png'));
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    if (app) await app.close();
  }
  const stored = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  check('config.json holds no owned value', stored.maxTurns !== 17 && stored.maxTurns !== 18 && stored.theme !== 'dark' && stored.permissionMode !== 'bypass' && !String(stored.systemPromptExtra || '').includes('LIVE') && stored.systemPromptExtra !== 'EDITED', { maxTurns: stored.maxTurns, theme: stored.theme, mode: stored.permissionMode });
  check('config.json was written (the trust is kept there)', Object.keys(stored.settingsTrusted || {}).length === 1);
  check('a save from the window kept its non-owned change', stored.autoCompact === false);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})();
