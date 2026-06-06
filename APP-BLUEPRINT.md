# APP BLUEPRINT — C-17 Mission Planner

A feature + architecture spec you can hand to an AI coding tool (drop it in a new
repo as `CLAUDE.md`) to build an app **like this one** from scratch. It describes
*what the app does and how it's built*, not deployment plumbing.

---

## 1. What the app is

An **Electronic Flight Bag (EFB) style web app** that assembles a single,
at-a-glance **mission brief** for long-haul military training sorties
(originally C-17). The pilot enters a sortie plan once and gets, per phase:
live weather, runway/wind analysis, NOTAMs, airspace, hazards, winds aloft,
low-level route data, and bird-strike risk — each evaluated **at the time that
phase actually happens**.

### Non-negotiable principles
1. **Live, authoritative data only. Never fabricate.** If a source is
   unreachable, the UI shows that field/source as **UNAVAILABLE** — it never
   shows fake or placeholder data. Every data pill is LIVE or UNAVAILABLE.
2. **Time-phased.** A sortie spans many hours, so every time-sensitive value is
   computed for the *specific Zulu time* of the phase it belongs to (departure ≠
   low-level entry ≠ landing), not "now".
3. **Near-zero dependencies, no build required.** Backend is the Node standard
   library (`node:http`); frontend is vanilla ES modules. The only optional
   runtime dependency is `mysql2` (for saved sorties). No framework, no bundler.
4. **All times Zulu (UTC).** Inputs are entered in Zulu; output shows
   `Zulu · local` for cross-reference.
5. **Planning aid only** — clearly labeled; limits are user-set placeholders,
   not official aircraft limits.

---

## 2. Core feature: the Sortie Plan (single input panel)

One panel captures the whole flight. Each row is a *(location, Zulu time)* pair:

| Phase | Input | Time used |
|-------|-------|-----------|
| ① Departure (required) | one airfield ICAO | takeoff time |
| ② Low-level (optional) | one or more route IDs (e.g. `IR-154 AR312L`) | route-entry time |
| ③ Recovery (optional) | one airfield ICAO | landing time |
| Alternates (optional) | one or more ICAOs | landing time |

- **Times default to "now" in Zulu** and are clearly marked `Z`.
- Building the brief evaluates **each location at its own time**: winds aloft,
  TAF period, AHAS bird risk, RAIM windows, and airspace active-windows are all
  tailored to that phase's Zulu hour.
- **Out-and-back to the same field works** — it produces two separate cards
  (departure vs recovery) at their different times.
- **Data horizon rule:** for phases far enough in the future (e.g. > 3 h), the
  *current-only* now-cast layers (live METAR context, PIREPs, SIGMETs,
  convective) are **hidden with a note** rather than implied valid; forecastable
  layers (winds aloft, TAF, AHAS, airspace effective windows) remain. A
  near-future phase keeps everything.
- Global inputs: crosswind limit, tailwind limit, high-density-altitude
  threshold, and a list of pattern AGL altitudes. Quick-pick airfield chips drop
  into the last-focused phase field.
- Output is **grouped by phase** (Departure → Low-level → Recovery → Alternates)
  with a per-card role tag and a "planned time" banner showing the lead (e.g.
  "+5h").

---

## 3. Per-airfield brief card

Each airfield renders a card with a GO / CAUTION / NO-GO status light (with an
explained reason list) and tabbed detail:

- **Current observation (METAR):** raw text + decoded wind, temperature,
  altimeter, and computed **density altitude** (flagged if over the threshold).
- **Wind + runway analysis:**
  - Recommended runway (max headwind among open runways).
  - Per-runway head/tail + crosswind components, crosswind side, gust components.
  - **SVG wind compass** showing wind vs the selected runway, color-coded to the
    crosswind limit.
  - **Pattern winds** interpolated to each pattern AGL altitude (with MSL).
  - **Tap any runway to recompute** the wind block for it (compare runways).
  - Cross-references NOTAM runway closures against the wind-favored runway and
    warns if the best runway is closed.
- **TAF:** decoded into periods + raw toggle, each time shown `Zulu · local`,
  with the period covering the phase time highlighted. A field that issues no TAF
  says so (still LIVE) — distinguish "no TAF for this field" from "TAF source
  unreachable."
- **NOTAMs:** categorized (RUNWAY, APPROACH, GPS_RAIM, LIGHTING, OBSTACLE,
  AIRSPACE, BIRD, TAXIWAY, NAVAID, SERVICES, OTHER), collapsible by category,
  with a category filter that shows only the chosen group; significant groups
  open by default.
- **Airspace:** nearby TFRs and Special Use Airspace (MOA / Restricted / Warning
  / Alert) with distance, altitude band, schedule/active state; **RAIM** (GPS)
  predicted-outage windows parsed from NOTAMs.
- **Hazards:** SIGMET/AIRMET and **convective outlook** areas (distance,
  altitude band, valid-until); **PIREPs** near the field.
- **Winds aloft:** low-level profile for the field at the phase time.
- **AHAS bird-strike risk:** LOW/MODERATE/SEVERE with advisory text and the
  **validity time** (the Zulu hour it was pulled for).

---

## 4. Low-level routes (MTR / AR)

Driven by the Low-level phase (route IDs + entry time):

- Supports **IR / VR / SR** military training routes and **AR** air-refueling
  tracks.
- Per route: type, name, controlling agency, refueling altitude block.
- **Per-leg detail:** length, bearing, altitude floor/ceiling (AGL/MSL), width
  left/right, and **leg winds** (head/cross at the leg altitude) at the entry
  time.
- **AHAS bird risk per route** with explicit validity: "valid `<hour>`Z (AHAS
  top-of-hour) · route entry `<entry Z·local>`" so the user can confirm the time
  pulled. If AHAS returns nothing, it says UNAVAILABLE for that entry time (no
  fabrication).
- Routes overlay on the map; multiple routes can be drawn at once.

---

## 5. Supporting tools

- **Route / Climb Winds:** winds-aloft profiles for arbitrary airfields/navaids
  (e.g. climb-out or enroute fixes), with hazardous-wx-near-route banner.
- **Map** (Leaflet-style): status-colored airfields, overlaid routes, **NEXRAD
  radar** (stamped with the actual latest frame time), TFR/SUA polygons,
  SIGMET/PIREP/convective markers, and a "valid times" caption.
- **Export:** one-click **PDF** (print-optimized) and **interactive HTML**
  exports that preserve the theme, collapsible sections, winds, and a radar
  snapshot.
- **Saved sorties:** save/restore the *entire* setup (all phase fields + times +
  limits + winds tool) to browser `localStorage`, or to a managed MySQL database
  when configured (so they sync across devices).

---

## 6. Live data sources (all outbound HTTPS, no key unless noted)

| Domain | Source | Endpoint shape |
|--------|--------|----------------|
| METAR + TAF | NOAA Aviation Weather Center (`aviationweather.gov`) | `/api/data/metar?ids=...&format=json`, `/api/data/taf?...` — **requires a descriptive `User-Agent`** or it 403s |
| Winds aloft | Open-Meteo (`api.open-meteo.com`) | pressure-level forecast by lat/lon/time |
| Convective outlook | NOAA SPC | GeoJSON |
| SIGMET / AIRMET + PIREP | AWC | JSON (PIREP needs a bounding box) |
| Special Use Airspace | FAA ArcGIS (`services6.arcgis.com`) | FeatureServer `query?f=geojson` |
| TFRs | FAA (`tfr.faa.gov`) | list `tfrapi/exportTfrList` + per-NOTAM **AIXM XML** detail (`download/detail_<id>.xml`) |
| NOTAMs (primary) | DoD DAIP (`daip.jcs.mil`) | POST query; **requires trusting the DoD Root CA** (cert chain) |
| NOTAMs (fallback) | FAA NMS | OAuth client-id/secret; flagged if pointed at staging |
| Bird risk (AHAS) | USAF AHAS (`usahas.com`) | per route/airfield, point-in-time at a Zulu hour |
| Radar / map tiles | RainViewer (frame time) + tile provider | tiles + timestamp API |

**Bundled reference data** (static JSON, used at runtime; fixtures only for
tests): airport database (from OurAirports), AHAS route-coverage + airfield-name
index, and AP/1B route geometry (IR/VR/SR + AR tracks).

---

## 7. Architecture

### Backend — zero-dependency `node:http` server
- Serves the JSON API + the static frontend from `/public`.
- Binds `process.env.PORT` on `0.0.0.0`.
- Endpoints:
  - `GET /api/airfields` — known airfield list (for quick chips).
  - `GET /api/brief?ids=...&stops=...&xwind=&tailwind=&highda=&agls=` — the full
    phased brief. `stops` is a pipe-delimited list of `ICAO@ISO@ROLE@Label`.
  - `GET /api/mtr?id=...&when=ISO` — low-level route detail (per-leg winds + AHAS).
  - `GET /api/winds?points=...` — winds-aloft profiles for arbitrary points.
  - `GET /api/sorties` / POST / DELETE — saved sorties (MySQL when configured).
  - `GET /healthz` (+ many aliases) — fast `{ok:true}` for health probes.
  - `GET /api/diag?key=...` — gated diagnostics that probe each source and report
    LIVE state + sample/snippet (for debugging remote deploys; **never open** —
    requires a secret `DIAG_KEY`).
- **Live-only policy in code:** an internal `offline` flag swaps to bundled
  fixtures **for tests only**; production always runs live and returns
  empty/UNAVAILABLE on failure.
- **Resilience patterns:** per-source timeouts (independent, not shared — e.g.
  TAF must not be aborted by METAR's timeout), one retry on slow/transient
  sources, stale-while-revalidate / bounded stale-serve caching for heavy feeds
  (TFR, SUA, AHAS), bounded concurrency for many detail fetches, and graceful
  per-field degradation (one bad record never wipes the working data).
- **Never write to stderr in normal operation** (advisory notices go to stdout)
  — some hosting health monitors treat startup stderr as a failure.

### Frontend — vanilla ES modules, no framework/build
- `app.js` (orchestration + rendering), `map.js` (map/overlays), `export.js`
  (lazy-loaded PDF/HTML export), `timefmt.js` (shared `Zulu · local`
  formatting), `theme.css` (dark EFB theme, mobile-first).
- State-driven map so looked-up routes overlay the brief context.
- Defensive init: a missing/late element never aborts startup; a top-of-page
  error banner surfaces script errors on mobile (no dev console).
- No service worker (a kill-switch unregisters any legacy one); the server sends
  `Cache-Control: no-cache` + `Last-Modified`/304 so deploys never serve stale
  JS.

### Cross-cutting
- **Time handling:** inputs are Zulu wall-clock pinned to UTC; AHAS is
  point-in-time floored to the Zulu hour; winds/TAF aligned to the phase time.
- **Security:** secrets only via env vars; diagnostics behind a key; trust the
  DoD CA *only* for the DAIP request, not globally; bundled CA certs are public.
- **Tests:** `node --test` only (no test framework dependency); pure-logic
  modules (wind components, density altitude, geo, decoders, parsers) are unit
  tested against fixtures.

---

## 8. Design / UX conventions
- Dark, monospace-accented EFB aesthetic; mobile-first responsive layout.
- Every data-source **pill** is tap/hover explained: what it is, its source, and
  LIVE vs why it's UNAVAILABLE.
- Status light per airfield explains *why* it's GO/CAUTION/NO-GO.
- Collapsible sections and per-card tabs keep cards compact; everything expands
  for print/export.

---

## 9. How to adapt this to a different mission/domain
Keep the skeleton — *(location, time) phases → per-phase live data → one brief,
never faked* — and swap the data layer:
1. Replace the source clients (section 6) with your domain's authoritative feeds;
   keep the LIVE/UNAVAILABLE contract and per-source timeouts.
2. Redefine the phases (section 2) and what "time-sensitive" means for each.
3. Reuse the card/tab/status/map/export shells and the Zulu time handling.
4. Keep it dependency-light and host-portable: `process.env.PORT`, `0.0.0.0`,
   `npm start`, a real `build` that emits an output dir, health endpoints, and
   no stderr noise.
