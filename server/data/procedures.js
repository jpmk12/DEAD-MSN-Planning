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
 * Expand a procedure to ordered points. `name` is the SID/STAR id (e.g. LGRHD3),
 * `airport` the ICAO it belongs to, `transition` optional. Returns
 * [{name, lat, lon}] where lat/lon may be null (enroute fixes/navaids the route
 * engine resolves at runtime), or null when the procedure is unknown.
 */
export function expandProcedure(name, airport, transition) {
  const p = load();
  if (!p || !name || !airport) return null;
  const ap = p[airport.toUpperCase()];
  const proc = ap && ap[name.toUpperCase()];
  if (!proc) return null;
  const common = proc._ || [];
  let trans = [];
  if (transition && proc[transition.toUpperCase()]) {
    trans = proc[transition.toUpperCase()];
  } else if (!transition) {
    const keys = Object.keys(proc).filter((k) => k !== '_');
    if (keys.length === 1) trans = proc[keys[0]]; // unambiguous single transition
  }
  const seq = [...common, ...trans];
  if (!seq.length) return null;
  const out = [];
  for (const c of seq) {
    const last = out[out.length - 1];
    if (last && last.name === c[2]) continue; // dedupe the joining fix
    out.push({ name: c[2], lat: c[0], lon: c[1] });
  }
  return out;
}
