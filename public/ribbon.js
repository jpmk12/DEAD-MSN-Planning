// Mission hazard ribbon — pure model builder (no DOM), shared by the frontend
// (public/app.js) and the test suite. Turns a brief + active routes into the
// ordered list of mission phases (departure → AR → low-level → recovery →
// alternate), each with a status and the hazard chips that explain it. All
// inputs are the data the brief already produced; nothing is fetched or faked.

export const SEV_RANK = { go: 0, info: 0, caution: 1, nogo: 2 };
const RB_ROLE = { DEPARTURE: 'DEP', RECOVERY: 'REC', ALTERNATE: 'ALT', AR: 'A/R', IR: 'LL', VR: 'LL', SR: 'LL', FIELD: 'FIELD' };
export const roleTag = (r) => RB_ROLE[r] || r;

export const catSev = (c) => (c === 'LIFR' ? 'nogo' : c === 'IFR' || c === 'MVFR' ? 'caution' : c ? 'go' : 'info');
export const birdSev = (l) => (l === 'SEVERE' ? 'nogo' : l === 'MODERATE' ? 'caution' : l ? 'go' : 'info');
export const xwSev = (kt, lim) => (kt == null ? 'info' : kt >= lim ? 'nogo' : kt >= 0.6 * lim ? 'caution' : 'go');

// Authoritative sources for the hazard chips, so a warning links out for detail.
export const AWC_SIGMET_URL = 'https://aviationweather.gov/gfa/#sigmet'; // graphical SIGMET/AIRMET viewer
export const SPC_OUTLOOK_URL = 'https://www.spc.noaa.gov/products/outlook/'; // SPC convective outlooks
export const AWC_PIREP_URL = 'https://aviationweather.gov/gfa/#pirep'; // graphical PIREP viewer

/** Tooltip text for a SIGMET/AIRMET chip — the decoded label plus the raw
 *  product text (the authoritative detail), and its valid-until time. */
export function sigTip(h) {
  if (!h) return null;
  return [h.label || h.type, h.validTo ? `valid to ${h.validTo}` : null, h.raw]
    .filter(Boolean).join(' · ');
}

/** Short kind tag for a PIREP (icing / turbulence / urgent). */
export const pirepKind = (p) => (p.ice ? 'ICE' : p.turb ? 'TURB' : p.urgent ? 'URGENT' : 'PIREP');

/** Tooltip text for a PIREP chip — hazard, flight level, obs time, raw report. */
export function pirepTip(p) {
  if (!p) return null;
  return [p.hazard || pirepKind(p), p.altFt != null ? `FL${Math.round(p.altFt / 100)}` : null,
    p.obsTime ? `obs ${p.obsTime}` : null, p.rawText].filter(Boolean).join(' · ');
}

/** Worst crosswind across an MTR's legs (the route's wind hazard), or null. */
export function routeWorstXw(d) {
  let max = null;
  for (const s of (d.segments || [])) {
    const k = s.wind ? Math.abs(s.wind.crosswindKt) : null;
    if (k != null && (max == null || k > max)) max = Math.round(k);
  }
  return max;
}

/** A field phase (departure / recovery / alternate) hazard summary. */
export function fieldPhase(b, limits) {
  const useFc = b.statusSource === 'TAF@ETA' && b.forecast;
  const active = useFc ? b.forecast.active : b.analysis?.active;
  const xw = active ? Math.round(active.gustCrosswindKt ?? active.crosswindKt) : null;
  const cat = (useFc ? b.forecast?.flightCategory : null) ?? b.currentConditions?.flightCategory ?? null;
  const chips = [];
  if (xw != null) chips.push({ k: `XW ${xw}`, sev: xwSev(xw, limits.xwind) });
  if (cat) chips.push({ k: cat, sev: catSev(cat) });
  if (b.birdRisk?.level) chips.push({ k: `BIRD ${b.birdRisk.level[0]}`, sev: birdSev(b.birdRisk.level) });
  // NVG illumination (computed) — LOW is a planning consideration (caution color),
  // not a GO/NO-GO driver; daylight phases show nothing.
  if (b.nvg && !b.nvg.daylight) {
    chips.push({ k: `ILLUM ${b.nvg.illumClass[0]} ${b.nvg.illumMlx} mlx`, sev: b.nvg.illumClass === 'LOW' ? 'caution' : 'go',
      tip: `AFI 11-214: HIGH ≥ 2.2 mlx, LOW < 2.2 mlx · clear-sky computed${b.nvg.source && b.nvg.source !== 'computed' ? ' (' + b.nvg.source + ')' : ''} — verify with USNO/mission brief` });
  }
  // Current-only convective/SIGMET only when representative for this phase.
  if (b.phase?.hideCurrentOnly) {
    chips.push({ k: 'now-cast n/a', sev: 'info' });
  } else {
    const convSig = (b.hazardWx || []).find((h) => h.hazard === 'CONVECTIVE');
    const tsBad = (b.convective || []).some((c) => c.distanceNm === 0) || !!convSig;
    const firstSig = (b.hazardWx || [])[0];
    if (tsBad) chips.push({ k: 'TS', sev: 'nogo', tip: convSig ? sigTip(convSig) : 'Convective outlook overhead', href: convSig ? AWC_SIGMET_URL : SPC_OUTLOOK_URL });
    else if (firstSig) chips.push({ k: 'SIGMET', sev: 'caution', tip: sigTip(firstSig), href: AWC_SIGMET_URL });
  }
  return {
    role: b.phase?.role || 'FIELD', id: b.icao, when: b.phase?.when || null,
    source: useFc ? 'TAF@ETA' : 'METAR', status: b.status,
    chips, reason: (b.statusReasons || [])[0] || null,
  };
}

/** An MTR/AR route phase hazard summary (birds + worst leg crosswind). */
export function routePhase(d, when, limits) {
  const worstXw = routeWorstXw(d);
  const isAr = d.type === 'AR';
  const chips = [];
  if (d.birdRisk?.level) chips.push({ k: `BIRD ${d.birdRisk.level}`, sev: birdSev(d.birdRisk.level) });
  // On an AR track the cross-track wind aloft is awareness, not a landing limit —
  // it must NOT drive GO/NO-GO, so show it informational. Low-level (IR/VR) keeps
  // the crosswind-vs-limit severity.
  if (worstXw != null) {
    chips.push(isAr
      ? { k: `XW ${worstXw} aloft`, sev: 'info' }
      : { k: `XW ${worstXw}`, sev: xwSev(worstXw, limits.xwind) });
  }
  // Convective/SIGMET along the route path (assessed server-side from the leg
  // geometry). Convective SIGMET on/near the route → NO-GO; a higher SPC outlook
  // category or any other SIGMET → CAUTION; a lower outlook → info; clear → GO.
  // When the check didn't run (offline / no geometry) stay honest: "CONV n/a".
  if (d.routeWxChecked) {
    const conv = d.convective || [];
    const sig = d.hazardWx || [];
    const convSig = sig.filter((h) => h.hazard === 'CONVECTIVE');
    const otherSig = sig.filter((h) => h.hazard !== 'CONVECTIVE');
    const HI = new Set(['ENH', 'MDT', 'HIGH']);
    const hiConv = conv.filter((c) => HI.has(c.risk));
    if (convSig.length) chips.push({ k: `CONV SIGMET ${convSig[0].distanceNm}NM`, sev: 'nogo', tip: sigTip(convSig[0]), href: AWC_SIGMET_URL });
    else if (hiConv.length) chips.push({ k: `CONV ${hiConv[0].risk} ${hiConv[0].distanceNm}NM`, sev: 'caution', tip: `SPC convective outlook: ${hiConv[0].label || hiConv[0].risk} · ${hiConv[0].distanceNm} NM from route`, href: SPC_OUTLOOK_URL });
    else if (otherSig.length) chips.push({ k: `${otherSig[0].type} ${otherSig[0].distanceNm}NM`, sev: 'caution', tip: sigTip(otherSig[0]), href: AWC_SIGMET_URL });
    else if (conv.length) chips.push({ k: `CONV ${conv[0].risk} ${conv[0].distanceNm}NM`, sev: 'info', tip: `SPC convective outlook: ${conv[0].label || conv[0].risk} · ${conv[0].distanceNm} NM from route`, href: SPC_OUTLOOK_URL });
    else chips.push({ k: 'CONV clear', sev: 'go' });
  } else {
    chips.push({ k: 'CONV n/a', sev: 'info' }); // not assessed (offline / no geometry)
  }
  // Structural-icing potential at the route's block altitude (winds-aloft temp/RH).
  // Awareness — MODERATE flags caution; lighter is informational. Never NO-GO.
  if (d.icing) {
    chips.push({ k: `ICE ${d.icing.severity}`, sev: d.icing.severity === 'MODERATE' ? 'caution' : 'info',
      tip: `Structural icing potential at block: ${d.icing.tempC}°C${d.icing.rhPct != null ? `, RH ${d.icing.rhPct}%` : ''} — temp/RH-based, needs visible moisture` });
  }
  // Pilot-reported icing/turbulence on/near the route (nearest one). Awareness.
  if (d.pireps && d.pireps.length) {
    const p = d.pireps[0];
    chips.push({ k: `PIREP ${pirepKind(p)} ${p.distanceNm}NM`, sev: 'caution', tip: pirepTip(p), href: AWC_PIREP_URL });
  }
  const worst = chips.reduce((m, c) => (SEV_RANK[c.sev] > SEV_RANK[m] ? c.sev : m), 'go');
  const status = worst === 'nogo' ? 'NO-GO' : worst === 'caution' ? 'CAUTION' : 'GO';
  return { role: d.type || 'IR', id: d.id, when, source: 'AHAS+winds', status, chips, reason: null };
}

/** Ordered mission phases: departure → AR → low-level → recovery → alternate.
 *  `whens` = { arWhen, llWhen } — AR tracks and low-level routes are flown (and
 *  evaluated) at their own entry times. A bare string is accepted as llWhen for
 *  back-compat. */
export function buildRibbonModel(data, routes, limits, whens) {
  const w = typeof whens === 'string' || whens == null ? { arWhen: whens ?? null, llWhen: whens ?? null } : whens;
  const af = data.airfields || [];
  const byRole = (r) => af.filter((b) => (b.phase?.role || 'FIELD') === r);
  const ar = (routes || []).filter((d) => d.type === 'AR');
  const ll = (routes || []).filter((d) => d.type && d.type !== 'AR');
  return [
    ...byRole('DEPARTURE').map((b) => fieldPhase(b, limits)),
    ...byRole('FIELD').map((b) => fieldPhase(b, limits)),
    ...ar.map((d) => routePhase(d, w.arWhen ?? null, limits)),
    ...ll.map((d) => routePhase(d, w.llWhen ?? null, limits)),
    ...byRole('RECOVERY').map((b) => fieldPhase(b, limits)),
    ...byRole('ALTERNATE').map((b) => fieldPhase(b, limits)),
  ];
}
