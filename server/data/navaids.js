// Unified navaid resolver. Prefers the bundled FAA NASR navaids (data/navaids.json
// — includes military TACANs/VORTACs and each station's magnetic variation), and
// falls back to the live OurAirports lookup for anything not in NASR. Both carry
// the fields the route/winds engines need: {ident, name, type, lat, lon, magVar}.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { haversineNm } from '../core/geo.js';
import { resolveNavaid as resolveOurAirportsNavaid } from './ourairports.js';

let nasr; // Map<ident, [[lat,lon,magVar,type], ...]> | null
function load() {
  if (nasr !== undefined) return nasr;
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/navaids.json', import.meta.url)), 'utf8'));
    nasr = new Map(Object.entries(raw));
  } catch {
    nasr = null;
  }
  return nasr;
}

export function nasrNavaidsAvailable() {
  const m = load();
  return !!(m && m.size);
}

function pick(list, near) {
  if (!list || !list.length) return undefined;
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon) && list.length > 1) {
    return [...list].sort((a, b) => haversineNm(near.lat, near.lon, a[0], a[1]) - haversineNm(near.lat, near.lon, b[0], b[1]))[0];
  }
  return list[0];
}

/** Resolve a navaid by ident: bundled NASR first, then OurAirports (network). */
export async function resolveNavaid(id, offline, near) {
  const m = load();
  if (m) {
    const c = pick(m.get(String(id || '').toUpperCase()), near);
    if (c) {
      const ident = String(id).toUpperCase();
      return { ident, name: ident, type: c[3] || 'NAVAID', lat: c[0], lon: c[1], magVar: c[2] ?? null };
    }
  }
  return resolveOurAirportsNavaid(id, offline, near);
}
