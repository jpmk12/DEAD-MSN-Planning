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
  // AWC sometimes returns 200 with an EMPTY/truncated body (typically per-IP
  // throttling on shared egress). Name that case explicitly so diag shows the
  // real cause instead of a bare JSON parse error.
  const text = (await res.text()).trim();
  if (!text) throw new Error('AWC 200 but EMPTY body (likely per-IP throttling)');
  try { return JSON.parse(text); }
  catch { throw new Error(`AWC 200 but invalid JSON (${text.length}B, likely throttling)`); }
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
  const res = await fetch(url, { signal, headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`AWC ${res.status} ${res.statusText} for ${url}`);
  // AWC often returns 200 with an EMPTY or non-JSON body for stations that issue
  // no TAF (common for military fields like KLTS). Treat that as "reachable, no
  // TAF" — return [] instead of throwing — so the source stays LIVE and the
  // field card simply shows no TAF (rather than the source reading UNAVAILABLE).
  const text = (await res.text()).trim();
  if (!text) return [];
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  return (Array.isArray(data) ? data : [])
    .map((t) => ({ icao: t.icaoId, rawTaf: t.rawTAF ?? t.rawOb ?? t.raw_text ?? t.rawText ?? '' }))
    .filter((t) => t.icao);
}
