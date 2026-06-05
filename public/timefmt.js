// Shared time formatting — render both Zulu (UTC) and browser-local time.
// Used by the brief (app.js) and the map caption (map.js).

const pad2 = (n) => String(n).padStart(2, '0');

// Local timezone abbreviation (e.g. CDT) so local times are unambiguous.
export const TZ_ABBR = (() => {
  try {
    const p = new Intl.DateTimeFormat([], { timeZoneName: 'short' })
      .formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
    return (p && p.value) || 'LCL';
  } catch { return 'LCL'; }
})();

// Parse a server time as UTC. The API emits UTC wall-clock; if a string has no
// zone marker, treat it as Zulu (append Z) so the Date math is correct.
export function toUtcDate(iso) {
  if (!iso) return null;
  let s = String(iso).trim();
  if (!/(z|[+-]\d\d:?\d\d)$/i.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const hhZ = (iso) => { const d = toUtcDate(iso); return d ? pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) : ''; };
export const hhL = (iso) => { const d = toUtcDate(iso); return d ? pad2(d.getHours()) + pad2(d.getMinutes()) : ''; };

// "1430Z · 0930 CDT". With {date:true}, prefix the day-of-month on each side
// (the local calendar day can differ from the UTC day): "05 1430Z · 04 2330 CST".
export function zuluLocal(iso, { date = false } = {}) {
  if (!iso) return '';
  const d = toUtcDate(iso);
  if (!d) return String(iso);
  const zd = date ? pad2(d.getUTCDate()) + ' ' : '';
  const ld = date ? pad2(d.getDate()) + ' ' : '';
  return `${zd}${hhZ(iso)}Z · ${ld}${hhL(iso)} ${TZ_ABBR}`;
}
