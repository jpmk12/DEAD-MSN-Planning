# C-17 Mission Planner

One-stop planning for C-17 training sorties: weather, NOTAMs, hazards, and —
the headline feature — **wind/pattern analysis** that picks the active runway
and computes head/cross/tailwind components, with magnetic↔true done right.

See [`PLANNING.md`](./PLANNING.md) for the full design, data-source survey, and roadmap.

## What's built so far

**1. Analysis engine** (`src/core/`) — pure, unit-tested, no network:
- `wind.ts` — magnetic→true conversion + head/cross/tailwind components.
- `density.ts` — pressure altitude, density altitude, ISA deviation.
- `analyze.ts` — per-runway analysis, active-runway selection, limit warnings
  (crosswind / gust crosswind / tailwind / high density altitude).
- Handles the correctness traps: METAR winds are **true** while runway numbers
  are **magnetic**; surveyed heading ≠ designator×10; gusts; calm/`VRB` winds.

**2. Data layer** (`src/data/`):
- `awc.ts` — NOAA Aviation Weather Center METAR/TAF client (free, no key).
- `airports.ts` — runway/airfield reference lookup (currently the bundled
  curated dataset in `data/airports.json`; this is the seam where FAA NASR /
  OpenAIP ingest plugs in).

**3. Demo CLI** (`src/cli.ts`) — fetches weather, runs the engine, prints a
kneeboard-style brief. Tries live AWC, falls back to the bundled fixture when
the network is unavailable.

## Run it

```bash
npm install
npm test                     # 21 tests — the safety-relevant math
npm run demo                 # brief for the default demo airfields
npm run demo -- KCHS KEDW    # specific airfields
npm run demo -- --offline    # force bundled fixture (no network)
npm run typecheck
```

Example brief (Edwards, hot/high with gusty wind):

```
 KEDW — Edwards AFB, CA
 OBS 16:56Z  WIND 240/28G38 (true)  TEMP 34°C  ALT 1009 hPa
 Field elev 2312 ft   PA 2438 ft   DA 5297 ft (ISA +24°C)

 ACTIVE RWY 22R  (true 232°)
   Headwind 28 kt      Crosswind 4 kt from RIGHT
   Gust:  Headwind 38 kt   Crosswind 5 kt
 Warnings:
   ⚠ Density altitude 5297 ft is high — expect degraded ... performance.
 STATUS: CAUTION
```

## Important caveats

- **Planning aid only — verify with official sources.** Not authoritative.
- `data/airports.json` is **illustrative**: runway headings, elevations, and
  magnetic variation are approximate and must be replaced by FAA NASR (CONUS) /
  OpenAIP (OCONUS) before operational use.
- Aircraft limits in the CLI are **placeholders**, not official -1/TO values —
  set them in `src/cli.ts` (`LIMITS`).

## Next steps (see PLANNING.md §5)

NASR/OpenAIP ingest · FAA NOTAM API + categorization · TFR/SUA/RAIM · AHAS/BAM
bird hazards · winds-aloft for pattern altitude · responsive PWA frontend +
kneeboard PDF export.
