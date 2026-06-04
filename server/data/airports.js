// Airport/runway reference lookup. Loads the bundled curated dataset; this is
// the seam where authoritative FAA NASR (CONUS) / OpenAIP (OCONUS) ingest plugs
// in without touching the analysis engine.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveAirport } from './ourairports.js';

const DATA_URL = new URL('../../data/airports.json', import.meta.url);

let cache = null;

async function load() {
  if (cache) return cache;
  const raw = await readFile(fileURLToPath(DATA_URL), 'utf8');
  const parsed = JSON.parse(raw);
  cache = new Map(parsed.airports.map((a) => [a.icao.toUpperCase(), a]));
  return cache;
}

/**
 * Look up an airfield. The bundled curated set is checked first (instant,
 * offline); anything else is resolved live from OurAirports unless `offline`.
 */
export async function getAirport(icao, offline = false) {
  const bundled = (await load()).get(icao.toUpperCase());
  if (bundled) return bundled;
  return resolveAirport(icao, offline);
}

export async function knownAirports() {
  return [...(await load()).keys()].sort();
}
