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
const DETAIL_URL = (id) => `https://tfr.faa.gov/save_pages/detail_${id}.xml`;

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

const tag = (xml, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
};
const allBlocks = (xml, name) => {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'ig');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
};

/** Geometry from one airspace area block: a circle if it has a center+radius,
 *  else a polygon from its <Avx> vertices. Returns null if neither is present. */
function geometryFromArea(area) {
  const latCen = parseDms(tag(area, 'geoLatCen') ?? tag(area, 'geoLatCenter'));
  const lonCen = parseDms(tag(area, 'geoLongCen') ?? tag(area, 'geoLongCenter'));
  const radius = Number(tag(area, 'valRadiusArc') ?? tag(area, 'valRadius'));
  if (latCen != null && lonCen != null && Number.isFinite(radius) && radius > 0) {
    const uom = (tag(area, 'uomRadiusArc') ?? 'NM').toUpperCase();
    const radiusNm = uom.startsWith('KM') ? radius / 1.852 : uom === 'M' ? radius / 1852 : radius;
    return { kind: 'circle', lat: latCen, lon: lonCen, radiusNm };
  }
  const points = allBlocks(area, 'Avx')
    .map((avx) => [parseDms(tag(avx, 'geoLat')), parseDms(tag(avx, 'geoLong'))])
    .filter(([la, lo]) => la != null && lo != null);
  return points.length >= 3 ? { kind: 'polygon', points } : null;
}

/** Parse one TFR detail XML into airspace records (one per area). */
export function tfrRecordsFromXml(xml, fallbackId = 'TFR') {
  if (!xml || typeof xml !== 'string') return [];
  const id = tag(xml, 'txtLocalName') || tag(xml, 'codeId') || fallbackId;
  const name = tag(xml, 'txtNameCity') || tag(xml, 'txtNameUSState') || tag(xml, 'txtLocalName') || 'TFR';
  const effectiveStart = tag(xml, 'dateEffective');
  const effectiveEnd = tag(xml, 'dateExpire');
  const areas = allBlocks(xml, 'aseTFRArea').length ? allBlocks(xml, 'aseTFRArea') : allBlocks(xml, 'Ase');
  const records = [];
  for (const area of areas) {
    const geometry = geometryFromArea(area);
    if (!geometry) continue;
    records.push({
      id: String(id),
      type: 'HAZARD',
      name: String(name),
      lowerFt: altFt(tag(area, 'valDistVerLower'), tag(area, 'uomDistVerLower')) ?? 0,
      upperFt: altFt(tag(area, 'valDistVerUpper'), tag(area, 'uomDistVerUpper')),
      effectiveStart,
      effectiveEnd,
      url: 'https://tfr.faa.gov',
      geometry,
    });
  }
  return records;
}

let cache = { at: 0, tfrs: null };
const TTL_MS = 10 * 60 * 1000;

/** Extract detail ids (e.g. "4_3344") from the TFR list HTML. */
export function tfrIdsFromList(html) {
  const ids = new Set();
  const re = /detail_([0-9]+_[0-9]+)\.xml/ig;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

/**
 * Fetch + parse active FAA TFRs. Throws on a network/HTTP failure (so the caller
 * shows UNAVAILABLE); returns [] when the list is reachable but has no TFRs.
 * @returns {Promise<any[]>}
 */
export async function fetchLiveTfrs(signal) {
  if (cache.tfrs && Date.now() - cache.at < TTL_MS) return cache.tfrs;
  const sig = signal ?? AbortSignal.timeout(9000);
  const listRes = await fetch(LIST_URL, { signal: sig, headers: { Accept: 'text/html' } });
  if (!listRes.ok) throw new Error(`TFR list ${listRes.status}`);
  const ids = tfrIdsFromList(await listRes.text()).slice(0, 60);
  const settled = await Promise.allSettled(
    ids.map(async (id) => {
      const r = await fetch(DETAIL_URL(id), { signal: sig, headers: { Accept: 'application/xml' } });
      if (!r.ok) return [];
      return tfrRecordsFromXml(await r.text(), id);
    }),
  );
  const tfrs = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  cache = { at: Date.now(), tfrs };
  return tfrs;
}
