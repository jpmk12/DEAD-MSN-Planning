import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsnoOneDay, usnoOneDay, usnoDate, mergeUsno } from './usno.js';
import { nvgIllum } from './astro.js';

// A captured-shape USNO rstt/oneday payload (KLTS, 12 Jun 2026, tz=0). Times are
// "HH:MM" in the requested tz; the moon is a waning crescent near the new moon.
const USNO_FIXTURE = {
  apiversion: '4.0.1',
  properties: {
    data: {
      sundata: [
        { phen: 'Begin Civil Twilight', time: '11:00' },
        { phen: 'Rise', time: '11:25' },
        { phen: 'Upper Transit', time: '18:30' },
        { phen: 'Set', time: '01:38' },
        { phen: 'End Civil Twilight', time: '02:03' },
      ],
      moondata: [
        { phen: 'Rise', time: '09:10' },
        { phen: 'Upper Transit', time: '15:50' },
        { phen: 'Set', time: '22:40' },
      ],
      curphase: 'Waning Crescent',
      fracillum: '12%',
      closestphase: { phase: 'New Moon', day: 14, month: 6, year: 2026 },
    },
  },
};

test('usnoDate is the UTC calendar date of an instant', () => {
  assert.equal(usnoDate('2026-06-12T01:00:00Z'), '2026-06-12');
  // Just before UTC midnight stays on the prior day.
  assert.equal(usnoDate('2026-06-12T23:59:00Z'), '2026-06-12');
  assert.equal(usnoDate('2026-06-13T00:00:00Z'), '2026-06-13');
});

test('parseUsnoOneDay stitches HH:MM onto the queried date as Zulu ISO', () => {
  const p = parseUsnoOneDay(USNO_FIXTURE, '2026-06-12');
  assert.equal(p.source, 'USNO');
  assert.equal(p.events.sunrise, '2026-06-12T11:25:00Z');
  assert.equal(p.events.sunset, '2026-06-12T01:38:00Z');
  assert.equal(p.events.civilDawn, '2026-06-12T11:00:00Z');
  assert.equal(p.events.civilDusk, '2026-06-12T02:03:00Z');
  assert.equal(p.events.moonrise, '2026-06-12T09:10:00Z');
  assert.equal(p.events.moonset, '2026-06-12T22:40:00Z');
  assert.equal(p.moon.fraction, 0.12);
  assert.equal(p.moon.name, 'Waning Crescent');
  assert.equal(p.closestPhase, 'New Moon');
});

test('parseUsnoOneDay returns null for a payload without data', () => {
  assert.equal(parseUsnoOneDay({}, '2026-06-12'), null);
  assert.equal(parseUsnoOneDay(null, '2026-06-12'), null);
});

test('usnoOneDay: offline short-circuits, fetch failure -> null, success -> parsed', async () => {
  // Offline never touches the network.
  assert.equal(await usnoOneDay('2026-06-12T01:00:00Z', 34.7, -99.3, { offline: true }), null);

  // A throwing/!ok fetch yields null (computed values stand).
  const boom = async () => { throw new Error('network'); };
  assert.equal(await usnoOneDay('2026-06-12T01:00:00Z', 34.7, -99.3, { fetchImpl: boom }), null);
  const notOk = async () => ({ ok: false });
  assert.equal(await usnoOneDay('2026-06-12T01:00:00Z', 34.7, -99.3, { fetchImpl: notOk }), null);

  // A good response is parsed; the request carries the date + coords + tz=0.
  let seenUrl = null;
  const ok = async (u) => { seenUrl = u; return { ok: true, json: async () => USNO_FIXTURE }; };
  const r = await usnoOneDay('2026-06-12T01:00:00Z', 34.66797, -99.26775, { fetchImpl: ok });
  assert.equal(r.source, 'USNO');
  assert.equal(r.events.sunset, '2026-06-12T01:38:00Z');
  assert.match(seenUrl, /date=2026-06-12/);
  assert.match(seenUrl, /tz=0/);
  assert.match(seenUrl, /34\.6680/); // lat rounded to 4dp
});

test('mergeUsno overlays authoritative event times and tags the source', () => {
  const computed = nvgIllum('2026-06-12T05:00:00Z', 34.66797, -99.26775);
  assert.equal(computed.source, 'computed');
  const usno = parseUsnoOneDay(USNO_FIXTURE, '2026-06-12');
  const merged = mergeUsno(computed, usno);

  // USNO event times win; the band / millilux / lunar position stay computed.
  assert.equal(merged.events.sunset, '2026-06-12T01:38:00Z');
  assert.equal(merged.events.moonrise, '2026-06-12T09:10:00Z');
  assert.equal(merged.illumMlx, computed.illumMlx);
  assert.equal(merged.band, computed.band);
  assert.equal(merged.source, 'computed+USNO');
  assert.ok(merged.usno.fields.includes('sunset'));
  assert.equal(merged.usno.moon.name, 'Waning Crescent');

  // With no USNO data the computed result is returned untouched.
  const same = mergeUsno(computed, null);
  assert.equal(same.source, 'computed');
  assert.equal(same.usno, undefined);
});
