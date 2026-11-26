// Planner orchestrator — builds the 72-hour OPS TIMELINE for every airfield of a
// mission, on a shared Zulu axis. It is the only place that fetches; the timeline
// logic lives in the pure, shared engine public/opsTimeline.js (imported here so
// the server and the browser run byte-for-byte the same rules).
//
// Per field: airport + runway TRUE headings, the raw+decoded TAF (adapted to the
// engine's TafPeriod shape, with the raw weather codes and any military icing
// 6-groups), the hourly model profile (Open-Meteo), and NOTAM closure windows.
// Nothing is fabricated — a dead source degrades to UNAVAILABLE (live:false).

import { getAirport } from './data/airports.js';
import { loadWeather } from './data/weather.js';
import { fetchNotams } from './data/notams.js';
import { decodeTaf, tafTimeMs } from './data/taf.js';
import { fetchModelProfile } from './data/windsaloft.js';
import { magToTrue } from './core/wind.js';
import { buildOpsTimeline, windowsWithNotams, rangeLabel } from '../public/opsTimeline.js';

const HOUR = 3600000;
const floorHour = (ms) => Math.floor(ms / HOUR) * HOUR;

/** Airport runways → the engine's per-END list: `{ ident, headingDegT }`.
 *  Honours a surveyed TRUE heading when present, else magnetic + field magVar. */
function toRunwayEnds(airport) {
  if (!airport || !Array.isArray(airport.runways)) return [];
  return airport.runways.map((r) => ({
    ident: r.ident,
    headingDegT: typeof r.trueHeading === 'number' ? r.trueHeading
      : (typeof r.magHeading === 'number' ? magToTrue(r.magHeading, airport.magVar ?? 0) : null),
  })).filter((r) => r.ident);
}

/** Decoded TAF → the engine's TafPeriod[] (ISO/ms, raw weather codes, change type). */
export function toTafPeriods(decoded, anchorMs) {
  if (!decoded || !Array.isArray(decoded.periods) || !decoded.periods.length) return null;
  const validToMs = decoded.validTo ? tafTimeMs(decoded.validTo, anchorMs) : null;
  return decoded.periods.map((p) => {
    const toMs = p.to ? tafTimeMs(p.to, anchorMs) : validToMs; // FM has no explicit end
    return {
      fromMs: tafTimeMs(p.from, anchorMs),
      toMs,
      changeType: p.kind, // 'BASE' | 'BECMG' | 'TEMPO' | 'PROB' — engine treats TEMPO/PROB as overlays
      flightCategory: p.flightCategory || null,
      windDir: p.wind ? (p.wind.dirTrue === 'VRB' ? null : p.wind.dirTrue) : null,
      windVariable: p.wind ? p.wind.dirTrue === 'VRB' : false,
      windSpeedKt: p.wind ? p.wind.speedKt : null,
      windGustKt: p.wind ? (p.wind.gustKt ?? null) : null,
      wxRaw: (p.wxTokens || []).join(' '),
    };
  }).filter((p) => Number.isFinite(p.fromMs));
}

/** Parse U.S. military TAF icing 6-groups (6 Ic hhh t) from the raw TAF text.
 *  Ic 1–3 light · 4–6 moderate · 7–9 severe; hhh = base (hundreds ft AGL);
 *  t = thickness (thousands ft, 0 = top unknown). e.g. 640305 → moderate 3,000–8,000. */
export function parseMilIcing(raw) {
  const out = [];
  if (!raw) return out;
  for (const m of String(raw).matchAll(/\b6([1-9])(\d{3})(\d)\b/g)) {
    const ic = Number(m[1]);
    const baseFtAgl = Number(m[2]) * 100;
    const thickFt = Number(m[3]) * 1000;
    out.push({
      intensity: ic <= 3 ? 'light' : ic <= 6 ? 'moderate' : 'severe',
      type: null, baseFtAgl, topFtAgl: thickFt > 0 ? baseFtAgl + thickFt : null,
      code: m[0], change: '',
    });
  }
  return out;
}

/** NOTAM records → closure windows the ops timeline can fold in (spec §6). A
 *  readable B)/C) window is used verbatim; a published day/hour schedule we don't
 *  expand is marked `indeterminate` (a dashed "SCHED" bar that joins no window). */
export function closuresFromNotams(notams, startMs, endMs) {
  const out = [];
  for (const n of notams || []) {
    const t = n.text || '';
    let kind = null, label = null, m;
    if ((m = /RWY\s+([0-9LRC/]+)\s+(?:CLSD|CLOSED)/i.exec(t))) { kind = 'closure'; label = `RWY ${m[1]}`; }
    else if ((m = /TWY\s+([A-Z0-9]+)\s+(?:CLSD|CLOSED)/i.exec(t))) { kind = 'closure'; label = `TWY ${m[1]}`; }
    else if ((m = /\b(ILS|LOC|GP|RWY)\s+([0-9LRC/]+)[\s\S]{0,24}?(?:U\/S|UNSERVICEABLE|UNSVC)/i.exec(t))) { kind = 'unserviceable'; label = `${m[1]} ${m[2]}`; }
    else continue;
    const fs = Date.parse(n.effectiveStart), fe = Date.parse(n.effectiveEnd);
    if (!Number.isFinite(fs) || !Number.isFinite(fe)) continue;
    const from = Math.max(fs, startMs), to = Math.min(fe, endMs);
    if (to <= from) continue;
    const indeterminate = /\b(DLY|DAILY|MON|TUE|WED|THU|FRI|SAT|SUN)\b/i.test(t) && /\d{3,4}\s*-\s*\d{3,4}/.test(t);
    out.push({ fromMs: from, toMs: to, kind, label, text: t, indeterminate });
  }
  return out;
}

function fieldSummary(field) {
  if (!field.live) return `${field.icao}: UNKNOWN — no TAF and no model profile available.`;
  const w = field.windows;
  if (!w.length) return `${field.icao}: no limiting window in the next ${field.hours} h.`;
  const labels = [];
  for (const win of w) for (const f of win.factors) if (!labels.includes(f.label)) labels.push(f.label);
  return `${field.icao}: ${w.length} limiting window${w.length > 1 ? 's' : ''} — first ${rangeLabel(w[0].fromMs, w[0].toMs)}: ${labels.slice(0, 3).join(', ')}`;
}

/**
 * Build the mission planner timelines.
 * @param {string[]} ids — airfield ICAOs (deduped, capped by the caller).
 * @param {string|null} startIso — axis anchor (ISO); defaults to now.
 * @param {boolean} offline — use fixtures (tests/demo) instead of the network.
 * @param {{icao:string,kind:string,ms:number,label?:string}[]} events — ETD/ETA markers.
 * @param {object|null} inject — test hook: { airports, tafs, notams, models } by ICAO.
 * @param {number} horizonH
 */
export async function buildPlanner(ids, startIso, offline = false, events = [], inject = null, horizonH = 72) {
  const startMs = startIso && !Number.isNaN(Date.parse(startIso)) ? Date.parse(startIso) : Date.now();
  const anchor = floorHour(startMs);
  const fields = [...new Set((ids || []).map((s) => String(s || '').toUpperCase()).filter(Boolean))];

  // Weather + NOTAMs are one bulk fetch each (unless injected).
  let tafByIcao = new Map(), notamsByIcao = new Map(), wxLive = false, notamLive = false;
  if (!inject) {
    const [wx, nt] = await Promise.all([loadWeather(fields, offline), fetchNotams(fields, offline)]);
    tafByIcao = wx.tafs || new Map();
    wxLive = wx.tafLive === true || wx.live === true;
    notamLive = nt.live === true;
    for (const n of (nt.notams || [])) {
      const k = String(n.icao || '').toUpperCase();
      if (!notamsByIcao.has(k)) notamsByIcao.set(k, []);
      notamsByIcao.get(k).push(n);
    }
  }

  const endMs = anchor + horizonH * HOUR;
  const out = await Promise.all(fields.map(async (icao) => {
    const airport = inject ? (inject.airports?.[icao] ?? null) : await getAirport(icao, offline);
    const tafRaw = inject ? (inject.tafs?.[icao] ?? null) : (tafByIcao.get(icao) || null);
    const notams = inject ? (inject.notams?.[icao] ?? []) : (notamsByIcao.get(icao) || []);

    // Hourly model profile. Offline fixtures are rebased so hour 0 == the axis anchor.
    let hours = null, modelLive = false;
    if (inject) { hours = inject.models?.[icao] ?? null; modelLive = !!hours; }
    else if (airport && airport.lat != null) {
      const mp = await fetchModelProfile(airport.lat, airport.lon, startIso, offline);
      hours = mp.hours; modelLive = mp.live;
      if (offline && hours.length) { const shift = anchor - floorHour(hours[0].t); hours = hours.map((h) => ({ ...h, t: h.t + shift })); }
    }

    const decoded = tafRaw ? decodeTaf(tafRaw) : null;
    const taf = toTafPeriods(decoded, anchor);
    const tafGroups = parseMilIcing(tafRaw).map((g) => ({
      ...g, fromMs: decoded?.validFrom ? tafTimeMs(decoded.validFrom, anchor) : anchor,
      toMs: decoded?.validTo ? tafTimeMs(decoded.validTo, anchor) : endMs,
    }));

    const timeline = buildOpsTimeline({
      nowMs: startMs, lat: airport?.lat ?? 0, lon: airport?.lon ?? 0,
      elevationM: airport && airport.elevationFt != null ? airport.elevationFt / 3.28084 : null,
      hours, taf, tafGroups, runways: toRunwayEnds(airport), horizonH,
    });

    const closures = closuresFromNotams(notams, timeline.startMs, endMs);
    const { lane: notamLane, windows } = windowsWithNotams(timeline, closures);

    const field = {
      icao, found: !!airport, name: airport?.name ?? null, live: timeline.live,
      startMs: timeline.startMs, hours: timeline.hours, tafEndMs: timeline.tafEndMs,
      light: timeline.light, lanes: [...timeline.lanes, notamLane],
      temps: timeline.temps, temp: timeline.temp, windows,
      events: (events || []).filter((e) => String(e.icao || '').toUpperCase() === icao),
      sources: { taf: taf != null, model: hours != null && hours.length > 0, notams: closures.length > 0 },
    };
    field.summary = fieldSummary(field);
    return field;
  }));

  return {
    generatedAt: new Date().toISOString(), startIso: new Date(startMs).toISOString(),
    startMs: anchor, horizonH, fields: out,
    live: { taf: inject ? true : wxLive, model: out.some((f) => f.sources.model), notams: inject ? true : notamLive },
  };
}
