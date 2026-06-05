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
  let current = { label: 'Prevailing', when: validFrom ? `${timeText(validFrom)} – ${timeText(validTo)}` : '', from: validFrom, to: validTo, items: [], extra: [] };

  const pushCurrent = () => { if (current.items.length || current.extra.length) periods.push(current); };

  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    let m;
    if ((m = /^FM(\d{6})$/.exec(tok))) {
      pushCurrent();
      current = { label: 'From', when: timeText(m[1]), from: m[1], to: null, items: [], extra: [] };
      continue;
    }
    if (tok === 'BECMG' || tok === 'TEMPO') {
      pushCurrent();
      const rng = /^(\d{4})\/(\d{4})$/.exec(tokens[i + 1] || '');
      if (rng) i++;
      current = {
        label: tok === 'BECMG' ? 'Becoming' : 'Temporarily',
        when: rng ? `${timeText(rng[1])} – ${timeText(rng[2])}` : '',
        from: rng ? rng[1] : null, to: rng ? rng[2] : null,
        items: [], extra: [],
      };
      continue;
    }
    if ((m = /^PROB(\d{2})$/.exec(tok))) {
      pushCurrent();
      let label = `Probability ${m[1]}%`;
      if (tokens[i + 1] === 'TEMPO') { label += ' (temporarily)'; i++; }
      const rng = /^(\d{4})\/(\d{4})$/.exec(tokens[i + 1] || '');
      if (rng) i++;
      current = { label, when: rng ? `${timeText(rng[1])} – ${timeText(rng[2])}` : '', from: rng ? rng[1] : null, to: rng ? rng[2] : null, items: [], extra: [] };
      continue;
    }
    // combined fraction visibility, e.g. "1 1/2SM"
    if (/^\d$/.test(tok) && /^\d\/\dSM$/.test(tokens[i + 1] || '')) {
      current.items.push(`visibility ${tok} ${tokens[i + 1].replace('SM', '')} SM`);
      i++;
      continue;
    }
    const decoded = classify(tok);
    if (decoded) current.items.push(decoded);
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
