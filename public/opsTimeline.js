// 72-hour airfield OPS TIMELINE — pure engine (no DOM, no node, no fetch, no
// clock reads except the injected nowMs/startMs). Shared verbatim by the server
// orchestrator (server/planner.js) and the client renderer (public/planner.js),
// and unit-tested in public/opsTimeline.test.js. Mirrors public/taf-window.js and
// public/ribbon.js (pure ESM modules imported by both the app and node:test).
//
// It turns an hour-by-hour model profile + a decoded TAF (+ optional military
// icing groups + runway headings) into per-lane cells and merged "limiting
// windows", plus a scrub readout (sliceAt) and step points (changePoints).
//
// NON-NEGOTIABLE RULES (from the feature spec):
//  1. A FORECAST is AMBER at most; RED is for the observed. The crosswind lane is
//     the one exception — its advisory bands mean the same forecast or observed.
//  2. UNKNOWN is a value, never clear. A lane with no input reads UNKNOWN with the
//     reason; nothing missing is drawn green/blank. No TAF AND no model → live:false.
//  3. The TAF governs its window: inside the TAF's validity the TAF's weather and
//     category win; the model fills ONLY beyond it. A base period prevails until
//     the next base starts. TEMPO/PROB fold in as the worse of base and overlay,
//     drawn dashed.
//  4. Model reads are dashed and labelled "(model)". Beyond the TAF the Sky lane
//     is visibility only ("IFR vis" / "vis ok") — no ceiling claim.
//  5. The timeline never moves a status light.
//  6. Thresholds are planning guidance, not a de-ice policy / AFI / flight manual.
//  7. Never guess. TAF and model disagreeing (TAF freezing rain, model air +6 °C)
//     is said, never averaged.
//  8. All times Zulu.
//
// Crosswind note: this codebase stores runways as per-END objects, so the engine
// takes `runways: [{ ident, headingDegT }]` (one per usable end) and computes the
// best end exactly as the spec (least crosswind among ends with a headwind), in
// place of the spec's le/he-pair input.

const HOUR = 3600000;

// ---- weather vocabulary + rank (worst wins) --------------------------------
export const WX_RANK = {
  thunder: 10, fzra: 9, fzdz: 8, pellets: 7, hail: 7, snow: 6, heavyrain: 5,
  rain: 4, showers: 4, drizzle: 3, fzfog: 2, fog: 1, none: 0,
};
const WX_CHIP = {
  thunder: 'TS', fzra: 'FZRA', fzdz: 'FZDZ', pellets: 'PL', hail: 'GR', snow: 'SN',
  heavyrain: '+RA', rain: 'RA', showers: 'SHRA', drizzle: 'DZ', fzfog: 'FZFG', fog: 'FG', none: '',
};
const WX_NAME = {
  thunder: 'thunderstorm', fzra: 'freezing rain', fzdz: 'freezing drizzle', pellets: 'ice pellets',
  hail: 'hail', snow: 'snow', heavyrain: 'heavy rain', rain: 'rain', showers: 'showers',
  drizzle: 'drizzle', fzfog: 'freezing fog', fog: 'fog', none: 'no precipitation',
};
const isPrecip = (k) => k !== 'none' && k !== 'fog' && k !== 'fzfog';

/** Classify a TAF present-weather string into our worst-wins key. */
export function wxFromTaf(raw) {
  if (!raw) return 'none';
  let s = String(raw).toUpperCase();
  if (/\bNSW\b/.test(s)) return 'none';
  s = s.replace(/\bVC/g, ''); // strip "in the vicinity" prefix but keep the phenomenon
  const noBlow = s.replace(/BLSN|DRSN/g, ''); // blowing/drifting snow is not falling snow
  if (/TS/.test(s)) return 'thunder';
  if (/FZRA/.test(s)) return 'fzra';
  if (/FZDZ/.test(s)) return 'fzdz';
  if (/(?:^|[-+\s])(?:PL|GS)/.test(s)) return 'pellets';
  if (/GR/.test(s)) return 'hail';
  if (/FZFG/.test(s)) return 'fzfog';
  if (/(?:SH)?(?:SN|SG)/.test(noBlow)) return 'snow';
  if (/\+(?:SH)?RA/.test(s)) return 'heavyrain';
  if (/SHRA/.test(s)) return 'showers';
  if (/RA/.test(s)) return 'rain';
  if (/DZ/.test(s)) return 'drizzle';
  if (/MIFG|BCFG|PRFG|FG/.test(s)) return 'fog';
  return 'none';
}

/** Classify a WMO weather code (model) into our worst-wins key. */
export function wxFromWmo(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return 'none';
  if (c === 95) return 'thunder';
  if (c === 96 || c === 99) return 'hail';
  if (c === 66 || c === 67) return 'fzra';
  if (c === 56 || c === 57) return 'fzdz';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c === 65 || c === 82) return 'heavyrain';
  if (c === 80 || c === 81) return 'showers';
  if (c >= 61 && c <= 64) return 'rain';
  if (c >= 51 && c <= 55) return 'drizzle';
  if (c === 48) return 'fzfog';
  if (c === 45) return 'fog';
  return 'none';
}

// ---- physics helpers (verbatim formulas from the spec) ---------------------

/** NWS / MSC wind chill (°C); valid ≤ 10 °C and ≥ 4.8 km/h, else the air temp. */
export function windChillC(tempC, windKt) {
  const v = windKt * 1.852;
  if (tempC > 10 || v < 4.8) return tempC;
  const p = Math.pow(v, 0.16);
  return Math.round((13.12 + 0.6215 * tempC - 11.37 * p + 0.3965 * tempC * p) * 10) / 10;
}

/** Low-precision solar altitude (degrees) — good to ~0.1°, plenty for shading. */
export function sunAltitude(ms, latDeg, lonDeg) {
  const rad = Math.PI / 180, d = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const ha = (gmst * 15 + lonDeg) * rad - ra;
  const lat = latDeg * rad;
  return Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha)) / rad;
}

/** Ceiling-free flight category from visibility in metres (visibility only). */
export function visCategory(visM) {
  if (visM == null || !Number.isFinite(visM)) return null;
  if (visM < 1609) return 'LIFR';     // < 1 SM
  if (visM < 4828) return 'IFR';      // < 3 SM
  if (visM <= 8047) return 'MVFR';    // ≤ 5 SM
  return 'VFR';
}

const CAT_RANK = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
const catTone = (cat) => (cat === 'LIFR' || cat === 'IFR' ? 'a' : cat === 'MVFR' ? 'i' : 'g');

// ---- time / label helpers --------------------------------------------------
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');
const floorHour = (ms) => Math.floor(ms / HOUR) * HOUR;
const hhz = (ms) => `${p2(new Date(ms).getUTCHours())}Z`;
/** "Thu 26 09Z" */
export function stampShort(ms) {
  const d = new Date(ms);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${p2(d.getUTCHours())}Z`;
}
/** "Thu 26 09Z–Fri 27 15Z" (names the second day only across a Zulu midnight). */
export function rangeLabel(fromMs, toMs) {
  const a = new Date(fromMs), b = new Date(toMs);
  const sameDay = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  return `${stampShort(fromMs)}–${sameDay ? hhz(toMs) : stampShort(toMs)}`;
}

// ---- limiting-window severity + ordering -----------------------------------
const SEV = {
  'ICE': 9, 'DE/ANTI-ICE': 9, 'LIFR': 9, 'SEV ICE': 9,
  'PL': 8, 'GLAZE': 8, 'LIGHTNING': 8, 'MOD ICE': 8,
  'SNOW': 7, 'DE-ICE': 7, 'IFR': 7, 'LIFR VIS': 7,
  'REFREEZE': 6, 'FZFG': 6, 'IFR VIS': 6, 'ICE LIKELY': 6, 'HEAT': 6,
  'WATER': 5,
};
/** Severity of a lane's label for picking the worst segment in a window.
 *  Exact match (so "ICE likely" never matches "ICE"); "WC …" and gusts "G…"
 *  are matched by prefix. */
export function labelSeverity(label) {
  const L = String(label || '').toUpperCase();
  if (SEV[L] != null) return SEV[L];
  if (L.startsWith('WC')) return 6;
  if (/^G\d/.test(L)) return 5;
  return 0;
}

const LANE_TITLE = {
  sky: 'Sky', precip: 'Precip', deice: 'Ground ice', runway: 'Runway',
  icing: 'Icing aloft', xwind: 'Crosswind', ramp: 'Ramp / crew', notam: 'NOTAMs',
};
// What limits first (window factor order). Precip is dropped when anything else explains it.
const FACTOR_ORDER = ['notam', 'runway', 'deice', 'sky', 'xwind', 'icing', 'ramp', 'precip'];

// ---- cell → segment merge --------------------------------------------------
const cellKey = (c) => (c ? `${c.tone}|${c.label}|${c.dashed ? 1 : 0}|${c.cat || ''}` : '');

/** Merge an hour-aligned array of cells (null = gap) into segments. */
function laneFromCells(key, cells, hoursArr, unknown = null) {
  const segs = [];
  let run = null;
  for (let i = 0; i < hoursArr.length; i++) {
    const c = cells[i];
    if (run && c && cellKey(c) === run._k) { run.toMs = hoursArr[i] + HOUR; continue; }
    if (run) { segs.push(run); run = null; }
    if (c) run = { fromMs: hoursArr[i], toMs: hoursArr[i] + HOUR, tone: c.tone, label: c.label, short: c.short, detail: c.detail, dashed: !!c.dashed, src: c.src, cat: c.cat, _k: cellKey(c) };
  }
  if (run) segs.push(run);
  for (const s of segs) delete s._k;
  return { key, title: LANE_TITLE[key], segs, unknown };
}

// ---- the hour read (spec §3) ----------------------------------------------
function normPeriods(taf) {
  return (taf || []).map((p) => ({
    fromMs: p.fromMs != null ? p.fromMs : Date.parse(p.from),
    toMs: p.toMs != null ? p.toMs : Date.parse(p.to),
    changeType: p.changeType || '',
    overlay: /TEMPO|PROB/.test(p.changeType || ''),
    flightCategory: p.flightCategory || null,
    wind: p.windSpeedKt != null || p.windDir != null
      ? { dir: p.windVariable ? 'VRB' : (p.windDir ?? null), kt: p.windSpeedKt ?? null, gust: p.windGustKt ?? null, variable: !!p.windVariable }
      : (p.wind || null),
    wx: wxFromTaf(p.wxRaw || ''),
  })).filter((p) => Number.isFinite(p.fromMs) && Number.isFinite(p.toMs));
}

function readHour(t, modelMap, bases, overlays, tafStartMs, tafEndMs) {
  const mid = t + HOUR / 2;
  const model = modelMap.get(t) || null;
  const airC = model && typeof model.tempC2m === 'number' ? model.tempC2m : null;
  const inTaf = tafStartMs != null && mid >= tafStartMs && mid <= tafEndMs;

  let cat = null, catSrc = 'model', catDashed = false, wxKey = 'none', wxSrc = 'model', wxDashed = false, overlay = false;
  let wind = null, windSrc = 'model';

  if (inTaf) {
    // latest-starting base whose effective window covers the midpoint
    let base = null;
    for (const b of bases) { if (b.fromMs <= mid && mid < b.effToMs) base = b; }
    if (!base) base = bases[bases.length - 1] || null;
    if (base) {
      cat = base.flightCategory; catSrc = 'taf';
      wxKey = base.wx; wxSrc = 'taf';
      if (base.wind && base.wind.kt != null) { wind = base.wind; windSrc = 'taf'; }
    }
    for (const ov of overlays) {
      if (ov.toMs <= t || ov.fromMs >= t + HOUR) continue; // overlap [t, t+HOUR)
      overlay = true;
      if (ov.flightCategory && (cat == null || CAT_RANK[ov.flightCategory] > CAT_RANK[cat])) { cat = ov.flightCategory; catDashed = true; }
      if (WX_RANK[ov.wx] > WX_RANK[wxKey]) { wxKey = ov.wx; wxDashed = true; }
      if (ov.wind && ov.wind.gust != null && (!wind || wind.gust == null || ov.wind.gust > wind.gust)) {
        wind = { ...(wind || { dir: ov.wind.dir, kt: ov.wind.kt }), gust: ov.wind.gust }; wxDashed = true;
      }
    }
    if (!wind && model) windSrc = 'model';
  } else {
    cat = visCategory(model ? model.visM : null);
    wxKey = wxFromWmo(model ? model.weatherCode : null);
  }
  if ((!wind) && model) { wind = { dir: model.windDir, kt: model.windKt, gust: model.gustKt, variable: false }; windSrc = 'model'; }

  const disagree = inTaf && (wxKey === 'fzra' || wxKey === 'fzdz') && airC != null && airC > 2;
  return { t, mid, inTaf, model, airC, cat, catSrc, catDashed, skyDashed: !inTaf, wxKey, wxSrc, wxDashed, overlay, wind, windSrc, disagree };
}

// ---- crosswind best-end (spec §4) ------------------------------------------
function bestEnd(runways, wind) {
  const ends = (runways || []).filter((r) => r && typeof r.headingDegT === 'number');
  if (!ends.length || !wind || wind.variable || wind.dir == null || wind.dir === 'VRB') return null;
  const kt = wind.kt || 0, gust = wind.gust != null ? wind.gust : kt, rad = Math.PI / 180;
  const comp = ends.map((r) => {
    const dd = ((wind.dir - r.headingDegT) % 360 + 540) % 360 - 180; // signed delta
    return { ident: r.ident, head: Math.cos(dd * rad) * kt, cross: Math.abs(Math.sin(dd * rad) * kt), gustCross: Math.abs(Math.sin(dd * rad) * gust) };
  });
  const head = comp.filter((c) => c.head >= 0);
  const pool = head.length ? head : comp;
  pool.sort((a, b) => a.cross - b.cross || a.gustCross - b.gustCross || b.head - a.head);
  return pool[0];
}

// ---- main builder ----------------------------------------------------------
/**
 * @param {object} inputs — see the spec §2 data contract (runways here are per-END
 *   `{ ident, headingDegT }`). Required: nowMs, lat, lon. All else optional.
 * @returns {object} OpsTimeline (spec §6): live, startMs, hours, tafEndMs, light,
 *   lanes, temps, temp, windows, summary, reason.
 */
export function buildOpsTimeline(inputs) {
  const { nowMs, lat, lon, elevationM = null, hours = null, taf = null, tafGroups = null, runways = [], horizonH = 72 } = inputs || {};
  const startMs = floorHour(nowMs);
  const hoursArr = [];
  for (let i = 0; i < horizonH; i++) hoursArr.push(startMs + i * HOUR);

  // No TAF and no model at all → the whole timeline is UNKNOWN.
  if ((!taf || !taf.length) && (!hours || !hours.length)) {
    return {
      live: false, startMs, hours: horizonH, tafEndMs: null, light: [], lanes: [], temps: [],
      temp: { minC: null, maxC: null, crossings: [] }, windows: [],
      summary: 'Next ' + horizonH + ' h: UNKNOWN — no TAF and no model profile available.',
      reason: 'no TAF and no model profile',
    };
  }

  const modelMap = new Map();
  for (const h of (hours || [])) modelMap.set(floorHour(h.t), h);

  // TAF base resolution: extend each base's `to` to the next base's `from`.
  const periods = normPeriods(taf);
  const bases = periods.filter((p) => !p.overlay).sort((a, b) => a.fromMs - b.fromMs);
  const overlays = periods.filter((p) => p.overlay);
  const tafStartMs = bases.length ? bases[0].fromMs : null;
  const tafEndMs = periods.length ? Math.max(...periods.map((p) => p.toMs)) : null;
  for (let i = 0; i < bases.length; i++) bases[i].effToMs = i + 1 < bases.length ? bases[i + 1].fromMs : (tafEndMs ?? bases[i].toMs);

  const reads = hoursArr.map((t) => readHour(t, modelMap, bases, overlays, tafStartMs, tafEndMs));

  // Icing groups overlapping an hour (base ≤ 10,000 ft AGL), worst intensity.
  const ICE_INT = { trace: 0, light: 1, moderate: 2, severe: 3 };
  const groupFor = (t) => {
    let best = null;
    for (const g of (tafGroups || [])) {
      if (!g || g.toMs <= t || g.fromMs >= t + HOUR) continue;
      if (g.baseFtAgl > 10000) continue;
      if (!best || ICE_INT[g.intensity] > ICE_INT[best.intensity]) best = g;
    }
    return best;
  };

  // ---- per-lane cells ----
  const sky = [], precip = [], deice = [], runway = [], icing = [], xwind = [], ramp = [];
  const temps = [];
  const noHeadings = !(runways || []).some((r) => r && typeof r.headingDegT === 'number');

  for (let i = 0; i < reads.length; i++) {
    const hr = reads[i], m = hr.model, air = hr.airC, t = hr.t;

    // temperature series (always model)
    temps.push({
      t, c: m && typeof m.tempC2m === 'number' ? m.tempC2m : null,
      dew: m && typeof m.dewC === 'number' ? m.dewC : null,
      feels: m && typeof m.feelsC === 'number' ? m.feelsC : null,
      fzlFtAgl: m && typeof m.freezingLevelM === 'number' && elevationM != null ? Math.round((m.freezingLevelM - elevationM) * 3.28084) : null,
    });

    // Sky
    if (hr.cat == null) {
      sky.push(hr.inTaf ? null : { tone: 'u', label: '—', detail: 'no model visibility', dashed: true, src: 'model' });
    } else if (hr.inTaf) {
      sky.push({ tone: catTone(hr.cat), label: hr.cat, detail: `${hr.cat} ceiling/visibility (TAF)`, dashed: hr.catDashed, src: 'taf', cat: hr.cat });
    } else {
      const lbl = hr.cat === 'VFR' || hr.cat === 'MVFR' ? 'vis ok' : `${hr.cat} vis`;
      sky.push({ tone: catTone(hr.cat), label: lbl, detail: 'by model visibility (ceiling not modelled)', dashed: true, src: 'model', cat: hr.cat });
    }

    // Precip
    if (isPrecip(hr.wxKey)) {
      const amber = WX_RANK[hr.wxKey] >= WX_RANK.snow || hr.wxKey === 'heavyrain' || hr.wxKey === 'pellets' || hr.wxKey === 'hail';
      const mm = m && typeof m.precipMm === 'number' && m.precipMm > 0 ? ` · ${m.precipMm} mm/h` : '';
      precip.push({ tone: amber ? 'a' : 'i', label: WX_CHIP[hr.wxKey], detail: `${WX_NAME[hr.wxKey]}${hr.wxSrc === 'taf' ? ' (TAF)' : ' (model)'}${mm}`, dashed: !hr.inTaf || hr.wxDashed, src: hr.inTaf ? (hr.wxDashed ? 'mixed' : 'taf') : 'model' });
    } else precip.push(null);

    // Ground ice
    deice.push(deiceCell(hr, m, air));

    // Runway
    runway.push(runwayCell(hr, m, air, reads, i));

    // Icing aloft
    icing.push(icingCell(hr, groupFor(t), elevationM, startMs, t));

    // Ramp / crew
    ramp.push(rampCell(hr, m, air));
  }

  // Crosswind depends on whether the runway is contaminated that hour.
  for (let i = 0; i < reads.length; i++) {
    const contaminated = !!runway[i] && (runway[i].tone === 'a' || runway[i].tone === 'r');
    xwind.push(noHeadings ? null : xwindCell(reads[i], runways, contaminated));
  }

  const lanes = [
    laneFromCells('sky', sky, hoursArr),
    laneFromCells('precip', precip, hoursArr),
    laneFromCells('deice', deice, hoursArr),
    laneFromCells('runway', runway, hoursArr),
    laneFromCells('icing', icing, hoursArr),
    laneFromCells('xwind', xwind, hoursArr, noHeadings ? 'no runway headings' : null),
    laneFromCells('ramp', ramp, hoursArr),
  ];

  // temperature summary + 0 °C crossings
  const tvals = temps.map((x) => x.c).filter((v) => v != null);
  const crossings = [];
  for (let i = 1; i < temps.length; i++) {
    const a = temps[i - 1].c, b = temps[i].c;
    if (a == null || b == null) continue;
    if (a > 0 && b <= 0) crossings.push({ t: temps[i].t, dir: 'down' });
    else if (a <= 0 && b > 0) crossings.push({ t: temps[i].t, dir: 'up' });
  }
  const temp = { minC: tvals.length ? Math.min(...tvals) : null, maxC: tvals.length ? Math.max(...tvals) : null, crossings };

  // light shading
  const light = buildLight(hoursArr, lat, lon);

  const windows = windowsFromLanes(lanes, startMs);
  return {
    live: true, startMs, hours: horizonH, tafEndMs, light, lanes, temps, temp, windows,
    summary: summarize(windows, horizonH, { taf: !!(taf && taf.length), model: !!(hours && hours.length) }),
    reason: null,
  };
}

// ---- individual lane cells -------------------------------------------------
function deiceCell(hr, m, air) {
  const k = hr.wxKey, src = hr.inTaf ? (hr.wxDashed ? 'mixed' : 'taf') : 'model', dashed = !hr.inTaf || hr.wxDashed;
  if (k === 'fzra' || k === 'fzdz') {
    let d = 'holdover times are short in freezing precipitation';
    if (hr.wxSrc === 'taf' && air != null && air > 2) d += ' — the TAF and the model disagree, plan on the TAF';
    return { tone: 'a', label: 'DE/ANTI-ICE', detail: d, dashed, src };
  }
  if ((k === 'snow' || k === 'pellets') && air != null && air <= 2) return { tone: 'a', label: 'DE-ICE', detail: 'frozen contaminant — de-ice before taxi', dashed, src };
  if (k === 'fzfog' || (k === 'fog' && air != null && air <= 0)) return { tone: 'a', label: 'FZFG', detail: 'freezing fog — frost/rime accretion', dashed, src };
  if ((k === 'rain' || k === 'drizzle' || k === 'showers') && air != null && air <= 0) return { tone: 'a', label: 'GLAZE', detail: 'rain on cold-soaked surfaces — glaze ice', dashed, src };
  if ((k === 'rain' || k === 'drizzle' || k === 'showers') && air != null && air <= 2) return { tone: 'i', label: 'near 0°', detail: 'rain near freezing — watch cold-soaked surfaces', dashed, src };
  if ((k === 'none' || k === 'fog') && air != null && air <= 0 && m && typeof m.dewC === 'number' && air - m.dewC <= 2) return { tone: 'i', label: 'FROST', detail: 'radiative frost likely (air near dew point, ≤ 0 °C)', dashed: true, src: 'model' };
  return null;
}

function runwayCell(hr, m, air, reads, i) {
  const k = hr.wxKey, src = hr.inTaf ? (hr.wxDashed ? 'mixed' : 'taf') : 'model', dashed = !hr.inTaf || hr.wxDashed;
  if (k === 'fzra' || k === 'fzdz') return { tone: 'a', label: 'ICE', detail: 'ice on the runway, braking poor', dashed, src };
  if (k === 'pellets') return { tone: 'a', label: 'PL', detail: 'ice pellets on the surface', dashed, src };
  if (k === 'snow' && air != null && air <= 2) { const cm = m && typeof m.snowCm === 'number' && m.snowCm > 0 ? ` · ${m.snowCm} cm/h` : ''; return { tone: 'a', label: 'SNOW', detail: `snow accumulating${cm}`, dashed, src }; }
  if ((k === 'heavyrain' || k === 'thunder' || (m && typeof m.precipMm === 'number' && m.precipMm >= 4)) && air != null && air > 0) return { tone: 'a', label: 'WATER', detail: 'standing water — hydroplaning risk', dashed, src: m && m.precipMm >= 4 && !isPrecip(k) ? 'model' : src };
  // Refreeze: nothing falling, air ≤ 0 now, and in the last 12 h it was > 0 °C with rain/≥0.2 mm.
  if ((k === 'none' || k === 'fog') && air != null && air <= 0) {
    for (let j = Math.max(0, i - 12); j < i; j++) {
      const pm = reads[j].model;
      if (!pm || typeof pm.tempC2m !== 'number' || pm.tempC2m <= 0) continue;
      const wet = (typeof pm.precipMm === 'number' && pm.precipMm >= 0.2) || ['rain', 'showers', 'drizzle', 'heavyrain'].includes(wxFromWmo(pm.weatherCode));
      if (wet) return { tone: 'a', label: 'REFREEZE', detail: 'wet surface now ≤ 0 °C — black ice risk', dashed: true, src: 'model' };
    }
  }
  return null;
}

function icingCell(hr, group, elevationM, startMs, t) {
  if (group) {
    const tone = group.intensity === 'moderate' || group.intensity === 'severe' ? 'a' : 'i';
    const label = group.intensity === 'severe' ? 'SEV ICE' : group.intensity === 'moderate' ? 'MOD ICE' : 'LGT ICE';
    const band = `${group.baseFtAgl.toLocaleString()}–${group.topFtAgl != null ? group.topFtAgl.toLocaleString() + ' ft AGL' : 'top unknown'}`;
    return { tone, label, detail: `${group.intensity} ${group.type || 'icing'} ${band} (TAF group ${group.code})`, dashed: /TEMPO|PROB/.test(group.change || ''), src: 'taf' };
  }
  const m = hr.model;
  if (!m || !Array.isArray(m.levels) || elevationM == null) return null;
  let lo = Infinity, hi = -Infinity, likely = false, possible = false;
  for (const lv of m.levels) {
    if (typeof lv.heightM !== 'number' || typeof lv.tempC !== 'number' || typeof lv.rh !== 'number') continue;
    const aglFt = (lv.heightM - elevationM) * 3.28084;
    if (aglFt < 0 || aglFt > 10000) continue;
    if (lv.tempC > 0 || lv.tempC < -20) continue;
    if (lv.rh >= 85) { possible = true; lo = Math.min(lo, aglFt); hi = Math.max(hi, aglFt); if (lv.rh >= 95 && lv.tempC >= -15) likely = true; }
  }
  if (!possible) return null;
  const amber = likely && (t - startMs) <= 12 * HOUR;
  return {
    tone: amber ? 'a' : 'i', label: likely ? 'ICE likely' : 'ICE poss',
    detail: `conducive layer ${Math.round(lo).toLocaleString()}–${Math.round(hi).toLocaleString()} ft AGL (model, planning-grade — conducive, not reported)`,
    dashed: true, src: 'model',
  };
}

function xwindCell(hr, runways, contaminated) {
  const be = bestEnd(runways, hr.wind);
  if (!be) return null;
  const cross = be.cross, gc = be.gustCross, kt = hr.wind.kt || 0, gust = hr.wind.gust != null ? hr.wind.gust : null;
  if (cross < 10 && gc < 15) return null; // light — skip
  let tone = null;
  if (cross >= 30 || gc >= 35) tone = 'r';
  else if (cross >= 20 || gc >= 25) tone = 'a';
  else if (contaminated && (cross >= 15 || gc >= 20)) tone = 'a';
  if (!tone) return null;
  const label = `${Math.round(kt)}${gust != null ? 'G' + Math.round(gust) : ''} R${be.ident}`;
  const tail = be.head < 0 ? ' · TAILWIND' : '';
  const extra = contaminated && tone === 'a' && cross < 20 && gc < 25 ? ' — usable crosswind is lower on a contaminated runway' : '';
  return { tone, label, short: `R${be.ident}`, detail: `crosswind ${Math.round(cross)} kt${gust != null ? ` (gust ${Math.round(gc)})` : ''} on R${be.ident}${tail}${extra}`, dashed: hr.windSrc !== 'taf' || hr.overlay, src: hr.windSrc === 'taf' ? 'taf' : 'model' };
}

function rampCell(hr, m, air) {
  const kt = hr.wind ? (hr.wind.kt || 0) : 0, gust = hr.wind && hr.wind.gust != null ? hr.wind.gust : kt;
  const src = hr.windSrc === 'taf' ? 'taf' : 'model', dashed = hr.windSrc !== 'taf' || hr.overlay;
  if (hr.wxKey === 'thunder' || hr.wxKey === 'hail') return { tone: 'a', label: 'LIGHTNING', detail: 'thunderstorm — ramp / refuel holds', dashed: !hr.inTaf || hr.wxDashed, src: hr.inTaf ? 'taf' : 'model' };
  if (gust >= 35) return { tone: 'a', label: `G${Math.round(gust)}`, detail: `gusts ${Math.round(gust)} kt — door, stair, stand, refuel limits`, dashed, src };
  if (air != null) {
    const wc = windChillC(air, kt);
    if (wc <= -27) return { tone: 'a', label: `WC ${Math.round(wc)}°`, detail: `wind chill ${Math.round(wc)} °C — frostbite risk in ~30 min`, dashed: true, src: 'model' };
    if (wc <= -18) return { tone: 'i', label: `WC ${Math.round(wc)}°`, detail: `wind chill ${Math.round(wc)} °C — cold-weather ramp limits`, dashed: true, src: 'model' };
  }
  if (m && typeof m.feelsC === 'number') {
    if (m.feelsC >= 40) return { tone: 'a', label: 'HEAT', detail: `feels-like ${Math.round(m.feelsC)} °C — heat stress on the ramp`, dashed: true, src: 'model' };
    if (m.feelsC >= 32) return { tone: 'i', label: 'HEAT', detail: `feels-like ${Math.round(m.feelsC)} °C — monitor heat stress`, dashed: true, src: 'model' };
  }
  return null;
}

// ---- light shading ---------------------------------------------------------
function buildLight(hoursArr, lat, lon) {
  const stateAt = (ms) => {
    const a = sunAltitude(ms + HOUR / 2, lat, lon);
    return a > -0.833 ? 'day' : a > -6 ? 'civil' : a > -12 ? 'nautical' : 'night';
  };
  const out = [];
  for (const t of hoursArr) {
    const s = stateAt(t), last = out[out.length - 1];
    if (last && last.state === s) last.toMs = t + HOUR;
    else out.push({ fromMs: t, toMs: t + HOUR, state: s });
  }
  return out;
}

// ---- limiting windows (spec §5) --------------------------------------------
/** Merge amber/red segments across lanes into limiting windows. */
export function windowsFromLanes(lanes, startMs) {
  const hits = [];
  for (const lane of lanes) for (const s of lane.segs) if (s.tone === 'a' || s.tone === 'r') hits.push({ lane: lane.key, ...s });
  hits.sort((a, b) => a.fromMs - b.fromMs);
  const merged = [];
  for (const h of hits) {
    const w = merged[merged.length - 1];
    if (w && h.fromMs <= w.toMs) { w.toMs = Math.max(w.toMs, h.toMs); w.hits.push(h); }
    else merged.push({ fromMs: h.fromMs, toMs: h.toMs, hits: [h] });
  }
  return merged.map((w) => finalizeWindow(w));
}

function finalizeWindow(w) {
  const byLane = new Map();
  for (const h of w.hits) {
    const cur = byLane.get(h.lane);
    const better = !cur || (h.tone === 'r' && cur.tone !== 'r') ||
      (h.tone === cur.tone && (labelSeverity(h.label) > labelSeverity(cur.label) ||
        (labelSeverity(h.label) === labelSeverity(cur.label) && (h.toMs - h.fromMs) > (cur.toMs - cur.fromMs))));
    if (better) byLane.set(h.lane, h);
  }
  let factors = FACTOR_ORDER.filter((k) => byLane.has(k)).map((k) => {
    const h = byLane.get(k);
    // Coalesce the lane's amber/red spans (adjacent hours with different labels
    // still read as one range) and annotate only when they don't fill the window.
    const raw = w.hits.filter((x) => x.lane === k).sort((a, b) => a.fromMs - b.fromMs);
    const spans = [];
    for (const s of raw) { const last = spans[spans.length - 1]; if (last && s.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, s.toMs); else spans.push({ fromMs: s.fromMs, toMs: s.toMs }); }
    const coversWhole = spans.length === 1 && spans[0].fromMs <= w.fromMs && spans[0].toMs >= w.toMs;
    const spanTxt = coversWhole ? '' : ` [${spans.map((s) => rangeLabel(s.fromMs, s.toMs)).join(', ')}]`;
    return { lane: k, label: h.label, tone: h.tone, detail: h.detail + spanTxt };
  });
  if (factors.length > 1) factors = factors.filter((f) => f.lane !== 'precip'); // precip repeats others
  const tone = factors.some((f) => f.tone === 'r') ? 'r' : 'a';
  const text = `${rangeLabel(w.fromMs, w.toMs)} — ${factors.map((f) => `${LANE_TITLE[f.lane]}: ${f.detail}`).join('; ')}`;
  return { fromMs: w.fromMs, toMs: w.toMs, tone, factors: factors.map((f) => ({ lane: f.lane, label: f.label, detail: f.detail })), text };
}

function summarize(windows, horizonH, checked) {
  if (!windows.length) {
    const what = [checked.taf ? 'TAF' : null, checked.model ? 'model' : null].filter(Boolean).join(' + ') || 'no sources';
    return `Next ${horizonH} h: no limiting window — checked ${what}.`;
  }
  const first = windows[0];
  const labels = [];
  for (const w of windows) for (const f of w.factors) if (!labels.includes(f.label)) labels.push(f.label);
  return `Next ${horizonH} h: ${windows.length} limiting window${windows.length > 1 ? 's' : ''} — first ${rangeLabel(first.fromMs, first.toMs)}: ${labels.slice(0, 3).join(', ')}`;
}

// ---- NOTAM fold (spec §6) --------------------------------------------------
/**
 * Fold NOTAM closure windows into the timeline as a separate pure step.
 * @returns {{ lane, windows }} the NOTAM lane and windows recomputed over all lanes.
 */
export function windowsWithNotams(timeline, closures) {
  const segs = [];
  for (const c of (closures || [])) {
    if (!Number.isFinite(c.fromMs) || !Number.isFinite(c.toMs) || c.toMs <= c.fromMs) continue;
    if (c.indeterminate) { segs.push({ fromMs: c.fromMs, toMs: c.toMs, tone: 'u', label: 'SCHED', short: 'SCHED', detail: `${c.label}: published schedule could not be read — verify`, dashed: true, src: 'notam' }); continue; }
    const short = c.kind === 'closure' ? 'CLSD' : c.kind === 'unserviceable' ? 'U/S' : 'LTD';
    segs.push({ fromMs: c.fromMs, toMs: c.toMs, tone: c.kind === 'limited' ? 'i' : 'a', label: `${c.label} ${short}`, short, detail: c.text || `${c.label} ${c.kind}`, dashed: false, src: 'notam' });
  }
  const lane = { key: 'notam', title: LANE_TITLE.notam, segs, unknown: null };
  const windows = windowsFromLanes([...(timeline.lanes || []), lane], timeline.startMs);
  return { lane, windows };
}

// ---- scrub readout + change points (spec §7) -------------------------------
const READOUT_ORDER = ['sky', 'precip', 'temp', 'deice', 'runway', 'icing', 'xwind', 'ramp', 'notam'];
const segAt = (lane, ms) => (lane ? lane.segs.find((s) => ms >= s.fromMs && ms < s.toMs) || null : null);

/**
 * Read every lane at a Zulu instant for the scrub readout.
 * @returns {object|null} null when the timeline is not live; ms clamps into the horizon.
 */
export function sliceAt(timeline, extraLanes, windows, ms) {
  if (!timeline || !timeline.live) return null;
  const endMs = timeline.startMs + timeline.hours * HOUR;
  const at = Math.max(timeline.startMs, Math.min(endMs - 1, ms));
  const laneByKey = new Map((timeline.lanes || []).concat(extraLanes || []).map((l) => [l.key, l]));
  const src = timeline.tafEndMs != null && at <= timeline.tafEndMs ? 'taf' : 'model';

  const rows = READOUT_ORDER.map((key) => {
    if (key === 'temp') {
      const tp = (timeline.temps || []).find((x) => at >= x.t && at < x.t + HOUR) || null;
      if (!tp || tp.c == null) return { key, title: 'Temp', tone: 'u', label: '', text: 'UNKNOWN — no model temperature' };
      const fzl = tp.fzlFtAgl != null ? ` · 0 °C at ${tp.fzlFtAgl.toLocaleString()} ft AGL (model)` : '';
      return { key, title: 'Temp', tone: tp.c <= 0 ? 'i' : 'n', label: `${Math.round(tp.c)} °C`, text: `${Math.round(tp.c)} °C · dew ${tp.dew != null ? Math.round(tp.dew) : '—'} · feels ${tp.feels != null ? Math.round(tp.feels) : '—'}${fzl}` };
    }
    const lane = laneByKey.get(key);
    const title = LANE_TITLE[key];
    if (!lane) return { key, title, tone: 'n', label: '', text: key === 'notam' ? 'no closure in effect' : 'nothing limiting' };
    const s = segAt(lane, at);
    if (s && s.tone === 'u') return { key, title, tone: 'u', label: s.label, text: `UNKNOWN — ${s.detail}` };
    if (!s) {
      if (lane.unknown) return { key, title, tone: 'u', label: '', text: `UNKNOWN — ${lane.unknown}` };
      return { key, title, tone: 'n', label: '', text: key === 'notam' ? 'no closure in effect' : 'nothing limiting' };
    }
    return { key, title, tone: s.tone, label: s.label, text: s.detail };
  });

  const wins = windows || timeline.windows || [];
  let window = null;
  for (let i = 0; i < wins.length; i++) if (at >= wins[i].fromMs && at < wins[i].toMs) { window = { index: i, tone: wins[i].tone, toMs: wins[i].toMs, leftMs: wins[i].toMs - at }; break; }
  let next = null;
  for (let i = 0; i < wins.length; i++) if (wins[i].fromMs > at) { next = { index: i, fromMs: wins[i].fromMs, inMs: wins[i].fromMs - at }; break; }

  return { ms: at, stamp: stampShort(at), src, rows, window, next };
}

/** Every segment edge (any lane) + every 0 °C crossing, sorted, inside the horizon. */
export function changePoints(timeline, extraLanes) {
  if (!timeline) return [];
  const endMs = timeline.startMs + timeline.hours * HOUR;
  const set = new Set();
  const add = (ms) => { if (ms > timeline.startMs && ms < endMs) set.add(ms); };
  for (const lane of (timeline.lanes || []).concat(extraLanes || [])) for (const s of lane.segs) { add(s.fromMs); add(s.toMs); }
  for (const c of (timeline.temp?.crossings || [])) add(c.t);
  return [...set].sort((a, b) => a - b);
}
