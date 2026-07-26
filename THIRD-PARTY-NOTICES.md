# Third-Party Notices

VHS Commercial Cutter bundles and uses the following third-party software.

## FFmpeg
This application bundles **FFmpeg** (`ffmpeg` and `ffprobe`) and invokes it as a
separate process for all video/audio analysis and encoding.

- The bundled `ffmpeg` is the **gyan.dev "essentials" Windows build of FFmpeg
  6.1.1**, configured with `--enable-gpl --enable-version3`, and is therefore
  under the **GNU GPL v3 or later**. It is redistributed unmodified.
- It ships via the `ffmpeg-static` npm package (5.3.0), which declares
  `GPL-3.0-or-later`. `ffprobe` comes from `ffprobe-static`.
- FFmpeg project and sources: https://ffmpeg.org  ·  https://git.ffmpeg.org/ffmpeg.git
- Windows build and its sources: https://www.gyan.dev/ffmpeg/builds/
- GPL v3 text: https://www.gnu.org/licenses/gpl-3.0.html
- FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

The app itself (MIT, see LICENSE) does not link against FFmpeg. It runs the
binaries as separate processes and passes them arguments.

## Electron
Built on **Electron** (MIT) and Chromium/Node.js. See https://electronjs.org.
