// Winds aloft (forecast) from Open-Meteo — free, no API key. Gives wind at low
// height levels and pressure levels, which we turn into a vertical profile and
// a pattern-altitude wind for the active runway.
//
//   https://open-meteo.com/  (CC-BY 4.0)
//   GET /v1/forecast?latitude=..&longitude=..&hourly=wind_speed_925hPa,...
//
// Falls back to a bundled fixture when the network is unavailable.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FIXTURE_URL = new URL('../../data/fixtures/windsaloft-sample.json', import.meta.url);

// Levels we request, with approximate standard-atmosphere MSL altitudes (ft)
// for pressure levels, or AGL offsets for height levels. Spans the surface up
// through ~FL300 so the profile is useful for climb-out and route planning.
const PRESSURE_LEVELS = [
  { key: '1000hPa', altMsl: 364 },
  { key: '950hPa', altMsl: 1773 },
  { key: '925hPa', altMsl: 2500 },
  { key: '900hPa', altMsl: 3243 },
  { key: '850hPa', altMsl: 4781 },
  { key: '800hPa', altMsl: 6394 },
  { key: '700hPa', altMsl: 9882 },
  { key: '600hPa', altMsl: 13801 },
  { key: '500hPa', altMsl: 18289 },
  { key: '400hPa', altMsl: 23574 },
  { key: '300hPa', altMsl: 30065 },
];
const HEIGHT_LEVELS = [
  { key: '80m', aglFt: 262 },
  { key: '180m', aglFt: 590 },
];

const VARS = [
  ...HEIGHT_LEVELS.flatMap((l) => [`wind_speed_${l.key}`, `wind_direction_${l.key}`]),
  ...PRESSURE_LEVELS.flatMap((l) => [`wind_speed_${l.key}`, `wind_direction_${l.key}`]),
];

export function buildUrl(lat, lon) {
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: VARS.join(','),
    wind_speed_unit: 'kn',
    timezone: 'GMT',
    forecast_days: '1',
  });
  return `https://api.open-meteo.com/v1/forecast?${p.toString()}`;
}

/** Index of the hourly sample at/just before the target ISO time (else 0). */
export function findHourIndex(times, targetIso) {
  if (!Array.isArray(times) || times.length === 0) return -1;
  const target = Date.parse(targetIso);
  if (!Number.isFinite(target)) return 0;
  let idx = 0;
  for (let i = 0; i < times.length; i++) {
    if (Date.parse(times[i] + 'Z') <= target) idx = i;
    else break;
  }
  return idx;
}

/** Build a sorted (low→high) wind profile in MSL feet from an Open-Meteo payload. */
export function parseProfile(json, idx, elevFt) {
  const H = json?.hourly;
  if (!H || idx < 0) return [];
  const out = [];
  const push = (altFt, kind, speedKey, dirKey) => {
    const speed = H[speedKey]?.[idx];
    const dir = H[dirKey]?.[idx];
    if (typeof speed === 'number' && typeof dir === 'number') {
      out.push({ altFt: Math.round(altFt), kind, dirTrue: Math.round(dir), speedKt: Math.round(speed) });
    }
  };
  for (const l of HEIGHT_LEVELS) push(elevFt + l.aglFt, 'agl', `wind_speed_${l.key}`, `wind_direction_${l.key}`);
  for (const l of PRESSURE_LEVELS) push(l.altMsl, 'msl', `wind_speed_${l.key}`, `wind_direction_${l.key}`);
  return out.sort((a, b) => a.altFt - b.altFt);
}

/** Pick the profile level nearest a target MSL altitude. */
export function nearestLevel(profile, targetFt) {
  if (!profile.length) return null;
  return profile.reduce((best, p) => (Math.abs(p.altFt - targetFt) < Math.abs(best.altFt - targetFt) ? p : best));
}

/**
 * Wind at an exact MSL altitude, linearly interpolated between the bracketing
 * forecast levels. Interpolates the wind vector (u,v) then converts back, so
 * direction is handled correctly across the compass. Returns {dirTrue, speedKt}.
 */
export function interpolateWind(profile, targetFt) {
  if (!profile.length) return null;
  const s = [...profile].sort((a, b) => a.altFt - b.altFt);
  const pick = (lvl) => ({ dirTrue: Math.round(lvl.dirTrue), speedKt: Math.round(lvl.speedKt) });
  if (targetFt <= s[0].altFt) return pick(s[0]);
  if (targetFt >= s[s.length - 1].altFt) return pick(s[s.length - 1]);

  let lo = s[0], hi = s[s.length - 1];
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i].altFt <= targetFt && s[i + 1].altFt >= targetFt) { lo = s[i]; hi = s[i + 1]; break; }
  }
  const f = hi.altFt === lo.altFt ? 0 : (targetFt - lo.altFt) / (hi.altFt - lo.altFt);
  const toUV = (d, sp) => ({ u: -sp * Math.sin((d * Math.PI) / 180), v: -sp * Math.cos((d * Math.PI) / 180) });
  const a = toUV(lo.dirTrue, lo.speedKt);
  const b = toUV(hi.dirTrue, hi.speedKt);
  const u = a.u + (b.u - a.u) * f;
  const v = a.v + (b.v - a.v) * f;
  const speedKt = Math.round(Math.hypot(u, v));
  let dir = (Math.atan2(-u, -v) * 180) / Math.PI;
  dir = ((Math.round(dir) % 360) + 360) % 360;
  return { dirTrue: dir, speedKt };
}

async function loadFixture() {
  return JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
}

/** @returns {Promise<{profile:any[], time:string|null, live:boolean}>} */
export async function fetchWindsAloft(lat, lon, elevFt, offline, targetIso, signal) {
  let json = null;
  let live = false;
  if (!offline && lat != null && lon != null) {
    try {
      const res = await fetch(buildUrl(lat, lon), { signal, headers: { Accept: 'application/json', 'User-Agent': 'C17MissionPlanner/1.0' } });
      if (res.ok) { json = await res.json(); live = true; }
    } catch {
      /* fall through to fixture */
    }
  }
  // offline=true → sample (tests); production failure → empty (UNAVAILABLE).
  if (!json) {
    if (!offline) return { profile: [], time: null, live: false };
    json = await loadFixture();
  }
  const times = json?.hourly?.time ?? [];
  const idx = findHourIndex(times, targetIso ?? new Date().toISOString());
  return { profile: parseProfile(json, idx, elevFt ?? 0), time: times[idx] ? times[idx] + 'Z' : null, live };
}
