import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from './helpers/tracks.mjs';
import { fitAll, fitModel } from '../lib/physics/select.mjs';
import { fork, GRAVITY, resolveOverrides } from '../lib/physics/fork.mjs';
import { MODELS } from '../lib/physics/models.mjs';

const noisy = (track, seed = 7) => T.corrupt(track, { sigma: 0.0025, gaps: 2, outliers: 2, seed });
const landing = (f) => f.events.find((e) => e.type === 'land');
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// A drop from rest: 2.3 m, released at t = 0, footage ends when the ball reaches the floor.
const dropFit = () => fitAll(noisy(T.free({ y0: 2.3, dur: 0.66 })));

test('presets: Earth, Moon, Mars, Jupiter, Ceres are exported with standard values', () => {
  assert.equal(GRAVITY.earth, 9.81); assert.equal(GRAVITY.moon, 1.62); assert.equal(GRAVITY.mars, 3.71);
  assert.equal(GRAVITY.jupiter, 24.79); assert.equal(GRAVITY.ceres, 0.28);
  assert.deepEqual(resolveOverrides({ g: 'Moon', drag: 0 }).ov, { g: 1.62, gName: 'moon', dragScale: 0 });
  assert.match(resolveOverrides({ g: 'pluto2' }).warnings[0], /unknown gravity/);
});

test('Moon fall time / Earth fall time = sqrt(9.81 / 1.62) for a drop from rest', () => {
  const fit = dropFit();
  assert.equal(fit.verdict.best, 'projectile');
  const moon = fork(fit, { g: 'moon' }, { fps: 30 });
  const earth = fork(fit, {}, { fps: 30 });
  const ratio = (landing(moon).t - moon.t[0]) / (landing(earth).t - earth.t[0]);
  assert.ok(rel(ratio, Math.sqrt(9.81 / 1.62)) < 0.02, `ratio ${ratio} vs ${Math.sqrt(9.81 / 1.62)}`);
  assert.match(moon.summary, /^On the Moon it falls for \d\.\d\d s instead of 0\.\d\d s\.$/);
  assert.ok(moon.t.at(-1) > landing(moon).t, 'simulation continues past the landing, longer than the real clip');
  assert.ok(moon.t.at(-1) > 1.9);
});

test('the fork starts from the real footage state (same position and velocity at t0)', () => {
  const fit = fitAll(noisy(T.free({ x0: 0.4, y0: 2, vx: 1.2, vy: 2, dur: 0.9 })));
  const p = MODELS.projectile.params.map((q) => fit.fits[0].p[q.name]);
  const f = fork(fit, { g: 'jupiter' }, { floorY: null, fps: 60 });
  assert.ok(Math.abs(f.x[0] - p[0]) < 1e-6 && Math.abs(f.y[0] - p[1]) < 1e-6);
  const v = (a, i) => (a[i + 1] - a[i]) * 60;
  assert.ok(Math.abs(v(f.x, 0) - 1.2) < 0.05, 'same horizontal velocity');
  assert.ok(Math.abs(v(f.y, 0) - (p[3] - 24.79 / 120)) < 0.1, 'same launch velocity, then Jupiter pulls harder');
  const real = fork(fit, {}, { floorY: null, fps: 60 });
  for (let i = 0; i < 20; i++) assert.ok(Math.abs(real.y[i] - (p[1] + p[3] * real.t[i] - 0.5 * p[4] * real.t[i] ** 2)) < 1e-6);
});

test('removing drag from a drag fit lands farther; strong drag lands shorter', () => {
  const fit = fitAll(noisy(T.drag({ b: 0.05 })));
  assert.equal(fit.verdict.best, 'projectile-drag');
  const base = fork(fit, {});
  const nodrag = fork(fit, { drag: 0 });
  const heavy = fork(fit, { dragScale: 3 });
  assert.ok(landing(nodrag).x > landing(base).x + 0.5, `${landing(nodrag).x} vs ${landing(base).x}`);
  assert.ok(landing(heavy).x < landing(base).x - 0.3);
  assert.ok(landing(base).x > 4.3 && landing(base).x < 4.9, 'baseline reproduces the real landing point (4.6 m)');
  assert.match(nodrag.summary, /Without air drag it lands \d\.\d\d m farther/);
  // heavier body, same drag force -> less deceleration: lands between "no drag" and "baseline" drag
  const heavyMass = fork(fit, { massScale: 4 });
  assert.ok(landing(heavyMass).x > landing(base).x && landing(heavyMass).x < landing(nodrag).x);
});

test('mass is irrelevant without drag (all masses fall alike)', () => {
  const fit = dropFit();
  const a = fork(fit, { g: 'moon' }), b = fork(fit, { g: 'moon', massScale: 10 });
  assert.deepEqual(a.y, b.y);
  assert.match(b.summary, /Mass has no effect/);
});

test('bounce with e = 1 keeps its apex height; e = 0.5 loses height', () => {
  const fit = fitAll(noisy(T.bounce({ e: 0.78 })));
  assert.equal(fit.verdict.best, 'bounce');
  const apexes = (f) => {
    const hits = f.events.filter((e) => e.type === 'bounce').map((e) => e.t), out = [];
    for (let k = 0; k + 1 < hits.length; k++) out.push(Math.max(...f.y.filter((_, i) => f.t[i] > hits[k] && f.t[i] < hits[k + 1])));
    return out;
  };
  const e1 = fork(fit, { e: 1 }, { t1: 6, fps: 120 });
  const a1 = apexes(e1);
  assert.ok(a1.length >= 3);
  const release = fit.fits[0].p.y0;
  assert.ok(a1.every((h) => Math.abs(h - release) / release < 0.01), `apexes ${a1.map((h) => h.toFixed(3))} vs ${release}`);
  const half = fork(fit, { e: 0.5 }, { t1: 6, fps: 120 });
  const ah = apexes(half);
  assert.ok(ah[0] < a1[0] * 0.5 && ah[1] < ah[0]);
  assert.match(half.summary, /e = 0\.50/);
  // the unmodified fork reproduces the real bounces
  const base = fork(fit, {}, { t1: 4.5, fps: 30 });
  const real = fit.fits[0];
  const pred = MODELS.bounce.predict(base.t.map((t) => t - fit.data.t0), MODELS.bounce.params.map((q) => real.p[q.name]));
  base.y.forEach((y, i) => assert.ok(Math.abs(y - pred.y[i]) < 0.01, `frame ${i}: ${y} vs ${pred.y[i]}`));
});

test('timeScale slows the same path down without changing it', () => {
  const fit = fitAll(noisy(T.free({ x0: 0.4, y0: 2, vx: 1.2, vy: 2, dur: 0.9 })));
  const a = fork(fit, {}, { floorY: null, fps: 30, t1: 1.8 }), b = fork(fit, { timeScale: 0.5 }, { floorY: null, fps: 30, t1: 1.8 });
  assert.ok(Math.abs(b.y[20] - a.y[10]) < 1e-6 && Math.abs(b.x[20] - a.x[10]) < 1e-6, 'half speed: frame 2i equals frame i');
  assert.match(b.summary, /0\.50× speed/);
});

test('pendulum fork: the Moon lengthens the period by sqrt(9.81/1.62); no damping keeps the amplitude', () => {
  const fit = fitAll(noisy(T.pendulum({})));
  const cross = (f, px) => { const out = []; for (let i = 1; i < f.x.length; i++) if (f.x[i - 1] < px && f.x[i] >= px) out.push(f.t[i - 1] + (f.t[i] - f.t[i - 1]) * (px - f.x[i - 1]) / (f.x[i] - f.x[i - 1])); return out; };
  const px = fit.fits[0].p.px;
  const earth = fork(fit, {}, { t1: 10, fps: 120 }), moon = fork(fit, { g: 'moon' }, { t1: 24, fps: 120 });
  const Te = cross(earth, px), Tm = cross(moon, px);
  const pe = Te[1] - Te[0], pm = Tm[1] - Tm[0];
  assert.ok(rel(pm / pe, Math.sqrt(9.81 / 1.62)) < 0.04, `period ratio ${pm / pe}`);
  assert.ok(rel(pe, 2 * Math.PI * Math.sqrt(0.75 / 9.81)) < 0.03);
  const undamped = fork(fit, { drag: 0 }, { t1: 20, fps: 60 }), damped = fork(fit, {}, { t1: 20, fps: 60 });
  const amp = (f, from) => Math.max(...f.x.filter((_, i) => f.t[i] > from).map((x) => Math.abs(x - px)));
  assert.ok(amp(undamped, 15) > amp(damped, 15) * 1.3);
  assert.match(moon.summary, /^On the Moon the period is \d\.\d\d s instead of 1\.7\d s/);
});

test('floating object "on Earth" starts at the same place and falls; incline and oscillator forks behave', () => {
  const fl = fitAll(noisy(T.floatTrack({})));
  const f = fork(fl, { g: 'earth' }, { fps: 30 });
  assert.ok(Math.abs(f.x[0] - 0.6) < 0.02 && Math.abs(f.y[0] - 0.8) < 0.02);
  assert.ok(f.y.at(-1) < 0.8 - 30, 'falls ~ 1/2 g t^2 below its start over 4 s');
  const inc = fitAll(noisy(T.incline({})));
  const moon = fork(inc, { g: 'moon' }, { fps: 30 }), earth = fork(inc, {}, { fps: 30 });
  const dist = (r) => Math.hypot(r.x.at(-1) - r.x[0], r.y.at(-1) - r.y[0]);
  assert.ok(dist(moon) < dist(earth) / 2);
  const osc = fitAll(noisy(T.oscillator({})));
  const fo = fork(osc, { drag: 0 }, { t1: 12, fps: 30 });
  assert.ok(Math.max(...fo.y.filter((_, i) => fo.t[i] > 10).map((y) => Math.abs(y - 1.0))) > 0.1, 'undamped oscillation persists');
  assert.match(fork(osc, { g: 5 }, {}).summary, /does not change/);
});

test('output is JSON-serialisable and warns about unknown overrides', () => {
  const f = fork(dropFit(), { g: 'moon', banana: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(f)), JSON.parse(JSON.stringify(f)));
  assert.ok(f.warnings.some((w) => /banana/.test(w)));
  assert.ok(f.baseline && f.baseline.t.length > 10);
  assert.ok(fork(dropFit(), { g: 'moon' }, { baseline: false }).baseline === undefined);
  const single = fitModel(noisy(T.free({ y0: 2.3, dur: 0.66 })), 'projectile');
  assert.ok(fork(single, { g: 'mars' }).events.length >= 1, 'accepts the {data, fit} shape of fitModel');
  assert.throws(() => fork({ fits: [], data: {} }, {}), /applicable fit/);
});
