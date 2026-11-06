// Live: the history log survives a hard kill. A run is killed with SIGKILL while its tool runs; the relaunched app
// has the user message and the tool call, shows the "restored" notice, and takes a follow-up. Then the session is
// deleted (gone from the sidebar) and brought back with history.restore.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/history.js [screenshot-dir]
// Without a key the mock model cannot call tools, so the crash happens while it streams instead.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  let app = await launch({ mode: 'bypass' });
  let id = '';
  try {
    console.log(app.live ? 'model: the real API' : 'model: the mock (no key)');
    id = (await app.evaluate('oc.sessions.current()')).id;
    if (app.live) {
      await app.send('Use the bash tool to run exactly this command: sleep 5 && echo slept. After it finishes, reply with one short sentence.');
      await app.waitFor(`oc.rpc('sessions.live', ${JSON.stringify(id)}).then((l) => l.tools.some((t) => t.name === 'bash'))`, 60_000, 'the bash call to start');
    } else {
      // The mock answers at once, so its reply is held back: the kill has to land while the run is still going.
      app.mock.state.replies.push({ content: 'Hello!', delayMs: 20_000 });
      await app.send('Hello there');
      await sleep(300);
    }
    await sleep(800);
    await app.screenshot(path.join(shots, 'history-1-before-kill.png'));
    await app.kill();
    const logFile = path.join(app.profile, 'history', `${id}.jsonl`);
    const types = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type) : [];
    check('the log on disk has the user message and the run start', types.includes('message.append') && types.includes('run.start'), types.join(' '));
    if (app.live) check('the log on disk has the tool start, and no run end', types.includes('tool.start') && !types.includes('run.end'), types.join(' '));

    app = await app.relaunch();
    await app.waitFor(`document.querySelector('.session-item[data-id=${JSON.stringify(id)}]')`, 10_000, 'the session in the sidebar');
    await app.click(`.session-item[data-id=${JSON.stringify(id)}]`);
    await app.waitFor(`[...document.querySelectorAll('.msg.system')].some((e) => /restored after the app closed unexpectedly/.test(e.innerText))`, 10_000, 'the restored notice');
    const items = await app.transcript();
    const texts = items.map((i) => i.text).join('\n');
    check('the user message is there', /sleep 5|Hello there/.test(texts), items.map((i) => i.cls));
    if (app.live) check('the tool call is there, marked interrupted', items.some((i) => /\btool\b/.test(i.cls) && /bash|sleep/.test(i.text)) && /interrupted/i.test(JSON.stringify(await app.evaluate(`oc.rpc('sessions.transcript', ${JSON.stringify(id)})`))));
    check('the notice is shown once', items.filter((i) => /restored after the app closed unexpectedly/.test(i.text)).length === 1);
    await app.evaluate(`document.documentElement.dataset.theme = 'light'`);
    await sleep(200);
    await app.screenshot(path.join(shots, 'history-2-restored-light.png'));
    await app.evaluate(`document.documentElement.dataset.theme = 'dark'`);
    await sleep(200);
    await app.screenshot(path.join(shots, 'history-2-restored-dark.png'));
    await app.evaluate(`document.documentElement.dataset.theme = 'light'`);

    await app.send('Reply with just the word OK.');
    await app.waitIdle(120_000);
    check('a follow-up works', (await app.lastReply()).length > 0, await app.lastReply());
    await app.screenshot(path.join(shots, 'history-3-follow-up.png'));
    const before = (await app.evaluate(`oc.rpc('sessions.transcript', ${JSON.stringify(id)})`)).length;

    // Delete through the sidebar's menu (the confirm answered yes), then restore through the RPC
    await app.evaluate('window.confirm = () => true');
    await app.click(`.session-item[data-id=${JSON.stringify(id)}] .row-more`);
    await app.waitFor(`[...document.querySelectorAll('[role=menuitem], .menu-item, button')].some((e) => e.innerText.trim() === 'Delete')`, 5_000, 'the Delete item');
    await app.evaluate(`[...document.querySelectorAll('[role=menuitem], .menu-item, button')].find((e) => e.innerText.trim() === 'Delete').click()`);
    await app.waitFor(`!document.querySelector('.session-item[data-id=${JSON.stringify(id)}]')`, 10_000, 'the session to leave the sidebar');
    check('the deleted session is gone from the sidebar', !(await app.exists(`.session-item[data-id=${JSON.stringify(id)}]`)));
    const trash = await app.evaluate(`oc.rpc('history.trash')`);
    check('it is in the trash', trash.some((e) => e.id === id), trash);
    const meta = await app.evaluate(`oc.rpc('history.restore', ${JSON.stringify(id)})`);
    check('history.restore returns its meta', meta && meta.id === id && meta.messageCount > 0, meta);
    await app.waitFor(`document.querySelector('.session-item[data-id=${JSON.stringify(id)}]')`, 10_000, 'the session back in the sidebar');
    check('it is back in the sidebar', true);
    await app.click(`.session-item[data-id=${JSON.stringify(id)}]`);
    await sleep(1200); // past the transcript's fade-in, for the screenshot
    const after = (await app.evaluate(`oc.rpc('sessions.transcript', ${JSON.stringify(id)})`)).length;
    check('with its messages', after === before && (await app.count('.msg.user')) >= 2, { before, after });
    await app.screenshot(path.join(shots, 'history-4-restored-from-trash.png'));
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
