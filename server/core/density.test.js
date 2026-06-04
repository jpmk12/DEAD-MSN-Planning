import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hpaToInHg, isaTempC, pressureAltitudeFt, computeAltitudes } from './density.js';

const near = (a, b, eps = 1e-2) => assert.ok(Math.abs(a - b) <= eps, `${a} ~ ${b}`);

test('hPa -> inHg', () => {
  near(hpaToInHg(1013.25), 29.9213, 1e-3);
  near(hpaToInHg(1019), 30.09);
});

test('ISA temp: 15C at SL, ~5.1C at 5000ft', () => {
  near(isaTempC(0), 15, 1e-5);
  near(isaTempC(5000), 5.1);
});

test('pressure altitude = field elevation at standard pressure', () => {
  near(pressureAltitudeFt(5000, hpaToInHg(1013.25)), 5000, 0.5);
});

test('standard day at sea level => DA ~0', () => {
  const a = computeAltitudes(0, 1013.25, 15);
  near(a.pressureAltitudeFt, 0, 0.5);
  near(a.densityAltitudeFt, 0, 0.5);
  near(a.isaDeviationC, 0);
});

test('hot/high: 5000ft, std pressure, 25C => DA ~7388ft', () => {
  const a = computeAltitudes(5000, 1013.25, 25);
  near(a.pressureAltitudeFt, 5000, 0.5);
  near(a.densityAltitudeFt, 7388, 1);
  near(a.isaDeviationC, 19.9, 0.1);
});
