// Images in replies: the show_image tool (validation, the stored copy, the event, the transcript item), header
// parsing per format, forks and rewinds, the artifact:// mapping for stored images and images.resolve.
// Headless, against the mock model. Run: node test/images.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-images-'));
// ~ in a path is this folder, not the real home
process.env.HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.HOME);
process.env.OPEN_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { SessionStore, toTranscript } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { setupImages } = require(path.join(projectDir, 'dist/main/images.js'));
const { sniffImage, imageSize } = require(path.join(projectDir, 'dist/main/images/sniff.js'));
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

// ---- fixtures, made here ----
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 200;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function jpeg(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 1)]);
  const sof = Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, sof, Buffer.from([0xff, 0xd9])]);
}
function gif(w, h) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return Buffer.concat([b, Buffer.from([0x3b])]);
}
function riff(chunkType, data) {
  const body = Buffer.concat([Buffer.from('WEBP' + chunkType, 'latin1'), Buffer.alloc(4), data]);
  body.writeUInt32LE(data.length, 8);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
function webpVP8X(w, h) {
  const d = Buffer.alloc(10);
  d.writeUIntLE(w - 1, 4, 3);
  d.writeUIntLE(h - 1, 7, 3);
  return riff('VP8X', d);
}
function webpVP8L(w, h) {
  const d = Buffer.alloc(5);
  d[0] = 0x2f;
  const bits = (w - 1) | ((h - 1) << 14);
  d.writeUInt32LE(bits >>> 0, 1);
  return riff('VP8L', d);
}
function webpVP8(w, h) {
  const d = Buffer.alloc(10);
  d[3] = 0x9d;
  d[4] = 0x01;
  d[5] = 0x2a;
  d.writeUInt16LE(w, 6);
  d.writeUInt16LE(h, 8);
  return riff('VP8 ', d);
}
const SVG = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- three circles -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><circle cx="20" cy="20" r="15" fill="red"/></svg>\n';

(async () => {
  // ---- 1: content sniffing and header parsing ----
  const kinds = [
    ['png', png(64, 32), 'image/png', 64, 32],
    ['jpeg', jpeg(300, 200), 'image/jpeg', 300, 200],
    ['gif', gif(17, 9), 'image/gif', 17, 9],
    ['webp VP8X', webpVP8X(1000, 750), 'image/webp', 1000, 750],
    ['webp VP8L', webpVP8L(129, 77), 'image/webp', 129, 77],
    ['webp VP8', webpVP8(320, 240), 'image/webp', 320, 240],
  ];
  for (const [label, buf, mime, w, h] of kinds) {
    const k = sniffImage(buf);
    const size = k && imageSize(buf, k);
    check(`1: ${label} is ${mime}, ${w}×${h}`, k?.mime === mime && size?.width === w && size?.height === h, { k, size });
  }
  check('1: SVG with prolog, comment and doctype', sniffImage(Buffer.from(SVG))?.mime === 'image/svg+xml');
  check('1: SVG with a BOM and namespace prefix', sniffImage(Buffer.from('﻿<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>'))?.ext === 'svg');
  check('1: SVG has no header size', imageSize(Buffer.from(SVG), { mime: 'image/svg+xml', ext: 'svg' }) === undefined);
  check('1: HTML is not an image', sniffImage(Buffer.from('<!doctype html><html><svg></svg></html>')) === null);
  check('1: text mentioning <svg is not an image', sniffImage(Buffer.from('hello <svg>')) === null);
  check('1: random bytes are not an image', sniffImage(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) === null);

  // ---- the app, with the feature set up ----
  const mock = await startMock();
  const { state } = mock;
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  const base = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: project, permissionMode: 'bypass', autoApprove: true, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  const artifacts = new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') });
  const app = createApp({ userData: tmp, appRoot: projectDir, loadConfig: () => base, saveConfig: () => {}, browser: () => null, artifacts });
  setupImages(app);
  const rt = app.runtime;
  let events = [];
  app.events.on((sid, ev) => events.push({ sid, ev }));
  const rpc = (m, ...a) => app.invokeRpc(m, a);
  const idle = (id) => waitFor(() => !rt.isRunning(id), 15000, `session ${id} to finish`);

  // ---- 2: registration ----
  const tool = app.tools.list().find((t) => t.name === 'show_image');
  check('2: show_image is registered and read-only (plan mode offers it)', tool && tool.readOnly === true);
  const prompt = app.promptFor({ cwd: project, mode: 'ask', sessionId: 'x' });
  check('2: the system prompt tells the model about show_image', /show_image/.test(prompt) && /inline/.test(prompt));
  check('2: the images service is provided', typeof app.service('images')?.list === 'function');

  // ---- 3: a show_image call through the real runtime ----
  const logo = path.join(project, 'logo.png');
  const logoBytes = png(64, 32);
  fs.writeFileSync(logo, logoBytes);
  const S = rt.foregroundId();
  state.replies.push({ content: 'Here it is.', toolCalls: [{ id: 'c1', name: 'show_image', args: { path: 'logo.png', caption: 'Our logo' } }] });
  state.replies.push({ content: 'Done.' });
  rt.send(S, 'show me logo.png');
  await idle(S);
  const evs = events.filter((e) => e.sid === S).map((e) => e.ev);
  const imgEv = evs.find((e) => e.type === 'image');
  const end = evs.find((e) => e.type === 'tool_end' && e.name === 'show_image');
  check('3: an image event', imgEv && imgEv.image.id === 'img-1' && imgEv.image.caption === 'Our logo' && imgEv.image.name === 'logo.png', imgEv);
  check('3: the event comes before the tool result', evs.indexOf(imgEv) < evs.indexOf(end));
  check('3: one-line result with size', end && end.ok && end.result === `Shown to the user: logo.png (64×32, ${logoBytes.length} B).`, end && end.result);
  const info = imgEv.image;
  const storeDir = path.join(tmp, 'artifacts', S, 'images');
  check('3: copied as img-1.png in the session store', info.path === path.join(storeDir, 'img-1.png') && fs.readFileSync(info.path).equals(logoBytes));
  check('3: url, mime, bytes, size, source', info.url === `artifact://view/${S}/images/img-1.png` && info.mime === 'image/png' && info.bytes === logoBytes.length && info.width === 64 && info.height === 32 && info.source === 'logo.png', info);
  check('3: recorded on the session', rt.get(S).images?.['img-1']?.url === info.url);
  fs.writeFileSync(logo, png(8, 8));
  check('3: the copy survives a change to the original', fs.readFileSync(info.path).equals(logoBytes));
  const items = toTranscript(rt.get(S));
  check('3: the transcript shows the image, not a tool row', items.some((i) => i.role === 'image' && i.image.id === 'img-1') && !items.some((i) => i.role === 'tool' && i.name === 'show_image'), items.map((i) => i.role));
  check('3: the image sits between the two replies', items.map((i) => i.role).join() === 'user,assistant,image,assistant', items.map((i) => i.role).join());
  check('3: images.list and the service', (await rpc('images.list', S)).length === 1 && app.service('images').get(S, 'img-1')?.id === 'img-1' && (await rpc('images.list')).length === 1);

  // ---- 4: validation, straight through the tool ----
  const ctx = { cwd: project, sessionId: S };
  const run = async (args) => {
    try {
      return { ok: true, text: (await tool.run(args, ctx)).content };
    } catch (err) {
      return { ok: false, text: err.message };
    }
  };
  let r = await run({ path: 'missing.png' });
  check('4: a missing file', !r.ok && /no such file: missing\.png/.test(r.text), r);
  fs.writeFileSync(path.join(project, 'notes.txt'), 'just text');
  r = await run({ path: 'notes.txt' });
  check('4: not an image', !r.ok && /not an image/.test(r.text), r);
  fs.writeFileSync(path.join(project, 'fake.png'), 'not a png at all');
  r = await run({ path: 'fake.png' });
  check('4: a non-image with an image extension', !r.ok && /not an image/.test(r.text), r);
  fs.writeFileSync(path.join(project, 'shot.dat'), jpeg(300, 200));
  r = await run({ path: 'shot.dat' });
  const second = rt.get(S).images['img-2'];
  check('4: an image with the wrong extension is accepted by content', r.ok && second?.mime === 'image/jpeg' && second.path.endsWith('img-2.jpg') && r.text === `Shown to the user: shot.dat (300×200, ${second.bytes} B).`, r);
  const big = path.join(project, 'big.png');
  fs.writeFileSync(big, png(4, 4));
  fs.truncateSync(big, 16 * 1024 * 1024);
  r = await run({ path: big });
  check('4: too large', !r.ok && /too large \(16\.0 MB\); the limit is 15\.0 MB/.test(r.text), r);
  fs.mkdirSync(path.join(project, 'pics'));
  r = await run({ path: 'pics' });
  check('4: a folder', !r.ok && /folder/.test(r.text), r);
  const outside = path.join(tmp, 'elsewhere');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'chart.svg'), SVG);
  r = await run({ path: path.join(outside, 'chart.svg') });
  const svgInfo = rt.get(S).images['img-3'];
  check('4: an absolute path outside the project; SVG without pixels', r.ok && svgInfo?.mime === 'image/svg+xml' && svgInfo.width === undefined && /^Shown to the user: chart\.svg \(\d+ B\)\.$/.test(r.text), r);
  fs.writeFileSync(path.join(process.env.HOME, 'pic.gif'), gif(5, 6));
  r = await run({ path: '~/pic.gif' });
  check('4: ~/ is the home folder', r.ok && rt.get(S).images['img-4']?.width === 5 && rt.get(S).images['img-4'].source === '~/pic.gif', r);
  r = await run({ path: '  ' });
  check('4: an empty path', !r.ok && /path is required/.test(r.text), r);
  r = await run({ path: 'logo.png', caption: 'x'.repeat(500) });
  check('4: captions are clipped', r.ok && rt.get(S).images['img-5'].caption.length === 300);

  // ---- 5: a failed call stays a tool row; a reload shows the images again ----
  state.replies.push({ content: '', toolCalls: [{ id: 'c2', name: 'show_image', args: { path: 'nope.png' } }] });
  state.replies.push({ content: 'Could not.' });
  rt.send(S, 'show nope.png');
  await idle(S);
  const failed = toTranscript(rt.get(S)).filter((i) => i.role === 'tool' && i.name === 'show_image');
  check('5: the failed call is a failed tool row with the error', failed.length === 1 && failed[0].ok === false && /no such file/.test(failed[0].result), failed);
  check('5: no image event for it', !events.filter((e) => e.sid === S && e.ev.type === 'image').some((e) => e.ev.image.source === 'nope.png'));
  const reloaded = new SessionStore(path.join(tmp, 'sessions')).get(S);
  const again = toTranscript(reloaded).filter((i) => i.role === 'image');
  check('5: after a reload the transcript still has the image', again.length === 1 && again[0].image.url === info.url && again[0].image.caption === 'Our logo', again.length);

  // ---- 6: fork copies the images ----
  const fork = app.store.fork(S);
  const fimg = fork.images?.['img-1'];
  check('6: the fork has its own copies', fimg && fimg.sessionId === fork.id && fimg.path === path.join(tmp, 'artifacts', fork.id, 'images', 'img-1.png') && fs.existsSync(fimg.path) && fimg.url === `artifact://view/${fork.id}/images/img-1.png`, fimg);
  check('6: all of them', Object.keys(fork.images).length === Object.keys(rt.get(S).images).length);
  check('6: the source keeps its own', rt.get(S).images['img-1'].path === info.path);
  check("6: the fork's transcript points at its copies", toTranscript(fork).find((i) => i.role === 'image')?.image.url === fimg.url);
  check('6: and the fork was saved with them', new SessionStore(path.join(tmp, 'sessions')).get(fork.id)?.images?.['img-1']?.url === fimg.url);

  // ---- 7: the artifact:// mapping ----
  const res = (u) => artifacts.resolve(u);
  check('7: a stored image is served', res(info.url)?.kind === 'file' && res(info.url).path === info.path);
  check("7: the fork's copy is served", res(fimg.url)?.path === fimg.path);
  const other = rt.create().id;
  check('7: another session has no such image', res(`artifact://view/${other}/images/img-1.png`) === null);
  check('7: traversal is refused', res(`artifact://view/${S}/images/..%2F..%2Fsessions%2F${S}.json`) === null && res(`artifact://view/${S}/images/%2E%2E`) === null && res(`artifact://view/${S}/images/img-1.png/x`) === null);
  check('7: names other than img-<n>.<ext> are refused', res(`artifact://view/${S}/images/logo.png`) === null);
  fs.writeFileSync(path.join(storeDir, 'img-90.png'), 'not an image');
  check('7: a non-image in the folder is refused', res(`artifact://view/${S}/images/img-90.png`) === null);
  fs.copyFileSync(info.path, path.join(storeDir, 'img-91.gif'));
  check('7: a stored file whose extension lies is refused', res(`artifact://view/${S}/images/img-91.gif`) === null);
  fs.symlinkSync(path.join(project, 'logo.png'), path.join(storeDir, 'img-92.png'));
  check('7: a symlink in the folder is refused', res(`artifact://view/${S}/images/img-92.png`) === null);
  check('7: artifacts still resolve as before', res(`artifact://view/${S}/art-1`) === null && res('artifact://view/_app/markdown.js')?.kind === 'file');

  // ---- 8: images.resolve for Markdown images ----
  let v = await rpc('images.resolve', 'logo.png', S);
  check('8: a relative path resolves to an artifact URL', v.url && v.url.startsWith('artifact://view/_local/') && v.name === 'logo.png', v);
  check('8: which is served as that file', res(v.url)?.path === path.join(project, 'logo.png'));
  check('8: the same file keeps its URL', (await rpc('images.resolve', path.join(project, 'logo.png'), S)).url === v.url);
  check('8: ./ and ~/ work', (await rpc('images.resolve', './logo.png', S)).url === v.url && (await rpc('images.resolve', '~/pic.gif', S)).name === 'pic.gif');
  v = await rpc('images.resolve', 'shot.dat', S);
  check('8: a misnamed image is served under its real type', v.url && res(v.url)?.path.endsWith('.jpg') && fs.readFileSync(res(v.url).path).equals(jpeg(300, 200)), v);
  check('8: missing', (await rpc('images.resolve', 'missing.png', S)).error === 'not found');
  check('8: not an image', (await rpc('images.resolve', 'notes.txt', S)).error === 'not an image' && (await rpc('images.resolve', 'fake.png', S)).error === 'not an image');
  check('8: a folder', (await rpc('images.resolve', 'pics', S)).error === 'not a file');
  check('8: too large', (await rpc('images.resolve', big, S)).error === 'too large');
  check('8: remote URLs are refused', (await rpc('images.resolve', 'https://example.com/a.png', S)).error === 'remote images are not loaded' && (await rpc('images.resolve', 'http://x/y.png', S)).error && (await rpc('images.resolve', '//example.com/a.png', S)).error);
  check('8: other schemes are refused', (await rpc('images.resolve', 'data:image/png;base64,AAAA', S)).error && (await rpc('images.resolve', 'javascript:alert(1)', S)).error);
  check('8: file:// works', (await rpc('images.resolve', `file://${path.join(project, 'logo.png')}`, S)).url === (await rpc('images.resolve', 'logo.png', S)).url);
  check('8: unknown tokens are not served', res('artifact://view/_local/000000000000000000000000/x.png') === null && res('artifact://view/_local/../x.png') === null);
  const tokenUrl = (await rpc('images.resolve', 'logo.png', S)).url;
  fs.writeFileSync(logo, 'now text');
  check('8: a file that stopped being an image is no longer served', res(tokenUrl) === null);

  // ---- 9: a rewind drops the images of the calls it removes ----
  const s = rt.get(S);
  const before = Object.keys(s.images).length;
  const at = s.messages.findIndex((m) => m.role === 'user');
  app.store.truncate(s, at);
  check('9: the images of rewound calls are gone', !s.images?.['img-1'] && !fs.existsSync(info.path), { before, now: Object.keys(s.images ?? {}) });
  check('9: images shown outside a call (no message) stay', Boolean(s.images?.['img-2']));
  check("9: the fork's copies are untouched", fs.existsSync(fimg.path));

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
