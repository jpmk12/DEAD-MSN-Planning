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
// for pressure levels, or AGL offsets for height levels.
const PRESSURE_LEVELS = [
  { key: '925hPa', altMsl: 2500 },
  { key: '850hPa', altMsl: 4781 },
  { key: '700hPa', altMsl: 9882 },
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

async function loadFixture() {
  return JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
}

/** @returns {Promise<{profile:any[], time:string|null, live:boolean}>} */
export async function fetchWindsAloft(lat, lon, elevFt, offline, targetIso, signal) {
  let json = null;
  let live = false;
  if (!offline && lat != null && lon != null) {
    try {
      const res = await fetch(buildUrl(lat, lon), { signal, headers: { Accept: 'application/json' } });
      if (res.ok) { json = await res.json(); live = true; }
    } catch {
      /* fall through to fixture */
    }
  }
  if (!json) json = await loadFixture();
  const times = json?.hourly?.time ?? [];
  const idx = findHourIndex(times, targetIso ?? new Date().toISOString());
  return { profile: parseProfile(json, idx, elevFt ?? 0), time: times[idx] ? times[idx] + 'Z' : null, live };
}
