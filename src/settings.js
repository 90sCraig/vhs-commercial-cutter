// Persistent app settings, stored as JSON in the user-data folder.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  proxyEnabled: true,       // build a fast preview proxy on import
  proxyCacheCapGB: 8,       // cap the proxy cache; LRU-evict beyond this
  encoder: 'cpu',           // 'cpu' | 'nvenc' | 'qsv' | 'amf'
  encoderDetected: false,   // set once the first-run hardware probe has run
  // Scan the 480p proxy instead of the original. On a 2h 1080p60 capture over
  // a network share this was 52s vs 413s for identical output: same 10 black
  // events, same 8 confident boundaries, same 5 segments, boundaries within a
  // second. Export always uses the original regardless.
  detectOnProxy: true,
  // Reveals features that aren't finished being validated. Off by default so
  // nobody trusts an answer the app isn't confident in yet.
  experimental: false,
  // Detection thresholds, remembered between sessions. Tuning these against
  // your own tapes is the whole workflow, so losing them on quit is hostile.
  detect: {
    preset: 'balanced',
    blackThreshold: 0.10,
    silenceDb: -30,
    minCommercial: 8,
    maxCommercial: 360,
  },
};

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    // The spread is shallow, so `detect` has to be merged on its own or a file
    // written by an older version would drop whichever keys it predates.
    return { ...DEFAULTS, ...saved, detect: { ...DEFAULTS.detect, ...(saved.detect || {}) } };
  } catch (_) {
    return { ...DEFAULTS, detect: { ...DEFAULTS.detect } };
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
