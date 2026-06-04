import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRouteRisk, segmentRisk } from './ahas.js';
import { buildMtrDetail } from './mtr.js';

test('fetchRouteRisk maps normalized ids to levels (fixture)', async () => {
  const { risk, live } = await fetchRouteRisk(['IR-021', 'vr1355', 'ZZ-9'], true);
  assert.equal(live, false);
  assert.equal(risk.get('IR021').level, 'SEVERE');
  assert.equal(risk.get('VR1355').level, 'MODERATE');
  assert.equal(risk.has('ZZ9'), false); // unknown route omitted
});

test('segmentRisk reads per-segment level', () => {
  const rec = { segments: { 'A → B': 'SEVERE', 'B → C': 'LOW' } };
  assert.equal(segmentRisk(rec, 'A → B'), 'SEVERE');
  assert.equal(segmentRisk(rec, 'B → C'), 'LOW');
  assert.equal(segmentRisk(null, 'A → B'), null);
});

test('buildMtrDetail attaches route + per-segment bird risk', async () => {
  const d = await buildMtrDetail('IR-021', true);
  assert.equal(d.birdRisk.level, 'SEVERE');
  assert.equal(d.segments[0].birdRisk, 'SEVERE');
  assert.equal(d.segments[1].birdRisk, 'MODERATE');
});
