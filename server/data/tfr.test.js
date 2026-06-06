import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDms, altFt, tfrRecordsFromXml, tfrIdsFromList, tfrListItems, tfrIdOf } from './tfr.js';

test('tfrListItems normalizes array / featurecollection / wrapped shapes', () => {
  assert.equal(tfrListItems([{ a: 1 }, { a: 2 }]).length, 2);
  assert.equal(tfrListItems({ features: [{ x: 1 }] }).length, 1);
  assert.equal(tfrListItems({ tfrList: [{ x: 1 }, { y: 2 }] }).length, 2);
  assert.deepEqual(tfrListItems(null), []);
});

test('tfrIdOf reads varied id field names (incl. GeoJSON properties)', () => {
  assert.equal(tfrIdOf({ notam_id: '4/3344' }), '4/3344');
  assert.equal(tfrIdOf({ NOTAM_ID: '0/1234' }), '0/1234');
  assert.equal(tfrIdOf({ properties: { notamId: '9/9999' } }), '9/9999');
  assert.equal(tfrIdOf({ nope: 1 }), null);
});

test('parseDms handles DDMMSS, DDMM, and decimal', () => {
  assert.ok(Math.abs(parseDms('385230.00N') - 38.875) < 1e-6);
  assert.ok(Math.abs(parseDms('0771500.00W') - -77.25) < 1e-6);
  assert.ok(Math.abs(parseDms('3852N') - (38 + 52 / 60)) < 1e-6);
  assert.ok(Math.abs(parseDms('07715W') - -77.25) < 1e-6);
  assert.equal(parseDms('-77.25'), -77.25);
  assert.equal(parseDms('garbage'), null);
  assert.equal(parseDms(null), null);
});

test('altFt converts SFC/UNL/FL/FT', () => {
  assert.equal(altFt('SFC', 'FT'), 0);
  assert.equal(altFt('UNL', ''), null);
  assert.equal(altFt('050', 'FL'), 5000);
  assert.equal(altFt('1500', 'FT'), 1500);
  assert.equal(altFt('', ''), null);
});

test('tfrIdsFromList extracts unique detail ids', () => {
  const html = '<a href="save_pages/detail_4_3344.xml">x</a> <a href="detail_5_1234.xml"> <a href="detail_4_3344.xml">';
  assert.deepEqual(tfrIdsFromList(html), ['4_3344', '5_1234']);
});

const SAMPLE_POLY = `
<XNOTAM_Update><Group><Add><Not>
  <NotUid><txtLocalName>4/3344</txtLocalName></NotUid>
  <dateEffective>2026-06-05T12:00:00</dateEffective>
  <dateExpire>2026-06-05T20:00:00</dateExpire>
  <txtNameCity>SOMEWHERE</txtNameCity>
  <TfrNot><TFRAreaGroup><aseTFRArea>
    <valDistVerLower>SFC</valDistVerLower><uomDistVerLower>FT</uomDistVerLower>
    <valDistVerUpper>050</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
    <Avx><geoLat>385230.00N</geoLat><geoLong>0771500.00W</geoLong></Avx>
    <Avx><geoLat>385230.00N</geoLat><geoLong>0770500.00W</geoLong></Avx>
    <Avx><geoLat>384230.00N</geoLat><geoLong>0770500.00W</geoLong></Avx>
  </aseTFRArea></TFRAreaGroup></TfrNot>
</Not></Add></Group></XNOTAM_Update>`;

test('tfrRecordsFromXml parses a polygon TFR area', () => {
  const recs = tfrRecordsFromXml(SAMPLE_POLY, 'fallback');
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.id, '4/3344');
  assert.equal(r.name, 'SOMEWHERE');
  assert.equal(r.lowerFt, 0);
  assert.equal(r.upperFt, 5000);
  assert.equal(r.geometry.kind, 'polygon');
  assert.equal(r.geometry.points.length, 3);
  assert.ok(Math.abs(r.geometry.points[0][0] - 38.875) < 1e-6);
  assert.ok(Math.abs(r.geometry.points[0][1] - -77.25) < 1e-6);
});

const SAMPLE_CIRCLE = `
<Not><NotUid><txtLocalName>9/9999</txtLocalName></NotUid><txtNameCity>RINGTOWN</txtNameCity>
<aseTFRArea>
  <valDistVerLower>SFC</valDistVerLower><valDistVerUpper>100</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
  <geoLatCen>390000.00N</geoLatCen><geoLongCen>0900000.00W</geoLongCen>
  <valRadiusArc>5</valRadiusArc><uomRadiusArc>NM</uomRadiusArc>
</aseTFRArea></Not>`;

test('tfrRecordsFromXml parses a circular TFR area', () => {
  const recs = tfrRecordsFromXml(SAMPLE_CIRCLE);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].geometry.kind, 'circle');
  assert.ok(Math.abs(recs[0].geometry.lat - 39) < 1e-6);
  assert.ok(Math.abs(recs[0].geometry.lon - -90) < 1e-6);
  assert.equal(recs[0].geometry.radiusNm, 5);
  assert.equal(recs[0].upperFt, 10000);
});
