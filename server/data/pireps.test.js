import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPirep, pirepAltFt, mapAwcPirep, mapPireps } from './pireps.js';

test('classifyPirep detects turbulence and icing', () => {
  assert.equal(classifyPirep({ turbInt1: 'MOD' }).turb, true);
  assert.equal(classifyPirep({ icgInt1: 'LGT' }).ice, true);
  assert.equal(classifyPirep({ rawOb: 'KX UA /TB MOD /IC LGT' }).label, 'TURB + ICE');
  assert.equal(classifyPirep({ rawOb: 'KX UUA /TB SEV' }).urgent, true);
  assert.equal(classifyPirep({ rawOb: 'KX UA /SK BKN040' }).label, 'PIREP');
});

test('pirepAltFt parses flight level and explicit altitude', () => {
  assert.equal(pirepAltFt({ fltlvl: '120' }), 12000);
  assert.equal(pirepAltFt({ altFtMsl: 8500 }), 8500);
  assert.equal(pirepAltFt({}), null);
});

test('mapAwcPirep builds a point with hazard + geometry', () => {
  const p = mapAwcPirep({ pirepId: 'P1', lat: 33.2, lon: -80.3, fltlvl: '120', turbInt1: 'MOD', obsTime: 1780936800, rawOb: 'X /TB MOD' });
  assert.equal(p.altFt, 12000);
  assert.equal(p.hazard, 'TURB');
  assert.equal(p.geometry.kind, 'circle');
  assert.equal(p.geometry.radiusNm, 0);
});

test('mapPireps drops reports without coordinates', () => {
  const out = mapPireps([
    { pirepId: 'ok', lat: 35, lon: -118, rawOb: 'X /TB LGT' },
    { pirepId: 'nocoord', rawOb: 'X' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ok');
});
