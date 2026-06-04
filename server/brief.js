// Assembles the full mission brief consumed by the frontend: per-airfield
// weather + wind/pattern analysis + ranked NOTAMs + an overall status light,
// including the smart cross-reference of NOTAM runway closures vs the
// wind-optimal runway.

import { analyzeAirfield } from './core/analyze.js';
import { getAirport, knownAirports } from './data/airports.js';
import { loadWeather } from './data/weather.js';
import { fetchNotams } from './data/notams.js';

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

function deriveStatus(analysis, notams) {
  if (!analysis) return 'NO-DATA';
  if (analysis.warnings.some((w) => w.includes('exceeds'))) return 'NO-GO';
  const hasClosure = notams.some((n) => n.category === 'RUNWAY' && /CLSD|CLOSED/i.test(n.text));
  if (analysis.warnings.length > 0 || hasClosure) return 'CAUTION';
  return 'GO';
}

export async function buildBrief(icaos, offline, limits = DEFAULT_LIMITS) {
  const fields = icaos.map((s) => s.toUpperCase());
  const [{ obs, tafs, live: wxLive }, notamResult] = await Promise.all([
    loadWeather(fields, offline),
    fetchNotams(fields, offline),
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

    airfields.push({
      icao,
      found: !!airport,
      airport,
      analysis,
      taf: tafs.get(icao),
      notams,
      closedRunways,
      recommendedRunway,
      status: deriveStatus(analysis, notams),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    live: { weather: wxLive, notams: notamResult.live },
    limits,
    knownAirfields: await knownAirports(),
    airfields,
  };
}
