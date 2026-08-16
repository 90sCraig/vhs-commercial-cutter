// Export: render the chosen segments (the saved commercials, or the skipped
// show) either merged into one file or split into one file per segment.
// Optionally reframe to 4:3 and apply color / restoration fixes.

const fs = require('fs');
const path = require('path');
const { runFfmpeg, ffprobeInfo, tmpDir } = require('./ffmpeg');
const { videoCodecArgs } = require('./encoders');

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

// Target output dimensions for each reframe option (source = no reframing).
const FRAMES = {
  '4:3': [1440, 1080],  // classic TV / VHS shape (YouTube)
};

// Quality presets → x264 CRF (lower = better/bigger).
//
// Deliberately not named after delivery formats. Resolution always follows the
// source, so "Blu-ray" or "DVD" would promise something this setting does not
// control — and neither means anything applied to a 480-line tape. What it
// actually trades is size against how much tape grain survives, since x264
// smooths noise as compression rises.
//
// Measured on a 1080p60 capture, per hour: 5.9 / 4.4 / 2.8 / 1.6 / 0.8 GB —
// roughly 100 / 75 / 45 / 30 / 15 percent of Archive. The absolutes move with
// capture resolution; the ratios hold.
const QUALITY = {
  archive: 16,   // 100%, grain intact
  high: 18,      // ~75%, no visible loss (default)
  balanced: 21,  // ~45%, the YouTube upload size
  efficient: 24, // ~30%, grain begins smoothing
  low: 28,       // ~15%, visibly compressed
};

// Denoise + re-sharpen presets by tape speed. hqdn3d removes VHS grain;
// unsharp restores the softness that denoising (and the tape) introduces.
const ENHANCE = {
  off: null,
  sp: { denoise: 'hqdn3d=2:1:2:3', sharpen: 'unsharp=3:3:0.4:3:3:0.0' },
  lp: { denoise: 'hqdn3d=4:3:6:6', sharpen: 'unsharp=5:5:0.8:5:5:0.0' },
  ep: { denoise: 'hqdn3d=6:5:9:9', sharpen: 'unsharp=5:5:1.2:5:5:0.0' },
};

// The color-correction sub-filter (no leading comma), or '' if disabled.
function colorEq(correction) {
  if (!correction || !correction.enabled) return '';
  const b = (correction.brightness ?? 0);
  const c = (correction.contrast ?? 1);
  const s = (correction.saturation ?? 1);
  const g = (correction.gamma ?? 1);
  return `eq=brightness=${b}:contrast=${c}:saturation=${s}:gamma=${g}`;
}

// Per-channel midtone balance to correct VHS color casts, or '' if none.
function colorBalance(correction) {
  if (!correction || !correction.enabled) return '';
  const r = (correction.r ?? 0), g = (correction.g ?? 0), b = (correction.b ?? 0);
  if (!r && !g && !b) return '';
  return `colorbalance=rm=${r}:gm=${g}:bm=${b}`;
}

// Repairs torn frames: the pixel-wise median of each frame and its two
// neighbors. Some capture devices lose sync several times a second and emit a
// frame split across two positions with a band of corrupted data between. Those
// pixels are outliers against both neighbors, so the median discards them and
// reconstructs from the frames either side.
//
// Measured on a 4h 1440x1080 capture: 14 torn frames per 500 became 0. Frames
// it left alone changed by a mean of 4/255, and the larger changes turned out
// to be further torn frames rather than damage. Adds about a third to encode
// time (2.1s to 2.8s for a 12s slice), so it stays well under realtime.
// Only worth enabling on captures that actually tear — see src/tears.js.
const REPAIR_TEARS = 'tmedian=radius=1';

// The ordered list of pre-reframe video filters: repair → denoise → color →
// balance → sharpen. Repair goes first because hqdn3d is temporal as well, so
// denoising ahead of it would blend torn-frame data into the very neighbors
// the repair needs to read. (Denoise before sharpen; sharpen last so it isn't
// smeared.)
function videoPreParts(correction, enhance, repairTears) {
  const parts = [];
  if (repairTears) parts.push(REPAIR_TEARS);
  const en = ENHANCE[enhance];
  if (en && en.denoise) parts.push(en.denoise);
  const eq = colorEq(correction); if (eq) parts.push(eq);
  const cb = colorBalance(correction); if (cb) parts.push(cb);
  if (en && en.sharpen) parts.push(en.sharpen);
  return parts;
}

// Build the video-filter args for a segment: restoration + optional reframe.
// Returns { vf }, or {} when there is nothing to apply.
function buildVideoFilter(correction, enhance, layout, repairTears) {
  const pre = videoPreParts(correction, enhance, repairTears);
  const dims = layout && FRAMES[layout.frame];
  if (!dims) {
    // Source frame: restoration filters only. Resolution always follows the
    // source, so there is nothing to rescale.
    return pre.length ? { vf: pre.join(',') } : {};
  }
  const [W, H] = dims;
  const prep = pre.length ? `${pre.join(',')},` : '';
  // Reframing always center-crops: scale to cover the target, then trim the
  // overflow evenly from both sides (ffmpeg's crop centers when given no x/y).
  // On a 4:3 picture inside a 16:9 frame that removes exactly the pillars.
  return { vf: `${prep}scale=${W}:${H}:force_original_aspect_ratio=increase,` +
    `crop=${W}:${H},setsar=1` };
}

// Audio drift correction: shift the audio track ±ms to fix lip-sync.
function audioFilter(driftMs) {
  if (!driftMs) return '';
  if (driftMs > 0) return `adelay=${driftMs}|${driftMs}`;         // audio later
  const s = (Math.abs(driftMs) / 1000).toFixed(3);
  return `atrim=start=${s},asetpts=PTS-STARTPTS`;                 // audio earlier
}

// Full audio filter chain: drift + optional YouTube loudness normalization.
function audioChain(driftMs, normalize) {
  const parts = [];
  const drift = audioFilter(driftMs);
  if (drift) parts.push(drift);
  if (normalize) parts.push('loudnorm=I=-14:TP=-1.5:LRA=11'); // YouTube target
  return parts.join(',');
}

// Encode a single [start,start+duration) slice, re-encoding so arbitrary cut
// points are frame-accurate (VHS captures rarely have clean keyframes at cuts).
// opts: { correction, enhance, layout, quality, audioDriftMs, encoder,
//         normalizeAudio, repairTears }
function encodeSegment(input, start, duration, outPath, opts, onProgress) {
  const { correction, enhance, layout, quality, audioDriftMs, encoder, normalizeAudio,
    repairTears } = opts;
  const args = ['-hide_banner', '-y', '-ss', String(start), '-i', input, '-t', String(duration)];
  const f = buildVideoFilter(correction, enhance, layout, repairTears);
  if (f.vf) args.push('-vf', f.vf);
  const af = audioChain(audioDriftMs, normalizeAudio);
  if (af) args.push('-af', af);
  const crf = QUALITY[quality] != null ? QUALITY[quality] : 18;
  args.push(
    ...videoCodecArgs(encoder, crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  );
  return runFfmpeg(args, { onProgress });
}

// Encode one segment, retrying on the CPU if the hardware encoder fails.
// A partial file is left behind when ffmpeg dies mid-encode, so drop it before
// the retry. Resolves true when the fallback was used, so the caller can stop
// attempting the GPU for the rest of the run — these failures (wedged driver,
// unsupported source, exhausted encoder sessions) rarely fix themselves.
async function encodeWithFallback(input, start, duration, outPath, opts, onProgress, hooks) {
  try {
    await encodeSegment(input, start, duration, outPath, opts, onProgress);
    return false;
  } catch (e) {
    // Aborted: bin the truncated file, but do not retry on the CPU.
    if (e.cancelled) {
      try { fs.unlinkSync(outPath); } catch (_) { /* nothing written yet */ }
      throw e;
    }
    if (opts.encoder === 'cpu') throw e;   // nothing left to fall back to
    try { fs.unlinkSync(outPath); } catch (_) { /* nothing written yet */ }
    hooks.onFallback && hooks.onFallback(opts.encoder, e);
    await encodeSegment(input, start, duration, outPath,
      { ...opts, encoder: 'cpu' }, onProgress);
    return true;
  }
}

// Concatenate already-encoded parts with stream copy (fast, lossless).
function concatParts(parts, outPath, listDir) {
  const listFile = path.join(listDir || tmpDir, `vhs-concat-${Date.now()}.txt`);
  const body = parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listFile, body, 'utf8');
  const args = [
    '-hide_banner', '-y',
    '-f', 'concat', '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ];
  return runFfmpeg(args).finally(() => {
    try { fs.unlinkSync(listFile); } catch (_) {}
  });
}

function gb(bytes) { return (bytes / 1073741824).toFixed(1); }

// Free bytes on the volume holding dir. 0 when it can't be determined.
function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch (_) {
    return 0;
  }
}

// Rough estimate of the space an export will occupy. Re-encoding a capture at
// the default quality lands near the source's own bitrate, so scale the source
// bytes-per-second by the exported duration. Merged mode stages every segment
// beside the finished file, so it needs room for both at once.
// Returns 0 when the source can't be measured — callers skip the check.
async function estimateBytes(input, exportSeconds, mode) {
  try {
    const info = await ffprobeInfo(input);
    const size = fs.statSync(input).size;
    if (!info.duration || !size || !exportSeconds) return 0;
    const bytes = (size / info.duration) * exportSeconds;
    return Math.round(bytes * (mode === 'split' ? 1.1 : 2.15));
  } catch (_) {
    return 0;
  }
}

// mode: 'merged' | 'split'
// target: 'save' (the clips you're keeping — commercials by default) | 'skip' (the rest)
// layout: { frame: 'source'|'4:3' }
async function exportVideo({ input, segments, mode, target = 'save', correction, enhance = 'off', layout, quality = 'high', audioDriftMs = 0, encoder = 'cpu', normalizeAudio = false, repairTears = false, outputDir, baseName }, hooks = {}) {
  const encodeOpts = { correction, enhance, layout, quality, audioDriftMs, encoder, normalizeAudio, repairTears };
  // Downgraded to CPU for the remainder once a hardware encode has failed.
  let active = encodeOpts;
  let fellBackToCpu = false;
  const chosen = segments
    .filter((s) => (target === 'skip' ? !s.keep : s.keep))
    .sort((a, b) => a.start - b.start);
  if (chosen.length === 0) {
    throw new Error(target === 'skip'
      ? 'No clips are marked "skip" — nothing to export.'
      : 'No clips are marked "save" — nothing to export.');
  }

  // Naming: saved commercials vs the skipped show, split vs merged.
  const splitTag = target === 'skip' ? 'show' : 'clip';
  const mergedTag = target === 'skip' ? 'show' : 'commercials';

  const totalDuration = chosen.reduce((sum, s) => sum + (s.end - s.start), 0);
  let doneDuration = 0;
  const report = () => hooks.onProgress && hooks.onProgress(Math.min(1, doneDuration / totalDuration));

  // Pre-flight space check. Refusing up front beats dying an hour in — and
  // when the staging volume is the Windows drive, running it dry takes the
  // whole machine down, not just this export.
  fs.mkdirSync(outputDir, { recursive: true });
  hooks.onStatus && hooks.onStatus('Checking free space…');
  const needBytes = await estimateBytes(input, totalDuration, mode);
  const free = freeBytes(outputDir);
  if (needBytes && free && free < needBytes) {
    throw new Error(
      `Not enough free space in ${outputDir} — this export needs about `
      + `${gb(needBytes)} GB but only ${gb(free)} GB is free.`
      + (mode === 'split' ? '' : ' Merged exports stage every segment beside the'
        + ' finished file before joining them, so they need roughly twice the'
        + ' final size. Exporting as separate clips needs far less.'),
    );
  }

  // Staged segments live beside the output rather than in the system temp
  // folder. Temp is on C:, so a large merged export could fill the Windows
  // drive even when the output was pointed at a roomier disk.
  const work = path.join(outputDir, `.vhs-export-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  const outputs = [];

  try {
    if (mode === 'split') {
      let i = 0;
      for (const s of chosen) {
        i += 1;
        const out = path.join(outputDir, `${baseName}_${splitTag}${pad(i)}.mp4`);
        const dur = s.end - s.start;
        hooks.onStatus && hooks.onStatus(`Exporting clip ${i} of ${chosen.length}…`);
        if (await encodeWithFallback(input, s.start, dur, out, active, (secs) => {
          hooks.onProgress && hooks.onProgress(Math.min(1, (doneDuration + secs) / totalDuration));
        }, hooks)) { active = { ...active, encoder: 'cpu' }; fellBackToCpu = true; }
        doneDuration += dur;
        report();
        outputs.push(out);
      }
    } else {
      const parts = [];
      let i = 0;
      for (const s of chosen) {
        i += 1;
        const part = path.join(work, `part${pad(i, 4)}.mp4`);
        const dur = s.end - s.start;
        hooks.onStatus && hooks.onStatus(`Rendering segment ${i} of ${chosen.length}…`);
        if (await encodeWithFallback(input, s.start, dur, part, active, (secs) => {
          hooks.onProgress && hooks.onProgress(Math.min(1, (doneDuration + secs) / totalDuration));
        }, hooks)) { active = { ...active, encoder: 'cpu' }; fellBackToCpu = true; }
        doneDuration += dur;
        report();
        parts.push(part);
      }
      const out = path.join(outputDir, `${baseName}_${mergedTag}.mp4`);
      hooks.onStatus && hooks.onStatus('Joining segments…');
      await concatParts(parts, out, work);
      outputs.push(out);
    }
  } finally {
    try {
      for (const f of fs.readdirSync(work)) fs.unlinkSync(path.join(work, f));
      fs.rmdirSync(work);
    } catch (_) {}
  }

  return { outputs, fellBackToCpu };
}

// Render a short sample window with the given settings to outPath, for an
// accurate "what will this look/sound like" preview (color, denoise/sharpen,
// normalized audio). Uses the same pipeline as export.
function renderPreview({ input, start, duration, outPath, correction, enhance, layout, quality, audioDriftMs, encoder, normalizeAudio, repairTears }, hooks = {}) {
  return encodeSegment(input, start, duration, outPath,
    { correction, enhance, layout, quality, audioDriftMs, encoder, normalizeAudio, repairTears },
    hooks.onProgress);
}

module.exports = { exportVideo, renderPreview };
