# Deploying the C-17 Mission Planner

This is a standard, dependency-light Node app: `npm install` → `npm run build`
→ `npm start`, listening on `process.env.PORT` bound to `0.0.0.0`, with a health
endpoint at `/healthz`. It runs on any Node host. No database is required (saved
sorties fall back to browser storage when `DB_*` isn't set).

## Recommended: Render (free, Node-native, ~3 min)

1. Push this repo to GitHub (already on branch `claude/kind-pascal-XE8X9`).
2. In Render: **New ► Blueprint**, connect the repo. Render reads `render.yaml`
   and creates a web service:
   - build: `npm install && npm run build`
   - start: `npm start`
   - health check: `/healthz`
3. (Optional) Add env vars in the dashboard: `DIAG_KEY`, `NMS_API_BASE`,
   `NMS_CLIENT_ID/SECRET`, `TFR_GEOJSON_URL`.
4. Deploy. Render assigns a URL and an auto-managed TLS cert.

## Railway (also easy)

1. **New Project ► Deploy from GitHub repo**, pick this repo.
2. Railway auto-detects Node and runs `npm start` (the `Procfile` confirms it).
   It injects `PORT` automatically.
3. Add the same optional env vars under **Variables**. Deploy.

## Fly.io

`flyctl launch` (accept Node detection), ensure the internal port uses
`process.env.PORT`, then `flyctl deploy`. Health check path: `/healthz`.

## GoDaddy cPanel "Setup Node.js App" (not Airo)

GoDaddy's cPanel/VPS Node hosting runs a real Node process without Airo's
publish gate:
1. Upload the project (or git-clone it) into a folder.
2. cPanel ► **Setup Node.js App** ► create app; set **Application startup file**
   to `server.js`, Application mode **Production**.
3. Run **NPM Install**, then **Start**. cPanel provides the URL/port.

## Managed MySQL (optional)

To sync saved sorties, set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
`DB_PASSWORD` (the app uses `mysql2`, parameterized queries, short-lived
connections). On hosts that only allow outbound 443, use an HTTPS-reachable
MySQL (e.g. PlanetScale). Without a DB, sorties save to the browser.

## Upload gotcha (zip deploys)

If a platform reports `ENOENT … /app/package.json`, the uploaded zip has a
**wrapping folder** (files landed at `/app/<folder>/package.json`). The zip must
have `package.json` at its **root**. The `git archive` zip used here is already
flat — don't unzip-and-re-zip the folder (that re-introduces the wrapper).
