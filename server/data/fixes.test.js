import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFixCoord } from './fixes.js';

test('pickFixCoord chooses the candidate nearest a reference, first otherwise', () => {
  const us = [34.0, -99.0];   // near KLTS
  const far = [15.0, 103.0];  // far away
  const list = [far, us];     // intentionally far-first
  // Nearest to a field near KLTS picks the US candidate.
  assert.deepEqual(pickFixCoord(list, { lat: 34.67, lon: -99.27 }), us);
  // No reference -> first as listed.
  assert.deepEqual(pickFixCoord(list, null), far);
  // Single candidate -> that one.
  assert.deepEqual(pickFixCoord([us], { lat: 0, lon: 0 }), us);
  // Empty / missing -> undefined.
  assert.equal(pickFixCoord([], { lat: 0, lon: 0 }), undefined);
  assert.equal(pickFixCoord(undefined, null), undefined);
});
