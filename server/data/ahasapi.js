// AHAS (Avian Hazard Advisory System, usahas.com) live access.
//
// Public ASMX web service. Examples (from the site):
//   route:    /GetAHASRisk?Type=IR&Area='IR154'&iMonth=6&iDay=6&iHour=1
//   airfield: /GetAHASRisk12?Type=MILAIR&Area='ALTUS AFB'&iMonth=6&iDay=6&iHour=1
// Area is the route id (no dash) or the base NAME, single-quoted. Responses are
// parsed for the LOW/MODERATE/SEVERE risk vocabulary (which matches ours). All
// calls are timeout-bounded and cached; failures yield null (UNAVAILABLE).

const BASE = 'https://www.usahas.com/webservices/Fluffy_AHAS2025.asmx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const cache = new Map(); // key -> { at, text }
const TTL_MS = 30 * 60 * 1000; // AHAS updates ~hourly

function dateParts(when) {
  const d = when ? new Date(when) : new Date();
  const ok = Number.isNaN(d.getTime()) ? new Date() : d;
  return { iMonth: ok.getUTCMonth() + 1, iDay: ok.getUTCDate(), iHour: ok.getUTCHours() };
}

export function ahasUrl(method, type, area, when) {
  const { iMonth, iDay, iHour } = dateParts(when);
  // AHAS wants the Area single-quoted and encoded as %27 (encodeURIComponent
  // leaves the apostrophe bare), e.g. Area=%27IR154%27 / Area=%27ALTUS%20AFB%27.
  const areaq = `%27${encodeURIComponent(area)}%27`;
  return `${BASE}/${method}?Type=${encodeURIComponent(type)}&Area=${areaq}&iMonth=${iMonth}&iDay=${iDay}&iHour=${iHour}`;
}

/** Raw AHAS response text (cached, stale-tolerant). Throws only when there's no
 *  cached value to fall back on. Cache key is hour-agnostic so a slow refresh at
 *  the top of the hour still serves the last good answer (bird risk moves slowly). */
export async function ahasRaw(method, type, area, when, signal) {
  const key = `${method}|${type}|${area}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  try {
    const res = await fetch(ahasUrl(method, type, area, when), { signal: signal ?? AbortSignal.timeout(8000), headers: { Accept: 'application/xml,text/xml,*/*', 'User-Agent': UA } });
    if (!res.ok) throw new Error(`AHAS ${res.status}`);
    const text = await res.text();
    cache.set(key, { at: Date.now(), text });
    return text;
  } catch (e) {
    if (hit) return hit.text; // transient failure → serve the last good answer
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

// ICAO -> AHAS MILAIR base name. Only ALTUS AFB is confirmed; the rest are
// best-guess and yield UNAVAILABLE (not fake) if the name doesn't match. Extend
// as names are verified. Override/add via AHAS_AREA_MAP (JSON: {"KXXX":"NAME"}).
const ICAO_TO_AHAS = {
  KLTS: 'ALTUS AFB',
  KCHS: 'CHARLESTON AFB',
  KSUU: 'TRAVIS AFB',
  KWRI: 'MCGUIRE AFB',
  KEDW: 'EDWARDS AFB',
  KDOV: 'DOVER AFB',
  KADW: 'ANDREWS AFB',
  KFFO: 'WRIGHT PATTERSON AFB',
  KLFI: 'LANGLEY AFB',
  KSKA: 'FAIRCHILD AFB',
  KTCM: 'MCCHORD AFB',
  KHOP: 'CAMPBELL AAF',
  KFTK: 'GODMAN AAF',
};
let envMap = null;
function areaMap() {
  if (envMap) return envMap;
  envMap = { ...ICAO_TO_AHAS };
  try { Object.assign(envMap, JSON.parse(process.env.AHAS_AREA_MAP || '{}')); } catch { /* ignore */ }
  return envMap;
}
export function ahasAreaForIcao(icao) {
  return areaMap()[String(icao || '').toUpperCase()] || null;
}
