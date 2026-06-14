// Ingest authoritative airfield/runway data from OurAirports into the format
// the app consumes (data/airports.json).
//
// OurAirports (https://ourairports.com/data/) is free and public domain, with
// GLOBAL coverage and — crucially — surveyed runway TRUE headings
// (le_heading_degT / he_heading_degT), which feed our wind engine directly with
// no magnetic-variation guesswork.
//
// Usage:
//   node scripts/ingest-ourairports.js                 # default field set
//   node scripts/ingest-ourairports.js KCHS KSUU EGLL  # specific ICAOs
//   node scripts/ingest-ourairports.js --out data/airports.json KCHS ...
//
// Requires outbound network to the OurAirports CDN. Run wherever the network
// policy allows (it is blocked in some sandboxes), then commit the output.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Shared parsers live in the runtime module; re-export so tests can import them here.
import { parseCsv, toObjects, buildRunwayEnds, indexRunways, num } from '../server/data/ourairports.js';
export { parseCsv, toObjects, buildRunwayEnds };

const BASE = 'https://davidmegginson.github.io/ourairports-data';
const DEFAULT_FIELDS = ['KCHS', 'KSUU', 'KWRI', 'PHIK', 'KEDW'];

/** One airfield record in the bundled shape the app consumes (TRUE runway
 *  headings; magVar 0). Pure — shared by the per-ICAO and global builders. */
function airportRecord(a, runways) {
  return {
    icao: (a.ident || '').toUpperCase(),
    name: a.name + (a.municipality ? `, ${a.municipality}` : ''),
    elevationFt: num(a.elevation_ft) ?? 0,
    lat: num(a.latitude_deg) ?? null,
    lon: num(a.longitude_deg) ?? null,
    magVar: 0, // headings are TRUE from source; no variation needed
    source: 'ourairports',
    runways,
  };
}

/**
 * Build the GLOBAL airfield bundle from OurAirports rows: every airport of the
 * requested `types` (default large + medium — covers AMC hubs, international and
 * most usable fields worldwide) that has at least one open runway ≥ `minRunwayFt`.
 * Pure (no network) so it's unit-testable; the long tail of small fields still
 * resolves live at runtime. Returns an array sorted by ICAO.
 */
export function buildGlobalAirports(airportObjs, runwayObjs, { types = ['large_airport', 'medium_airport'], minRunwayFt = 0 } = {}) {
  const runwaysByApt = indexRunways(runwayObjs);
  const typeSet = new Set(types);
  const out = [];
  for (const a of airportObjs) {
    const ident = (a.ident || '').toUpperCase();
    if (!ident || !typeSet.has(a.type)) continue;
    const runways = runwaysByApt.get(ident) || [];
    if (minRunwayFt && !runways.some((r) => (r.lengthFt || 0) >= minRunwayFt)) continue;
    out.push(airportRecord(a, runways));
  }
  return out.sort((x, y) => x.icao.localeCompare(y.icao));
}

async function fetchCsv(name) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return toObjects(parseCsv(await res.text()));
}

async function main() {
  const args = process.argv.slice(2);
  let out = fileURLToPath(new URL('../data/airports.json', import.meta.url));
  const ids = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else ids.push(args[i].toUpperCase());
  }
  const wanted = new Set(ids.length ? ids : DEFAULT_FIELDS);

  console.log(`Fetching OurAirports data for: ${[...wanted].join(', ')}`);
  const [airports, runways] = await Promise.all([fetchCsv('airports.csv'), fetchCsv('runways.csv')]);

  const byIdent = new Map();
  for (const a of airports) {
    if (wanted.has((a.ident || '').toUpperCase())) byIdent.set(a.ident.toUpperCase(), a);
  }

  const rwysByIcao = new Map();
  for (const r of runways) {
    const icao = (r.airport_ident || '').toUpperCase();
    if (!wanted.has(icao)) continue;
    if (r.closed === '1') continue; // skip permanently closed runways
    if (!rwysByIcao.has(icao)) rwysByIcao.set(icao, []);
    rwysByIcao.get(icao).push(...buildRunwayEnds(r));
  }

  const result = [];
  for (const icao of wanted) {
    const a = byIdent.get(icao);
    if (!a) { console.warn(`  ! ${icao}: not found in OurAirports`); continue; }
    const runwaysOut = rwysByIcao.get(icao) ?? [];
    if (runwaysOut.length === 0) console.warn(`  ! ${icao}: no open runways found`);
    result.push({
      icao,
      name: a.name + (a.municipality ? `, ${a.municipality}` : ''),
      elevationFt: num(a.elevation_ft) ?? 0,
      lat: num(a.latitude_deg),
      lon: num(a.longitude_deg),
      magVar: 0, // headings are TRUE from source; no variation needed
      source: 'ourairports',
      runways: runwaysOut,
    });
  }

  const payload = {
    _comment:
      'Generated from OurAirports (public domain, https://ourairports.com/data/). ' +
      'Runway headings are TRUE where available. Verify against FLIP/Chart Supplement for operational use.',
    _generatedAt: new Date().toISOString(),
    airports: result.sort((x, y) => x.icao.localeCompare(y.icao)),
  };
  await writeFile(out, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${result.length} airfields to ${out}`);
}

// Only fetch/run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('Ingest failed:', err.message); process.exit(1); });
}
