// The rename to Silo Harness: the moves on first launch (the config folder, moved and linked; the data folder, moved),
// what is left alone (the new folder already there, the old one a link, a rename that fails), the resolvers of the
// config and project folders, and the variables read under their new names first and their old ones after. Every
// folder is a temporary one: your own home is never read. Run: node test/rename.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { moveConfigDir, moveDataFolder, carryOverOlderDataFolder } = require(path.join(projectDir, 'dist/main/migrate.js'));
const paths = require(path.join(projectDir, 'dist/main/paths.js'));
const { check, done } = require('./support/check.js');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-rename-')));
let n = 0;
const fresh = () => {
  const d = path.join(root, `h${++n}`);
  fs.mkdirSync(d);
  return d;
};
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const lines = [];
const log = (l) => lines.push(l);
const failing = () => {
  throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
};
// The tests set the config folder themselves
delete process.env.SILO_HARNESS_CONFIG_DIR;
delete process.env.OPEN_HARNESS_CONFIG_DIR;

// ---- the config folder ----
{
  const home = fresh();
  write(path.join(home, '.open-harness', 'settings.json'), '{"theme":"dark"}');
  write(path.join(home, '.open-harness', 'skills', 'x', 'SKILL.md'), 'skill');
  check('before the move, configDir() finds ~/.open-harness', paths.configDir(home) === path.join(home, '.open-harness'));
  const r = moveConfigDir(home, log);
  const linkAt = path.join(home, '.open-harness');
  check('config folder: moved', r === 'moved' && fs.readFileSync(path.join(home, '.silo-harness', 'settings.json'), 'utf8') === '{"theme":"dark"}' && fs.existsSync(path.join(home, '.silo-harness', 'skills', 'x', 'SKILL.md')), r);
  check('… and a link left at the old place, pointing at the new one', fs.lstatSync(linkAt).isSymbolicLink() && fs.realpathSync(linkAt) === path.join(home, '.silo-harness'));
  check('… through which the old path still reads the files', fs.readFileSync(path.join(linkAt, 'settings.json'), 'utf8') === '{"theme":"dark"}');
  check('… and configDir() is ~/.silo-harness', paths.configDir(home) === path.join(home, '.silo-harness'));
  check('… and the move is in the log', lines.some((l) => /moved .*\.open-harness to .*\.silo-harness/.test(l)) && lines.some((l) => /left a link/.test(l)), lines);
  const again = moveConfigDir(home, log);
  check('a second launch does nothing (the new folder is there, the old one a link)', again === 'exists' && fs.lstatSync(linkAt).isSymbolicLink(), again);
}
{
  const home = fresh();
  write(path.join(home, '.open-harness', 'settings.json'), 'old');
  write(path.join(home, '.silo-harness', 'settings.json'), 'new');
  const r = moveConfigDir(home, log);
  check('config folder: nothing done when ~/.silo-harness already exists', r === 'exists' && fs.readFileSync(path.join(home, '.open-harness', 'settings.json'), 'utf8') === 'old' && fs.readFileSync(path.join(home, '.silo-harness', 'settings.json'), 'utf8') === 'new' && !fs.lstatSync(path.join(home, '.open-harness')).isSymbolicLink(), r);
  check('… and configDir() is the new one', paths.configDir(home) === path.join(home, '.silo-harness'));
}
{
  const home = fresh();
  const elsewhere = path.join(home, 'dotfiles', 'open-harness');
  write(path.join(elsewhere, 'settings.json'), 'linked');
  fs.symlinkSync(elsewhere, path.join(home, '.open-harness'));
  const r = moveConfigDir(home, log);
  check('config folder: nothing done when ~/.open-harness is a link', r === 'not-a-folder' && !fs.existsSync(path.join(home, '.silo-harness')) && fs.lstatSync(path.join(home, '.open-harness')).isSymbolicLink() && fs.existsSync(path.join(elsewhere, 'settings.json')), r);
  check('… and configDir() keeps using it', paths.configDir(home) === path.join(home, '.open-harness'));
}
{
  const home = fresh();
  write(path.join(home, '.open-harness', 'settings.json'), 'stays');
  lines.length = 0;
  const r = moveConfigDir(home, log, failing);
  check('config folder: a rename that fails leaves the old folder as it was', r === 'failed' && fs.readFileSync(path.join(home, '.open-harness', 'settings.json'), 'utf8') === 'stays' && !fs.existsSync(path.join(home, '.silo-harness')), r);
  check('… configDir() keeps using ~/.open-harness for this run', paths.configDir(home) === path.join(home, '.open-harness'));
  check('… and the log says so', lines.some((l) => /could not move .*still using .*\.open-harness.*EPERM/.test(l)), lines);
}
{
  const home = fresh();
  check('config folder: nothing to do without an old one', moveConfigDir(home, log) === 'none' && !fs.existsSync(path.join(home, '.silo-harness')));
  check('… and configDir() is ~/.silo-harness for a new one', paths.configDir(home) === path.join(home, '.silo-harness'));
}

// ---- the data folder ----
{
  const support = fresh();
  const old = path.join(support, 'Open Harness');
  const next = path.join(support, 'Silo Harness');
  write(path.join(old, 'config.json'), '{"schemaVersion":2}');
  write(path.join(old, 'sessions', 's1.json'), '{"id":"s1"}');
  write(path.join(old, 'Preferences'), '{}');
  const ino = fs.statSync(path.join(old, 'sessions', 's1.json')).ino;
  lines.length = 0;
  const r = moveDataFolder(next, log);
  check('data folder: moved whole, Chromium files and all', r === 'moved' && fs.existsSync(path.join(next, 'config.json')) && fs.existsSync(path.join(next, 'Preferences')) && !fs.existsSync(old), r);
  check('… by a rename, not a copy (the session file is the same file)', fs.statSync(path.join(next, 'sessions', 's1.json')).ino === ino);
  check('… and the log says so', lines.some((l) => /moved .*Open Harness to .*Silo Harness/.test(l)), lines);
  check('a second launch does nothing', moveDataFolder(next, log) === 'exists' && fs.existsSync(path.join(next, 'config.json')));
}
{
  const support = fresh();
  const old = path.join(support, 'Open Harness');
  const next = path.join(support, 'Silo Harness');
  write(path.join(old, 'config.json'), 'old');
  fs.mkdirSync(next);
  check('data folder: an empty new folder (made before the app ran) counts as absent', moveDataFolder(next, log) === 'moved' && fs.readFileSync(path.join(next, 'config.json'), 'utf8') === 'old');
}
{
  const support = fresh();
  const old = path.join(support, 'Open Harness');
  const next = path.join(support, 'Silo Harness');
  write(path.join(old, 'config.json'), 'old');
  write(path.join(next, 'config.json'), 'new');
  const r = moveDataFolder(next, log);
  check('data folder: nothing done when the new one already holds files', r === 'exists' && fs.readFileSync(path.join(old, 'config.json'), 'utf8') === 'old' && fs.readFileSync(path.join(next, 'config.json'), 'utf8') === 'new', r);
}
{
  const support = fresh();
  const elsewhere = path.join(support, 'elsewhere');
  write(path.join(elsewhere, 'config.json'), 'linked');
  fs.symlinkSync(elsewhere, path.join(support, 'Open Harness'));
  const next = path.join(support, 'Silo Harness');
  const r = moveDataFolder(next, log);
  check('data folder: nothing done when the old one is a link', r === 'not-a-folder' && !fs.existsSync(next) && fs.lstatSync(path.join(support, 'Open Harness')).isSymbolicLink(), r);
}
{
  const support = fresh();
  const old = path.join(support, 'Open Harness');
  const next = path.join(support, 'Silo Harness');
  write(path.join(old, 'config.json'), 'stays');
  lines.length = 0;
  const r = moveDataFolder(next, log, failing);
  check('data folder: a rename that fails leaves the old folder as it was, and logs it', r === 'failed' && fs.readFileSync(path.join(old, 'config.json'), 'utf8') === 'stays' && lines.some((l) => /could not move/.test(l)), [r, lines]);
}
{
  const support = fresh();
  const profile = path.join(support, 'Open Harness');
  fs.mkdirSync(profile);
  check('data folder: a profile that has the old name itself is left alone', moveDataFolder(profile, log) === 'exists' && fs.existsSync(profile));
}
{
  // The older names still carry over into the new folder
  const support = fresh();
  write(path.join(support, 'OpenAgent', 'config.json'), 'agent');
  const next = path.join(support, 'Silo Harness');
  check('data folder: none under Open Harness, one under OpenAgent', moveDataFolder(next, log) === 'none');
  carryOverOlderDataFolder(next, log);
  check('… OpenAgent\'s config.json is carried into Silo Harness', fs.readFileSync(path.join(next, 'config.json'), 'utf8') === 'agent');
}

// ---- the project folder ----
{
  const proj = fresh();
  check('project folder: .silo-harness for a project with neither', paths.projectConfigDir(proj) === path.join(proj, '.silo-harness'));
  fs.mkdirSync(path.join(proj, '.open-harness'));
  check('… .open-harness when only it exists', paths.projectConfigDir(proj) === path.join(proj, '.open-harness'));
  fs.mkdirSync(path.join(proj, '.silo-harness'));
  check('… .silo-harness when both exist', paths.projectConfigDir(proj) === path.join(proj, '.silo-harness'));
  const settings = require(path.join(projectDir, 'dist/main/settings.js'));
  const proj2 = fresh();
  fs.mkdirSync(path.join(proj2, '.open-harness'));
  check('… a project settings.json under .open-harness is still found', settings.projectSettingsPath(proj2) === path.join(proj2, '.open-harness', 'settings.json'));
}

// ---- the variables ----
{
  const env = (o) => paths.configDirOverride(o);
  check('SILO_HARNESS_CONFIG_DIR names the config folder', env({ SILO_HARNESS_CONFIG_DIR: '/tmp/a' }) === path.resolve('/tmp/a'));
  check('OPEN_HARNESS_CONFIG_DIR still does when the new one is unset', env({ OPEN_HARNESS_CONFIG_DIR: '/tmp/b' }) === path.resolve('/tmp/b'));
  check('… and the new one wins when both are set', env({ SILO_HARNESS_CONFIG_DIR: '/tmp/a', OPEN_HARNESS_CONFIG_DIR: '/tmp/b' }) === path.resolve('/tmp/a'));
  check('… an empty new one falls back to the old', env({ SILO_HARNESS_CONFIG_DIR: ' ', OPEN_HARNESS_CONFIG_DIR: '/tmp/b' }) === path.resolve('/tmp/b'));
  check('neither: no override', env({}) === null);
  check('envVar: CLI_LINK_DIR new first, old after', paths.envVar('CLI_LINK_DIR', { SILO_HARNESS_CLI_LINK_DIR: 'n', OPEN_HARNESS_CLI_LINK_DIR: 'o' }) === 'n' && paths.envVar('CLI_LINK_DIR', { OPEN_HARNESS_CLI_LINK_DIR: 'o' }) === 'o' && paths.envVar('CLI_LINK_DIR', {}) === undefined);
  const a = fresh();
  process.env.OPEN_HARNESS_CONFIG_DIR = a;
  check('configDir() follows OPEN_HARNESS_CONFIG_DIR', paths.configDir() === a);
  const b = fresh();
  process.env.SILO_HARNESS_CONFIG_DIR = b;
  check('… and SILO_HARNESS_CONFIG_DIR over it', paths.configDir() === b);
  delete process.env.SILO_HARNESS_CONFIG_DIR;
  delete process.env.OPEN_HARNESS_CONFIG_DIR;
}
{
  // The command reads both names too
  const bin = path.join(projectDir, 'bin', 'silo.js');
  const run = (env) => spawnSync(process.execPath, [bin, 'config', 'path', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: fresh(), ...env } });
  const conf = fresh();
  const data = fresh();
  const oldNames = JSON.parse(run({ OPEN_HARNESS_CONFIG_DIR: conf, OPEN_HARNESS_USER_DATA: data }).stdout || '{}');
  const s = JSON.stringify(oldNames);
  check('silo config path: the old variables still name the folders', s.includes(conf) && s.includes(data), oldNames);
  const conf2 = fresh();
  const data2 = fresh();
  const both = JSON.stringify(JSON.parse(run({ SILO_HARNESS_CONFIG_DIR: conf2, SILO_HARNESS_USER_DATA: data2, OPEN_HARNESS_CONFIG_DIR: conf, OPEN_HARNESS_USER_DATA: data }).stdout || '{}'));
  check('… and the new ones win', both.includes(conf2) && both.includes(data2) && !both.includes(conf) && !both.includes(data), both);
  // A home with only the old folders: the command finds them (the app has not started since the rename)
  const home = fresh();
  fs.mkdirSync(path.join(home, '.open-harness'));
  fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'Open Harness'), { recursive: true });
  const r = spawnSync(process.execPath, [bin, 'config', 'path', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  const out = r.stdout || '';
  check('… a home with only the old folders: the command uses them', out.includes(path.join(home, '.open-harness')) && out.includes(path.join('Application Support', 'Open Harness')), out);
  fs.mkdirSync(path.join(home, '.silo-harness'));
  fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'Silo Harness'));
  const out2 = spawnSync(process.execPath, [bin, 'config', 'path', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } }).stdout || '';
  check('… and the new ones once they are there', out2.includes(path.join(home, '.silo-harness')) && out2.includes(path.join('Application Support', 'Silo Harness')), out2);
}
{
  // The terminal sets the new names and the old ones
  const term = fs.readFileSync(path.join(projectDir, 'dist', 'main', 'terminal.js'), 'utf8');
  check('the terminal sets SILO_HARNESS_TERMINAL and OPEN_HARNESS_TERMINAL', /SILO_HARNESS_TERMINAL = '1'/.test(term) && /OPEN_HARNESS_TERMINAL = '1'/.test(term));
}

fs.rmSync(root, { recursive: true, force: true });
done();
