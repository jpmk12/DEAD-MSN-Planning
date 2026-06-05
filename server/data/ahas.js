// AHAS bird risk per Military Training Route (and per segment). The USAF Avian
// Hazard Advisory System reports current/forecast bird-strike risk by MTR — the
// canonical low-level planning input. Live AHAS access (set AHAS_API_URL) would
// plug in here; otherwise the bundled fixture is used. Risk levels reuse the
// LOW/MODERATE/SEVERE vocabulary from the airfield bird layer.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeRisk, advisoryFor } from './birds.js';

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
  // No public AHAS API yet → production returns empty (UNAVAILABLE) instead of
  // fabricated per-route risk. Bundled sample is used only by the offline/test
  // path. (Live AHAS adapter plugs in here once an endpoint exists.)
  void signal;
  if (!offline) return { risk: new Map(), live: false };
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
