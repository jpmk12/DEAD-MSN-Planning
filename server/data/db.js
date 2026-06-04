// Managed MySQL access for cross-device saved sorties. Credentials come from the
// platform-injected DB_* env vars. Connections are short-lived (one per request)
// and queries are parameterized. When DB_* isn't configured (local dev / no DB),
// dbConfigured() is false and the app falls back to browser-local storage.

import mysql from 'mysql2/promise';

export function dbConfigured() {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
}

function connConfig() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: 8000,
  };
}

let tableReady = false;

async function withConn(fn) {
  const conn = await mysql.createConnection(connConfig());
  try {
    if (!tableReady) {
      await conn.execute(
        `CREATE TABLE IF NOT EXISTS sorties (
           name VARCHAR(191) NOT NULL PRIMARY KEY,
           data JSON NOT NULL,
           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         )`,
      );
      tableReady = true;
    }
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

/** @returns {Promise<Record<string, any>>} name -> sortie data */
export async function listSorties() {
  return withConn(async (conn) => {
    const [rows] = await conn.execute('SELECT name, data FROM sorties ORDER BY name');
    const out = {};
    for (const r of rows) out[r.name] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    return out;
  });
}

export async function saveSortie(name, data) {
  return withConn((conn) =>
    conn.execute(
      'INSERT INTO sorties (name, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)',
      [name, JSON.stringify(data)],
    ),
  );
}

export async function deleteSortie(name) {
  return withConn((conn) => conn.execute('DELETE FROM sorties WHERE name = ?', [name]));
}
