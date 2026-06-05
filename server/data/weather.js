// Weather loading with live-AWC-then-fixture fallback. Shared by the CLI and
// the HTTP server so the fetch/fallback behavior stays in one place.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchMetars, fetchTafs, mapAwcMetar } from './awc.js';

const FIXTURE_URL = new URL('../../data/fixtures/metar-sample.json', import.meta.url);

async function loadFixtureObs(icaos) {
  const raw = await readFile(fileURLToPath(FIXTURE_URL), 'utf8');
  const arr = JSON.parse(raw);
  const wanted = new Set(icaos.map((i) => i.toUpperCase()));
  return arr.filter((m) => wanted.has(m.icaoId.toUpperCase())).map(mapAwcMetar);
}

/** @returns {Promise<{obs:any[], tafs:Map<string,string>, live:boolean, tafLive:boolean}>} */
export async function loadWeather(icaos, offline) {
  // offline=true serves the bundled sample (used only by tests). In production
  // (offline=false) we return live data, or an empty/unavailable result on
  // failure — never fabricated weather.
  if (offline) {
    return { obs: await loadFixtureObs(icaos), tafs: new Map(), live: false, tafLive: false };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const [obs, tafList] = await Promise.all([
      fetchMetars(icaos, ctrl.signal),
      fetchTafs(icaos, ctrl.signal).catch(() => []),
    ]);
    clearTimeout(t);
    if (obs.length > 0) {
      // Build the TAF map defensively — a single malformed entry must not
      // wipe out the (working) live METARs.
      const tafs = new Map();
      for (const tf of tafList) {
        if (tf && tf.icao) tafs.set(String(tf.icao).toUpperCase(), tf.rawTaf || '');
      }
      return { obs, tafs, live: true, tafLive: tafs.size > 0 };
    }
  } catch {
    // unavailable — fall through
  }
  return { obs: [], tafs: new Map(), live: false, tafLive: false };
}
