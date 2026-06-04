// FAA NOTAM Management System API (NMS-API) client.
//
// OAuth2 client-credentials: POST {base}/v1/auth/token (HTTP Basic id:secret)
// returns a short-lived bearer token (~30 min). NOTAMs are then fetched from
// {base}/nmsapi/v1/notams?location=ICAO with header nmsResponseFormat: GEOJSON.
//
// Config via env: NMS_CLIENT_ID, NMS_CLIENT_SECRET, NMS_API_BASE
// (default prod https://api-nms.aim.faa.gov). All outbound is HTTPS.

function cfg() {
  return {
    id: process.env.NMS_CLIENT_ID,
    secret: process.env.NMS_CLIENT_SECRET,
    base: (process.env.NMS_API_BASE || 'https://api-nms.aim.faa.gov').replace(/\/+$/, ''),
  };
}

export function nmsConfigured() {
  const c = cfg();
  return Boolean(c.id && c.secret);
}

/** Map one NMS GeoJSON NOTAM feature to our raw notam shape. */
export function mapNmsFeature(feature, fallbackIcao) {
  const n = feature?.properties?.coreNOTAMData?.notam ?? {};
  return {
    id: String(n.id ?? n.number ?? 'NMS'),
    icao: n.icaoLocation ?? n.location ?? fallbackIcao,
    text: n.text ?? '',
    effectiveStart: n.effectiveStart ?? null,
    effectiveEnd: n.effectiveEnd ?? null,
  };
}

let tokenCache = null; // { token, exp (epoch ms) }

async function getToken(signal, force = false) {
  if (!force && tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const c = cfg();
  const auth = Buffer.from(`${c.id}:${c.secret}`).toString('base64');
  const res = await fetch(`${c.base}/v1/auth/token`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}`, 'User-Agent': 'C17MissionPlanner/1.0' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`NMS auth ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('NMS auth: no access_token');
  tokenCache = { token: j.access_token, exp: Date.now() + Number(j.expires_in || 1799) * 1000 };
  return tokenCache.token;
}

async function fetchLocation(icao, token, signal) {
  const c = cfg();
  const url = `${c.base}/nmsapi/v1/notams?location=${encodeURIComponent(icao)}`;
  const res = await fetch(url, {
    signal,
    headers: { Authorization: `Bearer ${token}`, nmsResponseFormat: 'GEOJSON', Accept: 'application/json', 'User-Agent': 'C17MissionPlanner/1.0' },
  });
  if (res.status === 401) { const e = new Error('NMS 401'); e.code = 401; throw e; }
  if (!res.ok) throw new Error(`NMS notams ${res.status}`);
  const j = await res.json();
  const feats = j?.data?.geojson ?? [];
  return feats.map((f) => mapNmsFeature(f, icao)).filter((x) => x.text);
}

/** Diagnostic probe: hit the NMS NOTAM endpoint for one field and surface the
 *  raw status/shape (does not swallow errors). Used by /api/diag. */
export async function nmsProbe(icao = 'KCHS', signal) {
  try {
    const token = await getToken(signal);
    const c = cfg();
    const url = `${c.base}/nmsapi/v1/notams?location=${encodeURIComponent(icao)}`;
    const res = await fetch(url, {
      signal,
      headers: { Authorization: `Bearer ${token}`, nmsResponseFormat: 'GEOJSON', Accept: 'application/json', 'User-Agent': 'C17MissionPlanner/1.0' },
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    const feats = body?.data?.geojson ?? [];
    return {
      auth: 'ok',
      status: res.status,
      count: Array.isArray(feats) ? feats.length : 0,
      sample: (feats[0]?.properties?.coreNOTAMData?.notam?.text || '').slice(0, 90),
      bodyKeys: body ? Object.keys(body) : null,
      dataKeys: body?.data ? Object.keys(body.data) : null,
      message: body?.message || (res.ok ? null : `HTTP ${res.status}`),
    };
  } catch (e) {
    return { auth: 'failed', error: String(e).slice(0, 200) };
  }
}

/** Fetch raw (uncategorized) NOTAMs for a set of ICAOs from the NMS-API. */
export async function fetchNmsRaw(icaos, signal) {
  let token = await getToken(signal);
  const one = async (icao) => {
    try {
      return await fetchLocation(icao, token, signal);
    } catch (e) {
      if (e.code === 401) { token = await getToken(signal, true); return fetchLocation(icao, token, signal); }
      throw e;
    }
  };
  const lists = await Promise.all(icaos.map((i) => one(i).catch(() => [])));
  return lists.flat();
}
