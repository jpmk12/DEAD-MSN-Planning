import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nasrNavaidsAvailable, resolveNavaid } from './navaids.js';

// Runs against the bundled data/navaids.json (FAA NASR NAV_BASE).
test('NASR navaids are bundled and include military VORTAC/TACAN', () => {
  assert.equal(nasrNavaidsAvailable(), true);
});

test('resolveNavaid returns coords + station declination from NASR', async () => {
  const n = await resolveNavaid('MMB', true); // offline: bundled NASR only
  assert.ok(n, 'MMB resolves');
  assert.equal(n.type, 'VORTAC');
  assert.ok(Number.isFinite(n.lat) && Number.isFinite(n.lon));
  assert.equal(typeof n.magVar, 'number'); // East-positive declination for radials
});
