import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskFromProps, mapProps, RISK_RANK } from './convective.js';

test('riskFromProps reads LABEL, DN code, or defaults to TSTM', () => {
  assert.equal(riskFromProps({ LABEL: 'ENH' }), 'ENH');
  assert.equal(riskFromProps({ DN: 4 }), 'SLGT');
  assert.equal(riskFromProps({ DN: 8 }), 'HIGH');
  assert.equal(riskFromProps({}), 'TSTM');
  assert.equal(riskFromProps({ LABEL: 'bogus' }), 'TSTM');
});

test('risk ranking is ordered TSTM < SLGT < HIGH', () => {
  assert.ok(RISK_RANK.TSTM < RISK_RANK.SLGT);
  assert.ok(RISK_RANK.SLGT < RISK_RANK.HIGH);
});

test('mapProps builds id/risk/label/type', () => {
  const m = mapProps({ LABEL: 'SLGT' }, 0);
  assert.equal(m.risk, 'SLGT');
  assert.equal(m.label, 'Slight');
  assert.equal(m.type, 'CONVECTIVE');
  assert.equal(m.id, 'CONV-0');
});
