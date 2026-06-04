// Pressure altitude / density altitude.
//
// Uses the FAA-accepted field approximations (the ones crews use by hand),
// driven by altimeter setting (QNH) and OAT. Documented as approximate — good
// to within chart resolution, not a substitute for the -1 perf charts.

const STD_ALTIMETER_INHG = 29.9213; // 1013.25 hPa
const HPA_PER_INHG = 33.8639;

export const hpaToInHg = (hpa: number): number => hpa / HPA_PER_INHG;

/** ISA standard lapse: 15 °C at SL, ~1.98 °C per 1000 ft. */
export function isaTempC(pressureAltitudeFt: number): number {
  return 15 - 1.98 * (pressureAltitudeFt / 1000);
}

/**
 * Pressure altitude from field elevation and altimeter setting.
 * PA = elevation + (29.92 - altimeter) * 1000
 */
export function pressureAltitudeFt(elevationFt: number, altimeterInHg: number): number {
  return elevationFt + (STD_ALTIMETER_INHG - altimeterInHg) * 1000;
}

/**
 * Density altitude.
 * DA = PA + 120 * (OAT - ISA_temp_at_PA)
 */
export function densityAltitudeFt(pressureAltFt: number, oatC: number): number {
  return pressureAltFt + 120 * (oatC - isaTempC(pressureAltFt));
}

export interface AltitudeResult {
  pressureAltitudeFt: number;
  densityAltitudeFt: number;
  isaDeviationC: number;
}

/** Convenience: compute PA/DA/ISA-dev from raw field + METAR inputs (QNH in hPa). */
export function computeAltitudes(
  elevationFt: number,
  altimHpa: number,
  oatC: number,
): AltitudeResult {
  const pa = pressureAltitudeFt(elevationFt, hpaToInHg(altimHpa));
  return {
    pressureAltitudeFt: pa,
    densityAltitudeFt: densityAltitudeFt(pa, oatC),
    isaDeviationC: oatC - isaTempC(pa),
  };
}
