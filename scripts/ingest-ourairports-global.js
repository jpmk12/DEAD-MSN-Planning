// Build the GLOBAL airfield bundle (data/airports-global.json) from OurAirports
// so any major field worldwide — AMC hubs, international airports, oceanic
// diversions — resolves instantly and offline, instead of depending on a live
// fetch at runtime. The long tail of small fields still resolves live.
//
// Default scope: large + medium airports (~10–12k worldwide, a few MB). Tune:
//   node scripts/ingest-ourairports-global.js
//   node scripts/ingest-ourairports-global.js --types large_airport,medium_airport --min-runway 4000
//   node scripts/ingest-ourairports-global.js --out data/airports-global.json
//
// Requires outbound network to the OurAirports CDN (blocked in some sandboxes —
// run where the network policy allows, then commit the output). The app works
// without this file (live fallback); it just makes global coverage robust.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCsv, toObjects } from '../server/data/ourairports.js';
import { buildGlobalAirports } from './ingest-ourairports.js';

const BASE = 'https://davidmegginson.github.io/ourairports-data';

async function fetchCsv(name) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return toObjects(parseCsv(await res.text()));
}

async function main() {
  const args = process.argv.slice(2);
  let out = fileURLToPath(new URL('../data/airports-global.json', import.meta.url));
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
    _comment:
      'GLOBAL airfield bundle generated from OurAirports (public domain, https://ourairports.com/data/). ' +
      'Runway headings are TRUE where available. Subset for robust offline resolution; the long tail resolves live. ' +
      'Verify against FLIP/Chart Supplement for operational use.',
    _generatedAt: new Date().toISOString(),
    _types: types,
    _minRunwayFt: minRunwayFt,
    airports: result,
  };
  await writeFile(out, JSON.stringify(payload) + '\n');
  console.log(`Wrote ${result.length} airfields to ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('Global ingest failed:', err.message); process.exit(1); });
}
