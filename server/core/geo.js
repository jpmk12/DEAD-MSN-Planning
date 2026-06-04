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
