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
npm test          # 21 tests via node --test (no deps, no build)
npm start         # serve the app at http://localhost:8787
npm run demo      # terminal brief for the default airfields
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
- **Smart synthesis** — if the wind-optimal runway is closed by NOTAM, the brief
  says so and recommends the best **open** runway. A GO/CAUTION/NO-GO status
  light rolls up wind limits, density altitude, and closures per field.

## Deploy (GoDaddy / generic Node host)

- Entry point: `npm start` → `node server/index.js`.
- Port: respects `process.env.PORT` (defaults to 8787).
- No build, no `npm install` of native deps required.
- Optional env for live NOTAMs: `FAA_NOTAM_CLIENT_ID`, `FAA_NOTAM_CLIENT_SECRET`.

## Important caveats

- **Planning aid only — verify with official sources.** Not authoritative.
- `data/airports.json` is **illustrative**: runway headings, elevations, and
  magnetic variation are approximate and must be replaced by FAA NASR (CONUS) /
  OpenAIP (OCONUS) before operational use.
- Aircraft limits are **user-configurable placeholders**, not official -1/TO
  values (set them in the UI controls or via `xwind`/`tailwind`/`highda` query
  params).

## Next steps (see PLANNING.md §5)

NASR/OpenAIP ingest · live FAA NOTAM credentials · TFR/SUA/RAIM · AHAS/BAM bird
hazards · winds-aloft for pattern altitude · kneeboard PDF export.
