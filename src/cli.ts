// Demo CLI: fetch live AWC weather for a set of airfields, run the analysis
// engine, and print a kneeboard-style brief.
//
//   npm run demo                 # default demo airfields
//   npm run demo -- KCHS KSUU    # specific airfields
//   npm run demo -- --offline    # force the bundled fixture (no network)
//
// Live AWC fetch is attempted first; if the network is unavailable (e.g. a
// restricted allowlist), it transparently falls back to the bundled fixture.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { analyzeAirfield } from './core/analyze';
import type { AircraftLimits, AirfieldAnalysis, Observation } from './core/types';
import { fetchMetars, fetchTafs, mapAwcMetar } from './data/awc';
import { getAirport, knownAirports } from './data/airports';

// Placeholder limits — edit to your aircraft. NOT official C-17 -1/TO values.
const LIMITS: AircraftLimits = { crosswindKt: 25, tailwindKt: 10, highDensityAltitudeFt: 5000 };

const FIXTURE_URL = new URL('../data/fixtures/metar-sample.json', import.meta.url);

const DEFAULT_FIELDS = ['KCHS', 'KSUU', 'KWRI', 'PHIK', 'KEDW'];

function fmt(n: number, digits = 0): string {
  return n.toFixed(digits);
}

async function loadFixtureObs(icaos: string[]): Promise<Observation[]> {
  const raw = await readFile(fileURLToPath(FIXTURE_URL), 'utf8');
  const arr = JSON.parse(raw) as Parameters<typeof mapAwcMetar>[0][];
  const wanted = new Set(icaos.map((i) => i.toUpperCase()));
  return arr.filter((m) => wanted.has(m.icaoId.toUpperCase())).map(mapAwcMetar);
}

interface WxResult {
  obs: Observation[];
  tafs: Map<string, string>;
  live: boolean;
}

async function loadWeather(icaos: string[], offline: boolean): Promise<WxResult> {
  if (!offline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const obs = await fetchMetars(icaos, ctrl.signal);
      const tafList = await fetchTafs(icaos, ctrl.signal).catch(() => []);
      clearTimeout(t);
      const tafs = new Map(tafList.map((t) => [t.icao.toUpperCase(), t.rawTaf]));
      if (obs.length > 0) return { obs, tafs, live: true };
    } catch {
      // fall through to fixture
    }
  }
  return { obs: await loadFixtureObs(icaos), tafs: new Map(), live: false };
}

function status(a: AirfieldAnalysis): string {
  const exceeds = a.warnings.some((w) => w.includes('exceeds'));
  if (exceeds) return 'CAUTION — LIMIT EXCEEDED';
  if (a.warnings.length > 0) return 'CAUTION';
  return 'GO';
}

function windField(obs: Observation): string {
  const w = obs.wind;
  if (w.dirTrue === null && w.speedKt === 0) return 'CALM';
  const dir = w.dirTrue === 'VRB' ? 'VRB' : String(w.dirTrue).padStart(3, '0');
  const gust = w.gustKt ? `G${w.gustKt}` : '';
  return `${dir}/${w.speedKt}${gust} (true)`;
}

function printBrief(a: AirfieldAnalysis, taf: string | undefined, live: boolean): void {
  const ap = a.airport;
  const obs = a.observation;
  const line = '═'.repeat(64);
  console.log(`\n${line}`);
  console.log(` ${ap.icao} — ${ap.name}`);
  console.log(line);

  const src = live ? 'LIVE AWC' : 'FIXTURE';
  const obsT = obs.obsTime ? new Date(obs.obsTime).toISOString().slice(11, 16) + 'Z' : '----';
  console.log(
    ` OBS ${obsT}  WIND ${windField(obs)}  ` +
      `TEMP ${obs.tempC ?? '--'}°C  ALT ${obs.altimHpa ?? '--'} hPa   [${src}]`,
  );
  if (obs.rawText) console.log(` ${obs.rawText}`);

  if (a.densityAltitudeFt != null) {
    console.log(
      ` Field elev ${ap.elevationFt} ft   PA ${a.pressureAltitudeFt} ft   ` +
        `DA ${a.densityAltitudeFt} ft (ISA ${a.isaDeviationC! >= 0 ? '+' : ''}${a.isaDeviationC}°C)`,
    );
  }

  console.log('');
  if (a.active) {
    const r = a.active;
    const side = r.crosswindSide === 'none' ? '' : ` from ${r.crosswindSide.toUpperCase()}`;
    console.log(` ACTIVE RWY ${r.ident}  (true ${fmt(r.trueHeading)}°)`);
    console.log(
      `   Headwind ${fmt(r.headwindKt)} kt      Crosswind ${fmt(r.crosswindKt)} kt${side}`,
    );
    if (r.gustCrosswindKt != null) {
      console.log(
        `   Gust:  Headwind ${fmt(r.gustHeadwindKt!)} kt   Crosswind ${fmt(r.gustCrosswindKt)} kt`,
      );
    }
  } else {
    console.log(' ACTIVE RWY: pilot discretion (wind calm/variable)');
  }

  console.log('\n All runways:');
  for (const r of a.runways) {
    const hw = r.isTailwind ? `TW ${fmt(-r.headwindKt)}` : `HW ${fmt(r.headwindKt)}`;
    const xw =
      r.crosswindSide === 'none' ? 'XW  0' : `XW ${fmt(r.crosswindKt)} ${r.crosswindSide[0]!.toUpperCase()}`;
    const flag = r === a.active ? ' *' : '';
    console.log(`   RWY ${r.ident.padEnd(4)} ${hw.padEnd(7)} ${xw}${flag}`);
  }

  if (a.warnings.length) {
    console.log('\n Warnings:');
    for (const w of a.warnings) console.log(`   ⚠ ${w}`);
  }

  if (taf) console.log(`\n TAF: ${taf}`);
  console.log(`\n STATUS: ${status(a)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const icaos = args.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());
  const fields = icaos.length ? icaos : DEFAULT_FIELDS;

  console.log('C-17 Mission Planner — wind/pattern analysis demo');
  console.log(`Limits (placeholder): crosswind ${LIMITS.crosswindKt} kt, ` +
    `tailwind ${LIMITS.tailwindKt} kt, high-DA ${LIMITS.highDensityAltitudeFt} ft`);

  const { obs, tafs, live } = await loadWeather(fields, offline);
  if (!live) console.log('(network unavailable — using bundled fixture data)');
  const byIcao = new Map(obs.map((o) => [o.icao.toUpperCase(), o]));

  for (const icao of fields) {
    const airport = await getAirport(icao);
    if (!airport) {
      console.log(`\n${icao}: not in reference dataset. Known: ${(await knownAirports()).join(', ')}`);
      continue;
    }
    const o = byIcao.get(icao);
    if (!o) {
      console.log(`\n${icao}: no weather observation available.`);
      continue;
    }
    printBrief(analyzeAirfield(airport, o, LIMITS), tafs.get(icao), live);
  }
  console.log('\n— planning aid only; verify with official sources —\n');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
