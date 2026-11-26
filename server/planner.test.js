import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelProfile, fetchModelProfile } from './data/windsaloft.js';
import { toTafPeriods, parseMilIcing, closuresFromNotams, buildPlanner } from './planner.js';
import { decodeTaf } from './data/taf.js';

test('parseModelProfile maps surface fields + pressure levels from an Open-Meteo payload', () => {
  const json = {
    hourly: {
      time: ['2026-11-26T00:00', '2026-11-26T01:00'],
      temperature_2m: [2, 1], dew_point_2m: [0, -1], apparent_temperature: [-1, -2],
      freezing_level_height: [200, 150], weather_code: [63, 67], precipitation: [1, 1.2],
      snowfall: [0, 0], visibility: [8000, 4000], wind_speed_10m: [12, 14],
      wind_direction_10m: [200, 210], wind_gusts_10m: [20, 24],
      temperature_850hPa: [-4, -5], relative_humidity_850hPa: [95, 96], geopotential_height_850hPa: [1460, 1455],
    },
  };
  const hours = parseModelProfile(json);
  assert.equal(hours.length, 2);
  assert.equal(hours[1].tempC2m, 1);
  assert.equal(hours[1].weatherCode, 67);
  assert.equal(hours[1].visM, 4000);
  assert.equal(hours[1].gustKt, 24);
  assert.deepEqual(hours[1].levels[0], { hPa: 850, heightM: 1455, tempC: -5, rh: 96 });
  assert.equal(Date.parse('2026-11-26T00:00Z'), hours[0].t); // parsed as UTC
});

test('fetchModelProfile offline loads the bundled fixture (≥72 h)', async () => {
  const r = await fetchModelProfile(35, -80, null, true);
  assert.ok(r.hours.length >= 72);
  assert.equal(r.live, false);
  assert.ok(r.hours.every((h) => Array.isArray(h.levels)));
});

test('toTafPeriods adapts decoded periods with raw weather codes + change type', () => {
  const anchor = Date.UTC(2026, 10, 26, 0, 0, 0);
  const decoded = decodeTaf('KCHS 260000Z 2600/2706 24012KT 6SM -FZRA BKN008 TEMPO 2602/2605 1SM +SN');
  const periods = toTafPeriods(decoded, anchor);
  assert.ok(periods.length >= 1);
  const base = periods[0];
  assert.equal(base.changeType, 'BASE');
  assert.match(base.wxRaw, /FZRA/);
  assert.ok(Number.isFinite(base.fromMs) && Number.isFinite(base.toMs));
  const tempo = periods.find((p) => p.changeType === 'TEMPO');
  assert.ok(tempo, 'TEMPO overlay present');
  assert.match(tempo.wxRaw, /SN/);
});

test('parseMilIcing decodes a 6-group into intensity + base/top', () => {
  const g = parseMilIcing('... 640305 ...');
  assert.equal(g.length, 1);
  assert.equal(g[0].intensity, 'moderate');
  assert.equal(g[0].baseFtAgl, 3000);
  assert.equal(g[0].topFtAgl, 8000);
  assert.equal(parseMilIcing('no groups here').length, 0);
});

test('closuresFromNotams: readable window used; scheduled one marked indeterminate', () => {
  const start = Date.UTC(2026, 10, 26, 0, 0, 0), end = start + 72 * 3600000;
  const notams = [
    { icao: 'KCHS', text: 'RWY 15/33 CLSD', effectiveStart: '2026-11-26T02:00:00Z', effectiveEnd: '2026-11-26T06:00:00Z' },
    { icao: 'KCHS', text: 'TWY A CLSD DLY 0600-0800', effectiveStart: '2026-11-26T00:00:00Z', effectiveEnd: '2026-11-28T00:00:00Z' },
    { icao: 'KCHS', text: 'RWY 15 PAPI U/S', effectiveStart: 'not-a-date', effectiveEnd: 'x' },
  ];
  const cl = closuresFromNotams(notams, start, end);
  const rwy = cl.find((c) => c.label === 'RWY 15/33');
  assert.ok(rwy && !rwy.indeterminate && rwy.kind === 'closure');
  const twy = cl.find((c) => c.label === 'TWY A');
  assert.ok(twy && twy.indeterminate, 'daily schedule → indeterminate');
  assert.ok(!cl.some((c) => c.label === 'RWY 15'), 'unparseable times skipped, never guessed');
});

test('buildPlanner (injected) assembles per-field lanes + windows + events', async () => {
  const anchor = Date.UTC(2026, 10, 26, 0, 0, 0);
  const H = (i, over = {}) => ({ t: anchor + i * 3600000, tempC2m: -1, dewC: -3, feelsC: -4, freezingLevelM: 60, weatherCode: 67, precipMm: 1, snowCm: 0, visM: 4000, windDir: 200, windKt: 14, gustKt: 22, levels: [{ hPa: 850, heightM: 1460, tempC: -5, rh: 96 }], ...over });
  const inject = {
    airports: { KCHS: { icao: 'KCHS', name: 'Charleston', lat: 32.9, lon: -80.0, elevationFt: 46, magVar: -8, runways: [{ ident: '03', magHeading: 33 }, { ident: '21', magHeading: 213 }] } },
    tafs: { KCHS: 'KCHS 260000Z 2600/2706 20012KT 3SM -FZRA OVC005' },
    notams: { KCHS: [{ icao: 'KCHS', text: 'RWY 03/21 CLSD', effectiveStart: '2026-11-26T05:00:00Z', effectiveEnd: '2026-11-26T09:00:00Z' }] },
    models: { KCHS: Array.from({ length: 72 }, (_, i) => H(i)) },
  };
  const events = [{ icao: 'KCHS', kind: 'ETD', ms: anchor + 2 * 3600000 }];
  const r = await buildPlanner(['KCHS'], new Date(anchor).toISOString(), false, events, inject);
  const f = r.fields[0];
  assert.equal(f.found, true);
  assert.equal(f.live, true);
  assert.deepEqual(f.lanes.map((l) => l.key), ['sky', 'precip', 'deice', 'runway', 'icing', 'xwind', 'ramp', 'notam']);
  assert.ok(f.windows.length >= 1);
  assert.equal(f.events[0].kind, 'ETD');
  // The freezing-rain TAF drives Runway ICE; the NOTAM closure appears in the notam lane.
  assert.ok(f.lanes.find((l) => l.key === 'runway').segs.some((s) => s.label === 'ICE'));
  assert.ok(f.lanes.find((l) => l.key === 'notam').segs.some((s) => s.short === 'CLSD'));
});
