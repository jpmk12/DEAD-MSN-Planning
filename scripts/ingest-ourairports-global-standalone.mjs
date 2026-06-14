// STANDALONE global airfield bundle generator — no repo imports, run from anywhere
// (e.g. your Downloads folder) on a machine with open internet. Mirrors the
// tested logic in scripts/ingest-ourairports.js (buildGlobalAirports); kept
// self-contained on purpose so it has zero path/ESM friction.
//
// Usage (Node 18+):
//   node ingest-ourairports-global-standalone.mjs
//   node ingest-ourairports-global-standalone.mjs --out airports-global.json
//   node ingest-ourairports-global-standalone.mjs --types large_airport,medium_airport --min-runway 4000
//
// Writes airports-global.json in the current folder. Then copy it into the repo's
// data/ folder (data/airports-global.json) and commit it.

import { writeFile } from 'node:fs/promises';

const BASE = 'https://davidmegginson.github.io/ourairports-data';

// ---- CSV helpers (identical behavior to the repo's parser) ------------------
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function toObjects(rows) {
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length > 1).map((r) => {
    const o = {}; header.forEach((h, i) => { o[h] = r[i]; }); return o;
  });
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) && v !== '' ? n : undefined; };
const designatorToMag = (ident) => { const m = String(ident).match(/^(\d{1,2})/); return m ? Number(m[1]) * 10 : undefined; };

function buildRunwayEnds(rwy) {
  const ends = [];
  for (const side of ['le', 'he']) {
    const ident = rwy[`${side}_ident`]; if (!ident) continue;
    const end = { ident };
    const t = num(rwy[`${side}_heading_degT`]); if (t != null) end.trueHeading = Math.round(t * 10) / 10;
    const mag = designatorToMag(ident); if (mag != null) end.magHeading = mag;
    if (num(rwy.length_ft) != null) end.lengthFt = num(rwy.length_ft);
    if (num(rwy.width_ft) != null) end.widthFt = num(rwy.width_ft);
    if (rwy.surface) end.surface = rwy.surface;
    ends.push(end);
  }
  return ends;
}
function indexRunways(runwayObjs) {
  const byApt = new Map();
  for (const r of runwayObjs) {
    if (r.closed === '1') continue;
    const k = (r.airport_ident || '').toUpperCase(); if (!k) continue;
    if (!byApt.has(k)) byApt.set(k, []);
    byApt.get(k).push(...buildRunwayEnds(r));
  }
  return byApt;
}
function buildGlobalAirports(airportObjs, runwayObjs, { types, minRunwayFt }) {
  const runwaysByApt = indexRunways(runwayObjs);
  const typeSet = new Set(types);
  const out = [];
  for (const a of airportObjs) {
    const ident = (a.ident || '').toUpperCase();
    if (!ident || !typeSet.has(a.type)) continue;
    const runways = runwaysByApt.get(ident) || [];
    if (minRunwayFt && !runways.some((r) => (r.lengthFt || 0) >= minRunwayFt)) continue;
    out.push({
      icao: ident,
      name: a.name + (a.municipality ? `, ${a.municipality}` : ''),
      elevationFt: num(a.elevation_ft) ?? 0,
      lat: num(a.latitude_deg) ?? null,
      lon: num(a.longitude_deg) ?? null,
      magVar: 0,
      source: 'ourairports',
      runways,
    });
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
  let out = 'airports-global.json';
  let types = ['large_airport', 'medium_airport'];
  let minRunwayFt = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--types') types = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (args[i] === '--min-runway') minRunwayFt = Number(args[++i]) || 0;
  }
  console.log(`Fetching OurAirports airports + runways (types: ${types.join(', ')}${minRunwayFt ? `, min runway ${minRunwayFt} ft` : ''})…`);
  const [airports, runways] = await Promise.all([fetchCsv('airports.csv'), fetchCsv('runways.csv')]);
  const result = buildGlobalAirports(airports, runways, { types, minRunwayFt });
  const payload = {
    _comment: 'GLOBAL airfield bundle from OurAirports (public domain, https://ourairports.com/data/). TRUE runway headings where available. Verify against FLIP/Chart Supplement for operational use.',
    _generatedAt: new Date().toISOString(),
    _types: types,
    _minRunwayFt: minRunwayFt,
    airports: result,
  };
  await writeFile(out, JSON.stringify(payload) + '\n');
  console.log(`Wrote ${result.length} airfields to ${out}`);
  console.log('Next: copy this file to the repo as data/airports-global.json, then commit it.');
}

main().catch((err) => { console.error('Global ingest failed:', err.message); process.exit(1); });
