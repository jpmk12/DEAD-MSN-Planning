// Pressure altitude / density altitude — FAA-accepted field approximations
// (the ones crews use by hand). Documented as approximate.

const STD_ALTIMETER_INHG = 29.9213; // 1013.25 hPa
const HPA_PER_INHG = 33.8639;

export const hpaToInHg = (hpa) => hpa / HPA_PER_INHG;

/** ISA standard lapse: 15 °C at SL, ~1.98 °C per 1000 ft. */
export function isaTempC(pressureAltitudeFt) {
  return 15 - 1.98 * (pressureAltitudeFt / 1000);
}

/** PA = elevation + (29.92 - altimeter) * 1000 */
export function pressureAltitudeFt(elevationFt, altimeterInHg) {
  return elevationFt + (STD_ALTIMETER_INHG - altimeterInHg) * 1000;
}

/** DA = PA + 120 * (OAT - ISA_temp_at_PA) */
export function densityAltitudeFt(pressureAltFt, oatC) {
  return pressureAltFt + 120 * (oatC - isaTempC(pressureAltFt));
}

/** Compute PA/DA/ISA-dev from field elevation + METAR inputs (QNH in hPa). */
export function computeAltitudes(elevationFt, altimHpa, oatC) {
  const pa = pressureAltitudeFt(elevationFt, hpaToInHg(altimHpa));
  return {
    pressureAltitudeFt: pa,
    densityAltitudeFt: densityAltitudeFt(pa, oatC),
    isaDeviationC: oatC - isaTempC(pa),
  };
}
