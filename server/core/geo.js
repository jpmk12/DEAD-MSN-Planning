// Small, dependency-free angle helpers.

export const toRad = (deg) => (deg * Math.PI) / 180;
export const toDeg = (rad) => (rad * 180) / Math.PI;

/** Normalize any angle into [0, 360). */
export function normalize360(deg) {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

/**
 * Signed smallest angular difference (a - b), result in (-180, 180].
 * Positive means `a` is clockwise from `b`.
 */
export function signedDiff(a, b) {
  let d = normalize360(a - b);
  if (d > 180) d -= 360;
  return d;
}

const EARTH_NM = 3440.065; // mean earth radius in nautical miles

/** Great-circle distance in nautical miles between two lat/lon points. */
export function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial true bearing (degrees) from point 1 to point 2. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalize360(toDeg(Math.atan2(y, x)));
}

/** Destination point given a start, an initial TRUE bearing (deg) and a distance
 *  (NM), along a great circle. Returns { lat, lon }. Used for radial/DME fixes. */
export function destinationPoint(lat, lon, bearingTrue, distNm) {
  const d = distNm / EARTH_NM; // angular distance
  const br = toRad(bearingTrue);
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const sinP2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br);
  const p2 = Math.asin(Math.min(1, Math.max(-1, sinP2)));
  const l2 = l1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(p1),
    Math.cos(d) - Math.sin(p1) * sinP2,
  );
  return { lat: toDeg(p2), lon: ((toDeg(l2) + 540) % 360) - 180 };
}
