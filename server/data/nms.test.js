import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nmsConfigured, mapNmsFeature, fetchNmsRaw } from './nms.js';

test('nmsConfigured reflects NMS_CLIENT_ID/SECRET', () => {
  const saved = { i: process.env.NMS_CLIENT_ID, s: process.env.NMS_CLIENT_SECRET };
  delete process.env.NMS_CLIENT_ID; delete process.env.NMS_CLIENT_SECRET;
  assert.equal(nmsConfigured(), false);
  process.env.NMS_CLIENT_ID = 'k'; process.env.NMS_CLIENT_SECRET = 's';
  assert.equal(nmsConfigured(), true);
  if (saved.i === undefined) delete process.env.NMS_CLIENT_ID; else process.env.NMS_CLIENT_ID = saved.i;
  if (saved.s === undefined) delete process.env.NMS_CLIENT_SECRET; else process.env.NMS_CLIENT_SECRET = saved.s;
});

test('mapNmsFeature extracts the notam fields from a GeoJSON feature', () => {
  const feature = {
    type: 'Feature',
    properties: {
      coreNOTAMData: {
        notam: {
          id: 'NMS_ID_1234567812345678', number: '01/123', location: 'CLT', icaoLocation: 'KCLT',
          effectiveStart: '2025-03-17T17:02:00.000Z', effectiveEnd: '2025-09-18T21:11:00.000Z',
          text: '27 RWY END ID LGT U/S',
        },
      },
    },
  };
  const r = mapNmsFeature(feature, 'KXXX');
  assert.equal(r.icao, 'KCLT');
  assert.equal(r.text, '27 RWY END ID LGT U/S');
  assert.equal(r.effectiveEnd, '2025-09-18T21:11:00.000Z');
});

test('mapNmsFeature falls back to provided icao and tolerates missing data', () => {
  const r = mapNmsFeature({}, 'KDFW');
  assert.equal(r.icao, 'KDFW');
  assert.equal(r.text, '');
});

test('fetchNmsRaw fetches fields sequentially, dedupes, and retries transient 429', async () => {
  const saved = {
    i: process.env.NMS_CLIENT_ID, s: process.env.NMS_CLIENT_SECRET,
    b: process.env.NMS_API_BASE, f: globalThis.fetch,
  };
  process.env.NMS_CLIENT_ID = 'k';
  process.env.NMS_CLIENT_SECRET = 's';
  process.env.NMS_API_BASE = 'https://nms.example';

  let inflight = 0, maxInflight = 0, threw429 = false;
  const notamCalls = [];
  const notam = (loc) => ({
    properties: { coreNOTAMData: { notam: { id: loc + '1', text: 'RWY 17 CLSD', icaoLocation: loc } } },
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/v1/auth/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'T', expires_in: 1799 }) };
    }
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    try {
      const loc = new URL(url).searchParams.get('location');
      notamCalls.push(loc);
      // First KLTS hit returns a transient 429 to exercise retry/backoff.
      if (loc === 'KLTS' && !threw429) { threw429 = true; return { ok: false, status: 429, json: async () => ({}) }; }
      return { ok: true, status: 200, json: async () => ({ data: { geojson: [notam(loc)] } }) };
    } finally { inflight--; }
  };

  try {
    const raw = await fetchNmsRaw(['KLTS', 'KCHS', 'klts']); // duplicate KLTS (case-insensitive)
    assert.equal(maxInflight, 1, 'requests must be issued one at a time');
    assert.deepEqual(notamCalls, ['KLTS', 'KLTS', 'KCHS'], 'KLTS retried after 429, then KCHS; dup dropped');
    assert.deepEqual(raw.map((n) => n.icao).sort(), ['KCHS', 'KLTS']);
  } finally {
    globalThis.fetch = saved.f;
    for (const [k, v] of [['NMS_CLIENT_ID', saved.i], ['NMS_CLIENT_SECRET', saved.s], ['NMS_API_BASE', saved.b]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
