// The change tracker behind the Diff pane and the Outputs panel: snapshots, the changed-file list, diff and revert,
// with the project reached through a symlink (as /tmp and /var are on macOS) and files written into folders that did
// not exist when the snapshot was taken. Run: node test/changes.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { snapshotBeforeChange, listChanges, changedFileCount, diffOf, revertChange } = require(path.join(projectDir, 'dist/main/changes.js'));
const { check, done } = require('./support/check.js');

(async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-changes-')));
  const real = path.join(tmp, 'real');
  const link = path.join(tmp, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  const session = {};

  // An existing file, edited through the symlinked path
  fs.writeFileSync(path.join(real, 'a.txt'), 'one\ntwo\n');
  snapshotBeforeChange(session, path.join(link, 'a.txt'));
  fs.writeFileSync(path.join(link, 'a.txt'), 'one\ntwo\nthree\n');

  // A new file in a folder that does not exist yet when the snapshot is taken
  snapshotBeforeChange(session, path.join(link, 'new', 'deep', 'b.txt'));
  fs.mkdirSync(path.join(link, 'new', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(link, 'new', 'deep', 'b.txt'), 'x\ny\n');

  check('snapshot keys are real paths, also for a file whose folder did not exist', JSON.stringify(Object.keys(session.changes).sort()) === JSON.stringify([path.join(real, 'a.txt'), path.join(real, 'new', 'deep', 'b.txt')]), Object.keys(session.changes));

  let list = await listChanges(session, link);
  check('both files are listed with paths relative to the project', JSON.stringify(list.map((e) => e.relPath)) === JSON.stringify(['a.txt', 'new/deep/b.txt']), list.map((e) => e.relPath));
  const a = list.find((e) => e.relPath === 'a.txt');
  const b = list.find((e) => e.relPath === 'new/deep/b.txt');
  check('the edit counts one added line', a?.status === 'modified' && a.additions === 1 && a.deletions === 0, a);
  check('the new file counts as added', b?.status === 'added' && b.additions === 2, b);
  check('the count matches the list', changedFileCount(session, link) === 2);

  const diff = await diffOf(session, link, b.path);
  check('the diff of the new file is found by the path the list gave', diff.status === 'added' && diff.original === '' && diff.current === 'x\ny\n', { status: diff.status, relPath: diff.relPath });
  const viaLink = await diffOf(session, link, path.join(link, 'a.txt'));
  check('… and by the symlinked path', viaLink.original === 'one\ntwo\n' && viaLink.current === 'one\ntwo\nthree\n');

  list = await revertChange(session, link, b.path);
  check('reverting the new file removes it', !fs.existsSync(path.join(real, 'new', 'deep', 'b.txt')) && list.length === 1 && list[0].relPath === 'a.txt', list.map((e) => e.relPath));
  list = await revertChange(session, link, path.join(link, 'a.txt'));
  check('reverting the edit puts the text back', fs.readFileSync(path.join(real, 'a.txt'), 'utf8') === 'one\ntwo\n' && list.length === 0);

  // A session saved by an earlier version can hold a key that was never resolved (the path as written, through the link)
  const old = { changes: { [path.join(link, 'late', 'c.txt')]: { original: null } } };
  fs.mkdirSync(path.join(real, 'late'));
  fs.writeFileSync(path.join(real, 'late', 'c.txt'), 'c\n');
  list = await listChanges(old, link);
  check('an unresolved key from an older session still lists relative', list.length === 1 && list[0].relPath === 'late/c.txt' && list[0].path === path.join(real, 'late', 'c.txt'), list);
  const oldDiff = await diffOf(old, link, list[0].path);
  check('… and its diff and revert find the snapshot', oldDiff.status === 'added' && (await revertChange(old, link, list[0].path)).length === 0 && !fs.existsSync(path.join(real, 'late', 'c.txt')));

  // Outside the project the path stays absolute
  const outside = path.join(tmp, 'elsewhere.txt');
  const s2 = {};
  snapshotBeforeChange(s2, outside);
  fs.writeFileSync(outside, 'z\n');
  list = await listChanges(s2, link);
  check('a file outside the project keeps its full path', list.length === 1 && list[0].relPath === outside, list.map((e) => e.relPath));

  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
