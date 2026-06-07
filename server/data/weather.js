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
    // METAR and TAF run concurrently but with INDEPENDENT timeouts. AWC's TAF
    // endpoint is slower than METAR (especially on a cold container), so a
    // shared timeout could abort a still-pending TAF the moment METAR's window
    // closed — surfacing TAF as "unreachable" while METAR worked. Give TAF its
    // own, longer window and one retry.
    const metarP = (async () => {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 8000);
      try { return await fetchMetars(icaos, c.signal); } finally { clearTimeout(t); }
    })();
    // Track TAF source reachability separately from how many TAFs came back: a
    // successful fetch that returns no TAF for a field (e.g. many military
    // fields like KLTS issue none via AWC) is still LIVE — it's "no TAF for this
    // field", not "source unreachable". Only a thrown fetch = unreachable.
    const tafP = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 12000);
        try { return { ok: true, list: await fetchTafs(icaos, c.signal) }; }
        catch { /* retry once */ }
        finally { clearTimeout(t); }
      }
      return { ok: false, list: [] };
    })();
    const [obs, taf] = await Promise.all([metarP, tafP]);
    if (obs.length > 0) {
      // Build the TAF map defensively — a single malformed entry must not
      // wipe out the (working) live METARs.
      const tafs = new Map();
      for (const tf of taf.list) {
        if (tf && tf.icao) tafs.set(String(tf.icao).toUpperCase(), tf.rawTaf || '');
      }
      // TAF and METAR come from the SAME AWC API. If METARs came back, the AWC
      // source is reachable, so the TAF source is "live" too — a field with no
      // TAF (e.g. KLTS) is "no TAF for this field", not "source unreachable".
      // Only when METAR is also unavailable do we mark TAF unreachable.
      return { obs, tafs, live: true, tafLive: taf.ok || obs.length > 0 };
    }
  } catch {
    // unavailable — fall through
  }
  return { obs: [], tafs: new Map(), live: false, tafLive: false };
}
