const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const verify = require('../scripts/verify-electron');

// The repair script has to find things on a machine it is not running on --
// the cache location and the binary name both move with the platform -- so
// those lookups are pure and checked here for all three.

test('it looks for the right binary on each platform', () => {
  assert.equal(verify.binaryPath('/d', 'win32'), path.join('/d', 'electron.exe'));
  assert.equal(verify.binaryPath('/d', 'darwin'), path.join('/d', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
  assert.equal(verify.binaryPath('/d', 'linux'), path.join('/d', 'electron'));
});

test('path.txt gets what electron/index.js expects to read back', () => {
  assert.equal(verify.pathTxtValue('win32'), 'electron.exe');
  assert.equal(verify.pathTxtValue('darwin'), 'Electron.app/Contents/MacOS/Electron');
  assert.equal(verify.pathTxtValue('linux'), 'electron');
});

test('the cache root follows the same overrides @electron/get honors', () => {
  // Otherwise a machine with a redirected cache looks empty, and the script
  // reports a download that never happened instead of repairing one that did.
  assert.equal(verify.cacheRoot({ electron_config_cache: '/custom' }, 'linux'), '/custom');
  assert.equal(verify.cacheRoot({ ELECTRON_CACHE: '/other' }, 'linux'), '/other');
  assert.equal(
    verify.cacheRoot({ LOCALAPPDATA: 'C:\\la' }, 'win32'),
    path.join('C:\\la', 'electron', 'Cache')
  );
  assert.equal(
    verify.cacheRoot({ XDG_CACHE_HOME: '/xdg' }, 'linux'),
    path.join('/xdg', 'electron')
  );
});

test('it finds the cached zip inside its hash-named folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elcache-'));
  try {
    const hashed = path.join(dir, 'a'.repeat(64));
    fs.mkdirSync(hashed);
    fs.writeFileSync(path.join(hashed, 'electron-v33.4.11-win32-x64.zip'), 'x');
    // a decoy from another version, in the same cache
    const other = path.join(dir, 'b'.repeat(64));
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'electron-v30.0.0-win32-x64.zip'), 'x');

    assert.equal(
      verify.findCachedZip('33.4.11', dir, 'win32', 'x64'),
      path.join(hashed, 'electron-v33.4.11-win32-x64.zip')
    );
    assert.equal(verify.findCachedZip('33.4.11', dir, 'win32', 'arm64'), null, 'arch must match');
    assert.equal(verify.findCachedZip('99.0.0', dir, 'win32', 'x64'), null, 'version must match');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing cache directory is not an error', () => {
  // A machine that never downloaded anything just has no cache folder.
  assert.equal(verify.findCachedZip('33.4.11', path.join(os.tmpdir(), 'nope-' + Date.now())), null);
});
