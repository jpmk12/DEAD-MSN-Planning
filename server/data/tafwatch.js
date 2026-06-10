// TAF degradation watch: between two briefs, did an amended/newer TAF push any
// briefed phase toward CAUTION/NO-GO? Compares the OLD vs NEW forecast AT EACH
// PHASE TIME (not the whole TAF), so only changes that affect THIS sortie flag.
//
// State is per-process (resets on deploy/restart) — it's a "while you've been
// planning" watch, not a persistent log. Pure comparator exported for tests.

import { decodeTaf, tafAt } from './taf.js';

const lastTaf = new Map(); // icao -> { raw, issuedRaw, at }
const MAX_ENTRIES = 128;

const CAT_RANK = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

/** Describe how the forecast at `whenIso` changed old→new. Returns a list of
 *  human-readable worsening notes ([] when nothing got worse). */
export function compareTafAt(oldRaw, newRaw, whenIso) {
  if (!oldRaw || !newRaw || !whenIso) return [];
  const a = tafAt(decodeTaf(oldRaw), whenIso);
  const b = tafAt(decodeTaf(newRaw), whenIso);
  if (!a || !b) return [];
  const notes = [];
  const aCat = a.flightCategory, bCat = b.flightCategory;
  if (aCat && bCat && (CAT_RANK[bCat] ?? 0) > (CAT_RANK[aCat] ?? 0)) {
    notes.push(`now ${bCat} (was ${aCat})`);
  }
  const spd = (w) => (w ? Math.max(w.speedKt ?? 0, w.gustKt ?? 0) : null);
  const aW = spd(a.wind), bW = spd(b.wind);
  if (aW != null && bW != null && bW - aW >= 10) {
    notes.push(`wind up to ${bW} kt (was ${aW} kt)`);
  }
  if (a.ceilingFt != null && b.ceilingFt != null && b.ceilingFt < a.ceilingFt && b.ceilingFt < 3000) {
    notes.push(`ceiling down to ${b.ceilingFt} ft (was ${a.ceilingFt} ft)`);
  }
  if (a.visibilitySm != null && b.visibilitySm != null && b.visibilitySm < a.visibilitySm && b.visibilitySm < 6) {
    notes.push(`visibility down to ${b.visibilitySm} SM (was ${a.visibilitySm} SM)`);
  }
  return notes;
}

/**
 * Record the latest TAF for a field and report degradations at the given phase
 * times since the previously seen TAF. Returns [{ when, notes }] or [].
 */
export function watchTaf(icao, raw, whenIsos) {
  if (!icao || !raw) return [];
  const key = icao.toUpperCase();
  const prev = lastTaf.get(key);
  const issuedRaw = (decodeTaf(raw) || {}).issuedRaw ?? null;
  // Always store the newest TAF (bounded).
  lastTaf.set(key, { raw, issuedRaw, at: Date.now() });
  if (lastTaf.size > MAX_ENTRIES) lastTaf.delete(lastTaf.keys().next().value);
  // Nothing to compare against, or the TAF text hasn't changed.
  if (!prev || prev.raw === raw) return [];
  const out = [];
  for (const when of (whenIsos || []).filter(Boolean)) {
    const notes = compareTafAt(prev.raw, raw, when);
    if (notes.length) out.push({ when, notes });
  }
  return out;
}

/** Test hook: clear watch state. */
export function resetTafWatch() { lastTaf.clear(); }
