// Demo CLI: build a brief for a set of airfields and print it to the terminal.
//   npm run demo
//   node server/cli.js KCHS KEDW --offline

import { loadEnv } from './env.js';
import { buildBrief, DEFAULT_LIMITS } from './brief.js';

loadEnv();

const fmt = (n, d = 0) => n.toFixed(d);

function windField(obs) {
  const w = obs.wind;
  if (w.dirTrue === null && w.speedKt === 0) return 'CALM';
  const dir = w.dirTrue === 'VRB' ? 'VRB' : String(w.dirTrue).padStart(3, '0');
  return `${dir}/${w.speedKt}${w.gustKt ? `G${w.gustKt}` : ''} (true)`;
}

function printAirfield(b) {
  const line = '═'.repeat(64);
  console.log(`\n${line}\n ${b.icao}${b.airport ? ' — ' + b.airport.name : ''}\n${line}`);
  if (!b.found) {
    console.log(' not in reference dataset.');
    return;
  }
  const a = b.analysis;
  if (!a) {
    console.log(' no weather observation available.');
    return;
  }
  const obsT = a.observation.obsTime ? a.observation.obsTime.slice(11, 16) + 'Z' : '----';
  console.log(` OBS ${obsT}  WIND ${windField(a.observation)}  TEMP ${a.observation.tempC ?? '--'}°C  ALT ${a.observation.altimHpa ?? '--'} hPa`);
  if (a.observation.rawText) console.log(` ${a.observation.rawText}`);
  if (a.densityAltitudeFt != null) {
    console.log(` Field elev ${a.airport.elevationFt} ft   PA ${a.pressureAltitudeFt} ft   DA ${a.densityAltitudeFt} ft (ISA ${a.isaDeviationC >= 0 ? '+' : ''}${a.isaDeviationC}°C)`);
  }
  console.log('');
  if (a.active) {
    const r = a.active;
    const rec = b.recommendedRunway ?? r.ident;
    console.log(` RECOMMENDED RWY ${rec}` + (rec !== r.ident ? `  (wind-best ${r.ident} CLOSED)` : ''));
    const side = r.crosswindSide === 'none' ? '' : ` from ${r.crosswindSide.toUpperCase()}`;
    console.log(`   Headwind ${fmt(r.headwindKt)} kt   Crosswind ${fmt(r.crosswindKt)} kt${side}`);
    if (r.gustCrosswindKt != null) {
      console.log(`   Gust: HW ${fmt(r.gustHeadwindKt)} kt  XW ${fmt(r.gustCrosswindKt)} kt`);
    }
  } else {
    console.log(' RWY: pilot discretion (wind calm/variable)');
  }
  const closed = new Set(b.closedRunways.map((r) => r.toUpperCase()));
  console.log('\n Runways:');
  for (const r of a.runways) {
    const hw = r.isTailwind ? `TW ${fmt(-r.headwindKt)}` : `HW ${fmt(r.headwindKt)}`;
    const xw = r.crosswindSide === 'none' ? 'XW 0' : `XW ${fmt(r.crosswindKt)} ${r.crosswindSide[0].toUpperCase()}`;
    const flags = `${b.recommendedRunway === r.ident ? ' *' : ''}${closed.has(r.ident.toUpperCase()) ? ' [CLSD]' : ''}`;
    console.log(`   RWY ${r.ident.padEnd(4)} ${hw.padEnd(7)} ${xw}${flags}`);
  }
  if (a.warnings.length) {
    console.log('\n Warnings:');
    for (const w of a.warnings) console.log(`   ⚠ ${w}`);
  }
  console.log(`\n NOTAMs (${b.notams.length}):`);
  for (const n of b.notams) console.log(`   ${n.category.padEnd(9)} ${n.text}`);
  console.log(`\n STATUS: ${b.status}`);
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const ids = args.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());
  const fields = ids.length ? ids : ['KCHS', 'KSUU', 'KWRI', 'PHIK', 'KEDW'];

  console.log('C-17 Mission Planner — demo');
  console.log(`Limits (placeholder): xwind ${DEFAULT_LIMITS.crosswindKt} kt, tailwind ${DEFAULT_LIMITS.tailwindKt} kt, high-DA ${DEFAULT_LIMITS.highDensityAltitudeFt} ft`);
  const brief = await buildBrief(fields, offline);
  if (!brief.live.weather) console.log('(weather: bundled fixture — live AWC unavailable)');
  for (const b of brief.airfields) printAirfield(b);
  console.log('\n— planning aid only; verify with official sources —\n');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
