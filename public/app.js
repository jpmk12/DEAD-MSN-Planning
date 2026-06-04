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
function compassSvg(analysis, xwLimit, rwy) {
  const wind = analysis.observation.wind;
  const hasWind = !analysis.windIndeterminate && typeof wind.dirTrue === 'number';

  let windColor = 'var(--go)';
  if (rwy) {
    if (rwy.crosswindKt >= xwLimit) windColor = 'var(--nogo)';
    else if (rwy.crosswindKt >= xwLimit * 0.6) windColor = 'var(--caution)';
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
  if (rwy) {
    const e1 = pt(rwy.trueHeading, R - 8), e2 = pt(rwy.trueHeading + 180, R - 8);
    s += `<line x1="${e1.x}" y1="${e1.y}" x2="${e2.x}" y2="${e2.y}" stroke="#e6edf3" stroke-width="9" stroke-linecap="round" opacity="0.9"/>`;
    s += `<line x1="${e1.x}" y1="${e1.y}" x2="${e2.x}" y2="${e2.y}" stroke="#0a0e14" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    // runway-end label at the approach end
    const lp = pt(rwy.trueHeading + 180, R - 2);
    s += `<text x="${lp.x}" y="${lp.y + 3}" text-anchor="middle" font-size="8" font-family="var(--mono)" fill="var(--accent)">${esc(rwy.ident)}</text>`;
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

/** Client-side wind components (mirrors server) — used to recompute pattern wind
 *  when comparing a runway other than the recommended one. */
function windComp(rwyTrueHeading, windDirTrue, speedKt) {
  const theta = (((windDirTrue - rwyTrueHeading) % 360) + 540) % 360 - 180;
  const r = (theta * Math.PI) / 180;
  const cross = speedKt * Math.sin(r);
  const headwindKt = speedKt * Math.cos(r);
  const crosswindKt = Math.abs(cross);
  const crosswindSide = crosswindKt < 0.5 ? 'none' : cross > 0 ? 'right' : 'left';
  return { headwindKt, crosswindKt, crosswindSide };
}

/** The compass + readout block for a chosen runway (defaults to recommended). */
function windBlock(brief, rwy, limits) {
  const a = brief.analysis;
  const lengthByIdent = {};
  (brief.airport?.runways || []).forEach((r) => { if (r.lengthFt) lengthByIdent[r.ident] = r.lengthFt; });

  let readout;
  if (!rwy) {
    readout = `<div class="active-rwy" style="color:var(--text-dim)">Wind calm / variable — pilot discretion</div>`;
  } else {
    const xwClass = rwy.crosswindKt >= limits.xwind ? 'high' : rwy.crosswindKt >= limits.xwind * 0.6 ? 'mod' : '';
    const isRec = brief.recommendedRunway ? rwy.ident === brief.recommendedRunway : (a.active && a.active.ident === rwy.ident);
    const tag = isRec ? '<span class="rec-tag">recommended</span>' : '<span class="cmp-tag">comparing</span>';
    const len = lengthByIdent[rwy.ident] ? `<span class="rwy-len">${lengthByIdent[rwy.ident].toLocaleString()} ft</span>` : '';
    const gust = rwy.gustCrosswindKt != null
      ? `<div class="gust-note">gust: HW ${fmt(Math.abs(rwy.gustHeadwindKt))} · XW ${fmt(rwy.gustCrosswindKt)} kt</div>` : '';
    let pwLine = '';
    const pw = brief.patternWind;
    if (pw) {
      const c = windComp(rwy.trueHeading, pw.dirTrue, pw.speedKt);
      pwLine = `<div class="gust-note" style="color:var(--accent)">pattern @${pw.altFt.toLocaleString()} MSL: ${String(pw.dirTrue).padStart(3, '0')}/${pw.speedKt} → HW ${fmt(c.headwindKt)} · XW ${fmt(c.crosswindKt)}${c.crosswindSide !== 'none' ? ' ' + c.crosswindSide[0].toUpperCase() : ''}</div>`;
    }
    readout = `
      <div class="active-rwy">RWY <b>${esc(rwy.ident)}</b> ${tag} ${len}</div>
      <div class="comp">
        <div class="box ${rwy.isTailwind ? 'tw' : ''}"><div class="lbl">${rwy.isTailwind ? 'Tailwind' : 'Headwind'}</div><div class="val">${fmt(Math.abs(rwy.headwindKt))}</div></div>
        <div class="box xw ${xwClass}"><div class="lbl">Xwind ${rwy.crosswindSide !== 'none' ? rwy.crosswindSide[0].toUpperCase() : ''}</div><div class="val">${fmt(rwy.crosswindKt)}</div></div>
      </div>${gust}${pwLine}`;
  }
  return `<div class="wind-block" data-icao="${esc(brief.icao)}"><div class="compass">${compassSvg(a, limits.xwind, rwy || null)}</div><div class="wind-readout">${readout}</div></div>`;
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
  const selIdent = brief.recommendedRunway || (a.active && a.active.ident);
  return a.runways.map((r) => {
    const isClosed = closed.has(r.ident.toUpperCase());
    const isSel = r.ident === selIdent;
    const xw = `XW ${fmt(r.crosswindKt)}${r.crosswindSide !== 'none' ? ' ' + r.crosswindSide[0].toUpperCase() : ''}`;
    return `<div class="rwy-row selectable ${isSel ? 'selected' : ''} ${isClosed ? 'closed' : ''}" data-rwy="${esc(r.ident)}" title="Click to compare RWY ${esc(r.ident)}">
      <span class="id">${esc(r.ident)}</span>
      <span class="${r.isTailwind ? 'tw' : ''}">${r.isTailwind ? 'TW' : 'HW'} ${fmt(Math.abs(r.headwindKt))}</span>
      <span>${xw}</span>
      <span class="star">${brief.recommendedRunway === r.ident ? '★' : ''}</span>
    </div>`;
  }).join('');
}

const BIRD_COLOR = { LOW: 'var(--go)', MODERATE: 'var(--caution)', SEVERE: 'var(--nogo)' };
let cardData = {}; // icao -> { brief, limits } for runway-compare interaction

// Collapsible card section (native <details>, accessible, prints expanded).
function sectionEl(titleHtml, inner, open = true) {
  return `<details class="sec"${open ? ' open' : ''}><summary class="section-title">${titleHtml}</summary><div class="sec-body">${inner}</div></details>`;
}

function windsAloftSection(brief) {
  const wa = brief.windsAloft;
  if (!wa || !wa.profile.length) return '';
  // Per-card view keeps it low-level (pattern/departure); the full climb
  // profile lives in the Route / Climb Winds tool.
  const low = wa.profile.filter((p) => p.altFt <= 10000);
  const rows = (low.length ? low : wa.profile)
    .slice()
    .reverse()
    .map((p) => {
      const lbl = p.altFt >= 1000 ? (p.altFt / 1000).toFixed(1) + 'k' : String(p.altFt);
      return `<div class="as-row"><span class="cat cat-LIGHTING">${esc(lbl)}</span>
        <div><div class="txt">${esc(p.altFt.toLocaleString())} ft MSL — ${String(p.dirTrue).padStart(3, '0')}°/${p.speedKt} kt</div></div></div>`;
    })
    .join('');
  const t = wa.time ? `<span class="count">${esc(wa.time.slice(11, 16))}Z fcst</span>` : '';
  return sectionEl(`Winds Aloft ${t}`, `<div class="notams">${rows}</div>`, false);
}

const CONV_CLASS = { TSTM: 'cat-LIGHTING', MRGL: 'cat-APPROACH', SLGT: 'cat-APPROACH', ENH: 'cat-RUNWAY', MDT: 'cat-RUNWAY', HIGH: 'cat-RUNWAY' };

function hazardWxSection(brief) {
  const wx = brief.hazardWx || [];
  const conv = brief.convective || [];
  if (!wx.length && !conv.length) return '';
  const wxRows = wx.map((h) => {
    const cls = h.hazard === 'CONVECTIVE' ? 'cat-RUNWAY' : h.type === 'SIGMET' ? 'cat-APPROACH' : 'cat-LIGHTING';
    const dist = h.distanceNm === 0 ? '<b>OVERHEAD</b>' : esc(h.distanceNm) + ' NM';
    const alt = h.lowFt != null ? ` · ${esc(h.lowFt.toLocaleString())}–${esc((h.hiFt ?? 0).toLocaleString())} ft` : '';
    const end = h.validTo ? ` · until ${esc(h.validTo.slice(0, 16).replace('T', ' '))}Z` : '';
    return `<div class="as-row"><span class="cat ${cls}">${esc(h.type)}</span>
      <div><div class="txt">${esc(h.label)} · ${dist}</div><div class="when">${alt}${end}</div></div></div>`;
  }).join('');
  const convRows = conv.map((c) => {
    const dist = c.distanceNm === 0 ? '<b>OVERHEAD</b>' : esc(c.distanceNm) + ' NM';
    return `<div class="as-row"><span class="cat ${CONV_CLASS[c.risk] || 'cat-LIGHTING'}">${esc(c.risk)}</span>
      <div><div class="txt">Convective outlook: ${esc(c.label)} · ${dist}</div></div></div>`;
  }).join('');
  const count = wx.length + conv.length;
  return sectionEl(`Hazardous Wx <span class="count">${count}</span>`, `<div class="notams">${wxRows}${convRows}</div>`, true);
}

function tafSection(brief) {
  if (!brief.taf) return '';
  const d = brief.tafDecoded;
  let decoded = '';
  if (d && d.periods && d.periods.length) {
    const head = d.valid ? `<div class="when" style="margin-bottom:6px">Valid ${esc(d.valid)}${d.issued ? ` · issued ${esc(d.issued)}` : ''}</div>` : '';
    const periods = d.periods.map((p) => {
      const items = p.items.map((it) => `<li>${esc(it)}</li>`).join('');
      const extra = p.extra && p.extra.length ? `<li class="extra">${esc(p.extra.join(' '))}</li>` : '';
      return `<div class="taf-period"><div class="taf-when">${esc(p.label)}${p.when ? ` · ${esc(p.when)}` : ''}</div>
        <ul class="taf-items">${items}${extra}</ul></div>`;
    }).join('');
    decoded = `${head}${periods}`;
  }
  const inner = `<div class="taf-decoded">${decoded || '<div class="readout">No decodable TAF.</div>'}</div>
    <div class="taf raw-taf" style="display:none">${esc(brief.taf)}</div>`;
  return sectionEl(`TAF <span class="taf-toggle" data-taf-raw>show raw</span>`, inner, true);
}

function pirepSection(brief) {
  const ps = brief.pireps;
  if (!ps || !ps.length) return '';
  const rows = ps.map((p) => {
    const cls = p.urgent ? 'cat-RUNWAY' : p.turb || p.ice ? 'cat-APPROACH' : 'cat-LIGHTING';
    const alt = p.altFt != null ? `${(p.altFt / 1000).toFixed(0)}k ft` : '—';
    const dist = p.distanceNm === 0 ? 'overhead' : esc(p.distanceNm) + ' NM';
    return `<div class="as-row"><span class="cat ${cls}">${esc(p.hazard)}</span>
      <div><div class="txt">${esc(alt)} · ${dist}</div><div class="when">${esc(p.rawText)}</div></div></div>`;
  }).join('');
  return sectionEl(`PIREPs <span class="count">${ps.length}</span>`, `<div class="notams">${rows}</div>`, false);
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

  const inner = `<div class="notams">
      ${tfrRows || ''}${suaRows || ''}
      ${raimWin ? `<div class="as-row"><span class="cat ${raimClass}">GPS</span><div><div class="txt">Predicted RAIM outage</div>${raimWin}</div></div>` : ''}
      ${!as.tfrs.length && !as.sua.length && as.raim.status !== 'PREDICTED OUTAGE'
        ? '<div class="readout" style="font-size:12px">No TFRs or SUA within 100 NM · RAIM nominal.</div>' : ''}
    </div>`;
  return sectionEl(`Airspace &amp; RAIM <span class="cat ${raimClass}" style="margin-left:auto">RAIM: ${esc(as.raim.status)}</span>`, inner, true);
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
    const highDA = a.densityAltitudeFt != null && limits.highda && a.densityAltitudeFt > limits.highda;
    // Default selected runway: the recommended (or active) one.
    const selRwy = a.active ? (a.runways.find((r) => r.ident === (brief.recommendedRunway || a.active.ident)) || a.active) : null;

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
      ${windBlock(brief, selRwy, limits)}
      <div class="rwys">${runwayRows(a, brief)}</div>
      ${warns}`;
  } else {
    body = `<div class="readout">No weather observation available for this field.</div>`;
  }

  const notams = sectionEl(`NOTAMs <span class="count">${brief.notams.length}</span>`,
    `<div class="notams">${brief.notams.length ? brief.notams.map(notamRow).join('') : '<div class="readout" style="font-size:12px">None retrieved.</div>'}</div>`, true);
  const taf = tafSection(brief);

  return `<div class="card" data-icao="${esc(ap.icao)}">
    <div class="head"><div><div class="icao">${esc(ap.icao)}</div><div class="name">${esc(ap.name)}</div></div>
      <div class="spacer"></div><div class="status-led ${statusClass}">${esc(brief.status)}</div></div>
    <div class="body">${body}${windsAloftSection(brief)}${hazardWxSection(brief)}${pirepSection(brief)}${airspaceSection(brief)}${notams}${taf}</div></div>`;
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
    cardData = {};
    data.airfields.forEach((b) => { cardData[b.icao.toUpperCase()] = { brief: b, limits }; });
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

// ---- Route / climb winds tool ----------------------------------------------
function windsProfileCard(pt) {
  if (!pt.found) {
    return `<div class="missing-card"><span class="icao">${esc(pt.id)}</span> — not found as an airfield or navaid.</div>`;
  }
  const rows = pt.profile
    .slice()
    .sort((a, b) => b.altFt - a.altFt) // highest first
    .map((l) => {
      const lbl = l.altFt >= 1000 ? (l.altFt / 1000).toFixed(1) + 'k' : String(l.altFt);
      const strong = l.speedKt >= 50 ? ' strong' : l.speedKt >= 30 ? ' mod' : '';
      return `<div class="wind-row${strong}"><span class="wa">${esc(lbl)} ft</span>
        <span class="wd">${String(l.dirTrue).padStart(3, '0')}°</span>
        <span class="ws">${l.speedKt} kt</span></div>`;
    })
    .join('');
  const t = pt.time ? `<span class="count">${esc(pt.time.slice(11, 16))}Z fcst</span>` : '';
  const hz = (pt.hazards || []);
  let banner = '';
  if (hz.length) {
    const conv = hz.some((h) => h.hazard === 'CONVECTIVE');
    const list = hz.map((h) => `${esc(h.label)} (${h.distanceNm === 0 ? 'overhead' : esc(h.distanceNm) + ' NM'})`).join(', ');
    banner = `<div class="warn-item ${conv ? 'crit' : ''}" style="margin-bottom:10px"><span class="ico">⚠</span><span>Hazardous wx near route: ${list}</span></div>`;
  }
  return `<div class="card"><div class="head">
      <div><div class="icao">${esc(pt.id)}</div><div class="name">${esc(pt.kind)} · ${esc(pt.name)}</div></div>
      <div class="spacer"></div>${t}</div>
    <div class="body">${banner}<div class="wind-profile">
      <div class="wind-row hdr"><span class="wa">ALT</span><span class="wd">DIR</span><span class="ws">SPD</span></div>
      ${rows}</div></div></div>`;
}

async function getRouteWinds() {
  const pts = $('winds-points').value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!pts.length) return;
  const params = new URLSearchParams({ points: pts.join(',') });
  if ($('offline').checked) params.set('offline', '1');
  $('winds-go').disabled = true;
  $('winds-results').innerHTML = `<div class="loading"><div class="spinner"></div>Fetching winds aloft…</div>`;
  try {
    const res = await fetch(`/api/winds?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    $('winds-results').innerHTML = `<div class="grid">${data.points.map(windsProfileCard).join('')}</div>`;
    // Radar-along-route: drop the route points + hazardous wx onto the map.
    const routePts = data.points.filter((p) => p.found).map((p) => ({ icao: p.id, lat: p.lat, lon: p.lon, status: (p.hazards || []).some((h) => h.hazard === 'CONVECTIVE') ? 'CAUTION' : 'GO' }));
    if (routePts.length) {
      const mapEl = $('map');
      mapEl.style.display = '';
      initMap(mapEl, { airfields: routePts, tfrs: [], sua: [], sigmets: data.airsigmets || [], pireps: [] });
    }
  } catch (err) {
    $('winds-results').innerHTML = `<div class="errbox">Failed: ${esc(err.message)}</div>`;
  } finally {
    $('winds-go').disabled = false;
  }
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
  initMap(mapEl, { airfields, tfrs: as.tfrs, sua: as.sua, sigmets: data.airsigmets || [], pireps: data.pireps || [], convective: data.convective || [] });
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

// ---- Saved sorties (server-backed when a DB is configured, else browser-local)
const SORTIE_KEY = 'c17-sorties';
let sortieMode = 'local';   // 'remote' when the platform DB is available
let sortieCache = {};       // name -> { icaos, xwind, tailwind, highda }

function loadLocal() {
  try { return JSON.parse(localStorage.getItem(SORTIE_KEY)) || {}; } catch { return {}; }
}
function saveLocal(obj) {
  try { localStorage.setItem(SORTIE_KEY, JSON.stringify(obj)); } catch { /* storage blocked */ }
}

function refreshSortieList(selected) {
  const names = Object.keys(sortieCache).sort();
  const where = sortieMode === 'remote' ? 'synced' : 'this device';
  const sel = $('sortie-list');
  sel.innerHTML = names.length
    ? names.map((n) => `<option${n === selected ? ' selected' : ''}>${esc(n)}</option>`).join('')
    : `<option value="">— none saved (${where}) —</option>`;
}

async function initSorties() {
  try {
    const res = await fetch('/api/sorties');
    if (res.ok) {
      const d = await res.json();
      if (d.configured) { sortieMode = 'remote'; sortieCache = d.sorties || {}; refreshSortieList(); return; }
    }
  } catch { /* fall back to local */ }
  sortieMode = 'local';
  sortieCache = loadLocal();
  refreshSortieList();
}

async function refreshRemote() {
  const res = await fetch('/api/sorties');
  const d = await res.json();
  sortieCache = d.sorties || {};
}

async function saveCurrentSortie() {
  const name = $('sortie-name').value.trim();
  if (!name) { $('sortie-name').focus(); return; }
  const data = { icaos: $('icaos').value.trim(), xwind: $('xwind').value, tailwind: $('tailwind').value, highda: $('highda').value };
  if (sortieMode === 'remote') {
    try {
      await fetch('/api/sorties', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, data }) });
      await refreshRemote();
    } catch { /* ignore */ }
  } else {
    sortieCache[name] = data;
    saveLocal(sortieCache);
  }
  $('sortie-name').value = '';
  refreshSortieList(name);
}

function loadSelectedSortie() {
  const s = sortieCache[$('sortie-list').value];
  if (!s) return;
  $('icaos').value = s.icaos;
  if (s.xwind) $('xwind').value = s.xwind;
  if (s.tailwind) $('tailwind').value = s.tailwind;
  if (s.highda) $('highda').value = s.highda;
  buildBrief();
}

async function deleteSelectedSortie() {
  const name = $('sortie-list').value;
  if (!name) return;
  if (sortieMode === 'remote') {
    try { await fetch(`/api/sorties?name=${encodeURIComponent(name)}`, { method: 'DELETE' }); await refreshRemote(); } catch { /* ignore */ }
  } else {
    delete sortieCache[name];
    saveLocal(sortieCache);
  }
  refreshSortieList();
}

$('results').addEventListener('click', (e) => {
  // Runway compare: click a runway row to recompute the wind block for it.
  const row = e.target.closest('.rwy-row.selectable');
  if (row && row.dataset.rwy) {
    const cardEl = row.closest('.card');
    const entry = cardData[(cardEl?.dataset.icao || '').toUpperCase()];
    if (entry && entry.brief.analysis) {
      const rwy = entry.brief.analysis.runways.find((r) => r.ident === row.dataset.rwy);
      const wb = cardEl.querySelector('.wind-block');
      if (rwy && wb) {
        wb.outerHTML = windBlock(entry.brief, rwy, entry.limits);
        cardEl.querySelectorAll('.rwy-row').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
      }
    }
    return;
  }

  const t = e.target.closest('[data-taf-raw]');
  if (!t) return;
  e.preventDefault(); // don't toggle the <details> when clicking "show raw"
  const wrap = t.closest('details') || t.closest('.section-title').parentElement;
  const raw = wrap.querySelector('.raw-taf');
  const dec = wrap.querySelector('.taf-decoded');
  const showRaw = raw.style.display === 'none';
  raw.style.display = showRaw ? 'block' : 'none';
  dec.style.display = showRaw ? 'none' : 'block';
  t.textContent = showRaw ? 'show decoded' : 'show raw';
});

// Expand all collapsible sections for printing, then restore.
window.addEventListener('beforeprint', () => {
  document.querySelectorAll('details.sec').forEach((d) => { d.dataset.wasopen = d.open ? '1' : '0'; d.open = true; });
});
window.addEventListener('afterprint', () => {
  document.querySelectorAll('details.sec').forEach((d) => { if (d.dataset.wasopen === '0') d.open = false; });
});

$('go').addEventListener('click', buildBrief);
$('print').addEventListener('click', () => window.print());
$('sortie-save').addEventListener('click', saveCurrentSortie);
$('sortie-load').addEventListener('click', loadSelectedSortie);
$('sortie-del').addEventListener('click', deleteSelectedSortie);
initSorties();
$('icaos').addEventListener('keydown', (e) => { if (e.key === 'Enter') buildBrief(); });
$('winds-go').addEventListener('click', getRouteWinds);
$('winds-points').addEventListener('keydown', (e) => { if (e.key === 'Enter') getRouteWinds(); });
loadQuickChips();
buildBrief();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
