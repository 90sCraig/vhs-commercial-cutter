// Preview proxy generation.
//
// Heavy captures (large MKV, on a network drive) seek slowly in the built-in
// player. We generate a small, local, short-GOP 480p MP4 once per source and
// let the player use THAT for review. Export always uses the full-quality
// original. Detection scans the proxy when one exists — black frames and
// silence read the same at 480p, for a fraction of the work. See
// settings.detectOnProxy.
//
// Proxies are cached in userData/proxies keyed by source path+size+mtime, so
// re-opening a tape reuses the existing proxy instantly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { runFfmpeg } = require('./ffmpeg');
const { videoCodecArgs, proxyGopArgs } = require('./encoders');

function cacheDir() {
  const dir = path.join(app.getPath('userData'), 'proxies');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Bump when proxy generation changes so stale proxies are rebuilt, not reused.
// v3: built on the CPU. Proxies made by the old GPU path are ~3.4x larger than
// they need to be, so retire them rather than leave the cache full of them.
const PROXY_VERSION = 'v3-cpu';

function proxyPathFor(src) {
  const st = fs.statSync(src);
  const key = crypto
    .createHash('sha1')
    .update(`${src}|${st.size}|${Math.round(st.mtimeMs)}|${PROXY_VERSION}`)
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

  // Proxies are built on the CPU regardless of the encoder setting, which is
  // the opposite of what you would expect. Measured on a 4h 1440x1080 capture,
  // 120s slices, reading from the same network share:
  //
  //   nvenc + cuda decode     15.1s    8.0x realtime   29.7 MB
  //   nvenc + cpu decode       5.3s   22.7x realtime   29.7 MB
  //   x264 veryfast            5.8s   20.6x realtime    8.8 MB
  //
  // Hardware decode costs 2.8x here. It is not the GPU->system-memory readback
  // that `scale` forces: keeping everything on the card with
  // -hwaccel_output_format cuda + scale_cuda measured 8.3x, no better. NVDEC is
  // simply slower than this CPU's decoder for this content (5.6s vs 3.0s
  // decoding 90s with no encode at all).
  //
  // x264 is chosen over nvenc for the encode on size, not speed — they are
  // within 10% of each other. nvenc's -cq 28 is nowhere near x264's -crf 28, so
  // GPU proxies run 3.4x larger. On a 4h tape that is 3.6 GB against 1.07 GB,
  // and the default cache is 8 GB: two tapes cached instead of seven. That part
  // is a property of the encoders and holds on any machine.
  //
  // The speed half was measured on one machine with a fast CPU. On a weak CPU
  // hardware decode could well win, in which case re-add '-hwaccel' here — but
  // keep x264 for the encode, because the size finding stands either way.
  const buildArgs = () => {
    const args = ['-hide_banner', '-y'];
    args.push(
      '-i', src,
      '-vf', 'scale=-2:480',                        // 480p, keep aspect
      // Preserve the source frame timestamps. Forcing CFR (e.g. -r 30) resamples
      // the timeline, which drifts out of sync with the original on VHS captures
      // that have irregular timing — so a clip would seek to the wrong content.
      '-fps_mode', 'passthrough',
      ...videoCodecArgs('cpu', 28),
      ...proxyGopArgs('cpu'),                       // frequent keyframes → snappy seek
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-movflags', '+faststart',
      '-f', 'mp4',                                  // temp name ends in .part
      tmp,
    );
    return args;
  };

  // No encoder fallback chain any more: the one path is the CPU path, so there
  // is nothing to fall back to.
  try {
    await runFfmpeg(buildArgs(), { onProgress: hooks.onProgress });
    fs.renameSync(tmp, out);
    if (opts.cacheCapBytes) enforceCap(opts.cacheCapBytes, out);
    return { path: out, cached: false, encoder: 'cpu' };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

module.exports = { ensureProxy, proxyPathFor, cacheSize, clearCache, enforceCap };
