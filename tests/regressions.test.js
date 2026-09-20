const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ff = require('../src/ffmpeg');

const root = path.resolve(__dirname, '..');

function renderer() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '0', checked: false, style: {}, currentTime: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return true; } },
      addEventListener() {}, removeEventListener() {}, pause() {}, focus() {}, dispatchEvent() {},
      querySelector: () => null, querySelectorAll: () => [],
      play: () => Promise.resolve(),
    });
    return elements.get(id);
  };
  const calls = [];
  const api = {
    probe: async () => ({ duration: 300, fps: 30, width: 640 }),
    loadSession: async () => null, saveSession: () => ({ ok: true }),
    confirmReplaceCuts: async () => true,
    renderPreview: async (payload) => { calls.push(payload); return 'C:/sample.mp4'; },
  };
  const context = vm.createContext({
    document: {
      getElementById: get, querySelector: () => get("query"),
      createElement: () => ({ appendChild() {}, insertBefore() {} }),
      documentElement: { dataset: {} },
    },
    window: { api, matchMedia: () => ({ matches: false, addEventListener() {} }) }, Event: class {},
    setTimeout: () => 0, clearTimeout() {},
  });
  const run = (code) => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(root, 'renderer/renderer.js'), 'utf8').replace(/init\(\);\s*$/, ''));
  run(`clearHistory = resetTearNotice = buildProxyFor = renderTimeline =
    renderSegmentList = updateExportSummary = applyLiveColor = () => {};
    colorSettings = () => ({ enabled: false }); exportQuality = () => 'high'; exportMode = () => 'merged';`);
  return { run, get, calls, api };
}

test('new tape exits its sample to the new original before a proxy is ready', async () => {
  const r = renderer();
  await r.run(`(async () => {
    state.proxyPath = 'C:/old-proxy.mp4';
    await loadFile('C:/new-tape.mp4');
    await renderSamplePreview();
    exitSamplePreview();
  })()`);
  assert.equal(r.get('player').src, 'file:///C:/new-tape.mp4');
});

test('repeated samples retain source position and bypass live audio delay', async () => {
  const r = renderer();
  await r.run(`(async () => {
    state.filePath = 'C:/tape.mp4'; state.duration = 300; $('player').currentTime = 120;
    $('audioDrift').value = '250';
    audioGraph = { ctx: { state: 'running' }, delay: { delayTime: { value: 0.25 } } };
    await renderSamplePreview();
  })()`);
  assert.equal(r.run('audioGraph.delay.delayTime.value'), 0);
  await r.run(`$('player').currentTime = 3; renderSamplePreview()`);
  assert.deepEqual(r.calls.map((c) => c.start), [120, 120]);
  assert.deepEqual(r.calls.map((c) => c.audioDriftMs), [250, 250]);
  r.run('applyLiveAudio()');
  assert.equal(r.run('audioGraph.delay.delayTime.value'), 0);
  r.run('exitSamplePreview()');
  assert.equal(r.run('audioGraph.delay.delayTime.value'), 0.25);
});

test('a sample finishing after switching tapes cannot replace the new player', async () => {
  const r = renderer();
  let finish;
  r.api.renderPreview = () => new Promise((resolve) => { finish = resolve; });
  const pending = r.run(`state.filePath = 'C:/old.mp4'; renderSamplePreview()`);
  await r.run(`loadFile('C:/new.mp4')`);
  finish('C:/old-sample.mp4');
  await pending;
  assert.equal(r.get('player').src, 'file:///C:/new.mp4');
  assert.equal(r.run('state.inSamplePreview'), false);
});

test('manual cutting works immediately after opening a tape', async () => {
  const r = renderer();
  await r.run(`loadFile('C:/tape.mp4')`);
  r.get('player').currentTime = 20;
  r.run('splitAtPlayhead()');
  assert.equal(r.run('state.segments.length'), 2);
  assert.equal(r.run('state.segments[0].end'), 20);
});

test('splitting a processed sample cuts at its source position', async () => {
  const r = renderer();
  await r.run(`loadFile('C:/tape.mp4')`);
  r.run(`state.inSamplePreview = true; state.previewReturnTime = 20; $('player').currentTime = 3; splitAtPlayhead()`);
  assert.equal(r.run('state.segments[0].end'), 23);
  assert.equal(r.run('state.inSamplePreview'), false);
  assert.equal(r.get('player').src, 'file:///C:/tape.mp4');
  assert.equal(r.run('sourceTime()'), 23);
});

test('failed autosave blocks file switching and keeps current edits', async () => {
  const r = renderer();
  await r.run(`loadFile('C:/tape.mp4')`);
  r.get('player').currentTime = 20; r.run('splitAtPlayhead()');
  r.api.saveSession = () => ({ ok: false, error: 'Disk full' });
  assert.equal(await r.run(`loadFile('C:/another.mp4')`), false);
  assert.equal(r.run('state.filePath'), 'C:/tape.mp4');
  assert.equal(r.run('state.segments.length'), 2);
  assert.equal(r.run('state.unsaved'), true);
});

test('new jobs do not inherit cancellation or revive an older cancelled job', async () => {
  let resume;
  const paused = new Promise((resolve) => { resume = resolve; });
  const old = ff.withJob(async () => {
    await paused;
    assert.equal(ff.isCancelled(), true);
    await assert.rejects(ff.runFfmpeg([]), (e) => e.cancelled === true);
  });
  ff.cancelJob();
  await ff.withJob(async () => {
    assert.equal(ff.isCancelled(), false);
    await Promise.resolve();
    assert.equal(ff.isCancelled(), false);
  });
  resume();
  await old;
});

// Exercise the real export orchestration and filesystem with an encoder stub,
// so these safety checks run without Electron, FFmpeg or a graphics card.
function exporter(onEncode = () => {}) {
  const filename = path.join(root, 'src/export.js');
  const localRequire = createRequire(filename);
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process, require: (name) => name === './ffmpeg' ? {
      tmpDir: os.tmpdir(), ffprobeInfo: async () => ({ duration: 10 }),
      runFfmpeg: async (args) => {
        calls.push(args);
        fs.writeFileSync(args.at(-1), 'encoded video');
        onEncode(args);
      },
    } : localRequire(name),
  }, { filename });
  return { exportVideo: module.exports.exportVideo, calls };
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhs-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'tape_commercials.mp4');
  fs.writeFileSync(input, 'original capture');
  return { input, outputDir: dir, baseName: 'tape', mode: 'merged',
    segments: [{ start: 0, end: 1, keep: true }, { start: 2, end: 3, keep: true }] };
}

test('source collision is rejected before any encoding', async (t) => {
  const options = fixture(t), exp = exporter();
  await assert.rejects(exp.exportVideo(options), /File already exists/);
  assert.equal(fs.readFileSync(options.input, 'utf8'), 'original capture');
  assert.equal(exp.calls.length, 0);
});

test('all split destinations are checked before writing the first clip', async (t) => {
  const options = { ...fixture(t), mode: 'split' }, exp = exporter();
  const existing = path.join(options.outputDir, 'tape_clip02.mp4');
  fs.writeFileSync(existing, 'previous export');
  await assert.rejects(exp.exportVideo(options), /File already exists/);
  assert.equal(exp.calls.length, 0);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'previous export');
});

for (const mode of ['merged', 'split']) {
  test(`${mode} export preserves a destination created during rendering`, async (t) => {
    const options = { ...fixture(t), baseName: 'result', mode };
    const destination = path.join(options.outputDir,
      mode === 'merged' ? 'result_commercials.mp4' : 'result_clip01.mp4');
    const exp = exporter(() => fs.writeFileSync(destination, 'another file'));
    await assert.rejects(exp.exportVideo(options), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(destination, 'utf8'), 'another file');
    assert.equal(fs.readFileSync(options.input, 'utf8'), 'original capture');
    assert.equal(fs.readdirSync(options.outputDir).some((f) => f.startsWith('.vhs-export-')), false);
  });

  test(`${mode} export publishes completed clips and removes staging`, async (t) => {
    const options = { ...fixture(t), baseName: 'result', mode };
    const result = await exporter().exportVideo(options);
    assert.equal(result.outputs.length, mode === 'split' ? 2 : 1);
    for (const out of result.outputs) assert.equal(fs.readFileSync(out, 'utf8'), 'encoded video');
    assert.equal(fs.readFileSync(options.input, 'utf8'), 'original capture');
    assert.equal(fs.readdirSync(options.outputDir).some((f) => f.startsWith('.vhs-export-')), false);
  });
}

// Cutting a tape is thousands of these two actions. Both used to go through a
// full rebuild of the timeline, minimap and segment list, which made the app
// slower the longer the tape: about 1.6ms per selection at 8 segments, 20ms at
// 156, 40ms at 300. Neither changes the shape of anything, so neither may
// rebuild. Structural edits -- split, merge, undo, invert -- still must.
test('selecting a clip does not rebuild the timeline or the list', () => {
  const r = renderer();
  r.run(`
    rebuilds = 0;
    renderTimeline = renderSegmentList = renderMinimap = () => { rebuilds++; };
    state.duration = 600;
    state.segments = [
      { id: 1, start: 0, end: 200, duration: 200, keep: true },
      { id: 2, start: 200, end: 400, duration: 200, keep: false },
      { id: 3, start: 400, end: 600, duration: 200, keep: true },
    ];
    state.selected = 1;
    selectSegment(2, {});
    selectSegment(3, {});
  `);
  assert.equal(r.run('state.selected'), 3);
  assert.equal(r.run('rebuilds'), 0);
});

test('flipping save/skip does not rebuild, but still records the edit', () => {
  const r = renderer();
  r.run(`
    rebuilds = 0; saved = 0;
    renderTimeline = renderSegmentList = renderMinimap = () => { rebuilds++; };
    saveEdits = () => { saved++; };
    state.duration = 400; state.hasEdits = false;
    state.segments = [
      { id: 1, start: 0, end: 200, duration: 200, keep: true },
      { id: 2, start: 200, end: 400, duration: 200, keep: false },
    ];
    toggleSegment(1);
  `);
  assert.equal(r.run('state.segments[0].keep'), false, 'the flag still flips');
  assert.equal(r.run('rebuilds'), 0, 'without a rebuild');
  assert.equal(r.run('state.hasEdits'), true, 'and it still counts as an edit');
  assert.equal(r.run('saved'), 1, 'and still autosaves');
});

test('structural edits still rebuild', () => {
  const r = renderer();
  r.run(`
    rebuilds = 0;
    renderTimeline = renderSegmentList = () => { rebuilds++; };
    state.duration = 400;
    state.segments = [
      { id: 1, start: 0, end: 200, duration: 200, keep: true },
      { id: 2, start: 200, end: 400, duration: 200, keep: false },
    ];
    history.past = []; history.future = [];
    toggleSegment(1);
    const afterToggle = rebuilds;
    undoEdit();
    result = { afterToggle, afterUndo: rebuilds };
  `);
  const out = r.run('result');
  assert.equal(out.afterToggle, 0);
  assert.ok(out.afterUndo > 0, 'undo has to repaint everything it restored');
});
