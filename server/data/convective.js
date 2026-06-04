// Convective outlook — SPC categorical thunderstorm risk areas (TSTM / MRGL /
// SLGT / ENH / MDT / HIGH) as polygons. Live source is a configurable GeoJSON
// feature service (defaults to SPC Day 1); fixture fallback otherwise. Reuses
// the airspace GeoJSON converter + proximity model and the map overlay.
//
//   default: https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson
//   override with CONVECTIVE_GEOJSON_URL

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { geojsonToAirspace } from './airspace.js';

const DEFAULT_URL = 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson';
const FIXTURE_URL = new URL('../../data/fixtures/convective-sample.json', import.meta.url);

// Severity rank + SPC numeric "DN" code mapping.
export const RISK_RANK = { TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };
const DN_TO_RISK = { 2: 'TSTM', 3: 'MRGL', 4: 'SLGT', 5: 'ENH', 6: 'MDT', 8: 'HIGH' };
const RISK_LABEL = {
  TSTM: 'General thunderstorms', MRGL: 'Marginal', SLGT: 'Slight',
  ENH: 'Enhanced', MDT: 'Moderate', HIGH: 'High',
};

/** Derive a normalized risk code from SPC feature properties. */
export function riskFromProps(p) {
  const raw = p.LABEL ?? p.label ?? (p.DN != null ? DN_TO_RISK[Number(p.DN)] : null);
  const up = String(raw ?? 'TSTM').toUpperCase();
  return RISK_RANK[up] ? up : 'TSTM';
}

export function mapProps(p, i) {
  const risk = riskFromProps(p);
  return { id: `CONV-${i}`, risk, label: RISK_LABEL[risk] || risk, type: 'CONVECTIVE' };
}

async function loadFixture() {
  return JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
}

/** @returns {Promise<{convective:any[], live:boolean}>} */
export async function fetchConvective(offline, signal) {
  const url = process.env.CONVECTIVE_GEOJSON_URL || DEFAULT_URL;
  if (!offline) {
    try {
      const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
      if (res.ok) return { convective: geojsonToAirspace(await res.json(), mapProps), live: true };
    } catch {
      /* fall through to fixture */
    }
  }
  return { convective: geojsonToAirspace(await loadFixture(), mapProps), live: false };
}
