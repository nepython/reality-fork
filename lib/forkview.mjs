// The fork in pixels: re-simulate the run's chosen fit under changed physics and map it back onto the footage.
import {fork} from './physics/fork.mjs';
import {predictPixels} from './agent.mjs';
import {MODELS} from './physics/models.mjs';

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
    // Run the fork past the fitted stretch: to the end of the clip, or six times the fitted duration (times scale as
    // 1/√g, and a throw on the Moon stays up six times as long, landing well after the footage ends), at most 12 s;
    // the landing and the camera's reach below trim it.
    const clipEnd = (frames - 1 - fit.frameOffset) / fps;
    const t1 = Math.min(fit.data.t0 + 12, Math.max(clipEnd, fit.data.t0 + 6 * fit.data.duration));
    sim = fork({fit: {...fit, applicable: true}, data: fit.data}, ov, {fps, t0: fit.data.t0, t1, floorY: launchLevel(fit)});
  } catch (e) { return {error: String(e.message || e)}; }
  const [x0, y0] = fit.origin_px;
  const path = sim.t.map((t, i) => [Math.round(fit.frameOffset + t * fps), r1(x0 + sim.x[i] * fit.ppm), r1(y0 - sim.y[i] * fit.ppm)]);
  // One point per frame (the simulator samples at 1/fps, but rounding can repeat a frame).
  const seen = new Set();
  let uniq = path.filter(p => !seen.has(p[0]) && seen.add(p[0]));
  // A landing ends the story: keep a moment of it lying there, not seconds of a ball at rest.
  const land = sim.events?.find(e => e.type === 'land');
  if (land) uniq = uniq.filter(p => p[0] <= fit.frameOffset + (land.t + 0.8) * fps);
  // Where the forked object leaves the picture for good (no floor in shot, e.g. the space station), stop once it is
  // beyond what the stage's camera can pull back to, and say when it left, rather than following it metres away.
  // Without a floor the simulator compares end positions ("after 6.97 s it is at y = −39.67 m"), which says nothing
  // once the path is trimmed; the frame exit below says it instead.
  const where = world ? (world === 'orbit' ? 'In orbit' : `On ${world}`) : null;
  let summary = /it is at y = /.test(sim.summary) ? '' : where ? sim.summary.replace(/^With g = \S+ m\/s²(?= )/, where) : sim.summary;
  const {width, height} = run.info, margin = 10;
  // Gone means the whole cut-out is out of the picture, not just the tracked point: a rocket followed by its nose
  // still filled the frame when its nose crossed the top edge. Without a sprite, a 30 px box around the point.
  const ax = fit.point === 'top' ? sprite?.tx : fit.point === 'bottom' ? sprite?.bx : sprite?.cx;
  const ay = fit.point === 'top' ? sprite?.ty : fit.point === 'bottom' ? sprite?.by : sprite?.cy;
  const box = sprite && Number.isFinite(ax) && Number.isFinite(ay)
    ? {l: sprite.left - ax, r: sprite.left + sprite.width - ax, t: sprite.top - ay, b: sprite.top + sprite.height - ay}
    : {l: -30, r: 30, t: -30, b: 30};
  // `reach` widens the picture by that many frame sizes on every side: the stage pulls its camera back to follow a
  // fork out of shot (a Moon throw rises far above the room and lands 14 m away), up to five frames across.
  const gone = (x, y, reach = 0) => x + box.r < -margin - reach * width || x + box.l > width + margin + reach * width ||
    y + box.b < -margin - reach * height || y + box.t > height + margin + reach * height;
  const exit = uniq.findIndex(p => p[0] > f0 && gone(p[1], p[2]));
  const far = uniq.findIndex(p => p[0] > f0 && gone(p[1], p[2], 2));
  const returns = exit > 0 && uniq.slice(exit, far > 0 ? far : undefined).some(p => !gone(p[1], p[2]));
  if (returns) summary = (summary || `${where || 'Forked'}, it goes out of shot.`) + ' It sails out of the frame on the way; the camera pulls back to follow it.';
  else if (exit > 0) {
    const tExit = (uniq[exit][0] - uniq[0][0]) / fps;
    // The real path for comparison is the simulator's unchanged baseline over the same span, not just the fitted
    // stretch: the fit ends where tracking ends, which for a rocket is before it leaves the frame.
    const b = sim.baseline;
    const realExit = b ? b.t.findIndex((t, i) => t > b.t[0] && gone(x0 + b.x[i] * fit.ppm, y0 - b.y[i] * fit.ppm)) : -1;
    const realT = realExit > 0 ? b.t[realExit] - b.t[0] : null;
    const versus = realExit < 0 ? 'while in reality it stays in shot' : realT != null ? `against ${realT.toFixed(2)} s in reality` : '';
    summary = summary
      ? `${summary} It leaves the frame ${tExit.toFixed(2)} s after release${versus ? ', ' + versus : ''}.`
      : `${where || 'Forked'}, it would leave the frame ${tExit.toFixed(2)} s after release${versus ? ', ' + versus : ''}.`;
  }
  if (far > 0) uniq = uniq.slice(0, far + 1);
  // Reality by the fitted law over the fork's span (the measured points stop where tracking does), for the stage's
  // reality marker when the real object cannot be erased.
  const b = sim.baseline, end = uniq.at(-1)[0], seenB = new Set();
  const baseline = b ? b.t.map((t, i) => [Math.round(fit.frameOffset + t * fps), r1(x0 + b.x[i] * fit.ppm), r1(y0 - b.y[i] * fit.ppm)])
    .filter(p => p[0] <= end && !seenB.has(p[0]) && seenB.add(p[0])) : null;
  // Where it lands or bounces, in pixels: the stage carries the floor on beyond the footage when the camera pulls back.
  const contact = sim.events?.find(e => e.type === 'land' || e.type === 'bounce');
  const floor_px = contact ? r1(y0 - contact.y * fit.ppm) : null;
  return {real, path: uniq, baseline, end_frame: end, clip_frames: frames, floor_px, summary, events: sim.events, warnings: sim.warnings};
}

// The floor the simulator knows comes from footage that ends with the object lying at its lowest point. A jump, or a toss
// from a support, often has its fitted stretch end just before touchdown (feet and hands interfere there), so no floor is
// known and the forked astronaut fell straight through the ground (Apollo 16 jump salute, 4 Nov 2026). Something
// launched upward that is falling again when the fit ends, with nothing measured below where it started, lands at the
// height it left from. Returns undefined to keep the simulator's own choice.
function launchLevel(fit) {
  const model = MODELS[fit.model], d = fit.data;
  if (d?.floorY != null || !model?.state || !(fit.model === 'projectile' || fit.model === 'projectile-drag') || !(fit.p.g > 0)) return undefined;
  const p = model.params.map(q => fit.p[q.name]), start = model.state(p, 0), end = model.state(p, d.duration);
  const below = start.y - d.yMin > Math.max(3 * (d.noise_sigma_m || 0), 0.01);
  return start.vy > 0 && end.vy < 0 && !below ? start.y : undefined;
}
