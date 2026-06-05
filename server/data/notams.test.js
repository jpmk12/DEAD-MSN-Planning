import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, rankNotams, fetchNotams } from './notams.js';

test('categorize floats runway closures above lower-priority items', () => {
  assert.equal(categorize('RWY 15/33 CLSD').category, 'RUNWAY');
  assert.equal(categorize('TWY A CLSD').category, 'TAXIWAY');
  assert.equal(categorize('ILS 04 OTS').category, 'APPROACH');
  assert.ok(categorize('RWY 15/33 CLSD').priority > categorize('TWY A CLSD').priority);
});

test('rankNotams sorts most-significant first', () => {
  const ranked = rankNotams([
    { text: 'TWY A CLSD', priority: 40 },
    { text: 'RWY 15 CLSD', priority: 110 },
  ]);
  assert.equal(ranked[0].text, 'RWY 15 CLSD');
});

test('fetchNotams (legacy FAA path) is sequential, dedupes, retries 429, and skips a failing field', async () => {
  const saved = {
    ni: process.env.NMS_CLIENT_ID, ns: process.env.NMS_CLIENT_SECRET,
    fi: process.env.FAA_NOTAM_CLIENT_ID, fs: process.env.FAA_NOTAM_CLIENT_SECRET,
    f: globalThis.fetch,
  };
  delete process.env.NMS_CLIENT_ID; delete process.env.NMS_CLIENT_SECRET; // force the FAA path
  process.env.FAA_NOTAM_CLIENT_ID = 'id';
  process.env.FAA_NOTAM_CLIENT_SECRET = 'secret';

  let inflight = 0, maxInflight = 0, threw429 = false;
  const calls = [];
  const item = (loc) => ({ properties: { coreNOTAMData: { notam: { id: loc + '1', text: 'RWY 17 CLSD' } } } });
  globalThis.fetch = async (url) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    try {
      const loc = new URL(url).searchParams.get('domesticLocation');
      calls.push(loc);
      if (loc === 'KLTS' && !threw429) { threw429 = true; return { ok: false, status: 429, json: async () => ({}) }; }
      if (loc === 'KBAD') return { ok: false, status: 404, json: async () => ({}) }; // hard fail → skipped
      return { ok: true, status: 200, json: async () => ({ items: [item(loc)] }) };
    } finally { inflight--; }
  };

  try {
    const { notams, live } = await fetchNotams(['KLTS', 'KBAD', 'KCHS', 'klts']); // dup KLTS
    assert.equal(maxInflight, 1, 'requests must be issued one at a time');
    assert.deepEqual(calls, ['KLTS', 'KLTS', 'KBAD', 'KCHS'], 'KLTS retried after 429; dup dropped; KBAD attempted');
    assert.equal(live, true, 'partial success still counts as live');
    // KBAD (404) is skipped; KLTS + KCHS survive.
    assert.deepEqual([...new Set(notams.map((n) => n.icao))].sort(), ['KCHS', 'KLTS']);
  } finally {
    globalThis.fetch = saved.f;
    for (const [k, v] of [
      ['NMS_CLIENT_ID', saved.ni], ['NMS_CLIENT_SECRET', saved.ns],
      ['FAA_NOTAM_CLIENT_ID', saved.fi], ['FAA_NOTAM_CLIENT_SECRET', saved.fs],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
