// Commercial detection.
//
// Strategy (robust multi-signal): broadcasters almost always fade to BLACK and
// drop AUDIO at the boundary between program and a commercial pod. We run a
// single ffmpeg pass with both blackdetect and silencedetect, then treat a
// black interval that COINCIDES with silence as a high-confidence boundary.
// Black-only or silence-only events are kept as lower-confidence hints.
//
// The boundaries split the recording into content segments. We then classify
// each segment as "keep" (program) or "cut" (commercial) using a length
// heuristic, and hand the whole thing to the UI for review.

const { runFfmpeg, ffprobeInfo } = require('./ffmpeg');

const DEFAULTS = {
  blackDuration: 0.10, // min seconds of black to register (blackdetect d=)
  blackThreshold: 0.10, // pixel blackness threshold (blackdetect pix_th=)
  silenceDb: -30, // silence threshold in dB (silencedetect n=)
  silenceDuration: 0.30, // min seconds of silence (silencedetect d=)
  coincidenceTol: 1.0, // seconds: how close black & silence must be to "coincide"
  minCommercialLen: 8, // s: ignore boundary-gaps shorter than this (noise)
  maxCommercialLen: 360, // s: a content segment shorter than this is guessed commercial
  // Scene-change rate, measured per segment and reported as cutsPerMin. Ads cut
  // faster than programs, and on a test tape the gap was real (26.8/min across a
  // known ad block vs 10.3-11.7 across program). It is NOT used to classify:
  // length already got every segment right there, and no threshold pair moved
  // anything without being fitted to that one tape. Kept because it costs
  // almost nothing in the existing pass and is what any future tuning needs.
  sceneDetect: true, // set false to skip scdet entirely
  sceneThreshold: 10, // scdet t= (higher = fewer detections)
};

function parseEvents(line, black, silence, scenes) {
  // scdet logs one line per detected cut:
  //   [scdet @ ...] lavfi.scd.score: 31.463, lavfi.scd.time: 18
  if (scenes) {
    const sc = line.match(/lavfi\.scd\.time:\s*(-?\d+(?:\.\d+)?)/);
    if (sc) {
      const t = parseFloat(sc[1]);
      if (Number.isFinite(t) && t >= 0) scenes.push(t);
    }
  }
  // blackdetect prints black_start and black_end together on ONE line:
  //   black_start:18 black_end:20 black_duration:2
  const bs = line.match(/black_start:(\d+(?:\.\d+)?)/);
  const be = line.match(/black_end:(\d+(?:\.\d+)?)/);
  if (bs || be) {
    if (bs && be) black.push({ start: parseFloat(bs[1]), end: parseFloat(be[1]) });
    else if (bs) black.push({ start: parseFloat(bs[1]), end: null });
    else {
      const last = black[black.length - 1];
      if (last && last.end === null) last.end = parseFloat(be[1]);
    }
  }
  // silencedetect prints start and end on SEPARATE lines.
  let m;
  if ((m = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/))) {
    silence.push({ start: parseFloat(m[1]), end: null });
  } else if ((m = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/))) {
    const last = silence[silence.length - 1];
    if (last && last.end === null) last.end = parseFloat(m[1]);
  }
}

function intervalsOverlap(a, bStart, bEnd, tol) {
  return a.start - tol <= bEnd && a.end + tol >= bStart;
}

// Build the list of boundary points (each a black interval, flagged confident
// when audio silence coincides).
function buildBoundaries(black, silence, opts) {
  const boundaries = [];
  for (const b of black) {
    if (b.end === null) continue;
    const mid = (b.start + b.end) / 2;
    const confident = silence.some((s) =>
      s.end !== null && intervalsOverlap(s, b.start, b.end, opts.coincidenceTol));
    boundaries.push({
      start: b.start,
      end: b.end,
      mid,
      confident,
    });
  }
  boundaries.sort((x, y) => x.start - y.start);
  return boundaries;
}

// Cuts per minute inside [start, end), from the sorted scene-change times.
function cutRate(scenes, start, end) {
  const len = end - start;
  if (!scenes || !scenes.length || len <= 0) return null;
  let n = 0;
  for (const t of scenes) {
    if (t >= end) break;
    if (t >= start) n += 1;
  }
  return (n / len) * 60;
}

// Turn boundaries into content segments between them.
function buildSegments(boundaries, duration, opts, scenes) {
  const segs = [];
  let cursor = 0;
  let id = 0;
  const pushSeg = (start, end) => {
    const len = end - start;
    if (len < opts.minCommercialLen) return; // skip micro-gaps (noise)
    const rate = cutRate(scenes, start, end);
    segs.push({
      id: id++,
      start,
      end,
      duration: len,
      // Goal is collecting commercials: short blocks between fades are almost
      // always ads, so they default to SAVE; long program blocks default to SKIP.
      // (`keep` = "included in the export".)
      keep: len < opts.maxCommercialLen,
      cutsPerMin: rate == null ? null : Math.round(rate * 10) / 10,
      confidentBoundary: true,
    });
  };
  for (const b of boundaries) {
    pushSeg(cursor, b.start);
    cursor = b.end;
  }
  pushSeg(cursor, duration);

  // Nothing tripped the detector: one big block, skipped by default (a whole
  // tape isn't a commercial — the user can mark spots by hand).
  if (segs.length === 0 && duration > 0) {
    segs.push({ id: 0, start: 0, end: duration, duration, keep: false, confidentBoundary: false });
  }
  return segs;
}

async function detect(filePath, userOpts = {}, hooks = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const info = await ffprobeInfo(filePath);
  const duration = info.duration;

  const black = [];
  const silence = [];
  const scenes = [];

  let vf = `blackdetect=d=${opts.blackDuration}:pix_th=${opts.blackThreshold}`;
  // scdet logs a line per cut and passes every frame through, so progress
  // reporting is unaffected.
  if (opts.sceneDetect) vf += `,scdet=t=${opts.sceneThreshold}`;
  const af = `silencedetect=n=${opts.silenceDb}dB:d=${opts.silenceDuration}`;
  const NUL = process.platform === 'win32' ? 'NUL' : '/dev/null';

  // Detection decodes + analyzes (no encoding). A GPU can accelerate the decode;
  // if that path fails, we transparently retry with plain CPU decode.
  const runPass = (hwaccel) => {
    black.length = 0; silence.length = 0; scenes.length = 0;
    const args = ['-hide_banner'];
    if (hwaccel) args.push('-hwaccel', hwaccel);
    args.push('-i', filePath, '-vf', vf, '-af', af, '-f', 'null', NUL);
    return runFfmpeg(args, {
      onLine: (line) => parseEvents(line, black, silence, scenes),
      onProgress: (secs) => {
        if (hooks.onProgress && duration) hooks.onProgress(Math.min(1, secs / duration));
      },
    });
  };

  try {
    await runPass(opts.hwaccel || null);
  } catch (e) {
    if (e.cancelled) throw e;                  // aborted — do not restart on CPU
    if (opts.hwaccel) { await runPass(null); } // fall back to CPU decode
    else throw e;
  }

  scenes.sort((a, b) => a - b);
  const boundaries = buildBoundaries(black, silence, opts);
  const segments = buildSegments(boundaries, duration, opts, scenes);

  return {
    info,
    duration,
    boundaries,
    segments,
    stats: {
      blackEvents: black.length,
      silenceEvents: silence.length,
      sceneChanges: scenes.length,
      confidentBoundaries: boundaries.filter((b) => b.confident).length,
    },
    opts,
  };
}

// Sample detection: scan only a [start, start+duration] window so you can
// tune thresholds against a known commercial break without processing the
// whole tape. Returns boundaries at ABSOLUTE timeline positions.
async function detectSample(filePath, userOpts = {}, range = {}, hooks = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const start = Math.max(0, range.start || 0);
  const dur = Math.max(1, range.duration || 120);
  const black = [];
  const silence = [];
  const vf = `blackdetect=d=${opts.blackDuration}:pix_th=${opts.blackThreshold}`;
  const af = `silencedetect=n=${opts.silenceDb}dB:d=${opts.silenceDuration}`;
  const NUL = process.platform === 'win32' ? 'NUL' : '/dev/null';

  const runPass = (hwaccel) => {
    black.length = 0; silence.length = 0;
    const args = ['-hide_banner'];
    if (hwaccel) args.push('-hwaccel', hwaccel);
    // -ss before -i = fast seek; timestamps come back relative to the slice.
    args.push('-ss', String(start), '-i', filePath, '-t', String(dur),
      '-vf', vf, '-af', af, '-f', 'null', NUL);
    return runFfmpeg(args, {
      onLine: (line) => parseEvents(line, black, silence),
      onProgress: (secs) => { if (hooks.onProgress) hooks.onProgress(Math.min(1, secs / dur)); },
    });
  };

  try {
    await runPass(opts.hwaccel || null);
  } catch (e) {
    if (opts.hwaccel) { await runPass(null); } else throw e;
  }

  // Shift slice-relative timestamps back to absolute timeline positions.
  for (const b of black) { b.start += start; if (b.end != null) b.end += start; }
  for (const s of silence) { s.start += start; if (s.end != null) s.end += start; }

  const boundaries = buildBoundaries(black, silence, opts);
  return {
    rangeStart: start,
    rangeDuration: dur,
    boundaries,
    stats: {
      blackEvents: black.length,
      silenceEvents: silence.length,
      confidentBoundaries: boundaries.filter((b) => b.confident).length,
    },
  };
}

module.exports = { detect, detectSample, DEFAULTS };
