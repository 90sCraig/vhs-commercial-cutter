const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sessions = require('../src/sessions');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhs-session-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'capture.mp4');
  fs.writeFileSync(source, 'source capture');
  return { dir: path.join(dir, 'sessions'), source, session: {
    version: 1, duration: 30, selected: 1, position: 23, hasEdits: true,
    segments: [{ id: 0, start: 0, end: 20, keep: false }, { id: 1, start: 20, end: 30, keep: true }],
    controls: { brightness: '0.1', repairTears: true, exportName: 'My clips' }, mode: 'split',
  } };
}
test('cuts, restoration settings and position survive a disk round trip', (t) => {
  const f = fixture(t);
  assert.equal(sessions.load(f.dir, f.source), null);
  sessions.save(f.dir, f.source, f.session);
  const result = sessions.load(f.dir, f.source);
  for (const key of Object.keys(f.session)) assert.deepEqual(result[key], f.session[key]);
  sessions.save(f.dir, f.source, { ...f.session, position: 24 });
  assert.equal(sessions.load(f.dir, f.source).position, 24);
  assert.equal(fs.readdirSync(f.dir).length, 1);
});
test('different or replaced sources never receive another capture’s edits', (t) => {
  const f = fixture(t); sessions.save(f.dir, f.source, f.session);
  const other = path.join(path.dirname(f.source), 'other.mp4');
  fs.writeFileSync(other, 'source capture');
  assert.equal(sessions.load(f.dir, other), null);
  fs.writeFileSync(f.source, 'replaced capture with different content');
  assert.equal(sessions.load(f.dir, f.source), null);
});
test('invalid replacement leaves the previous good session intact', (t) => {
  const f = fixture(t); sessions.save(f.dir, f.source, f.session);
  assert.throws(() => sessions.save(f.dir, f.source, { ...f.session,
    segments: [{ id: 0, start: 20, end: 10, keep: true }] }), /Invalid cut/);
  assert.deepEqual(sessions.load(f.dir, f.source).segments, f.session.segments);
});
test('unwritable storage and corrupt recovery data report failure', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.dir, 'not a directory');
  assert.throws(() => sessions.save(f.dir, f.source, f.session));
  fs.unlinkSync(f.dir);
  sessions.save(f.dir, f.source, f.session);
  fs.writeFileSync(path.join(f.dir, fs.readdirSync(f.dir)[0]), '{broken');
  assert.throws(() => sessions.load(f.dir, f.source));
});
