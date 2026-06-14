import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toObjects, buildRunwayEnds, buildGlobalAirports } from './ingest-ourairports.js';

test('CSV parser handles quotes and embedded commas', () => {
  const rows = parseCsv('a,b,c\n1,"hello, world","say ""hi"""\n');
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.deepEqual(rows[1], ['1', 'hello, world', 'say "hi"']);
});

test('toObjects maps headers to fields', () => {
  const objs = toObjects(parseCsv('ident,name\nKCHS,Charleston\n'));
  assert.equal(objs.length, 1);
  assert.equal(objs[0].ident, 'KCHS');
  assert.equal(objs[0].name, 'Charleston');
});

test('buildRunwayEnds produces both ends with TRUE headings', () => {
  const ends = buildRunwayEnds({
    le_ident: '15', le_heading_degT: '152.7',
    he_ident: '33', he_heading_degT: '332.7',
    length_ft: '9001', width_ft: '150', surface: 'ASP', closed: '0',
  });
  assert.equal(ends.length, 2);
  const le = ends.find((e) => e.ident === '15');
  assert.equal(le.trueHeading, 152.7);
  assert.equal(le.magHeading, 150); // from designator
  assert.equal(le.lengthFt, 9001);
  assert.equal(le.surface, 'ASP');
});

test('buildRunwayEnds omits trueHeading when source lacks it', () => {
  const ends = buildRunwayEnds({ le_ident: '09', he_ident: '27', length_ft: '5000' });
  const le = ends.find((e) => e.ident === '09');
  assert.equal(le.trueHeading, undefined);
  assert.equal(le.magHeading, 90);
});

test('buildGlobalAirports keeps large+medium (default), drops small/heliport, attaches runways', () => {
  const airports = [
    { ident: 'ETAR', type: 'large_airport', name: 'Ramstein AB', municipality: 'Ramstein', elevation_ft: '776', latitude_deg: '49.4369', longitude_deg: '7.6003' },
    { ident: 'KXYZ', type: 'medium_airport', name: 'Med Field', elevation_ft: '500', latitude_deg: '40', longitude_deg: '-100' },
    { ident: 'XS01', type: 'small_airport', name: 'Tiny', elevation_ft: '900', latitude_deg: '30', longitude_deg: '-95' },
    { ident: 'XH01', type: 'heliport', name: 'Helipad', latitude_deg: '30', longitude_deg: '-95' },
  ];
  const runways = [
    { airport_ident: 'ETAR', le_ident: '08', le_heading_degT: '83', he_ident: '26', he_heading_degT: '263', length_ft: '9000', closed: '0' },
  ];
  const out = buildGlobalAirports(airports, runways);
  assert.deepEqual(out.map((a) => a.icao), ['ETAR', 'KXYZ']); // sorted, small/heliport excluded
  const etar = out.find((a) => a.icao === 'ETAR');
  assert.equal(etar.name, 'Ramstein AB, Ramstein');
  assert.equal(etar.magVar, 0); // TRUE headings from source
  assert.equal(etar.runways.length, 2);
  assert.equal(etar.runways.find((r) => r.ident === '08').trueHeading, 83);
  assert.equal(out.find((a) => a.icao === 'KXYZ').runways.length, 0);
});

test('buildGlobalAirports honors the min-runway filter', () => {
  const airports = [
    { ident: 'AAAA', type: 'medium_airport', name: 'Short', latitude_deg: '0', longitude_deg: '0' },
    { ident: 'BBBB', type: 'medium_airport', name: 'Long', latitude_deg: '0', longitude_deg: '0' },
  ];
  const runways = [
    { airport_ident: 'AAAA', le_ident: '09', he_ident: '27', length_ft: '3000', closed: '0' },
    { airport_ident: 'BBBB', le_ident: '09', he_ident: '27', length_ft: '7000', closed: '0' },
  ];
  const out = buildGlobalAirports(airports, runways, { minRunwayFt: 5000 });
  assert.deepEqual(out.map((a) => a.icao), ['BBBB']); // AAAA dropped (3000 < 5000)
});
