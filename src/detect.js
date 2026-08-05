// Commercial detection.
//
// Strategy: broadcasters almost always fade to BLACK and drop AUDIO at the
// boundary between program and a commercial pod. We run a single ffmpeg pass
// with both blackdetect and silencedetect.
//
// Boundaries come from black intervals ONLY. One that coincides with silence
// is flagged confident; black without silence still becomes a boundary, just
// unflagged. Silence on its own is discarded, which is a real limitation
// rather than a design choice: black is the scarce signal on a worn tape, and
// a two-hour test capture produced 10 black events against 1018 silences.
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
  calibrateWindow: 1200, // s: how much tape to sample when calibrating
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
  // Whether the boundary this segment STARTS at had silence to back it up.
  // The first segment starts at the head of the tape, where there is no
  // boundary to judge, so it counts as certain.
  let openedConfident = true;
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
      confidentBoundary: openedConfident,
    });
  };
  for (const b of boundaries) {
    pushSeg(cursor, b.start);
    cursor = b.end;
    openedConfident = b.confident;
  }
  pushSeg(cursor, duration);

  // Nothing tripped the detector: one big block, skipped by default (a whole
  // tape isn't a commercial — the user can mark spots by hand).
  if (segs.length === 0 && duration > 0) {
    segs.push({ id: 0, start: 0, end: duration, duration, keep: false, confidentBoundary: false });
  }
  return segs;
}

// One analysis pass: decode the file and collect black, silence and scene-cut
// events. Shared by detect() and calibrate(). Decoding can be GPU-accelerated;
// if that path fails we retry on plain CPU decode.
async function scanEvents(filePath, opts, duration, hooks = {}, range = null) {
  const black = [];
  const silence = [];
  const scenes = [];

  let vf = `blackdetect=d=${opts.blackDuration}:pix_th=${opts.blackThreshold}`;
  // scdet logs a line per cut and passes every frame through, so progress
  // reporting is unaffected.
  if (opts.sceneDetect) vf += `,scdet=t=${opts.sceneThreshold}`;
  const af = `silencedetect=n=${opts.silenceDb}dB:d=${opts.silenceDuration}`;
  const NUL = process.platform === 'win32' ? 'NUL' : '/dev/null';

  const runPass = (hwaccel) => {
    black.length = 0; silence.length = 0; scenes.length = 0;
    const args = ['-hide_banner'];
    if (hwaccel) args.push('-hwaccel', hwaccel);
    // -ss before -i = fast seek; timestamps come back relative to the slice
    // and get shifted below.
    if (range) args.push('-ss', String(range.start));
    args.push('-i', filePath);
    if (range) args.push('-t', String(range.duration));
    args.push('-vf', vf, '-af', af, '-f', 'null', NUL);
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

  if (range) {
    // Slice-relative timestamps back to absolute timeline positions.
    for (const b of black) { b.start += range.start; if (b.end != null) b.end += range.start; }
    for (const s of silence) { s.start += range.start; if (s.end != null) s.end += range.start; }
    for (let i = 0; i < scenes.length; i++) scenes[i] += range.start;
  }
  scenes.sort((a, b) => a - b);
  return { black, silence, scenes };
}

async function detect(filePath, userOpts = {}, hooks = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const info = await ffprobeInfo(filePath);
  const duration = info.duration;

  const { black, silence, scenes } = await scanEvents(filePath, opts, duration, hooks);
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
// Threshold ladder for calibration.
//
// There is no universally right black threshold: two tapes from the same
// collection and deck put the knee in different places. One found 10 events at
// 0.10 and 59 at 0.16; the other already found 109 at 0.10. A fixed default is
// wrong for one of them whichever value it takes.
//
// So measure the tape instead. Walk upward and, at each rung, look at what the
// step ADDED — if those new black events are still mostly backed by silence
// they are real breaks; once they stop coinciding you have crossed from
// finding breaks into finding noise. Stop at the last good rung.
//
// Checked against both tapes' measured sweeps: picks 0.16 and 0.10 correctly.
const CALIBRATION_LADDER = [0.06, 0.10, 0.16, 0.22, 0.30];

function pickThreshold(rungs, floor = 0.7, minAdded = 5) {
  let best = rungs[0];
  let anchor = rungs[0]; // last rung there was enough evidence to judge against
  for (let i = 1; i < rungs.length; i++) {
    const addedEvents = rungs[i].blackEvents - anchor.blackEvents;
    const addedSilent = rungs[i].coinciding - anchor.coinciding;
    // Too few new events to judge a rate on. Keep the anchor where it is and
    // let the next rung accumulate against it, rather than accepting this one
    // on no evidence. Advancing `best` here would walk to the top of the ladder
    // on any tape whose steps are individually small — which is every tape,
    // once you are sampling a window instead of the whole thing.
    if (addedEvents < minAdded) continue;
    if (addedSilent / addedEvents < floor) break;
    best = rungs[i];
    anchor = rungs[i];
  }
  return best;
}

// Sample a window of tape at each rung and report the threshold that suits it.
async function calibrate(filePath, userOpts = {}, hooks = {}) {
  const opts = { ...DEFAULTS, ...userOpts, sceneDetect: false };
  const info = await ffprobeInfo(filePath);
  const duration = info.duration || 0;

  // A quarter of the way in: heads and tails are often blank or mid-programme,
  // and a window containing no breaks calibrates nothing.
  const window = Math.min(opts.calibrateWindow, Math.max(60, duration / 2));
  const range = { start: Math.max(0, Math.min(duration * 0.25, duration - window)), duration: window };

  const rungs = [];
  for (let i = 0; i < CALIBRATION_LADDER.length; i++) {
    const threshold = CALIBRATION_LADDER[i];
    hooks.onStatus && hooks.onStatus(`Testing sensitivity ${i + 1} of ${CALIBRATION_LADDER.length}…`);
    const { black, silence } = await scanEvents(
      filePath,
      { ...opts, blackThreshold: threshold },
      window,
      { onProgress: (p) => hooks.onProgress && hooks.onProgress((i + p) / CALIBRATION_LADDER.length) },
      range,
    );
    const coinciding = black.filter((b) => b.end !== null && silence.some(
      (s) => s.end !== null && intervalsOverlap(s, b.start, b.end, opts.coincidenceTol))).length;
    rungs.push({ threshold, blackEvents: black.length, coinciding });
  }

  const best = pickThreshold(rungs);
  return {
    threshold: best.threshold,
    rungs,
    range,
    // Nothing found even at the top of the ladder: this stretch of tape has no
    // breaks in it. Better to say so than to hand back a number backed by
    // nothing.
    inconclusive: rungs[rungs.length - 1].blackEvents < 3,
  };
}

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

module.exports = { detect, detectSample, calibrate, DEFAULTS };
