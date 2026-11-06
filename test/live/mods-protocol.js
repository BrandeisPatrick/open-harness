// Live proof of the parts of mods that only exist inside Electron: the mod:// scheme, its headers and CSP, and the
// lock-down of mod frames (navigation and network). Runs a hidden Electron process with a small fixture main script
// (test/live/fixtures/mods-protocol-main.js) and a fake App; it never starts the app itself or touches a profile.
// Run: npm run build && node test/live/mods-protocol.js
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'mods.js'))) {
  console.error('Build first: npm run build');
  process.exit(1);
}

// A self-signed certificate for the local https/wss server that stands in for "the internet".
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mods-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });

const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const env = { ...process.env, OA_ROOT: ROOT, OA_CERT_DIR: certDir };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, 'fixtures', 'mods-protocol-main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (c) => {
  out += c;
  process.stdout.write(c);
});
child.stderr.on('data', (c) => {
  const s = String(c);
  // Chromium's own chatter (GPU, sandbox notes) is not ours; show only lines that look like ours.
  if (/FAIL|Error|CRASH/.test(s)) process.stderr.write(s);
});
const timer = setTimeout(() => {
  console.log('FAIL the fixture did not finish within 60 s');
  child.kill('SIGKILL');
}, 60_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  fs.rmSync(certDir, { recursive: true, force: true });
  const ok = code === 0 && /\nALL OK/.test(out);
  if (!ok && code === 0) console.log('FAIL the fixture exited without a verdict');
  process.exit(ok ? 0 : 1);
});
