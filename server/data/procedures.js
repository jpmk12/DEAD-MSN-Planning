// SID / STAR (terminal procedure) expansion. Reads the bundled
// data/procedures.json (produced from the public-domain FAA CIFP). Shape:
//   { "KLTS": { "HHOTT5": { "_": [[lat,lon,"FIX"], ...],
//                            "DALAS": [[lat,lon,"FIX"], ...] } }, ... }
// where each procedure maps transition-name -> ordered fix list ("_" = common
// portion / no transition).
//
// Unavailable (returns null) until the dataset is ingested, so procedure tokens
// are reported as not-expanded rather than guessed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let procs; // { airport: { proc: { transition: [[lat,lon,name]] } } } | null
function load() {
  if (procs !== undefined) return procs;
  try {
    procs = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/procedures.json', import.meta.url)), 'utf8'));
  } catch {
    procs = null;
  }
  return procs;
}

export function proceduresAvailable() {
  const p = load();
  return !!(p && Object.keys(p).length);
}

/**
 * Expand a procedure to ordered points. `name` is the SID/STAR id (e.g. HHOTT5),
 * `airport` the ICAO it belongs to, `transition` optional. Returns
 * [{id,lat,lon,kind:'fix'}] or null when unknown.
 */
export function expandProcedure(name, airport, transition) {
  const p = load();
  if (!p || !name) return null;
  const ap = airport && p[airport.toUpperCase()];
  const proc = ap && ap[name.toUpperCase()];
  if (!proc) return null;
  const common = proc._ || [];
  const trans = transition && proc[transition.toUpperCase()] ? proc[transition.toUpperCase()] : [];
  const seq = [...common, ...trans];
  if (!seq.length) return null;
  return seq.map((c) => ({ id: c[2] || name, lat: c[0], lon: c[1], kind: 'fix' }));
}
