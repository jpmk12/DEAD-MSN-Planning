// Server-rendered "reference card": a single printable page combining the
// external references — DAIP NOTAMs, AWC METAR + decoded TAF, and AHAS 12-hour
// bird risk — for ALL of the sortie's bases (departure, recovery, alternates,
// each at its own time) plus the low-level/AR routes, using the same live
// fetchers the brief uses (so the data shows even though the external SPAs can't
// be deep-linked). Returned as a self-contained, print-friendly HTML document.

import { getAirport } from './data/airports.js';
import { loadWeather } from './data/weather.js';
import { decodeTaf } from './data/taf.js';
import { fetchNotams } from './data/notams.js';
import { advisoryFor } from './data/birds.js';
import { ahasRaw, parseAhasLevel, parseAhasSeries, parseAhasHourly, ahasAreaForIcao, ahasRouteType, ahasHasRoute, ahasRunAtIso } from './data/ahasapi.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const nowZ = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
};
const cite = (label, url) => `<div class="src">Source: ${esc(label)} — <span class="url">${esc(url)}</span> · retrieved ${nowZ()}</div>`;

function zulu(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}

const riskColor = (lvl) => (lvl === 'SEVERE' ? '#b3231b' : lvl === 'MODERATE' ? '#b5840a' : '#1a7f37');
const RANK = { LOW: 0, MODERATE: 1, SEVERE: 2 };
const normRoute = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const hhz = (s) => { const m = /\d{4}-\d{2}-\d{2}[ T](\d{2})/.exec(String(s || '')); return m ? `${m[1]}Z` : ''; };

// 12-hour AHAS outlook (GetAHASRisk12): per-hour worst level + real times.
async function ahas12(type, area, whenIso) {
  try {
    const xml = await ahasRaw('GetAHASRisk12', type, area, whenIso);
    let series = parseAhasHourly(xml);
    if (!series.length) series = parseAhasSeries(xml).map((level) => ({ time: null, level }));
    if (!series.length) { const lv = parseAhasLevel(xml); return lv ? { level: lv, series: [], runAt: ahasRunAtIso(whenIso) } : null; }
    const level = series.reduce((w, s) => (RANK[s.level] > RANK[w] ? s.level : w), 'LOW');
    return { level, series, runAt: ahasRunAtIso(whenIso) };
  } catch { return null; }
}

function hourlyStrip(series) {
  if (!series || series.length < 2) return '';
  const cells = series.map((s) => `<div class="hr"><div class="hr-t">${esc(hhz(s.time))}</div><div class="hr-l" title="${esc(s.level)}" style="background:${riskColor(s.level)}">${esc(s.level[0])}</div></div>`).join('');
  return `<div class="strip">${cells}</div>`;
}

function ahasBlock(a) {
  if (!a || (!a.level && !(a.series || []).length)) return '<div class="none">No AHAS risk available.</div>';
  const worst = a.level || (a.series && a.series[0] && a.series[0].level) || 'LOW';
  const head = `<div class="ahas"><span class="lvl" style="color:${riskColor(worst)};border-color:${riskColor(worst)}">${esc(worst)}</span>
    <span class="ahas-note">12-hr worst case — ${esc(advisoryFor(worst))}</span></div>`;
  const when = a.runAt ? `<div class="when">12-hr outlook from ${esc(zulu(a.runAt))}</div>` : '';
  return `${head}${when}${hourlyStrip(a.series)}`;
}

// ---- per-field sections ----------------------------------------------------
function wxSection(label, obs, tafRaw, decoded) {
  const metar = obs?.rawText ? `<pre class="raw">${esc(obs.rawText)}</pre>` : '<div class="none">METAR unavailable.</div>';
  let taf = '<div class="none">No TAF issued for this field.</div>';
  if (tafRaw) {
    const periods = (decoded?.periods || []).map((p) => {
      const items = [...(p.items || []), ...(p.extra || [])].map((it) => `<li>${esc(it)}</li>`).join('');
      return `<div class="taf-p"><div class="taf-l">${esc(p.label)}${p.when ? ` · ${esc(p.when)}` : ''}</div><ul>${items}</ul></div>`;
    }).join('');
    taf = `<pre class="raw">${esc(tafRaw)}</pre>${periods}`;
  }
  return `<section><h2>Aviation Weather — ${esc(label)}</h2>
    <h3>METAR</h3>${metar}
    <h3>TAF (decoded)</h3>${taf}
    ${cite('FAA / NWS Aviation Weather Center', 'aviationweather.gov')}</section>`;
}

function ahasFieldSection(label, a) {
  return `<section><h2>AHAS Bird Risk (12-hour) — ${esc(label)}</h2>
    ${ahasBlock(a)}
    ${cite('USAF Avian Hazard Advisory System', 'usahas.com')}</section>`;
}

function routeAhasSection(routeAhas) {
  if (!routeAhas.length) return '';
  const rows = routeAhas.map((r) => {
    if (!r.ahas) return `<div class="notam"><span class="cat">${esc(r.id)}</span><div><div class="txt none">No AHAS data (route not covered by AHAS — e.g. AR tracks — or unavailable).</div></div></div>`;
    const worst = r.ahas.level || (r.ahas.series && r.ahas.series[0] && r.ahas.series[0].level) || 'LOW';
    return `<div class="route-ahas"><div class="notam"><span class="cat" style="color:${riskColor(worst)};background:#fff;border:1px solid ${riskColor(worst)}">${esc(r.id)}</span>
      <div><div class="txt"><b style="color:${riskColor(worst)}">${esc(worst)}</b> 12-hr worst${r.ahas.runAt ? ` · from ${esc(zulu(r.ahas.runAt))}` : ''}</div></div></div>
      ${hourlyStrip(r.ahas.series)}</div>`;
  }).join('');
  return `<section><h2>AHAS Bird Risk (12-hour) — Low-Level / AR routes</h2>${rows}
    ${cite('USAF Avian Hazard Advisory System', 'usahas.com')}</section>`;
}

function notamSection(label, notams, source) {
  if (!notams.length) return `<section><h2>NOTAMs — ${esc(label)}</h2><div class="none">No NOTAMs retrieved${source ? ` (${esc(source)})` : ''}.</div></section>`;
  const rows = notams.map((n) => {
    const end = n.effectiveEnd ? `<div class="when">until ${esc(zulu(n.effectiveEnd))}</div>` : '';
    return `<div class="notam"><span class="cat">${esc(n.category || 'OTHER')}</span><div><div class="txt">${esc(n.text)}</div>${end}</div></div>`;
  }).join('');
  return `<section><h2>NOTAMs — ${esc(label)} <span class="count">${notams.length}${source ? ` · ${esc(source)}` : ''}</span></h2>${rows}
    ${cite(source === 'DAIP' ? 'DoD Aeronautical Information (DAIP)' : `NOTAMs (${source || 'source'})`, 'daip.jcs.mil')}</section>`;
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; color: #111; margin: 0; padding: 24px; max-width: 900px; }
  .doc-head { border-bottom: 3px double #222; padding-bottom: 8px; margin-bottom: 14px; }
  .doc-title { font-family: Georgia, "Times New Roman", serif; font-size: 21px; font-weight: 700; letter-spacing: .3px; }
  .doc-meta { color: #555; font-size: 12px; margin-top: 3px; font-family: ui-monospace, monospace; }
  .url { font-family: ui-monospace, monospace; color: #0a66c2; }
  .foot-src { color: #777; font-size: 10.5px; margin-top: 4px; }
  .toolbar { margin: 8px 0 18px; }
  .toolbar button { font: 13px sans-serif; padding: 8px 16px; border: 1px solid #0a66c2; background: #0a66c2; color: #fff; border-radius: 6px; cursor: pointer; }
  .field-group-h { font-family: Georgia, serif; font-size: 16px; font-weight: 700; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 2px solid #888; }
  section { border: 1px solid #ddd; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; break-inside: avoid; }
  h2 { font-size: 15px; margin: 0 0 8px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: #666; margin: 10px 0 4px; }
  pre.raw { font: 12px ui-monospace, monospace; background: #f5f5f5; border: 1px solid #e5e5e5; border-radius: 6px; padding: 8px; white-space: pre-wrap; margin: 0; }
  .none { color: #777; font-style: italic; }
  .taf-p { margin: 6px 0; padding-left: 8px; border-left: 3px solid #cfe0f3; }
  .taf-l { font-family: ui-monospace, monospace; font-size: 12px; color: #0a66c2; }
  .taf-p ul { margin: 3px 0; padding-left: 18px; }
  .ahas { display: flex; align-items: center; gap: 10px; }
  .lvl { font-weight: 700; border: 1px solid; border-radius: 5px; padding: 2px 10px; }
  .ahas-note { color: #333; }
  .when { color: #666; font-size: 12px; margin-top: 4px; }
  .strip { display: flex; flex-wrap: wrap; gap: 3px; margin: 6px 0 2px; }
  .hr { text-align: center; }
  .hr-t { font: 9px ui-monospace, monospace; color: #777; }
  .hr-l { font: 700 11px ui-monospace, monospace; color: #fff; width: 26px; height: 22px; line-height: 22px; border-radius: 4px; }
  .route-ahas { padding: 4px 0; border-top: 1px solid #f0f0f0; }
  .src { color: #999; font-size: 11px; margin-top: 4px; }
  .notam { display: flex; gap: 8px; padding: 6px 0; border-top: 1px solid #f0f0f0; }
  .notam .cat { font: 10px ui-monospace, monospace; font-weight: 700; background: #eef; color: #335; border-radius: 4px; padding: 2px 6px; height: fit-content; white-space: nowrap; }
  .notam .txt { font-family: ui-monospace, monospace; font-size: 12px; }
  .count { font-weight: 400; font-size: 12px; color: #777; }
  .foot { color: #999; font-size: 11px; margin-top: 10px; }
  @media print { .toolbar { display: none; } body { padding: 0; } section { border-color: #ccc; } }
`;

/**
 * Build the combined reference page for one or more sortie bases.
 * @param {Array<{icao:string, when:?string, label:string}>} fields  bases (dep/rec/alt) + times
 * @param {('all'|'notams'|'wx'|'ahas')} only  which sections to include
 * @param {boolean} autoPrint  open the print dialog on load (Build PDF)
 * @param {string[]} routes  low-level/AR route ids (for the AHAS section)
 * @param {?string} routeWhen  route entry time
 */
export async function buildRefCard(fields, only = 'all', autoPrint = false, routes = [], routeWhen = null) {
  const want = (k) => only === 'all' || only === k;

  // Dedupe bases that are the SAME location AND time (e.g. an out-and-back where
  // departure and recovery are the same field at the same time) — fetch + show
  // once, merging the labels ("Departure / Recovery").
  const seen = new Map();
  const uniqueFields = [];
  for (const f of fields) {
    const key = `${f.icao}|${f.when || ''}`;
    const dup = seen.get(key);
    if (dup) { if (f.label && !dup.label.split(' / ').includes(f.label)) dup.label += ` / ${f.label}`; continue; }
    const e = { ...f };
    seen.set(key, e);
    uniqueFields.push(e);
  }
  fields = uniqueFields;

  // Per-field live data (each base at its own time), all in parallel.
  const data = await Promise.all(fields.map(async (f) => {
    const area = ahasAreaForIcao(f.icao);
    const [airport, wx, notamRes, ahas] = await Promise.all([
      getAirport(f.icao, false).catch(() => null),
      want('wx') ? loadWeather([f.icao], false).catch(() => ({ obs: [], tafs: new Map() })) : Promise.resolve({ obs: [], tafs: new Map() }),
      want('notams') ? fetchNotams([f.icao], false).catch(() => ({ notams: [], source: null })) : Promise.resolve({ notams: [], source: null }),
      (want('ahas') && area) ? ahas12('MILAIR', area, f.when).catch(() => null) : Promise.resolve(null),
    ]);
    return { f, airport, wx, notamRes, ahas };
  }));

  // Route AHAS once (shared low-level phase).
  const routeAhas = want('ahas')
    ? await Promise.all(routes.map(async (id) => {
        const type = ahasRouteType(id);
        if (!type || !ahasHasRoute(id)) return { id, ahas: null };
        return { id, ahas: await ahas12(type, normRoute(id), routeWhen).catch(() => null) };
      }))
    : [];

  let body = '';
  for (const { f, wx, notamRes, ahas } of data) {
    const label = f.label ? `${f.icao} (${f.label})` : f.icao;
    // For the combined view, group a base's sections under a heading.
    if (only === 'all') body += `<div class="field-group-h">${esc(label)}</div>`;
    if (want('notams')) body += notamSection(label, (notamRes.notams || []).filter((n) => n.icao?.toUpperCase() === f.icao), notamRes.source);
    if (want('wx')) {
      const obs = (wx.obs || []).find((o) => o.icao?.toUpperCase() === f.icao);
      const tafRaw = wx.tafs?.get(f.icao);
      body += wxSection(label, obs, tafRaw, decodeTaf(tafRaw));
    }
    if (want('ahas')) body += ahasFieldSection(label, ahas);
  }
  if (want('ahas') && routeAhas.length) {
    if (only === 'all') body += '<div class="field-group-h">Low-Level / AR</div>';
    body += routeAhasSection(routeAhas);
  }

  const titleMap = { all: 'Field Reference', notams: 'NOTAMs', wx: 'Aviation Weather', ahas: 'AHAS Bird Risk (12-hr)' };
  const fieldList = fields.map((f) => `${esc(f.label || '')} ${esc(f.icao)}`.trim()).join(' · ');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fieldList)} ${esc(titleMap[only] || 'Reference')}</title><style>${STYLE}</style></head>
<body>
  <header class="doc-head">
    <div class="doc-title">MISSION REFERENCE — ${esc(titleMap[only] || 'Reference')}</div>
    <div class="doc-meta">${esc(fieldList)}${routeAhas.length ? ` · routes ${esc(routes.join(', '))}` : ''} · Generated ${esc(nowZ())}</div>
  </header>
  <div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
  ${body}
  <footer class="foot">
    <div>PLANNING AID ONLY — verify with official sources.</div>
    <div class="foot-src">Official sources: DoD DAIP (daip.jcs.mil) · FAA / NWS Aviation Weather Center (aviationweather.gov) · USAF AHAS (usahas.com)</div>
  </footer>
  ${autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},400);});</script>' : ''}
</body></html>`;
}
