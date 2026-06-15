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

// Short-TTL cache of the raw Open-Meteo response, keyed by location + window
// size. One response serves every forecast hour, so per-stop/timeline reads of
// the same field reuse it. ~5 min keeps it fresh; failures aren't cached.
const WA_TTL_MS = 5 * 60 * 1000;
const waCache = new Map(); // key -> { at, json }

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
  { key: '250hPa', altMsl: 33999 }, // ~FL340 — headroom above high AR/tanker blocks
];
const HEIGHT_LEVELS = [
  { key: '80m', aglFt: 262 },
  { key: '180m', aglFt: 590 },
];

const VARS = [
  ...HEIGHT_LEVELS.flatMap((l) => [`wind_speed_${l.key}`, `wind_direction_${l.key}`, `temperature_${l.key}`]),
  ...PRESSURE_LEVELS.flatMap((l) => [`wind_speed_${l.key}`, `wind_direction_${l.key}`, `temperature_${l.key}`, `relative_humidity_${l.key}`]),
];

/** Open-Meteo forecast_days to request so the window reaches the target time
 *  (today + enough days), capped at 3. Defaults to 1 when no/invalid target. */
export function forecastDaysFor(targetIso) {
  const t = Date.parse(targetIso);
  if (!Number.isFinite(t)) return 1;
  const dayMs = 86400000; // calendar (UTC) days from today to the target, inclusive
  const days = Math.floor(t / dayMs) - Math.floor(Date.now() / dayMs) + 1;
  return Math.min(3, Math.max(1, days));
}

export function buildUrl(lat, lon, targetIso) {
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: VARS.join(','),
    wind_speed_unit: 'kn',
    timezone: 'GMT',
    forecast_days: String(forecastDaysFor(targetIso)),
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
  const push = (altFt, kind, key) => {
    const speed = H[`wind_speed_${key}`]?.[idx];
    const dir = H[`wind_direction_${key}`]?.[idx];
    if (typeof speed === 'number' && typeof dir === 'number') {
      const tempC = H[`temperature_${key}`]?.[idx];
      const rh = H[`relative_humidity_${key}`]?.[idx];
      out.push({
        altFt: Math.round(altFt), kind, dirTrue: Math.round(dir), speedKt: Math.round(speed),
        tempC: typeof tempC === 'number' ? Math.round(tempC * 10) / 10 : null,
        rhPct: typeof rh === 'number' ? Math.round(rh) : null,
      });
    }
  };
  for (const l of HEIGHT_LEVELS) push(elevFt + l.aglFt, 'agl', l.key);
  for (const l of PRESSURE_LEVELS) push(l.altMsl, 'msl', l.key);
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

/**
 * Lowest freezing level (MSL ft) from a temp-bearing profile: the altitude where
 * temperature crosses 0 °C, linearly interpolated. If the surface is already
 * below freezing the lowest level's altitude is returned (freezing at/below it);
 * if the whole column is above freezing → null (no freezing level in range).
 */
export function freezingLevelFt(profile) {
  const s = (profile || []).filter((p) => typeof p.tempC === 'number').sort((a, b) => a.altFt - b.altFt);
  if (s.length < 1) return null;
  if (s[0].tempC <= 0) return s[0].altFt; // already at/below freezing at the bottom
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i].tempC > 0 && s[i + 1].tempC <= 0) {
      const f = (s[i].tempC - 0) / (s[i].tempC - s[i + 1].tempC);
      return Math.round(s[i].altFt + (s[i + 1].altFt - s[i].altFt) * f);
    }
  }
  return null; // entire sampled column above freezing
}

/**
 * Structural-icing layers from a temp+RH profile. A level is icing-suspect when
 * its temperature is in the classic structural-icing band (0 to −20 °C) AND
 * there is enough moisture (RH ≥ `rhMin`, when RH is available). Contiguous
 * suspect levels are merged into bands with a coarse severity from temperature
 * (worst around −2 to −12 °C) and RH. Temperature/clear-sky based — actual icing
 * needs visible moisture; flag accordingly in the UI.
 */
export function icingLayers(profile, { rhMin = 70 } = {}) {
  const s = (profile || []).filter((p) => typeof p.tempC === 'number').sort((a, b) => a.altFt - b.altFt);
  const suspect = (p) => p.tempC <= 0 && p.tempC >= -20 && (p.rhPct == null || p.rhPct >= rhMin);
  const bands = [];
  let cur = null;
  for (const p of s) {
    if (suspect(p)) {
      if (!cur) cur = { baseFt: p.altFt, topFt: p.altFt, minTempC: p.tempC, maxRh: p.rhPct ?? 0 };
      else { cur.topFt = p.altFt; cur.minTempC = Math.min(cur.minTempC, p.tempC); cur.maxRh = Math.max(cur.maxRh, p.rhPct ?? 0); }
    } else if (cur) { bands.push(cur); cur = null; }
  }
  if (cur) bands.push(cur);
  return bands.map((b) => {
    const inWorstTemp = b.minTempC <= -2 && b.minTempC >= -15;
    const wet = b.maxRh >= 85;
    const severity = inWorstTemp && wet ? 'MODERATE' : (inWorstTemp || wet ? 'LIGHT' : 'TRACE');
    return { baseFt: b.baseFt, topFt: b.topFt, minTempC: Math.round(b.minTempC * 10) / 10, maxRhPct: b.maxRh || null, severity };
  });
}

/** Profile level with the strongest wind (the jet core if within range), or null.
 *  Requires finite altFt/dirTrue too, so callers can format it without guards. */
export function maxWindLevel(profile) {
  const s = (profile || []).filter((p) => typeof p.speedKt === 'number' && Number.isFinite(p.altFt) && Number.isFinite(p.dirTrue));
  if (!s.length) return null;
  const m = s.reduce((best, p) => (p.speedKt > best.speedKt ? p : best));
  return { altFt: m.altFt, speedKt: m.speedKt, dirTrue: m.dirTrue };
}

/** Tropopause altitude (MSL ft): the lowest level (above ~FL150, to skip surface
 *  inversions) where the temperature lapse rate drops below 2 °C/km — the WMO
 *  definition, approximated on the coarse forecast levels. Null when the column
 *  is still cooling at the profile top (tropopause is above our ceiling, ~FL340). */
export function tropopauseFt(profile) {
  const s = (profile || []).filter((p) => typeof p.tempC === 'number').sort((a, b) => a.altFt - b.altFt);
  for (let i = 0; i < s.length - 1; i++) {
    const dzKm = (s[i + 1].altFt - s[i].altFt) * 0.0003048;
    if (dzKm <= 0) continue;
    const lapse = (s[i].tempC - s[i + 1].tempC) / dzKm; // °C/km, positive = cooling with height
    if (s[i].altFt >= 15000 && lapse < 2) return s[i].altFt;
  }
  return null;
}

/** Compact winds-aloft summary: freezing level + icing (when temps present), the
 *  tropopause, and the max-wind level. Null only when the profile is empty. */
export function thermalSummary(profile) {
  if (!(profile || []).length) return null;
  const hasTemp = profile.some((p) => typeof p.tempC === 'number');
  return {
    freezingLevelFt: hasTemp ? freezingLevelFt(profile) : null,
    icing: hasTemp ? icingLayers(profile) : [],
    tropopauseFt: hasTemp ? tropopauseFt(profile) : null,
    maxWind: maxWindLevel(profile),
  };
}

/** Linearly interpolate a numeric per-level field (e.g. tempC, rhPct) at an MSL
 *  altitude, ignoring levels that lack the field. Null when none are available. */
export function interpolateScalar(profile, targetFt, key) {
  const s = (profile || []).filter((p) => typeof p[key] === 'number').sort((a, b) => a.altFt - b.altFt);
  if (!s.length) return null;
  if (targetFt <= s[0].altFt) return s[0][key];
  if (targetFt >= s[s.length - 1].altFt) return s[s.length - 1][key];
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i].altFt <= targetFt && s[i + 1].altFt >= targetFt) {
      const f = (targetFt - s[i].altFt) / (s[i + 1].altFt - s[i].altFt);
      return s[i][key] + (s[i + 1][key] - s[i][key]) * f;
    }
  }
  return s[s.length - 1][key];
}

/** Structural-icing call at one point: classic 0..−20 °C band with moisture
 *  (RH ≥ rhMin when available). Returns { severity, tempC, rhPct } or null when
 *  not icing-suspect / no temperature. Same severity scale as icingLayers. */
export function icingAt(tempC, rhPct, { rhMin = 70 } = {}) {
  if (typeof tempC !== 'number') return null;
  const moist = rhPct == null || rhPct >= rhMin;
  if (!(tempC <= 0 && tempC >= -20 && moist)) return null;
  const inWorstTemp = tempC <= -2 && tempC >= -15;
  const wet = rhPct != null && rhPct >= 85;
  const severity = inWorstTemp && wet ? 'MODERATE' : (inWorstTemp || wet ? 'LIGHT' : 'TRACE');
  return { severity, tempC: Math.round(tempC * 10) / 10, rhPct: rhPct != null ? Math.round(rhPct) : null };
}

async function loadFixture() {
  return JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
}

/** @returns {Promise<{profile:any[], time:string|null, live:boolean}>} */
export async function fetchWindsAloft(lat, lon, elevFt, offline, targetIso, signal) {
  let json = null;
  let live = false;
  if (!offline && lat != null && lon != null) {
    // One Open-Meteo response covers EVERY hour of the requested window, so cache
    // it by location + window size: all per-stop times for a field (and the
    // route-winds tool's repeats, and the timeline's hours) reuse one fetch.
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${forecastDaysFor(targetIso)}`;
    const hit = waCache.get(key);
    if (hit && Date.now() - hit.at < WA_TTL_MS) { json = hit.json; live = true; }
    else {
      try {
        const res = await fetch(buildUrl(lat, lon, targetIso), { signal, headers: { Accept: 'application/json', 'User-Agent': 'C17MissionPlanner/1.0' } });
        if (res.ok) {
          json = await res.json();
          live = true;
          waCache.set(key, { at: Date.now(), json });
          if (waCache.size > 96) waCache.delete(waCache.keys().next().value);
        }
      } catch {
        /* fall through to fixture */
      }
    }
  }
  // offline=true → sample (tests); production failure → empty (UNAVAILABLE).
  if (!json) {
    if (!offline) return { profile: [], time: null, live: false, clamped: false, requested: targetIso ?? null };
    json = await loadFixture();
  }
  const times = json?.hourly?.time ?? [];
  const want = targetIso ?? new Date().toISOString();
  const idx = findHourIndex(times, want);
  // Honesty guard (R2): if the requested time falls outside the forecast window
  // (e.g. a stop further out than coverage), the selected sample is the window
  // EDGE, not the real time — flag it so the UI never shows it as the ETA wind.
  const target = Date.parse(want);
  const lastT = times.length ? Date.parse(times[times.length - 1] + 'Z') : NaN;
  const firstT = times.length ? Date.parse(times[0] + 'Z') : NaN;
  const clamped = Number.isFinite(target) && Number.isFinite(lastT)
    && (target > lastT + 3600000 || target < firstT - 3600000);
  return {
    profile: parseProfile(json, idx, elevFt ?? 0),
    time: times[idx] ? times[idx] + 'Z' : null,
    live,
    clamped,
    requested: targetIso ?? null,
  };
}
