# CLAUDE.md — Node.js Hosting

This project is built to deploy on **GoDaddy Node.js Hosting**, a managed
Node.js PaaS. Use this file as context when helping build, debug, or prepare
this app for deployment.

---

## How THIS app meets the requirements

The C-17 Mission Planner is a **zero-dependency, no-build** Node.js app — which
maps cleanly onto Node.js Hosting:

| Requirement | This app |
|---|---|
| Root `package.json` with `start` script | ✅ `"start": "node server/index.js"` |
| Entry point exists | ✅ `server/index.js` |
| Listens on `process.env.PORT` | ✅ `process.env.PORT ?? 8787`, binds `0.0.0.0` |
| Prod deps in `dependencies` (not dev) | ✅ **No dependencies at all** — Node built-ins only |
| `npm install --production` safe | ✅ Nothing to install; no devDeps needed at runtime |
| Build step (if any) defined | ✅ no-op `"build"` script (there is no build) |
| Single app per upload | ✅ single app rooted at `package.json` |
| No hardcoded ports / secrets / local paths | ✅ all paths are module-relative; secrets via env |
| Health check | ✅ `GET /healthz` → `{ "ok": true }` |

**Upload the whole repository folder.** `node_modules` and `.env` are gitignored
and not needed. Static assets are in `public/`, server code in `server/`, data
in `data/`. Optional env vars (set in the Node.js Hosting UI after upload):
`FAA_NOTAM_CLIENT_ID`, `FAA_NOTAM_CLIENT_SECRET`, `TFR_GEOJSON_URL`,
`SUA_GEOJSON_URL` — all optional; without them the app uses bundled demo data.

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

## What the Platform Handles

SSL/TLS certificates, CDN, process management/restarts, and server
infrastructure are all fully managed.

## Pre-Upload Checklist

- [x] `package.json` exists in the root directory
- [x] `package.json` has a `"start"` script
- [x] All production dependencies are in `"dependencies"` (this app has none)
- [x] App listens on `process.env.PORT`
- [x] No hardcoded ports, secrets, or local file paths
- [x] App runs locally with `npm install && npm start`
- [x] `"build"` script is defined (no-op here)

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

## Getting Help

If you run into issues deploying, reach out through the Node.js Hosting
interface or contact GoDaddy support.
