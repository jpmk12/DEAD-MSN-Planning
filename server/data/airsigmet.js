// Hazardous weather advisories — SIGMETs & AIRMETs — from NOAA AWC (free, no
// key). Convective/icing/turbulence/IFR areas with geometry, altitudes, and
// valid times. Reuses the airspace proximity model and the map overlay.
//
//   https://aviationweather.gov/api/data/airsigmet?format=json
//
// Falls back to a bundled fixture when the network is unavailable.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const URL_AIRSIGMET = 'https://aviationweather.gov/api/data/airsigmet?format=json';
const FIXTURE_URL = new URL('../../data/fixtures/airsigmet-sample.json', import.meta.url);

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const toIso = (epochSec) => (typeof epochSec === 'number' ? new Date(epochSec * 1000).toISOString() : null);

/** Convert AWC `coords` (array of {lat,lon}) to our polygon geometry. */
export function coordsToPolygon(coords) {
  if (!Array.isArray(coords)) return null;
  const points = coords
    .map((c) => [Number(c.lat), Number(c.lon)])
    .filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));
  return points.length >= 2 ? { kind: 'polygon', points } : null;
}

/** Friendly label for an AWC hazard code. */
export function hazardLabel(hazard) {
  const map = {
    CONVECTIVE: 'Convective (TS)',
    TURB: 'Turbulence',
    ICE: 'Icing',
    IFR: 'IFR / low ceilings',
    'MTN OBSCN': 'Mtn obscuration',
    ASH: 'Volcanic ash',
  };
  return map[hazard] || hazard || 'Weather';
}

/** Map one AWC air/sigmet record into our shape. Returns null without geometry. */
export function mapAwcAirSigmet(it) {
  const geometry = coordsToPolygon(it.coords);
  if (!geometry) return null;
  return {
    id: String(it.airSigmetId ?? it.icaoId ?? 'AIRSIG'),
    type: it.airSigmetType ?? 'AIRMET',
    hazard: it.hazard ?? 'WX',
    label: hazardLabel(it.hazard),
    severity: it.severity ?? null,
    lowFt: numOrNull(it.altitudeLow1),
    hiFt: numOrNull(it.altitudeHi1),
    validFrom: toIso(it.validTimeFrom),
    validTo: toIso(it.validTimeTo),
    geometry,
    raw: it.rawAirSigmet ?? '',
  };
}

export function mapAirSigmets(items) {
  return (Array.isArray(items) ? items : []).map(mapAwcAirSigmet).filter(Boolean);
}

async function loadFixture() {
  return JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
}

/** @returns {Promise<{airsigmets:any[], live:boolean}>} */
export async function fetchAirSigmets(offline, signal) {
  if (!offline) {
    try {
      const res = await fetch(URL_AIRSIGMET, { signal, headers: { Accept: 'application/json' } });
      if (res.ok) return { airsigmets: mapAirSigmets(await res.json()), live: true };
    } catch {
      /* fall through to fixture */
    }
  }
  if (offline) return { airsigmets: mapAirSigmets(await loadFixture()), live: false };
  return { airsigmets: [], live: false };
}
