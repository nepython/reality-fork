// The fork in pixels: re-simulate the run's chosen fit under changed physics and map it back onto the footage.
import {fork} from './physics/fork.mjs';
import {predictPixels} from './agent.mjs';

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
  let summary = sim.summary;
  const {width, height} = run.info, margin = 40;
  const exit = uniq.findIndex(p => p[0] > f0 && (p[1] < -margin || p[1] > width + margin || p[2] < -margin || p[2] > height + margin));
  if (exit > 0) {
    const tExit = (uniq[exit][0] - uniq[0][0]) / fps;
    const realExit = real.findIndex(p => p[1] < -margin || p[1] > width + margin || p[2] < -margin || p[2] > height + margin);
    const where = ov.g != null ? (sim.summary.match(/^(On|With) [^,]+?(?= it| after|,)/)?.[0] || 'Forked') : 'Forked';
    summary = `${where}, it would leave the frame ${tExit.toFixed(2)} s after release` + (realExit < 0 ? ', while in reality it stays in shot.' : '.');
    uniq = uniq.slice(0, exit + 1);
  }
  return {real, path: uniq, end_frame: uniq.at(-1)[0], clip_frames: frames, summary, events: sim.events, warnings: sim.warnings};
}
