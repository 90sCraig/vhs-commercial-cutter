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
function setProxyStatus(text, { spinning = false, ready = false, progress = null } = {}) {
  const el = $('proxyStatus');
  if (!text) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.classList.toggle('spinning', spinning);
  el.classList.toggle('ready', ready);
  $('proxyStatusText').textContent = text;
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
  setProxyStatus('Preparing preview…', { spinning: true });
  try {
    const res = await window.api.buildProxy(filePath, state.duration);
    if (state.filePath !== filePath) return; // user switched files meanwhile
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
    setProxyStatus('Preview unavailable — using original', {});
  }
}

// ---- detection --------------------------------------------------------
function detectOpts() {
  return {
    blackThreshold: parseFloat($('blackThreshold').value),
    silenceDb: parseInt($('silenceDb').value, 10),
    minCommercialLen: parseInt($('minCommercial').value, 10),
    maxCommercialLen: parseInt($('maxCommercial').value, 10),
  };
}

async function runDetect() {
  if (!state.filePath) return;
  showOverlay('Detecting commercials…', 'Scanning for black + silence boundaries');
  setBar(0);
  try {
    const res = await window.api.detect(state.filePath, detectOpts());
    state.segments = res.segments;
    state.duration = res.duration || state.duration;
    const cut = res.segments.filter((s) => !s.keep).length;
    $('detectStats').textContent =
      `${res.segments.length} segments · ${res.stats.confidentBoundaries} strong boundaries · ` +
      `${res.stats.blackEvents} black / ${res.stats.silenceEvents} silence events`;
    renderTimeline();
    renderSegmentList();
    updateExportSummary();
    $('exportBtn').disabled = false;
    toast(`Found ${res.segments.length} segments — ${cut} guessed as commercials to cut.`);
  } catch (e) {
    toast('Detection failed: ' + e.message, true);
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
    el.style.flexGrow = String(Math.max(0.0001, seg.duration));
    el.style.flexBasis = '0';
    if (state.selected === seg.id) el.classList.add('selected');
    el.title = `${fmtTime(seg.start)}–${fmtTime(seg.end)} (${fmtDur(seg.duration)}) · ${seg.keep ? 'keep' : 'cut'}`;
    el.addEventListener('click', () => selectSegment(seg.id, { seek: true }));
    el.addEventListener('dblclick', () => toggleSegment(seg.id));
    tl.appendChild(el);
  }
  // Draggable handles at each internal boundary (segments are contiguous).
  for (let i = 0; i < state.segments.length - 1; i++) {
    const bTime = state.segments[i].end;
    const h = document.createElement('div');
    h.className = 'bhandle';
    h.style.left = (bTime / dur * 100) + '%';
    h.title = `Boundary at ${fmtTime(bTime)} — drag to adjust`;
    h.addEventListener('pointerdown', (e) => startBoundaryDrag(e, i));
    tl.appendChild(h);
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
  for (const seg of state.segments) {
    const el = document.createElement('div');
    el.className = 'mseg ' + segClass(seg);
    el.style.flexGrow = String(Math.max(0.0001, seg.duration));
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
  const keep = state.segments.filter((s) => s.keep).length;
  $('segCount').textContent = `${state.segments.length} segments · ${keep} kept`;
  list.innerHTML = '';
  state.segments.forEach((seg, idx) => {
    const row = document.createElement('div');
    row.className = 'seg-row' + (state.selected === seg.id ? ' selected' : '');
    row.innerHTML = `
      <span class="seg-dot ${segClass(seg)}"></span>
      <span class="seg-time">${String(idx + 1).padStart(2, '0')} · ${fmtTime(seg.start)} → ${fmtTime(seg.end)}</span>
      <span class="seg-dur">${fmtDur(seg.duration)}</span>
      <span class="seg-tag ${segClass(seg)}">${seg.keep ? 'keep' : 'cut'}</span>`;
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
  if (seg) {
    const p = $('player');
    if (play) previewSegment(seg);
    else if (seek) { state.previewEnd = null; fastSeekTo(p, seg.start + 0.03); }
  }
  renderTimeline();
  renderSegmentList();
  if (seg) scrollSegIntoView(seg);
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
function exportMode() {
  return document.querySelector('input[name=mode]:checked').value;
}
function exportTarget() { return $('exportTarget').value; } // 'keep' | 'cut'

// Apply a one-click export preset, then reflect it in the controls.
function applyPreset(name) {
  const setMode = (v) => { document.querySelector(`input[name=mode][value=${v}]`).checked = true; };
  if (name === 'social') {
    $('exportTarget').value = 'cut';
    $('exportFrame').value = '9:16';
    $('exportFill').value = 'blur';
    setMode('split');
  } else if (name === 'clean') {
    $('exportTarget').value = 'keep';
    $('exportFrame').value = 'source';
    setMode('merged');
  }
  syncFrameFields();
  $('presetSocial').classList.toggle('active', name === 'social');
  $('presetClean').classList.toggle('active', name === 'clean');
  updateExportSummary();
}
function exportLayout() {
  return {
    frame: $('exportFrame').value,
    fill: $('exportFill').value,
    resolution: $('exportResolution').value,
  };
}
function exportQuality() { return $('exportQuality').value; }
function exportFps() { return $('exportFps').value; }
function exportBaseName() {
  const v = $('exportName').value.trim();
  return v ? v.replace(/[\\/:*?"<>|]/g, '_') : baseName(state.filePath);
}
// Keep the Resolution field (source-frame only) and Fill field (reframe only)
// in sync with the chosen Frame.
function syncFrameFields() {
  const src = $('exportFrame').value === 'source';
  $('fillField').style.display = src ? 'none' : '';
  $('resolutionField').style.display = src ? '' : 'none';
}

const FRAME_LABELS = {
  source: 'source frame',
  '9:16': 'vertical 9:16 (1080×1920)',
  '4:5': 'portrait 4:5 (1080×1350)',
  '1:1': 'square 1:1 (1080×1080)',
};

function updateExportSummary() {
  const target = exportTarget();
  const chosen = state.segments.filter((s) => (target === 'cut' ? !s.keep : s.keep));
  const noun = target === 'cut' ? 'commercial' : 'kept';
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
  const fps = exportFps();
  const bits = [`${qLabel} quality`];
  if (layout.frame === 'source' && layout.resolution !== 'source') bits.push(`${layout.resolution}p`);
  if (fps !== 'source') bits.push(`${fps} fps`);
  $('exportSummary').innerHTML =
    `Exporting <b>${chosen.length}</b> ${noun} clip(s) · ${fmtTime(total)}${frameNote}<br>` +
    (mode === 'merged' ? 'Output: one merged file' : `Output: ${chosen.length} separate clips`) +
    `<br><span class="muted">${bits.join(' · ')}</span>`;
  $('exportBtn').disabled = false;
}

async function runExport() {
  const target = exportTarget();
  const chosen = state.segments.filter((s) => (target === 'cut' ? !s.keep : s.keep));
  if (chosen.length === 0) {
    return toast(`No ${target === 'cut' ? 'commercial (cut)' : 'kept'} clips to export.`, true);
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
    fps: exportFps(),
    audioDriftMs: parseInt($('audioDrift').value, 10),
    outputDir,
    baseName: exportBaseName(),
  };
  showOverlay('Exporting…', 'Preparing');
  setBar(0);
  try {
    const res = await window.api.export(payload);
    hideOverlay();
    toast(`Exported ${res.outputs.length} file(s) to ${outputDir}`);
    if (res.outputs[0]) window.api.showItem(res.outputs[0]);
  } catch (e) {
    hideOverlay();
    toast('Export failed: ' + e.message, true);
  }
}

// ---- overlay ----------------------------------------------------------
function showOverlay(title, status) {
  $('overlayTitle').textContent = title;
  $('overlayStatus').textContent = status || '';
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
  $('setCap').value = state.settings.proxyCacheCapGB;
  $('setCapOut').textContent = state.settings.proxyCacheCapGB + ' GB';
  $('setEncoder').value = state.settings.encoder;

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsDone').addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });

  $('setProxyEnabled').addEventListener('change', async () => {
    state.settings = await window.api.setSettings({ proxyEnabled: $('setProxyEnabled').checked });
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

function init() {
  initHelp();
  initSettings();
  $('openBtn').addEventListener('click', async () => {
    const f = await window.api.openVideo();
    if (f) loadFile(f);
  });
  $('detectBtn').addEventListener('click', runDetect);
  $('exportBtn').addEventListener('click', runExport);

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
  const syncColor = () => colorControls.classList.toggle('off', !colorEnabled.checked);
  colorEnabled.addEventListener('change', syncColor); syncColor();

  const clearPresetChips = () => {
    $('presetSocial').classList.remove('active');
    $('presetClean').classList.remove('active');
  };
  document.querySelectorAll('input[name=mode]').forEach((r) =>
    r.addEventListener('change', () => { clearPresetChips(); updateExportSummary(); }));
  $('exportTarget').addEventListener('change', () => { clearPresetChips(); updateExportSummary(); });
  $('exportFill').addEventListener('change', () => { clearPresetChips(); updateExportSummary(); });
  $('exportFrame').addEventListener('change', () => {
    clearPresetChips();
    syncFrameFields();
    updateExportSummary();
  });
  ['exportResolution', 'exportFps', 'exportQuality'].forEach((id) =>
    $(id).addEventListener('change', () => { clearPresetChips(); updateExportSummary(); }));
  $('exportName').addEventListener('input', updateExportSummary);

  // one-click export presets
  $('presetSocial').addEventListener('click', () => applyPreset('social'));
  $('presetClean').addEventListener('click', () => applyPreset('clean'));

  bindSlider('blackThreshold', 'blackOut', (v) => (+v).toFixed(2));
  bindSlider('silenceDb', 'silenceOut', (v) => `${v} dB`);
  bindSlider('minCommercial', 'minCommercialOut', (v) => `${v} s`);
  bindSlider('maxCommercial', 'maxCommercialOut', (v) => `${(v / 60).toFixed(1)} min`);
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
  window.api.onProxyProgress((p) => setProxyStatus(`Building preview ${Math.round(p * 100)}%`, { spinning: true, progress: p }));

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
    document.title = '90s Craig Edit Booth';
    $('fileLabel').title = `ffmpeg: ${p.ffmpeg}`;
  });
}

init();
