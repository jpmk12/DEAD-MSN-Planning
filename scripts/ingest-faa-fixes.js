// Ingest US enroute IFR fixes / RNAV waypoints from the FAA NASR into the format
// the app consumes (data/fixes.json: { "FLOYD": [[lat, lon], ...], ... }).
//
// Source: FAA NASR Subscription, "FIX_BASE.csv" (public domain). Because the
// NASR is distributed as a per-cycle ZIP (and Node has no bundled unzip), point
// this script at an already-extracted FIX_BASE.csv (or a direct CSV URL):
//
//   1) Download the current "NASR Subscription" (CSV) from
//      https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/
//   2) Unzip it and find CSV_Data/FIX_BASE.csv
//   3) node scripts/ingest-faa-fixes.js path/to/FIX_BASE.csv
//      node scripts/ingest-faa-fixes.js https://host/FIX_BASE.csv      # direct CSV
//      node scripts/ingest-faa-fixes.js --out data/fixes.json FIX_BASE.csv
//
// Names aren't globally unique, so each maps to a list of [lat,lon]; the runtime
// resolver (server/data/fixes.js) picks the candidate nearest the briefed field.

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCsv, toObjects, num } from '../server/data/ourairports.js';

const round5 = (n) => Math.round(n * 1e5) / 1e5;

// DMS fallback (LAT_DEG/MIN/SEC/HEMIS) when LAT_DECIMAL isn't populated.
function dms(deg, min, sec, hemis) {
  const d = num(deg), m = num(min) ?? 0, s = num(sec) ?? 0;
  if (d == null) return null;
  const v = d + m / 60 + s / 3600;
  return /[SW]/i.test(hemis || '') ? -v : v;
}

function rowsToFixes(rows) {
  const out = {};
  for (const r of rows) {
    const name = String(r.FIX_ID || r.FIX_ID_OLD || '').trim().toUpperCase();
    if (!name || !/[A-Z]/.test(name)) continue; // skip blanks / pure-numeric artifacts
    const lat = num(r.LAT_DECIMAL) ?? dms(r.LAT_DEG, r.LAT_MIN, r.LAT_SEC, r.LAT_HEMIS);
    const lon = num(r.LONG_DECIMAL) ?? dms(r.LONG_DEG, r.LONG_MIN, r.LONG_SEC, r.LONG_HEMIS);
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const coord = [round5(lat), round5(lon)];
    const list = (out[name] ||= []);
    // de-dupe identical coordinates (NASR lists a fix once per use)
    if (!list.some((c) => c[0] === coord[0] && c[1] === coord[1])) list.push(coord);
  }
  return out;
}

async function readSource(src) {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, { headers: { Accept: 'text/csv' } });
    if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
    return res.text();
  }
  return readFileSync(src, 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  let out = fileURLToPath(new URL('../data/fixes.json', import.meta.url));
  let src = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else src = args[i];
  }
  if (!src) {
    console.error('Usage: node scripts/ingest-faa-fixes.js <FIX_BASE.csv | URL> [--out data/fixes.json]');
    console.error('Get FIX_BASE.csv from the FAA NASR Subscription (CSV): https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/');
    process.exit(2);
  }
  const rows = toObjects(parseCsv(await readSource(src)));
  const fixes = rowsToFixes(rows);
  const names = Object.keys(fixes);
  await writeFile(out, JSON.stringify(fixes));
  const dupes = names.filter((n) => fixes[n].length > 1).length;
  console.log(`Wrote ${names.length} fixes (${dupes} with multiple candidates) -> ${out}`);
}

// Allow importing rowsToFixes in tests without running main.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

export { rowsToFixes };
