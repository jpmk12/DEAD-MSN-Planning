// Zero-dependency HTTP server: serves the JSON brief API and the static
// frontend from /public. Designed to deploy as a plain Node app (no build, no
// native deps) — uses only Node built-ins.
//
//   npm start                 # http://localhost:8787 (or process.env.PORT)
//   GET /api/brief?ids=KCHS,KEDW&offline=1
//   GET /api/airfields

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { buildBrief, DEFAULT_LIMITS } from './brief.js';
import { buildRouteWinds } from './winds.js';
import { buildMtrDetail } from './data/mtr.js';
import { knownAirports } from './data/airports.js';
import { dbConfigured, listSorties, saveSortie, deleteSortie } from './data/db.js';
import { fetchMetars, fetchTafs } from './data/awc.js';
import { nmsConfigured } from './data/nms.js';

loadEnv(); // pick up FAA NOTAM credentials from .env if present

const PORT = Number(process.env.PORT ?? 8787);
const WEB_ROOT = fileURLToPath(new URL('../public', import.meta.url));

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

function parseLimits(url) {
  const num = (key, fallback) => {
    const v = Number(url.searchParams.get(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    crosswindKt: num('xwind', DEFAULT_LIMITS.crosswindKt),
    tailwindKt: num('tailwind', DEFAULT_LIMITS.tailwindKt),
    highDensityAltitudeFt: num('highda', DEFAULT_LIMITS.highDensityAltitudeFt),
  };
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(WEB_ROOT, rel));
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    const target = info.isDirectory() ? join(filePath, 'index.html') : filePath;
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    // SPA-ish fallback to index.html.
    try {
      const body = await readFile(join(WEB_ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (url.pathname === '/api/airfields') {
      sendJson(res, 200, { airfields: await knownAirports() });
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
      sendJson(res, 200, await buildBrief(ids, offline, parseLimits(url), agls.length ? agls : undefined));
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
      sendJson(res, 200, await buildRouteWinds(ids, offline));
      return;
    }

    if (url.pathname === '/api/mtr') {
      const id = (url.searchParams.get('id') ?? '').trim();
      if (!id) { sendJson(res, 400, { error: 'provide ?id=IR-021' }); return; }
      const offline = url.searchParams.get('offline') === '1';
      sendJson(res, 200, await buildMtrDetail(id, offline));
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
      const field = (url.searchParams.get('ids') || 'KCHS').split(',')[0].trim().toUpperCase();
      const out = {
        time: new Date().toISOString(),
        node: process.version,
        notamSource: nmsConfigured() ? 'NMS-API' : process.env.FAA_NOTAM_CLIENT_ID ? 'FAA legacy' : 'fixture (no NOTAM credentials set)',
        env: { NMS_CLIENT_ID: !!process.env.NMS_CLIENT_ID, FAA_NOTAM_CLIENT_ID: !!process.env.FAA_NOTAM_CLIENT_ID, DB: dbConfigured() },
        testField: field,
      };
      try { const m = await fetchMetars([field]); out.metar = { live: true, count: m.length, sample: (m[0]?.rawText || '').slice(0, 70) }; }
      catch (e) { out.metar = { live: false, error: String(e).slice(0, 200) }; }
      try { const t = await fetchTafs([field]); out.taf = { live: true, count: t.length, sample: (t[0]?.rawTaf || '').slice(0, 90) }; }
      catch (e) { out.taf = { live: false, error: String(e).slice(0, 200) }; }
      sendJson(res, 200, out);
      return;
    }

    if (url.pathname === '/healthz' || url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'c17-mission-planner', time: new Date().toISOString() });
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
});

const HOST = process.env.HOST ?? '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`C-17 Mission Planner listening on http://${HOST}:${PORT}`);
});
