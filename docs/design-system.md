# Design system integration

The source guidelines below were supplied in `WCRG-TV Ch. 90 Design System.zip`.
They are brand reference material. Website examples and sample catalog content
in that package are not application features or production data.

## Application mapping

- `renderer/brand/` contains the supplied color, type, spacing and effect tokens.
- `renderer/styles.css` adapts those tokens to the desktop editor. The monitor
  fills available space; the control rack is 316px. The app retains its resizable
  segment list and supports its 900×640 minimum window size.
- Fonts are bundled under `renderer/brand/fonts/`, with their licenses. Local CSS
  loads them without CDN requests or cross-origin font preloads on file URLs.
- Green identifies controls, readouts and saved clips. Skipped clips use neutral
  gray, outlined indicators and explicit SAVE/SKIP labels. White marks edit handles.
  Cream is reserved for the source tape label. There is no decorative red lamp.
- Body copy uses Archivo and off-white ink. Titles use Archivo Narrow; instrument
  labels and keys use IBM Plex Mono. The tape label uses Permanent Marker.
- Surfaces are flat; inputs are recessed and keys travel 2px on press. No scanline
  overlay, vignette, glass blur or autonomous decoration is applied to the editor.
- Help and export-mode switches remain keyboard-accessible. Focus outlines stay
  visible, and reduced-motion preferences disable animation and transitions.
- The source React examples were translated into the existing HTML/CSS interface;
  the supplied scripts and bundles are not loaded by the app.

## Theming

The tokens above are the default palette, not the only one. `renderer/brand/themes.css`
adds fifteen further palettes as `:root[data-theme="..."]` blocks, each overriding the
surfaces, accent, lines, ink ladder and signal colors and nothing else. Shadows, bevels,
key faces and glows live in `effects.css` and are derived from those tokens with
`color-mix()`, so a palette never restates a shadow recipe and cannot leave the chrome
behind on green.

The rules above still hold inside a theme. The accent identifies controls, readouts and
saved clips; skipped clips stay neutral; white marks edit handles; cream stays reserved
for the source tape label and is the one family a theme does not override, because it
means physical label stock rather than a color choice. Surfaces stay flat, inputs stay
recessed, keys still travel 2px.

Ink tiers are solved per theme rather than copied, because the upstream palettes were
not authored against this ladder. Each tier is a share of the contrast that theme can
actually reach on its own panel, floored so that `--muted` and `--muted-2` — body prose
and the lowest tier the system allows for a sentence — stay at AA for normal text. The
accent is nudged toward the theme's pole where it misses 4.5:1 as text, and `--on-accent`
picks black or white for the primary button's label. `tests/themes.test.js` enforces all
of it against the committed CSS.

## Visual checks

Review the empty editor, a loaded timeline, Settings, Guide, export controls and
progress dialog at 1280×820 and 900×640, in the default theme and in at least one
light theme. Also check a narrow stacked layout,
keyboard focus, help text on/off and resizing the segment list.
Screenshots under `docs/screenshots/brand-*.png` show the integrated renderer.

---

## Original brand reference

# WCRG-TV Ch. 90 — the 90s Craig design system

A 1990s broadcast master control room, held at a strength where it reads as
unusually well-organized equipment rather than as a costume. Built for **90s
Craig**, a VHS archive and lost-media preservation project: tapes recorded off
air in northern Illinois between 1993 and 1999, logged, cleaned, digitized and
catalogued.

## Sources

This system was authored from a **written brand brief supplied in chat** (the
"WCRG-TV Ch. 90 — Design System" document: colors, type scale, geometry, shadow
recipes, component recipes, voice table, CSS custom properties). There was no
codebase, Figma file, slide deck, or asset package attached — so:

- **No logo file exists.** The mark is set in type (Archivo Narrow 700, phosphor
  green, wordmark glow) wherever a logo would go. Nothing was drawn or invented.
- **No product screens were supplied.** The UI kit in `ui_kits/site/` is composed
  from the brief's own rules and voice, not recreated from an existing product.
- **Fonts are CDN-hosted** (Google Fonts: IBM Plex Mono, Archivo, Archivo Narrow,
  Permanent Marker) via `tokens/fonts.css`. No font binaries were provided;
  self-host and preload Plex Mono 600 + Archivo Narrow 700 in production.

If a real repo, Figma file, logo or webfont package exists, attach it and this
system should be re-derived against it.

## The one rule

**Phosphor green is for the machine. White is for the words.** Green labels the
instruments — panel strips, readouts, catalog numbers, LEDs, keys, links.
Anything a person actually reads is off-white on panel grey. The moment body copy
turns green the system becomes a novelty and stops being usable.

---

## CONTENT FUNDAMENTALS

**Voice:** plain, specific, faintly deadpan. The interest is in the material, so
the writing does not perform.

- **Person:** first person singular for the archivist ("I log the pass count on
  the spine label"), second person for the reader ("Postage back if you want the
  tape returned"). Never corporate "we".
- **Casing:** sentence case for headlines and prose. ALL CAPS **only** in mono
  instrument text — panel strips, readouts, field labels, key labels, station
  furniture. Handwritten hooks are lowercase, as if scrawled.
- **Length:** short declaratives. Answers are allowed to be two words long —
  "Usually a day or two." A sentence that hedges gets cut.
- **Specificity over enthusiasm:** "Forty minutes of the same cold front" beats
  "an amazing find". Numbers are real or absent.
- **Station furniture** — `WCRG-TV CH. 90`, catalog numbers (`C-0412`),
  `SP MODE`, `END OF TAPE · PLEASE REWIND` — is played straight, never winked at.
  It works because it is treated as real.
- **Emoji: never.** The system's glyph set (▶ ● ★ ✓ ◀ → ✕) does the job.

| Yes | No |
| --- | --- |
| "The stuff that was never meant to survive." | "Welcome to my VHS collection!" |
| "Usually a day or two." | "We value your message and will respond promptly." |
| "No pressure and no wishlist." | "Donations gratefully accepted — see our needs list." |
| "Written from doing it, not from reading about it." | "The ultimate guide to thrifting VHS in 2026!" |
| "no label, no idea what this is" (hook) | "An Incredible Find You Won't Believe" |

**Never** publish follower, subscriber or view counts — they date the page and
move focus off the work.

---

## VISUAL FOUNDATIONS

**Backgrounds.** Flat colour only. Page is `--bg #0d0f0e` (warm near-black, never
pure black); every container is `--panel #161918`. Two greys, full stop — no third
background grey, no gradient backgrounds, no glassmorphism, no photographic or
illustrated backdrops. Gradients appear in exactly two places, both mechanical:
the key face (`linear-gradient(#2c322e,#1b1f1d)`) and the active key face
(`linear-gradient(#0e1f16,#123024)`).

**Colour.** One accent hue: phosphor green. Amber is signal only (the handwritten
hook line, required asterisks, RESET). Red is the tally lamp and nothing else.
Cream `#e9e3d0` is the single warm surface and always means *a physical label*.
Prose sits at 4.5:1 or better on panel grey; the three dimmest greys are reserved
for short mono all-caps legends where they read as etched panel text.

**Type.** Four families, one job each: IBM Plex Mono is the voice of the machine
(everything technical), Archivo Narrow is headlines and titles only, Archivo is
body prose and UI text, Permanent Marker is handwritten hooks — two or three uses
per page, maximum. Body prose runs 16.5px / 1.75. Long-form article prose caps at
`66ch`; everything else runs the full width of its container.

**Spacing & layout.** Scale is 4 / 5 / 7 / 9 / 11 / 13 / 14 / 16 / 18 / 22 / 26 /
30 / 34 / 38. Panel stack gap 22px, rack module gap 14px, chip and key gap 5–9px.
Container 1240px with 22px gutters, centered. Sticky header at min 62px; sticky
sidebars offset `top: 82px`. The sidebar rack is always exactly 316px. Four
min-width breakpoints: 760 (featured card splits), 1000 (page grid gains the
rack), 1080 (header readouts appear), 1180 (hero splits). Page headers are
full-bleed: an eyebrow strip band, then a title band, each spanning the viewport
with inner content held to the container width.

**Corner radii.** Panel 5px · key 4px · input and small panel 3px · label strip,
thumbnail and tag 2px · LED 50%. Nothing is pill-shaped except an LED, which is
round because it is a lamp.

**Cards.** A card is a panel: `--panel` face, `1px solid --line`, 5px radius, and a
labeled strip across the top in `--panel-strip` with a 1px bottom border. Three
variants — standard, **lit** (`--green-dim` border + `--sh-lit` glow, one per page,
for the single thing you want acted on) and **seated** (adds `--sh-panel`, for page
headers and hero panels). An unlabeled panel looks like a web card, not equipment.

**Shadows.** Two families. Panels are *seated*: `inset 0 1px 0 rgba(255,255,255,.05),
0 10px 30px rgba(0,0,0,.4)`. Anything that receives input is *recessed*:
`inset 0 2px 5px rgba(0,0,0,.6)` over `--inset` with a `--line-mid` border. Keys
carry a 1px top highlight and a hard 2–3px bottom edge. No soft ambient
drop-shadow "elevation" system — depth here is machined, not floating.

**Hover states.** Panels and rows lighten one step to `--panel-hover #191d1b`.
Secondary key text goes `--ink-3` → `--green`. Primary keys go `--green` →
`--green-bright`. Links go green → bright green with the underline brightening.
Never opacity fades, never scale-ups.

**Press states.** Real mechanical travel: `translateY(2px)` while the raised
shadow collapses to `--sh-key-down`. Current-state nav keys sit permanently
recessed with phosphor bleeding from under the edge (`--sh-key-active`) and do not
travel. **If it doesn't move when pressed, it's wrong.**

**Borders.** 1px, always. `--line` for panel edges and strip dividers,
`--line-soft` for internal row dividers, `--line-mid` for input and chip outlines,
`--key-border` under keys. No 2px accents, no coloured left-border cards.

**Transparency and blur.** Effectively none. Transparency exists only inside
shadow recipes and glow colours. No backdrop-filter, no frosted overlays, no
protection gradients — text sits on flat panel, so it never needs protecting.
Overlays (dialogs) use flat `--inset-deep` at high opacity, not blur.

**Animation.** Almost nothing moves on its own. Two keyframe animations exist:
`rec` (1.6s, hard `steps(1)` — the step is what makes it read as hardware) and
`led` (2.4s ease-in-out breathing). Interaction feedback is instantaneous:
transform is immediate, colour transitions ≤120ms linear. No bounces, no
parallax, no scroll reveals. `prefers-reduced-motion` disables both animations
and leaves the dots at full opacity.

**Effects.** Scanlines are a fixed, non-interactive overlay at ~2.8% white,
1px on / 2px off, gated behind a setting and never placed over interactive
content. No CRT curvature, chromatic aberration or heavy grain.

**Phosphor glow — three places only:** the wordmark (`0 0 12px rgba(78,232,138,.45)`),
the active nav key (`0 0 10px rgba(78,232,138,.55)`), and large mono readouts
(`0 0 14px rgba(78,232,138,.3)`).

**Imagery.** Tape thumbnails are portrait **2:3** — the physical objects are
taller than wide (62×84 in a card grid, 68×92 in a list row, 232×290 on a detail
page). Images sit in a recessed `--inset-deep` well with a `--line-mid` border and
a 2px radius, so a photo reads as a slide in a holder. Source imagery is expected
to be warm, low-contrast, slightly degraded — off-air captures and shelf
photography, not studio product shots. An empty well shows a `▶` glyph in
`--faint`, never a placeholder illustration.

---

## ICONOGRAPHY

There is no icon font, no SVG sprite and no icon library in this system, and none
was supplied. **Icons are typographic glyphs** set in IBM Plex Mono, in
`--green` when they mark a control and `--faint` when decorative:

`▶` play / open · `◀` back · `●` record, radio-set, bullet · `■` stop ·
`★` flagged · `✓` checked · `✕` close, dismiss · `→` continue, read on ·
`·` meta separator

Rules: no emoji, ever. No hand-drawn SVG substitutes — if a glyph can't say it,
use a mono caps word instead ("REC", "DUB", "EJECT"), which is what real equipment
does. If a future need genuinely requires a drawn icon set, add a CDN set with a
1.5px stroke (Lucide is the closest match to the mono weight) and record the
substitution here — do not mix two icon vocabularies.

Assets: `assets/` is intentionally empty of a logo. See "Sources" above.

---

## Intentional additions

The brief specified components loosely (panel, keys, readouts, wells, LEDs, cream
labels). These were added because the brief's own screens require them and each is
a direct application of its rules — flagged so nobody mistakes them for supplied
inventory: `PanelRow`, `Rack`, `NavKeys`, `Chip`, `Meter`, `Field`,
`Toggle`, `StripLabel`/`CatalogNumber`, `HandNote`, `TapeCard`, `PageHeader`,
`PullQuote`.

---

## Index

**Root**
- `styles.css` — the single stylesheet consumers link. `@import` lines only.
- `readme.md` — this file.
- `SKILL.md` — Agent Skills entry point.
- `thumbnail.html` — homepage tile.

**`tokens/`** — `fonts.css` (Google Fonts import), `colors.css`, `typography.css`,
`spacing.css`, `effects.css` (shadows, gradients, glows, keyframes), `base.css`
(element defaults, link colours, `.scanlines`).

**`components/`** — each directory has `<Name>.jsx`, `<Name>.d.ts`,
`<Name>.prompt.md` and one `@dsCard` HTML.
- `panels/` — `Panel`, `PanelRow`, `Rack`
- `controls/` — `Key`, `Chip`, `NavKeys`
- `instruments/` — `Readout`, `ReadoutRow`, `LED`, `Meter`
- `forms/` — `Field`, `Input`, `Textarea`, `Select`, `Toggle`
- `labels/` — `CreamLabel`, `HandNote`, `StripLabel`, `CatalogNumber`
- `content/` — `TapeCard`, `PageHeader`, `PullQuote`

**`guidelines/`** — foundation specimen cards: surfaces, phosphor, lines, ink
ladder, cream stock, signal (Colors); display, body, mono, hand (Type); scale,
radii, page grid (Spacing); key shadows, panel shadows, scanlines, wordmark,
glyph set (Brand).

**`ui_kits/site/`** — the 90s Craig website: `index.html` (click-through),
`SiteChrome.jsx`, `CatalogScreen.jsx`, `TapeScreen.jsx`, `NotesScreen.jsx`,
`IntakeScreen.jsx`, `README.md`.

**`templates/tape-catalog/`** — `TapeCatalog.dc.html`, a copyable catalog-page starting point for consuming projects (plus `ds-base.js`, which points at this system's stylesheet and bundle).

**`assets/`** — no logo supplied; see Sources.

---

## Always / Never

**Always** — derive every number on screen from real data · give each panel a
labeled strip · let keys move on press · run text full width unless it is
long-form article prose · keep prose at 4.5:1 or better · play the station fiction
straight · portrait 2:3 tape thumbnails · full-bleed page headers.

**Never** — green body copy · a third background grey or a second accent hue ·
Permanent Marker more than two or three times on a page · follower or view counts
· gradient backgrounds, glassmorphism or heavy CRT distortion · emoji · scanlines
over interactive content · effects that ignore `prefers-reduced-motion`.
