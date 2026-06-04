// C-17 Mission Planner — static frontend (no framework, no build).
// Talks to the zero-dependency Node API and renders the EFB-style brief.

import { initMap } from './map.js';

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => Number(n).toFixed(d);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- Wind compass (SVG) ----------------------------------------------------
const SIZE = 130, CX = SIZE / 2, R = 56;
function pt(bearingDeg, radius) {
  const a = (bearingDeg * Math.PI) / 180;
  return { x: CX + radius * Math.sin(a), y: CX - radius * Math.cos(a) };
}
function arrowHead(from, to, color) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const len = 7, spread = 0.5;
  const p1 = { x: to.x - len * Math.cos(ang - spread), y: to.y - len * Math.sin(ang - spread) };
  const p2 = { x: to.x - len * Math.cos(ang + spread), y: to.y - len * Math.sin(ang + spread) };
  return `<polyline points="${p1.x},${p1.y} ${to.x},${to.y} ${p2.x},${p2.y}" stroke="${color}" fill="none"/>`;
}
function compassSvg(analysis, xwLimit) {
  const active = analysis.active;
  const wind = analysis.observation.wind;
  const hasWind = !analysis.windIndeterminate && typeof wind.dirTrue === 'number';

  let windColor = 'var(--go)';
  if (active) {
    if (active.crosswindKt >= xwLimit) windColor = 'var(--nogo)';
    else if (active.crosswindKt >= xwLimit * 0.6) windColor = 'var(--caution)';
  }

  let s = `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="wind compass">`;
  s += `<circle cx="${CX}" cy="${CX}" r="${R}" fill="#0c121a" stroke="var(--border-bright)" stroke-width="1"/>`;
  for (let b = 0; b < 360; b += 30) {
    const o = pt(b, R), i = pt(b, b % 90 === 0 ? R - 8 : R - 4);
    s += `<line x1="${o.x}" y1="${o.y}" x2="${i.x}" y2="${i.y}" stroke="var(--border-bright)" stroke-width="1"/>`;
  }
  ['N', 'E', 'S', 'W'].forEach((lbl, i) => {
    const p = pt(i * 90, R - 16);
    s += `<text x="${p.x}" y="${p.y + 3}" text-anchor="middle" font-size="8" font-family="var(--mono)" fill="${lbl === 'N' ? 'var(--accent)' : 'var(--text-faint)'}">${lbl}</text>`;
  });
  if (active) {
    const e1 = pt(active.trueHeading, R - 8), e2 = pt(active.trueHeading + 180, R - 8);
    s += `<line x1="${e1.x}" y1="${e1.y}" x2="${e2.x}" y2="${e2.y}" stroke="#e6edf3" stroke-width="9" stroke-linecap="round" opacity="0.9"/>`;
    s += `<line x1="${e1.x}" y1="${e1.y}" x2="${e2.x}" y2="${e2.y}" stroke="#0a0e14" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  }
  if (hasWind) {
    const src = pt(wind.dirTrue, R + 4), tip = pt(wind.dirTrue, 14);
    s += `<g stroke="${windColor}" stroke-width="3" stroke-linecap="round" fill="none">`;
    s += `<line x1="${src.x}" y1="${src.y}" x2="${tip.x}" y2="${tip.y}"/>`;
    s += arrowHead(src, tip, windColor);
    s += `</g>`;
  }
  s += `<circle cx="${CX}" cy="${CX}" r="3" fill="var(--accent)"/>`;
  if (!hasWind) {
    s += `<text x="${CX}" y="${CX + 22}" text-anchor="middle" font-size="8" font-family="var(--mono)" fill="var(--text-dim)">${wind.dirTrue === 'VRB' ? 'VRB' : 'CALM'}</text>`;
  }
  return s + `</svg>`;
}

// ---- Card rendering --------------------------------------------------------
function formatWind(wind) {
  if (wind.dirTrue === null && wind.speedKt === 0) return 'CALM';
  const dir = wind.dirTrue === 'VRB' ? 'VRB' : String(wind.dirTrue).padStart(3, '0');
  return `${dir}° / ${wind.speedKt}${wind.gustKt ? 'G' + wind.gustKt : ''} kt`;
}

function notamRow(n) {
  const end = n.effectiveEnd ? `<div class="when">until ${esc(n.effectiveEnd.slice(0, 16).replace('T', ' '))}Z</div>` : '';
  return `<div class="notam"><span class="cat cat-${esc(n.category)}">${esc(n.category)}</span>
    <div><div class="txt">${esc(n.text)}</div>${end}</div></div>`;
}

function runwayRows(a, brief) {
  const closed = new Set(brief.closedRunways.map((r) => r.toUpperCase()));
  return a.runways.map((r) => {
    const isClosed = closed.has(r.ident.toUpperCase());
    const isActive = a.active && a.active.ident === r.ident;
    const xw = `XW ${fmt(r.crosswindKt)}${r.crosswindSide !== 'none' ? ' ' + r.crosswindSide[0].toUpperCase() : ''}`;
    return `<div class="rwy-row ${isActive ? 'active' : ''} ${isClosed ? 'closed' : ''}">
      <span class="id">${esc(r.ident)}</span>
      <span class="${r.isTailwind ? 'tw' : ''}">${r.isTailwind ? 'TW' : 'HW'} ${fmt(Math.abs(r.headwindKt))}</span>
      <span>${xw}</span>
      <span class="star">${brief.recommendedRunway === r.ident ? '★' : ''}</span>
    </div>`;
  }).join('');
}

const BIRD_COLOR = { LOW: 'var(--go)', MODERATE: 'var(--caution)', SEVERE: 'var(--nogo)' };

function windsAloftSection(brief) {
  const wa = brief.windsAloft;
  if (!wa || !wa.profile.length) return '';
  const rows = wa.profile
    .slice()
    .reverse()
    .map((p) => {
      const lbl = p.altFt >= 1000 ? (p.altFt / 1000).toFixed(1) + 'k' : String(p.altFt);
      return `<div class="as-row"><span class="cat cat-LIGHTING">${esc(lbl)}</span>
        <div><div class="txt">${esc(p.altFt.toLocaleString())} ft MSL — ${String(p.dirTrue).padStart(3, '0')}°/${p.speedKt} kt</div></div></div>`;
    })
    .join('');
  const t = wa.time ? `<span class="count">${esc(wa.time.slice(11, 16))}Z fcst</span>` : '';
  return `<div><div class="section-title">Winds Aloft ${t}</div>
    <div class="notams" style="margin-top:8px">${rows}</div></div>`;
}

function airspaceSection(brief) {
  const as = brief.airspace;
  if (!as) return '';
  const raimClass = as.raim.status === 'PREDICTED OUTAGE' ? 'cat-RUNWAY' : 'cat-LIGHTING';
  const tfrRows = as.tfrs.map((t) => {
    const inside = t.distanceNm === 0;
    return `<div class="as-row"><span class="cat cat-RUNWAY">TFR</span>
      <div><div class="txt">${esc(t.type)} · ${esc(t.name)} ${inside ? '<b style="color:var(--nogo)">INSIDE</b>' : esc(t.distanceNm) + ' NM'}</div>
      <div class="when">SFC–${t.upperFt != null ? esc(t.upperFt.toLocaleString()) + ' ft' : '—'}${t.effectiveEnd ? ' · until ' + esc(t.effectiveEnd.slice(0, 16).replace('T', ' ')) + 'Z' : ''}</div></div></div>`;
  }).join('');
  const suaRows = as.sua.map((s) => {
    const sc = s.status === 'active' ? 'cat-RUNWAY' : s.status === 'scheduled' ? 'cat-APPROACH' : 'cat-LIGHTING';
    return `<div class="as-row"><span class="cat ${sc}">${esc(s.type)}</span>
      <div><div class="txt">${esc(s.id)} · ${esc(s.status.toUpperCase())} · ${s.distanceNm === 0 ? '<b>OVERHEAD</b>' : esc(s.distanceNm) + ' NM'}</div>
      <div class="when">${esc(s.schedule || '')}${s.lowerFt != null ? ' · ' + esc(s.lowerFt.toLocaleString()) + '–' + esc((s.upperFt ?? 0).toLocaleString()) + ' ft' : ''}</div></div></div>`;
  }).join('');
  const raimWin = as.raim.windows.map((w) => {
    const inl = (w.inlineRanges || []).map((r) => `${r.start}–${r.end}`).join(', ');
    const abs = w.start ? `${w.start.slice(11, 16)}Z–${(w.end || '').slice(11, 16)}Z` : '';
    return `<div class="when" style="margin-left:2px">• ${esc(inl || abs || w.raw)}</div>`;
  }).join('');

  return `<div><div class="section-title">Airspace &amp; RAIM
      <span class="cat ${raimClass}" style="margin-left:auto">RAIM: ${esc(as.raim.status)}</span></div>
    <div class="notams" style="margin-top:8px">
      ${tfrRows || ''}${suaRows || ''}
      ${raimWin ? `<div class="as-row"><span class="cat ${raimClass}">GPS</span><div><div class="txt">Predicted RAIM outage</div>${raimWin}</div></div>` : ''}
      ${!as.tfrs.length && !as.sua.length && as.raim.status !== 'PREDICTED OUTAGE'
        ? '<div class="readout" style="font-size:12px">No TFRs or SUA within 100 NM · RAIM nominal.</div>' : ''}
    </div></div>`;
}

function card(brief, limits) {
  if (!brief.found) {
    return `<div class="missing-card"><span class="icao">${esc(brief.icao)}</span> — not in the reference dataset yet.
      <div style="margin-top:6px;font-size:12px">Add it via NASR/OpenAIP ingest, or pick a bundled field.</div></div>`;
  }
  const a = brief.analysis;
  const ap = brief.airport;
  const statusClass = 'status-' + brief.status.replace('-', '');
  let body = '';

  if (a) {
    const active = a.active;
    const highDA = a.densityAltitudeFt != null && limits.highda && a.densityAltitudeFt > limits.highda;
    const xwClass = active
      ? (active.crosswindKt >= limits.xwind ? 'high' : active.crosswindKt >= limits.xwind * 0.6 ? 'mod' : '')
      : '';

    let windReadout;
    if (active) {
      const rec = brief.recommendedRunway || active.ident;
      const closedNote = brief.recommendedRunway && brief.recommendedRunway !== active.ident
        ? `<span style="color:var(--caution);font-size:11px">(wind-best ${esc(active.ident)} closed)</span>` : '';
      const gust = active.gustCrosswindKt != null
        ? `<div class="gust-note">gust: HW ${fmt(Math.abs(active.gustHeadwindKt))} · XW ${fmt(active.gustCrosswindKt)} kt</div>` : '';
      const pw = brief.patternWind;
      const pwLine = pw
        ? `<div class="gust-note" style="color:var(--accent)">pattern @${pw.altFt.toLocaleString()} MSL: ${String(pw.dirTrue).padStart(3, '0')}/${pw.speedKt} → HW ${pw.headwindKt} · XW ${pw.crosswindKt}${pw.crosswindSide !== 'none' ? ' ' + pw.crosswindSide[0].toUpperCase() : ''}</div>`
        : '';
      windReadout = `
        <div class="active-rwy">RWY <b>${esc(rec)}</b>${closedNote}</div>
        <div class="comp">
          <div class="box ${active.isTailwind ? 'tw' : ''}"><div class="lbl">${active.isTailwind ? 'Tailwind' : 'Headwind'}</div><div class="val">${fmt(Math.abs(active.headwindKt))}</div></div>
          <div class="box xw ${xwClass}"><div class="lbl">Xwind ${active.crosswindSide !== 'none' ? active.crosswindSide[0].toUpperCase() : ''}</div><div class="val">${fmt(active.crosswindKt)}</div></div>
        </div>${gust}${pwLine}`;
    } else {
      windReadout = `<div class="active-rwy" style="color:var(--text-dim)">Wind calm / variable — pilot discretion</div>`;
    }

    const warns = a.warnings.length
      ? `<div class="warnings">${a.warnings.map((w) =>
          `<div class="warn-item ${/exceeds|CLOSED/.test(w) ? 'crit' : ''}"><span class="ico">⚠</span><span>${esc(w)}</span></div>`).join('')}</div>`
      : '';

    body = `
      <div class="readout"><div class="raw">${esc(a.observation.rawText || 'No raw report')}</div></div>
      <div class="metrics">
        <div class="metric"><div class="k">Wind</div><div class="v" style="font-size:13px">${esc(formatWind(a.observation.wind))}</div></div>
        <div class="metric"><div class="k">Temp</div><div class="v">${a.observation.tempC ?? '--'}<small>°C</small></div></div>
        <div class="metric"><div class="k">Altimeter</div><div class="v">${a.observation.altimHpa ?? '--'}<small> hPa</small></div></div>
        <div class="metric ${highDA ? 'warn' : ''}"><div class="k">Density Alt</div><div class="v">${a.densityAltitudeFt != null ? a.densityAltitudeFt.toLocaleString() : '--'}<small> ft</small></div></div>
        ${brief.birdRisk ? `<div class="metric ${brief.birdRisk.level !== 'LOW' ? 'warn' : ''}"><div class="k">Bird Risk</div><div class="v" style="font-size:14px;color:${BIRD_COLOR[brief.birdRisk.level]}">${esc(brief.birdRisk.level)}</div></div>` : ''}
      </div>
      <div class="wind-block"><div class="compass">${compassSvg(a, limits.xwind)}</div><div class="wind-readout">${windReadout}</div></div>
      <div class="rwys">${runwayRows(a, brief)}</div>
      ${warns}`;
  } else {
    body = `<div class="readout">No weather observation available for this field.</div>`;
  }

  const notams = `<div><div class="section-title">NOTAMs <span class="count">${brief.notams.length}</span></div>
    <div class="notams" style="margin-top:8px">${brief.notams.length ? brief.notams.map(notamRow).join('') : '<div class="readout" style="font-size:12px">None retrieved.</div>'}</div></div>`;
  const taf = brief.taf ? `<div><div class="section-title">TAF</div><div class="taf" style="margin-top:8px">${esc(brief.taf)}</div></div>` : '';

  return `<div class="card">
    <div class="head"><div><div class="icao">${esc(ap.icao)}</div><div class="name">${esc(ap.name)}</div></div>
      <div class="spacer"></div><div class="status-led ${statusClass}">${esc(brief.status)}</div></div>
    <div class="body">${body}${windsAloftSection(brief)}${airspaceSection(brief)}${notams}${taf}</div></div>`;
}

// ---- Data + events ---------------------------------------------------------
function readLimits() {
  return {
    xwind: Number($('xwind').value) || 25,
    tailwind: Number($('tailwind').value) || 10,
    highda: Number($('highda').value) || 5000,
  };
}

function setSourcePills(live) {
  const wx = $('wx-source'), nt = $('notam-source');
  wx.textContent = live.weather ? 'WX: LIVE' : 'WX: DEMO';
  wx.className = 'pill ' + (live.weather ? 'live' : 'fixture');
  nt.textContent = live.notams ? 'NOTAM: LIVE' : 'NOTAM: DEMO';
  nt.className = 'pill ' + (live.notams ? 'live' : 'fixture');
}

async function buildBrief() {
  const ids = $('icaos').value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!ids.length) return;
  const limits = readLimits();
  const params = new URLSearchParams({
    ids: ids.join(','), xwind: limits.xwind, tailwind: limits.tailwind, highda: limits.highda,
  });
  if ($('offline').checked) params.set('offline', '1');

  $('go').disabled = true;
  $('results').innerHTML = `<div class="loading"><div class="spinner"></div>Pulling weather &amp; NOTAMs…</div>`;
  try {
    const res = await fetch(`/api/brief?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setSourcePills(data.live);
    $('results').innerHTML = `<div class="grid">${data.airfields.map((b) => card(b, limits)).join('')}</div>`;
    updatePrintHead(data, ids, limits);
    renderMap(data);
  } catch (err) {
    $('results').innerHTML = `<div class="errbox">Failed to build brief: ${esc(err.message)}<br/>
      <span style="color:var(--text-dim);font-size:12px">Is the server running? Try the offline/demo toggle.</span></div>`;
  } finally {
    $('go').disabled = false;
  }
}

async function loadQuickChips() {
  try {
    const res = await fetch('/api/airfields');
    const { airfields } = await res.json();
    $('quick').innerHTML = airfields.map((a) => `<span class="chip" data-icao="${a}">+ ${a}</span>`).join('');
    $('quick').querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const cur = $('icaos').value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
        const icao = chip.dataset.icao;
        if (!cur.includes(icao)) $('icaos').value = [...cur, icao].join(' ');
      });
    });
  } catch { /* server may be down; chips are optional */ }
}

function renderMap(data) {
  const mapEl = $('map');
  const airfields = data.airfields
    .filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lon))
    .map((b) => ({ icao: b.icao, lat: b.lat, lon: b.lon, status: b.status }));
  if (airfields.length === 0) {
    mapEl.style.display = 'none';
    return;
  }
  mapEl.style.display = '';
  const as = data.airspace || { tfrs: [], sua: [] };
  initMap(mapEl, { airfields, tfrs: as.tfrs, sua: as.sua });
}

function updatePrintHead(data, ids, limits) {
  const gen = new Date(data.generatedAt);
  const z = gen.toISOString().slice(0, 16).replace('T', ' ');
  const src = `WX ${data.live.weather ? 'LIVE' : 'DEMO'} · NOTAM ${data.live.notams ? 'LIVE' : 'DEMO'}`;
  $('print-head').innerHTML =
    `<div class="ph-title">C-17 MISSION BRIEF</div>
     <div class="ph-meta">${esc(ids.join(' · '))}</div>
     <div class="ph-meta">Generated ${esc(z)}Z · ${esc(src)} · Limits: XW ${limits.xwind} / TW ${limits.tailwind} kt, DA ${limits.highda} ft</div>
     <div class="ph-meta ph-warn">PLANNING AID ONLY — VERIFY WITH OFFICIAL SOURCES</div>`;
}

$('go').addEventListener('click', buildBrief);
$('print').addEventListener('click', () => window.print());
$('icaos').addEventListener('keydown', (e) => { if (e.key === 'Enter') buildBrief(); });
loadQuickChips();
buildBrief();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
