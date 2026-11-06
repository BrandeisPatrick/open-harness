// What "~" stands for in the paths the window shows (src/renderer/home.ts): the home folder the app reports, and a
// fallback for when it is not known. Run: node test/home.js
const path = require('node:path');
const fs = require('node:fs');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

(async () => {
  // The renderer compiles to ES modules; home.js imports nothing, so its source loads as a data: module.
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/home.js'), 'utf8');
  const { tilde, homeDir, setHomeDir } = await import('data:text/javascript,' + encodeURIComponent(src));

  // ---------- the home folder is not known (a module on its own) ----------
  check('unknown home: any /Users/<name> is ~', tilde('/Users/me/src/app') === '~/src/app' && tilde('/Users/me') === '~');
  check('unknown home: other roots stay', tilde('/var/folders/x/T/project') === '/var/folders/x/T/project' && tilde('/home/me/app') === '/home/me/app' && tilde('relative/path') === 'relative/path');
  check('unknown home: the folder a path sits in is taken as home', homeDir('/Users/me/src/app') === '/Users/me' && homeDir('/home/dev/app') === '/home/dev' && homeDir('/tmp/x') === '' && homeDir() === '');

  // ---------- the app reported it ----------
  setHomeDir('/Users/me/');
  check('known home: paths inside it are shortened', tilde('/Users/me/src/app') === '~/src/app' && tilde('/Users/me') === '~');
  check('known home: another user\'s folder, and the shared one, are not', tilde('/Users/other/src') === '/Users/other/src' && tilde('/Users/Shared/code') === '/Users/Shared/code');
  check('known home: a folder that only starts with the same letters is not', tilde('/Users/me2/src') === '/Users/me2/src' && tilde('/Users/meow') === '/Users/meow');
  check('known home: homeDir ignores the hint', homeDir('/Users/other/app') === '/Users/me' && homeDir() === '/Users/me');

  // A home outside /Users (a test profile, another system): still "~"
  setHomeDir('/private/var/folders/2b/T/demo-home');
  check('a home anywhere on disk works', tilde('/private/var/folders/2b/T/demo-home/code/atlas-api') === '~/code/atlas-api' && tilde('/Users/me/x') === '/Users/me/x');

  setHomeDir('not-a-path');
  check('something that is not an absolute path is ignored', homeDir() === '' && tilde('/Users/me/x') === '~/x');
  setHomeDir(undefined);
  check('nothing at all is safe', tilde(undefined) === '' && tilde('') === '' && homeDir() === '');

  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
