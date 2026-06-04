import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRisk, advisoryFor, RISK_RANK, fetchBirdRisk } from './birds.js';

test('normalizeRisk validates and upper-cases, defaults to LOW', () => {
  assert.equal(normalizeRisk('severe'), 'SEVERE');
  assert.equal(normalizeRisk('Moderate'), 'MODERATE');
  assert.equal(normalizeRisk('garbage'), 'LOW');
  assert.equal(normalizeRisk(undefined), 'LOW');
});

test('risk ranking orders LOW < MODERATE < SEVERE', () => {
  assert.ok(RISK_RANK.LOW < RISK_RANK.MODERATE);
  assert.ok(RISK_RANK.MODERATE < RISK_RANK.SEVERE);
});

test('advisoryFor returns guidance text per level', () => {
  assert.match(advisoryFor('SEVERE'), /[Aa]void/);
  assert.match(advisoryFor('LOW'), /[Nn]ormal/);
});

test('fetchBirdRisk maps every requested field, fixture-backed', async () => {
  const { risk, live } = await fetchBirdRisk(['KEDW', 'KSUU', 'ZZZZ'], true);
  assert.equal(live, false);
  assert.equal(risk.get('KEDW').level, 'SEVERE');
  assert.equal(risk.get('KSUU').level, 'LOW');
  assert.equal(risk.get('ZZZZ').level, 'LOW'); // unknown -> LOW
});
