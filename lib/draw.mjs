// Minimal anti-aliased drawing on RGB24 buffers, for the check images the agent looks at and for rendered forks.
// (No canvas dependency on the server: a few primitives are all the overlays need.)

export function blend(img, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || a <= 0) return;
  const i = (y * img.width + x) * 3, d = img.data;
  d[i] += (rgb[0] - d[i]) * a; d[i + 1] += (rgb[1] - d[i + 1]) * a; d[i + 2] += (rgb[2] - d[i + 2]) * a;
}

// Disc (filled) or ring (stroke > 0) with 1-px anti-aliasing.
export function circle(img, cx, cy, r, rgb, {stroke = 0, alpha = 1} = {}) {
  const R = r + stroke + 1;
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const cov = stroke ? Math.max(0, Math.min(1, stroke / 2 + 0.5 - Math.abs(d - r))) : Math.max(0, Math.min(1, r + 0.5 - d));
    blend(img, x, y, rgb, cov * alpha);
  }
}

export function line(img, x0, y0, x1, y1, rgb, {width = 2, alpha = 1} = {}) {
  const minX = Math.floor(Math.min(x0, x1) - width), maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width), maxY = Math.ceil(Math.max(y0, y1) + width);
  const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1e-9;
  for (let y = Math.max(0, minY); y <= Math.min(img.height - 1, maxY); y++) for (let x = Math.max(0, minX); x <= Math.min(img.width - 1, maxX); x++) {
    const px = x + 0.5, py = y + 0.5, t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / L2));
    const d = Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
    blend(img, x, y, rgb, Math.max(0, Math.min(1, width / 2 + 0.5 - d)) * alpha);
  }
}

export function polyline(img, pts, rgb, opts) {
  for (let i = 1; i < pts.length; i++) line(img, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], rgb, opts);
}

export function copy(img) { return {width: img.width, height: img.height, data: Buffer.from(img.data)}; }

// Paste `tiles` (same size) into a grid image, scaled down by `scale` (box filter).
export function contactSheet(tiles, {cols = 3, scale = 0.5, gap = 6} = {}) {
  const tw = Math.floor(tiles[0].width * scale), th = Math.floor(tiles[0].height * scale);
  const rows = Math.ceil(tiles.length / cols);
  const W = cols * tw + (cols + 1) * gap, H = rows * th + (rows + 1) * gap;
  const out = {width: W, height: H, data: Buffer.alloc(W * H * 3, 24)};
  const k = Math.round(1 / scale);
  tiles.forEach((t, n) => {
    const ox = gap + (n % cols) * (tw + gap), oy = gap + Math.floor(n / cols) * (th + gap);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      let r = 0, g = 0, b = 0, c = 0;
      for (let v = 0; v < k; v++) for (let u = 0; u < k; u++) {
        const sx = Math.min(t.width - 1, Math.floor(x / scale) + u), sy = Math.min(t.height - 1, Math.floor(y / scale) + v);
        const i = (sy * t.width + sx) * 3; r += t.data[i]; g += t.data[i + 1]; b += t.data[i + 2]; c++;
      }
      const o = ((oy + y) * W + ox + x) * 3; out.data[o] = r / c; out.data[o + 1] = g / c; out.data[o + 2] = b / c;
    }
  });
  return out;
}

export const COLORS = {measured: [255, 214, 10], fit: [0, 200, 255], ghost: [255, 64, 160], white: [255, 255, 255]};
