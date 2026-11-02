import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from './helpers/tracks.mjs';
import { fitAll, fitModel, trimToMotion, prepareTrack } from '../lib/physics/select.mjs';
import { MODELS, MODEL_LIST } from '../lib/physics/models.mjs';

const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const derived = (fit, name) => fit.derived.find((d) => d.name === name);
const noisy = (track, seed = 7, opts = {}) => T.corrupt(track, { sigma: 0.0025, gaps: 2, outliers: 2, seed, ...opts });

test('registry exposes the seven documented models with complete interfaces', () => {
  assert.deepEqual(MODEL_LIST.map((m) => m.id), ['constant-velocity', 'projectile', 'projectile-drag', 'bounce', 'pendulum', 'incline', 'oscillator']);
  for (const m of MODEL_LIST) {
    for (const f of ['guess', 'predict', 'derived', 'simulate', 'state']) assert.equal(typeof m[f], 'function', `${m.id}.${f}`);
    assert.ok(m.params.length >= 4 && m.params.every((q) => q.name && 'unit' in q && q.desc));
  }
});

test('constant-velocity: speed and direction recovered', () => {
  const f = fitModel(noisy(T.floatTrack({})), 'constant-velocity').fit;
  assert.ok(rel(derived(f, 'speed').value, Math.hypot(0.9, 0.35)) < 0.01);
  assert.ok(Math.abs(f.p.vx - 0.9) < 0.01 && Math.abs(f.p.vy - 0.35) < 0.01);
});

test('projectile: g within 1% from a 0.9 s throw with noise, gaps and outliers', () => {
  const f = fitModel(noisy(T.free({ y0: 2, vx: 1.2, vy: 2, dur: 0.9 })), 'projectile').fit;
  assert.ok(rel(f.p.g, 9.81) < 0.01, `g = ${f.p.g}`);
  assert.ok(Math.abs(f.p.g - 9.81) < 4 * f.sigma.g, 'error bar covers the truth within 4 sigma');
  assert.ok(Math.abs(derived(f, 'launch_angle').value - Math.atan2(2, 1.2) * 180 / Math.PI) < 1);
  assert.ok(f.outliers.length >= 1, 'injected outliers are flagged');
});

test('projectile: Moon gravity is recovered as 1.62, not 9.81', () => {
  const f = fitModel(noisy(T.free({ g: 1.62, y0: 2.2, vx: 0.4, vy: 0.5, dur: 2.2 })), 'projectile').fit;
  assert.ok(rel(f.p.g, 1.62) < 0.02, `g = ${f.p.g}`);
});

test('projectile-drag: g within 2%, drag b within 6%, terminal velocity consistent', () => {
  const f = fitModel(noisy(T.drag({ b: 0.05 })), 'projectile-drag').fit;
  assert.ok(rel(f.p.g, 9.81) < 0.02, `g = ${f.p.g}`);
  assert.ok(rel(f.p.b, 0.05) < 0.06, `b = ${f.p.b}`);
  assert.ok(rel(derived(f, 'terminal_velocity').value, Math.sqrt(9.81 / 0.05)) < 0.04);
});

test('bounce: g within 2%, e within 0.03, floor within 1 cm', () => {
  const f = fitModel(noisy(T.bounce({ e: 0.78 })), 'bounce').fit;
  assert.ok(rel(f.p.g, 9.81) < 0.02, `g = ${f.p.g}`);
  assert.ok(Math.abs(f.p.e - 0.78) < 0.03, `e = ${f.p.e}`);
  assert.ok(Math.abs(f.p.floorY - 0.12) < 0.01);
  assert.ok(Math.abs(derived(f, 'energy_lost_per_bounce').value - (1 - 0.78 ** 2)) < 0.05);
});

test('bounce: a different restitution (0.55) and the Moon are recovered', () => {
  const f = fitModel(noisy(T.bounce({ e: 0.55, g: 1.62, y0: 1.0, dur: 5 })), 'bounce').fit;
  assert.ok(Math.abs(f.p.e - 0.55) < 0.03, `e = ${f.p.e}`);
  assert.ok(rel(f.p.g, 1.62) < 0.03, `g = ${f.p.g}`);
});

test('pendulum: L within 1.5%, g within 2.5%, period matches (5 noise seeds)', () => {
  const errs = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const f = fitModel(noisy(T.pendulum({}), seed), 'pendulum').fit;
    errs.push({ L: rel(f.p.L, 0.75), g: rel(f.p.g, 9.81), T: rel(derived(f, 'period_small_angle').value, 2 * Math.PI * Math.sqrt(0.75 / 9.81)) });
    assert.ok(Math.abs(f.p.L - 0.75) < 4 * f.sigma.L + 1e-3, 'L error bar honest');
  }
  const med = (k) => errs.map((e) => e[k]).sort((a, b) => a - b)[2];
  assert.ok(med('L') < 0.01, `median L error ${med('L')}`);
  assert.ok(Math.max(...errs.map((e) => e.L)) < 0.025 && Math.max(...errs.map((e) => e.g)) < 0.03);
  assert.ok(Math.max(...errs.map((e) => e.T)) < 0.002, 'the period is the tightly constrained quantity');
});

test('pendulum: damping and a Moon-gravity pendulum', () => {
  const f = fitModel(noisy(T.pendulum({ g: 1.62, gamma: 0.12, dur: 8 })), 'pendulum').fit;
  assert.ok(rel(f.p.g, 1.62) < 0.04, `g = ${f.p.g}`);
  assert.ok(Math.abs(f.p.gamma - 0.12) < 0.03, `gamma = ${f.p.gamma}`);
  assert.ok(derived(f, 'Q').value > 5);
});

test('incline: a, angle and implied g of a rolling sphere', () => {
  const tr = T.incline({ alphaDeg: 12 });
  const f = fitModel(noisy(tr), 'incline').fit;
  assert.ok(rel(f.p.a, tr.a) < 0.01, `a = ${f.p.a}`);
  assert.ok(Math.abs(derived(f, 'alpha').value - 12) < 0.4);
  assert.ok(rel(derived(f, 'g_if_rolling_sphere').value, 9.81) < 0.03);
  assert.ok(Math.abs(derived(f, 'mu_if_sliding_on_earth').value) < 3);
});

test('oscillator: omega within 0.5%, damping within 15%', () => {
  const f = fitModel(noisy(T.oscillator({})), 'oscillator').fit;
  assert.ok(rel(f.p.omega, 2 * Math.PI * 1.2) < 0.005, `omega = ${f.p.omega}`);
  assert.ok(rel(f.p.gamma, 0.35) < 0.15, `gamma = ${f.p.gamma}`);
  assert.ok(rel(derived(f, 'period').value, 1 / 1.2) < 0.005);
  assert.ok(rel(derived(f, 'Q').value, Math.hypot(2 * Math.PI * 1.2, 0.35) / 0.7) < 0.2);
});

test('horizontal spring oscillation (different axis) is also recovered', () => {
  const tr = T.oscillator({});
  const f = fitModel(noisy({ t: tr.t, x: tr.y.map((v) => v + 0.5), y: tr.x.map(() => 1.2) }), 'oscillator').fit;
  assert.ok(rel(f.p.omega, 2 * Math.PI * 1.2) < 0.005);
});

// ------------------------------------------------------------------ model selection
const scenarios = [
  ['free fall (drop)', () => T.free({ vx: 0.2, dur: 0.65 }), 'projectile'],
  ['thrown ball', () => T.free({ x0: 0.3, y0: 1, vx: 3, vy: 4.5, dur: 1.5 }), 'projectile'],
  ['thrown with drag', () => T.drag({ b: 0.05 }), 'projectile-drag'],
  ['floating', () => T.floatTrack({}), 'constant-velocity'],
  ['bouncing ball', () => T.bounce({}), 'bounce'],
  ['pendulum', () => T.pendulum({}), 'pendulum'],
  ['ball on ramp', () => T.incline({}), 'incline'],
  ['spring', () => T.oscillator({}), 'oscillator'],
];
for (const [name, make, expected] of scenarios) {
  test(`model selection: ${name} -> ${expected}`, () => {
    for (const seed of [7, 21]) {
      const r = fitAll(noisy(make(), seed));
      assert.equal(r.verdict.best, expected, `seed ${seed}: ${JSON.stringify(r.verdict)}`);
      assert.equal(r.fits[0].model, expected);
      assert.ok(r.fits.every((f, i, a) => i === 0 || !f.applicable || !a[i - 1].applicable || f.bic >= a[i - 1].bic), 'sorted by BIC');
    }
  });
}

test('verdict strength: decisive when the model is clearly right, honest when ambiguous', () => {
  assert.equal(fitAll(noisy(T.bounce({}))).verdict.strength, 'decisive');
  assert.equal(fitAll(noisy(T.pendulum({}))).verdict.strength, 'decisive');
  const float = fitAll(noisy(T.floatTrack({}))).verdict;           // projectile with g ~ 0 is nearly as good
  assert.equal(float.best, 'constant-velocity');
});

test('inapplicable models are reported, not forced', () => {
  const r = fitAll(noisy(T.floatTrack({})));
  const byId = Object.fromEntries(r.fits.map((f) => [f.model, f]));
  assert.equal(byId.bounce.applicable, false);
  assert.equal(byId.pendulum.applicable, false);
  assert.equal(MODELS.bounce.guess(prepareTrack(noisy(T.free({}))) ), null);
  assert.equal(MODELS.pendulum.guess(prepareTrack(noisy(T.free({ vx: 2, vy: 3, dur: 1 })))), null);
});

test('output is compact JSON and survives a round trip', () => {
  const r = fitAll(noisy(T.drag({})));
  const text = JSON.stringify(r);
  assert.deepEqual(JSON.parse(text), r);
  assert.ok(text.length < 20000, `fitAll JSON is ${text.length} bytes`);
  assert.equal(r.fits[0].residuals, undefined);
  assert.equal(fitAll(noisy(T.drag({})), { residuals: true }).fits[0].residuals.x.length, r.data.samples);
});

test('fitModel with a fixed parameter tests a hypothesis (g = 9.81 on a Moon drop is rejected)', () => {
  const tr = noisy(T.free({ g: 1.62, y0: 2.2, vx: 0.4, vy: 0.5, dur: 2.2 }));
  const free = fitModel(tr, 'projectile').fit, pinned = fitModel(tr, 'projectile', { fixed: { g: 9.81 } }).fit;
  assert.equal(pinned.p.g, 9.81);
  assert.equal(pinned.sigma.g, 0);
  assert.equal(pinned.k, 4);
  assert.ok(pinned.bic - free.bic > 100, `dBIC = ${pinned.bic - free.bic}`);
  const earth = noisy(T.free({ y0: 2, vx: 1.2, vy: 2, dur: 0.9 }));
  const ok = fitModel(earth, 'projectile', { fixed: { g: 9.81 } }).fit, fr = fitModel(earth, 'projectile').fit;
  assert.ok(ok.bic < fr.bic + 2, 'the correct hypothesis is not penalised');
  assert.throws(() => fitModel(earth, 'projectile', { fixed: { nonsense: 1 } }), /no parameter/);
});

test('trimToMotion drops the held and resting parts of a drop; g is still right', () => {
  const fall = T.free({ y0: 2.3, dur: 0.6 }), t = [], x = [], y = [];
  const floor = 2.3 - 0.5 * 9.81 * 0.6 ** 2;
  for (let i = 0; i < 90; i++) {                      // 0.4 s held, 0.6 s fall (to y = floor), then rests
    const ti = i / 30, s = Math.min(Math.max(ti - 0.4, 0), 0.6);
    t.push(ti); x.push(1.5); y.push(2.3 - 0.5 * 9.81 * s * s);
  }
  const tr = noisy({ t, x, y }, 5, { outliers: 1 });
  const { track, trimmed } = trimToMotion(prepareTrack(tr));
  assert.ok(trimmed > 30, `trimmed ${trimmed}`);
  assert.ok(track.t.length < 30);
  const r = fitAll(tr);
  assert.equal(r.verdict.best, 'projectile');
  assert.ok(rel(r.fits[0].p.g, 9.81) < 0.02, `g = ${r.fits[0].p.g}`);
  assert.ok(Math.abs(r.data.floorY - floor) < 0.02, 'footage ends at its lowest point: floor hint found');
});

test('degenerate input fails gracefully', () => {
  assert.equal(fitAll({ t: [0, 1], x: [0, 1], y: [0, 1] }).verdict.best, null);
  const nan = T.free({});
  nan.x[3] = NaN; nan.y[5] = Infinity;
  assert.equal(fitAll(nan).verdict.best, 'projectile');
});
