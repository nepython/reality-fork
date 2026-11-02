// Ground-truth trajectory generators for the physics tests.  They deliberately do NOT use
// lib/physics (separate closed forms / their own RK4), so the tests are not circular.

/** Small seeded PRNG (mulberry32) + Box-Muller Gaussian. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  return { u, gauss };
}

export const frames = (fps, dur) => Array.from({ length: Math.round(fps * dur) + 1 }, (_, i) => i / fps);

/** Add Gaussian noise (sigma metres), drop `gaps` random samples, corrupt `outliers` samples by ~30 cm. */
export function corrupt(track, { sigma = 0.0025, gaps = 2, outliers = 2, seed = 7 } = {}) {
  const { u, gauss } = rng(seed);
  const n = track.t.length;
  const x = track.x.map((v) => v + sigma * gauss());
  const y = track.y.map((v) => v + sigma * gauss());
  for (let k = 0; k < outliers; k++) { const i = 3 + Math.floor(u() * (n - 6)); x[i] += 0.3 * (u() < 0.5 ? 1 : -1); y[i] += 0.25 * (u() < 0.5 ? 1 : -1); }
  const drop = new Set();
  while (drop.size < gaps) drop.add(2 + Math.floor(u() * (n - 4)));
  const keep = track.t.map((_, i) => i).filter((i) => !drop.has(i));
  return { t: keep.map((i) => track.t[i]), x: keep.map((i) => x[i]), y: keep.map((i) => y[i]) };
}

export const free = ({ x0 = 0.5, y0 = 2, vx = 0, vy = 0, g = 9.81, fps = 30, dur = 0.6 } = {}) => {
  const t = frames(fps, dur);
  return { t, x: t.map((s) => x0 + vx * s), y: t.map((s) => y0 + vy * s - 0.5 * g * s * s) };
};

/** Quadratic drag by RK4 with a tiny step. */
export function drag({ x0 = 0.3, y0 = 0.4, vx = 4.5, vy = 5.5, g = 9.81, b = 0.05, fps = 30, dur = 1.1 } = {}) {
  const t = frames(fps, dur);
  let s = [x0, y0, vx, vy], tt = 0;
  const f = ([, , u, v]) => { const sp = Math.hypot(u, v); return [u, v, -b * sp * u, -g - b * sp * v]; };
  const out = { t, x: [], y: [] };
  for (const target of t) {
    while (tt < target - 1e-12) {
      const h = Math.min(0.0005, target - tt);
      const k1 = f(s), k2 = f(s.map((v, i) => v + 0.5 * h * k1[i])), k3 = f(s.map((v, i) => v + 0.5 * h * k2[i])), k4 = f(s.map((v, i) => v + h * k3[i]));
      s = s.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])); tt += h;
    }
    out.x.push(s[0]); out.y.push(s[1]);
  }
  return out;
}

/** Exact bouncing ball (closed-form arcs). */
export function bounce({ x0 = 0.4, y0 = 2.1, vx = 0.7, vy = 0, g = 9.81, e = 0.78, floor = 0.12, fps = 30, dur = 4.5 } = {}) {
  const t = frames(fps, dur);
  const arcs = [{ t: 0, y: y0, v: vy }];
  for (let i = 0; i < 60; i++) {
    const a = arcs.at(-1), tau = (a.v + Math.sqrt(a.v * a.v + 2 * g * (a.y - floor))) / g;
    const vin = a.v - g * tau;
    if (-vin * e < 0.05) break;
    arcs.push({ t: a.t + tau, y: floor, v: -e * vin });
  }
  const yAt = (s) => { let a = arcs[0]; for (const c of arcs) if (c.t <= s) a = c; const q = s - a.t; return Math.max(a.y + a.v * q - 0.5 * g * q * q, floor); };
  return { t, x: t.map((s) => x0 + vx * s), y: t.map(yAt) };
}

/** Damped pendulum by RK4. */
export function pendulum({ px = 2, py = 2.3, L = 0.75, theta0 = (25 * Math.PI) / 180, omega0 = 0, g = 9.81, gamma = 0.05, fps = 30, dur = 5 } = {}) {
  const t = frames(fps, dur);
  let s = [theta0, omega0], tt = 0;
  const f = ([th, om]) => [om, -(g / L) * Math.sin(th) - 2 * gamma * om];
  const out = { t, x: [], y: [] };
  for (const target of t) {
    while (tt < target - 1e-12) {
      const h = Math.min(0.001, target - tt);
      const k1 = f(s), k2 = f(s.map((v, i) => v + 0.5 * h * k1[i])), k3 = f(s.map((v, i) => v + 0.5 * h * k2[i])), k4 = f(s.map((v, i) => v + h * k3[i]));
      s = s.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])); tt += h;
    }
    out.x.push(px + L * Math.sin(s[0])); out.y.push(py - L * Math.cos(s[0]));
  }
  return out;
}

/** Rolling sphere on a ramp: a = (5/7) g sin(alpha). */
export function incline({ alphaDeg = 12, g = 9.81, x0 = 0.6, y0 = 1.0, v0 = 0, fps = 30, dur = 2.2 } = {}) {
  const al = (alphaDeg * Math.PI) / 180, a = (5 / 7) * g * Math.sin(al), t = frames(fps, dur);
  const s = t.map((q) => v0 * q + 0.5 * a * q * q);
  return { t, x: s.map((v) => x0 + v * Math.cos(al)), y: s.map((v) => y0 - v * Math.sin(al)), a };
}

export const floatTrack = ({ x0 = 0.6, y0 = 0.8, vx = 0.9, vy = 0.35, fps = 30, dur = 4 } = {}) => {
  const t = frames(fps, dur);
  return { t, x: t.map((s) => x0 + vx * s), y: t.map((s) => y0 + vy * s) };
};

/** Vertical mass on a spring, damped. */
export function oscillator({ x0 = 1.5, y0 = 1.0, A = 0.12, gamma = 0.35, omega = 2 * Math.PI * 1.2, phi = 0.4, fps = 30, dur = 5 } = {}) {
  const t = frames(fps, dur);
  return { t, x: t.map(() => x0), y: t.map((s) => y0 + A * Math.exp(-gamma * s) * Math.cos(omega * s + phi)) };
}
