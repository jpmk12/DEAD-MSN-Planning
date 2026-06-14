// Assembles the full mission brief consumed by the frontend: per-airfield
// weather + wind/pattern analysis + ranked NOTAMs + an overall status light,
// including the smart cross-reference of NOTAM runway closures vs the
// wind-optimal runway.

import { analyzeAirfield } from './core/analyze.js';
import { getAirport, knownAirports } from './data/airports.js';
import { loadWeather } from './data/weather.js';
import { fetchNotams } from './data/notams.js';
import { fetchTfrs, fetchSua, nearby, distanceToGeometry } from './data/airspace.js';
import { fetchAirSigmets } from './data/airsigmet.js';
import { fetchGairmets } from './data/gairmet.js';
import { fetchConvective, RISK_RANK as CONV_RANK } from './data/convective.js';
import { fetchMtrs, normalizeId } from './data/mtr.js';
import { fetchRouteRisk } from './data/ahas.js';
import { fetchPireps } from './data/pireps.js';
import { decodeTaf, tafAt, flightCategory, parseVisSm, parseCeilingFt } from './data/taf.js';
import { raimOutlook } from './data/raim.js';
import { fetchWindsAloft, interpolateWind, thermalSummary } from './data/windsaloft.js';
import { fetchBirdRisk } from './data/birds.js';
import { watchTaf } from './data/tafwatch.js';
import { nvgIllum, illumTrend } from './core/astro.js';
import { usnoOneDay, usnoDate, mergeUsno } from './core/usno.js';

// Default pattern altitudes (ft AGL) reported in the wind section; configurable
// per request. Each is shown with its MSL (field elev + AGL).
export const DEFAULT_PATTERN_AGLS = [1500, 2500, 6000];

// How close airspace must be (NM) to a field to be flagged on its card.
const AIRSPACE_THRESHOLD_NM = 100;
// Hazardous-weather advisories use a wider relevance radius.
const WX_THRESHOLD_NM = 150;
// PIREP relevance radius around a field.
const PIREP_THRESHOLD_NM = 125;
// Low-level routes within this radius of a field are noted.
const MTR_THRESHOLD_NM = 60;

// Sortie time-horizon thresholds (minutes from "now"). A C-17 sortie spans many
// hours, so each stop is evaluated at its own planned time. Beyond FUTURE_MIN a
// phase is "future" (forecast sources are tailored to it); beyond
// CURRENT_ONLY_MIN the transient now-cast layers (current METAR-only context,
// PIREPs, SIGMET, convective) are no longer representative and are hidden by the
// client (with a note) rather than implied to be valid at that time.
const FUTURE_MIN = 90;
const CURRENT_ONLY_MIN = 180;

/** Is an airspace item (TFR/SUA) scheduled active at the stop's ETA? Items with
 *  no effective window are assumed active (we can't rule them out). */
function activeAt(item, whenIso) {
  const start = item.effectiveStart ? Date.parse(item.effectiveStart) : NaN;
  const end = item.effectiveEnd ? Date.parse(item.effectiveEnd) : NaN;
  const t = whenIso ? Date.parse(whenIso) : Date.now();
  if (!Number.isFinite(t)) return true;
  if (Number.isFinite(start) && t < start) return false; // not yet active at ETA
  if (Number.isFinite(end) && t > end) return false; // expired by ETA
  return true;
}

/** Classify a stop time relative to now for the data-horizon logic. */
function phaseHorizon(whenIso, nowMs) {
  if (!whenIso) return { future: false, minutesAhead: 0, hideCurrentOnly: false };
  const minutesAhead = Math.round((Date.parse(whenIso) - nowMs) / 60000);
  return {
    future: minutesAhead > FUTURE_MIN,
    minutesAhead,
    hideCurrentOnly: minutesAhead > CURRENT_ONLY_MIN,
  };
}

// Placeholder limits — NOT official C-17 -1/TO values. Configurable per request.
// ceilingMinFt / visMinSm are planning thresholds for the ceiling/vis flags.
export const DEFAULT_LIMITS = {
  crosswindKt: 30,
  tailwindKt: 10,
  highDensityAltitudeFt: 5000,
  ceilingMinFt: 1000,
  visMinSm: 3,
};

const fmtVis = (sm) => (sm >= 99 ? '6+ SM' : (sm % 1 ? sm.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : String(sm)) + ' SM');

/** Ceiling/visibility/flight-category from a raw METAR string (CONUS: SM vis).
 *  Reuses the TAF token parsers; lowest BKN/OVC/VV wins for ceiling. */
export function metarConditions(rawText) {
  if (!rawText || typeof rawText !== 'string') return { visibilitySm: null, ceilingFt: null, flightCategory: null };
  const toks = rawText.trim().replace(/\s+/g, ' ').split(' ');
  let vis = null, ceil = null;
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (vis == null) {
      if (/^\d$/.test(tok) && /^\d\/\dSM$/.test(toks[k + 1] || '')) { // "1 1/2SM"
        const fm = /^(\d)\/(\d)SM$/.exec(toks[k + 1]); vis = Number(tok) + Number(fm[1]) / Number(fm[2]);
      } else if (/SM$/.test(tok) || tok === 'CAVOK' || tok === 'P6SM') {
        const v = parseVisSm(tok); if (v != null) vis = v;
      }
    }
    const c = parseCeilingFt(tok); if (c != null) ceil = ceil == null ? c : Math.min(ceil, c);
  }
  return { visibilitySm: vis, ceilingFt: ceil, flightCategory: (vis != null || ceil != null) ? flightCategory(ceil, vis) : null };
}

/**
 * Forecast conditions/analysis for a field AT a phase time, from its TAF.
 * Runs the same wind/runway math against the TAF-at-ETA wind, and checks
 * ceiling/vis vs planning minimums. Returns null when the TAF can't speak to it.
 */
export function phaseForecast(airport, tafDecoded, whenIso, limits) {
  if (!airport || !tafDecoded || !whenIso) return null;
  const fc = tafAt(tafDecoded, whenIso);
  if (!fc) return null;
  const hasWind = fc.wind && fc.wind.dirTrue != null;
  const fAnalysis = hasWind
    ? analyzeAirfield(airport, { icao: airport.icao, wind: { dirTrue: fc.wind.dirTrue, speedKt: fc.wind.speedKt, gustKt: fc.wind.gustKt }, tempC: null, altimHpa: null }, limits)
    : null;
  const cvWarnings = [];
  if (fc.ceilingFt != null && limits.ceilingMinFt != null && fc.ceilingFt < limits.ceilingMinFt) {
    cvWarnings.push(`Forecast ceiling ${fc.ceilingFt} ft below planning minimum (${limits.ceilingMinFt} ft) at ETA.`);
  }
  if (fc.visibilitySm != null && limits.visMinSm != null && fc.visibilitySm < limits.visMinSm) {
    cvWarnings.push(`Forecast visibility ${fmtVis(fc.visibilitySm)} below planning minimum (${limits.visMinSm} SM) at ETA.`);
  }
  return {
    source: 'TAF',
    whenIso,
    withinValidity: fc.withinValidity,
    wind: fc.wind,
    ceilingFt: fc.ceilingFt,
    visibilitySm: fc.visibilitySm,
    flightCategory: fc.flightCategory,
    active: fAnalysis?.active ?? null,
    runways: fAnalysis?.runways ?? null,
    windWarnings: fAnalysis ? fAnalysis.warnings : [],
    cvWarnings,
    caveats: fc.caveats || [],
  };
}

/** GO/CAUTION/NO-GO from a warning list (forecast or current). */
function statusFromWarnings(warnings, hasClosure, alert) {
  if (warnings.some((w) => /exceeds/.test(w))) return 'NO-GO';
  if (warnings.length > 0 || hasClosure || alert) return 'CAUTION';
  return 'GO';
}

const STATUS_RANK = { 'GO': 0, 'CAUTION': 1, 'NO-GO': 2, 'NO-DATA': 3 };
const CAT_RANK = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

/**
 * Rank ALTERNATE stops by their forecast at ETA — status first, then worst-case
 * (gust) crosswind, then flight category. Each entry carries the numbers that
 * drove the ranking so the UI can explain it. Pure (tested).
 */
export function rankAlternates(airfields, limits) {
  const alts = (airfields || []).filter((b) => b.phase?.role === 'ALTERNATE');
  if (alts.length < 1) return [];
  const keyed = alts.map((b) => {
    const useFc = b.statusSource === 'TAF@ETA' && b.forecast;
    const active = useFc ? b.forecast?.active : b.analysis?.active;
    const xw = active ? Math.round(active.gustCrosswindKt ?? active.crosswindKt) : null;
    const cat = (useFc ? b.forecast?.flightCategory : null) ?? b.currentConditions?.flightCategory ?? null;
    const reasons = [];
    if (xw != null) reasons.push(`XW ${xw} kt${xw >= (limits?.crosswindKt ?? 30) ? ' — exceeds limit' : ''}`);
    if (cat) reasons.push(cat);
    if (b.birdRisk?.level && b.birdRisk.level !== 'LOW') reasons.push(`birds ${b.birdRisk.level}`);
    if ((b.statusReasons || []).length) reasons.push(b.statusReasons[0]);
    return {
      uid: b.uid, icao: b.icao, status: b.status, source: b.statusSource ?? 'METAR',
      when: b.phase?.when ?? null, crosswindKt: xw, flightCategory: cat,
      reasons: reasons.slice(0, 3),
      _k: [STATUS_RANK[b.status] ?? 3, xw ?? 999, CAT_RANK[cat] ?? 2.5],
    };
  });
  keyed.sort((a, b) => a._k[0] - b._k[0] || a._k[1] - b._k[1] || a._k[2] - b._k[2]);
  return keyed.map(({ _k, ...rest }, i) => ({ rank: i + 1, ...rest }));
}

/** Extract closed runway idents from NOTAMs, e.g. "RWY 15/33 CLSD" -> [15, 33]. */
export function parseClosedRunways(notams) {
  const closed = new Set();
  for (const n of notams) {
    const m = n.text.match(/RWY\s+([0-9LRC/]+)\s+(?:CLSD|CLOSED)/i);
    if (m && m[1]) for (const id of m[1].split('/')) closed.add(id.toUpperCase());
  }
  return [...closed];
}

/**
 * Runway surface condition from FICON / RCR / braking-action NOTAMs (winter &
 * contamination ops). Extracts the runway, a normalized condition, and a coarse
 * severity from the NOTAM text — never fabricated, only what the NOTAM states.
 * Returns [{ runway, condition, severity, raw }]. severity: POOR/NIL → 'bad',
 * MEDIUM → 'caution', GOOD → 'ok'; a bare RwyCC triplet is rated by its worst digit.
 */
export function parseRunwayConditions(notams) {
  const out = [];
  for (const n of notams) {
    const t = n.text || '';
    if (!/\bFICON\b|\bRCR\b|\bBRAKING\b|\bBA\b/i.test(t)) continue;
    const rwy = (t.match(/RWY\s+([0-9LRC/]+)/i)?.[1] || '').toUpperCase() || null;
    const triplet = t.match(/\b([0-6])\/([0-6])\/([0-6])\b/);          // RwyCC per third (0=NIL..6=dry)
    const word = t.match(/\b(NIL|POOR|MEDIUM TO POOR|MEDIUM|MED|GOOD TO MEDIUM|GOOD)\b/i)?.[1];
    const rcr = t.match(/\bRCR\s*(\d{1,2})\b/i)?.[1];
    let condition = null, severity = 'caution';
    if (triplet) {
      const worst = Math.min(Number(triplet[1]), Number(triplet[2]), Number(triplet[3]));
      condition = `RwyCC ${triplet[0]}`;
      severity = worst <= 1 ? 'bad' : worst <= 3 ? 'caution' : 'ok';
    } else if (word) {
      const w = word.toUpperCase();
      condition = w;
      severity = /NIL|POOR/.test(w) && !/GOOD/.test(w) ? 'bad' : /GOOD/.test(w) && !/POOR|MED/.test(w) ? 'ok' : 'caution';
    } else if (rcr) {
      condition = `RCR ${rcr}`;
      severity = Number(rcr) <= 5 ? 'bad' : Number(rcr) <= 11 ? 'caution' : 'ok';
    } else {
      condition = 'FICON'; // contamination NOTAM without a parsed code — flag for read
    }
    out.push({ runway: rwy, condition, severity, raw: t });
  }
  return out;
}

export async function buildBrief(icaos, offline, limits = DEFAULT_LIMITS, patternAgls = DEFAULT_PATTERN_AGLS, whenIso = null, stops = null, opts = {}) {
  const { nvg = false } = opts; // NVG sortie -> attach per-phase illumination
  const nowMs = Date.now();
  const startPerf = performance.now();
  // Per-source wall-clock timing (ms), so /api/diag and the [timing] log can show
  // which live feed is slow on the real host — the fan-out is parallel, so the
  // brief's latency is the slowest single source, and this names it.
  const timings = {};
  const timed = (name, p) => {
    const t0 = performance.now();
    return p.finally(() => { timings[name] = Math.round(performance.now() - t0); });
  };
  const normWhen = (w) => (w && !Number.isNaN(Date.parse(w)) ? new Date(w).toISOString() : null);
  // Optional planned takeoff time. When set, time-sensitive layers (winds aloft,
  // AHAS bird risk) are tailored to it instead of "now".
  const targetIso = normWhen(whenIso);

  // A sortie is an ordered list of stops, each with its own planned time and
  // role (DEPARTURE / RECOVERY / ALTERNATE / FIELD). When `stops` is supplied
  // each location's time-sensitive data is evaluated AT ITS OWN time — so an
  // out-and-back to the same field shows departure and recovery at their real,
  // different times. Without `stops` we fall back to the flat icao list (every
  // field shares the single optional takeoff time), preserving the quick-brief.
  const stopList = (Array.isArray(stops) && stops.length
    ? stops.map((s) => ({
        icao: String(s.icao || '').toUpperCase(),
        when: normWhen(s.when) ?? targetIso,
        role: String(s.role || 'FIELD').toUpperCase(),
        label: s.label || String(s.icao || '').toUpperCase(),
      }))
    : icaos.map((s) => ({ icao: String(s).toUpperCase(), when: targetIso, role: 'FIELD', label: String(s).toUpperCase() }))
  ).filter((s) => s.icao);
  const isSortie = Array.isArray(stops) && stops.length > 0;
  // Unique fields drive the shared (time-agnostic / single-fetch) data layers.
  const fields = [...new Set(stopList.map((s) => s.icao))];
  // Per-stop cache key (a field can appear twice at different times).
  const stopKey = (s) => `${s.when || ''}|${s.icao}`;

  // Pre-fetch airport records (needed for coordinates + winds-aloft lookups).
  const airportPairs = await Promise.all(fields.map(async (i) => [i, await getAirport(i, offline)]));
  const airportMap = new Map(airportPairs);

  // Field coordinates (reused for the PIREP bounding box and the map trim).
  const fieldPts = fields
    .map((i) => airportMap.get(i))
    .filter((a) => a && Number.isFinite(a.lat) && Number.isFinite(a.lon))
    .map((a) => ({ lat: a.lat, lon: a.lon }));
  // AWC's pirep endpoint needs a bbox (lat0,lon0,lat1,lon1); pad the fields ~6°.
  let pirepBbox;
  // SUA query bounding box (~5° ≈ 300NM pad, matching the map trim) so we fetch
  // only the relevant Special Use Airspace instead of the whole nation.
  let airspaceBbox = null;
  if (fieldPts.length) {
    const lats = fieldPts.map((p) => p.lat);
    const lons = fieldPts.map((p) => p.lon);
    pirepBbox = `${Math.min(...lats) - 6},${Math.min(...lons) - 6},${Math.max(...lats) + 6},${Math.max(...lons) + 6}`;
    airspaceBbox = { minLat: Math.min(...lats) - 5, minLon: Math.min(...lons) - 5, maxLat: Math.max(...lats) + 5, maxLon: Math.max(...lons) + 5 };
  }

  // Run EVERY source concurrently. Dependent steps chain only on the one promise
  // they need (route AHAS on the bundled MTR set; nothing else waits on the slow
  // feeds), and birds/winds run alongside the rest instead of stacking after —
  // so total time is the slowest single source, not their sum.
  const weatherP = timed('weather', loadWeather(fields, offline));
  const notamsP = timed('notams', fetchNotams(fields, offline));
  const tfrP = timed('tfr', fetchTfrs(offline));
  const suaP = timed('sua', fetchSua(offline, undefined, airspaceBbox));
  const sigmetP = timed('sigmet', fetchAirSigmets(offline));
  const gairmetP = timed('gairmet', fetchGairmets(offline));
  const pirepP = timed('pirep', fetchPireps(offline, pirepBbox));
  const convP = timed('convective', fetchConvective(offline));
  const mtrP = timed('mtr', fetchMtrs(offline));

  // AHAS airfield bird risk per stop time. Fields sharing a time are fetched
  // together; an out-and-back field gets separate departure/recovery risk.
  const byWhen = new Map(); // when -> Set(icao)
  for (const s of stopList) {
    const k = s.when || '';
    if (!byWhen.has(k)) byWhen.set(k, new Set());
    byWhen.get(k).add(s.icao);
  }
  let birdLive = false;
  const birdsP = timed('birds', Promise.all([...byWhen].map(async ([whenKey, icaoSet]) => {
    const res = await fetchBirdRisk([...icaoSet], offline, whenKey || null);
    birdLive = birdLive || res.live;
    return [whenKey, res];
  })).then((entries) => {
    const m = new Map(); // `${when}|${icao}` -> risk record
    for (const [whenKey, res] of entries) {
      for (const icao of byWhen.get(whenKey)) {
        const rec = res.risk.get(icao);
        if (rec) m.set(`${whenKey}|${icao}`, rec);
      }
    }
    return m;
  }));

  // Route AHAS for routes near the fields, at the departure time. Depends only
  // on the bundled MTR set + airport coords, so it starts as soon as MTRs load.
  const depStop = stopList.find((s) => s.role === 'DEPARTURE') || stopList[0];
  const routeWhen = depStop?.when ?? targetIso;
  const routeAhasP = timed('ahas', mtrP.then((mtrRes) => {
    const ids = new Set();
    for (const icao of fields) {
      const ap = airportMap.get(icao);
      if (ap && Number.isFinite(ap.lat)) {
        for (const m of nearby(ap.lat, ap.lon, mtrRes.mtrs, MTR_THRESHOLD_NM)) ids.add(m.id);
      }
    }
    return fetchRouteRisk([...ids], offline, routeWhen);
  }));

  // Winds aloft per stop — needs only coordinates + the stop time, so it's fully
  // independent of the weather/NOTAM/airspace fetches.
  let windsLive = false;
  const windsP = timed('windsAloft', (async () => {
    const map = new Map();
    await Promise.all(stopList.map(async (s) => {
      const key = stopKey(s);
      if (map.has(key)) return; // shared by stops with identical icao+time
      const ap = airportMap.get(s.icao);
      if (!ap || ap.lat == null) { map.set(key, null); return; }
      const r = await fetchWindsAloft(ap.lat, ap.lon, ap.elevationFt, offline, s.when || null).catch(() => null);
      if (r && r.live) windsLive = true;
      map.set(key, r || null);
    }));
    return map;
  })());

  // USNO cross-check (NVG only): authoritative rise/set/twilight + moon phase per
  // unique field+date. Best-effort — failures yield null and the computed astro
  // values stand. Keyed by "ICAO|YYYY-MM-DD" so stops sharing a field/day reuse it.
  const usnoP = timed('usno', (async () => {
    const map = new Map();
    if (!nvg || offline) return map;
    await Promise.all(stopList.map(async (s) => {
      if (!s.when) return;
      const ap = airportMap.get(s.icao);
      if (!ap || ap.lat == null) return;
      const key = `${s.icao}|${usnoDate(s.when)}`;
      if (map.has(key)) return;
      map.set(key, null); // reserve so concurrent stops don't double-fetch
      map.set(key, await usnoOneDay(s.when, ap.lat, ap.lon, { offline }));
    }));
    return map;
  })());

  const [wxRes, notamResult, tfrResult, suaResult, sigmetResult, pirepResult, convResult, mtrResult, birdByKey, ahasRes, windsByKey, usnoByKey, gairmetResult] =
    await Promise.all([weatherP, notamsP, tfrP, suaP, sigmetP, pirepP, convP, mtrP, birdsP, routeAhasP, windsP, usnoP, gairmetP]);
  timings.total = Math.round(performance.now() - startPerf);
  // Name the slow live feed in the host log (skip offline/test runs to avoid noise).
  if (!offline) {
    console.log(`[timing] brief fields=${fields.length} ` +
      Object.entries(timings).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}ms`).join(' '));
  }
  const { obs, tafs, live: wxLive } = wxRes;
  const byIcao = new Map(obs.map((o) => [o.icao.toUpperCase(), o]));
  const mtrLevel = (id) => ahasRes.risk.get(normalizeId(id))?.level ?? null;

  const airfields = [];
  for (let si = 0; si < stopList.length; si++) {
    const stop = stopList[si];
    const icao = stop.icao;
    const horizon = phaseHorizon(stop.when, nowMs);
    const airport = airportMap.get(icao);
    const o = byIcao.get(icao);
    const notams = notamResult.notams.filter((n) => n.icao.toUpperCase() === icao);
    const analysis = airport && o ? analyzeAirfield(airport, o, limits) : undefined;
    const closedRunways = parseClosedRunways(notams);

    let recommendedRunway;
    if (analysis && !analysis.windIndeterminate) {
      const closedSet = new Set(closedRunways);
      const open = analysis.runways
        .filter((r) => !closedSet.has(r.ident.toUpperCase()))
        .sort((a, b) => b.headwindKt - a.headwindKt);
      recommendedRunway = open[0]?.ident;
      if (analysis.active && closedSet.has(analysis.active.ident.toUpperCase())) {
        analysis.warnings.unshift(
          `Wind favors RWY ${analysis.active.ident} but it is CLOSED (NOTAM)` +
            (recommendedRunway ? ` — best open runway is RWY ${recommendedRunway}.` : '.'),
        );
      }
    }

    // Airspace + RAIM outlook for this field.
    const lat = airport?.lat ?? null;
    const lon = airport?.lon ?? null;
    const tfrs = nearby(lat, lon, tfrResult.tfrs, AIRSPACE_THRESHOLD_NM);
    const sua = nearby(lat, lon, suaResult.sua, AIRSPACE_THRESHOLD_NM);
    const hazardWx = nearby(lat, lon, sigmetResult.airsigmets, WX_THRESHOLD_NM);
    const gairmets = nearby(lat, lon, gairmetResult.gairmets, WX_THRESHOLD_NM);
    const pireps = nearby(lat, lon, pirepResult.pireps, PIREP_THRESHOLD_NM);
    const convective = nearby(lat, lon, convResult.convective, WX_THRESHOLD_NM);
    const mtrs = nearby(lat, lon, mtrResult.mtrs, MTR_THRESHOLD_NM).map((m) => ({ id: m.id, type: m.type, name: m.name, distanceNm: m.distanceNm, birdRisk: mtrLevel(m.id) }));
    const raim = raimOutlook(notams);

    // Winds aloft: profile + pattern winds at 1500 & 2500 AGL (with MSL),
    // interpolated to those altitudes. Head/cross is recomputed client-side for
    // the selected runway.
    const windsAloft = windsByKey.get(stopKey(stop)) ?? null;
    let patternWinds = [];
    if (windsAloft && windsAloft.profile.length) {
      const elev = airport?.elevationFt ?? 0;
      patternWinds = patternAgls.map((aglFt) => {
        const mslFt = elev + aglFt;
        const w = interpolateWind(windsAloft.profile, mslFt);
        return w ? { aglFt, mslFt, dirTrue: w.dirTrue, speedKt: w.speedKt } : null;
      }).filter(Boolean);
    }

    // Current (METAR) ceiling/vis/category, and the TAF-at-ETA forecast (wind
    // analysis + ceiling/vis vs minimums) so each phase reads at ITS time.
    const currentConditions = metarConditions(o?.rawText);
    const tafDecodedForStop = decodeTaf(tafs.get(icao));
    const forecast = airport ? phaseForecast(airport, tafDecodedForStop, stop.when, limits) : null;
    if (forecast && !forecast.windIndeterminate) {
      const closedSet = new Set(closedRunways);
      const open = (forecast.runways || []).filter((r) => !closedSet.has(r.ident.toUpperCase())).sort((a, b) => b.headwindKt - a.headwindKt);
      forecast.recommendedRunway = open[0]?.ident ?? null;
    }

    // Bird/wildlife risk for this stop, at the stop's time.
    const birdRisk = birdByKey.get(`${stop.when || ''}|${icao}`) ?? null;

    // Inside an active TFR / restricted area, RAIM outage, SEVERE birds, or a
    // convective SIGMET / overhead hazardous-wx area = caution. Collect the
    // specific reasons so the card's status pill can explain itself. The
    // current-only weather alerts (SIGMET/convective now-casts) are skipped for
    // far-future phases, where they aren't representative (they're hidden).
    const alertReasons = [];
    if (tfrs.some((t) => t.distanceNm === 0 && activeAt(t, stop.when))) alertReasons.push('Inside a TFR active at your ETA');
    if (sua.some((s) => s.distanceNm === 0 && s.status === 'active' && s.type === 'RESTRICTED')) alertReasons.push('Inside active Restricted airspace');
    if (raim.status === 'PREDICTED OUTAGE') alertReasons.push('Predicted GPS/RAIM outage');
    if (birdRisk?.level === 'SEVERE') alertReasons.push('SEVERE bird risk (AHAS)');
    if (!horizon.hideCurrentOnly) {
      if (hazardWx.some((h) => h.hazard === 'CONVECTIVE' || h.distanceNm === 0)) alertReasons.push('Hazardous weather (SIGMET) near/overhead');
      if (convective.some((c) => c.distanceNm === 0 && (CONV_RANK[c.risk] ?? 0) >= CONV_RANK.SLGT)) alertReasons.push('Convective outlook overhead');
    }
    const alert = alertReasons.length > 0;

    // Everything that drove the GO/CAUTION/NO-GO call (wind/runway warnings,
    // ceiling/vis vs minimums, runway closures, and the airspace/bird/wx alerts).
    const closureReasons = notams
      .filter((n) => n.category === 'RUNWAY' && /CLSD|CLOSED/i.test(n.text))
      .map((n) => `Runway closure (NOTAM): ${n.text.slice(0, 60)}`);
    const hasClosure = notams.some((n) => n.category === 'RUNWAY' && /CLSD|CLOSED/i.test(n.text));
    // Current (METAR) ceiling/vis below planning minimums.
    const curCv = [];
    if (currentConditions.ceilingFt != null && limits.ceilingMinFt && currentConditions.ceilingFt < limits.ceilingMinFt) curCv.push(`Ceiling ${currentConditions.ceilingFt} ft below planning minimum (${limits.ceilingMinFt} ft).`);
    if (currentConditions.visibilitySm != null && limits.visMinSm && currentConditions.visibilitySm < limits.visMinSm) curCv.push(`Visibility ${fmtVis(currentConditions.visibilitySm)} below planning minimum (${limits.visMinSm} SM).`);
    // Future phases are judged on the TAF-at-ETA; near phases on the current METAR.
    const useForecast = horizon.future && forecast && (forecast.wind || forecast.ceilingFt != null || forecast.visibilitySm != null);
    const govWarnings = useForecast
      ? [...forecast.windWarnings, ...forecast.cvWarnings]
      : [...(analysis ? analysis.warnings : []), ...curCv];
    const statusSource = useForecast ? 'TAF@ETA' : 'METAR';
    const status = (!analysis && !useForecast) ? 'NO-DATA' : statusFromWarnings(govWarnings, hasClosure, alert);
    const statusReasons = [...govWarnings, ...closureReasons, ...alertReasons];

    airfields.push({
      icao,
      uid: `${icao}-${si}`,
      found: !!airport,
      airport,
      lat,
      lon,
      analysis,
      taf: tafs.get(icao),
      tafDecoded: decodeTaf(tafs.get(icao)),
      notams,
      closedRunways,
      runwayConditions: parseRunwayConditions(notams),
      recommendedRunway,
      airspace: { tfrs, sua, raim },
      hazardWx,
      gairmets,
      pireps,
      convective,
      mtrs,
      windsAloft,
      // Freezing level + structural-icing band(s) from the temp/RH profile at
      // this phase's time (climb-out + en-route awareness). null when no temps.
      thermal: windsAloft && windsAloft.profile.length ? thermalSummary(windsAloft.profile) : null,
      patternWinds,
      birdRisk,
      currentConditions,
      forecast,
      // NVG illumination at this phase's time/place (computed). A BKN/OVC ceiling
      // (forecast at ETA, else current) degrades the clear-sky value -> caveat.
      nvg: (nvg && stop.when && lat != null && lon != null)
        ? (() => {
            const ill = nvgIllum(stop.when, lat, lon);
            if (!ill) return null;
            const merged = mergeUsno(ill, usnoByKey.get(`${icao}|${usnoDate(stop.when)}`));
            const ceil = (useForecast ? forecast?.ceilingFt : currentConditions?.ceilingFt) ?? null;
            return { ...merged, cloudCeilingFt: ceil, cloudCaveat: ceil != null };
          })()
        : null,
      statusSource,
      status,
      statusReasons,
      // Sortie phase + data-horizon: lets the client group cards by phase, label
      // the planned time, and hide current-only layers at far-future phases.
      phase: {
        role: stop.role,
        label: stop.label,
        when: stop.when,
        future: horizon.future,
        minutesAhead: horizon.minutesAhead,
        hideCurrentOnly: horizon.hideCurrentOnly,
      },
    });
  }

  // Alternates ranked by their forecast at ETA (status, then worst-case
  // crosswind, then flight category) — "which alternate do I plan?".
  const alternates = rankAlternates(airfields, limits);

  // NVG illumination trend across the sortie window, sampled at the departure
  // field, for the sparkline. Only when NVG is on and there are timed stops.
  let nvgTrend = null;
  if (nvg) {
    const whenMsList = stopList.map((s) => Date.parse(s.when)).filter(Number.isFinite);
    const dep = stopList.find((s) => s.role === 'DEPARTURE') || stopList[0];
    const depAp = dep ? airportMap.get(dep.icao) : null;
    if (whenMsList.length && depAp && depAp.lat != null) {
      const from = new Date(Math.min(...whenMsList) - 3600000).toISOString();
      const to = new Date(Math.max(...whenMsList) + 3600000).toISOString();
      const points = illumTrend(from, to, depAp.lat, depAp.lon, 30);
      if (points.length) nvgTrend = { icao: dep.icao, from, to, points };
    }
  }

  // TAF degradation watch: did an amended TAF push any briefed phase toward
  // CAUTION/NO-GO since the last brief? Compared AT each phase's time. Skipped
  // offline (tests) so fixture runs don't accumulate watch state.
  const tafChanges = [];
  if (!offline) {
    for (const icao of fields) {
      const raw = tafs.get(icao);
      if (!raw) continue;
      const whens = stopList.filter((s) => s.icao === icao).map((s) => s.when);
      for (const ch of watchTaf(icao, raw, whens)) {
        tafChanges.push({ icao, when: ch.when, notes: ch.notes });
      }
    }
  }

  // The map only needs geometry around the briefed fields. Live nationwide feeds
  // (e.g. ~1500 SUA areas) would otherwise bloat the response and the overlay,
  // so trim every map layer to within MAP_AIRSPACE_NM of any briefed field
  // (fieldPts computed above). Per-field tab data keeps its tighter threshold.
  const MAP_AIRSPACE_NM = 300;
  const nearAnyField = (items) => (fieldPts.length
    ? items.filter((it) => fieldPts.some((p) => distanceToGeometry(p.lat, p.lon, it.geometry) <= MAP_AIRSPACE_NM))
    : items);

  return {
    generatedAt: new Date().toISOString(),
    targetTime: targetIso,
    sortie: isSortie,
    nvg,
    nvgTrend,
    // Per-source wall-clock (ms) for this brief; surfaced by /api/diag and the
    // [timing] log so the slowest live feed on the host is visible.
    diag: { timings },
    live: {
      weather: wxLive,
      taf: wxRes.tafLive,
      notams: notamResult.live,
      airspace: tfrResult.live && suaResult.live,
      tfr: tfrResult.live,
      sua: suaResult.live,
      windsAloft: windsLive,
      birds: birdLive,
      hazardWx: sigmetResult.live,
      gairmets: gairmetResult.live,
      pireps: pirepResult.live,
      convective: convResult.live,
      mtrs: mtrResult.live,
      ahas: ahasRes.live,
    },
    limits,
    wxSource: wxRes.source ?? (wxRes.live ? 'AWC' : null),
    notamSource: notamResult.source ?? null,
    notamSourceNote: notamResult.sourceNote ?? null,
    knownAirfields: await knownAirports(),
    // Map geometry, trimmed to the briefed area (see nearAnyField above).
    airspace: { tfrs: nearAnyField(tfrResult.tfrs), sua: nearAnyField(suaResult.sua) },
    airsigmets: nearAnyField(sigmetResult.airsigmets),
    gairmets: nearAnyField(gairmetResult.gairmets),
    pireps: nearAnyField(pirepResult.pireps),
    convective: nearAnyField(convResult.convective),
    mtrs: nearAnyField(mtrResult.mtrs).map((m) => ({ ...m, birdRisk: mtrLevel(m.id) })),
    airfields,
    alternates,
    tafChanges,
  };
}
