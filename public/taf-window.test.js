import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tafTokenIso, periodIntervals, periodsInWindow } from './taf-window.js';

const anchor = '2026-06-23T00:00:00Z';

test('tafTokenIso resolves a DDHH[MM] token near the anchor (with 24:00 rollover)', () => {
  assert.equal(tafTokenIso('2303', anchor), '2026-06-23T03:00:00.000Z');
  assert.equal(tafTokenIso('230630', anchor), '2026-06-23T06:30:00.000Z');
  // "24" hour = 00:00 the next day.
  assert.equal(tafTokenIso('2324', anchor), '2026-06-24T00:00:00.000Z');
  assert.equal(tafTokenIso('', anchor), null);
});

test('periodIntervals: open-ended FM runs until the next BASE; last is open', () => {
  const periods = [
    { kind: 'BASE', from: '2300', to: '2306' },   // Prevailing 00–06Z
    { kind: 'BASE', from: '2306', to: null },      // FM 0600Z (open-ended)
    { kind: 'TEMPO', from: '2302', to: '2305' },   // TEMPO 02–05Z
    { kind: 'BASE', from: '2312', to: null },      // FM 1200Z (last, open)
  ];
  const iv = periodIntervals(periods, anchor);
  // FM 0600 runs until the next BASE (FM 1200), not to infinity.
  assert.equal(iv[1].start, Date.parse('2026-06-23T06:00:00Z'));
  assert.equal(iv[1].end, Date.parse('2026-06-23T12:00:00Z'));
  // TEMPO keeps its explicit window.
  assert.equal(iv[2].end, Date.parse('2026-06-23T05:00:00Z'));
  // The last BASE is open-ended.
  assert.equal(iv[3].end, Infinity);
});

test('periodsInWindow: flags exactly the periods flown during takeoff→landing', () => {
  const periods = [
    { kind: 'BASE', from: '2300', to: '2303' },    // 00–03Z
    { kind: 'BASE', from: '2303', to: null },       // FM 0300Z → next base
    { kind: 'TEMPO', from: '2302', to: '2305' },    // 02–05Z
    { kind: 'BASE', from: '2306', to: null },       // FM 0600Z (last)
  ];
  // Flight 0135Z → 0410Z.
  const win = { start: Date.parse('2026-06-23T01:35:00Z'), end: Date.parse('2026-06-23T04:10:00Z') };
  const flags = periodsInWindow(periods, anchor, win);
  assert.deepEqual(flags, [true, true, true, false]);
});

test('periodsInWindow: returns null when nothing overlaps (caller must not dim all)', () => {
  const periods = [{ kind: 'BASE', from: '2300', to: '2303' }]; // 00–03Z only
  const win = { start: Date.parse('2026-06-23T10:00:00Z'), end: Date.parse('2026-06-23T12:00:00Z') };
  assert.equal(periodsInWindow(periods, anchor, win), null);
  // No window at all → null.
  assert.equal(periodsInWindow(periods, anchor, null), null);
});
