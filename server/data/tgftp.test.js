import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRawMetar } from './tgftp.js';

test('parseRawMetar: standard US METAR (wind/gust, temp, A-altimeter)', () => {
  const o = parseRawMetar('KLTS 101455Z 17015G25KT 10SM FEW040 SCT250 32/14 A2989 RMK AO2A SLP110');
  assert.equal(o.icao, 'KLTS');
  assert.deepEqual(o.wind, { dirTrue: 170, speedKt: 15, gustKt: 25 });
  assert.equal(o.tempC, 32);
  // A2989 -> 29.89 inHg -> ~1012.2 hPa
  assert.ok(Math.abs(o.altimHpa - 1012.2) < 0.5, `altim ${o.altimHpa}`);
  assert.ok(o.rawText.startsWith('KLTS'));
  assert.ok(o.obsTime, 'obsTime resolved');
});

test('parseRawMetar: negative temp, Q-altimeter (hPa), MPS wind', () => {
  const o = parseRawMetar('ETAR 101450Z 27008MPS 9999 BKN030 M02/M05 Q1021 NOSIG');
  assert.deepEqual(o.wind, { dirTrue: 270, speedKt: 16, gustKt: null }); // 8 m/s ≈ 16 kt
  assert.equal(o.tempC, -2);
  assert.equal(o.altimHpa, 1021);
});

test('parseRawMetar: VRB and calm winds', () => {
  const v = parseRawMetar('KCHS 101456Z VRB04KT 10SM CLR 28/21 A3002');
  assert.deepEqual(v.wind, { dirTrue: 'VRB', speedKt: 4, gustKt: null });
  const c = parseRawMetar('KCHS 101456Z 00000KT 10SM CLR 28/21 A3002');
  assert.equal(c.wind.dirTrue, null); // calm => indeterminate, matches AWC shape
  assert.equal(c.wind.speedKt, 0);
});

test('parseRawMetar: rejects non-METAR text', () => {
  assert.equal(parseRawMetar(''), null);
  assert.equal(parseRawMetar('not a metar at all'), null);
});
