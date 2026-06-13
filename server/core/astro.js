// Astronomy for NVG planning — pure, dependency-free, deterministic (computed,
// never fabricated; same class as the density-altitude math). Provides solar &
// lunar position, rise/set/twilight events, moon phase + % illumination, and a
// clear-sky ground-illuminance estimate in millilux with the AFI 11-214 LOW/HIGH
// classification (LOW 0–2.1 mlx, HIGH ≥2.2 mlx).
//
// Methods: NOAA solar equations; truncated Meeus lunar series; Krisciunas–
// Schaefer / Allen-style illuminance vs solar & lunar altitude. Planning-grade:
// rise/set within ~2 min, alt/az within a few tenths of a degree. Always label
// values as computed and "verify with official sources".

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;
const sin = (d) => Math.sin(d * D2R);
const cos = (d) => Math.cos(d * D2R);
const tan = (d) => Math.tan(d * D2R);

/** Julian Day (UTC) from a Date/ISO/ms. */
export function toJulian(when) {
  const ms = when instanceof Date ? when.getTime() : (typeof when === 'number' ? when : Date.parse(when));
  return ms / 86400000 + 2440587.5;
}
const julianCenturies = (jd) => (jd - 2451545) / 36525;
/** Greenwich Mean Sidereal Time (deg). */
function gmstDeg(jd) {
  const T = julianCenturies(jd);
  return norm360(280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * T * T - (T * T * T) / 38710000);
}

// ---- Sun (NOAA) -----------------------------------------------------------
/** Apparent solar RA/Dec (deg) and equation-of-time, for a Julian Day. */
function sunPosition(jd) {
  const T = julianCenturies(jd);
  const L0 = norm360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const C = sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + sin(2 * M) * (0.019993 - 0.000101 * T) + sin(3 * M) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * sin(omega);
  const eps0 = 23 + (26 + ((21.448 - T * (46.815 + T * (0.00059 - T * 0.001813)))) / 60) / 60;
  const eps = eps0 + 0.00256 * cos(omega);
  const ra = norm360(R2D * Math.atan2(cos(eps) * sin(lambda), cos(lambda)));
  const dec = R2D * Math.asin(sin(eps) * sin(lambda));
  return { ra, dec };
}

// ---- Moon (truncated Meeus, ch. 47) --------------------------------------
function moonPosition(jd) {
  const T = julianCenturies(jd);
  const Lp = norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + (T * T * T) / 538841 - (T * T * T * T) / 65194000);
  const D = norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + (T * T * T) / 545868 - (T * T * T * T) / 113065000);
  const M = norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + (T * T * T) / 24490000);
  const Mp = norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + (T * T * T) / 69699 - (T * T * T * T) / 14712000);
  const F = norm360(93.272095 + 483202.0175233 * T - 0.0036539 * T * T - (T * T * T) / 3526000 + (T * T * T * T) / 863310000);
  // Leading periodic terms for longitude (Σl) and distance (Σr).
  const lng = 6.288774 * sin(Mp) + 1.274027 * sin(2 * D - Mp) + 0.658314 * sin(2 * D)
    + 0.213618 * sin(2 * Mp) - 0.185116 * sin(M) - 0.114332 * sin(2 * F)
    + 0.058793 * sin(2 * D - 2 * Mp) + 0.057066 * sin(2 * D - M - Mp) + 0.053322 * sin(2 * D + Mp)
    + 0.045758 * sin(2 * D - M) - 0.040923 * sin(M - Mp) - 0.034720 * sin(D)
    - 0.030383 * sin(M + Mp) + 0.015327 * sin(2 * D - 2 * F) - 0.012528 * sin(2 * F + Mp)
    + 0.010980 * sin(2 * F - Mp);
  const lat = 5.128122 * sin(F) + 0.280602 * sin(Mp + F) + 0.277693 * sin(Mp - F)
    + 0.173237 * sin(2 * D - F) + 0.055413 * sin(2 * D + F - Mp) + 0.046271 * sin(2 * D - F - Mp)
    + 0.032573 * sin(2 * D + F) + 0.017198 * sin(2 * Mp + F) + 0.009266 * sin(2 * D + Mp - F);
  const lambda = Lp + lng;
  const beta = lat;
  const eps = 23.439291 - 0.0130042 * T;
  const ra = norm360(R2D * Math.atan2(sin(lambda) * cos(eps) - tan(beta) * sin(eps), cos(lambda)));
  const dec = R2D * Math.asin(sin(beta) * cos(eps) + cos(beta) * sin(eps) * sin(lambda));
  return { ra, dec, lambda, sunM: M, moonD: D, moonMp: Mp };
}

/** Local horizontal coordinates (altitude/azimuth, deg) for an equatorial body. */
function altAz(ra, dec, jd, lat, lon) {
  const lst = norm360(gmstDeg(jd) + lon); // local sidereal time (deg)
  const H = norm360(lst - ra); // hour angle
  const alt = R2D * Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H));
  let az = R2D * Math.atan2(-sin(H), tan(dec) * cos(lat) - sin(lat) * cos(H));
  return { altDeg: alt, azDeg: norm360(az) };
}

/** Sun altitude/azimuth at a time/place. */
export function sunAltAz(when, lat, lon) {
  const jd = toJulian(when);
  const { ra, dec } = sunPosition(jd);
  return altAz(ra, dec, jd, lat, lon);
}
/** Moon altitude/azimuth at a time/place. */
export function moonAltAz(when, lat, lon) {
  const jd = toJulian(when);
  const { ra, dec } = moonPosition(jd);
  return altAz(ra, dec, jd, lat, lon);
}

/** Moon phase: illuminated fraction (0–1), phase angle, and a name. */
export function moonIllumination(when) {
  const jd = toJulian(when);
  const { sunM: M, moonD: D, moonMp: Mp } = moonPosition(jd);
  // Phase angle i (Meeus 48.4), elongation-based.
  const i = 180 - D - 6.289 * sin(Mp) + 2.100 * sin(M) - 1.274 * sin(2 * D - Mp)
    - 0.658 * sin(2 * D) - 0.214 * sin(2 * Mp) - 0.110 * sin(D);
  const fraction = (1 + cos(i)) / 2;
  // Phase name from the sun–moon elongation (age within the synodic month).
  const age = norm360(D); // ~0 new, ~180 full
  const names = ['New', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const name = names[Math.round(age / 45) % 8];
  return { fraction, phaseAngle: norm360(i), age, name };
}

// ---- Rise / set / twilight ------------------------------------------------
// Standard altitudes (deg) of the body centre at the event.
export const EVENT_ALT = {
  sunrise: -0.833, sunset: -0.833,
  civilDawn: -6, civilDusk: -6,
  bmnt: -12, eent: -12,        // nautical twilight — the NVG-relevant boundary
  astroDawn: -18, astroDusk: -18,
  moonrise: 0.125, moonset: 0.125, // ~upper limb + refraction
};

const altOf = (kind, when, lat, lon) =>
  (kind === 'moon' ? moonAltAz(when, lat, lon) : sunAltAz(when, lat, lon)).altDeg;

/**
 * Find the time (ms) the body crosses `targetAltDeg` going the requested way,
 * searching a day window around `dateMs`. Coarse 10-min scan for a sign change,
 * then bisection. Returns null when the body never crosses (polar day/night, or
 * the moon simply doesn't rise/set that day).
 */
function crossing(kind, targetAltDeg, going, dateMs, lat, lon, windowH = 24, startOffsetH = -2) {
  const f = (ms) => altOf(kind, ms, lat, lon) - targetAltDeg;
  const stepMs = 10 * 60000;
  let t0 = dateMs + startOffsetH * 3600000;
  let prev = f(t0);
  for (let t = t0 + stepMs; t <= dateMs + (startOffsetH + windowH) * 3600000; t += stepMs) {
    const cur = f(t);
    if (prev <= 0 && cur > 0 && going === 'up' || prev >= 0 && cur < 0 && going === 'down') {
      // bisect [t-step, t]
      let lo = t - stepMs, hi = t, flo = prev;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2, fm = f(mid);
        if ((flo <= 0) === (fm <= 0)) { lo = mid; flo = fm; } else hi = mid;
      }
      return Math.round((lo + hi) / 2);
    }
    prev = cur;
  }
  return null;
}

/** UTC-midnight ms of the date containing `when`. */
const utcMidnight = (when) => { const d = new Date(when instanceof Date ? when.getTime() : (typeof when === 'number' ? when : Date.parse(when))); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const toMs = (when) => (when instanceof Date ? when.getTime() : (typeof when === 'number' ? when : Date.parse(when)));

/**
 * The body's crossing of `targetAltDeg` (rise/set direction `going`) NEAREST to
 * `when`, searching ±`spanH`/2 hours around it. Used for the moon, whose rise or
 * set relevant to a night sortie often falls on an adjacent UTC day — anchoring
 * on the instant (not the UTC midnight) guarantees the event is found and shown.
 */
function nearestCrossing(kind, targetAltDeg, going, when, lat, lon, spanH = 30) {
  const center = toMs(when);
  const f = (ms) => altOf(kind, ms, lat, lon) - targetAltDeg;
  const stepMs = 10 * 60000;
  let best = null;
  let prev = f(center - (spanH / 2) * 3600000);
  for (let t = center - (spanH / 2) * 3600000 + stepMs; t <= center + (spanH / 2) * 3600000; t += stepMs) {
    const cur = f(t);
    if ((going === 'up' && prev <= 0 && cur > 0) || (going === 'down' && prev >= 0 && cur < 0)) {
      let lo = t - stepMs, hi = t, flo = prev;
      for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2, fm = f(mid); if ((flo <= 0) === (fm <= 0)) { lo = mid; flo = fm; } else hi = mid; }
      const hit = Math.round((lo + hi) / 2);
      if (best == null || Math.abs(hit - center) < Math.abs(best - center)) best = hit;
    }
    prev = cur;
  }
  return best;
}

/**
 * All sun/moon events relevant to `when`, as ISO strings (null when the event
 * doesn't occur). Sun events are taken for the UTC day; moon rise/set are taken
 * as the crossings NEAREST the instant, so a night sortie spanning UTC midnight
 * still always shows a moonrise and a moonset. Computed locally; label as such.
 */
export function sunMoonEvents(when, lat, lon) {
  const day = utcMidnight(when);
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  return {
    sunrise: iso(crossing('sun', EVENT_ALT.sunrise, 'up', day, lat, lon)),
    sunset: iso(crossing('sun', EVENT_ALT.sunset, 'down', day, lat, lon)),
    civilDawn: iso(crossing('sun', EVENT_ALT.civilDawn, 'up', day, lat, lon)),
    civilDusk: iso(crossing('sun', EVENT_ALT.civilDusk, 'down', day, lat, lon)),
    bmnt: iso(crossing('sun', EVENT_ALT.bmnt, 'up', day, lat, lon)),
    eent: iso(crossing('sun', EVENT_ALT.eent, 'down', day, lat, lon)),
    moonrise: iso(nearestCrossing('moon', EVENT_ALT.moonrise, 'up', when, lat, lon)),
    moonset: iso(nearestCrossing('moon', EVENT_ALT.moonset, 'down', when, lat, lon)),
  };
}

// ---- Ground illuminance (millilux) ---------------------------------------
// Clear-sky horizontal illuminance from sun (twilight) + moon (alt × phase) +
// a starlight/airglow floor. Returns mlx. Model: Schaefer/Allen-style fits used
// by planning tools; planning-grade, clear-sky. Cloud cover reduces this (flag
// the caveat separately from METAR/TAF).
const LUX_TO_MLX = 1000;
const STARLIGHT_MLX = 0.2; // clear moonless overcast-free night floor (~2e-4 lux)

function sunIlluminanceLux(altDeg) {
  if (altDeg > -0.8) {
    // Daylight/sun-up: rough clear-sky horizontal illuminance.
    return Math.max(0, 1000 * (Math.max(0, sin(altDeg)) * 100 + 10));
  }
  // Twilight fits (lux) by solar depression.
  if (altDeg > -6) return 3.2 + 700 * Math.pow((altDeg + 6) / 6, 2); // civil
  if (altDeg > -12) return 0.05 + 3.15 * Math.pow((altDeg + 12) / 6, 2); // nautical
  if (altDeg > -18) return 0.0011 + 0.0489 * Math.pow((altDeg + 18) / 6, 2); // astronomical
  return 0;
}

function moonIlluminanceLux(altDeg, fraction, phaseAngle) {
  if (altDeg <= -0.8) return 0; // below horizon contributes nothing
  // Illuminance of full moon at zenith ~0.267 lux; scale by phase & altitude,
  // with an extinction term near the horizon.
  const phaseFactor = Math.pow(fraction, 1.0); // ~linear in illuminated fraction for planning
  const h = Math.max(0, sin(altDeg));
  const extinction = Math.pow(h, 0.5); // dimming toward the horizon
  return 0.267 * phaseFactor * h * (0.4 + 0.6 * extinction);
}

/** Ground illuminance (millilux) at a time/place, with sources. */
export function groundIlluminanceMlx(when, lat, lon) {
  const s = sunAltAz(when, lat, lon);
  const m = moonAltAz(when, lat, lon);
  const ill = moonIllumination(when);
  const lux = sunIlluminanceLux(s.altDeg) + moonIlluminanceLux(m.altDeg, ill.fraction, ill.phaseAngle) + STARLIGHT_MLX / LUX_TO_MLX;
  return {
    mlx: Math.round(lux * LUX_TO_MLX * 100) / 100,
    sunAltDeg: Math.round(s.altDeg * 10) / 10,
    moonAltDeg: Math.round(m.altDeg * 10) / 10,
    moonAzDeg: Math.round(m.azDeg),
    moonFraction: Math.round(ill.fraction * 1000) / 1000,
  };
}

/** AFI 11-214: LOW 0–2.1 mlx, HIGH ≥2.2 mlx. */
export function illumClass(mlx) {
  return mlx >= 2.2 ? 'HIGH' : 'LOW';
}

/**
 * Lightweight illumination at an instant — millilux + LOW/HIGH, day/twilight/
 * night band, and whether the moon is up. Skips the (costly) rise/set event
 * search, so it's cheap enough to sample across a whole sortie for a trend.
 */
export function illumPoint(when, lat, lon) {
  const g = groundIlluminanceMlx(when, lat, lon);
  const band = g.sunAltDeg > -0.833 ? 'day' : g.sunAltDeg > -12 ? 'twilight' : 'night';
  return { mlx: g.mlx, class: illumClass(g.mlx), band, moonUp: g.moonAltDeg > -0.8, sunAltDeg: g.sunAltDeg, moonAltDeg: g.moonAltDeg };
}

/**
 * Illumination trend: an array of { t, mlx, class, band, moonUp } sampled every
 * `stepMin` minutes from `fromIso` to `toIso` at a place. For the NVG sparkline
 * across the sortie window. Caps the sample count so a long sortie stays cheap.
 */
export function illumTrend(fromIso, toIso, lat, lon, stepMin = 30, maxPoints = 48) {
  const from = toMs(fromIso), to = toMs(toIso);
  if (lat == null || lon == null || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  let stepMs = stepMin * 60000;
  if ((to - from) / stepMs > maxPoints) stepMs = Math.ceil((to - from) / maxPoints / 60000) * 60000;
  const out = [];
  for (let t = from; t <= to; t += stepMs) out.push({ t: new Date(t).toISOString(), ...illumPoint(t, lat, lon) });
  return out;
}

/** True when the sun is up (daylight — NVG illumination n/a). */
export function isDaylight(when, lat, lon) {
  return sunAltAz(when, lat, lon).altDeg > -0.833;
}

/**
 * Full NVG illumination picture for a time/place: events for the day, the moon
 * state, lunar position at the instant, the millilux + LOW/HIGH call, and a
 * day/twilight/night band. Everything computed; `source: 'computed'`.
 */
export function nvgIllum(when, lat, lon) {
  if (lat == null || lon == null) return null;
  const g = groundIlluminanceMlx(when, lat, lon);
  const ill = moonIllumination(when);
  const sun = sunAltAz(when, lat, lon);
  const band = sun.altDeg > -0.833 ? 'day' : sun.altDeg > -12 ? 'twilight' : 'night';
  return {
    when: new Date(when instanceof Date ? when.getTime() : (typeof when === 'number' ? when : Date.parse(when))).toISOString(),
    band,
    daylight: band === 'day',
    illumMlx: g.mlx,
    illumClass: illumClass(g.mlx),
    moon: { fraction: ill.fraction, name: ill.name, altDeg: g.moonAltDeg, azDeg: g.moonAzDeg, up: g.moonAltDeg > -0.8 },
    sunAltDeg: g.sunAltDeg,
    events: sunMoonEvents(when, lat, lon),
    source: 'computed',
  };
}
