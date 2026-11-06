// Writes the GitHub release notes for a version from CHANGELOG.md (see docs/releasing.md).
//
//   npm run dist                                   (the DMG and zip must be in release/)
//   node scripts/release-notes.js <version> [out]  default: prints the notes
//
// The notes are the "## <version>" section of the changelog with three changes: links to files in the repository
// point at the current commit, so they work in a draft before the tag exists; the README's hero screenshot sits
// under the opening paragraph; and an Install section gives the size and SHA-256 of both downloads. The "Not
// notarized" line under Known limits is left out because Install says it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const [version, out] = process.argv.slice(2);
if (!version) {
  console.error('usage: node scripts/release-notes.js <version> [out-file]');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const slug = String(pkg.repository?.url ?? pkg.repository ?? '')
  .replace(/^github:/, '')
  .replace(/^(?:git\+)?https:\/\/github\.com\//, '')
  .replace(/\.git$/, '');
if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error('package.json has no GitHub repository');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const heading = `## ${version}\n`;
const start = changelog.indexOf(heading);
if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
const next = changelog.indexOf('\n## ', start + heading.length);
let body = changelog.slice(start + heading.length, next < 0 ? undefined : next).trim();

// Links to files in the repository, pinned to the commit
const blob = `https://github.com/${slug}/blob/${sha}/`;
body = body.replace(/\]\((?!https?:|#)([^)\s]+)\)/g, (_, rel) => `](${blob}${rel})`);
for (const [, url] of body.matchAll(/\]\((https:\/\/github\.com\/[^)]+)\)/g)) {
  if (!url.startsWith(blob)) continue;
  const rel = url.slice(blob.length).replace(/#.*$/, '');
  if (!fs.existsSync(path.join(root, rel))) throw new Error(`the notes link to a file that is not there: ${rel}`);
}

body = body.replace(/\n- Not notarized:[^\n]*/, '');

// The screenshot goes under the opening paragraph
const hero = 'docs/screenshots/hero.png';
if (!fs.existsSync(path.join(root, hero))) throw new Error(`missing ${hero}`);
const firstBreak = body.indexOf('\n\n');
const image = `![${pkg.build?.productName ?? 'Silo Harness'}](https://raw.githubusercontent.com/${slug}/${sha}/${hero})`;
body = firstBreak < 0 ? `${body}\n\n${image}` : `${body.slice(0, firstBreak)}\n\n${image}${body.slice(firstBreak)}`;

// Downloads
const files = [`Silo-Harness-${version}-arm64.dmg`, `Silo-Harness-${version}-arm64.zip`];
const rows = files.map((name) => {
  const file = path.join(root, 'release', name);
  if (!fs.existsSync(file)) throw new Error(`release/${name} is missing: run npm run dist first`);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return `| \`${name}\` | ${(fs.statSync(file).size / 1e6).toFixed(0)} MB | \`${hash}\` |`;
});
const install = [
  '### Install',
  '',
  `For Apple silicon Macs. Download \`${files[0]}\` below, open it and drag Silo Harness into Applications; the \`.zip\` holds the same app.`,
  '',
  'The app is not notarized: on first launch, open it once, then allow it in System Settings → Privacy & Security → Open Anyway.',
  '',
  '| File | Size | SHA-256 |',
  '| --- | --- | --- |',
  ...rows,
].join('\n');

const notes = `${body}\n\n${install}\n`;
if (out) fs.writeFileSync(out, notes);
else process.stdout.write(notes);
