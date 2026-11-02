// Synthetic benchmark scenes with EXACTLY known physics.
//
// World frame: metres on the wall plane, X to the right, Y UP, origin where the floor contact
// line meets X = 0.  The camera is a fixed, fronto-parallel pinhole, so the image is a pure
// scale + flip of the world: px = ox + X * S,  py = oy - Y * S.
//
// Truth is generated here by closed forms or a tiny-step RK4 that does not share any code with
// lib/physics, so benchmarks against these clips are not circular.

export const CAMERA = {
  width: 1280, height: 720,
  pxPerMetre: 260,        // scale on the wall plane (also the scale of the A4 sheet)
  ox: 105, oy: 650,       // pixel of world origin (X=0, Y=0); Y=0 is the floor contact line
  wallBase: 612,          // pixel row where the wall meets the floor
};
export const A4 = { w: 0.210, h: 0.297, X: 4.12, Y: 1.00 }; // portrait sheet pinned on the wall (lower-left corner)

export const G = { earth: 9.81, moon: 1.62 };
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Tabulate a smooth trajectory computed with RK4 at h = 0.5 ms and read it back by interpolation. */
function tabulated(f, s0, tEnd, stop) {
  const h = 0.0005, table = [s0.slice()];
  let s = s0.slice(), t = 0, rest = null;
  const add = (a, b, k) => a.map((v, i) => v + k * b[i]);
  while (t < tEnd) {
    const k1 = f(s), k2 = f(add(s, k1, h / 2)), k3 = f(add(s, k2, h / 2)), k4 = f(add(s, k3, h));
    s = s.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    t += h;
    if (stop && stop(s)) { rest = { t, s: s.slice() }; break; }
    table.push(s.slice());
  }
  const read = (time) => {
    if (rest && time >= rest.t) return rest.s;
    const q = clamp(time, 0, (table.length - 1) * h) / h, i = Math.min(Math.floor(q), table.length - 2), fr = q - i;
    return table[i].map((v, j) => v + fr * (table[i + 1][j] - v));
  };
  read.tStop = rest ? rest.t : null;   // time the stop condition fired (e.g. landing)
  return read;
}

// ---------------------------------------------------------------- scene factories
function dropScene({ id, title, fps, duration, theme, g, tRel = 0.4, Y0 = 2.35, X = 1.5, d = 0.24 }) {
  const r = d / 2, T = Math.sqrt((2 * (Y0 - r)) / g);
  return {
    id, title, fps, duration, theme, expected_model: 'projectile',
    ball: { kind: 'basketball', diameter: d },
    params: { g, x0: X, y0: Y0, vx: 0, vy: 0, release_time: tRel },
    events: [{ type: 'release', t: tRel }, { type: 'floor_contact', t: tRel + T }],
    motion_window: [tRel, tRel + T],
    floor_y_m: r,
    // Stationary at the release point, falls freely, then rests on the floor (no bounce).
    motion(t) { const s = clamp(t - tRel, 0, T); return { X, Y: Y0 - 0.5 * g * s * s, rot: 0 }; },
  };
}

function throwScene() {
  const d = 0.067, r = d / 2, g = G.earth, b = 0.03, x0 = 0.35, y0 = 0.9, vx = 3.9, vy = 4.4;
  const f = ([, , u, v]) => { const sp = Math.hypot(u, v); return [u, v, -b * sp * u, -g - b * sp * v]; };
  const path = tabulated(f, [x0, y0, vx, vy], 5, (s) => s[1] <= r && s[3] < 0);
  const tLand = path.tStop;
  return {
    id: 'throw', title: 'Tennis ball thrown, with mild air drag', fps: 30, duration: 2.4, theme: 'room', expected_model: 'projectile-drag',
    ball: { kind: 'tennis', diameter: d },
    params: { g, drag_b: b, x0, y0, vx, vy },
    events: [{ type: 'floor_contact', t: tLand }],
    motion_window: [0, tLand],
    floor_y_m: r,
    motion(t) { const s = path(t); return { X: s[0], Y: Math.max(s[1], r), rot: 9 * Math.min(t, tLand) }; },
  };
}

function bounceScene() {
  const d = 0.24, r = d / 2, g = G.earth, e = 0.78, x0 = 0.5, y0 = 2.3, vx = 0.75, vy = 0;
  const arcs = [{ t: 0, y: y0, v: vy }];
  for (let i = 0; i < 80; i++) {
    const a = arcs[arcs.length - 1], tau = (a.v + Math.sqrt(a.v * a.v + 2 * g * (a.y - r))) / g, vin = a.v - g * tau;
    if (-vin * e < 0.04) break;
    arcs.push({ t: a.t + tau, y: r, v: -e * vin });
  }
  const contacts = arcs.slice(1).map((a) => a.t);
  return {
    id: 'bounce', title: 'Basketball bouncing, e = 0.78', fps: 30, duration: 5, theme: 'room', expected_model: 'bounce',
    ball: { kind: 'basketball', diameter: d },
    params: { g, e, floorY: r, x0, y0, vx, vy },
    events: contacts.map((t) => ({ type: 'floor_contact', t })),
    motion_window: [0, 5],
    floor_y_m: r,
    motion(t) {
      let a = arcs[0]; for (const c of arcs) if (c.t <= t) a = c;
      const q = t - a.t;
      return { X: x0 + vx * t, Y: Math.max(a.y + a.v * q - 0.5 * g * q * q, r), rot: 1.5 * t };
    },
  };
}

function pendulumScene() {
  const d = 0.24, g = G.earth, L = 0.75, th0 = 25 * DEG, gamma = 0.04, px = 2.2, py = 2.35;
  const f = ([th, om]) => [om, -(g / L) * Math.sin(th) - 2 * gamma * om];
  const path = tabulated(f, [th0, 0], 6);
  return {
    id: 'pendulum', title: 'Pendulum released from 25 degrees', fps: 30, duration: 5, theme: 'room', expected_model: 'pendulum',
    ball: { kind: 'basketball', diameter: d },
    params: { g, L, theta0_deg: 25, theta0: th0, omega0: 0, gamma, pivot_x: px, pivot_y: py, period_small_angle: 2 * Math.PI * Math.sqrt(L / g) },
    events: [{ type: 'release', t: 0 }],
    motion_window: [0, 5],
    pivot: { X: px, Y: py },
    motion(t) { const [th] = path(t); return { X: px + L * Math.sin(th), Y: py - L * Math.cos(th), rot: th * 0.2, theta: th }; },
  };
}

function inclineScene() {
  const d = 0.24, r = d / 2, g = G.earth, alpha = 12 * DEG, tRel = 0.2, A = { X: 0.7, Y: 1.15 }, plankLen = 3.7;
  const a = (5 / 7) * g * Math.sin(alpha), s0 = 0.15;
  const u = { X: Math.cos(alpha), Y: -Math.sin(alpha) }, n = { X: Math.sin(alpha), Y: Math.cos(alpha) };
  return {
    id: 'incline', title: 'Ball rolling down a 12 degree ramp', fps: 30, duration: 2.4, theme: 'room', expected_model: 'incline',
    ball: { kind: 'basketball', diameter: d },
    params: { alpha_deg: 12, alpha, g, a_along_slope: a, g_if_rolling_sphere: g, rolling: 'solid sphere, a = (5/7) g sin(alpha)', release_time: tRel },
    events: [{ type: 'release', t: tRel }],
    motion_window: [tRel, 2.4],
    plank: { from: A, alpha, length: plankLen, thickness: 0.045 },
    motion(t) {
      const q = Math.max(t - tRel, 0), s = s0 + 0.5 * a * q * q;
      return { X: A.X + s * u.X + r * n.X, Y: A.Y + s * u.Y + r * n.Y, rot: s / r };
    },
  };
}

function floatScene() {
  const d = 0.24, x0 = 0.6, y0 = 0.8, vx = 0.9, vy = 0.35, spin = 0.8;
  return {
    id: 'float', title: 'Ball drifting in microgravity', fps: 30, duration: 4, theme: 'iss', expected_model: 'constant-velocity',
    ball: { kind: 'basketball', diameter: d },
    params: { g: 0, x0, y0, vx, vy },
    events: [], motion_window: [0, 4],
    motion(t) { return { X: x0 + vx * t, Y: y0 + vy * t, rot: spin * t }; },
  };
}

export const SCENES = [
  dropScene({ id: 'drop', title: 'Basketball dropped, Earth gravity', fps: 30, duration: 2.5, theme: 'room', g: G.earth }),
  throwScene(),
  bounceScene(),
  pendulumScene(),
  inclineScene(),
  floatScene(),
  dropScene({ id: 'moon-drop', title: 'Basketball dropped in a lunar habitat (g = 1.62)', fps: 30, duration: 3.2, theme: 'moon', g: G.moon }),
  dropScene({ id: 'drop-60fps', title: 'Basketball dropped, 60 fps', fps: 60, duration: 2, theme: 'room', g: G.earth }),
];
export const sceneById = (id) => SCENES.find((s) => s.id === id);
