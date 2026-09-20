// Generates renderer/brand/themes.css from the palette anchors below.
//
// Every theme keeps the ink ladder the design system defines: eight tiers of
// text, each at a measured contrast ratio against that theme's own panel. The
// upstream palettes were not authored with that ladder in mind — Nord's fg on
// Nord's panel is 7.6:1, not the 13.6:1 the original green-on-black managed —
// so tiers are solved per theme as a share of what the theme can actually
// reach, with hard floors so no tier that carries a sentence drops under AA.
//
// Run: node scripts/build-themes.js
const fs = require('fs');
const path = require('path');

// ---- color math -------------------------------------------------------

function parse(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}

function hex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

// sRGB relative luminance, per WCAG 2.1.
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(typeof a === 'string' ? parse(a) : a);
  const lb = luminance(typeof b === 'string' ? parse(b) : b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Straight sRGB interpolation. Matches what color-mix(in srgb) does in the
// renderer, so a color computed here and a color mixed at runtime agree.
function mix(a, b, t) {
  const ca = typeof a === 'string' ? parse(a) : a;
  const cb = typeof b === 'string' ? parse(b) : b;
  return ca.map((v, i) => v + (cb[i] - v) * t);
}

// The lightest (dark mode) or darkest (light mode) usable version of a hue:
// pushed toward the extreme only as far as the ladder's top tier needs.
function reachable(fg, panel, mode, target) {
  const pole = mode === 'dark' ? '#ffffff' : '#000000';
  if (contrast(fg, panel) >= target) return parse(fg);
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const t = (lo + hi) / 2;
    if (contrast(mix(fg, pole, t), panel) < target) lo = t; else hi = t;
  }
  return mix(fg, pole, hi);
}

// Walk from the panel toward the ink pole until the ratio lands on target.
function atRatio(inkPole, panel, target) {
  let lo = 0, hi = 1;
  if (contrast(inkPole, panel) < target) return inkPole;
  for (let i = 0; i < 40; i++) {
    const t = (lo + hi) / 2;
    if (contrast(mix(panel, inkPole, t), panel) < target) lo = t; else hi = t;
  }
  return mix(panel, inkPole, hi);
}

// ---- the ink ladder ---------------------------------------------------

// Share of the theme's achievable maximum, then a floor. The floors are what
// keep an upstream palette honest: --muted carries body prose and --muted-2 is
// the lowest tier the design system allows for a sentence, so both sit at AA
// for normal text no matter how low-contrast the source palette is.
const LADDER = [
  { name: 'ink',       share: 1.00, floor: 7.0,  note: 'titles' },
  { name: 'ink-2',     share: 0.83, floor: 6.5,  note: 'default body ink' },
  { name: 'ink-3',     share: 0.68, floor: 5.5,  note: 'secondary' },
  // 5.0 rather than 4.5 so this stays a visibly different tier from --muted-2
  // on the low-contrast palettes. At AA both would floor to 4.5 and render
  // identically, quietly flattening a distinction the components rely on.
  { name: 'muted',     share: 0.50, floor: 5.0,  note: 'body prose' },
  { name: 'muted-2',   share: 0.38, floor: 4.5,  note: 'lowest tier legal for a sentence' },
  { name: 'muted-3',   share: 0.31, floor: 3.5,  note: 'mono all-caps labels <=11px' },
  { name: 'label',     share: 0.26, floor: 3.0,  note: 'labels only' },
  { name: 'label-dim', share: 0.21, floor: 2.4,  note: 'labels only' },
];

function ladder(fg, panel, mode) {
  const top = LADDER[0].floor;
  const pole = reachable(fg, panel, mode, top);
  const max = contrast(pole, panel);
  const out = [];
  let prev = Infinity;
  for (const tier of LADDER) {
    // Never above what the theme can reach, never below the floor, never
    // brighter than the tier above it.
    let target = Math.max(tier.floor, max * tier.share);
    target = Math.min(target, max, prev);
    prev = target;
    const color = atRatio(pole, panel, target);
    out.push({ ...tier, color: hex(color), ratio: contrast(color, panel) });
  }
  return out;
}

// ---- derived surfaces and chrome --------------------------------------

function surfaces(t) {
  const dark = t.mode === 'dark';
  const down = '#000000';
  // A well is recessed: darker than the panel in both modes, because a hole in
  // a surface reads as a hole whichever way the lights are pointed.
  const inset = hex(mix(t.panel, down, dark ? 0.42 : 0.07));
  const insetDeep = hex(mix(t.panel, down, dark ? 0.6 : 0.12));
  // Strips and hovers move away from the panel, and in a light theme "away"
  // means down. Deriving them from --bg breaks on palettes whose page and
  // panel are already near-identical: GitHub Light is #f6f8fa on #ffffff, and
  // a strip mixed between them lands back on white.
  const strip = dark ? mix(t.panel, t.bg, 0.55) : mix(t.panel, down, 0.05);
  const hover = dark ? mix(t.panel, '#ffffff', 0.04) : mix(t.panel, down, 0.045);
  return {
    bg: t.bg,
    panel: t.panel,
    'panel-strip': hex(strip),
    'panel-hover': hex(hover),
    inset,
    'inset-deep': insetDeep,
  };
}

function lines(t, fg) {
  const dark = t.mode === 'dark';
  const down = '#000000';
  return {
    line: t.line || hex(mix(t.panel, fg, dark ? 0.14 : 0.20)),
    'line-soft': hex(mix(t.panel, fg, dark ? 0.08 : 0.12)),
    'line-mid': hex(mix(t.panel, fg, dark ? 0.22 : 0.32)),
    'key-border': hex(mix(t.panel, down, dark ? 0.35 : 0.14)),
    'key-edge': hex(mix(t.panel, down, dark ? 0.5 : 0.2)),
  };
}

// The accent family. --green* keeps its name across every theme: the design
// system named the token after the phosphor it started as, and renaming it in
// 51 places in styles.css would be churn for nothing.
//
// The accent has two jobs that pull against each other. It is text — readouts,
// links, card titles, the timecode — which needs 4.5:1 on the panel. It is also
// the primary button's fill, where the text sits on top of it. Several upstream
// accents miss the text bar on their own panel (Solarized Light's blue is
// 3.4:1), so the accent is nudged toward the theme's pole until it clears, and
// --on-accent picks whichever of black or white survives on the result.
const ACCENT_MIN = 4.5;

function legibleAccent(accent, panel, mode) {
  if (contrast(accent, panel) >= ACCENT_MIN) return parse(accent);
  return reachable(accent, panel, mode, ACCENT_MIN);
}

function onAccent(fill) {
  const white = contrast('#ffffff', fill);
  const black = contrast('#000000', fill);
  return white >= black ? '#ffffff' : '#111111';
}

function accents(t) {
  const dark = t.mode === 'dark';
  const a = hex(legibleAccent(t.accent, t.panel, t.mode));
  const bright = hex(mix(a, dark ? '#ffffff' : '#000000', dark ? 0.32 : 0.22));
  // One text color has to work on both the resting fill and the hover fill,
  // so pick against whichever of the two is harder.
  const worst = contrast('#ffffff', a) < contrast('#ffffff', bright) ? a : bright;
  return {
    green: a,
    'green-bright': bright,
    'green-dim': hex(mix(a, t.panel, 0.45)),
    'green-shadow': hex(mix(a, '#000000', dark ? 0.38 : 0.28)),
    'green-bg': hex(mix(a, t.panel, dark ? 0.86 : 0.88)),
    'on-accent': onAccent(worst),
  };
}

// ---- palette anchors --------------------------------------------------
//
// Upstream values, unretouched. Everything else on a theme is solved from
// these. `label` is what shows in Settings; `id` is the data-theme value.

const THEMES = [
  // --- dark ---
  { id: 'nord', label: 'Nord', mode: 'dark',
    bg: '#2e3440', panel: '#3b4252', fg: '#eceff4', accent: '#88c0d0', amber: '#ebcb8b', red: '#bf616a' },
  { id: 'dracula', label: 'Dracula', mode: 'dark',
    bg: '#21222c', panel: '#282a36', fg: '#f8f8f2', accent: '#bd93f9', amber: '#ffb86c', red: '#ff5555' },
  { id: 'tokyo-night', label: 'Tokyo Night', mode: 'dark',
    bg: '#1a1b26', panel: '#24283b', fg: '#c0caf5', accent: '#7aa2f7', amber: '#e0af68', red: '#f7768e' },
  { id: 'one-dark', label: 'One Dark', mode: 'dark',
    bg: '#21252b', panel: '#282c34', fg: '#abb2bf', accent: '#61afef', amber: '#e5c07b', red: '#e06c75' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', mode: 'dark',
    bg: '#11111b', panel: '#1e1e2e', fg: '#cdd6f4', accent: '#89b4fa', amber: '#f9e2af', red: '#f38ba8' },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark', mode: 'dark',
    bg: '#1d2021', panel: '#282828', fg: '#ebdbb2', accent: '#b8bb26', amber: '#fabd2f', red: '#fb4934' },
  { id: 'monokai', label: 'Monokai', mode: 'dark',
    bg: '#1e1f1c', panel: '#272822', fg: '#f8f8f2', accent: '#a6e22e', amber: '#fd971f', red: '#f92672' },
  { id: 'rose-pine', label: 'Rose Pine', mode: 'dark',
    bg: '#191724', panel: '#1f1d2e', fg: '#e0def4', accent: '#ebbcba', amber: '#f6c177', red: '#eb6f92' },
  { id: 'everforest', label: 'Everforest', mode: 'dark',
    bg: '#272e33', panel: '#2e383c', fg: '#d3c6aa', accent: '#a7c080', amber: '#dbbc7f', red: '#e67e80' },
  { id: 'solarized-dark', label: 'Solarized Dark', mode: 'dark',
    bg: '#002b36', panel: '#073642', fg: '#eee8d5', accent: '#2aa198', amber: '#b58900', red: '#dc322f' },
  // --- light ---
  { id: 'solarized-light', label: 'Solarized Light', mode: 'light',
    bg: '#eee8d5', panel: '#fdf6e3', fg: '#073642', accent: '#268bd2', amber: '#b58900', red: '#dc322f' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', mode: 'light',
    bg: '#e6e9ef', panel: '#eff1f5', fg: '#4c4f69', accent: '#1e66d5', amber: '#df8e1d', red: '#d20f39' },
  { id: 'github-light', label: 'GitHub Light', mode: 'light',
    bg: '#f6f8fa', panel: '#ffffff', fg: '#1f2328', accent: '#0969da', amber: '#9a6700', red: '#cf222e' },
  { id: 'gruvbox-light', label: 'Gruvbox Light', mode: 'light',
    bg: '#f2e5bc', panel: '#fbf1c7', fg: '#3c3836', accent: '#79740e', amber: '#b57614', red: '#9d0006' },
  { id: 'rose-pine-dawn', label: 'Rose Pine Dawn', mode: 'light',
    bg: '#f2e9e1', panel: '#fffaf3', fg: '#575279', accent: '#907aa9', amber: '#ea9d34', red: '#b4637a' },
];

// ---- emit -------------------------------------------------------------

function block(t) {
  const s = surfaces(t);
  const a = accents(t);
  const rungs = ladder(t.fg, t.panel, t.mode);
  const fgTop = rungs[0].color;
  const l = lines(t, fgTop);
  const dark = t.mode === 'dark';

  const L = [];
  L.push(`:root[data-theme="${t.id}"]{`);
  L.push(`color-scheme:${t.mode};`);
  L.push(`/* Surfaces */`);
  L.push(Object.entries(s).map(([k, v]) => `--${k}:${v}`).join(';') + ';');
  L.push(`/* Accent */`);
  L.push(Object.entries(a).map(([k, v]) => `--${k}:${v}`).join(';') + ';');
  L.push(`/* Lines */`);
  L.push(Object.entries(l).map(([k, v]) => `--${k}:${v}`).join(';') + ';');
  L.push(`/* Ink ladder — ratios measured on --panel (${t.panel}) */`);
  for (const r of rungs) {
    L.push(`--${r.name}:${r.color};`.padEnd(20) + `/* ${r.ratio.toFixed(1)}:1 — ${r.note} */`);
  }
  L.push(`--faint:${hex(mix(t.panel, fgTop, 0.18))};  /* decorative glyphs */`);
  L.push(`--ghost:${hex(mix(t.panel, fgTop, 0.07))};  /* intentionally invisible */`);
  L.push(`/* Signal */`);
  L.push(`--amber:${t.amber};--amber-bright:${hex(mix(t.amber, dark ? '#ffffff' : '#000000', 0.25))};--rec-red:${t.red};`);
  if (!dark) {
    L.push(`/* Light chrome: shadows thin out, the bevel highlight becomes the light source */`);
    L.push(`--shadow:#1c1917;--hilite:#ffffff;`);
    L.push(`--a-hilite:65%;--a-drop:10%;--a-well:13%;--a-key-top:90%;--a-key-bot:7%;--a-key-drop:12%;--a-key-down:16%;--a-primary-top:55%;--a-label:14%;--a-overlay:78%;`);
    L.push(`--key-lift-1:100%;--key-lift-2:70%;`);
  }
  L.push(`}`);
  return L.join('\n');
}

const header = `/* Generated by scripts/build-themes.js — edit the palette anchors there.
   Each theme overrides the palette only. Shadows, key faces and glows are
   derived from these tokens in effects.css, so a theme never restates chrome.
   The --green* family keeps its name in every theme; it is the accent slot,
   named for the phosphor it started as. */\n`;

const css = header + THEMES.map(block).join('\n\n') + '\n';
fs.writeFileSync(path.join(__dirname, '..', 'renderer', 'brand', 'themes.css'), css);

// A manifest so the renderer, the settings UI and the main process agree on
// what exists. `bg` is here so the window can be created already wearing the
// right page color instead of flashing the default dark on a light theme.
const manifest = [
  { id: 'wcrg', label: 'WCRG-TV Ch. 90', mode: 'dark', bg: '#0d0f0e' },
  ...THEMES.map(({ id, label, mode, bg }) => ({ id, label, mode, bg })),
];
fs.writeFileSync(
  path.join(__dirname, '..', 'renderer', 'brand', 'themes.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);

console.log(`themes.css: ${THEMES.length} themes`);
for (const t of THEMES) {
  const rungs = ladder(t.fg, t.panel, t.mode);
  const acc = contrast(accents(t).green, t.panel);
  console.log(
    `  ${t.id.padEnd(18)} ${t.mode.padEnd(5)} ink ${rungs[0].ratio.toFixed(1).padStart(4)}:1  ` +
    `body ${rungs[3].ratio.toFixed(1)}:1  floor ${rungs[7].ratio.toFixed(1)}:1  accent ${acc.toFixed(1)}:1`
  );
}

module.exports = { THEMES, contrast, ladder, parse, hex, mix, surfaces, accents, lines, LADDER };
