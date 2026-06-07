import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airwaysAvailable, hasAirway, airwaySegmentNames } from './airways.js';

// These run against the bundled data/airways.json (FAA NASR AWY_BASE).
test('airways dataset is bundled and J78 is known', () => {
  assert.equal(airwaysAvailable(), true);
  assert.equal(hasAirway('j78'), true);
  assert.equal(hasAirway('NOPE999'), false);
});

test('airwaySegmentNames returns ordered intermediates and respects direction', () => {
  const fwd = airwaySegmentNames('J78', 'LAX', 'ZUN');
  assert.ok(Array.isArray(fwd) && fwd.length >= 1);
  // exclusive of anchors
  assert.ok(!fwd.includes('LAX') && !fwd.includes('ZUN'));
  const rev = airwaySegmentNames('J78', 'ZUN', 'LAX');
  assert.deepEqual(rev, [...fwd].reverse());
  // unknown anchors -> null
  assert.equal(airwaySegmentNames('J78', 'XXXXX', 'YYYYY'), null);
});
