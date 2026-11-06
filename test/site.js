// The website (docs/index.html, served by GitHub Pages from main's /docs), headless and without a browser: every local
// href and src resolves to a file in the repository; every <img> has alt text, and a width and height in the ratio of
// the file's real pixels; each themed picture has its light and its dark file, the same size; exactly one h1 and no
// skipped heading level; nothing is loaded from another origin (links to github.com are fine, resources are not);
// the page, its stylesheet and its script together weigh under 60 KB; the Copy buttons point at blocks that exist.
// Run: node test/site.js [repo]
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

const DOCS = path.join(root, 'docs');
const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=[\\s>/])`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
const isRemote = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u);
const local = (u) => decodeURIComponent(u.split('#')[0].split('?')[0]);

/** The pixel size of a PNG (its IHDR) or an SVG (its width and height, else its viewBox). */
function size(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(1, 4).toString('latin1') === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  const svg = buf.toString('utf8');
  const w = /<svg[^>]*\swidth="([\d.]+)"/.exec(svg);
  const h = /<svg[^>]*\sheight="([\d.]+)"/.exec(svg);
  if (w && h) return { w: Number(w[1]), h: Number(h[1]) };
  const vb = /viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/.exec(svg);
  return vb ? { w: Number(vb[1]), h: Number(vb[2]) } : null;
}

// ---- every local reference resolves ----
const refs = [];
for (const t of html.matchAll(/<[a-z]+\b[^>]*>/gi)) {
  const tag = t[0];
  for (const name of ['href', 'src', 'data-src', 'data-src-dark']) {
    const v = attr(tag, name);
    if (v !== null) refs.push({ tag, url: v });
  }
  const set = attr(tag, 'srcset');
  if (set) for (const part of set.split(',')) refs.push({ tag, url: part.trim().split(/\s+/)[0] });
}
const missing = [];
for (const { url } of refs) {
  if (!url || url.startsWith('#') || isRemote(url)) continue;
  const file = path.resolve(DOCS, local(url) || '.');
  const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file;
  if (!target.startsWith(DOCS + path.sep) || !fs.existsSync(target)) missing.push(url);
}
check('every local href, src and srcset resolves to a file under docs/', missing.length === 0 && refs.length > 10, missing);
const anchors = refs.filter((r) => r.url.startsWith('#') && r.url.length > 1).map((r) => r.url.slice(1));
check('every in-page link names an id on the page', anchors.every((id) => new RegExp(`\\sid="${id}"`).test(html)), anchors);
check('links to Markdown files go to their page on GitHub (Pages does not render them)', refs.filter((r) => /\.md(?:#|$)/.test(r.url)).every((r) => /^https:\/\/github\.com\/BrandeisPatrick\/open-harness\/blob\//.test(r.url)));
check('docs/.nojekyll is there', fs.existsSync(path.join(DOCS, '.nojekyll')));

// ---- pictures ----
// A themed picture is an <img> with data-src (light) and data-src-dark, given its src by the script, and beside it a
// <noscript> copy: a <picture> whose <source data-dark> switches with the system's scheme.
const fileOf = (tag) => attr(tag, 'src') ?? attr(tag, 'data-src');
const imgs = tags('img');
const bad = [];
for (const tag of imgs) {
  const src = fileOf(tag);
  const alt = attr(tag, 'alt');
  const w = Number(attr(tag, 'width'));
  const h = Number(attr(tag, 'height'));
  const files = [src, attr(tag, 'data-src-dark')].filter(Boolean);
  const decorative = alt === '' && /icon/.test(src || '');
  if (alt === null || (!decorative && alt.trim().length < 12)) bad.push(`${src}: alt`);
  if (!w || !h) bad.push(`${src}: width/height`);
  for (const f of files) {
    const real = !isRemote(f) && fs.existsSync(path.join(DOCS, local(f))) ? size(path.join(DOCS, local(f))) : null;
    if (w && h && (!real || Math.abs(w / h - real.w / real.h) > 0.01 * (real.w / real.h))) bad.push(`${f}: ${w}x${h} vs ${real && `${real.w}x${real.h}`}`);
  }
  const hero = /screenshots\/hero/.test(src);
  if (/screenshots\//.test(src) && (attr(tag, 'decoding') !== 'async' || (!hero && attr(tag, 'loading') !== 'lazy'))) bad.push(`${src}: decoding/loading`);
}
check('every <img> has alt text, and a width and height in the ratio of its file', bad.length === 0 && imgs.length >= 8, bad);

const themedImgs = imgs.filter((t) => attr(t, 'data-src-dark') !== null);
const pairs = [];
for (const tag of themedImgs) {
  const light = attr(tag, 'data-src');
  const dark = attr(tag, 'data-src-dark');
  const after = html.slice(html.indexOf(tag) + tag.length);
  const fallback = /^\s*<noscript>\s*<picture>([\s\S]*?)<\/picture>\s*<\/noscript>/.exec(after)?.[1] || '';
  const source = /<source\b[^>]*>/.exec(fallback)?.[0] || '';
  const img = /<img\b[^>]*>/.exec(fallback)?.[0] || '';
  const ok =
    light && dark === light.replace(/\.png$/, '-dark.png') && attr(tag, 'src') === null &&
    fs.existsSync(path.join(DOCS, light)) && fs.existsSync(path.join(DOCS, dark)) &&
    JSON.stringify(size(path.join(DOCS, light))) === JSON.stringify(size(path.join(DOCS, dark))) &&
    attr(source, 'srcset') === dark && attr(source, 'media') === '(prefers-color-scheme: dark)' && attr(img, 'src') === light &&
    attr(img, 'alt') === attr(tag, 'alt') && attr(img, 'width') === attr(tag, 'width') && attr(source, 'width') === attr(tag, 'width');
  pairs.push({ light, dark, ok: Boolean(ok) });
}
check('every themed picture has its light and its dark file, the same size, and a <noscript> copy that switches with the system', pairs.length >= 6 && pairs.every((p) => p.ok), pairs.filter((p) => !p.ok));
const themed = themedImgs.map((t) => attr(t, 'data-src'));
const unthemed = [...new Set(imgs.map(fileOf).filter((f) => /^screenshots\//.test(f) && !/-dark\.png$/.test(f) && !themed.includes(f)))];
check('every screenshot is themed but Hyperspace, which is dark by design', JSON.stringify(unthemed) === JSON.stringify(['screenshots/hyperspace.png']), unthemed);
check('the main window picture has both themes', themed.includes('screenshots/hero.png'));
// The features are cards: a heading and its words, and one picture in a frame that names its crop; every card's
// picture has both themes but Hyperspace's.
const cards = [...html.matchAll(/<article class="card">([\s\S]*?)<\/article>/g)].map((m) => m[1]);
const cardBad = cards.filter((c) => {
  const frame = /<div class="card-frame[^"]*" style="([^"]*)">/.exec(c);
  const pics = (c.replace(/<noscript>[\s\S]*?<\/noscript>/g, '').match(/<img\b[^>]*>/g) || []);
  const pic = pics[0] || '';
  const themedOk = attr(pic, 'data-src-dark') !== null || attr(pic, 'src') === 'screenshots/hyperspace.png';
  return !/<h3>[^<]+<\/h3>\s*<p>/.test(c) || !frame || !/--w:\s*\d+px/.test(frame[1]) || pics.length !== 1 || !themedOk;
});
check('six feature cards, each with a heading, its words and one framed picture in both themes (Hyperspace is dark only)', cards.length === 6 && cardBad.length === 0, cardBad.map((c) => /<h3>([^<]*)/.exec(c)?.[1]));
check('no <picture> outside a <noscript> (the preload scanner would fetch it in the system scheme)', html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '').indexOf('<picture') === -1);

// ---- headings ----
const heads = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
check('exactly one h1, and it comes first', heads.filter((n) => n === 1).length === 1 && heads[0] === 1, heads);
const skips = heads.filter((n, i) => i && n > heads[i - 1] + 1);
check('no heading skips a level', skips.length === 0, heads.join(''));

// ---- nothing from another origin ----
const css = [];
const js = [];
const remoteLoads = [];
for (const tag of html.match(/<(?:img|source|script|link|iframe|video|audio|embed|object|track|input)\b[^>]*>/gi) || []) {
  const isLink = /^<link/i.test(tag);
  const rel = (attr(tag, 'rel') || '').toLowerCase();
  for (const name of ['src', 'srcset', 'href', 'data', 'poster']) {
    const v = attr(tag, name);
    if (v && isRemote(v.trim())) remoteLoads.push(tag.slice(0, 80));
  }
  if (isLink && rel === 'stylesheet') css.push(attr(tag, 'href'));
  if (/^<script/i.test(tag) && attr(tag, 'src')) js.push(attr(tag, 'src'));
}
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const inlineStyle = [...html.matchAll(/<style>([\s\S]*?)<\/style>|\sstyle="([^"]*)"/g)].map((m) => m[1] || m[2]);
check('one stylesheet and one script, both local', css.length === 1 && js.length === 1 && !isRemote(css[0]) && !isRemote(js[0]), { css, js });
check('one small inline script, in the head (the theme before the first paint)', inline.length === 1 && html.indexOf('<script>') < html.indexOf('</head>') && inline[0].length < 600);
const cssText = css.map((f) => fs.readFileSync(path.join(DOCS, f), 'utf8')).concat(inlineStyle).join('\n');
const jsText = js.map((f) => fs.readFileSync(path.join(DOCS, f), 'utf8')).concat(inline).join('\n');
const cssRemote = [...cssText.matchAll(/url\(\s*['"]?([^'")]+)|@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g)].map((m) => m[1] || m[2]).filter(isRemote);
const jsRemote = jsText.match(/https?:\/\/|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\s*\(|importScripts/g) || [];
check('nothing in the page loads from another origin', remoteLoads.length === 0, remoteLoads);
check('nothing in the stylesheet loads from another origin, and no web fonts', cssRemote.length === 0 && !/@font-face/.test(cssText) && !/@import/.test(cssText), cssRemote);
check('the script makes no network request', jsRemote.length === 0, jsRemote);

// ---- weight ----
const bytes = [path.join(DOCS, 'index.html'), ...css.map((f) => path.join(DOCS, f)), ...js.map((f) => path.join(DOCS, f))].reduce((n, f) => n + fs.statSync(f).size, 0);
check('the page, its stylesheet and its script weigh under 60 KB', bytes < 60 * 1024, `${(bytes / 1024).toFixed(1)} KB`);

// ---- the controls ----
const copies = tags('button').filter((t) => /class="copy"/.test(t));
check('every Copy button is a button and points at a code block on the page', copies.length >= 4 && copies.every((t) => attr(t, 'type') === 'button' && new RegExp(`<pre id="${attr(t, 'data-copy')}"`).test(html)), copies.length);
const choices = tags('button').filter((t) => attr(t, 'data-theme-choice') !== null).map((t) => [attr(t, 'data-theme-choice'), attr(t, 'aria-pressed')]);
check('the theme control offers light, the system and dark, as toggle buttons in a labelled group', JSON.stringify(choices.map((c) => c[0])) === '["light","system","dark"]' && choices.every((c) => c[1] === 'true' || c[1] === 'false') && /role="group" aria-label="[^"]+"/.test(html), choices);
check('there is a live region for "Copied" and the theme', /aria-live="polite"/.test(html));
check('the product name is only text: not in file names, ids or classes', !/(?:id|class|for|data-[a-z-]+)="[^"]*(?:open-?harness)/i.test(html) && !fs.readdirSync(path.join(DOCS, 'site')).some((f) => /harness/i.test(f)));

done();
