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
  // Half-degree (DDMM) coordinates: 5730/30 = 57°30'N 030°W, 5630N040W = 56°30'N 040°W.
  assert.deepEqual(decodeNatPoint('5730/30'), { label: '5730/30', lat: 57.5, lon: -30 });
  assert.deepEqual(decodeNatPoint('5630N040W'), { label: '5630N040W', lat: 56.5, lon: -40 });
  // Airways with trailing digits are NOT treated as named fixes.
  assert.equal(decodeNatPoint('OTR5'), null);
  assert.equal(decodeNatPoint('N515A'), null);
});

test('parseNatTracks: half-degree geometry + EAST/WEST direction tag', () => {
  const tracks = parseNatTracks([
    'NAT-1/1 TRACKS FLS 340/400 INCLUSIVE',
    'JUN 15/0100Z TO JUN 15/0800Z',
    'U JOOPY 49/50 50/40 51/30 DOGAL',
    'EAST LVLS 340 350 360 WEST LVLS NIL',
    'C PIKIL 57/20 5730/30 5630/40 NEEKO',
    'EAST LVLS NIL WEST LVLS 340 350',
  ].join('\n'));
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].direction, 'EAST');
  assert.equal(tracks[0].flBand, 'FL340-400');
  assert.equal(tracks[0].validRaw, 'JUN 15/0100Z TO JUN 15/0800Z');
  assert.equal(tracks[1].direction, 'WEST');
  assert.deepEqual(tracks[1].points, [[57, -20], [57.5, -30], [56.5, -40]]); // half-degree decoded
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

import { parseNatJson, parseNatBody } from './nattracks.js';

test('parseNatJson: array with route string, array with points, GeoJSON, unknown', () => {
  const a = parseNatJson([{ id: 'A', route: 'DINIM 56/20 57/30 58/40 HOIST' }]);
  assert.equal(a[0].id, 'A');
  assert.deepEqual(a[0].points, [[56, -20], [57, -30], [58, -40]]);
  const b = parseNatJson({ tracks: [{ trackId: 'B', points: [[55, -20], [56, -30]] }] });
  assert.deepEqual(b[0].points, [[55, -20], [56, -30]]);
  const g = parseNatJson({ type: 'FeatureCollection', features: [
    { properties: { id: 'C' }, geometry: { type: 'LineString', coordinates: [[-20, 55], [-30, 56]] } },
  ] });
  assert.equal(g[0].id, 'C');
  assert.deepEqual(g[0].points, [[55, -20], [56, -30]]); // [lon,lat] -> [lat,lon]
  assert.deepEqual(parseNatJson({ nope: 1 }), []);
});

test('parseNatBody routes JSON vs text', () => {
  assert.equal(parseNatBody('application/json', '[{"id":"A","route":"56/20 57/30"}]')[0].id, 'A');
  assert.equal(parseNatBody('text/plain', 'A 56/20 57/30 HOIST\n')[0].id, 'A');
});
