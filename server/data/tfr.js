// Live TFR (Temporary Flight Restriction) adapter.
//
// The FAA publishes active TFRs at tfr.faa.gov: an HTML list that links to a
// per-TFR detail XML at /save_pages/detail_<id>.xml. There is no clean GeoJSON
// feed, so we fetch the list, pull each detail XML, and parse its geometry +
// altitudes into our airspace record shape. Pure parsing helpers are unit-tested;
// the network orchestration is defensive (timeout, cap, cache) and FAILS to an
// empty/throw result so the caller can show UNAVAILABLE — never fabricated data.
//
// XML is parsed with focused regexes (no XML dependency — this app is near-zero
// -dep). The detail XML carries vertices as <Avx><geoLat>/<geoLong></Avx> and
// circles as <geoLatCen>/<geoLongCen>/<valRadiusArc>, with FAA coordinate
// strings like "385230.00N" / "0771500.00W".

const LIST_URL = 'https://tfr.faa.gov/tfr2/list.html';
const DETAIL_URL = (id) => `https://tfr.faa.gov/download/detail_${id}.xml`;

/** Parse an FAA coordinate string ("385230.00N", "3852N", "0771500W", or a
 *  plain decimal) into signed decimal degrees. Returns null if unparseable. */
export function parseDms(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  const m = /^(\d+(?:\.\d+)?)\s*([NSEW])$/.exec(s);
  if (!m) {
    const d = Number(s);
    return Number.isFinite(d) ? d : null;
  }
  const hemi = m[2];
  const isLon = hemi === 'E' || hemi === 'W';
  const degLen = isLon ? 3 : 2;
  const dot = m[1].indexOf('.');
  const intPart = dot >= 0 ? m[1].slice(0, dot) : m[1];
  const frac = dot >= 0 ? m[1].slice(dot) : '';
  let deg;
  let min = 0;
  let sec = 0;
  if (intPart.length <= degLen) {
    deg = Number(intPart + frac);
  } else if (intPart.length <= degLen + 2) {
    deg = Number(intPart.slice(0, degLen));
    min = Number(intPart.slice(degLen) + frac);
  } else {
    deg = Number(intPart.slice(0, degLen));
    min = Number(intPart.slice(degLen, degLen + 2));
    sec = Number(intPart.slice(degLen + 2) + frac);
  }
  let val = deg + min / 60 + sec / 3600;
  if (hemi === 'S' || hemi === 'W') val = -val;
  return Number.isFinite(val) ? val : null;
}

/** Convert an FAA vertical limit (value + unit of measure) to feet MSL.
 *  SFC/GND -> 0, UNL/UNLTD -> null (unlimited), FL -> hundreds of feet. */
export function altFt(value, uom) {
  const v = String(value ?? '').trim().toUpperCase();
  const u = String(uom ?? '').trim().toUpperCase();
  if (v === '' ) return null;
  if (v === 'SFC' || v === 'GND') return 0;
  if (v === 'UNL' || v === 'UNLTD' || v === 'UNLIMITED') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (u === 'FL') return n * 100;
  return n; // already feet
}

// Exact element match: the char after the name must be '>' or whitespace, so
// `tag(x,'geoLat')` does NOT match a sibling <geoLatArc> (the prefix collision
// that was silently dropping arc-edged TFR vertices).
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
};
const allBlocks = (xml, name) => {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'ig');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
};

/** Geometry from one boundary block (FAA AIXM <Abd>, or an area that embeds its
 *  own vertices): a circle if it carries a center+radius (often inside an arc
 *  <Avx>), else a polygon from its <Avx> <geoLat>/<geoLong> vertices. */
function geometryFromBoundary(blk) {
  const radius = Number(tag(blk, 'valRadiusArc') ?? tag(blk, 'valRadius'));
  const latCen = parseDms(tag(blk, 'geoLatArc') ?? tag(blk, 'geoLatCen') ?? tag(blk, 'geoLatCenter'));
  const lonCen = parseDms(tag(blk, 'geoLongArc') ?? tag(blk, 'geoLongCen') ?? tag(blk, 'geoLongCenter'));
  if (latCen != null && lonCen != null && Number.isFinite(radius) && radius > 0) {
    const uom = (tag(blk, 'uomRadiusArc') ?? 'NM').toUpperCase();
    const radiusNm = uom.startsWith('KM') ? radius / 1.852 : uom === 'M' ? radius / 1852 : radius;
    return { kind: 'circle', lat: latCen, lon: lonCen, radiusNm };
  }
  const points = allBlocks(blk, 'Avx')
    .map((avx) => [parseDms(tag(avx, 'geoLat')), parseDms(tag(avx, 'geoLong'))])
    .filter(([la, lo]) => la != null && lo != null);
  return points.length >= 3 ? { kind: 'polygon', points } : null;
}

/** Parse one TFR detail XML (FAA AIXM) into airspace records. Areas (<aseTFRArea>)
 *  hold the altitudes/name; geometry is in sibling <Abd> boundary blocks linked
 *  by codeId. Falls back to geometry embedded in the area if there are no <Abd>. */
export function tfrRecordsFromXml(xml, fallbackId = 'TFR') {
  if (!xml || typeof xml !== 'string') return [];
  const id = tag(xml, 'txtLocalName') || tag(xml, 'codeId') || fallbackId;
  const name = tag(xml, 'txtNameCity') || tag(xml, 'txtNameUSState') || tag(xml, 'txtName') || tag(xml, 'txtLocalName') || 'TFR';
  const effectiveStart = tag(xml, 'dateEffective');
  const effectiveEnd = tag(xml, 'dateExpire');

  // Area attributes keyed by codeId (altitudes + per-area name).
  const areaByCode = new Map();
  const areaList = [];
  for (const a of allBlocks(xml, 'aseTFRArea')) {
    const rec = {
      codeId: tag(a, 'codeId'),
      name: tag(a, 'txtName') || name,
      lowerFt: altFt(tag(a, 'valDistVerLower'), tag(a, 'uomDistVerLower')) ?? 0,
      upperFt: altFt(tag(a, 'valDistVerUpper'), tag(a, 'uomDistVerUpper')),
    };
    areaList.push(rec);
    if (rec.codeId) areaByCode.set(rec.codeId, rec);
  }

  // Build records from a set of boundary blocks (those that actually yield
  // geometry). Per-area <Abd> is preferred; if it yields nothing (e.g. the Abd
  // only holds AbdUid and the vertices live in <abdMergedArea>), fall back to the
  // merged union, then to geometry embedded in the areas. Fallback is by RESULT,
  // not element presence — an empty <Abd> must not block the merged area.
  const buildFrom = (blocks) => {
    const recs = [];
    blocks.forEach((blk, i) => {
      const geometry = geometryFromBoundary(blk);
      if (!geometry) return;
      const area = areaByCode.get(tag(blk, 'codeId')) || areaList[i] || areaList[0] || {};
      recs.push({
        id: String(id), type: 'HAZARD', name: String(area.name || name),
        lowerFt: area.lowerFt ?? 0, upperFt: area.upperFt ?? null,
        effectiveStart, effectiveEnd, url: 'https://tfr.faa.gov', geometry,
      });
    });
    return recs;
  };

  let records = buildFrom(allBlocks(xml, 'Abd'));
  if (!records.length) records = buildFrom(allBlocks(xml, 'abdMergedArea'));
  if (!records.length) records = buildFrom(allBlocks(xml, 'aseTFRArea'));
  return records;
}

let cache = { at: 0, tfrs: null };
let refreshing = null; // in-flight background refresh (stale-while-revalidate)
const TTL_MS = 10 * 60 * 1000;

// Per-NOTAM detail-XML cache. A TFR's geometry/altitudes are stable for its
// life, so cache the parsed records by notam id and reuse them across list
// refreshes — only newly-appeared TFRs are fetched. This makes the (otherwise
// heavy) ~N detail-XML pull cheap after the first load. TTL is kept modest so a
// same-id amendment is re-pulled within the window (the list itself, which
// catches new/removed TFRs, still refreshes every TTL_MS = 10 min).
const detailCache = new Map(); // notamId -> { at, recs }
const DETAIL_TTL_MS = 60 * 60 * 1000; // 1h

/** Extract detail ids (e.g. "4_3344") from the legacy TFR list HTML. */
export function tfrIdsFromList(html) {
  const ids = new Set();
  const re = /detail_([0-9]+_[0-9]+)\.xml/ig;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

// ---- tfr3 JSON list (preferred) -------------------------------------------
// tfr.faa.gov serves an HTML page to non-browser User-Agents, so present a
// browser UA here (unlike the AWC/ArcGIS feeds, which accept our app UA).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LIST_JSON_URL = 'https://tfr.faa.gov/tfrapi/exportTfrList';

/** Normalize a tfr3 list response to an array of items. */
export function tfrListItems(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.features)) return json.features; // GeoJSON
  for (const k of ['tfrList', 'tfrs', 'TFRList', 'data', 'items', 'NOTAMS', 'notams']) {
    if (Array.isArray(json[k])) return json[k];
  }
  return [];
}

const props = (item) => (item && item.properties ? item.properties : item) || {};

/** NOTAM id from a tfr3 item (field name varies). */
export function tfrIdOf(item) {
  const p = props(item);
  const raw = p.notam_id ?? p.NOTAM_ID ?? p.notamId ?? p.notam ?? p.Notam ?? p.id ?? null;
  return raw == null || raw === '' ? null : String(raw).trim();
}
const tfrNameOf = (item) => {
  const p = props(item);
  return String(p.description ?? p.txtDescr ?? p.NAME ?? p.facility ?? p.state ?? 'TFR');
};
/** "4/3344" -> "4_3344" (the detail XML id form). */
const detailIdFromNotam = (notamId) => String(notamId).replace(/\//g, '_').replace(/[^0-9_]/g, '');

/** GeoJSON-style geometry embedded directly in a list item, if present. */
function inlineGeometry(item) {
  const g = item?.geometry ?? item?.geom ?? null;
  if (!g || !g.type) return null;
  const ring = (coords) => coords.map(([lon, lat]) => [lat, lon]);
  if (g.type === 'Polygon' && g.coordinates?.[0]) return { kind: 'polygon', points: ring(g.coordinates[0]) };
  if (g.type === 'MultiPolygon' && g.coordinates?.[0]?.[0]) return { kind: 'polygon', points: ring(g.coordinates[0][0]) };
  if (g.type === 'Point' && g.coordinates) return { kind: 'circle', lat: g.coordinates[1], lon: g.coordinates[0], radiusNm: 5 };
  return null;
}

/**
 * Fetch + parse active FAA TFRs from the tfr3 JSON list. Prefers geometry
 * embedded in the list; otherwise pulls each TFR's detail XML for geometry.
 * Throws on a network/HTTP failure (caller shows UNAVAILABLE); returns [] when
 * the list is reachable but yields no usable TFRs.
 * @returns {Promise<any[]>}
 */
export async function fetchLiveTfrs() {
  const fresh = cache.tfrs && Date.now() - cache.at < TTL_MS;
  if (fresh) return cache.tfrs;
  // Stale-while-revalidate: the list+detail fetch is heavy (many XMLs), so when
  // the cache is stale return it immediately and refresh in the background. The
  // refresh uses its own internal timeout (never a caller's request signal, so
  // an unrelated request can't abort a shared refresh). Only a cold call awaits.
  if (!refreshing) {
    refreshing = loadTfrs()
      .then((tfrs) => { cache = { at: Date.now(), tfrs }; return tfrs; })
      .finally(() => { refreshing = null; });
  }
  if (cache.tfrs) { refreshing.catch(() => {}); return cache.tfrs; }
  return refreshing;
}

// Bounded-concurrency map so we don't open ~200 sockets to tfr.faa.gov at once.
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    out.push(...await Promise.all(batch.map((x) => fn(x).catch(() => []))));
  }
  return out;
}

async function loadTfrs() {
  const sig = AbortSignal.timeout(20000);
  const listUrl = process.env.TFR_JSON_URL || LIST_JSON_URL;
  const res = await fetch(listUrl, { signal: sig, headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`TFR list ${res.status}`);
  const items = tfrListItems(await res.json());

  // Use embedded geometry where present; collect ids for the rest.
  const direct = [];
  const ids = [];
  for (const item of items) {
    const geometry = inlineGeometry(item);
    const id = tfrIdOf(item);
    if (geometry) {
      direct.push({ id: id || `TFR-${direct.length}`, type: 'HAZARD', name: tfrNameOf(item), lowerFt: 0, upperFt: null, effectiveStart: null, effectiveEnd: null, url: 'https://tfr.faa.gov', geometry });
    } else if (id) {
      ids.push(id);
    }
  }

  // Fetch geometry for ALL active TFRs (proximity is applied later, by the
  // brief — so we must not pre-truncate by list order), with bounded concurrency.
  // Reuse cached per-NOTAM detail records; only fetch ids not already cached.
  let xmlRecs = [];
  if (ids.length) {
    const batches = await mapLimit(ids, 16, async (notamId) => {
      const hit = detailCache.get(notamId);
      if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.recs;
      const r = await fetch(DETAIL_URL(detailIdFromNotam(notamId)), { signal: sig, headers: { Accept: 'application/xml', 'User-Agent': UA } });
      if (!r.ok) return [];
      const recs = tfrRecordsFromXml(await r.text(), notamId);
      detailCache.set(notamId, { at: Date.now(), recs });
      return recs;
    });
    xmlRecs = batches.flat();
  }
  // Drop cache entries for TFRs no longer active so the map can't grow unbounded.
  const active = new Set(ids);
  for (const key of detailCache.keys()) if (!active.has(key)) detailCache.delete(key);

  return [...direct, ...xmlRecs];
}
