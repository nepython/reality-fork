// "Fork reality": re-simulate a fitted model under changed physics, starting from the
// state the real object had at t0 (so the forked object leaves the real one's hand and
// then diverges).  Output times are absolute clip seconds, sampled once per video frame.

import { MODELS } from './models.mjs';

/** Surface gravity in m/s^2 (rounded standard values). */
export const GRAVITY = {
  earth: 9.81, moon: 1.62, mars: 3.71, jupiter: 24.79, ceres: 0.28, venus: 8.87, mercury: 3.70,
  saturn: 10.44, uranus: 8.69, neptune: 11.15, pluto: 0.62, titan: 1.35, europa: 1.31, sun: 274,
  iss: 0, // microgravity: the station is in free fall
};
const NICE = { earth: 'Earth', moon: 'the Moon', mars: 'Mars', jupiter: 'Jupiter', ceres: 'Ceres', venus: 'Venus', mercury: 'Mercury', saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune', pluto: 'Pluto', titan: 'Titan', europa: 'Europa', sun: 'the Sun', iss: 'the space station' };

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

/** Normalise user overrides: preset names, drag:0 -> dragScale 0, validation. */
export function resolveOverrides(raw = {}) {
  const ov = {}, warnings = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (k === 'g') {
      const g = typeof v === 'string' ? GRAVITY[v.toLowerCase()] : Number(v);
      if (!Number.isFinite(g)) { warnings.push(`unknown gravity "${v}"; presets: ${Object.keys(GRAVITY).join(', ')}`); continue; }
      ov.g = g;
      ov.gName = typeof v === 'string' ? v.toLowerCase() : Object.keys(GRAVITY).find((n) => Math.abs(GRAVITY[n] - g) < 0.005);
    } else if (k === 'drag') ov.dragScale = Number(v);               // drag: 0 means "no air"
    else if (['dragScale', 'e', 'massScale', 'timeScale', 'b'].includes(k)) ov[k] = Number(v);
    else warnings.push(`ignored unknown override "${k}"`);
  }
  if (ov.timeScale !== undefined && !(ov.timeScale > 0)) { warnings.push('timeScale must be > 0; ignored'); delete ov.timeScale; }
  if (ov.massScale !== undefined && !(ov.massScale > 0)) { warnings.push('massScale must be > 0; ignored'); delete ov.massScale; }
  if (ov.e !== undefined && !(ov.e >= 0 && ov.e <= 1)) { warnings.push('e should be in [0, 1]; clamped'); ov.e = Math.min(Math.max(ov.e, 0), 1); }
  return { ov, warnings };
}

/** Accept a fit entry, fitModel's {data, fit}, or fitAll's {data, fits} (best model). */
function unpack(result) {
  if (result.fits) return { fit: result.fits.find((f) => f.applicable), data: result.data };
  if (result.fit) return { fit: result.fit, data: result.data };
  return { fit: result, data: result.data ?? {} };
}

const firstContact = (events) => events.find((e) => e.type === 'land' || e.type === 'bounce');
const gLabel = (ov) => (ov.gName ? `On ${NICE[ov.gName] ?? ov.gName}` : `With g = ${fmt(ov.g)} m/s²`);

/**
 * fork(fit, overrides, {t0, t1, fps, floorY, baseline})
 *   overrides: {g: number|'moon'|..., drag: 0, dragScale, b (absolute drag 1/m), e, massScale, timeScale}
 *   t0, t1: absolute clip seconds (default: the clip start, and long enough to see the outcome)
 *   floorY: metres, where the object lands.  Defaults to the model's own floor (bounce), else to
 *           data.floorY (the end point of footage that finishes at its lowest point), else no floor.
 *           Pass a number (e.g. the measured floor height) to force one, null for none.
 * Returns {t[], x[], y[], events[], summary, baseline:{t,x,y,events}, overrides, warnings[], notes[]}.
 */
export function fork(fitResult, overrides = {}, { t0, t1, fps = 30, floorY, baseline = true, maxDuration = 30 } = {}) {
  const { fit, data } = unpack(fitResult);
  if (!fit || !fit.applicable) throw new Error('fork needs an applicable fit');
  const model = MODELS[fit.model];
  if (!model) throw new Error(`unknown model ${fit.model}`);
  const p = model.params.map((q) => fit.p[q.name]);
  const clipT0 = data?.t0 ?? 0;
  const clipDur = data?.duration ?? 0;
  const { ov, warnings } = resolveOverrides(overrides);
  const ts = ov.timeScale ?? 1;

  const start = Math.max(t0 ?? clipT0, clipT0);                      // before the first sample we have no state
  const tr0 = start - clipT0;                                         // model time (first sample = 0)
  const floor = floorY !== undefined ? floorY : data?.floorY ?? null;
  const dt = 1 / fps;

  const run = (o, durationAbs) => {
    // timeScale > 1 plays the world faster: simulate timeScale x longer physical time, then compress.
    const phys = durationAbs * (o.timeScale ?? 1);
    const sim = model.simulate(p, o, { t0: tr0, t1: tr0 + phys, dt: dt * (o.timeScale ?? 1), floorY: floor });
    const s = o.timeScale ?? 1;
    const remap = (tm) => clipT0 + tr0 + (tm - tr0) / s;
    return { ...sim, t: sim.t.map(remap), events: (sim.events ?? []).map((e) => ({ ...e, t: remap(e.t) })) };
  };

  // Pick the horizon: the clip length, extended to cover the forked outcome (landing + margin).
  const want = t1 !== undefined ? Math.max(t1 - start, dt) : Math.max(clipDur - tr0, 1);
  let dur = Math.min(want, maxDuration);
  let forked = run(ov, dur);
  if (t1 === undefined) {
    // auto-extend while the forked object has not come to rest / landed but a floor exists
    for (let i = 0; i < 3 && dur < maxDuration && !forked.events.some((e) => e.type === 'land') && floor !== null && model.id !== 'pendulum' && model.id !== 'oscillator' && model.id !== 'incline'; i++) {
      dur = Math.min(dur * 2, maxDuration);
      forked = run(ov, dur);
    }
    const land = forked.events.find((e) => e.type === 'land');
    if (land) {
      const tEnd = Math.max(land.t + 0.6, start + (clipDur - tr0));
      dur = Math.min(Math.max(tEnd - start, dt), maxDuration);
      forked = run(ov, dur);
    }
  }
  const base = baseline ? run({}, dur) : null;

  const out = {
    model: model.id,
    t: forked.t, x: forked.x, y: forked.y, events: forked.events,
    overrides: ov, warnings, notes: forked.notes ?? [],
    summary: '',
  };
  out.summary = summarise(model, p, ov, forked, base, start);
  if (base) out.baseline = { t: base.t, x: base.x, y: base.y, events: base.events };
  return out;
}

function summarise(model, p, ov, forked, base, start) {
  const parts = [];
  const f1 = firstContact(forked.events), b1 = base && firstContact(base.events);
  const fLand = forked.events.find((e) => e.type === 'land'), bLand = base?.events.find((e) => e.type === 'land');
  const fBounces = forked.events.filter((e) => e.type === 'bounce').length;
  const bBounces = base ? base.events.filter((e) => e.type === 'bounce').length : 0;
  const rel = (e) => e.t - start;

  if (model.id === 'pendulum') {
    const gT = ov.g !== undefined ? `${gLabel(ov)} the period` : 'The period';
    if (ov.g !== undefined || ov.dragScale !== undefined) {
      const Tb = 2 * Math.PI * Math.sqrt(p[2] / p[5]);
      parts.push(ov.g !== undefined ? `${gT} is ${fmt(forked.period)} s instead of ${fmt(Tb)} s` : 'The swing keeps its period');
      if (ov.dragScale === 0) parts.push('with no damping it never stops swinging');
      else if (ov.dragScale !== undefined) parts.push(`damping is ${fmt(ov.dragScale, 2)}× the original`);
    }
  } else if (model.id === 'oscillator') {
    if (ov.dragScale === 0) parts.push('Without damping it oscillates forever at the same amplitude');
    else if (ov.dragScale !== undefined) parts.push(`With ${fmt(ov.dragScale, 2)}× the damping the oscillation dies out ${ov.dragScale > 1 ? 'faster' : 'slower'}`);
    if (ov.massScale !== undefined && ov.massScale !== 1) parts.push(`With ${fmt(ov.massScale, 2)}× the mass the period is ${fmt(forked.period)} s`);
    if (ov.g !== undefined) parts.push('Gravity does not change the spring\'s oscillation');
  } else if (model.id === 'incline') {
    if (ov.g !== undefined) parts.push(`${gLabel(ov)} it accelerates at ${fmt(forked.accel)} m/s² instead of ${fmt(p[4])} m/s²`);
  } else {
    // free-flight family
    if (ov.g !== undefined) {
      const who = gLabel(ov);
      if (f1 && b1) parts.push(model.id === 'bounce' ? `${who} it first hits the floor after ${fmt(rel(f1))} s instead of ${fmt(rel(b1))} s` : `${who} it falls for ${fmt(rel(f1))} s instead of ${fmt(rel(b1))} s`);
      else if (!f1 && b1) parts.push(`${who} it stays in the air for the whole simulation instead of landing after ${fmt(rel(b1))} s`);
      else if (f1 && !b1) parts.push(`${who} it lands after ${fmt(rel(f1))} s`);
      else {
        // no floor known: compare where the object is at the end of the simulation
        const T = forked.t[forked.t.length - 1] - start, yF = forked.y[forked.y.length - 1], yB = base?.y[base.y.length - 1];
        parts.push(`${who} after ${fmt(T)} s it is at y = ${fmt(yF)} m${base ? ` instead of ${fmt(yB)} m` : ''}`);
      }
    }
    if (ov.dragScale !== undefined || ov.b !== undefined) {
      const noDrag = ov.dragScale === 0 || ov.b === 0;
      if (model.id === 'projectile' || model.id === 'constant-velocity' || model.id === 'bounce') {
        if (ov.b !== undefined && ov.b > 0) parts.push(`With air drag b = ${fmt(ov.b, 3)}/m the path is bent`);
      }
      if (fLand && bLand) {
        const dx = fLand.x - bLand.x;
        parts.push(`${noDrag ? 'Without air drag' : 'With changed drag'} it lands ${fmt(Math.abs(dx))} m ${dx >= 0 ? 'farther' : 'shorter'} (x = ${fmt(fLand.x)} m instead of ${fmt(bLand.x)} m)`);
      }
    }
    if (ov.massScale !== undefined && ov.massScale !== 1 && model.id === 'projectile-drag') parts.push(`At ${fmt(ov.massScale, 2)}× the mass drag matters ${ov.massScale > 1 ? 'less' : 'more'}`);
    if (ov.massScale !== undefined && ov.massScale !== 1 && model.id !== 'projectile-drag') parts.push('Mass has no effect without air drag (all masses fall alike)');
    if (ov.e !== undefined) {
      parts.push(`With restitution e = ${fmt(ov.e)} it bounces ${fBounces} time${fBounces === 1 ? '' : 's'}${base ? ` (instead of ${bBounces})` : ''}${fLand ? ` and comes to rest after ${fmt(rel(fLand))} s` : ' and is still moving at the end'}`);
    }
    if (!parts.length && f1) parts.push(`It ${model.id === 'bounce' ? 'first hits the floor' : 'lands'} after ${fmt(rel(f1))} s`);
  }
  if (ov.timeScale !== undefined && ov.timeScale !== 1) parts.push(`played at ${fmt(ov.timeScale, 2)}× speed`);
  if (!parts.length) parts.push('No change: the overrides do not affect this model');
  const s = parts.join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}
