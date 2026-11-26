import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plannerExportHtml } from './plannerExport.js';

const HOUR = 3600000;
const START = Date.UTC(2026, 10, 26, 0, 0, 0);

const sampleData = {
  startMs: START, horizonH: 24,
  fields: [
    {
      icao: 'KCHS', name: 'Charleston', live: true, hours: 24, tafEndMs: START + 18 * HOUR,
      temp: { minC: -3, maxC: 5, crossings: [{ t: START + 6 * HOUR, dir: 'down' }] },
      temps: Array.from({ length: 24 }, (_, i) => ({ t: START + i * HOUR, c: 5 - i * 0.3, dew: 1 - i * 0.3, feels: 4 - i * 0.3, fzlFtAgl: 1500 })),
      events: [{ icao: 'KCHS', kind: 'ETD', ms: START + 4 * HOUR }],
      windows: [{ fromMs: START + 5 * HOUR, toMs: START + 9 * HOUR, tone: 'a', factors: [{ lane: 'runway', label: 'ICE', detail: 'braking poor' }], text: 'Thu 26 05Z–09Z — Runway: ICE braking poor' }],
      lanes: [
        { key: 'sky', title: 'Sky', segs: [{ fromMs: START, toMs: START + 24 * HOUR, tone: 'a', label: 'IFR', detail: 'IFR (TAF)', dashed: false, cat: 'IFR' }], unknown: null },
        { key: 'runway', title: 'Runway', segs: [{ fromMs: START + 5 * HOUR, toMs: START + 9 * HOUR, tone: 'a', label: 'ICE', short: 'ICE', detail: 'ice on the runway, braking poor', dashed: false }], unknown: null },
        { key: 'notam', title: 'NOTAMs', segs: [{ fromMs: START + 2 * HOUR, toMs: START + 4 * HOUR, tone: 'a', label: 'RWY 15/33 CLSD', short: 'CLSD', detail: '<script>alert(1)</script> RWY 15/33 CLSD', dashed: false }], unknown: null },
      ],
    },
    { icao: 'KEDW', name: 'Edwards', live: false },
  ],
};

test('plannerExportHtml produces a self-contained, SCRIPT-FREE document', () => {
  const html = plannerExportHtml(sampleData);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('<style>') && html.includes('</style>'), 'has inline styles');
  assert.ok(!/<script/i.test(html), 'contains no <script> — static briefing packet');
  assert.match(html, /NEXT 24 H/);
  assert.match(html, /KCHS/);
  assert.match(html, /Charleston/);
});

test('plannerExportHtml escapes external content (NOTAM/model text)', () => {
  const html = plannerExportHtml(sampleData);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'the NOTAM markup is escaped, not injected');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('plannerExportHtml renders lanes, windows, and marks an UNAVAILABLE field', () => {
  const html = plannerExportHtml(sampleData);
  assert.match(html, /Limiting windows/);
  assert.match(html, /Runway: ICE braking poor/);
  assert.match(html, /class="t"/); // inline temperature SVG
  assert.match(html, /UNAVAILABLE/); // KEDW
});
