import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePacotsText, parsePacots, fetchPacots } from './pacots.js';

test('parsePacotsText: track id + waypoints out of free text', () => {
  const tracks = parsePacotsText('1 30/140 32/150 33/160 ELATO\nNARRATIVE LINE IGNORED\n2 28/150 30/160 OTRLG');
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].id, '1');
  assert.deepEqual(tracks[0].points, [[30, -140], [32, -150], [33, -160]]);
  assert.equal(tracks[1].id, '2');
});

test('parsePacots: JSON tracks shape and DAIP NOTAM-style body', () => {
  const direct = parsePacots(JSON.stringify({ tracks: [{ id: '7', route: '30/140 32/150' }] }));
  assert.equal(direct[0].id, '7');
  const daip = parsePacots(JSON.stringify({ group: [{ name: 'PACOTS', notams: [{ list: [{ rawtext: '3 31/140 33/150 ENDPT' }] }] }] }));
  assert.equal(daip[0].id, '3');
  assert.deepEqual(daip[0].points, [[31, -140], [33, -150]]);
});

test('fetchPacots: offline / no DoD CA -> empty, not fabricated', async () => {
  const r = await fetchPacots(true);
  assert.equal(r.live, false);
  assert.deepEqual(r.tracks, []);
});
