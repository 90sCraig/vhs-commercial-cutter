const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { ffprobeInfo, FFMPEG, FFPROBE } = require('./src/ffmpeg');
const { detect, detectSample } = require('./src/detect');
const { exportVideo, renderPreview } = require('./src/export');
const os = require('os');
const { ensureProxy, cacheSize, clearCache } = require('./src/proxy');
const settings = require('./src/settings');
const { decodeAccel } = require('./src/encoders');
const updater = require('./src/updater');
const { spawn } = require('child_process');

let win;

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

app.whenReady().then(() => {
  createWindow();
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
    title: 'Open VHS capture',
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

ipcMain.handle('detect:run', async (_e, { filePath, opts }) => {
  opts.hwaccel = decodeAccel(settings.load().encoder); // GPU-accelerated decode
  return detect(filePath, opts, {
    onProgress: (p) => win.webContents.send('detect:progress', p),
  });
});

ipcMain.handle('detect:sample', async (_e, { filePath, opts, range }) => {
  opts.hwaccel = decodeAccel(settings.load().encoder);
  return detectSample(filePath, opts, range);
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
  return exportVideo(payload, {
    onProgress: (p) => win.webContents.send('export:progress', p),
    onStatus: (s) => win.webContents.send('export:status', s),
  });
});

ipcMain.handle('proxy:ensure', async (_e, { filePath, duration }) => {
  const s = settings.load();
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

// Quick capability test: try a 1-frame encode with the chosen encoder.
ipcMain.handle('encoder:test', (_e, encoder) => new Promise((resolve) => {
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
}));

ipcMain.handle('shell:showItem', async (_e, p) => {
  shell.showItemInFolder(p);
});

// --- updates ---
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:install', () => updater.install());
