// DAIP (DoD Aeronautical Information Portal, daip.jcs.mil) client.
//
// DAIP serves NOTAMs / flight info but presents a DoD PKI server certificate
// whose issuing CA is not in the public trust store, so a default TLS fetch
// fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. To trust it, drop the public
// DoD PKI CA bundle (PEM) at data/dod-ca.pem (or point DOD_CA_PEM at it). We
// then trust those CAs *plus* the normal public roots, scoped to this request —
// no global trust change. (Server-cert trust only; if DAIP also requires a CAC
// client cert, that's a separate step.)

import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://www.daip.jcs.mil/daip/mobile/query';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let caCache; // undefined=unloaded, null=absent, string=pem bundle
let caPath = null;
let caError = null;
function dodCa() {
  if (caCache !== undefined) return caCache;
  caPath = process.env.DOD_CA_PEM || fileURLToPath(new URL('../../data/dod-ca.pem', import.meta.url));
  try { caCache = readFileSync(caPath, 'utf8'); caError = null; }
  catch (e) { caCache = null; caError = String(e && e.code ? e.code : e); }
  return caCache;
}

/** True when a DoD CA bundle is available to trust DAIP's certificate. */
export function dodCaLoaded() { return !!dodCa(); }
/** Diagnostics: where the CA bundle is expected and why it didn't load. */
export function dodCaInfo() { dodCa(); return { loaded: !!caCache, path: caPath, error: caError, certs: caCache ? (caCache.match(/BEGIN CERTIFICATE/g) || []).length : 0 }; }

/** The DAIP mobile-query payload for a single location (NOTAMs within radius). */
export function daipPayload(loc, radius = '10') {
  return {
    locs: String(loc || '').toLowerCase(), poa: '', pod: '', alternates: '', route: '', radius: String(radius),
    runwayLength: '', runwayWidth: '', airportType: '', type: 'LOCATION', notamId: '', acode: '', artcc: '',
    tfrsOnly: '', orgLoc: '', lat1: '', lat2: '', lng1: '', lng2: '', latdir: '', longdir: '',
    includeRegulatoryNotices: '', briefing: '', scheduleDate: '', sendTime: '', active: '',
    sunday: '', monday: '', tuesday: '', wednesday: '', thursday: '', friday: '', saturday: '', sort: 'Criticality',
  };
}

/** POST the DAIP mobile query, trusting the DoD CA bundle if present. */
export function daipQueryRaw(payload, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const ca = dodCa();
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json,*/*',
        'User-Agent': UA, 'Content-Length': Buffer.byteLength(body),
      },
    };
    if (ca) opts.ca = [ca, ...rootCertificates]; // DoD CAs + public roots
    const req = httpsRequest(ENDPOINT, opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('DAIP timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
