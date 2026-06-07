// OurAirports runtime resolver — looks up airfields AND navaids on demand from
// the public-domain OurAirports dataset, so any field/navaid the user types
// works (not just the bundled set). Data is fetched once and cached in memory;
// callers pass `offline` to skip the network (sandbox/demo), in which case
// nothing is fetched and the bundled dataset remains the only source.
//
// Outbound is HTTPS only (port 443) — compatible with the hosting platform.

const BASE = 'https://davidmegginson.github.io/ourairports-data';

import { haversineNm } from '../core/geo.js';

// ---- shared CSV helpers (also re-exported by the ingest script) -------------
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toObjects(rows) {
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length > 1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

export const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' ? n : undefined;
};

const designatorToMag = (ident) => {
  const m = String(ident).match(/^(\d{1,2})/);
  return m ? Number(m[1]) * 10 : undefined;
};

/** Build both runway ends from an OurAirports runways.csv row. */
export function buildRunwayEnds(rwy) {
  const ends = [];
  for (const side of ['le', 'he']) {
    const ident = rwy[`${side}_ident`];
    if (!ident) continue;
    const end = { ident };
    const t = num(rwy[`${side}_heading_degT`]);
    if (t != null) end.trueHeading = Math.round(t * 10) / 10;
    const mag = designatorToMag(ident);
    if (mag != null) end.magHeading = mag;
    if (num(rwy.length_ft) != null) end.lengthFt = num(rwy.length_ft);
    if (num(rwy.width_ft) != null) end.widthFt = num(rwy.width_ft);
    if (rwy.surface) end.surface = rwy.surface;
    ends.push(end);
  }
  return ends;
}

// ---- pure builders (unit-tested) -------------------------------------------

/** Group runway ends by airport ident from runways.csv objects. */
export function indexRunways(runwayObjs) {
  const byApt = new Map();
  for (const r of runwayObjs) {
    if (r.closed === '1') continue;
    const k = (r.airport_ident || '').toUpperCase();
    if (!k) continue;
    if (!byApt.has(k)) byApt.set(k, []);
    byApt.get(k).push(...buildRunwayEnds(r));
  }
  return byApt;
}

/** Build the airport lookup Map (keyed by ICAO only). We deliberately do NOT key
 *  by IATA or local code: 3-letter IATA codes collide with navaid identifiers
 *  (e.g. "BFV" is both a US navaid and Buri Ram's IATA), which would resolve an
 *  airfield when the user meant the navaid. Airfields are looked up by ICAO. */
export function indexAirports(airportObjs, runwaysByApt) {
  const airports = new Map();
  for (const a of airportObjs) {
    const ident = (a.ident || '').toUpperCase();
    if (!ident) continue;
    if (!String(a.type || '').endsWith('_airport')) continue; // skip heliports/closed/etc.
    const rec = {
      icao: ident,
      name: a.name + (a.municipality ? `, ${a.municipality}` : ''),
      elevationFt: num(a.elevation_ft) ?? 0,
      lat: num(a.latitude_deg) ?? null,
      lon: num(a.longitude_deg) ?? null,
      magVar: 0, // headings from source are TRUE
      source: 'ourairports',
      runways: runwaysByApt.get(ident) || [],
    };
    // ICAO only: `ident` plus `gps_code` (the ICAO-style code). No IATA/local.
    for (const key of [ident, a.gps_code]) {
      const ku = (key || '').toUpperCase();
      if (ku && !airports.has(ku)) airports.set(ku, rec);
    }
  }
  return airports;
}

/** Build the navaid lookup Map (keyed by ident → ALL candidates with that
 *  ident). Navaid identifiers are NOT globally unique (e.g. several "BFV" exist),
 *  so we keep every match and let resolveNavaid pick the nearest to a reference. */
export function indexNavaids(navaidObjs) {
  const navaids = new Map(); // ident -> Navaid[]
  for (const n of navaidObjs) {
    const ident = (n.ident || '').toUpperCase();
    const lat = num(n.latitude_deg);
    const lon = num(n.longitude_deg);
    if (!ident || lat == null || lon == null) continue;
    const rec = {
      ident,
      name: n.name || ident,
      type: n.type || 'NAVAID',
      lat,
      lon,
      elevationFt: num(n.elevation_ft) ?? 0,
      // Station declination (the variation VOR radials are aligned to); fall back
      // to the geographic magnetic variation. East positive. Used for radial/DME.
      magVar: num(n.slaved_variation_deg) ?? num(n.magnetic_variation_deg) ?? null,
    };
    const list = navaids.get(ident);
    if (list) list.push(rec); else navaids.set(ident, [rec]);
  }
  return navaids;
}

/** Choose the navaid candidate nearest to `near` ({lat,lon}); first if no ref
 *  or only one candidate. Disambiguates non-unique navaid idents by proximity. */
export function pickNavaid(list, near) {
  if (!list || !list.length) return undefined;
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon) && list.length > 1) {
    return [...list].sort(
      (a, b) => haversineNm(near.lat, near.lon, a.lat, a.lon) - haversineNm(near.lat, near.lon, b.lat, b.lon),
    )[0];
  }
  return list[0];
}

// ---- network load + cache ---------------------------------------------------

let cache = null;       // { airports: Map, navaids: Map }
let loadPromise = null;

async function fetchText(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'text/csv' } });
  if (!res.ok) throw new Error(`OurAirports ${res.status} for ${url}`);
  return res.text();
}

async function doLoad() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const [aText, rText, nText] = await Promise.all([
      fetchText(`${BASE}/airports.csv`, ctrl.signal),
      fetchText(`${BASE}/runways.csv`, ctrl.signal),
      fetchText(`${BASE}/navaids.csv`, ctrl.signal),
    ]);
    const runwaysByApt = indexRunways(toObjects(parseCsv(rText)));
    cache = {
      airports: indexAirports(toObjects(parseCsv(aText)), runwaysByApt),
      navaids: indexNavaids(toObjects(parseCsv(nText))),
    };
    return cache;
  } finally {
    clearTimeout(t);
  }
}

async function ensureLoaded() {
  if (cache) return cache;
  if (!loadPromise) loadPromise = doLoad().catch((e) => { loadPromise = null; throw e; });
  return loadPromise;
}

/** Resolve an airfield by ICAO/IATA/local code. Returns undefined when offline or unknown. */
export async function resolveAirport(id, offline) {
  if (offline || !id) return undefined;
  try {
    return (await ensureLoaded()).airports.get(id.toUpperCase());
  } catch {
    return undefined;
  }
}

/** Resolve a navaid by identifier, picking the candidate nearest `near`
 *  ({lat,lon}) when the ident isn't unique. Returns undefined when offline/unknown. */
export async function resolveNavaid(id, offline, near) {
  if (offline || !id) return undefined;
  try {
    return pickNavaid((await ensureLoaded()).navaids.get(id.toUpperCase()), near);
  } catch {
    return undefined;
  }
}
