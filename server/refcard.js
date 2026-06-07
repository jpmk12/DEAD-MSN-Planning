// Server-rendered "reference card": a single printable page that combines the
// three external references for one field — DAIP NOTAMs, AWC METAR + decoded
// TAF, and AHAS bird risk — using the same live fetchers the brief uses (so the
// data shows even though the external SPAs can't be deep-linked). Returned as a
// self-contained, print-friendly HTML document (Build PDF → window.print()).

import { getAirport } from './data/airports.js';
import { loadWeather } from './data/weather.js';
import { decodeTaf } from './data/taf.js';
import { fetchNotams } from './data/notams.js';
import { fetchBirdRisk } from './data/birds.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
    <h3>TAF (decoded)</h3>${taf}</section>`;
}

function ahasSection(icao, bird) {
  if (!bird) return `<section><h2>AHAS Bird Risk — ${esc(icao)}</h2><div class="none">No AHAS risk available for this field.</div></section>`;
  const when = bird.runAt ? `${bird.windowHours ? `${bird.windowHours}-hr outlook from ` : 'valid '}${zulu(bird.runAt)}` : '';
  const color = bird.level === 'SEVERE' ? '#b3231b' : bird.level === 'MODERATE' ? '#b5840a' : '#1a7f37';
  return `<section><h2>AHAS Bird Risk — ${esc(icao)}</h2>
    <div class="ahas"><span class="lvl" style="color:${color};border-color:${color}">${esc(bird.level)}</span>
      <span class="ahas-note">${esc(bird.note || '')}</span></div>
    ${when ? `<div class="when">${esc(when)}</div>` : ''}
    <div class="src">Source: USAF AHAS (usahas.com)</div></section>`;
}

function notamSection(icao, notams, source) {
  if (!notams.length) return `<section><h2>NOTAMs — ${esc(icao)}</h2><div class="none">No NOTAMs retrieved${source ? ` (${esc(source)})` : ''}.</div></section>`;
  const rows = notams.map((n) => {
    const end = n.effectiveEnd ? `<div class="when">until ${esc(zulu(n.effectiveEnd))}</div>` : '';
    return `<div class="notam"><span class="cat">${esc(n.category || 'OTHER')}</span><div><div class="txt">${esc(n.text)}</div>${end}</div></div>`;
  }).join('');
  return `<section><h2>NOTAMs — ${esc(icao)} <span class="count">${notams.length}${source ? ` · ${esc(source)}` : ''}</span></h2>${rows}</section>`;
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; color: #111; margin: 0; padding: 24px; max-width: 900px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #555; margin-bottom: 6px; }
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
export async function buildRefCard(icao, whenIso, only = 'all', autoPrint = false) {
  const want = (k) => only === 'all' || only === k;
  const [airport, wx, notamRes, birdRes] = await Promise.all([
    getAirport(icao, false).catch(() => null),
    want('wx') ? loadWeather([icao], false).catch(() => ({ obs: [], tafs: new Map() })) : Promise.resolve({ obs: [], tafs: new Map() }),
    want('notams') ? fetchNotams([icao], false).catch(() => ({ notams: [], source: null })) : Promise.resolve({ notams: [], source: null }),
    want('ahas') ? fetchBirdRisk([icao], false, whenIso).catch(() => ({ risk: new Map() })) : Promise.resolve({ risk: new Map() }),
  ]);

  const obs = (wx.obs || []).find((o) => o.icao?.toUpperCase() === icao);
  const tafRaw = wx.tafs?.get(icao);
  const bird = birdRes.risk?.get(icao) || null;
  const notams = (notamRes.notams || []).filter((n) => n.icao?.toUpperCase() === icao);

  const titleMap = { all: 'Field Reference', notams: 'NOTAMs', wx: 'Aviation Weather', ahas: 'AHAS Bird Risk' };
  let body = '';
  if (want('notams')) body += notamSection(icao, notams, notamRes.source);
  if (want('wx')) body += wxSection(icao, obs, tafRaw, decodeTaf(tafRaw));
  if (want('ahas')) body += ahasSection(icao, bird);

  const name = airport?.name ? ` — ${esc(airport.name)}` : '';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(icao)} ${esc(titleMap[only] || 'Reference')}</title><style>${STYLE}</style></head>
<body>
  <h1>${esc(icao)}${name}</h1>
  <div class="sub">${esc(titleMap[only] || 'Reference')} · generated ${esc(zulu(new Date().toISOString()))}${whenIso ? ` · for ${esc(zulu(whenIso))}` : ''}</div>
  <div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
  ${body}
  <div class="foot">Planning aid only — verify with official sources (DAIP, aviationweather.gov, usahas.com).</div>
  ${autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},400);});</script>' : ''}
</body></html>`;
}
