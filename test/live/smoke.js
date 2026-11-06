// Live smoke test: the real window, a real model call with a tool, an approval card, and a screenshot.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/smoke.js [screenshot-dir]
// Without a key it runs against the mock model (which cannot call tools, so the tool checks are skipped).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker } = require('./rig.js');

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const app = await launch({ mode: 'ask' });
  try {
    check('the window loads with an empty session', await app.exists('#empty-state'));
    check('the composer shows the configured model', /haiku|mock/i.test((await app.text('#model-btn')) || ''), await app.text('#model-btn'));
    await app.screenshot(path.join(shots, 'smoke-1-empty.png'));

    if (app.live) {
      await app.send('Create a file named hello.txt in the working directory containing exactly the text: live test ok. Then reply with the single word DONE.');
      await app.approve('allow');
      await app.waitIdle(120_000);
      const file = path.join(app.project, 'hello.txt');
      check('the model wrote the file through write_file', fs.existsSync(file) && /live test ok/.test(fs.readFileSync(file, 'utf8')), fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'missing');
      check('an approval card was answered', (await app.count('.approval .decided, .approval.decided')) >= 1);
      check('a tool row is shown', (await app.count('.tool')) >= 1);
      check('the reply arrives', /DONE/i.test(await app.lastReply()), await app.lastReply());
    } else {
      await app.send('Hello');
      await app.waitIdle(30_000);
      check('the mock model replies', (await app.lastReply()).length > 0, await app.lastReply());
    }
    check('the session appears in the sidebar', (await app.count('.session-item')) >= 1);
    await app.screenshot(path.join(shots, 'smoke-2-run.png'));
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${shots}`);
  } finally {
    await app.close();
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
