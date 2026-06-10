// NOAA TGFTP fallback for METAR/TAF — independent of aviationweather.gov.
//
//   https://tgftp.nws.noaa.gov/data/observations/metar/stations/KLTS.TXT
//   https://tgftp.nws.noaa.gov/data/forecasts/taf/stations/KLTS.TXT
//
// Plain-text station files (a date line + the raw report), HTTPS, keyless, and
// served by NWS infrastructure separate from the AWC API — so when AWC throttles
// a shared egress IP (200-with-empty-body), this path usually still works. We
// parse the raw METAR ourselves into the same Observation shape mapAwcMetar
// produces. Raw METAR wind direction is TRUE (ICAO/WMO), matching the engine.

const BASE = 'https://tgftp.nws.noaa.gov/data';
const UA = 'C17MissionPlanner/1.0 (mission planning; contact: ops)';

/** Parse a raw METAR string into the app's Observation shape. Returns null when
 *  the string doesn't look like a METAR. Handles VRB/calm/gusts, M-prefixed
 *  (negative) temps, and A____ (inHg) or Q____ (hPa) altimeters. */
export function parseRawMetar(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim().replace(/\s+/g, ' ');
  const toks = text.split(' ');
  const icao = /^[A-Z][A-Z0-9]{3}$/.test(toks[0]) ? toks[0] : null;
  if (!icao) return null;

  let obsTime;
  const tm = toks.find((t) => /^\d{6}Z$/.test(t));
  if (tm) {
    const now = new Date();
    const dd = Number(tm.slice(0, 2)), hh = Number(tm.slice(2, 4)), mi = Number(tm.slice(4, 6));
    // Resolve the day near "now" (handles month rollover the same way TAFs do).
    let best = null, bestDist = Infinity;
    for (const dM of [-1, 0, 1]) {
      const cand = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + dM, dd, hh, mi);
      const dist = Math.abs(cand - now.getTime());
      if (dist < bestDist) { bestDist = dist; best = cand; }
    }
    obsTime = new Date(best).toISOString();
  }

  let dirTrue = null, speedKt = 0, gustKt = null;
  const wm = text.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b/);
  if (wm) {
    const toKt = (v) => (wm[4] === 'MPS' ? Math.round(v * 1.94384) : v);
    speedKt = toKt(Number(wm[2]));
    gustKt = wm[3] ? toKt(Number(wm[3])) : null;
    dirTrue = wm[1] === 'VRB' ? 'VRB' : Number(wm[1]);
    if (dirTrue === 0 && speedKt === 0) dirTrue = null; // calm
  }

  let tempC = null;
  const tg = text.match(/\s(M?\d{2})\/(M?\d{2}|\/\/)\s/);
  if (tg) tempC = Number(tg[1].replace('M', '-'));

  let altimHpa = null;
  const a = text.match(/\bA(\d{4})\b/);
  const q = text.match(/\bQ(\d{4})\b/);
  if (q) altimHpa = Number(q[1]);
  else if (a) altimHpa = Math.round((Number(a[1]) / 100) * 33.8639 * 10) / 10;

  return { icao, obsTime, wind: { dirTrue, speedKt, gustKt }, tempC, altimHpa, rawText: text };
}

async function fetchStationText(kind, icao, signal) {
  const url = `${BASE}/${kind}/stations/${encodeURIComponent(icao.toUpperCase())}.TXT`;
  const res = await fetch(url, { signal, headers: { Accept: 'text/plain', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`TGFTP ${res.status} for ${icao}`);
  return res.text();
}

/** Raw METAR for one station (TGFTP file = date line + report line(s)). */
export async function fetchTgftpMetar(icao, signal) {
  const text = await fetchStationText('observations/metar', icao, signal);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // First line is "YYYY/MM/DD HH:MM"; the report may wrap across lines.
  const report = lines.slice(1).join(' ').trim();
  return report ? parseRawMetar(report) : null;
}

/** Raw TAF for one station (may span multiple lines). */
export async function fetchTgftpTaf(icao, signal) {
  const text = await fetchStationText('forecasts/taf', icao, signal);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const report = lines.slice(1).join(' ').trim();
  return report || null;
}

/** Fallback fetch for several stations. Per-station failures are skipped (a
 *  station with no TGFTP file just yields nothing). */
export async function fetchTgftpWeather(icaos, timeoutMs = 6000) {
  const uniq = [...new Set(icaos.map((i) => i.toUpperCase()))];
  const obs = [];
  const tafs = new Map();
  await Promise.all(uniq.map(async (icao) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const [m, taf] = await Promise.allSettled([fetchTgftpMetar(icao, c.signal), fetchTgftpTaf(icao, c.signal)]);
      if (m.status === 'fulfilled' && m.value) obs.push(m.value);
      if (taf.status === 'fulfilled' && taf.value) tafs.set(icao, taf.value);
    } finally {
      clearTimeout(t);
    }
  }));
  return { obs, tafs };
}
