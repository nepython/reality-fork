// Registry of candidate physical models.
//
// Conventions (see README of the physics core):
//  * a track is {t[s], x[m, right], y[m, UP], w?[0..1]}; before it reaches a model it has been
//    shifted so that t[0] = 0 (select.mjs does that), so every parameter is "at the first sample".
//  * gravity acts along -y and g is reported positive.
//  * parameters are a plain vector `p` ordered as `params`; `cov` is the matching covariance.
//
// Every model provides:
//   id, label, params[{name,unit,desc,lo?,hi?}]
//   guess(track)            -> p0 | null (null = clearly inapplicable)
//   predict(t[], p)         -> {x[], y[]}
//   state(p, t)             -> native state at time t (used by fork to start from the real footage)
//   derived(p, cov)         -> [{name,value,sigma,unit,desc}]  (1-sigma by numeric error propagation)
//   simulate(p, ov, {t0,t1,dt,floorY}) -> {t[],x[],y[],events[],notes[]}   (ov: resolved overrides)

import { levenbergMarquardt, polyfit, madSigma, median, propagate } from './fit.mjs';
import { integrateAt, ballisticAccel, simulateBallistic, rk4Step } from './ode.mjs';

const G_EARTH = 9.81;
const RAD = 180 / Math.PI;
const sq = (v) => v * v;
const range = (a) => Math.max(...a) - Math.min(...a);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const dtOf = (t) => median(t.slice(1).map((v, i) => v - t[i]));
const pct = (a, q) => { const s = [...a].sort((u, v) => u - v); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/**
 * Outlier removal for *initial guesses and noise estimates only*.  A sample is dropped when it
 * departs from the Theil-Sen line through its (up to six) neighbours by more than both 5 robust
 * sigmas and 4x how badly those neighbours disagree with that line.  The second test keeps
 * genuine kinks (a bounce's V, a turning point), where the neighbours themselves are not
 * straight; the median-based line tolerates a second bad mask next to the first.
 * The final fits are robust on their own and always use every sample.
 */
export function despike(track) {
  const { t, x, y, w } = track;
  const n = t.length;
  if (n < 9) return track;
  const dev = (a) => a.map((_, i) => {
    const nb = [];
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (j !== i) nb.push(j);
    if (nb.length < 4) return { d: 0, r: Infinity };
    const slopes = [];
    for (let p = 0; p < nb.length; p++) for (let q = p + 1; q < nb.length; q++) slopes.push((a[nb[q]] - a[nb[p]]) / (t[nb[q]] - t[nb[p]]));
    const m = median(slopes), c0 = median(nb.map((j) => a[j] - m * (t[j] - t[i])));
    const r = 1.4826 * median(nb.map((j) => Math.abs(a[j] - (c0 + m * (t[j] - t[i])))));
    return { d: Math.abs(a[i] - c0), r };
  });
  const dx = dev(x), dy = dev(y);
  const sx = Math.max(madSigma(dx.map((v) => v.d)), 1e-3), sy = Math.max(madSigma(dy.map((v) => v.d)), 1e-3);
  const bad = (v, s) => v.d > 5 * s && v.d > 4 * v.r;
  const keep = t.map((_, i) => i).filter((i) => !bad(dx[i], sx) && !bad(dy[i], sy));
  const pick = (a) => (a ? keep.map((i) => a[i]) : a);
  return { t: pick(t), x: pick(x), y: pick(y), w: pick(w) };
}

/** Build derived-quantity list from {name,unit,desc,f(p)} specs with propagated errors. */
function derive(specs, p, cov) {
  return specs.map(({ name, unit, desc, f }) => {
    let r;
    try { r = propagate(f, p, cov); } catch { r = { value: null, sigma: null }; }
    return { name, value: r.value, sigma: r.sigma, unit, desc };
  });
}

// ---------------------------------------------------------------- shared estimators
/** Robust polynomial start for the free-flight family: x linear, y quadratic. */
function ballisticStart(track) {
  const { t, x, y, w } = track;
  const [x0, vx] = polyfit(t, x, 1, w, true);
  const [y0, vy, c2] = polyfit(t, y, 2, w, true);
  return { x0, y0, vx, vy, g: -2 * c2 };
}

/** Principal axis of the points: {cx, cy, ux, uy, extent, perpRms}. */
function principalAxis(track) {
  const { x, y } = track;
  const cx = mean(x), cy = mean(y);
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) { sxx += sq(x[i] - cx); syy += sq(y[i] - cy); sxy += (x[i] - cx) * (y[i] - cy); }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const s = x.map((xi, i) => (xi - cx) * ux + (y[i] - cy) * uy);
  const perp = x.map((xi, i) => -(xi - cx) * uy + (y[i] - cy) * ux);
  // 85th percentile of |perp|: a few outliers cannot disqualify a line, but a curve cannot hide
  return { cx, cy, ux, uy, s, perp, extent: range(s), perpRms: pct(perp.map(Math.abs), 0.85) };
}

/**
 * Scan for a damped sinusoid s(t) = c + e^{-gamma t}(a cos wt + b sin wt).
 * For fixed (w, gamma) the fit is linear, so a 2-D grid + local refinement is robust where a
 * blind non-linear fit from a poor frequency guess is not.
 */
export function dampedSinusoidScan(t, s, { minCycles = 1, maxFrac = 0.8 } = {}) {
  const T = t[t.length - 1] - t[0];
  const dt = dtOf(t);
  const wMin = (2 * Math.PI * minCycles) / T;
  const wMax = (maxFrac * Math.PI) / dt;
  if (!(wMax > wMin)) return null;
  const total = s.reduce((acc, v) => acc + sq(v - mean(s)), 0) || 1e-12;
  const evalAt = (w, gam) => {
    // normal equations for basis [1, e cos, e sin]
    const B = t.map((ti) => { const e = Math.exp(-gam * ti); return [1, e * Math.cos(w * ti), e * Math.sin(w * ti)]; });
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
    for (let i = 0; i < t.length; i++) for (let a = 0; a < 3; a++) { r[a] += B[i][a] * s[i]; for (let b = 0; b < 3; b++) A[a][b] += B[i][a] * B[i][b]; }
    const c = solve3(A, r);
    if (!c) return null;
    let ssr = 0;
    for (let i = 0; i < t.length; i++) ssr += sq(s[i] - (c[0] * B[i][0] + c[1] * B[i][1] + c[2] * B[i][2]));
    return { w, gam, c: c[0], a: c[1], b: c[2], ssr, r2: 1 - ssr / total };
  };
  let best = null;
  const N = 260;
  for (let i = 0; i < N; i++) {
    const w = wMin * Math.pow(wMax / wMin, i / (N - 1));
    for (const gf of [0, 0.03, 0.08, 0.2]) {
      const r = evalAt(w, gf * w);
      if (r && (!best || r.ssr < best.ssr)) best = r;
    }
  }
  if (!best) return null;
  // local refinement of (w, gamma)
  for (let pass = 0; pass < 3; pass++) {
    const wStep = best.w * 0.02 / (pass + 1), gStep = Math.max(best.gam * 0.3, 0.01) / (pass + 1);
    for (let i = -6; i <= 6; i++) for (let j = -4; j <= 4; j++) {
      const r = evalAt(best.w + i * wStep / 3, Math.max(0, best.gam + j * gStep / 2));
      if (r && r.ssr < best.ssr) best = r;
    }
  }
  return best;
}
function solve3(A, b) {
  const [[a, bb, c], [d, e, f], [g, h, i]] = A;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-300) return null;
  const x = (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det;
  const y = (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det;
  const z = (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det;
  return [x, y, z];
}

/** Robust geometric circle fit: Kasa algebraic start, then LM on radial residuals. */
export function fitCircle(track) {
  const { x, y } = track;
  const n = x.length;
  if (n < 6) return null;
  // Kasa: x^2 + y^2 = 2 a x + 2 b y + c  (linear in a, b, c)
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const row = [2 * x[i], 2 * y[i], 1], rhs = x[i] * x[i] + y[i] * y[i];
    for (let a = 0; a < 3; a++) { r[a] += row[a] * rhs; for (let b = 0; b < 3; b++) A[a][b] += row[a] * row[b]; }
  }
  const s = solve3(A, r);
  if (!s) return null;
  const R0 = Math.sqrt(Math.max(s[2] + s[0] * s[0] + s[1] * s[1], 1e-12));
  if (!Number.isFinite(R0) || R0 > 1e4) return null;
  const fit = levenbergMarquardt({
    p0: [s[0], s[1], R0],
    residuals: (p) => x.map((xi, i) => Math.hypot(xi - p[0], y[i] - p[1]) - p[2]),
    weights: track.w, robust: true, maxIter: 40,
  });
  const radial = x.map((xi, i) => Math.abs(Math.hypot(xi - fit.p[0], y[i] - fit.p[1]) - fit.p[2]));
  return { cx: fit.p[0], cy: fit.p[1], R: fit.p[2], rms: fit.rms, p85: pct(radial, 0.85) };
}

const noWeights = (track) => track.w;

// ================================================================ 1. constant velocity
const constantVelocity = {
  id: 'constant-velocity',
  label: 'Constant velocity (no net force, e.g. floating in orbit)',
  params: [
    { name: 'x0', unit: 'm', desc: 'x at first sample' },
    { name: 'y0', unit: 'm', desc: 'y at first sample' },
    { name: 'vx', unit: 'm/s', desc: 'horizontal velocity' },
    { name: 'vy', unit: 'm/s', desc: 'vertical velocity (up positive)' },
  ],
  guess(track) {
    const [x0, vx] = polyfit(track.t, track.x, 1, noWeights(track), true);
    const [y0, vy] = polyfit(track.t, track.y, 1, noWeights(track), true);
    return [x0, y0, vx, vy];
  },
  predict: (t, [x0, y0, vx, vy]) => ({ x: t.map((ti) => x0 + vx * ti), y: t.map((ti) => y0 + vy * ti) }),
  state: ([x0, y0, vx, vy], t) => ({ x: x0 + vx * t, y: y0 + vy * t, vx, vy }),
  derived: (p, cov) => derive([
    { name: 'speed', unit: 'm/s', desc: 'speed |v|', f: (q) => Math.hypot(q[2], q[3]) },
    { name: 'direction', unit: 'deg', desc: 'direction of travel, degrees above +x', f: (q) => Math.atan2(q[3], q[2]) * RAD },
  ], p, cov),
  // Baseline has no gravity. An override g makes the object accelerate: "what if it were on Earth?".
  simulate(p, ov, opts) {
    const s = this.state(p, opts.t0);
    const g = ov.g ?? 0;
    const b = ov.b ?? 0;
    return simulateBallistic({ ...s, g, b, e: ov.e ?? 0, floorY: opts.floorY, t0: opts.t0, t1: opts.t1, dt: opts.dt });
  },
};

// ================================================================ 2. projectile
const projectile = {
  id: 'projectile',
  label: 'Projectile in free fall (gravity only, no air drag)',
  params: [
    { name: 'x0', unit: 'm', desc: 'x at first sample' },
    { name: 'y0', unit: 'm', desc: 'y at first sample' },
    { name: 'vx', unit: 'm/s', desc: 'horizontal velocity' },
    { name: 'vy', unit: 'm/s', desc: 'vertical velocity at first sample (up positive)' },
    { name: 'g', unit: 'm/s^2', desc: 'gravitational acceleration (positive down)' },
  ],
  guess(track) {
    const s = ballisticStart(track);
    return [s.x0, s.y0, s.vx, s.vy, Number.isFinite(s.g) ? s.g : G_EARTH];
  },
  predict: (t, [x0, y0, vx, vy, g]) => ({
    x: t.map((ti) => x0 + vx * ti),
    y: t.map((ti) => y0 + vy * ti - 0.5 * g * ti * ti),
  }),
  state: ([x0, y0, vx, vy, g], t) => ({ x: x0 + vx * t, y: y0 + vy * t - 0.5 * g * t * t, vx, vy: vy - g * t }),
  derived: (p, cov) => derive([
    { name: 'g', unit: 'm/s^2', desc: 'gravitational acceleration', f: (q) => q[4] },
    { name: 'launch_speed', unit: 'm/s', desc: 'speed at first sample', f: (q) => Math.hypot(q[2], q[3]) },
    { name: 'launch_angle', unit: 'deg', desc: 'angle above horizontal at first sample', f: (q) => Math.atan2(q[3], q[2]) * RAD },
    { name: 'apex_height', unit: 'm', desc: 'highest y reached (in the same frame as y)', f: (q) => q[1] + sq(Math.max(q[3], 0)) / (2 * q[4]) },
  ], p, cov),
  simulate(p, ov, opts) {
    const s = this.state(p, opts.t0);
    return simulateBallistic({ ...s, g: ov.g ?? p[4], b: ov.b ?? 0, e: ov.e ?? 0, floorY: opts.floorY, t0: opts.t0, t1: opts.t1, dt: opts.dt });
  },
};

// ================================================================ 3. projectile with quadratic drag
const dragIntegrate = ([x0, y0, vx, vy, g, b], times) => integrateAt(ballisticAccel(g, b), [x0, y0, vx, vy], times, 0.004);
const projectileDrag = {
  id: 'projectile-drag',
  label: 'Projectile with quadratic air drag (a = -b|v|v - g)',
  params: [
    { name: 'x0', unit: 'm', desc: 'x at first sample' },
    { name: 'y0', unit: 'm', desc: 'y at first sample' },
    { name: 'vx', unit: 'm/s', desc: 'horizontal velocity at first sample' },
    { name: 'vy', unit: 'm/s', desc: 'vertical velocity at first sample' },
    { name: 'g', unit: 'm/s^2', desc: 'gravitational acceleration' },
    { name: 'b', unit: '1/m', desc: 'drag coefficient c/m = rho Cd A / (2 m)', lo: 0, hi: 20 },
  ],
  guess(track) {
    const s = ballisticStart(track);
    return [s.x0, s.y0, s.vx, s.vy, Number.isFinite(s.g) ? s.g : G_EARTH, 0.01];
  },
  predict(t, p) {
    const st = dragIntegrate(p, t);
    return { x: st.map((s) => s[0]), y: st.map((s) => s[1]) };
  },
  state(p, t) { const [s] = dragIntegrate(p, [t]); return { x: s[0], y: s[1], vx: s[2], vy: s[3] }; },
  derived: (p, cov) => derive([
    { name: 'g', unit: 'm/s^2', desc: 'gravitational acceleration', f: (q) => q[4] },
    { name: 'drag_b', unit: '1/m', desc: 'drag coefficient b = c/m', f: (q) => q[5] },
    { name: 'terminal_velocity', unit: 'm/s', desc: 'sqrt(g/b): speed at which drag balances gravity (null if b <= 0)', f: (q) => (q[5] > 1e-6 ? Math.sqrt(q[4] / q[5]) : NaN) },
    { name: 'launch_speed', unit: 'm/s', desc: 'speed at first sample', f: (q) => Math.hypot(q[2], q[3]) },
  ], p, cov),
  simulate(p, ov, opts) {
    const s = this.state(p, opts.t0);
    const b = ov.b ?? (p[5] * (ov.dragScale ?? 1)) / (ov.massScale ?? 1);
    return simulateBallistic({ ...s, g: ov.g ?? p[4], b, e: ov.e ?? 0, floorY: opts.floorY, t0: opts.t0, t1: opts.t1, dt: opts.dt });
  },
};

// ================================================================ 4. bouncing ball
/**
 * Piecewise-parabolic bouncing trajectory (exact, no integration).  Returns arcs
 * [{t, y, vy}] giving the state at the start of each arc (t=0 and each floor contact) and the
 * contact events.  The motion ends (rests on the floor) when the rebound is negligible.
 */
function bounceArcs([, y0, , vy0, g, e, floor], tMax) {
  const G = Math.max(g, 1e-3), E = Math.min(Math.max(e, 0), 1.2);
  const arcs = [{ t: 0, y: Math.max(y0, floor), vy: vy0 }];
  const events = [];
  for (let n = 0; n < 80; n++) {
    const a = arcs[arcs.length - 1];
    const disc = a.vy * a.vy + 2 * G * (a.y - floor);
    const tau = (a.vy + Math.sqrt(Math.max(disc, 0))) / G; // time until y returns to the floor
    const tc = a.t + tau;
    if (!(tc < tMax)) break;
    const vImpact = a.vy - G * tau; // negative
    const vUp = -E * vImpact;
    events.push({ t: tc, speed: -vImpact });
    if (vUp < 0.05 || tau < 1e-4) { arcs.push({ t: tc, y: floor, vy: 0, rest: true }); break; }
    arcs.push({ t: tc, y: floor, vy: vUp });
  }
  return { arcs, events };
}
function bounceY(p, times) {
  const tMax = Math.max(...times, 0) + 1e-6;
  const { arcs } = bounceArcs(p, tMax);
  const G = Math.max(p[4], 1e-3);
  return times.map((ti) => {
    let a = arcs[0];
    for (let i = arcs.length - 1; i >= 0; i--) if (arcs[i].t <= ti) { a = arcs[i]; break; }
    if (a.rest) return p[6];
    const tau = ti - a.t;
    return Math.max(a.y + a.vy * tau - 0.5 * G * tau * tau, p[6]);
  });
}

/** Local minima of y that look like floor contacts (descending, then rising again). */
function detectBounces(track) {
  const { t, y } = track;
  const n = y.length, dt = dtOf(t);
  const m = Math.max(2, Math.ceil(0.07 / dt));
  const yMin = Math.min(...y), yr = range(y);
  const rise = Math.max(0.035 * yr, 0.02);
  const found = [];
  for (let i = m; i < n - m; i++) {
    let isMin = true;
    for (let j = i - m; j <= i + m; j++) if (y[j] < y[i]) { isMin = false; break; }
    if (!isMin) continue;
    if (y[i] - yMin > 0.15 * yr + 0.02) continue;                      // must be near the floor
    const before = Math.max(...y.slice(i - m, i)), after = Math.max(...y.slice(i + 1, i + m + 1));
    if (before - y[i] < rise || after - y[i] < rise) continue;           // must come down AND go back up
    if (found.length && i - found[found.length - 1] <= 2 * m) { if (y[i] < y[found[found.length - 1]]) found[found.length - 1] = i; } else found.push(i);
  }
  return found;
}

const quadAt = (c, t) => c[0] + c[1] * t + c[2] * t * t;
const quadVel = (c, t) => c[1] + 2 * c[2] * t;

function bounceGuess(raw) {
  const track = despike(raw);          // a bad mask below the floor must not move the "floor"
  const { t, x, y, w } = track;
  const bounces = detectBounces(track);
  if (!bounces.length) return null;
  const idx = [0, ...bounces, t.length - 1];
  // fit one parabola per flight arc, skipping the samples nearest each kink
  const arcs = [];
  for (let a = 0; a < idx.length - 1; a++) {
    const lo = a === 0 ? 0 : idx[a] + 1, hi = a === idx.length - 2 ? t.length - 1 : idx[a + 1] - 1;
    if (hi - lo + 1 < 4) { arcs.push(null); continue; }
    const tt = t.slice(lo, hi + 1), yy = y.slice(lo, hi + 1);
    arcs.push({ c: polyfit(tt, yy, 2, w && w.slice(lo, hi + 1), true), n: hi - lo + 1 });
  }
  const gs = arcs.filter((a) => a && a.c[2] < 0 && a.n >= 5).map((a) => -2 * a.c[2]);
  const g = gs.length ? median(gs) : G_EARTH;
  const yc = [], es = [];
  for (let k = 0; k < bounces.length; k++) {
    const A = arcs[k], B = arcs[k + 1];
    if (!A || !B) continue;
    // contact instant: where the neighbouring parabolas intersect, nearest the detected minimum
    const d2 = A.c[2] - B.c[2], d1 = A.c[1] - B.c[1], d0 = A.c[0] - B.c[0];
    const roots = Math.abs(d2) > 1e-9
      ? (() => { const D = d1 * d1 - 4 * d2 * d0; return D < 0 ? [] : [(-d1 + Math.sqrt(D)) / (2 * d2), (-d1 - Math.sqrt(D)) / (2 * d2)]; })()
      : Math.abs(d1) > 1e-12 ? [-d0 / d1] : [];
    const tb = t[bounces[k]];
    const tc = roots.filter((r) => Math.abs(r - tb) < 4 * dtOf(t) + 0.05).sort((a, b) => Math.abs(a - tb) - Math.abs(b - tb))[0];
    if (tc === undefined) continue;
    yc.push(quadAt(A.c, tc));
    const vin = quadVel(A.c, tc), vout = quadVel(B.c, tc);
    if (vin < 0 && vout > 0) es.push(-vout / vin);
  }
  const floor = yc.length ? median(yc) : Math.min(...y);
  const e = es.length ? Math.min(Math.max(median(es), 0.05), 1) : 0.7;
  const first = arcs[0] ?? { c: polyfit(t.slice(0, 6), y.slice(0, 6), 2) };
  const [x0, vx] = polyfit(t, x, 1, w, true);
  return [x0, quadAt(first.c, 0), vx, quadVel(first.c, 0), g, e, floor];
}

const bounce = {
  id: 'bounce',
  label: 'Bouncing ball (free flight between floor impacts, restitution e)',
  params: [
    { name: 'x0', unit: 'm', desc: 'x at first sample' },
    { name: 'y0', unit: 'm', desc: 'y of the ball centre at first sample' },
    { name: 'vx', unit: 'm/s', desc: 'horizontal velocity (constant between impacts)' },
    { name: 'vy', unit: 'm/s', desc: 'vertical velocity at first sample' },
    { name: 'g', unit: 'm/s^2', desc: 'gravitational acceleration' },
    { name: 'e', unit: '', desc: 'coefficient of restitution (rebound speed / impact speed)', lo: 0, hi: 1.05 },
    { name: 'floorY', unit: 'm', desc: 'y of the ball centre when touching the floor' },
  ],
  guess: bounceGuess,
  predict: (t, p) => ({ x: t.map((ti) => p[0] + p[2] * ti), y: bounceY(p, t) }),
  state(p, t) {
    const [y] = bounceY(p, [t]), h = 1e-4;
    const vy = (bounceY(p, [t + h])[0] - bounceY(p, [Math.max(t - h, 0)])[0]) / (t + h - Math.max(t - h, 0));
    return { x: p[0] + p[2] * t, y, vx: p[2], vy };
  },
  derived(p, cov) {
    const { events } = bounceArcs(p, 1e3);
    const e = p[5];
    return [
      ...derive([
        { name: 'g', unit: 'm/s^2', desc: 'gravitational acceleration', f: (q) => q[4] },
        { name: 'e', unit: '', desc: 'coefficient of restitution', f: (q) => q[5] },
        { name: 'energy_lost_per_bounce', unit: 'fraction', desc: '1 - e^2: share of kinetic energy lost at each impact', f: (q) => 1 - sq(q[5]) },
      ], p, cov),
      { name: 'bounce_count_in_clip', value: events.length, sigma: null, unit: '', desc: 'floor impacts predicted before the ball comes to rest' },
    ];
  },
  simulate(p, ov, opts) {
    const s = this.state(p, opts.t0);
    return simulateBallistic({ ...s, g: ov.g ?? p[4], b: ov.b ?? 0, e: ov.e ?? p[5], floorY: p[6], t0: opts.t0, t1: opts.t1, dt: opts.dt });
  },
};

// ================================================================ 5. pendulum
const pendRHS = (g, L, gam) => (_t, [th, om]) => [om, -(g / L) * Math.sin(th) - 2 * gam * om];
const pendTheta = (p, times) => integrateAt(pendRHS(p[5], p[2], p[6]), [p[3], p[4]], times, 0.004);

const pendulum = {
  id: 'pendulum',
  label: 'Damped pendulum (bob on a circle: theta\'\' = -(g/L) sin(theta) - 2 gamma theta\')',
  params: [
    { name: 'px', unit: 'm', desc: 'pivot x' },
    { name: 'py', unit: 'm', desc: 'pivot y' },
    { name: 'L', unit: 'm', desc: 'effective length, pivot to bob centre', lo: 0.01, hi: 50 },
    { name: 'theta0', unit: 'rad', desc: 'angle from straight down at first sample (+ = to the right)' },
    { name: 'omega0', unit: 'rad/s', desc: 'angular velocity at first sample' },
    { name: 'g', unit: 'm/s^2', desc: 'gravitational acceleration', lo: 0.01, hi: 100 },
    { name: 'gamma', unit: '1/s', desc: 'amplitude damping rate (amplitude ~ e^{-gamma t})', lo: 0, hi: 5 },
  ],
  guess(track) {
    const { t, x, y } = despike(track);
    const c = fitCircle({ t, x, y });
    if (!c) return null;
    const ext = Math.hypot(range(x), range(y));
    if (!(c.R > 0.02 && c.R < 8 * ext)) return null;            // nearly straight or tiny: not an arc
    if (!(c.cy > mean(y))) return null;                           // pivot must be above the bob
    if (c.p85 > 0.03 * c.R + 0.008) return null;                  // points must hug the circle
    const th = x.map((xi, i) => Math.atan2(xi - c.cx, -(y[i] - c.cy)));
    if (range(th) < 0.1 || Math.max(...th.map(Math.abs)) > 2.6) return null;
    const sc = dampedSinusoidScan(t, th, { minCycles: 0.75 });
    if (!sc || sc.r2 < 0.6) return null;
    const amp = Math.hypot(sc.a, sc.b);
    const wd = sc.w / (1 - sq(amp) / 16);                         // undo the amplitude-dependent period
    const g0 = (sq(wd) + sq(sc.gam)) * c.R;
    return [c.cx, c.cy, c.R, sc.c + sc.a, -sc.gam * sc.a + sc.w * sc.b, g0, sc.gam];
  },
  predict(t, p) {
    const st = pendTheta(p, t);
    return { x: st.map((s) => p[0] + p[2] * Math.sin(s[0])), y: st.map((s) => p[1] - p[2] * Math.cos(s[0])) };
  },
  state(p, t) { const [s] = pendTheta(p, [t]); return { th: s[0], om: s[1] }; },
  derived: (p, cov) => derive([
    { name: 'g', unit: 'm/s^2', desc: 'gravitational acceleration (uses the fitted length, so its error includes L)', f: (q) => q[5] },
    { name: 'L', unit: 'm', desc: 'pendulum length (pivot to bob centre)', f: (q) => q[2] },
    { name: 'period_small_angle', unit: 's', desc: '2 pi sqrt(L/g): period for small swings', f: (q) => 2 * Math.PI * Math.sqrt(q[2] / q[5]) },
    { name: 'period_at_start_amplitude', unit: 's', desc: 'period corrected for the first-sample amplitude (series in theta^2)', f: (q) => 2 * Math.PI * Math.sqrt(q[2] / q[5]) * (1 + sq(Math.hypot(q[3], q[4] * Math.sqrt(q[2] / q[5]))) / 16 + (11 * sq(sq(Math.hypot(q[3], q[4] * Math.sqrt(q[2] / q[5])))) ) / 3072) },
    { name: 'damping_time', unit: 's', desc: '1/gamma: time for the amplitude to fall by 1/e (null if not damped)', f: (q) => (q[6] > 1e-4 ? 1 / q[6] : NaN) },
    { name: 'Q', unit: '', desc: 'quality factor sqrt(g/L) / (2 gamma) (null if not damped)', f: (q) => (q[6] > 1e-4 ? Math.sqrt(q[5] / q[2]) / (2 * q[6]) : NaN) },
  ], p, cov),
  // Fork: continue the real swing from its state at t0 under changed g / damping.
  simulate(p, ov, opts) {
    const s0 = this.state(p, opts.t0);
    const g = ov.g ?? p[5];
    const gam = ov.b !== undefined ? ov.b : p[6] * (ov.dragScale ?? 1);
    const f = pendRHS(g, p[2], gam);
    const out = { t: [], x: [], y: [], events: [], notes: [] };
    let y = [s0.th, s0.om], t = opts.t0;
    const n = Math.max(0, Math.round((opts.t1 - opts.t0) / opts.dt));
    const sub = Math.max(1, Math.ceil(opts.dt / 0.004));
    for (let k = 0; k <= n; k++) {
      out.t.push(t); out.x.push(p[0] + p[2] * Math.sin(y[0])); out.y.push(p[1] - p[2] * Math.cos(y[0]));
      for (let i = 0; i < sub; i++) y = rk4Step(f, t, y, opts.dt / sub);
      t += opts.dt;
    }
    if (ov.massScale !== undefined && ov.massScale !== 1) out.notes.push('A pendulum\'s motion does not depend on the bob mass (ignoring air drag), so mass has no effect.');
    out.period = 2 * Math.PI * Math.sqrt(p[2] / g);
    return out;
  },
};

// ================================================================ 6. incline
const inclineModel = {
  id: 'incline',
  label: 'Motion along a straight incline with constant acceleration',
  params: [
    { name: 'x0', unit: 'm', desc: 'x at first sample' },
    { name: 'y0', unit: 'm', desc: 'y at first sample' },
    { name: 'phi', unit: 'rad', desc: 'direction of the down-slope axis (angle from +x; sin < 0 means downhill)', lo: -Math.PI - 0.3, hi: 0.3 },
    { name: 'v0', unit: 'm/s', desc: 'speed along the down-slope direction at first sample' },
    { name: 'a', unit: 'm/s^2', desc: 'acceleration along the down-slope direction' },
  ],
  guess(track) {
    track = despike(track);
    const ax = principalAxis(track);
    if (ax.extent < 0.05 || ax.perpRms > 0.04 * ax.extent + 0.01) return null;
    let { ux, uy } = ax;
    if (uy > 0 || (uy === 0 && ux < 0)) { ux = -ux; uy = -uy; }       // orient down-slope
    const alpha = Math.atan2(Math.abs(uy), Math.abs(ux)) * RAD;
    if (alpha > 75) return null;                                       // essentially vertical: that's free fall
    const s = track.x.map((xi, i) => (xi - ax.cx) * ux + (track.y[i] - ax.cy) * uy);
    const [s0, v0, c2] = polyfit(track.t, s, 2, track.w, true);
    return [ax.cx + s0 * ux, ax.cy + s0 * uy, Math.atan2(uy, ux), v0, 2 * c2];
  },
  predict: (t, [x0, y0, phi, v0, a]) => {
    const ux = Math.cos(phi), uy = Math.sin(phi);
    const s = t.map((ti) => v0 * ti + 0.5 * a * ti * ti);
    return { x: s.map((si) => x0 + si * ux), y: s.map((si) => y0 + si * uy) };
  },
  state: ([x0, y0, phi, v0, a], t) => {
    const ux = Math.cos(phi), uy = Math.sin(phi), s = v0 * t + 0.5 * a * t * t, v = v0 + a * t;
    return { x: x0 + s * ux, y: y0 + s * uy, vx: v * ux, vy: v * uy, s, v };
  },
  derived: (p, cov) => derive([
    { name: 'a', unit: 'm/s^2', desc: 'acceleration along the slope', f: (q) => q[4] },
    { name: 'alpha', unit: 'deg', desc: 'slope angle to the horizontal', f: (q) => Math.atan2(Math.abs(Math.sin(q[2])), Math.abs(Math.cos(q[2]))) * RAD },
    { name: 'g_if_rolling_sphere', unit: 'm/s^2', desc: 'g implied if this is a solid sphere rolling without slipping: a = (5/7) g sin(alpha)', f: (q) => q[4] / ((5 / 7) * Math.abs(Math.sin(q[2]))) },
    { name: 'g_if_sliding_frictionless', unit: 'm/s^2', desc: 'g implied for a frictionless sliding block: a = g sin(alpha)', f: (q) => q[4] / Math.abs(Math.sin(q[2])) },
    { name: 'mu_if_sliding_on_earth', unit: '', desc: 'kinetic friction coefficient if a sliding block on Earth (g = 9.81): mu = tan(alpha) - a / (g cos(alpha))', f: (q) => { const al = Math.atan2(Math.abs(Math.sin(q[2])), Math.abs(Math.cos(q[2]))); return Math.tan(al) - q[4] / (G_EARTH * Math.cos(al)); } },
  ], p, cov),
  // Fork: acceleration along the slope scales with g (rolling sphere, frictionless or kinetic friction alike).
  simulate(p, ov, opts) {
    const s0 = this.state(p, opts.t0);
    const gScale = ov.g !== undefined ? ov.g / G_EARTH : 1;
    const a = p[4] * gScale;
    const ux = Math.cos(p[2]), uy = Math.sin(p[2]);
    const out = { t: [], x: [], y: [], events: [], notes: [] };
    const n = Math.max(0, Math.round((opts.t1 - opts.t0) / opts.dt));
    for (let k = 0; k <= n; k++) {
      const tau = k * opts.dt, s = s0.s + s0.v * tau + 0.5 * a * tau * tau;
      out.t.push(opts.t0 + tau); out.x.push(p[0] + s * ux); out.y.push(p[1] + s * uy);
    }
    if (ov.g !== undefined) out.notes.push('Assumes the acceleration along the ramp scales in proportion to g (true for a rolling sphere and for a block with kinetic friction); the measured Earth-g value is taken as 9.81.');
    out.accel = a;
    return out;
  },
};

// ================================================================ 7. damped oscillator
const oscModel = {
  id: 'oscillator',
  label: 'Damped harmonic oscillator along one axis (mass on a spring)',
  params: [
    { name: 'x0', unit: 'm', desc: 'equilibrium x' },
    { name: 'y0', unit: 'm', desc: 'equilibrium y' },
    { name: 'psi', unit: 'rad', desc: 'axis of oscillation, angle from +x (pi/2 = vertical)' },
    { name: 'A', unit: 'm', desc: 'amplitude at first sample (signed)' },
    { name: 'gamma', unit: '1/s', desc: 'amplitude damping rate', lo: 0, hi: 20 },
    { name: 'omega', unit: 'rad/s', desc: 'angular frequency of the damped oscillation', lo: 0.05, hi: 400 },
    { name: 'phi', unit: 'rad', desc: 'phase at first sample' },
  ],
  guess(track) {
    const clean = despike(track);
    const ac = principalAxis(clean);
    if (ac.extent < 0.02 || ac.perpRms > 0.04 * ac.extent + 0.01) return null; // must move along a line
    const sc = dampedSinusoidScan(clean.t, ac.s, { minCycles: 1 });
    if (!sc || sc.r2 < 0.8) return null;
    const A = Math.hypot(sc.a, sc.b), phi = Math.atan2(-sc.b, sc.a);
    return [ac.cx + sc.c * ac.ux, ac.cy + sc.c * ac.uy, Math.atan2(ac.uy, ac.ux), A, sc.gam, sc.w, phi];
  },
  predict: (t, [x0, y0, psi, A, gam, w, phi]) => {
    const s = t.map((ti) => A * Math.exp(-gam * ti) * Math.cos(w * ti + phi));
    return { x: s.map((si) => x0 + si * Math.cos(psi)), y: s.map((si) => y0 + si * Math.sin(psi)) };
  },
  state([, , , A, gam, w, phi], t) {
    const e = Math.exp(-gam * t);
    return { s: A * e * Math.cos(w * t + phi), v: A * e * (-gam * Math.cos(w * t + phi) - w * Math.sin(w * t + phi)), gam, w };
  },
  derived: (p, cov) => derive([
    { name: 'omega', unit: 'rad/s', desc: 'angular frequency of the damped oscillation', f: (q) => q[5] },
    { name: 'period', unit: 's', desc: 'period 2 pi / omega', f: (q) => (2 * Math.PI) / q[5] },
    { name: 'frequency', unit: 'Hz', desc: 'frequency omega / 2 pi', f: (q) => q[5] / (2 * Math.PI) },
    { name: 'gamma', unit: '1/s', desc: 'amplitude damping rate', f: (q) => q[4] },
    { name: 'damping_time', unit: 's', desc: '1/gamma: amplitude e-folding time (null if not damped)', f: (q) => (q[4] > 1e-4 ? 1 / q[4] : NaN) },
    { name: 'Q', unit: '', desc: 'quality factor omega_n / (2 gamma) (null if not damped)', f: (q) => (q[4] > 1e-4 ? Math.hypot(q[5], q[4]) / (2 * q[4]) : NaN) },
    { name: 'spring_over_mass', unit: '1/s^2', desc: 'k/m = omega^2 + gamma^2 (natural frequency squared)', f: (q) => sq(q[5]) + sq(q[4]) },
  ], p, cov),
  // Fork: spring constant fixed, so omega_n^2 = k/m scales as 1/massScale and gamma = c/2m as 1/massScale.
  simulate(p, ov, opts) {
    const s0 = this.state(p, opts.t0);
    const ms = ov.massScale ?? 1;
    const gam = ov.b !== undefined ? ov.b : (p[4] * (ov.dragScale ?? 1)) / ms;
    const wn2 = (sq(p[5]) + sq(p[4])) / ms;
    const f = (_t, [s, v]) => [v, -wn2 * s - 2 * gam * v];
    const out = { t: [], x: [], y: [], events: [], notes: [] };
    let y = [s0.s, s0.v], t = opts.t0;
    const n = Math.max(0, Math.round((opts.t1 - opts.t0) / opts.dt));
    const sub = Math.max(1, Math.ceil(opts.dt / 0.004));
    for (let k = 0; k <= n; k++) {
      out.t.push(t); out.x.push(p[0] + y[0] * Math.cos(p[2])); out.y.push(p[1] + y[0] * Math.sin(p[2]));
      for (let i = 0; i < sub; i++) y = rk4Step(f, t, y, opts.dt / sub);
      t += opts.dt;
    }
    if (ov.g !== undefined) out.notes.push('Gravity only shifts the equilibrium of a mass on a spring; the oscillation itself is unchanged, so g has no effect here.');
    out.period = 2 * Math.PI / Math.sqrt(Math.max(wn2 - sq(gam), 1e-12));
    return out;
  },
};

export const MODEL_LIST = [constantVelocity, projectile, projectileDrag, bounce, pendulum, inclineModel, oscModel];
export const MODELS = Object.fromEntries(MODEL_LIST.map((m) => [m.id, m]));
export { G_EARTH };
