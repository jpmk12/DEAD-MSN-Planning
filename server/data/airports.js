// Airport/runway reference lookup. Loads the bundled curated dataset; this is
// the seam where authoritative FAA NASR (CONUS) / OpenAIP (OCONUS) ingest plugs
// in without touching the analysis engine.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DATA_URL = new URL('../../data/airports.json', import.meta.url);

let cache = null;

async function load() {
  if (cache) return cache;
  const raw = await readFile(fileURLToPath(DATA_URL), 'utf8');
  const parsed = JSON.parse(raw);
  cache = new Map(parsed.airports.map((a) => [a.icao.toUpperCase(), a]));
  return cache;
}

export async function getAirport(icao) {
  return (await load()).get(icao.toUpperCase());
}

export async function knownAirports() {
  return [...(await load()).keys()].sort();
}
