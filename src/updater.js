// Auto-update via GitHub releases. Notify-first: we tell the renderer an update
// exists and let the USER choose to download, then choose to restart & install.
// Nothing downloads or installs without the user clicking.
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

function initUpdater(win) {
  // Updates only make sense for the installed (NSIS) build, not dev or portable.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;         // wait for the user to say yes
  autoUpdater.autoInstallOnAppQuit = false; // don't sneak it in on quit

  const send = (channel, data) => {
    try { if (win && !win.isDestroyed()) win.webContents.send(channel, data); } catch (_) {}
  };

  autoUpdater.on('update-available', (info) => send('update:available', { version: info.version }));
  autoUpdater.on('download-progress', (p) => send('update:progress', Math.round(p.percent)));
  autoUpdater.on('update-downloaded', (info) => send('update:downloaded', { version: info.version }));
  autoUpdater.on('error', (err) => send('update:error', String(err && err.message ? err.message : err)));

  check();
}

function check() {
  if (!app.isPackaged) return Promise.resolve({ ok: false, reason: 'dev' });
  return autoUpdater.checkForUpdates().then(() => ({ ok: true })).catch((e) => ({ ok: false, reason: String(e) }));
}

function download() {
  return autoUpdater.downloadUpdate().catch(() => {});
}

function install() {
  // Quit and run the downloaded installer.
  autoUpdater.quitAndInstall();
}

module.exports = { initUpdater, check, download, install };
