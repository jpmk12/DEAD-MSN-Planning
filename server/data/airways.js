// Airway expansion (Victor/Jet/T/Q/Alaska/Hawaii routes). Reads the bundled
// data/airways.json (produced by scripts/ingest-faa-airways.js from the
// public-domain FAA NASR AWY_BASE). Shape: { "J78": [ ["FIX1","NAV2",...], ... ] }
// — each airway id maps to a LIST of ordered name-sequences (a list because some
// designators recur in different locations, e.g. V1 CONUS vs Alaska).
//
// Coordinates aren't stored here: the route engine resolves each point NAME at
// runtime (airport/navaid/fix) so airways reuse the same authoritative lookups.
// When the dataset isn't present the module is simply unavailable.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let airways; // Map<id, string[][]> | null
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

/**
 * Intermediate point NAMES along airway `id` between `fromName` and `toName`
 * (exclusive of both). Picks the segment/sequence that contains both anchors,
 * honoring travel direction. Returns string[] or null when not found.
 */
export function airwaySegmentNames(id, fromName, toName) {
  const m = load();
  const seqs = m && m.get(String(id || '').toUpperCase());
  if (!seqs) return null;
  const F = String(fromName || '').toUpperCase();
  const T = String(toName || '').toUpperCase();
  for (const seq of seqs) {
    const i = seq.indexOf(F);
    const j = seq.indexOf(T);
    if (i >= 0 && j >= 0 && i !== j) {
      const step = i < j ? 1 : -1;
      const out = [];
      for (let k = i + step; k !== j; k += step) out.push(seq[k]);
      return out;
    }
  }
  return null;
}
