const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return file.path || null; }
  },
  ffmpegPaths: () => ipcRenderer.invoke('ffmpeg:paths'),
  openVideo: () => ipcRenderer.invoke('dialog:openVideo'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  probe: (filePath) => ipcRenderer.invoke('video:probe', filePath),
  detect: (filePath, opts) => ipcRenderer.invoke('detect:run', { filePath, opts }),
  export: (payload) => ipcRenderer.invoke('export:run', payload),
  buildProxy: (filePath, duration) => ipcRenderer.invoke('proxy:ensure', { filePath, duration }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  cacheSize: () => ipcRenderer.invoke('proxy:cacheSize'),
  clearCache: () => ipcRenderer.invoke('proxy:clearCache'),
  testEncoder: (encoder) => ipcRenderer.invoke('encoder:test', encoder),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),

  onDetectProgress: (cb) => ipcRenderer.on('detect:progress', (_e, p) => cb(p)),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, p) => cb(p)),
  onExportStatus: (cb) => ipcRenderer.on('export:status', (_e, s) => cb(s)),
  onProxyProgress: (cb) => ipcRenderer.on('proxy:progress', (_e, p) => cb(p)),
});
