// AHAS bird risk per Military Training Route (and per segment). The USAF Avian
// Hazard Advisory System reports current/forecast bird-strike risk by MTR — the
// canonical low-level planning input. Live AHAS access (set AHAS_API_URL) would
// plug in here; otherwise the bundled fixture is used. Risk levels reuse the
// LOW/MODERATE/SEVERE vocabulary from the airfield bird layer.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeRisk, advisoryFor } from './birds.js';
import { ahasRaw, parseAhasLevel, ahasRouteType } from './ahasapi.js';

const FIXTURE_URL = new URL('../../data/fixtures/ahas-routes-sample.json', import.meta.url);

// Local id normalizer (kept independent of mtr.js to avoid an import cycle).
const normId = (id) => String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function loadFixture() {
  return JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
}

/**
 * @returns {Promise<{risk: Map<string, {level,note,source,segments}>, live: boolean}>}
 *          keyed by normalized route id.
 */
export async function fetchRouteRisk(ids, offline, signal) {
  // Live AHAS (usahas.com) per IR/VR/SR route (AR refueling tracks have no bird
  // route). Caller passes only the nearby route ids. Capped to bound the number
  // of requests; failures/unmapped types are omitted (UNAVAILABLE, not faked).
  if (!offline) {
    const risk = new Map();
    const wanted = [...new Set(ids.map((id) => normId(id)))]
      .map((key) => ({ key, type: ahasRouteType(key) }))
      .filter((r) => r.type)
      .slice(0, 25);
    await Promise.allSettled(wanted.map(async ({ key, type }) => {
      const level = parseAhasLevel(await ahasRaw('GetAHASRisk', type, key, undefined, signal));
      if (level) risk.set(key, { level, note: advisoryFor(level), source: 'AHAS (usahas.com)', segments: null });
    }));
    return { risk, live: risk.size > 0 };
  }
  const fixture = await loadFixture();
  const risk = new Map();
  for (const id of ids) {
    const key = normId(id);
    const rec = fixture[key];
    if (rec) {
      const level = normalizeRisk(rec.level);
      risk.set(key, { level, note: advisoryFor(level), source: 'AHAS (fixture)', segments: rec.segments || null });
    }
  }
  return { risk, live: false };
}

/** Bird risk for a named segment of a route, if the source provides per-segment data. */
export function segmentRisk(routeRec, segName) {
  if (!routeRec || !routeRec.segments) return null;
  const raw = routeRec.segments[segName] ?? routeRec.segments[String(segName || '').trim()];
  return raw ? normalizeRisk(raw) : null;
}
