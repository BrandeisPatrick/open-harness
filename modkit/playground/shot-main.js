// Electron main script for shot.js: loads each job's URL in a hidden window, waits for the playground to say its
// views are settled (window.__pg.ready), sizes the window to the content and writes a PNG. One JSON line per job.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const jobs = JSON.parse(process.env.SHOT_JOBS || '[]');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(job) {
  const win = new BrowserWindow({
    show: false, paintWhenInitiallyHidden: true, width: job.width, height: job.height || 900, useContentSize: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  const result = { label: job.label, file: job.file, denied: [], errors: [], requests: 0, timedOut: false };
  try {
    await win.loadURL(job.url);
    if (!/[?&]shot=1/.test(job.url)) await win.webContents.executeJavaScript('window.__playground && window.__playground.watchReady()');
    const t0 = Date.now();
    for (;;) {
      const ready = await win.webContents.executeJavaScript('!!(window.__pg && window.__pg.ready)');
      if (ready) break;
      if (Date.now() - t0 > 15000) { result.timedOut = true; break; }
      await wait(100);
    }
    if (job.evalJs) {
      // Mod frames are sandboxed (an opaque origin): reach them through the main process, not the page
      const frames = win.webContents.mainFrame.framesInSubtree.filter((f) => f !== win.webContents.mainFrame);
      for (const f of frames) {
        try { await f.executeJavaScript(job.evalJs, true); } catch (e) { result.error = 'eval: ' + String((e && e.message) || e); }
      }
      await wait(job.wait || 0);
      const t1 = Date.now();
      for (;;) {
        const quiet = await win.webContents.executeJavaScript('Date.now() - window.__pg.lastTraffic > 500');
        if (quiet || Date.now() - t1 > 8000) break;
        await wait(100);
      }
    }
    if (!job.height) {
      const h = await win.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)');
      win.setContentSize(job.width, Math.max(40, h));
      await wait(250);
    }
    await wait(200);
    const stats = await win.webContents.executeJavaScript('JSON.stringify({ denied: __pg.denied, errors: __pg.errors, requests: __pg.requests, timedOut: __pg.timedOut })');
    Object.assign(result, JSON.parse(stats), { timedOut: result.timedOut || JSON.parse(stats).timedOut });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(job.file, img.toPNG());
  } catch (e) {
    result.error = String((e && e.message) || e);
  }
  win.destroy();
  process.stdout.write(JSON.stringify(result) + '\n');
}

// Retina-sharp output wherever it runs
app.commandLine.appendSwitch('force-device-scale-factor', process.env.SHOT_SCALE || '2');
if (app.dock) app.dock.hide();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const job of jobs) await shoot(job);
  app.exit(0);
});
