// The bash tool: output and exit code, and that stopping a run (the abort signal) or a timeout ends the command
// together with everything it started. Run: node test/shell.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { bash } = require(path.join(projectDir, 'dist/main/tools/shell.js'));
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-shell-'));
  const ctx = (signal) => ({ cwd, signal, approve: async () => ({ ok: true }) });

  const plain = await bash.run({ command: 'echo hello && echo oops >&2 && exit 3' }, ctx());
  check('stdout, stderr and the exit code are reported', /hello/.test(plain.content) && /\[stderr\]\noops/.test(plain.content) && /\[exit code: 3\]/.test(plain.content), plain.content);

  const denied = await bash.run({ command: 'echo no' }, { cwd, approve: async () => ({ ok: false, message: 'Not permitted: test' }) });
  check('a denied command does not run', denied.content === 'Not permitted: test', denied.content);

  // Stop: the shell and the process it started are both gone, promptly.
  {
    const pidFile = path.join(cwd, 'child.pid');
    const ac = new AbortController();
    const started = Date.now();
    const pending = bash.run({ command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait` }, ctx(ac.signal));
    await sleep(400);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    check('the command started a child process', childPid > 0 && alive(childPid), childPid);
    ac.abort();
    const res = await pending;
    const took = Date.now() - started;
    check('stopping ends the command at once, not after its 30 seconds', took < 4000, took);
    check('the result says it was stopped', /\[exit code: stopped by the user\]/.test(res.content), res.content);
    await sleep(300);
    check('the process it started is gone too', !alive(childPid), childPid);
  }

  // A signal that is already aborted: the command is stopped straight away.
  {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const res = await bash.run({ command: 'sleep 20' }, ctx(ac.signal));
    check('an already-stopped run does not wait for the command', Date.now() - started < 4000 && /stopped by the user/.test(res.content), res.content);
  }

  // Timeout: same, with its own wording.
  {
    const pidFile = path.join(cwd, 'child2.pid');
    const started = Date.now();
    const res = await bash.run({ command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`, timeout_ms: 1000 }, ctx());
    const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    check('a timeout ends the command', Date.now() - started < 5000 && /\[exit code: killed \(timeout after 1000 ms\)\]/.test(res.content), res.content);
    await sleep(300);
    check('and what it started', !alive(childPid), childPid);
  }

  // A command that ignores SIGTERM is killed after the grace period.
  {
    const ac = new AbortController();
    const started = Date.now();
    const pending = bash.run({ command: `trap '' TERM; sleep 30` }, ctx(ac.signal));
    await sleep(300);
    ac.abort();
    await pending;
    check('a command that ignores the polite signal is killed anyway', Date.now() - started < 6000, Date.now() - started);
  }

  fs.rmSync(cwd, { recursive: true, force: true });
  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
