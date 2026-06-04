// Airport/runway reference lookup.
//
// For the demo this loads the bundled curated dataset. The interface is the
// seam where authoritative NASR (CONUS) / OpenAIP (OCONUS) ingest will plug in
// without touching the analysis engine.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Airport } from '../core/types';

const DATA_URL = new URL('../../data/airports.json', import.meta.url);

let cache: Map<string, Airport> | null = null;

async function load(): Promise<Map<string, Airport>> {
  if (cache) return cache;
  const raw = await readFile(fileURLToPath(DATA_URL), 'utf8');
  const parsed = JSON.parse(raw) as { airports: Airport[] };
  cache = new Map(parsed.airports.map((a) => [a.icao.toUpperCase(), a]));
  return cache;
}

export async function getAirport(icao: string): Promise<Airport | undefined> {
  return (await load()).get(icao.toUpperCase());
}

export async function knownAirports(): Promise<string[]> {
  return [...(await load()).keys()].sort();
}
