// AHAS (Avian Hazard Advisory System, usahas.com) live access.
//
// Public ASMX web service. Examples (from the site):
//   route:    /GetAHASRisk?Type=IR&Area='IR154'&iMonth=6&iDay=6&iHour=1
//   airfield: /GetAHASRisk12?Type=MILAIR&Area='ALTUS AFB'&iMonth=6&iDay=6&iHour=1
// Area is the route id (no dash) or the base NAME, single-quoted. Responses are
// parsed for the LOW/MODERATE/SEVERE risk vocabulary (which matches ours). All
// calls are timeout-bounded and cached; failures yield null (UNAVAILABLE).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.usahas.com/webservices/Fluffy_AHAS2025.asmx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// AHAS route-coverage index (which route ids AHAS actually has), bundled from the
// usahas.com dropdowns. Lets us skip bird-risk queries for uncovered routes.
let routeIndex; // {IR:Set, VR:Set, ...} | null
function routeIdx() {
  if (routeIndex !== undefined) return routeIndex;
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/ahas-routes.json', import.meta.url)), 'utf8'));
    routeIndex = {};
    for (const k of Object.keys(raw)) if (Array.isArray(raw[k])) routeIndex[k] = new Set(raw[k].map((s) => String(s).toUpperCase()));
  } catch { routeIndex = null; }
  return routeIndex;
}

/** True if AHAS is known to cover this route. A type with no index list (e.g. SR)
 *  or a missing index returns true — we only filter what we can verify. */
export function ahasHasRoute(id) {
  const idx = routeIdx();
  if (!idx) return true;
  const type = ahasRouteType(id);
  const list = type && idx[type];
  if (!list) return true;
  return list.has(String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

const cache = new Map(); // key -> { at, text }
const TTL_MS = 30 * 60 * 1000; // AHAS updates ~hourly
const MAX_STALE_MS = 3 * 60 * 60 * 1000; // serve stale on failure up to 3h, then give up

function dateParts(when) {
  const d = when ? new Date(when) : new Date();
  const ok = Number.isNaN(d.getTime()) ? new Date() : d;
  return { iMonth: ok.getUTCMonth() + 1, iDay: ok.getUTCDate(), iHour: ok.getUTCHours() };
}

/** ISO of the Zulu hour a query is run for (the requested time, or now). */
export function ahasRunAtIso(when) {
  const d = when ? new Date(when) : new Date();
  const ok = Number.isNaN(d.getTime()) ? new Date() : d;
  return new Date(Date.UTC(ok.getUTCFullYear(), ok.getUTCMonth(), ok.getUTCDate(), ok.getUTCHours())).toISOString();
}

export function ahasUrl(method, type, area, when) {
  const { iMonth, iDay, iHour } = dateParts(when);
  // AHAS wants the Area single-quoted and encoded as %27 (encodeURIComponent
  // leaves the apostrophe bare), e.g. Area=%27IR154%27 / Area=%27ALTUS%20AFB%27.
  const areaq = `%27${encodeURIComponent(area)}%27`;
  return `${BASE}/${method}?Type=${encodeURIComponent(type)}&Area=${areaq}&iMonth=${iMonth}&iDay=${iDay}&iHour=${iHour}`;
}

/** Raw AHAS response text (cached, stale-tolerant). Throws only when there's no
 *  cached value to fall back on. Cache key includes the requested Zulu hour so a
 *  specific takeoff-time query doesn't collide with the "now" query. */
export async function ahasRaw(method, type, area, when, signal) {
  const key = `${method}|${type}|${area}|${ahasRunAtIso(when)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  try {
    const res = await fetch(ahasUrl(method, type, area, when), { signal: signal ?? AbortSignal.timeout(8000), headers: { Accept: 'application/xml,text/xml,*/*', 'User-Agent': UA } });
    if (!res.ok) throw new Error(`AHAS ${res.status}`);
    const text = await res.text();
    cache.set(key, { at: Date.now(), text });
    return text;
  } catch (e) {
    // Transient failure → serve the last good answer, but not indefinitely.
    if (hit && Date.now() - hit.at < MAX_STALE_MS) return hit.text;
    throw e;
  }
}

/** Extract the worst LOW/MODERATE/SEVERE level present in an AHAS response. */
export function parseAhasLevel(text) {
  if (!text) return null;
  const up = String(text).toUpperCase();
  if (/\bSEVERE\b/.test(up)) return 'SEVERE';
  if (/\bMODERATE\b/.test(up)) return 'MODERATE';
  if (/\bLOW\b/.test(up)) return 'LOW';
  return null;
}

/** AHAS route Type from an MTR id prefix; AR (refueling) has no bird route. */
export function ahasRouteType(id) {
  const u = String(id || '').toUpperCase();
  if (u.startsWith('IR')) return 'IR';
  if (u.startsWith('VR')) return 'VR';
  if (u.startsWith('SR')) return 'SR';
  return null;
}

// ICAO/LID -> AHAS MILAIR base name, from the bundled AHAS airfield list
// (extracted from the usahas.com airfield dropdown). Override/add via
// AHAS_AREA_MAP env (JSON: {"KXXX":"NAME"}). Unmapped fields yield UNAVAILABLE
// (never fabricated).
let envMap = null;
function areaMap() {
  if (envMap) return envMap;
  envMap = {};
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/ahas-airfields.json', import.meta.url)), 'utf8'));
    for (const [id, name] of Object.entries(raw)) {
      if (id.startsWith('_') || typeof name !== 'string') continue;
      if (!envMap[id.toUpperCase()]) envMap[id.toUpperCase()] = name; // first wins
    }
  } catch { /* no list bundled */ }
  try { Object.assign(envMap, JSON.parse(process.env.AHAS_AREA_MAP || '{}')); } catch { /* ignore */ }
  return envMap;
}
export function ahasAreaForIcao(icao) {
  return areaMap()[String(icao || '').toUpperCase()] || null;
}
