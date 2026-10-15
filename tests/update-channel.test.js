const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUpdateChannel,
  applyUpdateChannel,
} = require('../src/update-channel');
const { DEFAULTS } = require('../src/settings');

test('existing installs stay on the stable update channel', () => {
  assert.equal(DEFAULTS.updateChannel, 'stable');
  assert.equal(normalizeUpdateChannel(undefined), 'stable');
  assert.equal(normalizeUpdateChannel('unknown'), 'stable');
});

test('beta enables prereleases without permitting downgrades', () => {
  const updater = { allowPrerelease: false, allowDowngrade: true };
  assert.equal(applyUpdateChannel(updater, 'beta'), 'beta');
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
});

test('stable excludes prereleases without permitting downgrades', () => {
  const updater = { allowPrerelease: true, allowDowngrade: true };
  assert.equal(applyUpdateChannel(updater, 'stable'), 'stable');
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
});
