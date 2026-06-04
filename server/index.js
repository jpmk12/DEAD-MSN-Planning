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
import { knownAirports } from './data/airports.js';

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
      sendJson(res, 200, await buildBrief(ids, offline, parseLimits(url)));
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`C-17 Mission Planner on http://localhost:${PORT}`);
});
