# CLAUDE.md — Node.js Hosting

This project is built to deploy on **GoDaddy Node.js Hosting**, a managed
Node.js PaaS. Use this file as context when helping build, debug, or prepare
this app for deployment.

---

## How THIS app meets the requirements

The C-17 Mission Planner is a **near-zero-dependency, no-build** Node.js app
(one runtime dep, `pg`), which maps cleanly onto Node.js Hosting:

| Requirement | This app |
|---|---|
| Root `package.json` with `start` script | ✅ `"start": "node server/index.js"` |
| Entry point exists | ✅ `server/index.js` (also `main`) |
| Listens on `process.env.PORT` | ✅ `process.env.PORT ?? 8787`, binds `0.0.0.0` |
| Prod deps in `dependencies` (not dev) | ✅ only `pg` (pure JS, no native build) |
| `npm install --production` safe | ✅ installs `pg`; no native postinstall |
| Build step defined | ✅ no-op `"build": "echo build"` |
| Single app per upload | ✅ single app rooted at `package.json` |
| No hardcoded ports / secrets / paths | ✅ module-relative paths; secrets via env |
| **Outbound HTTP/HTTPS only (80/443)** | ✅ all outbound calls are HTTPS: AWC, FAA NOTAM, Open-Meteo, SPC, FAA ArcGIS (SUA), FAA TFR (tfr.faa.gov), map tiles, RainViewer (radar time) |
| **Managed Postgres** | ✅ used for cross-device **saved sorties** (`DATABASE_URL`; falls back to browser-local when unset) |
| Health check | ✅ `GET /healthz` → `{ "ok": true }` |
| Upload < 100 MB | ✅ ~0.3 MB; `node_modules`/caches gitignored |

**Upload the whole repository folder.** `node_modules` and `.env` are gitignored
and not needed. Static assets are in `public/`, server code in `server/`, data
in `data/`. The app is **live-only**: most sources are live with no config
(METAR/TAF via AWC, winds via Open-Meteo, convective via SPC, PIREP/SIGMET via
AWC, SUA via FAA ArcGIS, radar via IEM). When a live source is unreachable the
UI shows it as **UNAVAILABLE** — it never fabricates data. Optional env vars
(set in the Node.js Hosting UI) enable the credential-gated sources:
`NMS_CLIENT_ID`/`NMS_CLIENT_SECRET` or `FAA_NOTAM_CLIENT_ID`/`FAA_NOTAM_CLIENT_SECRET`
(NOTAMs), `TFR_GEOJSON_URL` (TFRs), and optional overrides `SUA_GEOJSON_URL`,
`MTR_GEOJSON_URL`, `CONVECTIVE_GEOJSON_URL`. The bundled `data/fixtures/*` are
used only by the unit tests (via an internal `offline` flag), never in
production.

Validate locally before upload:

```bash
npm install && npm start   # then open http://localhost:8787  (or $PORT)
```

---

## Platform Overview

Node.js Hosting is a managed Node.js PaaS that supports Node.js applications and
static sites. Customers upload their project folder through the GoDaddy
interface — no Docker, no CI/CD pipelines, no infrastructure config needed. The
platform handles SSL, CDN, and server-side compute automatically.

## Deployment Flow

1. Customer uploads their project folder via the Node.js Hosting UI
2. The platform installs dependencies and builds the app
3. The app is deployed to a private preview environment (requires GoDaddy auth to view)
4. Once ready, the customer can publish to production and connect a custom domain

The platform runs `npm install` followed by `npm start` to boot the application.

## Requirements

### package.json
Every project must have a valid `package.json` in the root directory with a
`start` script. This is how the platform knows how to run the app.

### Entry Point
The app needs a clear entry point referenced by the `start` script
(e.g. `node server.js`, `node index.js`, `next start`).

### Port Binding
The app must listen on the port provided by the `PORT` environment variable. Do
not hardcode a port.

```javascript
const port = process.env.PORT || 3000;
```

### Static Sites
For static sites with no server-side logic, include a simple Node server that
serves the static files.

## Single Application Per Upload

Node.js Hosting expects a single application per upload. Monorepos and multi-app
setups are not supported unless a single `npm start` command at the root boots
everything the app needs.

## Environment Variables

- `PORT` is provided automatically by the platform. Always use `process.env.PORT`.
- Additional env vars can be configured through the Node.js Hosting UI after upload.
- Never commit secrets or `.env` files in the upload folder.

## Network Connectivity

Only outbound connections on ports 80 (HTTP) and 443 (HTTPS) are allowed from
the container. Connections to GoDaddy databases are also supported. Do not rely
on arbitrary outbound ports or external services reachable only on non-standard
ports — those connections will be blocked at runtime. Design the app to
communicate over HTTP/HTTPS only.

**This app:** every outbound call is HTTPS — AWC weather
(`aviationweather.gov`), FAA NOTAMs (`external-api.faa.gov`), winds aloft
(`api.open-meteo.com`), optional airspace GeoJSON URLs, and browser map tiles.

## Database (Managed Postgres)

The app deploys on **Render**, whose managed Postgres injects a single
`DATABASE_URL` (discrete `DB_*`/`PG*` vars are also accepted for local dev).
We use the `pg` driver (pure JS, no native build) with a small pooled client and
parameterized queries; SSL is enabled automatically for non-local managed DBs.
Preview and production share the same database.

**Used only for cross-device saved sorties** (`server/data/db.js`): one
`sorties` table (`name` PK, `data` JSONB, `updated_at`) with list/upsert/delete.
When `DATABASE_URL` is unset, `dbConfigured()` is false and the app falls back to
browser-local storage — so the DB is entirely optional.

## What the Platform Handles

SSL/TLS certificates, CDN, process management/restarts, and server
infrastructure are all fully managed.

## Pre-Upload Checklist

- [x] `package.json` exists in the root directory
- [x] `package.json` has a `"start"` script
- [x] All production dependencies are in `"dependencies"` (this app has none)
- [x] App listens on `process.env.PORT`
- [x] No hardcoded ports, secrets, database credentials, or local file paths
- [x] Managed Postgres via `pg` + `DATABASE_URL` (optional; browser-local fallback)
- [x] App runs locally with `npm install && npm start`
- [x] `"build"` script is defined (no-op here)
- [x] All outbound connections use HTTP (80) or HTTPS (443)

## Troubleshooting

### App won't start
- Check that `"start"` exists and the entry point file referenced by it exists.
- Verify all runtime dependencies are under `"dependencies"`.

### Port errors
- Never hardcode a port — always use `process.env.PORT`.
- Bind to `0.0.0.0`, not `localhost`.

### Missing modules
- The platform runs `npm install --production`, so dev dependencies are not
  installed. This app has zero dependencies, so this cannot bite it.

### Build failures
- If a build step is needed, define a `"build"` script and ensure its output
  paths match what `"start"` expects. This app has no build step.

### Blocked outbound connections
- Only ports 80/443 are allowed outbound. Use HTTPS endpoints only. External
  databases must be reachable over HTTPS or use the managed Postgres instance.

## Getting Help

If you run into issues deploying, reach out through the Node.js Hosting
interface or contact GoDaddy support.
