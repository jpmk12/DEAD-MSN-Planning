# Weather Map Component — Reusable Build Spec

A self-contained spec for the interactive aviation **weather map** used in DEAD
Planning, written so another project (or another AI instance) can rebuild an
equivalent component from scratch. It is a dependency-free, no-build slippy map:
a dark basemap + animatable weather radar + an SVG vector overlay of hazards and
routes, with pan/zoom, layer toggles, a radar time-loop, and PNG snapshot export.

Reference implementation: `public/map.js` (~700 lines, vanilla ES module, zero
runtime deps). Everything below is framework-agnostic — port it to React/Svelte/
Leaflet/MapLibre as you like; the data contract and source URLs are the reusable
core.

---

## 1. Goals & constraints

- **Zero dependencies, no build.** Pure DOM + SVG + Canvas. No Leaflet/Mapbox.
  (If your project allows libs, MapLibre GL + these sources is a faster path —
  see §12.)
- **Outbound HTTPS (443) only.** Every tile/API host must be https. No websockets.
- **Never fabricate.** If a source fails, hide that layer / show "UNAVAILABLE" —
  do not invent data.
- **Self-hosting-friendly.** All sources are free, key-less, CORS-friendly.
- **Mobile-first interaction.** Pointer events (touch + mouse), pinch optional.

---

## 2. Architecture (three stacked layers in a viewport)

```
.map-viewport  (position:relative, fixed/resizable height, overflow:hidden)
 ├─ .map-tiles.base     (div; <img> raster tiles — dark basemap)
 ├─ .map-tiles.radar    (div; <img> raster tiles — radar; opacity + mix-blend:screen)
 └─ svg.map-overlay     (absolute inset:0; pointer-events:none; vector hazards/routes)
+ .map-controls (layer toggles, opacity slider, legend/times buttons)
+ .map-nav      (zoom +/−, recenter)
+ .map-radarbar (play/pause, frame scrubber, frame-time label)
+ .map-legend / .map-times / .map-attrib  (popovers / caption)
```

State object (single source of truth, re-render on change):
```js
state = {
  lat, lon, zoom,                 // viewport center + zoom (Web Mercator)
  radar, airspace, wx, pireps, conv, mtr,  // layer on/off booleans
  opacity,                        // radar layer opacity 0..1
  radarFrames: [], radarHost: '', radarIdx, radarNowIdx, radarPlaying,
}
```

---

## 3. Projection & tiling (Web Mercator / "slippy map" XYZ)

Standard EPSG:3857. Tile size `TILE = 256`. At zoom `z` the world is `2^z` tiles.

```js
// lon/lat -> world pixel coords at zoom z
function project(lat, lon, z) {
  const n = 2 ** z * TILE;
  const x = (lon + 180) / 360 * n;
  const s = Math.sin(lat * Math.PI / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x, y };
}
// inverse (for drag-pan): world pixel -> lon/lat
function unproject(x, y, z) {
  const n = 2 ** z * TILE;
  const lon = x / n * 360 - 180;
  const k = Math.PI - 2 * Math.PI * y / n;
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(k) - Math.exp(-k)));
  return { lat, lon };
}
// meters-per-pixel + a NM->px helper for range rings
const mppAt = (lat, z) => 156543.03392804097 * Math.cos(lat * Math.PI / 180) / 2 ** z;
const nmToPx = (nm, lat, z) => (nm * 1852) / mppAt(lat, z);
```

Render a raster layer by laying absolutely-positioned `<img>` tiles covering the
viewport, given the top-left world-pixel of the view:

```js
function renderTileLayer(layerEl, urlFn /* (z,x,y)->url */, z, topLeft) {
  layerEl.innerHTML = '';
  const n = 2 ** z;
  const x0 = Math.floor(topLeft.x / TILE), y0 = Math.floor(topLeft.y / TILE);
  const x1 = Math.ceil((topLeft.x + W) / TILE), y1 = Math.ceil((topLeft.y + H) / TILE);
  for (let tx = x0; tx < x1; tx++) for (let ty = y0; ty < y1; ty++) {
    if (ty < 0 || ty >= n) continue;
    const wx = ((tx % n) + n) % n;                 // wrap longitudinally
    const img = new Image();
    img.className = 'map-tile';                     // position:absolute; 256x256
    img.loading = 'lazy';
    img.src = urlFn(z, wx, ty);
    img.style.left = `${tx * TILE - topLeft.x}px`;
    img.style.top  = `${ty * TILE - topLeft.y}px`;
    img.onerror = () => { img.style.visibility = 'hidden'; }; // honest: blank, not broken
    layerEl.appendChild(img);
  }
}
// topLeft = { x: project(lat,lon,z).x - W/2, y: project(lat,lon,z).y - H/2 }
```

---

## 4. Tile & data sources (all free, key-less, HTTPS)

| Layer | Source | URL template / endpoint | Notes |
|---|---|---|---|
| **Dark basemap** | CARTO | `https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png` | Also `b.`/`c.` subdomains. Attribution: © OpenStreetMap, © CARTO. |
| **Radar (static)** | Iowa Env. Mesonet (IEM) | `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png` | US NEXRAD base reflectivity, latest mosaic. Best US resolution; CORS-ok. |
| **Radar (animated)** | RainViewer | index: `https://api.rainviewer.com/public/weather-maps.json` → frame tiles: `${host}${frame.path}/256/{z}/{x}/{y}/{color}/{opts}.png` | Global. `host` + `radar.past[]` (last ~2h) + `radar.nowcast[]` (~30 min). color scheme `2`, opts `1_1` (smoothed). |

Vector hazard data is **app-provided** (fetched server-side from NOAA AWC / FAA /
SPC and passed into the map as the `data` object — see §6). The map itself only
fetches the **radar frame index** (RainViewer JSON) directly.

> Honesty note: public radar has **no multi-hour forecast** — only ~2h past +
> ~30 min nowcast. For times beyond that, show a convective/outlook overlay as a
> surrogate and label radar UNAVAILABLE; never extrapolate.

---

## 5. Radar time-loop (animation)

```js
async function fetchRadarFrames() {
  const j = await (await fetch('https://api.rainviewer.com/public/weather-maps.json',
                               { cache: 'no-store' })).json();
  const host = j.host || 'https://tilecache.rainviewer.com';
  const past = (j.radar?.past || []).map(f => ({ time: f.time, path: f.path, kind: 'past' }));
  const now  = (j.radar?.nowcast || []).map(f => ({ time: f.time, path: f.path, kind: 'nowcast' }));
  const frames = [...past, ...now];
  return frames.length ? { host, frames, nowIdx: Math.max(0, past.length - 1) } : null;
}
const frameUrl = (host, f) => (z, x, y) => `${host}${f.path}/256/${z}/${x}/${y}/2/1_1.png`;
```
- A **play/pause** button advances `radarIdx` on a ~600 ms interval (re-render the
  radar layer only, not base/overlay — browser caches tiles after first loop).
- A **range scrubber** (`<input type=range>` 0..frames-1) jumps to a frame.
- A **time label** shows the frame's Zulu time + relative offset
  (`now`, `−40m`, `+20m nowcast`) using `frame.time` (epoch seconds).
- **Fallback:** if RainViewer is unreachable, keep the static IEM layer and hide
  the radar bar (no animation, but radar still shows).

---

## 6. Data contract (`initMap(container, data)`)

The map is pure-render: pass it one `data` object. All geometry is `[lat, lon]`.

```ts
type LatLon = [number, number];
type Geometry =
  | { kind: 'circle';  lat: number; lon: number; radiusNm: number }
  | { kind: 'polygon'; points: LatLon[] }
  | { kind: 'line';    points: LatLon[] };

interface MapData {
  airfields:  { icao: string; lat: number; lon: number; status?: 'GO'|'CAUTION'|'NO-GO' }[];
  navaids:    { icao: string; lat: number; lon: number; type?: string; status?: string }[];
  tfrs:       { id: string; geometry: Geometry; type?: string; ... }[];
  sua:        { id: string; geometry: Geometry; status?: 'active'|'scheduled'|'cold' }[];
  sigmets:    { id: string; geometry: Geometry; hazard?: string; type?: 'SIGMET'|'AIRMET' }[];
  pireps:     { lat: number; lon: number; urgent?: boolean; turb?: boolean; ice?: boolean }[];
  convective: { geometry: Geometry; risk: 'TSTM'|'MRGL'|'SLGT'|'ENH'|'MDT'|'HIGH' }[];
  mtrs:       { id: string; type: 'IR'|'VR'|'AR'; geometry: Geometry }[];   // low-level/AR routes
  routeOfFlight?: { points: LatLon[] } | null;                              // drawn connectors
  validity?:  { id?: string; k: string; v: string }[];                     // "valid times" caption
  focus?:     { lat: number; lon: number }[];  // initial fit
  home?:      { lat: number; lon: number }[];  // recenter target
}
```

Drawing the overlay: convert each `[lat,lon]` to screen coords with
`scr(lat,lon) = project(lat,lon,z) - topLeft`, then append SVG elements.

Marker/style conventions (carry these for instant familiarity):
- **Airfield** dot colored by status: GO `#3fb950`, CAUTION `#d29922`, NO-GO
  `#f85149`; plus a **10 NM range ring** (`nmToPx(10, lat, z)`).
- **Navaid** triangle: VOR/TACAN `#37b6c3`, fix/waypoint `#b39ddb`.
- **PIREP** diamond: urgent `#f85149`, turb/ice `#d29922`, routine `#37b6c3`.
- **TFR** polygon: VIP/security `#f85149`, hazard/stadium `#d29922`.
- **SUA** polygon by status: active `#f85149`, scheduled `#d29922`, cold `#5b6878`.
- **SIGMET** `#f85149` (convective) / `#d29922` (other); **AIRMET** `#8a7bd8`;
  fill at ~12% alpha.
- **Convective outlook** polygon ramped TSTM→HIGH: `#3fb950,#6fae46,#d29922,
  #e8833a,#f85149,#d6409f` at ~18% alpha.
- **Routes**: low-level (IR/VR) `#3fb950`, A/R track `#4aa3df`, route-of-flight
  connectors `#f0b429`.

---

## 7. Controls & interaction

- **Layer toggles** (checkboxes): radar, airspace (TFR+SUA), wx (SIGMET/AIRMET),
  pireps, conv (convective), mtr (routes). Each flips a `state.*` bool → re-render.
- **Opacity slider** (0–100) → `radarLayer.style.opacity`.
- **Zoom** +/− buttons and **mouse wheel** (clamp z to ~2..12). **Recenter** ⌂
  fits to `data.home`.
- **Drag-pan** via pointer events with pointer capture:
  ```js
  viewport.onpointerdown = e => { drag = {x:e.clientX,y:e.clientY,lat:state.lat,lon:state.lon,z:state.zoom};
                                  viewport.setPointerCapture(e.pointerId); };
  viewport.onpointermove = e => { if(!drag) return;
    const c = project(drag.lat, drag.lon, drag.z);
    const np = unproject(c.x-(e.clientX-drag.x), c.y-(e.clientY-drag.y), drag.z);
    state.lat = clamp(np.lat,-85,85); state.lon = np.lon; render(); };
  ```
- **Resizable viewport** (CSS `resize:vertical`); persist height in
  `localStorage` so it survives re-renders/reloads.
- **fitView(points, w, h)**: compute the zoom whose bbox of `points` fits the
  viewport (with padding), and the center lat/lon. Used on first render + recenter.
- **Legend** and **valid-times** popovers toggled by buttons.

---

## 8. PNG snapshot / export

For "save brief as image": draw the visible tiles + overlay to a `<canvas>` and
`toDataURL('image/png')`.
- Load each tile via `new Image()` with `crossOrigin='anonymous'` (CARTO, IEM,
  RainViewer all send permissive CORS), draw at the same offsets as the live tiles,
  then draw the SVG overlay (serialize SVG → `Image` → drawImage).
- **CORS-taint fallback:** if a radar tile taints the canvas (some mirrors don't
  send CORS), retry the snapshot with radar omitted so a base+overlay image still
  saves. Never throw — return null and let the caller skip the image.

---

## 9. Suggested file/DOM layout

- `map.js` — `export function initMap(container, data)`; returns `{ render, snapshot, destroy }`.
- CSS classes used: `.map-panel .map-viewport .map-tiles(.base|.radar) .map-overlay
  .map-controls .map-toggle .map-nav .map-legend .map-times .map-radarbar
  .map-attrib .map-tile`. (Copy the rules from `public/theme.css` `@media`-free
  section + the `.map-*` block.)

---

## 10. Print/kneeboard

If you print the page, hide the interactive map (`@media print { .map-section{display:none} }`)
or render a static snapshot in its place; raster tiles rarely print usefully and
the interactive controls are meaningless on paper.

---

## 11. Attribution & licensing (required)

Render a small caption: **"© OpenStreetMap, © CARTO · radar: RainViewer / IEM
NEXRAD"**. CARTO basemaps require OSM+CARTO attribution; RainViewer and IEM are
free for non-abusive use — keep requests modest (cache the frame index; don't
hammer tiles). Check each provider's current ToS before production.

---

## 12. If your project allows dependencies

The fastest equivalent is **MapLibre GL JS** (BSD) with:
- a dark vector/raster basemap style (CARTO `dark-matter` style or your own),
- a **raster source** per radar frame (RainViewer tiles) swapped on a timer for
  the loop,
- **GeoJSON sources + fill/line/circle layers** for the hazard overlay (convert
  the §6 geometries to GeoJSON features),
- MapLibre's built-in pan/zoom/markers/popups.
You keep the same data contract (§6) and source URLs (§4); MapLibre replaces the
hand-rolled projection (§3), tile loop (§3), and snapshot (§8, via
`map.getCanvas().toDataURL()` with `preserveDrawingBuffer:true`).

---

## 13. Minimal build checklist

- [ ] Web-Mercator project/unproject + `renderTileLayer` (§3)
- [ ] Base (CARTO) + radar (IEM static OR RainViewer animated) layers (§4–5)
- [ ] SVG overlay drawing the §6 geometries with the §6 color conventions
- [ ] Pan (pointer capture) + wheel zoom + fitView/recenter (§7)
- [ ] Layer toggles + radar opacity (§7)
- [ ] Radar time-loop: frame fetch, play/scrub, time label, honest fallback (§5)
- [ ] PNG snapshot with CORS-taint fallback (§8)
- [ ] Attribution caption (§11)
- [ ] All sources HTTPS; failed tiles/layers degrade silently, never fabricate
