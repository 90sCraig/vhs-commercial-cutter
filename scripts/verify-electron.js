// Checks that Electron's binary actually unpacked, and repairs it if not.
//
// Runs as this project's postinstall, because `npm install` can report success
// while leaving Electron unusable, in two unrelated ways:
//
//   - npm 11.17 and later block dependency install scripts by default, so
//     Electron's postinstall never runs and nothing is downloaded at all.
//   - Node 26 breaks extract-zip 2.0.1, which that postinstall uses: the
//     extraction writes its first entry, the promise never settles, Node
//     empties its event loop and exits 0 with 1 of 19 files unpacked.
//
// Both end at the same misleading runtime error telling you to reinstall,
// which fixes neither. The download itself is fine in the second case, so the
// zip is sitting in Electron's cache and only needs unpacking with something
// that works -- `tar`, which ships with Windows 10 and later and handles zips.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');

// Where Electron puts its executable, per platform.
function binaryPath(dist, platform = process.platform) {
  if (platform === 'win32') return path.join(dist, 'electron.exe');
  if (platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

// What install.js writes into path.txt on success, relative to dist/.
function pathTxtValue(platform = process.platform) {
  if (platform === 'win32') return 'electron.exe';
  if (platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  return 'electron';
}

// @electron/get's cache root. Honors the same overrides it does, so a machine
// with a redirected cache still repairs.
function cacheRoot(env = process.env, platform = process.platform) {
  if (env.electron_config_cache) return env.electron_config_cache;
  if (env.ELECTRON_CACHE) return env.ELECTRON_CACHE;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || os.homedir(), 'electron', 'Cache');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'electron');
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron');
}

// The cache is a flat set of hash-named directories, each holding one zip, so
// find it by name rather than recomputing the hash.
function findCachedZip(version, cacheDir, platform = process.platform, arch = process.arch) {
  const wanted = `electron-v${version}-${platform}-${arch}.zip`;
  let entries;
  try { entries = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(cacheDir, e.name, wanted);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function note(msg) { console.log(`  electron: ${msg}`); }

function main() {
  // Not installed at all, e.g. a production-only install. Nothing to verify.
  if (!fs.existsSync(electronDir)) return 0;

  const dist = path.join(electronDir, 'dist');
  const binary = binaryPath(dist);
  if (fs.existsSync(binary)) return 0;

  const version = JSON.parse(
    fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8')
  ).version;

  const unpacked = fs.existsSync(dist) ? fs.readdirSync(dist).length : 0;
  note(`binary missing after install (dist has ${unpacked} ${unpacked === 1 ? 'entry' : 'entries'}), repairing`);

  const zip = findCachedZip(version, cacheRoot());
  if (!zip) {
    // No cached download means the postinstall never ran, rather than having
    // run and failed to unpack -- a different problem with a different fix.
    console.error(
      `\n  electron ${version} did not download and is not in the cache.\n` +
      `  npm 11.17 and later block dependency install scripts by default. Approve them and reinstall:\n\n` +
      `    npm approve-scripts electron ffmpeg-static electron-winstaller\n    npm install\n`
    );
    return 1;
  }

  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const r = spawnSync('tar', ['-xf', zip, '-C', dist], { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(
      `\n  could not unpack ${zip}\n` +
      `  ${r.error ? r.error.message : `tar exited ${r.status}`}\n` +
      `  Unpack it into node_modules/electron/dist by hand, or install under a Node LTS.\n`
    );
    return 1;
  }

  if (!fs.existsSync(binary)) {
    console.error(`\n  unpacked ${zip} but ${path.basename(binary)} is still missing.\n`);
    return 1;
  }
  // install.js normally writes this; electron/index.js reads it to find the binary.
  fs.writeFileSync(path.join(electronDir, 'path.txt'), pathTxtValue());
  note(`repaired — ${fs.readdirSync(dist).length} entries unpacked from the cached zip`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { binaryPath, pathTxtValue, cacheRoot, findCachedZip };
