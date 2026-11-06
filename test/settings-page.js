// The settings page's pure pieces (src/renderer/settings/model.ts): the search matcher, the field validators, the
// config patches, the mod permission words and chips, the settings.json state chip and the schedule helpers.
// The page itself needs a DOM: it is checked live by test/live/settings-page.js. Run: node test/settings-page.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

(async () => {
  // The window's modules are ES modules in a package without "type": a .mjs copy loads them without Node's warning.
  // model.js imports nothing at run time, so the copy stands alone.
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-settings-page-')), 'model.mjs');
  fs.copyFileSync(path.join(projectDir, 'dist/renderer/settings/model.js'), copy);
  const m = await import(pathToFileURL(copy).href);
  fs.rmSync(path.dirname(copy), { recursive: true, force: true });

  // --- sections ---------------------------------------------------------------
  check('fourteen sections in four groups', m.SECTIONS.length === 14 && new Set(m.SECTIONS.map((s) => s.group)).size === 4);
  check('section ids are recognised', m.isSectionId('mods') && !m.isSectionId('nope'));
  check('old targets map to sections', m.sectionForTarget('mcp-section') === 'mcp' && m.sectionForTarget('rules-section') === 'permissions' && m.sectionForTarget('mods') === 'mods');
  check('a field id is not a section (the page looks it up)', m.sectionForTarget('ollama-baseURL') === null);

  // --- search -----------------------------------------------------------------
  check('every word must start a word of the haystack', m.matchesQuery(['API key', 'Your gateway key'], 'api k') && !m.matchesQuery(['API key'], 'pi'));
  check('case and accents do not matter', m.matchesQuery(['Résumé settings'], 'RESUME'));
  check('keywords are searched', m.matchesQuery(['Keep awake', 'Stop this Mac', 'sleep caffeinate'], 'sleep'));
  check('an empty query matches everything', m.matchesQuery(['x'], '   '));
  check('nonsense matches nothing', !m.matchesQuery(['Theme', 'System follows'], 'zqxv'));
  check('punctuation splits words', m.matchesQuery(['settings.json file'], 'json'));

  // --- validators ---------------------------------------------------------------
  let p = m.parseInteger('0', 1, 500);
  check('max tool turns 0 is refused', !p.ok && /from 1 to 500/.test(p.error), p);
  p = m.parseInteger('abc', 2048, 1048576);
  check('"abc" is not a number', !p.ok && /whole number/.test(p.error), p);
  p = m.parseInteger('16,384', 2048, 1048576);
  check('thousands separators are allowed', p.ok && p.value === 16384, p);
  check('decimals are refused for whole numbers', !m.parseInteger('12.5', 1, 100).ok);
  check('an empty number is refused', !m.parseInteger(' ', 1, 100).ok);
  p = m.parseUrl('http://localhost:11434/v1/');
  check('a URL keeps its path without the trailing slash', p.ok && p.value === 'http://localhost:11434/v1', p);
  check('a URL needs http(s)', !m.parseUrl('ftp://x').ok && !m.parseUrl('localhost:11434').ok && !m.parseUrl('').ok);
  check('text is trimmed', m.parseText('  x ').value === 'x');

  // --- config paths ---------------------------------------------------------------
  const cfg = { portkey: { model: 'a', contextWindow: 1 }, maxTurns: 40 };
  check('getPath reads nested fields', m.getPath(cfg, 'portkey.model') === 'a' && m.getPath(cfg, 'maxTurns') === 40 && m.getPath(cfg, 'x.y') === undefined);
  check('patchFor sends only the field', JSON.stringify(m.patchFor('portkey.model', 'b')) === '{"portkey":{"model":"b"}}' && JSON.stringify(m.patchFor('maxTurns', 3)) === '{"maxTurns":3}');
  check('the permission mode keeps the legacy flag in step', JSON.stringify(m.patchFor('permissionMode', 'bypass')) === '{"permissionMode":"bypass","autoApprove":true}');
  check('compact steps: nearest offered value', m.nearestCompactStep(0.82) === 0.8 && m.nearestCompactStep(0.93) === 0.95 && m.nearestCompactStep('x') === 0.8);

  // --- mods ---------------------------------------------------------------------
  check('every permission has plain words', ['session:read', 'session:send', 'session:control', 'sessions:read', 'model', 'skills:read', 'config:read', 'config:write', 'schedules', 'remote', 'network'].every((k) => m.PERMISSION_WORDS[k] && m.PERMISSION_WORDS[k] !== k));
  check('chips: off, paused, invalid, problems, on', m.modChip({ state: 'off', problems: [] }).label === 'Off' && /Paused/.test(m.modChip({ state: 'paused', problems: [] }).label) && m.modChip({ state: 'invalid', problems: [] }).label === 'Problem' && m.modChip({ state: 'on', problems: [{}] }).label === 'Problem' && m.modChip({ state: 'on', problems: [] }) === null);
  const manifest = { name: 'Theme', permissions: ['config:read', 'network'], contributes: { styles: ['theme.css'] } };
  let sheet = m.grantSheet({ state: 'off', manifest, wants: [], wantsStyles: false, granted: [] });
  check('turning on lists what the manifest asks, in words', sheet.lines.length === 2 && /Reach the internet/.test(sheet.lines[1]) && /Turn on Theme/.test(sheet.title));
  check('… with the restyle and network warnings', sheet.warnings.length === 2 && /restyle the whole app/.test(sheet.warnings[0]) && /leave this Mac/.test(sheet.warnings[1]));
  sheet = m.grantSheet({ state: 'paused', manifest, wants: ['network'], wantsStyles: false, granted: ['config:read'] });
  check('a paused mod lists only what is new', sheet.lines.length === 1 && /wants more access/.test(sheet.title) && sheet.warnings.length === 1);
  check('a mod id from a name', m.deriveModId('Word count!') === 'word-count' && m.deriveModId('9 lives') === 'lives' && m.deriveModId('x') === 'x-mod' && m.deriveModId('') === '');
  check('mod ids are validated like the manifest', m.validModId('word-count') && !m.validModId('Word') && !m.validModId('a') && !m.validModId('1abc'));
  check('an SVG icon file is used as is; names and paths out are not', m.modIconFile('icon.svg') === 'icon.svg' && m.modIconFile('gauge') === null && m.modIconFile('../x.svg') === null);

  // --- settings.json state chip -------------------------------------------------------
  const f = (o) => ({ scope: 'project', path: '/p', exists: true, applied: false, trusted: false, keys: [], invalid: [], ...o });
  check('file states', m.fileState(f({ exists: false })).label === 'Not found' && m.fileState(f({ error: 'bad' })).label === 'Could not be read' && m.fileState(f({ changed: true, trusted: true })).label === 'Changed since you approved it' && m.fileState(f({})).label === 'Needs your approval' && m.fileState(f({ trusted: true, applied: true })).label === 'Applied' && m.fileState(f({ scope: 'user', applied: true, trusted: true })).label === 'Applied');

  // --- schedules -------------------------------------------------------------------
  let iso = m.localToIso('2026-11-06T09:00', 300);
  check('a local time gets its offset', iso.ok && iso.value === '2026-11-06T09:00:00-05:00', iso);
  iso = m.localToIso('2026-11-06T09:30', -330);
  check('… east of UTC too', iso.ok && iso.value === '2026-11-06T09:30:00+05:30', iso);
  check('a bad date is refused', !m.localToIso('tomorrow').ok);
  const base = new Date(2026, 10, 5, 12, 0).getTime();
  check('once: in the future only', !m.parseWhen('at', '2026-11-05T11:00', base).ok && m.parseWhen('at', '2026-11-05T13:00', base).value.kind === 'at');
  check('every: at least 5 minutes', !m.parseWhen('every', '2').ok && m.parseWhen('every', '30').value.minutes === 30);
  check('cron: five fields', m.parseWhen('cron', ' 0 9  * * 1-5 ').value.expr === '0 9 * * 1-5' && !m.parseWhen('cron', '0 9 * *').ok);
  check('dates in words', m.formatWhenAt(new Date(2026, 10, 5, 9, 5).getTime(), base) === 'Today at 09:05' && m.formatWhenAt(new Date(2026, 10, 6, 14, 0).getTime(), base) === 'Tomorrow at 14:00' && m.formatWhenAt(new Date(2026, 11, 24, 8, 0).getTime(), base) === 'Dec 24 at 08:00');
  check('relative days', m.relativeDays(base + 3 * 86400000, base) === 'in 3 days' && m.relativeDays(base - 3600000, base) === '1 hour ago');

  // --- looks: the region selects, the sets, which set the layout shows, the patch a set makes ---
  {
    const lk = (id, title, target) => ({ id, title, target, styles: ['x.css'] });
    const info = (key, name, contributes, state = 'on') => ({ key, id: key, scope: 'bundled', state, manifest: { name, contributes }, problems: [], settings: {} });
    const hyper = info('hyperspace', 'Hyperspace', { looks: [lk('holo', 'Holo terminal', 'conversation'), lk('cockpit', 'Cockpit', 'composer')], views: [{ id: 'stars', title: 'Hyperspace', seat: 'background' }] });
    const pair = info('pair', 'Pair', { looks: [lk('a', 'A', 'conversation')], views: [{ id: 'bg', title: 'Bg', seat: 'background' }] });
    const single = info('single', 'Single', { looks: [lk('only', 'Only', 'conversation')] });
    const off = info('offset', 'Off set', { looks: [lk('a', 'A', 'conversation'), lk('b', 'B', 'composer')] }, 'off');
    const mods = [hyper, pair, single, off];
    check('lookChoices: every look for the region from on mods, named "<mod>: <look>"', JSON.stringify(m.lookChoices(mods, 'conversation')) === JSON.stringify([{ value: 'hyperspace/holo', label: 'Hyperspace: Holo terminal' }, { value: 'pair/a', label: 'Pair: A' }, { value: 'single/only', label: 'Single: Only' }]) && m.lookChoices(mods, 'composer').length === 1);
    const sets = m.lookSets(mods);
    check('lookSets: on mods with at least two of the three parts', sets.map((x) => x.key).join() === 'hyperspace,pair' && sets[0].background === 'hyperspace/stars' && sets[0].composer === 'hyperspace/cockpit' && sets[1].composer === null, sets);
    const L0 = { looks: { conversation: null, composer: null }, background: null, backgroundImage: null };
    check('currentLookSet: None when everything is the app\'s own', m.currentLookSet(mods, L0) === '');
    check('currentLookSet: a set when the three are exactly its parts', m.currentLookSet(mods, { ...L0, looks: { conversation: 'hyperspace/holo', composer: 'hyperspace/cockpit' }, background: 'hyperspace/stars' }) === 'hyperspace');
    check('currentLookSet: a set lacking a part needs that part to be the app\'s own', m.currentLookSet(mods, { ...L0, looks: { conversation: 'pair/a', composer: null }, background: 'pair/bg' }) === 'pair' && m.currentLookSet(mods, { ...L0, looks: { conversation: 'pair/a', composer: 'hyperspace/cockpit' }, background: 'pair/bg' }) === 'custom');
    check('currentLookSet: Custom for a mix, or a user picture under a set', m.currentLookSet(mods, { ...L0, looks: { conversation: 'single/only', composer: null }, background: null }) === 'custom' && m.currentLookSet(mods, { ...L0, looks: { conversation: 'pair/a', composer: null }, backgroundImage: '/x.png' }) === 'custom' && m.currentLookSet(mods, { ...L0, backgroundImage: '/x.png' }) === 'custom');
    check('currentLookSet: "off:<key>" when all the parts come from a mod that is off or gone', m.currentLookSet(mods, { ...L0, looks: { conversation: 'offset/a', composer: 'offset/b' } }) === 'off:offset' && m.currentLookSet(mods, { ...L0, looks: { conversation: 'gone/a', composer: null }, background: 'gone/bg' }) === 'off:gone');
    check('currentLookSet: one part of an off mod alone is Custom', m.currentLookSet(mods, { ...L0, looks: { conversation: 'offset/a', composer: null } }) === 'custom');
    check('lookSetPatch: a set sets all three, a missing part to the app\'s own', JSON.stringify(m.lookSetPatch(sets[0])) === JSON.stringify({ looks: { conversation: 'hyperspace/holo', composer: 'hyperspace/cockpit' }, background: 'hyperspace/stars' }) && m.lookSetPatch(sets[1]).looks.composer === null);
    const none = m.lookSetPatch(null);
    check('lookSetPatch: None clears the looks, the background and the picture', none.looks.conversation === null && none.looks.composer === null && none.background === null && none.backgroundImage === null);
    check('a patch applied gives back the set', m.currentLookSet(mods, { ...L0, ...m.lookSetPatch(sets[0]) }) === 'hyperspace' && m.currentLookSet(mods, { ...L0, ...m.lookSetPatch(sets[1]) }) === 'pair');
    check('offLookMods: the off mods that have looks', m.offLookMods(mods).join() === 'Off set');
    check('modChip: a warning alone is not a problem', m.modChip({ state: 'on', problems: [{ kind: 'manifest', message: 'x', warning: true }] }) === null && m.modChip({ state: 'on', problems: [{ kind: 'runtime', message: 'x' }] }).label === 'Problem');
    check('grantSheet: looks get the restyle warning', /restyle the whole app/.test(m.grantSheet({ state: 'off', manifest: { name: 'L', contributes: { looks: [lk('a', 'A', 'conversation')] } }, wants: [], wantsStyles: false, granted: [] }).warnings[0] || ''));
  }
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
