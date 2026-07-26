// Resolves the ffmpeg / ffprobe binaries and provides small exec helpers.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Path to the binary bundled via ffmpeg-static / ffprobe-static. When the app
// is packaged the module lives inside app.asar, but the executable is unpacked
// to app.asar.unpacked (see build.asarUnpack) — rewrite the path accordingly.
function staticBinary(name) {
  try {
    const p = name === 'ffprobe'
      ? require('ffprobe-static').path
      : require('ffmpeg-static');
    return p ? p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : null;
  } catch (_) {
    return null;
  }
}

// Candidate locations, in priority order:
//  1. explicit env override (power users)
//  2. the bundled static binary (ships with the app — the normal case)
//  3. a copy dropped into the project's vendor folder
//  4. known-good copy inside Nickvision Parabolic (dev machine convenience)
//  5. whatever is on PATH
function resolveBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    process.env[`${name.toUpperCase()}_PATH`],
    staticBinary(name),
    path.join(__dirname, '..', 'vendor', 'ffmpeg', exe),
    path.join('C:\\Program Files (x86)', 'Nickvision Parabolic', 'Release', exe),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  return exe; // fall back to PATH lookup
}

const FFMPEG = resolveBinary('ffmpeg');
const FFPROBE = resolveBinary('ffprobe');

function ffprobeInfo(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const proc = spawn(FFPROBE, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err || code}`));
      try {
        const json = JSON.parse(out);
        const v = (json.streams || []).find((s) => s.codec_type === 'video') || {};
        const a = (json.streams || []).find((s) => s.codec_type === 'audio') || {};
        resolve({
          duration: parseFloat(json.format?.duration) || 0,
          width: v.width || 0,
          height: v.height || 0,
          fps: parseFrameRate(v.avg_frame_rate || v.r_frame_rate),
          vcodec: v.codec_name || '',
          acodec: a.codec_name || '',
          hasAudio: !!a.codec_name,
          size: parseInt(json.format?.size, 10) || 0,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseFrameRate(str) {
  if (!str) return 0;
  const [n, d] = str.split('/').map(Number);
  if (!d) return n || 0;
  return n / d;
}

// --- job cancellation --------------------------------------------------
// Only one long job (a detection scan or an export) runs at a time, so a
// single flag plus a registry of live processes covers it. Cancelling kills
// whatever is running and makes any later spawn fail immediately, so a
// multi-step job stops instead of starting its next step.
const live = new Set();
let cancelled = false;

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

function beginJob() { cancelled = false; }
function isCancelled() { return cancelled; }
function cancelJob() {
  cancelled = true;
  for (const p of live) {
    try { p.kill(); } catch (_) { /* already gone */ }
  }
  live.clear();
  return true;
}

// Spawns ffmpeg, streaming stderr lines to onLine. Resolves on success.
function runFfmpeg(args, { onLine, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (cancelled) return reject(new CancelledError());
    const proc = spawn(FFMPEG, args);
    live.add(proc);
    let tail = '';
    let stderrAll = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrAll += text;
      if (stderrAll.length > 200000) stderrAll = stderrAll.slice(-100000);
      tail += text;
      const lines = tail.split(/\r\n|\r|\n/);
      tail = lines.pop();
      for (const line of lines) {
        if (onLine) onLine(line);
        if (onProgress) {
          const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (m) {
            const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
            onProgress(secs);
          }
        }
      }
    });
    proc.on('error', (e) => { live.delete(proc); reject(e); });
    proc.on('close', (code) => {
      live.delete(proc);
      if (tail && onLine) onLine(tail);
      // A killed process reports a non-zero code; report it as a cancellation
      // rather than a failure so callers can tell the two apart.
      if (cancelled) return reject(new CancelledError());
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderrAll.slice(-2000)}`));
    });
  });
}

module.exports = {
  FFMPEG, FFPROBE, ffprobeInfo, runFfmpeg, tmpDir: os.tmpdir(),
  beginJob, cancelJob, isCancelled, CancelledError,
};
