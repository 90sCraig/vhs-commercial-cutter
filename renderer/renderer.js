const $ = (id) => document.getElementById(id);

const state = {
  filePath: null,
  info: null,
  duration: 0,
  segments: [],
  selected: null,
  outputDir: null,
  zoom: 1,
  previewEnd: null, // when previewing a single segment, pause here
  usingProxy: false,
  sampleBoundaries: [], // candidate boundaries from a "Test here" sample
  sampleRange: null,    // { start, end } of the last sample scan
  proxyPath: null,      // file path of the preview proxy in use
  inSamplePreview: false,
  previewReturnTime: 0,
};

// ---- helpers ----------------------------------------------------------
function fmtTime(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
function fmtTC(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(sec)}`;
}
function fmtDur(s) {
  if (s >= 60) return `${(s / 60).toFixed(1)}m`;
  return `${Math.round(s)}s`;
}
function baseName(p) {
  const n = p.split(/[\\/]/).pop();
  return n.replace(/\.[^.]+$/, '');
}
function dirName(p) {
  return p.slice(0, p.length - p.split(/[\\/]/).pop().length - 1);
}
function toFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23');
}
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 4200);
}

// Map a segment length to a color intensity (short = red/cut-likely, long = green).
function segClass(seg) { return seg.keep ? 'keep' : 'cut'; }

// ---- loading a file ---------------------------------------------------
async function loadFile(filePath) {
  state.filePath = filePath;
  state.segments = [];
  state.selected = null;
  $('fileLabel').textContent = filePath;
  $('tapeLabel').textContent = baseName(filePath).toUpperCase();
  $('exportName').value = ''; // default back to the source file name
  const player = $('player');
  state.usingProxy = false;
  player.src = toFileUrl(filePath); // original as immediate fallback
  player.classList.add('ready');
  $('playerEmpty').style.display = 'none';

  try {
    state.info = await window.api.probe(filePath);
    state.duration = state.info.duration;
    $('detectBtn').disabled = false;
    $('sampleBtn').disabled = false;
    $('calibrateBtn').disabled = false;
    clearHistory(); // a new tape starts with a clean slate
    resetTearNotice(); // including any torn-frame finding from the last one
    $('previewSampleBtn').disabled = false;
    state.sampleBoundaries = []; state.sampleRange = null;
    state.inSamplePreview = false; $('previewBanner').classList.add('hidden');
    buildProxyFor(filePath); // build a fast-seeking preview in the background
    if (!state.outputDir) $('outputDir').placeholder = dirName(filePath);
    const i = state.info;
    $('detectStats').textContent =
      `${i.width}×${i.height} · ${i.fps ? i.fps.toFixed(2) + ' fps · ' : ''}${fmtTime(i.duration)} · ${i.vcodec}/${i.acodec || 'no audio'}`;
    renderTimeline();
    renderSegmentList();
    updateExportSummary();
  } catch (e) {
    toast('Could not read file: ' + e.message, true);
  }
}

// ---- preview proxy ----------------------------------------------------
function setProxyStatus(text, { spinning = false, ready = false, progress = null, abortable = false } = {}) {
  const el = $('proxyStatus');
  if (!text) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.classList.toggle('spinning', spinning);
  el.classList.toggle('ready', ready);
  $('proxyStatusText').textContent = text;
  const abort = $('proxyAbort');
  abort.classList.toggle('hidden', !abortable);
  if (abortable) { abort.disabled = false; abort.textContent = 'Cancel'; }
  const bar = $('proxyBar');
  if (progress == null) {
    bar.classList.add('hidden');
  } else {
    bar.classList.remove('hidden');
    $('proxyBarFill').style.width = Math.round(progress * 100) + '%';
  }
}

async function buildProxyFor(filePath) {
  if (state.settings && state.settings.proxyEnabled === false) {
    setProxyStatus(''); // proxies disabled — play the original directly
    checkTears(filePath);
    return;
  }
  setProxyStatus('Preparing preview…', { spinning: true, abortable: true });
  try {
    const res = await window.api.buildProxy(filePath, state.duration);
    if (state.filePath !== filePath) return; // user switched files meanwhile
    state.proxyPath = res.path;
    if (state.inSamplePreview) return; // don't yank the player out of a preview
    const player = $('player');
    const t = player.currentTime;
    const wasPlaying = !player.paused;
    player.src = toFileUrl(res.path);
    player.addEventListener('loadedmetadata', function once() {
      player.removeEventListener('loadedmetadata', once);
      try { player.currentTime = t; } catch (_) {}
      if (wasPlaying) player.play().catch(() => {});
    });
    state.usingProxy = true;
    setProxyStatus('Preview ready', { ready: true });
    setTimeout(() => { if (state.usingProxy && state.filePath === filePath) setProxyStatus(''); }, 2500);
    checkTears(filePath); // proxy is local now, so the scan is cheap
  } catch (e) {
    // Cancelling is a choice, not a failure — say so differently. Either way
    // the player keeps using the full-quality original.
    if (isAbort(e)) setProxyStatus('Preview cancelled — using original', {});
    else setProxyStatus('Preview unavailable — using original', {});
    setTimeout(() => { if (state.filePath === filePath) setProxyStatus(''); }, 4000);
  }
}

// ---- torn frames ------------------------------------------------------
// Below this the finding isn't worth acting on. Measured with this scanner: an
// affected capture reported 1.0/s averaged over sampled windows (3/s in its
// worst stretches), a clean control 0.0/s across the same 900 frames. The clean
// side has all the margin; the torn side only has 2x, so a tape that tears
// rarely will fall under and stay quiet — which is the right call, since a
// handful of tears over four hours isn't worth re-encoding for.
const TEAR_RATE_MIN = 0.5;

function resetTearNotice() {
  $('tearNotice').classList.add('hidden');
  $('repairTears').checked = false;
}

// Torn frames read as a stutter rather than as damage, so nobody goes hunting
// for a repair setting. Scan the proxy once per tape and say what was found.
// The switch gets preselected but the export is still the user's call — the
// alternative is silently altering their footage on the strength of a heuristic.
async function checkTears(filePath) {
  try {
    const r = await window.api.scanTears(filePath);
    if (state.filePath !== filePath) return;  // switched tapes mid-scan
    if (r.inconclusive || r.tornPerSecond < TEAR_RATE_MIN) return;
    $('repairTears').checked = true;
    $('tearNotice').textContent =
      `Torn frames found — about ${r.tornPerSecond.toFixed(1)} per second `
      + `(${r.torn} in ${r.frames} frames sampled). Repair has been switched on. `
      + 'This is a capture fault rather than tape damage, so other tapes from '
      + 'the same setup probably have it too.';
    $('tearNotice').classList.remove('hidden');
  } catch (_) { /* a failed scan costs a notice, not an import */ }
}

// ---- detection --------------------------------------------------------
// Starting points along one axis: how readily a fade counts as a break.
// Both thresholds move together because tape wear degrades both signals — a
// worn tape has grainy near-black AND hiss on the audio floor, and a boundary
// needs the two to coincide, so loosening one alone finds nothing.
//
// Min gap RISES as strength rises: a looser detector throws more spurious
// boundaries, so the noise filter has to work harder to stop the tape
// shattering into fragments.
//
// Max commercial length is identical in all four on purpose. It describes how
// the broadcast was structured, not how hard we are looking.
const DETECT_PRESETS = {
  strict: { blackThreshold: 0.06, silenceDb: -35, minCommercial: 8, maxCommercial: 360 },
  balanced: { blackThreshold: 0.10, silenceDb: -30, minCommercial: 8, maxCommercial: 360 },
  sensitive: { blackThreshold: 0.16, silenceDb: -25, minCommercial: 10, maxCommercial: 360 },
  aggressive: { blackThreshold: 0.22, silenceDb: -20, minCommercial: 12, maxCommercial: 360 },
};

const DETECT_SLIDERS = ['blackThreshold', 'silenceDb', 'minCommercial', 'maxCommercial'];

// Push the remembered thresholds back into the controls on startup. Safe to run
// before or after bindSlider: dispatching 'input' updates the readout if the
// binding already exists, and bindSlider reads the current value if it doesn't.
function applySavedDetect() {
  const d = (state.settings && state.settings.detect) || {};
  applyingPreset = true;
  for (const id of DETECT_SLIDERS) {
    if (d[id] != null) { $(id).value = d[id]; $(id).dispatchEvent(new Event('input')); }
  }
  applyingPreset = false;
  if (d.preset) $('detectPreset').value = d.preset;
}

async function saveDetectSettings() {
  state.settings = await window.api.setSettings({
    detect: {
      preset: $('detectPreset').value,
      blackThreshold: parseFloat($('blackThreshold').value),
      silenceDb: parseInt($('silenceDb').value, 10),
      minCommercial: parseInt($('minCommercial').value, 10),
      maxCommercial: parseInt($('maxCommercial').value, 10),
    },
  });
}

let applyingPreset = false;
function applyDetectPreset(name) {
  const p = DETECT_PRESETS[name];
  if (!p) return; // 'custom' — leave the sliders where the user put them
  applyingPreset = true;
  for (const [id, v] of Object.entries(p)) {
    const el = $(id);
    if (!el) continue;
    el.value = v;
    el.dispatchEvent(new Event('input')); // refresh the readout next to the label
  }
  applyingPreset = false;
}

function detectOpts() {
  return {
    blackThreshold: parseFloat($('blackThreshold').value),
    silenceDb: parseInt($('silenceDb').value, 10),
    minCommercialLen: parseInt($('minCommercial').value, 10),
    maxCommercialLen: parseInt($('maxCommercial').value, 10),
    // Repairing before the scan keeps the cuts-per-minute figure honest: a torn
    // frame otherwise registers as two scene changes.
    repairTears: $('repairTears').checked,
  };
}

// Quick detection on a short window from the playhead, for tuning the sliders.
async function runSample() {
  if (!state.filePath) return;
  const p = $('player');
  const len = parseInt($('sampleLen').value, 10);
  const start = p.currentTime;
  $('sampleResult').textContent = 'Testing…';
  $('sampleBtn').disabled = true;
  try {
    const res = await window.api.detectSample(state.filePath, detectOpts(), { start, duration: len });
    state.sampleRange = { start: res.rangeStart, end: res.rangeStart + res.rangeDuration };
    state.sampleBoundaries = res.boundaries.map((b) => ({ mid: b.mid, confident: b.confident }));
    const s = res.stats;
    const verdict = s.confidentBoundaries > 0
      ? `<b>${s.confidentBoundaries}</b> boundary${s.confidentBoundaries > 1 ? 'ies' : ''} found`
      : (s.blackEvents || s.silenceEvents
        ? 'no black+silence match — try raising sensitivity'
        : 'nothing detected — raise sensitivity, or no break here');
    $('sampleResult').innerHTML =
      `Sample ${fmtTime(res.rangeStart)}–${fmtTime(state.sampleRange.end)}: ` +
      `${s.blackEvents} black / ${s.silenceEvents} silence · ${verdict}`;
    renderTimeline();
  } catch (e) {
    $('sampleResult').textContent = 'Sample failed: ' + e.message;
  } finally {
    $('sampleBtn').disabled = false;
  }
}

// The job runs in the main process, so IPC wraps its error — match the message.
function isAbort(e) { return /Cancelled/i.test((e && e.message) || ''); }

// ---- keyboard layouts -------------------------------------------------
//
// Two profiles. Default is this app's own; VideoReDo mirrors the layout in its
// manual, because people arriving from it have the muscle memory already.
//
// The notable difference is navigation: VideoReDo steps single frames on the
// up/down arrows and leaves left/right for larger jumps, with Shift and Ctrl
// as x2 and x3 multipliers. Its manual documents up/down as the single-frame
// keys without saying which way each goes; up = forward follows convention.
//
// Split, merge and save/skip stay put in both. VideoReDo uses S and M for
// jump-to-selection-start and mute, but splitting and merging are central here
// in a way they are not there, so those keys are not worth surrendering.
const KEYMAPS = {
  default: {
    hint: 'Space play · ←/→ step frame (Shift = 1s) · Tab next cut · S split · M merge · I/O set in-out · K save⁄skip · drag timeline boundaries',
    keys: {
      ' ': 'playPause',
      arrowleft: 'frameBack', arrowright: 'frameFwd',
      home: 'gotoStart', end: 'gotoEnd',
      tab: 'stepBoundary',
      s: 'split', m: 'merge', i: 'markIn', o: 'markOut', k: 'toggleKeep',
    },
  },
  videoredo: {
    hint: 'Space play · ↑/↓ step frame · ←/→ jump 1s (Shift ×2, Ctrl ×3) · PgUp/PgDn 2 min · Tab next cut · F3/F4 mark in-out · S split · M merge · K save⁄skip',
    keys: {
      ' ': 'playPause',
      arrowup: 'frameFwd', arrowdown: 'frameBack',
      arrowleft: 'coarseBack', arrowright: 'coarseFwd',
      pageup: 'jumpFwd', pagedown: 'jumpBack',
      home: 'gotoStart', end: 'gotoEnd',
      tab: 'stepBoundary',
      f3: 'markIn', f4: 'markOut',
      s: 'split', m: 'merge', k: 'toggleKeep',
    },
  },
};

function activeKeymap() {
  return KEYMAPS[(state.settings && state.settings.keymap) || 'default'] || KEYMAPS.default;
}

function seekBy(p, secs) {
  state.previewEnd = null;
  p.currentTime = clamp(p.currentTime + secs, 0, Math.max(0, state.duration - 0.05));
}

// VideoReDo's left/right multipliers: x2 with Shift, x3 with Ctrl.
function coarseStep(e) { return e.ctrlKey ? 3 : (e.shiftKey ? 2 : 1); }

// Walk the cut list from the keyboard. Reviewing 80 segments with the mouse is
// the slow part of the job; this is the traversal VideoReDo's Tab gives you.
function stepBoundary(dir) {
  if (!state.segments.length) return;
  const i = selectedIndex();
  const next = i === -1
    ? (dir > 0 ? 0 : state.segments.length - 1)
    : clamp(i + dir, 0, state.segments.length - 1);
  selectSegment(state.segments[next].id, { seek: true });
}

const KEY_ACTIONS = {
  playPause: (e, p) => { e.preventDefault(); if (p.paused) p.play().catch(() => {}); else p.pause(); },
  frameBack: (e) => { e.preventDefault(); stepFrame(-1, e.shiftKey); },
  frameFwd: (e) => { e.preventDefault(); stepFrame(1, e.shiftKey); },
  coarseBack: (e, p) => { e.preventDefault(); seekBy(p, -coarseStep(e)); },
  coarseFwd: (e, p) => { e.preventDefault(); seekBy(p, coarseStep(e)); },
  jumpBack: (e, p) => { e.preventDefault(); seekBy(p, -120); },
  jumpFwd: (e, p) => { e.preventDefault(); seekBy(p, 120); },
  gotoStart: (e, p) => { e.preventDefault(); state.previewEnd = null; p.currentTime = 0; },
  gotoEnd: (e, p) => { e.preventDefault(); state.previewEnd = null; p.currentTime = Math.max(0, state.duration - 0.1); },
  stepBoundary: (e) => { e.preventDefault(); stepBoundary(e.shiftKey ? -1 : 1); },
  split: () => splitAtPlayhead(),
  merge: (e) => mergeWithNeighbor(e.shiftKey ? 1 : -1),
  markIn: (e) => { e.preventDefault(); setInPoint(); },
  markOut: (e) => { e.preventDefault(); setOutPoint(); },
  toggleKeep: () => { if (state.selected != null) toggleSegment(state.selected); },
};

function applyKeymap() {
  $('kbdHint').textContent = activeKeymap().hint;
  $('setKeymap').value = (state.settings && state.settings.keymap) || 'default';
}

// Anything marked [data-experimental] is hidden unless the setting is on.
// One switch for all of it, so a new half-finished feature just needs the
// attribute rather than its own plumbing.
function applyExperimental() {
  const on = state.settings && state.settings.experimental === true;
  document.querySelectorAll('[data-experimental]').forEach((el) =>
    el.classList.toggle('hidden', !on));
}

// Help text is a body class rather than per-element, so it covers the lines
// added later without anyone having to remember to wire them up. Both the
// topbar button and the Settings checkbox are driven from here, so whichever
// one you use, the other follows.
function applyHelpText() {
  const on = !!(state.settings && state.settings.showHelpText === true);
  document.body.classList.toggle('no-help', !on);
  $('helpTextToggle').checked = on;
  $('helpTextState').textContent = on ? 'On' : 'Off';
  $('setHelpText').checked = on;
}

async function setHelpText(on) {
  state.settings = await window.api.setSettings({ showHelpText: on });
  applyHelpText();
}

// Measure this tape and set the black threshold to suit it. The right value
// varies enough between tapes that a fixed default is wrong for some of them.
async function runCalibrate() {
  if (!state.filePath) return;
  $('player').pause();
  $('calibrateBtn').disabled = true;
  $('calibrateStatus').textContent = 'Calibrating…';
  showOverlay('Calibrating…', 'Sampling the tape at several sensitivities');
  setBar(0);
  try {
    const res = await window.api.calibrate(state.filePath, detectOpts());
    if (res.inconclusive) {
      $('calibrateStatus').textContent = 'No breaks in the sampled stretch';
      toast('Calibration found no breaks in that part of the tape — the sliders are unchanged.', true);
      return;
    }
    applyingPreset = true;
    $('blackThreshold').value = res.threshold;
    $('blackThreshold').dispatchEvent(new Event('input'));
    applyingPreset = false;
    $('detectPreset').value = 'custom';
    saveDetectSettings();
    const top = res.rungs[res.rungs.length - 1];
    $('calibrateStatus').textContent = `Set to ${res.threshold.toFixed(2)}`;
    toast(`Calibrated: black sensitivity ${res.threshold.toFixed(2)} (${top.blackEvents} candidates examined).`);
  } catch (e) {
    if (isAbort(e)) { $('calibrateStatus').textContent = 'Cancelled'; toast('Calibration aborted.'); }
    else { $('calibrateStatus').textContent = 'Failed'; toast('Calibration failed: ' + e.message, true); }
  } finally {
    $('calibrateBtn').disabled = false;
    hideOverlay();
  }
}

async function runDetect() {
  if (!state.filePath) return;
  $('player').pause();  // playback competes with the scan for disk and decode
  state.sampleBoundaries = []; state.sampleRange = null; // clear sample overlay
  showOverlay('Detecting commercials…', 'Scanning for black + silence boundaries');
  setBar(0);
  try {
    const res = await window.api.detect(state.filePath, detectOpts());
    // Detection replaces the list wholesale, so anything before it is not a
    // state worth returning to — undoing into an empty tape helps nobody.
    clearHistory();
    state.segments = res.segments;
    state.duration = res.duration || state.duration;
    const saved = res.segments.filter((s) => s.keep).length;
    $('detectStats').textContent =
      `${res.segments.length} segments · ${res.stats.confidentBoundaries} strong boundaries · ` +
      `${res.stats.blackEvents} black / ${res.stats.silenceEvents} silence events`;
    renderTimeline();
    renderSegmentList();
    updateExportSummary();
    $('exportBtn').disabled = false;
    toast(`Found ${saved} commercial${saved === 1 ? '' : 's'} to save (${res.segments.length} segments).`);
  } catch (e) {
    if (isAbort(e)) toast('Detection aborted.');
    else toast('Detection failed: ' + e.message, true);
  } finally {
    hideOverlay();
  }
}

// ---- rendering timeline ----------------------------------------------
function renderTimeline() {
  const tl = $('timeline');
  const playhead = $('playhead');
  tl.querySelectorAll('.seg').forEach((n) => n.remove());
  const dur = state.duration || 1;
  $('timelineTrack').style.width = (state.zoom * 100) + '%';

  if (state.segments.length === 0) {
    $('timelineTitle').textContent = 'Timeline';
  } else {
    $('timelineTitle').textContent = `Timeline · ${fmtTime(dur)}`;
  }

  for (const seg of state.segments) {
    const el = document.createElement('div');
    el.className = 'seg ' + segClass(seg);
    // Position by absolute time so segments line up with the playhead, scale,
    // and boundary handles. Gaps (black transitions) show as empty timeline.
    el.style.left = (seg.start / dur * 100) + '%';
    el.style.width = (Math.max(0, seg.duration) / dur * 100) + '%';
    if (state.selected === seg.id) el.classList.add('selected');
    el.title = `${fmtTime(seg.start)}–${fmtTime(seg.end)} (${fmtDur(seg.duration)}) · ${seg.keep ? 'save' : 'skip'}`
      + `\nClick to select · double-click to switch to ${seg.keep ? 'skip' : 'save'}`;
    el.addEventListener('click', () => selectSegment(seg.id, { seek: true }));
    el.addEventListener('dblclick', () => toggleSegment(seg.id));
    tl.appendChild(el);
  }
  // Draggable handles at each internal boundary (segments are contiguous).
  // Zoomed out on a tape with many breaks they crowd together, stop reading as
  // handles, and start looking like yellow segments of their own — so skip any
  // that wouldn't have room to be grabbed. Zooming in brings them back.
  const trackPx = ($('timelineScroll').clientWidth || 800) * (state.zoom || 1);
  const MIN_HANDLE_GAP_PX = 14;
  let lastHandlePx = -Infinity;
  for (let i = 0; i < state.segments.length - 1; i++) {
    const bTime = state.segments[i].end;
    const px = (bTime / dur) * trackPx;
    if (px - lastHandlePx < MIN_HANDLE_GAP_PX) continue;
    lastHandlePx = px;
    const h = document.createElement('div');
    h.className = 'bhandle';
    h.style.left = (bTime / dur * 100) + '%';
    h.title = `Boundary at ${fmtTime(bTime)} — drag to adjust`;
    h.addEventListener('pointerdown', (e) => startBoundaryDrag(e, i));
    tl.appendChild(h);
  }
  // Sample-scan overlay: highlight the tested window and show candidate marks.
  if (state.sampleRange && dur) {
    const band = document.createElement('div');
    band.className = 'sample-band';
    band.style.left = (state.sampleRange.start / dur * 100) + '%';
    band.style.width = ((state.sampleRange.end - state.sampleRange.start) / dur * 100) + '%';
    tl.appendChild(band);
  }
  for (const m of state.sampleBoundaries || []) {
    const t = document.createElement('div');
    t.className = 'sample-tick' + (m.confident ? ' confident' : '');
    t.style.left = (m.mid / dur * 100) + '%';
    t.title = `candidate boundary at ${fmtTime(m.mid)}`;
    tl.appendChild(t);
  }

  tl.appendChild(playhead);
  renderScale();
  renderMinimap();
}

function startBoundaryDrag(e, i) {
  e.preventDefault();
  e.stopPropagation();
  pushHistory(); // once per drag, not once per pixel of movement
  const tl = $('timeline');
  const move = (ev) => {
    const rect = tl.getBoundingClientRect();
    const a = state.segments[i], b = state.segments[i + 1];
    let t = (ev.clientX - rect.left) / rect.width * state.duration;
    t = clamp(t, a.start + 0.05, b.end - 0.05);
    a.end = t; b.start = t;
    recalc(a); recalc(b);
    renderTimeline();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    renderSegmentList();
    updateExportSummary();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// ---- minimap overview -------------------------------------------------
function renderMinimap() {
  const mm = $('minimap');
  const win = $('minimapWindow');
  mm.querySelectorAll('.mseg').forEach((n) => n.remove());
  const dur = state.duration || 1;
  for (const seg of state.segments) {
    const el = document.createElement('div');
    el.className = 'mseg ' + segClass(seg);
    el.style.left = (seg.start / dur * 100) + '%';
    el.style.width = (Math.max(0, seg.duration) / dur * 100) + '%';
    mm.insertBefore(el, win);
  }
  updateMinimapWindow();
}

function updateMinimapWindow() {
  const scroll = $('timelineScroll');
  const win = $('minimapWindow');
  const total = scroll.scrollWidth || 1;
  const leftPct = (scroll.scrollLeft / total) * 100;
  const wPct = (scroll.clientWidth / total) * 100;
  win.style.left = leftPct + '%';
  win.style.width = Math.min(100, wPct) + '%';
}

function minimapPanTo(clientX) {
  const mm = $('minimap');
  const rect = mm.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const scroll = $('timelineScroll');
  scroll.scrollLeft = ratio * scroll.scrollWidth - scroll.clientWidth / 2;
}

function renderScale() {
  const scale = $('timelineScale');
  scale.innerHTML = '';
  const dur = state.duration;
  if (!dur) return;
  // More ticks as we zoom in, so labels stay useful on long tapes.
  const ticks = Math.max(6, Math.min(120, Math.round(6 * state.zoom)));
  for (let i = 0; i <= ticks; i++) {
    const t = (dur / ticks) * i;
    const s = document.createElement('span');
    s.textContent = fmtTime(t);
    s.style.left = `${(i / ticks) * 100}%`;
    if (i === 0) s.style.transform = 'translateX(0)';
    if (i === ticks) s.style.transform = 'translateX(-100%)';
    scale.appendChild(s);
  }
}

function updatePlayhead() {
  const p = $('player');
  if (!state.duration) return;
  if (state.inSamplePreview) return; // player is on the temp sample; don't move the playhead
  // Stop at the end of a single-segment preview.
  if (state.previewEnd != null && p.currentTime >= state.previewEnd) {
    p.pause();
    state.previewEnd = null;
  }
  const pct = (p.currentTime / state.duration) * 100;
  $('playhead').style.left = pct + '%';
  $('monitorTc').textContent = fmtTC(p.currentTime);
  // Keep the playhead in view while playing on a zoomed timeline.
  if (state.zoom > 1 && !p.paused) {
    const scroll = $('timelineScroll');
    const x = (p.currentTime / state.duration) * scroll.scrollWidth;
    if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth) {
      scroll.scrollLeft = x - scroll.clientWidth / 2;
    }
  }
}

// ---- zoom -------------------------------------------------------------
function updateZoomLabel() { $('zoomLabel').textContent = state.zoom.toFixed(1) + '×'; }

// Set zoom while keeping the content point at `contentRatio` (0..1) pinned
// under `viewportX` pixels from the scroll viewport's left edge.
function zoomAround(newZoom, contentRatio, viewportX) {
  const scroll = $('timelineScroll');
  state.zoom = Math.min(60, Math.max(1, newZoom));
  $('timelineTrack').style.width = (state.zoom * 100) + '%';
  renderScale();
  const contentW = scroll.scrollWidth;
  scroll.scrollLeft = contentRatio * contentW - viewportX;
  updateZoomLabel();
  syncZoomSlider();
  updateMinimapWindow();
}

// Zoom slider uses a log scale (1× … 60×) so low zoom levels get fine control.
const ZOOM_MAX = 60;
function syncZoomSlider() {
  $('zoomSlider').value = Math.log(state.zoom) / Math.log(ZOOM_MAX);
}
function zoomFromSlider(norm) {
  const z = Math.pow(ZOOM_MAX, norm);
  const scroll = $('timelineScroll');
  const vx = scroll.clientWidth / 2;
  const ratio = (scroll.scrollLeft + vx) / scroll.scrollWidth;
  zoomAround(z, ratio, vx);
}

function zoomByButton(factor) {
  const scroll = $('timelineScroll');
  const vx = scroll.clientWidth / 2;
  const ratio = (scroll.scrollLeft + vx) / scroll.scrollWidth;
  zoomAround(state.zoom * factor, ratio, vx);
}

// Bring the matching row in the list below into view, so selecting a clip on
// the timeline doesn't leave you hunting for it among eighty others.
function scrollSegRowIntoView(id) {
  const row = $('segmentList').querySelector(`[data-seg-id="${id}"]`);
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
}

function scrollSegIntoView(seg) {
  if (state.zoom <= 1) return;
  const scroll = $('timelineScroll');
  const w = scroll.scrollWidth;
  const x1 = (seg.start / state.duration) * w;
  const x2 = (seg.end / state.duration) * w;
  if (x1 < scroll.scrollLeft || x2 > scroll.scrollLeft + scroll.clientWidth) {
    scroll.scrollLeft = x1 - scroll.clientWidth * 0.25;
  }
}

// ---- segment list -----------------------------------------------------
function renderSegmentList() {
  const list = $('segmentList');
  if (state.segments.length === 0) {
    list.innerHTML = '<div class="empty-note">Load a capture and run detection to see segments.</div>';
    $('segCount').textContent = 'Segments';
    return;
  }
  const saved = state.segments.filter((s) => s.keep).length;
  $('segCount').textContent = `${state.segments.length} segments · ${saved} saved`;
  list.innerHTML = '';
  state.segments.forEach((seg, idx) => {
    const row = document.createElement('div');
    row.className = 'seg-row' + (state.selected === seg.id ? ' selected' : '');
    row.dataset.segId = seg.id;
    row.innerHTML = `
      <span class="seg-dot ${segClass(seg)}"></span>
      <span class="seg-time">${String(idx + 1).padStart(2, '0')} · ${fmtTime(seg.start)} → ${fmtTime(seg.end)}</span>
      <span class="seg-dur">${fmtDur(seg.duration)}</span>
      <span class="seg-cuts" title="Scene changes per minute. Ads tend to cut faster than the show.">${seg.cutsPerMin == null ? '' : seg.cutsPerMin + '/min'}</span>
      <span class="seg-tag ${segClass(seg)}" title="Click to switch to ${seg.keep ? 'skip' : 'save'}">${seg.keep ? 'save' : 'skip'}</span>`;
    row.addEventListener('click', () => selectSegment(seg.id, { seek: true, play: true }));
    const tag = row.querySelector('.seg-tag');
    tag.addEventListener('click', (e) => { e.stopPropagation(); toggleSegment(seg.id); });
    list.appendChild(row);
  });
}

function fastSeekTo(p, t) {
  // fastSeek (nearest-keyframe) is much snappier where supported; fall back.
  if (typeof p.fastSeek === 'function') {
    try { p.fastSeek(t); return; } catch (_) { /* fall through */ }
  }
  p.currentTime = t;
}

// Jump to a segment and play just it, auto-pausing at its end.
function previewSegment(seg) {
  const p = $('player');
  state.previewEnd = seg.end;
  fastSeekTo(p, seg.start + 0.03);
  p.play().catch(() => {});
}

function selectSegment(id, { seek = false, play = false } = {}) {
  state.selected = id;
  const seg = state.segments.find((s) => s.id === id);
  if (state.inSamplePreview) {
    // leave the sample preview and return to the tape at this clip
    state.previewReturnTime = seg ? seg.start + 0.03 : 0;
    exitSamplePreview();
    renderTimeline(); renderSegmentList();
    if (seg) { scrollSegIntoView(seg); scrollSegRowIntoView(id); }
    return;
  }
  if (seg) {
    const p = $('player');
    if (play) previewSegment(seg);
    else if (seek) { state.previewEnd = null; fastSeekTo(p, seg.start + 0.03); }
  }
  renderTimeline();
  renderSegmentList();
  if (seg) { scrollSegIntoView(seg); scrollSegRowIntoView(id); }
}

function toggleSegment(id) {
  const seg = state.segments.find((s) => s.id === id);
  if (!seg) return;
  pushHistory();
  seg.keep = !seg.keep;
  refreshSegments();
}

// ---- undo -------------------------------------------------------------
//
// Snapshots the whole cut list before each change rather than recording what
// each operation did. Segments are small plain objects — an 84-segment tape is
// a few kilobytes — so copying the array outright is cheaper to reason about
// than inverse operations, and it cannot drift out of step with them the way
// hand-written undo for eight different edits would.
//
// Cleared when a file is opened or detection replaces the list: undoing back
// to "before detection" would just leave you with nothing.
const HISTORY_LIMIT = 50;
const history = { past: [], future: [] };

function snapshotSegments() {
  return { segments: state.segments.map((s) => ({ ...s })), selected: state.selected };
}

function restoreSnapshot(snap) {
  state.segments = snap.segments.map((s) => ({ ...s }));
  state.selected = snap.selected;
}

// Call BEFORE mutating, and only once the operation is certain to go ahead —
// pushing on a rejected edit would leave a no-op sitting in the history.
function pushHistory() {
  history.past.push(snapshotSegments());
  if (history.past.length > HISTORY_LIMIT) history.past.shift();
  history.future.length = 0; // a fresh edit invalidates anything undone
  updateHistoryButtons();
}

function undoEdit() {
  if (!history.past.length) return;
  history.future.push(snapshotSegments());
  restoreSnapshot(history.past.pop());
  refreshSegments();
  updateHistoryButtons();
}

function redoEdit() {
  if (!history.future.length) return;
  history.past.push(snapshotSegments());
  restoreSnapshot(history.future.pop());
  refreshSegments();
  updateHistoryButtons();
}

function clearHistory() {
  history.past.length = 0;
  history.future.length = 0;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('undoBtn').disabled = history.past.length === 0;
  $('redoBtn').disabled = history.future.length === 0;
}

// ---- manual clip editing ----------------------------------------------
function refreshSegments() {
  renderTimeline();
  renderSegmentList();
  updateExportSummary();
}
function recalc(seg) { seg.duration = seg.end - seg.start; }
function nextSegId() { return state.segments.reduce((m, s) => Math.max(m, s.id), -1) + 1; }
function selectedIndex() { return state.segments.findIndex((s) => s.id === state.selected); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Split the clip under the playhead into two at the current time.
function splitAtPlayhead() {
  const t = $('player').currentTime;
  const idx = state.segments.findIndex((s) => t > s.start + 0.05 && t < s.end - 0.05);
  if (idx < 0) return toast('Move the playhead inside a clip to split it.', true);
  pushHistory();
  const seg = state.segments[idx];
  const tail = { id: nextSegId(), start: t, end: seg.end, keep: seg.keep, confidentBoundary: false };
  seg.end = t;
  recalc(seg); recalc(tail);
  state.segments.splice(idx + 1, 0, tail);
  state.selected = tail.id;
  refreshSegments();
}

// Merge the selected clip with a neighbor (dir: -1 previous, +1 next).
function mergeWithNeighbor(dir) {
  const idx = selectedIndex();
  if (idx < 0) return toast('Select a clip first.', true);
  const j = idx + dir;
  if (j < 0 || j >= state.segments.length) return;
  pushHistory();
  const lo = Math.min(idx, j), hi = Math.max(idx, j);
  const a = state.segments[lo], b = state.segments[hi];
  a.end = b.end; recalc(a);       // keep the earlier clip's keep/cut state
  state.segments.splice(hi, 1);
  state.selected = a.id;
  refreshSegments();
}

// Move a boundary to the playhead by editing the selected clip's start/end,
// keeping neighbors contiguous.
function setInPoint() {
  const idx = selectedIndex();
  if (idx < 0) return toast('Select a clip first.', true);
  pushHistory();
  const seg = state.segments[idx];
  const prev = state.segments[idx - 1];
  const t = clamp($('player').currentTime, (prev ? prev.start : 0) + 0.05, seg.end - 0.05);
  seg.start = t; recalc(seg);
  if (prev) { prev.end = t; recalc(prev); }
  refreshSegments();
}
function setOutPoint() {
  const idx = selectedIndex();
  if (idx < 0) return toast('Select a clip first.', true);
  pushHistory();
  const seg = state.segments[idx];
  const next = state.segments[idx + 1];
  const t = clamp($('player').currentTime, seg.start + 0.05, (next ? next.end : state.duration) - 0.05);
  seg.end = t; recalc(seg);
  if (next) { next.start = t; recalc(next); }
  refreshSegments();
}

// Frame-accurate transport.
function stepFrame(dir, big) {
  const p = $('player');
  const fps = (state.info && state.info.fps) ? state.info.fps : 30;
  const delta = big ? 1 : 1 / fps;
  state.previewEnd = null;
  p.pause();
  p.currentTime = clamp(p.currentTime + dir * delta, 0, Math.max(0, state.duration - 1 / fps));
}

// ---- export -----------------------------------------------------------
function colorSettings() {
  return {
    enabled: $('colorEnabled').checked,
    brightness: parseFloat($('brightness').value),
    contrast: parseFloat($('contrast').value),
    saturation: parseFloat($('saturation').value),
    gamma: parseFloat($('gamma').value),
    r: parseFloat($('rgbR').value),
    g: parseFloat($('rgbG').value),
    b: parseFloat($('rgbB').value),
  };
}
// ---- resizable segment list -------------------------------------------
// On a tape with eighty segments the default 210px shows about four at a time,
// so the list is draggable against the player. Bounds stop either pane being
// dragged away entirely, since a player of zero height and no way back would
// need a reset button to recover from.
const SEG_MIN = 120;
const SEG_MAX_FRACTION = 0.75; // leave at least a quarter of the window as player

function setSegmentsHeight(px) {
  const layout = document.querySelector('.layout');
  const max = Math.max(SEG_MIN, layout.clientHeight * SEG_MAX_FRACTION);
  const h = Math.round(Math.max(SEG_MIN, Math.min(max, px)));
  layout.style.setProperty('--seg-h', `${h}px`);
  return h;
}

function initRowResizer() {
  const handle = $('rowResizer');
  const layout = document.querySelector('.layout');
  if (!handle || !layout) return;

  let dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    // Distance from the pointer to the bottom of the layout, less the padding,
    // is the height the list should take.
    const rect = layout.getBoundingClientRect();
    setSegmentsHeight(rect.bottom - e.clientY - 14);
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('row-resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    // Persist only on release: saving during the drag would write settings on
    // every mouse move.
    const h = parseInt(layout.style.getPropertyValue('--seg-h'), 10);
    if (h) window.api.setSettings({ segmentsHeight: h });
    renderTimeline(); // the timeline sizes itself to the space it has
  };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('row-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // Double-click restores the default, which is easier to find than a menu item.
  handle.addEventListener('dblclick', () => {
    setSegmentsHeight(210);
    window.api.setSettings({ segmentsHeight: 210 });
    renderTimeline();
  });

  // Re-clamp when the window changes, so a saved height from a big window does
  // not swallow the player on a small one.
  window.addEventListener('resize', () => {
    const cur = parseInt(layout.style.getPropertyValue('--seg-h'), 10);
    if (cur) setSegmentsHeight(cur);
  });
}

// ---- live preview -----------------------------------------------------
// Drives the SVG filter chain in index.html from the Restore sliders, so the
// player shows the effect while you drag instead of after a render.
//
// The math here was measured against ffmpeg rather than assumed, because the
// obvious implementations are wrong in ways you would not notice until export:
//
//   * eq's brightness ADDS an offset. The old CSS brightness() multiplied, so
//     at slider 0.20 the player showed 154 where export produced 176.
//   * eq's contrast and gamma act on luma only, leaving chroma alone. Scaling
//     RGB channels directly also scales the color: measured 42 levels off on
//     saturated content, against 3 for the luma-only form.
//   * eq works on limited-range luma (16-235), so a unit of brightness covers
//     219 levels, not 255. Hence the 255/219 scale.
//
// Verified against ffmpeg over ten colors and five settings, comparing the
// whole chain rather than the model behind it:
//
//   defaults (b .05 c 1.10 s 1.20)   worst 4.1   mean 2.8
//   heavy    (b .20 c 1.40 s 1.50)   worst 6.4   mean 4.4
//   gamma 1.30 + contrast 1.2        worst 16.7  mean 4.8
//
// Gamma is the weak one, and unavoidably so: feComponentTransfer is per-channel
// while eq applies gamma to luma alone, which is the same mismatch that put
// contrast 42 levels out before it moved into the matrix above. A luma-only
// nonlinear curve would need the difference composited back in, and feComposite
// clamps negatives, so it cannot be expressed here. Mean error stays around 3
// of 255 either way, which is why the note says "close" rather than "exact".
const LIMITED = 255 / 219;      // limited-range luma spans 219 levels
const LUMA_R = 0.299, LUMA_G = 0.587, LUMA_B = 0.114; // Rec.601, as ffmpeg uses

// colorbalance's midtone weighting, sampled from ffmpeg at bm=0.30. It peaks at
// level 127 and falls to nothing below 48 and above 206, and the shift is
// linear in the slider amount (checked at 0.1/0.2/0.3/0.5). Hardcoded because
// the filter's own curve is not the textbook one its name suggests.
const BALANCE_CURVE = [
  [0, 0], [16, 0], [31, 0], [47, 0], [62, 0.105], [79, 0.288], [94, 0.444],
  [110, 0.627], [127, 0.706], [143, 0.654], [159, 0.471], [174, 0.301],
  [191, 0.118], [206, 0], [222, 0], [237, 0], [255, 0],
];

function balanceWeight(level) {
  for (let i = 1; i < BALANCE_CURVE.length; i++) {
    const [x1, w1] = BALANCE_CURVE[i];
    if (level <= x1) {
      const [x0, w0] = BALANCE_CURVE[i - 1];
      const t = x1 === x0 ? 0 : (level - x0) / (x1 - x0);
      return w0 + (w1 - w0) * t;
    }
  }
  return 0;
}

// One channel's tone curve: gamma, then color balance, sampled for feFuncX.
// ffmpeg applies eq before colorbalance, so the order matters.
function toneCurve(gamma, balance, steps = 33) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const v = (i / (steps - 1)) * 255;
    // gamma on the limited-range value, which is why full white lands on 248
    let y = v;
    if (gamma !== 1) {
      const lim = 16 + y * (219 / 255);
      y = (Math.pow(lim / 255, 1 / gamma) * 255 - 16) * LIMITED;
    }
    if (balance) y += balance * 255 * balanceWeight(Math.max(0, Math.min(255, y)));
    out.push((Math.max(0, Math.min(255, y)) / 255).toFixed(4));
  }
  return out.join(' ');
}

// How much smaller the frame on screen is than the source. Sharpen and denoise
// are measured in pixels, so a radius tuned for a 1080-line original is far too
// strong on the 480p preview copy the player is showing.
function previewScale() {
  const p = $('player');
  const srcH = (state.info && state.info.height) || 0;
  if (!srcH || !p.videoHeight) return 1;
  return p.videoHeight / srcH;
}

// Denoise/sharpen strength per Enhance preset, keyed to the ffmpeg values in
// src/export.js. These are eyeball matches, not measured ones.
const ENHANCE_LIVE = {
  off: null,
  sp: { blur: 0.5, mix: 0.35, sharpen: 0.4 },
  lp: { blur: 0.9, mix: 0.50, sharpen: 0.8 },
  ep: { blur: 1.4, mix: 0.62, sharpen: 1.2 },
};

function applyLiveColor() {
  const p = $('player');
  const c = colorSettings();
  const en = ENHANCE_LIVE[$('enhancePreset').value] || null;

  // A rendered sample already has everything baked in; filtering it again would
  // apply each effect twice.
  if (state.inSamplePreview || (!c.enabled && !en)) {
    p.style.filter = '';
    updateLiveNote(false, false);
    return;
  }

  const contrast = c.enabled ? (c.contrast ?? 1) : 1;
  const bright = c.enabled ? (c.brightness ?? 0) : 0;
  const sat = c.enabled ? (c.saturation ?? 1) : 1;
  const gamma = c.enabled ? (c.gamma ?? 1) : 1;

  // Contrast + brightness, luma only. Chroma is carried through untouched.
  const k = contrast - 1;
  const off = (0.5 * (1 - contrast)) + (bright * LIMITED);
  const row = (self) => [
    (self === 0 ? 1 : 0) + LUMA_R * k,
    (self === 1 ? 1 : 0) + LUMA_G * k,
    (self === 2 ? 1 : 0) + LUMA_B * k,
    0, off,
  ];
  setAttr('fxLuma', 'values', [row(0), row(1), row(2), [0, 0, 0, 1, 0]]
    .map((r) => r.map((n) => n.toFixed(5)).join(' ')).join('  '));

  // Saturation with Rec.601 weights. SVG's built-in `saturate` uses Rec.709 and
  // would drift on exactly the saturated content that shows the difference.
  const satRow = (self) => [
    LUMA_R * (1 - sat) + (self === 0 ? sat : 0),
    LUMA_G * (1 - sat) + (self === 1 ? sat : 0),
    LUMA_B * (1 - sat) + (self === 2 ? sat : 0),
    0, 0,
  ];
  setAttr('fxSat', 'values', [satRow(0), satRow(1), satRow(2), [0, 0, 0, 1, 0]]
    .map((r) => r.map((n) => n.toFixed(5)).join(' ')).join('  '));

  // Gamma + per-channel balance as sampled curves.
  const bal = c.enabled ? c : { r: 0, g: 0, b: 0 };
  for (const [id, amount] of [['fxCurveR', bal.r], ['fxCurveG', bal.g], ['fxCurveB', bal.b]]) {
    const el = document.getElementById(id);
    if (gamma === 1 && !amount) { el.setAttribute('type', 'identity'); el.removeAttribute('tableValues'); continue; }
    el.setAttribute('type', 'table');
    el.setAttribute('tableValues', toneCurve(gamma, amount || 0));
  }

  // Denoise and sharpen, both scaled for the smaller preview frame.
  const s = previewScale();
  if (en) {
    setAttr('fxBlur', 'stdDeviation', (en.blur * s).toFixed(3));
    setAttr('fxBlurMix', 'k2', en.mix.toFixed(3));
    setAttr('fxBlurMix', 'k3', (1 - en.mix).toFixed(3));
    const a = en.sharpen * s;
    setAttr('fxSharpen', 'kernelMatrix',
      `0 ${-a} 0  ${-a} ${1 + 4 * a} ${-a}  0 ${-a} 0`);
    setAttr('fxSharpen', 'divisor', '1');
  } else {
    setAttr('fxBlur', 'stdDeviation', '0');
    setAttr('fxBlurMix', 'k2', '0');
    setAttr('fxBlurMix', 'k3', '1');
    setAttr('fxSharpen', 'kernelMatrix', '0 0 0  0 1 0  0 0 0');
  }

  p.style.filter = 'url(#liveFx)';
  updateLiveNote(c.enabled, !!en);
}

function setAttr(id, name, value) {
  const el = document.getElementById(id);
  if (el) el.setAttribute(name, value);
}

// ---- live audio drift -------------------------------------------------
// Routes the player through a WebAudio delay so lip-sync can be judged while
// dragging. Only works in one direction: a delay can hold the audio back, but
// nothing here can hold the VIDEO back, so "audio earlier" cannot be previewed.
// Negative drift says so rather than showing an unchanged picture and letting
// you conclude the setting does nothing.
//
// createMediaElementSource permanently reroutes the element's audio, so it is
// created once and left in place with a delay of zero when unused. Built lazily
// because an AudioContext made before any user gesture starts suspended.
let audioGraph = null;

function ensureAudioGraph() {
  if (audioGraph) return audioGraph;
  const p = $('player');
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaElementSource(p);
    const delay = ctx.createDelay(1.0); // slider caps at 500ms
    src.connect(delay);
    delay.connect(ctx.destination);
    audioGraph = { ctx, delay };
  } catch (_) {
    audioGraph = { ctx: null, delay: null }; // don't retry every drag
  }
  return audioGraph;
}

function applyLiveAudio() {
  const ms = parseInt($('audioDrift').value, 10) || 0;
  const note = $('driftNote');
  if (note) {
    note.textContent = ms < 0
      ? 'Pulling audio earlier cannot be previewed live. Use Preview to hear it.'
      : '';
    note.classList.toggle('hidden', ms >= 0);
  }
  if (!ms && !audioGraph) return; // nothing to do, and no need to build the graph
  const g = ensureAudioGraph();
  if (!g.delay) return;
  if (g.ctx.state === 'suspended') g.ctx.resume().catch(() => {});
  g.delay.delayTime.value = Math.max(0, ms) / 1000;
}

// Says which parts of what you are looking at can be trusted. Denoise and
// sharpen are stand-ins: hqdn3d filters over time as well as space, and unsharp
// takes a pixel radius that means something different on a 480p preview than on
// your original. Both are close enough to judge by and wrong enough to check.
function updateLiveNote(colorOn, enhanceOn) {
  const el = $('liveNote');
  if (!el) return;
  if (!colorOn && !enhanceOn) { el.classList.add('hidden'); return; }
  el.textContent = enhanceOn
    ? 'Live: color tracks the export closely. Denoise and sharpen are approximations scaled for the preview copy — use Preview to see them properly.'
    : 'Live: color tracks the export closely.';
  el.classList.toggle('approx', enhanceOn);
  el.classList.remove('hidden');
}

// Render a short sample with the full pipeline and play it in the player.
async function renderSamplePreview() {
  if (!state.filePath) return;
  const p = $('player');
  const start = p.currentTime;
  if (!state.inSamplePreview) state.previewReturnTime = start;
  $('previewSampleBtn').disabled = true;
  setProxyStatus('Rendering preview…', { spinning: true });
  try {
    const out = await window.api.renderPreview({
      // renderPreview() destructures `input` — sending `filePath` silently
      // handed ffmpeg undefined. Preview deliberately uses the original, not
      // the proxy: the point is to show exactly what export will produce.
      input: state.filePath,
      start,
      duration: 6,
      correction: colorSettings(),
      enhance: $('enhancePreset').value,
      repairTears: $('repairTears').checked,
      layout: { frame: 'source' }, // focus on color/restore/audio
      quality: exportQuality(),
      audioDriftMs: parseInt($('audioDrift').value, 10),
      normalizeAudio: $('normalizeAudio').checked,
    });
    state.inSamplePreview = true;
    p.style.filter = ''; // effects are baked into the render
    p.src = toFileUrl(out);
    p.addEventListener('loadedmetadata', function once() {
      p.removeEventListener('loadedmetadata', once);
      p.play().catch(() => {});
    });
    $('previewBanner').classList.remove('hidden');
    setProxyStatus('');
  } catch (e) {
    toast('Preview failed: ' + e.message, true);
    setProxyStatus('');
  } finally {
    $('previewSampleBtn').disabled = false;
  }
}

function exitSamplePreview() {
  const p = $('player');
  state.inSamplePreview = false;
  $('previewBanner').classList.add('hidden');
  const back = state.proxyPath || state.filePath;
  const t = state.previewReturnTime;
  p.src = toFileUrl(back);
  p.addEventListener('loadedmetadata', function once() {
    p.removeEventListener('loadedmetadata', once);
    try { p.currentTime = t; } catch (_) {}
  });
  applyLiveColor();
}

function exportMode() {
  return document.querySelector('input[name=mode]:checked').value;
}
function exportTarget() { return $('exportTarget').value; } // 'save' | 'skip'

// Resolution and frame rate always follow the source, so frame is the only
// layout choice left.
function exportLayout() {
  return { frame: $('exportFrame').value };
}
function exportQuality() { return $('exportQuality').value; }
function exportBaseName() {
  const v = $('exportName').value.trim();
  return v ? v.replace(/[\\/:*?"<>|]/g, '_') : baseName(state.filePath);
}

const FRAME_LABELS = {
  source: 'source frame',
  '4:3': 'standard 4:3 (1440×1080)',
};

function updateExportSummary() {
  const target = exportTarget();
  const chosen = state.segments.filter((s) => (target === 'skip' ? !s.keep : s.keep));
  const noun = target === 'skip' ? 'show' : 'commercial';
  // Cut points depend only on there being segments at all — the handler says
  // so if the chosen side happens to be empty.
  $('cutPointsBtn').disabled = state.segments.length === 0;
  if (chosen.length === 0) {
    $('exportSummary').textContent = state.segments.length ? `No ${noun} clips selected.` : '';
    $('exportBtn').disabled = true;
    return;
  }
  const total = chosen.reduce((a, s) => a + s.duration, 0);
  const mode = exportMode();
  const layout = exportLayout();
  const frameNote = layout.frame === 'source' ? '' : ` · reframed to ${FRAME_LABELS[layout.frame]}`;
  const qLabel = $('exportQuality').selectedOptions[0].textContent.split(' · ')[0];
  const bits = [`${qLabel} quality`, 'source resolution and frame rate'];
  $('exportSummary').innerHTML =
    `Exporting <b>${chosen.length}</b> ${noun} clip(s) · ${fmtTime(total)}${frameNote}<br>` +
    (mode === 'merged' ? 'Output: one merged file' : `Output: ${chosen.length} separate clips`) +
    `<br><span class="muted">${bits.join(' · ')}</span>`;
  $('exportBtn').disabled = false;
}

// Write the in/out points as text instead of encoding anything, for cutting
// elsewhere. Instant — no ffmpeg involved.
async function saveCutPoints() {
  if (!state.segments.length) return toast('Run detection first — there are no clips to write.', true);
  const fps = state.info && state.info.fps;
  // Frame numbers are the whole point of the file, so refuse rather than
  // writing timecodes and quietly dropping the column they asked for.
  if (!fps) return toast("Couldn't read the source frame rate, so frame numbers aren't available.", true);
  const target = exportTarget();
  const outputDir = state.outputDir || dirName(state.filePath);
  try {
    const res = await window.api.saveCutPoints({
      segments: state.segments,
      target,
      fps,
      baseName: exportBaseName(),
      sourceName: baseName(state.filePath),
      outputDir,
    });
    if (!res.written.length) {
      return toast(`No ${target === 'skip' ? 'skipped' : 'saved'} clips to write.`, true);
    }
    toast(`Wrote ${res.written.length} cut-point files to ${outputDir}`);
    window.api.showItem(res.written[0]);
  } catch (e) {
    toast('Could not write cut points: ' + e.message, true);
  }
}

async function runExport() {
  const target = exportTarget();
  const chosen = state.segments.filter((s) => (target === 'skip' ? !s.keep : s.keep));
  if (chosen.length === 0) {
    return toast(`No ${target === 'skip' ? 'skipped (show)' : 'saved (commercial)'} clips to export.`, true);
  }
  const outputDir = state.outputDir || dirName(state.filePath);
  const payload = {
    input: state.filePath,
    segments: state.segments,
    mode: exportMode(),
    target: exportTarget(),
    correction: colorSettings(),
    enhance: $('enhancePreset').value,
    repairTears: $('repairTears').checked,
    layout: exportLayout(),
    quality: exportQuality(),
    audioDriftMs: parseInt($('audioDrift').value, 10),
    normalizeAudio: $('normalizeAudio').checked,
    outputDir,
    baseName: exportBaseName(),
  };
  $('player').pause();  // playback competes with the encode for disk and decode
  showOverlay('Exporting…', 'Preparing');
  setBar(0);
  try {
    const res = await window.api.export(payload);
    hideOverlay();
    toast(`Exported ${res.outputs.length} file(s) to ${outputDir}`);
    if (res.outputs[0]) window.api.showItem(res.outputs[0]);
  } catch (e) {
    hideOverlay();
    if (isAbort(e)) toast('Export aborted. Finished clips were kept.');
    else toast('Export failed: ' + e.message, true);
  }
}

// ---- overlay ----------------------------------------------------------
function showOverlay(title, status) {
  $('overlayTitle').textContent = title;
  $('overlayStatus').textContent = status || '';
  const abort = $('overlayAbort');
  abort.disabled = false;
  abort.textContent = 'Abort';
  $('overlay').classList.remove('hidden');
}
function hideOverlay() { $('overlay').classList.add('hidden'); }
function setBar(p) { $('overlayBar').style.width = Math.round((p || 0) * 100) + '%'; }

// ---- wiring -----------------------------------------------------------
function bindSlider(id, outId, fmt) {
  const el = $(id), out = $(outId);
  const update = () => { out.textContent = fmt(el.value); };
  el.addEventListener('input', update);
  update();
}

// ---- help: tooltips + guide modal ------------------------------------
function showTip(el, text) {
  const tip = $('tooltip');
  tip.textContent = text;
  tip.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let top = r.top - tr.height - 8;
  if (top < 8) top = r.bottom + 8;                 // flip below if no room above
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, left));
  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
}
function hideTip() { $('tooltip').classList.add('hidden'); }

function openGuide() { $('helpModal').classList.remove('hidden'); }
function closeGuide() { $('helpModal').classList.add('hidden'); }
function helpModalOpen() { return !$('helpModal').classList.contains('hidden'); }

function initHelp() {
  let tipTimer;
  const over = (e) => {
    const el = e.target.closest('[data-help]');
    if (!el) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(el, el.getAttribute('data-help')), 300);
  };
  const out = (e) => {
    if (e.target.closest('[data-help]')) { clearTimeout(tipTimer); hideTip(); }
  };
  document.addEventListener('mouseover', over);
  document.addEventListener('mouseout', out);
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-help]');
    if (el) showTip(el, el.getAttribute('data-help'));
  });
  document.addEventListener('focusout', hideTip);

  $('guideBtn').addEventListener('click', openGuide);
  $('helpClose').addEventListener('click', closeGuide);
  $('helpDone').addEventListener('click', closeGuide);
  $('helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal') closeGuide(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (helpModalOpen()) closeGuide();
    if (settingsOpen()) closeSettings();
  });

  // Open the Guide automatically on first launch.
  try {
    if (!localStorage.getItem('vhs_welcomed')) {
      openGuide();
      localStorage.setItem('vhs_welcomed', '1');
    }
  } catch (_) { /* localStorage may be unavailable */ }
}

// ---- settings ---------------------------------------------------------
function fmtCache(bytes) {
  if (!bytes) return '0 MB';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(0) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}
function openSettings() { $('settingsModal').classList.remove('hidden'); refreshCacheSize(); }
function closeSettings() { $('settingsModal').classList.add('hidden'); }
function settingsOpen() { return !$('settingsModal').classList.contains('hidden'); }
async function refreshCacheSize() {
  try { $('cacheSizeLabel').textContent = 'Cache: ' + fmtCache(await window.api.cacheSize()); }
  catch (_) { $('cacheSizeLabel').textContent = 'Cache: —'; }
}

async function initSettings() {
  state.settings = await window.api.getSettings();
  $('setProxyEnabled').checked = state.settings.proxyEnabled;
  $('setDetectOnProxy').checked = state.settings.detectOnProxy !== false;
  $('setExperimental').checked = state.settings.experimental === true;
  $('setHelpText').checked = state.settings.showHelpText !== false;
  applyExperimental();
  applyHelpText();
  applyKeymap();
  applySavedDetect();
  // Restore the dragged split. setSegmentsHeight re-clamps, so a height saved
  // on a larger window cannot swallow the player on a smaller one.
  if (state.settings.segmentsHeight) setSegmentsHeight(state.settings.segmentsHeight);
  initRowResizer();
  $('setCap').value = state.settings.proxyCacheCapGB;
  $('setCapOut').textContent = state.settings.proxyCacheCapGB + ' GB';
  $('setEncoder').value = state.settings.encoder;
  // First run probes the hardware in the background; catch up when it lands.
  window.api.onEncoderDetected((enc) => {
    state.settings.encoder = enc;
    $('setEncoder').value = enc;
  });
  try { $('appVersion').textContent = await window.api.appVersion(); } catch (_) {}

  $('checkUpdatesBtn').addEventListener('click', async () => {
    $('updateCheckStatus').textContent = 'Checking…';
    const r = await window.api.checkForUpdates();
    if (r.reason === 'dev') $('updateCheckStatus').textContent = 'Updates only work in the installed app.';
    else if (!r.ok) $('updateCheckStatus').textContent = 'Check failed (are you online / is a release published?).';
    else $('updateCheckStatus').textContent = 'Checked — you’ll be notified if an update is available.';
  });

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsDone').addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });

  $('setProxyEnabled').addEventListener('change', async () => {
    state.settings = await window.api.setSettings({ proxyEnabled: $('setProxyEnabled').checked });
  });
  $('setDetectOnProxy').addEventListener('change', async () => {
    state.settings = await window.api.setSettings({ detectOnProxy: $('setDetectOnProxy').checked });
  });
  $('setKeymap').addEventListener('change', async () => {
    state.settings = await window.api.setSettings({ keymap: $('setKeymap').value });
    applyKeymap(); // the hint line follows immediately, no restart
  });
  $('setExperimental').addEventListener('change', async () => {
    state.settings = await window.api.setSettings({ experimental: $('setExperimental').checked });
    applyExperimental(); // takes effect straight away, no restart
  });
  $('setHelpText').addEventListener('change', () => setHelpText($('setHelpText').checked));
  $('helpTextToggle').addEventListener('change', () => setHelpText($('helpTextToggle').checked));
  $('setCap').addEventListener('input', () => { $('setCapOut').textContent = $('setCap').value + ' GB'; });
  $('setCap').addEventListener('change', async () => {
    state.settings = await window.api.setSettings({ proxyCacheCapGB: parseInt($('setCap').value, 10) });
  });
  $('clearCacheBtn').addEventListener('click', async () => {
    const freed = await window.api.clearCache();
    toast('Cleared ' + fmtCache(freed) + ' of previews.');
    refreshCacheSize();
  });
  $('setEncoder').addEventListener('change', async () => {
    state.settings = await window.api.setSettings({ encoder: $('setEncoder').value });
    $('encoderStatus').textContent = ''; $('encoderStatus').className = 'muted';
  });
  $('testEncoderBtn').addEventListener('click', async () => {
    const enc = $('setEncoder').value;
    $('encoderStatus').textContent = 'Testing…'; $('encoderStatus').className = 'muted';
    const r = await window.api.testEncoder(enc);
    if (r.ok) { $('encoderStatus').textContent = '✓ Works on this machine'; $('encoderStatus').className = 'ok'; }
    else { $('encoderStatus').textContent = '✗ Not available here — use CPU'; $('encoderStatus').className = 'bad'; }
  });
}

// ---- auto-update ------------------------------------------------------
function showUpdateBanner(text, primaryLabel, onPrimary) {
  $('updateText').textContent = text;
  const btn = $('updatePrimary');
  if (primaryLabel) {
    btn.textContent = primaryLabel;
    btn.style.display = '';
    btn.onclick = onPrimary;
  } else {
    btn.style.display = 'none';
  }
  $('updateBanner').classList.remove('hidden');
}
function hideUpdateBanner() { $('updateBanner').classList.add('hidden'); }

function initUpdates() {
  $('updateDismiss').addEventListener('click', hideUpdateBanner);

  window.api.onUpdateAvailable((d) => {
    showUpdateBanner(`Update ${d.version} is available.`, 'Download', () => {
      showUpdateBanner(`Downloading ${d.version}… 0%`, null);
      window.api.downloadUpdate();
    });
  });
  window.api.onUpdateProgress((pct) => {
    showUpdateBanner(`Downloading update… ${pct}%`, null);
  });
  window.api.onUpdateDownloaded((d) => {
    showUpdateBanner(`Update ${d.version} ready.`, 'Restart & install', () => window.api.installUpdate());
  });
  window.api.onUpdateError(() => { /* stay quiet; manual check reports errors */ });
}

function init() {
  initHelp();
  initSettings();
  initUpdates();
  $('openBtn').addEventListener('click', async () => {
    const f = await window.api.openVideo();
    if (f) loadFile(f);
  });
  $('detectBtn').addEventListener('click', runDetect);
  $('calibrateBtn').addEventListener('click', runCalibrate);
  $('cutPointsBtn').addEventListener('click', saveCutPoints);
  $('overlayAbort').addEventListener('click', async () => {
    const b = $('overlayAbort');
    b.disabled = true;                 // killing is quick, but do not queue clicks
    b.textContent = 'Stopping…';
    try { await window.api.abortJob(); } catch (_) { /* job already finished */ }
  });
  $('sampleBtn').addEventListener('click', runSample);
  $('exportBtn').addEventListener('click', runExport);
  $('previewSampleBtn').addEventListener('click', renderSamplePreview);
  $('exitPreviewBtn').addEventListener('click', exitSamplePreview);

  $('folderBtn').addEventListener('click', async () => {
    const d = await window.api.openFolder();
    if (d) { state.outputDir = d; $('outputDir').value = d; }
  });

  // zoom controls
  $('zoomIn').addEventListener('click', () => zoomByButton(1.5));
  $('zoomOut').addEventListener('click', () => zoomByButton(1 / 1.5));
  $('zoomFit').addEventListener('click', () => zoomAround(1, 0, 0));
  $('zoomSlider').addEventListener('input', (e) => zoomFromSlider(parseFloat(e.target.value)));
  $('timelineScroll').addEventListener('scroll', updateMinimapWindow);

  // minimap drag-to-pan
  let mmDragging = false;
  const mm = $('minimap');
  mm.addEventListener('pointerdown', (e) => {
    mmDragging = true; mm.setPointerCapture(e.pointerId); minimapPanTo(e.clientX);
  });
  mm.addEventListener('pointermove', (e) => { if (mmDragging) minimapPanTo(e.clientX); });
  mm.addEventListener('pointerup', () => { mmDragging = false; });

  $('timelineScroll').addEventListener('wheel', (e) => {
    const scroll = $('timelineScroll');
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = scroll.getBoundingClientRect();
      const viewportX = e.clientX - rect.left;
      const ratio = (scroll.scrollLeft + viewportX) / scroll.scrollWidth;
      zoomAround(state.zoom * (e.deltaY < 0 ? 1.25 : 0.8), ratio, viewportX);
    } else if (state.zoom > 1) {
      e.preventDefault();
      scroll.scrollLeft += (e.deltaY || e.deltaX);
    }
  }, { passive: false });

  $('keepAllBtn').addEventListener('click', () => {
    if (!state.segments.length) return;
    pushHistory();
    state.segments.forEach((s) => (s.keep = true));
    refreshSegments();
  });
  $('invertBtn').addEventListener('click', () => {
    if (!state.segments.length) return;
    pushHistory();
    state.segments.forEach((s) => (s.keep = !s.keep));
    refreshSegments();
  });
  $('undoBtn').addEventListener('click', undoEdit);
  $('redoBtn').addEventListener('click', redoEdit);

  // manual clip editing
  $('splitBtn').addEventListener('click', splitAtPlayhead);
  $('mergePrevBtn').addEventListener('click', () => mergeWithNeighbor(-1));
  $('mergeNextBtn').addEventListener('click', () => mergeWithNeighbor(1));
  $('inBtn').addEventListener('click', setInPoint);
  $('outBtn').addEventListener('click', setOutPoint);

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (helpModalOpen() || settingsOpen()) return;
    if (!state.filePath) return;
    // Undo/redo sit outside the profiles — Ctrl+Z and Ctrl+Y mean the same
    // thing in both, and everywhere else. Other Ctrl combos are left alone so
    // the browser shortcuts underneath still work.
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoEdit(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redoEdit(); }
      return;
    }
    const action = activeKeymap().keys[e.key.toLowerCase()];
    const run = KEY_ACTIONS[action];
    if (run) run(e, $('player'));
  });

  // color toggle
  const colorEnabled = $('colorEnabled');
  const colorControls = $('colorControls');
  const syncColor = () => { colorControls.classList.toggle('off', !colorEnabled.checked); applyLiveColor(); };
  colorEnabled.addEventListener('change', syncColor); syncColor();
  ['brightness', 'contrast', 'saturation', 'gamma', 'rgbR', 'rgbG', 'rgbB'].forEach((id) =>
    $(id).addEventListener('input', applyLiveColor));
  // Denoise/sharpen are previewed too, scaled for the smaller frame, so the
  // Enhance picker has to re-run the chain like the sliders do.
  $('enhancePreset').addEventListener('change', applyLiveColor);
  // previewScale() needs videoHeight, which is only known once metadata lands.
  $('player').addEventListener('loadedmetadata', applyLiveColor);
  $('audioDrift').addEventListener('input', applyLiveAudio);

  document.querySelectorAll('input[name=mode]').forEach((r) =>
    r.addEventListener('change', updateExportSummary));
  ['exportTarget', 'exportFrame', 'exportQuality'].forEach((id) =>
    $(id).addEventListener('change', updateExportSummary));
  $('exportName').addEventListener('input', updateExportSummary);

  bindSlider('blackThreshold', 'blackOut', (v) => (+v).toFixed(2));
  bindSlider('silenceDb', 'silenceOut', (v) => `${v} dB`);
  bindSlider('minCommercial', 'minCommercialOut', (v) => `${v} s`);
  bindSlider('maxCommercial', 'maxCommercialOut', (v) => `${(v / 60).toFixed(1)} min`);

  $('detectPreset').addEventListener('change', () => {
    applyDetectPreset($('detectPreset').value);
    saveDetectSettings();
  });
  DETECT_SLIDERS.forEach((id) => {
    // Touching a slider by hand means you're no longer on a preset. Guarded so
    // the preset applying itself doesn't immediately flip the label to Custom.
    $(id).addEventListener('input', () => {
      if (!applyingPreset) $('detectPreset').value = 'custom';
    });
    // Persist on 'change' rather than 'input' — 'input' fires continuously
    // while dragging and would hammer the settings file.
    $(id).addEventListener('change', saveDetectSettings);
  });
  bindSlider('brightness', 'brightnessOut', (v) => (+v).toFixed(2));
  bindSlider('contrast', 'contrastOut', (v) => (+v).toFixed(2));
  bindSlider('saturation', 'saturationOut', (v) => (+v).toFixed(2));
  bindSlider('gamma', 'gammaOut', (v) => (+v).toFixed(2));
  bindSlider('rgbR', 'rgbROut', (v) => (+v).toFixed(2));
  bindSlider('rgbG', 'rgbGOut', (v) => (+v).toFixed(2));
  bindSlider('rgbB', 'rgbBOut', (v) => (+v).toFixed(2));
  bindSlider('audioDrift', 'driftOut', (v) => `${v} ms`);

  // player playhead
  const player = $('player');
  player.addEventListener('timeupdate', updatePlayhead);
  player.addEventListener('loadedmetadata', () => {
    if (!state.duration && player.duration) { state.duration = player.duration; renderTimeline(); }
  });

  // progress from main
  window.api.onDetectProgress((p) => setBar(p));
  window.api.onExportProgress((p) => setBar(p));
  window.api.onExportStatus((s) => { $('overlayStatus').textContent = s; });
  window.api.onProxyProgress((p) => setProxyStatus(`Building preview ${Math.round(p * 100)}%`, { spinning: true, progress: p, abortable: true }));
  $('proxyAbort').addEventListener('click', async () => {
    const b = $('proxyAbort');
    b.disabled = true;
    b.textContent = 'Stopping…';
    try { await window.api.abortJob(); } catch (_) { /* already finished */ }
  });

  // drag & drop
  const wrap = document.querySelector('.player-wrap');
  ['dragenter', 'dragover'].forEach((ev) =>
    wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.remove('dragover'); }));
  wrap.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const p = window.api.pathForFile(f);
    if (p) loadFile(p);
  });

  // show ffmpeg source in title tooltip
  window.api.ffmpegPaths().then((p) => {
    document.title = 'VHS Commercial Cutter';
    $('fileLabel').title = `ffmpeg: ${p.ffmpeg}`;
  });
}

init();
