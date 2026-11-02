import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levenbergMarquardt, solve, invert, aic, bic, polyfit, propagate } from '../lib/physics/fit.mjs';
import { rng } from './helpers/tracks.mjs';

test('linear algebra: solve and invert agree with a hand-checked 3x3', () => {
  const A = [[4, 1, 2], [1, 3, 0], [2, 0, 5]];
  const x = solve(A, [1, 2, 3]);
  const back = A.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
  back.forEach((v, i) => assert.ok(Math.abs(v - [1, 2, 3][i]) < 1e-12));
  const inv = invert(A);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const e = A[i].reduce((s, v, k) => s + v * inv[k][j], 0);
    assert.ok(Math.abs(e - (i === j ? 1 : 0)) < 1e-12);
  }
  assert.equal(invert([[1, 2], [2, 4]]), null, 'singular matrix is reported');
});

test('LM recovers an exponential decay and its covariance is calibrated', () => {
  const { gauss } = rng(3);
  const t = Array.from({ length: 80 }, (_, i) => i * 0.05), sigma = 0.02;
  const truth = [2.0, 0.9, 0.3];
  const trials = 40;
  let z2 = 0;
  for (let k = 0; k < trials; k++) {
    const y = t.map((s) => truth[0] * Math.exp(-truth[1] * s) + truth[2] + sigma * gauss());
    const fit = levenbergMarquardt({ p0: [1, 0.5, 0], residuals: (p) => t.map((s, i) => y[i] - (p[0] * Math.exp(-p[1] * s) + p[2])) });
    assert.ok(fit.converged);
    z2 += ((fit.p[1] - truth[1]) / fit.sigma[1]) ** 2;
    assert.ok(Math.abs(fit.rms - sigma) < 0.006);
  }
  // sigma of the decay rate should be honest: mean z^2 ~ 1
  assert.ok(z2 / trials > 0.5 && z2 / trials < 1.8, `mean z^2 = ${z2 / trials}`);
});

test('robust fit shrugs off gross outliers, plain fit does not', () => {
  const t = Array.from({ length: 60 }, (_, i) => i / 30);
  const y = t.map((s) => 1 + 2 * s + 0.002 * Math.sin(37 * s));
  y[10] += 3; y[30] -= 2;
  const res = (p) => t.map((s, i) => y[i] - (p[0] + p[1] * s));
  const plain = levenbergMarquardt({ p0: [0, 0], residuals: res });
  const robust = levenbergMarquardt({ p0: [0, 0], residuals: res, robust: true });
  assert.ok(Math.abs(robust.p[1] - 2) < 0.01, `robust slope ${robust.p[1]}`);
  assert.ok(Math.abs(plain.p[1] - 2) > 0.02);
  assert.ok(robust.weights[10] < 0.05 && robust.weights[30] < 0.05 && robust.weights[0] > 0.9);
});

test('bounds are respected and fixed parameters stay put', () => {
  const t = [0, 1, 2, 3, 4], y = t.map((s) => 5 + 0.5 * s);
  const fit = levenbergMarquardt({ p0: [0, 0], lower: [-10, 0.8], upper: [10, 5], residuals: (p) => t.map((s, i) => y[i] - (p[0] + p[1] * s)) });
  assert.ok(fit.p[1] >= 0.8 - 1e-12);
  const pinned = levenbergMarquardt({ p0: [0, 0.5], freeIdx: [0], residuals: (p) => t.map((s, i) => y[i] - (p[0] + p[1] * s)) });
  assert.equal(pinned.p[1], 0.5);
  assert.equal(pinned.cov[1][1], 0);
});

test('AIC/BIC penalise parameters, polyfit and propagate behave', () => {
  assert.ok(bic(1e-3, 100, 6) > bic(1e-3, 100, 5));
  assert.ok(aic(1e-3, 100, 6) > aic(1e-3, 100, 5));
  const c = polyfit([0, 1, 2, 3], [1, 3, 9, 19], 2);       // 1 + 0 t + 2 t^2
  assert.ok(Math.abs(c[0] - 1) < 1e-9 && Math.abs(c[2] - 2) < 1e-9);
  const r = propagate((p) => p[0] * p[1], [2, 3], [[0.01, 0], [0, 0.04]]);
  assert.ok(Math.abs(r.sigma - Math.sqrt(9 * 0.01 + 4 * 0.04)) < 1e-6);
});
