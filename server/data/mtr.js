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
import { geojsonToAirspace } from './airspace.js';
import { fetchWindsAloft, nearestLevel } from './windsaloft.js';
import { fetchRouteRisk, segmentRisk } from './ahas.js';

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
  const urls = includeDemo ? [AP1B_URL, AR_URL, FIXTURE_URL] : [AP1B_URL, AR_URL];
  const arrs = await Promise.all(urls.map(loadJsonArray));
  return arrs.flat().map(withGeometry);
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

const midpoint = (pts) => pts[Math.floor(pts.length / 2)] || pts[0];
const segLengthNm = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) s += haversineNm(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  return s;
};

/** Build a detailed MTR view with per-leg winds (Phase 2). */
export async function buildMtrDetail(id, offline, targetIso) {
  const mtr = await lookupMtr(id, offline);
  if (!mtr) return { found: false, id };

  const { risk } = await fetchRouteRisk([mtr.id], offline, targetIso);
  const routeRisk = risk.get(normalizeId(mtr.id)) || null;

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
      if (mid) {
        const w = await fetchWindsAloft(mid[0], mid[1], seg.floorFt ?? 0, offline, targetIso).catch(() => null);
        const lvl = w && w.profile.length ? nearestLevel(w.profile, targetAlt) : null;
        if (lvl && bearing != null) {
          const c = windComponents(bearing, lvl.dirTrue, lvl.speedKt);
          wind = {
            altFt: lvl.altFt, dirTrue: lvl.dirTrue, speedKt: lvl.speedKt,
            headwindKt: Math.round(c.headwindKt), crosswindKt: Math.round(c.crosswindKt), crosswindSide: c.crosswindSide,
            live: w.live,
          };
        }
      }
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
        birdRisk: segmentRisk(routeRisk, seg.name) ?? (routeRisk ? routeRisk.level : null),
      };
    }),
  );

  return {
    found: true,
    id: mtr.id,
    type: mtr.type,
    name: mtr.name,
    agency: mtr.agency,
    refuelAlt: mtr.refuelAlt ?? null,
    geometry: mtr.geometry,
    birdRisk: routeRisk ? { level: routeRisk.level, note: routeRisk.note, source: routeRisk.source } : null,
    segments,
  };
}
