// The person who steps out: a filled, outlined silhouette seen from behind (they step off the near kerb, away from the
// camera) in a three-pose walk: left foot forward, passing, right foot forward. Drawn at true scale: `h` is the person's
// height in pixels, i.e. 1.7 m (an adult) or 1.3 m (a child with a school bag) times the footage's pixels per metre.
const INK = 'rgba(10, 12, 20, 0.92)';

export const PEDESTRIAN_M = {adult: 1.7, child: 1.3};

// `shadow: false` leaves the road shadow to the caller (a knocked person is rotated, the shadow stays on the road); `flail` (0..1)
// throws the arms up and spreads the legs; `look` (-1..1) turns the head toward a side, showing a little cheek.
export function pedestrian(ctx, x, foot, h, t = 0, {child = true, shadow = true, flail = 0, look = 0} = {}) {
  const u = h / 100, o = Math.max(1.2, 1.5 * u);      // u: one hundredth of the height; o: outline width
  // 0.55 s per step. step ∈ [-1, 1]: -1 right foot forward, 0 passing, +1 left foot forward (a smooth swing, three poses).
  const step = Math.sin(t / 0.55 * Math.PI), lift = Math.abs(Math.cos(t / 0.55 * Math.PI));
  const limb = (x0, y0, x1, y1, w, col) => {
    ctx.lineCap = 'round'; ctx.strokeStyle = INK; ctx.lineWidth = w + 2 * o;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
  };
  const shape = (draw, col) => { ctx.beginPath(); draw(); ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = o; ctx.lineJoin = 'round'; ctx.stroke(); };
  const jacket = child ? '#ffb020' : '#4d6fa8', trousers = child ? '#3a4a78' : '#2b2f3c', skin = '#d9a37e', hair = child ? '#4a3222' : '#2a211c';
  ctx.save(); ctx.translate(x, foot);
  // soft shadow on the road
  if (shadow) { ctx.save(); ctx.scale(1, 0.22); const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 17 * u);
  g.addColorStop(0, 'rgba(0,0,0,0.38)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 17 * u, 0, 7); ctx.fill(); ctx.restore(); }
  const hip = -44 * u, shoulder = -78 * u;
  // legs: the forward leg is raised and foreshortened (walking away, it reaches up the picture)
  for (const side of [-1, 1]) {
    const fwd = side * step, y = -Math.max(0, fwd) * 6 * u * (0.6 + lift * 0.4), len = 1 - 0.1 * Math.max(0, fwd);
    const fx = side * (5.5 + 8 * flail) * u, fy = y - 2 * u * len - flail * 7 * u * (side > 0 ? 1 : 0.4);
    limb(side * 5 * u, hip, fx, fy, 8.6 * u, trousers);
    shape(() => ctx.ellipse(fx, fy + 0.5 * u, 5.2 * u, 3 * u, 0, 0, 7), '#1b1d26');
  }
  // arms swing against the legs
  for (const side of [-1, 1]) limb(side * 11.5 * u, shoulder + 3 * u, side * (13 + 14 * flail) * u, (hip + 4 * u - side * step * 4 * u) * (1 - flail) + (shoulder - 20 * u) * flail, 5.8 * u, jacket);
  shape(() => { ctx.moveTo(-11 * u, shoulder); ctx.lineTo(11 * u, shoulder); ctx.lineTo(9 * u, hip + 3 * u); ctx.lineTo(-9 * u, hip + 3 * u); ctx.closePath(); }, jacket);
  if (child) {   // school bag: rounded body, pocket and straps
    shape(() => ctx.roundRect(-8 * u, shoulder + 3 * u, 16 * u, 24 * u, 4.5 * u), '#2f80ed');
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = Math.max(1, 1.1 * u);
    ctx.beginPath(); ctx.roundRect(-5.2 * u, shoulder + 15 * u, 10.4 * u, 8 * u, 2 * u); ctx.stroke();
  } else { ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = Math.max(1, u); ctx.beginPath(); ctx.moveTo(0, shoulder + 2 * u); ctx.lineTo(0, hip); ctx.stroke(); }
  shape(() => ctx.rect(-2.6 * u, shoulder - 4 * u, 5.2 * u, 5 * u), skin);   // neck
  const hr = child ? 9.4 * u : 8 * u, hx = look * 3 * u;
  shape(() => ctx.arc(hx, shoulder - 11 * u, hr, 0, 7), hair);   // head seen from behind: hair all over
  if (Math.abs(look) > 0.25) {   // turned toward a side: a sliver of cheek and an ear show on that side
    const a = Math.min(1, (Math.abs(look) - 0.25) / 0.5), sd = Math.sign(look);
    ctx.save(); ctx.globalAlpha *= a; shape(() => ctx.ellipse(hx + sd * hr * 0.72, shoulder - 10 * u, hr * 0.34, hr * 0.62, 0, 0, 7), skin); ctx.restore();
  }
  ctx.restore();
}
