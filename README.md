# VHS Editor (Windows)

A lightweight Windows companion for digitizing VHS tapes — a clone of the macOS
app *Video Barbershop*, focused on its killer feature: **automatic commercial
detection and removal**, plus a simple VHS color fix and flexible export.

Built with Electron + FFmpeg.

## What it does (v1)

1. **Import** a long capture (MP4 / MKV / AVI / MOV / TS…).
2. **Detect commercials** automatically. It runs one FFmpeg pass looking for two
   signals that mark program↔ad boundaries on broadcast recordings:
   - **fade-to-black** (`blackdetect`), and
   - **audio drop** (`silencedetect`).
   A black interval that *coincides* with silence is a high-confidence boundary.
   The recording is split into segments; short segments between boundaries are
   auto-guessed as commercials (cut), long segments as program (keep).
3. **Review** on a color-coded timeline and segment list. Click a segment's tag
   (or double-click it on the timeline) to flip keep↔cut. Click a segment to
   jump the preview player to it. "Keep all" / "Invert" for bulk edits.
4. **Color fix** (optional): brightness / contrast / saturation to undo the
   dark, washed-out CRT look.
5. **Export**: one merged clean file, or one clip per kept segment. Your choice
   per job. Cut segments (and sub-threshold micro-gaps) are dropped.

### Detection tuning

If detection is too eager or too shy on your tapes, adjust the sliders:
- **Black sensitivity** — how dark a frame must be to count (higher = looser).
- **Silence threshold** — how quiet audio must fall to count as a drop.
- **Min commercial gap** — ignores boundary gaps shorter than this (noise).
- **Max commercial length** — segments shorter than this are guessed as ads.

## Running it (development)

```powershell
npm install       # one time
npm start
```

## Building an installer (distribution)

FFmpeg/FFprobe are bundled automatically via `ffmpeg-static` / `ffprobe-static`
(fetched during `npm install`) and packed as unpacked resources, so end users
need nothing installed.

```powershell
npm install       # pulls the bundled FFmpeg binaries too
npm run dist       # → dist\90s-Craig-Edit-Booth-Setup-<ver>.exe    (installer)
                   #   dist\90s-Craig-Edit-Booth-Portable-<ver>.exe (portable)
npm run pack       # unpacked app only (dist\win-unpacked), for quick testing
```

## Releasing an update (auto-update)

The installed app checks GitHub releases on launch and notifies the user
(nothing installs without their consent). To publish a new version:

```powershell
npm run release -- patch   # bump 0.1.0 → 0.1.1, build, and create the release
npm run release -- minor   # 0.1.0 → 0.2.0
npm run release            # release the current version as-is
```

This builds and creates a GitHub release (installer + portable + `latest.yml`)
via the `gh` CLI, which must be installed and authenticated (`gh auth login`).

**Auto-update only reaches users when the repo is public** — a private repo's
release assets require authentication to download. Flip the repo to public when
you're ready; no code changes needed.

The app is **unsigned**, so Windows SmartScreen shows an "unknown publisher"
warning (More info → Run anyway). Removing it requires a code-signing
certificate (e.g. Azure Trusted Signing).

Notes:
- Output is unsigned, so Windows SmartScreen shows an "unknown publisher"
  warning (users click **More info → Run anyway**). Add a code-signing
  certificate in `build.win.certificateFile`/`CSC_LINK` to remove it.
- Bump `version` in `package.json` before each release.
- See `THIRD-PARTY-NOTICES.md` for the bundled FFmpeg license.
- Test the installer on a clean PC (no FFmpeg, no dev tools) to confirm the
  bundled binaries resolve.

## FFmpeg

The app looks for `ffmpeg.exe` / `ffprobe.exe` in this order:

1. `FFMPEG_PATH` / `FFPROBE_PATH` environment variables
2. `vendor/ffmpeg/` inside this project (self-contained)
3. The copy bundled with Nickvision Parabolic (auto-detected on this machine)
4. Whatever is on your `PATH`

To make it fully self-contained, run `npm run setup-ffmpeg` (copies a local
build into `vendor/ffmpeg/`), or drop your own `ffmpeg.exe` + `ffprobe.exe`
there. Windows builds: https://www.gyan.dev/ffmpeg/builds/

## Notes & limits (v1)

- Export **re-encodes** kept segments (libx264/AAC, CRF 18) so cuts are
  frame-accurate on VHS captures that lack clean keyframes.
- Preview uses the built-in HTML5 player. H.264 MP4 previews everywhere; some
  MKV codecs may not preview even though detection/export still work.
- This is a personal-use build (no installer/signing yet).

## Roadmap (not in v1)

Bulk/batch queue across many tapes · aspect-ratio & resolution presets with
letterboxing · text overlays / watermarks / keyframe FX · metadata reports.
