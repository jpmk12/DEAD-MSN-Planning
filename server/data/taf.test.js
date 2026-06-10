import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWind, decodeVisibility, decodeCloud, decodeWeather, decodeTaf } from './taf.js';

test('decodeWind handles steady, gust, variable, calm', () => {
  assert.equal(decodeWind('18012KT'), 'wind 180° at 12 kt');
  assert.equal(decodeWind('21015G25KT'), 'wind 210° at 15 kt, gusting 25 kt');
  assert.equal(decodeWind('VRB05KT'), 'wind variable at 5 kt');
  assert.equal(decodeWind('00000KT'), 'wind calm');
  assert.equal(decodeWind('P6SM'), null);
});

test('decodeVisibility handles SM, fractions, P6SM, CAVOK', () => {
  assert.equal(decodeVisibility('P6SM'), 'visibility better than 6 SM');
  assert.equal(decodeVisibility('5SM'), 'visibility 5 SM');
  assert.equal(decodeVisibility('1/2SM'), 'visibility 1/2 SM');
  assert.equal(decodeVisibility('CAVOK'), 'ceiling and visibility OK');
});

test('decodeCloud handles layers, CB, clear, VV', () => {
  assert.equal(decodeCloud('SCT250'), 'scattered at 25,000 ft');
  assert.equal(decodeCloud('BKN015CB'), 'broken at 1,500 ft (cumulonimbus)');
  assert.equal(decodeCloud('SKC'), 'sky clear');
  assert.equal(decodeCloud('VV002'), 'vertical visibility 200 ft');
});

test('decodeWeather handles intensity, descriptor, phenomena', () => {
  assert.equal(decodeWeather('-TSRA'), 'light thunderstorm rain');
  assert.equal(decodeWeather('+SN'), 'heavy snow');
  assert.equal(decodeWeather('VCSH'), 'in the vicinity showers');
  assert.equal(decodeWeather('BR'), 'mist');
  assert.equal(decodeWeather('BKN015'), null);
});

test('decodeTaf parses header, validity, and periods', () => {
  const raw = 'KCHS 241130Z 2412/2518 18012G22KT P6SM SCT250 FM241800 21015G25KT P6SM VCSH BKN035 TEMPO 2418/2422 5SM -TSRA BKN015CB FM250200 24008KT P6SM SCT040';
  const d = decodeTaf(raw);
  assert.equal(d.station, 'KCHS');
  assert.match(d.issued, /24th 11:30Z/);
  assert.match(d.valid, /24th 12:00Z – 25th 18:00Z/);
  assert.equal(d.periods.length, 4);

  const prevail = d.periods[0];
  assert.equal(prevail.label, 'Prevailing');
  assert.ok(prevail.items.includes('wind 180° at 12 kt, gusting 22 kt'));
  assert.ok(prevail.items.includes('scattered at 25,000 ft'));

  const tempo = d.periods.find((p) => p.label === 'Temporarily');
  assert.ok(tempo, 'has TEMPO period');
  assert.ok(tempo.items.includes('light thunderstorm rain'));
  assert.ok(tempo.items.includes('broken at 1,500 ft (cumulonimbus)'));

  const fm = d.periods.filter((p) => p.label === 'From');
  assert.equal(fm.length, 2);
});

test('decodeTaf keeps unknown tokens in extra', () => {
  const d = decodeTaf('KORD 011200Z 0112/0218 27010KT P6SM FEW050 WS020/27045KT');
  const all = d.periods.flatMap((p) => p.extra);
  assert.ok(all.includes('WS020/27045KT'));
});

// --- machine-readable, time-aware decode (Commit 3) ---
import { parseWindTok, parseVisSm, parseCeilingFt, flightCategory, tafTimeMs, tafAt } from './taf.js';

test('parseWindTok / parseVisSm / parseCeilingFt extract numbers', () => {
  assert.deepEqual(parseWindTok('24018G30KT'), { dirTrue: 240, speedKt: 18, gustKt: 30 });
  assert.deepEqual(parseWindTok('VRB05KT'), { dirTrue: 'VRB', speedKt: 5, gustKt: null });
  assert.equal(parseVisSm('P6SM'), 99);
  assert.equal(parseVisSm('1/2SM'), 0.5);
  assert.equal(parseVisSm('3SM'), 3);
  assert.equal(parseCeilingFt('OVC008'), 800);
  assert.equal(parseCeilingFt('SCT020'), null); // SCT is not a ceiling
  assert.equal(parseCeilingFt('VV002'), 200);
});

test('flightCategory thresholds (VFR/MVFR/IFR/LIFR)', () => {
  assert.equal(flightCategory(5000, 10), 'VFR');
  assert.equal(flightCategory(2500, 10), 'MVFR');
  assert.equal(flightCategory(800, 10), 'IFR');
  assert.equal(flightCategory(300, 10), 'LIFR');
  assert.equal(flightCategory(5000, 0.5), 'LIFR'); // vis drives it
});

test('tafTimeMs resolves DDHH near anchor, handles month rollover + hour 24', () => {
  const anchor = Date.parse('2026-07-01T12:00:00Z');
  assert.equal(new Date(tafTimeMs('0100', anchor)).toISOString(), '2026-07-01T00:00:00.000Z');
  // hour 24 = 24:00 of the day = 00Z the next day
  assert.equal(new Date(tafTimeMs('0124', anchor)).toISOString(), '2026-07-02T00:00:00.000Z');
  // month rollover: anchored June 30, a group on the 1st resolves to July
  const a2 = Date.parse('2026-06-30T22:00:00Z');
  assert.equal(new Date(tafTimeMs('0106', a2)).toISOString(), '2026-07-01T06:00:00.000Z');
  assert.equal(new Date(tafTimeMs('3023', a2)).toISOString(), '2026-06-30T23:00:00.000Z');
});

test('tafAt selects the governing FM period + active TEMPO caveat with numbers', () => {
  const raw = 'KLTS 111120Z 1112/1218 24012KT P6SM SCT040 '
    + 'FM111800 27018G28KT P6SM BKN025 '
    + 'TEMPO 1119/1122 3SM TSRA BKN015CB';
  const d = decodeTaf(raw);
  const at = tafAt(d, '2026-06-11T20:15:00Z');
  assert.equal(at.withinValidity, true);
  assert.equal(at.base.label, 'From');
  assert.deepEqual(at.wind, { dirTrue: 270, speedKt: 18, gustKt: 28 }); // the FM1800 wind
  assert.equal(at.ceilingFt, 2500);
  assert.equal(at.flightCategory, 'MVFR');
  assert.ok(at.caveats.some((c) => /Temporarily/.test(c.label) && c.ceilingFt === 1500));
  // before the FM, the prevailing group governs
  const early = tafAt(d, '2026-06-11T13:00:00Z');
  assert.deepEqual(early.wind, { dirTrue: 240, speedKt: 12, gustKt: null });
  // outside validity
  const out = tafAt(d, '2026-06-13T00:00:00Z');
  assert.equal(out.withinValidity, false);
});
