// Server-rendered "reference card": a single printable page that combines the
// three external references for one field — DAIP NOTAMs, AWC METAR + decoded
// TAF, and AHAS bird risk — using the same live fetchers the brief uses (so the
// data shows even though the external SPAs can't be deep-linked). Returned as a
// self-contained, print-friendly HTML document (Build PDF → window.print()).

import { getAirport } from './data/airports.js';
import { loadWeather } from './data/weather.js';
import { decodeTaf } from './data/taf.js';
import { fetchNotams } from './data/notams.js';
import { advisoryFor } from './data/birds.js';
import { ahasRaw, parseAhasLevel, parseAhasSeries, ahasAreaForIcao, ahasRouteType, ahasHasRoute, ahasRunAtIso } from './data/ahasapi.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const nowZ = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
};
// Official source citation line shown under each section.
const cite = (label, url) => `<div class="src">Source: ${esc(label)} — <span class="url">${esc(url)}</span> · retrieved ${nowZ()}</div>`;

function zulu(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}

function wxSection(icao, obs, tafRaw, decoded) {
  const metar = obs?.rawText ? `<pre class="raw">${esc(obs.rawText)}</pre>` : '<div class="none">METAR unavailable.</div>';
  let taf = '<div class="none">No TAF issued for this field.</div>';
  if (tafRaw) {
    const periods = (decoded?.periods || []).map((p) => {
      const items = [...(p.items || []), ...(p.extra || [])].map((it) => `<li>${esc(it)}</li>`).join('');
      return `<div class="taf-p"><div class="taf-l">${esc(p.label)}${p.when ? ` · ${esc(p.when)}` : ''}</div><ul>${items}</ul></div>`;
    }).join('');
    taf = `<pre class="raw">${esc(tafRaw)}</pre>${periods}`;
  }
  return `<section><h2>Aviation Weather — ${esc(icao)}</h2>
    <h3>METAR</h3>${metar}
    <h3>TAF (decoded)</h3>${taf}
    ${cite('FAA / NWS Aviation Weather Center', 'aviationweather.gov')}</section>`;
}

const riskColor = (lvl) => (lvl === 'SEVERE' ? '#b3231b' : lvl === 'MODERATE' ? '#b5840a' : '#1a7f37');
const normRoute = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

// Fetch the 12-hour AHAS outlook (GetAHASRisk12): worst level + the hourly
// series, starting at whenIso (or now). Returns null on failure/unmapped.
async function ahas12(type, area, whenIso) {
  try {
    const xml = await ahasRaw('GetAHASRisk12', type, area, whenIso);
    const series = parseAhasSeries(xml);
    const level = parseAhasLevel(xml);
    if (!level && !series.length) return null;
    return { level, series, runAt: ahasRunAtIso(whenIso) };
  } catch { return null; }
}

// 12-hour hourly strip: one cell per forecast hour (Zulu), color-coded.
function hourlyStrip(series, startIso) {
  if (!series || series.length < 2) return '';
  const start = startIso ? new Date(startIso) : new Date();
  const h0 = Number.isNaN(start.getTime()) ? new Date().getUTCHours() : start.getUTCHours();
  const cells = series.map((lvl, i) => {
    const h = String((h0 + i) % 24).padStart(2, '0');
    return `<div class="hr"><div class="hr-t">${h}Z</div><div class="hr-l" title="${esc(lvl)}" style="background:${riskColor(lvl)}">${esc(lvl[0])}</div></div>`;
  }).join('');
  return `<div class="strip">${cells}</div>`;
}

function ahasBlock(a) {
  if (!a || (!a.level && !(a.series || []).length)) return '<div class="none">No AHAS risk available.</div>';
  const worst = a.level || (a.series || [])[0];
  const head = `<div class="ahas"><span class="lvl" style="color:${riskColor(worst)};border-color:${riskColor(worst)}">${esc(worst)}</span>
    <span class="ahas-note">12-hr worst case — ${esc(advisoryFor(worst))}</span></div>`;
  const when = a.runAt ? `<div class="when">12-hr outlook from ${esc(zulu(a.runAt))}</div>` : '';
  return `${head}${when}${hourlyStrip(a.series, a.runAt)}`;
}

function ahasSection(icao, airfield, routes = []) {
  const routeRows = routes.length ? `<h3>Low-Level / AR routes (12-hr)</h3>${routes.map((r) => {
    if (!r.ahas) return `<div class="notam"><span class="cat">${esc(r.id)}</span><div><div class="txt none">No AHAS data (route not covered by AHAS — e.g. AR tracks — or unavailable).</div></div></div>`;
    const worst = r.ahas.level || (r.ahas.series || [])[0];
    return `<div class="route-ahas"><div class="notam"><span class="cat" style="color:${riskColor(worst)};background:#fff;border:1px solid ${riskColor(worst)}">${esc(r.id)}</span>
      <div><div class="txt"><b style="color:${riskColor(worst)}">${esc(worst)}</b> 12-hr worst${r.ahas.runAt ? ` · from ${esc(zulu(r.ahas.runAt))}` : ''}</div></div></div>
      ${hourlyStrip(r.ahas.series, r.ahas.runAt)}</div>`;
  }).join('')}` : '';
  return `<section><h2>AHAS Bird Risk (12-hour) — ${esc(icao)}</h2>
    <h3>Airfield</h3>${ahasBlock(airfield)}
    ${routeRows}
    ${cite('USAF Avian Hazard Advisory System', 'usahas.com')}</section>`;
}

function notamSection(icao, notams, source) {
  if (!notams.length) return `<section><h2>NOTAMs — ${esc(icao)}</h2><div class="none">No NOTAMs retrieved${source ? ` (${esc(source)})` : ''}.</div></section>`;
  const rows = notams.map((n) => {
    const end = n.effectiveEnd ? `<div class="when">until ${esc(zulu(n.effectiveEnd))}</div>` : '';
    return `<div class="notam"><span class="cat">${esc(n.category || 'OTHER')}</span><div><div class="txt">${esc(n.text)}</div>${end}</div></div>`;
  }).join('');
  return `<section><h2>NOTAMs — ${esc(icao)} <span class="count">${notams.length}${source ? ` · ${esc(source)}` : ''}</span></h2>${rows}
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
 * Build the combined reference page HTML for one field.
 * @param {string} icao
 * @param {string|null} whenIso  time for AHAS (departure time); defaults to now
 * @param {('all'|'notams'|'wx'|'ahas')} only  which sections to include
 * @param {boolean} autoPrint  open the print dialog on load (Build PDF)
 */
export async function buildRefCard(icao, whenIso, only = 'all', autoPrint = false, routes = [], routeWhen = null) {
  const want = (k) => only === 'all' || only === k;
  // 12-hour airfield AHAS (GetAHASRisk12) at the departure time.
  const airfieldArea = ahasAreaForIcao(icao);
  const airfieldAhasP = (want('ahas') && airfieldArea) ? ahas12('MILAIR', airfieldArea, whenIso) : Promise.resolve(null);
  // 12-hour AHAS per low-level/AR route at the entry time (AR tracks aren't
  // covered by AHAS, so they resolve to no data).
  const routeAhasP = want('ahas')
    ? Promise.all(routes.map(async (id) => {
        const type = ahasRouteType(id);
        if (!type || !ahasHasRoute(id)) return { id, ahas: null };
        return { id, ahas: await ahas12(type, normRoute(id), routeWhen || whenIso) };
      }))
    : Promise.resolve([]);

  const [airport, wx, notamRes, airfieldAhas, routeAhas] = await Promise.all([
    getAirport(icao, false).catch(() => null),
    want('wx') ? loadWeather([icao], false).catch(() => ({ obs: [], tafs: new Map() })) : Promise.resolve({ obs: [], tafs: new Map() }),
    want('notams') ? fetchNotams([icao], false).catch(() => ({ notams: [], source: null })) : Promise.resolve({ notams: [], source: null }),
    airfieldAhasP.catch(() => null),
    routeAhasP.catch(() => []),
  ]);

  const obs = (wx.obs || []).find((o) => o.icao?.toUpperCase() === icao);
  const tafRaw = wx.tafs?.get(icao);
  const notams = (notamRes.notams || []).filter((n) => n.icao?.toUpperCase() === icao);

  const titleMap = { all: 'Field Reference', notams: 'NOTAMs', wx: 'Aviation Weather', ahas: 'AHAS Bird Risk' };
  let body = '';
  if (want('notams')) body += notamSection(icao, notams, notamRes.source);
  if (want('wx')) body += wxSection(icao, obs, tafRaw, decodeTaf(tafRaw));
  if (want('ahas')) body += ahasSection(icao, airfieldAhas, routeAhas);

  const name = airport?.name ? ` — ${esc(airport.name)}` : '';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(icao)} ${esc(titleMap[only] || 'Reference')}</title><style>${STYLE}</style></head>
<body>
  <header class="doc-head">
    <div class="doc-title">MISSION REFERENCE — ${esc(icao)}${name}</div>
    <div class="doc-meta">${esc(titleMap[only] || 'Reference')} · Generated ${esc(nowZ())}${whenIso ? ` · Valid for ${esc(zulu(whenIso))}` : ''}</div>
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
