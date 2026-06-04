import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexRunways, indexAirports, indexNavaids } from './ourairports.js';

test('indexRunways groups ends by airport and skips closed', () => {
  const m = indexRunways([
    { airport_ident: 'KLTS', le_ident: '17', le_heading_degT: '174.0', he_ident: '35', he_heading_degT: '354.0', length_ft: '13440', closed: '0' },
    { airport_ident: 'KLTS', le_ident: '14', he_ident: '32', closed: '1' }, // closed -> skipped
  ]);
  const ends = m.get('KLTS');
  assert.equal(ends.length, 2);
  assert.equal(ends.find((e) => e.ident === '17').trueHeading, 174);
  assert.equal(ends.find((e) => e.ident === '35').magHeading, 350);
});

test('indexAirports builds records with ICAO + alias keys, skips non-airports', () => {
  const runways = indexRunways([
    { airport_ident: 'KLTS', le_ident: '17', le_heading_degT: '174', he_ident: '35', he_heading_degT: '354', length_ft: '13440', closed: '0' },
  ]);
  const ap = indexAirports([
    { ident: 'KLTS', type: 'large_airport', name: 'Altus AFB', municipality: 'Altus', elevation_ft: '1382', latitude_deg: '34.667', longitude_deg: '-99.267', local_code: 'LTS', iata_code: 'LTS' },
    { ident: 'XX01', type: 'heliport', name: 'A Helipad', latitude_deg: '1', longitude_deg: '2' },
  ], runways);
  const rec = ap.get('KLTS');
  assert.ok(rec, 'KLTS present');
  assert.equal(rec.name, 'Altus AFB, Altus');
  assert.equal(rec.elevationFt, 1382);
  assert.equal(rec.runways.length, 2);
  assert.equal(ap.get('LTS'), rec, 'alias key resolves to same record');
  assert.equal(ap.has('XX01'), false, 'heliport skipped');
});

test('indexNavaids keys by ident and requires coordinates', () => {
  const m = indexNavaids([
    { ident: 'LRP', name: 'Lancaster VOR', type: 'VORTAC', latitude_deg: '40.12', longitude_deg: '-76.29', elevation_ft: '480' },
    { ident: 'BAD', name: 'No coords', type: 'NDB' },
  ]);
  assert.equal(m.get('LRP').type, 'VORTAC');
  assert.equal(m.get('LRP').lat, 40.12);
  assert.equal(m.has('BAD'), false);
});
