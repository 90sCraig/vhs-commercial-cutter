const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return file.path || null; }
  },
  ffmpegPaths: () => ipcRenderer.invoke('ffmpeg:paths'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  openVideo: () => ipcRenderer.invoke('dialog:openVideo'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  probe: (filePath) => ipcRenderer.invoke('video:probe', filePath),
  detect: (filePath, opts) => ipcRenderer.invoke('detect:run', { filePath, opts }),
  detectSample: (filePath, opts, range) => ipcRenderer.invoke('detect:sample', { filePath, opts, range }),
  calibrate: (filePath, opts) => ipcRenderer.invoke('detect:calibrate', { filePath, opts }),
  export: (payload) => ipcRenderer.invoke('export:run', payload),
  abortJob: () => ipcRenderer.invoke('job:abort'),
  renderPreview: (payload) => ipcRenderer.invoke('preview:render', payload),
  buildProxy: (filePath, duration) => ipcRenderer.invoke('proxy:ensure', { filePath, duration }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  cacheSize: () => ipcRenderer.invoke('proxy:cacheSize'),
  clearCache: () => ipcRenderer.invoke('proxy:clearCache'),
  testEncoder: (encoder) => ipcRenderer.invoke('encoder:test', encoder),
  onEncoderDetected: (cb) => ipcRenderer.on('encoder:detected', (_e, enc) => cb(enc)),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, d) => cb(d)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_e, d) => cb(d)),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (_e, m) => cb(m)),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),

  onDetectProgress: (cb) => ipcRenderer.on('detect:progress', (_e, p) => cb(p)),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, p) => cb(p)),
  onExportStatus: (cb) => ipcRenderer.on('export:status', (_e, s) => cb(s)),
  onProxyProgress: (cb) => ipcRenderer.on('proxy:progress', (_e, p) => cb(p)),
});
