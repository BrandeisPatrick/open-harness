// Writing mod folders: the starter a "New mod" creates, installing from a folder or a Git URL, and copying a
// bundled mod into the user folder to customise it. Everything that lands is validated with the same rules as
// any other mod, and a user or project mod starts off.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModManifest, ModSeat } from '../../shared/mods';
import { MOD_ID_RE, readManifest } from './manifest';
import { MOD_SEATS } from './permissions';

const GIT_TIMEOUT_MS = 90_000;

export class ManageError extends Error {}

/** The starter manifest and page for a seat: something real (the session's title and a counter kept in storage) to edit. */
export function starterFiles(id: string, name: string, seat: ModSeat): { manifest: ModManifest; page: string } {
  const manifest: ModManifest = {
    protocol: 1,
    id,
    name,
    version: '0.1.0',
    description: seat === 'background' ? 'A slowly moving gradient behind the app.' : 'Shows the session on screen and a counter kept in harness.storage.',
    permissions: seat === 'background' ? [] : ['session:read'],
    contributes: { views: [{ id: 'main', title: name, entry: 'index.html', seat, ...(seat === 'rail' ? { order: 100 } : {}) }] },
  };
  if (!manifest.permissions!.length) delete manifest.permissions;
  if (seat === 'background') {
    return {
      manifest,
      page: `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/@harness/harness.css">
<style>
  /* A background takes no clicks: draw something calm with the app's own tokens so it suits light and dark. */
  html, body { height: 100%; margin: 0; }
  body {
    background: radial-gradient(circle at 20% 30%, color-mix(in srgb, var(--accent) 35%, transparent), transparent 55%),
      radial-gradient(circle at 80% 70%, color-mix(in srgb, var(--success) 25%, transparent), transparent 50%), var(--bg-100);
    background-size: 160% 160%;
    animation: drift 40s ease-in-out infinite alternate;
  }
  @keyframes drift { from { background-position: 0% 0%; } to { background-position: 100% 100%; } }
</style>
<script src="/@harness/harness.js"></script>
`,
    };
  }
  const compact = seat === 'composer';
  return {
    manifest,
    page: `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/@harness/harness.css">
${
      compact
        ? '<div class="h-row"><span class="h-label" id="title">…</span><span class="h-value" id="count">0</span><button class="h-btn sm ghost" id="bump">+1</button></div>'
        : '<div class="h-row"><span class="h-label">Session</span><span class="h-value" id="title">…</span></div>\n<div class="h-row"><span class="h-label">Clicks</span><span class="h-value" id="count">0</span></div>\n<button class="h-btn sm" id="bump">Add one</button>'
    }
<script src="/@harness/harness.js"></script>
<script>
  // The page talks to the app only through \`harness\`: it has no localStorage and no network.
  const $ = (id) => document.getElementById(id);
  let count = 0;

  // session:read (in mod.json) lets the page see the session on screen. Handle "nothing to show" too.
  async function showSession() {
    try {
      const s = await harness.session.get();
      $('title').textContent = s.title || 'Untitled';
    } catch {
      $('title').textContent = 'No session open';
    }
  }

  harness.ready.then(async () => {
    // harness.storage keeps JSON values for this mod across sessions and restarts.
    count = await harness.storage.get('count', 0);
    $('count').textContent = count;
    showSession();
  });

  $('bump').addEventListener('click', async () => {
    count += 1;
    $('count').textContent = count;
    await harness.storage.set('count', count);
  });

  // The session on screen changed (another one was opened, or this one was renamed).
  harness.on('session.changed', showSession);
</script>
`,
  };
}

/** Writes a starter mod into `root/<id>`; refuses an id that is taken there. */
export function createMod(root: string, input: { id: unknown; name: unknown; seat: unknown }): string {
  const id = String(input.id ?? '').trim();
  const name = String(input.name ?? '').trim();
  const seat = input.seat as ModSeat;
  if (!MOD_ID_RE.test(id)) throw new ManageError('The id must be 2 to 40 lower-case letters, digits and -, starting with a letter.');
  if (!name) throw new ManageError('Give the mod a name.');
  if (!MOD_SEATS.includes(seat)) throw new ManageError(`The seat must be one of ${MOD_SEATS.join(', ')}.`);
  const dir = path.join(root, id);
  if (fs.existsSync(dir)) throw new ManageError(`There is already a folder ${dir}.`);
  const { manifest, page } = starterFiles(id, name.slice(0, 80), seat);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), page);
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

/** Whether `source` names a Git repository rather than a folder */
export function isGitUrl(source: string): boolean {
  return /^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/i.test(source.trim());
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 1024 * 1024 },
      (err, _out, stderr) => {
        if (!err) return resolve();
        const timedOut = (err as { killed?: boolean }).killed;
        reject(new ManageError(timedOut ? `git clone took longer than ${GIT_TIMEOUT_MS / 1000} s and was stopped.` : `git clone failed: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      },
    );
  });
}

/**
 * Installs a mod into `root` from a folder (copied) or a Git URL (cloned, shallow, without hooks or other
 * transports). Refuses ids in `taken`. Returns the new folder; the caller rescans.
 */
export async function installMod(root: string, source: string, taken: (id: string) => boolean): Promise<string> {
  const src = String(source ?? '').trim();
  if (!src) throw new ManageError('Give a folder or a Git URL.');
  fs.mkdirSync(root, { recursive: true });
  // Staged under a dot-folder in the root: the scanner never lists it, and the final move is a rename.
  const stage = path.join(root, `.install-${randomBytes(4).toString('hex')}`);
  try {
    if (isGitUrl(src)) {
      if (/^-/.test(src)) throw new ManageError('That is not a Git URL.');
      await run(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', 'clone', '--depth', '1', '--no-recurse-submodules', '--template=', '--', src, stage],
        root,
      );
    } else {
      const local = /^file:\/\//i.test(src) ? fileURLToPath(src) : src.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
      if (!path.isAbsolute(local)) throw new ManageError(`Give the full path of the mod's folder (or an https/ssh Git URL), not ${src}.`);
      const from = path.resolve(local);
      let st: fs.Stats;
      try {
        st = fs.statSync(from);
      } catch {
        throw new ManageError(`${from} does not exist.`);
      }
      if (!st.isDirectory()) throw new ManageError(`${from} is not a folder.`);
      if (!fs.existsSync(path.join(from, 'mod.json'))) throw new ManageError(`${from} has no mod.json, so it is not a mod.`);
      fs.cpSync(from, stage, { recursive: true, filter: (p) => path.basename(p) !== 'node_modules' });
    }
    let id = '';
    try {
      id = String((JSON.parse(fs.readFileSync(path.join(stage, 'mod.json'), 'utf8')) as { id?: unknown }).id ?? '');
    } catch {
      throw new ManageError('The mod has no readable mod.json.');
    }
    if (!MOD_ID_RE.test(id)) throw new ManageError(`mod.json has no valid id (found ${JSON.stringify(id)}).`);
    const r = readManifest(stage, id);
    if (!r.manifest) throw new ManageError(`The mod is not valid:\n${r.problems.map((p) => `- ${p.message}`).join('\n')}`);
    if (taken(id) || fs.existsSync(path.join(root, id))) throw new ManageError(`A mod with the id "${id}" is already installed.`);
    fs.renameSync(stage, path.join(root, id));
    return path.join(root, id);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Copies a bundled mod's folder into the user folder, where it replaces the bundled one. */
export function customiseMod(from: string, root: string, id: string): string {
  const to = path.join(root, id);
  if (fs.existsSync(to)) throw new ManageError(`There is already a user mod ${id} at ${to}.`);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  return to;
}
