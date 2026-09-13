// One recoverable edit session per source version. Writes are atomic so a
// crash cannot replace the last good session with half a JSON document.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function identity(source) {
  const resolved = fs.realpathSync(source);
  const st = fs.statSync(resolved);
  return { path: process.platform === 'win32' ? resolved.toLowerCase() : resolved,
    size: st.size, modified: st.mtimeMs };
}
function location(dir, source) {
  const stamp = identity(source);
  const key = crypto.createHash('sha256').update(JSON.stringify(stamp)).digest('hex');
  return { stamp, file: path.join(dir, `${key}.json`) };
}
function validate(session) {
  if (!session || session.version !== 1 || !Number.isFinite(session.duration) || session.duration <= 0
      || !Array.isArray(session.segments) || !session.segments.length || session.segments.length > 10000) {
    throw new Error('Invalid edit session.');
  }
  let end = 0;
  const ids = new Set();
  for (const seg of session.segments) {
    if (!Number.isInteger(seg.id) || ids.has(seg.id) || typeof seg.keep !== 'boolean'
        || !Number.isFinite(seg.start) || !Number.isFinite(seg.end)
        || seg.start < end || seg.end <= seg.start || seg.end > session.duration + 0.1) {
      throw new Error('Invalid cut points in edit session.');
    }
    ids.add(seg.id); end = seg.end;
  }
  return session;
}
function save(dir, source, session) {
  validate(session);
  const { stamp, file } = location(dir, source);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...session, source: stamp }), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
function load(dir, source) {
  const { stamp, file } = location(dir, source);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const session = validate(JSON.parse(text));
  if (JSON.stringify(session.source) !== JSON.stringify(stamp)) throw new Error('The source video has changed.');
  return session;
}
module.exports = { save, load, validate };
