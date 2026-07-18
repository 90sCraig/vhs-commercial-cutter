<div align="center">

<img src="docs/icon.png" width="128" alt="90s Craig Edit Booth" />

# 90s Craig Edit Booth

**Find and cut the commercials out of digitized VHS tapes — then keep the show, or turn the ads into vertical clips for TikTok & Reels.**

![Windows](https://img.shields.io/badge/Windows-x64-2b3136?logo=windows&logoColor=5fce8c)
![Built with Electron](https://img.shields.io/badge/Electron-33-2b3136?logo=electron&logoColor=5fce8c)
![FFmpeg](https://img.shields.io/badge/FFmpeg-bundled-2b3136?logo=ffmpeg&logoColor=5fce8c)
![License](https://img.shields.io/badge/license-MIT-2b3136)

<img src="docs/screenshots/hero.png" alt="90s Craig Edit Booth — detecting commercials on a tape" width="880" />

</div>

---

## What it does

Digitizing a shelf of old VHS tapes leaves you with long captures full of commercials. **90s Craig Edit Booth** scans a capture for the fade-to-black + audio-silence marks that sit between the show and the ads, splits it into clips, and lets you:

- 📺 **Make a clean tape** — the program with commercials removed, as one file.
- 🎬 **Make social clips** — the *commercials themselves*, reframed to vertical 9:16 with a blurred background, ready to post.

It's a fast, focused companion — not a full NLE. Point it at a tape, review, export.

## Features

- **Automatic commercial detection** — black-frame + audio-silence correlation, with tunable sensitivity.
- **Editable timeline** — zoom, minimap overview, drag boundaries, split / merge, set in/out, frame-step keyboard nav.
- **Fast preview** — builds a small local proxy so scrubbing huge MKV/network captures stays smooth (with an LRU cache you control).
- **Restore** — denoise/sharpen by tape speed, brightness/contrast/saturation/gamma, RGB balance, audio-drift fix.
- **Flexible export** — source or vertical/portrait/square reframing, quality/resolution/frame-rate presets, custom filenames, one-click **Clean tape** / **Social clips** presets.
- **GPU acceleration** — CPU (x264) or NVIDIA / Intel / AMD hardware encode + decode for export, previews, and detection, with automatic CPU fallback.
- **Self-contained** — FFmpeg is bundled; nothing else to install.
- **Auto-update** — notify-first: you decide when to download and install.

## Download & install

Grab the latest **[Release](https://github.com/90sCraig/vhs-commercial-cutter/releases/latest)**:

- **`…-Setup-<ver>.exe`** — installer (Start-menu shortcut + uninstaller)
- **`…-Portable-<ver>.exe`** — single exe, no install

> The app is unsigned, so Windows SmartScreen shows an "unknown publisher" prompt the first time. Click **More info → Run anyway**. Windows x64.

## Quick start

1. **Open a capture** — click *Open capture…* or drag a video onto the player. MP4 / MKV / AVI / MOV and more.
2. **Detect commercials** — click *Detect commercials*. Clips appear on the timeline, colored **green = keep** / **red = cut**.
3. **Review & fix** — click a clip to play it; flip keep/cut with a click or `K`; drag the yellow boundaries, or `S` split / `M` merge / `I`·`O` set in-out.
4. **Pick a preset** — **📺 Clean tape** or **🎬 Social clips**.
5. **Export** — pick a folder and go. Your full-quality original is always the source; the preview is just for speed.

<div align="center">
<img src="docs/screenshots/guide.png" alt="In-app guide" width="440" />
&nbsp;&nbsp;
<img src="docs/screenshots/settings.png" alt="Settings — proxy cache, encoder, updates" width="440" />
</div>

<sub>A built-in **Guide** (left) walks through everything, and **Settings** (right) controls the preview-proxy cache, the CPU/GPU encoder, and updates.</sub>

## Made by 90s Craig

<!-- LINKS: replace the # placeholders with your real channel URLs -->
- ▶️ **YouTube** — [90s Craig](#)
- 🎵 **TikTok** — [@90scraig](#)
- 📸 **Instagram** — [@90scraig](#)
- 🦋 **Bluesky** — [90scraig](#)
- 💬 **Discord** — [join](#)

## Building from source

FFmpeg/FFprobe are fetched during `npm install` (via `ffmpeg-static` / `ffprobe-static`) and bundled, so end users need nothing installed.

```powershell
npm install       # also pulls the bundled FFmpeg binaries
npm start          # run in dev
npm run dist       # build installer + portable into dist\
npm run pack       # unpacked app only (dist\win-unpacked)
```

## Releasing an update

The installed app checks GitHub releases on launch and notifies the user (nothing installs without consent). To publish a new version:

```powershell
npm run release -- patch   # bump 0.1.0 → 0.1.1, build, create the release
npm run release -- minor   # 0.1.0 → 0.2.0
npm run release            # release the current version as-is
```

Requires the GitHub CLI (`gh auth login`). **Auto-update only reaches users when the repository is public** — a private repo's release assets need authentication to download.

## Tech

Electron · FFmpeg (bundled) · electron-builder. No native modules — the app drives FFmpeg as a subprocess.

## License

[MIT](LICENSE). Bundles FFmpeg (LGPL/GPL, used as a separate process) — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
