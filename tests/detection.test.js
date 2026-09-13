const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Drive public entry points with FFmpeg log events; no production-only exports.
function detector({ duration = 30, events = [], pass } = {}) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/detect.js'), 'utf8'), {
    module, process, require: () => ({
      ffprobeInfo: async () => ({ duration }),
      runFfmpeg: async (args, hooks) => {
        calls.push(args);
        const lines = pass ? await pass(args) : events;
        for (const line of lines) hooks.onLine(line);
      },
    }),
  });
  return { ...module.exports, calls };
}
const black = (start, end) => `black_start:${start} black_end:${end} black_duration:${end - start}`;

for (const duration of [2, 8, 30, 359, 360, 1200]) {
  test(`no breaks: ${duration}s stays intact and skipped`, async () => {
    const result = await detector({ duration }).detect('tape');
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].keep, false);
    assert.equal(result.segments[0].duration, duration);
    assert.equal(result.segments[0].confidentBoundary, false);
  });
}

test('short content stays available between transitions and at both ends', async () => {
  const d = detector({ duration: 30, events: [black(2, 2.5), black(10.5, 11), black(16, 16.5), black(28, 28.5)] });
  const result = await d.detect('tape');
  assert.deepEqual(Array.from(result.segments, s => [s.start, s.end, s.keep]),
    [[0, 2, false], [2.5, 10.5, true], [11, 16, false], [16.5, 28, true], [28.5, 30, false]]);
  assert.equal(result.segments.reduce((sum, s) => sum + s.duration, 0), 28);
  const relaxed = await d.detect('tape', { minCommercialLen: 2 });
  assert.deepEqual(Array.from(relaxed.segments, s => [s.start, s.end]),
    Array.from(result.segments, s => [s.start, s.end]));
  assert.equal(relaxed.segments[2].keep, true);
});

test('sample shares restoration filters, shifts timestamps and clamps to EOF', async () => {
  const d = detector({ events: [black(1, 1.3)] });
  await d.detect('tape', { repairTears: true });
  const sample = await d.detectSample('tape', { repairTears: true }, { start: 20, duration: 60 });
  const filter = args => args[args.indexOf('-vf') + 1];
  assert.equal(filter(d.calls[0]), filter(d.calls[1]));
  assert.match(filter(d.calls[1]), /tmedian/);
  assert.equal(sample.rangeDuration, 10);
  assert.equal(sample.boundaries[0].start, 21);
  const empty = await d.detectSample('tape', {}, { start: 40 });
  assert.equal(empty.rangeDuration, 0);
  assert.equal(empty.boundaries.length, 0);
  assert.equal(d.calls.length, 2);
});

test('cancelled hardware sample does not retry', async () => {
  const d = detector({ pass: () => { throw Object.assign(new Error('Cancelled'), { cancelled: true }); } });
  await assert.rejects(d.detectSample('tape', { hwaccel: 'cuda' }), e => e.cancelled);
  assert.equal(d.calls.length, 1);
});

function ladder(counts, silent = true) {
  return detector({ pass: (args) => {
    const vf = args[args.indexOf('-vf') + 1];
    const threshold = Number(vf.match(/pix_th=([\d.]+)/)[1]);
    const count = counts[threshold] || 0;
    const lines = Array.from({ length: count }, (_, i) => black(1 + i * 2, 1.3 + i * 2));
    return silent ? [...lines, 'silence_start: 0', 'silence_end: 30'] : lines;
  } });
}

test('three fades cannot select an unsupported threshold and erase all detections', async () => {
  const d = ladder({ 0.1: 3, 0.16: 3, 0.22: 3, 0.3: 3 });
  const result = await d.calibrate('tape', { blackThreshold: 0.12 });
  assert.equal(result.inconclusive, true);
  assert.equal(result.threshold, 0.12);
  assert.equal(result.range.duration, 30);
});

test('calibration accepts a supported step or a supported lowest rung', async () => {
  let result = await ladder({ 0.1: 5, 0.16: 5, 0.22: 5, 0.3: 5 }).calibrate('tape');
  assert.equal(result.inconclusive, false);
  assert.equal(result.threshold, 0.1);
  result = await ladder({ 0.06: 5, 0.1: 5, 0.16: 5, 0.22: 5, 0.3: 5 }).calibrate('tape');
  assert.equal(result.inconclusive, false);
  assert.equal(result.threshold, 0.06);
});

test('calibration refuses unsupported silence evidence and empty recordings', async () => {
  const result = await ladder({ 0.1: 10, 0.16: 10, 0.22: 10, 0.3: 10 }, false).calibrate('tape');
  assert.equal(result.inconclusive, true);
  const d = detector({ duration: 0 });
  assert.equal((await d.calibrate('tape')).inconclusive, true);
  assert.equal(d.calls.length, 0);
});
