import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHourIndex, parseProfile, nearestLevel, interpolateWind, buildUrl, forecastDaysFor, fetchWindsAloft } from './windsaloft.js';

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

test('forecastDaysFor sizes the window to reach the target (cap 3) (R2)', () => {
  const now = Date.now();
  assert.equal(forecastDaysFor(undefined), 1);
  assert.equal(forecastDaysFor('not-a-date'), 1);
  assert.equal(forecastDaysFor(new Date(now).toISOString()), 1); // today
  assert.ok(forecastDaysFor(new Date(now + 25 * 3600000).toISOString()) >= 2); // next calendar day(s)
  assert.equal(forecastDaysFor(new Date(now + 10 * 86400000).toISOString()), 3); // capped
  assert.match(buildUrl(34, -99, new Date(now + 25 * 3600000).toISOString()), /forecast_days=[23]/);
});

test('fetchWindsAloft flags a target beyond the forecast window as clamped (R2)', async () => {
  // offline uses the bundled sample (2026-06-04 15-17Z). A target inside that
  // window is not clamped; one far outside is, so the UI never shows the edge
  // sample as the ETA wind.
  const inWindow = await fetchWindsAloft(34.9, -117.9, 2300, true, '2026-06-04T16:00:00Z');
  assert.equal(inWindow.clamped, false);
  const beyond = await fetchWindsAloft(34.9, -117.9, 2300, true, '2999-01-01T00:00:00Z');
  assert.equal(beyond.clamped, true);
  assert.equal(beyond.requested, '2999-01-01T00:00:00Z');
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

test('interpolateWind: halfway between two levels (same direction)', () => {
  const profile = [{ altFt: 1000, dirTrue: 270, speedKt: 10 }, { altFt: 3000, dirTrue: 270, speedKt: 30 }];
  const w = interpolateWind(profile, 2000);
  assert.equal(w.dirTrue, 270);
  assert.equal(w.speedKt, 20); // linear in speed when direction constant
});

test('interpolateWind: clamps below/above the profile', () => {
  const profile = [{ altFt: 1000, dirTrue: 200, speedKt: 8 }, { altFt: 5000, dirTrue: 260, speedKt: 40 }];
  assert.deepEqual(interpolateWind(profile, 0), { dirTrue: 200, speedKt: 8 });
  assert.deepEqual(interpolateWind(profile, 9000), { dirTrue: 260, speedKt: 40 });
});

test('interpolateWind: direction interpolates across the compass via vectors', () => {
  const profile = [{ altFt: 1000, dirTrue: 350, speedKt: 20 }, { altFt: 3000, dirTrue: 10, speedKt: 20 }];
  const w = interpolateWind(profile, 2000);
  assert.equal(w.dirTrue, 0); // midpoint of 350 and 010 is 360/000, not 180
  assert.ok(Math.abs(w.speedKt - 20) <= 1);
});

test('nearestLevel picks the closest altitude', () => {
  const profile = [{ altFt: 2574 }, { altFt: 2902 }, { altFt: 4781 }];
  assert.equal(nearestLevel(profile, 3800).altFt, 2902); // 4781 vs 2902 -> 2902 closer to 3800? |4781-3800|=981, |2902-3800|=898
});

import { freezingLevelFt, icingLayers, thermalSummary } from './windsaloft.js';

const thermProfile = [
  { altFt: 1000, tempC: 12, rhPct: 60 },
  { altFt: 5000, tempC: 4, rhPct: 80 },   // above freezing
  { altFt: 9000, tempC: -3, rhPct: 90 },  // icing: cold + wet
  { altFt: 14000, tempC: -10, rhPct: 88 },// icing: cold + wet
  { altFt: 20000, tempC: -25, rhPct: 95 },// too cold (< -20) -> out of band
];

test('freezingLevelFt interpolates the 0C crossing', () => {
  // Between 5000 ft (+4) and 9000 ft (-3): 0C at 5000 + 4000*(4/7) ~= 7286 ft.
  const fl = freezingLevelFt(thermProfile);
  assert.ok(Math.abs(fl - 7286) < 30, `freezing level ${fl}`);
  // Surface already below freezing -> the lowest level's altitude.
  assert.equal(freezingLevelFt([{ altFt: 2000, tempC: -1 }, { altFt: 8000, tempC: -8 }]), 2000);
  // Whole column above freezing -> null.
  assert.equal(freezingLevelFt([{ altFt: 1000, tempC: 9 }, { altFt: 9000, tempC: 2 }]), null);
  // No temps -> null.
  assert.equal(freezingLevelFt([{ altFt: 1000 }]), null);
});

test('icingLayers flags the 0..-20C moist band, not the too-cold level', () => {
  const bands = icingLayers(thermProfile);
  assert.equal(bands.length, 1);
  assert.equal(bands[0].baseFt, 9000);
  assert.equal(bands[0].topFt, 14000); // -25C level excluded (below -20)
  assert.equal(bands[0].severity, 'MODERATE'); // cold (worst band) + wet
  // Dry air in the band -> not suspect (RH below threshold).
  assert.equal(icingLayers([{ altFt: 9000, tempC: -5, rhPct: 30 }]).length, 0);
});

test('thermalSummary: empty profile -> null; no-temp profile -> maxWind only; full -> all', () => {
  assert.equal(thermalSummary([]), null);
  // No temperatures: freezing/icing/tropopause null/empty, but maxWind still works.
  const noTemp = thermalSummary([{ altFt: 1000, dirTrue: 240, speedKt: 10 }, { altFt: 9000, dirTrue: 260, speedKt: 45 }]);
  assert.equal(noTemp.freezingLevelFt, null);
  assert.equal(noTemp.icing.length, 0);
  assert.equal(noTemp.tropopauseFt, null);
  assert.equal(noTemp.maxWind.speedKt, 45);
  // Full profile.
  const t = thermalSummary(thermProfile);
  assert.ok(t && t.freezingLevelFt > 0 && t.icing.length === 1);
});

import { interpolateScalar, icingAt, maxWindLevel, tropopauseFt } from './windsaloft.js';

test('maxWindLevel finds the strongest wind level (jet core)', () => {
  const prof = [
    { altFt: 2000, dirTrue: 240, speedKt: 15 },
    { altFt: 18000, dirTrue: 260, speedKt: 60 },
    { altFt: 34000, dirTrue: 270, speedKt: 120 },
  ];
  const m = maxWindLevel(prof);
  assert.equal(m.altFt, 34000);
  assert.equal(m.speedKt, 120);
  assert.equal(maxWindLevel([]), null);
  // Levels missing altFt/dirTrue are ignored (so callers can format without guards).
  const partial = maxWindLevel([{ speedKt: 200 }, { altFt: 20000, dirTrue: 250, speedKt: 80 }]);
  assert.equal(partial.altFt, 20000);
  assert.equal(partial.speedKt, 80);
});

test('tropopauseFt finds where the lapse rate drops below 2C/km, else null', () => {
  // Steady ~6.5C/km cooling to ~FL300, then near-isothermal above = tropopause.
  const prof = [
    { altFt: 1000, tempC: 12 },
    { altFt: 10000, tempC: -6 },   // ~6.5C/km
    { altFt: 20000, tempC: -25 },  // ~6.3C/km
    { altFt: 30000, tempC: -44 },  // ~6.3C/km
    { altFt: 34000, tempC: -45 },  // ~0.8C/km -> isothermal -> trop at 30000
  ];
  assert.equal(tropopauseFt(prof), 30000);
  // Still cooling at the top -> tropopause above the profile -> null.
  const cooling = [
    { altFt: 1000, tempC: 12 }, { altFt: 18000, tempC: -25 }, { altFt: 34000, tempC: -55 },
  ];
  assert.equal(tropopauseFt(cooling), null);
});

test('interpolateScalar linearly interpolates a per-level field, skipping nulls', () => {
  const prof = [
    { altFt: 1000, tempC: 10 },
    { altFt: 5000, tempC: 2 },
    { altFt: 9000, tempC: -6, rhPct: 80 },
  ];
  assert.equal(interpolateScalar(prof, 3000, 'tempC'), 6); // halfway 1k..5k
  assert.equal(interpolateScalar(prof, 500, 'tempC'), 10);  // clamps low
  assert.equal(interpolateScalar(prof, 99000, 'tempC'), -6); // clamps high
  // rhPct only present on one level -> returns it (single-sample), null if none.
  assert.equal(interpolateScalar(prof, 9000, 'rhPct'), 80);
  assert.equal(interpolateScalar(prof, 3000, 'mystery'), null);
});

test('icingAt flags the 0..-20C moist band with a severity, else null', () => {
  assert.equal(icingAt(5, 90), null);          // too warm
  assert.equal(icingAt(-25, 90), null);        // too cold
  assert.equal(icingAt(-5, 30), null);         // dry
  assert.equal(icingAt(-8, 50), null);                // dry (RH < 70) -> not suspect
  assert.equal(icingAt(-8, 90).severity, 'MODERATE'); // cold band + wet
  assert.equal(icingAt(-8, 75).severity, 'LIGHT');    // cold band, moist but not wet
  assert.equal(icingAt(-1, null).severity, 'TRACE');  // edge of band, RH unknown
  assert.equal(icingAt(null, 90), null);       // no temperature
});
