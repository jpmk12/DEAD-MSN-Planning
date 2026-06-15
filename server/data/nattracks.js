// North Atlantic Organized Track System (NAT-OTS) — the daily Gander/Shanwick
// track message (TMI). Parses the track letters, their waypoint chains (named
// fixes + lat/lon shorthand), flight-level bands and direction, into geometry
// the Global tab can list/overlay.
//
// Source varies and may need auth, so the URL is env-configured (NAT_TRACKS_URL);
// offline/unset falls back to a bundled sample. Parsing is defensive — a line we
// don't recognize is skipped (UNAVAILABLE, never invented). PACOTS has no clean
// public feed and is intentionally not attempted here.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FIXTURE_URL = new URL('../../data/fixtures/nat-tracks-sample.txt', import.meta.url);
// FAA NAS NOTAM/AIM NAT feed (public host). Overridable via NAT_TRACKS_URL.
const DEFAULT_NAT_URL = 'https://nms.aim.faa.gov/nat';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Best-effort parse of a NAT JSON payload into our track shape. Handles a few
 *  plausible shapes (array of tracks, or a GeoJSON FeatureCollection); falls back
 *  to the text TMI parser on the raw string if nothing matches. Defensive — an
 *  unrecognized shape yields [] (UNAVAILABLE), never invented tracks. */
export function parseNatJson(json) {
  const decodeRoute = (str) => {
    const pts = [], raw = [];
    for (const tok of String(str).toUpperCase().split(/\s+/)) {
      const p = decodeNatPoint(tok);
      if (!p) continue;
      raw.push(p.label);
      if (p.lat != null) pts.push([p.lat, p.lon]);
    }
    return { raw, pts };
  };
  const toTrack = (id, raw, pts, eastLevels = [], westLevels = []) => ({
    id: String(id || '?'), pointsRaw: raw, points: pts,
    eastLevels, westLevels, geometry: pts.length >= 2 ? { kind: 'line', points: pts } : null,
  });
  // 1) Array of track objects with an id and a route string / waypoint list.
  const arr = Array.isArray(json) ? json : (Array.isArray(json?.tracks) ? json.tracks : null);
  if (arr) {
    const out = [];
    for (const t of arr) {
      const id = t.id ?? t.trackId ?? t.identifier ?? t.name;
      if (typeof (t.route ?? t.routeText ?? t.track) === 'string') {
        const { raw, pts } = decodeRoute(t.route ?? t.routeText ?? t.track);
        out.push(toTrack(id, raw, pts));
      } else if (Array.isArray(t.points ?? t.waypoints ?? t.fixes)) {
        const list = t.points ?? t.waypoints ?? t.fixes, raw = [], pts = [];
        for (const w of list) {
          if (Array.isArray(w) && w.length >= 2) { pts.push([Number(w[0]), Number(w[1])]); raw.push(`${w[0]}/${w[1]}`); }
          else if (typeof w === 'object' && w) { const la = Number(w.lat ?? w.latitude), lo = Number(w.lon ?? w.lng ?? w.longitude); if (Number.isFinite(la) && Number.isFinite(lo)) { pts.push([la, lo]); } raw.push(String(w.name ?? w.fix ?? `${la}/${lo}`)); }
          else if (typeof w === 'string') { const p = decodeNatPoint(w); if (p) { raw.push(p.label); if (p.lat != null) pts.push([p.lat, p.lon]); } }
        }
        out.push(toTrack(id, raw, pts));
      }
    }
    if (out.length) return out;
  }
  // 2) GeoJSON FeatureCollection of LineStrings ([lon,lat] order).
  if (json?.type === 'FeatureCollection' && Array.isArray(json.features)) {
    const out = [];
    for (const f of json.features) {
      const coords = f?.geometry?.coordinates;
      if (f?.geometry?.type === 'LineString' && Array.isArray(coords)) {
        const pts = coords.map((c) => [Number(c[1]), Number(c[0])]).filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));
        out.push(toTrack(f.properties?.id ?? f.properties?.name, pts.map((p) => `${p[0]}/${p[1]}`), pts));
      }
    }
    if (out.length) return out;
  }
  return [];
}

/**
 * Decode one NAT waypoint token to { label, lat, lon } (lat/lon null for a named
 * fix). NAT is North latitude / West longitude. Handles whole degrees ("55/20"),
 * HALF/MINUTE degrees in DDMM form ("5730/30" = 57°30′N 030°W), "55N020W", and
 * named fixes (RESNO, DOGAL). Returns null if unrecognized.
 */
export function decodeNatPoint(tok) {
  const t = String(tok || '').toUpperCase().trim();
  let m = t.match(/^(\d{2,4})\/(\d{2,5})$/);             // 57/30, 5730/30, 30/140
  if (m) return { label: t, lat: dm(m[1]), lon: -dm(m[2]) };
  m = t.match(/^(\d{2,4})N0?(\d{2,5})W$/);               // 55N020W / 5730N030W
  if (m) return { label: t, lat: dm(m[1]), lon: -dm(m[2]) };
  if (/^[A-Z]{2,5}$/.test(t)) return { label: t, lat: null, lon: null }; // named fix (airways with trailing digits excluded)
  return null;
}
// Degrees from a coordinate string: 4–5 digits = DDMM (last 2 are minutes),
// otherwise whole degrees. "5730"->57.5, "57"->57, "140"->140, "14030"->140.5.
function dm(s) {
  const n = s.length;
  if (n >= 4) return Number(s.slice(0, n - 2)) + Number(s.slice(n - 2)) / 60;
  return Number(s);
}

/** Parse flight levels from a "...LVLS 350 360 370..." fragment. */
function parseLevels(s) {
  return (String(s).match(/\b(\d{2,3})\b/g) || []).map(Number).filter((n) => n >= 50 && n <= 450);
}

/**
 * Parse a NAT track message (the Gander/Shanwick TMI text) into [{ id, pointsRaw,
 * points:[ [lat,lon] ], eastLevels, westLevels, direction, flBand, validRaw,
 * geometry }]. A track is a line: single letter + waypoint chain (named fixes +
 * lat/lon, incl. half-degree DDMM). FL band / validity / direction come from the
 * surrounding message lines. HTML (if the feed is a page) is stripped first.
 */
export function parseNatTracks(text) {
  const clean = String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tracks = [];
  let cur = null;
  let ctx = { flBand: null, validRaw: null };
  const isTrackHeader = (toks) => toks.length >= 2 && /^[A-Z]$/.test(toks[0]) && decodeNatPoint(toks[1]) != null;
  for (const line of lines) {
    // Message context that applies to the tracks that follow.
    let m = line.match(/TRACKS?\s+FLS?\s+(\d{2,3})\/(\d{2,3})/i);
    if (m) { ctx = { ...ctx, flBand: `FL${Number(m[1])}-${Number(m[2])}` }; continue; }
    m = line.match(/\b([A-Z]{3}\s+\d{1,2}\/\d{3,4}Z\s+TO\s+[A-Z]{3}\s+\d{1,2}\/\d{3,4}Z)/i);
    if (m) { ctx = { ...ctx, validRaw: m[1] }; continue; }

    const toks = line.split(/\s+/);
    if (isTrackHeader(toks)) {
      cur = { id: toks[0], pointsRaw: [], points: [], eastLevels: [], westLevels: [], direction: null, flBand: ctx.flBand, validRaw: ctx.validRaw };
      for (let i = 1; i < toks.length; i++) {
        const p = decodeNatPoint(toks[i]);
        if (!p) break; // stop at the first non-waypoint token
        cur.pointsRaw.push(p.label);
        if (p.lat != null) cur.points.push([p.lat, p.lon]);
      }
      cur.geometry = cur.points.length >= 2 ? { kind: 'line', points: cur.points } : null;
      tracks.push(cur);
      continue;
    }
    // EAST/WEST level lines attach to the most recent track (and set direction).
    if (cur && /LVLS?/.test(line)) {
      const east = line.match(/EAST\s+LVLS?\s+([\d\s]+|NIL)/i);
      const west = line.match(/WEST\s+LVLS?\s+([\d\s]+|NIL)/i);
      if (east && !/NIL/i.test(east[1])) cur.eastLevels = parseLevels(east[1]);
      if (west && !/NIL/i.test(west[1])) cur.westLevels = parseLevels(west[1]);
      cur.direction = cur.eastLevels.length ? 'EAST' : cur.westLevels.length ? 'WEST' : cur.direction;
    }
  }
  return tracks;
}

async function loadFixture() {
  return readFile(fileURLToPath(FIXTURE_URL), 'utf8');
}

/** Parse a NAT response body by content type: JSON → parseNatJson (with a text
 *  fallback), anything else → the text TMI parser. */
export function parseNatBody(contentType, body) {
  if (/json/i.test(contentType || '') || /^\s*[[{]/.test(body || '')) {
    try {
      const tracks = parseNatJson(JSON.parse(body));
      if (tracks.length) return tracks;
    } catch { /* not JSON after all */ }
  }
  return parseNatTracks(body || '');
}

/** @returns {Promise<{tracks:any[], live:boolean, source:string}>} */
export async function fetchNatTracks(offline, signal) {
  const url = process.env.NAT_TRACKS_URL || DEFAULT_NAT_URL;
  if (!offline) {
    try {
      const res = await fetch(url, { signal, headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': UA } });
      if (res.ok) {
        const tracks = parseNatBody(res.headers.get('content-type'), await res.text());
        if (tracks.length) return { tracks, live: true, source: url };
      }
    } catch {
      /* fall through to fixture */
    }
  }
  // Offline, fetch failed, or nothing parsed: show the bundled sample, clearly
  // labeled (never presented as today's live tracks).
  return { tracks: parseNatTracks(await loadFixture()), live: false, source: 'fixture' };
}
