// Planner → a self-contained, SCRIPT-FREE HTML briefing packet of the same pure
// ops-timeline output (inline SVG temperature line, absolutely-positioned bars,
// per-field band + limiting-window list). Pure (no DOM): usable from the browser
// (download a .html) and unit-tested in node. EVERY external string (field names,
// lane detail, NOTAM/model text, window text) is escaped — it is untrusted.

import { stampShort, rangeLabel } from './opsTimeline.js';

const HOUR = 3600000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');
const clamp01 = (v) => Math.max(0, Math.min(1, v));

const TONE = { // light / ink-friendly briefing colours
  a: { fg: '#7a5800', bg: '#fff3d4', bd: '#e3b341' },
  r: { fg: '#8a1a14', bg: '#ffe1dd', bd: '#f0a39d' },
  i: { fg: '#0b5e6a', bg: '#dff2f5', bd: '#8fcdd6' },
  g: { fg: '#1a7f37', bg: '#eaf6ee', bd: '#add8ba' },
  u: { fg: '#55606e', bg: '#ffffff', bd: '#c3ccd6' },
};
const CAT = { VFR: '#eaf6ee', MVFR: '#e3eefb', IFR: '#ffe1dd', LIFR: '#f6e3f2' };

const STYLE = `
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#15202b;background:#fff;margin:0;padding:22px 26px 40px}
h1{font-size:17px;margin:0 0 2px}.sub{color:#5b6878;font-size:12px;margin-bottom:4px}.gen{color:#8793a3;font-size:11px;margin-bottom:16px}
.caveat{font-size:11px;color:#5b6878;border:1px solid #e2e8ef;background:#f7f9fb;border-radius:8px;padding:8px 10px;margin-bottom:18px}
.axis{position:relative;height:16px;margin:0 0 4px 92px}.tick{position:absolute;top:0;font:600 9.5px ui-monospace,Menlo,monospace;color:#8793a3;transform:translateX(-50%);white-space:nowrap}.tick.day{color:#15202b;font-weight:700}
.field{border:1px solid #e2e8ef;border-radius:10px;padding:10px 12px;margin-bottom:14px;break-inside:avoid}
.fh{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px}.fh b{font-family:ui-monospace,Menlo,monospace;font-size:14px;letter-spacing:1px}.fname{color:#5b6878;font-size:11.5px}.fsum{color:#8793a3;font-size:11px;margin-left:auto}
.unavail{color:#8a1a14;font:700 9px ui-monospace,Menlo,monospace;border:1px solid #f0a39d;border-radius:4px;padding:1px 5px}
.lane{display:grid;grid-template-columns:92px 1fr;align-items:center;margin-bottom:3px}.lbl{text-align:right;padding-right:8px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#8793a3;white-space:nowrap}.lbl small{text-transform:none;letter-spacing:0;color:#5b6878}
.track{position:relative;height:17px;background:#f2f5f8;border-radius:4px;overflow:hidden}.track.temp{height:44px}
.bar{position:absolute;top:1px;bottom:1px;border:1px solid;border-radius:3px;overflow:hidden;display:flex;align-items:center;padding:0 3px;font:700 8px ui-monospace,Menlo,monospace}.bar.dash{border-style:dashed}
.band{position:relative;height:6px;flex:1 1 150px;max-width:380px;background:#eef2f6;border:1px solid #e2e8ef;border-radius:3px;overflow:hidden;margin:0 6px}.bseg{position:absolute;top:0;bottom:0}.btick{position:absolute;top:0;bottom:0;width:1px;background:#c3ccd6}
svg.t{width:100%;height:44px;display:block}.tline{fill:none;stroke:#0b6b78;stroke-width:1.5;vector-effect:non-scaling-stroke}.dew{fill:none;stroke:#8793a3;stroke-width:1;stroke-dasharray:1 2;vector-effect:non-scaling-stroke}.zero{stroke:#b5840a;stroke-width:1;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}.shade{fill:rgba(90,130,220,.12)}.cross{stroke:#8793a3;stroke-width:1;stroke-dasharray:2 2;vector-effect:non-scaling-stroke}.crosst{fill:#5b6878;font:700 7px ui-monospace,Menlo,monospace;text-anchor:middle}
.evt{position:absolute;top:0;bottom:0;border-left:1.5px solid #0b6b78}.evt span{position:absolute;top:-1px;left:2px;font:700 8px ui-monospace,Menlo,monospace;color:#0b6b78;white-space:nowrap}
.wins{margin-top:8px}.winh{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#8793a3;margin-bottom:4px}
.win{font-size:11.5px;line-height:1.45;padding:4px 0;border-top:1px solid #eef2f6}.win b{font-family:ui-monospace,Menlo,monospace}
.nowin{font-size:11.5px;color:#8793a3}
@media print{body{padding:0}.field{border-color:#ccc}}
`;

export function plannerExportHtml(data) {
  if (!data || !data.fields) return '<!doctype html><title>Planner</title><body>No data.';
  const startMs = data.startMs, span = data.horizonH * HOUR, endMs = startMs + span;
  const pct = (ms) => clamp01((ms - startMs) / span) * 100;
  const xcalc = (ms) => `calc(92px + (100% - 92px) * ${clamp01((ms - startMs) / span)})`;

  // shared axis
  const ticks = [];
  for (let t = Math.ceil(startMs / (6 * HOUR)) * (6 * HOUR); t < endMs; t += 6 * HOUR) {
    const d = new Date(t), h = d.getUTCHours();
    ticks.push(`<div class="tick${h === 0 ? ' day' : ''}" style="left:${pct(t)}%">${h === 0 ? `${DOW[d.getUTCDay()]} ${d.getUTCDate()}` : `${p2(h)}Z`}</div>`);
  }

  const fields = data.fields.map((f) => fieldHtml(f, startMs, span, endMs, pct, xcalc)).join('');
  const title = `Ops timeline — ${esc(data.fields.map((f) => f.icao).join(' · '))}`;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${STYLE}</style></head>
<body><h1>NEXT ${data.horizonH} H — OPS TIMELINE</h1>
<div class="sub">${esc(data.fields.map((f) => f.icao).join(' · '))} · all times Zulu · the TAF governs its window, the model fills beyond it (dashed)</div>
<div class="gen">Generated ${esc(stampShort(Date.now()))} · briefing packet (static)</div>
<div class="caveat">Planning picture — it never moves a status light. A forecast is amber at most (red is observed, except the crosswind lane's own bands). UNKNOWN is never shown as clear. Thresholds are planning guidance, not a de-ice policy, an AFI, or a flight manual. Verify against official sources.</div>
<div class="axis">${ticks.join('')}</div>
${fields}</body></html>`;
}

function fieldHtml(f, startMs, span, endMs, pct, xcalc) {
  if (!f.live) {
    return `<div class="field"><div class="fh"><b>${esc(f.icao)}</b>${f.name ? `<span class="fname">${esc(f.name)}</span>` : ''}<span class="unavail">UNAVAILABLE</span><span class="fsum">no live forecast</span></div></div>`;
  }
  const band = (f.windows || []).map((w) => `<div class="bseg" style="left:${pct(w.fromMs)}%;width:${Math.max(0.6, pct(w.toMs) - pct(w.fromMs))}%;background:${w.tone === 'r' ? '#d0352b' : '#d29922'}"></div>`).join('')
    + [24, 48].map((h) => `<div class="btick" style="left:${(h * HOUR / span) * 100}%"></div>`).join('');

  const lanes = (f.lanes || []).map((lane) => {
    const bars = lane.segs.filter((s) => s.toMs > startMs && s.fromMs < endMs).map((s) => {
      const t = TONE[s.tone] || TONE.u;
      const bg = lane.key === 'sky' && s.cat ? CAT[s.cat] : t.bg;
      const left = pct(s.fromMs), w = Math.max(0.4, pct(s.toMs) - pct(s.fromMs));
      return `<div class="bar${s.dashed ? ' dash' : ''}" style="left:${left}%;width:${w}%;color:${t.fg};background:${bg};border-color:${t.bd}" title="${esc(s.detail)}">${esc(s.short || s.label)}</div>`;
    }).join('');
    const unk = lane.unknown ? `<div class="bar dash" style="left:0;width:100%;color:${TONE.u.fg};border-color:${TONE.u.bd}" title="UNKNOWN — ${esc(lane.unknown)}">UNKNOWN</div>` : '';
    return `<div class="lane"><div class="lbl">${esc(lane.title)}</div><div class="track">${bars}${unk}</div></div>`;
  }).join('');

  const temp = tempSvg(f, startMs, span);
  const evts = (f.events || []).filter((e) => e.ms > startMs && e.ms < endMs)
    .map((e) => `<div class="evt" style="left:${xcalc(e.ms)}"><span>${esc(e.kind)}</span></div>`).join('');

  const wins = (f.windows || []).length
    ? `<div class="wins"><div class="winh">Limiting windows</div>${f.windows.map((w) => `<div class="win"><b>${esc(rangeLabel(w.fromMs, w.toMs))}</b> — ${esc(w.factors.map((fa) => `${fa.label}`).join(', '))}<br>${esc(w.text)}</div>`).join('')}</div>`
    : `<div class="wins"><div class="nowin">No limiting window in the next ${f.hours} h.</div></div>`;

  return `<div class="field"><div class="fh"><b>${esc(f.icao)}</b>${f.name ? `<span class="fname">${esc(f.name)}</span>` : ''}<div class="band">${band}</div><span class="fsum">${esc(f.summary || '')}</span></div>
    <div style="position:relative">${lanes}
    <div class="lane"><div class="lbl">Temp <small>${f.temp && f.temp.minC != null ? Math.round(f.temp.minC) + '/' + Math.round(f.temp.maxC) + '°' : ''}</small></div><div class="track temp">${temp}</div></div>
    ${evts}</div>${wins}</div>`;
}

function tempSvg(f, startMs, span) {
  const pts = (f.temps || []).filter((x) => x.c != null);
  if (pts.length < 2) return '';
  const cs = pts.map((x) => x.c), min = Math.min(...cs, 0), max = Math.max(...cs, 0), H = 44, pad = 4;
  const x = (t) => ((t - startMs) / span) * 100, y = (c) => pad + (1 - (c - min) / (max - min || 1)) * (H - 2 * pad);
  const path = (sel) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)},${y(sel(p)).toFixed(2)}`).join(' ');
  const shade = pts.filter((p) => p.c <= 0).map((p) => `<rect class="shade" x="${x(p.t).toFixed(2)}" y="0" width="${(100 / (span / HOUR)).toFixed(3)}" height="${H}"/>`).join('');
  const dew = pts.every((p) => p.dew != null) ? `<path class="dew" d="${path((p) => p.dew)}"/>` : '';
  const cross = (f.temp?.crossings || []).map((c) => `<line class="cross" x1="${x(c.t).toFixed(2)}" y1="0" x2="${x(c.t).toFixed(2)}" y2="${H}"/><text class="crosst" x="${x(c.t).toFixed(2)}" y="9">${c.dir === 'down' ? '↓0°' : '↑0°'}</text>`).join('');
  return `<svg class="t" viewBox="0 0 100 ${H}" preserveAspectRatio="none">${shade}<line class="zero" x1="0" y1="${y(0).toFixed(2)}" x2="100" y2="${y(0).toFixed(2)}"/>${dew}<path class="tline" d="${path((p) => p.c)}"/>${cross}</svg>`;
}
