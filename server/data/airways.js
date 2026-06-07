// Airway expansion (Victor/Jet/T/Q routes). Reads the bundled data/airways.json
// (produced by scripts/ingest-faa-airways.js from the public-domain FAA NASR AWY
// data). Shape: { "J78": [ [lat, lon, "FIXNAME"], ... ordered ], ... }.
//
// When the dataset isn't present the module is simply unavailable (returns null),
// and route parsing reports airway tokens as not-expanded rather than guessing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { haversineNm } from '../core/geo.js';

let airways; // Map<id, [[lat,lon,name], ...]> | null
function load() {
  if (airways !== undefined) return airways;
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/airways.json', import.meta.url)), 'utf8'));
    airways = new Map(Object.entries(raw));
  } catch {
    airways = null;
  }
  return airways;
}

export function airwaysAvailable() {
  const m = load();
  return !!(m && m.size);
}

export function hasAirway(id) {
  const m = load();
  return !!(m && m.has(String(id || '').toUpperCase()));
}

/** Index of the airway point nearest a given lat/lon (to anchor expansion when
 *  the entry/exit fix name isn't an exact match). */
function nearestIdx(points, lat, lon) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = haversineNm(lat, lon, points[i][0], points[i][1]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Expand airway `id` between the entry point `from` and exit point `to`
 * ({id,lat,lon}). Returns the INTERMEDIATE points (exclusive of from/to) as
 * [{id,lat,lon}] in route order, or null when the airway/segment isn't known.
 */
export function expandAirway(id, from, to) {
  const m = load();
  const pts = m && m.get(String(id || '').toUpperCase());
  if (!pts || pts.length < 2 || !from || !to) return null;
  const byName = (p) => pts.findIndex((q) => q[2] && p.id && q[2].toUpperCase() === p.id.toUpperCase());
  let i = byName(from); if (i < 0) i = nearestIdx(pts, from.lat, from.lon);
  let j = byName(to);   if (j < 0) j = nearestIdx(pts, to.lat, to.lon);
  if (i < 0 || j < 0 || i === j) return null;
  const step = i < j ? 1 : -1;
  const out = [];
  for (let k = i + step; k !== j; k += step) out.push({ id: pts[k][2] || `${id}`, lat: pts[k][0], lon: pts[k][1], kind: 'fix' });
  return out;
}
