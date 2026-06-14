import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineNm } from '../core/geo.js';
import { distanceToGeometry, nearby, geometryFromGeoJson, geojsonToAirspace } from './airspace.js';
import { extractTimeRanges, raimOutlook } from './raim.js';

const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} ~ ${b}`);

test('haversine: ~1 nm per minute of latitude', () => {
  near(haversineNm(32.0, -80.0, 32.0 + 1 / 60, -80.0), 1.0, 0.02);
});
test('haversine: known KCHS->KEDW distance', () => {
  // Charleston SC to Edwards CA is roughly 1900 nm.
  near(haversineNm(32.8986, -80.0405, 34.9054, -117.8839), 1900, 60);
});

test('distanceToGeometry: 0 when inside a circle', () => {
  const geom = { kind: 'circle', lat: 40.05, lon: -74.6, radiusNm: 30 };
  assert.equal(distanceToGeometry(40.0155, -74.5917, geom), 0); // KWRI inside VIP TFR
});
test('distanceToGeometry: positive gap when outside a circle', () => {
  const geom = { kind: 'circle', lat: 33.4, lon: -80.1, radiusNm: 10 };
  assert.ok(distanceToGeometry(32.8986, -80.0405, geom) > 0);
});
test('distanceToGeometry: polygon uses nearest vertex', () => {
  const geom = { kind: 'polygon', points: [[33, -80], [34, -80], [34, -79]] };
  assert.ok(Number.isFinite(distanceToGeometry(32.9, -80.04, geom)));
});

test('nearby: filters by threshold and sorts by distance', () => {
  const items = [
    { id: 'far', geometry: { kind: 'circle', lat: 50, lon: -120, radiusNm: 1 } },
    { id: 'inside', geometry: { kind: 'circle', lat: 40.05, lon: -74.6, radiusNm: 30 } },
  ];
  const res = nearby(40.0155, -74.5917, items, 100);
  assert.equal(res.length, 1);
  assert.equal(res[0].id, 'inside');
  assert.equal(res[0].distanceNm, 0);
});
test('nearby: returns [] when field has no coordinates', () => {
  assert.deepEqual(nearby(null, null, [{ geometry: { kind: 'circle', lat: 0, lon: 0, radiusNm: 5 } }], 100), []);
});

test('extractTimeRanges: parses Zulu HHMM-HHMM', () => {
  const r = extractTimeRanges('GPS RAIM UNREL 1400-1800 AND 2030-2105');
  assert.deepEqual(r, [{ start: '1400Z', end: '1800Z' }, { start: '2030Z', end: '2105Z' }]);
});

test('raimOutlook: outage when a GPS_RAIM NOTAM exists', () => {
  const out = raimOutlook([
    { id: 'X', category: 'GPS_RAIM', text: 'GPS RAIM UNREL 1400-1800', effectiveStart: '2026-06-04T14:00:00Z', effectiveEnd: '2026-06-04T18:00:00Z' },
  ]);
  assert.equal(out.status, 'PREDICTED OUTAGE');
  assert.equal(out.windows.length, 1);
  assert.deepEqual(out.windows[0].inlineRanges, [{ start: '1400Z', end: '1800Z' }]);
});
test('raimOutlook: clear when no RAIM NOTAMs', () => {
  assert.equal(raimOutlook([{ category: 'TAXIWAY', text: 'TWY A CLSD' }]).status, 'NO PREDICTED OUTAGE');
});
test('raimOutlook: UNKNOWN when the NOTAM source was unavailable (no false "clear")', () => {
  assert.equal(raimOutlook([], false).status, 'UNKNOWN');
  // Even with no RAIM NOTAM, an available feed is genuinely clear.
  assert.equal(raimOutlook([], true).status, 'NO PREDICTED OUTAGE');
});

test('geometryFromGeoJson: polygon flips [lon,lat] -> [lat,lon]', () => {
  const g = geometryFromGeoJson({ type: 'Polygon', coordinates: [[[-80, 33], [-79, 33], [-79, 34], [-80, 33]]] });
  assert.equal(g.kind, 'polygon');
  assert.deepEqual(g.points[0], [33, -80]);
});

test('geometryFromGeoJson: point -> circle', () => {
  const g = geometryFromGeoJson({ type: 'Point', coordinates: [-117.9, 34.9] });
  assert.equal(g.kind, 'circle');
  assert.equal(g.lat, 34.9);
  assert.equal(g.lon, -117.9);
});

test('geojsonToAirspace: maps properties + geometry, drops geometry-less', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { properties: { NAME: 'R-2508', TYPE: 'RESTRICTED' }, geometry: { type: 'Polygon', coordinates: [[[-118, 35], [-117, 35], [-117, 36], [-118, 35]]] } },
      { properties: { NAME: 'no-geom' }, geometry: null },
    ],
  };
  const out = geojsonToAirspace(fc, (p) => ({ name: p.NAME, type: p.TYPE }));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'R-2508');
  assert.equal(out[0].geometry.kind, 'polygon');
});
