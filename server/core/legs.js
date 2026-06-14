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

/**
 * Equal-Time Point for a scheduled leg, treating its two endpoints as the
 * diversion pair. Continuing groundspeed is the leg's `gsKt`; the return (turn-
 * back) groundspeed has the wind component reversed, i.e. 2·TAS − gsKt. The ETP
 * is where time-back equals time-ahead: distFromStart = D·gsReturn/(gsCont+gsReturn).
 * Returns { fromNm, toNm, lat, lon, etpIso, gsContinueKt, gsReturnKt } or null.
 */
export function legEtp(leg, tasKt) {
  if (!leg || !Number.isFinite(leg.distanceNm) || !Number.isFinite(leg.gsKt)) return null;
  const gsCont = Math.max(60, leg.gsKt);
  const gsRet = Math.max(60, 2 * tasKt - leg.gsKt);
  const fromNm = Math.round(leg.distanceNm * gsRet / (gsCont + gsRet));
  const toNm = leg.distanceNm - fromNm;
  const pos = (Number.isFinite(leg.fromLat) && Number.isFinite(leg.bearingTrue))
    ? destinationPoint(leg.fromLat, leg.fromLon, leg.bearingTrue, fromNm) : null;
  let etpIso = null;
  if (leg.startIso) {
    const start = toMs(leg.startIso);
    if (Number.isFinite(start)) etpIso = new Date(start + (fromNm / gsCont) * 3600000).toISOString();
  }
  return {
    fromNm, toNm,
    lat: pos ? Math.round(pos.lat * 1000) / 1000 : null,
    lon: pos ? Math.round(pos.lon * 1000) / 1000 : null,
    etpIso, gsContinueKt: Math.round(gsCont), gsReturnKt: Math.round(gsRet),
  };
}

/** A field is a usable diversion if it has an open runway ≥ minRunwayFt
 *  (default 7000 ft — a conservative heavy-jet/airlift threshold). */
export function suitableDiversion(ap, minRunwayFt = 7000) {
  return !!ap && Array.isArray(ap.runways) && ap.runways.some((r) => (r.lengthFt || 0) >= minRunwayFt);
}

/** Nearest airports to a point, each tagged with distanceNm, sorted nearest-first.
 *  Optional suitability filter (min runway) and result cap. Pure. */
export function nearestAirports(lat, lon, airports, { maxNm = 400, minRunwayFt = null, limit = 3 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const out = [];
  for (const ap of airports || []) {
    if (ap.lat == null || ap.lon == null) continue;
    if (minRunwayFt != null && !suitableDiversion(ap, minRunwayFt)) continue;
    const d = haversineNm(lat, lon, ap.lat, ap.lon);
    if (d <= maxNm) out.push({ icao: ap.icao, name: ap.name, lat: ap.lat, lon: ap.lon, distanceNm: Math.round(d) });
  }
  return out.sort((a, b) => a.distanceNm - b.distanceNm).slice(0, limit);
}
