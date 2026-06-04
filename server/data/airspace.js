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
  if (geom.kind === 'line' && Array.isArray(geom.points) && geom.points.length) {
    return pointToPolylineNm(lat, lon, geom.points);
  }
  return Infinity;
}

/** Shortest distance (NM) from a point to a polyline, using a local planar approx. */
export function pointToPolylineNm(lat, lon, points) {
  if (points.length === 1) return haversineNm(lat, lon, points[0][0], points[0][1]);
  const ky = 60; // NM per degree latitude
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [alat, alon] = points[i];
    const [blat, blon] = points[i + 1];
    const kx = 60 * Math.cos(((lat + alat + blat) / 3) * (Math.PI / 180));
    const ax = (alon - lon) * kx, ay = (alat - lat) * ky;
    const bx = (blon - lon) * kx, by = (blat - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    min = Math.min(min, Math.hypot(cx, cy));
  }
  return min;
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

/** Convert a GeoJSON geometry to our airspace geometry shape. */
export function geometryFromGeoJson(g) {
  if (!g) return null;
  const ring = (coords) => coords.map(([lon, lat]) => [lat, lon]);
  if (g.type === 'Polygon' && g.coordinates?.[0]) return { kind: 'polygon', points: ring(g.coordinates[0]) };
  if (g.type === 'MultiPolygon' && g.coordinates?.[0]?.[0]) return { kind: 'polygon', points: ring(g.coordinates[0][0]) };
  if (g.type === 'LineString' && g.coordinates) return { kind: 'line', points: ring(g.coordinates) };
  if (g.type === 'MultiLineString' && g.coordinates?.[0]) return { kind: 'line', points: ring(g.coordinates.flat()) };
  if (g.type === 'Point' && g.coordinates) return { kind: 'circle', lat: g.coordinates[1], lon: g.coordinates[0], radiusNm: 5 };
  return null;
}

/**
 * Convert a GeoJSON FeatureCollection into airspace records. `mapper(props, i)`
 * supplies the non-geometry fields (id/name/type/status/etc.) from the feature
 * properties, whose names vary by FAA/OpenAIP service.
 */
export function geojsonToAirspace(geojson, mapper) {
  const feats = geojson?.features ?? [];
  return feats
    .map((f, i) => ({ ...mapper(f.properties ?? {}, i), geometry: geometryFromGeoJson(f.geometry) }))
    .filter((x) => x.geometry);
}

async function fetchGeoJson(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GeoJSON ${res.status} for ${url}`);
  return res.json();
}

const firstProp = (props, keys, fallback) => {
  for (const k of keys) if (props[k] != null && props[k] !== '') return props[k];
  return fallback;
};

/** @returns {Promise<{tfrs:any[], live:boolean}>} */
export async function fetchTfrs(offline, signal) {
  const url = process.env.TFR_GEOJSON_URL;
  if (!offline && url) {
    try {
      const gj = await fetchGeoJson(url, signal);
      const tfrs = geojsonToAirspace(gj, (p, i) => ({
        id: firstProp(p, ['NOTAM_ID', 'notam_id', 'id'], `TFR-${i}`),
        type: firstProp(p, ['TYPE', 'type'], 'HAZARD'),
        name: firstProp(p, ['NAME', 'name', 'DESCRIPTION'], 'TFR'),
        upperFt: Number(firstProp(p, ['MAX_ALT', 'upperFt'], 0)) || null,
        lowerFt: Number(firstProp(p, ['MIN_ALT', 'lowerFt'], 0)) || 0,
        effectiveStart: firstProp(p, ['START', 'effectiveStart'], null),
        effectiveEnd: firstProp(p, ['END', 'effectiveEnd'], null),
        url: firstProp(p, ['URL', 'url'], 'https://tfr.faa.gov'),
      }));
      return { tfrs, live: true };
    } catch {
      /* fall through to fixture */
    }
  }
  return { tfrs: await loadJson(TFR_FIXTURE), live: false };
}

/** @returns {Promise<{sua:any[], live:boolean}>} */
export async function fetchSua(offline, signal) {
  const url = process.env.SUA_GEOJSON_URL;
  if (!offline && url) {
    try {
      const gj = await fetchGeoJson(url, signal);
      const sua = geojsonToAirspace(gj, (p, i) => ({
        id: firstProp(p, ['IDENT', 'NAME', 'name'], `SUA-${i}`),
        name: firstProp(p, ['NAME', 'name'], 'Special Use Airspace'),
        type: String(firstProp(p, ['TYPE_CODE', 'TYPE', 'type'], 'MOA')).toUpperCase(),
        status: String(firstProp(p, ['STATUS', 'status'], 'cold')).toLowerCase(),
        schedule: firstProp(p, ['SCHEDULE', 'schedule'], ''),
        lowerFt: Number(firstProp(p, ['LOWER_VAL', 'lowerFt'], 0)) || 0,
        upperFt: Number(firstProp(p, ['UPPER_VAL', 'upperFt'], 0)) || null,
        effectiveStart: null,
        effectiveEnd: null,
      }));
      return { sua, live: true };
    } catch {
      /* fall through to fixture */
    }
  }
  return { sua: await loadJson(SUA_FIXTURE), live: false };
}
