import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gairmetHazard, mapGairmet, mapGairmets, fetchGairmets } from './gairmet.js';

test('gairmetHazard normalizes codes to a hazard + friendly label', () => {
  assert.deepEqual(gairmetHazard('TURB-LO'), { hazard: 'TURB', label: 'Turbulence (low)' });
  assert.deepEqual(gairmetHazard('ICE'), { hazard: 'ICE', label: 'Icing' });
  assert.deepEqual(gairmetHazard('LLWS'), { hazard: 'LLWS', label: 'Low-level wind shear' });
  assert.deepEqual(gairmetHazard('MT_OBSC'), { hazard: 'MTN OBSCN', label: 'Mtn obscuration' });
  assert.equal(gairmetHazard('FZLVL').hazard, 'FZLVL');
});

test('mapGairmet parses geometry, altitudes (FL/SFC strings), and valid time', () => {
  const g = mapGairmet({
    gairmetId: 'GA-1', hazard: 'TURB-LO', forecast: 3, base: 'SFC', top: 'FL180',
    validTime: '2026-06-13T18:00:00Z', dueTo: 'WIND',
    coords: [{ lat: 35, lon: -100 }, { lat: 34, lon: -99 }, { lat: 34, lon: -101 }],
  });
  assert.equal(g.type, 'G-AIRMET');
  assert.equal(g.hazard, 'TURB');
  assert.equal(g.lowFt, 0);       // SFC -> 0
  assert.equal(g.hiFt, 18000);    // FL180 -> 18000
  assert.equal(g.forecastHr, 3);
  assert.equal(g.geometry.kind, 'polygon');
  assert.match(g.raw, /due to WIND/);
  // No geometry -> null (never a phantom hazard).
  assert.equal(mapGairmet({ hazard: 'ICE' }), null);
});

test('mapGairmet tolerates alternate field names (altitudeLow1/Hi1, geom)', () => {
  const g = mapGairmet({
    hazard: 'ICING', altitudeLow1: 8000, altitudeHi1: 22000, validTimeTo: 1780945200,
    geom: [{ lat: 36, lon: -101 }, { lat: 36, lon: -99 }, { lat: 34, lon: -100 }],
  });
  assert.equal(g.hazard, 'ICE');
  assert.equal(g.lowFt, 8000);
  assert.equal(g.hiFt, 22000);
});

test('fetchGairmets returns fixture data offline', async () => {
  const { gairmets, live } = await fetchGairmets(true);
  assert.equal(live, false);
  assert.ok(gairmets.length >= 2);
  assert.ok(gairmets.every((g) => g.geometry && g.type === 'G-AIRMET'));
});

test('mapGairmet: real AWC shape — forecastHour + flight-level base/top + tag id', () => {
  const g = mapGairmet({ tag: '4W', forecastHour: 3, hazard: 'TURB-HI', top: '390', base: '180',
    validTime: '2026-06-17T18:00:00.000Z', issueTime: 1781713200,
    coords: [{ lat: '49', lon: '-104' }, { lat: '47', lon: '-101' }, { lat: '46', lon: '-96' }] });
  assert.equal(g.forecastHr, 3);   // forecastHour, not "forecast"
  assert.equal(g.lowFt, 18000);    // FL180 -> 18000 ft (was read as 180)
  assert.equal(g.hiFt, 39000);     // FL390
  assert.equal(g.id, '4W');        // tag fallback
  // SFC base -> 0; FZLVL uses fzlbase/fzltop.
  const t = mapGairmet({ forecastHour: 6, hazard: 'TURB-LO', base: 'SFC', top: '180', coords: [{ lat: '42', lon: '-107' }, { lat: '41', lon: '-104' }] });
  assert.equal(t.lowFt, 0); assert.equal(t.hiFt, 18000);
});
