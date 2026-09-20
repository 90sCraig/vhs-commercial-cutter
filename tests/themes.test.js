const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const theme = require('../src/theme');
const { DEFAULTS } = require('../src/settings');

const root = path.resolve(__dirname, '..');
const brand = path.join(root, 'renderer', 'brand');

// These tests read the generated CSS rather than calling the generator, so a
// hand-edit to themes.css is checked on the same terms as a generated one.

function parseRoot(css) {
  // Every token in a `:root...{ }` block, last definition winning.
  const out = new Map();
  const blocks = css.matchAll(/:root([^{]*)\{([^}]*)\}/g);
  for (const [, selector, body] of blocks) {
    const id = (selector.match(/\[data-theme="([^"]+)"\]/) || [])[1] || null;
    const tokens = new Map();
    for (const [, name, value] of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+)/g)) {
      tokens.set(name, value.trim());
    }
    const key = id || ':root';
    out.set(key, new Map([...(out.get(key) || []), ...tokens]));
  }
  return out;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const colorsCss = fs.readFileSync(path.join(brand, 'colors.css'), 'utf8');
const themesCss = fs.readFileSync(path.join(brand, 'themes.css'), 'utf8');
const defaults = parseRoot(colorsCss).get(':root');
const themes = parseRoot(themesCss);

// The default palette lives in colors.css under a bare :root, so it is not one
// of the data-theme blocks. Test it on the same terms as the rest.
const all = new Map([['wcrg', defaults], ...themes]);

test('every theme in the manifest has a palette, and vice versa', () => {
  const declared = theme.list().map((t) => t.id).sort();
  const styled = [...all.keys()].sort();
  assert.deepEqual(styled, declared);
});

test('no theme invents a token the default palette does not define', () => {
  // A typo'd token name is invisible at runtime: the declaration is valid CSS
  // and simply never read. Comparing against colors.css catches it.
  for (const [id, tokens] of themes) {
    for (const name of tokens.keys()) {
      assert.ok(
        defaults.has(name),
        `${id} defines --${name}, which colors.css never declares`
      );
    }
  }
});

test('every theme overrides the whole palette, not part of it', () => {
  // A token a theme forgets silently inherits the default green-on-black,
  // which is how a stray phosphor line ends up in the middle of Solarized.
  const palette = [
    'bg', 'panel', 'panel-strip', 'panel-hover', 'inset', 'inset-deep',
    'green', 'green-bright', 'green-dim', 'green-shadow', 'green-bg', 'on-accent',
    'line', 'line-soft', 'line-mid', 'key-border', 'key-edge',
    'ink', 'ink-2', 'ink-3', 'muted', 'muted-2', 'muted-3', 'label', 'label-dim',
    'faint', 'ghost', 'amber', 'amber-bright', 'rec-red',
  ];
  for (const [id, tokens] of themes) {
    for (const name of palette) {
      assert.ok(tokens.has(name), `${id} never overrides --${name}`);
    }
  }
});

// The floors the design system's ladder is built on. --muted carries body
// prose and --muted-2 is described as the lowest tier legal for a sentence, so
// both sit at AA for normal text; the label tiers are non-text and sit at the
// large-text and UI-component bars.
const FLOORS = {
  ink: 7.0, 'ink-2': 6.5, 'ink-3': 5.5, muted: 5.0, 'muted-2': 4.5,
  'muted-3': 3.5, label: 3.0, 'label-dim': 2.4,
};

test('every ink tier clears its floor on its own panel', () => {
  for (const [id, tokens] of all) {
    const panel = tokens.get('panel');
    for (const [tier, floor] of Object.entries(FLOORS)) {
      const ratio = contrast(tokens.get(tier), panel);
      assert.ok(
        ratio >= floor - 0.05,
        `${id}: --${tier} is ${ratio.toFixed(2)}:1 on ${panel}, floor is ${floor}:1`
      );
    }
  }
});

test('no two ink tiers render identically', () => {
  // Two tiers that solve to the same hex are a hierarchy the components still
  // ask for and the palette no longer provides.
  for (const [id, tokens] of all) {
    const seen = new Map();
    for (const tier of Object.keys(FLOORS)) {
      const value = tokens.get(tier);
      assert.ok(!seen.has(value), `${id}: --${tier} is the same color as --${seen.get(value)}`);
      seen.set(value, tier);
    }
  }
});

test('the ink ladder never inverts', () => {
  const order = Object.keys(FLOORS);
  for (const [id, tokens] of all) {
    const panel = tokens.get('panel');
    let prev = Infinity;
    for (const tier of order) {
      const ratio = contrast(tokens.get(tier), panel);
      assert.ok(
        ratio <= prev + 0.05,
        `${id}: --${tier} (${ratio.toFixed(2)}:1) is brighter than the tier above it`
      );
      prev = ratio;
    }
  }
});

test('the accent is legible as text on its own panel', () => {
  // It is the timecode, the readouts, links and card titles, not just a fill.
  for (const [id, tokens] of all) {
    const ratio = contrast(tokens.get('green'), tokens.get('panel'));
    assert.ok(ratio >= 4.5 - 0.05, `${id}: accent is ${ratio.toFixed(2)}:1 on its panel`);
  }
});

test('the primary button label survives on both its fills', () => {
  for (const [id, tokens] of all) {
    const on = tokens.get('on-accent');
    // The default defers to another token; resolve it before measuring.
    const ink = on.startsWith('var(') ? tokens.get(on.slice(6, -1).replace(/^--/, '')) : on;
    for (const fill of ['green', 'green-bright']) {
      const ratio = contrast(ink, tokens.get(fill));
      assert.ok(
        ratio >= 4.5,
        `${id}: button label is ${ratio.toFixed(2)}:1 on --${fill}`
      );
    }
  }
});

test('a light theme reads as light and a dark one as dark', () => {
  for (const t of theme.list()) {
    const tokens = all.get(t.id);
    const l = luminance(hexToRgb(tokens.get('panel')));
    if (t.mode === 'light') assert.ok(l > 0.5, `${t.id} is declared light but its panel is not`);
    else assert.ok(l < 0.5, `${t.id} is declared dark but its panel is not`);
  }
});

test('surfaces stay distinguishable from each other', () => {
  // A strip or a hover that lands back on the panel is a control that stops
  // reading as a control. GitHub Light's page and panel are 2% apart, so this
  // is a real failure mode, not a hypothetical one.
  for (const [id, tokens] of all) {
    const panel = tokens.get('panel');
    for (const other of ['panel-strip', 'panel-hover', 'inset']) {
      assert.notEqual(tokens.get(other), panel, `${id}: --${other} is identical to --panel`);
    }
  }
});

test('the window background matches the palette it claims', () => {
  for (const t of theme.list()) {
    assert.equal(t.bg, all.get(t.id).get('bg'), `${t.id}: manifest bg disagrees with themes.css`);
  }
});

test('resolve() falls back rather than leaving the app unstyled', () => {
  assert.equal(theme.resolve({ theme: 'nord' }), 'nord');
  assert.equal(theme.resolve({ theme: 'does-not-exist' }), 'wcrg');
  assert.equal(theme.resolve({}), 'wcrg');
  assert.equal(theme.resolve(null), 'wcrg');
  assert.equal(theme.resolve(undefined), 'wcrg');
});

test('auto follows the system and lands on the right side of the switch', () => {
  const s = { theme: 'auto', themeLight: 'github-light', themeDark: 'dracula' };
  assert.equal(theme.resolve(s, true), 'dracula');
  assert.equal(theme.resolve(s, false), 'github-light');

  // A pairing naming a theme this build does not have still has to resolve,
  // and has to resolve to something of the right mode.
  const stale = { theme: 'auto', themeLight: 'gone', themeDark: 'gone' };
  assert.equal(theme.byId(theme.resolve(stale, true)).mode, 'dark');
  assert.equal(theme.byId(theme.resolve(stale, false)).mode, 'light');
});

test('the shipped defaults name themes that exist', () => {
  assert.ok(theme.byId(DEFAULTS.theme), `default theme ${DEFAULTS.theme} is missing`);
  assert.equal(theme.byId(DEFAULTS.themeLight).mode, 'light');
  assert.equal(theme.byId(DEFAULTS.themeDark).mode, 'dark');
});

test('the default look is still WCRG-TV', () => {
  // Themes are an addition. Anyone who already installed the app should not
  // find it repainted after an update.
  assert.equal(DEFAULTS.theme, 'wcrg');
  assert.equal(defaults.get('green'), '#4ee88a');
  assert.equal(defaults.get('bg'), '#0d0f0e');
});

test('chrome is derived, so a new theme cannot leave it behind', () => {
  const effects = fs.readFileSync(path.join(brand, 'effects.css'), 'utf8');
  const literal = effects.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || [];
  assert.deepEqual(literal, [], `effects.css still hardcodes ${literal.join(', ')}`);

  const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
  const strays = (styles.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || [])
    .filter((c) => !c.startsWith('rgba(var('));
  assert.deepEqual(strays, [], `styles.css hardcodes ${strays.join(', ')}`);
});

test('themes.css is what the generator would write today', () => {
  // Otherwise the checked-in CSS and the palette anchors drift apart, and the
  // next person to run the generator gets a diff they did not ask for.
  const { execFileSync } = require('node:child_process');
  const before = fs.readFileSync(path.join(brand, 'themes.css'), 'utf8');
  const beforeManifest = fs.readFileSync(path.join(brand, 'themes.json'), 'utf8');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-themes.js')], { stdio: 'ignore' });
  assert.equal(fs.readFileSync(path.join(brand, 'themes.css'), 'utf8'), before, 'themes.css is stale');
  assert.equal(fs.readFileSync(path.join(brand, 'themes.json'), 'utf8'), beforeManifest, 'themes.json is stale');
});
