// NOAA Aviation Weather Center (AWC) client. Free, no API key, JSON.
// Docs: https://aviationweather.gov/data/api/
//   GET /api/data/metar?ids=KCHS,KSUU&format=json
//   GET /api/data/taf?ids=KCHS&format=json
// AWC's format=json returns DECODED numeric fields; wind direction is TRUE.

const BASE = 'https://aviationweather.gov/api/data';

/** Map an AWC METAR JSON object into our Observation shape. */
export function mapAwcMetar(m) {
  let dirTrue = null;
  if (m.wdir === 'VRB') dirTrue = 'VRB';
  else if (typeof m.wdir === 'number') dirTrue = m.wdir;
  return {
    icao: m.icaoId,
    obsTime: m.obsTime ? new Date(m.obsTime * 1000).toISOString() : undefined,
    wind: {
      dirTrue,
      speedKt: typeof m.wspd === 'number' ? m.wspd : 0,
      gustKt: typeof m.wgst === 'number' ? m.wgst : null,
    },
    tempC: typeof m.temp === 'number' ? m.temp : null,
    altimHpa: typeof m.altim === 'number' ? m.altim : null,
    rawText: m.rawOb,
  };
}

// Some government endpoints (incl. aviationweather.gov) reject requests that
// lack a descriptive User-Agent. Without this, live data can silently 403.
export const USER_AGENT = 'C17MissionPlanner/1.0 (mission planning; contact: ops)';

async function getJson(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`AWC ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export async function fetchMetars(icaos, signal) {
  if (icaos.length === 0) return [];
  const url = `${BASE}/metar?ids=${encodeURIComponent(icaos.join(','))}&format=json`;
  const data = await getJson(url, signal);
  return (Array.isArray(data) ? data : []).map(mapAwcMetar);
}

export async function fetchTafs(icaos, signal) {
  if (icaos.length === 0) return [];
  const url = `${BASE}/taf?ids=${encodeURIComponent(icaos.join(','))}&format=json`;
  const data = await getJson(url, signal);
  return (Array.isArray(data) ? data : [])
    .map((t) => ({ icao: t.icaoId, rawTaf: t.rawTAF ?? t.rawOb ?? t.raw_text ?? t.rawText ?? '' }))
    .filter((t) => t.icao);
}
