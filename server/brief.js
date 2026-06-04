// Assembles the full mission brief consumed by the frontend: per-airfield
// weather + wind/pattern analysis + ranked NOTAMs + an overall status light,
// including the smart cross-reference of NOTAM runway closures vs the
// wind-optimal runway.

import { analyzeAirfield } from './core/analyze.js';
import { windComponents } from './core/wind.js';
import { getAirport, knownAirports } from './data/airports.js';
import { loadWeather } from './data/weather.js';
import { fetchNotams } from './data/notams.js';
import { fetchTfrs, fetchSua, nearby } from './data/airspace.js';
import { fetchAirSigmets } from './data/airsigmet.js';
import { fetchConvective, RISK_RANK as CONV_RANK } from './data/convective.js';
import { fetchPireps } from './data/pireps.js';
import { decodeTaf } from './data/taf.js';
import { raimOutlook } from './data/raim.js';
import { fetchWindsAloft, nearestLevel } from './data/windsaloft.js';
import { fetchBirdRisk } from './data/birds.js';

// Pattern altitude offset (ft AGL) used to pick the winds-aloft level.
const PATTERN_AGL_FT = 1500;

// How close airspace must be (NM) to a field to be flagged on its card.
const AIRSPACE_THRESHOLD_NM = 100;
// Hazardous-weather advisories use a wider relevance radius.
const WX_THRESHOLD_NM = 150;
// PIREP relevance radius around a field.
const PIREP_THRESHOLD_NM = 125;

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

export async function buildBrief(icaos, offline, limits = DEFAULT_LIMITS) {
  const fields = icaos.map((s) => s.toUpperCase());

  // Pre-fetch airport records (needed for coordinates + winds-aloft lookups).
  const airportPairs = await Promise.all(fields.map(async (i) => [i, await getAirport(i, offline)]));
  const airportMap = new Map(airportPairs);

  const [{ obs, tafs, live: wxLive }, notamResult, tfrResult, suaResult, birdResult, sigmetResult, pirepResult, convResult] = await Promise.all([
    loadWeather(fields, offline),
    fetchNotams(fields, offline),
    fetchTfrs(offline),
    fetchSua(offline),
    fetchBirdRisk(fields, offline),
    fetchAirSigmets(offline),
    fetchPireps(offline),
    fetchConvective(offline),
  ]);
  const byIcao = new Map(obs.map((o) => [o.icao.toUpperCase(), o]));

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
    const raim = raimOutlook(notams);

    // Winds aloft: profile + the wind at pattern altitude on the chosen runway.
    const windsAloft = windsMap.get(icao) ?? null;
    let patternWind = null;
    if (windsAloft && windsAloft.profile.length && analysis && analysis.active) {
      const lvl = nearestLevel(windsAloft.profile, (airport.elevationFt ?? 0) + PATTERN_AGL_FT);
      if (lvl) {
        const ident = recommendedRunway ?? analysis.active.ident;
        const rwy = analysis.runways.find((r) => r.ident === ident) ?? analysis.active;
        const c = windComponents(rwy.trueHeading, lvl.dirTrue, lvl.speedKt);
        patternWind = {
          altFt: lvl.altFt,
          dirTrue: lvl.dirTrue,
          speedKt: lvl.speedKt,
          runway: rwy.ident,
          headwindKt: Math.round(c.headwindKt),
          crosswindKt: Math.round(c.crosswindKt),
          crosswindSide: c.crosswindSide,
        };
      }
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
      windsAloft,
      patternWind,
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
    },
    limits,
    knownAirfields: await knownAirports(),
    // Full geometry sets for the map layer.
    airspace: { tfrs: tfrResult.tfrs, sua: suaResult.sua },
    airsigmets: sigmetResult.airsigmets,
    pireps: pirepResult.pireps,
    convective: convResult.convective,
    airfields,
  };
}
