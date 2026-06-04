// Wind component math — the safety-relevant heart of the app.
// Every function here is pure and unit-tested (see wind.test.ts).

import { normalize360, signedDiff, toRad } from './geo';

/** Convert a magnetic heading to true. magVar is EAST-positive. */
export function magToTrue(magHeading: number, magVar: number): number {
  return normalize360(magHeading + magVar);
}

export interface WindComponents {
  /** Positive = headwind, negative = tailwind. */
  headwindKt: number;
  /** Magnitude of the crosswind. */
  crosswindKt: number;
  crosswindSide: 'left' | 'right' | 'none';
}

/**
 * Resolve a wind into head/cross components relative to a runway.
 *
 * @param runwayTrueHeading  runway centerline, TRUE degrees
 * @param windDirTrue        direction wind is coming FROM, TRUE degrees
 * @param windSpeedKt        wind speed in knots
 *
 * Sign/side convention: if the wind is clockwise of the runway heading
 * (i.e. coming from the right), the crosswind is from the RIGHT.
 */
export function windComponents(
  runwayTrueHeading: number,
  windDirTrue: number,
  windSpeedKt: number,
): WindComponents {
  const theta = signedDiff(windDirTrue, runwayTrueHeading); // (-180, 180]
  const headwindKt = windSpeedKt * Math.cos(toRad(theta));
  const crossSigned = windSpeedKt * Math.sin(toRad(theta)); // >0 => from right

  // Round small residuals so "essentially zero" reads as zero/none.
  const crosswindKt = Math.abs(crossSigned);
  let crosswindSide: WindComponents['crosswindSide'] = 'none';
  if (crosswindKt >= 0.5) crosswindSide = crossSigned > 0 ? 'right' : 'left';

  return { headwindKt, crosswindKt, crosswindSide };
}
