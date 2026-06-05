// Self-contained slippy map — no external map library. Stacks raster tile
// layers (dark basemap + NEXRAD weather radar) and draws an SVG vector overlay
// for airfields, range rings, TFRs and SUA, using the tested projection math.
//
// Tiles need network at runtime; if they fail (offline), the vector overlay
// still renders against the dark backdrop so relative geometry stays useful.

import { project, tileXToLon, tileYToLat, fitView, TILE } from './projection.js';

const BASE_URL = (z, x, y) => `https://a.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;
const RADAR_URL = (z, x, y) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/${z}/${x}/${y}.png`;

const TFR_COLORS = { VIP: '#f85149', SECURITY: '#f85149', HAZARD: '#d29922', STADIUM: '#37b6c3', DEFAULT: '#d29922' };
const SUA_COLORS = { active: '#f85149', scheduled: '#d29922', cold: '#5b6878', DEFAULT: '#97a3b4' };

const mppAt = (lat, z) => (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
const nmToPx = (nm, lat, z) => (nm * 1852) / mppAt(lat, z);

export function initMap(container, data) {
  const airfields = (data.airfields || []).filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon));
  const tfrs = data.tfrs || [];
  const sua = data.sua || [];
  const sigmets = data.sigmets || [];
  const pireps = data.pireps || [];
  const convective = data.convective || [];
  const mtrs = data.mtrs || [];
  const CONV_COLOR = { TSTM: '#3fb950', MRGL: '#6fae46', SLGT: '#d29922', ENH: '#e8833a', MDT: '#f85149', HIGH: '#d6409f' };
  const MTR_COLOR = { IR: '#4aa3df', VR: '#c77dff', AR: '#46c6a0' };

  container.innerHTML = '';
  container.classList.add('map-panel');

  const viewport = document.createElement('div');
  viewport.className = 'map-viewport';
  const baseLayer = document.createElement('div');
  baseLayer.className = 'map-tiles';
  const radarLayer = document.createElement('div');
  radarLayer.className = 'map-tiles radar';
  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlay.setAttribute('class', 'map-overlay');
  viewport.append(baseLayer, radarLayer, overlay);

  const controls = document.createElement('div');
  controls.className = 'map-controls';
  controls.innerHTML = `
    <label class="map-toggle"><input type="checkbox" data-act="radar" checked> Radar</label>
    <label class="map-toggle"><input type="checkbox" data-act="airspace" checked> Airspace</label>
    <label class="map-toggle"><input type="checkbox" data-act="wx" checked> Wx</label>
    <label class="map-toggle"><input type="checkbox" data-act="pireps" checked> PIREP</label>
    <label class="map-toggle"><input type="checkbox" data-act="conv" checked> Conv</label>
    <label class="map-toggle"><input type="checkbox" data-act="mtr" checked> MTR</label>
    <input type="range" data-act="opacity" min="0" max="100" value="65" title="Radar opacity">
    <button data-act="legend" title="Toggle legend">?</button>`;

  // Zoom + recenter cluster (separate, bottom-right for thumb reach).
  const navc = document.createElement('div');
  navc.className = 'map-nav';
  navc.innerHTML = `
    <button data-act="in" title="Zoom in">+</button>
    <button data-act="out" title="Zoom out">−</button>
    <button data-act="recenter" title="Recenter">⌂</button>`;

  const legend = document.createElement('div');
  legend.className = 'map-legend';
  legend.style.display = 'none';
  legend.innerHTML = `
    <div class="lg-title">Legend</div>
    <div class="lg-row"><span class="lg-dot" style="background:#3fb950"></span><span class="lg-dot" style="background:#d29922"></span><span class="lg-dot" style="background:#f85149"></span> Airfield GO / CAUTION / NO-GO</div>
    <div class="lg-row"><span class="lg-ring"></span> 10 NM range ring</div>
    <div class="lg-row"><span class="lg-dia" style="background:#f85149"></span><span class="lg-dia" style="background:#d29922"></span><span class="lg-dia" style="background:#37b6c3"></span> PIREP urgent / turb-ice / routine</div>
    <div class="lg-row"><span class="lg-poly" style="border-color:#f85149;background:rgba(248,81,73,.12)"></span> Convective SIGMET</div>
    <div class="lg-row"><span class="lg-poly" style="border-color:#d29922;background:rgba(210,153,34,.12)"></span> SIGMET &nbsp; <span class="lg-poly" style="border-color:#8a7bd8;background:rgba(138,123,216,.12)"></span> AIRMET</div>
    <div class="lg-row"><span class="lg-poly" style="border-color:#d29922;background:rgba(210,153,34,.18)"></span> Convective outlook (TSTM→HIGH)</div>
    <div class="lg-row"><span class="lg-line" style="background:#4aa3df"></span> IR &nbsp; <span class="lg-line" style="background:#c77dff"></span> VR &nbsp; <span class="lg-line" style="background:#46c6a0"></span> AR track</div>
    <div class="lg-row lg-note">Radar = NEXRAD reflectivity overlay</div>`;

  const attribution = document.createElement('div');
  attribution.className = 'map-attrib';
  attribution.innerHTML = '© OpenStreetMap, © CARTO · radar: IEM NEXRAD';

  container.append(viewport, controls, navc, legend, attribution);

  const w = () => viewport.clientWidth || 600;
  const h = () => viewport.clientHeight || 360;

  // Center on airfields if present, otherwise on the route geometry (MTR lookup).
  const focusPts = airfields.length ? airfields
    : mtrs.flatMap((m) => (m.geometry?.points || []).map(([lat, lon]) => ({ lat, lon })));
  const state = { ...fitView(focusPts, w(), h(), { singleZoom: 9, maxZoom: 10 }), radar: true, airspace: true, wx: true, pireps: true, conv: true, mtr: true, opacity: 0.65 };

  function unproject(px, py, z) {
    return { lat: tileYToLat(py / TILE, z), lon: tileXToLon(px / TILE, z) };
  }

  function renderTileLayer(layer, urlFn, z, topLeft) {
    layer.innerHTML = '';
    const n = 2 ** z;
    const x0 = Math.floor(topLeft.x / TILE), y0 = Math.floor(topLeft.y / TILE);
    const x1 = Math.ceil((topLeft.x + w()) / TILE), y1 = Math.ceil((topLeft.y + h()) / TILE);
    for (let tx = x0; tx < x1; tx++) {
      for (let ty = y0; ty < y1; ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        const img = document.createElement('img');
        img.className = 'map-tile';
        img.loading = 'lazy';
        img.src = urlFn(z, wx, ty);
        img.style.left = `${tx * TILE - topLeft.x}px`;
        img.style.top = `${ty * TILE - topLeft.y}px`;
        img.onerror = () => { img.style.visibility = 'hidden'; };
        layer.appendChild(img);
      }
    }
  }

  function ring(cx, cy, r, stroke, opts = {}) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', Math.max(1, r));
    c.setAttribute('fill', opts.fill || 'none');
    c.setAttribute('stroke', stroke);
    c.setAttribute('stroke-width', opts.width || 1.5);
    if (opts.dash) c.setAttribute('stroke-dasharray', opts.dash);
    if (opts.opacity != null) c.setAttribute('opacity', opts.opacity);
    return c;
  }
  function label(x, y, text, color) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('fill', color);
    t.setAttribute('font-size', '11'); t.setAttribute('font-family', 'var(--mono)'); t.setAttribute('font-weight', '700');
    t.textContent = text;
    return t;
  }

  function polygon(points, scr, stroke, fillOpacity) {
    const d = points.map(([la, lo], i) => { const p = scr(la, lo); return `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`; }).join(' ') + ' Z';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', stroke);
    path.setAttribute('fill-opacity', String(fillOpacity));
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-dasharray', '7 5');
    return path;
  }

  function renderOverlay(z, topLeft) {
    overlay.setAttribute('width', w()); overlay.setAttribute('height', h());
    overlay.setAttribute('viewBox', `0 0 ${w()} ${h()}`);
    overlay.innerHTML = '';
    const scr = (lat, lon) => { const p = project(lat, lon, z); return { x: p.x - topLeft.x, y: p.y - topLeft.y }; };

    if (state.conv) {
      for (const c of convective) {
        if (!c.geometry || c.geometry.kind !== 'polygon') continue;
        overlay.appendChild(polygon(c.geometry.points, scr, CONV_COLOR[c.risk] || '#d29922', 0.12));
      }
    }

    if (state.mtr) {
      for (const m of mtrs) {
        const pts = m.geometry?.points;
        if (!pts || pts.length < 2) continue;
        const color = MTR_COLOR[m.type] || '#4aa3df';
        const d = pts.map(([la, lo], i) => { const p = scr(la, lo); return `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`; }).join(' ');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', '2.5');
        path.setAttribute('stroke-linejoin', 'round');
        overlay.appendChild(path);
        const sp = scr(pts[0][0], pts[0][1]);
        overlay.appendChild(label(sp.x + 6, sp.y - 4, m.id, color));
      }
    }

    if (state.wx) {
      for (const s of sigmets) {
        if (!s.geometry || s.geometry.kind !== 'polygon') continue;
        const color = s.hazard === 'CONVECTIVE' ? '#f85149' : s.type === 'SIGMET' ? '#d29922' : '#8a7bd8';
        overlay.appendChild(polygon(s.geometry.points, scr, color, 0.07));
      }
    }

    if (state.airspace) {
      for (const s of sua) {
        const g = s.geometry; if (!g) continue;
        const color = SUA_COLORS[s.status] || SUA_COLORS.DEFAULT;
        if (g.kind === 'circle') {
          const p = scr(g.lat, g.lon);
          overlay.appendChild(ring(p.x, p.y, nmToPx(g.radiusNm, g.lat, z), color, { dash: '6 5', opacity: 0.85, fill: color, width: 1.2 }));
          overlay.lastChild.setAttribute('fill-opacity', '0.06');
        }
      }
      for (const t of tfrs) {
        const g = t.geometry; if (!g || g.kind !== 'circle') continue;
        const color = TFR_COLORS[t.type] || TFR_COLORS.DEFAULT;
        const p = scr(g.lat, g.lon);
        const c = ring(p.x, p.y, nmToPx(g.radiusNm, g.lat, z), color, { width: 2, opacity: 0.9, fill: color });
        c.setAttribute('fill-opacity', '0.1');
        overlay.appendChild(c);
      }
    }

    if (state.pireps) {
      for (const r of pireps) {
        const pt = scr(r.lat, r.lon);
        const color = r.urgent ? '#f85149' : r.turb || r.ice ? '#d29922' : '#37b6c3';
        const dm = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        dm.setAttribute('d', `M${pt.x} ${pt.y - 5} L${pt.x + 5} ${pt.y} L${pt.x} ${pt.y + 5} L${pt.x - 5} ${pt.y} Z`);
        dm.setAttribute('fill', color);
        dm.setAttribute('stroke', '#0a0e14');
        dm.setAttribute('stroke-width', '1');
        overlay.appendChild(dm);
      }
    }

    for (const a of airfields) {
      const p = scr(a.lat, a.lon);
      const col = a.status === 'NO-GO' ? '#f85149' : a.status === 'CAUTION' ? '#d29922' : '#3fb950';
      overlay.appendChild(ring(p.x, p.y, nmToPx(10, a.lat, z), '#37b6c3', { dash: '3 5', opacity: 0.5 }));
      const dot = ring(p.x, p.y, 4, '#0a0e14', { fill: col, width: 2 });
      dot.setAttribute('stroke', '#0a0e14');
      overlay.appendChild(dot);
      overlay.appendChild(label(p.x + 8, p.y + 4, a.icao, '#e6edf3'));
    }
  }

  function render() {
    const z = state.zoom;
    const c = project(state.lat, state.lon, z);
    const topLeft = { x: c.x - w() / 2, y: c.y - h() / 2 };
    renderTileLayer(baseLayer, BASE_URL, z, topLeft);
    radarLayer.style.display = state.radar ? 'block' : 'none';
    radarLayer.style.opacity = state.opacity;
    if (state.radar) renderTileLayer(radarLayer, RADAR_URL, z, topLeft);
    renderOverlay(z, topLeft);
  }

  // --- interaction ---
  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, lat: state.lat, lon: state.lon, z: state.zoom };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = project(drag.lat, drag.lon, drag.z);
    const np = unproject(c.x - (e.clientX - drag.x), c.y - (e.clientY - drag.y), drag.z);
    state.lat = Math.max(-85, Math.min(85, np.lat));
    state.lon = np.lon;
    render();
  });
  const endDrag = (e) => { if (drag) { drag = null; viewport.classList.remove('dragging'); try { viewport.releasePointerCapture(e.pointerId); } catch {} } };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const next = state.zoom + (e.deltaY < 0 ? 1 : -1);
    state.zoom = Math.max(2, Math.min(12, next));
    render();
  }, { passive: false });

  const onNav = (e) => {
    const act = e.target.dataset?.act;
    if (act === 'in') { state.zoom = Math.min(12, state.zoom + 1); render(); }
    if (act === 'out') { state.zoom = Math.max(2, state.zoom - 1); render(); }
    if (act === 'recenter') { Object.assign(state, fitView(focusPts, w(), h(), { singleZoom: 9, maxZoom: 10 })); render(); }
    if (act === 'legend') { legend.style.display = legend.style.display === 'none' ? 'block' : 'none'; }
  };
  controls.addEventListener('click', onNav);
  navc.addEventListener('click', onNav);
  controls.addEventListener('input', (e) => {
    const act = e.target.dataset?.act;
    if (act === 'radar') { state.radar = e.target.checked; render(); }
    if (act === 'airspace') { state.airspace = e.target.checked; render(); }
    if (act === 'wx') { state.wx = e.target.checked; render(); }
    if (act === 'pireps') { state.pireps = e.target.checked; render(); }
    if (act === 'conv') { state.conv = e.target.checked; render(); }
    if (act === 'mtr') { state.mtr = e.target.checked; render(); }
    if (act === 'opacity') { state.opacity = e.target.value / 100; render(); }
  });

  // Initial paint (defer one frame so the viewport has a measured size).
  requestAnimationFrame(render);
  return { render, state };
}
