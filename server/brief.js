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
import { fetchConvective, RISK_RANK as CONV_RANK } from './data/convective.js';
import { fetchMtrs, normalizeId } from './data/mtr.js';
import { fetchRouteRisk } from './data/ahas.js';
import { fetchPireps } from './data/pireps.js';
import { decodeTaf } from './data/taf.js';
import { raimOutlook } from './data/raim.js';
import { fetchWindsAloft, interpolateWind } from './data/windsaloft.js';
import { fetchBirdRisk } from './data/birds.js';

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
export const DEFAULT_LIMITS = {
  crosswindKt: 30,
  tailwindKt: 10,
  highDensityAltitudeFt: 5000,
};

/** Extract closed runway idents from NOTAMs, e.g. "RWY 15/33 CLSD" -> [15, 33]. */
export function parseClosedRunways(notams) {
  const closed = new Set();
  for (const n of notams) {
    const m = n.text.match(/RWY\s+([0-9LRC/]+)\s+(?:CLSD|CLOSED)/i);
    if (m && m[1]) for (const id of m[1].split('/')) closed.add(id.toUpperCase());
  }
  return [...closed];
}

function deriveStatus(analysis, notams, airspaceAlert) {
  if (!analysis) return 'NO-DATA';
  if (analysis.warnings.some((w) => w.includes('exceeds'))) return 'NO-GO';
  const hasClosure = notams.some((n) => n.category === 'RUNWAY' && /CLSD|CLOSED/i.test(n.text));
  if (analysis.warnings.length > 0 || hasClosure || airspaceAlert) return 'CAUTION';
  return 'GO';
}

export async function buildBrief(icaos, offline, limits = DEFAULT_LIMITS, patternAgls = DEFAULT_PATTERN_AGLS, whenIso = null, stops = null) {
  const nowMs = Date.now();
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
  if (fieldPts.length) {
    const lats = fieldPts.map((p) => p.lat);
    const lons = fieldPts.map((p) => p.lon);
    pirepBbox = `${Math.min(...lats) - 6},${Math.min(...lons) - 6},${Math.max(...lats) + 6},${Math.max(...lons) + 6}`;
  }

  const [wxRes, notamResult, tfrResult, suaResult, sigmetResult, pirepResult, convResult, mtrResult] = await Promise.all([
    loadWeather(fields, offline),
    fetchNotams(fields, offline),
    fetchTfrs(offline),
    fetchSua(offline),
    fetchAirSigmets(offline),
    fetchPireps(offline, pirepBbox),
    fetchConvective(offline),
    fetchMtrs(offline),
  ]);
  const { obs, tafs, live: wxLive } = wxRes;
  const byIcao = new Map(obs.map((o) => [o.icao.toUpperCase(), o]));

  // AHAS airfield bird risk, evaluated AT EACH STOP'S TIME. Fields that share a
  // time are fetched together (one HTTP call per field per distinct time). An
  // out-and-back field gets a separate departure-time and recovery-time risk.
  const byWhen = new Map(); // when -> Set(icao)
  for (const s of stopList) {
    const k = s.when || '';
    if (!byWhen.has(k)) byWhen.set(k, new Set());
    byWhen.get(k).add(s.icao);
  }
  const birdByKey = new Map(); // `${when}|${icao}` -> risk record
  let birdLive = false;
  await Promise.all([...byWhen].map(async ([whenKey, icaoSet]) => {
    const res = await fetchBirdRisk([...icaoSet], offline, whenKey || null);
    birdLive = birdLive || res.live;
    for (const icao of icaoSet) {
      const rec = res.risk.get(icao);
      if (rec) birdByKey.set(`${whenKey}|${icao}`, rec);
    }
  }));

  // AHAS bird risk only for routes near the briefed fields (live AHAS is one
  // HTTP call per route, so don't query the whole AP/1B set). Evaluated at the
  // departure time (the dedicated Route Lookup gives entry-time precision).
  const depStop = stopList.find((s) => s.role === 'DEPARTURE') || stopList[0];
  const routeWhen = depStop?.when ?? targetIso;
  const nearbyRouteIds = new Set();
  for (const icao of fields) {
    const ap = airportMap.get(icao);
    if (ap && Number.isFinite(ap.lat)) {
      for (const m of nearby(ap.lat, ap.lon, mtrResult.mtrs, MTR_THRESHOLD_NM)) nearbyRouteIds.add(m.id);
    }
  }
  const ahasRes = await fetchRouteRisk([...nearbyRouteIds], offline, routeWhen);
  const mtrLevel = (id) => ahasRes.risk.get(normalizeId(id))?.level ?? null;

  // Winds aloft per stop (needs coordinates), tailored to the stop time (or the
  // observation hour when no time is set).
  const windsByKey = new Map();
  let windsLive = false;
  await Promise.all(stopList.map(async (s) => {
    const key = stopKey(s);
    if (windsByKey.has(key)) return; // shared by stops with identical icao+time
    const ap = airportMap.get(s.icao);
    if (!ap || ap.lat == null) { windsByKey.set(key, null); return; }
    const o = byIcao.get(s.icao);
    const r = await fetchWindsAloft(ap.lat, ap.lon, ap.elevationFt, offline, s.when ?? o?.obsTime).catch(() => null);
    if (r && r.live) windsLive = true;
    windsByKey.set(key, r || null);
  }));

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

    // Bird/wildlife risk for this stop, at the stop's time.
    const birdRisk = birdByKey.get(`${stop.when || ''}|${icao}`) ?? null;

    // Inside an active TFR / restricted area, RAIM outage, SEVERE birds, or a
    // convective SIGMET / overhead hazardous-wx area = caution. Collect the
    // specific reasons so the card's status pill can explain itself. The
    // current-only weather alerts (SIGMET/convective now-casts) are skipped for
    // far-future phases, where they aren't representative (they're hidden).
    const alertReasons = [];
    if (tfrs.some((t) => t.distanceNm === 0)) alertReasons.push('Inside an active TFR');
    if (sua.some((s) => s.distanceNm === 0 && s.status === 'active' && s.type === 'RESTRICTED')) alertReasons.push('Inside active Restricted airspace');
    if (raim.status === 'PREDICTED OUTAGE') alertReasons.push('Predicted GPS/RAIM outage');
    if (birdRisk?.level === 'SEVERE') alertReasons.push('SEVERE bird risk (AHAS)');
    if (!horizon.hideCurrentOnly) {
      if (hazardWx.some((h) => h.hazard === 'CONVECTIVE' || h.distanceNm === 0)) alertReasons.push('Hazardous weather (SIGMET) near/overhead');
      if (convective.some((c) => c.distanceNm === 0 && (CONV_RANK[c.risk] ?? 0) >= CONV_RANK.SLGT)) alertReasons.push('Convective outlook overhead');
    }
    const alert = alertReasons.length > 0;

    // Everything that drove the GO/CAUTION/NO-GO call (wind/runway warnings,
    // runway closures, and the airspace/bird/wx alerts above).
    const closureReasons = notams
      .filter((n) => n.category === 'RUNWAY' && /CLSD|CLOSED/i.test(n.text))
      .map((n) => `Runway closure (NOTAM): ${n.text.slice(0, 60)}`);
    const statusReasons = [...(analysis ? analysis.warnings : []), ...closureReasons, ...alertReasons];

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
      recommendedRunway,
      airspace: { tfrs, sua, raim },
      hazardWx,
      pireps,
      convective,
      mtrs,
      windsAloft,
      patternWinds,
      birdRisk,
      status: deriveStatus(analysis, notams, alert),
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
      pireps: pirepResult.live,
      convective: convResult.live,
      mtrs: mtrResult.live,
      ahas: ahasRes.live,
    },
    limits,
    notamSource: notamResult.source ?? null,
    notamSourceNote: notamResult.sourceNote ?? null,
    knownAirfields: await knownAirports(),
    // Map geometry, trimmed to the briefed area (see nearAnyField above).
    airspace: { tfrs: nearAnyField(tfrResult.tfrs), sua: nearAnyField(suaResult.sua) },
    airsigmets: nearAnyField(sigmetResult.airsigmets),
    pireps: nearAnyField(pirepResult.pireps),
    convective: nearAnyField(convResult.convective),
    mtrs: nearAnyField(mtrResult.mtrs).map((m) => ({ ...m, birdRisk: mtrLevel(m.id) })),
    airfields,
  };
}
