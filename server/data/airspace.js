// Airspace layer: Temporary Flight Restrictions (TFRs) and Special Use Airspace
// (SUA — MOAs, Restricted/Warning/Alert areas) with geometry and proximity.
//
// Live sources (run where the network policy allows; fixtures used otherwise):
//   - TFRs: FAA https://tfr.faa.gov (per-NOTAM XML) — geometry + schedule.
//   - SUA : FAA https://sua.faa.gov (SUA/ISE status) + class/SUA shapefiles.
// Both are awkward to parse robustly; this module exposes a clean shape and a
// fixture fallback, and is the seam where real ingest plugs in.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { haversineNm } from '../core/geo.js';

const TFR_FIXTURE = new URL('../../data/fixtures/tfr-sample.json', import.meta.url);
const SUA_FIXTURE = new URL('../../data/fixtures/sua-sample.json', import.meta.url);

/** Nautical-mile distance from a point to an airspace geometry (0 = inside). */
export function distanceToGeometry(lat, lon, geom) {
  if (!geom) return Infinity;
  if (geom.kind === 'circle') {
    return Math.max(0, haversineNm(lat, lon, geom.lat, geom.lon) - geom.radiusNm);
  }
  if (geom.kind === 'polygon' && Array.isArray(geom.points) && geom.points.length) {
    // Approximate: distance to the nearest vertex (advisory-grade).
    return Math.min(...geom.points.map(([la, lo]) => haversineNm(lat, lon, la, lo)));
  }
  return Infinity;
}

/** Items within `thresholdNm` of the field, annotated with distance, nearest first. */
export function nearby(lat, lon, items, thresholdNm) {
  if (lat == null || lon == null) return [];
  return items
    .map((it) => ({ ...it, distanceNm: Math.round(distanceToGeometry(lat, lon, it.geometry)) }))
    .filter((it) => it.distanceNm <= thresholdNm)
    .sort((a, b) => a.distanceNm - b.distanceNm);
}

async function loadJson(url) {
  return JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
}

/** @returns {Promise<{tfrs:any[], live:boolean}>} */
export async function fetchTfrs(offline) {
  // Live FAA TFR ingest would go here when offline === false and reachable.
  void offline;
  return { tfrs: await loadJson(TFR_FIXTURE), live: false };
}

/** @returns {Promise<{sua:any[], live:boolean}>} */
export async function fetchSua(offline) {
  void offline;
  return { sua: await loadJson(SUA_FIXTURE), live: false };
}
