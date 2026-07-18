// Optional: make the app self-contained by copying ffmpeg/ffprobe into
// vendor/ffmpeg. If a local copy (e.g. the one bundled with Nickvision
// Parabolic) is found it is copied; otherwise instructions are printed.
const fs = require('fs');
const path = require('path');

const dest = path.join(__dirname, '..', 'vendor', 'ffmpeg');
const knownSources = [
  path.join('C:\\Program Files (x86)', 'Nickvision Parabolic', 'Release'),
];

function findSource() {
  for (const dir of knownSources) {
    const ff = path.join(dir, 'ffmpeg.exe');
    const fp = path.join(dir, 'ffprobe.exe');
    if (fs.existsSync(ff) && fs.existsSync(fp)) return dir;
  }
  return null;
}

const src = findSource();
if (!src) {
  console.log('No local ffmpeg found to copy.');
  console.log('The app will still use ffmpeg from PATH or set FFMPEG_PATH / FFPROBE_PATH.');
  console.log('To bundle: download a Windows build from https://www.gyan.dev/ffmpeg/builds/');
  console.log(`and place ffmpeg.exe + ffprobe.exe in: ${dest}`);
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
  const from = path.join(src, name);
  const to = path.join(dest, name);
  process.stdout.write(`Copying ${name} … `);
  fs.copyFileSync(from, to);
  console.log('done');
}
console.log(`\nBundled ffmpeg into ${dest}`);
