// Route-of-flight parser: turn a free-text route string into ordered, resolved
// points and a polyline the map can draw. Supports:
//   - named points: airport ICAO, navaid, enroute fix (airport→navaid→fix)
//   - DCT / direct connectors (ignored)
//   - radial/DME off a navaid: LRP270015  or  LRP270/15  (magnetic radial)
//   - lat/long: 3407N10006W (dd[mm[ss]] / ddd[mm[ss]])
//   - airways: J78, V16, … expanded between the surrounding fixes (needs the
//     bundled NASR airway data; otherwise reported as not-expanded)
//   - SID/STAR procedures: NAME or NAME.TRANSITION (needs the bundled CIFP data)
//
// Everything is resolved server-side using the same data the winds tool uses, so
// the front end just draws the returned geometry.

import { getAirport } from './data/airports.js';
import { resolveNavaid } from './data/ourairports.js';
import { resolveFix } from './data/fixes.js';
import { airwaysAvailable, hasAirway, airwaySegmentNames } from './data/airways.js';
import { proceduresAvailable, expandProcedure } from './data/procedures.js';
import { destinationPoint, haversineNm, bearingDeg, normalize360 } from './core/geo.js';

const CONNECTORS = new Set(['DCT', 'DIRECT', '.', '..']);
const RADIAL_DME = /^([A-Z]{2,3})(\d{3})(\d{3})$/;          // LRP270015
const RADIAL_DME_SLASH = /^([A-Z]{2,3})(\d{3})\/(\d{1,3})$/; // LRP270/15
const LATLON = /^(\d{2,6})([NS])(\d{3,7})([EW])$/;          // 3407N10006W
const AIRWAY_LIKE = /^[A-Z]{1,2}\d{1,4}[A-Z]?$/;            // J78 / V16 / Q42 / T123

function dmsParse(digits, hemi, isLat) {
  const degLen = isLat ? 2 : 3;
  if (digits.length < degLen) return null;
  const deg = Number(digits.slice(0, degLen));
  const rest = digits.slice(degLen);
  const min = rest.length >= 2 ? Number(rest.slice(0, 2)) : 0;
  const sec = rest.length >= 4 ? Number(rest.slice(2, 4)) : 0;
  let v = deg + min / 60 + sec / 3600;
  if (hemi === 'S' || hemi === 'W') v = -v;
  return v;
}

function parseLatLon(tok) {
  const m = LATLON.exec(tok);
  if (!m) return null;
  const lat = dmsParse(m[1], m[2], true);
  const lon = dmsParse(m[3], m[4], false);
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { id: tok, kind: 'coord', lat, lon };
}

async function tryRadialDme(tok, offline, near) {
  const m = RADIAL_DME.exec(tok) || RADIAL_DME_SLASH.exec(tok);
  if (!m) return null;
  const ident = m[1], radial = Number(m[2]), dist = Number(m[3]);
  if (radial > 360 || dist === 0) return null;
  const nv = await resolveNavaid(ident, offline, near);
  if (!nv) return { unresolved: true, raw: tok, note: `radial/DME base navaid ${ident} not found` };
  // Published radials are MAGNETIC; convert to true with the station's
  // declination (East variation positive): true = magnetic + variation.
  const trueBrg = normalize360(radial + (nv.magVar ?? 0));
  const d = destinationPoint(nv.lat, nv.lon, trueBrg, dist);
  return { id: tok, kind: 'rdme', lat: d.lat, lon: d.lon };
}

async function resolveNamed(id, offline, near) {
  const ap = await getAirport(id, offline);
  if (ap && ap.lat != null && ap.lon != null) return { id, kind: 'airport', lat: ap.lat, lon: ap.lon };
  const nv = await resolveNavaid(id, offline, near);
  if (nv) return { id, kind: 'navaid', lat: nv.lat, lon: nv.lon };
  const fx = resolveFix(id, near);
  if (fx) return { id, kind: 'fix', lat: fx.lat, lon: fx.lon };
  return null;
}

const isPt = (e) => e && Number.isFinite(e.lat) && Number.isFinite(e.lon);
const lastPoint = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (isPt(arr[i])) return arr[i]; return null; };
const nextPoint = (arr, start) => { for (let i = start; i < arr.length; i++) if (isPt(arr[i])) return arr[i]; return null; };

/**
 * @param {string} routeStr  free-text route of flight
 * @param {boolean} offline
 * @param {?{lat:number,lon:number}} near  reference for navaid/fix disambiguation
 */
export async function buildRoute(routeStr, offline, near) {
  const tokens = String(routeStr || '').trim().toUpperCase().split(/\s+/).filter(Boolean).slice(0, 200);
  const entries = [];
  for (const tok of tokens) {
    if (CONNECTORS.has(tok)) continue;
    const ll = parseLatLon(tok); if (ll) { entries.push(ll); continue; }
    const rd = await tryRadialDme(tok, offline, near); if (rd) { entries.push(rd); continue; }
    if (hasAirway(tok)) { entries.push({ airway: tok }); continue; }
    const np = await resolveNamed(tok, offline, near); if (np) { entries.push(np); continue; }
    if (AIRWAY_LIKE.test(tok)) { entries.push({ unresolved: true, raw: tok, note: airwaysAvailable() ? 'unknown airway' : 'airway data not loaded' }); continue; }
    // SID/STAR: NAME or NAME.TRANSITION, anchored to the first airport in the route.
    const [pname, ptrans] = tok.split('.');
    const depAp = entries.find((e) => e.kind === 'airport');
    const proc = expandProcedure(pname, depAp?.id, ptrans || null);
    if (proc && proc.length) { entries.push(...proc); continue; }
    entries.push({ unresolved: true, raw: tok, note: proceduresAvailable() ? 'unknown point/procedure' : 'not found' });
  }

  // Expand airways between their surrounding anchor points: look up the ordered
  // point NAMES for the segment, then resolve each at runtime (biased to the
  // entry anchor so navaid/fix idents pick the nearby one).
  const expanded = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.airway) {
      const from = lastPoint(expanded);
      const to = nextPoint(entries, i + 1);
      const names = (from && to) ? airwaySegmentNames(e.airway, from.id, to.id) : null;
      if (names) {
        const bias = from ? { lat: from.lat, lon: from.lon } : near;
        for (const nm of names) {
          const p = await resolveNamed(nm, offline, bias);
          if (p) expanded.push(p);
          else expanded.push({ unresolved: true, raw: `${e.airway}:${nm}`, note: 'airway point not found' });
        }
      } else {
        expanded.push({ unresolved: true, raw: e.airway, note: airwaysAvailable() ? 'airway segment not found — check entry/exit fixes' : 'airway data not loaded' });
      }
      continue;
    }
    expanded.push(e);
  }

  const points = expanded.filter(isPt);
  const unresolved = expanded.filter((e) => e.unresolved).map((e) => ({ token: e.raw, note: e.note }));
  let totalNm = 0;
  const legs = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dist = haversineNm(a.lat, a.lon, b.lat, b.lon);
    totalNm += dist;
    legs.push({ from: a.id, to: b.id, distNm: Math.round(dist), bearingTrue: Math.round(bearingDeg(a.lat, a.lon, b.lat, b.lon)) });
  }
  return {
    points: points.map((p) => ({ id: p.id, kind: p.kind, lat: p.lat, lon: p.lon })),
    geometry: { kind: 'line', points: points.map((p) => [p.lat, p.lon]) },
    legs,
    totalNm: Math.round(totalNm),
    unresolved,
  };
}
