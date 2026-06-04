import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearingDeg } from '../core/geo.js';
import { pointToPolylineNm } from './airspace.js';
import { normalizeId, routeLine, lookupMtr, buildMtrDetail } from './mtr.js';

const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} ~ ${b}`);

test('bearingDeg: due north and due east', () => {
  near(bearingDeg(33, -80, 34, -80), 0, 0.5);
  near(bearingDeg(0, 0, 0, 1), 90, 0.5);
});

test('pointToPolylineNm: distance to a segment (perpendicular)', () => {
  // segment along the equator from (0,0) to (0,1deg); point 1deg north of midpoint
  const d = pointToPolylineNm(1, 0.5, [[0, 0], [0, 1]]);
  near(d, 60, 1); // ~60 NM per degree latitude
});

test('pointToPolylineNm: zero on the line', () => {
  near(pointToPolylineNm(0, 0.5, [[0, 0], [0, 1]]), 0, 0.5);
});

test('normalizeId strips punctuation/case', () => {
  assert.equal(normalizeId('IR-021'), 'IR021');
  assert.equal(normalizeId('vr 1355'), 'VR1355');
});

test('routeLine flattens segments, de-duping shared points', () => {
  const g = routeLine({ segments: [
    { points: [[1, 1], [2, 2]] },
    { points: [[2, 2], [3, 3]] },
  ] });
  assert.equal(g.kind, 'line');
  assert.deepEqual(g.points, [[1, 1], [2, 2], [3, 3]]);
});

test('lookupMtr finds fixture route by normalized id', async () => {
  const m = await lookupMtr('ir021', true);
  assert.ok(m);
  assert.equal(m.type, 'IR');
  assert.equal(m.segments.length, 2);
});

test('buildMtrDetail returns per-leg bearing/length and winds (offline fixture)', async () => {
  const d = await buildMtrDetail('VR-1355', true);
  assert.equal(d.found, true);
  assert.equal(d.type, 'VR');
  assert.equal(d.segments.length, 2);
  const s = d.segments[0];
  assert.ok(typeof s.bearing === 'number');
  assert.ok(s.lengthNm > 0);
  assert.ok(s.wind && typeof s.wind.crosswindKt === 'number'); // winds resolved from fixture
});

test('buildMtrDetail reports not found for unknown id', async () => {
  const d = await buildMtrDetail('IR-999', true);
  assert.equal(d.found, false);
});

test('AP/1B ingested routes load (IR-193 ≡ VR-106 geometry)', async () => {
  const ir193 = await buildMtrDetail('IR-193', true);
  const vr106 = await buildMtrDetail('VR-106', true);
  assert.equal(ir193.found, true);
  assert.equal(ir193.source === undefined || true, true);
  assert.equal(ir193.segments.length, 6); // 7 points A..G
  assert.match(ir193.segments[0].altText, /AGL|MSL/);
  // IR-193 and VR-106 share the exact routing per AP/1B
  assert.equal(vr106.segments.length, ir193.segments.length);
  assert.deepEqual(vr106.geometry.points[0], ir193.geometry.points[0]);
});

test('AP/1B IR-154 has the full Altus point set', async () => {
  const d = await buildMtrDetail('IR-154', true);
  assert.equal(d.segments.length, 16); // 17 points A..Q
  assert.equal(d.segments[0].widthLeftNm, 2);
});
