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
