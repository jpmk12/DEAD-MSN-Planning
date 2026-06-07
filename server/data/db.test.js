import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbConfigured } from './db.js';

test('dbConfigured is false — the app is local-only (no server DB)', () => {
  // Saved sorties persist in the browser; there is no server-side database.
  assert.equal(dbConfigured(), false);
});
