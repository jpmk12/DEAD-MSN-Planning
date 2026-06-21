// Ingest AP/1B (DoD FLIP) IR/VR routes + AR refueling tracks into the bundled
// datasets (data/mtr-ap1b.json, data/ar-ap1b.json). SR routes are intentionally
// skipped. Existing route ids are PRESERVED (curated entries win); new ones are
// appended.
//
// AP/1B is a ~1100-page PDF; this script parses a PLAIN-TEXT extraction of it so
// the repo stays dependency-free. Produce the text first, e.g.:
//   pdftotext ap1b.pdf ap1b.txt          # poppler, if available
//   # or with pdfjs-dist (pure JS):
//   #   npm i -D pdfjs-dist && node -e "..."  (see docs/ — getTextContent per page,
//   #   join item.str, prefix each page with \f[PAGE n])
// Then:  node scripts/ingest-ap1b.mjs path/to/ap1b.txt
//
// Why text-first: the OCR text layer prints an explicit Lat/Long for every route
// point (e.g. "N36°04.00' W84°39.00'"), distinct from the hyphen format used for
// hazard coords — so geometry is extracted directly, no radial/DME math needed.
// Guardrails (never fabricate): coordinates must fall in a CONUS/AK/HI box, and
// any route with a leg > 400 NM (a tell-tale OCR/parse error) is EXCLUDED and
// reported rather than shipped with a wrong straight-line.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dm = (d, m) => Number(d) + Number(m) / 60;
const inBox = (lat, lon) => lat > 12 && lat < 75 && lon > -180 && lon < -50;
const nm = (a, b) => { const R = 3440.065, t = Math.PI / 180; const dLa = (b[0] - a[0]) * t, dLo = (b[1] - a[1]) * t; const s = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const COORD = /([NS])\s*(\d{1,2})°\s*([\d.]+)'?\s*([EW])\s*(\d{1,3})°\s*([\d.]+)'?/g;

/** Parse all IR/VR route definitions out of the AP/1B text. */
export function parseMtr(text) {
  const out = [], flags = [];
  const starts = [...text.matchAll(/\b(IR|VR)-(\d{1,4}[A-Z]?)\s+ORIGINATING ACTIVITY:/g)];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i], type = m[1], id = `${type}-${m[2]}`;
    const block = text.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : m.index + 9000);
    const ai = block.search(/Altitude Data|Fac\/Rad\/Dist|Lat\/Long/i);
    const tail = ai >= 0 ? block.slice(ai) : block;
    const pts = []; let c; COORD.lastIndex = 0;
    while ((c = COORD.exec(tail)) !== null) {
      const lat = dm(c[2], c[3]) * (c[1] === 'S' ? -1 : 1);
      const lon = dm(c[5], c[6]) * (c[4] === 'W' ? -1 : 1);
      if (!inBox(lat, lon)) continue;
      const pre = tail.slice(Math.max(0, c.index - 45), c.index);
      const a = [...pre.matchAll(/(\d{1,3})\s*MSL/g)].pop();
      pts.push({ lat: +lat.toFixed(5), lon: +lon.toFixed(5), ceilFt: a ? Number(a[1]) * 100 : null });
    }
    if (pts.length < 2) continue;
    const agency = (block.match(/ORIGINATING ACTIVITY:\s*([^.]{3,90})/) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
    const widthNote = (block.match(/ROUTE WIDTH[^.]{0,160}\./i) || [])[0]?.replace(/\s+/g, ' ').trim() || '';
    const w = widthNote.match(/(\d+(?:\.\d+)?)\s*NM either side/i);
    const segs = [];
    for (let k = 0; k < pts.length - 1; k++) {
      if (nm([pts[k].lat, pts[k].lon], [pts[k + 1].lat, pts[k + 1].lon]) < 0.1) continue; // OCR repeat
      const ceil = pts[k + 1].ceilFt ?? pts[k].ceilFt ?? 10000;
      const seg = { name: `P${k + 1} → P${k + 2}`, points: [[pts[k].lat, pts[k].lon], [pts[k + 1].lat, pts[k + 1].lon]], floorFt: 0, ceilingFt: ceil, altText: `SFC–${ceil} MSL` };
      if (w) { seg.widthLeftNm = +w[1]; seg.widthRightNm = +w[1]; }
      segs.push(seg);
    }
    if (!segs.length) continue;
    const maxLeg = Math.max(...segs.map((s) => nm(s.points[0], s.points[1])));
    if (maxLeg > 400) { flags.push(`${id}: ${Math.round(maxLeg)} NM leg (excluded)`); continue; }
    out.push({ id, type, name: id, agency, widthNote, source: 'ap1b', segments: segs });
  }
  return { routes: out, flags };
}

/** Parse AR refueling tracks (primary/East direction) out of the AP/1B text. */
export function parseAr(text) {
  const out = [];
  const s = text.search(/Chapter 5 REFUELING/i);
  const arText = s >= 0 ? text.slice(s) : text;
  const ds = [...arText.matchAll(/\bAR(\d{1,4}[A-Z]?)\b(?=\s*(?:\(East\)|\(West\)|[NS]\d|[A-Z]{2,4}\s+VOR))/g)];
  for (let i = 0; i < ds.length; i++) {
    const id = `AR${ds[i][1]}`;
    if (out.some((x) => x.id === id)) continue;
    const block = arText.slice(ds[i].index, i + 1 < ds.length ? ds[i + 1].index : ds[i].index + 1600);
    const cut = block.search(/\ba\.\s|\(West\)|REMARKS/i);
    const head = cut > 0 ? block.slice(0, cut) : block;
    const pts = []; let c; COORD.lastIndex = 0;
    while ((c = COORD.exec(head)) !== null) {
      const lat = dm(c[2], c[3]) * (c[1] === 'S' ? -1 : 1);
      const lon = dm(c[5], c[6]) * (c[4] === 'W' ? -1 : 1);
      if (inBox(lat, lon)) pts.push([+lat.toFixed(5), +lon.toFixed(5)]);
    }
    const segs = [];
    const altm = block.match(/(?:FL)?(\d{3,5})\s*\/\s*(?:FL)?(\d{3,5})/);
    const fl = (v) => (v.length >= 4 ? Number(v) : Number(v) * 100);
    const altText = altm ? `${altm[1].length >= 4 ? altm[1] : 'FL' + altm[1]}–${altm[2].length >= 4 ? altm[2] : 'FL' + altm[2]}` : '';
    const floorFt = altm ? fl(altm[1]) : 0, ceilingFt = altm ? fl(altm[2]) : 0;
    for (let k = 0; k < pts.length - 1; k++) {
      if (nm(pts[k], pts[k + 1]) < 0.1) continue;
      segs.push({ name: `P${k + 1} → P${k + 2}`, points: [pts[k], pts[k + 1]], floorFt, ceilingFt, altText });
    }
    if (segs.length < 1) continue;
    const agency = (block.match(/(?:FL|\d)\d{2,4}\s+(\d{1,3}\s+[A-Z]{2,5}[^.]{0,40}?(?:AFB|ANGB|IAP|NAS|Field)[^.]{0,30})/) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
    out.push({ id, type: 'AR', name: `${id} — Air Refueling`, agency, refuelAlt: altText, source: 'ap1b', segments: segs });
  }
  return { routes: out };
}

function merge(path, fresh) {
  let existing = []; try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { /* none */ }
  const arr = Array.isArray(existing) ? existing : (existing.routes || []);
  const have = new Set(arr.map((r) => r.id)); // existing curated entries win
  const added = fresh.filter((r) => !have.has(r.id));
  return { merged: [...arr, ...added], kept: arr.length, added: added.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const txtPath = process.argv[2];
  if (!txtPath) { console.error('usage: node scripts/ingest-ap1b.mjs <ap1b.txt>'); process.exit(1); }
  const text = readFileSync(txtPath, 'utf8').replace(/\f\[PAGE \d+\]/g, ' ');
  const repo = fileURLToPath(new URL('../data', import.meta.url));
  const mtr = parseMtr(text), ar = parseAr(text);
  const mM = merge(`${repo}/mtr-ap1b.json`, mtr.routes);
  const aM = merge(`${repo}/ar-ap1b.json`, ar.routes);
  writeFileSync(`${repo}/mtr-ap1b.json`, JSON.stringify(mM.merged, null, 1) + '\n');
  writeFileSync(`${repo}/ar-ap1b.json`, JSON.stringify(aM.merged, null, 1) + '\n');
  console.log(`mtr-ap1b.json: ${mM.merged.length} (kept ${mM.kept}, added ${mM.added})`);
  console.log(`ar-ap1b.json:  ${aM.merged.length} (kept ${aM.kept}, added ${aM.added})`);
  if (mtr.flags.length) { console.log(`excluded (broken):`); mtr.flags.forEach((f) => console.log('  ' + f)); }
}
