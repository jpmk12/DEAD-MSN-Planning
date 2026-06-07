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
    if (cache.size > 300) cache.delete(cache.keys().next().value); // bound growth (oldest out)
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

/** Ordered hourly risk levels from a GetAHASRisk12 response (one per forecast
 *  hour). The data rows follow the <xs:schema> block; we read the risk tokens in
 *  document order from the data portion only (so column NAMES in the schema can't
 *  pollute the series). Capped at 12 (the 12-hour product). */
export function parseAhasSeries(text) {
  if (!text) return [];
  let s = String(text);
  const i = s.search(/<\/xs:schema>/i);
  if (i >= 0) s = s.slice(i);
  const out = [];
  const re = /\b(SEVERE|MODERATE|LOW)\b/gi;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1].toUpperCase());
  return out.slice(0, 12);
}

const AHAS_RANK = { LOW: 0, MODERATE: 1, SEVERE: 2 };

/** Hourly AHAS outlook from a GetAHASRisk12 response. The response groups rows
 *  into 12 forecast hours (each hour can have many route-segment rows); the
 *  combined risk is <AHASRISK> and the time is <DateTime>. Returns one entry per
 *  hour with the WORST AHASRISK across that hour's segments, time-ordered:
 *  [{ time: "2026-06-07 16:00:00.000", level: "MODERATE" }]. Non-risk values
 *  (e.g. "NO DATA") are ignored. Falls back to [] if the shape isn't present. */
export function parseAhasHourly(text) {
  if (!text) return [];
  const s = String(text);
  const times = [...s.matchAll(/<DateTime>([^<]+)<\/DateTime>/gi)].map((m) => m[1].trim());
  const risks = [...s.matchAll(/<AHASRISK>([^<]+)<\/AHASRISK>/gi)].map((m) => m[1].trim().toUpperCase());
  const n = Math.min(times.length, risks.length);
  const byHour = new Map(); // "YYYY-MM-DD HH" -> { time, level }
  for (let i = 0; i < n; i++) {
    const level = risks[i];
    if (!(level in AHAS_RANK)) continue; // skip "NO DATA" etc.
    const key = times[i].slice(0, 13);
    const cur = byHour.get(key);
    if (!cur || AHAS_RANK[level] > AHAS_RANK[cur.level]) byHour.set(key, { time: times[i], level });
  }
  return [...byHour.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((e) => e[1])
    .slice(0, 12);
}

/** Per-turn-point (per-segment) 12-hour outlook from a route GetAHASRisk12
 *  response. The DataSet serializes one row per (segment × forecast hour); each
 *  row carries <Segment>, <DateTime> and the combined <AHASRISK>. We zip the
 *  three parallel columns by index (same shape parseAhasHourly relies on), group
 *  by segment, and within each segment take the worst risk per Zulu hour, time-
 *  ordered and capped at 12. Returns [{ segment, series:[{time,level}] }] ordered
 *  by segment number. Falls back to [] when the per-segment shape isn't present
 *  (e.g. an airfield response, or no data). */
export function parseAhasRouteMatrix(text) {
  if (!text) return [];
  const s = String(text);
  const segs = [...s.matchAll(/<Segment>([^<]+)<\/Segment>/gi)].map((m) => m[1].trim());
  const times = [...s.matchAll(/<DateTime>([^<]+)<\/DateTime>/gi)].map((m) => m[1].trim());
  const risks = [...s.matchAll(/<AHASRISK>([^<]+)<\/AHASRISK>/gi)].map((m) => m[1].trim().toUpperCase());
  const n = Math.min(segs.length, times.length, risks.length);
  if (!n) return [];
  const bySeg = new Map(); // segment -> Map(hourKey -> { time, level })
  const order = []; // preserve first-seen segment order
  for (let i = 0; i < n; i++) {
    const level = risks[i];
    if (!(level in AHAS_RANK)) continue; // skip "NO DATA"
    const seg = segs[i];
    let hours = bySeg.get(seg);
    if (!hours) { hours = new Map(); bySeg.set(seg, hours); order.push(seg); }
    const key = times[i].slice(0, 13);
    const cur = hours.get(key);
    if (!cur || AHAS_RANK[level] > AHAS_RANK[cur.level]) hours.set(key, { time: times[i], level });
  }
  const numeric = (a, b) => { const na = parseFloat(a), nb = parseFloat(b); return (Number.isNaN(na) || Number.isNaN(nb)) ? (a < b ? -1 : a > b ? 1 : 0) : na - nb; };
  return order.sort(numeric).map((seg) => ({
    segment: seg,
    series: [...bySeg.get(seg).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]).slice(0, 12),
  }));
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
