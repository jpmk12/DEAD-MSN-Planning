// Assembles the full mission brief consumed by the frontend: per-airfield
// weather + wind/pattern analysis + ranked NOTAMs + an overall status light,
// including the smart cross-reference of NOTAM runway closures vs the
// wind-optimal runway.

import { analyzeAirfield } from './core/analyze.js';
import { getAirport, knownAirports } from './data/airports.js';
import { loadWeather } from './data/weather.js';
import { fetchNotams } from './data/notams.js';
import { fetchTfrs, fetchSua, nearby } from './data/airspace.js';
import { raimOutlook } from './data/raim.js';

// How close airspace must be (NM) to a field to be flagged on its card.
const AIRSPACE_THRESHOLD_NM = 100;

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
  const [{ obs, tafs, live: wxLive }, notamResult, tfrResult, suaResult] = await Promise.all([
    loadWeather(fields, offline),
    fetchNotams(fields, offline),
    fetchTfrs(offline),
    fetchSua(offline),
  ]);
  const byIcao = new Map(obs.map((o) => [o.icao.toUpperCase(), o]));

  const airfields = [];
  for (const icao of fields) {
    const airport = await getAirport(icao);
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
    const raim = raimOutlook(notams);

    // Inside an active TFR, or inside an active restricted area = caution.
    const airspaceAlert =
      tfrs.some((t) => t.distanceNm === 0) ||
      sua.some((s) => s.distanceNm === 0 && s.status === 'active' && s.type === 'RESTRICTED') ||
      raim.status === 'PREDICTED OUTAGE';

    airfields.push({
      icao,
      found: !!airport,
      airport,
      lat,
      lon,
      analysis,
      taf: tafs.get(icao),
      notams,
      closedRunways,
      recommendedRunway,
      airspace: { tfrs, sua, raim },
      status: deriveStatus(analysis, notams, airspaceAlert),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    live: { weather: wxLive, notams: notamResult.live, airspace: tfrResult.live && suaResult.live },
    limits,
    knownAirfields: await knownAirports(),
    // Full geometry sets for the map layer.
    airspace: { tfrs: tfrResult.tfrs, sua: suaResult.sua },
    airfields,
  };
}
