import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAhasLevel, ahasRouteType, ahasUrl, ahasAreaForIcao } from './ahasapi.js';

test('parseAhasLevel extracts the worst level present', () => {
  assert.equal(parseAhasLevel('<string>LOW</string>'), 'LOW');
  assert.equal(parseAhasLevel('risk: MODERATE today'), 'MODERATE');
  assert.equal(parseAhasLevel('SEVERE'), 'SEVERE');
  // worst wins when several appear (e.g. a 12-hour list)
  assert.equal(parseAhasLevel('LOW LOW MODERATE LOW SEVERE LOW'), 'SEVERE');
  assert.equal(parseAhasLevel('no risk words'), null);
  assert.equal(parseAhasLevel(''), null);
});

test('ahasRouteType maps IR/VR/SR, skips AR', () => {
  assert.equal(ahasRouteType('IR154'), 'IR');
  assert.equal(ahasRouteType('IR-154'), 'IR');
  assert.equal(ahasRouteType('VR106'), 'VR');
  assert.equal(ahasRouteType('SR101'), 'SR');
  assert.equal(ahasRouteType('AR197H'), null);
});

test('ahasUrl single-quotes and encodes Area', () => {
  const u = ahasUrl('GetAHASRisk', 'IR', 'IR154', '2026-06-06T01:00:00Z');
  assert.ok(u.includes("/GetAHASRisk?Type=IR&Area=%27IR154%27"));
  assert.ok(u.includes('iMonth=6&iDay=6&iHour=1'));
  const a = ahasUrl('GetAHASRisk12', 'MILAIR', 'ALTUS AFB', '2026-06-06T01:00:00Z');
  assert.ok(a.includes("Area=%27ALTUS%20AFB%27"));
});

test('ahasAreaForIcao maps known bases, null otherwise', () => {
  assert.equal(ahasAreaForIcao('KLTS'), 'ALTUS AFB');
  assert.equal(ahasAreaForIcao('klts'), 'ALTUS AFB');
  assert.equal(ahasAreaForIcao('ZZZZ'), null);
});
