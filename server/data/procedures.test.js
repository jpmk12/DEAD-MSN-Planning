import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proceduresAvailable, expandProcedure } from './procedures.js';

// Runs against the bundled data/procedures.json (from the FAA CIFP extract).
test('procedures dataset is bundled', () => {
  assert.equal(proceduresAvailable(), true);
});

test('expandProcedure returns ordered points for a SID transition', () => {
  const r = expandProcedure('LGRHD3', 'KCHS', 'GIPPL');
  assert.ok(Array.isArray(r) && r.length >= 2);
  assert.ok(r.every((p) => typeof p.name === 'string'));
  assert.ok(r.some((p) => p.name === 'GIPPL'), 'transition fix present');
  // Each point has a name; coords are inline for terminal waypoints and null for
  // enroute fixes (the route engine resolves those at runtime).
  assert.ok(r.every((p) => 'lat' in p && 'lon' in p));
});

test('a SID transition with a terminal waypoint carries inline coords', () => {
  // RW03 runway transition begins at HALEE, a terminal waypoint with coords.
  const r = expandProcedure('LGRHD3', 'KCHS', 'RW03');
  assert.ok(r.some((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)));
});

test('expandProcedure returns null for unknown procedure/airport', () => {
  assert.equal(expandProcedure('NOPE9', 'KCHS', null), null);
  assert.equal(expandProcedure('LGRHD3', 'ZZZZ', null), null);
});
