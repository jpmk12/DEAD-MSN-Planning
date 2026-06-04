import { describe, it, expect } from 'vitest';
import { hpaToInHg, isaTempC, pressureAltitudeFt, computeAltitudes } from './density';

describe('density / pressure altitude', () => {
  it('converts hPa to inHg', () => {
    expect(hpaToInHg(1013.25)).toBeCloseTo(29.9213, 3);
    expect(hpaToInHg(1019)).toBeCloseTo(30.09, 2);
  });

  it('ISA at sea level is 15C, ~5.1C at 5000ft', () => {
    expect(isaTempC(0)).toBeCloseTo(15, 5);
    expect(isaTempC(5000)).toBeCloseTo(5.1, 2);
  });

  it('pressure altitude equals field elevation at standard pressure', () => {
    expect(pressureAltitudeFt(5000, hpaToInHg(1013.25))).toBeCloseTo(5000, 0);
  });

  it('standard day at sea level => DA ~0', () => {
    const a = computeAltitudes(0, 1013.25, 15);
    expect(a.pressureAltitudeFt).toBeCloseTo(0, 0);
    expect(a.densityAltitudeFt).toBeCloseTo(0, 0);
    expect(a.isaDeviationC).toBeCloseTo(0, 2);
  });

  it('hot high field: 5000ft, std pressure, 25C => DA ~7388ft', () => {
    const a = computeAltitudes(5000, 1013.25, 25);
    expect(a.pressureAltitudeFt).toBeCloseTo(5000, 0);
    expect(a.densityAltitudeFt).toBeCloseTo(7388, 0);
    expect(a.isaDeviationC).toBeCloseTo(19.9, 1);
  });
});
