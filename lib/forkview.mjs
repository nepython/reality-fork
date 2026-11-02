// The fork in pixels: re-simulate the run's chosen fit under changed physics and map it back onto the footage.
import {fork} from './physics/fork.mjs';
import {predictPixels} from './agent.mjs';

const WORLDS = [{name: 'the Moon', g: 1.62}, {name: 'Mars', g: 3.71}, {name: 'Jupiter', g: 24.79}, {name: 'Earth', g: 9.81},
  {name: 'orbit', g: 0}, {name: 'Ceres', g: 0.28}, {name: 'Venus', g: 8.87}, {name: 'Titan', g: 1.35}];

const r1 = v => Math.round(v * 10) / 10;

export function forkPixels(run, overrides = {}, {fps, frames, sprite = null}) {
  const fit = run.report?.fit;
  if (!fit) return {error: 'this run has no fit'};
  const [f0, f1] = fit.frames;
  const span = Array.from({length: f1 - f0 + 1}, (_, k) => f0 + k);
  const real = predictPixels(fit, span, fps).map(p => [p.frame, r1(p.x), r1(p.y)]);

  // The UI speaks in "drag: none"; the simulator in dragScale (0 = no air).
  const ov = {...overrides};
  if (ov.drag === 'none') { delete ov.drag; ov.dragScale = 0; }
  // A gravity fork changes gravity only and keeps every other force. The fitted "g" is the net downward acceleration,
  // so it shifts by the difference in gravity: a ball thrown on Earth (g_fit ≈ 9.81) gets the new world's g, while a
  // rocket (g_fit ≈ −5, thrust included) keeps its thrust and only loses Earth's pull. An object coasting on Earth at
  // constant velocity is supported against gravity, so changing gravity leaves it alone; in orbit it starts to fall.
  let world = null;
  if (ov.g != null) {
    const filmed = Number.isFinite(run.report.filmed_g) ? run.report.filmed_g : 9.81;
    world = WORLDS.find(w => Math.abs(w.g - ov.g) < 0.01)?.name || `g = ${ov.g} m/s²`;
    const where = world === 'orbit' ? 'In orbit' : `On ${world}`;
    if (Math.abs(ov.g - filmed) < 0.05 && Object.keys(ov).length === 1)
      return {real, path: real, end_frame: f1, summary: 'That is the gravity it was filmed in, so this fork is reality.'};
    // Powered ascent (net acceleration upward, a rocket): its own push is filmed_g − g_fit. Where gravity is stronger
    // than that, it never leaves its support, so it stays put rather than sinking through the pad.
    const push = filmed - fit.p.g, gNew = ov.g;
    if (Number.isFinite(fit.p.g) && fit.p.g < 0 && gNew > push) {
      const [, x, y] = real[0], hold = Array.from({length: Math.round(3 * fps)}, (_, k) => [f0 + k, x, y]);
      return {real, path: hold, end_frame: hold.at(-1)[0], summary: `${where} it would not lift off: its engines give ` +
        `${push.toFixed(1)} m/s² of push, less than the ${gNew.toFixed(1)} m/s² of gravity there.`};
    }
    if (Number.isFinite(fit.p.g)) ov.g = fit.p.g + (ov.g - filmed);
    else if (filmed > 0.5 && fit.model === 'constant-velocity') delete ov.g;
  }
  // Removing air from a law that has no drag term (the fit found none to measure) would replay the same path.
  if (ov.dragScale === 0 && fit.p.b == null && fit.p.gamma == null) {
    delete ov.dragScale;
    if (!Object.keys(ov).length) return {real, path: real, end_frame: f1, summary: 'The law that fits this motion has no air drag in it, so removing the air changes nothing.'};
  }
  if (!Object.keys(ov).length) return {real, path: real, end_frame: f1,
    summary: overrides.g != null ? 'Changing gravity leaves it as it is: on the ground something holds it up against gravity.' : ''};

  let sim;
  try {
    // Times in the simulator are seconds of our track (frame − frameOffset) / fps; it starts at the first moving sample.
    // Run the fork past the fitted stretch: to the end of the clip, or three times the fitted duration, whichever is
    // longer (a Moon fall outlasts the footage), but at most 20 s; the frame-exit check below trims it.
    const clipEnd = (frames - 1 - fit.frameOffset) / fps;
    const t1 = Math.min(fit.data.t0 + 20, Math.max(clipEnd, fit.data.t0 + 3 * fit.data.duration));
    sim = fork({fit: {...fit, applicable: true}, data: fit.data}, ov, {fps, t0: fit.data.t0, t1});
  } catch (e) { return {error: String(e.message || e)}; }
  const [x0, y0] = fit.origin_px;
  const path = sim.t.map((t, i) => [Math.round(fit.frameOffset + t * fps), r1(x0 + sim.x[i] * fit.ppm), r1(y0 - sim.y[i] * fit.ppm)]);
  // One point per frame (the simulator samples at 1/fps, but rounding can repeat a frame).
  const seen = new Set();
  let uniq = path.filter(p => !seen.has(p[0]) && seen.add(p[0]));
  // Where the forked object leaves the picture (no floor in shot, e.g. the space station), stop shortly after and
  // say so, rather than following it metres below the frame.
  // "after T s it is at y = A m instead of B m" reads badly for a climbing rocket; say how far apart they are.
  sim.summary = sim.summary.replace(/after ([\d.]+) s it is at y = (-?[\d.]+) m instead of (-?[\d.]+) m\.?/, (_, t, a, b) => {
    const d = Number(a) - Number(b);
    return `after ${t} s it is ${Math.abs(d).toFixed(1)} m ${d > 0 ? 'higher' : 'lower'} than in reality.`;
  });
  let summary = world ? sim.summary.replace(/^(On [^,]+?|With g = \S+ m\/s²)(?= )/, world === 'orbit' ? 'In orbit' : `On ${world}`) : sim.summary;
  const {width, height} = run.info, margin = 10;
  // Gone means the whole cut-out is out of the picture, not just the tracked point: a rocket followed by its nose
  // still filled the frame when its nose crossed the top edge. Without a sprite, a 30 px box around the point.
  const ax = fit.point === 'top' ? sprite?.tx : fit.point === 'bottom' ? sprite?.bx : sprite?.cx;
  const ay = fit.point === 'top' ? sprite?.ty : fit.point === 'bottom' ? sprite?.by : sprite?.cy;
  const box = sprite && Number.isFinite(ax) && Number.isFinite(ay)
    ? {l: sprite.left - ax, r: sprite.left + sprite.width - ax, t: sprite.top - ay, b: sprite.top + sprite.height - ay}
    : {l: -30, r: 30, t: -30, b: 30};
  const gone = (x, y) => x + box.r < -margin || x + box.l > width + margin || y + box.b < -margin || y + box.t > height + margin;
  const exit = uniq.findIndex(p => p[0] > f0 && gone(p[1], p[2]));
  if (exit > 0) {
    const tExit = (uniq[exit][0] - uniq[0][0]) / fps;
    // The real path for comparison is the simulator's unchanged baseline over the same span, not just the fitted
    // stretch: the fit ends where tracking ends, which for a rocket is before it leaves the frame.
    const b = sim.baseline;
    const realExit = b ? b.t.findIndex((t, i) => t > b.t[0] && gone(x0 + b.x[i] * fit.ppm, y0 - b.y[i] * fit.ppm)) : -1;
    const where = world ? (world === 'orbit' ? 'In orbit' : `On ${world}`) : 'Forked';
    const realT = realExit > 0 ? b.t[realExit] - b.t[0] : null;
    summary = `${where}, it would leave the frame ${tExit.toFixed(2)} s after release` +
      (realExit < 0 ? ', while in reality it stays in shot.' : realT != null ? `, against ${realT.toFixed(2)} s in reality.` : '.');
    uniq = uniq.slice(0, exit + 1);
  }
  // Reality by the fitted law over the fork's span (the measured points stop where tracking does), for the stage's
  // reality marker when the real object cannot be erased.
  const b = sim.baseline, end = uniq.at(-1)[0], seenB = new Set();
  const baseline = b ? b.t.map((t, i) => [Math.round(fit.frameOffset + t * fps), r1(x0 + b.x[i] * fit.ppm), r1(y0 - b.y[i] * fit.ppm)])
    .filter(p => p[0] <= end && !seenB.has(p[0]) && seenB.add(p[0])) : null;
  return {real, path: uniq, baseline, end_frame: end, clip_frames: frames, summary, events: sim.events, warnings: sim.warnings};
}
