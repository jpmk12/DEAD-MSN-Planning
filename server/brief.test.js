import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metarConditions, phaseForecast, DEFAULT_LIMITS } from './brief.js';
import { decodeTaf } from './data/taf.js';

test('metarConditions extracts vis/ceiling/category from a raw METAR (CONUS SM)', () => {
  const a = metarConditions('KLTS 111455Z 27015G25KT 10SM FEW040 SCT250 30/12 A2992');
  assert.equal(a.visibilitySm, 10);
  assert.equal(a.ceilingFt, null); // FEW/SCT are not ceilings
  assert.equal(a.flightCategory, 'VFR');
  const b = metarConditions('KCHS 111455Z 09008KT 1 1/2SM BR OVC004 18/17 A3001');
  assert.equal(b.visibilitySm, 1.5);
  assert.equal(b.ceilingFt, 400);
  assert.equal(b.flightCategory, 'LIFR');
});

const APT = { icao: 'KLTS', elevationFt: 1382, magVar: 0, runways: [
  { ident: '17', trueHeading: 174 }, { ident: '35', trueHeading: 354 },
] };

test('phaseForecast analyzes the TAF-at-ETA wind + ceiling/vis vs minimums', () => {
  // FM wind 090° is ~perpendicular to runways 17/35, gusting 40 -> gust crosswind
  // exceeds the 30 kt limit; ceiling 600 < 1000 and vis 2 < 3.
  const raw = 'KLTS 111120Z 1112/1218 24012KT P6SM SCT040 '
    + 'FM111800 09028G40KT 2SM BR OVC006';
  const d = decodeTaf(raw);
  const f = phaseForecast(APT, d, '2026-06-11T20:15:00Z', DEFAULT_LIMITS);
  assert.equal(f.source, 'TAF');
  assert.deepEqual(f.wind, { dirTrue: 90, speedKt: 28, gustKt: 40 });
  assert.ok(f.windWarnings.some((w) => /exceeds limit/.test(w)), 'gust crosswind exceedance flagged');
  assert.ok(f.cvWarnings.some((w) => /ceiling 600 ft below/.test(w)));
  assert.ok(f.cvWarnings.some((w) => /visibility 2 SM below/.test(w)));
  assert.equal(f.flightCategory, 'IFR');
  assert.ok(['17', '35'].includes(f.active?.ident), 'an active runway is selected');
});

test('phaseForecast returns null when the TAF cannot speak to the time', () => {
  assert.equal(phaseForecast(APT, null, '2026-06-11T20:15:00Z', DEFAULT_LIMITS), null);
  const d = decodeTaf('KLTS 111120Z 1112/1218 24012KT P6SM SCT040');
  assert.equal(phaseForecast(APT, d, 'bad-date', DEFAULT_LIMITS), null);
});

import { rankAlternates } from './brief.js';

test('rankAlternates orders by status, then worst-case crosswind, then category', () => {
  const alt = (icao, status, xw, cat, src = 'TAF@ETA') => ({
    uid: icao, icao, status, statusSource: src,
    forecast: src === 'TAF@ETA' ? { active: { ident: 'X', crosswindKt: xw, gustCrosswindKt: xw }, flightCategory: cat } : null,
    analysis: src === 'METAR' ? { active: { ident: 'X', crosswindKt: xw } } : null,
    currentConditions: { flightCategory: cat }, birdRisk: { level: 'LOW' },
    phase: { role: 'ALTERNATE', when: '2026-06-11T20:15:00Z' }, statusReasons: [],
  });
  const r = rankAlternates([
    alt('KAAA', 'CAUTION', 18, 'MVFR'),
    alt('KBBB', 'GO', 12, 'VFR'),
    alt('KCCC', 'GO', 4, 'VFR'),
    { ...alt('KDEP', 'GO', 1, 'VFR'), phase: { role: 'DEPARTURE' } }, // not an alternate
  ], DEFAULT_LIMITS);
  assert.deepEqual(r.map((x) => x.icao), ['KCCC', 'KBBB', 'KAAA']);
  assert.equal(r[0].rank, 1);
  assert.equal(r[0].crosswindKt, 4);
  assert.ok(r[2].reasons.length >= 1);
});
