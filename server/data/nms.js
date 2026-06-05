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

let tokenCache = null;   // { token, exp (epoch ms) }
let tokenInflight = null; // single-flight guard so concurrent callers share one refresh

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken(signal, force = false) {
  if (!force && tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  // Coalesce concurrent refreshes into one auth request (avoids a token storm
  // — and 429s on the auth endpoint — when several fields 401 at once).
  if (tokenInflight) return tokenInflight;
  const c = cfg();
  tokenInflight = (async () => {
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
  })();
  try { return await tokenInflight; }
  finally { tokenInflight = null; }
}

async function fetchLocation(icao, token, signal, attempt = 0) {
  const c = cfg();
  const url = `${c.base}/nmsapi/v1/notams?location=${encodeURIComponent(icao)}`;
  const res = await fetch(url, {
    signal,
    headers: { Authorization: `Bearer ${token}`, nmsResponseFormat: 'GEOJSON', Accept: 'application/json', 'User-Agent': 'C17MissionPlanner/1.0' },
  });
  if (res.status === 401) { const e = new Error('NMS 401'); e.code = 401; throw e; }
  // Transient (throttling / upstream hiccup): back off and retry so a momentary
  // failure on one field in a multi-airfield brief doesn't silently drop that
  // field's NOTAMs.
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await delay(300 * 2 ** attempt);
    return fetchLocation(icao, token, signal, attempt + 1);
  }
  if (!res.ok) throw new Error(`NMS notams ${res.status}`);
  const j = await res.json();
  const feats = j?.data?.geojson ?? [];
  // Force icao to the queried location — we requested ?location=ICAO, so all
  // results belong to it. NMS may tag them with a domestic id (CHS vs KCHS),
  // which would otherwise be filtered out per-field in the brief.
  return feats.map((f) => ({ ...mapNmsFeature(f, icao), icao: icao.toUpperCase() })).filter((x) => x.text);
}

/** Diagnostic probe: do a fresh token request + a NOTAM fetch for one field,
 *  surfacing the host, raw auth status/body, and response shape. Used by /api/diag. */
export async function nmsProbe(icao = 'KCHS', signal) {
  const c = cfg();
  const authUrl = `${c.base}/v1/auth/token`;
  const out = { base: c.base, authUrl };
  let token;
  try {
    const auth = Buffer.from(`${c.id}:${c.secret}`).toString('base64');
    const ar = await fetch(authUrl, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}`, 'User-Agent': 'C17MissionPlanner/1.0' },
      body: 'grant_type=client_credentials',
    });
    const txt = await ar.text();
    out.authStatus = ar.status;
    if (!ar.ok) { out.auth = 'failed'; out.authBody = txt.slice(0, 200); return out; }
    try { token = JSON.parse(txt).access_token; } catch { /* ignore */ }
    out.auth = token ? 'ok' : 'no-token';
    if (!token) { out.authBody = txt.slice(0, 200); return out; }
  } catch (e) {
    out.auth = 'error'; out.error = String(e).slice(0, 200); return out;
  }
  try {
    const r = await fetch(`${c.base}/nmsapi/v1/notams?location=${encodeURIComponent(icao)}`, {
      signal, headers: { Authorization: `Bearer ${token}`, nmsResponseFormat: 'GEOJSON', Accept: 'application/json', 'User-Agent': 'C17MissionPlanner/1.0' },
    });
    let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
    const feats = body?.data?.geojson ?? [];
    out.notamStatus = r.status;
    out.count = Array.isArray(feats) ? feats.length : 0;
    out.sample = (feats[0]?.properties?.coreNOTAMData?.notam?.text || '').slice(0, 90);
    out.dataKeys = body?.data ? Object.keys(body.data) : null;
    out.message = body?.message ?? null;
  } catch (e) {
    out.notamError = String(e).slice(0, 200);
  }
  return out;
}


/** Fetch raw (uncategorized) NOTAMs for a set of ICAOs from the NMS-API.
 *  Sequential by design: the NMS-API throttles concurrent bursts, which would
 *  make some fields in a multi-airfield brief come back empty. One field at a
 *  time (with retry/backoff in fetchLocation) is reliable for a handful of
 *  fields. A field that still fails after retries is skipped, not allowed to
 *  drop the others. */
export async function fetchNmsRaw(icaos, signal) {
  let token = await getToken(signal);
  const uniq = [...new Set(icaos.map((i) => i.toUpperCase()))];
  const out = [];
  for (const icao of uniq) {
    try {
      out.push(...await fetchLocation(icao, token, signal));
    } catch (e) {
      if (e.code === 401) {
        // Token expired mid-batch: refresh once and retry this field.
        token = await getToken(signal, true);
        try { out.push(...await fetchLocation(icao, token, signal)); }
        catch { /* still failing — skip this field, keep the rest */ }
      }
      /* non-401 after retries — skip this field, keep the rest */
    }
  }
  return out;
}
