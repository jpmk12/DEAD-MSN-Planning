// Military Training Routes (MTR) — IR/VR low-level routes. Phase 1: route data,
// map geometry, proximity, and designator lookup. Phase 2: head/crosswind on
// each leg at its altitude block (ties into winds aloft).
//
// Live source: a configurable FAA MTR GeoJSON feature service (MTR_GEOJSON_URL);
// otherwise the bundled native fixture (which carries full per-segment detail).
// Outbound is HTTPS only.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bearingDeg, haversineNm } from '../core/geo.js';
import { windComponents } from '../core/wind.js';
import { geojsonToAirspace, distanceToGeometry } from './airspace.js';
import { fetchWindsAloft, interpolateWind, interpolateScalar, icingAt } from './windsaloft.js';
import { fetchRouteRisk, segmentRisk } from './ahas.js';
import { fetchConvective } from './convective.js';
import { fetchAirSigmets } from './airsigmet.js';
import { fetchPireps } from './pireps.js';

// How close a route's path must pass to a convective/SIGMET area to flag it.
const CONV_ROUTE_NM = 25;
const SIG_ROUTE_NM = 25;
const PIREP_ROUTE_NM = 50; // PIREPs are sparse points — a wider net than area products

/** True when a hazard's altitude band overlaps the route's band (± pad). Items
 *  with no altitude info (both ends null) are kept — can't honestly exclude them.
 *  The pad is generous so a low-level route (AGL block) is never wrongly cleared
 *  of a near-altitude advisory; it only filters out clearly-non-overlapping ones
 *  (e.g. an FL300+ SIGMET on a surface route). */
export function altOverlaps(item, band, pad = 5000) {
  if (!band) return true;
  const lo = typeof item.lowFt === 'number' ? item.lowFt : 0;
  const hi = typeof item.hiFt === 'number' ? item.hiFt : Infinity;
  return lo <= band.maxFt + pad && hi >= band.minFt - pad;
}

/** Hazard areas whose geometry the route path passes within `thresholdNm` of AND
 *  (when `band` is given) whose altitude band overlaps the route's. Each tagged
 *  with the route's closest approach (distanceNm). Pass band=null for products
 *  with no meaningful altitude (e.g. SPC convective outlook = surface risk). */
function hazardsAlongRoute(points, items, thresholdNm, band = null) {
  const out = [];
  for (const it of items || []) {
    if (band && !altOverlaps(it, band)) continue; // skip advisories above/below the route
    let min = Infinity;
    for (const [la, lo] of points) {
      const d = distanceToGeometry(la, lo, it.geometry);
      if (d < min) min = d;
      if (min === 0) break;
    }
    if (min <= thresholdNm) out.push({ ...it, distanceNm: Math.round(min) });
  }
  return out.sort((a, b) => a.distanceNm - b.distanceNm);
}

/** Icing/turbulence/urgent PIREPs near the route path AND near its altitude band
 *  (± 4000 ft buffer; reports with unknown altitude are kept). Sorted nearest-first. */
function pirepsAlongRoute(points, pireps, thresholdNm, band) {
  const out = [];
  for (const p of pireps || []) {
    if (!(p.turb || p.ice || p.urgent)) continue; // only the actionable hazards
    if (p.altFt != null && band && (p.altFt < band.minFt - 4000 || p.altFt > band.maxFt + 4000)) continue;
    let min = Infinity;
    for (const [la, lo] of points) { const d = haversineNm(la, lo, p.lat, p.lon); if (d < min) min = d; }
    if (min <= thresholdNm) out.push({ ...p, distanceNm: Math.round(min) });
  }
  return out.sort((a, b) => a.distanceNm - b.distanceNm);
}

const FIXTURE_URL = new URL('../../data/fixtures/mtr-sample.json', import.meta.url);
const AP1B_URL = new URL('../../data/mtr-ap1b.json', import.meta.url);
const AR_URL = new URL('../../data/ar-ap1b.json', import.meta.url);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && v !== '' ? n : null; };

/** Normalize a designator for matching: "IR-021" / "ir021" -> "IR021". */
export function normalizeId(id) {
  return String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Flatten an MTR's segments into a single centerline for geometry. */
export function routeLine(mtr) {
  const points = [];
  for (const seg of mtr.segments || []) {
    for (const p of seg.points || []) {
      const last = points[points.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) points.push(p);
    }
  }
  return { kind: 'line', points };
}

function withGeometry(mtr) {
  return { ...mtr, geometry: routeLine(mtr) };
}

async function loadJsonArray(url) {
  try {
    return JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
  } catch {
    return [];
  }
}

// Real, authoritative AP/1B routes (IR/VR) + AR refueling tracks. The demo
// sample routes are only included for the offline/test path; production never
// serves them.
async function loadRoutes(includeDemo) {
  // Offline/demo: the bundled sample routes take precedence (tests rely on them),
  // then the real AP/1B set. Production serves only the AP/1B routes. Dedupe by id
  // (first wins) so a demo id shadows a same-id AP/1B route offline, and the live
  // set never double-lists.
  const urls = includeDemo ? [FIXTURE_URL, AP1B_URL, AR_URL] : [AP1B_URL, AR_URL];
  const arrs = await Promise.all(urls.map(loadJsonArray));
  const seen = new Set(); const out = [];
  for (const r of arrs.flat()) {
    const k = String(r.id || '').toUpperCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(withGeometry(r));
  }
  return out;
}

// Map a FAA GeoJSON feature into our MTR record (centerline as one segment).
function mapGeoProps(p, i) {
  const id = p.IDENT ?? p.ROUTE_ID ?? p.designator ?? p.NAME ?? `MTR-${i}`;
  const type = String(id).toUpperCase().startsWith('VR') ? 'VR' : 'IR';
  return {
    id: String(id),
    type,
    name: p.NAME ?? String(id),
    agency: p.SCHED_AGENCY ?? p.AGENCY ?? p.scheduling ?? '',
    _floor: num(p.FLOOR ?? p.MIN_ALT ?? p.LOW_ALT),
    _ceiling: num(p.CEILING ?? p.MAX_ALT ?? p.HIGH_ALT),
  };
}

/** @returns {Promise<{mtrs:any[], live:boolean}>} */
export async function fetchMtrs(offline, signal) {
  const url = process.env.MTR_GEOJSON_URL;
  if (!offline && url) {
    try {
      const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
      if (res.ok) {
        const feats = geojsonToAirspace(await res.json(), mapGeoProps).filter((f) => f.geometry?.kind === 'line');
        const mtrs = feats.map((f) => ({
          id: f.id, type: f.type, name: f.name, agency: f.agency,
          segments: [{ name: 'route', points: f.geometry.points, floorFt: f._floor, ceilingFt: f._ceiling }],
          geometry: f.geometry,
        }));
        return { mtrs, live: true };
      }
    } catch {
      /* fall through to bundled routes */
    }
  }
  // Bundled AP/1B + AR routes are real published data; treat as live. The demo
  // sample routes are added only for the offline/test path.
  return { mtrs: await loadRoutes(offline), live: !offline };
}

export async function lookupMtr(id, offline) {
  const want = normalizeId(id);
  const { mtrs } = await fetchMtrs(offline);
  return mtrs.find((m) => normalizeId(m.id) === want) || null;
}

// "IR-154.C-M" -> { id:'IR-154', entry:'C', exit:'M' }; a plain id otherwise.
export function parseMtrToken(token) {
  const s = String(token || '').trim();
  const m = /^(.+?)\.([A-Z0-9]{1,4})-([A-Z0-9]{1,4})$/i.exec(s);
  if (m) return { id: m[1], entry: m[2].toUpperCase(), exit: m[3].toUpperCase() };
  return { id: s, entry: null, exit: null };
}

const SEG_ENDS = /^\s*(\S+)\s*(?:→|->|—|–|-)\s*(\S+)\s*$/;
/** Ordered labeled turn points [{label, coord:[lat,lon]}] from segment names
 *  like "A → B" … "P → Q", or null when the names aren't point-labelled. */
export function labeledPoints(mtr) {
  const segs = mtr.segments || [];
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const ends = SEG_ENDS.exec(segs[i].name || '');
    const pts = segs[i].points || [];
    if (!ends || pts.length < 2) return null;
    if (i === 0) out.push({ label: ends[1].toUpperCase(), coord: pts[0] });
    out.push({ label: ends[2].toUpperCase(), coord: pts[pts.length - 1] });
  }
  return out.length > 1 ? out : null;
}

const reverseName = (name) => { const m = SEG_ENDS.exec(name || ''); return m ? `${m[2]} → ${m[1]}` : name; };

/** Trim an MTR to the legs between two named points (inclusive), reversing the
 *  direction if the exit precedes the entry. Returns the original when the route
 *  isn't point-labelled or the labels aren't found. */
export function sliceRoute(mtr, entry, exit) {
  if (!entry || !exit) return mtr;
  const lp = labeledPoints(mtr);
  if (!lp) return mtr;
  const i = lp.findIndex((p) => p.label === entry);
  const j = lp.findIndex((p) => p.label === exit);
  if (i < 0 || j < 0 || i === j) return mtr;
  const lo = Math.min(i, j), hi = Math.max(i, j);
  let segs = (mtr.segments || []).slice(lo, hi); // legs lp[lo]..lp[hi]
  if (i > j) segs = segs.slice().reverse().map((s) => ({ ...s, points: [...(s.points || [])].reverse(), name: reverseName(s.name) }));
  const sliced = { ...mtr, segments: segs };
  sliced.geometry = routeLine(sliced);
  return sliced;
}

const midpoint = (pts) => pts[Math.floor(pts.length / 2)] || pts[0];
const segLengthNm = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) s += haversineNm(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  return s;
};

/** Build a detailed MTR view with per-leg winds (Phase 2). Accepts an optional
 *  entry/exit on the token (e.g. "IR-154.C-M") to draw only that portion. */
export async function buildMtrDetail(token, offline, targetIso) {
  const { id, entry, exit } = parseMtrToken(token);
  const base = await lookupMtr(id, offline);
  if (!base) return { found: false, id: token };
  const allPoints = labeledPoints(base);
  const mtr = (entry && exit) ? sliceRoute(base, entry, exit) : base;

  const { risk } = await fetchRouteRisk([base.id], offline, targetIso);
  const routeRisk = risk.get(normalizeId(base.id)) || null;

  const segments = await Promise.all(
    (mtr.segments || []).map(async (seg) => {
      const pts = seg.points || [];
      const first = pts[0];
      const last = pts[pts.length - 1];
      const bearing = first && last ? Math.round(bearingDeg(first[0], first[1], last[0], last[1])) : null;
      const mid = midpoint(pts);
      const targetAlt = seg.ceilingFt != null && seg.floorFt != null
        ? (seg.floorFt + seg.ceilingFt) / 2
        : (seg.ceilingFt ?? seg.floorFt ?? 1500);

      let wind = null;
      let icing = null;
      if (mid) {
        // Sample winds AT the block altitude (e.g. FL250 for an AR FL240–260
        // track). Pass elevFt=0 so the near-surface AGL levels stay near the
        // ground instead of being offset up into a high block (which would put
        // surface winds at altitude), and INTERPOLATE between pressure levels so
        // the block gets its true wind, not the nearest single level.
        const w = await fetchWindsAloft(mid[0], mid[1], 0, offline, targetIso).catch(() => null);
        const lvl = w && w.profile.length ? interpolateWind(w.profile, targetAlt) : null;
        if (lvl && bearing != null) {
          // Temperature + icing potential at the block altitude (same source as
          // the winds). Relevant on AR tracks (FL200+) and route climb alike.
          const tempC = w ? interpolateScalar(w.profile, targetAlt, 'tempC') : null;
          const rhPct = w ? interpolateScalar(w.profile, targetAlt, 'rhPct') : null;
          icing = icingAt(tempC, rhPct);
          const c = windComponents(bearing, lvl.dirTrue, lvl.speedKt);
          wind = {
            altFt: Math.round(targetAlt), dirTrue: lvl.dirTrue, speedKt: lvl.speedKt,
            headwindKt: Math.round(c.headwindKt), crosswindKt: Math.round(c.crosswindKt), crosswindSide: c.crosswindSide,
            tempC: typeof tempC === 'number' ? Math.round(tempC * 10) / 10 : null,
            rhPct: typeof rhPct === 'number' ? Math.round(rhPct) : null,
            live: w.live,
          };
        }
      }
      // AHAS (bird/wildlife) is a low-level product — it does NOT apply to AR
      // refueling tracks (flown at altitude). Never attach a bird level there.
      const isAr = base.type === 'AR';
      return {
        name: seg.name || 'leg',
        floorFt: seg.floorFt ?? null,
        ceilingFt: seg.ceilingFt ?? null,
        agl: seg.agl ?? false,
        altText: seg.altText ?? null,
        widthLeftNm: seg.widthLeftNm ?? null,
        widthRightNm: seg.widthRightNm ?? null,
        bearing,
        lengthNm: Math.round(segLengthNm(pts)),
        wind,
        icing,
        birdRisk: isAr ? null : (segmentRisk(routeRisk, seg.name) ?? (routeRisk ? routeRisk.level : null)),
      };
    }),
  );

  // Convective outlook + SIGMETs + icing/turbulence PIREPs whose area/point the
  // route path crosses (live only; offline stays UNAVAILABLE so it's never implied
  // from fixtures). Closes the ribbon's "CONV n/a" gap with an honest along-route
  // assessment, and surfaces pilot-reported icing/turb on the route itself.
  let convective = null, hazardWx = null, pireps = null, routeWxChecked = false;
  if (!offline) {
    const routePts = [];
    for (const s of (mtr.segments || [])) for (const p of (s.points || [])) routePts.push(p);
    if (routePts.length) {
      // Route altitude band (for PIREP altitude relevance) and a bbox to scope
      // the PIREP fetch to the route's vicinity.
      const floors = (mtr.segments || []).map((s) => s.floorFt).filter((n) => typeof n === 'number');
      const ceils = (mtr.segments || []).map((s) => s.ceilingFt).filter((n) => typeof n === 'number');
      const band = (floors.length || ceils.length)
        ? { minFt: floors.length ? Math.min(...floors) : 0, maxFt: ceils.length ? Math.max(...ceils) : 60000 } : null;
      const lats = routePts.map((p) => p[0]), lons = routePts.map((p) => p[1]);
      const bbox = `${Math.min(...lats) - 2},${Math.min(...lons) - 2},${Math.max(...lats) + 2},${Math.max(...lons) + 2}`;
      const [conv, sig, pir] = await Promise.all([
        fetchConvective(false).catch(() => ({ convective: [] })),
        fetchAirSigmets(false).catch(() => ({ airsigmets: [] })),
        fetchPireps(false, bbox).catch(() => ({ pireps: [] })),
      ]);
      convective = hazardsAlongRoute(routePts, conv.convective, CONV_ROUTE_NM); // surface risk — no alt filter
      hazardWx = hazardsAlongRoute(routePts, sig.airsigmets, SIG_ROUTE_NM, band); // SIGMET/AIRMET carry an alt band
      pireps = pirepsAlongRoute(routePts, pir.pireps, PIREP_ROUTE_NM, band);
      routeWxChecked = true;
    }
  }

  // Normalize the requested time to the AHAS Zulu run-hour so the UI can show
  // (and the user can verify) exactly which hour the bird risk was pulled for.
  const requestedIso = targetIso && !Number.isNaN(Date.parse(targetIso)) ? new Date(targetIso).toISOString() : null;
  // Route-level worst icing across the legs (for the ribbon chip + card summary).
  const ICE_RANK = { TRACE: 1, LIGHT: 2, MODERATE: 3 };
  const worstIcing = segments.reduce((m, s) => (s.icing && (!m || ICE_RANK[s.icing.severity] > ICE_RANK[m.severity]) ? s.icing : m), null);
  return {
    convective,
    hazardWx,
    pireps,
    routeWxChecked,
    // AHAS (bird/wildlife) is a low-level product; it does not apply to AR tracks.
    ahasApplies: base.type !== 'AR',
    icing: worstIcing,
    found: true,
    id: base.id,
    type: base.type,
    name: base.name,
    agency: base.agency,
    refuelAlt: base.refuelAlt ?? null,
    // Available turn points (A…Q) and the flown portion, so the UI can show
    // what's selectable and confirm the entry/exit drawn.
    points: allPoints ? allPoints.map((p) => p.label) : null,
    entry: entry || null,
    exit: exit || null,
    portion: (entry && exit) ? `${entry}-${exit}` : null,
    geometry: mtr.geometry,
    // Carry the AHAS validity (run hour) + the requested time through so the
    // route card can display the period the risk is valid for.
    birdRisk: routeRisk
      ? { level: routeRisk.level, note: routeRisk.note, source: routeRisk.source, runAt: routeRisk.runAt ?? null, requested: requestedIso }
      : null,
    windsAt: requestedIso,
    segments,
  };
}
