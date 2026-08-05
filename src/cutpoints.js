// Cut points as text, for people who want to do the cutting somewhere else.
//
// Two formats. CSV is the stable one — timecodes and frames, one row per clip,
// easy to script against. The AviSynth line is a convenience for the workflow
// that prompted this: hand-written Trim() chains joined with ++.
//
// Frame numbers are ABSOLUTE positions in the original capture, which is what
// a trim script needs. They come from the source frame rate, so they are only
// as good as the boundaries themselves — measured at about ±2 frames against a
// full-resolution scan.

const path = require('path');

function frameAt(seconds, fps) {
  return Math.max(0, Math.round(seconds * fps));
}

// AviSynth Trim(first, last) includes BOTH endpoints, and a segment's end time
// is where the next one begins — so the last frame inside the clip is one
// before that. Clamped so a clip shorter than a frame cannot invert.
function frameRange(seg, fps) {
  const first = frameAt(seg.start, fps);
  const last = Math.max(first, frameAt(seg.end, fps) - 1);
  return { first, last };
}

function timecode(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

function chosenSegments(segments, target) {
  return segments
    .filter((s) => (target === 'skip' ? !s.keep : s.keep))
    .sort((a, b) => a.start - b.start);
}

// One Trim() per clip, chained with ++, on a single line.
//
// Deliberately not wrapped. AviSynth does support line continuation, but the
// exact form is easy to get subtly wrong and this is generated code someone
// pastes without reading. A long line always parses; a mis-continued one fails
// in a way that looks like our fault. Editors soft-wrap it anyway, which is
// how the requester's own script looked.
function avisynth(segments, fps) {
  return segments.map((s) => {
    const { first, last } = frameRange(s, fps);
    return `Trim(${first}, ${last})`;
  }).join(' ++ ');
}

function csv(segments, fps) {
  const rows = ['index,start_frame,end_frame,start_tc,end_tc,start_seconds,end_seconds,duration_seconds'];
  segments.forEach((s, i) => {
    const { first, last } = frameRange(s, fps);
    rows.push([
      i + 1, first, last,
      timecode(s.start), timecode(s.end),
      s.start.toFixed(3), s.end.toFixed(3), (s.end - s.start).toFixed(3),
    ].join(','));
  });
  return rows.join('\n');
}

// Returns [{ name, body }] ready to write. Empty when nothing is selected.
function build({ segments, target = 'save', fps, baseName, sourceName }) {
  const chosen = chosenSegments(segments || [], target);
  if (!chosen.length || !fps) return [];
  const tag = target === 'skip' ? 'show' : 'commercials';
  const header = [
    `# ${sourceName || baseName}`,
    `# ${chosen.length} ${tag} clips · ${fps.toFixed(3)} fps`,
    '# Frame numbers are absolute positions in the source, accurate to about',
    '# +/-2 frames. Trim() endpoints are inclusive.',
    '',
  ].join('\n');
  return [
    { name: `${baseName}_${tag}_cutpoints.csv`, body: `${csv(chosen, fps)}\n` },
    { name: `${baseName}_${tag}_trim.txt`, body: `${header}${avisynth(chosen, fps)}\n` },
  ];
}

module.exports = { build, avisynth, csv, frameRange, timecode, chosenSegments };
