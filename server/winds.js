// Route / climb winds: resolve each point (airfield ICAO or navaid identifier)
// to coordinates, then fetch a full winds-aloft profile for it. Powers the
// /api/winds endpoint used by the Route Winds tool.

import { getAirport } from './data/airports.js';
import { resolveNavaid } from './data/ourairports.js';
import { fetchWindsAloft } from './data/windsaloft.js';

async function resolvePoint(id, offline) {
  const ap = await getAirport(id, offline);
  if (ap && ap.lat != null && ap.lon != null) {
    return { kind: 'airport', name: ap.name, lat: ap.lat, lon: ap.lon, elevationFt: ap.elevationFt ?? 0 };
  }
  const nv = await resolveNavaid(id, offline);
  if (nv) {
    return { kind: (nv.type || 'navaid').toString(), name: nv.name, lat: nv.lat, lon: nv.lon, elevationFt: nv.elevationFt ?? 0 };
  }
  return null;
}

export async function buildRouteWinds(ids, offline, targetIso) {
  const points = await Promise.all(
    ids.map(async (id) => {
      const pt = await resolvePoint(id, offline);
      if (!pt) return { id, found: false };
      const w = await fetchWindsAloft(pt.lat, pt.lon, pt.elevationFt, offline, targetIso).catch(() => null);
      return {
        id,
        found: true,
        kind: pt.kind,
        name: pt.name,
        lat: pt.lat,
        lon: pt.lon,
        elevationFt: pt.elevationFt,
        time: w?.time ?? null,
        live: w?.live ?? false,
        profile: w?.profile ?? [],
      };
    }),
  );
  return { generatedAt: new Date().toISOString(), points };
}
