import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legGeometry, groundspeed, scheduleLegs } from './legs.js';

test('legGeometry: distance, course, midpoint per consecutive pair', () => {
  const legs = legGeometry([
    { id: 'A', lat: 0, lon: 0 },
    { id: 'B', lat: 0, lon: 1 },   // ~60 NM due east
    { id: 'C', lat: 0, lon: 2 },
  ]);
  assert.equal(legs.length, 2);
  assert.equal(legs[0].fromId, 'A');
  assert.equal(legs[0].toId, 'B');
  assert.ok(Math.abs(legs[0].distanceNm - 60) <= 1, `dist ${legs[0].distanceNm}`);
  assert.equal(legs[0].bearingTrue, 90);
  assert.ok(Math.abs(legs[0].midLon - 0.5) < 0.02 && Math.abs(legs[0].midLat) < 0.02);
  // Waypoints missing coordinates are skipped.
  assert.equal(legGeometry([{ id: 'A', lat: 0, lon: 0 }, { id: 'X' }]).length, 0);
});

test('groundspeed: headwind cuts GS, tailwind raises it, floored at 60', () => {
  const tas = 450;
  assert.equal(groundspeed(tas, 90, { dirTrue: 90, speedKt: 50 }), 400);  // direct headwind
  assert.equal(groundspeed(tas, 90, { dirTrue: 270, speedKt: 50 }), 500); // direct tailwind
  assert.equal(groundspeed(tas, 90, null), 450);                          // no wind -> TAS
  assert.equal(groundspeed(100, 90, { dirTrue: 90, speedKt: 200 }), 60);  // floor
});

test('scheduleLegs: cumulative ETA chain + stops + totals', () => {
  const legs = legGeometry([
    { id: 'A', lat: 0, lon: 0 },
    { id: 'B', lat: 0, lon: 1 },
    { id: 'C', lat: 0, lon: 2 },
  ]);
  const out = scheduleLegs(legs, '2026-06-14T00:00:00Z', 60); // 60 kt -> 60 NM = 60 min/leg
  assert.equal(out.legs[0].gsKt, 60);
  assert.equal(out.legs[0].eteMin, 60);
  assert.equal(out.legs[0].startIso, '2026-06-14T00:00:00.000Z');
  assert.equal(out.legs[0].etaIso, '2026-06-14T01:00:00.000Z');
  assert.equal(out.legs[1].etaIso, '2026-06-14T02:00:00.000Z');
  // stops: A@depart, B@+1h, C@+2h
  assert.deepEqual(out.stops.map((s) => s.id), ['A', 'B', 'C']);
  assert.equal(out.stops[0].etaIso, '2026-06-14T00:00:00.000Z');
  assert.equal(out.stops[2].etaIso, '2026-06-14T02:00:00.000Z');
  assert.ok(out.totalNm >= 119 && out.totalNm <= 121);
  assert.equal(out.totalMin, 120);
});

test('scheduleLegs: per-leg groundspeed override', () => {
  const legs = legGeometry([{ id: 'A', lat: 0, lon: 0 }, { id: 'B', lat: 0, lon: 1 }]);
  const out = scheduleLegs(legs, '2026-06-14T00:00:00Z', 60, [120]); // 120 kt -> 30 min
  assert.equal(out.legs[0].gsKt, 120);
  assert.equal(out.legs[0].eteMin, 30);
  assert.equal(out.legs[0].etaIso, '2026-06-14T00:30:00.000Z');
});

import { legEtp, suitableDiversion, nearestAirports } from './legs.js';

test('legEtp: no wind -> midpoint; headwind -> ETP biased toward the destination', () => {
  const legs = legGeometry([{ id: 'A', lat: 0, lon: 0 }, { id: 'B', lat: 0, lon: 10 }]); // ~600 NM east
  // No wind: continue GS == TAS, ETP at the midpoint.
  const calm = scheduleLegs(legs, '2026-06-14T00:00:00Z', 450).legs[0];
  const e1 = legEtp(calm, 450);
  assert.ok(Math.abs(e1.fromNm - e1.toNm) <= 1, `near-midpoint ${e1.fromNm}/${e1.toNm}`);
  assert.equal(e1.gsContinueKt, 450);
  assert.equal(e1.gsReturnKt, 450);
  // Headwind on course (GS 360 continuing): return GS = 2*450-360 = 540; ETP toward B.
  const hw = scheduleLegs(legs, '2026-06-14T00:00:00Z', 450, [360]).legs[0];
  const e2 = legEtp(hw, 450);
  assert.equal(e2.gsContinueKt, 360);
  assert.equal(e2.gsReturnKt, 540);
  assert.ok(e2.fromNm > e2.toNm, `ETP past midpoint toward B (${e2.fromNm}/${e2.toNm})`);
  assert.ok(Number.isFinite(e2.lat) && Number.isFinite(e2.lon));
  assert.ok(e2.etpIso > calm.startIso);
});

test('suitableDiversion: needs an open runway >= threshold', () => {
  assert.equal(suitableDiversion({ runways: [{ lengthFt: 9000 }] }), true);
  assert.equal(suitableDiversion({ runways: [{ lengthFt: 4000 }] }), false);     // < 7000 default
  assert.equal(suitableDiversion({ runways: [{ lengthFt: 5000 }] }, 4000), true); // custom threshold
  assert.equal(suitableDiversion({ runways: [] }), false);
  assert.equal(suitableDiversion(null), false);
});

test('nearestAirports: distance filter, suitability filter, nearest-first, capped', () => {
  const pool = [
    { icao: 'NEAR', lat: 0, lon: 0.1, runways: [{ lengthFt: 8000 }] },   // ~6 NM, suitable
    { icao: 'SHORT', lat: 0, lon: 0.2, runways: [{ lengthFt: 3000 }] },  // ~12 NM, too short
    { icao: 'FAR', lat: 0, lon: 20, runways: [{ lengthFt: 12000 }] },    // ~1200 NM, out of range
    { icao: 'MID', lat: 0, lon: 1, runways: [{ lengthFt: 9000 }] },      // ~60 NM, suitable
  ];
  const r = nearestAirports(0, 0, pool, { maxNm: 400, minRunwayFt: 7000, limit: 3 });
  assert.deepEqual(r.map((a) => a.icao), ['NEAR', 'MID']); // SHORT filtered, FAR out of range
  assert.equal(r[0].distanceNm < r[1].distanceNm, true);
});
