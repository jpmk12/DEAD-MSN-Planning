// Pure, DOM-free helpers relating decoded-TAF periods to a flight window.
// Shared by the frontend (app.js) and unit tests (node:test) — no browser deps.

// A TAF time is a bare "DDHH"/"DDHHMM" Zulu token (no month/year). Anchor it to
// the brief's generation time so it resolves to a real instant. Handles month
// rollover and the 24:00 = next-day-00:00 convention. Returns an ISO string.
export function tafTokenIso(ddhhmm, anchorIso) {
  if (!ddhhmm || ddhhmm.length < 4) return null;
  const dd = +ddhhmm.slice(0, 2);
  let hh = +ddhhmm.slice(2, 4);
  const mm = ddhhmm.length >= 6 ? +ddhhmm.slice(4, 6) : 0;
  if (![dd, hh, mm].every(Number.isFinite)) return null;
  const anchor = new Date(anchorIso);
  const base = Number.isNaN(anchor.getTime()) ? new Date() : anchor;
  let mo = base.getUTCMonth();
  if (dd < base.getUTCDate() - 10) mo += 1; // token day well before now → next month
  const rollDay = hh >= 24;
  if (rollDay) hh -= 24;
  let d = new Date(Date.UTC(base.getUTCFullYear(), mo, dd, hh, mm));
  if (rollDay) d = new Date(d.getTime() + 86400000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Effective [startMs, endMs] for each decoded-TAF period. TEMPO/PROB carry an
// explicit from–to. An open-ended FM/BASE group (no `to`) is in effect until the
// next BASE group starts — or +Infinity for the last one. Anchored to `anchorIso`.
export function periodIntervals(periods, anchorIso) {
  const ms = (tok) => { const iso = tafTokenIso(tok, anchorIso); return iso ? Date.parse(iso) : NaN; };
  const isBase = (p) => p.kind !== 'TEMPO' && p.kind !== 'PROB';
  return (periods || []).map((p, i) => {
    const start = ms(p.from);
    let end = ms(p.to);
    if (!Number.isFinite(end)) {
      let nextBase = NaN;
      for (let j = i + 1; j < periods.length; j++) {
        if (isBase(periods[j])) { nextBase = ms(periods[j].from); break; }
      }
      end = Number.isFinite(nextBase) ? nextBase : Infinity;
    }
    return { start, end };
  });
}

// Boolean per period: does its effective interval overlap the flight window
// [win.start, win.end] (ms)? Returns null when there's no usable window or nothing
// overlaps — so the caller never dims an entire TAF that lies outside the window.
export function periodsInWindow(periods, anchorIso, win) {
  if (!win || !Number.isFinite(win.start) || !Number.isFinite(win.end) || !periods || !periods.length) return null;
  const flags = periodIntervals(periods, anchorIso)
    .map(({ start, end }) => Number.isFinite(start) && start <= win.end && end >= win.start);
  return flags.some(Boolean) ? flags : null;
}
