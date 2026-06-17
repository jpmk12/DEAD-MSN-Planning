# DEAD Planning — Forward Roadmap

Living plan for what's next. Grouped by horizon and tagged with **value**,
**effort**, and **blocker** (what it depends on). Most-recent state first.

## Where we are (done)
- **Local brief** — METAR/TAF, wind/pattern analysis (true-vs-mag), density alt,
  NOTAMs (categorized/ranked), TFR/SUA, AHAS birds, RAIM, SIGMET/AIRMET/G-AIRMET,
  PIREP, convective, runway condition (FICON/RCR), winds aloft + tropopause/max-wind.
- **Global tab** — paste ICAOs / lat-lon / fixes (or a whole NAT track); great-circle
  legs, wind-corrected ETAs, per-stop briefs, **ETP + diversions**, NAT/PACOTS on
  the map; **area NOTAMs** at ETP/coordinate waypoints (AREA_BRIEFING).
- **AMC Hubs / Oceanic Divert boards** — status tiles (GO/CAUTION/NO-GO + cat +
  ceiling/vis + closures + FICON + RAIM + **fuel**), filter, status mini-map with
  tap-to-select, selection persistence, **Build Brief / Build Selected** PDFs.
- **Oceanic tracks** — NAT (FAA) + PACOTS (DAIP) parsed (half-degree, date-line).
- **DAIP** — generic typed-query layer; GPS/WAAS feeds RAIM; AREA_BRIEFING live.
- **Engine** — pure, tested (~233 tests); lite mode for boards; TTL caching on the
  hot upstreams; honest "UNAVAILABLE" everywhere; bundled fixtures for offline.
- **Docs** — `WEATHER-MAP-SPEC.md`, `AVIATION-DATA-NOTES.md`, `DAIP-SOURCES.md`.

## Near-term — confirmed via 2nd capture, mostly built
1. **DAIP `ROUTE_OF_FLIGHT`** — DONE. `POST /query {type:ROUTE_OF_FLIGHT,...}` →
   grouped route NOTAMs; wired as the Global-tab "Route NOTAMs (DAIP)" button.
2. **DAIP `BIRDTAM`** — endpoint confirmed (`type:BIRDTAM`); `fetchBirdtam` built.
   *Remaining: UI surface (boards/Global) — OCONUS bird complement to AHAS.*
3. **G-AIRMET shape** — confirmed + mapper fixed (forecastHour, FL altitudes).
   *Remaining deploy check:* NAT (`nms.aim.faa.gov` — confirmed 200) and PACOTS
   (DoD CA on the host) still want a production smoke test.

## Near-term — buildable now
4. **Global route brief PDF** — a "Build route brief" mirroring the boards' PDF:
   weather+NOTAMs for every airport stop + the leg/ETP/diversion table. Reuses the
   refcard engine. *value: high · effort: low-med.*
5. **FUEL_NOTAMS / ARTCC+PRESIDENTIAL TFR / MOA** as DAIP typed feeds — the generic
   layer makes each ~10 lines; surface as cross-checks/supplements. *value: med ·
   effort: low · blocker: DoD CA for live.*
6. **Board staleness cue + auto-refresh** — "updated 14m ago" + re-pull on tab
   re-entry so weather can't read silently stale. *value: med · effort: low.*
7. **Persist recent Global routes** (Local tab saves sorties; the route box doesn't)
   + draw **ETP markers** on the Global map. *value: med · effort: low.*

## Medium-term — coverage & depth
8. **Oceanic fix table** (DOGAL/RESNO/MALOT…) — resolver plumbing is easy; needs an
   **authoritative coordinate source** (won't fabricate). Closes the NAT/PACOTS
   named-fix gap (NAT ~42% resolve today). *value: med · effort: low + data ·
   blocker: trusted fix coordinates.*
9. **Runway suitability (TOLD-lite)** — beyond the fixed 7000 ft heuristic: required
   landing distance vs weight/DA/surface/contamination per divert. *value: high ·
   effort: med (needs aircraft perf data).* 
10. **Fuel/PNR-aware ETP** — the ETP is geometric today; add point-of-no-return /
    fuel-aware diversion logic. *value: high (oceanic) · effort: med (needs fuel
    burn model).* 
11. **Per-airframe limit profiles** — presets (crosswind/ceiling/vis/DA) instead of
    one global set. *value: med · effort: low-med.*
12. **Global airfield bundle refresh** — it's a static snapshot; add a date stamp +
    periodic re-ingest reminder (runways/closures drift). *value: med · effort: low.*

## Longer-term
13. **Forecast timeline scrubber** — drag through the sortie window; watch
    runway/crosswind/category change (PLANNING V3). *value: high · effort: high.*
14. **Save & share briefs; offline cache for in-flight reference.** *value: med ·
    effort: med-high.*
15. **Military FLIP / DINS integration (CAC).** *value: high · effort: high ·
    blocker: auth.*

## Cross-cutting principles to preserve
- Never fabricate — degrade to UNAVAILABLE; distinguish "checked, clean" from
  "couldn't check" (the RAIM lesson).
- Zero runtime deps, no build step, HTTPS-only, env-overridable sources.
- Bound user inputs; cap external text before regex; escape fetched text in HTML.
- Keep the analysis engine pure + tested; UI is a thin renderer.

## Top 3 to pick up next
**(a)** Live-probe `ROUTE_OF_FLIGHT` + `BIRDTAM` and the deploy-source verification
(items 1–3) — needs a network-open run and unblocks the most. **(b)** Global route
brief PDF (#4). **(c)** Board staleness + recent-routes polish (#6–7).
