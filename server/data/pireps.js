// PIREPs — pilot reports of turbulence, icing, cloud tops, etc. — from NOAA AWC
// (free, no key). Plotted near each field and on the map; great companion to the
// SIGMET/AIRMET layer because PIREPs are what crews actually experienced.
//
//   https://aviationweather.gov/api/data/pirep?format=json&age=2
//
// Falls back to a bundled fixture when the network is unavailable.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const URL_PIREP = 'https://aviationweather.gov/api/data/pirep?format=json&age=2';
const FIXTURE_URL = new URL('../../data/fixtures/pireps-sample.json', import.meta.url);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const toIso = (s) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : null);

/** Derive a short hazard tag from PIREP fields/raw text. */
export function classifyPirep(it) {
  const raw = String(it.rawOb ?? '').toUpperCase();
  const turb = it.turbInt1 != null || it.turbType1 != null || /\bTB[A-Z]*\b|\/TB/.test(raw);
  const ice = it.icgInt1 != null || it.icgType1 != null || /\bIC[A-Z]*\b|\/IC/.test(raw);
  const urgent = String(it.pirepType ?? '').toUpperCase().includes('URGENT') || /\bUUA\b/.test(raw);
  const tags = [];
  if (turb) tags.push('TURB');
  if (ice) tags.push('ICE');
  if (urgent) tags.push('URGENT');
  return { turb, ice, urgent, label: tags.length ? tags.join(' + ') : 'PIREP' };
}

/** Flight level / altitude (ft MSL) from the various AWC fields. */
export function pirepAltFt(it) {
  if (num(it.altFtMsl) != null) return num(it.altFtMsl);
  const fl = num(it.fltlvl) ?? (typeof it.fltlvl === 'string' && /^\d+$/.test(it.fltlvl) ? Number(it.fltlvl) : null);
  return fl != null ? fl * 100 : null;
}

export function mapAwcPirep(it) {
  const lat = num(it.lat);
  const lon = num(it.lon);
  if (lat == null || lon == null) return null;
  const c = classifyPirep(it);
  return {
    id: String(it.pirepId ?? it.receiptTime ?? `${lat},${lon}`),
    lat,
    lon,
    altFt: pirepAltFt(it),
    type: it.airepType ?? it.pirepType ?? 'PIREP',
    hazard: c.label,
    turb: c.turb,
    ice: c.ice,
    urgent: c.urgent,
    obsTime: toIso(it.obsTime),
    rawText: it.rawOb ?? '',
    geometry: { kind: 'circle', lat, lon, radiusNm: 0 },
  };
}

export function mapPireps(items) {
  return (Array.isArray(items) ? items : []).map(mapAwcPirep).filter(Boolean);
}

async function loadFixture() {
  return JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
}

/** @returns {Promise<{pireps:any[], live:boolean}>} */
export async function fetchPireps(offline, signal) {
  if (!offline) {
    try {
      const res = await fetch(URL_PIREP, { signal, headers: { Accept: 'application/json' } });
      if (res.ok) return { pireps: mapPireps(await res.json()), live: true };
    } catch {
      /* fall through to fixture */
    }
  }
  return { pireps: mapPireps(await loadFixture()), live: false };
}
