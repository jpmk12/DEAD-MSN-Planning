// Strategic route legs — great-circle geometry + a wind-corrected schedule for
// global/oceanic sortie planning. Pure and dependency-free (same class as the
// density-altitude / astronomy math): given ordered waypoints it returns each
// leg's distance, course, midpoint (for wind sampling) and, with a TAS and
// optional per-leg groundspeed, a cumulative ETA chain. No fabrication — winds
// and field data are layered on by the caller.

import { haversineNm, bearingDeg, destinationPoint } from './geo.js';
import { windComponents } from './wind.js';

const toMs = (when) => (when instanceof Date ? when.getTime() : (typeof when === 'number' ? when : Date.parse(when)));

/**
 * Great-circle geometry for each consecutive waypoint pair. `waypoints` =
 * [{ id, lat, lon }]. Returns [{ fromId, toId, fromLat, fromLon, toLat, toLon,
 * distanceNm, bearingTrue, midLat, midLon }]. Skips pairs missing coordinates.
 */
export function legGeometry(waypoints) {
  const legs = [];
  const wp = (waypoints || []).filter((w) => w && Number.isFinite(w.lat) && Number.isFinite(w.lon));
  for (let i = 0; i < wp.length - 1; i++) {
    const a = wp[i], b = wp[i + 1];
    const distanceNm = Math.round(haversineNm(a.lat, a.lon, b.lat, b.lon));
    const bearingTrue = Math.round(bearingDeg(a.lat, a.lon, b.lat, b.lon));
    const mid = destinationPoint(a.lat, a.lon, bearingTrue, distanceNm / 2);
    legs.push({
      fromId: a.id, toId: b.id,
      fromLat: a.lat, fromLon: a.lon, toLat: b.lat, toLon: b.lon,
      distanceNm, bearingTrue,
      midLat: Math.round(mid.lat * 1000) / 1000, midLon: Math.round(mid.lon * 1000) / 1000,
    });
  }
  return legs;
}

/** Groundspeed (kt) from TAS and a leg wind: TAS minus the along-track headwind
 *  component (negative headwind = tailwind raises GS). Floors at 60 kt so a
 *  modeled gale never yields a zero/negative GS. */
export function groundspeed(tasKt, bearingTrue, wind) {
  if (!wind || typeof wind.speedKt !== 'number') return tasKt;
  const { headwindKt } = windComponents(bearingTrue, wind.dirTrue, wind.speedKt);
  return Math.max(60, Math.round(tasKt - headwindKt));
}

/**
 * Fold a departure time + TAS (and optional per-leg groundspeed) into the legs:
 * each leg gets gsKt, eteMin, startIso, etaIso, and a cumulative ETA chain. Also
 * returns `stops` = [{ id, etaIso, legIndex }] (the first waypoint at departIso,
 * each subsequent at its leg arrival). `gsByLeg[i]` overrides TAS for leg i.
 */
export function scheduleLegs(legs, departIso, tasKt, gsByLeg = null) {
  const start = toMs(departIso);
  const valid = Number.isFinite(start);
  let t = start;
  const outLegs = (legs || []).map((leg, i) => {
    const gsKt = (gsByLeg && Number.isFinite(gsByLeg[i])) ? gsByLeg[i] : tasKt;
    const eteMin = gsKt > 0 ? Math.round((leg.distanceNm / gsKt) * 60) : null;
    const startIso = valid ? new Date(t).toISOString() : null;
    if (valid && eteMin != null) t += eteMin * 60000;
    const etaIso = valid ? new Date(t).toISOString() : null;
    return { ...leg, gsKt, eteMin, startIso, etaIso };
  });
  const stops = [];
  if (legs && legs.length) {
    stops.push({ id: legs[0].fromId, etaIso: valid ? new Date(start).toISOString() : null, legIndex: -1 });
    outLegs.forEach((leg, i) => stops.push({ id: leg.toId, etaIso: leg.etaIso, legIndex: i }));
  }
  const totalNm = outLegs.reduce((s, l) => s + l.distanceNm, 0);
  const totalMin = outLegs.reduce((s, l) => s + (l.eteMin || 0), 0);
  return { legs: outLegs, stops, totalNm, totalMin };
}
