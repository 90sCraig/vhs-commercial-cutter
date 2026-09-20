// Persistent app settings, stored as JSON in the user-data folder.
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
  // Explanatory lines under the controls. Off by default for a tighter panel;
  // the "i" tooltips and the Guide still explain everything either way.
  showHelpText: false,
  keymap: 'default', // 'default' | 'videoredo'
  // Appearance. `theme` is a theme id from renderer/brand/themes.json, or
  // 'auto' to follow the OS light/dark setting, in which case themeLight and
  // themeDark say which palette each side of that switch uses. The default
  // stays WCRG-TV: the app's own look is the one people already installed.
  theme: 'wcrg',
  themeLight: 'github-light',
  themeDark: 'wcrg',
  // Height in px of the segment list, dragged against the player. Remembered
  // because how much of it you want depends on the tape: eighty segments needs
  // a lot more list than eight.
  segmentsHeight: 210,
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
  // Required here rather than at the top so the defaults can be read outside
  // an Electron process — the theme tests check that the shipped defaults name
  // palettes that actually exist.
  const { app } = require('electron');
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
