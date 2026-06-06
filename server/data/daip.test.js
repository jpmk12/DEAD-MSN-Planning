import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDaipNotams, daipPayload, dodCaLoaded } from './daip.js';

test('parseDaipNotams flattens group/notams/list and reads end time', () => {
  const body = JSON.stringify({
    count: 2,
    group: [{
      name: 'KLTS',
      notams: [{
        code: 'KLTS', name: 'KLTS ALTUS AFB',
        list: [
          { idshow: 'M0673/26', text: 'AERODROME SPOT 21 CLSD', rawtext: 'M0673/26 NOTAMN \r\nA) KLTS B) 2606031659 C) 2606120700 E) SPOT 21 CLSD' },
          { idshow: 'M0655/26', text: 'RWY 18R/36L CLSD', rawtext: 'A) KLTS C) 2606301200 E) RWY 18R/36L CLSD' },
        ],
      }],
    }],
  });
  const recs = parseDaipNotams(body);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].icao, 'KLTS');
  assert.equal(recs[0].id, 'M0673/26');
  assert.equal(recs[0].source, 'DAIP');
  assert.equal(recs[0].effectiveEnd, '2026-06-12T07:00:00.000Z');
  assert.equal(recs[1].effectiveEnd, '2026-06-30T12:00:00.000Z');
});

test('parseDaipNotams is defensive against junk', () => {
  assert.deepEqual(parseDaipNotams('not json'), []);
  assert.deepEqual(parseDaipNotams(JSON.stringify({})), []);
  assert.deepEqual(parseDaipNotams(JSON.stringify({ group: [{ notams: [] }] })), []);
});

test('daipPayload sets location + defaults', () => {
  const p = daipPayload('KLTS');
  assert.equal(p.locs, 'klts');
  assert.equal(p.type, 'LOCATION');
  assert.equal(p.radius, '10');
  assert.equal(p.sort, 'Criticality');
});

test('dodCaLoaded is true (embedded DoD CA fallback)', () => {
  assert.equal(dodCaLoaded(), true);
});
