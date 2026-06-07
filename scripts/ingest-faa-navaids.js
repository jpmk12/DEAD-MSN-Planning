// Ingest US navaids (VOR/VORTAC/TACAN/DME/NDB) from the FAA NASR into
// data/navaids.json: { "MMB": [ [lat, lon, magVar, "TYPE"], ... ], ... }.
//
// Source: FAA NASR Subscription, "NAV_BASE.csv" (public domain). Unlike
// OurAirports, this includes military TACANs/VORTACs and each station's magnetic
// variation (declination) — needed for correct radial/DME plotting. magVar is
// stored EAST-positive (true = magnetic_radial + magVar). Idents aren't unique,
// so each maps to a list; the resolver picks the nearest to a reference.
//
//   node scripts/ingest-faa-navaids.js path/to/NAV_BASE.csv [--out data/navaids.json]

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCsv, toObjects, num } from '../server/data/ourairports.js';

function rowsToNavaids(rows) {
  const out = {};
  for (const r of rows) {
    const id = String(r.NAV_ID || '').trim().toUpperCase();
    const lat = num(r.LAT_DECIMAL);
    const lon = num(r.LONG_DECIMAL);
    if (!id || lat == null || lon == null) continue;
    let magVar = num(r.MAG_VARN);
    if (magVar != null && String(r.MAG_VARN_HEMIS || '').toUpperCase() === 'W') magVar = -magVar; // East-positive
    const type = String(r.NAV_TYPE || 'NAVAID').trim();
    const rec = [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, magVar ?? 0, type];
    (out[id] ||= []).push(rec);
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
  let out = fileURLToPath(new URL('../data/navaids.json', import.meta.url));
  let src = null;
  for (let i = 0; i < args.length; i++) { if (args[i] === '--out') out = args[++i]; else src = args[i]; }
  if (!src) {
    console.error('Usage: node scripts/ingest-faa-navaids.js <NAV_BASE.csv | URL> [--out data/navaids.json]');
    console.error('Get NAV_BASE.csv from the FAA NASR Subscription (CSV).');
    process.exit(2);
  }
  const navaids = rowsToNavaids(toObjects(parseCsv(await readSource(src))));
  const ids = Object.keys(navaids);
  const dupes = ids.filter((k) => navaids[k].length > 1).length;
  await writeFile(out, JSON.stringify(navaids));
  console.log(`Wrote ${ids.length} navaids (${dupes} with multiple candidates) -> ${out}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

export { rowsToNavaids };
