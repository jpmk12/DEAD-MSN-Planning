// Saved sorties are stored client-side in the browser (localStorage); the app
// runs with NO database and zero runtime dependencies. These stubs keep the
// /api/sorties route contract intact: dbConfigured() is always false, so the
// server reports "not configured" and the front-end persists sorties locally
// (see public/app.js — SORTIE_KEY / loadLocal / saveLocal).
//
// To re-enable a server-side store later (for cross-device sync), reintroduce a
// driver here and have dbConfigured() reflect its env. A Postgres (`pg`)
// implementation lives in this file's git history.

export function dbConfigured() {
  return false;
}

const NO_DB = 'no database configured — saved sorties are stored in the browser';
export async function listSorties() { throw new Error(NO_DB); }
export async function saveSortie() { throw new Error(NO_DB); }
export async function deleteSortie() { throw new Error(NO_DB); }
