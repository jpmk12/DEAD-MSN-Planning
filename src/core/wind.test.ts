import { describe, it, expect } from 'vitest';
import { magToTrue, windComponents } from './wind';
import { signedDiff, normalize360 } from './geo';
import { analyzeRunways, selectActiveRunway, analyzeAirfield } from './analyze';
import type { Airport, Observation, AircraftLimits } from './types';

const LIMITS: AircraftLimits = { crosswindKt: 25, tailwindKt: 10, highDensityAltitudeFt: 5000 };

describe('geo helpers', () => {
  it('normalizes angles into [0,360)', () => {
    expect(normalize360(-10)).toBe(350);
    expect(normalize360(370)).toBe(10);
    expect(normalize360(360)).toBe(0);
  });
  it('signed diff lands in (-180,180]', () => {
    expect(signedDiff(10, 350)).toBe(20);
    expect(signedDiff(350, 10)).toBe(-20);
    expect(signedDiff(180, 0)).toBe(180);
  });
});

describe('magnetic -> true conversion', () => {
  it('applies east-positive variation (west variation, Charleston-ish)', () => {
    // RWY 15 surveyed mag 150, variation 8W (magVar = -8) => true 142
    expect(magToTrue(150, -8)).toBeCloseTo(142, 5);
  });
  it('applies east variation (California-ish)', () => {
    // mag 030, variation 13E => true 043
    expect(magToTrue(30, 13)).toBeCloseTo(43, 5);
  });
});

describe('windComponents', () => {
  it('pure headwind', () => {
    const c = windComponents(360, 360, 10);
    expect(c.headwindKt).toBeCloseTo(10, 5);
    expect(c.crosswindKt).toBeCloseTo(0, 5);
    expect(c.crosswindSide).toBe('none');
  });
  it('pure crosswind from the right', () => {
    const c = windComponents(360, 90, 10);
    expect(c.headwindKt).toBeCloseTo(0, 5);
    expect(c.crosswindKt).toBeCloseTo(10, 5);
    expect(c.crosswindSide).toBe('right');
  });
  it('pure crosswind from the left', () => {
    const c = windComponents(360, 270, 10);
    expect(c.crosswindKt).toBeCloseTo(10, 5);
    expect(c.crosswindSide).toBe('left');
  });
  it('45 degrees splits evenly', () => {
    const c = windComponents(360, 45, 10);
    expect(c.headwindKt).toBeCloseTo(7.071, 3);
    expect(c.crosswindKt).toBeCloseTo(7.071, 3);
    expect(c.crosswindSide).toBe('right');
  });
  it('direct tailwind reports negative headwind', () => {
    const c = windComponents(360, 180, 10);
    expect(c.headwindKt).toBeCloseTo(-10, 5);
    expect(c.crosswindKt).toBeCloseTo(0, 5);
  });
  it('wraps around 360 correctly (wind 010 on rwy 350)', () => {
    const c = windComponents(350, 10, 20);
    // 20 deg off => head 20*cos20=18.79, cross 20*sin20=6.84 from right
    expect(c.headwindKt).toBeCloseTo(18.794, 3);
    expect(c.crosswindKt).toBeCloseTo(6.840, 3);
    expect(c.crosswindSide).toBe('right');
  });
});

describe('runway analysis with mag/true conversion', () => {
  const airport: Airport = {
    icao: 'TEST',
    name: 'Test Field',
    elevationFt: 50,
    magVar: -8, // 8W
    runways: [
      { ident: '15', magHeading: 150 },
      { ident: '33', magHeading: 330 },
    ],
  };

  it('selects the runway most aligned with the (true) wind', () => {
    // Wind 320@15 TRUE. RWY33 true = 330-8 = 322 -> nearly down the runway.
    const obs: Observation = {
      icao: 'TEST',
      wind: { dirTrue: 320, speedKt: 15 },
    };
    const rwys = analyzeRunways(airport, obs);
    const active = selectActiveRunway(rwys)!;
    expect(active.ident).toBe('33');
    expect(active.trueHeading).toBeCloseTo(322, 5);
    expect(active.headwindKt).toBeGreaterThan(14); // ~14.9
    expect(active.crosswindKt).toBeLessThan(1);
    expect(active.isTailwind).toBe(false);
  });

  it('the reciprocal end shows a tailwind', () => {
    const obs: Observation = { icao: 'TEST', wind: { dirTrue: 320, speedKt: 15 } };
    const rwy15 = analyzeRunways(airport, obs).find((r) => r.ident === '15')!;
    expect(rwy15.isTailwind).toBe(true);
    expect(rwy15.headwindKt).toBeLessThan(0);
  });
});

describe('gust handling', () => {
  const airport: Airport = {
    icao: 'GUST',
    name: 'Gusty',
    elevationFt: 0,
    magVar: 0,
    runways: [{ ident: '09', magHeading: 90 }, { ident: '27', magHeading: 270 }],
  };
  it('computes a separate (larger) gust crosswind', () => {
    // Wind 180@15G30 on rwy 09 (true 090) => direct right crosswind.
    const obs: Observation = {
      icao: 'GUST',
      wind: { dirTrue: 180, speedKt: 15, gustKt: 30 },
    };
    const rwy = analyzeRunways(airport, obs).find((r) => r.ident === '09')!;
    expect(rwy.crosswindKt).toBeCloseTo(15, 5);
    expect(rwy.gustCrosswindKt).toBeCloseTo(30, 5);
  });
  it('flags a gust crosswind that exceeds the limit even when steady is fine', () => {
    const obs: Observation = {
      icao: 'GUST',
      wind: { dirTrue: 180, speedKt: 20, gustKt: 30 },
      tempC: 15,
      altimHpa: 1013.25,
    };
    const a = analyzeAirfield(airport, obs, { crosswindKt: 25, tailwindKt: 10 });
    expect(a.warnings.some((w) => w.includes('Gust crosswind'))).toBe(true);
  });
});

describe('calm / variable winds', () => {
  const airport: Airport = {
    icao: 'CALM',
    name: 'Calm',
    elevationFt: 0,
    magVar: 0,
    runways: [{ ident: '18', magHeading: 180 }, { ident: '36', magHeading: 360 }],
  };
  it('VRB wind yields no active runway and a discretion warning', () => {
    const a = analyzeAirfield(airport, { icao: 'CALM', wind: { dirTrue: 'VRB', speedKt: 3 } }, LIMITS);
    expect(a.active).toBeNull();
    expect(a.windIndeterminate).toBe(true);
    expect(a.warnings.some((w) => w.includes('discretion'))).toBe(true);
  });
  it('calm (00000KT) is indeterminate', () => {
    const a = analyzeAirfield(airport, { icao: 'CALM', wind: { dirTrue: null, speedKt: 0 } }, LIMITS);
    expect(a.active).toBeNull();
  });
});
