// C-17 Mission Planner — static frontend (no framework, no build).
// Talks to the zero-dependency Node API and renders the EFB-style brief.

import { initMap } from './map.js';
import { zuluLocal, hhZ, hhL, TZ_ABBR } from './timefmt.js';
// NOTE: export.js is loaded lazily (dynamic import) inside the export handlers
// so a missing/stale export module can never abort app.js and break the core
// app (brief, route lookup, map).

const $ = (id) => document.getElementById(id);
// Null-safe helpers: never let a missing/late element abort init or a handler.
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const val = (id, d = '') => { const el = $(id); return el ? el.value : d; };
const checked = (id) => { const el = $(id); return el ? el.checked : false; };
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
    const pws = brief.patternWinds || [];
    let pwBlock = '';
    if (pws.length) {
      const rows = pws.map((pw) => {
        const c = windComp(rwy.trueHeading, pw.dirTrue, pw.speedKt);
        const side = c.crosswindSide !== 'none' ? ' ' + c.crosswindSide[0].toUpperCase() : '';
        const hw = c.headwindKt < 0 ? `TW ${fmt(-c.headwindKt)}` : `HW ${fmt(c.headwindKt)}`;
        return `<div class="pw-row"><span class="pw-alt">${pw.aglFt.toLocaleString()} AGL <small>(${pw.mslFt.toLocaleString()} MSL)</small></span>
          <span class="pw-wind">${String(pw.dirTrue).padStart(3, '0')}/${pw.speedKt}</span>
          <span class="pw-comp">${hw} · XW ${fmt(c.crosswindKt)}${side}</span></div>`;
      }).join('');
      pwBlock = `<div class="pw-block"><div class="pw-hdr">Pattern winds (on RWY ${esc(rwy.ident)})</div>${rows}</div>`;
    }
    readout = `
      <div class="active-rwy">RWY <b>${esc(rwy.ident)}</b> ${tag} ${len}</div>
      <div class="comp">
        <div class="box ${rwy.isTailwind ? 'tw' : ''}"><div class="lbl">${rwy.isTailwind ? 'Tailwind' : 'Headwind'}</div><div class="val">${fmt(Math.abs(rwy.headwindKt))}</div></div>
        <div class="box xw ${xwClass}"><div class="lbl">Xwind ${rwy.crosswindSide !== 'none' ? rwy.crosswindSide[0].toUpperCase() : ''}</div><div class="val">${fmt(rwy.crosswindKt)}</div></div>
      </div>${gust}${pwBlock}`;
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
  const end = n.effectiveEnd ? `<div class="when">until ${esc(zuluLocal(n.effectiveEnd, { date: true }))}</div>` : '';
  return `<div class="notam" data-cat="${esc(n.category)}"><span class="cat cat-${esc(n.category)}">${esc(n.category)}</span>
    <div><div class="txt">${esc(n.text)}</div>${end}</div></div>`;
}

// Category display order (operational significance) and which groups open by
// default — the long tail (taxiway/navaid/services/other) starts collapsed so
// the card stays short.
const NOTAM_CAT_ORDER = ['RUNWAY', 'APPROACH', 'GPS_RAIM', 'LIGHTING', 'OBSTACLE', 'AIRSPACE', 'BIRD', 'TAXIWAY', 'NAVAID', 'SERVICES', 'OTHER'];
const NOTAM_OPEN_DEFAULT = new Set(['RUNWAY', 'APPROACH', 'GPS_RAIM']);

// Group NOTAMs into collapsible per-category sections so a long list doesn't
// force endless scrolling. Significant groups (runway/approach/RAIM) open.
function notamGroups(notams) {
  const byCat = new Map();
  for (const n of notams) {
    if (!byCat.has(n.category)) byCat.set(n.category, []);
    byCat.get(n.category).push(n);
  }
  const cats = [...byCat.keys()].sort(
    (a, b) => (NOTAM_CAT_ORDER.indexOf(a) + 1 || 99) - (NOTAM_CAT_ORDER.indexOf(b) + 1 || 99),
  );
  return cats.map((cat) => {
    const items = byCat.get(cat);
    const open = NOTAM_OPEN_DEFAULT.has(cat);
    return `<details class="ngroup" data-cat="${esc(cat)}"${open ? ' open' : ''}>
      <summary class="ngroup-sum"><span class="cat cat-${esc(cat)}">${esc(cat)}</span>
        <span class="ngroup-n">${items.length}</span><span class="ngroup-chev">▾</span></summary>
      <div class="notams">${items.map(notamRow).join('')}</div></details>`;
  }).join('');
}

// Category filter chips for a card's NOTAMs (click to filter the list below).
function notamFilterBar(notams) {
  if (notams.length <= 1) return '';
  const counts = {};
  for (const n of notams) counts[n.category] = (counts[n.category] || 0) + 1;
  const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const chip = (cat, label, count, active) =>
    `<span class="nfilter${active ? ' active' : ''}" data-cat="${esc(cat)}">${esc(label)} <b>${count}</b></span>`;
  return `<div class="nfilters">${chip('ALL', 'All', notams.length, true)}${cats.map((c) => chip(c, c, counts[c], false)).join('')}</div>`;
}

function runwayRows(a, brief) {
  const closed = new Set(brief.closedRunways.map((r) => r.toUpperCase()));
  const selIdent = brief.recommendedRunway || (a.active && a.active.ident);
  const dims = {};
  (brief.airport?.runways || []).forEach((r) => { dims[r.ident] = { len: r.lengthFt, wid: r.widthFt }; });
  const dimText = (ident) => {
    const d = dims[ident];
    if (!d || !d.len) return '';
    return `<small class="rwy-dim">${d.len.toLocaleString()}${d.wid ? '×' + d.wid : ''} ft</small>`;
  };
  return a.runways.map((r) => {
    const isClosed = closed.has(r.ident.toUpperCase());
    const isSel = r.ident === selIdent;
    const xw = `XW ${fmt(r.crosswindKt)}${r.crosswindSide !== 'none' ? ' ' + r.crosswindSide[0].toUpperCase() : ''}`;
    return `<div class="rwy-row selectable ${isSel ? 'selected' : ''} ${isClosed ? 'closed' : ''}" data-rwy="${esc(r.ident)}" title="Click to compare RWY ${esc(r.ident)}">
      <span class="id">${esc(r.ident)} ${dimText(r.ident)}</span>
      <span class="${r.isTailwind ? 'tw' : ''}">${r.isTailwind ? 'TW' : 'HW'} ${fmt(Math.abs(r.headwindKt))}</span>
      <span>${xw}</span>
      <span class="star">${brief.recommendedRunway === r.ident ? '★' : ''}</span>
    </div>`;
  }).join('');
}

const BIRD_COLOR = { LOW: 'var(--go)', MODERATE: 'var(--caution)', SEVERE: 'var(--nogo)' };
let cardData = {}; // icao -> { brief, limits } for runway-compare interaction
let currentMap = null; // latest map instance (for the export's radar snapshot)

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
  const t = wa.time ? `<div class="when" style="margin-bottom:6px">forecast ${esc(zuluLocal(wa.time))} · pattern/departure band</div>` : '';
  return `${t}<div class="notams">${rows}</div>`;
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
    const end = h.validTo ? ` · until ${esc(zuluLocal(h.validTo, { date: true }))}` : '';
    return `<div class="as-row"><span class="cat ${cls}">${esc(h.type)}</span>
      <div><div class="txt">${esc(h.label)} · ${dist}</div><div class="when">${alt}${end}</div></div></div>`;
  }).join('');
  const convRows = conv.map((c) => {
    const dist = c.distanceNm === 0 ? '<b>OVERHEAD</b>' : esc(c.distanceNm) + ' NM';
    return `<div class="as-row"><span class="cat ${CONV_CLASS[c.risk] || 'cat-LIGHTING'}">${esc(c.risk)}</span>
      <div><div class="txt">Convective outlook: ${esc(c.label)} · ${dist}</div></div></div>`;
  }).join('');
  return `<div class="notams">${wxRows}${convRows}</div>`;
}

// TAF times are bare "DDHH"/"DDHHMM" Zulu tokens (no month/year). Anchor them to
// the brief's generation date so we can render local time too. Handles month
// rollover and the 24:00 = next-day-00:00 convention.
function tafTokenIso(ddhhmm, anchorIso) {
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

// Render a TAF time token (or from–to range) as Zulu · local, falling back to
// the server's Zulu-only text if the raw token is missing.
function tafWhen(from, to, anchorIso, fallback = '') {
  const fIso = tafTokenIso(from, anchorIso);
  if (!fIso) return fallback;
  const fz = zuluLocal(fIso, { date: true });
  const tIso = to ? tafTokenIso(to, anchorIso) : null;
  return tIso ? `${fz} – ${zuluLocal(tIso, { date: true })}` : fz;
}

function tafSection(brief) {
  if (!brief.taf) {
    return '<div class="readout" style="font-size:12px">No TAF retrieved for this field (many fields don\'t issue TAFs; live TAFs appear here when available).</div>';
  }
  const d = brief.tafDecoded;
  const anchor = brief.generatedAt;
  let decoded = '';
  if (d && d.periods && d.periods.length) {
    const validTxt = tafWhen(d.validFrom, d.validTo, anchor, d.valid);
    const issuedTxt = tafWhen(d.issuedRaw, null, anchor, d.issued);
    const head = validTxt ? `<div class="when" style="margin-bottom:6px">Valid ${esc(validTxt)}${issuedTxt ? ` · issued ${esc(issuedTxt)}` : ''}</div>` : '';
    const periods = d.periods.map((p) => {
      const items = p.items.map((it) => `<li>${esc(it)}</li>`).join('');
      const extra = p.extra && p.extra.length ? `<li class="extra">${esc(p.extra.join(' '))}</li>` : '';
      const when = tafWhen(p.from, p.to, anchor, p.when);
      return `<div class="taf-period"><div class="taf-when">${esc(p.label)}${when ? ` · ${esc(when)}` : ''}</div>
        <ul class="taf-items">${items}${extra}</ul></div>`;
    }).join('');
    decoded = `${head}${periods}`;
  }
  return `<div class="taf-hd"><span class="taf-toggle" data-taf-raw>show raw</span></div>
    <div class="taf-decoded">${decoded || '<div class="readout">No decodable TAF.</div>'}</div>
    <div class="taf raw-taf" style="display:none">${esc(brief.taf)}</div>`;
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
  return `<div class="sub-hd">PIREPs</div><div class="notams">${rows}</div>`;
}

function birdBadge(level) {
  if (!level) return '';
  return `<span class="bird-badge" style="color:${BIRD_COLOR[level]};border-color:${BIRD_COLOR[level]}">BIRD ${esc(level)}</span>`;
}

function mtrSection(brief) {
  const ms = brief.mtrs;
  if (!ms || !ms.length) return '';
  const rows = ms.map((m) => {
    const cls = m.type === 'IR' ? 'cat-APPROACH' : 'cat-LIGHTING';
    return `<div class="as-row"><span class="cat ${cls}">${esc(m.type)}</span>
      <div><div class="txt">${esc(m.id)} · ${esc(m.name || '')} · ${esc(m.distanceNm)} NM ${birdBadge(m.birdRisk)}</div></div></div>`;
  }).join('');
  return `<div class="notams">${rows}</div>`;
}

function airspaceSection(brief) {
  const as = brief.airspace;
  if (!as) return '';
  const raimClass = as.raim.status === 'PREDICTED OUTAGE' ? 'cat-RUNWAY' : 'cat-LIGHTING';
  const tfrRows = as.tfrs.map((t) => {
    const inside = t.distanceNm === 0;
    return `<div class="as-row"><span class="cat cat-RUNWAY">TFR</span>
      <div><div class="txt">${esc(t.type)} · ${esc(t.name)} ${inside ? '<b style="color:var(--nogo)">INSIDE</b>' : esc(t.distanceNm) + ' NM'}</div>
      <div class="when">SFC–${t.upperFt != null ? esc(t.upperFt.toLocaleString()) + ' ft' : '—'}${t.effectiveEnd ? ' · until ' + esc(zuluLocal(t.effectiveEnd, { date: true })) : ''}</div></div></div>`;
  }).join('');
  const suaRows = as.sua.map((s) => {
    const sc = s.status === 'active' ? 'cat-RUNWAY' : s.status === 'scheduled' ? 'cat-APPROACH' : 'cat-LIGHTING';
    return `<div class="as-row"><span class="cat ${sc}">${esc(s.type)}</span>
      <div><div class="txt">${esc(s.id)} · ${esc(s.status.toUpperCase())} · ${s.distanceNm === 0 ? '<b>OVERHEAD</b>' : esc(s.distanceNm) + ' NM'}</div>
      <div class="when">${esc(s.schedule || '')}${s.lowerFt != null ? ' · ' + esc(s.lowerFt.toLocaleString()) + '–' + esc((s.upperFt ?? 0).toLocaleString()) + ' ft' : ''}</div></div></div>`;
  }).join('');
  const raimWin = as.raim.windows.map((w) => {
    const inl = (w.inlineRanges || []).map((r) => `${r.start}–${r.end}`).join(', ');
    const abs = w.start ? `${hhZ(w.start)}–${hhZ(w.end)}Z · ${hhL(w.start)}–${hhL(w.end)} ${TZ_ABBR}` : '';
    return `<div class="when" style="margin-left:2px">• ${esc(inl || abs || w.raw)}</div>`;
  }).join('');

  const inner = `<div class="notams">
      ${tfrRows || ''}${suaRows || ''}
      ${raimWin ? `<div class="as-row"><span class="cat ${raimClass}">GPS</span><div><div class="txt">Predicted RAIM outage</div>${raimWin}</div></div>` : ''}
      ${!as.tfrs.length && !as.sua.length && as.raim.status !== 'PREDICTED OUTAGE'
        ? '<div class="readout" style="font-size:12px">No TFRs or SUA within 100 NM · RAIM nominal.</div>' : ''}
    </div>`;
  return `<div class="sub-hd">RAIM: <span class="cat ${raimClass}">${esc(as.raim.status)}</span></div>${inner}`;
}

// Detail sections as a tab bar + panels (keeps cards compact; NOTAMs default).
const svgIcon = (inner) => `<svg class="tab-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const TAB_ICONS = {
  notams: svgIcon('<path d="M3 6v4h2l5 3V3L5 6H3z"/><path d="M12 6.3a2.4 2.4 0 0 1 0 3.4"/>'),            // megaphone / notice
  hazards: svgIcon('<path d="M8 2.5l5.6 10.5H2.4z"/><path d="M8 6.4v3.2"/><circle cx="8" cy="11.3" r="0.6" fill="currentColor" stroke="none"/>'), // warning triangle
  taf: svgIcon('<path d="M5 11.6a3 3 0 0 1 .3-6 4 4 0 0 1 7.4 1.3A2.6 2.6 0 0 1 12 11.6z"/>'),           // cloud
  airspace: svgIcon('<path d="M8 2.4l5.2 2.9L8 8.1 2.8 5.3z"/><path d="M2.8 8.2L8 11l5.2-2.8"/>'),       // stacked airspace strata
  lowlevel: svgIcon('<path d="M2.8 11.2l4-3 3 2 3.5-4.9"/><circle cx="2.8" cy="11.2" r="1"/><circle cx="13.3" cy="5.3" r="1"/>'), // route + waypoints
  winds: svgIcon('<path d="M2.5 6h7.6a2 2 0 1 0-2-2"/><path d="M2.5 9.6h5.6a1.8 1.8 0 1 1-1.8 1.8"/>'),   // wind flow
};

function tabbedDetails(brief) {
  const panels = [];
  const push = (key, label, count, html) => { if (html && html.trim()) panels.push({ key, label, count, html }); };

  const nCount = brief.notams.length;
  // Short lists render flat (no extra clicks); long lists collapse by category.
  const notamHtml = nCount === 0
    ? '<div class="readout" style="font-size:12px">None retrieved.</div>'
    : nCount <= 5
      ? `<div class="notams">${brief.notams.map(notamRow).join('')}</div>`
      : `${notamFilterBar(brief.notams)}<div class="ngroups">${notamGroups(brief.notams)}</div>`;
  push('notams', 'NOTAMs', nCount, notamHtml);

  // Current-only hazards (PIREP/SIGMET/convective now-casts) aren't valid for a
  // far-future phase, so hide them there (the user's "hide at future phases"
  // choice) and leave a short note instead of implying they're forecasts.
  if (brief.phase?.hideCurrentOnly) {
    push('hazards', 'Hazards', null,
      '<div class="readout" style="font-size:12px">Current-only hazards (PIREPs, SIGMETs, convective now-cast) are hidden for this future phase — they reflect conditions now, not at the planned time. Re-check closer to the time.</div>');
  } else {
    const hazards = (hazardWxSection(brief) || '') + (pirepSection(brief) || '');
    push('hazards', 'Hazards', (brief.hazardWx?.length || 0) + (brief.convective?.length || 0) + (brief.pireps?.length || 0) || null, hazards);
  }

  push('taf', 'TAF', null, tafSection(brief));
  push('airspace', 'Airspace', (brief.airspace ? brief.airspace.tfrs.length + brief.airspace.sua.length : 0) || null, airspaceSection(brief));
  push('lowlevel', 'Low-Level', (brief.mtrs || []).length || null, mtrSection(brief));
  push('winds', 'Winds Aloft', null, windsAloftSection(brief));

  if (!panels.length) return '';
  const tabs = panels.map((p, i) =>
    `<button class="tab${i === 0 ? ' active' : ''}" data-tab="${p.key}">${TAB_ICONS[p.key] || ''}<span>${esc(p.label)}</span>${p.count ? `<span class="count">${p.count}</span>` : ''}</button>`).join('');
  const bodies = panels.map((p, i) =>
    `<div class="tabpanel${i === 0 ? ' active' : ''}" data-panel="${p.key}">${p.html}</div>`).join('');
  return `<div class="card-tabs">${tabs}</div><div class="tabpanels">${bodies}</div>`;
}

// Role tag shown on a phased card's header (sortie mode).
const PHASE_TAG = { DEPARTURE: 'DEP', RECOVERY: 'REC', ALTERNATE: 'ALT' };
// A planned-time banner for a phased card: states the phase time + lead, and
// (for far-future phases) that current METAR is shown for reference only.
function phaseBanner(brief) {
  const p = brief.phase;
  if (!p || !p.when || p.role === 'FIELD') return '';
  const lead = (() => {
    const m = p.minutesAhead;
    if (m == null) return '';
    if (m <= 0) return 'now';
    const h = Math.floor(m / 60), mm = m % 60;
    return '+' + (h ? `${h}h${mm ? String(mm).padStart(2, '0') : ''}` : `${mm}m`);
  })();
  const cls = p.future ? 'phase-when future' : 'phase-when';
  const note = p.hideCurrentOnly
    ? '<div class="phase-caveat">Winds aloft, TAF, AHAS birds &amp; airspace are tailored to this time. Current METAR/PIREP/SIGMET shown elsewhere reflect now, not this phase.</div>'
    : '';
  return `<div class="${cls}">⏱ Planned ${esc(zuluLocal(p.when, { date: true }))}${lead ? ` · ${esc(lead)}` : ''}</div>${note}`;
}

function card(brief, limits) {
  if (!brief.found) {
    return `<div class="missing-card" data-uid="${esc(brief.uid || brief.icao)}"><span class="icao">${esc(brief.icao)}</span> — not in the reference dataset yet.
      ${phaseBanner(brief)}<div style="margin-top:6px;font-size:12px">Add it via NASR/OpenAIP ingest, or pick a bundled field.</div></div>`;
  }
  const a = brief.analysis;
  const ap = brief.airport;
  const statusClass = 'status-' + brief.status.replace('-', '');
  let body = phaseBanner(brief);

  if (a) {
    const highDA = a.densityAltitudeFt != null && limits.highda && a.densityAltitudeFt > limits.highda;
    // Default selected runway: the recommended (or active) one.
    const selRwy = a.active ? (a.runways.find((r) => r.ident === (brief.recommendedRunway || a.active.ident)) || a.active) : null;

    const warns = a.warnings.length
      ? `<div class="warnings">${a.warnings.map((w) =>
          `<div class="warn-item ${/exceeds|CLOSED/.test(w) ? 'crit' : ''}"><span class="ico">⚠</span><span>${esc(w)}</span></div>`).join('')}</div>`
      : '';

    body += `
      <div class="readout"><div class="raw">${esc(a.observation.rawText || 'No raw report')}</div></div>
      <div class="metrics">
        <div class="metric"><div class="k">Wind</div><div class="v" style="font-size:13px">${esc(formatWind(a.observation.wind))}</div></div>
        <div class="metric"><div class="k">Temp</div><div class="v">${a.observation.tempC ?? '--'}<small>°C</small></div></div>
        <div class="metric"><div class="k">Altimeter</div><div class="v">${a.observation.altimHpa ?? '--'}<small> hPa</small></div></div>
        <div class="metric ${highDA ? 'warn' : ''}"><div class="k">Density Alt</div><div class="v">${a.densityAltitudeFt != null ? a.densityAltitudeFt.toLocaleString() : '--'}<small> ft</small></div></div>
        ${brief.birdRisk ? `<div class="metric ${brief.birdRisk.level !== 'LOW' ? 'warn' : ''}" ${tipOf(birdRiskTip(brief.birdRisk))}><div class="k">AHAS Birds</div><div class="v" style="font-size:14px;color:${BIRD_COLOR[brief.birdRisk.level]}">${esc(brief.birdRisk.level)}</div>${birdRiskWhen(brief.birdRisk) ? `<small class="ahas-when">${esc(birdRiskWhen(brief.birdRisk))}</small>` : ''}</div>` : ''}
      </div>
      ${windBlock(brief, selRwy, limits)}
      ${a.active ? '<div class="rwys-cap">All runways — <b>tap any runway to compare its crosswind ↑</b></div>' : ''}
      <div class="rwys">${runwayRows(a, brief)}</div>
      ${warns}`;
  } else {
    body += `<div class="warn-item crit"><span class="ico">⚠</span><span>METAR unavailable — live weather source not reachable. Wind, runway, and density-altitude analysis are not shown (no data is fabricated).</span></div>`;
  }

  const ahasChip = brief.birdRisk
    ? `<span class="ahas-chip" style="color:${BIRD_COLOR[brief.birdRisk.level]};border-color:${BIRD_COLOR[brief.birdRisk.level]}" ${tipOf(birdRiskTip(brief.birdRisk))}>AHAS ${esc(brief.birdRisk.level)}</span>`
    : '';
  const roleTag = PHASE_TAG[brief.phase?.role]
    ? `<span class="role-tag role-${esc(brief.phase.role.toLowerCase())}">${esc(PHASE_TAG[brief.phase.role])}</span>` : '';
  return `<div class="card" data-icao="${esc(ap.icao)}" data-uid="${esc(brief.uid || ap.icao)}">
    <div class="head">${roleTag}<div><div class="icao">${esc(ap.icao)}</div><div class="name">${esc(ap.name)}</div></div>
      <div class="spacer"></div>${ahasChip}<div class="status-led ${statusClass}" ${tipOf(statusTip(brief))}>${esc(brief.status)}</div><span class="chev card-chev">▾</span></div>
    <div class="body">${body}${tabbedDetails(brief)}</div></div>`;
}

// ---- Data + events ---------------------------------------------------------
function readLimits() {
  return {
    xwind: Number(val('xwind')) || 30,
    tailwind: Number(val('tailwind')) || 10,
    highda: Number(val('highda')) || 5000,
  };
}

// Tap/click tooltip for the pills (hover titles don't appear on touch devices).
let pillTipEl = null;
function hidePillTip() { if (pillTipEl) { pillTipEl.remove(); pillTipEl = null; } }
function showPillTip(anchor, text) {
  hidePillTip();
  pillTipEl = document.createElement('div');
  pillTipEl.className = 'pill-tip';
  pillTipEl.textContent = text;
  document.body.appendChild(pillTipEl);
  const r = anchor.getBoundingClientRect();
  pillTipEl.style.top = `${r.bottom + 6 + window.scrollY}px`;
  pillTipEl.style.left = `${r.left + window.scrollX}px`;
  // Clamp to the viewport's right edge after layout.
  requestAnimationFrame(() => {
    if (!pillTipEl) return;
    const t = pillTipEl.getBoundingClientRect();
    const overflow = t.right - (window.innerWidth - 8);
    if (overflow > 0) pillTipEl.style.left = `${r.left + window.scrollX - overflow}px`;
  });
}

// What each data-source pill means, for the hover title + tap tooltip. This app
// shows only live data; a non-live pill means the source is UNAVAILABLE right
// now (nothing is fabricated).
const SOURCE_INFO = {
  WX: { what: 'Current surface weather (METARs) from AWC aviationweather.gov',
    unavail: 'Live source unreachable — no weather shown. Check the server can reach aviationweather.gov.' },
  TAF: { what: 'Terminal Aerodrome Forecasts from AWC aviationweather.gov',
    unavail: 'Live AWC TAF source unreachable — none shown. (A field with no TAF, e.g. many military fields, still shows LIVE; its card just notes no TAF.)' },
  NOTAM: { what: 'NOTAMs from the FAA NOTAM API',
    unavail: 'No live NOTAM source — set FAA credentials (NMS_CLIENT_ID/SECRET, or FAA_NOTAM_CLIENT_ID/SECRET). Nothing is fabricated.' },
  WINDS: { what: 'Winds aloft from Open-Meteo (api.open-meteo.com)',
    unavail: 'Live source unreachable — no winds shown.' },
  SUA: { what: 'Special Use Airspace (MOAs, Restricted/Warning/Alert areas) from the FAA ArcGIS feed',
    unavail: 'Live FAA feed unreachable — no SUA shown. Check outbound network access or set SUA_GEOJSON_URL.' },
  TFR: { what: 'Temporary Flight Restrictions from the FAA tfr.faa.gov feed (tfr3 list + AIXM detail)',
    unavail: 'FAA TFR feed unreachable — none shown (TFR_GEOJSON_URL overrides the source).' },
};
let notamSource = null; // provenance for the NOTAM pill tooltip (e.g. 'DAIP')
let notamSourceNote = null; // e.g. staging-fallback warning
function sourceTip(label, isLive) {
  const i = SOURCE_INFO[label] || {};
  let state = isLive
    ? 'LIVE — fetched in real time.'
    : `UNAVAILABLE — ${i.unavail || 'live source unreachable; nothing shown.'}`;
  if (label === 'NOTAM' && isLive && notamSource) {
    state = `LIVE — fetched in real time via ${notamSource}.${notamSourceNote ? `\n⚠ ${notamSourceNote}` : ''}`;
  }
  return `${label}: ${i.what || ''}\n${state}`;
}
const tipAttrs = (label, isLive) => {
  const t = esc(sourceTip(label, isLive));
  return `title="${t}" data-tip="${t}" role="button" tabindex="0"`;
};

// Short "valid period" label for an AHAS bird-risk record (the window it was run
// for), e.g. "12-hr outlook from 1300Z · 0800 CDT".
function birdRiskWhen(b) {
  if (!b || !b.runAt) return '';
  const lead = b.windowHours ? `${b.windowHours}-hr outlook from ` : 'valid ';
  return `${lead}${zuluLocal(b.runAt)}`;
}
function birdRiskTip(b) {
  if (!b) return '';
  const when = birdRiskWhen(b);
  return `AHAS bird-strike risk: ${b.level}.\n${b.note || ''}${when ? `\n${when}` : ''}\nSource: USAF AHAS (usahas.com), live.`;
}
// Generic hover-title + tap-tooltip attributes for any pill/badge.
const tipOf = (text) => { const t = esc(text); return `title="${t}" data-tip="${t}" role="button" tabindex="0"`; };

// Explain the airfield GO/CAUTION/NO-GO pill, including the specific reasons.
const STATUS_MEANING = {
  GO: 'GO — no limit exceedances, runway closures, or airspace/weather/bird alerts.',
  CAUTION: 'CAUTION — review the flagged items before using this field.',
  'NO-GO': 'NO-GO — a hard limit is exceeded (crosswind / tailwind / density altitude).',
  'NO-DATA': 'NO DATA — live METAR was unavailable, so the field could not be assessed.',
};
function statusTip(brief) {
  const reasons = brief.statusReasons || [];
  const head = `Field status ${brief.status} — computed from live METAR, NOTAMs, airspace (TFR/SUA/RAIM), AHAS birds, and SIGMET/convective.`;
  const meaning = STATUS_MEANING[brief.status] || '';
  const why = reasons.length ? `\nWhy:\n• ${reasons.join('\n• ')}` : '';
  return `${head}\n${meaning}${why}`;
}
const pillState = (isLive) => (isLive ? 'live' : 'unavail');

function setSourcePills(live) {
  const wx = $('wx-source'), nt = $('notam-source');
  if (wx) {
    wx.textContent = live.weather ? 'WX: LIVE' : 'WX: N/A';
    wx.className = 'pill ' + pillState(live.weather);
    wx.title = sourceTip('WX', live.weather); wx.dataset.tip = wx.title;
  }
  if (nt) {
    nt.textContent = live.notams ? 'NOTAM: LIVE' : 'NOTAM: N/A';
    nt.className = 'pill ' + pillState(live.notams);
    nt.title = sourceTip('NOTAM', live.notams); nt.dataset.tip = nt.title;
  }
}

// Prominent data-source status strip.
function updateStatusStrip(live) {
  const el = $('status-strip');
  if (!el) return;
  const badge = (label, isLive) => `<span class="sbadge ${pillState(isLive)}" ${tipAttrs(label, isLive)}>${label} ${isLive ? 'LIVE' : 'UNAVAIL'}</span>`;
  el.innerHTML =
    badge('WX', live.weather) +
    badge('TAF', live.taf) +
    badge('NOTAM', live.notams) +
    badge('WINDS', live.windsAloft) +
    badge('SUA', live.sua) +
    badge('TFR', live.tfr);
}

// Phase-group headers (sortie mode), in the order the client builds the stops.
const PHASE_GROUP = { DEPARTURE: '① Departure', RECOVERY: '③ Recovery', ALTERNATE: 'Alternates', FIELD: 'Fields' };

// Render the airfield cards. In sortie mode (data.sortie) cards are grouped by
// phase, in stop order, so the brief reads takeoff → recovery → alternates; the
// low-level phase is a slim banner pointing at the route detail + map. A plain
// departure-only brief falls back to a flat grid.
function renderAirfields(data, limits) {
  if (!data.sortie) return `<div class="grid">${data.airfields.map((b) => card(b, limits)).join('')}</div>`;
  const groups = [];
  for (const b of data.airfields) {
    const role = b.phase?.role || 'FIELD';
    let g = groups[groups.length - 1];
    if (!g || g.role !== role) { g = { role, items: [] }; groups.push(g); }
    g.items.push(b);
  }
  const html = groups.map((g) =>
    `<div class="phase-group"><div class="phase-group-h">${esc(PHASE_GROUP[g.role] || PHASE_GROUP.FIELD)}</div>
      <div class="grid">${g.items.map((b) => card(b, limits)).join('')}</div></div>`);
  // Insert the low-level banner between Departure and Recovery when routes exist.
  if (activeRoutes.length) {
    const llWhen = activeRoutes.find((d) => d.birdRisk?.runAt)?.birdRisk?.runAt
      || activeRoutes.find((d) => d.windsAt)?.windsAt || null;
    const llValid = llWhen ? `<span class="ll-hint">AHAS valid ${esc(zuluLocal(llWhen, { date: true }))} · per-leg winds, altitudes and entry-time AHAS are in the route detail above and on the map.</span>`
      : `<span class="ll-hint">Per-leg winds, altitudes and entry-time AHAS are in the route detail above and on the map.</span>`;
    const ll = `<div class="phase-group lowlevel-group"><div class="phase-group-h">② Low-level</div>
      <div class="ll-banner">${activeRoutes.map((d) => `<span class="route-chip ${RC_CLASS[d.type] || 'rc-ir'}"><span class="rc-dot"></span>${esc(d.id)}${d.birdRisk ? ` · <b style="color:${BIRD_COLOR[d.birdRisk.level]}">AHAS ${esc(d.birdRisk.level)}</b>` : ''}</span>`).join('')}
        ${llValid}</div></div>`;
    const depIdx = groups.findIndex((g) => g.role === 'RECOVERY');
    if (depIdx >= 0) html.splice(depIdx, 0, ll); else html.push(ll);
  }
  return html.join('');
}

// Shared fetch + render for both the quick brief and the structured sortie.
async function runBrief({ ids, limits, extra = {}, button }) {
  const params = new URLSearchParams({
    ids: ids.join(','), xwind: limits.xwind, tailwind: limits.tailwind, highda: limits.highda,
  });
  const agls = val('agls').replace(/\s+/g, '');
  if (agls) params.set('agls', agls);
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);

  if (button) $(button).disabled = true;
  $('results').innerHTML = `<div class="loading"><div class="spinner"></div>Pulling weather &amp; NOTAMs…</div>`;
  try {
    const res = await fetch(`/api/brief?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    notamSource = data.notamSource || null;
    notamSourceNote = data.notamSourceNote || null;
    setSourcePills(data.live);
    updateStatusStrip(data.live);
    cardData = {};
    data.airfields.forEach((b) => { cardData[(b.uid || b.icao).toUpperCase()] = { brief: b, limits }; });
    $('results').innerHTML = renderAirfields(data, limits);
    updatePrintHead(data, ids, limits);
    renderMap(data);
    return data;
  } catch (err) {
    $('results').innerHTML = `<div class="errbox">Failed to build brief: ${esc(err.message)}<br/>
      <span style="color:var(--text-dim);font-size:12px">Is the server running?</span></div>`;
    return null;
  } finally {
    if (button) $(button).disabled = false;
  }
}

// Current Zulu (UTC) wall time as a datetime-local input value
// (YYYY-MM-DDTHH:mm). The field has no timezone, so we show the UTC digits and
// treat what the user types as Zulu (see zuluToIso).
function nowZuluDt() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
// Default every empty time field to "now" in Zulu so phases start from the
// current Zulu date+time without the user having to type it.
function prefillDatetimes() {
  ['sp-dep-t', 'sp-ll-t', 'sp-rec-t'].forEach((id) => {
    const el = $(id);
    if (el && !el.value) el.value = nowZuluDt();
  });
}

// A datetime-local value entered as ZULU (UTC) → ISO, or '' when blank/invalid.
// The input carries no timezone, so we pin the entered wall time to UTC.
function zuluToIso(id) {
  const v = val(id);
  if (!v) return '';
  const base = v.length === 16 ? `${v}:00` : v; // ensure seconds
  const d = new Date(`${base}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
const splitIds = (s) => String(s || '').split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);

// Quick-links toolbar: external references for the current departure airfield.
// AWC deep-links to the field's METAR/TAF; DAIP and AHAS open their tools (they
// don't expose a public per-ICAO URL), with the field shown in the label.
function quickLinkUrls(icao) {
  const id = encodeURIComponent(icao);
  return {
    'ql-daip': { href: 'https://www.daip.jcs.mil/', text: `DAIP · ${icao}` },
    'ql-awc': { href: `https://aviationweather.gov/data/metar/?ids=${id}&taf=true`, text: `Aviation Weather · ${icao}` },
    'ql-ahas': { href: 'https://www.usahas.com/', text: `AHAS · ${icao}` },
  };
}
function updateQuickLinks() {
  const icao = splitIds(val('sp-dep'))[0] || 'KLTS';
  for (const [linkId, { href, text }] of Object.entries(quickLinkUrls(icao))) {
    const el = $(linkId);
    if (el) { el.href = href; el.textContent = text; }
  }
}

// Build the brief from the single sortie panel: each phase (departure /
// low-level / recovery / alternates) is evaluated at its own time, and any
// low-level routes are looked up at the entry time and overlaid. Departure-only
// (no times) collapses to the simple "one field, now" brief.
async function buildBrief() {
  const depIcao = splitIds(val('sp-dep'))[0];
  const recIcao = splitIds(val('sp-rec'))[0];
  const alts = splitIds(val('sp-alt'));
  const routes = splitIds(val('sp-ll'));
  const depT = zuluToIso('sp-dep-t');
  const recT = zuluToIso('sp-rec-t');
  const llT = zuluToIso('sp-ll-t');

  // Compose ordered stops (departure → recovery → alternates). A field with no
  // time still gets a card (evaluated "now"); alternates inherit the landing time.
  const stops = [];
  if (depIcao) stops.push({ icao: depIcao, when: depT, role: 'DEPARTURE', label: 'Departure' });
  if (recIcao) stops.push({ icao: recIcao, when: recT, role: 'RECOVERY', label: 'Recovery' });
  for (const a of alts) stops.push({ icao: a, when: recT, role: 'ALTERNATE', label: 'Alternate' });
  if (!stops.length) {
    $('results').innerHTML = `<div class="errbox">Enter a departure field (and optionally a recovery field, alternates, and a low-level route).</div>`;
    return;
  }
  const ids = [...new Set(stops.map((s) => s.icao))];
  const stopsParam = stops.map((s) => `${s.icao}@${s.when || ''}@${s.role}@${s.label}`).join('|');

  // Look up the low-level routes (at entry time) first so the brief's low-level
  // banner can show their entry-time AHAS risk, and the map overlays them. The
  // sortie's low-level field is the source of truth, so start from a clean set.
  activeRoutes = [];
  if (routes.length) await lookupRoutes(routes, llT, { scroll: false });
  else renderRouteResults();
  await runBrief({ ids, limits: readLimits(), extra: { stops: stopsParam }, button: 'go' });
}

// The phase field a quick-chip drops into: whichever airfield field was focused
// last (Departure / Recovery / Alternates), defaulting to Departure.
let chipTarget = 'sp-dep';
function trackChipTarget() {
  ['sp-dep', 'sp-rec', 'sp-alt'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('focus', () => { chipTarget = id; });
  });
}

async function loadQuickChips() {
  try {
    const res = await fetch('/api/airfields');
    const { airfields } = await res.json();
    $('quick').innerHTML = airfields.map((a) => `<span class="chip" data-icao="${a}">+ ${a}</span>`).join('');
    $('quick').querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        // Departure/Recovery take a single field; Alternates can take several.
        const target = $(chipTarget) || $('sp-dep');
        const icao = chip.dataset.icao;
        if (target.id === 'sp-alt') {
          const cur = splitIds(target.value);
          if (!cur.includes(icao)) target.value = [...cur, icao].join(' ');
        } else {
          target.value = icao;
        }
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
  const t = pt.time ? `<span class="count">${esc(zuluLocal(pt.time))} fcst</span>` : '';
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

async function getRouteWinds({ paintMap = true } = {}) {
  const pts = $('winds-points').value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!pts.length) return;
  const params = new URLSearchParams({ points: pts.join(',') });
  $('winds-go').disabled = true;
  $('winds-results').innerHTML = `<div class="loading"><div class="spinner"></div>Fetching winds aloft…</div>`;
  try {
    const res = await fetch(`/api/winds?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    $('winds-results').innerHTML = `<div class="grid">${data.points.map(windsProfileCard).join('')}</div>`;
    // Radar-along-route: drop the route points + hazardous wx onto the map.
    // Skipped when loading a saved sortie that also shows a brief (the brief map
    // owns the view there; this tool's focused overlay would clobber it).
    const routePts = data.points.filter((p) => p.found).map((p) => ({ icao: p.id, lat: p.lat, lon: p.lon, status: (p.hazards || []).some((h) => h.hazard === 'CONVECTIVE') ? 'CAUTION' : 'GO' }));
    if (paintMap && routePts.length) {
      const mapEl = $('map');
      mapEl.style.display = '';
      currentMap = initMap(mapEl, { airfields: routePts, tfrs: [], sua: [], sigmets: data.airsigmets || [], pireps: [] });
    }
  } catch (err) {
    $('winds-results').innerHTML = `<div class="errbox">Failed: ${esc(err.message)}</div>`;
  } finally {
    $('winds-go').disabled = false;
  }
}

// ---- MTR (low-level route) lookup tool -------------------------------------
function mtrDetailCard(d) {
  const segs = d.segments.map((s) => {
    const alt = s.altText || (s.floorFt != null ? `${s.floorFt.toLocaleString()}–${(s.ceilingFt ?? 0).toLocaleString()} ${s.agl ? 'AGL' : 'MSL'}` : '—');
    const wd = s.widthLeftNm != null ? ` · ${s.widthLeftNm}/${s.widthRightNm} NM` : '';
    const w = s.wind;
    const wind = w
      ? `${String(w.dirTrue).padStart(3, '0')}/${w.speedKt} → HW ${w.headwindKt} · XW ${w.crosswindKt}${w.crosswindSide !== 'none' ? ' ' + w.crosswindSide[0].toUpperCase() : ''}`
      : '—';
    const xwHi = w && Math.abs(w.crosswindKt) >= 20;
    return `<div class="mtr-seg">
      <div class="mtr-seg-h">${esc(s.name)} <span class="rwy-len">${esc(s.lengthNm)} NM · brg ${s.bearing != null ? String(s.bearing).padStart(3, '0') + '°' : '—'} · ${esc(alt)}${esc(wd)}</span> ${birdBadge(s.birdRisk)}</div>
      <div class="mtr-seg-w ${xwHi ? 'hi' : ''}">leg wind @${w ? w.altFt.toLocaleString() + ' ft' : '—'}: ${esc(wind)}</div>
    </div>`;
  }).join('');
  const bv = d.birdRisk;
  // AHAS validity: the Zulu hour the risk was pulled for, plus the route-entry
  // time requested — so the user can confirm the right time was used. (AHAS is a
  // point-in-time value floored to the top of the Zulu hour.)
  const ahasWhen = (() => {
    const bits = [];
    if (bv?.runAt) bits.push(`valid <b>${esc(zuluLocal(bv.runAt, { date: true }))}</b> (AHAS top-of-hour)`);
    const req = bv?.requested || d.windsAt;
    if (req) bits.push(`route entry ${esc(zuluLocal(req, { date: true }))}`);
    return bits.length ? `<div class="mtr-when">${bits.join(' · ')}</div>` : '';
  })();
  const routeBird = bv
    ? `<div class="mtr-bird" style="color:${BIRD_COLOR[bv.level]}">⚠ AHAS bird risk: <b>${esc(bv.level)}</b> — ${esc(bv.note || '')}</div>${ahasWhen}`
    : (d.windsAt
        ? `<div class="mtr-bird" style="color:var(--text-dim)">AHAS bird risk: UNAVAILABLE — no data returned for route entry ${esc(zuluLocal(d.windsAt, { date: true }))} (nothing fabricated)</div>`
        : '');
  const refuel = d.refuelAlt ? `<div class="mtr-bird" style="color:var(--accent)">⛽ Refueling altitude: <b>${esc(d.refuelAlt)}</b> — leg winds below are at this block</div>` : '';
  return `<div class="card"><div class="head">
      <div><div class="icao">${esc(d.id)}</div><div class="name">${esc(d.type)} · ${esc(d.name)}${d.agency ? ' · ' + esc(d.agency) : ''}</div></div>
      <div class="spacer"></div>${d.birdRisk ? birdBadge(d.birdRisk.level) : ''}</div>
    <div class="body">${refuel}${routeBird}<div class="mtr-segs">${segs}</div></div></div>`;
}

const RC_CLASS = { IR: 'rc-ir', VR: 'rc-vr', AR: 'rc-ar' };

// Removable chips for the routes currently overlaid on the map.
function routeChips() {
  if (!activeRoutes.length) return '';
  const chip = (d) => `<span class="route-chip ${RC_CLASS[d.type] || 'rc-ir'}">
      <span class="rc-dot"></span>${esc(d.id)}
      <button class="route-chip-x" data-route-id="${esc(d.id)}" title="Remove ${esc(d.id)}" aria-label="Remove ${esc(d.id)}">×</button></span>`;
  return `<div class="route-chips"><span class="rc-label">On map:</span>${activeRoutes.map(chip).join('')}
      <button class="route-chip-clear" title="Remove all routes">Clear all</button></div>`;
}

// Render the chip bar + a detail card for every active route (cards persist
// across lookups so the chips, cards, and map always agree).
function renderRouteResults(missing = []) {
  const details = activeRoutes.map((d) => `<div class="route-detail" data-route-id="${esc(d.id)}">${mtrDetailCard(d)}</div>`).join('');
  const miss = missing.length
    ? `<div class="missing-card">Not found: ${missing.map((d) => esc(d.id)).join(', ')} — try a published AP/1B route (e.g. IR-154, IR-193, VR-106, AR197H, AR312H), or set MTR_GEOJSON_URL for a live route source.</div>`
    : '';
  $('mtr-results').innerHTML = (routeChips() + details + miss) || '';
}

// Look up one or more routes (optionally at a given entry time), accumulate them
// onto the map, and render the route detail cards. Shared by the Route Lookup
// tool and the Sortie Plan's low-level phase. Returns the found routes.
async function lookupRoutes(ids, whenIso, { scroll = true } = {}) {
  if (!ids.length) return [];
  const params = new URLSearchParams({ id: ids.join(',') });
  if (whenIso) params.set('when', whenIso);
  try {
    const res = await fetch(`/api/mtr?${params}`);
    const data = await res.json();
    const routes = data.routes || [];
    const missing = routes.filter((d) => !d.found);
    // Accumulate found routes (add new, refresh existing) so a low-level and an
    // AR track looked up separately can both stay on the map.
    for (const d of routes.filter((r) => r.found)) {
      const i = activeRoutes.findIndex((r) => normId(r.id) === normId(d.id));
      if (i >= 0) activeRoutes[i] = d; else activeRoutes.push(d);
    }
    renderRouteResults(missing);
    if (activeRoutes.length) {
      paintMap();
      if (scroll) $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return routes.filter((r) => r.found);
  } catch (err) {
    $('mtr-results').innerHTML = `<div class="errbox">Lookup failed: ${esc(err.message)}</div>`;
    return [];
  }
}

// Build the map's "valid times" caption from the brief data. Radar is a live
// NEXRAD mosaic (no exact scan time exposed), so it's stamped with the brief
// time rounded to the ~5-min update cadence as a fallback; the map refines this
// to the actual latest radar frame time via RainViewer's API (id 'radar'). The
// advisory layers carry real valid times from the server.
function wxValidity(data) {
  const lines = [];
  if (data.generatedAt) {
    const d = new Date(data.generatedAt);
    if (!Number.isNaN(d.getTime())) {
      d.setUTCSeconds(0, 0);
      d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5);
      lines.push({ id: 'radar', k: 'Radar', v: `NEXRAD · ~${zuluLocal(d.toISOString())} (latest)` });
    }
  }
  const sig = data.airsigmets || [];
  if (sig.length) {
    const until = sig.map((s) => s.validTo).filter(Boolean).sort().pop();
    lines.push({ k: 'SIG/AIRMET', v: `${sig.length} active${until ? ` · thru ${zuluLocal(until, { date: true })}` : ''}` });
  }
  const pr = data.pireps || [];
  if (pr.length) {
    const newest = pr.map((p) => p.obsTime).filter(Boolean).sort().pop();
    lines.push({ k: 'PIREPs', v: `${pr.length}${newest ? ` · newest ${zuluLocal(newest)}` : ''}` });
  }
  const cv = data.convective || [];
  if (cv.length) lines.push({ k: 'Convective', v: `SPC outlook · ${cv.length} area${cv.length > 1 ? 's' : ''}` });
  return lines;
}

// The main map is state-driven so looked-up routes can be overlaid on the brief
// context (airfields, radar, weather). lastBriefData holds the most recent
// brief; activeRoutes are the routes the user has looked up (full server detail
// objects), shown as removable chips.
let lastBriefData = null;
let activeRoutes = [];
const normId = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function renderMap(data) {
  lastBriefData = data;
  paintMap();
}

function paintMap() {
  const mapEl = $('map');
  if (!mapEl) return;
  const data = lastBriefData;
  const airfields = data
    ? data.airfields.filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lon))
        .map((b) => ({ icao: b.icao, lat: b.lat, lon: b.lon, status: b.status }))
    : [];
  // With routes looked up, show exactly those (chip-controlled) over the brief;
  // otherwise fall back to the brief's auto nearby routes.
  const mtrs = activeRoutes.length
    ? activeRoutes.map((d) => ({ id: d.id, type: d.type, geometry: d.geometry }))
    : (data?.mtrs || []);
  if (!airfields.length && !mtrs.length) { mapEl.style.display = 'none'; return; }
  mapEl.style.display = '';
  const as = data?.airspace || { tfrs: [], sua: [] };
  // Fit to the airfields plus any looked-up route points (auto nearby routes
  // don't drag the default view out).
  const routePts = activeRoutes.flatMap((d) => (d.geometry?.points || []).map(([lat, lon]) => ({ lat, lon })));
  const focus = activeRoutes.length ? [...airfields, ...routePts] : airfields;
  currentMap = initMap(mapEl, {
    airfields, tfrs: as.tfrs, sua: as.sua,
    sigmets: data?.airsigmets || [], pireps: data?.pireps || [], convective: data?.convective || [],
    mtrs, validity: data ? wxValidity(data) : [], focus,
  });
}

function updatePrintHead(data, ids, limits) {
  const src = `WX ${data.live.weather ? 'LIVE' : 'UNAVAIL'} · NOTAM ${data.live.notams ? 'LIVE' : 'UNAVAIL'}`;
  let takeoff = '';
  if (data.sortie) {
    // Summarize the phase timeline (each phase at its own time).
    const phases = data.airfields
      .filter((b) => b.phase && b.phase.when && b.phase.role !== 'FIELD')
      .map((b) => `${esc(b.phase.label)} ${esc(b.icao)} @ ${esc(zuluLocal(b.phase.when))}`);
    const ll = activeRoutes.length ? [`Low-level ${activeRoutes.map((d) => esc(d.id)).join(', ')}`] : [];
    const line = [...phases.slice(0, 1), ...ll, ...phases.slice(1)].join('  →  ');
    takeoff = line ? `<div class="ph-meta">Sortie timeline: ${line} — each phase evaluated at its own time</div>` : '';
  } else if (data.targetTime) {
    takeoff = `<div class="ph-meta">Planned takeoff ${esc(zuluLocal(data.targetTime, { date: true }))} — winds &amp; AHAS tailored to this time</div>`;
  }
  $('print-head').innerHTML =
    `<div class="ph-title">C-17 MISSION BRIEF</div>
     <div class="ph-meta">${esc(ids.join(' · '))}</div>
     <div class="ph-meta">Generated ${esc(zuluLocal(data.generatedAt, { date: true }))} · ${esc(src)} · Limits: XW ${limits.xwind} / TW ${limits.tailwind} kt, DA ${limits.highda} ft · Pattern AGL: ${esc(val('agls').trim())} ft</div>
     ${takeoff}
     <div class="ph-meta ph-warn">PLANNING AID ONLY — VERIFY WITH OFFICIAL SOURCES</div>`;
}

// ---- Saved sorties (server-backed when a DB is configured, else browser-local)
const SORTIE_KEY = 'c17-sorties';
let sortieMode = 'local';   // 'remote' when the platform DB is available
let sortieCache = {};       // name -> { <input id>: value, ... }

// Every input that makes up a saved sortie. Keyed by element id so a saved
// record round-trips through save/load directly (and older saves still load —
// absent keys are left untouched). Covers the sortie phases, limits, pattern
// AGL, and the Route/Climb Winds tool.
const SORTIE_FIELDS = [
  'sp-dep', 'sp-dep-t', 'sp-ll', 'sp-ll-t', 'sp-rec', 'sp-rec-t', 'sp-alt',
  'xwind', 'tailwind', 'highda', 'agls',
  'winds-points',
];

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
  // Capture every sortie input by id (empty values included, so loading
  // restores the exact setup — including a cleared route or takeoff time).
  const data = {};
  for (const id of SORTIE_FIELDS) { const el = $(id); if (el) data[id] = (el.value || '').trim(); }
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

async function loadSelectedSortie() {
  const s = sortieCache[$('sortie-list').value];
  if (!s) return;
  // Restore each saved field by id. Keys present in the record (even empty)
  // overwrite, so a saved blank clears the field; absent keys are left as-is.
  for (const id of SORTIE_FIELDS) { const el = $(id); if (el && id in s) el.value = s[id]; }
  // Reset any routes currently on the map so the load reflects exactly the
  // saved sortie (buildBrief re-looks-up the low-level route(s) below).
  activeRoutes = [];
  // Some legacy saves stored the airfield list under `icaos`; map it to Departure.
  if (!(s['sp-dep'] || '').trim() && (s.icaos || '').trim()) {
    const dep = $('sp-dep'); if (dep) dep.value = splitIds(s.icaos)[0] || '';
  }
  await buildBrief(); // evaluates each phase + overlays the low-level route(s)
  // The Route/Climb Winds input is restored; re-run it if it was populated so
  // its profiles come back too, but leave the brief's map in place.
  if ((s['winds-points'] || '').trim()) getRouteWinds({ paintMap: false });
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

// Lazy-load the export module only when a user actually exports, so the core
// app never depends on it loading successfully.
async function runExport(format) {
  try {
    const { exportBrief } = await import('./export.js');
    await exportBrief(format, { map: currentMap });
  } catch (err) {
    alert('Export unavailable: ' + (err && err.message ? err.message : err));
  }
}

function init() {
  // Collapse/expand the tool panels (Route Winds, Route Lookup).
  document.addEventListener('click', (e) => {
    const head = e.target.closest('[data-collapse]');
    if (!head) return;
    const sec = document.getElementById(head.dataset.collapse);
    if (sec) sec.classList.toggle('collapsed');
  });

  // Pill tooltips: tap a data-source pill to explain LIVE/UNAVAILABLE (works on touch);
  // tap anywhere else to dismiss.
  document.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-tip]');
    if (pill) { showPillTip(pill, pill.dataset.tip); return; }
    hidePillTip();
  });
  document.addEventListener('keydown', (e) => {
    const pill = e.key === 'Enter' || e.key === ' ' ? e.target.closest?.('[data-tip]') : null;
    if (pill) {
      e.preventDefault();
      showPillTip(pill, pill.dataset.tip);
    } else if (e.key === 'Escape') {
      hidePillTip();
    }
  });
  window.addEventListener('resize', hidePillTip);

  // Route chips: remove one route, or clear them all, then repaint the map.
  $('mtr-results')?.addEventListener('click', (e) => {
    const x = e.target.closest('.route-chip-x');
    if (x) {
      const nid = normId(x.dataset.routeId);
      activeRoutes = activeRoutes.filter((r) => normId(r.id) !== nid);
      renderRouteResults();
      paintMap();
      return;
    }
    if (e.target.closest('.route-chip-clear')) {
      activeRoutes = [];
      $('mtr-results').innerHTML = '';
      paintMap();
    }
  });

$('results')?.addEventListener('click', (e) => {
  // Collapse/expand a whole airfield card by clicking its header (but not when
  // tapping a pill in the header — that shows its tooltip instead).
  const cardHead = e.target.closest('.card > .head');
  if (cardHead && !e.target.closest('[data-tip]')) { cardHead.parentElement.classList.toggle('collapsed'); return; }

  // Tab switching within a card.
  const tab = e.target.closest('.card-tabs .tab');
  if (tab) {
    const cardEl = tab.closest('.card');
    const key = tab.dataset.tab;
    cardEl.querySelectorAll('.card-tabs .tab').forEach((x) => x.classList.toggle('active', x === tab));
    cardEl.querySelectorAll('.tabpanel').forEach((p) => p.classList.toggle('active', p.dataset.panel === key));
    return;
  }

  // NOTAM category filter: show ONLY the chosen category — hide every other
  // group and expand the selected one. ALL restores all groups to their default
  // open/closed state.
  const nf = e.target.closest('.nfilter');
  if (nf) {
    const cat = nf.dataset.cat;
    const bar = nf.parentElement;
    bar.querySelectorAll('.nfilter').forEach((c) => c.classList.remove('active'));
    nf.classList.add('active');
    bar.parentElement.querySelectorAll('.ngroup').forEach((g) => {
      const match = cat === 'ALL' || g.dataset.cat === cat;
      g.hidden = !match;
      g.open = cat === 'ALL' ? NOTAM_OPEN_DEFAULT.has(g.dataset.cat) : true;
    });
    return;
  }

  // Runway compare: click a runway row to recompute the wind block for it.
  const row = e.target.closest('.rwy-row.selectable');
  if (row && row.dataset.rwy) {
    const cardEl = row.closest('.card');
    const entry = cardData[(cardEl?.dataset.uid || cardEl?.dataset.icao || '').toUpperCase()];
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
  e.preventDefault();
  const wrap = t.closest('.tabpanel') || t.closest('details') || t.closest('.card');
  const raw = wrap.querySelector('.raw-taf');
  const dec = wrap.querySelector('.taf-decoded');
  const showRaw = raw.style.display === 'none';
  raw.style.display = showRaw ? 'block' : 'none';
  dec.style.display = showRaw ? 'none' : 'block';
  t.textContent = showRaw ? 'show decoded' : 'show raw';
});

// Expand all collapsible sections (incl. NOTAM category groups) for printing,
// and un-hide any groups a category filter is currently hiding so the printed
// brief is always complete.
window.addEventListener('beforeprint', () => {
  document.querySelectorAll('details.sec, details.ngroup').forEach((d) => { d.dataset.wasopen = d.open ? '1' : '0'; d.open = true; });
  document.querySelectorAll('.ngroup[hidden]').forEach((g) => { g.dataset.washidden = '1'; g.hidden = false; });
});
window.addEventListener('afterprint', () => {
  document.querySelectorAll('details.sec, details.ngroup').forEach((d) => { if (d.dataset.wasopen === '0') d.open = false; });
  document.querySelectorAll('.ngroup[data-washidden="1"]').forEach((g) => { g.hidden = true; delete g.dataset.washidden; });
});

  prefillDatetimes();
  trackChipTarget();
  updateQuickLinks();
  on('sp-dep', 'input', updateQuickLinks); // keep the toolbar in sync with the field
  on('go', 'click', buildBrief);
  on('sp-clear', 'click', () => {
    ['sp-dep', 'sp-dep-t', 'sp-ll', 'sp-ll-t', 'sp-rec', 'sp-rec-t', 'sp-alt'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
    prefillDatetimes(); // restore the time fields to "now"
  });
  // Enter in any phase field builds the brief.
  ['sp-dep', 'sp-ll', 'sp-rec', 'sp-alt'].forEach((id) => on(id, 'keydown', (e) => { if (e.key === 'Enter') buildBrief(); }));
  on('export-html', 'click', () => runExport('html'));
  on('export-pdf', 'click', () => runExport('pdf'));
  on('sortie-save', 'click', saveCurrentSortie);
  on('sortie-load', 'click', loadSelectedSortie);
  on('sortie-del', 'click', deleteSelectedSortie);
  initSorties();
  on('winds-go', 'click', getRouteWinds);
  on('winds-points', 'keydown', (e) => { if (e.key === 'Enter') getRouteWinds(); });
  loadQuickChips();
  buildBrief();
}

// Run init only once the DOM is ready, and never let a missing element abort it.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Retire any previously-installed service worker. Earlier builds cached app
// assets, which caused stale app.js to be served after deploys (version skew).
// The server now sends no-cache on all app assets, so we load fresh from the
// origin and no longer use a service worker. Proactively unregister and purge
// any leftover caches so existing installs self-heal.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations?.()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => {});
  if (self.caches?.keys) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
  }
}
