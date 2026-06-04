import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toObjects, buildRunwayEnds } from './ingest-ourairports.js';

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
