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
  // Current-only convective/SIGMET only when representative for this phase.
  if (b.phase?.hideCurrentOnly) {
    chips.push({ k: 'now-cast n/a', sev: 'info' });
  } else {
    const tsBad = (b.convective || []).some((c) => c.distanceNm === 0) || (b.hazardWx || []).some((h) => h.hazard === 'CONVECTIVE');
    const sig = (b.hazardWx || []).length > 0;
    if (tsBad) chips.push({ k: 'TS', sev: 'nogo' });
    else if (sig) chips.push({ k: 'SIGMET', sev: 'caution' });
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
  const chips = [];
  if (d.birdRisk?.level) chips.push({ k: `BIRD ${d.birdRisk.level}`, sev: birdSev(d.birdRisk.level) });
  if (worstXw != null) chips.push({ k: `XW ${worstXw}`, sev: xwSev(worstXw, limits.xwind) });
  chips.push({ k: 'CONV n/a', sev: 'info' }); // convective-along-route not assessed (honest)
  const worst = chips.reduce((m, c) => (SEV_RANK[c.sev] > SEV_RANK[m] ? c.sev : m), 'go');
  const status = worst === 'nogo' ? 'NO-GO' : worst === 'caution' ? 'CAUTION' : 'GO';
  return { role: d.type || 'IR', id: d.id, when, source: 'AHAS+winds', status, chips, reason: null };
}

/** Ordered mission phases: departure → AR → low-level → recovery → alternate. */
export function buildRibbonModel(data, routes, limits, llWhen) {
  const af = data.airfields || [];
  const byRole = (r) => af.filter((b) => (b.phase?.role || 'FIELD') === r);
  const ar = (routes || []).filter((d) => d.type === 'AR');
  const ll = (routes || []).filter((d) => d.type && d.type !== 'AR');
  return [
    ...byRole('DEPARTURE').map((b) => fieldPhase(b, limits)),
    ...byRole('FIELD').map((b) => fieldPhase(b, limits)),
    ...ar.map((d) => routePhase(d, llWhen, limits)),
    ...ll.map((d) => routePhase(d, llWhen, limits)),
    ...byRole('RECOVERY').map((b) => fieldPhase(b, limits)),
    ...byRole('ALTERNATE').map((b) => fieldPhase(b, limits)),
  ];
}
