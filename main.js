const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const { ffprobeInfo, FFMPEG, FFPROBE, beginJob, cancelJob } = require('./src/ffmpeg');
const { detect, detectSample, calibrate } = require('./src/detect');
const { exportVideo, renderPreview } = require('./src/export');
const os = require('os');
const { ensureProxy, proxyPathFor, cacheSize, clearCache } = require('./src/proxy');
const fs = require('fs');
const settings = require('./src/settings');
const { decodeAccel } = require('./src/encoders');
const updater = require('./src/updater');
const { spawn } = require('child_process');

let win;

// Long ffmpeg runs are unattended by nature. If Windows sleeps mid-encode, an
// open GPU encoder session can wedge the driver on resume and take the desktop
// with it. This keeps the system awake; the display may still switch off.
async function keepAwake(fn) {
  const id = powerSaveBlocker.start('prevent-app-suspension');
  try {
    return await fn();
  } finally {
    try { powerSaveBlocker.stop(id); } catch (_) { /* already stopped */ }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0f1113',
    title: 'VHS Commercial Cutter',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => updater.initUpdater(win));
}

// On first launch, find the fastest encoder that actually works on this
// machine rather than leaving everyone on CPU. Runs once: the result is
// written to settings, and the user can still change it by hand afterwards.
// Returns the encoder it settled on, or null if this is not the first run.
async function detectEncoderOnce() {
  const s = settings.load();
  if (s.encoderDetected) return null;
  for (const enc of ['nvenc', 'qsv', 'amf']) {
    const r = await probeEncoder(enc);
    if (r.ok) {
      settings.save({ encoder: enc, encoderDetected: true });
      return enc;
    }
  }
  settings.save({ encoder: 'cpu', encoderDetected: true });
  return 'cpu';
}

app.whenReady().then(() => {
  createWindow();
  // Probe after the window is up so startup stays instant. Exports read the
  // encoder from settings in this process, so the result takes effect as soon
  // as it lands; the message only refreshes the Settings dropdown.
  detectEncoderOnce()
    .then((enc) => {
      if (enc && win && !win.isDestroyed()) win.webContents.send('encoder:detected', enc);
    })
    .catch((e) => { console.error('[encoder] detection failed, keeping default:', e); });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC ---------------------------------------------------------------

ipcMain.handle('ffmpeg:paths', () => ({ ffmpeg: FFMPEG, ffprobe: FFPROBE }));
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('dialog:openVideo', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open video file',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'm2ts', 'ts', 'wmv', 'mpg', 'mpeg'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose export folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('video:probe', async (_e, filePath) => {
  return ffprobeInfo(filePath);
});

// Black frames and silence read the same at 480p, and the proxy is local
// rather than across whatever drive the capture lives on. Falls back to the
// original whenever a proxy isn't sitting ready. Export never uses this.
function scanPathFor(filePath) {
  if (settings.load().detectOnProxy === false) return filePath;
  try {
    const p = proxyPathFor(filePath);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
  } catch (_) { /* no proxy — scan the original */ }
  return filePath;
}

ipcMain.handle('detect:run', async (_e, { filePath, opts }) => {
  opts.hwaccel = decodeAccel(settings.load().encoder); // GPU-accelerated decode
  beginJob();
  return keepAwake(() => detect(scanPathFor(filePath), opts, {
    onProgress: (p) => win.webContents.send('detect:progress', p),
  }));
});

ipcMain.handle('detect:sample', async (_e, { filePath, opts, range }) => {
  opts.hwaccel = decodeAccel(settings.load().encoder);
  return detectSample(scanPathFor(filePath), opts, range);
});

ipcMain.handle('detect:calibrate', async (_e, { filePath, opts }) => {
  opts.hwaccel = decodeAccel(settings.load().encoder);
  beginJob();
  return keepAwake(() => calibrate(scanPathFor(filePath), opts, {
    onProgress: (p) => win.webContents.send('detect:progress', p),
    onStatus: (s) => win.webContents.send('export:status', s),
  }));
});

let previewSeq = 0;
ipcMain.handle('preview:render', async (_e, payload) => {
  payload.encoder = settings.load().encoder || 'cpu';
  previewSeq += 1; // unique name each time (old temp file may still be open)
  payload.outPath = path.join(os.tmpdir(), `vhs-preview-${process.pid}-${previewSeq}.mp4`);
  await renderPreview(payload, {});
  return payload.outPath;
});

ipcMain.handle('export:run', async (_e, payload) => {
  payload.encoder = settings.load().encoder || 'cpu'; // single source of truth
  beginJob();
  return keepAwake(() => exportVideo(payload, {
    onProgress: (p) => win.webContents.send('export:progress', p),
    onStatus: (s) => win.webContents.send('export:status', s),
    onFallback: (enc) => win.webContents.send('export:status',
      `${String(enc).toUpperCase()} encoding failed — finishing on the CPU.`),
  }));
});

// Kills whatever ffmpeg is running and blocks the job from starting its next
// step. Safe to call when nothing is running.
ipcMain.handle('job:abort', () => cancelJob());

ipcMain.handle('proxy:ensure', async (_e, { filePath, duration }) => {
  const s = settings.load();
  beginJob();  // so Cancel on the preview badge can stop it
  const cap = (s.proxyCacheCapGB || 0) * 1024 * 1024 * 1024;
  return ensureProxy(filePath, {
    onProgress: (secs) =>
      win.webContents.send('proxy:progress', duration ? Math.min(1, secs / duration) : 0),
    onFallback: () => win.webContents.send('proxy:progress', 0),
  }, { cacheCapBytes: cap, encoder: s.encoder });
});

// --- settings + cache + encoder ---
ipcMain.handle('settings:get', () => settings.load());
ipcMain.handle('settings:set', (_e, partial) => settings.save(partial));
ipcMain.handle('proxy:cacheSize', () => cacheSize());
ipcMain.handle('proxy:clearCache', () => clearCache());

// Quick capability test: try a 1-frame encode with the given encoder.
function probeEncoder(encoder) {
  return new Promise((resolve) => {
    const map = {
      nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf', cpu: 'libx264',
    };
    const codec = map[encoder] || 'libx264';
    const args = [
      '-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=1',
      '-c:v', codec, '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
    ];
    const proc = spawn(FFMPEG, args);
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', () => resolve({ ok: false, error: 'failed to launch ffmpeg' }));
    proc.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err.slice(-400) }));
  });
}

ipcMain.handle('encoder:test', (_e, encoder) => probeEncoder(encoder));

ipcMain.handle('shell:showItem', async (_e, p) => {
  shell.showItemInFolder(p);
});

// --- updates ---
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:install', () => updater.install());
