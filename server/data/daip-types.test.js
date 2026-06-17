import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daipTypePayload, areaPayload, parseDaipNotams, fetchGpsWaasNotams, fetchAreaNotams } from './daip.js';

test('daipTypePayload: sets type and overrides base fields', () => {
  const p = daipTypePayload('GPS_WAAS');
  assert.equal(p.type, 'GPS_WAAS');
  assert.equal(p.sort, 'Criticality');
  assert.equal(daipTypePayload('MOA', { acode: 'MOA' }).acode, 'MOA');
});

test('areaPayload: decimal lat/lon -> deg/min + N/S/E/W (matches DAIP capture)', () => {
  // 34.6167N / 035.65E  ->  34°37'N / 035°39'E
  const p = areaPayload(34.6167, 35.65, 50);
  assert.equal(p.type, 'AREA_BRIEFING');
  assert.equal(p.lat1, '34'); assert.equal(p.lat2, '37'); assert.equal(p.latdir, 'N');
  assert.equal(p.lng1, '35'); assert.equal(p.lng2, '39'); assert.equal(p.longdir, 'E');
  assert.equal(p.radius, '50');
  // Western/southern hemisphere flags.
  const w = areaPayload(-10.5, -140.25, 100);
  assert.equal(w.latdir, 'S'); assert.equal(w.longdir, 'W'); assert.equal(w.lng1, '140');
});

test('fetchGpsWaasNotams: parses the real GPS_WAAS capture (offline fixture)', async () => {
  const { notams, live, source } = await fetchGpsWaasNotams(true);
  assert.equal(live, false);
  assert.equal(source, 'fixture');
  assert.ok(notams.length >= 40, `expected the captured GPS NOTAMs, got ${notams.length}`);
  assert.ok(notams.some((n) => /PRN|U\/S|UNRELIABLE|UNSERVICEABLE/i.test(n.text)));
});

test('fetchAreaNotams: parses the real AREA_BRIEFING capture (offline fixture)', async () => {
  const { notams, live } = await fetchAreaNotams(34.6, 35.6, 50, true);
  assert.equal(live, false);
  assert.ok(notams.length >= 10, `expected area NOTAMs, got ${notams.length}`);
  assert.ok(notams.every((n) => n.icao && n.text));
});

test('parseDaipNotams tolerates an empty/odd body', () => {
  assert.deepEqual(parseDaipNotams({}), []);
  assert.deepEqual(parseDaipNotams('not json'), []);
});
