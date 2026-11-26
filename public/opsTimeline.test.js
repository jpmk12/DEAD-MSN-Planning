import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpsTimeline, windowsWithNotams, sliceAt, changePoints,
  wxFromTaf, wxFromWmo, windChillC, visCategory, labelSeverity,
} from './opsTimeline.js';

const HOUR = 3600000;
const START = Date.UTC(2026, 10, 26, 12, 0, 0); // Thu 26 Nov 2026 12:00Z (top of hour)
const LAT = 40, LON = -75;
const at = (h) => START + h * HOUR;

// A model ProfileHour with sane defaults; override per test.
const H = (i, over = {}) => ({
  t: at(i), tempC2m: 10, dewC: 4, feelsC: 10, freezingLevelM: 3000, weatherCode: 0,
  precipMm: 0, snowCm: 0, windDir: 270, windKt: 8, gustKt: null, visM: 12000, levels: [], ...over,
});
const modelHours = (n, fn = () => ({})) => Array.from({ length: n }, (_, i) => H(i, fn(i)));
const base = (fromH, toH, over = {}) => ({ fromMs: at(fromH), toMs: at(toH), changeType: '', flightCategory: 'VFR', ...over });
const RWY = [{ ident: '09', headingDegT: 90 }, { ident: '27', headingDegT: 270 }];

const laneSeg = (tl, key, ms) => tl.lanes.find((l) => l.key === key)?.segs.find((s) => ms >= s.fromMs && ms < s.toMs) || null;

// 1 — weather vocabulary
test('wxFromTaf / wxFromWmo weather vocabulary', () => {
  assert.equal(wxFromTaf('-FZRA BR'), 'fzra');
  assert.equal(wxFromTaf('TSRA'), 'thunder');
  assert.equal(wxFromTaf('+RA'), 'heavyrain');
  assert.equal(wxFromTaf('BLSN'), 'none');
  assert.equal(wxFromTaf('NSW'), 'none');
  assert.equal(wxFromTaf('-SHSN'), 'snow');
  assert.equal(wxFromTaf('FZFG'), 'fzfog');
  assert.equal(wxFromWmo(67), 'fzra');
  assert.equal(wxFromWmo(73), 'snow');
  assert.equal(wxFromWmo(95), 'thunder');
  assert.equal(wxFromWmo(45), 'fog');
  assert.equal(visCategory(800), 'LIFR');
  assert.equal(visCategory(12000), 'VFR');
});

// 2 — wind chill
test('windChillC: cold + wind drops below -30; warm/calm unchanged', () => {
  assert.ok(windChillC(-20, 25) < -30);
  assert.equal(windChillC(15, 25), 15); // warm air unchanged
  assert.equal(windChillC(-20, 1), -20); // near-calm unchanged
});

// 3 — freezing rain lights Precip/Ground-ice/Runway; one window ordered Runway › Ground-ice › Sky
test('TAF freezing rain → Precip/Ground-ice/Runway amber; window factors ordered', () => {
  const tl = buildOpsTimeline({
    nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 12, runways: RWY,
    taf: [base(0, 12, { flightCategory: 'IFR', wxRaw: '-FZRA' })],
    hours: modelHours(12, () => ({ tempC2m: -1, dewC: -2, visM: 2000 })),
  });
  assert.equal(laneSeg(tl, 'precip', at(1)).label, 'FZRA');
  assert.equal(laneSeg(tl, 'precip', at(1)).tone, 'a');
  assert.equal(laneSeg(tl, 'deice', at(1)).label, 'DE/ANTI-ICE');
  assert.equal(laneSeg(tl, 'runway', at(1)).label, 'ICE');
  assert.equal(laneSeg(tl, 'sky', at(1)).label, 'IFR');
  assert.equal(tl.windows.length, 1);
  const lanes = tl.windows[0].factors.map((f) => f.lane);
  assert.equal(lanes[0], 'runway');
  assert.ok(lanes.includes('deice') && lanes.includes('sky'));
  assert.ok(!lanes.includes('precip'), 'precip dropped when others explain it');
});

// 4 — nothing outside the crosswind lane is ever red
test('no lane but Crosswind is ever red, even in an extreme model hour', () => {
  const tl = buildOpsTimeline({
    nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 8, runways: [{ ident: '18', headingDegT: 180 }],
    taf: null,
    hours: modelHours(8, () => ({ tempC2m: -30, dewC: -31, weatherCode: 95, precipMm: 30, windDir: 270, windKt: 50, gustKt: 55, visM: 12000 })),
  });
  for (const lane of tl.lanes) {
    if (lane.key === 'xwind') continue;
    assert.ok(lane.segs.every((s) => s.tone !== 'r'), `${lane.key} has no red`);
  }
  assert.ok(tl.lanes.find((l) => l.key === 'xwind').segs.some((s) => s.tone === 'r'), 'crosswind can be red');
});

// 5 — the TAF governs its window (model wx inside a dry TAF draws nothing; BECMG gap = prior period)
test('TAF governs: model rain inside a dry TAF hour draws nothing; BECMG gap keeps prior period', () => {
  const dry = buildOpsTimeline({
    nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 6, runways: RWY,
    taf: [base(0, 6, { flightCategory: 'VFR', wxRaw: '' })],
    hours: modelHours(6, () => ({ weatherCode: 63, precipMm: 2 })), // model says rain
  });
  assert.equal(laneSeg(dry, 'precip', at(2)), null, 'TAF dry → precip empty despite model rain');

  // BECMG [2,4] then a gap until a later base [10,12]: the BECMG period prevails
  // across the gap (hour 7), never falling back to the model rain, inside the TAF.
  const becmg = buildOpsTimeline({
    nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 12, runways: RWY,
    taf: [
      base(0, 2, { flightCategory: 'VFR', wxRaw: '' }),
      base(2, 4, { changeType: 'BECMG', flightCategory: 'MVFR', wxRaw: '-SN' }),
      base(10, 12, { changeType: 'FM', flightCategory: 'VFR', wxRaw: '' }),
    ],
    hours: modelHours(12, () => ({ tempC2m: -1, weatherCode: 63, precipMm: 2 })),
  });
  assert.equal(laneSeg(becmg, 'precip', at(7)).label, 'SN', 'BECMG snow prevails in the gap, not model rain');
});

// 6 — frost is a note and never a window; refreeze after rain then ≤ 0 °C
test('frost is a note (never a window); refreeze after wet-then-freezing', () => {
  const frost = buildOpsTimeline({
    nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 6, runways: RWY, taf: null,
    hours: modelHours(6, () => ({ tempC2m: -2, dewC: -3, weatherCode: 0, precipMm: 0, windKt: 2 })),
  });
  assert.equal(laneSeg(frost, 'deice', at(2)).label, 'FROST');
  assert.equal(laneSeg(frost, 'deice', at(2)).tone, 'i');
  assert.equal(frost.windows.length, 0, 'frost never forms a window');

  const refreeze = buildOpsTimeline({
    nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 8, runways: RWY, taf: null,
    hours: modelHours(8, (i) => i < 3
      ? { tempC2m: 3, weatherCode: 63, precipMm: 1 }      // wet & warm
      : { tempC2m: -2, dewC: -5, weatherCode: 0, precipMm: 0 }), // then freezing & dry
  });
  assert.equal(laneSeg(refreeze, 'runway', at(5)).label, 'REFREEZE');
});

// 7 — snow cm, standing water, glaze vs "near 0°"
test('snow accumulation, standing water, glaze vs near-0 note', () => {
  const snow = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 4, runways: RWY, taf: null,
    hours: modelHours(4, () => ({ tempC2m: -1, weatherCode: 73, snowCm: 2, precipMm: 1 })) });
  assert.equal(laneSeg(snow, 'runway', at(1)).label, 'SNOW');
  assert.match(laneSeg(snow, 'runway', at(1)).detail, /cm\/h/);

  const water = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 4, runways: RWY, taf: null,
    hours: modelHours(4, () => ({ tempC2m: 12, weatherCode: 65, precipMm: 6 })) });
  assert.equal(laneSeg(water, 'runway', at(1)).label, 'WATER');

  const glaze = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 4, runways: RWY, taf: null,
    hours: modelHours(4, () => ({ tempC2m: -1, weatherCode: 61, precipMm: 1 })) });
  assert.equal(laneSeg(glaze, 'deice', at(1)).label, 'GLAZE');

  const near0 = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 4, runways: RWY, taf: null,
    hours: modelHours(4, () => ({ tempC2m: 1.5, weatherCode: 61, precipMm: 1 })) });
  assert.equal(laneSeg(near0, 'deice', at(1)).label, 'near 0°');
  assert.equal(laneSeg(near0, 'deice', at(1)).tone, 'i');
});

// 8 — crosswind: contamination raises to amber; no headings → UNKNOWN
test('crosswind: contamination raises a 15-kt crosswind to amber; no headings → UNKNOWN lane', () => {
  const tl = buildOpsTimeline({
    nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 4, runways: [{ ident: '36', headingDegT: 360 }],
    taf: null,
    hours: modelHours(4, () => ({ tempC2m: -1, weatherCode: 73, snowCm: 1, precipMm: 1, windDir: 90, windKt: 16, gustKt: null })),
  });
  assert.equal(laneSeg(tl, 'runway', at(1)).tone, 'a'); // SNOW = contaminated
  assert.equal(laneSeg(tl, 'xwind', at(1)).tone, 'a', '16-kt crosswind amber on a contaminated runway');

  const noHd = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 4, runways: [], taf: null,
    hours: modelHours(4, () => ({ windDir: 90, windKt: 30 })) });
  assert.equal(noHd.lanes.find((l) => l.key === 'xwind').unknown, 'no runway headings');
});

// 9 — icing: a TAF group wins over the model; model "likely" amber only ≤ 12 h
test('icing: TAF group beats model; model likely amber only within 12 h', () => {
  const grp = buildOpsTimeline({
    nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 6, runways: RWY, taf: [base(0, 6, { flightCategory: 'VFR' })],
    tafGroups: [{ intensity: 'moderate', type: 'rime in cloud', baseFtAgl: 3000, topFtAgl: 8000, fromMs: at(0), toMs: at(6), change: '', code: '640305' }],
    hours: modelHours(6, () => ({ levels: [{ hPa: 850, heightM: 1500, tempC: -5, rh: 96 }] })),
  });
  assert.equal(laneSeg(grp, 'icing', at(2)).label, 'MOD ICE');
  assert.equal(laneSeg(grp, 'icing', at(2)).src, 'taf');

  const mdl = buildOpsTimeline({
    nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 24, runways: RWY, taf: null,
    hours: modelHours(24, () => ({ levels: [{ hPa: 850, heightM: 1500, tempC: -5, rh: 96 }] })),
  });
  assert.equal(laneSeg(mdl, 'icing', at(2)).tone, 'a', 'likely within 12 h → amber');
  assert.equal(laneSeg(mdl, 'icing', at(20)).tone, 'i', 'likely beyond 12 h → note');
});

// 10 — sky beyond the TAF is visibility only; no TAF + no model → live:false
test('sky beyond the TAF is vis-only; no TAF and no model → live:false', () => {
  const tl = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 4, runways: RWY, taf: null,
    hours: modelHours(4, () => ({ visM: 2000 })) });
  const s = laneSeg(tl, 'sky', at(1));
  assert.equal(s.label, 'IFR vis');
  assert.equal(s.dashed, true);

  const dead = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, horizonH: 4, runways: RWY, taf: null, hours: null });
  assert.equal(dead.live, false);
  assert.match(dead.summary, /UNKNOWN/);
});

// 11 — windows merge touching/overlapping; one factor per lane; labelSeverity exactness
test('windows merge touching hits; one factor per lane; labelSeverity is exact', () => {
  assert.ok(labelSeverity('ICE') > labelSeverity('ICE likely'));
  assert.equal(labelSeverity('ICE LIKELY'), 6);
  assert.equal(labelSeverity('G35'), 5);
  assert.ok(labelSeverity('WC -30°') === 6);
  // Two adjacent amber hours in one lane form a single window with one factor.
  const tl = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 6, runways: RWY, taf: null,
    hours: modelHours(6, () => ({ tempC2m: -1, weatherCode: 73, snowCm: 1, precipMm: 1 })) });
  assert.equal(tl.windows.length, 1);
  assert.equal(tl.windows[0].factors.filter((f) => f.lane === 'runway').length, 1);
});

// 12 — NOTAM closure leads its window; indeterminate joins none; short "CLSD"
test('NOTAM closure leads its window; indeterminate schedule joins none', () => {
  // Benign weather so the only windows come from the NOTAM closures.
  const tl = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 12, runways: RWY, taf: null,
    hours: modelHours(12) });
  const closed = { fromMs: at(1), toMs: at(3), kind: 'closure', label: 'RWY 09/27', text: 'RWY 09/27 CLSD' };
  const sched = { fromMs: at(5), toMs: at(6), kind: 'closure', label: 'TWY A', text: 'TWY A CLSD DLY', indeterminate: true };
  const { lane, windows } = windowsWithNotams(tl, [closed, sched]);
  assert.equal(lane.segs.find((s) => s.fromMs === at(1)).short, 'CLSD');
  const w = windows.find((x) => at(1) >= x.fromMs && at(1) < x.toMs);
  assert.equal(w.factors[0].lane, 'notam', 'NOTAM leads the window');
  assert.ok(lane.segs.find((s) => s.tone === 'u' && s.label === 'SCHED'), 'indeterminate is a dashed SCHED');
  assert.ok(!windows.some((x) => at(5) >= x.fromMs && at(5) < x.toMs), 'indeterminate joins no window');
});

// 13 — TAF freezing rain over +6 °C model air says the sources disagree
test('TAF freezing rain over +6 °C model air states the disagreement', () => {
  const tl = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 4, runways: RWY,
    taf: [base(0, 4, { flightCategory: 'IFR', wxRaw: '-FZRA' })],
    hours: modelHours(4, () => ({ tempC2m: 6 })) });
  assert.match(laneSeg(tl, 'deice', at(1)).detail, /disagree/);
});

// 14 — sliceAt: rows in display order, window + time to clear, next, UNKNOWN, clamp, null
test('sliceAt reads lanes in display order with window + next; null when not live', () => {
  const tl = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 12, runways: RWY, taf: null,
    hours: modelHours(12, (i) => i >= 2 && i < 5 ? { tempC2m: -1, weatherCode: 73, snowCm: 1, precipMm: 1 } : {}) });
  const s = sliceAt(tl, [], tl.windows, at(3) + 600000);
  assert.deepEqual(s.rows.map((r) => r.key), ['sky', 'precip', 'temp', 'deice', 'runway', 'icing', 'xwind', 'ramp', 'notam']);
  assert.ok(s.window && s.window.leftMs > 0);
  assert.equal(s.rows.find((r) => r.key === 'notam').text, 'no closure in effect');
  // Outside the window: next points ahead.
  const before = sliceAt(tl, [], tl.windows, at(0) + 600000);
  assert.ok(before.next && before.next.inMs > 0);
  assert.equal(before.rows.find((r) => r.key === 'runway').text, 'nothing limiting');
  // Clamp + null.
  assert.equal(sliceAt(tl, [], tl.windows, START - 10 * HOUR).ms, START);
  assert.equal(sliceAt({ live: false }, [], [], START), null);
});

// 15 — changePoints: every edge + crossing, sorted, inside the horizon
test('changePoints returns sorted edges + 0 °C crossings inside the horizon', () => {
  const tl = buildOpsTimeline({ nowMs: START, lat: LAT, lon: LON, elevationM: 0, horizonH: 10, runways: RWY, taf: null,
    hours: modelHours(10, (i) => i < 4 ? { tempC2m: 3, weatherCode: 73, snowCm: 1, precipMm: 1 } : { tempC2m: -2 }) });
  const cps = changePoints(tl, []);
  assert.ok(cps.length > 0);
  for (let i = 1; i < cps.length; i++) assert.ok(cps[i] > cps[i - 1], 'strictly sorted');
  assert.ok(cps.every((ms) => ms > tl.startMs && ms < tl.startMs + tl.hours * HOUR));
  assert.ok(cps.includes(at(4)), 'includes the 0 °C crossing / snow edge at hour 4');
});
