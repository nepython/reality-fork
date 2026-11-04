// Which frame to cut the object's sprite from: one where it is whole. A frame is a poor source when the mask touches
// the picture's edge (the object is cut by the frame), when it is smaller than the object's robust size (median) (something in
// front of it, such as a signal pole, hides part: area, width or height fall short), or when the mask is in pieces (a
// pole splits a car in two). Among whole frames the one where the object moves least (least blur) wins.
// `masks` is a Map frame → {left, top, right, bottom, at(x, y)}; `pts` the track [frame, x, y, ...].

const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** Area, extent, edge contact and connectedness of one mask, measured on a grid of at most ~100 cells across. */
export function maskStats(m, width, height) {
  const w = m.right - m.left, h = m.bottom - m.top, step = Math.max(1, Math.floor(Math.max(w, h) / 100));
  const gw = Math.ceil(w / step), gh = Math.ceil(h / step), g = new Uint8Array(gw * gh);
  let n = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (m.at(Math.min(w - 1, x * step), Math.min(h - 1, y * step))) { g[y * gw + x] = 1; n++; }
  // Largest 4-connected piece, as a share of all mask cells.
  let best = 0; const seen = new Uint8Array(g.length), stack = [];
  for (let i = 0; i < g.length; i++) if (g[i] && !seen[i]) {
    let size = 0; stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(); size++;
      const x = j % gw, y = (j / gw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const u = x + dx, v = y + dy, k = v * gw + u;
        if (u >= 0 && v >= 0 && u < gw && v < gh && g[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    best = Math.max(best, size);
  }
  // Boundary cells relative to the square root of the area: a clean outline scores low, a ragged one (something clinging to
  // the object, a hand, an antenna) high.
  let rim = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (g[y * gw + x] && !(x && y && x < gw - 1 && y < gh - 1 && g[y * gw + x - 1] && g[y * gw + x + 1] && g[(y - 1) * gw + x] && g[(y + 1) * gw + x])) rim++;
  const edge = m.left <= 1 || m.top <= 1 || m.right >= width - 1 || m.bottom >= height - 1;
  return {area: n * step * step, w, h, edge, rough: rim / Math.sqrt(Math.max(1, n)), whole: n ? best / n : 0, fill: n * step * step / Math.max(1, w * h)};
}

/** Index into pts of the best frame to cut from (always one with a mask), or -1 when no frame has a mask. */
export function chooseSpriteFrame(pts, masks, {width, height}) {
  const cand = [];
  for (let i = 0; i < pts.length; i++) {
    const m = masks.get(pts[i][0]);
    if (!m || m.right <= m.left || m.bottom <= m.top) continue;
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    cand.push({i, speed: Math.hypot(b[1] - a[1], b[2] - a[2]), ...maskStats(m, width, height)});
  }
  if (!cand.length) return -1;
  let pool = cand.filter(c => !c.edge);
  if (!pool.length) pool = cand;
  // Each test is relaxed if it would leave nothing: first not cut by the edge, then whole, then full size. The reference
  // is the 90th percentile, not the median: a car crossing a street is smaller as it recedes, but a signal pole hides
  // part of it for a stretch, and only the larger, earlier frames are certain to be unhidden.
  const ref = k => quantile(pool.map(c => c[k]), 0.9);
  const [A, W, H] = [ref('area'), ref('w'), ref('h')];
  const blur = c => c.speed / Math.max(c.w, c.h);     // pixels moved per frame, relative to the object's size
  const pick = good => {
    // Solid and clean: neither a patchy mask (fill) nor a ragged outline (rough), relative to the better frames.
    const solid = quantile(good.map(c => c.fill), 0.75), clean = quantile(good.map(c => c.rough), 0.25), firm = good.filter(c => c.fill >= 0.9 * solid && c.rough <= 1.15 * clean);
    return (firm.length ? firm : good).reduce((p, c) => blur(c) < blur(p) ? c : p);
  };
  for (const ok of [c => c.whole >= 0.97 && c.area >= 0.9 * A && c.w >= 0.92 * W && c.h >= 0.92 * H,
                    c => c.whole >= 0.9 && c.area >= 0.8 * A, c => c.area >= 0.7 * A, () => true]) {
    const good = pool.filter(ok);
    if (!good.length) continue;
    let best = pick(good);
    // A fast small object (a thrown ball) is stretched into a streak by motion blur, which makes its blurred frames look
    // "bigger" than its sharp ones; when the whole-sized frames are all smeared, take the sharpest whole frame instead.
    if (blur(best) > 0.1) {
      const sharp = pool.filter(c => c.whole >= 0.97 && c.area >= 0.4 * A);
      if (sharp.length) best = pick(sharp);
    }
    return best.i;
  }
  return -1;
}
