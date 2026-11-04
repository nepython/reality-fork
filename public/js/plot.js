// Height (or sideways position, for a pendulum) against time: SAM's measurements, the fitted law, and the fork.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

// With `speed` ({real, fork}: [frame, km/h] pairs) it plots a car's speed against time instead.
export function drawPlot(svg, {track, fitPath, forkPath, fps, ppm, origin, axis = 'y', now = null, start = 0, speed = null}) {
  if (speed) { fitPath = speed.real; forkPath = speed.fork; track = null; }
  svg.innerHTML = '';
  const W = svg.clientWidth || 600, H = svg.clientHeight || 220, L = 46, R = 12, T = 22, B = 26;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  // Pixels → metres in the lab frame (y up), relative to the first tracked point.
  const val = p => speed ? p[1] : axis === 'y' ? (origin[1] - p[2]) / ppm : (p[1] - origin[0]) / ppm;
  const tOf = f => (f - start) / fps;
  const series = [track, fitPath, forkPath].filter(Boolean);
  const all = series.flat();
  if (!all.length) return;
  let t0 = Math.min(...all.map(p => tOf(p[0]))), t1 = Math.max(...all.map(p => tOf(p[0])));
  let v0 = Math.min(...all.map(val)), v1 = Math.max(...all.map(val));
  const pad = (v1 - v0) * 0.08 || 0.1; v0 -= pad; v1 += pad;
  if (t1 - t0 < 1e-6) t1 = t0 + 1;
  const X = t => L + (t - t0) / (t1 - t0) * (W - L - R), Y = v => T + (1 - (v - v0) / (v1 - v0)) * (H - T - B);
  // axes and ticks
  svg.append(el('line', {class: 'axis', x1: L, y1: H - B, x2: W - R, y2: H - B}), el('line', {class: 'axis', x1: L, y1: T, x2: L, y2: H - B}));
  for (const t of ticks(t0, t1, 6)) { const tx = el('text', {class: 'tick', x: X(t), y: H - 8, 'text-anchor': 'middle'}); tx.textContent = `${+t.toFixed(2)} s`; svg.append(tx); }
  for (const v of ticks(v0, v1, 4)) { const tx = el('text', {class: 'tick', x: L - 6, y: Y(v) + 3, 'text-anchor': 'end'}); tx.textContent = `${+v.toFixed(2)}`; svg.append(tx); }
  const unit = el('text', {class: 'tick', x: 4, y: 12}); unit.textContent = speed ? 'speed km/h' : axis === 'y' ? 'height m' : 'across m'; svg.append(unit);
  const line = (pts, cls) => { if (pts?.length > 1) svg.append(el('path', {class: cls, d: pts.map((p, i) => `${i ? 'L' : 'M'}${X(tOf(p[0])).toFixed(1)},${Y(val(p)).toFixed(1)}`).join('')})); };
  line(fitPath, 'law');
  line(forkPath, 'forkline');
  for (const p of track || []) svg.append(el('circle', {class: 'meas', cx: X(tOf(p[0])), cy: Y(val(p)), r: 2.6}));
  if (now != null && tOf(now) >= t0 && tOf(now) <= t1) svg.append(el('line', {class: 'now', x1: X(tOf(now)), x2: X(tOf(now)), y1: T, y2: H - B}));
}

function ticks(a, b, n) {
  const step = niceStep((b - a) / n), out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return out;
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}
