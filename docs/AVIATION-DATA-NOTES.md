# Aviation Weather / Airspace / NOTAMs — Implementation Knowledge Transfer

A distilled, framework-agnostic guide from building this flight-planning tool.
Covers **free/key-less data sources, exact endpoints, response shapes, parsing
rules, and the correctness traps that bite everyone.** All sources are HTTPS
(port 443) and most need no API key. Paste this into another project to skip the
painful discovery.

## 0. Design principles that mattered most
- **Never fabricate. Degrade to "UNAVAILABLE."** Every source can fail; when it
  does, show "unavailable," not a guessed/empty-but-plausible value. Track a
  per-source `live` boolean and surface it. (Biggest single safety lesson — see
  the RAIM trap below.)
- **Fan out in parallel; total latency = slowest source, not the sum.** Fire all
  fetches concurrently; chain only true dependencies.
- **Compute locally what you can** (density altitude, wind components, flight
  category, sun/moon, great-circle/ETP) — no key, no latency, testable. Reserve
  the network for observations/forecasts/NOTAMs.
- **Bundle a fallback fixture** per source so the UI/tests work offline.
- **A "lite" fetch mode** for dashboards: skip per-field heavy fetches
  (winds-aloft, astronomy) that the summary view doesn't display.

## 1. Weather

**METAR + TAF — NOAA Aviation Weather Center (free, no key):**
- `GET https://aviationweather.gov/api/data/metar?ids=KCHS,KSUU&format=json`
- `GET https://aviationweather.gov/api/data/taf?ids=KCHS&format=json`
- `format=json` returns decoded numeric fields. **TRAP: wind direction is
  referenced to TRUE north** (ICAO/WMO), but **runway numbers are MAGNETIC**.
  Convert everything to TRUE internally: `true = magnetic + magVar` (magVar
  EAST-positive). Surveyed runway true headings ≠ designator×10. Getting this
  wrong silently inverts crosswind side.

**Flight-category thresholds (ceiling ft / vis SM), worst of the two wins:**
```
LIFR: ceil < 500  OR vis < 1
IFR:  ceil < 1000 OR vis < 3
MVFR: ceil <= 3000 OR vis <= 5
VFR:  else
```

**Density / pressure altitude:** compute locally from elevation, altimeter, temp
(ISA deviation). No service needed.

**Winds aloft (forecast profile) — Open-Meteo (free, no key):**
- `GET https://api.open-meteo.com/v1/forecast?...` with pressure-level wind/temp/RH
  variables → build a surface→~FL340 profile. Interpolate to any altitude for
  head/cross components and pattern winds. **TRAP:** profiles top out ~FL340
  (250 hPa); clamp above that and say so. Tropopause = lowest level where lapse
  rate < 2 °C/km; "max wind" = strongest level — both derivable from the profile.
- **Structural-icing potential** is honest only as "potential": flag layers in the
  0…−20 °C band with RH ≥ 70% (≥85% = wet), and label it "needs visible moisture."

**SIGMET / AIRMET — AWC:** `https://aviationweather.gov/api/data/airsigmet?format=json`.
Each has `coords` (polygon as `{lat,lon}[]`), `hazard`, `altitudeLow1/Hi1`,
`validTimeFrom/To`. **TRAP: filter by ALTITUDE, not just horizontal distance** —
a surface route should not be flagged by an FL300 turbulence SIGMET. Require the
advisory's altitude band to overlap the route's (with a generous pad for
AGL-vs-MSL ambiguity).

**G-AIRMET (graphical) — AWC:** `https://aviationweather.gov/api/data/gairmet?format=json`.
Hazards `TURB-HI/TURB-LO/ICE/IFR/MT_OBSC/LLWS/SFC_WND/FZLVL` at fixed forecast
hours. Field names shift across AWC versions — **map defensively** (accept
`coords|geom`, `base/top` vs `altitudeLow1/Hi1`, FL/SFC altitude strings) and
yield `[]` on an unrecognized shape.

**PIREPs — AWC:** `https://aviationweather.gov/api/data/pirep?format=json&age=2&bbox=...`.
Keep only actionable (turb/ice/urgent). **TRAP: filter by altitude band too**
(±~4000 ft); reports with unknown altitude are kept.

**Convective outlook — SPC:** `https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson`
(TSTM→MRGL→SLGT→ENH→MDT→HIGH). It's a *surface* categorical risk — don't
altitude-filter it.

> Honesty note on radar: public NEXRAD has **no multi-hour forecast** (≈2 h past
> + ≈30 min nowcast, via RainViewer `https://api.rainviewer.com/public/weather-maps.json`).
> For times beyond that, show the convective outlook as a surrogate and label
> radar unavailable.

## 2. Airspace

**TFRs — FAA:** `https://tfr.faa.gov/tfrapi/exportTfrList` (list) +
`https://tfr.faa.gov/download/detail_<id>` (geometry). Parse to polygons with
upper altitude + effective end. "Inside an active TFR" should drive a
caution/no-go.

**Special Use Airspace (MOA/Restricted/Warning/Alert) — FAA ArcGIS (free):**
`https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Special_Use_Airspace/FeatureServer/0/query?outFields=*&geometry=<bbox>&...&f=geojson`.
Carry active/scheduled/cold status. Make feeds **env-overridable**
(`SUA_GEOJSON_URL`, `TFR_GEOJSON_URL`) so you can swap sources (FAA/OpenAIP)
without code changes.

**Proximity model:** convert GeoJSON `[lon,lat]` → `[lat,lon]` (easy to flip!),
then compute closest approach of a point/route to each polygon/circle/line; tag
each with `distanceNm` (0 = overhead/inside). Reuse the same primitive for
SIGMET/SUA/TFR/PIREP/route hazards.

## 3. NOTAMs

**Sources, in preference order:**
1. **FAA NMS-API** (modern) — OAuth2 client-credentials; set `NMS_CLIENT_ID`/
   `NMS_CLIENT_SECRET`. Host: `api-nms.aim.faa.gov`.
2. **Legacy FAA NOTAM API** — `https://external-api.faa.gov/notamapi/v1/notams`
   with client id/secret headers.
3. **DoD DAIP** — `https://www.daip.jcs.mil/daip/mobile/query` (POST JSON,
   `type:"LOCATION"`). **TRAP: DAIP serves a DoD-PKI server cert** whose CA isn't
   in the public trust store — you must trust the **DoD CA bundle** (PEM) *scoped
   to the request* (CAs + public roots), not globally. Without it, every call
   fails `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.

**Categorize + rank** so the important stuff floats up (first-match-wins regex):
`RUNWAY (RWY…CLSD bumped highest) > APPROACH (ILS/RNAV U/S) > GPS_RAIM > LIGHTING
> OBSTACLE > AIRSPACE > BIRD > TAXIWAY > NAVAID > SERVICES > OTHER`.

**Runway closure parse:** `/RWY\s+([0-9LRC/]+)\s+(?:CLSD|CLOSED)/i` →
cross-reference against the wind-optimal runway; if it's closed, recommend the
best **open** one. NOTAM end time from the `C)` field `YYMMDDHHMM` Zulu.

**Runway surface condition (winter ops):** parse FICON / **RwyCC triplet**
(`5/5/2`, worst digit drives severity) / **RCR** / braking-action words from
NOTAM text.

**GPS/RAIM outlook — derived from NOTAMs, not a live SAPT calc.** Filter
`GPS_RAIM`-category NOTAMs; extract `HHMM-HHMM` Zulu outage windows.
> **The single most important honesty trap we hit:** when the NOTAM feed is
> *unavailable*, "no RAIM NOTAM found" does **NOT** mean "no outage." Return
> **UNKNOWN** (and point users to FAA SAPT, `sapt.faa.gov`), never a false
> "clear." Drive this off a real `notamsLive`/`feed-returned-data` boolean —
> **not** off `source` being truthy (a `source:"unavailable"` string is still
> truthy and will fool you). This generalizes: any "absence of bad news"
> indicator must distinguish "checked, clean" from "couldn't check."

## 4. Oceanic tracks (NAT / PACOTS) — coordinate-decoding gotchas
- **NAT** (FAA `https://nms.aim.faa.gov/nat`, plain-text TMI): tracks are a letter
  + waypoint chain mixing named fixes and lat/lon. **TRAP: half-degree DDMM
  coords** — `5730/30` = 57°30′N 030°W (not 5730°). Decode: 4–5 digit group →
  `deg + min/60`. Direction comes from which of EAST/WEST `LVLS` is populated.
- **PACOTS** (DoD DAIP, `type:"PACIFIC_TRACKS"`, needs the DoD CA): two encodings
  — Oakland `(TDM TRK J … 36N140W 29N180E …)` and Fukuoka
  `TRACK 1. FLEX ROUTE : KALNA 41N160E …`. **TRAP: Pacific crosses the date line**
  — handle both E and W longitudes (`29N180E` → +180, `43N170W` → −170). When
  drawing, **"unwrap" polyline longitudes** (keep each point within 180° of the
  previous) or a date-line-crossing line streaks across the whole map.
- **Named oceanic fixes** (DOGAL/RESNO/…) aren't in the US FAA fix DB — resolve
  what you can, **skip+report the rest**; lat/lon points carry the geometry
  regardless.

## 5. Airfield reference data
**OurAirports (public domain):**
`https://davidmegginson.github.io/ourairports-data/{airports,runways,navaids}.csv`.
Global coverage with **surveyed TRUE runway headings** (no magnetic guesswork).
Key by ICAO only — IATA/local codes collide with navaid idents. Bundle a curated
subset (large+medium, runways) for instant/offline resolution; live-resolve the
long tail.

## 6. Cross-cutting gotchas checklist
- GeoJSON is `[lon,lat]`; aviation thinks `[lat,lon]`. Flip on ingest.
- METAR wind TRUE vs runway MAGNETIC (the classic).
- Altitude-filter SIGMET/AIRMET/PIREP against the route's vertical band.
- Date-line longitude unwrap for Pacific geometry.
- Half-degree (DDMM) oceanic coordinates.
- "Absence of a bad NOTAM" ≠ "all clear" when the feed is down → UNKNOWN.
- Bound user inputs (waypoint count, search radius) so one request can't amplify
  into hundreds of upstream calls.
- Cap/length-limit external text before regex (ReDoS) and escape all fetched text
  before putting it in HTML.
- Roll a single **GO / CAUTION / NO-GO** status per field from: wind/crosswind vs
  limits, ceiling/vis vs minimums, runway closures, active TFR/restricted
  airspace, RAIM outage, severe bird risk, overhead convective/SIGMET — and keep
  the *reasons* so the status can explain itself.

## 7. Other sources used (reference)
- **Bird/wildlife (AHAS, US only):** `https://www.usahas.com/webservices/...` (SOAP).
- **Astronomy (sun/moon, NVG illumination):** computed locally; cross-checked
  against USNO when available.
- **Enroute fixes (US):** FAA NASR FIX data (bundled). International/oceanic fixes
  are NOT in it — that's a known coverage gap.
- **Map:** dark basemap (CARTO `dark_all`), radar (IEM NEXRAD static or RainViewer
  animated). See `docs/WEATHER-MAP-SPEC.md`.
