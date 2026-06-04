// Assembles the full mission brief consumed by the frontend: per-airfield
// weather + wind/pattern analysis + ranked NOTAMs + an overall status light,
// including the smart cross-reference of NOTAM runway closures vs the
// wind-optimal runway.

import { analyzeAirfield } from './core/analyze.js';
import { getAirport, knownAirports } from './data/airports.js';
import { loadWeather } from './data/weather.js';
import { fetchNotams } from './data/notams.js';
import { fetchTfrs, fetchSua, nearby } from './data/airspace.js';
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

// Placeholder limits — NOT official C-17 -1/TO values. Configurable per request.
export const DEFAULT_LIMITS = {
  crosswindKt: 25,
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

export async function buildBrief(icaos, offline, limits = DEFAULT_LIMITS, patternAgls = DEFAULT_PATTERN_AGLS) {
  const fields = icaos.map((s) => s.toUpperCase());

  // Pre-fetch airport records (needed for coordinates + winds-aloft lookups).
  const airportPairs = await Promise.all(fields.map(async (i) => [i, await getAirport(i, offline)]));
  const airportMap = new Map(airportPairs);

  const [{ obs, tafs, live: wxLive }, notamResult, tfrResult, suaResult, birdResult, sigmetResult, pirepResult, convResult, mtrResult] = await Promise.all([
    loadWeather(fields, offline),
    fetchNotams(fields, offline),
    fetchTfrs(offline),
    fetchSua(offline),
    fetchBirdRisk(fields, offline),
    fetchAirSigmets(offline),
    fetchPireps(offline),
    fetchConvective(offline),
    fetchMtrs(offline),
  ]);
  const byIcao = new Map(obs.map((o) => [o.icao.toUpperCase(), o]));

  // AHAS bird risk for the routes in play, attached to MTR records.
  const ahasRes = await fetchRouteRisk(mtrResult.mtrs.map((m) => m.id), offline);
  const mtrLevel = (id) => ahasRes.risk.get(normalizeId(id))?.level ?? null;

  // Winds aloft per field (needs coordinates), aligned to the observation hour.
  const windsPairs = await Promise.all(
    fields.map(async (icao) => {
      const ap = airportMap.get(icao);
      if (!ap || ap.lat == null) return [icao, null];
      const o = byIcao.get(icao);
      const r = await fetchWindsAloft(ap.lat, ap.lon, ap.elevationFt, offline, o?.obsTime).catch(() => null);
      return [icao, r];
    }),
  );
  const windsMap = new Map(windsPairs);

  const airfields = [];
  for (const icao of fields) {
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
    const windsAloft = windsMap.get(icao) ?? null;
    let patternWinds = [];
    if (windsAloft && windsAloft.profile.length) {
      const elev = airport?.elevationFt ?? 0;
      patternWinds = patternAgls.map((aglFt) => {
        const mslFt = elev + aglFt;
        const w = interpolateWind(windsAloft.profile, mslFt);
        return w ? { aglFt, mslFt, dirTrue: w.dirTrue, speedKt: w.speedKt } : null;
      }).filter(Boolean);
    }

    // Bird/wildlife risk for this field.
    const birdRisk = birdResult.risk.get(icao) ?? null;

    // Inside an active TFR / restricted area, RAIM outage, SEVERE birds, or a
    // convective SIGMET / overhead hazardous-wx area = caution.
    const alert =
      tfrs.some((t) => t.distanceNm === 0) ||
      sua.some((s) => s.distanceNm === 0 && s.status === 'active' && s.type === 'RESTRICTED') ||
      raim.status === 'PREDICTED OUTAGE' ||
      birdRisk?.level === 'SEVERE' ||
      hazardWx.some((h) => h.hazard === 'CONVECTIVE' || h.distanceNm === 0) ||
      convective.some((c) => c.distanceNm === 0 && (CONV_RANK[c.risk] ?? 0) >= CONV_RANK.SLGT);

    airfields.push({
      icao,
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
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    live: {
      weather: wxLive,
      notams: notamResult.live,
      airspace: tfrResult.live && suaResult.live,
      windsAloft: windsPairs.some(([, r]) => r && r.live),
      birds: birdResult.live,
      hazardWx: sigmetResult.live,
      pireps: pirepResult.live,
      convective: convResult.live,
      mtrs: mtrResult.live,
      ahas: ahasRes.live,
    },
    limits,
    knownAirfields: await knownAirports(),
    // Full geometry sets for the map layer.
    airspace: { tfrs: tfrResult.tfrs, sua: suaResult.sua },
    airsigmets: sigmetResult.airsigmets,
    pireps: pirepResult.pireps,
    convective: convResult.convective,
    mtrs: mtrResult.mtrs.map((m) => ({ ...m, birdRisk: mtrLevel(m.id) })),
    airfields,
  };
}
