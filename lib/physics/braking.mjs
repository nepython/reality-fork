// Stopping a car: reaction distance, braking distance, and what happens at a hazard. Pure functions, SI units (m, s, m/s).
// The two defaults are assumptions, not measurements, so they are parameters and every summary states them.
export const REACT_S = 1.5;  // perception-reaction time, a commonly used average for an alert driver
export const DECEL = 7;      // m/s², hard braking on dry asphalt
export const KMH = 3.6;

const r1 = v => Math.round(v * 10) / 10;
export const kmh = v => v * KMH;
export const assumptionsText = (react_s = REACT_S, decel = DECEL) => `assuming ${react_s} s to react and hard braking at ${decel} m/s²`;

// One scenario at one speed (no error bar). The car holds v for react_s, then brakes at `decel`.
function at(v, hazard_m, react_s, decel) {
  const reaction_m = v * react_s, braking_m = v * v / (2 * decel), stopping_m = reaction_m + braking_m;
  const stops = stopping_m <= hazard_m;
  // Inside the reaction distance the brakes are not even on when it arrives: it hits at full speed.
  const impact_ms = stops ? 0 : hazard_m <= reaction_m ? v : Math.sqrt(Math.max(0, v * v - 2 * decel * (hazard_m - reaction_m)));
  const t_react = react_s, t_brake = v / decel;
  // When it reaches the hazard (only if it does): constant speed, or reaction then braking down to the impact speed.
  const t_hazard = stops ? null : hazard_m <= reaction_m ? hazard_m / v : react_s + (v - impact_ms) / decel;
  return {v, reaction_m, braking_m, stopping_m, stops, short_m: stops ? hazard_m - stopping_m : null, impact_ms, t_react, t_brake, t_total: t_react + t_brake, t_hazard};
}

/** v in m/s; sigma_v its 1-sigma error. The range is the scenario at v − σ and v + σ (everything here is monotonic in v). */
export function brakingScenario({v, sigma_v = 0, hazard_m, react_s = REACT_S, decel = DECEL}) {
  if (!(v >= 0) || !(hazard_m > 0) || !(decel > 0) || !(react_s >= 0)) throw new Error('braking needs v ≥ 0, hazard_m > 0, decel > 0, react_s ≥ 0');
  const mid = at(v, hazard_m, react_s, decel), lo = at(Math.max(0, v - sigma_v), hazard_m, react_s, decel), hi = at(v + sigma_v, hazard_m, react_s, decel);
  return {
    ...mid, v_kmh: kmh(v), sigma_v, sigma_v_kmh: kmh(sigma_v), hazard_m, react_s, decel,
    impact_kmh: kmh(mid.impact_ms),
    range: {
      impact_kmh: [kmh(lo.impact_ms), kmh(hi.impact_ms)], stopping_m: [lo.stopping_m, hi.stopping_m],
      // Metres to spare at the hazard (negative: it overshoots); the faster end is the smaller margin.
      margin_m: [hazard_m - hi.stopping_m, hazard_m - lo.stopping_m],
      // Is the outcome the same across the error bar?
      stops_certain: lo.stops === hi.stops,
    },
    assumptions: assumptionsText(react_s, decel),
  };
}

/** Distance (m) travelled `t` seconds after the hazard appears: constant speed while reacting, then constant deceleration to rest.
 *  A car that reaches the hazard does not stop there in reality, so this simply keeps decelerating through it. */
export function distanceAt({v, react_s = REACT_S, decel = DECEL}, t) {
  if (t <= 0) return v * t;                      // before the hazard appears: constant velocity (extrapolated back)
  if (t <= react_s) return v * t;
  const tb = Math.min(t - react_s, v / decel);
  return v * react_s + v * tb - decel * tb * tb / 2;
}
export function speedAt({v, react_s = REACT_S, decel = DECEL}, t) {
  return t <= react_s ? v : Math.max(0, v - decel * (t - react_s));
}
/** Positions (m along the direction of travel) at each time in `times`, t = 0 when the hazard appears. */
export const motionAlong = (opts, times) => times.map(t => distanceAt(opts, t));

// ---- the speed survey -------------------------------------------------------------------------------------------
export function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = p * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

// A small seeded generator, so a survey gives the same numbers every time it is asked.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** speeds: [{kmh, sigma}]. The 85th percentile of the speeds themselves, and its uncertainty by Monte Carlo over each
 *  clip's own error bar: median and a 68% interval of the 85th percentile across draws. */
export function survey85(speeds, {draws = 4000, seed = 85} = {}) {
  const rand = rng(seed), gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const p85 = percentile(speeds.map(s => s.kmh), 0.85), sims = [];
  for (let d = 0; d < draws; d++) sims.push(percentile(speeds.map(s => Math.max(0, s.kmh + (s.sigma || 0) * gauss())), 0.85));
  return {p85, median: percentile(sims, 0.5), low: percentile(sims, 0.16), high: percentile(sims, 0.84)};
}

// ---- words ------------------------------------------------------------------------------------------------------
const pm = (mid, [lo, hi]) => hi - lo < 0.5 ? `${Math.round(mid)}` : `${Math.round(mid)} ± ${Math.max(1, Math.round((hi - lo) / 2))}`;
const speedText = (sc, measured) => measured && sc.sigma_v_kmh >= 0.5 ? `${Math.round(sc.v_kmh)} ± ${Math.max(1, Math.round(sc.sigma_v_kmh))}` : `${Math.round(sc.v_kmh)}`;

/** The story as one sentence: "If someone steps out 20 m ahead: at 30 km/h it stops 2.5 m short (assuming …)."
 *  `measured` says the speed is the one filmed (so it is called that, with its error bar). */
export function brakingSentence(sc, {measured = false} = {}) {
  const head = `If someone steps out ${r1(sc.hazard_m)} m ahead: at ${measured ? 'the measured ' : ''}${speedText(sc, measured)} km/h`;
  const tail = ` (${sc.assumptions}).`;
  const wide = measured && sc.sigma_v > 0 ? sc.range : null;
  if (sc.stops) {
    const out = `${head} it stops ${r1(sc.short_m)} m short`;
    return wide && !wide.stops_certain ? `${out}, though within the error bar it could still reach them at up to ${Math.round(wide.impact_kmh[1])} km/h${tail}` : out + tail;
  }
  if (sc.impact_ms >= sc.v - 1e-9) return `${head} it has not started braking when it reaches them, so it hits at full speed${tail}`;
  const hit = wide ? `${pm(sc.impact_kmh, wide.impact_kmh)}` : `${Math.round(sc.impact_kmh)}`;
  const out = measured ? `${head} it is still doing ${hit} km/h when it reaches them` : `${head} it hits them at ${hit} km/h`;
  return wide && !wide.stops_certain ? `${out}, or stops short if it is at the slow end of the error bar${tail}` : out + tail;
}
