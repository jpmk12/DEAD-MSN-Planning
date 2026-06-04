import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lonToTileX, latToTileY, tileXToLon, tileYToLat, project, fitView } from './projection.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ~ ${b}`);

test('center of the world maps to the middle tile', () => {
  near(lonToTileX(0, 0), 0.5);
  near(latToTileY(0, 0), 0.5);
});

test('lon/lat <-> tile round-trips', () => {
  for (const lon of [-179, -74.6, 0, 12.3, 157]) near(tileXToLon(lonToTileX(lon, 5), 5), lon, 1e-9);
  for (const lat of [-60, -10, 0, 33.5, 60]) near(tileYToLat(latToTileY(lat, 5), 5), lat, 1e-9);
});

test('project gives world pixels (zoom 1 => 512px world)', () => {
  const p = project(0, 0, 1);
  near(p.x, 256);
  near(p.y, 256);
});

test('fitView centers on a single point with a close zoom', () => {
  const v = fitView([{ lat: 32.9, lon: -80.04 }], 600, 360, { singleZoom: 9 });
  near(v.lat, 32.9, 1e-9);
  near(v.lon, -80.04, 1e-9);
  assert.equal(v.zoom, 9);
});

test('fitView zooms out to contain spread-out points', () => {
  const wide = fitView([{ lat: 32.9, lon: -80 }, { lat: 34.9, lon: -117.9 }], 600, 360);
  const tight = fitView([{ lat: 32.9, lon: -80 }, { lat: 33.0, lon: -80.1 }], 600, 360);
  assert.ok(tight.zoom > wide.zoom, 'tighter cluster should zoom in more');
});

test('fitView falls back to CONUS when no valid points', () => {
  const v = fitView([{ lat: NaN, lon: 1 }], 600, 360);
  assert.equal(v.zoom, 4);
});
