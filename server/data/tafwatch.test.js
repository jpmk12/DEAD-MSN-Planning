import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTafAt, watchTaf, resetTafWatch } from './tafwatch.js';

const OLD = 'KLTS 111100Z 1112/1218 17012KT P6SM SCT045';
const AMD = 'KLTS 111700Z 1117/1218 17012KT P6SM SCT045 FM112000 09025G38KT 2SM TSRA OVC008';
const WHEN = '2026-06-11T20:15:00Z';

test('compareTafAt flags category/wind/ceiling/vis worsening at the phase time', () => {
  const notes = compareTafAt(OLD, AMD, WHEN);
  assert.ok(notes.some((n) => /now IFR \(was VFR\)/.test(n)), notes.join(' | '));
  assert.ok(notes.some((n) => /wind up to 38 kt \(was 12 kt\)/.test(n)));
  assert.ok(notes.some((n) => /visibility down to 2 SM/.test(n)));
  // No change -> no notes; improvement -> no notes.
  assert.deepEqual(compareTafAt(OLD, OLD, WHEN), []);
  assert.deepEqual(compareTafAt(AMD, OLD, WHEN), []);
});

test('watchTaf reports only when a NEW (different) TAF worsens a briefed phase', () => {
  resetTafWatch();
  // First sighting: nothing to compare against.
  assert.deepEqual(watchTaf('KLTS', OLD, [WHEN]), []);
  // Same TAF again: no change.
  assert.deepEqual(watchTaf('KLTS', OLD, [WHEN]), []);
  // Amended TAF: degradation at the recovery time flags with notes.
  const ch = watchTaf('KLTS', AMD, [WHEN, null]);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].when, WHEN);
  assert.ok(ch[0].notes.length >= 2);
  // The amended TAF is now the baseline.
  assert.deepEqual(watchTaf('KLTS', AMD, [WHEN]), []);
  resetTafWatch();
});
