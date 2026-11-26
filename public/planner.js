// Planner tab — parse a C2D2 mission paste into per-field arrival/departure
// times, and render the stacked 72-hour OPS TIMELINEs (one per airfield on a
// shared Zulu axis) with a single synchronized scrub cursor + hour readout and
// the merged limiting windows. The timeline data + sliceAt/changePoints come
// from the shared pure engine (./opsTimeline.js); this file is the view.

import { sliceAt, changePoints, stampShort } from './opsTimeline.js';
import { zuluLocal } from './timefmt.js';

const HOUR = 3600000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- mission paste parsing (pure, unit-tested) -----------------------------

/** Julian "YDDD" + HHMM Zulu → epoch ms. Y = year's ones digit (this decade,
 *  nudged ±10 y so it lands near now). DDD = day-of-year (Jan 1 = 001). */
export function julianToMs(yDigit, doy, hh, mm, nowMs = Date.now()) {
  const nowY = new Date(nowMs).getUTCFullYear();
  let year = Math.floor(nowY / 10) * 10 + Number(yDigit);
  while (year < nowY - 1) year += 10;
  while (year > nowY + 8) year -= 10;
  return Date.UTC(year, 0, 1) + (Number(doy) - 1) * 86400000 + Number(hh) * HOUR + Number(mm) * 60000;
}

const STAMP_RE = /\b(\d)(\d{3})\/(\d{2})(\d{2})Z\b/g;
const ICAO_RE = /\b([A-Z]{4})\b/g;
// ICAO-ish tokens that are really column headers / words in the paste.
const NOT_ICAO = new Set(['TIME', 'MISSION', 'DETAILS', 'SHARE', 'CLOSE', 'GMT', 'ZULU', 'DAYS', 'NONE', 'PPR', 'ETD', 'ETA']);

/**
 * Parse a pasted C2D2 "Mission Details" list into legs + per-field times.
 * Tolerant by design — the editable rows let the user fix anything mis-parsed.
 * @returns {{ legs:{orig,dest,depMs,arrMs}[], fields:{icao,arrMs,depMs}[] }}
 */
export function parseMissionPaste(text, nowMs = Date.now()) {
  const src = String(text || '');
  // Split into per-leg blocks on the mission marker ("#200", "Gnd Time"), else
  // treat the whole paste as one block and pair sequentially.
  const parts = src.split(/(?=#\s*\d+|Gnd\s*Time)/i).map((s) => s.trim()).filter(Boolean);
  const blocks = parts.length > 1 ? parts : [src];

  const legs = [];
  for (const b of blocks) {
    const icaos = [...b.matchAll(ICAO_RE)].map((m) => m[1]).filter((c) => !NOT_ICAO.has(c));
    const stamps = [...b.matchAll(STAMP_RE)].map((m) => julianToMs(m[1], m[2], m[3], m[4], nowMs));
    if (icaos.length >= 2 && stamps.length >= 2) {
      legs.push({ orig: icaos[0], dest: icaos[1], depMs: stamps[0], arrMs: stamps[1] });
    } else if (icaos.length >= 2 && stamps.length === 1) {
      legs.push({ orig: icaos[0], dest: icaos[1], depMs: stamps[0], arrMs: null });
    }
  }

  // Per-field arrival (as a leg's destination) + departure (as the next leg's origin).
  const order = [], fieldMap = new Map();
  const touch = (icao) => { if (!fieldMap.has(icao)) { fieldMap.set(icao, { icao, arrMs: null, depMs: null }); order.push(icao); } return fieldMap.get(icao); };
  for (const lg of legs) {
    const o = touch(lg.orig), d = touch(lg.dest);
    if (lg.depMs != null && o.depMs == null) o.depMs = lg.depMs;
    if (lg.arrMs != null) d.arrMs = lg.arrMs;
  }
  return { legs, fields: order.map((i) => fieldMap.get(i)) };
}

// ---- rendering -------------------------------------------------------------
const TONE_CLASS = { r: 'pl-r', a: 'pl-a', i: 'pl-i', g: 'pl-g', u: 'pl-u', n: 'pl-n' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');

let PL = null; // render state for the scrub handlers

/** Render the planner response into a container element and wire the scrub cursor. */
export function renderPlanner(container, data) {
  if (!data || !data.fields || !data.fields.length) { container.innerHTML = '<div class="readout">No airfields to plan.</div>'; return; }
  const startMs = data.startMs, span = data.horizonH * HOUR, endMs = startMs + span;
  const xPct = (ms) => `calc(96px + (100% - 96px) * ${Math.max(0, Math.min(1, (ms - startMs) / span))})`;
  const barL = (ms) => ((Math.max(startMs, ms) - startMs) / span) * 100;
  const barW = (f, t) => ((Math.min(endMs, t) - Math.max(startMs, f)) / span) * 100;

  const anyWin = data.fields.some((f) => f.live);
  const head = `<div class="pl-head">
    <div class="pl-title">NEXT ${data.horizonH} H — OPS TIMELINE</div>
    <div class="pl-sub">all times Z · model planning-grade · the TAF governs its window · scrub to read any hour</div>
    <details class="pl-key"><summary>key ▾</summary><div class="pl-key-body">
      <b>Tones</b> — <span class="pl-sw pl-a"></span> amber = forecast limit · <span class="pl-sw pl-r"></span> red = observed / crosswind band · <span class="pl-sw pl-i"></span> note · <span class="pl-sw pl-g"></span> fine · <span class="pl-sw pl-u"></span> UNKNOWN.
      <b>Dashed</b> border = model or TEMPO/PROB (not the governing TAF). Beyond the TAF the Sky lane is visibility only (no ceiling). Thresholds are planning guidance, not a de-ice policy / AFI / flight manual. ${anyWin ? '' : 'No live forecast was available for some fields (UNKNOWN).'}
    </div></details>
  </div>`;

  const axis = buildAxis(startMs, data.horizonH);
  const stacks = data.fields.map((f) => fieldStack(f, startMs, span, xPct, barL, barW)).join('');
  const nowMs = Date.now();
  const nowLine = (nowMs > startMs && nowMs < endMs) ? `<div class="pl-now" style="left:${xPct(nowMs)}" title="now"></div>` : '';

  container.innerHTML = `<div class="planner">${head}
    <div class="pl-fields" id="pl-fields" tabindex="0" aria-label="ops timeline — arrow keys to scrub">
      ${axis}${stacks}${nowLine}
      <div class="pl-cursor" id="pl-cursor" hidden></div>
      <div class="pl-flag" id="pl-flag" hidden></div>
    </div>
    <div class="pl-readouts" id="pl-readouts">${data.fields.map((f) => `<div class="pl-readout" data-icao="${esc(f.icao)}"></div>`).join('')}</div>
    <div class="pl-winlists">${data.fields.map((f) => windowsList(f)).join('')}</div>
  </div>`;

  // Scrub state + initial readout.
  const cps = [...new Set(data.fields.flatMap((f) => changePoints(f, [])))].sort((a, b) => a - b);
  PL = { data, startMs, span, endMs, cps, pinned: false, cursorMs: Math.min(endMs - 1, Math.max(startMs, nowMs)) };
  wireScrub(container);
  updateCursor(PL.cursorMs);
}

function buildAxis(startMs, horizonH) {
  const span = horizonH * HOUR;
  const ticks = [];
  for (let t = Math.ceil(startMs / (6 * HOUR)) * (6 * HOUR); t < startMs + span; t += 6 * HOUR) {
    const d = new Date(t), h = d.getUTCHours();
    const frac = (t - startMs) / span;
    const label = h === 0 ? `${DOW[d.getUTCDay()]} ${d.getUTCDate()}` : `${p2(h)}Z`;
    ticks.push(`<div class="pl-tick${h === 0 ? ' pl-tick-day' : ''}" style="left:calc(96px + (100% - 96px) * ${frac})">${label}</div>`);
  }
  return `<div class="pl-axis">${ticks.join('')}</div>`;
}

function fieldStack(f, startMs, span, xPct, barL, barW) {
  const endMs = startMs + span;
  const unavailable = !f.live;
  const laneRows = f.lanes.map((lane) => {
    const bars = lane.segs.filter((s) => s.toMs > startMs && s.fromMs < endMs).map((s) => {
      const left = barL(s.fromMs), w = barW(s.fromMs, s.toMs);
      const cat = lane.key === 'sky' && s.cat ? ` data-cat="${s.cat}"` : '';
      return `<div class="pl-bar ${TONE_CLASS[s.tone] || ''}${s.dashed ? ' pl-dash' : ''}" style="left:${left}%;width:${Math.max(0.4, w)}%"${cat} title="${esc(s.detail)}"><span>${esc(s.short || s.label)}</span></div>`;
    }).join('');
    const unk = lane.unknown ? `<div class="pl-bar pl-u pl-dash" style="left:0;width:100%" title="UNKNOWN — ${esc(lane.unknown)}"><span>UNKNOWN</span></div>` : '';
    return `<div class="pl-lane"><div class="pl-lane-lbl">${esc(lane.title)}</div><div class="pl-track">${bars}${unk}</div></div>`;
  }).join('');

  const temp = tempSvg(f, startMs, span);
  // Mission ETD/ETA markers + the field's "TAF ends" marker, across the lanes.
  const marks = (f.events || []).filter((e) => e.ms > startMs && e.ms < endMs)
    .map((e) => `<div class="pl-event" style="left:${xPct(e.ms)}" title="${esc(e.kind)} ${esc(f.icao)} ${esc(zuluLocal(new Date(e.ms).toISOString()))}"><span>${esc(e.kind)}</span></div>`).join('');
  const tafEnd = (f.tafEndMs && f.tafEndMs > startMs && f.tafEndMs < endMs)
    ? `<div class="pl-tafend" style="left:${xPct(f.tafEndMs)}" title="TAF ends — model beyond here"><span>TAF ends</span></div>` : '';

  return `<div class="pl-field" data-icao="${esc(f.icao)}">
    <div class="pl-field-h"><b>${esc(f.icao)}</b>${f.name ? ` <span class="pl-fname">${esc(f.name)}</span>` : ''}${unavailable ? ' <span class="pl-unavail">UNAVAILABLE</span>' : ''}<span class="pl-fsum">${esc(f.summary || '')}</span></div>
    <div class="pl-lanes">${laneRows}
      <div class="pl-lane pl-temp-lane"><div class="pl-lane-lbl">Temp <small>${f.temp.minC != null ? Math.round(f.temp.minC) + '/' + Math.round(f.temp.maxC) + '°' : ''}</small></div><div class="pl-track">${temp}</div></div>
      ${marks}${tafEnd}
    </div>
  </div>`;
}

function tempSvg(f, startMs, span) {
  const pts = (f.temps || []).filter((x) => x.c != null);
  if (pts.length < 2) return '<div class="pl-notemp">no model temperature</div>';
  const cs = pts.map((x) => x.c), min = Math.min(...cs, 0), max = Math.max(...cs, 0);
  const H = 46, pad = 4;
  const x = (t) => ((t - startMs) / span) * 100;
  const y = (c) => pad + (1 - (c - min) / (max - min || 1)) * (H - 2 * pad);
  const line = (sel) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)},${y(sel(p)).toFixed(2)}`).join(' ');
  const zeroY = y(0).toFixed(2);
  const shade = pts.filter((p) => p.c <= 0).map((p) => `<rect x="${x(p.t).toFixed(2)}" y="0" width="${(100 / (span / HOUR)).toFixed(3)}" height="${H}"/>`).join('');
  const dew = pts.every((p) => p.dew != null) ? `<path class="pl-dew" d="${line((p) => p.dew)}"/>` : '';
  const cross = (f.temp.crossings || []).map((c) => `<line class="pl-cross" x1="${x(c.t).toFixed(2)}" y1="0" x2="${x(c.t).toFixed(2)}" y2="${H}"/><text class="pl-crosst" x="${x(c.t).toFixed(2)}" y="9">${c.dir === 'down' ? '↓0°' : '↑0°'}</text>`).join('');
  return `<svg class="pl-tsvg" viewBox="0 0 100 ${H}" preserveAspectRatio="none"><g class="pl-shade">${shade}</g>
    <line class="pl-zero" x1="0" y1="${zeroY}" x2="100" y2="${zeroY}"/>${dew}<path class="pl-tline" d="${line((p) => p.c)}"/>${cross}</svg>`;
}

function windowsList(f) {
  if (!f.live) return `<div class="pl-winlist" data-icao="${esc(f.icao)}"><div class="pl-winlist-h">${esc(f.icao)} — limiting windows</div><div class="readout">UNKNOWN — no live forecast.</div></div>`;
  if (!f.windows.length) return `<div class="pl-winlist" data-icao="${esc(f.icao)}"><div class="pl-winlist-h">${esc(f.icao)} — limiting windows</div><div class="pl-nowin">No limiting window in the next ${f.hours} h.</div></div>`;
  const rows = f.windows.map((w, i) => {
    const chips = w.factors.map((fa) => `<span class="pl-chip">${esc(fa.label)}</span>`).join('');
    const dur = Math.round((w.toMs - w.fromMs) / HOUR);
    return `<div class="pl-win pl-win-${w.tone}" data-icao="${esc(f.icao)}" data-win="${i}" data-from="${w.fromMs}" title="${esc(w.text)}">
      <span class="pl-win-dot"></span><span class="pl-win-range">${esc(stampShort(w.fromMs))} – ${esc(stampShort(w.toMs))}</span><span class="pl-win-dur">${dur} h</span>${chips}</div>`;
  }).join('');
  return `<div class="pl-winlist" data-icao="${esc(f.icao)}"><div class="pl-winlist-h">${esc(f.icao)} — limiting windows</div>${rows}</div>`;
}

// ---- scrub cursor + readout ------------------------------------------------
function wireScrub(container) {
  const fields = container.querySelector('#pl-fields');
  if (!fields) return;
  const msAt = (clientX) => {
    const r = fields.getBoundingClientRect();
    const trackL = r.left + 96, trackW = r.width - 96;
    const frac = trackW > 0 ? (clientX - trackL) / trackW : 0;
    return PL.startMs + Math.max(0, Math.min(1, frac)) * PL.span;
  };
  const move = (e) => { if (PL.pinned) return; updateCursor(msAt(e.clientX)); };
  fields.addEventListener('pointermove', move);
  fields.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pl-win')) return; // window clicks handled below
    fields.setPointerCapture?.(e.pointerId);
    PL.pinned = !PL.pinned;
    if (!PL.pinned) updateCursor(msAt(e.clientX));
    else updateCursor(msAt(e.clientX), true);
    fields.focus({ preventScroll: true });
  });
  fields.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { PL.pinned = false; applyPin(); return; }
    let ms = PL.cursorMs;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (e.shiftKey) { const nx = e.key === 'ArrowRight' ? PL.cps.find((c) => c > ms) : [...PL.cps].reverse().find((c) => c < ms); if (nx != null) ms = nx; }
      else ms += dir * HOUR;
      e.preventDefault(); updateCursor(ms);
    }
  });
  // Clicking a window pins the cursor at its start + highlights it.
  container.querySelectorAll('.pl-win').forEach((el) => el.addEventListener('click', () => { PL.pinned = true; updateCursor(Number(el.dataset.from), true); }));
}

function applyPin() {
  const cur = document.getElementById('pl-cursor'), flag = document.getElementById('pl-flag');
  if (cur) cur.classList.toggle('pinned', PL.pinned);
  if (flag) flag.classList.toggle('pinned', PL.pinned);
}

function updateCursor(ms, pin) {
  if (!PL) return;
  PL.cursorMs = Math.max(PL.startMs, Math.min(PL.endMs - 1, ms));
  if (pin != null) PL.pinned = pin;
  const frac = (PL.cursorMs - PL.startMs) / PL.span;
  const left = `calc(96px + (100% - 96px) * ${frac})`;
  const cur = document.getElementById('pl-cursor'), flag = document.getElementById('pl-flag');
  if (cur) { cur.hidden = false; cur.style.left = left; }
  const iso = new Date(PL.cursorMs).toISOString();
  if (flag) {
    flag.hidden = false; flag.style.left = left;
    flag.style.transform = frac < 0.1 ? 'translateX(0)' : frac > 0.9 ? 'translateX(-100%)' : 'translateX(-50%)';
    flag.innerHTML = `<b>${esc(stampShort(PL.cursorMs))}</b> <span>${esc(zuluLocal(iso))}</span>`;
  }
  applyPin();
  // per-field readouts + window highlight
  for (const f of PL.data.fields) {
    const el = document.querySelector(`.pl-readout[data-icao="${cssq(f.icao)}"]`);
    if (el) el.innerHTML = readoutHtml(f, PL.cursorMs);
  }
  document.querySelectorAll('.pl-win').forEach((el) => {
    const f = PL.data.fields.find((x) => x.icao === el.dataset.icao);
    const w = f && f.windows[Number(el.dataset.win)];
    el.classList.toggle('active', !!w && PL.cursorMs >= w.fromMs && PL.cursorMs < w.toMs);
  });
}

const cssq = (s) => String(s).replace(/"/g, '\\"');

function readoutHtml(f, ms) {
  const s = sliceAt(f, [], f.windows, ms);
  if (!s) return `<div class="pl-ro-head"><b>${esc(f.icao)}</b> · UNAVAILABLE</div>`;
  const iso = new Date(s.ms).toISOString();
  const rel = relTime(s.ms);
  const govern = s.src === 'taf' ? 'the TAF governs this hour' : 'beyond the TAF — model, planning-grade';
  let pill;
  if (s.window) pill = `<span class="pl-pill pl-pill-${s.window.tone}">Inside limiting window ${s.window.index + 1} · clears ${esc(stampShort(s.window.toMs))} (${hLeft(s.window.leftMs)} left)</span>`;
  else if (s.next) pill = `<span class="pl-pill pl-pill-ok">Outside any window · next opens ${esc(stampShort(s.next.fromMs))} (in ${hLeft(s.next.inMs)})</span>`;
  else pill = '<span class="pl-pill pl-pill-ok">No limiting window</span>';
  const rows = s.rows.map((r) => `<div class="pl-ro-row ${TONE_CLASS[r.tone] || 'pl-n'}"><span class="pl-ro-k">${esc(r.title)}</span><span class="pl-ro-v">${esc(r.label ? r.label + ' — ' : '')}${esc(r.text)}</span></div>`).join('');
  return `<div class="pl-ro-head"><b>${esc(f.icao)}</b> · ${esc(stampShort(s.ms))} <small>${esc(zuluLocal(iso))} · ${esc(rel)} · ${esc(govern)}${PL.pinned ? ' · pinned' : ''}</small></div>
    <div class="pl-ro-pill">${pill}</div><div class="pl-ro-rows">${rows}</div>`;
}

function relTime(ms) {
  const d = Math.round((ms - Date.now()) / HOUR);
  if (d === 0) return 'this hour';
  return d > 0 ? `in ${d} h` : `${-d} h ago`;
}
const hLeft = (ms) => `${Math.max(0, Math.round(ms / HOUR))} h`;
