import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHourIndex, parseProfile, nearestLevel, buildUrl } from './windsaloft.js';

const sample = {
  hourly: {
    time: ['2026-06-04T15:00', '2026-06-04T16:00', '2026-06-04T17:00'],
    wind_speed_80m: [11, 12, 13],
    wind_direction_80m: [238, 240, 242],
    wind_speed_180m: [15, 16, 17],
    wind_direction_180m: [244, 245, 246],
    wind_speed_925hPa: [21, 22, 23],
    wind_direction_925hPa: [249, 250, 251],
    wind_speed_850hPa: [29, 30, 31],
    wind_direction_850hPa: [254, 255, 256],
    wind_speed_700hPa: [44, 45, 46],
    wind_direction_700hPa: [259, 260, 261],
  },
};

test('buildUrl requests knots and the expected levels', () => {
  const u = buildUrl(34.9, -117.9);
  assert.match(u, /wind_speed_unit=kn/);
  assert.match(u, /wind_speed_925hPa/);
  assert.match(u, /latitude=34.9/);
});

test('findHourIndex selects the hour at/just before target', () => {
  assert.equal(findHourIndex(sample.hourly.time, '2026-06-04T16:30:00Z'), 1);
  assert.equal(findHourIndex(sample.hourly.time, '2026-06-04T17:00:00Z'), 2);
  assert.equal(findHourIndex(sample.hourly.time, '2026-06-04T09:00:00Z'), 0); // before all
});

test('parseProfile builds a low->high MSL profile from height + pressure levels', () => {
  const p = parseProfile(sample, 1, 2312); // KEDW-ish elevation
  // 80m (262 AGL) -> 2574, 180m (590) -> 2902, then 2500/4781/9882 MSL
  const alts = p.map((x) => x.altFt);
  assert.deepEqual([...alts].sort((a, b) => a - b), alts); // sorted ascending
  const top = p[p.length - 1];
  assert.equal(top.altFt, 9882);
  assert.equal(top.speedKt, 45);
  assert.equal(top.dirTrue, 260);
});

test('parseProfile skips missing levels', () => {
  const partial = { hourly: { time: ['t'], wind_speed_925hPa: [20], wind_direction_925hPa: [250] } };
  const p = parseProfile(partial, 0, 0);
  assert.equal(p.length, 1);
  assert.equal(p[0].altFt, 2500);
});

test('nearestLevel picks the closest altitude', () => {
  const profile = [{ altFt: 2574 }, { altFt: 2902 }, { altFt: 4781 }];
  assert.equal(nearestLevel(profile, 3800).altFt, 2902); // 4781 vs 2902 -> 2902 closer to 3800? |4781-3800|=981, |2902-3800|=898
});
