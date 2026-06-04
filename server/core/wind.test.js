import { test } from 'node:test';
import assert from 'node:assert/strict';
import { magToTrue, windComponents } from './wind.js';
import { signedDiff, normalize360 } from './geo.js';
import { analyzeRunways, selectActiveRunway, analyzeAirfield } from './analyze.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} ~ ${b}`);
const LIMITS = { crosswindKt: 25, tailwindKt: 10, highDensityAltitudeFt: 5000 };

test('geo: normalize into [0,360)', () => {
  assert.equal(normalize360(-10), 350);
  assert.equal(normalize360(370), 10);
  assert.equal(normalize360(360), 0);
});

test('geo: signed diff in (-180,180]', () => {
  assert.equal(signedDiff(10, 350), 20);
  assert.equal(signedDiff(350, 10), -20);
  assert.equal(signedDiff(180, 0), 180);
});

test('mag->true: west variation (Charleston-ish)', () => {
  near(magToTrue(150, -8), 142); // 8W
});
test('mag->true: east variation (California-ish)', () => {
  near(magToTrue(30, 13), 43);
});

test('wind: pure headwind', () => {
  const c = windComponents(360, 360, 10);
  near(c.headwindKt, 10);
  near(c.crosswindKt, 0);
  assert.equal(c.crosswindSide, 'none');
});
test('wind: pure crosswind from the right', () => {
  const c = windComponents(360, 90, 10);
  near(c.headwindKt, 0);
  near(c.crosswindKt, 10);
  assert.equal(c.crosswindSide, 'right');
});
test('wind: pure crosswind from the left', () => {
  const c = windComponents(360, 270, 10);
  near(c.crosswindKt, 10);
  assert.equal(c.crosswindSide, 'left');
});
test('wind: 45 degrees splits evenly', () => {
  const c = windComponents(360, 45, 10);
  near(c.headwindKt, 7.071);
  near(c.crosswindKt, 7.071);
});
test('wind: direct tailwind => negative headwind', () => {
  const c = windComponents(360, 180, 10);
  near(c.headwindKt, -10);
  near(c.crosswindKt, 0);
});
test('wind: wraps around 360 (wind 010 on rwy 350)', () => {
  const c = windComponents(350, 10, 20);
  near(c.headwindKt, 18.794);
  near(c.crosswindKt, 6.84);
  assert.equal(c.crosswindSide, 'right');
});

const airport = {
  icao: 'TEST', name: 'Test', elevationFt: 50, magVar: -8,
  runways: [{ ident: '15', magHeading: 150 }, { ident: '33', magHeading: 330 }],
};

test('runway selection uses true-frame wind', () => {
  const obs = { icao: 'TEST', wind: { dirTrue: 320, speedKt: 15 } };
  const active = selectActiveRunway(analyzeRunways(airport, obs));
  assert.equal(active.ident, '33');
  near(active.trueHeading, 322);
  assert.ok(active.headwindKt > 14);
  assert.ok(active.crosswindKt < 1);
  assert.equal(active.isTailwind, false);
});
test('reciprocal end shows tailwind', () => {
  const obs = { icao: 'TEST', wind: { dirTrue: 320, speedKt: 15 } };
  const rwy15 = analyzeRunways(airport, obs).find((r) => r.ident === '15');
  assert.equal(rwy15.isTailwind, true);
  assert.ok(rwy15.headwindKt < 0);
});

const gusty = {
  icao: 'GUST', name: 'Gusty', elevationFt: 0, magVar: 0,
  runways: [{ ident: '09', magHeading: 90 }, { ident: '27', magHeading: 270 }],
};
test('gust: separate larger gust crosswind', () => {
  const obs = { icao: 'GUST', wind: { dirTrue: 180, speedKt: 15, gustKt: 30 } };
  const r = analyzeRunways(gusty, obs).find((x) => x.ident === '09');
  near(r.crosswindKt, 15);
  near(r.gustCrosswindKt, 30);
});
test('gust crosswind exceeding limit is flagged when steady is fine', () => {
  const obs = { icao: 'GUST', wind: { dirTrue: 180, speedKt: 20, gustKt: 30 }, tempC: 15, altimHpa: 1013.25 };
  const a = analyzeAirfield(gusty, obs, { crosswindKt: 25, tailwindKt: 10 });
  assert.ok(a.warnings.some((w) => w.includes('Gust crosswind')));
});

const calm = {
  icao: 'CALM', name: 'Calm', elevationFt: 0, magVar: 0,
  runways: [{ ident: '18', magHeading: 180 }, { ident: '36', magHeading: 360 }],
};
test('VRB wind => no active runway + discretion warning', () => {
  const a = analyzeAirfield(calm, { icao: 'CALM', wind: { dirTrue: 'VRB', speedKt: 3 } }, LIMITS);
  assert.equal(a.active, null);
  assert.equal(a.windIndeterminate, true);
  assert.ok(a.warnings.some((w) => w.includes('discretion')));
});
test('calm (00000KT) is indeterminate', () => {
  const a = analyzeAirfield(calm, { icao: 'CALM', wind: { dirTrue: null, speedKt: 0 } }, LIMITS);
  assert.equal(a.active, null);
});
