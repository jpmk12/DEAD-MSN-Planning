import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nmsConfigured, mapNmsFeature } from './nms.js';

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
