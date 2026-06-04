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

const BASE = 'https://davidmegginson.github.io/ourairports-data';
const DEFAULT_FIELDS = ['KCHS', 'KSUU', 'KWRI', 'PHIK', 'KEDW'];

// --- minimal RFC-4180-ish CSV parser (handles quotes, embedded commas) ------
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toObjects(rows) {
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length > 1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

async function fetchCsv(name) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return toObjects(parseCsv(await res.text()));
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' ? n : undefined;
};
const designatorToMag = (ident) => {
  const m = String(ident).match(/^(\d{1,2})/);
  return m ? Number(m[1]) * 10 : undefined;
};

export function buildRunwayEnds(rwy) {
  const ends = [];
  for (const side of ['le', 'he']) {
    const ident = rwy[`${side}_ident`];
    if (!ident) continue;
    const end = { ident };
    const t = num(rwy[`${side}_heading_degT`]);
    if (t != null) end.trueHeading = Math.round(t * 10) / 10;
    const mag = designatorToMag(ident);
    if (mag != null) end.magHeading = mag;
    if (num(rwy.length_ft) != null) end.lengthFt = num(rwy.length_ft);
    if (num(rwy.width_ft) != null) end.widthFt = num(rwy.width_ft);
    if (rwy.surface) end.surface = rwy.surface;
    ends.push(end);
  }
  return ends;
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
