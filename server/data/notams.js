// FAA NOTAM client + categorization.
//
// The live FAA NOTAM API requires a free client_id/client_secret (set
// FAA_NOTAM_CLIENT_ID / FAA_NOTAM_CLIENT_SECRET). Without them we fall back to
// the bundled fixture. The value-add is categorize-and-rank so the
// runway/approach/lighting items that affect the sortie float to the top.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { nmsConfigured, fetchNmsRaw } from './nms.js';

const CATEGORY_PRIORITY = {
  RUNWAY: 100,
  APPROACH: 70,
  GPS_RAIM: 65,
  LIGHTING: 60,
  OBSTACLE: 55,
  AIRSPACE: 50,
  BIRD: 45,
  TAXIWAY: 40,
  NAVAID: 35,
  SERVICES: 20,
  OTHER: 10,
};

// Ordered rules: first match wins.
const RULES = [
  { test: /\bRWY\b.*\b(CLSD|CLOSED)\b/i, category: 'RUNWAY', bump: 10 },
  { test: /\bRWY\b/i, category: 'RUNWAY' },
  { test: /\b(GPS|RAIM|WAAS)\b.*\b(UNREL|U\/S|OTS|UNRELIABLE)\b/i, category: 'GPS_RAIM' },
  { test: /\b(ILS|LOC|GS|RNAV|RNP|VOR|TACAN|VASI|PAPI)\b.*\b(U\/S|OTS|UNUSBL|UNMON)\b/i, category: 'APPROACH' },
  { test: /\b(PAPI|VASI|REIL|ALS|ALSF|MALSR|RWY\s?EDGE\s?LGT|LGT|LIGHTING)\b/i, category: 'LIGHTING' },
  { test: /\b(OBST|OBSTACLE|CRANE|TOWER)\b/i, category: 'OBSTACLE' },
  { test: /\b(TFR|AIRSPACE|MOA|RESTRICTED|TEMPORARY FLIGHT)\b/i, category: 'AIRSPACE' },
  { test: /\bBIRD\b/i, category: 'BIRD' },
  { test: /\bTWY\b/i, category: 'TAXIWAY' },
  { test: /\b(VOR|TACAN|DME|NDB|VORTAC)\b/i, category: 'NAVAID' },
  { test: /\b(FUEL|ARRESTING|SERVICE|FIRE|ARFF|RFF)\b/i, category: 'SERVICES' },
];

export function categorize(text) {
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return { category: rule.category, priority: CATEGORY_PRIORITY[rule.category] + (rule.bump ?? 0) };
    }
  }
  return { category: 'OTHER', priority: CATEGORY_PRIORITY.OTHER };
}

function classify(raw) {
  const { category, priority } = categorize(raw.text);
  return { ...raw, category, priority };
}

/** Sort most-significant first. */
export function rankNotams(notams) {
  return [...notams].sort((a, b) => b.priority - a.priority);
}

const FIXTURE_URL = new URL('../../data/fixtures/notams-sample.json', import.meta.url);

async function loadFixture(icaos) {
  const raw = await readFile(fileURLToPath(FIXTURE_URL), 'utf8');
  const all = JSON.parse(raw);
  const wanted = new Set(icaos.map((i) => i.toUpperCase()));
  return rankNotams(all.filter((n) => wanted.has(n.icao.toUpperCase())).map(classify));
}

const FAA_BASE = 'https://external-api.faa.gov/notamapi/v1/notams';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFaa(icao, signal, attempt = 0) {
  const clientId = process.env.FAA_NOTAM_CLIENT_ID;
  const clientSecret = process.env.FAA_NOTAM_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('no FAA credentials');

  const url = `${FAA_BASE}?domesticLocation=${encodeURIComponent(icao)}&pageSize=50`;
  const res = await fetch(url, {
    signal,
    headers: { client_id: clientId, client_secret: clientSecret, Accept: 'application/json', 'User-Agent': 'C17MissionPlanner/1.0' },
  });
  // Transient throttling / upstream hiccup: back off and retry so one field
  // doesn't silently drop out of a multi-airfield brief.
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await delay(300 * 2 ** attempt);
    return fetchFaa(icao, signal, attempt + 1);
  }
  if (!res.ok) throw new Error(`FAA NOTAM ${res.status}`);
  const json = await res.json();
  const items = json.items ?? [];
  return rankNotams(
    items.map((it) => {
      const n = it.properties?.coreNOTAMData?.notam ?? {};
      return classify({
        id: n.id ?? n.number ?? 'UNKNOWN',
        icao,
        text: n.text ?? '',
        effectiveStart: n.effectiveStart,
        effectiveEnd: n.effectiveEnd,
      });
    }),
  );
}

/** @returns {Promise<{notams:any[], live:boolean}>} */
export async function fetchNotams(icaos, offline, signal) {
  // Preferred: FAA NMS-API (bearer token). Then legacy FAA NOTAM API. Then fixture.
  if (!offline && nmsConfigured()) {
    try {
      const raw = await fetchNmsRaw(icaos, signal);
      return { notams: rankNotams(raw.map(classify)), live: true };
    } catch {
      // fall through
    }
  }
  if (!offline && process.env.FAA_NOTAM_CLIENT_ID) {
    // Sequential (not Promise.all): the FAA NOTAM API throttles concurrent
    // bursts. Fetch one field at a time (with retry/backoff in fetchFaa), keep
    // whatever succeeds, and skip a field that still fails so it doesn't drop
    // the rest. Only fall back to the fixture if every field failed.
    const uniq = [...new Set(icaos.map((i) => i.toUpperCase()))];
    const all = [];
    let any = false;
    for (const i of uniq) {
      try { all.push(...await fetchFaa(i, signal)); any = true; }
      catch { /* skip this field, keep the rest */ }
    }
    if (any) return { notams: rankNotams(all), live: true };
  }
  // offline=true → bundled sample (tests only). Production with no/failed live
  // source returns empty (UNAVAILABLE) rather than fabricated NOTAMs.
  if (offline) return { notams: await loadFixture(icaos), live: false };
  return { notams: [], live: false };
}
