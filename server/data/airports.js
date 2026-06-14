// Airport/runway reference lookup. Loads the bundled curated dataset; this is
// the seam where authoritative FAA NASR (CONUS) / OpenAIP (OCONUS) ingest plugs
// in without touching the analysis engine.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveAirport } from './ourairports.js';

const DATA_URL = new URL('../../data/airports.json', import.meta.url);
// Optional GLOBAL bundle (data/airports-global.json) — produced by
// scripts/ingest-ourairports-global.js. When present it gives instant, offline
// worldwide coverage (AMC hubs, international fields, oceanic diversions); when
// absent the app falls back to live OurAirports resolution. Either way works.
const GLOBAL_URL = new URL('../../data/airports-global.json', import.meta.url);

let cache = null;
let globalCache; // undefined = not yet loaded, null = file absent

async function load() {
  if (cache) return cache;
  const raw = await readFile(fileURLToPath(DATA_URL), 'utf8');
  const parsed = JSON.parse(raw);
  cache = new Map(parsed.airports.map((a) => [a.icao.toUpperCase(), a]));
  return cache;
}

async function loadGlobal() {
  if (globalCache !== undefined) return globalCache;
  try {
    const parsed = JSON.parse(await readFile(fileURLToPath(GLOBAL_URL), 'utf8'));
    globalCache = new Map((parsed.airports || []).map((a) => [a.icao.toUpperCase(), a]));
  } catch {
    globalCache = null; // not generated yet — rely on the live resolver
  }
  return globalCache;
}

/**
 * Look up an airfield. Resolution order: curated set (hand-verified) → global
 * bundle (instant, offline, worldwide) → live OurAirports (the long tail) unless
 * `offline`. The first two are instant and need no network.
 */
export async function getAirport(icao, offline = false) {
  const key = icao.toUpperCase();
  const curated = (await load()).get(key);
  if (curated) return curated;
  const global = (await loadGlobal())?.get(key);
  if (global) return global;
  return resolveAirport(icao, offline);
}

export async function knownAirports() {
  return [...(await load()).keys()].sort();
}

/**
 * The searchable airfield pool for diversion/ETP planning: curated + the global
 * bundle (deduped by ICAO, curated wins). The live OurAirports long tail isn't
 * enumerable cheaply, so the bundle IS the diversion candidate set — generate it
 * with scripts/ingest-ourairports-global.js for full worldwide coverage.
 */
export async function allAirports() {
  const byIcao = new Map();
  const g = await loadGlobal();
  if (g) for (const [k, v] of g) byIcao.set(k, v);
  for (const [k, v] of await load()) byIcao.set(k, v); // curated overrides
  return [...byIcao.values()];
}
