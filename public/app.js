// DEAD Planning — static frontend (no framework, no build).
// Talks to the zero-dependency Node API and renders the EFB-style brief.

import { initMap } from './map.js';
import { zuluLocal, zuluLocalHtml, hhZ, hhL, TZ_ABBR } from './timefmt.js';
import { buildRibbonModel, roleTag as rbRoleTag, sigTip, pirepTip, pirepKind, AWC_SIGMET_URL, SPC_OUTLOOK_URL, AWC_PIREP_URL } from './ribbon.js';
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

// Routine-for-print NOTAMs: verbose DOD procedural/IAP-minima notices and the
// services/other tail. Always shown on screen; the "essential NOTAMs" print
// toggle hides them on the kneeboard (with a count so nothing hides silently).
function isRoutineNotam(n) {
  if (/PROCEDURAL\s+NOTAM|INSTRUMENT\s+APPROACH\s+PROCEDURE|DEPARTURE\s+PROCEDURES/i.test(n.text || '')) return true;
  return n.category === 'SERVICES' || n.category === 'OTHER';
}

function notamRow(n) {
  const end = n.effectiveEnd ? `<div class="when">until ${esc(zuluLocal(n.effectiveEnd, { date: true }))}</div>` : '';
  return `<div class="notam${isRoutineNotam(n) ? ' n-routine' : ''}" data-cat="${esc(n.category)}"><span class="cat cat-${esc(n.category)}">${esc(n.category)}</span>
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
    const routine = items.filter(isRoutineNotam).length;
    const hiddenNote = routine
      ? `<div class="n-hidden-note">${routine} procedural/routine NOTAM${routine > 1 ? 's' : ''} omitted from this printout — see the app or DAIP for full text.</div>`
      : '';
    return `<details class="ngroup" data-cat="${esc(cat)}"${open ? ' open' : ''}>
      <summary class="ngroup-sum"><span class="cat cat-${esc(cat)}">${esc(cat)}</span>
        <span class="ngroup-n">${items.length}</span><span class="ngroup-chev">▾</span></summary>
      <div class="notams">${items.map(notamRow).join('')}${hiddenNote}</div></details>`;
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
      const temp = p.tempC != null ? ` · ${p.tempC > 0 ? '+' : ''}${p.tempC}°C` : '';
      return `<div class="as-row"><span class="cat cat-LIGHTING">${esc(lbl)}</span>
        <div><div class="txt">${esc(p.altFt.toLocaleString())} ft MSL — ${String(p.dirTrue).padStart(3, '0')}°/${p.speedKt} kt${esc(temp)}</div></div></div>`;
    })
    .join('');
  // Honesty (R2): if the requested phase time is beyond the forecast window, the
  // shown sample is the window edge — say so plainly, don't imply it's the ETA wind.
  const clamp = wa.clamped
    ? `<div class="when" style="margin-bottom:6px;color:var(--warn,#d29922)">⚠ Beyond winds-aloft forecast horizon — showing the latest available (${esc(zuluLocal(wa.time))}), NOT your phase time. Verify with an official source.</div>`
    : (wa.time ? `<div class="when" style="margin-bottom:6px">forecast ${esc(zuluLocal(wa.time))} · pattern/departure band</div>` : '');
  return `${clamp}${thermalLine(brief.thermal)}<div class="notams">${rows}</div>`;
}

// Winds-aloft thermal/structure line: max-wind level + tropopause (for AR block
// selection), freezing level, and structural-icing band(s). Honest — icing is
// temperature/RH-based (needs visible moisture); tropopause/freezing computed.
function thermalLine(th) {
  if (!th) return '';
  const bits = [];
  if (th.maxWind) {
    bits.push(`Max wind <b>${String(th.maxWind.dirTrue).padStart(3, '0')}°/${th.maxWind.speedKt} kt</b> @ ${th.maxWind.altFt.toLocaleString()} ft`);
  }
  if (th.tropopauseFt != null) {
    bits.push(`<span title="Lowest level where the lapse rate drops below 2°C/km (WMO), computed from the forecast profile">Tropopause ~<b>${th.tropopauseFt.toLocaleString()} ft</b></span>`);
  } else {
    bits.push('<span title="Temperature is still falling at the profile top (~FL340) — the tropopause is above the sampled column" class="thm-note">Tropopause &gt; FL340</span>');
  }
  // Freezing + icing only when temperatures were available.
  if (th.freezingLevelFt != null || (th.icing && th.icing.length) || th.tropopauseFt != null) {
    const fl = th.freezingLevelFt != null
      ? `Freezing level <b>${th.freezingLevelFt.toLocaleString()} ft MSL</b>`
      : 'Freezing level above sampled column';
    bits.push(fl);
    const ic = th.icing || [];
    if (!ic.length) {
      bits.push('<span class="thm-ok" title="No layer in the 0 to −20°C band with RH ≥ 70% in the forecast profile">no icing band</span>');
    } else {
      bits.push(ic.map((b) => {
        const sevCls = b.severity === 'MODERATE' ? 'thm-mod' : b.severity === 'LIGHT' ? 'thm-lt' : 'thm-tr';
        const rh = b.maxRhPct != null ? ` · RH ${b.maxRhPct}%` : '';
        return `<span class="thm-band ${sevCls}" title="Structural-icing potential: 0 to −20°C band with RH ≥ 70% (≥ 85% = wet). Temp/RH-based — needs visible moisture.">Icing ${esc(b.severity)} ${b.baseFt.toLocaleString()}–${b.topFt.toLocaleString()} ft (min ${b.minTempC}°C${rh})</span>`;
      }).join(' '));
    }
  }
  return `<div class="thermal-line"><span class="thm-h">❄ Aloft</span> ${bits.join(' · ')}
    <span class="thm-note">computed from the forecast profile — icing needs visible moisture; verify with G-AIRMET/SIGMET</span></div>`;
}

const CONV_CLASS = { TSTM: 'cat-LIGHTING', MRGL: 'cat-APPROACH', SLGT: 'cat-APPROACH', ENH: 'cat-RUNWAY', MDT: 'cat-RUNWAY', HIGH: 'cat-RUNWAY' };

function hazardWxSection(brief) {
  const wx = brief.hazardWx || [];
  const conv = brief.convective || [];
  const gairmets = brief.gairmets || [];
  if (!wx.length && !conv.length && !gairmets.length) return '';
  const wxRows = wx.map((h) => {
    const cls = h.hazard === 'CONVECTIVE' ? 'cat-RUNWAY' : h.type === 'SIGMET' ? 'cat-APPROACH' : 'cat-LIGHTING';
    const dist = h.distanceNm === 0 ? '<b>OVERHEAD</b>' : esc(h.distanceNm) + ' NM';
    const alt = h.lowFt != null ? ` · ${esc(h.lowFt.toLocaleString())}–${esc((h.hiFt ?? 0).toLocaleString())} ft` : '';
    const end = h.validTo ? ` · until ${esc(zuluLocal(h.validTo, { date: true }))}` : '';
    const over = h.distanceNm === 0 ? ' as-over' : '';
    return `<div class="as-row${over}"><span class="cat ${cls}">${esc(h.type)}</span>
      <div><div class="txt">${esc(h.label)} · ${dist}</div><div class="when">${alt}${end}</div></div></div>`;
  }).join('');
  const convRows = conv.map((c) => {
    const dist = c.distanceNm === 0 ? '<b>OVERHEAD</b>' : esc(c.distanceNm) + ' NM';
    return `<div class="as-row${c.distanceNm === 0 ? ' as-over' : ''}"><span class="cat ${CONV_CLASS[c.risk] || 'cat-LIGHTING'}">${esc(c.risk)}</span>
      <div><div class="txt">Convective outlook: ${esc(c.label)} · ${dist}</div></div></div>`;
  }).join('');
  // G-AIRMET (graphical AIRMET) — forecast guidance; informational, distinct tag.
  const gaRows = gairmets.map((g) => {
    const dist = g.distanceNm === 0 ? '<b>OVERHEAD</b>' : esc(g.distanceNm) + ' NM';
    const alt = g.lowFt != null ? ` · ${esc(g.lowFt.toLocaleString())}–${esc((g.hiFt ?? 0).toLocaleString())} ft` : '';
    const fc = g.forecastHr != null ? ` · +${esc(g.forecastHr)}h` : '';
    return `<div class="as-row${g.distanceNm === 0 ? ' as-over' : ''}" title="${esc(g.raw || g.label)}"><span class="cat cat-LIGHTING">G-AMET</span>
      <div><div class="txt">${esc(g.label)} · ${dist}</div><div class="when">${alt}${fc}</div></div></div>`;
  }).join('');
  return `<div class="notams">${wxRows}${convRows}${gaRows}</div>`;
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

// Compact, always-visible RAIM indicator for the card header. Green ✓ nominal,
// red ✗ predicted outage, grey ? when the NOTAM source is unavailable.
const RAIM_CHIP = {
  'PREDICTED OUTAGE': { txt: 'RAIM ✗', cls: 'raim-out' },
  'NO PREDICTED OUTAGE': { txt: 'RAIM ✓', cls: 'raim-ok' },
  UNKNOWN: { txt: 'RAIM ?', cls: 'raim-unk' },
};
function raimChipHtml(raim) {
  if (!raim) return '';
  const c = RAIM_CHIP[raim.status] || RAIM_CHIP.UNKNOWN;
  const win = (raim.windows || []).map((w) => (w.inlineRanges || []).map((r) => `${r.start}-${r.end}`).join(', ')).filter(Boolean).join(' · ');
  const tip = `GPS/RAIM: ${raim.status}.${win ? ` Window(s): ${win}.` : ''} ${raim.note || ''}`;
  return `<span class="raim-chip ${c.cls}" ${tipOf(tip)}>${c.txt}</span>`;
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
  push('airspace', 'Airspace / RAIM', (brief.airspace ? brief.airspace.tfrs.length + brief.airspace.sua.length : 0) || null, airspaceSection(brief));
  push('lowlevel', 'Low-Level', (brief.mtrs || []).length || null, mtrSection(brief));
  push('winds', 'Winds Aloft', null, windsAloftSection(brief));

  // On Departure, Recovery and Alternate cards, lead with TAF (forecast)
  // instead of NOTAMs.
  const role = brief.phase?.role;
  if (role === 'DEPARTURE' || role === 'RECOVERY' || role === 'ALTERNATE') {
    const i = panels.findIndex((p) => p.key === 'taf');
    if (i > 0) panels.unshift(panels.splice(i, 1)[0]);
  }

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
    if (m <= -60) { const h = Math.round(-m / 60); return `${h}h ago (past)`; }
    if (m <= 0) return 'now';
    const h = Math.floor(m / 60), mm = m % 60;
    return '+' + (h ? `${h}h${mm ? String(mm).padStart(2, '0') : ''}` : `${mm}m`);
  })();
  const cls = p.future ? 'phase-when future' : 'phase-when';
  const note = p.hideCurrentOnly
    ? '<div class="phase-caveat">Winds aloft, TAF, AHAS birds &amp; airspace are tailored to this time. Current METAR/PIREP/SIGMET shown elsewhere reflect now, not this phase.</div>'
    : '';
  return `<div class="${cls}">⏱ Planned ${zuluLocalHtml(p.when, { date: true })}${lead ? ` · ${esc(lead)}` : ''}</div>${note}`;
}

const CAT_COLOR = { VFR: '#3fb950', MVFR: '#4aa3df', IFR: '#f85149', LIFR: '#c77dff' };
const catColor = (c) => CAT_COLOR[c] || 'var(--text-dim)';
const fmtVisSm = (sm) => (sm == null ? null : sm >= 99 ? '6+ SM' : (sm % 1 ? sm.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : String(sm)) + ' SM');
const fmtFcWind = (w) => (!w ? '—' : `${w.dirTrue === 'VRB' ? 'VRB' : String(w.dirTrue).padStart(3, '0') + '°'}/${w.speedKt}${w.gustKt ? 'G' + w.gustKt : ''} kt`);

// "Forecast at ETA" — the TAF-at-phase-time wind/runway analysis + ceiling/vis
// vs minimums. Renders for any phase whose field has a TAF (even military fields
// with no current METAR), and is highlighted when it drives the status.
// NVG illumination block — sun/moon events, % illum + lunar position at the
// phase time, millilux + AFI 11-214 LOW/HIGH, and a cloud caveat. Computed.
const ILLUM_CLASS = { HIGH: 'b-illhigh', LOW: 'b-illlow' };
function nvgBlock(brief) {
  const n = brief.nvg;
  if (!n) return '';
  const ev = n.events || {};
  const z = (iso) => (iso ? zuluLocal(iso) : '—');
  const glare = glareShadowLine(brief);
  if (n.daylight) {
    return `<div class="illum-block daylight"><div class="il-h">🌙 NVG · ${brief.phase?.when ? zuluLocalHtml(brief.phase.when) : '—'}
      <span class="cat-chip">DAYLIGHT — illumination n/a</span></div>
      <div class="fc-line">Sun up (alt ${n.sunAltDeg}°). Sunset ${esc(z(ev.sunset))} · EENT ${esc(z(ev.eent))}.</div>${glare}</div>`;
  }
  const cls = n.illumClass === 'HIGH' ? 'b-illhigh' : 'b-illlow';
  const moon = n.moon || {};
  const moonState = moon.up
    ? `Alt <b>+${moon.altDeg}°</b> · Az ${moon.azDeg}° · disk ${Math.round((moon.fraction || 0) * 100)}% (${esc(moon.name || '')})`
    : `<b>below horizon</b> · disk ${Math.round((moon.fraction || 0) * 100)}% (does not contribute)`;
  const caveat = n.cloudCaveat
    ? `<div class="fc-caveat crit">⚠ BKN/OVC ceiling ${n.cloudCeilingFt ? n.cloudCeilingFt.toLocaleString() + ' ft' : ''} at this time — cloud cover reduces effective illumination below the clear-sky value.</div>`
    : '';
  return `<div class="illum-block ${cls}">
    <div class="il-h">🌙 Illumination · ${brief.phase?.when ? zuluLocalHtml(brief.phase.when) : '—'}
      <span class="cat-chip ${cls}" title="AFI 11-214: HIGH ≥ 2.2 mlx, LOW &lt; 2.2 mlx. Clear-sky ground illuminance, computed${n.source && n.source !== 'computed' ? ' (' + esc(n.source) + ')' : ''} — verify with USNO / mission brief.">${esc(n.illumClass)} ILLUM · ${n.illumMlx} mlx</span>
      <span class="fc-src">computed${n.source && n.source !== 'computed' ? ' · ' + esc(n.source) : ''}</span></div>
    <div class="il-grid">
      <div class="il-cell"><div class="k">Sun</div><div class="v">Set ${esc(z(ev.sunset))} · <b>EENT ${esc(z(ev.eent))}</b><br><small>BMNT ${esc(z(ev.bmnt))} · Rise ${esc(z(ev.sunrise))}</small></div></div>
      <div class="il-cell"><div class="k">Moon</div><div class="v">Rise ${esc(z(ev.moonrise))} · Set ${esc(z(ev.moonset))}</div></div>
      <div class="il-cell"><div class="k">Lunar position</div><div class="v">${moonState}</div></div>
      <div class="il-cell"><div class="k">Ground illum</div><div class="v"><b>${n.illumMlx} mlx</b> · ${esc(n.illumClass)}<br><small>clear-sky computed</small></div></div>
    </div>${glare}${caveat}</div>`;
}

const azDiff = (a, b) => { const d = Math.abs(a - b) % 360; return Math.round(d > 180 ? 360 - d : d); };

// Sun-glare (low sun near the approach course) and lunar geometry vs the
// recommended runway / NVG terrain-shadow note. Pure geometry off the computed
// sun/moon azimuth and the runway true heading — awareness only, not a limit.
function glareShadowLine(brief) {
  const n = brief.nvg;
  if (!n) return '';
  const a = brief.analysis;
  const rwyIdent = brief.recommendedRunway || (a && a.active && a.active.ident) || null;
  const rwy = a && rwyIdent ? (a.runways || []).find((r) => r.ident === rwyIdent) : null;
  const hdg = rwy && rwy.trueHeading != null ? rwy.trueHeading : null;
  const bits = [];
  // Sun glare: low sun (−3°..+12°) within ±30° of the approach course.
  if (n.sun && n.sun.altDeg > -3 && n.sun.altDeg < 12 && hdg != null) {
    const d = azDiff(n.sun.azDeg, hdg);
    if (d <= 30) bits.push(`☀ Sun-glare risk on approach RWY ${rwyIdent} — sun ${Math.round(n.sun.altDeg)}° up, ${d}° off the approach course`);
  }
  if (!n.daylight) {
    if (n.moon && n.moon.up) {
      let s = `🌙 Moon az ${n.moon.azDeg}° / alt +${n.moon.altDeg}°`;
      if (hdg != null) s += ` · ${azDiff(n.moon.azDeg, hdg)}° off RWY ${rwyIdent} approach`;
      if (n.moon.altDeg < 15) s += ' — low moon: long terrain shadows / uneven illumination';
      bits.push(s);
    } else if (n.moon) {
      bits.push('🌙 Moon below horizon — no lunar illumination; expect flat light / unlit terrain under NVG');
    }
  }
  return bits.length ? `<div class="glare-line">${bits.map(esc).join('<br>')}</div>` : '';
}

// Runway surface condition (FICON / RwyCC / RCR / braking action) from NOTAMs —
// winter/contamination ops. Shown only when a condition NOTAM is present.
function rwyCondBlock(brief) {
  const rc = brief.runwayConditions || [];
  if (!rc.length) return '';
  const rows = rc.map((c) => {
    const cls = c.severity === 'bad' ? 'rc-bad' : c.severity === 'ok' ? 'rc-ok' : 'rc-caution';
    const rwy = c.runway ? `RWY ${esc(c.runway)}` : 'RWY';
    return `<div class="rc-item ${cls}" title="${esc(c.raw)}"><span class="rc-ico">🧊</span> ${rwy}: <b>${esc(c.condition)}</b></div>`;
  }).join('');
  return `<div class="rwycond-block"><div class="rc-h">Runway condition (FICON/RCR) — from NOTAM; verify current</div>${rows}</div>`;
}

function forecastBlock(brief) {
  const f = brief.forecast;
  if (!f) return '';
  const drives = brief.statusSource === 'TAF@ETA';
  const cat = f.flightCategory ? `<span class="cat-chip" style="color:${catColor(f.flightCategory)};border-color:${catColor(f.flightCategory)}">${esc(f.flightCategory)}</span>` : '';
  const cv = [];
  if (f.ceilingFt != null) cv.push(`ceiling ${f.ceilingFt.toLocaleString()} ft`);
  if (f.visibilitySm != null) cv.push(`vis ${esc(fmtVisSm(f.visibilitySm))}`);
  const rwy = f.active ? ` · active RWY ${esc(f.recommendedRunway || f.active.ident)}` : '';
  const warns = [...(f.windWarnings || []), ...(f.cvWarnings || [])];
  const warnHtml = warns.length
    ? `<div class="warnings">${warns.map((w) => `<div class="warn-item ${/exceeds/.test(w) ? 'crit' : ''}"><span class="ico">⚠</span><span>${esc(w)}</span></div>`).join('')}</div>`
    : '';
  const caveatHtml = (f.caveats || []).length
    ? `<div class="fc-caveat">TEMPO/PROB: ${f.caveats.map((c) => esc(c.label) + (c.flightCategory ? ` (${esc(c.flightCategory)})` : '')).join(' · ')}</div>` : '';
  const validity = f.withinValidity === false
    ? '<div class="fc-caveat crit">⚠ Phase time is outside the TAF validity window — forecast not assured; verify with an updated TAF.</div>' : '';
  const when = brief.phase?.when ? zuluLocalHtml(brief.phase.when, { date: true }) : '';
  return `<div class="forecast-block ${drives ? 'is-source' : ''}">
    <div class="fc-h">Forecast at ETA ${when ? `<span class="fc-when">${when}</span>` : ''} ${cat}${drives ? '<span class="fc-src">drives status</span>' : ''}</div>
    <div class="fc-line">TAF: ${esc(fmtFcWind(f.wind))}${cv.length ? ' · ' + cv.join(' · ') : ''}${rwy}</div>
    ${validity}${caveatHtml}${warnHtml}</div>`;
}

function card(brief, limits, altRank) {
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
        ${brief.currentConditions?.flightCategory ? `<div class="metric"><div class="k">Cat (now)</div><div class="v" style="font-size:14px;color:${catColor(brief.currentConditions.flightCategory)}">${esc(brief.currentConditions.flightCategory)}</div>${(brief.currentConditions.ceilingFt != null || brief.currentConditions.visibilitySm != null) ? `<small class="ahas-when">${brief.currentConditions.ceilingFt != null ? brief.currentConditions.ceilingFt.toLocaleString() + ' ft' : ''}${brief.currentConditions.visibilitySm != null ? (brief.currentConditions.ceilingFt != null ? ' · ' : '') + esc(fmtVisSm(brief.currentConditions.visibilitySm)) : ''}</small>` : ''}</div>` : ''}
        ${brief.birdRisk ? `<div class="metric ${brief.birdRisk.level !== 'LOW' ? 'warn' : ''}" ${tipOf(birdRiskTip(brief.birdRisk))}><div class="k">AHAS Birds</div><div class="v" style="font-size:14px;color:${BIRD_COLOR[brief.birdRisk.level]}">${esc(brief.birdRisk.level)}</div>${birdRiskWhen(brief.birdRisk) ? `<small class="ahas-when">${esc(birdRiskWhen(brief.birdRisk))}</small>` : ''}</div>` : ''}
      </div>
      ${windBlock(brief, selRwy, limits)}
      ${a.active ? '<div class="rwys-cap">All runways — <b>tap any runway to compare its crosswind ↑</b></div>' : ''}
      <div class="rwys">${runwayRows(a, brief)}</div>
      ${warns}`;
  } else {
    body += `<div class="warn-item crit"><span class="ico">⚠</span><span>METAR unavailable — live weather source not reachable. Wind, runway, and density-altitude analysis are not shown (no data is fabricated).</span></div>`;
  }
  body += rwyCondBlock(brief);
  body += forecastBlock(brief);
  body += nvgBlock(brief);

  const ahasChip = brief.birdRisk
    ? `<span class="ahas-chip" style="color:${BIRD_COLOR[brief.birdRisk.level]};border-color:${BIRD_COLOR[brief.birdRisk.level]}" ${tipOf(birdRiskTip(brief.birdRisk))}>AHAS ${esc(brief.birdRisk.level)}</span>`
    : '';
  const raimChip = raimChipHtml(brief.airspace?.raim);
  const roleTag = PHASE_TAG[brief.phase?.role]
    ? `<span class="role-tag role-${esc(brief.phase.role.toLowerCase())}">${esc(PHASE_TAG[brief.phase.role])}</span>` : '';
  const rankBadge = altRank
    ? `<span class="alt-rank-badge ${altRank === 1 ? 'best' : ''}" title="Alternate ranking by forecast at ETA (status, then crosswind, then category)">${altRank === 1 ? '★ ' : ''}ALT #${altRank}</span>` : '';
  return `<div class="card" data-icao="${esc(ap.icao)}" data-uid="${esc(brief.uid || ap.icao)}">
    <div class="head">${roleTag}${rankBadge}<div><div class="icao">${esc(ap.icao)}</div><div class="name">${esc(ap.name)}</div></div>
      <div class="spacer"></div>${raimChip}${ahasChip}<div class="status-led ${statusClass}" ${tipOf(statusTip(brief))}>${esc(brief.status)}</div><span class="chev card-chev">▾</span></div>
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
// Render the airfield cards, split so the Departure card(s) sit directly under
// the map (with the Climb Winds tool + route cards beneath), and Recovery/
// "TAF amended and it got worse" banner — only shows when a NEWER TAF degraded
// a briefed phase since the previous brief (server-side watch).
function degradeBanner(data) {
  const ch = data.tafChanges || [];
  if (!ch.length) return '';
  const rows = ch.map((c) =>
    `<div class="warn-item crit"><span class="ico">⚠</span><span><b>TAF AMENDED — ${esc(c.icao)}</b> at ${esc(zuluLocal(c.when, { date: true }))}: ${esc(c.notes.join('; '))}. Re-check this phase.</span></div>`).join('');
  return `<div class="degrade-banner">${rows}</div>`;
}

// Ranked alternates strip (forecast at ETA): which alternate do I plan?
function altRankStrip(data) {
  const alts = data.alternates || [];
  if (alts.length < 2) return ''; // ranking only means something with options
  const item = (a) => {
    const cls = a.status === 'NO-GO' ? 'nogo' : a.status === 'CAUTION' ? 'caution' : 'go';
    const bits = [a.status, a.crosswindKt != null ? `XW ${a.crosswindKt}` : null, a.flightCategory].filter(Boolean).join(' · ');
    return `<span class="alt-rank ${cls}" title="${esc((a.reasons || []).join(' · ') || bits)} (${esc(a.source)})">#${a.rank} ${esc(a.icao)} <small>${esc(bits)}</small></span>`;
  };
  return `<div class="alt-rank-strip"><span class="alt-rank-lbl">Alternates at ETA (best first):</span>${alts.map(item).join('')}</div>`;
}

// Alternates go in the lower container. Returns { dep, rest } HTML.
function renderAirfields(data, limits) {
  if (!data.sortie) return { dep: degradeBanner(data) + `<div class="grid">${data.airfields.map((b) => card(b, limits)).join('')}</div>`, rest: '' };
  // Rank badge for alternate cards (#1 = plan this one).
  const rankByUid = new Map((data.alternates || []).map((a) => [a.uid, a.rank]));
  const groups = [];
  for (const b of data.airfields) {
    const role = b.phase?.role || 'FIELD';
    let g = groups[groups.length - 1];
    if (!g || g.role !== role) { g = { role, items: [] }; groups.push(g); }
    g.items.push(b);
  }
  const groupHtml = (g) => `<div class="phase-group"><div class="phase-group-h">${esc(PHASE_GROUP[g.role] || PHASE_GROUP.FIELD)}</div>
      ${g.role === 'ALTERNATE' ? altRankStrip(data) : ''}
      <div class="grid">${g.items.map((b) => card(b, limits, rankByUid.get(b.uid))).join('')}</div></div>`;
  const isDep = (g) => g.role === 'DEPARTURE' || g.role === 'FIELD';
  return {
    dep: degradeBanner(data) + groups.filter(isDep).map(groupHtml).join(''),
    rest: groups.filter((g) => !isDep(g)).map(groupHtml).join(''),
  };
}

// Shared fetch + render for both the quick brief and the structured sortie.
async function runBrief({ ids, limits, extra = {}, button }) {
  const params = new URLSearchParams({
    ids: ids.join(','), xwind: limits.xwind, tailwind: limits.tailwind, highda: limits.highda,
  });
  const agls = val('agls').replace(/\s+/g, '');
  if (agls) params.set('agls', agls);
  if ($('nvg-mode')?.checked) params.set('nvg', '1'); // NVG sortie -> illumination
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);

  if (button) $(button).disabled = true;
  $('results').innerHTML = `<div class="loading"><div class="spinner"></div>Pulling weather &amp; NOTAMs…</div>`;
  if ($('results-rest')) $('results-rest').innerHTML = '';
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
    const r = renderAirfields(data, limits);
    $('results').innerHTML = r.dep || '<div class="empty">No departure field.</div>';
    if ($('results-rest')) $('results-rest').innerHTML = r.rest;
    updatePrintHead(data, ids, limits);
    renderMap(data);
    renderRibbon(data, activeRoutes, limits);
    return data;
  } catch (err) {
    $('results').innerHTML = `<div class="errbox">Failed to build brief: ${esc(err.message)}<br/>
      <span style="color:var(--text-dim);font-size:12px">Is the server running?</span></div>`;
    if ($('results-rest')) $('results-rest').innerHTML = '';
    return null;
  } finally {
    if (button) $(button).disabled = false;
  }
}

// Current Zulu (UTC) wall time as a datetime-local input value
// (YYYY-MM-DDTHH:mm). The field has no timezone, so we show the UTC digits and
// treat what the user types as Zulu (see zuluToIso).
const TIME_PREFIXES = ['sp-dep', 'sp-ar', 'sp-ll', 'sp-rec'];

// AR tracks + low-level routes, each id paired with ITS OWN entry time as
// "ID@ISO" (AR at the A/R time, IR/VR/SR at the low-level time) — so every
// route's AHAS/winds are evaluated at the time it's actually flown.
function routeTokens() {
  const arT = zuluToIso('sp-ar');
  const llT = zuluToIso('sp-ll');
  return [
    ...splitIds(val('sp-ar')).map((id) => ({ id, when: arT || null })),
    ...splitIds(val('sp-ll')).map((id) => ({ id, when: llT || null })),
  ];
}
const routeTokensParam = () => routeTokens().map((r) => (r.when ? `${r.id}@${r.when}` : r.id)).join(',');

// Default every empty phase time to "now" in Zulu (date + 24-hour HHMM) so phases
// start from the current Zulu date/time without the user having to type it.
function prefillDatetimes() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const hhmm = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  for (const pre of TIME_PREFIXES) {
    const de = $(`${pre}-d`), te = $(`${pre}-hhmm`);
    if (de && !de.value) de.value = date;
    if (te && !te.value) te.value = hhmm;
  }
}

// Normalize a 24-hour military time field to HHMM: 1–2 digits = whole hour
// (8 → 0800), 3–4 digits = H(H)MM (830 → 0830), clamped to 23:59.
function normalizeHhmm(el) {
  if (!el) return;
  let s = (el.value || '').replace(/\D/g, '').slice(0, 4);
  if (!s) { el.value = ''; return; }
  s = s.length <= 2 ? s.padStart(2, '0') + '00' : s.padStart(4, '0');
  const hh = Math.min(23, Number(s.slice(0, 2)));
  const mm = Math.min(59, Number(s.slice(2, 4)));
  el.value = String(hh).padStart(2, '0') + String(mm).padStart(2, '0');
}

// Combine a phase's Zulu date (YYYY-MM-DD) + 24-hour HHMM into an ISO instant,
// pinning the entered wall time to UTC. '' when blank/invalid.
function zuluToIso(prefix) {
  const date = val(`${prefix}-d`);
  const hhmmRaw = (val(`${prefix}-hhmm`) || '').replace(/\D/g, '');
  if (!date || !hhmmRaw) return '';
  const hhmm = hhmmRaw.length <= 2 ? hhmmRaw.padStart(2, '0') + '00' : hhmmRaw.padStart(4, '0');
  const hh = Number(hhmm.slice(0, 2)), mm = Number(hhmm.slice(2, 4));
  if (hh > 23 || mm > 59) return '';
  const d = new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
const splitIds = (s) => String(s || '').split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);

// All sortie bases (departure, recovery, alternates) as the refcard `fields`
// param: "ICAO@ISO@Label" pipe-separated, each at its own Zulu time (alternates
// inherit the landing time).
function refFieldsParam() {
  const depT = zuluToIso('sp-dep');
  const recT = zuluToIso('sp-rec');
  const out = [];
  const dep = splitIds(val('sp-dep'))[0]; if (dep) out.push(`${dep}@${depT}@Departure`);
  const rec = splitIds(val('sp-rec'))[0]; if (rec) out.push(`${rec}@${recT}@Recovery`);
  for (const a of splitIds(val('sp-alt'))) out.push(`${a}@${recT}@Alternate`);
  return out.join('|');
}

// Quick-links toolbar: server-rendered references for EVERY sortie base
// (departure + recovery + alternates) plus the low-level/AR routes. The official
// SPAs can't be deep-linked, so rendering ourselves guarantees the NOTAMs +
// decoded TAF + 12-hr AHAS actually show. Build PDF combines all of it.
function quickLinkUrls() {
  const fields = encodeURIComponent(refFieldsParam());
  const toks = routeTokensParam();
  const routes = toks ? `&routes=${encodeURIComponent(toks)}` : '';
  const rwhen = ''; // per-route times ride in the routes tokens (ID@ISO)
  return {
    'ql-daip': { href: `/api/refcard?fields=${fields}&only=notams`, title: 'DAIP NOTAMs - all sortie bases' },
    'ql-awc': { href: `/api/refcard?fields=${fields}&only=wx`, title: 'METAR + decoded TAF - all sortie bases' },
    'ql-ahas': { href: `/api/refcard?fields=${fields}&only=ahas${routes}${rwhen}`, title: 'AHAS 12-hr - all sortie bases + routes' },
    'ql-build': { href: `/api/refcard?fields=${fields}${routes}${rwhen}&print=1`, title: 'Combined NOTAMs + weather + AHAS for all bases + routes - save as PDF' },
  };
}
function updateQuickLinks() {
  for (const [linkId, { href, title }] of Object.entries(quickLinkUrls())) {
    const el = $(linkId);
    if (el) { el.href = href; el.title = title; } // label text left as-is (short)
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
  const arRoutes = splitIds(val('sp-ar'));
  const llRoutes = splitIds(val('sp-ll'));
  const depT = zuluToIso('sp-dep');
  const recT = zuluToIso('sp-rec');
  const arT = zuluToIso('sp-ar');
  const llT = zuluToIso('sp-ll');

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

  // Sortie timeline runs in parallel with the brief (same stops/routes/limits).
  // Routes carry their own entry time (AR at A/R time, IR/VR at low-level time).
  const lim = readLimits();
  const tlParams = new URLSearchParams({ stops: stopsParam });
  const toks = routeTokensParam();
  if (toks) tlParams.set('routes', toks);
  if (lim.xwind) tlParams.set('xwind', lim.xwind);
  if (lim.tailwind) tlParams.set('tailwind', lim.tailwind);
  if ($('nvg-mode')?.checked) tlParams.set('nvg', '1');
  fetchTimeline(tlParams);

  // Look up AR tracks at the A/R entry time and low-level routes at the
  // low-level entry time — separate lookups so each group's per-leg winds and
  // AHAS are evaluated at the time it's actually flown.
  activeRoutes = [];
  windsPoints = []; // climb-winds overlay is re-added when the user runs that tool
  if (arRoutes.length) await lookupRoutes(arRoutes, arT, { scroll: false });
  if (llRoutes.length) await lookupRoutes(llRoutes, llT, { scroll: false });
  if (!arRoutes.length && !llRoutes.length) renderRouteResults();
  await runBrief({ ids, limits: lim, extra: { stops: stopsParam }, button: 'go' });
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

async function getRouteWinds() {
  const pts = $('winds-points').value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!pts.length) return;
  const params = new URLSearchParams({ points: pts.join(',') });
  // Bias navaid resolution toward the briefed field so non-unique navaid idents
  // resolve to the nearby one (not a far IATA/foreign duplicate).
  const ref = (lastBriefData?.airfields || []).find((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon));
  if (ref) params.set('near', `${ref.lat},${ref.lon}`);
  $('winds-go').disabled = true;
  $('winds-results').innerHTML = `<div class="loading"><div class="spinner"></div>Fetching winds aloft…</div>`;
  try {
    const res = await fetch(`/api/winds?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    $('winds-results').innerHTML = `<div class="grid">${data.points.map(windsProfileCard).join('')}</div>`;
    // Overlay the winds points ON TOP of the brief map (airfields + routes +
    // radar), not as a replacement — paintMap() merges windsPoints.
    windsPoints = data.points.filter((p) => p.found).map((p) => ({
      icao: p.id, lat: p.lat, lon: p.lon,
      type: p.kind || 'navaid', // 'airport' | 'VOR' | 'TACAN' | 'navaid' | ...
      status: (p.hazards || []).some((h) => h.hazard === 'CONVECTIVE') ? 'CAUTION' : 'GO',
    }));
    paintMap();
  } catch (err) {
    $('winds-results').innerHTML = `<div class="errbox">Failed: ${esc(err.message)}</div>`;
  } finally {
    $('winds-go').disabled = false;
  }
}

// ---- Route of flight (planning section) ------------------------------------
async function drawRouteOfFlight() {
  const routeStr = ($('rof').value || '').trim();
  const status = $('rof-status');
  if (!routeStr) { routeOfFlight = null; if (status) status.innerHTML = ''; paintMap(); return; }
  if (status) status.innerHTML = '<span class="rof-load">Resolving route…</span>';
  try {
    const params = new URLSearchParams({ route: routeStr });
    const ref = (lastBriefData?.airfields || []).find((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon));
    if (ref) params.set('near', `${ref.lat},${ref.lon}`);
    const res = await fetch(`/api/route?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    routeOfFlight = (data.points && data.points.length) ? data : null;
    paintMap();
    if (status) {
      const n = data.points?.length || 0;
      const unres = (data.unresolved || []);
      let msg = n ? `<span class="rof-ok">${n} point${n === 1 ? '' : 's'} · ${data.totalNm} NM</span>` : '<span class="rof-warn">No points resolved.</span>';
      if (unres.length) msg += ` <span class="rof-warn">Unresolved: ${unres.map((u) => `${esc(u.token)}${u.note ? ` (${esc(u.note)})` : ''}`).join(', ')}</span>`;
      status.innerHTML = msg;
    }
  } catch (err) {
    if (status) status.innerHTML = `<span class="rof-warn">Failed: ${esc(err.message)}</span>`;
  }
}
function clearRouteOfFlight() {
  routeOfFlight = null;
  const el = $('rof'); if (el) el.value = '';
  const status = $('rof-status'); if (status) status.innerHTML = '';
  paintMap();
}

// ---- Mission hazard ribbon (the sortie as flown: dep → AR → LL → rec → alt) --
// Pure model in ./ribbon.js (shared with the tests); this is just the render.
function renderRibbon(data, routes, limits) {
  const el = $('sec-ribbon');
  if (!el) return;
  if (!data || !(data.airfields || []).length) { el.hidden = true; el.innerHTML = ''; return; }
  const whens = { arWhen: zuluToIso('sp-ar') || null, llWhen: zuluToIso('sp-ll') || null };
  const phases = buildRibbonModel(data, routes, limits, whens);
  if (!phases.length) { el.hidden = true; el.innerHTML = ''; return; }

  const STAT = { 'GO': 'rb-go', 'CAUTION': 'rb-caution', 'NO-GO': 'rb-nogo', 'NO-DATA': 'rb-na' };
  const seg = (p, i) => {
    const roleTag = rbRoleTag(p.role);
    const clear = p.status === 'GO' && !p.chips.some((c) => c.sev === 'caution' || c.sev === 'nogo');
    const chips = p.chips.map((c) => {
      const cls = `rb-chip sev-${c.sev}`;
      const title = c.tip ? ` title="${esc(c.tip)}"` : '';
      // Chips with a source link become anchors (open the authoritative product).
      return c.href
        ? `<a class="${cls} rb-chip-link" href="${esc(c.href)}" target="_blank" rel="noopener"${title}>${esc(c.k)} ↗</a>`
        : `<span class="${cls}"${title}>${esc(c.k)}</span>`;
    }).join('');
    const when = p.when ? zuluLocal(p.when) : '';
    return `${i ? '<div class="rb-arrow">▸</div>' : ''}
      <div class="rb-phase ${STAT[p.status] || 'rb-na'}" title="${esc(`${roleTag} ${p.id} ${when} · ${p.status}${p.reason ? ' — ' + p.reason : ''} · ${p.source}`)}">
        <div class="rb-top"><span class="rb-role">${esc(roleTag)}</span>${clear ? '<span class="rb-clear">✓ clear</span>' : ''}</div>
        <div class="rb-id">${esc(p.id)}</div>
        <div class="rb-time">${esc(when)}</div>
        <div class="rb-chips">${chips}</div>
      </div>`;
  };

  const bad = phases.filter((p) => p.status === 'NO-GO').length;
  const caut = phases.filter((p) => p.status === 'CAUTION').length;
  const summary = bad ? `<span class="rb-sum nogo">${bad} phase${bad > 1 ? 's' : ''} NO-GO</span>`
    : caut ? `<span class="rb-sum caution">${caut} phase${caut > 1 ? 's' : ''} CAUTION</span>`
    : '<span class="rb-sum go">All phases GO</span>';

  el.innerHTML = `
    <div class="tool-head"><span class="tool-title">Mission Hazard Ribbon</span> ${summary}
      <span class="rb-note">the sortie as flown · forecast at each phase time</span></div>
    <div class="rb-track">${phases.map(seg).join('')}</div>
    <div class="rb-foot">Per-phase worst-case from the same engine as the cards (wind/runway, ceiling-vis vs your minimums, AHAS birds, convective/SIGMET when representative). “CONV n/a” = convective-along-route not yet assessed. Verify with official sources.</div>
    ${nvgTrendStrip(data.nvgTrend, phases)}`;
  el.hidden = false;
}

// NVG illumination trend sparkline: clear-sky ground illuminance (log mlx) across
// the sortie window, with day/twilight/night band shading and the AFI 11-214
// 2.2 mlx LOW/HIGH threshold line. Computed astronomy — verify with official src.
const BAND_FILL = { day: 'rgba(210,153,34,0.20)', twilight: 'rgba(120,130,170,0.22)', night: 'rgba(20,28,52,0.55)' };
function nvgTrendStrip(trend, phases) {
  if (!trend || !Array.isArray(trend.points) || trend.points.length < 2) return '';
  const W = 600, H = 64, padL = 4, padR = 4, padT = 6, padB = 14;
  const from = Date.parse(trend.from), to = Date.parse(trend.to), span = to - from || 1;
  const x = (iso) => padL + ((Date.parse(iso) - from) / span) * (W - padL - padR);
  // log10(mlx) clamped to [0.05 .. 200] mlx -> [-1.3 .. 2.3].
  const lo = -1.3, hi = 2.3;
  const y = (mlx) => {
    const v = Math.max(lo, Math.min(hi, Math.log10(Math.max(mlx, 0.05))));
    return padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  };
  const pts = trend.points;
  const bandName = { day: 'Daylight', twilight: 'Twilight', night: 'Night' };
  // Band shading rects between consecutive samples — each with a hover tooltip
  // (<title>) naming the band, time and the illuminance at that point.
  const bands = pts.slice(0, -1).map((p, i) => {
    const x0 = x(p.t), x1 = x(pts[i + 1].t);
    const tip = `${zuluLocal(p.t)} · ${bandName[p.band] || p.band} · ${p.mlx} mlx ${p.class}${p.moonUp ? ' · moon up' : ''}`;
    return `<rect x="${x0.toFixed(1)}" y="${padT}" width="${(x1 - x0 + 0.5).toFixed(1)}" height="${H - padT - padB}" fill="${BAND_FILL[p.band] || 'none'}"><title>${esc(tip)}</title></rect>`;
  }).join('');
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.mlx).toFixed(1)}`).join(' ');
  const thrY = y(2.2).toFixed(1);
  // Phase-time markers (D/A/L etc.) along the axis.
  const marks = (phases || []).filter((p) => p.when && Date.parse(p.when) >= from && Date.parse(p.when) <= to)
    .map((p) => `<line x1="${x(p.when).toFixed(1)}" y1="${padT}" x2="${x(p.when).toFixed(1)}" y2="${H - padB}" class="nt-mark"/>
      <text x="${x(p.when).toFixed(1)}" y="${H - 3}" class="nt-mtext">${esc(rbRoleTag(p.role)[0])}<title>${esc(`${rbRoleTag(p.role)} ${p.id} ${zuluLocal(p.when)}`)}</title></text>`).join('');
  const lg = (sw, txt) => `<span class="nt-li">${sw} ${esc(txt)}</span>`;
  return `<div class="nvg-trend">
    <div class="nt-h">🌙 Illumination trend <small>${esc(trend.icao)} · clear-sky ground illuminance over the sortie · computed — hover for values</small></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="nt-svg" role="img" aria-label="Illumination trend across the sortie">
      ${bands}
      <line x1="${padL}" y1="${thrY}" x2="${W - padR}" y2="${thrY}" class="nt-thr"><title>2.2 mlx — AFI 11-214 LOW/HIGH boundary</title></line>
      <path d="${line}" class="nt-line"><title>Ground illuminance (clear-sky), log scale</title></path>
      ${marks}
    </svg>
    <div class="nt-legend">
      ${lg('<i class="nt-sw nt-day"></i>', 'Daylight')}
      ${lg('<i class="nt-sw nt-twi"></i>', 'Twilight')}
      ${lg('<i class="nt-sw nt-night"></i>', 'Night')}
      ${lg('<i class="nt-swline"></i>', 'Illuminance (mlx, log scale ↑)')}
      ${lg('<i class="nt-swdash"></i>', '2.2 mlx — LOW / HIGH (AFI 11-214)')}
      ${lg('<b class="nt-swmark">D</b>', 'phase time')}
    </div>
  </div>`;
}

// ---- Sortie timeline (hour-by-hour conditions per field across the window) --
const TL_STATUS_CLASS = { 'GO': 'tl-go', 'CAUTION': 'tl-caution', 'NO-GO': 'tl-nogo' };
const TL_BIRD_CLASS = { LOW: 'tl-go', MODERATE: 'tl-caution', SEVERE: 'tl-nogo' };
let timelineData = null;

function tlCellTip(c) {
  if (!c.source) return `${zuluLocal(c.t)} — UNAVAILABLE (no METAR/TAF speaks to this hour; nothing fabricated)`;
  const bits = [`${zuluLocal(c.t)} · ${c.source}`];
  if (c.wind) bits.push(`${c.wind.dirTrue === 'VRB' ? 'VRB' : String(c.wind.dirTrue).padStart(3, '0') + '°'}/${c.wind.speedKt}${c.wind.gustKt ? 'G' + c.wind.gustKt : ''} kt`);
  if (c.active) bits.push(`RWY ${c.active} XW ${c.gustCrosswindKt ?? c.crosswindKt} kt`);
  if (c.cat) bits.push(c.cat);
  if (c.bird) bits.push(`birds ${c.bird}`);
  if (c.warn) bits.push(`⚠ ${c.warn}`);
  if (c.caveat) bits.push(c.caveat);
  return bits.join(' · ');
}

function renderTimeline(tl) {
  timelineData = tl;
  const el = $('sec-timeline');
  if (!el) return;
  if (!tl || !tl.fields?.length) { el.hidden = true; el.innerHTML = ''; return; }
  const hours = tl.window.hours;
  const nowKey = (tl.now || '').slice(0, 13);
  // Columns can be >1h apart on a long sortie; place markers in the BUCKET that
  // contains the phase time (the last column whose start <= the phase time), not
  // an exact-hour match, so D/R/A/E never fall off the grid.
  const hourMs = hours.map((h) => Date.parse(h));
  const stepH = hourMs.length > 1 ? Math.round((hourMs[1] - hourMs[0]) / 3600000) : 1;
  const hourLbl = (iso) => `${iso.slice(11, 13)}Z`;
  const colIndexFor = (whenIso) => {
    const w = Date.parse(whenIso);
    if (!Number.isFinite(w)) return -1;
    let idx = -1;
    for (let i = 0; i < hourMs.length; i++) { if (hourMs[i] <= w) idx = i; else break; }
    return idx;
  };

  const head = `<div class="tl-row tl-hours"><div class="tl-lbl">Zulu →</div>${hours.map((h) =>
    `<div class="tl-h ${h.slice(0, 13) === nowKey ? 'tl-now' : ''}">${hourLbl(h)}</div>`).join('')}</div>`;

  const fieldRows = tl.fields.map((f, fi) => {
    const markByCol = {};
    for (const r of (f.roles || [])) {
      const ci = colIndexFor(r.when);
      if (ci >= 0) (markByCol[ci] ||= []).push(r);
    }
    const cells = f.cells.map((c, ci) => {
      const hits = markByCol[ci];
      const mark = hits ? `<span class="tl-mark" title="${esc(hits.map((r) => `${r.label} ${zuluLocal(r.when)}`).join(' · '))}">${esc(hits.map((r) => (r.role || 'F')[0]).join(''))}</span>` : '';
      return `<div class="tl-c ${c.status ? TL_STATUS_CLASS[c.status] : 'tl-na'} ${c.t.slice(0, 13) === nowKey ? 'tl-now' : ''}" data-tl="${fi},${ci}" title="${esc(tlCellTip(c))}">${mark}</div>`;
    }).join('');
    const roleTxt = (f.roles || []).map((r) => r.role[0]).join('/');
    let row = `<div class="tl-row"><div class="tl-lbl">${esc(f.icao)} <small>${esc(roleTxt)}</small></div>${cells}</div>`;
    // NVG illumination band row (only when the brief was built in NVG mode).
    if (tl.nvg && Array.isArray(f.illum)) {
      const ic = f.illum.map((g) => {
        if (!g || !g.band) return '<div class="tl-c tl-na"></div>';
        const cl = g.band === 'day' ? 'tl-day' : g.band === 'twilight' ? 'tl-twi' : (g.class === 'HIGH' ? 'tl-nh' : 'tl-nl');
        const ch = g.band === 'day' ? '☀' : g.band === 'twilight' ? 't' : (g.class === 'HIGH' ? 'H' : 'L');
        const tip = g.band === 'day' ? `${zuluLocal(g.t)} · daylight` : `${zuluLocal(g.t)} · ${g.band} · ${g.mlx} mlx ${g.class}${g.moonUp ? ' · moon up' : ''}`;
        return `<div class="tl-c ${cl}" title="${esc(tip)}">${ch}</div>`;
      }).join('');
      row += `<div class="tl-row"><div class="tl-lbl tl-illum-lbl">ILLUM <small>${esc(f.icao)}</small></div>${ic}</div>`;
    }
    return row;
  }).join('');

  const routeRows = (tl.routes || []).map((r) => {
    const entryCol = colIndexFor(r.when);
    // AR refueling tracks: AHAS (bird) doesn't apply — show the entry marker only,
    // with a muted "n/a" note instead of UNAVAILABLE bird cells.
    if (r.ahas === false) {
      const cells = r.cells.map((c, ci) =>
        `<div class="tl-c tl-na" title="${esc(zuluLocal(c.t))} · AHAS n/a (AR track)">${ci === entryCol ? '<span class="tl-mark" title="Route entry time">E</span>' : ''}</div>`).join('');
      return `<div class="tl-row"><div class="tl-lbl">${esc(r.id)} <small>AHAS n/a</small></div>${cells}</div>`;
    }
    const cells = r.cells.map((c, ci) =>
      `<div class="tl-c ${c.bird ? TL_BIRD_CLASS[c.bird] : 'tl-na'}" title="${esc(zuluLocal(c.t))} · AHAS bird risk ${esc(c.bird || 'UNAVAILABLE')}">${ci === entryCol ? '<span class="tl-mark" title="Route entry time">E</span>' : (c.bird ? `<span class="tl-bird">${esc(c.bird[0])}</span>` : '')}</div>`).join('');
    return `<div class="tl-row"><div class="tl-lbl">${esc(r.id)} <small>birds</small></div>${cells}</div>`;
  }).join('');

  const demo = tl.demo ? `<span class="tl-demo" title="${esc(tl.demoNote || 'Fixture data')}">${esc(tl.demo)} DEMO — fixture data, not live</span>` : '';
  el.innerHTML = `
    <div class="tool-head"><span class="tool-title">Sortie Timeline</span> ${demo}
      ${stepH > 1 ? `<span class="tl-demo" title="Long sortie — columns are ${stepH}-hourly so the full window through landing always fits">${stepH}-hourly</span>` : ''}
      <span class="tl-range">${zuluLocalHtml(hours[0], { date: true })} – ${zuluLocalHtml(hours[hours.length - 1])}</span></div>
    <div class="tl-grid" style="--tlcols:${hours.length}">${head}${fieldRows}${routeRows}</div>
    <div class="tl-legend">
      <span class="tl-leg-h">Cell color — that hour's call:</span>
      <span><i class="tl-sw tl-go"></i>GO</span><span><i class="tl-sw tl-caution"></i>CAUTION</span>
      <span><i class="tl-sw tl-nogo"></i>NO-GO</span><span><i class="tl-sw tl-na"></i>no data for that hour (nothing fabricated)</span>
    </div>
    <div class="tl-legend">
      <span class="tl-leg-h">Markers:</span>
      <span><b class="tl-mark">D</b> Departure</span><span><b class="tl-mark">R</b> Recovery</span>
      <span><b class="tl-mark">A</b> Alternate ETA</span><span><b class="tl-mark">E</b> Route entry</span>
      <span><i class="tl-sw tl-nowleg"></i> outlined column = now</span>
      <span>route rows: <b>L/M/S</b> = AHAS bird risk Low / Moderate / Severe</span>
    </div>
    ${tl.nvg ? `<div class="tl-legend">
      <span class="tl-leg-h">ILLUM row (NVG) — computed illumination band:</span>
      <span><i class="tl-sw tl-day"></i>☀ daylight</span><span><i class="tl-sw tl-twi"></i>t twilight</span>
      <span><i class="tl-sw tl-nh"></i>H night HIGH (≥2.2 mlx)</span><span><i class="tl-sw tl-nl"></i>L night LOW (0–2.1 mlx)</span>
      <span class="tl-note">AFI 11-214 thresholds · astronomy-derived — verify with official sources.</span>
    </div>` : ''}
    <div class="tl-legend"><span class="tl-note">Each field row re-runs the wind/runway + ceiling-vis checks for every hour — from the current METAR near now, from the TAF period valid at that hour further out. Tap any cell for the full detail.</span></div>
    <div id="tl-detail" class="tl-detail"></div>`;
  el.hidden = false;
}

async function fetchTimeline(params) {
  try {
    const res = await fetch(`/api/timeline?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderTimeline(await res.json());
  } catch {
    const el = $('sec-timeline');
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }
}

function onTimelineClick(e) {
  const cell = e.target.closest('[data-tl]');
  if (!cell || !timelineData) return;
  const [fi, ci] = cell.dataset.tl.split(',').map(Number);
  const f = timelineData.fields[fi];
  const c = f?.cells[ci];
  const det = $('tl-detail');
  if (det && c) det.innerHTML = `<b>${esc(f.icao)}</b> — ${esc(tlCellTip(c))}`;
}

// ---- MTR (low-level route) lookup tool -------------------------------------
function mtrDetailCard(d) {
  const segs = d.segments.map((s) => {
    const alt = s.altText || (s.floorFt != null ? `${s.floorFt.toLocaleString()}–${(s.ceilingFt ?? 0).toLocaleString()} ${s.agl ? 'AGL' : 'MSL'}` : '—');
    const wd = s.widthLeftNm != null ? ` · ${s.widthLeftNm}/${s.widthRightNm} NM` : '';
    const w = s.wind;
    const temp = w && w.tempC != null ? ` · ${w.tempC > 0 ? '+' : ''}${w.tempC}°C` : '';
    const wind = w
      ? `${String(w.dirTrue).padStart(3, '0')}/${w.speedKt} → HW ${w.headwindKt} · XW ${w.crosswindKt}${w.crosswindSide !== 'none' ? ' ' + w.crosswindSide[0].toUpperCase() : ''}${temp}`
      : '—';
    const xwHi = w && Math.abs(w.crosswindKt) >= 20;
    const ice = s.icing
      ? `<span class="mtr-ice ice-${esc(s.icing.severity.toLowerCase())}" title="Structural icing potential at the block altitude (${s.icing.tempC}°C${s.icing.rhPct != null ? `, RH ${s.icing.rhPct}%` : ''}) — temp/RH-based, needs visible moisture">ICE ${esc(s.icing.severity)}</span>`
      : '';
    return `<div class="mtr-seg">
      <div class="mtr-seg-h">${esc(s.name)} <span class="rwy-len">${esc(s.lengthNm)} NM · brg ${s.bearing != null ? String(s.bearing).padStart(3, '0') + '°' : '—'} · ${esc(alt)}${esc(wd)}</span> ${ice}${d.ahasApplies ? birdBadge(s.birdRisk) : ''}</div>
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
  // AHAS is a low-level bird/wildlife product — it does NOT apply to AR tracks.
  const routeBird = d.ahasApplies === false
    ? '<div class="mtr-bird" style="color:var(--text-faint)">AHAS bird risk: n/a — air-refueling track (AHAS is a low-level product; no published bird route)</div>'
    : bv
      ? `<div class="mtr-bird" style="color:${BIRD_COLOR[bv.level]}">⚠ AHAS bird risk: <b>${esc(bv.level)}</b> — ${esc(bv.note || '')}</div>${ahasWhen}`
      : (d.windsAt
          ? `<div class="mtr-bird" style="color:var(--text-dim)">AHAS bird risk: UNAVAILABLE — no data returned for route entry ${esc(zuluLocal(d.windsAt, { date: true }))} (nothing fabricated)</div>`
          : '');
  const wxHaz = routeWxBlock(d);
  const refuel = d.refuelAlt ? `<div class="mtr-bird" style="color:var(--accent)">⛽ Refueling altitude: <b>${esc(d.refuelAlt)}</b> — leg winds below are at this block</div>` : '';
  // Available turn points + the flown portion (entry/exit). Lets users see what
  // they can fly and how to request a portion (e.g. IR-154.C-M).
  const pts = Array.isArray(d.points) && d.points.length ? d.points : null;
  const portionLine = pts
    ? `<div class="mtr-points">Turn points: <span class="mtr-pts">${pts.map(esc).join(' ')}</span>` +
      (d.portion
        ? ` · <b>flying ${esc(d.entry)}→${esc(d.exit)}</b>`
        : ` · fly a portion with <code>${esc(d.id)}.${esc(pts[0])}-${esc(pts[pts.length - 1])}</code>`) +
      `</div>`
    : '';
  return `<div class="card"><div class="head">
      <div><div class="icao">${esc(d.id)}${d.portion ? ` <span class="mtr-portion">${esc(d.portion)}</span>` : ''}</div><div class="name">${esc(d.type)} · ${esc(d.name)}${d.agency ? ' · ' + esc(d.agency) : ''}</div></div>
      <div class="spacer"></div>${d.ahasApplies && d.birdRisk ? birdBadge(d.birdRisk.level) : ''}<span class="chev card-chev">▾</span></div>
    <div class="body">${refuel}${wxHaz}${routeBird}${portionLine}<div class="mtr-segs">${segs}</div></div></div>`;
}

// Convective/SIGMET-along-route + worst icing for a route detail card. Honest:
// "n/a" when the live check didn't run (offline / no geometry). Hazards link to
// the authoritative product (AWC SIGMET viewer / SPC outlook).
function routeWxBlock(d) {
  const rows = [];
  if (d.icing) {
    rows.push(`<div class="mtr-wx ice-${esc(d.icing.severity.toLowerCase())}">❄ Icing <b>${esc(d.icing.severity)}</b> at block — ${d.icing.tempC}°C${d.icing.rhPct != null ? ` · RH ${d.icing.rhPct}%` : ''} <small>(temp/RH-based; needs visible moisture)</small></div>`);
  }
  if (d.routeWxChecked) {
    const sig = d.hazardWx || [], conv = d.convective || [];
    for (const h of sig.slice(0, 3)) {
      const crit = h.hazard === 'CONVECTIVE' ? ' crit' : '';
      rows.push(`<div class="mtr-wx${crit}">⚠ <a href="${esc(AWC_SIGMET_URL)}" target="_blank" rel="noopener" title="${esc(sigTip(h) || '')}">${esc(h.type)}${h.hazard ? ' ' + esc(h.hazard) : ''} · ${esc(h.distanceNm)} NM from route ↗</a></div>`);
    }
    for (const c of conv.slice(0, 2)) {
      rows.push(`<div class="mtr-wx">⛈ <a href="${esc(SPC_OUTLOOK_URL)}" target="_blank" rel="noopener" title="SPC convective outlook ${esc(c.label || c.risk)}">Convective outlook ${esc(c.risk)} · ${esc(c.distanceNm)} NM from route ↗</a></div>`);
    }
    const pir = d.pireps || [];
    for (const p of pir.slice(0, 4)) {
      const crit = p.urgent ? ' crit' : '';
      const fl = p.altFt != null ? ` · FL${Math.round(p.altFt / 100)}` : '';
      rows.push(`<div class="mtr-wx${crit}">✈ <a href="${esc(AWC_PIREP_URL)}" target="_blank" rel="noopener" title="${esc(pirepTip(p) || '')}">PIREP ${esc(pirepKind(p))}${esc(fl)} · ${esc(p.distanceNm)} NM from route ↗</a></div>`);
    }
    if (!sig.length && !conv.length && !pir.length) rows.push('<div class="mtr-wx ok">✓ No convective/SIGMET/PIREP within range of the route path</div>');
  } else if (!d.icing) {
    rows.push('<div class="mtr-wx" style="color:var(--text-faint)">Convective/SIGMET along route: not assessed (offline)</div>');
  }
  return rows.length ? `<div class="mtr-wxblock">${rows.join('')}</div>` : '';
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

// ---- Global / strategic route view -----------------------------------------
// A second tab sharing the weather/winds/astro/airfield engine, but with a
// leg-and-track model (great-circle legs, wind-corrected ETAs) instead of the
// local phase model. Reuses card() for each stop's brief.
function setMode(mode) {
  const views = { local: 'local-view', global: 'global-view', hubs: 'hubs-view', oceanic: 'oceanic-view' };
  for (const [m, id] of Object.entries(views)) { const el = $(id); if (el) el.hidden = mode !== m; }
  document.querySelectorAll('#tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === mode));
  try { localStorage.setItem('dead-mode', mode); } catch { /* storage blocked */ }
  if (mode === 'hubs' && !boardsLoaded.hubs) { boardsLoaded.hubs = true; loadHubs(); }
  if (mode === 'oceanic' && !boardsLoaded.oceanic) { boardsLoaded.oceanic = true; loadOceanic(); }
}

async function runGlobal() {
  const ids = splitIds(val('g-route'));
  const statusEl = $('global-status');
  if (ids.length < 2) { if (statusEl) statusEl.textContent = 'Enter at least two ICAO waypoints (e.g. KCHS TNCM LPLA ETAR).'; return; }
  normalizeHhmm($('g-depart-hhmm'));
  const depart = zuluToIso('g-depart');
  const tas = Number(val('g-tas')) || 450;
  const alt = (val('g-alt') || 'FL350').trim();
  const params = new URLSearchParams({ route: ids.join(' '), tas: String(tas), alt });
  if (depart) params.set('depart', depart);
  if ($('g-nvg')?.checked) params.set('nvg', '1');
  if (statusEl) statusEl.textContent = '';
  $('global-results').innerHTML = '<div class="loading"><div class="spinner"></div>Planning route — winds &amp; weather at each stop…</div>';
  try {
    const res = await fetch(`/api/global?${params}`);
    const data = await res.json();
    if (data.error) { $('global-results').innerHTML = `<div class="errbox">${esc(data.error)}</div>`; return; }
    renderGlobal(data);
  } catch (err) {
    $('global-results').innerHTML = `<div class="errbox">Failed to plan route: ${esc(err.message)}</div>`;
  }
}

const fmtHm = (min) => `${Math.floor((min || 0) / 60)}h${String((min || 0) % 60).padStart(2, '0')}`;

function renderGlobal(data) {
  const limits = readLimits();
  const r = data.route || {};
  const miss = (r.missing || []).length
    ? `<div class="missing-card">Unresolved ICAO(s): ${r.missing.map(esc).join(', ')} — check spelling, or the field isn't in the dataset yet.</div>` : '';
  const t = data.totals || {};
  const flLabel = r.altFt ? `FL${Math.round(r.altFt / 100)}` : '';
  const head = `<div class="g-summary"><b>${esc((r.ids || []).join(' → '))}</b>
    <span>${(t.distanceNm || 0).toLocaleString()} NM · ${fmtHm(t.timeMin)} · TAS ${esc(r.tasKt)} kt @ ${esc(flLabel)}</span></div>`;
  const legRows = (data.legs || []).map((l) => {
    let w = '—';
    if (l.wind) {
      const hw = Math.round(l.wind.headwindKt);
      const comp = hw >= 0 ? `HW ${hw}` : `TW ${-hw}`;
      w = `${String(l.wind.dirTrue).padStart(3, '0')}/${l.wind.speedKt} · ${comp}`;
    }
    // ETP + diversion cell: ETP distance-from-each-end @ time, then candidate fields.
    let etpCell = '—';
    if (l.etp) {
      const e = l.etp;
      const divs = (l.diversions || []).map((d) => `${esc(d.icao)} ${d.distanceNm}`).join(', ');
      const divHtml = l.diversionGap
        ? '<span class="g-gap">⚠ no diversion in range</span>'
        : `<span class="g-div" title="Nearest suitable (≥${data.route?.minRwy || 7000} ft) airfields to the ETP, with NM">${esc(divs)}</span>`;
      etpCell = `<div title="Equal-time point: ${e.fromNm} NM from ${esc(l.fromId)} / ${e.toNm} NM from ${esc(l.toId)}; continue ${e.gsContinueKt} kt vs return ${e.gsReturnKt} kt">ETP ${e.fromNm}/${e.toNm} NM${e.etpIso ? ` @ ${esc(zuluLocal(e.etpIso))}` : ''}</div><div class="g-divrow">${divHtml}</div>`;
    }
    return `<tr><td>${esc(l.fromId)}→${esc(l.toId)}</td><td>${l.distanceNm.toLocaleString()} NM</td><td>${String(l.bearingTrue).padStart(3, '0')}°T</td><td>${l.gsKt} kt</td><td>${fmtHm(l.eteMin)}</td><td>${esc(zuluLocal(l.etaIso))}</td><td>${esc(w)}</td><td>${etpCell}</td></tr>`;
  }).join('');
  const legTable = legRows
    ? `<div class="g-legs"><table class="g-table"><thead><tr><th>Leg</th><th>Dist</th><th>Course</th><th>GS</th><th>ETE</th><th>ETA (Z / local)</th><th>Wind @alt</th><th>ETP · diversions</th></tr></thead><tbody>${legRows}</tbody></table>
       <div class="g-note">Great-circle legs; GS = TAS minus along-track wind (clamps ~FL340). ETP = equal-time point between the leg's endpoints (continue vs turn-back GS); diversions are the nearest fields with a ≥${data.route?.minRwy || 7000} ft runway to the ETP. Verify fuel/ETOPS/ETP with official planning.</div></div>` : '';
  const cards = (data.airfields || []).map((af) => card(af, limits)).join('');
  $('global-results').innerHTML = `${miss}${head}${legTable}<div class="grid">${cards}</div>`;
  lastGlobalData = data;
  paintGlobalMap();
}

// ---- Status boards (AMC hubs, Oceanic divert) ------------------------------
// A field set rendered as region-grouped, worst-first status tiles. Both tabs
// share the same renderer; only the ?set= and target containers differ.
const boardsLoaded = {};
const boardData = {};   // last /api/hubs response per set (for the Build Brief PDF)
const SET_RES = { amc: 'hubs-results', oceanic: 'oceanic-results' };
const selected = { amc: new Set(), oceanic: new Set() }; // tile selection per board
const lastSelIdx = {}; // last-clicked tile index per board (for shift range-select)
const HUB_REGION_ORDER = ['CONUS', 'ALASKA', 'CANADA', 'GREENLAND', 'ICELAND', 'ATLANTIC', 'AZORES', 'IRELAND', 'UK', 'EUROPE', 'CENTCOM', 'PACOM', 'OTHER'];
const HUB_SEV = { 'NO-GO': 0, CAUTION: 1, GO: 2, 'NO-DATA': 3 };

async function loadBoard(set, resId, statusId, noun) {
  const el = $(resId); const st = $(statusId);
  el.innerHTML = `<div class="loading"><div class="spinner"></div>Briefing ${esc(noun)}…</div>`;
  if (st) st.textContent = '';
  try {
    const data = await (await fetch(`/api/hubs?set=${encodeURIComponent(set)}`)).json();
    boardData[set] = data;
    // Drop selections for fields no longer present.
    const present = new Set((data.hubs || []).map((h) => h.icao));
    selected[set] = new Set([...selected[set]].filter((ic) => present.has(ic)));
    renderHubBoard(data, resId, set);
    if (st) st.textContent = `${data.hubs.length} fields · WX ${data.live ? 'LIVE' : 'UNAVAIL'} · NOTAM ${data.notamsLive ? 'LIVE' : 'UNAVAIL'} · ${zuluLocal(data.generatedAt)}`;
  } catch (err) {
    el.innerHTML = `<div class="errbox">Failed to load ${esc(noun)}: ${esc(err.message)}</div>`;
  }
}
const loadHubs = () => loadBoard('amc', 'hubs-results', 'hubs-status', 'AMC hubs');
const loadOceanic = () => loadBoard('oceanic', 'oceanic-results', 'oceanic-status', 'divert fields');

// Compile one print-ready PDF (Weather + NOTAMs + RAIM, with a scan-first divert
// summary table) via the shared refcard engine. `icaos` limits it to a selection.
function buildBoardBrief(set, icaos) {
  const list = (icaos && icaos.length) ? icaos : (boardData[set]?.hubs || []).map((h) => h.icao);
  if (!list.length) { alert('Load the board first (tap Refresh), then Build Brief.'); return; }
  const fields = list.join('|');
  window.open(`/api/refcard?fields=${encodeURIComponent(fields)}&only=wxnotams&summary=1&print=1`, '_blank', 'noopener');
}

function hubTile(h, set) {
  const cls = h.status === 'NO-GO' ? 'nogo' : h.status === 'CAUTION' ? 'caution' : h.status === 'GO' ? 'go' : 'nodata';
  const cat = h.flightCategory ? `<span class="hub-cat cat-${esc(h.flightCategory)}">${esc(h.flightCategory)}</span>` : '';
  const cv = [];
  if (h.ceilingFt != null) cv.push(`${h.ceilingFt.toLocaleString()}′`);
  if (h.visibilitySm != null) cv.push(`${h.visibilitySm} SM`);
  const closed = (h.closedRunways || []).length ? `<span class="hub-flag">🚫 RWY ${h.closedRunways.map(esc).join('/')}</span>` : '';
  const fc = (h.runwayConditions || 0) > 0 ? '<span class="hub-flag">🧊 FICON</span>' : '';
  const rc = { 'PREDICTED OUTAGE': 'raim-out', 'NO PREDICTED OUTAGE': 'raim-ok', UNKNOWN: 'raim-unk' }[h.raim];
  const rt = { 'PREDICTED OUTAGE': 'RAIM ✗', 'NO PREDICTED OUTAGE': 'RAIM ✓', UNKNOWN: 'RAIM ?' }[h.raim];
  const raim = rc ? `<span class="raim-chip ${rc}" title="GPS/RAIM: ${esc(h.raim)}">${rt}</span>` : '';
  const title = [h.metar, h.topReason, 'Tap to select for Build Selected'].filter(Boolean).join('\n');
  const sel = selected[set]?.has(h.icao) ? ' selected' : '';
  return `<div class="hub-tile ${cls}${sel}" data-set="${esc(set)}" data-icao="${esc(h.icao)}" title="${esc(title)}">
    <span class="hub-check" aria-hidden="true">✓</span>
    <div class="hub-top"><span class="hub-icao">${esc(h.icao)}</span>${cat}</div>
    <div class="hub-name">${esc(h.name)}</div>
    <div class="hub-meta">${cv.join(' · ') || (h.found ? 'no METAR' : 'not found')}</div>
    <div class="hub-flags">${raim}${closed}${fc}</div></div>`;
}

function boardBar(set) {
  return `<div class="board-bar" data-set="${esc(set)}">
    <div class="bb-left"><button class="bb-btn" data-bb="selall" data-set="${esc(set)}">Select all</button>
      <button class="bb-btn" data-bb="clear" data-set="${esc(set)}">Clear</button></div>
    <div class="bb-right"><span class="bb-count">None selected</span>
      <button class="go bb-build" data-bb="build" data-set="${esc(set)}" disabled>Build Selected (PDF)</button></div></div>`;
}

function renderHubBoard(data, resId, set) {
  const byRegion = new Map();
  for (const h of data.hubs || []) {
    if (!byRegion.has(h.region)) byRegion.set(h.region, []);
    byRegion.get(h.region).push(h);
  }
  const rrank = (r) => { const i = HUB_REGION_ORDER.indexOf(r); return i < 0 ? 999 : i; };
  const regions = [...byRegion.keys()].sort((a, b) => rrank(a) - rrank(b));
  const out = regions.map((r) => {
    const tiles = byRegion.get(r).sort((a, b) => (HUB_SEV[a.status] ?? 9) - (HUB_SEV[b.status] ?? 9) || a.icao.localeCompare(b.icao));
    return `<div class="hub-region"><h3 class="hub-region-h">${esc(r)}</h3><div class="hub-grid">${tiles.map((h) => hubTile(h, set)).join('')}</div></div>`;
  }).join('');
  $(resId).innerHTML = out ? `${boardBar(set)}${out}` : '<div class="g-note">No fields configured.</div>';
  lastSelIdx[set] = null; // tile order changed; reset the shift-range anchor
  updateSelectionUI(set);
}

// Reflect the selection set into the board's tiles + action bar (no re-render).
function updateSelectionUI(set) {
  const el = $(SET_RES[set]); if (!el) return;
  const sel = selected[set];
  el.querySelectorAll('.hub-tile').forEach((t) => t.classList.toggle('selected', sel.has(t.dataset.icao)));
  const bar = el.querySelector('.board-bar');
  if (bar) {
    bar.querySelector('.bb-count').textContent = sel.size ? `${sel.size} selected` : 'None selected';
    bar.querySelector('.bb-build').disabled = sel.size === 0;
    bar.classList.toggle('has-sel', sel.size > 0);
  }
}

// Toggle a tile; shift-click selects the contiguous range from the last click.
function toggleTile(tileEl, shiftKey) {
  const set = tileEl.dataset.set, icao = tileEl.dataset.icao;
  if (!set || !icao) return;
  const tiles = [...$(SET_RES[set]).querySelectorAll('.hub-tile')];
  const idx = tiles.indexOf(tileEl);
  if (shiftKey && lastSelIdx[set] != null) {
    const [a, b] = [lastSelIdx[set], idx].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) selected[set].add(tiles[i].dataset.icao);
  } else {
    if (selected[set].has(icao)) selected[set].delete(icao); else selected[set].add(icao);
    lastSelIdx[set] = idx;
  }
  updateSelectionUI(set);
}

// Board interactions: tap a tile to (de)select; action-bar buttons.
function onBoardClick(e) {
  const bb = e.target.closest('[data-bb]');
  if (bb) {
    const set = bb.dataset.set;
    if (bb.dataset.bb === 'selall') { for (const h of boardData[set]?.hubs || []) selected[set].add(h.icao); updateSelectionUI(set); }
    else if (bb.dataset.bb === 'clear') { selected[set].clear(); updateSelectionUI(set); }
    else if (bb.dataset.bb === 'build') { buildBoardBrief(set, [...selected[set]]); }
    return;
  }
  const tile = e.target.closest('.hub-tile');
  if (tile && tile.dataset.set) toggleTile(tile, e.shiftKey);
}

// The Global tab's map: the planned route (gold), oceanic tracks (NAT violet /
// PACOTS orange), stops (GO/CAUTION/NO-GO), and diversion fields (markers).
let lastGlobalData = null;   // latest /api/global response
let globalTracks = [];       // [{...track, sys:'NAT'|'PAC'}] from /api/tracks

function paintGlobalMap() {
  const el = $('global-map');
  if (!el) return;
  const data = lastGlobalData;
  // Route line from the leg endpoints (origin then each leg's arrival).
  const legs = data?.legs || [];
  const routePts = legs.length
    ? [[legs[0].fromLat, legs[0].fromLon], ...legs.map((l) => [l.toLat, l.toLon])].filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    : [];
  const routeOfFlight = routePts.length >= 2 ? { geometry: { points: routePts } } : null;
  const airfields = (data?.airfields || []).filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon))
    .map((a) => ({ icao: a.icao, lat: a.lat, lon: a.lon, status: a.status }));
  // Diversion fields (dedup) as navaid-style markers.
  const seen = new Set(airfields.map((a) => a.icao));
  const navaids = [];
  for (const l of legs) for (const d of (l.diversions || [])) {
    if (d.lat == null || seen.has(d.icao)) continue;
    seen.add(d.icao); navaids.push({ icao: d.icao, lat: d.lat, lon: d.lon, type: 'fix' });
  }
  // Oceanic tracks as line overlays (map's mtr layer).
  const mtrs = globalTracks
    .filter((t) => t.geometry?.points?.length >= 2)
    .map((t) => ({ id: `${t.sys}${t.id}`, type: t.sys, geometry: t.geometry }));
  if (!routeOfFlight && !airfields.length && !mtrs.length) { el.hidden = true; return; }
  el.hidden = false;
  const trackPts = mtrs.flatMap((m) => m.geometry.points.map(([lat, lon]) => ({ lat, lon })));
  // Frame the route if there is one; otherwise frame the tracks.
  const focus = routePts.length
    ? [...airfields, ...routePts.map(([lat, lon]) => ({ lat, lon }))]
    : trackPts;
  currentMap = initMap(el, {
    airfields, navaids, routeOfFlight, mtrs,
    home: airfields.length ? airfields : trackPts, focus,
    validity: globalTracks.length ? [{ k: 'Oceanic tracks', v: `${globalTracks.length} loaded` }] : [],
  });
}

function trackTable(title, sys) {
  if (!sys) return '';
  if (!sys.tracks || !sys.tracks.length) {
    return `<div class="g-note">${esc(title)}: no tracks — ${esc(sys.source || 'unavailable')}.</div>`;
  }
  const src = sys.live ? `live (${esc(sys.source)})` : `sample (${esc(sys.source)})`;
  const rows = sys.tracks.map((t) => {
    const lvls = (t.westLevels || []).concat(t.eastLevels || []);
    const info = t.flBand
      || (lvls.length ? `FL${Math.min(...lvls)}–FL${Math.max(...lvls)}` : '')
      || [t.direction, t.fir].filter(Boolean).join(' ') || '—';
    const valid = t.validRaw || (t.validFrom ? `${esc(zuluLocal(t.validFrom))} – ${esc(zuluLocal(t.validTo))}` : '');
    return `<tr title="${esc(valid)}"><td><b>${esc(t.id)}</b></td><td>${esc(info)}</td><td>${esc((t.pointsRaw || []).join(' '))}</td></tr>`;
  }).join('');
  return `<div class="g-note">${esc(title)} · ${src} · ${sys.tracks.length} tracks. Hover a row for its valid window. Verify against the official source.</div>
    <div class="g-legs"><table class="g-table"><thead><tr><th>Trk</th><th>Levels / Dir</th><th>Route</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function loadNatTracks() {
  const el = $('nat-results');
  el.innerHTML = '<div class="loading"><div class="spinner"></div>Loading oceanic tracks…</div>';
  try {
    const data = await (await fetch('/api/tracks?system=both')).json();
    el.innerHTML = trackTable('North Atlantic (NAT-OTS)', data.nat) + trackTable('Pacific (PACOTS)', data.pacots);
    globalTracks = [
      ...((data.nat?.tracks || []).map((t) => ({ ...t, sys: 'NAT' }))),
      ...((data.pacots?.tracks || []).map((t) => ({ ...t, sys: 'PAC' }))),
    ];
    paintGlobalMap();
  } catch (err) {
    el.innerHTML = `<div class="errbox">Failed to load oceanic tracks: ${esc(err.message)}</div>`;
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
let windsPoints = []; // Climb-Winds navaids/airfields overlaid on the map ({icao,lat,lon,status})
let routeOfFlight = null; // { geometry:{kind:'line',points}, points:[{id,kind,lat,lon}] } | null
const normId = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function renderMap(data) {
  lastBriefData = data;
  paintMap();
}

function paintMap() {
  const mapEl = $('map');
  if (!mapEl) return;
  const data = lastBriefData;
  const briefAirfields = data
    ? data.airfields.filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lon))
        .map((b) => ({ icao: b.icao, lat: b.lat, lon: b.lon, status: b.status }))
    : [];
  // Merge in Climb-Winds points (dedup by icao) so that tool ADDS to the map
  // rather than replacing the brief's airfields + routes.
  const have = new Set(briefAirfields.map((a) => a.icao));
  const windPts = windsPoints.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon) && !have.has(w.icao));
  // Winds airfields render as airfields; winds navaids (VOR/TACAN/etc.) render
  // as distinct navaid markers (no traffic-pattern ring, no GO/NO-GO status).
  const isAirport = (t) => String(t || '').toLowerCase() === 'airport';
  const navaids = windPts.filter((w) => !isAirport(w.type));
  const airfields = [...briefAirfields, ...windPts.filter((w) => isAirport(w.type))];
  // With routes looked up, show exactly those (chip-controlled) over the brief;
  // otherwise fall back to the brief's auto nearby routes.
  const mtrs = activeRoutes.length
    ? activeRoutes.map((d) => ({ id: d.id, type: d.type, geometry: d.geometry }))
    : (data?.mtrs || []);
  const hasRof = !!(routeOfFlight?.geometry?.points?.length);
  if (!airfields.length && !navaids.length && !mtrs.length && !hasRof) { mapEl.style.display = 'none'; return; }
  mapEl.style.display = '';
  const as = data?.airspace || { tfrs: [], sua: [] };
  // Fit to the airfields plus any looked-up route points (auto nearby routes
  // don't drag the default view out).
  const routePts = activeRoutes.flatMap((d) => (d.geometry?.points || []).map(([lat, lon]) => ({ lat, lon })));
  const rofPts = (routeOfFlight?.geometry?.points || []).map(([lat, lon]) => ({ lat, lon }));
  const focus = (activeRoutes.length || windPts.length || rofPts.length) ? [...airfields, ...navaids, ...routePts, ...rofPts] : briefAirfields;
  currentMap = initMap(mapEl, {
    airfields, navaids, routeOfFlight, home: briefAirfields.length ? briefAirfields : airfields, tfrs: as.tfrs, sua: as.sua,
    sigmets: data?.airsigmets || [], pireps: data?.pireps || [], convective: data?.convective || [],
    mtrs, validity: data ? wxValidity(data) : [], focus,
  });
}

// One-line mission status for the kneeboard header — the worst phase call and
// what's driving it, from the same ribbon model the on-screen ribbon uses.
function printMissionStatus(data, limits) {
  try {
    const whens = { arWhen: zuluToIso('sp-ar') || null, llWhen: zuluToIso('sp-ll') || null };
    const phases = buildRibbonModel(data, activeRoutes, limits, whens);
    if (!phases.length) return '';
    const bad = phases.filter((p) => p.status === 'NO-GO');
    const caut = phases.filter((p) => p.status === 'CAUTION');
    const worst = bad.length ? 'NO-GO' : caut.length ? 'CAUTION' : 'GO';
    const driver = (p) => {
      const c = p.chips.find((x) => x.sev === 'nogo') || p.chips.find((x) => x.sev === 'caution');
      return `${rbRoleTag(p.role)} ${p.id}${c ? ` (${c.k})` : ''}`;
    };
    const detail = worst === 'GO' ? 'all phases GO' : [...bad, ...caut].map(driver).join(' · ');
    const cls = worst === 'NO-GO' ? 'ms-nogo' : worst === 'CAUTION' ? 'ms-caution' : 'ms-go';
    return `<div class="ph-status ${cls}">MISSION STATUS: ${esc(worst)} — ${esc(detail)}</div>`;
  } catch { return ''; }
}

function updatePrintHead(data, ids, limits) {
  const src = `WX ${data.live.weather ? 'LIVE' : 'UNAVAIL'} · NOTAM ${data.live.notams ? 'LIVE' : 'UNAVAIL'}`;
  let takeoff = '';
  if (data.sortie) {
    // Summarize the phases in mission order, each at its own time: departure →
    // A/R (at its entry time) → low-level (at its) → recovery → alternates.
    const fld = (role) => data.airfields.filter((b) => b.phase?.role === role && b.phase?.when)
      .map((b) => `${esc(b.phase.label)} ${esc(b.icao)} @ ${esc(zuluLocal(b.phase.when))}`);
    const arWhen = zuluToIso('sp-ar'); const llWhen = zuluToIso('sp-ll');
    const arIds = activeRoutes.filter((d) => d.type === 'AR').map((d) => esc(d.id));
    const llIds = activeRoutes.filter((d) => d.type && d.type !== 'AR').map((d) => esc(d.id));
    const ar = arIds.length ? [`A/R ${arIds.join(', ')}${arWhen ? ' @ ' + esc(zuluLocal(arWhen)) : ''}`] : [];
    const ll = llIds.length ? [`Low-Level ${llIds.join(', ')}${llWhen ? ' @ ' + esc(zuluLocal(llWhen)) : ''}`] : [];
    const line = [...fld('DEPARTURE'), ...ar, ...ll, ...fld('RECOVERY'), ...fld('ALTERNATE')].join('  →  ');
    takeoff = line ? `<div class="ph-meta">Sortie timeline: ${line} — each phase evaluated at its own time</div>` : '';
  } else if (data.targetTime) {
    takeoff = `<div class="ph-meta">Planned takeoff ${esc(zuluLocal(data.targetTime, { date: true }))} — winds &amp; AHAS tailored to this time</div>`;
  }
  $('print-head').innerHTML =
    `<div class="ph-title">DEAD PLANNING — MISSION BRIEF</div>
     ${printMissionStatus(data, limits)}
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
  'sp-dep', 'sp-dep-d', 'sp-dep-hhmm', 'sp-ar', 'sp-ar-d', 'sp-ar-hhmm', 'sp-ll', 'sp-ll-d', 'sp-ll-hhmm', 'sp-rec', 'sp-rec-d', 'sp-rec-hhmm', 'sp-alt',
  'xwind', 'tailwind', 'highda', 'agls', 'nvg-mode',
  'winds-points', 'rof',
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
  for (const id of SORTIE_FIELDS) { const el = $(id); if (el) data[id] = el.type === 'checkbox' ? el.checked : (el.value || '').trim(); }
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
  for (const id of SORTIE_FIELDS) { const el = $(id); if (el && id in s) { if (el.type === 'checkbox') el.checked = !!s[id]; else el.value = s[id]; } }
  // Reset any routes currently on the map so the load reflects exactly the
  // saved sortie (buildBrief re-looks-up the low-level route(s) below).
  activeRoutes = [];
  // Some legacy saves stored the airfield list under `icaos`; map it to Departure.
  if (!(s['sp-dep'] || '').trim() && (s.icaos || '').trim()) {
    const dep = $('sp-dep'); if (dep) dep.value = splitIds(s.icaos)[0] || '';
  }
  // Migration: older saves kept AR tracks in the combined Low-Level/AR field.
  // Move AR* ids into the (then-empty) A/R field, inheriting the LL time.
  const arEl = $('sp-ar'), llEl = $('sp-ll');
  if (arEl && llEl && !arEl.value.trim()) {
    const llIds = splitIds(llEl.value);
    const arIds = llIds.filter((id) => /^AR-?\d/.test(id));
    if (arIds.length) {
      arEl.value = arIds.join(' ');
      llEl.value = llIds.filter((id) => !/^AR-?\d/.test(id)).join(' ');
      const ad = $('sp-ar-d'), ah = $('sp-ar-hhmm'), ld = $('sp-ll-d'), lh = $('sp-ll-hhmm');
      if (ad && !ad.value && ld) ad.value = ld.value;
      if (ah && !ah.value && lh) ah.value = lh.value;
    }
  }
  await buildBrief(); // evaluates each phase + overlays the low-level route(s)
  // The Route/Climb Winds input is restored; re-run it if it was populated so
  // its profiles come back too, but leave the brief's map in place.
  if ((s['winds-points'] || '').trim()) getRouteWinds();
  // Re-draw a saved route of flight (resolves + overlays on the map).
  routeOfFlight = null;
  if ((s.rof || '').trim()) drawRouteOfFlight();
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

  // Local / Global tab switch (restores the last-used mode).
  const tabbar = $('tabbar');
  if (tabbar) tabbar.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setMode(b.dataset.tab); });
  on('g-go', 'click', runGlobal);
  on('nat-go', 'click', loadNatTracks);
  on('hubs-go', 'click', loadHubs);
  on('oceanic-go', 'click', loadOceanic);
  on('hubs-pdf', 'click', () => buildBoardBrief('amc'));
  on('oceanic-pdf', 'click', () => buildBoardBrief('oceanic'));
  on('hubs-results', 'click', onBoardClick);
  on('oceanic-results', 'click', onBoardClick);
  on('g-route', 'keydown', (e) => { if (e.key === 'Enter') runGlobal(); });
  on('g-depart-hhmm', 'blur', () => normalizeHhmm($('g-depart-hhmm')));
  { // prefill the global depart date/time with "now" (Zulu)
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    if ($('g-depart-d') && !$('g-depart-d').value) $('g-depart-d').value = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    if ($('g-depart-hhmm') && !$('g-depart-hhmm').value) $('g-depart-hhmm').value = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  }
  try { const m = localStorage.getItem('dead-mode'); setMode(['global', 'hubs', 'oceanic'].includes(m) ? m : 'local'); } catch { /* default local */ }

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
    // Collapse/expand a route detail card by clicking its header.
    const head = e.target.closest('.card > .head');
    if (head) { head.parentElement.classList.toggle('collapsed'); return; }
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

function onResultsClick(e) {
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
}
// Both the Departure container and the Recovery/Alternates container use the
// same card interactions (collapse, tabs, NOTAM filter, runway compare, TAF).
$('results')?.addEventListener('click', onResultsClick);
$('results-rest')?.addEventListener('click', onResultsClick);

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
  // Timeline cell taps + the CADDO10 offline demos: ?demo=caddo10 (day divert)
  // or ?demo=caddo10n (night NVG illumination).
  on('sec-timeline', 'click', onTimelineClick);
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo === 'caddo10' || demo === 'caddo10n') {
    fetchTimeline(new URLSearchParams({ demo }));
  }
  // Tidy each 24-hour Zulu time field to HHMM when the user leaves it / hits Enter.
  TIME_PREFIXES.forEach((pre) => {
    const el = $(`${pre}-hhmm`);
    if (!el) return;
    on(`${pre}-hhmm`, 'blur', () => { normalizeHhmm(el); updateQuickLinks(); });
    on(`${pre}-hhmm`, 'keydown', (e) => { if (e.key === 'Enter') { normalizeHhmm(el); buildBrief(); } });
  });
  updateQuickLinks();
  // Keep the toolbar links in sync with the departure field/time and the
  // low-level routes/entry time (AHAS + Build PDF include route bird-risk).
  ['sp-dep', 'sp-dep-d', 'sp-dep-hhmm', 'sp-ar', 'sp-ar-d', 'sp-ar-hhmm', 'sp-ll', 'sp-ll-d', 'sp-ll-hhmm'].forEach((id) => on(id, 'input', updateQuickLinks));
  on('go', 'click', buildBrief);
  on('sp-clear', 'click', () => {
    ['sp-dep', 'sp-dep-d', 'sp-dep-hhmm', 'sp-ar', 'sp-ar-d', 'sp-ar-hhmm', 'sp-ll', 'sp-ll-d', 'sp-ll-hhmm', 'sp-rec', 'sp-rec-d', 'sp-rec-hhmm', 'sp-alt'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
    prefillDatetimes(); // restore the time fields to "now"
  });
  // Enter in any phase field builds the brief.
  ['sp-dep', 'sp-ar', 'sp-ll', 'sp-rec', 'sp-alt'].forEach((id) => on(id, 'keydown', (e) => { if (e.key === 'Enter') buildBrief(); }));
  on('rof-go', 'click', drawRouteOfFlight);
  on('rof-clear', 'click', clearRouteOfFlight);
  on('rof', 'keydown', (e) => { if (e.key === 'Enter') drawRouteOfFlight(); });
  on('export-html', 'click', () => runExport('html'));
  on('export-pdf', 'click', () => runExport('pdf'));
  // Essential-NOTAMs print mode: toggles a body class the print stylesheet keys
  // on. Persisted; default ON (the kneeboard pain is verbose procedural NOTAMs).
  {
    const pe = $('print-essential');
    const stored = localStorage.getItem('dead-print-essential');
    if (pe) {
      pe.checked = stored == null ? true : stored === '1';
      document.body.classList.toggle('print-essential', pe.checked);
      pe.addEventListener('change', () => {
        document.body.classList.toggle('print-essential', pe.checked);
        try { localStorage.setItem('dead-print-essential', pe.checked ? '1' : '0'); } catch { /* storage blocked */ }
      });
    }
  }
  on('sortie-save', 'click', saveCurrentSortie);
  on('sortie-load', 'click', loadSelectedSortie);
  on('sortie-del', 'click', deleteSelectedSortie);
  initSorties();
  on('winds-go', 'click', getRouteWinds);
  on('winds-points', 'keydown', (e) => { if (e.key === 'Enter') getRouteWinds(); });
  // No auto-brief on load: let the user set fields/dates/times first, then pull
  // once on Build Brief — avoids a wasted live fan-out against the defaults.
  const res = $('results');
  if (res && !res.innerHTML.trim()) {
    res.innerHTML = `<div class="empty">Set your fields and Zulu times above, then press <b>Build Brief</b> to pull live data.</div>`;
  }
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
