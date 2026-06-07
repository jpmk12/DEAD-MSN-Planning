import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute } from './route.js';
import { destinationPoint, haversineNm } from './core/geo.js';

test('destinationPoint lands at the requested true bearing and distance', () => {
  const d = destinationPoint(34, -99, 90, 60); // due east, 60 NM
  assert.ok(Math.abs(haversineNm(34, -99, d.lat, d.lon) - 60) < 0.5, 'distance ~60 NM');
  assert.ok(d.lon > -99, 'moved east');
  assert.ok(Math.abs(d.lat - 34) < 0.2, 'stayed near same latitude');
});

test('buildRoute parses lat/long and ignores DCT connectors', async () => {
  const r = await buildRoute('3407N10006W DCT 3500N10100W', true);
  assert.equal(r.points.length, 2);
  assert.equal(r.points[0].kind, 'coord');
  assert.ok(Math.abs(r.points[0].lat - 34.1167) < 0.01);
  assert.ok(Math.abs(r.points[0].lon + 100.1) < 0.01);
  assert.ok(r.totalNm > 0);
  assert.equal(r.geometry.kind, 'line');
});

test('buildRoute resolves a bundled fix and flags airway with bad anchors', async () => {
  const r = await buildRoute('FLOYD J78 FLOYD', true, { lat: 34, lon: -100 });
  assert.ok(r.points.length >= 2, 'FLOYD resolves from bundled NASR fixes');
  // J78 is a known airway, but FLOYD isn't on it -> segment not found.
  assert.ok(r.unresolved.some((u) => u.token === 'J78'));
});

test('buildRoute draws military AR/IR routes from the MTR data', async () => {
  const r = await buildRoute('IR-154', true); // dash-insensitive
  assert.ok(r.geometry.points.length > 2, 'centerline drawn');
  assert.equal(r.unresolved.length, 0);
  assert.ok(r.points.some((p) => p.id === 'IR-154'), 'labeled with the route id');
  // AR312 (no suffix) prefix-matches an AR312H/L track.
  const ar = await buildRoute('AR312', true);
  assert.ok(ar.geometry.points.length >= 2 && ar.unresolved.length === 0);
});

test('buildRoute expands a SID anchored to its departure airport', async () => {
  const r = await buildRoute('KCHS LGRHD3.GIPPL', true, { lat: 32.9, lon: -80 });
  const ids = r.points.map((p) => p.id);
  assert.ok(ids.includes('KCHS') && ids.includes('GIPPL'), 'airport + transition fix drawn');
  assert.equal(r.unresolved.length, 0);
});
