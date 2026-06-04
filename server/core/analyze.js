// Airfield analysis: combine runway geometry + observation into a brief.

import { magToTrue, windComponents } from './wind.js';
import { computeAltitudes } from './density.js';

function windIsIndeterminate(wind) {
  return wind.dirTrue === null || wind.dirTrue === 'VRB' || wind.speedKt === 0;
}

/** Compute per-runway wind components for an airport given an observation. */
export function analyzeRunways(airport, obs) {
  const { wind } = obs;
  const indeterminate = windIsIndeterminate(wind);

  return airport.runways.map((rwy) => {
    const trueHeading = magToTrue(rwy.magHeading, airport.magVar);

    if (indeterminate) {
      return {
        ident: rwy.ident,
        magHeading: rwy.magHeading,
        trueHeading,
        headwindKt: 0,
        crosswindKt: 0,
        crosswindSide: 'none',
        isTailwind: false,
      };
    }

    const c = windComponents(trueHeading, wind.dirTrue, wind.speedKt);
    const result = {
      ident: rwy.ident,
      magHeading: rwy.magHeading,
      trueHeading,
      headwindKt: c.headwindKt,
      crosswindKt: c.crosswindKt,
      crosswindSide: c.crosswindSide,
      isTailwind: c.headwindKt < 0,
    };

    if (wind.gustKt != null && wind.gustKt > wind.speedKt) {
      const g = windComponents(trueHeading, wind.dirTrue, wind.gustKt);
      result.gustHeadwindKt = g.headwindKt;
      result.gustCrosswindKt = g.crosswindKt;
    }
    return result;
  });
}

/** Pick the runway with the most headwind (least tailwind). */
export function selectActiveRunway(runways) {
  if (runways.length === 0) return null;
  return runways.reduce((best, r) => (r.headwindKt > best.headwindKt ? r : best));
}

export function analyzeAirfield(airport, obs, limits) {
  const runways = analyzeRunways(airport, obs);
  const windIndeterminate = windIsIndeterminate(obs.wind);
  const active = windIndeterminate ? null : selectActiveRunway(runways);

  let pressureAltitudeFt = null;
  let densityAltitudeFt = null;
  let isaDeviationC = null;
  if (obs.altimHpa != null && obs.tempC != null) {
    const a = computeAltitudes(airport.elevationFt, obs.altimHpa, obs.tempC);
    pressureAltitudeFt = Math.round(a.pressureAltitudeFt);
    densityAltitudeFt = Math.round(a.densityAltitudeFt);
    isaDeviationC = Math.round(a.isaDeviationC);
  }

  const warnings = [];
  if (windIndeterminate) {
    warnings.push('Wind is calm or variable — runway selection is at pilot discretion.');
  } else if (active) {
    if (active.crosswindKt > limits.crosswindKt) {
      warnings.push(
        `Crosswind ${active.crosswindKt.toFixed(0)} kt on RWY ${active.ident} exceeds limit (${limits.crosswindKt} kt).`,
      );
    }
    if (active.gustCrosswindKt != null && active.gustCrosswindKt > limits.crosswindKt) {
      warnings.push(
        `Gust crosswind ${active.gustCrosswindKt.toFixed(0)} kt on RWY ${active.ident} exceeds limit (${limits.crosswindKt} kt).`,
      );
    }
    if (active.isTailwind && Math.abs(active.headwindKt) > limits.tailwindKt) {
      warnings.push(
        `Best runway still has ${Math.abs(active.headwindKt).toFixed(0)} kt tailwind — exceeds limit (${limits.tailwindKt} kt).`,
      );
    }
  }
  if (
    densityAltitudeFt != null &&
    limits.highDensityAltitudeFt != null &&
    densityAltitudeFt > limits.highDensityAltitudeFt
  ) {
    warnings.push(
      `Density altitude ${densityAltitudeFt} ft is high — expect degraded takeoff/climb/go-around performance.`,
    );
  }

  return {
    airport,
    observation: obs,
    runways,
    active,
    windIndeterminate,
    pressureAltitudeFt,
    densityAltitudeFt,
    isaDeviationC,
    warnings,
  };
}
