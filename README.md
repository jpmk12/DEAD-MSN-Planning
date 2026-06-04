# C-17 Mission Planner

One-stop planning for C-17 training sorties: weather, NOTAMs, hazards, and —
the headline feature — **wind/pattern analysis** that picks the active runway,
computes head/cross/tailwind components (magnetic↔true done right), and
cross-references NOTAM runway closures against the wind-optimal runway.

See [`PLANNING.md`](./PLANNING.md) for the full design, data-source survey, and roadmap.

## Zero-dependency by design

This app ships with **no npm dependencies and no build step** — just Node
built-ins and a static frontend. That's deliberate: the deploy sandbox blocks
native postinstall binaries (e.g. esbuild), so bundlers like Vite/tsx/vitest
can't run there. Plain JS + static files deploy cleanly anywhere Node runs.

```
server/                 Node backend (built-ins only)
  core/                 pure analysis engine
    geo.js              angle helpers
    wind.js             magnetic→true + head/cross/tailwind components
    density.js          pressure / density altitude
    analyze.js          per-runway analysis, active-runway selection, warnings
    *.test.js           node:test suites (the safety-relevant math)
  data/                 airports.js, awc.js, notams.js, weather.js
  brief.js              assembles weather + analysis + ranked NOTAMs + status
  index.js              HTTP server (API + static), entry point
  cli.js                terminal demo
public/                 static frontend (no framework, no build)
  index.html, app.js, theme.css, manifest.webmanifest, sw.js, icon.svg
data/                   curated airport dataset + offline fixtures
```

## Run it

```bash
npm test          # 26 tests via node --test (no deps, no build)
npm start         # serve the app at http://localhost:8787
npm run demo      # terminal brief for the default airfields
npm run ingest    # refresh data/airports.json from OurAirports (needs network)
```

Then open <http://localhost:8787>. Tick **Use offline/demo data** to run without
network (uses bundled fixtures), or leave it off to pull live AWC weather.

## What it does

- **Weather** — live METAR/TAF from NOAA AWC (free, no key), with density
  altitude, pressure altitude, and ISA deviation computed locally.
- **Wind/pattern analysis** — per-runway head/cross/tailwind, active-runway
  recommendation, gust components, calm/`VRB` handling, and an SVG wind compass.
  Handles the correctness traps: METAR winds are **true**, runway numbers are
  **magnetic**; surveyed heading ≠ designator×10.
- **NOTAMs** — fetched (FAA NOTAM API when `FAA_NOTAM_CLIENT_ID`/`_SECRET` are
  set; fixture otherwise), then **categorized and ranked** so runway/approach/
  lighting items surface first.
- **Any airfield, live** — the bundled set is instant/offline, but any other
  ICAO you type is resolved on demand from OurAirports (public domain) with real
  surveyed runway headings. Cached after first lookup.
- **Winds aloft** — a forecast wind profile (Open-Meteo, free, no key) plus the
  **wind at pattern altitude** resolved onto the recommended runway (head/cross
  components), so you see what the pattern actually flies in.
- **Route / climb winds tool** — enter airfields *or* navaids and get a full
  surface→FL300 wind profile for each (`/api/winds`), for climb-out and en-route
  planning. Flags hazardous wx near each route point and plots the route +
  radar on the map ("radar along route").
- **PIREPs** — live pilot reports (turbulence/icing) near each field and on the
  map, colored by hazard/urgency.
- **Saved sorties** — name and reload a set of airfields + limits; synced
  **across devices** via the platform's managed MySQL when available, else
  browser-local.
- **Decoded TAFs** — raw TAFs decoded into plain-English forecast periods
  (wind/vis/weather/clouds), with a one-click toggle back to raw.
- **Convective outlook** — SPC categorical risk areas (TSTM→HIGH) near each
  field and on the map.
- **Bird/wildlife risk** — an AHAS/BAM-style LOW/MODERATE/SEVERE level per field
  with advisory text; SEVERE drives the status light.
- **Airspace** — TFRs and Special Use Airspace (MOAs, Restricted/Warning/Alert)
  within 100 NM of each field, with distance, altitudes, and active/scheduled
  status. Being inside an active TFR or restricted area drives the status light.
  Live ingest is supported via configurable GeoJSON feature services (FAA
  ArcGIS / OpenAIP) — set `TFR_GEOJSON_URL` / `SUA_GEOJSON_URL`.
- **GPS-RAIM outlook** — predicted outage windows derived from GPS/RAIM NOTAMs
  (the operational signal crews use), with a pointer to FAA SAPT for the
  authoritative satellite-geometry prediction.
- **Map** — a self-contained slippy map (no map library) with a dark basemap,
  a **NEXRAD weather-radar overlay** (toggle + opacity), airfield markers with
  10 NM range rings, and TFR/SUA shapes. Drag to pan, scroll/buttons to zoom.
- **Smart synthesis** — if the wind-optimal runway is closed by NOTAM, the brief
  says so and recommends the best **open** runway. A GO/CAUTION/NO-GO status
  light rolls up wind limits, density altitude, closures, and airspace per field.

## Authoritative airfield data (NASR/OpenAIP seam)

`data/airports.json` ships with a small curated set. To replace it with
authoritative, global data:

```bash
npm run ingest                      # default field set
node scripts/ingest-ourairports.js KCHS KSUU EGLL ETAR   # any ICAOs
```

This pulls [OurAirports](https://ourairports.com/data/) (free, public domain,
worldwide) and writes `data/airports.json` using **surveyed runway TRUE
headings** — which feed the wind engine directly, with no magnetic-variation
guesswork. The engine accepts either an explicit `trueHeading` per runway or a
`magHeading` + field `magVar`, so curated and ingested records interoperate.
Run the ingest wherever outbound network is allowed, then commit the result.

## Live FAA NOTAMs

Set credentials (register a free app at <https://api.faa.gov>) and the brief
switches from the bundled fixture to live NOTAMs automatically:

```bash
cp .env.example .env     # then fill in the two values
```

`.env` is gitignored and loaded at startup by a tiny built-in loader (no deps).
On the deploy host, set `FAA_NOTAM_CLIENT_ID` / `FAA_NOTAM_CLIENT_SECRET` as
environment variables instead.

## Kneeboard PDF

Click **Kneeboard PDF** (or your browser's Print) to produce a print-ready
brief: the dark EFB theme flips to an ink-friendly light layout, on-screen
controls are hidden, a header with ICAOs / generated time / data source is
added, and cards avoid page breaks. Save-as-PDF for a kneeboard copy.

## Deploy (GoDaddy / generic Node host)

- Entry point: `npm start` → `node server/index.js` (also in `Procfile`).
- Binds `0.0.0.0` and respects `process.env.PORT` (defaults to 8787); override
  the host with `HOST` if needed.
- Install step: `npm ci` (or `npm install`) — installs **zero** dependencies
  from the committed `package-lock.json`; no build, no native modules.
- Health check: `GET /healthz` returns `{ "ok": true }`.
- No build, no `npm install` of native deps required.
- Optional env for live NOTAMs: `FAA_NOTAM_CLIENT_ID`, `FAA_NOTAM_CLIENT_SECRET`
  (host env vars, or a `.env` file at the repo root).

## Important caveats

- **Planning aid only — verify with official sources.** Not authoritative.
- The bundled `data/airports.json` is **illustrative**. Run `npm run ingest` to
  replace it with OurAirports data; still verify against FLIP / Chart Supplement
  before operational use.
- Aircraft limits are **user-configurable placeholders**, not official -1/TO
  values (set them in the UI controls or via `xwind`/`tailwind`/`highda` query
  params).

The airspace and TFR/SUA/RAIM data are currently bundled fixtures (the modules
expose a clean seam for live FAA ingest). The map needs runtime network for its
tiles (basemap + radar); offline, the vector overlay still draws airfields and
airspace against the dark backdrop.

## Next steps (see PLANNING.md §5)

Route/low-level support (MTRs) · per-leg fuel & timing · convective SIGMET /
icing / turbulence overlays · saved sortie sets & multi-user sharing.
