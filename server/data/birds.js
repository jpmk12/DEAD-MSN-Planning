// Bird/wildlife hazard (AHAS / BAM).
//
// The USAF Avian Hazard Advisory System (AHAS, https://www.usahas.com) fuses
// NEXRAD returns, weather, and the Bird Avoidance Model (BAM, seasonal history)
// into a current risk level per airfield / MOA / route — the standard military
// bird-strike planning input. There is no stable public JSON API, so this
// module returns a clean shape from a fixture and documents the live seam.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FIXTURE_URL = new URL('../../data/fixtures/birds-sample.json', import.meta.url);

export const RISK_RANK = { LOW: 0, MODERATE: 1, SEVERE: 2 };

const ADVISORY = {
  LOW: 'Normal precautions.',
  MODERATE: 'Heightened awareness; consider avoiding low-level/pattern work at dawn/dusk.',
  SEVERE: 'Avoid low-altitude operations if able; brief bird-strike response.',
};

/** Normalize/validate a level string. */
export function normalizeRisk(level) {
  const up = String(level || '').toUpperCase();
  return up in RISK_RANK ? up : 'LOW';
}

export function advisoryFor(level) {
  return ADVISORY[normalizeRisk(level)];
}

async function loadFixture() {
  return JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
}

/** @returns {Promise<{risk:Map<string,{level,note,source}>, live:boolean}>} */
export async function fetchBirdRisk(icaos, offline) {
  // Live AHAS query would go here when offline === false and reachable.
  void offline;
  const fixture = await loadFixture();
  const risk = new Map();
  for (const icao of icaos) {
    const level = normalizeRisk(fixture[icao.toUpperCase()] ?? 'LOW');
    risk.set(icao.toUpperCase(), { level, note: advisoryFor(level), source: 'AHAS/BAM (fixture)' });
  }
  return { risk, live: false };
}
