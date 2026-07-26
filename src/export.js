// Export: render the chosen segments (the saved commercials, or the skipped
// show) either merged into one file or split into one file per segment.
// Optionally reframe to a vertical/portrait/square social format + color fix.

const fs = require('fs');
const path = require('path');
const { runFfmpeg, tmpDir } = require('./ffmpeg');
const { videoCodecArgs } = require('./encoders');

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

// Target output dimensions for each social frame (source = no reframing).
const FRAMES = {
  '4:3': [1440, 1080],  // classic TV / VHS shape (YouTube)
  '9:16': [1080, 1920], // Reels / TikTok
  '4:5': [1080, 1350],  // Instagram portrait
  '1:1': [1080, 1080],  // Square
};

// Quality presets → x264 CRF (lower = better/bigger).
const QUALITY = {
  archive: 16,   // near lossless
  high: 18,      // Blu-ray-ish (default)
  balanced: 21,  // YouTube HD
  efficient: 24, // DVD-ish
  low: 28,       // VHS LP, small
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

// The ordered list of pre-reframe video filters: denoise → color → balance →
// sharpen. (Denoise before sharpen; sharpen last so it isn't smeared.)
function videoPreParts(correction, enhance) {
  const parts = [];
  const en = ENHANCE[enhance];
  if (en && en.denoise) parts.push(en.denoise);
  const eq = colorEq(correction); if (eq) parts.push(eq);
  const cb = colorBalance(correction); if (cb) parts.push(cb);
  if (en && en.sharpen) parts.push(en.sharpen);
  return parts;
}

// Build the video-filter args for a segment: restoration + optional reframe.
// Returns { vf } for a simple graph or { complex, map } for filter_complex.
function buildVideoFilter(correction, enhance, layout) {
  const pre = videoPreParts(correction, enhance);
  const dims = layout && FRAMES[layout.frame];
  if (!dims) {
    // Source frame: restoration and/or optional downscale to a target height.
    const parts = [...pre];
    const h = layout && layout.resolution;
    if (h && h !== 'source') parts.push(`scale=-2:${h}`);
    return parts.length ? { vf: parts.join(',') } : {};
  }
  const [W, H] = dims;
  const prep = pre.length ? `${pre.join(',')},` : '';
  const fill = (layout && layout.fill) || 'blur';

  if (fill === 'bars') {
    return { vf: `${prep}scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1` };
  }
  if (fill === 'crop') {
    return { vf: `${prep}scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H},setsar=1` };
  }
  // Blurred background: a zoomed, blurred copy fills the frame; the fitted
  // clip is overlaid centered on top. The classic vertical-social look.
  const complex =
    `[0:v]${prep}split=2[b][f];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=20[bb];` +
    `[f]scale=${W}:${H}:force_original_aspect_ratio=decrease[ff];` +
    `[bb][ff]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`;
  return { complex, map: '[v]' };
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
// opts: { correction, enhance, layout, quality, fps, audioDriftMs, encoder, normalizeAudio }
function encodeSegment(input, start, duration, outPath, opts, onProgress) {
  const { correction, enhance, layout, quality, fps, audioDriftMs, encoder, normalizeAudio } = opts;
  const args = ['-hide_banner', '-y', '-ss', String(start), '-i', input, '-t', String(duration)];
  const f = buildVideoFilter(correction, enhance, layout);
  if (f.complex) {
    args.push('-filter_complex', f.complex, '-map', f.map, '-map', '0:a?');
  } else if (f.vf) {
    args.push('-vf', f.vf);
  }
  const af = audioChain(audioDriftMs, normalizeAudio);
  if (af) args.push('-af', af);
  const crf = QUALITY[quality] != null ? QUALITY[quality] : 18;
  if (fps && fps !== 'source') args.push('-r', String(fps));
  args.push(
    ...videoCodecArgs(encoder, crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  );
  return runFfmpeg(args, { onProgress });
}

// Concatenate already-encoded parts with stream copy (fast, lossless).
function concatParts(parts, outPath) {
  const listFile = path.join(tmpDir, `vhs-concat-${Date.now()}.txt`);
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

// mode: 'merged' | 'split'
// target: 'save' (the clips you're keeping — commercials by default) | 'skip' (the rest)
// layout: { frame: 'source'|'9:16'|'4:5'|'1:1', fill: 'blur'|'bars'|'crop' }
async function exportVideo({ input, segments, mode, target = 'save', correction, enhance = 'off', layout, quality = 'high', fps = 'source', audioDriftMs = 0, encoder = 'cpu', normalizeAudio = false, outputDir, baseName }, hooks = {}) {
  const encodeOpts = { correction, enhance, layout, quality, fps, audioDriftMs, encoder, normalizeAudio };
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

  const work = path.join(tmpDir, `vhs-export-${Date.now()}`);
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
        await encodeSegment(input, s.start, dur, out, encodeOpts, (secs) => {
          hooks.onProgress && hooks.onProgress(Math.min(1, (doneDuration + secs) / totalDuration));
        });
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
        await encodeSegment(input, s.start, dur, part, encodeOpts, (secs) => {
          hooks.onProgress && hooks.onProgress(Math.min(1, (doneDuration + secs) / totalDuration));
        });
        doneDuration += dur;
        report();
        parts.push(part);
      }
      const out = path.join(outputDir, `${baseName}_${mergedTag}.mp4`);
      hooks.onStatus && hooks.onStatus('Joining segments…');
      await concatParts(parts, out);
      outputs.push(out);
    }
  } finally {
    try {
      for (const f of fs.readdirSync(work)) fs.unlinkSync(path.join(work, f));
      fs.rmdirSync(work);
    } catch (_) {}
  }

  return { outputs };
}

// Render a short sample window with the given settings to outPath, for an
// accurate "what will this look/sound like" preview (color, denoise/sharpen,
// normalized audio). Uses the same pipeline as export.
function renderPreview({ input, start, duration, outPath, correction, enhance, layout, quality, fps, audioDriftMs, encoder, normalizeAudio }, hooks = {}) {
  return encodeSegment(input, start, duration, outPath,
    { correction, enhance, layout, quality, fps, audioDriftMs, encoder, normalizeAudio },
    hooks.onProgress);
}

module.exports = { exportVideo, renderPreview };
