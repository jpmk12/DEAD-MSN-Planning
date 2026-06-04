# C-17 Mission Planning App — Brainstorm & Design Notes

> Goal: A one-stop mission planning tool for C-17 training sorties. Enter your
> training airfields, get weather, NOTAMs, and hazards in one place — and have
> the app *analyze* the winds to tell you the active runway and crosswind
> component for pattern operations.

---

## 1. The Vision

Most "aviation apps" make you bounce between five tabs to build a picture: one
site for METARs, another for NOTAMs, a PDF for the airfield diagram, a separate
portal for bird hazards. This app collapses that into a single workflow:

1. **Type in your airfields** (departure, training fields, alternates, recovery).
2. App **fetches everything** — weather, TAFs, winds aloft, NOTAMs, TFRs, SUA,
   bird/wildlife hazards, runway/airfield data.
3. App **does the thinking a planner does by hand**: picks the likely active
   runway from the wind, computes headwind/crosswind/tailwind components per
   runway, flags crosswinds that exceed C-17 limits, computes density altitude,
   and surfaces the NOTAMs that actually matter (runway/taxiway closures,
   lighting, approaches out, GPS/RAIM outages).
4. Output a **clean kneeboard-ready brief** you can read at a glance or print.

The differentiator is the **analysis layer** — not just displaying data, but
interpreting it the way a C-17 aircraft commander would.

---

## 2. Core User Workflow

```
[Enter airfields]  →  [Pick sortie window / valid time]
        │
        ▼
[Pull data in parallel] ── weather ── NOTAMs ── hazards ── airfield/runway DB
        │
        ▼
[Analysis engine] ── active rwy ── wind components ── density alt ── crosswind flags
        │
        ▼
[Mission brief view]  →  [Kneeboard export / print / share]
```

Per-airfield "card" shows: field name/ICAO, current + forecast wx, the
**recommended runway with wind component breakdown**, NOTAM highlights, hazard
status, and a go/caution/no-go style color cue.

---

## 3. Data Sources

Organized by category. Government/free sources first; note where military
(CAC-gated) sources give better fidelity.

### 3.1 Weather

| Data | Source | Access | Notes |
|---|---|---|---|
| METAR / TAF | **NOAA Aviation Weather Center** `aviationweather.gov/api/data/metar` (and `/taf`) | Free, no key, JSON | Core source. ~100 req/min limit, 15-day history. API redeveloped 2025. |
| Winds & Temps Aloft (FB) | AWC `/api/data/windtemp` | Free | Needed for the descent/pattern winds and for winds-aloft on the route. |
| PIREPs | AWC `/api/data/pirep` | Free | Turbulence/icing/cloud tops reported by aircraft. |
| Radar / Satellite | NWS / NOAA NEXRAD & GOES tiles | Free | Map overlay for convective awareness. |
| Forecast models | NWS NDFD / NBM, GFS, HRRR | Free (NOMADS) | For the "what will winds be at sortie time" question. |
| Icing / Turbulence | AWC CIP/FIP, GTG | Free | Gridded icing & turbulence forecasts. |
| Lightning | NWS / vendor feeds | Free/paid | Convective proximity. |
| **Military wx** | **557th Weather Wing / OWS, JEEP/N-TFS** | CAC-gated | Higher-fidelity DoD products + mission exec forecasts. Stretch goal — civil AWC covers MVP. |

**Derived from weather (we compute these):**
- **Density altitude** (from elevation, temp, altimeter/QNH) — drives C-17 perf.
- **Pressure altitude**, ISA deviation.
- **Ceiling & visibility** vs approach minimums / pattern VMC.
- **Crosswind / headwind / tailwind** components (see §4 — the headline feature).
- **Gust factor** and whether gusts push crosswind past limits.

### 3.2 NOTAMs & Airspace

| Data | Source | Access | Notes |
|---|---|---|---|
| NOTAMs (civil) | **FAA NOTAM API** (`api.faa.gov`) | Free, requires registered API key | Modern REST feed. Needs a developer-portal account. |
| NOTAMs (DoD/intl) | **DINS — Defense Internet NOTAM Service** (`notams.faa.gov`) | Public web; no clean API | Military & international NOTAMs (FDC, ICAO format). May need scraping/parsing. |
| TFRs | FAA TFR feed (`tfr.faa.gov`) | Free | Temporary flight restrictions — VIP, stadium, fire. |
| Special Use Airspace | FAA SUA / SAA data, NASR | Free | MOAs, restricted/warning areas — schedules + status. |
| GPS / RAIM outages | FAA GPS NOTAMs, RAIM prediction | Free | Big deal for approaches; flag affected fields/times. |

**NOTAM intelligence (the value-add):** raw NOTAMs are an unreadable wall of
abbreviations. The app should **parse, categorize, and rank** them:
- Runway closed / length reduced → top priority (affects rwy selection!).
- Taxiway closures, lighting (PAPI/VASI/REIL/edge), approaches OTS.
- Obstacles (cranes) near the field, displaced thresholds.
- Bird activity NOTAMs, laser, drone/UAS activity.
- Suppress the noise (e.g., distant/irrelevant FDC NOTAMs) by default.

### 3.3 Hazards

| Data | Source | Access | Notes |
|---|---|---|---|
| **Bird/wildlife (dynamic)** | **AHAS — Avian Hazard Advisory System** (`usahas.com`) | DoD system | NEXRAD-driven near-real-time bird risk for MTRs/airfields. |
| Bird (historical/planning) | **BAM — Bird Avoidance Model** | DoD GIS | Seasonal/long-range planning by route & time of day. |
| Obstacles | FAA **Digital Obstacle File (DOF)** | Free | Towers/cranes for pattern & low approach safety. |
| Military Training Routes | FAA / DAFIF **IR/VR routes** | Free/DoD | If the sortie includes low-level. |
| Terrain | SRTM / USGS DEM | Free | MSA-style terrain awareness around the field. |
| Volcanic ash / SIGMETs | AWC SIGMET/AIRMET API | Free | Regional hazards. |

### 3.4 Airfield & Runway Reference Data

This is the backbone — runway headings, lengths, and surfaces feed the wind math.

| Data | Source | Access | Notes |
|---|---|---|---|
| US airfield/runway DB | FAA **NASR** (28-day subscription) | Free | Authoritative US runway hdg/length/width/surface/lighting, mag var. |
| Chart Supplement (A/FD) | FAA | Free | Field elevation, freqs, remarks, declared distances. |
| Global airfields | **OurAirports** + **OpenAIP** | Free/ODbL | Coverage outside the US for OCONUS training. |
| Approach plates / diagrams | FAA d-TPP; **military: FLIP / e-FLIP** | Free / CAC | Military FLIP is the real-world source for crews. |
| Declared distances (TORA/TODA/ASDA/LDA) | NASR / Chart Supplement | Free | Needed for honest runway-vs-required analysis. |
| PCN / weight bearing | Chart Supplement / FLIP | Free/CAC | C-17 is heavy — pavement classification matters. |

---

## 4. The Headline Feature — Wind & Pattern Analysis Engine

This is what makes it "top notch." Given winds + runway geometry, compute and
recommend.

### 4.1 The math

For each runway end, with wind **direction** `wdir` and **speed** `wspd`:

```
θ        = wind_direction − runway_heading        (normalize to −180..+180)
headwind = wspd × cos(θ)        (positive = headwind, negative = tailwind)
crosswind= wspd × sin(θ)        (sign gives left/right; magnitude is what matters)
```

- **Active runway** = the end giving the greatest headwind (least tailwind).
- Report crosswind **magnitude** and **side** (e.g., "18 kt from the right").
- Repeat with **gust** value to show the worst-case crosswind/tailwind.
- Tailwind component flagged explicitly (most jets cap tailwind ~10–15 kt).

### 4.2 The nuances that make it *correct* (where lesser apps get it wrong)

- **Magnetic vs True north.** METAR winds in the raw text are **true**; the
  tower/ATIS reports **magnetic**; runway numbers are **magnetic** heading ÷10.
  The engine must convert using the field's **magnetic variation** (from NASR /
  WMM model) so the component is right. This is the #1 source of bad math in
  naive crosswind tools.
- **Runway heading ≠ runway number × 10.** Use the *actual* surveyed heading
  from NASR, not the rounded designator.
- **Gust handling.** Compute components for steady wind *and* gust; warn if the
  gust crosswind exceeds limits even when the steady value is fine.
- **Variable / calm winds.** Handle `VRB`, `00000KT`, and wind-shift groups
  gracefully rather than crashing or showing garbage.
- **Forecast vs observed.** Run the analysis against METAR (now), the TAF valid
  at sortie time, *and* winds-aloft for the pattern altitude.
- **Density altitude** shown alongside — high DA lengthens the C-17's required
  runway and degrades single-engine/go-around performance.

### 4.3 C-17-specific layer

- **Crosswind limits.** Encode the C-17's demonstrated/operational crosswind and
  tailwind limits (steady & gust) and color-code: green / caution / exceeds.
  *(Exact numbers to be sourced from the -1 / TO — leave configurable.)*
- **Assault / unimproved strip considerations** if training assault landings
  (shorter LZs, dirt, different limits).
- **Runway-required vs available** using TOLD-style inputs (weight, DA, slope,
  contamination) against declared distances — at least a coarse advisory.
- **Pattern direction** (left/right traffic) and whether terrain/SUA constrains
  the pattern on the favored runway.

---

## 5. Feature Roadmap

**MVP (the 80% value):**
- Multi-airfield entry (ICAO/IATA/FAA IDs), saved "sortie" sets.
- METAR + TAF fetch and clean decode.
- Runway DB lookup + **wind component analysis with active-runway recommendation**.
- Density altitude.
- NOTAM fetch with basic categorization (runway/lighting/approach highlights).
- Per-field card UI + go/caution color cue.

**V2:**
- Winds aloft for pattern altitude; gust-aware crosswind warnings.
- TFRs, SUA status, GPS/RAIM outages.
- AHAS/BAM bird hazard integration.
- Kneeboard PDF export / print layout.
- Map view with wx radar + airspace overlays.

**V3 / "top notch":**
- C-17 TOLD-lite runway analysis (weight/DA/contamination → required distance).
- Forecast timeline scrubber (drag through the sortie window, watch rwy/xwind change).
- Route/low-level support (MTRs, AHAS along route).
- Military FLIP / DINS integration (CAC).
- Save & share briefs; offline cache for in-flight reference.

---

## 6. Architecture & Tech (proposed, open to change)

- **Backend / data layer:** a service that fans out to the data-source APIs in
  parallel, normalizes responses, and caches (weather ~5–15 min, NASR per
  28-day cycle). Keeps API keys (FAA NOTAM) server-side.
- **Analysis engine:** a well-tested, pure module for the wind/DA/component math
  (unit tests are essential — this is safety-relevant; a sign error is a real
  hazard). Magnetic variation via the World Magnetic Model.
- **Reference data:** ingest NASR + OurAirports/OpenAIP into a local DB so
  runway lookups are instant and work offline.
- **Frontend:** web app (works on EFB/iPad and laptop), responsive, printable
  kneeboard view. PWA for offline.
- **Stack options:** Python (FastAPI) or Node/TypeScript backend; React/Next
  frontend. TypeScript end-to-end is attractive for sharing the math + types.

---

## 7. Key Risks / Things to Nail

- **Correctness of the wind math** (mag/true, sign conventions) — needs tests
  against known cases. Safety-of-flight relevant.
- **NOTAM parsing** is genuinely hard (cryptic, inconsistent) — start with
  categorize-and-highlight, not full natural-language decode.
- **Access to DoD sources** (AHAS, FLIP, DINS, 557th) may need CAC / agreements;
  design so civil sources cover MVP and mil sources slot in later.
- **Currency/disclaimers.** This is a *planning aid*, not an authoritative
  source — always show data age and "verify with official sources" framing.
- **Data licensing** (OpenAIP ODbL, vendor terms) before any redistribution.

---

## 8. Decisions I Need From You

1. **Platform priority** — iPad/EFB-first, laptop/web-first, or both equally?
2. **CONUS only or OCONUS too?** (Drives whether we lean FAA-only or add
   OpenAIP/global + DINS international NOTAMs.)
3. **CAC / DoD data** — do you have access we can build against (FLIP, AHAS,
   557th), or keep it to public/civil sources for now?
4. **C-17 limits** — can you provide the official crosswind/tailwind limit
   numbers, or should they be user-configurable placeholders?
5. **Online-only or offline-capable?** (Offline = heavier local data caching.)
6. **Just you, or your squadron?** (Solo tool vs multi-user accounts/sharing.)
