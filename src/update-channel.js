const STABLE = 'stable';
const BETA = 'beta';

function normalizeUpdateChannel(value) {
  return value === BETA ? BETA : STABLE;
}

function applyUpdateChannel(autoUpdater, value) {
  const channel = normalizeUpdateChannel(value);

  // GitHub prereleases use the same release feed as stable builds. Toggling
  // this flag lets electron-updater choose whether prerelease tags are
  // eligible without asking it for a beta.yml file that may not exist.
  autoUpdater.allowPrerelease = channel === BETA;

  // Changing channels must never install an older build. A beta user who
  // switches back to Stable simply waits for the next stable version newer
  // than the build already installed.
  autoUpdater.allowDowngrade = false;
  return channel;
}

module.exports = { STABLE, BETA, normalizeUpdateChannel, applyUpdateChannel };
