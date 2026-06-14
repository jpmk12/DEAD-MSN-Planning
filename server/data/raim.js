// GPS / RAIM outage outlook.
//
// The authoritative predictive tool is the FAA SAPT (Service Availability
// Prediction Tool, https://sapt.faa.gov), which runs a receiver-autonomy
// integrity calculation against the GPS almanac. We don't reimplement that
// satellite-geometry math; instead we surface the operational signal crews
// actually use day-to-day: FAA GPS/RAIM NOTAMs, which state predicted outage
// windows. We structure those NOTAMs into a per-field outlook with time windows.

/** Pull explicit Zulu HHMM-HHMM ranges out of NOTAM text, if present. */
export function extractTimeRanges(text) {
  const ranges = [];
  const re = /\b([01]\d|2[0-3])([0-5]\d)\s*-\s*([01]\d|2[0-3])([0-5]\d)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ranges.push({ start: `${m[1]}${m[2]}Z`, end: `${m[3]}${m[4]}Z` });
  }
  return ranges;
}

/**
 * Build a RAIM outlook for one field from its (already categorized) NOTAMs.
 * @param {any[]} notams  the field's NOTAMs
 * @param {boolean} notamsAvailable  whether the NOTAM source actually returned data
 * @returns {{status:'PREDICTED OUTAGE'|'NO PREDICTED OUTAGE'|'UNKNOWN', windows:any[], note:string}}
 */
export function raimOutlook(notams, notamsAvailable = true) {
  const raim = notams.filter((n) => n.category === 'GPS_RAIM');
  if (raim.length === 0) {
    // No RAIM NOTAM AND the feed was reachable -> genuinely clear. If the feed
    // was UNAVAILABLE we cannot claim "no outage" — say so honestly.
    if (!notamsAvailable) {
      return {
        status: 'UNKNOWN',
        windows: [],
        note: 'NOTAM source unavailable — RAIM status unknown. Check FAA SAPT (sapt.faa.gov).',
      };
    }
    return {
      status: 'NO PREDICTED OUTAGE',
      windows: [],
      note: 'No GPS/RAIM NOTAMs. Confirm with FAA SAPT for RNAV/RNP approaches.',
    };
  }
  const windows = raim.map((n) => {
    const inline = extractTimeRanges(n.text);
    return {
      id: n.id,
      raw: n.text,
      start: n.effectiveStart ?? null,
      end: n.effectiveEnd ?? null,
      inlineRanges: inline,
    };
  });
  return {
    status: 'PREDICTED OUTAGE',
    windows,
    note: 'RAIM may be unavailable in the listed window(s) — verify approach minima and consider alternates.',
  };
}
