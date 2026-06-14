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
import { USER_AGENT } from './awc.js';

const FIXTURE_URL = new URL('../../data/fixtures/nat-tracks-sample.txt', import.meta.url);

/**
 * Decode one NAT waypoint token to { label, lat, lon } (lat/lon null for a named
 * fix). NAT is North latitude / West longitude. Handles "55/20" (55N 020W),
 * "55N020W"/"55N20W", and named fixes (RESNO, DOGAL). Returns null if unrecognized.
 */
export function decodeNatPoint(tok) {
  const t = String(tok || '').toUpperCase().trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,3})$/);              // 55/20
  if (m) return { label: t, lat: Number(m[1]), lon: -Number(m[2]) };
  m = t.match(/^(\d{1,2})N0?(\d{1,3})W$/);                // 55N020W / 55N20W
  if (m) return { label: t, lat: Number(m[1]), lon: -Number(m[2]) };
  if (/^[A-Z]{2,5}\d?$/.test(t)) return { label: t, lat: null, lon: null }; // named fix
  return null;
}

/** Parse flight levels from a "...LVLS 350 360 370..." fragment. */
function parseLevels(s) {
  return (String(s).match(/\b(\d{2,3})\b/g) || []).map(Number).filter((n) => n >= 50 && n <= 450);
}

/**
 * Parse a NAT track message into [{ id, pointsRaw, points:[ [lat,lon] ],
 * eastLevels, westLevels, geometry }]. `points` holds only the decodable lat/lon
 * fixes (named fixes stay in pointsRaw as labels). Heuristic + defensive.
 */
export function parseNatTracks(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tracks = [];
  let cur = null;
  const isTrackHeader = (toks) => toks.length >= 2 && decodeNatPoint(toks[1]) != null && /^[A-Z]$/.test(toks[0]);
  for (const line of lines) {
    const toks = line.split(/\s+/);
    if (isTrackHeader(toks)) {
      cur = { id: toks[0], pointsRaw: [], points: [], eastLevels: [], westLevels: [] };
      for (let i = 1; i < toks.length; i++) {
        const p = decodeNatPoint(toks[i]);
        if (!p) break; // stop at the first non-waypoint token (e.g. trailing level info)
        cur.pointsRaw.push(p.label);
        if (p.lat != null) cur.points.push([p.lat, p.lon]);
      }
      cur.geometry = cur.points.length >= 2 ? { kind: 'line', points: cur.points } : null;
      tracks.push(cur);
      continue;
    }
    // Level/direction lines attach to the most recent track.
    if (cur && /LVLS?/.test(line)) {
      const east = line.match(/EAST\s+LVLS?\s+([\d\s]+|NIL)/i);
      const west = line.match(/WEST\s+LVLS?\s+([\d\s]+|NIL)/i);
      if (east && !/NIL/i.test(east[1])) cur.eastLevels = parseLevels(east[1]);
      if (west && !/NIL/i.test(west[1])) cur.westLevels = parseLevels(west[1]);
    }
  }
  return tracks;
}

async function loadFixture() {
  return readFile(fileURLToPath(FIXTURE_URL), 'utf8');
}

/** @returns {Promise<{tracks:any[], live:boolean, source:string}>} */
export async function fetchNatTracks(offline, signal) {
  const url = process.env.NAT_TRACKS_URL;
  if (!offline && url) {
    try {
      const res = await fetch(url, { signal, headers: { Accept: 'text/plain', 'User-Agent': USER_AGENT } });
      if (res.ok) return { tracks: parseNatTracks(await res.text()), live: true, source: 'NAT_TRACKS_URL' };
    } catch {
      /* fall through to fixture */
    }
  }
  // Offline, no NAT_TRACKS_URL configured, or the live fetch failed: show the
  // bundled sample, clearly labeled (never presented as today's live tracks).
  return { tracks: parseNatTracks(await loadFixture()), live: false, source: 'fixture' };
}
