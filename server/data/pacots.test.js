import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePacPoint, parsePacots, fetchPacots } from './pacots.js';

test('decodePacPoint: E/W longitudes and date-line crossing', () => {
  assert.deepEqual(decodePacPoint('36N140W'), { label: '36N140W', lat: 36, lon: -140 });
  assert.deepEqual(decodePacPoint('29N180E'), { label: '29N180E', lat: 29, lon: 180 });
  assert.deepEqual(decodePacPoint('43N170W'), { label: '43N170W', lat: 43, lon: -170 });
  assert.equal(decodePacPoint('ALCOA').lat, null);    // named fix
  assert.equal(decodePacPoint('OTR11'), null);        // airway -> not a point
  assert.equal(decodePacPoint('OTR5'), null);         // single-trailing-digit airway also excluded
  assert.equal(decodePacPoint('Y891'), null);
  assert.equal(decodePacPoint('R591'), null);
  // Half-degree Pacific coordinate.
  assert.deepEqual(decodePacPoint('3630N14030W'), { label: '3630N14030W', lat: 36.5, lon: -140.5 });
});

test('parsePacots: Oakland TDM TRK and Fukuoka FLEX ROUTE, both with date-line', () => {
  const json = { group: [
    { name: 'KZAK', notams: [{ code: 'KZAK', list: [
      { idshow: 'A2861/26', rawtext: 'B) 2606150500 C) 2606152100 E) (TDM TRK J 260615050001 2606150500 2606152100 ALCOA 36N140W 34N150W 29N180E 28N170E CANAI RTS/KSFO ALCOA RMK/0)' },
    ] }] },
    { name: 'RJJJ', notams: [{ code: 'RJJJ', list: [
      { idshow: 'Q1403/26', rawtext: 'A)RJJJ B)2606150700 C)2606152100 E)EASTBOUND PACOTS TRACKS BETWEEN JAPAN AND NORTH AMERICA, TRACK 1. FLEX ROUTE : KALNA 41N160E 41N180E 43N170W 49N140W PRETY JAPAN ROUTE : ADNAP OTR5 KALNA RMK : ATM CENTER' },
    ] }] },
  ] };
  const tracks = parsePacots(json);
  const j = tracks.find((t) => t.id === 'J');
  assert.equal(j.fir, 'KZAK');
  assert.deepEqual(j.points, [[36, -140], [34, -150], [29, 180], [28, 170]]); // 180E positive, 140W negative
  assert.equal(j.validFrom, '2026-06-15T05:00:00.000Z');
  const one = tracks.find((t) => t.id === '1');
  assert.equal(one.fir, 'RJJJ');
  assert.equal(one.direction, 'EAST');
  assert.deepEqual(one.points, [[41, 160], [41, 180], [43, -170], [49, -140]]); // E->W crossing
  // FLEX captured only the flex waypoints, not the JAPAN ROUTE airways.
  assert.ok(!one.pointsRaw.includes('OTR5'));
});

test('parsePacots: dedupes a track by FIR+id+direction, keeping the later-valid NOTAM', () => {
  const mk = (b, lonTag) => ({ idshow: 'x', rawtext: `B)${b} C)2606152100 E)EASTBOUND TRACK 1. FLEX ROUTE : KALNA 41N160E ${lonTag} PRETY RMK : x` });
  const json = { group: [{ name: 'RJJJ', notams: [{ code: 'RJJJ', list: [
    mk('2606140700', '43N170W'),  // yesterday
    mk('2606150700', '44N170W'),  // today (later) -> wins
  ] }] }] };
  const tracks = parsePacots(json);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].validFrom, '2026-06-15T07:00:00.000Z');
  assert.deepEqual(tracks[0].points[1], [44, -170]);
});

test('fetchPacots: offline / no DoD CA -> empty, not fabricated', async () => {
  const r = await fetchPacots(true);
  assert.equal(r.live, false);
  assert.deepEqual(r.tracks, []);
});
