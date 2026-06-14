// Zero-dependency HTTP server: serves the JSON brief API and the static
// frontend from /public. Designed to deploy as a plain Node app (no build, no
// native deps) — uses only Node built-ins.
//
//   npm start                 # http://localhost:8787 (or process.env.PORT)
//   GET /api/brief?ids=KCHS,KEDW&offline=1
//   GET /api/airfields

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { buildBrief, DEFAULT_LIMITS } from './brief.js';
import { buildRouteWinds } from './winds.js';
import { buildRoute } from './route.js';
import { buildTimeline } from './timeline.js';
import { buildRefCard } from './refcard.js';
import { buildMtrDetail } from './data/mtr.js';
import { legGeometry, scheduleLegs, groundspeed, legEtp, nearestAirports } from './core/legs.js';
import { fetchWindsAloft, interpolateWind } from './data/windsaloft.js';
import { fetchNatTracks } from './data/nattracks.js';
import { fetchPacots } from './data/pacots.js';
import { knownAirports, getAirport, allAirports } from './data/airports.js';
import { dbConfigured, listSorties, saveSortie, deleteSortie } from './data/db.js';
import { fetchMetars, fetchTafs } from './data/awc.js';
import { lastWeatherError } from './data/weather.js';
import { nmsConfigured, nmsProbe } from './data/nms.js';
import { fetchNotams } from './data/notams.js';
import { tfrListItems, tfrIdOf, tfrRecordsFromXml, fetchLiveTfrs } from './data/tfr.js';
import { daipQueryRaw, daipPayload, dodCaLoaded, dodCaInfo, parseDaipNotams } from './data/daip.js';
import { ahasRaw, parseAhasLevel, ahasAreaForIcao } from './data/ahasapi.js';
import { nvgIllum } from './core/astro.js';
import { usnoOneDay, usnoDate, mergeUsno } from './core/usno.js';

loadEnv(); // pick up FAA NOTAM credentials from .env if present

const PORT = Number(process.env.PORT ?? 8787);
const WEB_ROOT = fileURLToPath(new URL('../public', import.meta.url));

// Paths a hosting health monitor might probe — all answer a fast 200 JSON.
const HEALTH_PATHS = new Set([
  '/healthz', '/health', '/healthcheck', '/api/health', '/api/healthz',
  '/ping', '/status', '/_health', '/_healthz', '/livez', '/readyz',
]);

// Simple per-IP fixed-window rate limit for /api/* (health checks exempt).
// Tune with RATE_LIMIT_MAX (default 120) / RATE_LIMIT_WINDOW_MS (default 60000);
// RATE_LIMIT_MAX=0 disables it.
const RL_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000);
const RL_MAX = Number(process.env.RATE_LIMIT_MAX ?? 120);
const rlBuckets = new Map(); // ip -> { count, reset }
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket?.remoteAddress || 'unknown';
}
// Optional whole-app access gate (HTTP Basic auth). Set APP_BASIC_AUTH="user:pass"
// to require it for the site + API; leave unset to keep the app open. Health
// probes are always exempt so the platform can still mark the app healthy.
const BASIC_AUTH = process.env.APP_BASIC_AUTH || '';
function authzOk(req) {
  if (!BASIC_AUTH) return true; // gate disabled
  const expected = `Basic ${Buffer.from(BASIC_AUTH).toString('base64')}`;
  const got = req.headers.authorization || '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** @returns {number} seconds to wait if over the limit, else 0. */
function rateRetryAfter(req) {
  if (!(RL_MAX > 0)) return 0;
  const now = Date.now();
  const ip = clientIp(req);
  let b = rlBuckets.get(ip);
  if (!b || now >= b.reset) { b = { count: 0, reset: now + RL_WINDOW_MS }; rlBuckets.set(ip, b); }
  b.count += 1;
  if (rlBuckets.size > 5000) for (const [k, v] of rlBuckets) if (now >= v.reset) rlBuckets.delete(k);
  return b.count > RL_MAX ? Math.max(1, Math.ceil((b.reset - now) / 1000)) : 0;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Parse the optional `stops` param: pipe-separated stops, each a `@`-delimited
// "ICAO@ISO@ROLE@Label" (only ICAO required). Returns null when empty so the
// caller falls back to the flat id list. Capped to bound work per request.
function parseStops(raw) {
  if (!raw) return null;
  const stops = raw.split('|').map((tok) => {
    const [icao, when, role, label] = tok.split('@');
    const id = String(icao || '').trim().toUpperCase();
    if (!id) return null;
    const iso = when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString() : null;
    return { icao: id, when: iso, role: (role || 'FIELD').trim().toUpperCase(), label: (label || id).trim() };
  }).filter(Boolean).slice(0, 12);
  return stops.length ? stops : null;
}

// Parse route tokens "ID" or "ID@ISO" (comma/space separated). Each route can
// carry ITS OWN entry time (AR tracks at the A/R time, IR/VR at the low-level
// time); a bare id falls back to `rwhen` (legacy single-time param).
function parseRouteTokens(raw, rwhen) {
  const fallback = rwhen && !Number.isNaN(Date.parse(rwhen)) ? new Date(rwhen).toISOString() : null;
  return (raw ?? '').split(/[\s,]+/).filter(Boolean).slice(0, 8).map((tok) => {
    const [id, when] = tok.split('@');
    const iso = when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString() : fallback;
    return { id: id.trim(), when: iso };
  }).filter((r) => r.id);
}

// Parse the refcard `fields` param: pipe-separated "ICAO@ISO@Label" (time/label
// optional). Falls back to a single { icao, when } when only ?icao= is given.
function parseRefFields(raw, fallbackIcao, fallbackWhen) {
  if (raw) {
    const out = raw.split('|').map((tok) => {
      const [icao, when, label] = tok.split('@');
      const id = String(icao || '').trim().toUpperCase();
      if (!id) return null;
      const iso = when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString() : null;
      return { icao: id, when: iso, label: (label || '').trim() };
    }).filter(Boolean).slice(0, 12);
    if (out.length) return out;
  }
  return fallbackIcao ? [{ icao: fallbackIcao, when: fallbackWhen, label: '' }] : [];
}

function parseLimits(url) {
  const num = (key, fallback) => {
    const v = Number(url.searchParams.get(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    crosswindKt: num('xwind', DEFAULT_LIMITS.crosswindKt),
    tailwindKt: num('tailwind', DEFAULT_LIMITS.tailwindKt),
    highDensityAltitudeFt: num('highda', DEFAULT_LIMITS.highDensityAltitudeFt),
    ceilingMinFt: num('ceilmin', DEFAULT_LIMITS.ceilingMinFt),
    visMinSm: num('vismin', DEFAULT_LIMITS.visMinSm),
  };
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(WEB_ROOT, rel));
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  // App assets are not content-hashed, so always require revalidation. This
  // prevents a CDN/browser/service-worker from pinning a stale app.js against a
  // newer index.html (the cause of "every button is dead" after a deploy). The
  // service worker still provides offline support. Last-Modified enables cheap
  // 304s so revalidation isn't a full re-download.
  const headers = (mtime) => ({
    'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Last-Modified': mtime,
  });
  try {
    const info = await stat(filePath);
    const target = info.isDirectory() ? join(filePath, 'index.html') : filePath;
    const tinfo = info.isDirectory() ? await stat(target) : info;
    const lastMod = tinfo.mtime.toUTCString();
    if (req.headers['if-modified-since'] === lastMod) {
      res.writeHead(304, { 'Cache-Control': 'no-cache', 'Last-Modified': lastMod }).end();
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, { ...headers(lastMod), 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    // SPA-ish fallback to index.html.
    try {
      const body = await readFile(join(WEB_ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    // The frontend is served from this same origin, so no cross-origin access is
    // needed. Omitting Access-Control-Allow-Origin keeps other sites from reading
    // brief data or making cross-origin writes to /api/sorties (the JSON POST
    // preflight will fail). nosniff is cheap defense-in-depth.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Don't leak the full URL (which can carry briefed ICAOs/times) to the
    // third-party tile/CDN hosts the page talks to.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // Content-Security-Policy: lock the origin down while still allowing the
    // live map (CARTO/IEM/RainViewer tiles + their JSON over https) and the few
    // inline <style>/<script>/onclick hooks the app and the printable refcard
    // use. 'unsafe-inline' is required for those inline handlers; everything
    // else is same-origin. frame-ancestors blocks clickjacking.
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "img-src 'self' data: https:",
        "connect-src 'self' https:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
      ].join('; '),
    );

    // Request log (stdout, OFF by default; set REQUEST_LOG=on to enable). When
    // on it makes the platform's health probe VISIBLE in the deploy log: its
    // path, method, user-agent, forwarded headers, and the status we return.
    // That's the one thing support couldn't tell us — now we can see it.
    if (process.env.REQUEST_LOG === 'on' || process.env.REQUEST_LOG === '1') {
      const t0 = Date.now();
      const h = req.headers;
      res.on('finish', () => {
        console.log(
          `[req] ${req.method} ${url.pathname} -> ${res.statusCode} ${Date.now() - t0}ms` +
          ` ua="${(h['user-agent'] || '').slice(0, 80)}" xff="${h['x-forwarded-for'] || ''}"` +
          ` proto="${h['x-forwarded-proto'] || ''}" host="${h['host'] || ''}"`,
        );
      });
    }

    // Optional access gate for the whole app (health probes exempt).
    if (!HEALTH_PATHS.has(url.pathname) && !authzOk(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="DEAD Planning", charset="UTF-8"', 'Content-Type': 'text/plain' });
      res.end('Authentication required');
      return;
    }

    // Rate-limit the API (health probes exempt) to prevent abuse / outbound
    // amplification via the brief/refcard fan-out.
    if (url.pathname.startsWith('/api/') && !HEALTH_PATHS.has(url.pathname)) {
      const retry = rateRetryAfter(req);
      if (retry) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(retry) });
        res.end(JSON.stringify({ error: 'rate limit exceeded', retryAfterSeconds: retry }));
        return;
      }
    }

    if (url.pathname === '/api/airfields') {
      sendJson(res, 200, { airfields: await knownAirports() });
      return;
    }

    // ICAO -> AHAS area name (e.g. KLTS -> "ALTUS AFB"), for the AHAS quick-link.
    if (url.pathname === '/api/ahas-area') {
      const icao = (url.searchParams.get('icao') || '').trim().toUpperCase();
      sendJson(res, 200, { icao, area: ahasAreaForIcao(icao) || null });
      return;
    }

    // Combined printable reference page (DAIP NOTAMs + AWC METAR/decoded TAF +
    // AHAS) for ALL the sortie bases. `fields` is pipe-separated "ICAO@ISO@Label"
    // (falls back to single ?icao=). `only` filters sections; `print=1` auto-prints.
    if (url.pathname === '/api/refcard') {
      const onlyRaw = (url.searchParams.get('only') || 'all').toLowerCase();
      const only = ['all', 'notams', 'wx', 'ahas', 'wxnotams'].includes(onlyRaw) ? onlyRaw : 'all';
      const whenRaw = url.searchParams.get('when');
      const whenIso = whenRaw && !Number.isNaN(Date.parse(whenRaw)) ? new Date(whenRaw).toISOString() : null;
      const fields = parseRefFields(url.searchParams.get('fields'), (url.searchParams.get('icao') || '').trim().toUpperCase(), whenIso);
      if (!fields.length) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('provide ?fields= or ?icao='); return; }
      const rwhenRaw = url.searchParams.get('rwhen');
      const routeWhen = rwhenRaw && !Number.isNaN(Date.parse(rwhenRaw)) ? new Date(rwhenRaw).toISOString() : null;
      const routes = parseRouteTokens(url.searchParams.get('routes'), url.searchParams.get('rwhen'));
      const autoPrint = url.searchParams.get('print') === '1';
      const summary = url.searchParams.get('summary') === '1';
      try {
        const html = await buildRefCard(fields, only, autoPrint, routes, routeWhen, summary);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`reference unavailable: ${String(e).slice(0, 200)}`);
      }
      return;
    }

    if (url.pathname === '/api/hubs') {
      // Status board: one brief over a curated field list, condensed to a per-field
      // status line. ?set=amc (mobility hubs) | oceanic (N. Atlantic divert bases).
      const offline = url.searchParams.get('offline') === '1';
      const SETS = { amc: 'amc-hubs.json', oceanic: 'oceanic-divert.json' };
      const file = SETS[url.searchParams.get('set')] || SETS.amc;
      let hubList = [];
      try { hubList = JSON.parse(await readFile(fileURLToPath(new URL(`../data/${file}`, import.meta.url)), 'utf8')).hubs || []; } catch { hubList = []; }
      const meta = new Map(hubList.map((h) => [h.icao.toUpperCase(), h]));
      const icaos = hubList.map((h) => h.icao.toUpperCase());
      const brief = icaos.length ? await buildBrief(icaos, offline, parseLimits(url)) : { airfields: [], live: {} };
      const hubs = brief.airfields.map((a) => {
        const m = meta.get(a.icao.toUpperCase()) || {};
        const cc = a.currentConditions || {};
        return {
          icao: a.icao, name: m.name || a.airport?.name || a.icao, region: m.region || 'OTHER',
          found: a.found, status: a.status,
          flightCategory: cc.flightCategory ?? null, ceilingFt: cc.ceilingFt ?? null, visibilitySm: cc.visibilitySm ?? null,
          closedRunways: a.closedRunways || [], runwayConditions: (a.runwayConditions || []).length,
          raim: a.airspace?.raim?.status ?? null,
          topReason: (a.statusReasons || [])[0] || null, metar: a.metar || null,
        };
      });
      sendJson(res, 200, { generatedAt: new Date().toISOString(), live: brief.live?.weather ?? false, notamsLive: brief.live?.notams ?? false, hubs });
      return;
    }

    if (url.pathname === '/api/tracks' || url.pathname === '/api/nat') {
      // Oceanic organized tracks: NAT (FAA) and PACOTS (DAIP). ?system=nat|pacots|both.
      const offline = url.searchParams.get('offline') === '1';
      const sys = (url.searchParams.get('system') || (url.pathname === '/api/nat' ? 'nat' : 'both')).toLowerCase();
      const wantNat = sys === 'nat' || sys === 'both';
      const wantPac = sys === 'pacots' || sys === 'both';
      const [nat, pac] = await Promise.all([
        wantNat ? fetchNatTracks(offline) : Promise.resolve(null),
        wantPac ? fetchPacots(offline) : Promise.resolve(null),
      ]);
      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        nat: nat && { live: nat.live, source: nat.source, tracks: nat.tracks },
        pacots: pac && { live: pac.live, source: pac.source, tracks: pac.tracks },
        // Back-compat fields for the original /api/nat shape.
        ...(url.pathname === '/api/nat' && nat ? { live: nat.live, source: nat.source, tracks: nat.tracks } : {}),
      });
      return;
    }

    if (url.pathname === '/api/global') {
      // Strategic/global route: ordered ICAO waypoints -> great-circle legs with
      // wind-corrected ETAs, plus a per-stop brief (weather/NOTAM/NVG at each ETA).
      const ids = (url.searchParams.get('route') ?? '')
        .split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (ids.length < 2) { sendJson(res, 400, { error: 'provide ?route=KCHS TNCM LPLA ETAR (2+ ICAOs)' }); return; }
      const offline = url.searchParams.get('offline') === '1';
      const nvg = url.searchParams.get('nvg') === '1';
      const tasKt = Math.max(60, Math.min(600, Number(url.searchParams.get('tas')) || 450));
      const altRaw = url.searchParams.get('alt') || 'FL350';
      const flMatch = String(altRaw).match(/FL\s*(\d{2,3})/i);
      const altFt = Math.max(1000, Math.min(45000, flMatch ? Number(flMatch[1]) * 100 : (Number(String(altRaw).replace(/[^\d]/g, '')) || 35000)));
      const departRaw = url.searchParams.get('depart');
      const departIso = departRaw && !Number.isNaN(Date.parse(departRaw)) ? new Date(departRaw).toISOString() : new Date().toISOString();

      // Resolve each waypoint to coordinates (curated -> global bundle -> live).
      const resolved = await Promise.all(ids.map(async (id) => {
        const ap = await getAirport(id, offline);
        return ap && ap.lat != null ? { id, lat: ap.lat, lon: ap.lon, name: ap.name } : { id, missing: true };
      }));
      const waypoints = resolved.filter((w) => !w.missing);
      const missing = resolved.filter((w) => w.missing).map((w) => w.id);
      if (waypoints.length < 2) {
        sendJson(res, 200, { route: { departIso, tasKt, altFt }, missing, legs: [], stops: [], airfields: [], note: 'Need at least two resolvable ICAOs.' });
        return;
      }

      const legs = legGeometry(waypoints);
      // Two-pass schedule: TAS-only to get approx leg times, sample winds at each
      // leg midpoint/altitude for that time, then reschedule with groundspeeds.
      const prelim = scheduleLegs(legs, departIso, tasKt);
      const legWinds = await Promise.all(legs.map(async (leg, i) => {
        if (offline) return null;
        const w = await fetchWindsAloft(leg.midLat, leg.midLon, 0, false, prelim.legs[i].startIso).catch(() => null);
        const lvl = w && w.profile.length ? interpolateWind(w.profile, altFt) : null;
        return lvl ? { ...lvl, live: w.live } : null;
      }));
      const gsByLeg = legs.map((leg, i) => groundspeed(tasKt, leg.bearingTrue, legWinds[i]));
      const sched = scheduleLegs(legs, departIso, tasKt, gsByLeg);
      // Attach the leg wind (and headwind component) for display.
      sched.legs.forEach((leg, i) => {
        const wind = legWinds[i];
        if (wind) leg.wind = { altFt, dirTrue: wind.dirTrue, speedKt: wind.speedKt, headwindKt: tasKt - leg.gsKt, live: wind.live };
      });

      // Equal-Time Point + nearest suitable diversion airfields per leg (ETOPS/
      // oceanic). Diversion pool = curated + global bundle (US-only without the
      // bundle); minimum 7000 ft runway. A leg with no diversion within range is
      // flagged as a coverage gap.
      const minRwy = Math.max(0, Number(url.searchParams.get('minrwy')) || 7000);
      const divRangeNm = Math.max(50, Number(url.searchParams.get('divrange')) || 400);
      const pool = await allAirports();
      sched.legs.forEach((leg) => {
        const etp = legEtp(leg, tasKt);
        if (!etp) return;
        leg.etp = etp;
        leg.diversions = (etp.lat != null)
          ? nearestAirports(etp.lat, etp.lon, pool, { maxNm: divRangeNm, minRunwayFt: minRwy, limit: 3 })
          : [];
        leg.diversionGap = leg.diversions.length === 0;
      });

      // Per-stop brief at each ETA (reuses the full weather/NOTAM/NVG engine).
      const stops = sched.stops.map((s, i) => ({ icao: s.id, when: s.etaIso, role: 'FIELD', label: i === 0 ? 'Origin' : (i === sched.stops.length - 1 ? 'Destination' : `Stop ${i}`) }));
      const uniqueIds = [...new Set(waypoints.map((w) => w.id))];
      const brief = await buildBrief(uniqueIds, offline, parseLimits(url), undefined, null, stops, { nvg });

      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        route: { ids, departIso, tasKt, altFt, missing, minRwy, divRangeNm },
        legs: sched.legs,
        totals: { distanceNm: sched.totalNm, timeMin: sched.totalMin },
        stops: sched.stops,
        airfields: brief.airfields,
        live: brief.live,
        nvg,
      });
      return;
    }

    if (url.pathname === '/api/brief') {
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (ids.length === 0) {
        sendJson(res, 400, { error: 'provide ?ids=KCHS,KEDW' });
        return;
      }
      const offline = url.searchParams.get('offline') === '1';
      const agls = (url.searchParams.get('agls') ?? '')
        .split(',')
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 60000)
        .slice(0, 6);
      const whenRaw = url.searchParams.get('when');
      const whenIso = whenRaw && !Number.isNaN(Date.parse(whenRaw)) ? new Date(whenRaw).toISOString() : null;
      // Optional structured sortie: ordered stops, each "ICAO@ISO@ROLE@Label"
      // (time/role/label optional), pipe-separated. When present each location is
      // evaluated at its own time (departure ≠ recovery, even for an out-and-back
      // to the same field). Falls back to the flat id list when absent.
      const stops = parseStops(url.searchParams.get('stops'));
      const nvg = url.searchParams.get('nvg') === '1';
      sendJson(res, 200, await buildBrief(ids, offline, parseLimits(url), agls.length ? agls : undefined, whenIso, stops, { nvg }));
      return;
    }

    if (url.pathname === '/api/winds') {
      const ids = (url.searchParams.get('points') ?? url.searchParams.get('ids') ?? '')
        .split(/[\s,]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (ids.length === 0) {
        sendJson(res, 400, { error: 'provide ?points=KCHS,LRP (airfields or navaids)' });
        return;
      }
      const offline = url.searchParams.get('offline') === '1';
      // Optional reference point (briefed field) to disambiguate non-unique
      // navaid idents by proximity, e.g. ?near=34.67,-99.27
      const nm = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(url.searchParams.get('near') || '');
      const near = nm ? { lat: Number(nm[1]), lon: Number(nm[2]) } : null;
      sendJson(res, 200, await buildRouteWinds(ids, offline, undefined, near));
      return;
    }

    if (url.pathname === '/api/illum') {
      // NVG illumination for a place/time: computed sun/moon events, lunar
      // position, ground millilux + AFI 11-214 LOW/HIGH. Accepts an explicit
      // ?lat=&lon= or a ?icao= (resolved to its coordinates). ?usno=1 adds the
      // USNO cross-check (authoritative event times) unless ?offline=1.
      const offline = url.searchParams.get('offline') === '1';
      const whenRaw = url.searchParams.get('when');
      const when = whenRaw && !Number.isNaN(Date.parse(whenRaw)) ? new Date(whenRaw).toISOString() : new Date().toISOString();
      let lat = null, lon = null, icao = null;
      const latRaw = url.searchParams.get('lat');
      const lonRaw = url.searchParams.get('lon');
      if (latRaw != null && lonRaw != null && latRaw !== '' && lonRaw !== '') {
        lat = Number(latRaw); lon = Number(lonRaw);
      } else if (url.searchParams.get('icao')) {
        icao = String(url.searchParams.get('icao')).trim().toUpperCase();
        const ap = await getAirport(icao, offline);
        if (ap && ap.lat != null) { lat = ap.lat; lon = ap.lon; }
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        sendJson(res, 400, { error: 'provide ?lat=&lon= or a known ?icao= (and optional ?when=ISO)' });
        return;
      }
      const ill = nvgIllum(when, lat, lon);
      if (!ill) { sendJson(res, 422, { error: 'illumination not computable for those coordinates' }); return; }
      let out = ill;
      if (url.searchParams.get('usno') === '1' && !offline) {
        out = mergeUsno(ill, await usnoOneDay(when, lat, lon, { offline }));
      }
      sendJson(res, 200, { when, lat, lon, icao, ...out });
      return;
    }

    if (url.pathname === '/api/timeline') {
      // CADDO10 offline demos: bundled fixtures, fixed anchor time, labeled DEMO.
      // `caddo10` = day divert demo; `caddo10n` = night NVG illumination demo.
      const demo = url.searchParams.get('demo');
      const demoFile = demo === 'caddo10' ? 'caddo10.json' : demo === 'caddo10n' ? 'caddo10n.json' : null;
      if (demoFile) {
        const fix = JSON.parse(await readFile(fileURLToPath(new URL(`../data/fixtures/${demoFile}`, import.meta.url)), 'utf8'));
        const tl = await buildTimeline({ stops: fix.stops, routes: fix.routes, limits: parseLimits(url), nvg: url.searchParams.get('nvg') === '1' || fix.nvg === true, inject: fix });
        sendJson(res, 200, { ...tl, demo: demo === 'caddo10n' ? 'CADDO10-NIGHT' : 'CADDO10', demoNote: fix._sources });
        return;
      }
      const stops = parseStops(url.searchParams.get('stops') ?? '');
      if (!stops) { sendJson(res, 400, { error: 'provide ?stops=ICAO@ISO@ROLE@Label|... (or ?demo=caddo10)' }); return; }
      const routes = parseRouteTokens(url.searchParams.get('routes'), url.searchParams.get('rwhen'));
      const offline = url.searchParams.get('offline') === '1';
      sendJson(res, 200, await buildTimeline({ stops, routes, offline, nvg: url.searchParams.get('nvg') === '1', limits: parseLimits(url) }));
      return;
    }

    if (url.pathname === '/api/route') {
      const routeStr = (url.searchParams.get('route') ?? '').trim();
      if (!routeStr) { sendJson(res, 400, { error: 'provide ?route=KLTS DCT FLOYD J78 ...' }); return; }
      const offline = url.searchParams.get('offline') === '1';
      const nm = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(url.searchParams.get('near') || '');
      const near = nm ? { lat: Number(nm[1]), lon: Number(nm[2]) } : null;
      sendJson(res, 200, await buildRoute(routeStr, offline, near));
      return;
    }

    if (url.pathname === '/api/mtr') {
      const ids = [...new Set(
        (url.searchParams.get('id') ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      )].slice(0, 8);
      if (!ids.length) { sendJson(res, 400, { error: 'provide ?id=IR-021 (comma/space separated for multiple)' }); return; }
      const offline = url.searchParams.get('offline') === '1';
      const whenRaw = url.searchParams.get('when');
      const whenIso = whenRaw && !Number.isNaN(Date.parse(whenRaw)) ? new Date(whenRaw).toISOString() : null;
      const routes = await Promise.all(ids.map((id) => buildMtrDetail(id, offline, whenIso)));
      sendJson(res, 200, { routes });
      return;
    }

    if (url.pathname === '/api/sorties') {
      if (!dbConfigured()) {
        sendJson(res, 200, { configured: false, sorties: {} });
        return;
      }
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, { configured: true, sorties: await listSorties() });
        } else if (req.method === 'POST' || req.method === 'PUT') {
          const body = await readJsonBody(req);
          const name = String(body.name || '').trim();
          if (!name) { sendJson(res, 400, { error: 'name required' }); return; }
          await saveSortie(name, body.data ?? {});
          sendJson(res, 200, { ok: true });
        } else if (req.method === 'DELETE') {
          const name = String(url.searchParams.get('name') || '').trim();
          if (!name) { sendJson(res, 400, { error: 'name required' }); return; }
          await deleteSortie(name);
          sendJson(res, 200, { ok: true });
        } else {
          sendJson(res, 405, { error: 'method not allowed' });
        }
      } catch (err) {
        sendJson(res, 503, { error: 'database unavailable', detail: String(err) });
      }
      return;
    }

    if (url.pathname === '/api/diag') {
      // Locked down: disabled unless DIAG_KEY is set, and then a matching ?key=
      // is required. No key configured → 404 (the endpoint reveals env/source
      // detail, so it must not be open on a published site).
      const diagKey = process.env.DIAG_KEY;
      if (!diagKey || url.searchParams.get('key') !== diagKey) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      const field = (url.searchParams.get('ids') || 'KCHS').split(',')[0].trim().toUpperCase();
      const nmsBase = (process.env.NMS_API_BASE || 'https://api-nms.aim.faa.gov').replace(/\/+$/, '');
      const out = {
        time: new Date().toISOString(),
        node: process.version,
        testField: field,
        nmsBase,
        nmsStaging: /staging|test/i.test(nmsBase),
        env: { NMS_CLIENT_ID: !!process.env.NMS_CLIENT_ID, FAA_NOTAM_CLIENT_ID: !!process.env.FAA_NOTAM_CLIENT_ID, DB: dbConfigured() },
      };
      // Run the real brief pipeline once and report every source's live state —
      // a one-call check for the whole live-data picture.
      try {
        const b = await buildBrief([field], false, parseLimits(url));
        const af = b.airfields?.[0] || {};
        out.notamSource = b.notamSource;
        out.live = b.live;
        // Per-source latency (ms) for this brief — the slowest live feed first.
        out.timings = b.diag?.timings
          ? Object.fromEntries(Object.entries(b.diag.timings).sort((a, c) => c[1] - a[1]))
          : null;
        out.sources = {
          metar: { live: b.live.weather, via: b.wxSource ?? null, sample: (af.analysis?.observation?.rawText || '').slice(0, 90), error: b.live.weather ? null : lastWeatherError() },
          taf: { live: b.live.taf, sample: (af.taf || '').slice(0, 90) },
          notams: { live: b.live.notams, source: b.notamSource, count: af.notams?.length ?? 0, sample: (af.notams?.[0]?.text || '').slice(0, 120) },
          sua: { live: b.live.sua, count: b.airspace?.sua?.length ?? 0 },
          tfr: { live: b.live.tfr, count: b.airspace?.tfrs?.length ?? 0 },
          winds: { live: b.live.windsAloft, levels: af.windsAloft?.profile?.length ?? 0 },
          sigmet: { live: b.live.hazardWx, count: b.airsigmets?.length ?? 0 },
          pireps: { live: b.live.pireps, count: b.pireps?.length ?? 0 },
          convective: { live: b.live.convective, count: b.convective?.length ?? 0 },
        };
      } catch (e) {
        out.error = String(e).slice(0, 300);
      }
      // Only probe NMS auth detail when NOTAMs aren't coming through — a second
      // call while it's already working just trips the API rate limit (429).
      if (nmsConfigured() && !(out.live && out.live.notams)) out.nms = await nmsProbe(field);
      const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      // TFR schema probe — reveals the tfr3 response so the parser can be tuned.
      try {
        const tr = await fetch(process.env.TFR_JSON_URL || 'https://tfr.faa.gov/tfrapi/exportTfrList', {
          headers: { Accept: 'application/json,text/plain,*/*', 'User-Agent': browserUA }, signal: AbortSignal.timeout(8000),
        });
        const ct = tr.headers.get('content-type') || '';
        const text = await tr.text();
        out.tfrProbe = { status: tr.status, contentType: ct, finalUrl: tr.url, bytes: text.length };
        if (/json/i.test(ct) || /^[\s]*[[{]/.test(text)) {
          try {
            const tj = JSON.parse(text);
            const items = tfrListItems(tj);
            const first = items[0] ? (items[0].properties ?? items[0]) : null;
            Object.assign(out.tfrProbe, {
              listType: Array.isArray(tj) ? 'array' : tj?.features ? 'featurecollection' : typeof tj,
              itemCount: items.length,
              firstItemKeys: first ? Object.keys(first).slice(0, 50) : [],
              hasInlineGeometry: !!(items[0]?.geometry),
              idSamples: items.slice(0, 3).map(tfrIdOf),
              firstItem: first,
            });
            // If geometry isn't inline, test the detail-XML path for the first id.
            const id0 = items.slice(0, 1).map(tfrIdOf)[0];
            if (id0 && !out.tfrProbe.hasInlineGeometry) {
              const detailId = String(id0).replace(/\//g, '_').replace(/[^0-9_]/g, '');
              try {
                const dr = await fetch(`https://tfr.faa.gov/download/detail_${detailId}.xml`, { headers: { 'User-Agent': browserUA }, signal: AbortSignal.timeout(8000) });
                const dt = await dr.text();
                const recs = tfrRecordsFromXml(dt, id0);
                const containers = {
                  aseTFRArea: (dt.match(/<aseTFRArea[\s>]/gi) || []).length,
                  Abd: (dt.match(/<Abd[\s>]/gi) || []).length,
                  abdMergedArea: (dt.match(/<abdMergedArea[\s>]/gi) || []).length,
                  Avx: (dt.match(/<Avx[\s>]/gi) || []).length,
                };
                // Snippet centered on the geometry tags so the parser can be tuned.
                const gi = Math.max(dt.search(/geoLat|<Avx[ >]|<Abd[ >]/i), 0);
                out.tfrProbe.detail = { id: id0, detailId, status: dr.status, bytes: dt.length, parsed: recs.length, geom: recs[0]?.geometry?.kind || null, containers, snippet: dt.slice(gi, gi + 600) };
              } catch (e) { out.tfrProbe.detail = { error: String(e).slice(0, 150) }; }
              // Probe candidate tfr3 geometry endpoints for this notam id.
              const enc = encodeURIComponent(id0);
              const us = String(id0).replace(/\//g, '_');
              const candidates = [
                `https://tfr.faa.gov/tfrapi/exportTfr?notamId=${enc}`,
                `https://tfr.faa.gov/tfrapi/exportTfr/${enc}`,
                `https://tfr.faa.gov/tfrapi/getTfr?notamId=${enc}`,
                `https://tfr.faa.gov/download/detail_${us}.xml`,
                `https://tfr.faa.gov/tfr3/export/geojson`,
              ];
              out.tfrProbe.candidates = await Promise.all(candidates.map(async (u) => {
                try {
                  const cr = await fetch(u, { headers: { Accept: 'application/json,application/xml,*/*', 'User-Agent': browserUA }, signal: AbortSignal.timeout(6000) });
                  const ct = cr.headers.get('content-type') || '';
                  const body = (await cr.text()).slice(0, 160);
                  return { url: u, status: cr.status, ct, snippet: body };
                } catch (e) { return { url: u, error: String(e).slice(0, 80) }; }
              }));
            }
          } catch (e) { out.tfrProbe.parseError = String(e).slice(0, 120); out.tfrProbe.snippet = text.slice(0, 300); }
        } else {
          out.tfrProbe.snippet = text.slice(0, 300); // HTML/non-JSON — shows what the server returned
        }
      } catch (e) { out.tfrProbe = { error: String(e).slice(0, 200) }; }
      // AHAS schema probe — raw responses so the risk parser can be finalized.
      try {
        const route = await ahasRaw('GetAHASRisk', 'IR', 'IR154').then((t) => ({ level: parseAhasLevel(t), snippet: String(t).slice(0, 300) }), (e) => ({ error: String(e).slice(0, 150) }));
        const airfield = await ahasRaw('GetAHASRisk12', 'MILAIR', 'ALTUS AFB').then((t) => ({ level: parseAhasLevel(t), snippet: String(t).slice(0, 300) }), (e) => ({ error: String(e).slice(0, 150) }));
        out.ahasProbe = { route, airfield };
      } catch (e) { out.ahasProbe = { error: String(e).slice(0, 200) }; }
      // PIREP probe — shows why the AWC pirep endpoint isn't returning data.
      try {
        const pu = 'https://aviationweather.gov/api/data/pirep?format=json&age=2&bbox=20,-130,55,-60';
        const pr = await fetch(pu, { headers: { Accept: 'application/json', 'User-Agent': 'C17MissionPlanner/1.0 (mission planning; contact: ops)' }, signal: AbortSignal.timeout(8000) });
        const ptext = await pr.text();
        let parsed = null; try { parsed = JSON.parse(ptext); } catch { /* not json */ }
        out.pirepProbe = {
          status: pr.status,
          contentType: pr.headers.get('content-type') || '',
          isArray: Array.isArray(parsed),
          count: Array.isArray(parsed) ? parsed.length : (parsed && Array.isArray(parsed.features) ? parsed.features.length : null),
          snippet: ptext.slice(0, 200),
        };
      } catch (e) { out.pirepProbe = { error: String(e).slice(0, 200) }; }
      // DAIP (DoD Aeronautical Information) probe — reports the response shape so
      // we can see what data is available beyond NOTAMs (TFRs, flight info, …).
      try {
        const r = await daipQueryRaw(daipPayload(field));
        let parsed = null; try { parsed = JSON.parse(r.body); } catch { /* non-json */ }
        out.daipProbe = {
          ca: dodCaInfo(), status: r.status, contentType: r.contentType, bytes: r.body.length,
          topKeys: parsed ? Object.keys(parsed) : null,
          count: parsed?.count ?? null, groups: parsed?.group?.length ?? null,
          notamsParsed: parseDaipNotams(r.body).length,
          listItemKeys: parsed?.group?.[0]?.notams?.[0]?.list?.[0] ? Object.keys(parsed.group[0].notams[0].list[0]) : null,
          snippet: r.body.slice(0, 400),
        };
      } catch (e) {
        out.daipProbe = {
          ca: dodCaInfo(),
          error: String(e && e.message ? e.message : e).slice(0, 120),
          cause: e?.cause ? String(e.cause.code || e.cause.message || e.cause).slice(0, 180) : (e?.code || null),
        };
      }
      // DAIP TFR exploration — see how DAIP returns TFRs (structure + geometry).
      try {
        const tr = await daipQueryRaw({ ...daipPayload(field), tfrsOnly: 'Y' });
        let tp = null; try { tp = JSON.parse(tr.body); } catch { /* non-json */ }
        out.daipTfrProbe = { status: tr.status, bytes: tr.body.length, topKeys: tp ? Object.keys(tp) : null, count: tp?.count ?? null, snippet: tr.body.slice(0, 700) };
      } catch (e) { out.daipTfrProbe = { error: String(e && e.message ? e.message : e).slice(0, 150) }; }
      sendJson(res, 200, out);
      return;
    }

    // Health checks. Respond with a fast, tiny 200 JSON on every common probe
    // path so the platform's preview/production health monitor always gets an
    // unambiguous "healthy" (some checkers expect a small body, not the full
    // SPA HTML the static fallback would otherwise return).
    if (HEALTH_PATHS.has(url.pathname)) {
      sendJson(res, 200, { ok: true, service: 'c17-mission-planner', time: new Date().toISOString() });
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
});

// Always bind all interfaces. The platform's health probe / router reaches the
// container on its pod IP, so binding only to loopback (e.g. an injected
// HOST=127.0.0.1, as seen in deploy logs) makes the app unreachable and the
// build is marked "unhealthy". 0.0.0.0 also covers loopback, so a same-host
// proxy still works. (GoDaddy guidance: bind 0.0.0.0, not localhost.)
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`DEAD Planning listening on http://${HOST}:${PORT}`);
  // Startup diagnostics (stdout): how the platform configured us, and the NAMES
  // of every injected env var (names only — no values, so no secrets). A
  // platform-specific health-check path/port often shows up here.
  console.log(`[boot] node=${process.version} PORT=${process.env.PORT ?? '(unset)'} HOST=${HOST} NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}`);
  // Verbose platform diagnostics (paths + injected env-var NAMES, never values)
  // were invaluable while debugging the host. Off by default now; set BOOT_DIAG=1
  // to bring them back if a deploy misbehaves.
  if (process.env.BOOT_DIAG === '1') {
    console.log(`[boot] cwd=${process.cwd()} DIST_DIR=${process.env.DIST_DIR ?? '(unset)'} CUSTOMER_APP_DIR=${process.env.CUSTOMER_APP_DIR ?? '(unset)'} BASE_APP_DIR=${process.env.BASE_APP_DIR ?? '(unset)'} INIT_CWD=${process.env.INIT_CWD ?? '(unset)'}`);
    console.log(`[boot] env-names: ${Object.keys(process.env).sort().join(',')}`);
  }
  // Warm the TFR cache now (list + all detail XMLs) so the first brief isn't
  // slowed by fetching them on demand. Fire-and-forget; failures are non-fatal.
  fetchLiveTfrs().then(
    (t) => console.log(`[boot] TFR cache warmed (${t.length} records)`),
    () => console.log('[boot] TFR warm skipped (source unreachable)'),
  );
  if (process.env.NMS_ENABLED === '1' && nmsConfigured() && /staging|test/i.test(process.env.NMS_API_BASE || '')) {
    console.log('[NOTAM] FAA NMS fallback is ENABLED and pointed at a STAGING endpoint (non-operational test data). Set NMS_API_BASE to production, or unset NMS_ENABLED to disable the fallback.');
  }
});
