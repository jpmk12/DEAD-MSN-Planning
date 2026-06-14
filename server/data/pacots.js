// Pacific Organized Track System (PACOTS) from DAIP — the same DoD service the
// app already uses for NOTAMs, queried with type=PACIFIC_TRACKS at /result. DAIP
// presents a DoD PKI cert, so this needs the DoD CA bundle (see daip.js); without
// it we report UNAVAILABLE rather than fabricate.
//
// The exact /result body shape isn't documented here, so parsing is defensive:
// reuse the NOTAM flattener to pull text blobs, then extract each track's letter
// + waypoints with the shared NAT decoder. Also handles a direct {tracks:[...]}.

import { dodCaLoaded, daipQueryRaw, pacotsPayload, parseDaipNotams, DAIP_RESULT_ENDPOINT } from './daip.js';
import { decodeNatPoint, parseNatJson } from './nattracks.js';

/** Extract PACOTS tracks from free text (a NOTAM/track blob). Lines/segments that
 *  begin with a track id (letter or digit) followed by decodable waypoints become
 *  tracks; waypoints use the shared NAT decoder (lat/lon shorthand + named fixes). */
export function parsePacotsText(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const toks = line.trim().split(/\s+/);
    if (toks.length < 3) continue;
    // PACOTS track ids are typically a number (1..N) or letter; require the next
    // token to decode as a waypoint to avoid matching prose.
    if (!/^[A-Z0-9]{1,2}$/.test(toks[0]) || !decodeNatPoint(toks[1])) continue;
    const raw = [], pts = [];
    for (let i = 1; i < toks.length; i++) {
      const p = decodeNatPoint(toks[i]);
      if (!p) break;
      raw.push(p.label);
      if (p.lat != null) pts.push([p.lat, p.lon]);
    }
    if (raw.length >= 2) out.push({ id: toks[0], pointsRaw: raw, points: pts, eastLevels: [], westLevels: [], geometry: pts.length >= 2 ? { kind: 'line', points: pts } : null });
  }
  return out;
}

/** Parse a DAIP PACIFIC_TRACKS response body into tracks (best-effort). */
export function parsePacots(body) {
  let json = null;
  try { json = typeof body === 'string' ? JSON.parse(body) : body; } catch { /* not JSON */ }
  if (json) {
    // 1) Direct tracks array / GeoJSON (reuse the NAT JSON parser).
    const direct = parseNatJson(json);
    if (direct.length) return direct;
    // 2) NOTAM-style body: flatten to text blobs and parse track lines out of them.
    const notams = parseDaipNotams(json);
    const fromNotams = notams.flatMap((n) => parsePacotsText(n.rawText || n.text));
    if (fromNotams.length) return fromNotams;
  }
  return parsePacotsText(String(body || '')); // last resort: scan raw text
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
