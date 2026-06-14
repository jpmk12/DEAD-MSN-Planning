import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeNatPoint, parseNatTracks, fetchNatTracks } from './nattracks.js';

test('decodeNatPoint: lat/lon shorthand (N/W) and named fixes', () => {
  assert.deepEqual(decodeNatPoint('55/20'), { label: '55/20', lat: 55, lon: -20 });
  assert.deepEqual(decodeNatPoint('57/40'), { label: '57/40', lat: 57, lon: -40 });
  assert.deepEqual(decodeNatPoint('55N020W'), { label: '55N020W', lat: 55, lon: -20 });
  assert.equal(decodeNatPoint('RESNO').lat, null);   // named fix -> label only
  assert.equal(decodeNatPoint('RESNO').label, 'RESNO');
  assert.equal(decodeNatPoint('!!'), null);          // unrecognized
});

test('parseNatTracks: tracks, decoded geometry, and level bands', () => {
  const tracks = parseNatTracks([
    'A DINIM 56/20 57/30 58/40 HOIST',
    'EAST LVLS NIL WEST LVLS 350 360 370',
    'B RESNO 55/20 56/30 RODBO',
    'EAST LVLS NIL WEST LVLS 340 350',
  ].join('\n'));
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].id, 'A');
  assert.deepEqual(tracks[0].pointsRaw, ['DINIM', '56/20', '57/30', '58/40', 'HOIST']);
  assert.deepEqual(tracks[0].points, [[56, -20], [57, -30], [58, -40]]); // named fixes excluded from geometry
  assert.equal(tracks[0].geometry.kind, 'line');
  assert.deepEqual(tracks[0].westLevels, [350, 360, 370]);
  assert.deepEqual(tracks[0].eastLevels, []); // NIL
  assert.equal(tracks[1].id, 'B');
});

test('parseNatTracks ignores prose/headers, only real track lines', () => {
  const tracks = parseNatTracks('NAT TRACK MESSAGE TMI 165\nEASTBOUND TRACKS FL310 TO FL390\nEND OF MESSAGE');
  assert.equal(tracks.length, 0);
});

test('fetchNatTracks: offline -> fixture tracks', async () => {
  const { tracks, live, source } = await fetchNatTracks(true);
  assert.equal(live, false);
  assert.equal(source, 'fixture');
  assert.ok(tracks.length >= 3);
  assert.ok(tracks.every((t) => t.id && Array.isArray(t.points)));
});
