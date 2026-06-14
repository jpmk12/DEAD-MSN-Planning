// Pacific Organized Track System (PACOTS) from DAIP — the same DoD service the
// app uses for NOTAMs, queried with type=PACIFIC_TRACKS at /result. DAIP presents
// a DoD PKI cert, so this needs the DoD CA bundle (see daip.js); without it we
// report UNAVAILABLE rather than fabricate.
//
// The /result body is DAIP JSON: group[].notams[].list[].rawtext, where each
// NOTAM's E) field encodes tracks in one of two real forms:
//   • Oakland (KZAK):  (TDM TRK J <serial> <start> <end> ALCOA 36N140W 34N150W
//                       29N180E ... CANAI RTS/... RMK/...)
//   • Fukuoka (RJJJ):  TRACK 1. FLEX ROUTE : KALNA 41N160E ... 49N140W PRETY
// Pacific coordinates are DDN/DDD{E|W} and DO cross the date line (180E/W).

import { dodCaLoaded, daipQueryRaw, pacotsPayload, DAIP_RESULT_ENDPOINT } from './daip.js';

/** Decode a Pacific coordinate token "36N140W" / "29N180E" (DDMM allowed) to
 *  { label, lat, lon }, or a named fix (lat/lon null), or null. East longitudes
 *  are positive, west negative; south latitudes negative. */
export function decodePacPoint(tok) {
  const t = String(tok || '').toUpperCase().trim();
  const m = t.match(/^(\d{2,4})([NS])(\d{2,5})([EW])$/);
  if (m) return { label: t, lat: pdeg(m[1]) * (m[2] === 'S' ? -1 : 1), lon: pdeg(m[3]) * (m[4] === 'W' ? -1 : 1) };
  if (/^[A-Z]{2,5}\d?$/.test(t)) return { label: t, lat: null, lon: null }; // named fix (ALCOA, PRETY) — airways like OTR11/Y891 excluded
  return null;
}
// Degrees from a coordinate string: 4–5 digits = DDMM, else whole degrees.
function pdeg(s) { const n = s.length; return n >= 4 ? Number(s.slice(0, n - 2)) + Number(s.slice(n - 2)) / 60 : Number(s); }

/** NOTAM Zulu time YYMMDDHHMM → ISO, or null. */
function pacIso(s) {
  if (!s || !/^\d{10}$/.test(s)) return null;
  const d = new Date(`20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}T${s.slice(6, 8)}:${s.slice(8, 10)}:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildPacTrack(id, bodyStr, fir, direction, validFrom, validTo, notamId) {
  const pointsRaw = [], points = [];
  for (const tok of String(bodyStr).split(/\s+/)) {
    const p = decodePacPoint(tok);
    if (!p) continue; // skip airways/airports inside captured bodies
    pointsRaw.push(p.label);
    if (p.lat != null) points.push([p.lat, p.lon]);
  }
  if (points.length < 2) return null;
  return { id: String(id), fir, direction, validFrom, validTo, notamId, pointsRaw, points, eastLevels: [], westLevels: [], geometry: { kind: 'line', points } };
}

const natIdNum = (id) => { const n = Number(id); return Number.isFinite(n) ? n : NaN; };

/** Parse a DAIP PACIFIC_TRACKS response into tracks. Handles both the Oakland
 *  TDM-TRK and Fukuoka FLEX-ROUTE encodings; dedupes by FIR+id+direction keeping
 *  the latest-valid NOTAM (today supersedes yesterday). */
export function parsePacots(body) {
  let json = null;
  try { json = typeof body === 'string' ? JSON.parse(body) : body; } catch { return []; }
  if (!json) return [];
  const raw = [];
  for (const g of json.group ?? []) {
    const fir = g.name || (g.notams?.[0]?.code) || '';
    for (const n of g.notams ?? []) {
      for (const item of n.list ?? []) {
        const flat = String(item.rawtext || item.text || '').replace(/\s+/g, ' ').trim();
        if (!flat) continue;
        const direction = /EASTBOUND/i.test(flat) ? 'EAST' : /WESTBOUND/i.test(flat) ? 'WEST' : null;
        const bcFrom = pacIso((flat.match(/B\)\s*(\d{10})/) || [])[1]);
        const bcTo = pacIso((flat.match(/C\)\s*(\d{10})/) || [])[1]);
        // Oakland: (TDM TRK <id> <serial> <start> <end> <waypoints> RTS/...|RMK/...|)
        for (const m of flat.matchAll(/TDM\s+TRK\s+([A-Z0-9]+)\s+\d+\s+(\d{10})\s+(\d{10})\s+(.+?)\s+(?:RTS\/|RMK\/|\))/g)) {
          const t = buildPacTrack(m[1], m[4], fir, direction, pacIso(m[2]) || bcFrom, pacIso(m[3]) || bcTo, item.idshow);
          if (t) raw.push(t);
        }
        // Fukuoka: TRACK <n>. FLEX ROUTE : <waypoints> (until the next ROUTE/RMK/TRACK)
        for (const m of flat.matchAll(/TRACK\s+(\d+)\.?\s*FLEX\s+ROUTE\s*:\s*(.+?)(?=\s+(?:[A-Z]+(?:\/[A-Z0-9]+)?\s+ROUTE\s*:|RMK\s*:|TRACK\s+\d+\.|ATM\s+CENTER|$))/g)) {
          const t = buildPacTrack(m[1], m[2], fir, direction, bcFrom, bcTo, item.idshow);
          if (t) raw.push(t);
        }
      }
    }
  }
  const byKey = new Map();
  for (const t of raw) {
    const k = `${t.fir}|${t.id}|${t.direction}`;
    const prev = byKey.get(k);
    if (!prev || (t.validFrom || '') > (prev.validFrom || '')) byKey.set(k, t);
  }
  return [...byKey.values()].sort((a, b) =>
    (a.fir === b.fir ? (natIdNum(a.id) - natIdNum(b.id)) || String(a.id).localeCompare(String(b.id)) : a.fir.localeCompare(b.fir)));
}

/** @returns {Promise<{tracks:any[], live:boolean, source:string}>} */
export async function fetchPacots(offline) {
  if (offline || !dodCaLoaded()) return { tracks: [], live: false, source: dodCaLoaded() ? 'offline' : 'no-dod-ca' };
  try {
    const r = await daipQueryRaw(pacotsPayload(), 10000, DAIP_RESULT_ENDPOINT);
    if (r.status === 200) return { tracks: parsePacots(r.body), live: true, source: 'DAIP' };
    return { tracks: [], live: false, source: `DAIP ${r.status}` };
  } catch {
    return { tracks: [], live: false, source: 'DAIP error' };
  }
}
