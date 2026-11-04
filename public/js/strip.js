// The bird's-eye stopping-distance strip of a braking fork: the road seen from above, to scale along its length, with
// metre ticks, the car as a top-view icon moving with the fork, the crossing, a thinking-distance bar (amber) and a
// braking-distance bar (blue) growing in step with the car, and the outcome. It tells the part of the story the footage
// cannot show: someone steps out 20 m ahead while the frame holds about 10 m of road. Every number comes from the fork
// response (hazard, hazard.outcome, hazard.distances); the strip invents none. Across the road it is not to scale.
import {pedestrian} from './pedestrian.js';

const CAR_M = 4.6;                                   // a top-view icon's length; the sprite's perspective gives no better length
const AMBER = '#ffb020', BLUE = '#4aa3ff', GREEN = '#30d158', RED = '#ff453a', INK = 'rgba(8, 10, 18, 0.86)';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/** Everything that does not change while a fork plays: the metre scale, the direction, the car's distance at every frame. */
export function stripLayout({W, H, path, hz, atTop, color, fps}) {
  const car0 = path.find(p => p[0] >= hz.step_out_frame) || path[0], cross = [hz.x_px, hz.y_px], d = hz.distances || {};
  const len = Math.hypot(cross[0] - car0[1], cross[1] - car0[2]) || 1, ux = (cross[0] - car0[1]) / len, uy = (cross[1] - car0[2]) / len;
  const gap = hz.distance_m, mpp = gap / len;
  // Metres the car's front has to go before the crossing at each frame (negative: it has passed it).
  const front = new Map(path.map(p => [p[0], gap - ((p[1] - car0[1]) * ux + (p[2] - car0[2]) * uy) * mpp]));
  const all = [...front.values()], sMax = Math.max(...all) + CAR_M + 0.8, sMin = Math.min(-2, Math.min(...all) - 0.6);
  const k = W / 1280, x = 14 * k, w = W - 28 * k, h = 168 * k, y = atTop ? 60 * k : H - h - 14 * k;
  const ppm = (w - 40 * k) / (sMax - sMin), dir = Math.sign(ux) || 1;
  const X = s => dir > 0 ? x + 20 * k + (sMax - s) * ppm : x + 20 * k + (s - sMin) * ppm;
  return {W, H, k, x, y, w, h, atTop, hz, d, front, gap, sMax, sMin, ppm, dir, X, color, f0: path[0][0], f1: path.at(-1)[0],
    react_f: hz.step_out_frame + hz.react_s * fps};
}

export function drawStrip(ctx, L, frame, fps) {
  const {k, x, y, w, h, hz, d, X, ppm, dir} = L;
  const impactAt = hz.outcome.kind === 'hits' ? hz.event.frame : Infinity;   // a car that hits stays where it hit
  const f = clamp(Math.min(frame, impactAt), L.f0, L.f1), s = L.front.get(f) ?? L.front.get(Math.round(f)) ?? L.gap;
  const tOut = (frame - hz.step_out_frame) / fps, tReact = hz.react_s;
  const travelled = L.gap - s, impact = hz.outcome.kind === 'hits';
  const roadY = y + 52 * k, roadH = 54 * k, laneY = roadY + roadH * 0.72, kerbY = roadY - 12 * k;
  ctx.save();
  // panel
  ctx.fillStyle = INK; ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = k;
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18 * k; ctx.beginPath(); ctx.roundRect(x, y, w, h, 12 * k); ctx.fill(); ctx.shadowBlur = 0; ctx.stroke();
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 12 * k); ctx.clip();
  // header: what this is, the assumptions, and (once it happens) the outcome
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.font = `700 ${13 * k}px ui-monospace, monospace`; ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('FROM ABOVE · TO SCALE ALONG THE ROAD', x + 16 * k, y + 19 * k);
  ctx.font = `500 ${15 * k}px system-ui, sans-serif`; ctx.fillStyle = 'rgba(255,255,255,0.78)';
  const info = `${hz.speed_kmh} km/h · ${hz.react_s} s to react · braking ${hz.decel} m/s²`;
  ctx.fillText(info, x + 16 * k, y + 38 * k);
  // road: pavement (where the person waits), asphalt, edge lines, centre dashes
  ctx.fillStyle = '#3b4254'; ctx.fillRect(x, kerbY, w, 12 * k);
  ctx.fillStyle = '#242934'; ctx.fillRect(x, roadY, w, roadH);
  ctx.fillStyle = '#8b93a6'; ctx.fillRect(x, roadY - k, w, 1.6 * k); ctx.fillRect(x, roadY + roadH - 0.6 * k, w, 1.6 * k);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1.5 * k; ctx.setLineDash([12 * k, 10 * k]);
  ctx.beginPath(); ctx.moveTo(x, roadY + roadH * 0.42); ctx.lineTo(x + w, roadY + roadH * 0.42); ctx.stroke(); ctx.setLineDash([]);
  // the crossing: zebra stripes along the road's direction, 2.4 m wide
  const cx = X(0), zw = 1.2 * ppm;
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  for (let i = 0; i < 6; i++) ctx.fillRect(cx - zw, roadY + 2.5 * k + i * (roadH - 3 * k) / 6, 2 * zw, (roadH - 3 * k) / 12);
  // metre ticks under the road, counted back from the crossing
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = `600 ${13 * k}px ui-monospace, monospace`; ctx.textAlign = 'center'; ctx.lineWidth = k;
  const tickY = roadY + roadH + 3 * k;
  ctx.beginPath(); for (let m = Math.ceil(L.sMin); m <= L.sMax; m++) { const major = m % 5 === 0, tx = X(m); ctx.moveTo(tx, tickY); ctx.lineTo(tx, tickY + (major ? 6 : 3) * k); } ctx.stroke();
  for (let m = Math.ceil(L.sMin / 5) * 5; m <= L.sMax - 1; m += 5) ctx.fillText(m === 0 ? 'crossing' : `${m} m`, X(m), tickY + 18 * k);
  // the crossing's line through the bars, and the person: waiting on the kerb, stepping out, standing in the lane
  ctx.strokeStyle = 'rgba(255,214,10,0.55)'; ctx.setLineDash([4 * k, 4 * k]); ctx.beginPath(); ctx.moveTo(cx, kerbY); ctx.lineTo(cx, y + h - 8 * k); ctx.stroke(); ctx.setLineDash([]);
  const walk = ease(tOut / 0.9), px = cx, py = kerbY + 5 * k + (laneY - kerbY - 5 * k) * walk;
  topPerson(ctx, px, py, 2.1 * k, tOut < 0 ? 0.5 : 1, walk > 0 && walk < 1 ? tOut : 0);
  // the car
  const len = CAR_M * ppm, fx = X(s), bx = fx - dir * len, braking = frame >= L.react_f && frame < hz.event.frame + 1;
  topCar(ctx, Math.min(fx, bx), laneY - 13 * k, len, 26 * k, dir, L.color, braking || (!impact && frame >= L.react_f));
  // bars: thinking (amber) from where the car was when they stepped out, then braking (blue)
  const barY = tickY + 26 * k, bh = 21 * k, s0 = L.gap, cap = impact ? Math.min(travelled, L.gap) : travelled;
  const think = clamp(cap, 0, d.reaction_m ?? 0), brake = clamp(cap - (d.reaction_m ?? 0), 0, d.braking_m ?? 0);
  const seg = (a, b, col, text, ghost) => {                    // metres a..b of travel from the step-out position
    const x0 = X(s0 - a), x1 = X(s0 - b), l = Math.min(x0, x1), wd = Math.abs(x1 - x0);
    if (wd < 1) return;
    ctx.beginPath(); ctx.roundRect(l, barY, wd, bh, 3 * k);
    if (ghost) { ctx.setLineDash([4 * k, 3 * k]); ctx.strokeStyle = col; ctx.globalAlpha = 0.35; ctx.lineWidth = k; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; return; }
    ctx.fillStyle = col; ctx.fill();
    ctx.font = `700 ${14 * k}px system-ui, sans-serif`; ctx.fillStyle = col === AMBER ? '#2a1d00' : '#04152b'; ctx.textAlign = 'center';
    if (ctx.measureText(text).width + 8 * k < wd) ctx.fillText(text, l + wd / 2, barY + bh / 2 + k);
  };
  // the full extents as faint outlines, so the growing bars read against what they will reach
  seg(0, d.reaction_m ?? 0, AMBER, '', true); seg(d.reaction_m ?? 0, Math.min(d.stopping_m ?? 0, d.reaction_m + d.braking_m), BLUE, '', true);
  if (tOut >= 0) { seg(0, think, AMBER, `thinking ${think.toFixed(1)} m`); seg(d.reaction_m ?? 0, (d.reaction_m ?? 0) + brake, BLUE, `braking ${brake.toFixed(1)} m`); }
  // outcome: the gap kept (green) or the impact (red), and its words
  if (frame >= hz.event.frame) {
    const a = ease((frame - hz.event.frame) / (0.4 * fps)), col = impact ? RED : GREEN;
    const text = impact ? `hits at ${hz.outcome.impact_kmh} km/h` : hz.outcome.text;
    ctx.globalAlpha = a;
    if (!impact) {
      const y0 = laneY - 17 * k, x0 = fx, x1 = cx - dir * 0.0;
      ctx.strokeStyle = col; ctx.lineWidth = 2.5 * k; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.moveTo(x0, y0 - 5 * k); ctx.lineTo(x0, y0 + 5 * k); ctx.moveTo(x1, y0 - 5 * k); ctx.lineTo(x1, y0 + 5 * k); ctx.stroke();
    } else {
      ctx.fillStyle = col; ctx.beginPath(); for (let i = 0; i < 16; i++) { const r = (i % 2 ? 6 : 13) * k, an = i * Math.PI / 8; ctx.lineTo(cx + Math.cos(an) * r, laneY + Math.sin(an) * r); } ctx.closePath(); ctx.fill();
    }
    ctx.font = `800 ${19 * k}px system-ui, sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width + 22 * k;
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(x + w - 14 * k - tw, y + 8 * k, tw, 33 * k, 9 * k); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(text, x + w - 25 * k, y + 25 * k);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// The person from above: shoulders and head, in the same colours as the walking silhouette on the footage.
function topPerson(ctx, x, y, k, alpha, t) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y);
  const sw = Math.sin(t / 0.55 * Math.PI) * 2.2 * k;
  ctx.strokeStyle = 'rgba(10,12,20,0.9)'; ctx.lineWidth = 1.5 * k; ctx.lineCap = 'round';
  for (const sd of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sd * 3 * k, sd * sw + 3 * k, 2 * k, 3.4 * k, 0, 0, 7); ctx.fillStyle = '#1b1d26'; ctx.fill(); ctx.stroke(); }
  ctx.beginPath(); ctx.ellipse(0, 0, 4.3 * k, 8.5 * k, Math.PI / 2, 0, 7); ctx.fillStyle = '#ffb020'; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.roundRect(-3.2 * k, -3 * k, 6.4 * k, 6 * k, 1.8 * k); ctx.fillStyle = '#2f80ed'; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 3.4 * k, 0, 7); ctx.fillStyle = '#4a3222'; ctx.fill(); ctx.stroke();
  ctx.restore();
}

// A car from above: body in the footage car's own colour, windscreen, roof, lights; the brake lights glow once braking.
function topCar(ctx, l, t, len, wd, dir, color = '#dfe5f0', braking) {
  ctx.save(); ctx.translate(l + len / 2, t + wd / 2); ctx.scale(dir, 1);   // forward is +x after the scale
  const r = wd * 0.34, hx = len / 2, hy = wd / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.roundRect(-hx + 2, -hy + 3, len, wd, r); ctx.fill();
  ctx.fillStyle = color; ctx.strokeStyle = 'rgba(10,12,20,0.9)'; ctx.lineWidth = Math.max(1, wd * 0.07);
  ctx.beginPath(); ctx.roundRect(-hx, -hy, len, wd, r); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(25,32,48,0.92)';
  ctx.beginPath(); ctx.moveTo(hx * 0.3, -hy * 0.78); ctx.lineTo(hx * 0.5, -hy * 0.6); ctx.lineTo(hx * 0.5, hy * 0.6); ctx.lineTo(hx * 0.3, hy * 0.78); ctx.closePath(); ctx.fill();   // windscreen
  ctx.beginPath(); ctx.roundRect(-hx * 0.82, -hy * 0.7, hx * 0.18, hy * 1.4, 2); ctx.fill();                                                                           // rear window
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.roundRect(-hx * 0.55, -hy * 0.62, hx * 0.8, hy * 1.24, wd * 0.12); ctx.fill();                         // roof
  ctx.fillStyle = '#fff3b0'; for (const sd of [-1, 1]) { ctx.beginPath(); ctx.ellipse(hx - 2, sd * hy * 0.6, 2, hy * 0.2, 0, 0, 7); ctx.fill(); }
  ctx.fillStyle = braking ? '#ff3b30' : '#8c1f1a'; ctx.shadowColor = '#ff3b30'; ctx.shadowBlur = braking ? 12 : 0;
  for (const sd of [-1, 1]) { ctx.beginPath(); ctx.roundRect(-hx - 1, sd * hy * 0.58 - hy * 0.2, 3.5, hy * 0.4, 1); ctx.fill(); }
  ctx.restore();
}
