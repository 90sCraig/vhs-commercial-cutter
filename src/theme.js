// Theme resolution, shared by the main process and the renderer.
//
// The manifest is generated alongside themes.css by scripts/build-themes.js,
// so the list of palettes has exactly one source. Everything here is pure: the
// renderer applies the result to <html>, the main process uses it to pick the
// window's background color before the first paint.
const THEMES = require('../renderer/brand/themes.json');

const DEFAULT_THEME = 'wcrg';

function byId(id) {
  return THEMES.find((t) => t.id === id) || null;
}

// Turn a settings object plus the current OS preference into a real theme id.
// Anything unrecognized falls back to the default rather than leaving the app
// unstyled — a settings file written by a newer version naming a theme this
// build does not have should still open.
function resolve(settings, systemPrefersDark) {
  const s = settings || {};
  if (s.theme === 'auto') {
    const wanted = systemPrefersDark ? s.themeDark : s.themeLight;
    const hit = byId(wanted);
    if (hit) return hit.id;
    // An auto pairing that names a missing theme still has to land somewhere
    // on the right side of the switch.
    const fallback = THEMES.find((t) => t.mode === (systemPrefersDark ? 'dark' : 'light'));
    return (fallback || byId(DEFAULT_THEME)).id;
  }
  const hit = byId(s.theme);
  return hit ? hit.id : DEFAULT_THEME;
}

function background(id) {
  const t = byId(id);
  return t ? t.bg : byId(DEFAULT_THEME).bg;
}

function list() {
  return THEMES.slice();
}

module.exports = { THEMES, DEFAULT_THEME, byId, resolve, background, list };
