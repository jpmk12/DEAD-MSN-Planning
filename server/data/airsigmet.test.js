import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordsToPolygon, hazardLabel, mapAwcAirSigmet, mapAirSigmets } from './airsigmet.js';

test('coordsToPolygon converts {lat,lon} list to [lat,lon] points', () => {
  const g = coordsToPolygon([{ lat: 33, lon: -80 }, { lat: 34, lon: -79 }]);
  assert.equal(g.kind, 'polygon');
  assert.deepEqual(g.points, [[33, -80], [34, -79]]);
});

test('coordsToPolygon returns null for too few/invalid points', () => {
  assert.equal(coordsToPolygon([{ lat: 1, lon: 2 }]), null);
  assert.equal(coordsToPolygon('nope'), null);
});

test('hazardLabel maps known codes, passes through unknown', () => {
  assert.equal(hazardLabel('CONVECTIVE'), 'Convective (TS)');
  assert.equal(hazardLabel('ICE'), 'Icing');
  assert.equal(hazardLabel('ZZZ'), 'ZZZ');
});

test('mapAwcAirSigmet maps fields and parses times/altitudes', () => {
  const m = mapAwcAirSigmet({
    airSigmetId: 'S1', airSigmetType: 'SIGMET', hazard: 'CONVECTIVE', severity: 2,
    altitudeLow1: 0, altitudeHi1: 45000, validTimeFrom: 1780930800, validTimeTo: 1780945200,
    coords: [{ lat: 33, lon: -80 }, { lat: 34, lon: -79 }, { lat: 32, lon: -79 }],
    rawAirSigmet: 'CONVECTIVE SIGMET ...',
  });
  assert.equal(m.type, 'SIGMET');
  assert.equal(m.hazard, 'CONVECTIVE');
  assert.equal(m.label, 'Convective (TS)');
  assert.equal(m.hiFt, 45000);
  assert.match(m.validFrom, /^2026-/);
  assert.equal(m.geometry.kind, 'polygon');
});

test('mapAirSigmets drops records without geometry', () => {
  const out = mapAirSigmets([
    { hazard: 'TURB', coords: [{ lat: 35, lon: -119 }, { lat: 34, lon: -118 }] },
    { hazard: 'IFR', coords: null },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].hazard, 'TURB');
});
