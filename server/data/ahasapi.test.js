import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAhasLevel, parseAhasSeries, parseAhasHourly, parseAhasRouteMatrix, ahasRouteType, ahasUrl, ahasAreaForIcao, ahasHasRoute, ahasRunAtIso } from './ahasapi.js';

test('ahasRunAtIso floors to the requested Zulu hour', () => {
  assert.equal(ahasRunAtIso('2026-06-06T18:42:30Z'), '2026-06-06T18:00:00.000Z');
  assert.equal(ahasUrl('GetAHASRisk', 'IR', 'IR154', '2026-06-06T18:42:30Z').includes('iHour=18'), true);
});

test('parseAhasLevel extracts the worst level present', () => {
  assert.equal(parseAhasLevel('<string>LOW</string>'), 'LOW');
  assert.equal(parseAhasLevel('risk: MODERATE today'), 'MODERATE');
  assert.equal(parseAhasLevel('SEVERE'), 'SEVERE');
  // worst wins when several appear (e.g. a 12-hour list)
  assert.equal(parseAhasLevel('LOW LOW MODERATE LOW SEVERE LOW'), 'SEVERE');
  assert.equal(parseAhasLevel('no risk words'), null);
  assert.equal(parseAhasLevel(''), null);
});

test('parseAhasSeries reads the hourly levels in order, from the data rows only', () => {
  const xml = '<DataSet><xs:schema><xs:element name="SEVERE_LABEL"/></xs:schema>'
    + '<NewDataSet>' + ['LOW', 'LOW', 'MODERATE', 'SEVERE', 'MODERATE', 'LOW']
      .map((l) => `<Table><RISK>${l}</RISK></Table>`).join('') + '</NewDataSet></DataSet>';
  assert.deepEqual(parseAhasSeries(xml), ['LOW', 'LOW', 'MODERATE', 'SEVERE', 'MODERATE', 'LOW']);
  assert.deepEqual(parseAhasSeries(''), []);
  // Caps at 12 (the 12-hour product).
  const many = '</xs:schema>' + Array(20).fill('<r>LOW</r>').join('');
  assert.equal(parseAhasSeries(many).length, 12);
});

test('parseAhasHourly takes the worst AHASRISK per forecast hour, time-ordered', () => {
  // Two hours, two segments each; the worst segment risk wins per hour.
  const row = (dt, ahas) => `<Table><Segment>X</Segment><DateTime>${dt}</DateTime><NEXRADRISK>NO DATA</NEXRADRISK><AHASRISK>${ahas}</AHASRISK></Table>`;
  const xml = '</xs:schema><NewDataSet>'
    + row('2026-06-07 16:00:00.000', 'LOW') + row('2026-06-07 16:00:00.000', 'SEVERE')
    + row('2026-06-07 17:00:00.000', 'MODERATE') + row('2026-06-07 17:00:00.000', 'LOW')
    + '</NewDataSet>';
  const h = parseAhasHourly(xml);
  assert.equal(h.length, 2);
  assert.deepEqual(h.map((x) => x.level), ['SEVERE', 'MODERATE']);
  assert.equal(h[0].time, '2026-06-07 16:00:00.000');
  assert.deepEqual(parseAhasHourly(''), []);
});

test('parseAhasHourly handles the airfield shape (one row/hour, coords ignored)', () => {
  // Airfield GetAHASRisk12: one row per hour, with a big coordinates polygon that
  // must not pollute the risk parse.
  const row = (dt, ahas) => `<Table><Route>ALTUS AFB</Route><DateTime>${dt}</DateTime><NEXRADRISK>NO DATA</NEXRADRISK><BAMRISK>MODERATE</BAMRISK><AHASRISK>${ahas}</AHASRISK><coordinates>34.7 -99.2 34.5 -99.3 34.7 -99.2</coordinates></Table>`;
  const xml = '</xs:schema><NewDataSet>'
    + row('2026-06-07 15:06:00.000', 'LOW') + row('2026-06-07 16:00:00.000', 'MODERATE') + row('2026-06-08 02:00:00.000', 'LOW')
    + '</NewDataSet>';
  const h = parseAhasHourly(xml);
  assert.deepEqual(h.map((x) => x.level), ['LOW', 'MODERATE', 'LOW']);
});

test('parseAhasRouteMatrix groups per turn point, worst risk per hour', () => {
  const row = (seg, dt, ahas) => `<Table><Segment>${seg}</Segment><DateTime>${dt}</DateTime><NEXRADRISK>NO DATA</NEXRADRISK><AHASRISK>${ahas}</AHASRISK></Table>`;
  const xml = '</xs:schema><NewDataSet>'
    // segment 2 listed before 1 to prove numeric ordering
    + row('2', '2026-06-07 16:00:00.000', 'MODERATE') + row('2', '2026-06-07 17:00:00.000', 'LOW')
    + row('1', '2026-06-07 16:00:00.000', 'LOW') + row('1', '2026-06-07 16:00:00.000', 'SEVERE')
    + row('1', '2026-06-07 17:00:00.000', 'LOW')
    + '</NewDataSet>';
  const segs = parseAhasRouteMatrix(xml);
  assert.deepEqual(segs.map((s) => s.segment), ['1', '2']);              // numeric order
  assert.deepEqual(segs[0].series.map((h) => h.level), ['SEVERE', 'LOW']); // worst per hour
  assert.deepEqual(segs[1].series.map((h) => h.level), ['MODERATE', 'LOW']);
  // Airfield shape (no <Segment>) yields no per-segment matrix.
  assert.deepEqual(parseAhasRouteMatrix('</xs:schema><Table><DateTime>x</DateTime><AHASRISK>LOW</AHASRISK></Table>'), []);
  assert.deepEqual(parseAhasRouteMatrix(''), []);
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

test('ahasAreaForIcao maps bases from the bundled AHAS airfield list', () => {
  assert.equal(ahasAreaForIcao('KLTS'), 'ALTUS AFB');
  assert.equal(ahasAreaForIcao('klts'), 'ALTUS AFB');
  // Exact AHAS spellings (hand-guesses had these wrong):
  assert.equal(ahasAreaForIcao('KCHS'), 'CHARLESTON AFB INTL');
  assert.equal(ahasAreaForIcao('KWRI'), 'MC GUIRE AFB');
  assert.equal(ahasAreaForIcao('KTCM'), 'MC CHORD AFB');
  assert.equal(ahasAreaForIcao('ZZZZ'), null);
});

test('ahasHasRoute filters only types with a known index list', () => {
  assert.equal(ahasHasRoute('IR-154'), true);   // in bundled IR index
  assert.equal(ahasHasRoute('VR-106'), true);   // in bundled VR index
  assert.equal(ahasHasRoute('IR-999'), false);  // not covered by AHAS
  assert.equal(ahasHasRoute('SR-100'), true);   // no SR list -> don't filter
});
