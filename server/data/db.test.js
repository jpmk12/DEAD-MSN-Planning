import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbConfigured } from './db.js';

test('dbConfigured reflects the DB_* env vars', () => {
  const saved = { h: process.env.DB_HOST, u: process.env.DB_USER, n: process.env.DB_NAME };
  delete process.env.DB_HOST; delete process.env.DB_USER; delete process.env.DB_NAME;
  assert.equal(dbConfigured(), false);

  process.env.DB_HOST = 'localhost';
  process.env.DB_USER = 'app';
  process.env.DB_NAME = 'appdb';
  assert.equal(dbConfigured(), true);

  // restore
  if (saved.h === undefined) delete process.env.DB_HOST; else process.env.DB_HOST = saved.h;
  if (saved.u === undefined) delete process.env.DB_USER; else process.env.DB_USER = saved.u;
  if (saved.n === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = saved.n;
});
