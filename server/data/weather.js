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

/** @returns {Promise<{obs:any[], tafs:Map<string,string>, live:boolean}>} */
export async function loadWeather(icaos, offline) {
  if (!offline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const obs = await fetchMetars(icaos, ctrl.signal);
      const tafList = await fetchTafs(icaos, ctrl.signal).catch(() => []);
      clearTimeout(t);
      if (obs.length > 0) {
        return { obs, tafs: new Map(tafList.map((t) => [t.icao.toUpperCase(), t.rawTaf])), live: true };
      }
    } catch {
      // fall through to fixture
    }
  }
  return { obs: await loadFixtureObs(icaos), tafs: new Map(), live: false };
}
