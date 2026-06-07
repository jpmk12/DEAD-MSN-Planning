// Enroute IFR fix / RNAV waypoint resolver (US). Reads the bundled
// data/fixes.json (produced by scripts/ingest-faa-fixes.js from the public-domain
// FAA NASR FIX data). Fix names are not always unique, so each name maps to a
// list of [lat, lon] candidates and we pick the one nearest a reference point.
//
// When data/fixes.json isn't present, the resolver is simply unavailable
// (returns undefined) — fixes show as not-found, never fabricated.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { haversineNm } from '../core/geo.js';

let fixes; // Map<name, [[lat,lon], ...]> | null (null = no dataset bundled)
function load() {
  if (fixes !== undefined) return fixes;
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/fixes.json', import.meta.url)), 'utf8'));
    fixes = new Map(Object.entries(raw));
  } catch {
    fixes = null; // dataset not ingested yet
  }
  return fixes;
}

export function fixesAvailable() {
  const m = load();
  return !!(m && m.size);
}

/** Choose the [lat,lon] candidate nearest `near` ({lat,lon}); first if no ref. */
export function pickFixCoord(list, near) {
  if (!list || !list.length) return undefined;
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon) && list.length > 1) {
    return [...list].sort(
      (a, b) => haversineNm(near.lat, near.lon, a[0], a[1]) - haversineNm(near.lat, near.lon, b[0], b[1]),
    )[0];
  }
  return list[0];
}

/** Resolve an enroute fix by name. Returns {name,lat,lon} or undefined. */
export function resolveFix(id, near) {
  const m = load();
  if (!m) return undefined;
  const c = pickFixCoord(m.get(String(id || '').toUpperCase()), near);
  return c ? { name: String(id).toUpperCase(), lat: c[0], lon: c[1] } : undefined;
}
