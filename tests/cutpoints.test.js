const { test } = require('node:test');
const assert = require('node:assert/strict');
const cutpoints = require('../src/cutpoints');

test('EDL CSV maps source clips onto output time and preserves review evidence', () => {
  const body = cutpoints.csv([
    { start: 10, end: 20, keep: true, classification: 'commercial', reviewStatus: 'approved',
      label: 'Car, sale', startEvidence: 'black + quiet', endEvidence: 'black', notes: 'Clean "tag"' },
    { start: 40, end: 45.5, keep: true, classification: 'commercial', reviewStatus: 'proposed' },
  ], 30);
  const rows = body.split('\n');
  assert.match(rows[0], /output_start_seconds,output_end_seconds,classification,review_status/);
  assert.match(rows[1], /,0\.000,10\.000,commercial,approved,"Car, sale",black \+ quiet,black,"Clean ""tag"""$/);
  assert.match(rows[2], /,10\.000,15\.500,commercial,proposed,/);
});
