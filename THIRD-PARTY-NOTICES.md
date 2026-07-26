# Third-Party Notices

VHS Commercial Cutter bundles and uses the following third-party software.

## FFmpeg
This application bundles **FFmpeg** (`ffmpeg` and `ffprobe`) and invokes it as a
separate process for all video/audio analysis and encoding.

- FFmpeg is licensed under the **LGPL v2.1+ / GPL v2+** depending on the build.
- The bundled binaries are provided via the `ffmpeg-static` and `ffprobe-static`
  npm packages.
- FFmpeg source and license: https://ffmpeg.org  ·  https://www.gnu.org/licenses/
- FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

Because FFmpeg is used as a standalone executable (not linked into the app),
this constitutes mere aggregation. The FFmpeg binaries are redistributed
unmodified.

## Electron
Built on **Electron** (MIT) and Chromium/Node.js. See https://electronjs.org.
