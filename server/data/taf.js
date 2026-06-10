// TAF decoder — turns a raw TAF string into plain-English forecast periods.
// Pure and self-contained (no network), so it works offline and is unit-tested.
//
// Handles the common groups: header (station / issuance / validity), FM / BECMG
// / TEMPO / PROB period boundaries, wind, visibility, weather, and clouds.
// Unknown tokens are passed through verbatim so nothing is silently dropped.

const LAYER = { FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast' };
const INTENSITY = { '-': 'light', '+': 'heavy' };
const DESCRIPTOR = { MI: 'shallow', PR: 'partial', BC: 'patches of', DR: 'low drifting', BL: 'blowing', SH: 'showers', TS: 'thunderstorm', FZ: 'freezing' };
const PHENOM = {
  DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals', PL: 'ice pellets',
  GR: 'hail', GS: 'small hail', UP: 'unknown precip', BR: 'mist', FG: 'fog', FU: 'smoke', VA: 'volcanic ash',
  DU: 'dust', SA: 'sand', HZ: 'haze', PY: 'spray', PO: 'dust whirls', SQ: 'squalls', FC: 'funnel cloud',
  SS: 'sandstorm', DS: 'duststorm',
};

const pad = (n) => String(n).padStart(2, '0');
/** "DDHHMM" or "DDHH" -> "DDth HH:MMZ". */
function timeText(ddhh) {
  if (!ddhh) return '';
  const dd = ddhh.slice(0, 2);
  const hh = ddhh.slice(2, 4);
  const mm = ddhh.length >= 6 ? ddhh.slice(4, 6) : '00';
  return `${Number(dd)}th ${hh}:${mm}Z`;
}

export function decodeWind(tok) {
  const m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(tok);
  if (!m) return null;
  const [, dir, spd, gust] = m;
  if (dir === '000' && spd === '00') return 'wind calm';
  const dirText = dir === 'VRB' ? 'variable' : `${dir}°`;
  const unit = m[4] === 'MPS' ? 'm/s' : 'kt';
  return `wind ${dirText} at ${Number(spd)} ${unit}${gust ? `, gusting ${Number(gust)} ${unit}` : ''}`;
}

export function decodeVisibility(tok) {
  if (tok === 'CAVOK') return 'ceiling and visibility OK';
  if (tok === 'P6SM') return 'visibility better than 6 SM';
  let m = /^(\d{1,2})SM$/.exec(tok);
  if (m) return `visibility ${Number(m[1])} SM`;
  m = /^(\d)\/(\d)SM$/.exec(tok);
  if (m) return `visibility ${m[1]}/${m[2]} SM`;
  m = /^(\d{4})$/.exec(tok);
  if (m) return Number(m[1]) >= 9999 ? 'visibility 10 km or more' : `visibility ${Number(m[1])} m`;
  return null;
}

export function decodeCloud(tok) {
  if (['SKC', 'CLR', 'NSC', 'NCD'].includes(tok)) return 'sky clear';
  let m = /^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/.exec(tok);
  if (m) {
    const ft = Number(m[2]) * 100;
    const extra = m[3] === 'CB' ? ' (cumulonimbus)' : m[3] === 'TCU' ? ' (towering cumulus)' : '';
    return `${LAYER[m[1]]} at ${ft.toLocaleString()} ft${extra}`;
  }
  m = /^VV(\d{3})$/.exec(tok);
  if (m) return `vertical visibility ${(Number(m[1]) * 100).toLocaleString()} ft`;
  return null;
}

export function decodeWeather(tok) {
  let s = tok;
  let out = '';
  if (s.startsWith('+')) { out += 'heavy '; s = s.slice(1); }
  else if (s.startsWith('-')) { out += 'light '; s = s.slice(1); }
  if (s.startsWith('VC')) { out += 'in the vicinity '; s = s.slice(2); }
  const parts = [];
  for (let i = 0; i < s.length; i += 2) {
    const code = s.slice(i, i + 2);
    if (DESCRIPTOR[code]) parts.push(DESCRIPTOR[code]);
    else if (PHENOM[code]) parts.push(PHENOM[code]);
    else return null; // not a weather token
  }
  if (parts.length === 0) return null;
  return (out + parts.join(' ')).trim();
}

function classify(tok) {
  return decodeWind(tok) || decodeVisibility(tok) || decodeWeather(tok) || decodeCloud(tok);
}

// ---- structured value parsers (for machine-readable, time-aware forecasts) ---

/** Parse a wind token to numbers: { dirTrue:number|'VRB', speedKt, gustKt|null }. */
export function parseWindTok(tok) {
  const m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(tok);
  if (!m) return null;
  const toKt = (v) => (m[4] === 'MPS' ? Math.round(v * 1.94384) : v);
  return {
    dirTrue: m[1] === 'VRB' ? 'VRB' : Number(m[1]),
    speedKt: toKt(Number(m[2])),
    gustKt: m[3] ? toKt(Number(m[3])) : null,
  };
}

/** Parse a visibility token to statute miles (CAVOK/P6SM → 99 = unlimited). */
export function parseVisSm(tok) {
  if (tok === 'CAVOK' || tok === 'P6SM') return 99;
  let m = /^(\d{1,2})SM$/.exec(tok);
  if (m) return Number(m[1]);
  m = /^(\d)\/(\d)SM$/.exec(tok);
  if (m) return Number(m[1]) / Number(m[2]);
  m = /^(\d{4})$/.exec(tok); // metres
  if (m) return Number(m[1]) >= 9999 ? 99 : Number(m[1]) / 1609.34;
  return null;
}

/** Ceiling (lowest BKN/OVC or VV) in ft AGL from a cloud token, else null. */
export function parseCeilingFt(tok) {
  let m = /^(BKN|OVC)(\d{3})(?:CB|TCU)?$/.exec(tok);
  if (m) return Number(m[2]) * 100;
  m = /^VV(\d{3})$/.exec(tok);
  if (m) return Number(m[1]) * 100;
  return null;
}

/** Standard ceiling/visibility flight category. */
export function flightCategory(ceilingFt, visSm) {
  const c = ceilingFt == null ? Infinity : ceilingFt;
  const v = visSm == null ? Infinity : visSm;
  if (c < 500 || v < 1) return 'LIFR';
  if (c < 1000 || v < 3) return 'IFR';
  if (c <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}

// ---- TAF validity time resolution (DDHH[MM] → UTC) ------------------------

/** Resolve a TAF "DDHH" or "DDHHMM" group to a UTC ms instant near `anchorMs`,
 *  disambiguating the day across month boundaries (TAFs span <~36 h). Handles
 *  the "24" hour convention (= 00Z the next day). */
export function tafTimeMs(ddhh, anchorMs) {
  if (!ddhh || ddhh.length < 4) return NaN;
  const dd = Number(ddhh.slice(0, 2));
  let hh = Number(ddhh.slice(2, 4));
  const mm = ddhh.length >= 6 ? Number(ddhh.slice(4, 6)) : 0;
  let addDay = 0;
  if (hh === 24) { hh = 0; addDay = 1; }
  const ref = new Date(anchorMs);
  // Try the same month as the anchor, then neighbours; pick the candidate
  // closest to the anchor (TAF times are always within a couple weeks of it).
  let best = NaN, bestDist = Infinity;
  for (const dM of [-1, 0, 1]) {
    const cand = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + dM, dd + addDay, hh, mm);
    const dist = Math.abs(cand - anchorMs);
    if (dist < bestDist) { bestDist = dist; best = cand; }
  }
  return best;
}

/** Decode a raw TAF string into a structured, human-readable object. */
export function decodeTaf(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tokens = raw.trim().replace(/\s+/g, ' ').split(' ').filter((t) => t && t !== 'TAF' && t !== 'AMD' && t !== 'COR');
  if (tokens.length === 0) return null;

  let i = 0;
  const station = /^[A-Z]{4}$/.test(tokens[0]) ? tokens[i++] : null;
  const issued = /^\d{6}Z$/.test(tokens[i]) ? tokens[i++].slice(0, 6) : null;
  let validFrom = null;
  let validTo = null;
  const vm = /^(\d{4})\/(\d{4})$/.exec(tokens[i]);
  if (vm) { validFrom = vm[1]; validTo = vm[2]; i++; }

  const periods = [];
  const newPeriod = (o) => ({ ...o, items: [], extra: [], wind: undefined, visibilitySm: undefined, ceilingFt: undefined });
  let current = newPeriod({ label: 'Prevailing', kind: 'BASE', when: validFrom ? `${timeText(validFrom)} – ${timeText(validTo)}` : '', from: validFrom, to: validTo });

  // Capture machine-readable values alongside the human text. Lowest BKN/OVC
  // wins for ceiling; last wind/visibility token in the group wins.
  const capture = (tok) => {
    const w = parseWindTok(tok); if (w) { current.wind = w; return; }
    const v = parseVisSm(tok); if (v != null) { current.visibilitySm = v; return; }
    const c = parseCeilingFt(tok); if (c != null) current.ceilingFt = current.ceilingFt == null ? c : Math.min(current.ceilingFt, c);
  };

  const pushCurrent = () => {
    if (current.items.length || current.extra.length) {
      if (current.ceilingFt !== undefined || current.visibilitySm !== undefined) {
        current.flightCategory = flightCategory(current.ceilingFt ?? null, current.visibilitySm ?? null);
      }
      periods.push(current);
    }
  };

  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    let m;
    if ((m = /^FM(\d{6})$/.exec(tok))) {
      pushCurrent();
      current = newPeriod({ label: 'From', kind: 'BASE', when: timeText(m[1]), from: m[1], to: null });
      continue;
    }
    if (tok === 'BECMG' || tok === 'TEMPO') {
      pushCurrent();
      const rng = /^(\d{4})\/(\d{4})$/.exec(tokens[i + 1] || '');
      if (rng) i++;
      current = newPeriod({
        label: tok === 'BECMG' ? 'Becoming' : 'Temporarily',
        kind: tok,
        when: rng ? `${timeText(rng[1])} – ${timeText(rng[2])}` : '',
        from: rng ? rng[1] : null, to: rng ? rng[2] : null,
      });
      continue;
    }
    if ((m = /^PROB(\d{2})$/.exec(tok))) {
      pushCurrent();
      let label = `Probability ${m[1]}%`;
      if (tokens[i + 1] === 'TEMPO') { label += ' (temporarily)'; i++; }
      const rng = /^(\d{4})\/(\d{4})$/.exec(tokens[i + 1] || '');
      if (rng) i++;
      current = newPeriod({ label, kind: 'PROB', prob: Number(m[1]), when: rng ? `${timeText(rng[1])} – ${timeText(rng[2])}` : '', from: rng ? rng[1] : null, to: rng ? rng[2] : null });
      continue;
    }
    // combined fraction visibility, e.g. "1 1/2SM"
    if (/^\d$/.test(tok) && /^\d\/\dSM$/.test(tokens[i + 1] || '')) {
      const frac = tokens[i + 1];
      current.items.push(`visibility ${tok} ${frac.replace('SM', '')} SM`);
      const fm = /^(\d)\/(\d)SM$/.exec(frac);
      current.visibilitySm = Number(tok) + (fm ? Number(fm[1]) / Number(fm[2]) : 0);
      i++;
      continue;
    }
    const decoded = classify(tok);
    if (decoded) { current.items.push(decoded); capture(tok); }
    else current.extra.push(tok); // keep unknown tokens verbatim
  }
  pushCurrent();

  return {
    station,
    issued: issued ? timeText(issued) : null,
    issuedRaw: issued,
    valid: validFrom ? `${timeText(validFrom)} – ${timeText(validTo)}` : null,
    validFrom,
    validTo,
    periods,
    raw,
  };
}

/**
 * Select the forecast conditions a decoded TAF predicts AT a given time.
 * Returns the governing base period (Prevailing / FM / BECMG in effect) plus any
 * active TEMPO/PROB periods as caveats, with machine-readable wind/vis/ceiling/
 * category. Times are anchored around `whenIso` (TAF groups are day+hour only).
 * Returns null when the time is outside the TAF's validity window.
 *
 * @returns {null | { whenIso, withinValidity, base, wind, visibilitySm,
 *                    ceilingFt, flightCategory, caveats }}
 */
export function tafAt(decoded, whenIso) {
  if (!decoded || !Array.isArray(decoded.periods) || !decoded.periods.length) return null;
  const when = Date.parse(whenIso);
  if (!Number.isFinite(when)) return null;

  const fromMs = (p) => tafTimeMs(p.from, when);
  const toMs = (p) => tafTimeMs(p.to, when);

  const validFromMs = decoded.validFrom ? tafTimeMs(decoded.validFrom, when) : null;
  const validToMs = decoded.validTo ? tafTimeMs(decoded.validTo, when) : null;
  const withinValidity = !(Number.isFinite(validFromMs) && when < validFromMs)
    && !(Number.isFinite(validToMs) && when > validToMs);

  // Governing base: the latest BASE/BECMG period that has started by `when`.
  let base = null;
  for (const p of decoded.periods) {
    if (p.kind === 'TEMPO' || p.kind === 'PROB') continue;
    const f = fromMs(p);
    if (!Number.isFinite(f) || f <= when) base = p; else break;
  }
  if (!base) base = decoded.periods.find((p) => p.kind !== 'TEMPO' && p.kind !== 'PROB') || decoded.periods[0];

  // Active temporary/probabilistic caveats overlapping `when`.
  const caveats = decoded.periods.filter((p) => {
    if (p.kind !== 'TEMPO' && p.kind !== 'PROB') return false;
    const f = fromMs(p), t = toMs(p);
    return Number.isFinite(f) && Number.isFinite(t) && when >= f && when <= t;
  }).map((p) => ({ label: p.label, prob: p.prob ?? null, wind: p.wind ?? null, visibilitySm: p.visibilitySm ?? null, ceilingFt: p.ceilingFt ?? null, flightCategory: p.flightCategory ?? null, items: p.items }));

  return {
    whenIso,
    withinValidity,
    base: { label: base.label, when: base.when, wind: base.wind ?? null, visibilitySm: base.visibilitySm ?? null, ceilingFt: base.ceilingFt ?? null, flightCategory: base.flightCategory ?? null },
    wind: base.wind ?? null,
    visibilitySm: base.visibilitySm ?? null,
    ceilingFt: base.ceilingFt ?? null,
    flightCategory: base.flightCategory ?? null,
    caveats,
  };
}
