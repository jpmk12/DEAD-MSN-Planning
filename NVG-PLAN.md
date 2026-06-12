# NVG-PLAN — Night Vision Goggle Operations Support

> Goal: tell DEAD Planning "this is an NVG sortie" and get the illumination
> picture a crew needs, per phase, at each phase's time and place — sun/moon
> events, percent illumination, lunar position, and a LOW/HIGH illumination call
> per AFI 11-214 (LOW = 0–2.1 millilux, HIGH = ≥2.2 millilux).
>
> Status: plan + mockup for decisions. No feature code yet.

---

## 1. What the crew needs (per phase location + time)

| Item | Detail |
|---|---|
| Sun events | Sunset / sunrise, **BMNT / EENT** (begin morning / end evening nautical twilight — the NVG-relevant boundaries), civil twilight |
| Moon events | Moonrise / moonset (the ones bracketing the phase time) |
| Moon state | Phase name (waxing gibbous…), **% disk illumination** |
| Lunar position | **Altitude + azimuth at the phase time** (a 90%-illuminated moon below the horizon contributes nothing) |
| Ground illumination | **Millilux at the phase time**, classified **LOW (0–2.1 mlx) / HIGH (≥2.2 mlx)** per AFI 11-214 |
| Caveat | Cloud cover degrades effective illumination — flag when METAR/TAF show BKN/OVC at the phase time |

Applies to every night phase: departure, A/R, low-level entry + TOTs (LZs),
recovery, alternates. Day phases show "daylight — NVG n/a" instead of noise.

## 2. Data strategy (honest, zero-dependency)

Astronomy is **deterministic computation, not fabricated data** — same class as
our density-altitude math. Two layers:

1. **Local astronomy engine** (`server/core/astro.js`, pure + tested):
   - Solar position/rise/set/twilights: standard NOAA solar equations.
   - Lunar position/phase/illumination: truncated Meeus ephemeris (the standard
     planning-tool approach; rise/set within ~2 min, alt/az within ~0.2°).
   - **Ground illuminance (mlx):** sun contribution by altitude (twilight
     curve), moon contribution by altitude × phase (Krisciunas–Schaefer /
     Allen tables), plus the clear-sky starlight+airglow baseline (~0.2–1 mlx).
     Labeled **"clear-sky computed planning value."**
   - Works offline; fully unit-testable against USNO almanac golden values.
2. **USNO cross-check (optional, live):** `aa.usno.navy.mil/api/rstt/oneday`
   returns authoritative rise/set/phase/illum-% (free JSON, .mil like DAIP).
   When reachable, event times display from USNO with a "USNO" source tag;
   otherwise the computed values show with a "computed" tag. Millilux is always
   the local model (USNO doesn't publish ground illuminance).

Never fabricated: every value is either USNO's or a documented computation, with
the source labeled and the standing "verify with official sources" framing.

## 3. Where it shows (see mockups/nvg-mockup.html)

- **A — Planning panel:** an "NVG sortie" toggle (saved with sorties). When on,
  every surface below activates; when off, nothing changes.
- **B — Field/phase cards:** an ILLUMINATION block (sun/moon events, disk %,
  moon alt/az at phase time, millilux + LOW/HIGH badge, cloud caveat, source tag).
- **C — Sortie timeline:** a new **ILLUM row** — day/twilight/night shading per
  column with L/H letters at night, so "when does it get dark / when is the
  moon up" reads at a glance next to the weather rows.
- **D — Mission ribbon:** an `ILLUM H 12 mlx` / `ILLUM L 0.8 mlx` chip on each
  night phase (LOW = caution-colored: it's a planning consideration, not a
  prohibition).
- **Kneeboard print:** the card block prints; timeline ILLUM row prints.

## 4. API & plumbing

- `buildBrief`: per stop, attach `nvg: { sun:{set,rise,bmnt,eent}, moon:{rise,
  set,phase,diskPct,altDeg,azDeg}, illumMlx, illumClass, cloudCaveat, source }`
  when the NVG flag is on (`?nvg=1`).
- `buildTimeline`: per column, `illum: { sun:'day'|'twilight'|'night',
  mlx, class }` for each field row's location (one astro computation per
  field × hour — microseconds, no network).
- Standalone `GET /api/illum?lat=..&lon=..&when=..` for tools/LZ points
  (e.g. SCLZ/STLZ TOTs from the route-of-flight).
- CADDO10 demo gets a night-sortie variant so the feature demos offline.

## 5. Tests (write first)

- Golden vs USNO almanac: KLTS 2026-06-11 (sunset/EENT/moonrise/disk %), a
  full-moon and a new-moon date, a high-latitude sanity case.
- Threshold edges: 2.1 → LOW, 2.2 → HIGH (AFI 11-214 wording).
- Moon-below-horizon at 95% disk → LOW (position matters, not just phase).
- Twilight ordering invariants (BMNT < sunrise < sunset < EENT).
- Timeline ILLUM row day/twilight/night classification at known instants.

## 6. Effort

Engine + tests ~1 commit; brief/timeline/ribbon wiring ~1; UI + print ~1;
USNO cross-check ~1 (optional, last). All zero-dependency, no build step.

## 7. Decisions needed (mocked in nvg-mockup.html)

1. **Data source:** local engine only, or hybrid with USNO cross-check when
   reachable? *(Recommend hybrid — authoritative when available, never blocked.)*
2. **Millilux model labeling:** OK to show a clear-sky computed mlx value with
   the cloud caveat, or prefer showing only the inputs (disk %, moon alt) plus
   the LOW/HIGH call?
3. **Always-on vs toggle:** compute/show illumination only when "NVG sortie" is
   toggled, or always show a slim version on night phases? *(Recommend toggle.)*
4. **LOW illum severity:** treat LOW as CAUTION-colored chip (planning
   consideration) or neutral/informational only? *(Recommend caution color,
   no effect on GO/NO-GO status.)*
