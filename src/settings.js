// Persistent app settings, stored as JSON in the user-data folder.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  proxyEnabled: true,       // build a fast preview proxy on import
  proxyCacheCapGB: 8,       // cap the proxy cache; LRU-evict beyond this
  encoder: 'cpu',           // 'cpu' | 'nvenc' | 'qsv' | 'amf'
  encoderDetected: false,   // set once the first-run hardware probe has run
};

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const merged = { ...load(), ...partial };
  try {
    fs.writeFileSync(file(), JSON.stringify(merged, null, 2));
  } catch (_) { /* ignore write errors */ }
  return merged;
}

module.exports = { load, save, DEFAULTS };
