// G-AIRMET (Graphical AIRMET) — NOAA AWC's gridded AIRMET product: polygons for
// turbulence (hi/lo), icing, IFR, mountain obscuration, low-level wind shear,
// surface wind, and freezing level, at fixed forecast hours (0/3/6/9/12). It
// complements the text AIRMETs (airsigmet.js) with cleaner geometry + altitudes.
//
//   https://aviationweather.gov/api/data/gairmet?format=json
//
// Defensive mapping: the AWC payload's field names have shifted across versions,
// so we accept several spellings and fall back to a bundled fixture offline. If
// the live shape doesn't match, mapping yields [] (UNAVAILABLE — never faked).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { USER_AGENT } from './awc.js';
import { coordsToPolygon } from './airsigmet.js';

const URL_GAIRMET = 'https://aviationweather.gov/api/data/gairmet?format=json';
const FIXTURE_URL = new URL('../../data/fixtures/gairmet-sample.json', import.meta.url);

const toIso = (v) => {
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};
// G-AIRMET base/top are FLIGHT LEVELS (hundreds of ft): "180"=FL180=18000 ft,
// "SFC"=surface, "FL090"=9000 ft. (Confirmed from a live AWC capture.) A 4+ digit
// value is treated as raw feet for safety.
const toFt = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1000 ? v * 100 : v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^(SFC|SURFACE|0)$/i.test(s)) return 0;
    const fl = s.match(/^(?:FL)?\s*(\d{2,3})$/i);
    if (fl) return Number(fl[1]) * 100;
    const n = Number(s.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(n) && s !== '') return n;
  }
  return null;
};

/** Normalize a G-AIRMET hazard code and give it a friendly label. */
export function gairmetHazard(code) {
  const c = String(code || '').toUpperCase();
  const map = {
    'TURB-HI': ['TURB', 'Turbulence (high)'],
    'TURB-LO': ['TURB', 'Turbulence (low)'],
    TURB: ['TURB', 'Turbulence'],
    ICE: ['ICE', 'Icing'],
    ICING: ['ICE', 'Icing'],
    IFR: ['IFR', 'IFR / low ceilings'],
    MT_OBSC: ['MTN OBSCN', 'Mtn obscuration'],
    'MTN OBSCN': ['MTN OBSCN', 'Mtn obscuration'],
    LLWS: ['LLWS', 'Low-level wind shear'],
    SFC_WND: ['SFC WIND', 'Surface wind'],
    'SFC WND': ['SFC WIND', 'Surface wind'],
    FZLVL: ['FZLVL', 'Freezing level'],
    M_FZLVL: ['FZLVL', 'Freezing level (multiple)'],
  };
  const [hazard, label] = map[c] || [c || 'WX', c || 'Weather'];
  return { hazard, label };
}

/** Map one AWC G-AIRMET record into our hazard shape. Null without geometry. */
export function mapGairmet(it) {
  if (!it) return null;
  const geometry = coordsToPolygon(it.coords ?? it.geom ?? it.geometry);
  if (!geometry) return null;
  const { hazard, label } = gairmetHazard(it.hazard ?? it.product);
  const forecastHr = it.forecastHour ?? it.forecast ?? it.fcstHr ?? null;
  return {
    id: String(it.gairmetId ?? it.id ?? it.tag ?? `${hazard}-${forecastHr ?? ''}`),
    type: 'G-AIRMET',
    hazard,
    label,
    forecastHr,
    lowFt: toFt(it.base ?? it.fzlbase ?? it.altitudeLow1 ?? it.lowAlt),
    hiFt: toFt(it.top ?? it.fzltop ?? it.altitudeHi1 ?? it.hiAlt),
    validFrom: toIso(it.issueTime ?? it.validTimeFrom),
    validTo: toIso(it.validTime ?? it.validTimeTo ?? it.expireTime),
    geometry,
    raw: it.dueTo ? `${label} due to ${it.dueTo}` : label,
  };
}

export function mapGairmets(items) {
  return (Array.isArray(items) ? items : []).map(mapGairmet).filter(Boolean);
}

async function loadFixture() {
  return JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
}

/** @returns {Promise<{gairmets:any[], live:boolean}>} */
export async function fetchGairmets(offline, signal) {
  if (!offline) {
    try {
      const res = await fetch(URL_GAIRMET, { signal, headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
      if (res.ok) return { gairmets: mapGairmets(await res.json()), live: true };
    } catch {
      /* fall through to fixture */
    }
  }
  if (offline) return { gairmets: mapGairmets(await loadFixture()), live: false };
  return { gairmets: [], live: false };
}
