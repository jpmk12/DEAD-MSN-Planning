# DAIP data sources — catalog & recommendations

From a live capture of the DoD Aeronautical Information Portal mobile site
(`www.daip.jcs.mil/daip/mobile`). **Key insight:** ~15 query types post the SAME
shape to `POST /daip/mobile/query` and return the SAME `group → notams → list`
body — so `parseDaipNotams` (in `server/data/daip.js`) ingests all of them with
no new parsing. Every call needs the **DoD PKI CA bundle** loaded (same as the
existing DAIP NOTAMs / PACOTS); without it: UNAVAILABLE, never faked.

Generic helper: `daipTypePayload(type, extra)` + `fetchDaipByType(type, extra,
{offline, fixture})`. Adding a new type is ~3 lines.

## Query types (POST /daip/mobile/query, JSON body `{type, …}`)
| type | returns | use |
|---|---|---|
| `LOCATION` | NOTAMs near ICAO(s) (`locs`/`locations`, `radius`) | per-field NOTAMs (in use) |
| `PACIFIC_TRACKS` | PACOTS tracks | oceanic tracks (in use) |
| **`GPS_WAAS`** | system-wide GPS/WAAS/PRN outage NOTAMs | **RAIM (implemented)** |
| **`AREA_BRIEFING`** | NOTAMs within radius of a lat/lon (deg/min fields + N/S/E/W) | **NOTAMs for ETP/coord waypoints (implemented: `fetchAreaNotams`)** |
| `FUEL_NOTAMS` | fuel availability NOTAMs | divert fuel flag (recommended) |
| `ARTCC_TFRS` / `PRESIDENTIAL_TFRS` | DoD TFR list | TFR cross-check (recommended) |
| `MOA` | active MOAs (large) | SUA supplement; supports `acode` category filter |
| `EUROPEAN_RVSM` | RVSM notices | EUR ops |
| `FDC_NOTICES` / `FDC_SPECIAL_NOTICES` / `DAFIF_FLIP_CHART_NOTICES` / `ATTENTION_NOTICES` | notice categories | "DoD notices" panel |
| `TFA` / `CANDIDATE` | Temporary Flight Advisory (mission impact) | banner |

Body filters seen: `acode` (ALL/DAFIF-FLIP/FDC/LASER/MOA/VIP TFR/RVSM/SPECIAL
NOTICE/TFR/TOWER), `radius`, `sort:"Criticality"`. LOCATION accepts both
`{locs:"KADW KCHS"}` and `{locations:[...]}`.

## Probe-before-building (404'd in this capture — wrong path/params)
- `ROUTE_OF_FLIGHT` — `{poa, pod, alternates, airportType, radius}` → NOTAMs along
  a route + alternates. Maps perfectly to the Global tab; verify the correct
  endpoint live.
- `birdtam.do` (BIRDTAM) — DoD bird-hazard advisory; could complement AHAS (US-only)
  for OCONUS. Verify params.
- `nfir?type=FIR_ARTCC&locs=…&acode=…` — NOTAMs by FIR/ARTCC (ORBB, OSTT, UKBV,
  UUWV, OIIX, ZNY, `*` wildcard). GETs 404'd here; useful for regional/FIR briefs.

## Status
- **Implemented this pass:** `GPS_WAAS` → folded into the RAIM outlook (each
  field's `airspace.raim.gpsActive` = system-wide GPS NOTAM count, surfaced in the
  RAIM panel; does NOT flip per-field GO/NO-GO). `fetchAreaNotams(lat,lon,radiusNm)`
  available for ETP/coordinate-waypoint NOTAMs (engine + tests; UI wiring TBD).
  Both validated against the real captured bodies in `data/fixtures/`.
- **Recommended next:** FUEL_NOTAMS on the divert boards; ARTCC/PRESIDENTIAL TFR
  cross-check; probe ROUTE_OF_FLIGHT and BIRDTAM.
