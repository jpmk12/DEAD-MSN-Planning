# NEXT-LEVEL-PLAN — Weather-Anticipation Run (Phase 0 Audit)

> North star: the aircraft commander sees **where and when weather threatens the
> sortie — departure, AR track, low-level, recovery, alternates — and what to do
> about it**, earlier and more clearly than today. Scope: **CONUS only** this
> run; OCONUS is designed-for and captured in §6 as a 2.0 roadmap.
>
> Status: audit complete, **no feature code written**. Implementation starts on
> sign-off, in the commit order of §7.

---

## 1. Architecture map & honest assessment of the weather pipeline

### 1.1 Map (current)

```
public/app.js (vanilla, 75KB)         server/index.js (HTTP, auth, rate-limit)
  sortie panel (per-phase Zulu times)   /api/brief ──► server/brief.js
  map.js (slippy map, overlays)              fan-out: weather │ notams │ tfr │ sua
  refcard links (Build PDF)                  │ sigmet │ pirep │ convective │ mtr
                                             │ birds(AHAS, per-stop-time)
server/core/* (pure, tested)                 │ windsaloft(Open-Meteo, per-stop-time)
  wind.js  mag↔true, components         /api/route  ──► server/route.js (fix/navaid/
  density.js PA/DA                            airway/SID-STAR/radial-DME/MTR resolver)
  analyze.js runway selection, warnings /api/mtr, /api/winds, /api/refcard, /api/diag
server/data/* (one module per source; fixtures for tests; TTL caches on
  AHAS / GeoJSON / TFR-detail; NO cache on METAR/TAF/Open-Meteo)
```

Bundled reference data (offline-capable): `airports.json`, NASR `fixes.json`
(70k), `navaids.json` (1.5k incl. TACAN + declination), `airways.json` (1.5k),
CIFP `procedures.json`, AP/1B `mtr-ap1b.json` + `ar-ap1b.json`.

### 1.2 Where the pipeline is genuinely time-aware vs "now-only"

| Layer | Time-aware today? | Honest gap |
|---|---|---|
| **METAR → runway/crosswind/DA → GO/NO-GO** | ❌ **Now-only.** `analyzeAirfield` runs on the *current* METAR even for a stop 6 h out. The status light on the Recovery card is computed from the wind blowing **now**. | **The single biggest gap.** TAF is fetched but never analyzed. |
| TAF | Fetched + decoded **for display only** (`taf.js` produces text periods; `from/to` are display strings, not machine times) | Cannot answer "what does the TAF say at 2015Z?" programmatically. |
| Winds aloft (Open-Meteo) | ✅ per-stop hour (`findHourIndex`) | ❌ `forecast_days:'1'` = **today (GMT) only**; a stop tomorrow **silently clamps** to 23Z today (R2, §4). No TTL cache — refetched per brief. |
| AHAS bird risk | ✅ per-stop Zulu hour; 12-hr product in refcard | Product is 12 h — no flag when the stop is beyond coverage. |
| SIGMET / PIREP / convective | Now-casts, **hidden** beyond 180 min with a note (good honesty mechanism) | Hidden ≠ replaced: nothing forecast-grade (CIP/FIP icing, GTG turbulence, SPC hourly) fills the hole for the future phase. |
| TFR / SUA | Geometry + schedule text shown | `effectiveStart/End` **not evaluated against the stop time** — a TFR that ends before takeoff still alerts. |
| Density altitude | ❌ Current METAR temp/altimeter only | No DA estimate at a future takeoff/recovery time (Open-Meteo has hourly temp/pressure — unused). |
| Ceiling / visibility | ❌ **Not analyzed at all** | No ceiling/vis extraction vs configurable minimums — PLANNING §3.1 lists it as a derived product; it was never built. The hazard ribbon needs it. |

**Bottom line:** the app's *data plumbing* for time (per-phase Zulu times,
per-stop fetch keys, the horizon-hiding) is solid, but the *analysis* layer is
anchored to "now." The leverage is in making the existing safety math run
against forecast inputs at each phase's time.

---

## 2. Top improvements, ranked impact × effort

| # | Improvement | Impact | Effort | Why / files |
|---|---|---|---|---|
| 1 | **Fix the winds-aloft window + out-of-range flag.** Request enough `forecast_days` to cover the latest stop (cap 3); when the target hour is outside coverage, mark the result `clamped:true` and show data age, never silently use 23Z-today. | High (correctness/honesty) | **Low** | `server/data/windsaloft.js`, `brief.js`, `app.js` label |
| 2 | **VRB/gust safety warning** (R1, §4). VRB 15G25 currently shows 0 kt crosswind and no warning. If wind is variable and speed/gust exceeds the crosswind limit, warn "variable wind — crosswind may reach NN kt on any runway." | High (safety) | **Low** | `core/analyze.js` + tests |
| 3 | **Machine-decode TAF validity** — parse FM/BECMG/TEMPO/PROB groups into real UTC intervals with wind/vis/ceiling per period, exposing `tafAt(when)`. Foundation for everything below. | High | Medium | `server/data/taf.js` (+ golden tests) |
| 4 | **Forecast-aware analysis at each stop's time.** Run the same `windComponents`/runway-selection math against `tafAt(stop.when)` wind; drive each phase card's status from the phase-appropriate source (METAR for near, TAF for future) and show both ("now vs at ETA"). | **Highest** (north star) | Medium | `core/analyze.js`, `brief.js`, `app.js` |
| 5 | **Ceiling/vis extraction + classification** vs configurable minimums (current METAR + TAF-at-ETA), feeding status + ribbon. | High | Medium | `taf.js`, `awc.js`, `analyze.js`, settings UI |
| 6 | **Sortie timeline / scrubber.** Hour-by-hour series per field across the window: surface wind → active rwy + crosswind, ceiling/vis class, DA, AHAS, status. Key insight: **one Open-Meteo call already returns all hours** and one TAF covers the window — the series is *local computation over data we already fetch once*. | **Highest** (north star) | High | new `server/timeline.js`, `/api/timeline`, new UI panel |
| 7 | **Route-and-time hazard ribbon.** Lay the phases (dep → AR197H block → IR154 legs → recovery → alternate) on a time axis against hazards: convective/SPC, SIGMET (near-term), winds at AR block altitude, AHAS per segment, ceiling/vis class. One screen = the CADDO10 view (§5). | **Highest** | High | builds on 3–6; `public/` new view |
| 8 | **Forecast-aware alternate ranking at ETA** — rank `sp-alt` fields by TAF-at-ETA vs minimums + crosswind, not current wx. | High | Medium (cheap after 3–5) | `brief.js`, `app.js` |
| 9 | **Per-source timing/health instrumentation** in `/api/diag` (and `[timing]` log line per brief): measure the real live-source latencies on Render — the numbers §3 can't capture from this sandbox — then optimize what's actually slow. | Medium (enables perf work) | **Low** | `brief.js`, `index.js` |
| 10 | **METAR/TAF/Open-Meteo TTL cache (~5 min)** — today every brief refetches everything; the scrubber and degradation-watch multiply reads. Also dedupes the winds fetch the route-winds tool repeats. | Medium | Low | `weather.js`, `windsaloft.js` |
| 11 | **Degradation watch** — on refresh, compare TAF issue time + worst period vs the previous fetch; flag fields trending toward CAUTION/NO-GO during the window. | Medium | Medium | server cache + `app.js` banner |
| 12 | **Time-filter TFR/SUA alerts** against the stop time (`effectiveStart/End`), with "active at your ETA" wording. | Medium | Low | `brief.js` |

Sequencing rationale: 1–2 are small correctness/safety wins shipped first; 3 is
the foundation; 4–5 convert the existing safety math to forecast inputs; 6–7
are the visible north-star features built on that; 8, 11, 12 are fast follows.

---

## 3. Performance pass — measured baselines

Measured in this sandbox (no network egress, so **offline** paths; live-source
latency must be measured on Render — that's improvement #9, first commit).

| Measurement | Result |
|---|---|
| `/api/brief` offline, 3-stop sortie, **warm** | **4–7 ms**, 20.5 KB payload |
| `/api/brief` offline, **cold** (first request) | 358 ms (module + data load) |
| `/api/route` offline (`KLTS MMB270030 FLOYD IR-154.C-M`), warm | 2.5 ms |
| `/api/route` cold | 740 ms (dominated by `fixes.json` parse) |
| `data/fixes.json` (2.1 MB) cold parse | **199 ms** (one-time per process) |
| Other datasets (airways/navaids/procedures) cold parse | 5.2 / 1.7 / 1.5 ms |
| Frontend assets (unminified, no build) | 146 KB total (app.js 75 KB) |
| Test suite (`node --test`, 145 tests) | 2.1 s |

**Conclusions:**
- **Offline assembly is not a hot path.** Brief assembly overhead is single-digit
  ms; the brief's latency in production is entirely **live-source fan-out**, which
  is already parallelized (total = slowest source, not the sum).
- Known production bottlenecks from past debugging (to be confirmed by #9's
  instrumentation): nationwide SUA query used to exceed 20 s (fixed via bbox);
  AHAS calls time-bound at 8 s; TAF fetch up to 12 s with retry; DAIP NOTAMs
  multi-second. **No optimization will be merged without a measured baseline
  from `/api/diag` timings on Render first.**
- Concrete optimizations queued behind measurement: (a) METAR/TAF/Open-Meteo
  TTL cache (#10) — also a *correctness* enabler for the scrubber; (b) reuse the
  single Open-Meteo response across all hours of the timeline (zero extra
  network for #6); (c) warm `fixes.json` at boot (199 ms off the first route
  call); (d) keep payload trims (map layers already trimmed to 300 NM).

---

## 4. Correctness risks in the wind / DA / component math

Audited `core/wind.js`, `core/density.js`, `core/analyze.js`, `windsaloft.js`,
`awc.js`. The core conventions are right: METAR `wdir` is TRUE (AWC decoded
JSON), runway `trueHeading` is preferred over mag+var, magVar is signed
EAST-positive, `signedDiff` gives the correct crosswind side, gusts are
computed separately. 18 tests cover the sign conventions. Risks found:

| # | Risk | Proving test case |
|---|---|---|
| R1 | **VRB/gusty wind reports zero crosswind with no warning.** `windIsIndeterminate` zeroes all components for `VRB` — correct for runway *selection*, but `VRB15G25KT` renders as 0 kt crosswind, GO. A variable wind can put its full speed as crosswind on any runway. | `analyzeAirfield(apt, {wind:{dirTrue:'VRB',speedKt:15,gustKt:25}}, {crosswindKt:20})` must yield a warning ("variable wind — up to 25 kt crosswind possible") and not status GO. |
| R2 | **Winds-aloft silently clamps to today.** `buildUrl` pins `forecast_days:'1'`; `findHourIndex` returns the last index ≤ target — for a stop tomorrow that's **23Z today**, labeled but easy to miss. | `findHourIndex(times_for_today, '2026-06-12T18:00Z')` currently returns `23`; after fix, result carries `clamped:true` and the UI shows UNAVAILABLE/data-age, never a silent wrong-day wind. |
| R3 | **TAF periods are not machine-comparable.** `decodeTaf` stores `from/to` as display strings (`"111415"` → text), so no code can select the period valid at a stop time. | `tafAt(decoded, '2026-06-11T20:15Z')` (new) returns the FM/BECMG period containing 2015Z with parsed wind `{dirTrue, speedKt, gustKt}`; TEMPO/PROB returned as caveats. Golden TAFs incl. month rollover (valid 3023/0124). |
| R4 | **DA at future phases uses now-METAR temp/QNH.** A 1415Z DA shown on a card whose phase is 2015Z. | After #6: DA series from Open-Meteo hourly temp/pressure; test that the 2015Z DA uses the 2015Z sample. |
| R5 | **TFR/SUA alerts ignore effective times** vs the stop time (flags a TFR that expires before takeoff; misses one that starts after "now" but before ETA). | Stop at T+4 h vs TFR ending T+1 h → no alert; TFR starting T+2 h → alert "active at ETA." |
| R6 | **`magVar` fallback of 0** when a record has neither surveyed `trueHeading` nor variation (`analyze.js:19`) — fine for the bundled NASR-true-heading fields, wrong by up to ~15° CONUS for a sparse OurAirports record. | Airport fixture with only `magHeading` + missing magVar must surface a "true heading unverified" caveat rather than quietly assuming 0. |
| R7 | AHAS stop times beyond the 12-h product window aren't flagged. | Stop at T+18 h → bird risk shows UNAVAILABLE-with-reason, not the T+12 value. |

(The `density.js` approximations — PA = elev + (29.92 − altim)×1000, DA = PA +
120×ISA-dev — are the standard field formulas, documented as approximate; no
change recommended.)

---

## 5. Worked example — CADDO10 (11 Jun 2026, KLTS, 6.0 hr) as the canonical fixture

The timeline (#6) and ribbon (#7) will be designed and demoed against this
sortie, wired as an **offline demo scenario** (new fixtures keyed to the
mission, loaded via the existing `offline` flag + a `?demo=caddo10` hook):

```
1415Z KLTS T/O ──► climb ──► 1700–1835Z AR197H (KC-46, RZ-G) ──► 1835–1900Z transit
      ──► 1900–1934Z IR154 low level (SCLZ TOT 1914Z, STLZ TOT 1931Z) ──► 2015Z KLTS land
```

What the one-screen view answers, phase by phase (all from sources already
integrated): **1415Z KLTS** — TAF-at-1415 wind → active rwy + crosswind/gust,
ceiling/vis class, DA, SPC/convective proximity, AHAS hour risk. **AR197H
block** — winds + temp at the refuel altitudes (Open-Meteo pressure levels
already span FL300), convective along the track polyline. **IR154 1900–1934Z** —
per-segment AHAS (already built), low-level winds per leg (already built),
ceiling/vis vs LL minimums from the nearest TAFs, TOT hour highlighted.
**2015Z KLTS** — TAF-at-2015 wind/ceiling/vis + ranked alternate (KAMA) at the
same ETA. Existing AP/1B data covers AR197H and IR154 with labeled points; the
LZs (SCLZ/STLZ) enter as named fixture points. Fixtures: a crafted KLTS/KAMA
TAF spanning 1415–2015Z with a deliberate BECMG degradation, an Open-Meteo
sample with hourly coverage of the window, and an AHAS 12-h sample — so the
demo shows a *decision* (e.g., recovery trending to CAUTION → alternate ranked
GO), not just data.

UI shape (to be screenshot-verified against "legible on an iPad EFB"): a
horizontal Zulu time axis 1400–2030Z; one row per phase/location; cell color =
status at that hour; scrubbing moves a time cursor that updates the existing
field cards. The ribbon is the same data rendered route-first.

---

## 6. OCONUS 2.0 roadmap (designed-for, NOT built this run)

Current seams that make this clean later — preserve them:
`getAirport()` resolver chain (bundled → OurAirports) is where a **global
OpenAIP ingest** slots in; `fetchNotams()` source chain (DAIP → NMS → FAA) is
where **DINS international** NOTAMs join; `resolveNavaid()` already prefers
bundled NASR then falls back, so an international navaid source is additive;
`magToTrue()` is a pure seam for a **WMM (World Magnetic Model) evaluation**.

2.0 work, scoped: (a) OpenAIP/OurAirports global airfield+runway ingest with
surveyed-true-heading audit (many OCONUS records lack `_degT` — R6 becomes a
blocker, so ship the WMM model with per-date variation first); (b) DINS
parsing for ICAO-format international NOTAMs; (c) unit/format handling (QNH in
hPa display, metric vis, ICAO TAF differences); (d) AHAS doesn't exist OCONUS —
fall back to BAM-style seasonal data + bird NOTAMs with explicit
source labeling; (e) multi-alternate logic across long ETOPS-style legs; (f)
extend `windsaloft` coverage checks for date-line/longitude edge cases.
**This run:** keep mag↔true intact and tested (CONUS var runs ~0–15°), and add
the R6 caveat so the 2.0 ingest has a guardrail already in place.

---

## 7. Implementation order (after sign-off)

Small, reviewable commits, `npm test` green at every step, screenshots for UI:

1. **Instrumentation** (#9): per-source ms in `/api/diag` + `[timing]` log. → get Render baselines.
2. **Correctness trio** (#1, #2, #12 + R6/R7 caveats): winds-aloft window/clamp flag, VRB/gust warning, TFR/SUA time filter. Tests first.
3. **TAF machine decode** (#3) with golden-case suite (incl. month rollover, PROB30 TEMPO, wind-shift).
4. **Forecast-aware phase analysis** (#4) + **ceiling/vis classification** (#5): cards show "now vs at ETA," status driven by phase-appropriate source.
5. **Caching** (#10) — measured before/after from step 1's numbers.
6. **Timeline/scrubber** (#6) + CADDO10 offline demo fixture; screenshot-verify EFB legibility.
7. **Hazard ribbon** (#7) over the same series; kneeboard/print check.
8. **Alternate ranking at ETA** (#8) and **degradation watch** (#11).

Definition of done per the brief: one screen answers "where and when does
weather threaten CADDO10, and what do I do about it" — with no fabricated data,
visible data ages, configurable limits only, and the zero-dependency constraint
intact.
