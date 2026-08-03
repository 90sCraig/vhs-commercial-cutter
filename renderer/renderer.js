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
  } catch (e) {
    // Cancelling is a choice, not a failure — say so differently. Either way
    // the player keeps using the full-quality original.
    if (isAbort(e)) setProxyStatus('Preview cancelled — using original', {});
    else setProxyStatus('Preview unavailable — using original', {});
    setTimeout(() => { if (state.filePath === filePath) setProxyStatus(''); }, 4000);
  }
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

async function runDetect() {
  if (!state.filePath) return;
  $('player').pause();  // playback competes with the scan for disk and decode
  state.sampleBoundaries = []; state.sampleRange = null; // clear sample overlay
  showOverlay('Detecting commercials…', 'Scanning for black + silence boundaries');
  setBar(0);
  try {
    const res = await window.api.detect(state.filePath, detectOpts());
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
  seg.keep = !seg.keep;
  refreshSegments();
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
// Live (approximate) color preview on the player via CSS filters. Covers
// brightness/contrast/saturation; gamma/RGB and denoise/sharpen need the
// rendered sample preview to see accurately.
function applyLiveColor() {
  const p = $('player');
  if (state.inSamplePreview) return; // sample already has effects baked in
  const c = colorSettings();
  if (!c.enabled) { p.style.filter = ''; return; }
  const b = (1 + (c.brightness || 0)).toFixed(3);
  const con = (c.contrast || 1).toFixed(3);
  const sat = (c.saturation || 1).toFixed(3);
  p.style.filter = `brightness(${b}) contrast(${con}) saturate(${sat})`;
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
      filePath: state.filePath,
      start,
      duration: 6,
      correction: colorSettings(),
      enhance: $('enhancePreset').value,
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
  if (chosen.length === 0) {
    $('exportSummary').textContent = state.segments.length ? `No ${noun} clips selected.` : '';
    $('exportBtn').disabled = chosen.length === 0;
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
  applySavedDetect();
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
    state.segments.forEach((s) => (s.keep = true));
    refreshSegments();
  });
  $('invertBtn').addEventListener('click', () => {
    state.segments.forEach((s) => (s.keep = !s.keep));
    refreshSegments();
  });

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
    const p = $('player');
    switch (e.key) {
      case ' ': e.preventDefault(); if (p.paused) p.play().catch(() => {}); else p.pause(); break;
      case 'ArrowLeft': e.preventDefault(); stepFrame(-1, e.shiftKey); break;
      case 'ArrowRight': e.preventDefault(); stepFrame(1, e.shiftKey); break;
      case 'Home': e.preventDefault(); state.previewEnd = null; p.currentTime = 0; break;
      case 'End': e.preventDefault(); state.previewEnd = null; p.currentTime = Math.max(0, state.duration - 0.1); break;
      case 's': case 'S': splitAtPlayhead(); break;
      case 'm': case 'M': mergeWithNeighbor(e.shiftKey ? 1 : -1); break;
      case 'i': case 'I': setInPoint(); break;
      case 'o': case 'O': setOutPoint(); break;
      case 'k': case 'K': if (state.selected != null) toggleSegment(state.selected); break;
      default: break;
    }
  });

  // color toggle
  const colorEnabled = $('colorEnabled');
  const colorControls = $('colorControls');
  const syncColor = () => { colorControls.classList.toggle('off', !colorEnabled.checked); applyLiveColor(); };
  colorEnabled.addEventListener('change', syncColor); syncColor();
  ['brightness', 'contrast', 'saturation', 'gamma', 'rgbR', 'rgbG', 'rgbB'].forEach((id) =>
    $(id).addEventListener('input', applyLiveColor));

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
