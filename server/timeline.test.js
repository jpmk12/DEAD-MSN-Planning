import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hourRange, buildTimeline } from './timeline.js';

const FIX = JSON.parse(readFileSync(fileURLToPath(new URL('../data/fixtures/caddo10.json', import.meta.url)), 'utf8'));
const NIGHT = JSON.parse(readFileSync(fileURLToPath(new URL('../data/fixtures/caddo10n.json', import.meta.url)), 'utf8'));

test('hourRange covers now + all stops, hourly, capped', () => {
  const nowMs = Date.parse('2026-06-11T12:00:00Z');
  const hours = hourRange(FIX.stops, nowMs);
  assert.equal(hours[0], '2026-06-11T12:00:00.000Z'); // includes "now"
  assert.ok(hours.includes('2026-06-11T14:00:00.000Z'), 'covers takeoff hour');
  assert.ok(hours.includes('2026-06-11T20:00:00.000Z'), 'covers recovery hour');
  assert.ok(hours.length <= 18);
  // no stops -> 12h from now
  assert.equal(hourRange([], nowMs).length, 13);
});

test('hourRange adapts the step so a long sortie always reaches landing', () => {
  const now = Date.parse('2026-06-11T12:00:00Z');
  // 26h day: takeoff 14Z, landing next day 16Z -> window ~12Z..18Z+1d (~30h).
  const longStops = [
    { when: '2026-06-11T14:00:00Z' },
    { when: '2026-06-12T16:00:00Z' },
  ];
  const hours = hourRange(longStops, now, 16);
  assert.ok(hours.length <= 17, `cols ${hours.length} within budget`);
  // The landing window (+2h buffer) is the last column — never cut off.
  assert.equal(hours[hours.length - 1], '2026-06-12T18:00:00.000Z');
  // Columns are >1h apart (bucketed) for the long span.
  const step = (Date.parse(hours[1]) - Date.parse(hours[0])) / 3600000;
  assert.ok(step >= 2, `step ${step}`);
});

test('CADDO10 timeline: METAR governs near-now, TAF governs the window, degradation drives a divert decision', async () => {
  const tl = await buildTimeline({ stops: FIX.stops, routes: FIX.routes, inject: FIX });
  const klts = tl.fields.find((f) => f.icao === 'KLTS');
  const kama = tl.fields.find((f) => f.icao === 'KAMA');
  assert.ok(klts.found && kama.found);
  const at = (row, hh) => row.cells.find((c) => c.t.startsWith(`2026-06-11T${hh}`));

  // 12Z (now): current METAR governs, mild wind nearly down 18s -> GO.
  const noon = at(klts, '12');
  assert.equal(noon.source, 'METAR');
  assert.equal(noon.status, 'GO');

  // 1415Z takeoff hour (2h15 out): TAF prevailing 17012KT -> GO, runway 18 side.
  const tko = at(klts, '14');
  assert.equal(tko.source, 'TAF');
  assert.equal(tko.status, 'GO');
  assert.ok(['18L', '18R'].includes(tko.active));

  // 18Z: FM111800 19018G28KT -> still inside limits -> GO/CAUTION but not NO-GO.
  const six = at(klts, '18');
  assert.equal(six.source, 'TAF');
  assert.notEqual(six.status, 'NO-GO');

  // 2015Z recovery: BECMG 09025G38KT -> ~38 kt gust crosswind on 18/36 ->
  // exceeds the 30 kt placeholder limit -> NO-GO at home plate...
  const rec = at(klts, '20');
  assert.equal(rec.source, 'TAF');
  assert.equal(rec.status, 'NO-GO');
  assert.ok(/exceeds/.test(rec.warn), rec.warn);
  // ...while the alternate stays GO at the same hour = the divert decision.
  const altRec = at(kama, '20');
  assert.equal(altRec.status, 'GO');

  // Route AHAS rows carry the hourly bird levels (IR-154 MODERATE at entry).
  const ir = tl.routes.find((r) => r.id === 'IR-154');
  const irEntry = ir.cells.find((c) => c.t.startsWith('2026-06-11T19'));
  assert.equal(irEntry.bird, 'MODERATE');

  // Hours with no source are UNAVAILABLE (null), never fabricated.
  assert.ok(klts.cells.every((c) => c.status !== undefined));
});

test('CADDO10-NIGHT: NVG timeline carries an illumination band that goes day -> night LOW', async () => {
  const tl = await buildTimeline({ stops: NIGHT.stops, routes: NIGHT.routes, nvg: NIGHT.nvg, inject: NIGHT });
  assert.equal(tl.nvg, true);
  const klts = tl.fields.find((f) => f.icao === 'KLTS');
  assert.ok(Array.isArray(klts.illum), 'illum band present when nvg on');
  const at = (hh) => klts.illum.find((g) => g.t.startsWith(`2026-06-12T${hh}`));

  // 00Z/01Z the sun is still up (June, KLTS) -> daylight band.
  assert.equal(at('00').band, 'day');
  // Deep night (05Z ~ local midnight): night band, and with the moon below the
  // horizon near the new moon the call is LOW (AFI 11-214 < 2.2 mlx).
  const deep = at('05');
  assert.equal(deep.band, 'night');
  assert.equal(deep.class, 'LOW');
  assert.ok(deep.mlx < 2.2, `mlx ${deep.mlx} should be LOW`);
  assert.equal(deep.moonUp, false, 'moonless night drives the LOW call');

  // The transition is monotonic-ish: a twilight column exists between them.
  assert.ok(klts.illum.some((g) => g.band === 'twilight'), 'a twilight column appears');
});

test('NVG off -> no illumination band on the timeline (feature is opt-in)', async () => {
  const tl = await buildTimeline({ stops: NIGHT.stops, routes: NIGHT.routes, inject: NIGHT });
  assert.equal(tl.nvg, false);
  assert.equal(tl.fields.find((f) => f.icao === 'KLTS').illum, null);
});

test('timeline cells are honest when a field has no data at an hour', async () => {
  const tl = await buildTimeline({
    stops: [{ icao: 'KLTS', when: '2026-06-11T14:15:00Z', role: 'DEPARTURE', label: 'Takeoff' }],
    inject: { now: FIX.now, airports: FIX.airports, metars: {}, tafs: {}, birds: {} },
  });
  const klts = tl.fields[0];
  assert.ok(klts.cells.every((c) => c.status === null && c.source === null));
});
