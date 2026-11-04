// A run of something crossing the frame at a steady speed (a car on a street): constant velocity, mostly sideways, over
// 2 m/s. Mirrors lib/vehiclefork.mjs; the server decides again when a fork is asked for.
export function vehicleOf(rep) {
  const fit = rep?.fit;
  if (!fit || fit.model !== 'constant-velocity') return null;
  const {vx, vy} = fit.p, speed = Math.hypot(vx, vy);
  if (!(speed > 2) || Math.abs(vx) < 2 * Math.abs(vy)) return null;
  const d = (fit.derived || []).find(q => q.name === 'speed');
  const sigma = d?.sigma_total ?? d?.sigma ?? 0;
  return {speed, sigma, kmh: speed * 3.6, sigma_kmh: sigma * 3.6, dir: Math.sign(vx), vx, vy, fit};
}
export const kmhText = v => `${Math.round(v.kmh)}${v.sigma_kmh >= 0.5 ? ' ± ' + Math.max(1, Math.round(v.sigma_kmh)) : ''} km/h`;

// Where the line of travel crosses pixel column x (the crossing's y on the footage).
export function roadY(v, x) {
  const {origin_px: [ox, oy], ppm, p} = v.fit;
  return oy - (p.y0 + (p.vy / p.vx) * ((x - ox) / ppm - p.x0)) * ppm;
}
