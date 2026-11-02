// The fork in pixels: re-simulate the run's chosen fit under changed physics and map it back onto the footage.
import {fork} from './physics/fork.mjs';
import {predictPixels} from './agent.mjs';

const WORLDS = [{name: 'the Moon', g: 1.62}, {name: 'Mars', g: 3.71}, {name: 'Jupiter', g: 24.79}, {name: 'Earth', g: 9.81},
  {name: 'orbit', g: 0}, {name: 'Ceres', g: 0.28}, {name: 'Venus', g: 8.87}, {name: 'Titan', g: 1.35}];

const r1 = v => Math.round(v * 10) / 10;

export function forkPixels(run, overrides = {}, {fps, frames}) {
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
    if (Number.isFinite(fit.p.g)) ov.g = fit.p.g + (ov.g - filmed);
    else if (filmed > 0.5 && fit.model === 'constant-velocity') delete ov.g;
  }
  if (!Object.keys(ov).length) return {real, path: real, end_frame: f1, summary: ''};

  let sim;
  try {
    // Times in the simulator are seconds of our track (frame − frameOffset) / fps; it starts at the first moving sample.
    sim = fork({fit: {...fit, applicable: true}, data: fit.data}, ov, {fps, t0: fit.data.t0});
  } catch (e) { return {error: String(e.message || e)}; }
  const [x0, y0] = fit.origin_px;
  const path = sim.t.map((t, i) => [Math.round(fit.frameOffset + t * fps), r1(x0 + sim.x[i] * fit.ppm), r1(y0 - sim.y[i] * fit.ppm)]);
  // One point per frame (the simulator samples at 1/fps, but rounding can repeat a frame).
  const seen = new Set();
  let uniq = path.filter(p => !seen.has(p[0]) && seen.add(p[0]));
  // Where the forked object leaves the picture (no floor in shot, e.g. the space station), stop shortly after and
  // say so, rather than following it metres below the frame.
  let summary = world ? sim.summary.replace(/^(On [^,]+?|With g = \S+ m\/s²)(?= )/, world === 'orbit' ? 'In orbit' : `On ${world}`) : sim.summary;
  const {width, height} = run.info, margin = 40;
  const exit = uniq.findIndex(p => p[0] > f0 && (p[1] < -margin || p[1] > width + margin || p[2] < -margin || p[2] > height + margin));
  if (exit > 0) {
    const tExit = (uniq[exit][0] - uniq[0][0]) / fps;
    const realExit = real.findIndex(p => p[1] < -margin || p[1] > width + margin || p[2] < -margin || p[2] > height + margin);
    const where = world ? (world === 'orbit' ? 'In orbit' : `On ${world}`) : 'Forked';
    summary = `${where}, it would leave the frame ${tExit.toFixed(2)} s after release` + (realExit < 0 ? ', while in reality it stays in shot.' : '.');
    uniq = uniq.slice(0, exit + 1);
  }
  return {real, path: uniq, end_frame: uniq.at(-1)[0], clip_frames: frames, summary, events: sim.events, warnings: sim.warnings};
}
