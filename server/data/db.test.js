import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbConfigured } from './db.js';

test('dbConfigured reflects DATABASE_URL / discrete DB_* vars', () => {
  const saved = { url: process.env.DATABASE_URL, h: process.env.DB_HOST, u: process.env.DB_USER, n: process.env.DB_NAME };
  const clear = () => { delete process.env.DATABASE_URL; delete process.env.DB_HOST; delete process.env.DB_USER; delete process.env.DB_NAME; };

  clear();
  assert.equal(dbConfigured(), false);

  // Render-style single connection string.
  process.env.DATABASE_URL = 'postgres://app:secret@db.internal:5432/appdb';
  assert.equal(dbConfigured(), true);
  delete process.env.DATABASE_URL;

  // Discrete host/user/name (local dev / other hosts).
  process.env.DB_HOST = 'localhost';
  process.env.DB_USER = 'app';
  process.env.DB_NAME = 'appdb';
  assert.equal(dbConfigured(), true);

  // restore
  clear();
  if (saved.url !== undefined) process.env.DATABASE_URL = saved.url;
  if (saved.h !== undefined) process.env.DB_HOST = saved.h;
  if (saved.u !== undefined) process.env.DB_USER = saved.u;
  if (saved.n !== undefined) process.env.DB_NAME = saved.n;
});
