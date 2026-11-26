import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMissionPaste, julianToMs } from './planner.js';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0); // Thu 26 Nov 2026

test('julianToMs decodes a C2D2 "YDDD/HHMMZ" stamp', () => {
  const ms = julianToMs(6, 332, 13, 40, NOW); // 2026, day-of-year 332 = 28 Nov
  const d = new Date(ms);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 10); // November
  assert.equal(d.getUTCDate(), 28);
  assert.equal(d.getUTCHours(), 13);
  assert.equal(d.getUTCMinutes(), 40);
});

test('parseMissionPaste reads C2D2 legs into per-field arrival/departure times', () => {
  const paste = `Mission Details
#200   PPR   Gnd Time: 2+15
OKKK -------- OKAS
6332/1340Z (in 2 days)   0+20   6332/1400Z (in 2 days)
#300   PPR   Gnd Time: 2+15
OKAS -------- OJAQ
6332/1615Z (in 2 days)   2+15   6332/1830Z (in 2 days)
#400   PPR   Gnd Time: 2+00
OJAQ -------- OKKK
6332/2030Z (in 2 days)   1+50   6332/2220Z (in 3 days)
#600   PPR   Gnd Time: 2+15
OKAS -------- ETAD
6333/0310Z (in 3 days)   6+15   6333/0925Z (in 3 days)`;

  const { legs, fields } = parseMissionPaste(paste, NOW);
  assert.equal(legs.length, 4);
  assert.deepEqual([legs[0].orig, legs[0].dest], ['OKKK', 'OKAS']);
  const dep0 = new Date(legs[0].depMs);
  assert.equal(dep0.getUTCDate(), 28);
  assert.equal(dep0.getUTCHours(), 13);
  assert.equal(dep0.getUTCMinutes(), 40);

  // Field order preserved; OKAS is a turn (arrives on #200, departs on #300).
  const icaos = fields.map((f) => f.icao);
  assert.deepEqual(icaos, ['OKKK', 'OKAS', 'OJAQ', 'ETAD']);
  const okas = fields.find((f) => f.icao === 'OKAS');
  assert.ok(okas.arrMs != null && okas.depMs != null, 'turn field has both arrival and departure');
  assert.ok(okas.arrMs < okas.depMs, 'arrival before departure');
  const etad = fields.find((f) => f.icao === 'ETAD');
  assert.ok(etad.arrMs != null && etad.depMs == null, 'final destination has arrival only');
});

test('parseMissionPaste ignores header words and tolerates an empty paste', () => {
  assert.deepEqual(parseMissionPaste('', NOW).fields, []);
  const { fields } = parseMissionPaste('MISSION DETAILS SHARE CLOSE', NOW);
  assert.deepEqual(fields, []); // no legs from header words alone
});

test('parseMissionPaste handles a real C2D2 paste (icon/PPR noise, one-token-per-line, round robin)', () => {
  // Verbatim shape of the app's copy output: Material icon names, "PPR",
  // "Gnd Time", and "(in N hrs)" annotations interleaved one per line.
  const paste = `subdirectory_arrow_right
#100
PPR
ETAD
6332/0500Z
(in 35 hrs)
4+35
LLOV
6332/0935Z
(in 39 hrs)
radio_button_unchecked
#200
PPR
Gnd Time: 2+15
LLOV
6332/1150Z
(in 41 hrs)
0+45
OJAQ
6332/1235Z
(in 42 hrs)
radio_button_unchecked
#300
PPR
Gnd Time: 4+25
OJAQ
6332/1700Z
(in 47 hrs)
2+25
OTBH
6332/1925Z
(in 2 days)
radio_button_unchecked
#400
PPR
Gnd Time: 2+15
OTBH
6332/2140Z
(in 2 days)
7+05
ETAD`;
  const { legs, fields } = parseMissionPaste(paste, NOW);
  assert.deepEqual(legs.map((l) => [l.orig, l.dest]), [['ETAD', 'LLOV'], ['LLOV', 'OJAQ'], ['OJAQ', 'OTBH'], ['OTBH', 'ETAD']]);
  assert.deepEqual(fields.map((f) => f.icao), ['ETAD', 'LLOV', 'OJAQ', 'OTBH']); // ETAD deduped (start + return)
  assert.ok(!fields.some((f) => ['PPR', 'GND'].includes(f.icao)), 'noise words are not fields');
  const d = new Date(legs[0].depMs); // 6332 = day-of-year 332 = 28 Nov 2026
  assert.equal(d.getUTCMonth(), 10);
  assert.equal(d.getUTCDate(), 28);
  assert.equal(d.getUTCHours(), 5);
  for (const icao of ['LLOV', 'OJAQ', 'OTBH']) {
    const f = fields.find((x) => x.icao === icao);
    assert.ok(f.arrMs != null && f.depMs != null && f.arrMs < f.depMs, `${icao} is a turn (arr before dep)`);
  }
});
