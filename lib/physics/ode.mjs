// Fixed-step RK4 integration helpers and the shared ballistic simulator
// (gravity + optional quadratic drag + floor contact with restitution).

/** One RK4 step of y' = f(t, y) for an array state. */
export function rk4Step(f, t, y, h) {
  const add = (a, b, s) => a.map((v, i) => v + s * b[i]);
  const k1 = f(t, y);
  const k2 = f(t + h / 2, add(y, k1, h / 2));
  const k3 = f(t + h / 2, add(y, k2, h / 2));
  const k4 = f(t + h, add(y, k3, h));
  return y.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

/**
 * Integrate y' = f(t, y) from t=0 (state y0) and report the state at each requested time.
 * Times may be in any order and negative (integrated backwards); internally two ascending
 * passes (forward, backward) share one fixed step <= hMax that lands exactly on each sample.
 */
export function integrateAt(f, y0, times, hMax = 0.004) {
  const out = new Array(times.length);
  const pass = (idx) => {
    let t = 0, y = y0.slice();
    for (const i of idx) {
      const span = times[i] - t;
      if (span !== 0) {
        const n = Math.max(1, Math.ceil(Math.abs(span) / hMax));
        const h = span / n;
        for (let s = 0; s < n; s++) y = rk4Step(f, t + s * h, y, h);
        t = times[i];
      }
      out[i] = y.slice();
    }
  };
  const order = times.map((_, i) => i);
  pass(order.filter((i) => times[i] >= 0).sort((a, b) => times[a] - times[b]));
  pass(order.filter((i) => times[i] < 0).sort((a, b) => times[b] - times[a]));
  return out;
}

/** Acceleration of a point mass with gravity g (along -y) and quadratic drag b = c/m (1/m). */
export const ballisticAccel = (g, b) => (_t, [, , vx, vy]) => {
  const s = Math.hypot(vx, vy);
  return [vx, vy, -b * s * vx, -g - b * s * vy];
};

/**
 * Simulate a ballistic body from state s0 = {x, y, vx, vy} at time t0, sampled every dt until t1.
 *
 * Contact: when y falls below `floorY` the vertical velocity is reflected and scaled by `e`.
 * With e = 0, or once the rebound speed drops below `restSpeed`, the body comes to rest where it
 * landed (horizontal motion stops too: this simulator has no ground friction model).
 * Contact times are located by bisection inside the step, so events are accurate to ~1e-9 s.
 * Returns {t[], x[], y[], events[]}; events are {type:'bounce'|'land', t, x, y, speed}.
 */
export function simulateBallistic({ x, y, vx, vy, g, b = 0, e = 0, floorY = null, t0, t1, dt, restSpeed = 0.12, hMax = 0.004 }) {
  const f = ballisticAccel(g, b);
  const out = { t: [], x: [], y: [], events: [] };
  let st = [x, y, vx, vy];
  let at = t0;
  let rest = false;
  const useFloor = floorY !== null && floorY !== undefined && Number.isFinite(floorY) && y > floorY;
  let bounces = 0;

  const emit = () => { out.t.push(at); out.x.push(st[0]); out.y.push(st[1]); };
  // advance state by `dur`, handling any number of contacts inside it
  const advance = (dur) => {
    let left = dur, guard = 0;
    while (left > 1e-12 && !rest && guard++ < 200) {
      const n = Math.max(1, Math.ceil(left / hMax));
      const h = left / n;
      let consumed = 0, hit = false;
      for (let i = 0; i < n; i++) {
        const next = rk4Step(f, at, st, h);
        if (useFloor && st[1] >= floorY && next[1] < floorY && next[3] < 0) {
          // bisection on the sub-step length for the contact instant
          let lo = 0, hi = h;
          for (let it = 0; it < 50; it++) {
            const mid = 0.5 * (lo + hi);
            if (rk4Step(f, at, st, mid)[1] < floorY) hi = mid; else lo = mid;
          }
          const c = rk4Step(f, at, st, hi);
          at += hi; consumed += hi;
          const speed = Math.abs(c[3]);
          st = [c[0], floorY, c[2], -e * c[3]];
          if (e * speed < restSpeed || e <= 0) {
            rest = true; st = [c[0], floorY, 0, 0];
            out.events.push({ type: 'land', t: at, x: c[0], y: floorY, speed });
          } else {
            bounces++;
            out.events.push({ type: 'bounce', t: at, x: c[0], y: floorY, speed, n: bounces });
          }
          hit = true;
          break;
        }
        st = next; at += h; consumed += h;
      }
      left -= consumed;
      if (!hit) break;
    }
    if (rest) at += Math.max(left, 0);
  };

  emit();
  const nOut = Math.max(0, Math.round((t1 - t0) / dt));
  for (let k = 1; k <= nOut; k++) {
    const target = t0 + k * dt;
    advance(target - at);
    at = target; // while resting, `at` simply follows the grid
    emit();
  }
  return out;
}
