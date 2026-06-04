// Pure Web Mercator (slippy-map) projection helpers. No DOM — unit-tested in
// node and reused by the self-contained map engine (map.js).

const TILE = 256;

/** Fractional tile X for a longitude at zoom z. */
export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}

/** Fractional tile Y for a latitude at zoom z. */
export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export function tileXToLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y, z) {
  const n = Math.PI * (1 - (2 * y) / 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** World pixel coordinates (at the given zoom) for a lat/lon. */
export function project(lat, lon, z) {
  return { x: lonToTileX(lon, z) * TILE, y: latToTileY(lat, z) * TILE };
}

/**
 * Choose a center + integer zoom that fits all points within (w x h) pixels.
 * @param {Array<{lat:number,lon:number}>} points
 */
export function fitView(points, w, h, opts = {}) {
  const minZoom = opts.minZoom ?? 2;
  const maxZoom = opts.maxZoom ?? 11;
  const pad = opts.padding ?? 48;
  const pts = points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length === 0) return { lat: 39, lon: -98, zoom: 4 };

  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  // Average longitude via vectors to behave near the antimeridian.
  const sx = pts.reduce((s, p) => s + Math.cos((p.lon * Math.PI) / 180), 0);
  const sy = pts.reduce((s, p) => s + Math.sin((p.lon * Math.PI) / 180), 0);
  const lon = (Math.atan2(sy, sx) * 180) / Math.PI;

  if (pts.length === 1) return { lat, lon, zoom: opts.singleZoom ?? 9 };

  for (let z = maxZoom; z >= minZoom; z--) {
    const xs = pts.map((p) => lonToTileX(p.lon, z) * TILE);
    const ys = pts.map((p) => latToTileY(p.lat, z) * TILE);
    const dx = Math.max(...xs) - Math.min(...xs);
    const dy = Math.max(...ys) - Math.min(...ys);
    if (dx <= w - 2 * pad && dy <= h - 2 * pad) return { lat, lon, zoom: z };
  }
  return { lat, lon, zoom: minZoom };
}

export { TILE };
