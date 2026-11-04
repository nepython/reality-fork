// Forks for a vehicle crossing the frame at constant speed: "just slower", and "someone steps out ahead" (braking).
// Everything is a distance s along the line of travel, measured from where the fit starts (model time τ = 0), so the
// real car is s = v·τ and the fork replaces that with another motion along the same line.
import {predictPixels} from './agent.mjs';
import {brakingScenario, distanceAt, speedAt, brakingSentence, assumptionsText, kmh, REACT_S, DECEL} from './physics/braking.mjs';

const r1 = v => Math.round(v * 10) / 10;

/** The run's measured motion if it is a vehicle-like crossing (constant velocity, mostly sideways), else null. */
export function vehicleMotion(run) {
  const fit = run.report?.fit;
  if (!fit || fit.model !== 'constant-velocity') return null;
  const {vx, vy} = fit.p, speed = Math.hypot(vx, vy);
  if (!(speed > 0) || Math.abs(vx) < 2 * Math.abs(vy)) return null;
  const d = (fit.derived || []).find(q => q.name === 'speed');
  const sx = fit.sigma?.vx ?? 0, sy = fit.sigma?.vy ?? 0;
  const sigma = d?.sigma_total ?? d?.sigma ?? Math.hypot(vx * sx, vy * sy) / speed;
  return {vx, vy, speed, sigma, ux: vx / speed, uy: vy / speed, x0: fit.p.x0, y0: fit.p.y0};
}

export function vehicleFork(run, ov, {fps, frames, sprite = null}) {
  const fit = run.report.fit, m = vehicleMotion(run);
  if (!m) return {error: 'Braking and speed forks need a vehicle moving mostly sideways at a steady speed; this clip\'s motion is not that.'};
  const [f0] = fit.frames, {width, height} = run.info, [ox, oy] = fit.origin_px, ppm = fit.ppm;
  const speedOv = ov.speed_kmh != null, v = speedOv ? Number(ov.speed_kmh) / 3.6 : m.speed;
  if (!(v > 0) || v > 100) return {error: 'speed_kmh must be a positive number of km/h'};
  const b = ov.brake ? {distance_m: 20, react_s: REACT_S, decel: DECEL, ...ov.brake} : null;
  if (b && !(b.distance_m > 0 && b.decel > 0 && b.react_s >= 0)) return {error: 'brake needs distance_m > 0, decel > 0, react_s ≥ 0'};

  const px = s => [ox + (m.x0 + m.ux * s) * ppm, oy - (m.y0 + m.uy * s) * ppm];
  const tau = f => (f - fit.frameOffset) / fps - fit.data.t0;
  // Where the hazard is: the road's x in pixels (default 75% of the way across in the direction of travel).
  const hx_px = b ? (Number.isFinite(b.hazard_px) ? b.hazard_px : width * (m.ux > 0 ? 0.75 : 0.25)) : null;
  const s_h = b ? ((hx_px - ox) / ppm - m.x0) / m.ux : null;          // distance along the line to the hazard
  const s_trigger = b ? s_h - b.distance_m : null;                    // the car is here when someone steps out
  const tb = b ? s_trigger / v : null;                                // ...at this τ (may be before the footage: extrapolated back)
  const sc = b ? brakingScenario({v, sigma_v: speedOv ? 0 : m.sigma, hazard_m: b.distance_m, react_s: b.react_s, decel: b.decel}) : null;
  const opts = b && {v, react_s: b.react_s, decel: b.decel};
  const along = t => !b || t < tb ? v * t : s_trigger + distanceAt(opts, t - tb);
  const speedNow = t => !b || t < tb ? v : speedAt(opts, t - tb);

  // How long to follow it: until the story ends (a moment after the stop, or after it passes the hazard), at most 12 s.
  const tEvent = b ? tb + (sc.stops ? sc.t_total : sc.t_hazard) : null;
  const frameOf = t => Math.round(fit.frameOffset + (t + fit.data.t0) * fps);
  const last = f0 + Math.round(12 * fps), until = b ? Math.min(last, Math.max(f0 + 1, frameOf(tEvent + (sc.stops ? 2 : 0.8)))) : last;
  // Someone steps out when the car is distance_m from the crossing, which on a short stretch of road is before the car
  // is in shot (20 m is two frame-widths on a street clip). The fork starts half a second before that, extrapolating the
  // car back along its constant velocity; the stage pre-rolls (frames before 0) and pulls its camera back to show it.
  const first = b ? Math.min(f0, Math.max(frameOf(tb) - Math.round(0.5 * fps), f0 - Math.round(8 * fps))) : f0;
  const span = Array.from({length: until - first + 1}, (_, k) => first + k);

  const ax = fit.point === 'top' ? sprite?.tx : fit.point === 'bottom' ? sprite?.bx : sprite?.cx;
  const ay = fit.point === 'top' ? sprite?.ty : fit.point === 'bottom' ? sprite?.by : sprite?.cy;
  const box = sprite && Number.isFinite(ax) && Number.isFinite(ay)
    ? {l: sprite.left - ax, r: sprite.left + sprite.width - ax, t: sprite.top - ay, b: sprite.top + sprite.height - ay} : {l: -30, r: 30, t: -30, b: 30};
  const gone = (x, y) => x + box.r < -10 || x + box.l > width + 10 || y + box.b < -10 || y + box.t > height + 10;

  let path = span.map(f => { const [x, y] = px(along(tau(f))); return [f, r1(x), r1(y)]; });
  const real = predictPixels(fit, span, fps).map(p => [p.frame, r1(p.x), r1(p.y)]);
  const exitAt = pts => pts.findIndex(p => p[0] > f0 && gone(p[1], p[2]));
  // A braking story is followed to its end even out of shot (the stage pulls back); only a plain crossing stops at the frame's edge.
  const ex = b ? -1 : exitAt(path), exReal = exitAt(real);
  if (ex > 0) path = path.slice(0, ex + 1);
  const end = path.at(-1)[0];
  const baseline = real.filter(p => p[0] <= end);
  const speed = {fork: path.map(p => [p[0], r1(kmh(speedNow(tau(p[0]))))]), real: baseline.map(p => [p[0], r1(kmh(m.speed))])};
  const events = [], warnings = [];
  const at = (t, type, extra = {}) => { const [x, y] = px(along(t)); events.push({type, t: Math.round((t + fit.data.t0) * 1000) / 1000, x: (x - ox) / ppm, y: (oy - y) / ppm, ...extra}); return [x, y]; };
  const out = {real, path, baseline, end_frame: end, clip_frames: frames, floor_px: null, speed, events, warnings};

  if (!b) {
    const sec = ex > 0 ? (path.at(-1)[0] - f0) / fps : null, secReal = exReal > 0 ? (real[exReal][0] - f0) / fps : null;
    const vs = `${Math.round(kmh(v))} km/h instead of the measured ${Math.round(kmh(m.speed))}${m.sigma * 3.6 >= 0.5 ? ' ± ' + Math.max(1, Math.round(kmh(m.sigma))) : ''} km/h`;
    out.summary = sec != null && secReal != null
      ? `Crossing at ${vs}, the same car takes ${sec.toFixed(1)} s to leave the frame from where it is first tracked, against ${secReal.toFixed(1)} s as filmed.`
      : `Crossing at ${vs}, the same car is still in shot after ${((end - f0) / fps).toFixed(0)} s.`;
    return out;
  }

  const [hx, hy] = px(s_h);
  const impact = !sc.stops, tHit = impact ? tb + sc.t_hazard : tb + sc.t_total;
  at(tb, 'step-out'); at(tb + b.react_s, 'brake');
  const [ex_, ey_] = at(tHit, impact ? 'impact' : 'stop', {speed: impact ? sc.impact_ms : 0});
  const wide = !speedOv && sc.sigma_v > 0 ? sc.range : null;
  const text = impact ? `${Math.round(sc.impact_kmh)} km/h at the crossing` : `stops ${r1(sc.short_m)} m short`;
  out.summary = brakingSentence(sc, {measured: !speedOv});
  out.hazard = {
    x_px: r1(hx), y_px: r1(hy), distance_m: b.distance_m, speed_kmh: r1(kmh(v)), assumptions: assumptionsText(b.react_s, b.decel),
    react_s: b.react_s, decel: b.decel,
    // The stopping-distance diagram's numbers (stage's bird's-eye strip): where the car travels while the driver reacts,
    // while it brakes, and the gap to the person that the sum is compared with.
    distances: {reaction_m: r1(sc.reaction_m), braking_m: r1(sc.braking_m), stopping_m: r1(sc.stopping_m), gap_m: b.distance_m, speed_ms: Math.round(v * 100) / 100},
    outcome: {kind: impact ? 'hits' : 'stops', short_m: impact ? null : r1(sc.short_m), impact_kmh: impact ? Math.round(sc.impact_kmh) : 0,
      impact_range_kmh: wide ? wide.impact_kmh.map(Math.round) : null, stops_certain: wide ? wide.stops_certain : true, text},
    // When and where the story peaks, for the stage's callout; the step-out and brake frames mark the phases.
    event: {kind: impact ? 'impact' : 'stop', frame: Math.round(fit.frameOffset + (tHit + fit.data.t0) * fps), x_px: r1(ex_), y_px: r1(ey_)},
    step_out_frame: Math.round(fit.frameOffset + (tb + fit.data.t0) * fps),
  };
  return out;
}
