import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRibbonModel, fieldPhase, routePhase, xwSev, catSev, birdSev } from './ribbon.js';

const LIMITS = { xwind: 30, tailwind: 10 };

test('severity helpers map to go/caution/nogo', () => {
  assert.equal(xwSev(10, 30), 'go');
  assert.equal(xwSev(20, 30), 'caution'); // >= 60%
  assert.equal(xwSev(31, 30), 'nogo');
  assert.equal(catSev('VFR'), 'go');
  assert.equal(catSev('IFR'), 'caution');
  assert.equal(catSev('LIFR'), 'nogo');
  assert.equal(birdSev('MODERATE'), 'caution');
  assert.equal(birdSev('SEVERE'), 'nogo');
});

test('routePhase: AHAS + worst leg crosswind, convective marked not-assessed', () => {
  const d = { id: 'IR-154', type: 'IR', birdRisk: { level: 'MODERATE' },
    segments: [{ wind: { crosswindKt: 9 } }, { wind: { crosswindKt: 22 } }, { wind: null }] };
  const p = routePhase(d, '2026-06-11T19:00:00Z', LIMITS);
  assert.equal(p.status, 'CAUTION'); // MODERATE birds OR 22kt XW (>=60% of 30)
  assert.ok(p.chips.some((c) => c.k === 'BIRD MODERATE' && c.sev === 'caution'));
  assert.ok(p.chips.some((c) => c.k === 'XW 22'));
  assert.ok(p.chips.some((c) => c.k === 'CONV n/a' && c.sev === 'info'));
});

test('routePhase: along-route convective/SIGMET drives status when assessed', () => {
  // Convective SIGMET crossing the route -> NO-GO.
  const conv = routePhase({ id: 'IR-154', type: 'IR', routeWxChecked: true,
    hazardWx: [{ type: 'SIGMET', hazard: 'CONVECTIVE', distanceNm: 0, label: 'Convective', raw: 'CONVECTIVE SIGMET 21C ... TOPS FL450', validTo: '2026-06-13T05:00:00Z' }], convective: [] }, null, LIMITS);
  assert.equal(conv.status, 'NO-GO');
  const convChip = conv.chips.find((c) => c.k.startsWith('CONV SIGMET'));
  assert.ok(convChip && convChip.sev === 'nogo');
  // The warning links to the authoritative source and carries the raw text tip.
  assert.match(convChip.href, /aviationweather\.gov/);
  assert.match(convChip.tip, /CONVECTIVE SIGMET 21C/);

  // A high SPC outlook category near the route -> CAUTION.
  const enh = routePhase({ id: 'IR-154', type: 'IR', routeWxChecked: true,
    hazardWx: [], convective: [{ risk: 'ENH', distanceNm: 12 }] }, null, LIMITS);
  assert.equal(enh.status, 'CAUTION');

  // Clear route, assessment ran -> GO with a "CONV clear" chip (not "n/a").
  const clear = routePhase({ id: 'AR312L', type: 'AR', routeWxChecked: true, hazardWx: [], convective: [] }, null, LIMITS);
  assert.equal(clear.status, 'GO');
  assert.ok(clear.chips.some((c) => c.k === 'CONV clear'));
  assert.ok(!clear.chips.some((c) => c.k === 'CONV n/a'));

  // Not assessed (offline / no geometry) -> honest "CONV n/a".
  const na = routePhase({ id: 'AR312L', type: 'AR' }, null, LIMITS);
  assert.ok(na.chips.some((c) => c.k === 'CONV n/a' && c.sev === 'info'));
});

test('routePhase: icing/turbulence PIREPs on route show a caution chip with source + raw', () => {
  const d = { id: 'IR-154', type: 'IR', routeWxChecked: true, hazardWx: [], convective: [],
    pireps: [{ ice: true, turb: false, urgent: false, hazard: 'Icing', altFt: 3000, distanceNm: 12,
      obsTime: '2026-06-13T05:00:00Z', rawText: 'KLTS UA /FL030 /TP C17 /IC MOD RIME' }] };
  const p = routePhase(d, null, LIMITS);
  assert.equal(p.status, 'CAUTION');
  const chip = p.chips.find((c) => c.k.startsWith('PIREP'));
  assert.equal(chip.k, 'PIREP ICE 12NM');
  assert.equal(chip.sev, 'caution');
  assert.match(chip.href, /aviationweather\.gov/);
  assert.match(chip.tip, /MOD RIME/);
  // No PIREPs -> no PIREP chip.
  const none = routePhase({ id: 'IR-154', type: 'IR', routeWxChecked: true, hazardWx: [], convective: [], pireps: [] }, null, LIMITS);
  assert.ok(!none.chips.some((c) => c.k.startsWith('PIREP')));
});

test('routePhase: AR cross-track wind aloft is informational, never gating', () => {
  // 80 kt cross-track wind at the AR block — normal aloft, NOT a landing limit.
  const d = { id: 'AR312L', type: 'AR', birdRisk: { level: 'LOW' },
    segments: [{ wind: { crosswindKt: 80 } }] };
  const p = routePhase(d, '2026-06-11T17:00:00Z', LIMITS);
  assert.equal(p.status, 'GO'); // strong wind aloft does not force NO-GO on AR
  const xw = p.chips.find((c) => c.k.startsWith('XW'));
  assert.equal(xw.sev, 'info');
  assert.match(xw.k, /aloft/);
});

test('buildRibbonModel orders dep → AR → LL → recovery → alternate and carries status', () => {
  const data = { airfields: [
    { icao: 'KLTS', status: 'GO', statusSource: 'TAF@ETA',
      forecast: { active: { ident: '18R', crosswindKt: 6, gustCrosswindKt: 10 }, flightCategory: 'VFR' },
      birdRisk: { level: 'LOW' }, phase: { role: 'DEPARTURE', when: '2026-06-11T14:15:00Z', hideCurrentOnly: true } },
    { icao: 'KLTS', status: 'NO-GO', statusSource: 'TAF@ETA',
      forecast: { active: { ident: '18R', crosswindKt: 30, gustCrosswindKt: 38 }, flightCategory: 'IFR' },
      birdRisk: { level: 'MODERATE' }, statusReasons: ['Gust crosswind 38 kt on RWY 18R exceeds limit (30 kt).'],
      phase: { role: 'RECOVERY', when: '2026-06-11T20:15:00Z', hideCurrentOnly: true } },
    { icao: 'KAMA', status: 'GO', statusSource: 'TAF@ETA',
      forecast: { active: { ident: '04', crosswindKt: 8, gustCrosswindKt: 8 }, flightCategory: 'VFR' },
      birdRisk: { level: 'LOW' }, phase: { role: 'ALTERNATE', when: '2026-06-11T20:15:00Z', hideCurrentOnly: true } },
  ] };
  const routes = [
    { id: 'AR197H', type: 'AR', birdRisk: { level: 'LOW' }, segments: [{ wind: { crosswindKt: 5 } }] },
    { id: 'IR-154', type: 'IR', birdRisk: { level: 'MODERATE' }, segments: [{ wind: { crosswindKt: 12 } }] },
  ];
  const m = buildRibbonModel(data, routes, LIMITS, { arWhen: '2026-06-11T17:00:00Z', llWhen: '2026-06-11T19:00:00Z' });
  assert.deepEqual(m.map((p) => `${p.role}:${p.id}`), ['DEPARTURE:KLTS', 'AR:AR197H', 'IR:IR-154', 'RECOVERY:KLTS', 'ALTERNATE:KAMA']);
  // The decision: recovery NO-GO (38kt gust XW) while the alternate is GO.
  assert.equal(m.find((p) => p.role === 'RECOVERY').status, 'NO-GO');
  assert.equal(m.find((p) => p.role === 'ALTERNATE').status, 'GO');
  // AR and LL phases carry their OWN entry times.
  assert.equal(m.find((p) => p.id === 'AR197H').when, '2026-06-11T17:00:00Z');
  assert.equal(m.find((p) => p.id === 'IR-154').when, '2026-06-11T19:00:00Z');
  // Far-future phases hide now-cast convective/SIGMET honestly.
  assert.ok(m[0].chips.some((c) => c.k === 'now-cast n/a'));
});

test('fieldPhase uses current METAR when not future', () => {
  const b = { icao: 'KCHS', status: 'CAUTION', statusSource: 'METAR',
    analysis: { active: { ident: '03', crosswindKt: 21, gustCrosswindKt: null } },
    currentConditions: { flightCategory: 'MVFR' }, birdRisk: { level: 'LOW' },
    convective: [], hazardWx: [], pireps: [], phase: { role: 'DEPARTURE', when: null, hideCurrentOnly: false } };
  const p = fieldPhase(b, LIMITS);
  assert.equal(p.source, 'METAR');
  assert.ok(p.chips.some((c) => c.k === 'XW 21' && c.sev === 'caution'));
  assert.ok(p.chips.some((c) => c.k === 'MVFR'));
});
