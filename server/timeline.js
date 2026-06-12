// Sortie timeline: hour-by-hour conditions per field across the mission window,
// so the AC sees WHERE AND WHEN weather threatens each phase on one screen.
//
// Source policy per hour (honest, never fabricated):
//   - within ±90 min of "now": the current METAR governs (observed).
//   - beyond that: the TAF period valid at that hour governs (forecast).
//   - neither available → null cell (shown UNAVAILABLE, never interpolated).
// Each cell runs the SAME tested wind/runway engine and ceiling/vis checks the
// cards use, so the timeline and the cards can never disagree.

import { analyzeAirfield } from './core/analyze.js';
import { decodeTaf, tafAt } from './data/taf.js';
import { metarConditions, DEFAULT_LIMITS } from './brief.js';
import { getAirport } from './data/airports.js';
import { loadWeather } from './data/weather.js';
import { ahasRaw, parseAhasHourly, ahasAreaForIcao, ahasRouteType, ahasHasRoute } from './data/ahasapi.js';
import { nvgIllum } from './core/astro.js';

const HOUR_MS = 3600000;
const METAR_GOVERNS_MIN = 90; // matches the brief's FUTURE_MIN horizon

/**
 * Column time-points spanning the sortie window (now → departure-1h …
 * landing+2h). The window ALWAYS reaches the last stop; to keep the column count
 * readable on a long/far sortie, the step adapts (1h normally, 2h/3h for long
 * days) so the landing is never cut off. Returns ISO instants (column starts).
 */
export function hourRange(stops, nowMs, maxCols = 16) {
  const times = (stops || []).map((s) => Date.parse(s.when)).filter(Number.isFinite);
  const floorH = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;
  let from, to;
  if (times.length) {
    from = Math.min(floorH(Math.min(...times)) - HOUR_MS, floorH(nowMs));
    to = floorH(Math.max(...times)) + 2 * HOUR_MS;
  } else {
    from = floorH(nowMs);
    to = from + 12 * HOUR_MS;
  }
  const spanH = Math.round((to - from) / HOUR_MS);
  const step = Math.max(1, Math.ceil(spanH / maxCols)); // hours per column
  const hours = [];
  for (let t = from; t <= to; t += step * HOUR_MS) hours.push(new Date(t).toISOString());
  // Guarantee the window end (landing + buffer) is a column even if step skipped it.
  const lastIso = new Date(to).toISOString();
  if (hours[hours.length - 1] !== lastIso) hours.push(lastIso);
  return hours;
}

const hourKey = (iso) => iso.slice(0, 13); // "YYYY-MM-DDTHH"

/** One field's row of hourly cells. Pure — all inputs injected (testable). */
export function fieldTimeline({ airport, obs, tafRaw, birdByHour, hours, nowMs, limits = DEFAULT_LIMITS }) {
  const decoded = tafRaw ? decodeTaf(tafRaw) : null;
  const curCond = obs ? metarConditions(obs.rawText) : null;
  return hours.map((iso) => {
    const t = Date.parse(iso);
    const minFromNow = Math.abs(t - nowMs) / 60000;
    const bird = birdByHour ? (birdByHour[hourKey(iso)] ?? null) : null;

    // Pick the governing source for this hour.
    let source = null, wind = null, ceilingFt = null, visibilitySm = null, cat = null, caveat = null;
    if (obs && minFromNow <= METAR_GOVERNS_MIN) {
      source = 'METAR';
      wind = obs.wind;
      ceilingFt = curCond?.ceilingFt ?? null;
      visibilitySm = curCond?.visibilitySm ?? null;
      cat = curCond?.flightCategory ?? null;
    } else if (decoded) {
      const fc = tafAt(decoded, iso);
      if (fc && fc.withinValidity) {
        source = 'TAF';
        wind = fc.wind ? { dirTrue: fc.wind.dirTrue, speedKt: fc.wind.speedKt, gustKt: fc.wind.gustKt } : null;
        ceilingFt = fc.ceilingFt;
        visibilitySm = fc.visibilitySm;
        cat = fc.flightCategory;
        if ((fc.caveats || []).length) caveat = fc.caveats.map((c) => c.label).join(' · ');
      }
    }
    if (!source) return { t: iso, source: null, status: null, bird };

    // Same engine as the cards: runway selection + warnings off this hour's wind.
    let active = null, crosswindKt = null, gustCrosswindKt = null, warnings = [];
    if (wind && airport) {
      const a = analyzeAirfield(airport, { icao: airport.icao, wind, tempC: null, altimHpa: null }, limits);
      warnings = [...a.warnings];
      if (a.active) {
        active = a.active.ident;
        crosswindKt = Math.round(a.active.crosswindKt);
        gustCrosswindKt = a.active.gustCrosswindKt != null ? Math.round(a.active.gustCrosswindKt) : null;
      }
    }
    if (ceilingFt != null && limits.ceilingMinFt != null && ceilingFt < limits.ceilingMinFt) {
      warnings.push(`Ceiling ${ceilingFt} ft below planning minimum (${limits.ceilingMinFt} ft).`);
    }
    if (visibilitySm != null && limits.visMinSm != null && visibilitySm < limits.visMinSm) {
      warnings.push(`Visibility below planning minimum (${limits.visMinSm} SM).`);
    }

    let status = 'GO';
    if (warnings.some((w) => /exceeds/.test(w))) status = 'NO-GO';
    else if (warnings.length || bird === 'SEVERE') status = 'CAUTION';

    return {
      t: iso,
      source,
      wind: wind ? { dirTrue: wind.dirTrue, speedKt: wind.speedKt, gustKt: wind.gustKt ?? null } : null,
      active,
      crosswindKt,
      gustCrosswindKt,
      ceilingFt,
      visibilitySm,
      cat,
      bird,
      caveat,
      warn: warnings[0] ?? null,
      status,
    };
  });
}

/** AHAS 12-hr hourly levels as { "YYYY-MM-DDTHH": LEVEL }, or null. */
async function ahasHourMap(type, area, whenIso) {
  try {
    const xml = await ahasRaw('GetAHASRisk12', type, area, whenIso);
    const series = parseAhasHourly(xml);
    if (!series.length) return null;
    const map = {};
    for (const s of series) {
      // AHAS times are "YYYY-MM-DD HH:MM:SS" — normalize to the ISO hour key.
      const k = String(s.time || '').replace(' ', 'T').slice(0, 13);
      if (k) map[k] = s.level;
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Build the sortie timeline. `inject` (demo/tests) supplies data without the
 * network: { now, airports:{icao:rec}, metars:{icao:rawText|obs}, tafs:{icao:raw},
 * birds:{key:{hourKey:LEVEL}} }.
 */
export async function buildTimeline({ stops = [], routes = [], offline = false, limits = DEFAULT_LIMITS, nvg = false, inject = null }) {
  const nowMs = inject?.now ? Date.parse(inject.now) : Date.now();
  const hours = hourRange(stops, nowMs);
  const fields = [...new Set(stops.map((s) => String(s.icao || '').toUpperCase()).filter(Boolean))];

  // Airports + weather (injected for the demo, fetched otherwise).
  let obsByIcao = new Map();
  let tafByIcao = new Map();
  const airportByIcao = new Map();
  if (inject) {
    const { parseRawMetar } = await import('./data/tgftp.js');
    for (const icao of fields) {
      airportByIcao.set(icao, inject.airports?.[icao] ?? null);
      const m = inject.metars?.[icao];
      if (m) obsByIcao.set(icao, typeof m === 'string' ? parseRawMetar(m) : m);
      if (inject.tafs?.[icao]) tafByIcao.set(icao, inject.tafs[icao]);
    }
  } else {
    const [wx, ...aps] = await Promise.all([
      loadWeather(fields, offline),
      ...fields.map((i) => getAirport(i, offline)),
    ]);
    fields.forEach((icao, i) => airportByIcao.set(icao, aps[i] ?? null));
    obsByIcao = new Map(wx.obs.map((o) => [o.icao.toUpperCase(), o]));
    tafByIcao = wx.tafs;
  }

  // AHAS hourly per field area and per route (12-hr product, anchored at the
  // window start). Injected in demo mode; failures yield null (UNAVAILABLE).
  const windowStart = hours[0];
  const birdFor = async (key, type, area) => {
    if (inject) return inject.birds?.[key] ?? null;
    if (offline || !area) return null;
    return ahasHourMap(type, area, windowStart);
  };

  const fieldRows = await Promise.all(fields.map(async (icao) => {
    const airport = airportByIcao.get(icao);
    const birdByHour = await birdFor(icao, 'MILAIR', ahasAreaForIcao(icao));
    const cells = fieldTimeline({
      airport, obs: obsByIcao.get(icao) ?? null, tafRaw: tafByIcao.get(icao) ?? null,
      birdByHour, hours, nowMs, limits,
    });
    // NVG illumination band per column (day/twilight/night + LOW/HIGH), computed
    // for the field's location at each hour. Only when the NVG flag is on.
    const illum = (nvg && airport && airport.lat != null)
      ? hours.map((iso) => {
          const g = nvgIllum(iso, airport.lat, airport.lon);
          return g ? { t: iso, band: g.band, mlx: g.illumMlx, class: g.illumClass, moonUp: g.moon.up } : { t: iso, band: null };
        })
      : null;
    const roles = stops.filter((s) => String(s.icao).toUpperCase() === icao)
      .map((s) => ({ role: s.role || 'FIELD', label: s.label || icao, when: s.when || null }));
    return { icao, found: !!airport, roles, cells, illum };
  }));

  const routeRows = await Promise.all((routes || []).map(async (r) => {
    const id = typeof r === 'string' ? r : r.id;
    const when = typeof r === 'string' ? null : (r.when ?? null);
    const type = ahasRouteType(id);
    const area = type && ahasHasRoute(id) ? String(id).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
    const birdByHour = await birdFor(id, type, area);
    const cells = hours.map((iso) => ({ t: iso, bird: birdByHour ? (birdByHour[hourKey(iso)] ?? null) : null }));
    return { id, when, cells };
  }));

  return {
    generatedAt: new Date().toISOString(),
    now: new Date(nowMs).toISOString(),
    nvg,
    window: { from: hours[0], to: hours[hours.length - 1], hours },
    limits,
    fields: fieldRows,
    routes: routeRows,
  };
}
