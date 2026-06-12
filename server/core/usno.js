// USNO Astronomical Applications API cross-check — authoritative rise/set/
// twilight times and moon phase from the U.S. Naval Observatory. Optional: when
// the service is reachable it confirms (or corrects) the locally-computed event
// times in astro.js. Offline / network failure / bad payload → null, so the
// computed values stand and nothing is ever fabricated.
//
// Endpoint: https://aa.usno.navy.mil/api/rstt/oneday?date=YYYY-MM-DD&coords=LAT,LON&tz=0
// HTTPS only (port 443) — fits the Node.js Hosting outbound policy. USNO's
// one-day product gives civil twilight (not the −12° nautical BMNT/EENT this app
// uses for the NVG boundary), so only the fields USNO actually provides are
// tagged authoritative; the rest remain computed.

const USNO_BASE = 'https://aa.usno.navy.mil/api/rstt/oneday';

/** UTC calendar date (YYYY-MM-DD) of an instant. */
export function usnoDate(when) {
  const d = new Date(when instanceof Date ? when.getTime() : (typeof when === 'number' ? when : Date.parse(when)));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Parse a USNO `rstt/oneday` JSON payload into the brief's event shape. Pure —
 * no network — so it is unit-testable against a captured fixture. Times come
 * back as "HH:MM" in the requested tz (we always ask tz=0 → UTC), so we stitch
 * them onto the queried date as Zulu ISO instants.
 */
export function parseUsnoOneDay(json, date) {
  const data = json?.properties?.data;
  if (!data) return null;
  const toIso = (hhmm) => (hhmm ? `${date}T${hhmm}:00Z` : null);
  const pick = (arr, phen) => {
    const e = (arr || []).find((x) => x && x.phen === phen);
    return e ? toIso(e.time) : null;
  };
  const sun = data.sundata || [];
  const moon = data.moondata || [];
  const events = {
    sunrise: pick(sun, 'Rise'),
    sunset: pick(sun, 'Set'),
    civilDawn: pick(sun, 'Begin Civil Twilight'),
    civilDusk: pick(sun, 'End Civil Twilight'),
    moonrise: pick(moon, 'Rise'),
    moonset: pick(moon, 'Set'),
  };
  let fraction = null;
  if (data.fracillum != null) {
    const n = Number(String(data.fracillum).replace('%', '').trim());
    if (Number.isFinite(n)) fraction = Math.round(n) / 100;
  }
  return {
    source: 'USNO',
    date,
    events,
    moon: { fraction, name: data.curphase || null },
    closestPhase: data.closestphase?.phase || null,
  };
}

/**
 * Fetch the USNO one-day rise/set/twilight + moon phase for a place/date.
 * Returns the parsed cross-check, or null on offline / failure / timeout (the
 * caller then falls back to the computed astro.js values). `fetchImpl` is
 * injectable for tests.
 */
export async function usnoOneDay(when, lat, lon, { offline = false, fetchImpl, timeoutMs = 6000 } = {}) {
  if (offline || lat == null || lon == null) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const date = usnoDate(when);
  const coords = `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
  const url = `${USNO_BASE}?date=${date}&coords=${encodeURIComponent(coords)}&tz=0`;
  try {
    const opts = {};
    if (typeof AbortSignal?.timeout === 'function') opts.signal = AbortSignal.timeout(timeoutMs);
    const r = await doFetch(url, opts);
    if (!r || !r.ok) return null;
    const json = await r.json();
    return parseUsnoOneDay(json, date);
  } catch {
    return null;
  }
}

/**
 * Merge a USNO cross-check into a computed `nvgIllum()` result. Authoritative
 * event times overwrite the matching computed ones; the band, millilux, LOW/HIGH
 * call and lunar position stay computed (USNO doesn't supply those, and the
 * −12° BMNT/EENT have no USNO one-day field). `source` reflects what was used.
 */
export function mergeUsno(computed, usno) {
  if (!computed) return computed;
  if (!usno) return computed;
  const events = { ...computed.events };
  const usnoFields = [];
  for (const k of Object.keys(usno.events || {})) {
    if (usno.events[k]) { events[k] = usno.events[k]; usnoFields.push(k); }
  }
  return {
    ...computed,
    events,
    source: usnoFields.length ? 'computed+USNO' : computed.source,
    usno: { fields: usnoFields, moon: usno.moon, closestPhase: usno.closestPhase },
  };
}
