// NOAA Aviation Weather Center (AWC) data client.
//
// Free, no API key, JSON. Docs: https://aviationweather.gov/data/api/
// Endpoints used:
//   GET /api/data/metar?ids=KCHS,KSUU&format=json
//   GET /api/data/taf?ids=KCHS&format=json
//
// NOTE: AWC's `format=json` returns DECODED numeric fields, so we don't need a
// raw-METAR parser for the common case. Wind direction is referenced to TRUE
// north (ICAO/WMO), which is exactly what the analysis engine expects.

import type { Observation, WindObs } from '../core/types';

const BASE = 'https://aviationweather.gov/api/data';
const M_TO_FT = 3.28084;

/** Shape of the fields we consume from an AWC METAR JSON object. */
interface AwcMetar {
  icaoId: string;
  obsTime?: number; // epoch seconds
  wdir?: number | string | null; // number, "VRB", or null
  wspd?: number | null;
  wgst?: number | null;
  temp?: number | null;
  altim?: number | null; // hPa
  elev?: number | null; // meters
  rawOb?: string;
}

export interface TafResult {
  icao: string;
  rawTaf: string;
}

function mapWind(m: AwcMetar): WindObs {
  let dirTrue: WindObs['dirTrue'] = null;
  if (m.wdir === 'VRB') dirTrue = 'VRB';
  else if (typeof m.wdir === 'number') dirTrue = m.wdir;
  return {
    dirTrue,
    speedKt: typeof m.wspd === 'number' ? m.wspd : 0,
    gustKt: typeof m.wgst === 'number' ? m.wgst : null,
  };
}

export function mapAwcMetar(m: AwcMetar): Observation {
  return {
    icao: m.icaoId,
    obsTime: m.obsTime ? new Date(m.obsTime * 1000).toISOString() : undefined,
    wind: mapWind(m),
    tempC: typeof m.temp === 'number' ? m.temp : null,
    altimHpa: typeof m.altim === 'number' ? m.altim : null,
    rawText: m.rawOb,
  };
}

/** AWC-reported field elevation (ft), if present — handy fallback. */
export function awcElevationFt(m: AwcMetar): number | null {
  return typeof m.elev === 'number' ? Math.round(m.elev * M_TO_FT) : null;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`AWC ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export async function fetchMetars(icaos: string[], signal?: AbortSignal): Promise<Observation[]> {
  if (icaos.length === 0) return [];
  const url = `${BASE}/metar?ids=${encodeURIComponent(icaos.join(','))}&format=json`;
  const data = (await getJson(url, signal)) as AwcMetar[];
  return data.map(mapAwcMetar);
}

export async function fetchTafs(icaos: string[], signal?: AbortSignal): Promise<TafResult[]> {
  if (icaos.length === 0) return [];
  const url = `${BASE}/taf?ids=${encodeURIComponent(icaos.join(','))}&format=json`;
  const data = (await getJson(url, signal)) as Array<{ icaoId: string; rawTAF?: string }>;
  return data.map((t) => ({ icao: t.icaoId, rawTaf: t.rawTAF ?? '' }));
}
