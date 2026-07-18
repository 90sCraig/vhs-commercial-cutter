// Preview proxy generation.
//
// Heavy captures (large MKV, on a network drive) seek slowly in the built-in
// player. We generate a small, local, short-GOP 480p MP4 once per source and
// let the player use THAT for review. Detection and export always use the
// full-quality original — the proxy is preview-only.
//
// Proxies are cached in userData/proxies keyed by source path+size+mtime, so
// re-opening a tape reuses the existing proxy instantly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { runFfmpeg } = require('./ffmpeg');
const { videoCodecArgs, proxyGopArgs, decodeAccel } = require('./encoders');

function cacheDir() {
  const dir = path.join(app.getPath('userData'), 'proxies');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function proxyPathFor(src) {
  const st = fs.statSync(src);
  const key = crypto
    .createHash('sha1')
    .update(`${src}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(cacheDir(), `${key}.mp4`);
}

// Total bytes currently held in the proxy cache.
function cacheSize() {
  const dir = cacheDir();
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    try { total += fs.statSync(path.join(dir, f)).size; } catch (_) {}
  }
  return total;
}

// Delete every cached proxy. Returns bytes freed.
function clearCache() {
  const dir = cacheDir();
  let freed = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { freed += fs.statSync(p).size; fs.unlinkSync(p); } catch (_) {}
  }
  return freed;
}

// Keep the cache under capBytes by deleting least-recently-used proxies.
// mtime is refreshed on every cache hit (see ensureProxy), so it tracks use.
function enforceCap(capBytes, keepPath) {
  if (!capBytes || capBytes <= 0) return;
  const dir = cacheDir();
  const files = fs.readdirSync(dir).map((f) => {
    const p = path.join(dir, f);
    try { const s = fs.statSync(p); return { p, size: s.size, mtime: s.mtimeMs }; }
    catch (_) { return null; }
  }).filter(Boolean);
  let total = files.reduce((a, f) => a + f.size, 0);
  files.sort((a, b) => a.mtime - b.mtime); // oldest first
  for (const f of files) {
    if (total <= capBytes) break;
    if (f.p === keepPath) continue;        // never evict the one we just made
    try { fs.unlinkSync(f.p); total -= f.size; } catch (_) {}
  }
}

async function ensureProxy(src, hooks = {}, opts = {}) {
  const out = proxyPathFor(src);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    try { const now = new Date(); fs.utimesSync(out, now, now); } catch (_) {} // mark as recently used
    return { path: out, cached: true };
  }
  const tmp = `${out}.part`;

  const buildArgs = (encoder) => {
    const accel = decodeAccel(encoder);
    const args = ['-hide_banner', '-y'];
    if (accel) args.push('-hwaccel', accel);       // GPU-accelerated source decode
    args.push(
      '-i', src,
      '-vf', 'scale=-2:480',                        // 480p, keep aspect
      '-r', '30',                                   // 60→30 fps: smaller, lighter
      ...videoCodecArgs(encoder, 28),
      ...proxyGopArgs(encoder),                     // keyframe ~every 1s → snappy seek
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-movflags', '+faststart',
      '-f', 'mp4',                                  // temp name ends in .part
      tmp,
    );
    return args;
  };

  // Try the selected encoder; fall back to CPU if the GPU path fails.
  const chain = opts.encoder && opts.encoder !== 'cpu' ? [opts.encoder, 'cpu'] : ['cpu'];
  let lastErr;
  for (const encoder of chain) {
    try {
      await runFfmpeg(buildArgs(encoder), { onProgress: hooks.onProgress });
      fs.renameSync(tmp, out);
      if (opts.cacheCapBytes) enforceCap(opts.cacheCapBytes, out);
      return { path: out, cached: false, encoder };
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (encoder !== 'cpu' && hooks.onFallback) hooks.onFallback();
    }
  }
  throw lastErr;
}

module.exports = { ensureProxy, proxyPathFor, cacheSize, clearCache, enforceCap };
