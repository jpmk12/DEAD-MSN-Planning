import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryTable, raimLine } from './refcard.js';

test('summaryTable: category/ceiling/vis/closure/RAIM cells + escaping', () => {
  const html = summaryTable([
    { icao: 'CYQX', label: '', flightCategory: 'IFR', ceilingFt: 400, visibilitySm: 1, closed: true, closedList: '13/31', raim: 'PREDICTED OUTAGE' },
    { icao: 'BIKF', label: '', flightCategory: 'VFR', ceilingFt: null, visibilitySm: 10, closed: false, closedList: '', raim: 'UNKNOWN' },
  ]);
  assert.match(html, /CYQX/);
  assert.match(html, /cat-IFR/);            // flight-category color class
  assert.match(html, /400 ft/);             // ceiling formatted
  assert.match(html, /RWY CLSD 13\/31/);    // closed runway idents shown
  assert.match(html, /OUTAGE/);             // RAIM outage tag
  assert.match(html, /cat-VFR/);
  // RAIM UNKNOWN renders as "?" not a false clear.
  assert.match(html, /<td class="">\?<\/td>/);
});

test('summaryTable escapes field-derived text (no HTML injection)', () => {
  const html = summaryTable([{ icao: '<b>X</b>', label: '"&', flightCategory: null, ceilingFt: null, visibilitySm: null, closed: false, raim: 'NO PREDICTED OUTAGE' }]);
  assert.ok(!html.includes('<b>X</b>'));
  assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
});

test('raimLine: status, outage windows, and empty for missing input', () => {
  assert.equal(raimLine(null), '');
  const clear = raimLine({ status: 'NO PREDICTED OUTAGE', windows: [] });
  assert.match(clear, /NO PREDICTED OUTAGE/);
  const out = raimLine({ status: 'PREDICTED OUTAGE', windows: [{ inlineRanges: [{ start: '1400Z', end: '1800Z' }] }] });
  assert.match(out, /PREDICTED OUTAGE/);
  assert.match(out, /1400Z–1800Z/);
  assert.match(raimLine({ status: 'UNKNOWN', windows: [] }), /UNKNOWN/);
});
