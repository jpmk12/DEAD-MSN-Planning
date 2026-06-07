import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexRunways, indexAirports, indexNavaids, pickNavaid } from './ourairports.js';

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

test('indexAirports keys by ICAO only (not IATA/local), skips non-airports', () => {
  const runways = indexRunways([
    { airport_ident: 'KLTS', le_ident: '17', le_heading_degT: '174', he_ident: '35', he_heading_degT: '354', length_ft: '13440', closed: '0' },
  ]);
  const ap = indexAirports([
    { ident: 'KLTS', gps_code: 'KLTS', type: 'large_airport', name: 'Altus AFB', municipality: 'Altus', elevation_ft: '1382', latitude_deg: '34.667', longitude_deg: '-99.267', local_code: 'LTS', iata_code: 'LTS' },
    { ident: 'VTUO', gps_code: 'VTUO', type: 'medium_airport', name: 'Buri Ram', latitude_deg: '15.23', longitude_deg: '103.25', iata_code: 'BFV' },
    { ident: 'XX01', type: 'heliport', name: 'A Helipad', latitude_deg: '1', longitude_deg: '2' },
  ], runways);
  const rec = ap.get('KLTS');
  assert.ok(rec, 'KLTS present');
  assert.equal(rec.name, 'Altus AFB, Altus');
  assert.equal(rec.runways.length, 2);
  assert.equal(ap.has('LTS'), false, 'IATA/local alias does NOT resolve');
  assert.equal(ap.has('BFV'), false, 'IATA BFV does NOT resolve to Buri Ram');
  assert.equal(ap.get('VTUO').name, 'Buri Ram', 'ICAO still resolves');
  assert.equal(ap.has('XX01'), false, 'heliport skipped');
});

test('indexNavaids keeps all same-ident candidates; pickNavaid chooses nearest', () => {
  const m = indexNavaids([
    { ident: 'LRP', name: 'Lancaster VOR', type: 'VORTAC', latitude_deg: '40.12', longitude_deg: '-76.29', elevation_ft: '480' },
    { ident: 'BAD', name: 'No coords', type: 'NDB' },
    // Two navaids share the ident "BFV": one US, one far away.
    { ident: 'BFV', name: 'US BFV', type: 'VOR', latitude_deg: '34.0', longitude_deg: '-99.0' },
    { ident: 'BFV', name: 'Far BFV', type: 'VOR', latitude_deg: '15.0', longitude_deg: '103.0' },
  ]);
  assert.equal(m.get('LRP')[0].type, 'VORTAC');
  assert.equal(m.get('LRP')[0].lat, 40.12);
  assert.equal(m.has('BAD'), false);
  assert.equal(m.get('BFV').length, 2, 'both BFV candidates kept');
  // Nearest to a field near KLTS picks the US one; no reference -> first.
  assert.equal(pickNavaid(m.get('BFV'), { lat: 34.67, lon: -99.27 }).name, 'US BFV');
  assert.equal(pickNavaid(m.get('BFV'), null).name, 'US BFV');
});
