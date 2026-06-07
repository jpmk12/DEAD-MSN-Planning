// Managed Postgres access for cross-device saved sorties (Render Postgres). The
// connection comes from the platform-injected DATABASE_URL (or discrete DB_*/PG*
// vars). A single pooled client is reused; queries are parameterized. When no DB
// is configured, dbConfigured() is false and the app falls back to browser-local
// storage.

import pg from 'pg';
const { Pool } = pg;

export function dbConfigured() {
  // Render injects DATABASE_URL. Also accept discrete vars (DB_*/PG*) so local
  // dev and other hosts work without a URL.
  return Boolean(
    process.env.DATABASE_URL ||
    ((process.env.DB_HOST || process.env.PGHOST) &&
     (process.env.DB_USER || process.env.PGUSER) &&
     (process.env.DB_NAME || process.env.PGDATABASE)),
  );
}

function poolConfig() {
  // Managed providers (Render) terminate TLS on the DB; enable SSL for a
  // non-local URL unless explicitly disabled. Internal/local connections skip it.
  const url = process.env.DATABASE_URL;
  if (url) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const sslOff = process.env.PGSSLMODE === 'disable' || process.env.DB_SSL === 'off';
    return { connectionString: url, ssl: local || sslOff ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 };
  }
  return {
    host: process.env.DB_HOST || process.env.PGHOST,
    port: Number(process.env.DB_PORT || process.env.PGPORT || 5432),
    user: process.env.DB_USER || process.env.PGUSER,
    password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
    database: process.env.DB_NAME || process.env.PGDATABASE,
    connectionTimeoutMillis: 8000,
  };
}

let pool;
let tableReady;

function getPool() {
  if (!pool) pool = new Pool({ ...poolConfig(), max: 4, idleTimeoutMillis: 30000 });
  return pool;
}

async function ensureTable(p) {
  if (tableReady) return tableReady;
  tableReady = p
    .query(
      `CREATE TABLE IF NOT EXISTS sorties (
         name TEXT PRIMARY KEY,
         data JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    )
    .catch((e) => { tableReady = undefined; throw e; }); // allow a later retry
  return tableReady;
}

async function withPool(fn) {
  const p = getPool();
  await ensureTable(p);
  return fn(p);
}

/** @returns {Promise<Record<string, any>>} name -> sortie data */
export async function listSorties() {
  return withPool(async (p) => {
    const { rows } = await p.query('SELECT name, data FROM sorties ORDER BY name');
    const out = {};
    for (const r of rows) out[r.name] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    return out;
  });
}

export async function saveSortie(name, data) {
  return withPool((p) =>
    p.query(
      `INSERT INTO sorties (name, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [name, JSON.stringify(data)],
    ),
  );
}

export async function deleteSortie(name) {
  return withPool((p) => p.query('DELETE FROM sorties WHERE name = $1', [name]));
}
