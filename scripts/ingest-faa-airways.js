// Ingest US airways (Victor/Jet/T/Q/Alaska/Hawaii) from the FAA NASR into the
// format the app consumes (data/airways.json):
//   { "J78": [ ["FIX1","NAV2","FIX3", ...], ...more sequences ], ... }
//
// Source: FAA NASR Subscription, "AWY_BASE.csv" (public domain). Each row has an
// AWY_ID and an AIRWAY_STRING — the space-separated, ordered list of point names
// along that airway. We store the NAMES only; the route engine resolves each to
// coordinates at runtime (airport/navaid/fix), so airways reuse the same lookups.
// A designator can appear in multiple rows (different locations), so each id maps
// to a LIST of sequences.
//
//   node scripts/ingest-faa-airways.js path/to/AWY_BASE.csv
//   node scripts/ingest-faa-airways.js https://host/AWY_BASE.csv --out data/airways.json

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCsv, toObjects } from '../server/data/ourairports.js';

function rowsToAirways(rows) {
  const out = {};
  for (const r of rows) {
    const id = String(r.AWY_ID || '').trim().toUpperCase();
    const str = String(r.AIRWAY_STRING || '').trim().toUpperCase();
    if (!id || !str) continue;
    const seq = str.split(/\s+/).filter((t) => t && /[A-Z0-9]/.test(t));
    if (seq.length < 2) continue;
    (out[id] ||= []).push(seq);
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
  let out = fileURLToPath(new URL('../data/airways.json', import.meta.url));
  let src = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else src = args[i];
  }
  if (!src) {
    console.error('Usage: node scripts/ingest-faa-airways.js <AWY_BASE.csv | URL> [--out data/airways.json]');
    console.error('Get AWY_BASE.csv from the FAA NASR Subscription (CSV): https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/');
    process.exit(2);
  }
  const airways = rowsToAirways(toObjects(parseCsv(await readSource(src))));
  const ids = Object.keys(airways);
  const multi = ids.filter((k) => airways[k].length > 1).length;
  await writeFile(out, JSON.stringify(airways));
  console.log(`Wrote ${ids.length} airways (${multi} with multiple segments) -> ${out}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

export { rowsToAirways };
