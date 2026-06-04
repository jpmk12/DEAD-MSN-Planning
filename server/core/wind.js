// Wind component math — the safety-relevant heart of the app.
//
// Conventions (these matter for correctness):
//  - magVar is signed, EAST-positive. True = Magnetic + magVar.
//  - METAR/observed wind direction is referenced to TRUE north (ICAO/WMO);
//    runway numbers are MAGNETIC. We always work in TRUE internally.

import { normalize360, signedDiff, toRad } from './geo.js';

/** Convert a magnetic heading to true. magVar is EAST-positive. */
export function magToTrue(magHeading, magVar) {
  return normalize360(magHeading + magVar);
}

/**
 * Resolve a wind into head/cross components relative to a runway.
 * @param {number} runwayTrueHeading runway centerline, TRUE degrees
 * @param {number} windDirTrue       direction wind is FROM, TRUE degrees
 * @param {number} windSpeedKt       wind speed, knots
 * @returns {{headwindKt:number, crosswindKt:number, crosswindSide:'left'|'right'|'none'}}
 *
 * Sign/side: wind clockwise of the runway heading (from the right) => crosswind
 * from the RIGHT. headwindKt positive = headwind, negative = tailwind.
 */
export function windComponents(runwayTrueHeading, windDirTrue, windSpeedKt) {
  const theta = signedDiff(windDirTrue, runwayTrueHeading); // (-180, 180]
  const headwindKt = windSpeedKt * Math.cos(toRad(theta));
  const crossSigned = windSpeedKt * Math.sin(toRad(theta)); // >0 => from right

  const crosswindKt = Math.abs(crossSigned);
  let crosswindSide = 'none';
  if (crosswindKt >= 0.5) crosswindSide = crossSigned > 0 ? 'right' : 'left';

  return { headwindKt, crosswindKt, crosswindSide };
}
