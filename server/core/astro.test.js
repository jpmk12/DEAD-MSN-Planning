import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sunMoonEvents, moonIllumination, moonAltAz, groundIlluminanceMlx,
  illumClass, isDaylight, nvgIllum, EVENT_ALT, illumPoint, illumTrend,
} from './astro.js';

const KLTS = [34.667, -99.268];
const hh = (iso) => (iso ? iso.slice(11, 16) : null);
const minsApart = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 60000);

test('illumClass uses the AFI 11-214 thresholds (LOW 0-2.1, HIGH >=2.2)', () => {
  assert.equal(illumClass(0), 'LOW');
  assert.equal(illumClass(2.1), 'LOW');
  assert.equal(illumClass(2.19), 'LOW');
  assert.equal(illumClass(2.2), 'HIGH');
  assert.equal(illumClass(50), 'HIGH');
});

test('moon phase matches the 2026 lunar calendar (independently known dates)', () => {
  // Full moon ~2026-06-29, new moon ~2026-06-14, full ~2026-01-03.
  assert.ok(moonIllumination('2026-06-29T12:00:00Z').fraction > 0.97, 'near-full');
  assert.ok(moonIllumination('2026-06-14T12:00:00Z').fraction < 0.05, 'near-new');
  assert.ok(moonIllumination('2026-01-03T12:00:00Z').fraction > 0.97, 'near-full');
  assert.match(moonIllumination('2026-06-29T12:00:00Z').name, /Full/);
});

test('sun events at KLTS: solstice day length + twilight ordering', () => {
  const jun = sunMoonEvents('2026-06-11T12:00:00Z', ...KLTS);
  const dec = sunMoonEvents('2026-12-21T12:00:00Z', ...KLTS);
  const dayLen = (e) => (Date.parse(e.sunset) > Date.parse(e.sunrise)
    ? Date.parse(e.sunset) - Date.parse(e.sunrise)
    : Date.parse(e.sunset) + 86400000 - Date.parse(e.sunrise)) / 3600000;
  const jLen = dayLen(jun), dLen = dayLen(dec);
  assert.ok(jLen > 13.5 && jLen < 14.5, `June day ~14h (got ${jLen.toFixed(1)})`);
  assert.ok(dLen > 9.5 && dLen < 10.5, `Dec day ~10h (got ${dLen.toFixed(1)})`);
  // BMNT (dawn) before sunrise; sunset before EENT (dusk).
  assert.ok(Date.parse(jun.bmnt) < Date.parse(jun.sunrise), 'BMNT before sunrise');
  assert.ok(Date.parse(jun.eent) > Date.parse(jun.sunset), 'EENT after sunset');
  // Nautical twilight (BMNT/EENT) is further from sunrise/sunset than civil.
  assert.ok(minsApart(jun.bmnt, jun.sunrise) > minsApart(jun.civilDawn, jun.sunrise));
});

test('ground illuminance: bright by day, near the starlight floor on a moonless night', () => {
  const noon = groundIlluminanceMlx('2026-06-11T18:00:00Z', ...KLTS); // ~13L
  assert.ok(noon.mlx > 1e6, 'daylight is huge (mlx)');
  assert.equal(isDaylight('2026-06-11T18:00:00Z', ...KLTS), true);
  // New-moon deep night -> only starlight/airglow -> LOW, ~0.2 mlx.
  const darkNight = groundIlluminanceMlx('2026-06-14T07:00:00Z', ...KLTS);
  assert.ok(darkNight.mlx < 2.2, `moonless night is LOW (got ${darkNight.mlx})`);
  assert.equal(illumClass(darkNight.mlx), 'LOW');
});

test('lunar position drives illumination: full moon up = HIGH, new moon = LOW (deep night)', () => {
  // Deep night (no twilight) so only moon + starlight matter. Full moon high
  // overhead vs a moonless (new-moon) night.
  const fullUp = groundIlluminanceMlx('2026-06-29T06:00:00Z', ...KLTS); // moon ~+27, disk ~99%
  const newMoon = groundIlluminanceMlx('2026-06-14T07:00:00Z', ...KLTS); // disk ~1%, moon down
  assert.ok(fullUp.moonAltDeg > 10 && fullUp.sunAltDeg < -18, 'full moon up, deep night');
  assert.equal(illumClass(fullUp.mlx), 'HIGH');
  assert.equal(illumClass(newMoon.mlx), 'LOW');
  assert.ok(fullUp.mlx > newMoon.mlx * 50, `moon dominates (${fullUp.mlx} vs ${newMoon.mlx})`);
  // A full moon BELOW the horizon (daytime here) adds nothing beyond the sun's
  // own value — the moon term keys off altitude, not disk %.
  assert.ok(moonAltAz('2026-06-29T16:00:00Z', ...KLTS).altDeg < 0, 'moon down at 16Z despite 99% disk');
});

test('nvgIllum returns a complete, labeled, computed picture', () => {
  const n = nvgIllum('2026-06-29T06:00:00Z', ...KLTS);
  assert.equal(n.source, 'computed');
  assert.ok(['day', 'twilight', 'night'].includes(n.band));
  assert.ok(['LOW', 'HIGH'].includes(n.illumClass));
  assert.equal(typeof n.illumMlx, 'number');
  assert.ok(n.moon && typeof n.moon.fraction === 'number' && typeof n.moon.altDeg === 'number');
  assert.ok(n.events.sunset && n.events.bmnt);
  assert.equal(nvgIllum('x', null, null), null);
});

test('moon rise/set are always populated for a night that spans UTC midnight', () => {
  // A night sortie 01Z..07Z: the relevant moonrise/moonset can land on adjacent
  // UTC days. Anchoring on the instant must still return both events.
  for (const when of ['2026-06-12T05:00:00Z', '2026-06-29T03:00:00Z', '2026-01-15T23:30:00Z']) {
    const ev = sunMoonEvents(when, ...KLTS);
    assert.ok(ev.moonrise, `moonrise present @ ${when}`);
    assert.ok(ev.moonset, `moonset present @ ${when}`);
    // The chosen events are within ~a day of the phase time (nearest crossings).
    const dt = (iso) => Math.abs(Date.parse(iso) - Date.parse(when)) / 3600000;
    assert.ok(dt(ev.moonrise) <= 15, `moonrise near phase @ ${when}`);
    assert.ok(dt(ev.moonset) <= 15, `moonset near phase @ ${when}`);
  }
});

test('illumTrend samples the window and tracks the day->night drop', () => {
  // Evening into night at KLTS: 00Z (sun up) -> 06Z (deep night).
  const pts = illumTrend('2026-06-12T00:00:00Z', '2026-06-12T06:00:00Z', ...KLTS, 30);
  assert.ok(pts.length >= 10 && pts.length <= 48);
  assert.equal(pts[0].band, 'day');
  const last = pts[pts.length - 1];
  assert.equal(last.band, 'night');
  assert.ok(last.mlx < pts[0].mlx, 'illumination falls from day to night');
  // illumPoint agrees with a direct sample and skips the events search.
  const p = illumPoint('2026-06-12T06:00:00Z', ...KLTS);
  assert.equal(p.class, illumClass(p.mlx));
  assert.ok(!('events' in p));
  // Bad/empty window -> empty array.
  assert.equal(illumTrend('2026-06-12T06:00:00Z', '2026-06-12T00:00:00Z', ...KLTS).length, 0);
});
