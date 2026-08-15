// Detects torn frames — single frames a capture device split across two
// positions, with a band of corrupted data between them.
//
// These are worth finding automatically because nobody spots them by eye and
// goes looking for a setting. On an affected capture roughly one frame a second
// is broken, three a second in the worst stretches; what you see is a stutter,
// so the natural conclusion is a frame-rate problem. It is not: timestamps stay
// perfectly even (60.000fps, every gap 16.7ms, no skips) and every filter aimed
// at cadence or brightness leaves it untouched.
//
// The test: a torn frame's two NEIGHBOURS match each other far better than
// either matches the frame itself. Ordinary motion cannot produce that — frames
// further apart differ more, not less. Nor can a scene cut, because across a cut
// the neighbours differ from each other as well.
//
// Measured on an affected 4h capture: flagged frames scored 0.06–0.48 on this
// ratio while the median frame scored 2.77. The 0.5 threshold sits in open
// space between the two populations rather than partway up a slope.
const { runFfmpegRaw } = require('./ffmpeg');

// Downscaled hard: a tear wrecks a large part of the frame, so it survives any
// amount of shrinking, and the scan stays cheap enough to run on every import.
const W = 240;
const H = 180;
const PIX = W * H;
const STEP = 5;             // sample every 5th pixel — the damage is not subtle
const RATIO = 0.5;          // below this the middle frame is an interloper
const FLOOR = 0.5;          // ignore near-identical frames: a still shot has no
                            // neighbour distance to measure a ratio against
const WINDOW_FRAMES = 300;  // ~5s at 60fps, per sampled window
const WINDOWS = 3;

// Mean absolute difference between two frames in a rawvideo gray buffer.
function frameDiff(buf, i, j) {
  const oi = i * PIX;
  const oj = j * PIX;
  let sum = 0;
  let n = 0;
  for (let p = 0; p < PIX; p += STEP) {
    sum += Math.abs(buf[oi + p] - buf[oj + p]);
    n += 1;
  }
  return n ? sum / n : 0;
}

// Counts torn frames in one decoded window.
function countTorn(buf) {
  const frames = Math.floor(buf.length / PIX);
  if (frames < 3) return { torn: 0, frames };
  // Adjacent differences get reused by two neighbouring tests each, so compute
  // them once: d(i,i+1) is the "next" distance for frame i and the "previous"
  // distance for frame i+1.
  const adjacent = [];
  for (let i = 0; i < frames - 1; i += 1) adjacent.push(frameDiff(buf, i, i + 1));

  let torn = 0;
  for (let i = 1; i < frames - 1; i += 1) {
    const inner = Math.min(adjacent[i - 1], adjacent[i]);
    if (inner <= FLOOR) continue;
    if (frameDiff(buf, i - 1, i + 1) / inner < RATIO) torn += 1;
  }
  return { torn, frames };
}

// Decodes WINDOW_FRAMES starting at `start` as small grayscale frames.
async function readWindow(filePath, start) {
  const chunks = [];
  await runFfmpegRaw([
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(start),
    '-i', filePath,
    '-frames:v', String(WINDOW_FRAMES),
    '-vf', `scale=${W}:${H},format=gray`,
    '-f', 'rawvideo', '-',
  ], (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks);
}

// Scans a few windows spread through the file and returns the torn-frame rate.
//
// Sampling rather than scanning whole: the defect is a property of the capture
// hardware, so it is present throughout or not at all — three windows is enough
// to tell which, and it keeps this cheap enough to run unprompted. `fps` turns
// the count into a per-second figure, which is the only form that means
// anything to someone deciding whether to switch the repair on.
async function scanTears(filePath, duration, fps) {
  if (!duration || !fps) return { tornPerSecond: 0, torn: 0, frames: 0, inconclusive: true };

  // Spread across the middle of the file, skipping the head and tail where a
  // tape is most likely to be blank or noisy.
  const points = [];
  for (let i = 0; i < WINDOWS; i += 1) {
    points.push(Math.max(0, duration * (0.2 + (0.3 * i))));
  }

  let torn = 0;
  let frames = 0;
  for (const start of points) {
    if (start >= duration) continue;
    const buf = await readWindow(filePath, start);
    const r = countTorn(buf);
    torn += r.torn;
    frames += r.frames;
  }

  if (frames < WINDOW_FRAMES) return { tornPerSecond: 0, torn, frames, inconclusive: true };
  return {
    torn,
    frames,
    tornPerSecond: torn / (frames / fps),
    inconclusive: false,
  };
}

module.exports = { scanTears };
