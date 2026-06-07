// Ingest SID/STAR procedures from the FAA CIFP (ARINC 424 "FAACIFP18") into the
// format the app consumes (data/procedures.json):
//   { "KCHS": { "LGRHD3": { "_": [[lat,lon,"FIX"], ...],
//                            "IRQ": [[lat,lon,"FIX"], ...] } }, ... }
// where each procedure maps transition name -> ordered points ("_" = common /
// blank transition). Terminal-waypoint coordinates come from the CIFP's own PC
// records; enroute fixes/navaids are stored as [null,null,NAME] and resolved at
// runtime against the bundled NASR fixes + navaids.
//
// Source: FAA CIFP (public domain), file "FAACIFP18" (or a per-airport extract).
//   https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/
//   node scripts/ingest-faa-cifp.js path/to/FAACIFP18 [--out data/procedures.json]
//
// Records used (continental "S...P" airport section):
//   col13 = subsection: D=SID, E=STAR, C=terminal waypoint (coords)
//   7-10 airport · 14-19 procedure id · 21-25 transition · 27-29 seq
//   30-34 fix id · 35-36 region · 37 fix section · 38 fix subsection · 48-49 path/term

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// CIFP is ASCII, but a PowerShell ">" extract is UTF-16. Decode robustly.
function readText(path) {
  const buf = readFileSync(path);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const s = Buffer.from(buf); s.swap16(); return s.toString('utf16le'); }
  // Heuristic: many NUL bytes => UTF-16LE without BOM.
  let nul = 0; for (let i = 1; i < Math.min(buf.length, 2000); i += 2) if (buf[i] === 0) nul++;
  if (nul > 400) return buf.toString('utf16le');
  return buf.toString('latin1');
}

const C = (line, a, b) => line.slice(a - 1, b).trim(); // 1-based, inclusive

// Parse a CIFP lat/lon token: N/SDDMMSSss + E/WDDDMMSSss (ss = hundredths).
function parseCoord(line) {
  const m = /([NS])(\d{2})(\d{2})(\d{2})(\d{2})([EW])(\d{3})(\d{2})(\d{2})(\d{2})/.exec(line);
  if (!m) return null;
  let lat = Number(m[2]) + Number(m[3]) / 60 + Number(m[4] + '.' + m[5]) / 3600;
  let lon = Number(m[7]) + Number(m[8]) / 60 + Number(m[9] + '.' + m[10]) / 3600;
  if (m[1] === 'S') lat = -lat;
  if (m[6] === 'W') lon = -lon;
  return [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5];
}

function build(text) {
  const lines = text.split(/\r?\n/);
  // Pass 1: terminal-waypoint coordinates, keyed by airport|ident.
  const coords = new Map();
  for (const line of lines) {
    if (line[0] !== 'S' || line[4] !== 'P' || line[12] !== 'C') continue; // airport terminal waypoint
    const apt = C(line, 7, 10), id = C(line, 14, 19), c = parseCoord(line);
    if (apt && id && c) coords.set(`${apt}|${id}`, c);
  }
  // Pass 2: SID (D) / STAR (E) legs.
  const procs = {};
  for (const line of lines) {
    if (line[0] !== 'S' || line[4] !== 'P') continue;
    const sub = line[12];
    if (sub !== 'D' && sub !== 'E') continue;
    const apt = C(line, 7, 10);
    const proc = C(line, 14, 19);
    const trans = C(line, 21, 25) || '_';
    const seq = Number(C(line, 27, 29)) || 0;
    const fix = C(line, 30, 34);
    if (!apt || !proc || !fix) continue; // skip heading/vector legs (no fix)
    const fixSec = line[36], fixSub = line[37];
    let coord = coords.get(`${apt}|${fix}`) || null;
    // also accept a terminal waypoint flagged P/C even if region differs
    if (!coord && fixSec === 'P' && fixSub === 'C') coord = coords.get(`${apt}|${fix}`) || null;
    ((procs[apt] ||= {})[proc] ||= {})[trans] ||= [];
    procs[apt][proc][trans].push({ seq, name: fix, coord });
  }
  // Order each transition by seq, collapse to [lat,lon,name], dedupe consecutive.
  const out = {};
  for (const [apt, ps] of Object.entries(procs)) {
    out[apt] = {};
    for (const [proc, trans] of Object.entries(ps)) {
      out[apt][proc] = {};
      for (const [tk, legs] of Object.entries(trans)) {
        legs.sort((a, b) => a.seq - b.seq);
        const pts = [];
        for (const l of legs) {
          const last = pts[pts.length - 1];
          if (last && last[2] === l.name) continue;
          pts.push([l.coord ? l.coord[0] : null, l.coord ? l.coord[1] : null, l.name]);
        }
        out[apt][proc][tk] = pts;
      }
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  let out = fileURLToPath(new URL('../data/procedures.json', import.meta.url));
  let src = null;
  for (let i = 0; i < args.length; i++) { if (args[i] === '--out') out = args[++i]; else src = args[i]; }
  if (!src) {
    console.error('Usage: node scripts/ingest-faa-cifp.js <FAACIFP18 | extract> [--out data/procedures.json]');
    console.error('Get FAACIFP18 from the FAA CIFP: https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/');
    process.exit(2);
  }
  const procs = build(readText(src));
  const aprts = Object.keys(procs);
  const nProc = aprts.reduce((n, a) => n + Object.keys(procs[a]).length, 0);
  await writeFile(out, JSON.stringify(procs));
  console.log(`Wrote ${nProc} procedures across ${aprts.length} airports -> ${out}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

export { build as buildProcedures, parseCoord };
