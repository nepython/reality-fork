#!/usr/bin/env node
// Software rasteriser for synthetic physics clips with known ground truth.
//
//   node bench/render-synthetic.mjs                 # render every scene into bench/synthetic/
//   node bench/render-synthetic.mjs --only drop     # one scene
//   node bench/render-synthetic.mjs --out /tmp/x    # other output directory
//
// Pure JS (no dependencies): primitives are rasterised with signed-distance anti-aliasing,
// motion blur comes from averaging SUBFRAMES sub-exposures, and a little sensor noise is added;
// raw RGB24 frames are piped to ffmpeg (libx264).  Each clip is accompanied by <id>.truth.json.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CAMERA, A4, SCENES, sceneById } from './scenes.mjs';

const { width: W, height: H, pxPerMetre: S, ox, oy, wallBase } = CAMERA;
const SUBFRAMES = 4;        // temporal supersamples per frame (motion blur)
const SHUTTER = 0.5;        // exposure as a fraction of the frame interval
const NOISE_SIGMA = 2.0;    // sensor noise, 8-bit levels
const px = (X) => ox + X * S;
const py = (Y) => oy - Y * S;

// ---------------------------------------------------------------- tiny helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/** Deterministic hash -> [0,1). */
function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed + 1, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Bilinear value noise in [0,1). */
function vnoise(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return mix(mix(hash2(ix, iy, seed), hash2(ix + 1, iy, seed), sx), mix(hash2(ix, iy + 1, seed), hash2(ix + 1, iy + 1, seed), sx), sy);
}

/** Alpha-composite one colour onto an RGB24 buffer. */
function over(buf, x, y, r, g, b, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = clamp(buf[i] * (1 - a) + r * a, 0, 255);     // Uint8Array wraps on overflow, so clamp
  buf[i + 1] = clamp(buf[i + 1] * (1 - a) + g * a, 0, 255);
  buf[i + 2] = clamp(buf[i + 2] * (1 - a) + b * a, 0, 255);
}

/** Fill the region where sdf(px+0.5, py+0.5) < 0, anti-aliased; shade(x,y) -> [r,g,b,a]. */
function fillSDF(buf, bbox, sdf, shade) {
  const x0 = Math.max(0, Math.floor(bbox[0])), y0 = Math.max(0, Math.floor(bbox[1]));
  const x1 = Math.min(W - 1, Math.ceil(bbox[2])), y1 = Math.min(H - 1, Math.ceil(bbox[3]));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const cov = clamp(0.5 - sdf(x + 0.5, y + 0.5), 0, 1);
    if (cov <= 0) continue;
    const c = shade(x + 0.5, y + 0.5);
    over(buf, x, y, c[0], c[1], c[2], cov * (c[3] ?? 1));
  }
}
const solid = (r, g, b, a = 1) => () => [r, g, b, a];

const rectSDF = (x0, y0, x1, y1) => (x, y) => Math.max(x0 - x, x - x1, y0 - y, y - y1);
function capsuleSDF(ax, ay, bx, by, hw) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
  return (x, y) => { const t = clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1); return Math.hypot(x - ax - t * dx, y - ay - t * dy) - hw; };
}
/** Oriented box: centre, unit direction u (pixels, y down), half-length, half-width. */
function orientedBox(cx, cy, ux, uy, hl, hw) {
  return {
    sdf: (x, y) => { const lx = (x - cx) * ux + (y - cy) * uy, ly = -(x - cx) * uy + (y - cy) * ux; return Math.max(Math.abs(lx) - hl, Math.abs(ly) - hw); },
    local: (x, y) => [(x - cx) * ux + (y - cy) * uy, -(x - cx) * uy + (y - cy) * ux],
    bbox: [cx - Math.abs(ux) * hl - Math.abs(uy) * hw - 2, cy - Math.abs(uy) * hl - Math.abs(ux) * hw - 2, cx + Math.abs(ux) * hl + Math.abs(uy) * hw + 2, cy + Math.abs(uy) * hl + Math.abs(ux) * hw + 2],
  };
}

// ---------------------------------------------------------------- static background per theme
const THEMES = {
  room: { wallTop: [214, 205, 190], wallBot: [193, 184, 170], floor: [150, 108, 70], stripe: [205, 196, 181] },
  iss: { wallTop: [226, 229, 233], wallBot: [205, 209, 215], floor: [226, 229, 233], stripe: [196, 201, 208] },
  moon: { wallTop: [84, 88, 96], wallBot: [66, 70, 78], floor: [152, 149, 144], stripe: [74, 78, 86] },
};

function paintBackground(theme, scene) {
  const T = THEMES[theme], buf = new Uint8Array(W * H * 3);
  const hasFloor = theme !== 'iss';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let c;
      if (!hasFloor || y < wallBase) {
        const t = y / (hasFloor ? wallBase : H);
        const lowFreq = vnoise(x / 160, y / 160, 1) - 0.5, grain = vnoise(x / 3, y / 3, 2) - 0.5;
        const vig = 1 - 0.10 * (((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2) * 0.5;
        const shade = (1 + 0.05 * lowFreq + 0.025 * grain) * vig;
        c = T.wallTop.map((v, k) => mix(v, T.wallBot[k], t) * shade);
        // wall panel seams / wallpaper stripes, faint
        if (theme === 'room' && (x % 200) < 2) c = c.map((v, k) => mix(v, T.stripe[k], 0.6));
        if (theme !== 'room') {
          const seamX = (x + 40) % 215 < 2, seamY = (y + 30) % 190 < 2;
          if (seamX || seamY) c = c.map((v) => v * 0.9);
          // rivets
          if (((x + 40) % 215 > 12 && (x + 40) % 215 < 17) && (((y + 30) % 190) > 12 && ((y + 30) % 190) < 17)) c = c.map((v) => v * 0.8);
        }
      } else {
        const t = (y - wallBase) / (H - wallBase);
        const grain = vnoise(x / 2, y / 6, 3) - 0.5, plankSeed = vnoise(Math.floor((x - 640) / Math.max(10, 60 * (0.5 + t * 1.5))), 0, 4);
        let shade = mix(1.0, 0.72, t) * (1 + 0.10 * grain);
        if (theme === 'room') {
          // floorboards: lines converging toward a vanishing point at the horizon
          const spread = 1 + t * 3.2, u = (x - 640) / (95 * spread);
          if (Math.abs(u - Math.round(u)) < 0.012 * spread) shade *= 0.78;
          shade *= 0.93 + 0.14 * hash2(Math.round(u), 7, 5) + 0.02 * plankSeed;
        } else {
          shade *= 0.95 + 0.05 * vnoise(x / 20, y / 20, 6); // regolith dust
        }
        c = T.floor.map((v) => v * shade);
      }
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
    }
  }
  if (hasFloor) { // baseboard + soft contact shadow where the wall meets the floor
    for (let y = wallBase - 14; y < wallBase + 10; y++) for (let x = 0; x < W; x++) {
      const k = y < wallBase ? 0.82 : mix(0.72, 1, (y - wallBase) / 10);
      over(buf, x, y, 40 * k, 34 * k, 30 * k, y < wallBase ? 0.45 : 0.3 * (1 - (y - wallBase) / 10));
    }
  }
  if (theme === 'iss') drawIssFurniture(buf);
  if (theme === 'moon') drawCraters(buf);
  drawSheet(buf);
  scene.drawStatic?.(buf);
  return buf;
}

function drawIssFurniture(buf) {
  // blue stripe, handrail with brackets, a cable run
  fillSDF(buf, [0, 540, W, 600], rectSDF(0, 548, W, 590), solid(52, 96, 160, 0.9));
  fillSDF(buf, [0, 60, W, 110], rectSDF(0, 70, W, 96), solid(176, 180, 186, 1));
  fillSDF(buf, [0, 60, W, 110], rectSDF(0, 72, W, 76), solid(240, 242, 245, 0.8));
  for (const x of [120, 520, 920, 1240]) fillSDF(buf, [x - 12, 60, x + 12, 110], rectSDF(x - 8, 56, x + 8, 112), solid(120, 124, 130, 1));
  fillSDF(buf, [0, 300, W, 320], capsuleSDF(0, 316, W, 304, 3), solid(44, 44, 48, 0.9));
}
function drawCraters(buf) {
  for (let k = 0; k < 14; k++) {
    const cx = hash2(k, 1, 9) * W, cy = wallBase + 20 + hash2(k, 2, 9) * (H - wallBase - 30), rx = 18 + hash2(k, 3, 9) * 60, ry = rx * 0.22;
    fillSDF(buf, [cx - rx - 2, cy - ry - 2, cx + rx + 2, cy + ry + 2], (x, y) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * ry, (x, y) => (y < cy ? [80, 78, 74, 0.25] : [200, 198, 192, 0.18]));
  }
}

/** White A4 sheet pinned flat on the wall facing the camera: the metric scale reference. */
function drawSheet(buf) {
  const x0 = px(A4.X), x1 = px(A4.X + A4.w), y1 = py(A4.Y), y0 = py(A4.Y + A4.h);
  fillSDF(buf, [x0, y0, x1 + 6, y1 + 6], rectSDF(x0 + 2.5, y0 + 3, x1 + 2.5, y1 + 3), solid(40, 36, 30, 0.22)); // paper shadow on the wall
  fillSDF(buf, [x0 - 1, y0 - 1, x1 + 1, y1 + 1], rectSDF(x0, y0, x1, y1), (x, y) => [mix(247, 238, (y - y0) / (y1 - y0)), mix(247, 238, (y - y0) / (y1 - y0)), mix(244, 234, (y - y0) / (y1 - y0)), 1]);
  // faint text: a heading bar then ruled lines of varying length
  const m = 0.012 * S;
  fillSDF(buf, [x0, y0, x1, y1], rectSDF(x0 + m * 1.5, y0 + m * 1.6, x0 + (x1 - x0) * 0.62, y0 + m * 1.6 + 3.2), solid(120, 124, 132, 0.55));
  for (let row = 0, y = y0 + m * 1.6 + 11; y < y1 - m * 1.5; row++, y += 5.2) {
    const len = (0.55 + 0.45 * hash2(row, 3, 11)) * (x1 - x0 - 3 * m);
    fillSDF(buf, [x0, y - 1, x1, y + 2], rectSDF(x0 + 1.5 * m, y, x0 + 1.5 * m + len, y + 1.1), solid(135, 138, 146, 0.5));
  }
  for (const [cx, cy] of [[x0 + 3, y0 + 3], [x1 - 3, y0 + 3], [x0 + 3, y1 - 3], [x1 - 3, y1 - 3]]) // pins
    fillSDF(buf, [cx - 3, cy - 3, cx + 3, cy + 3], (x, y) => Math.hypot(x - cx, y - cy) - 1.6, solid(178, 40, 40, 1));
}

// ---------------------------------------------------------------- moving things (drawn per sub-exposure)
const LIGHT = (() => { const v = [-0.45, -0.55, 0.7], n = Math.hypot(...v); return v.map((c) => c / n); })();
const HALF = (() => { const v = [LIGHT[0], LIGHT[1], LIGHT[2] + 1], n = Math.hypot(...v); return v.map((c) => c / n); })();
const SEAMS = {
  basketball: [[1, 0, 0], [0, 1, 0], [0.62, 0, 0.78], [-0.62, 0, 0.78]].map((v) => { const n = Math.hypot(...v); return v.map((c) => c / n); }),
  tennis: [[0.55, 0.15, 0.82], [-0.55, 0.15, 0.82]].map((v) => { const n = Math.hypot(...v); return v.map((c) => c / n); }),
};
const BALLS = {
  basketball: { base: [212, 96, 30], seam: [28, 18, 12], seamW: 1.5, offs: [0, 0, 0, 0], bump: 0.07 },
  tennis: { base: [206, 224, 58], seam: [244, 244, 236], seamW: 1.0, offs: [0.32, -0.32], bump: 0.10 },
};

/** Shaded, seamed sphere seen frontally, spun by `rot` radians about the view axis. */
function drawBall(buf, cx, cy, r, rot, kind) {
  const spec = BALLS[kind], seams = SEAMS[kind], cs = Math.cos(rot), sn = Math.sin(rot);
  fillSDF(buf, [cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2], (x, y) => Math.hypot(x - cx, y - cy) - r, (x, y) => {
    const nx = clamp((x - cx) / r, -1, 1), ny = clamp((y - cy) / r, -1, 1), nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const diff = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const spc = Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), 28) * (kind === 'tennis' ? 0.08 : 0.30);
    let shade = 0.30 + 0.78 * diff;
    const rx = nx * cs + ny * sn, ry = -nx * sn + ny * cs;             // sphere frame (spun)
    shade *= 1 - spec.bump + 2 * spec.bump * vnoise(rx * r / 2.2 + 50, ry * r / 2.2 + 50, 8); // pebbled/felt texture
    let col = spec.base.map((v) => v * shade);
    let seam = 0;
    for (let k = 0; k < seams.length; k++) {
      const a = seams[k], off = spec.offs[k] ?? 0;
      const d = Math.abs(rx * a[0] + ry * a[1] + nz * a[2] - off) / ((spec.seamW / r) * Math.max(0.35, nz * 0.7 + 0.3));
      seam = Math.max(seam, 1 - clamp(d, 0, 1));
    }
    col = col.map((v, i) => mix(v, spec.seam[i] * (kind === 'tennis' ? 0.5 + 0.5 * shade : shade), seam * 0.9));
    return [Math.min(255, col[0] + 255 * spc), Math.min(255, col[1] + 255 * spc), Math.min(255, col[2] + 255 * spc), 1];
  });
}

/** Soft elliptical contact shadow on the floor, fading with height h (m). */
function drawFloorShadow(buf, X, h, r) {
  const cx = px(X) + 6, cy = py(0) + 7, rx = r * S * (1.0 + 0.25 * Math.min(h, 2)), ry = rx * 0.17;
  const a = 0.42 / (1 + 1.4 * h);
  fillSDF(buf, [cx - rx * 1.3, cy - ry * 1.5, cx + rx * 1.3, cy + ry * 1.5], (x, y) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * ry,
    (x, y) => [22, 18, 14, a * (1 - smooth(0.2, 1.3, Math.hypot((x - cx) / rx, (y - cy) / ry)))]);
}

// ---------------------------------------------------------------- scene-specific static parts
function addSceneDecor(scene) {
  if (scene.pivot) {
    const X = px(scene.pivot.X), Y = py(scene.pivot.Y);
    scene.drawStatic = (buf) => {
      fillSDF(buf, [X - 60, Y - 40, X + 60, Y + 20], rectSDF(X - 46, Y - 24, X + 46, Y - 12), solid(108, 112, 120, 1));
      fillSDF(buf, [X - 60, Y - 40, X + 60, Y + 20], rectSDF(X - 46, Y - 24, X + 46, Y - 22), solid(190, 194, 200, 0.8));
      fillSDF(buf, [X - 12, Y - 20, X + 12, Y + 12], rectSDF(X - 7, Y - 14, X + 7, Y + 2), solid(88, 92, 100, 1));
      fillSDF(buf, [X - 12, Y - 12, X + 12, Y + 12], (x, y) => Math.hypot(x - X, y - Y) - 5, solid(60, 62, 68, 1));
    };
  }
  if (scene.plank) {
    const { from, alpha, length, thickness } = scene.plank;
    scene.drawStatic = (buf) => {
      const ux = Math.cos(alpha), uy = Math.sin(alpha); // pixel-space direction (y down)
      // legs: posts from the floor to the plank underside at 1/5 and 4/5 of its length
      for (const f of [0.2, 0.8]) {
        const X = from.X + f * length * Math.cos(alpha), Ytop = from.Y - f * length * Math.sin(alpha) - thickness;
        fillSDF(buf, [px(X) - 14, py(Ytop) - 2, px(X) + 14, py(0) + 8], rectSDF(px(X) - 9, py(Ytop), px(X) + 9, py(0) + 4), (x, y) => [150 + 20 * vnoise(x / 2, y / 18, 12), 106 + 14 * vnoise(x / 2, y / 18, 12), 68, 1]);
      }
      const cx = px(from.X + 0.5 * length * Math.cos(alpha)), cy = py(from.Y - 0.5 * length * Math.sin(alpha) - thickness / 2);
      const box = orientedBox(cx, cy, ux, uy, 0.5 * length * S, 0.5 * thickness * S);
      fillSDF(buf, box.bbox, box.sdf, (x, y) => {
        const [lx, ly] = box.local(x, y), grain = vnoise(lx / 40, ly / 1.6, 13) - 0.5, ring = Math.sin(ly * 1.3 + 6 * vnoise(lx / 90, ly / 5, 14));
        const k = 1 + 0.12 * grain + 0.05 * ring;
        return [190 * k, 140 * k, 88 * k, 1];
      });
      // lit top edge
      const top = orientedBox(cx - uy * 0.5 * thickness * S * 0.94, cy + ux * 0.5 * thickness * S * 0.94 * -1, ux, uy, 0.5 * length * S, 0.9);
      fillSDF(buf, top.bbox, top.sdf, solid(235, 200, 150, 0.55));
    };
  }
}

// ---------------------------------------------------------------- rendering loop
const gaussTable = (() => { // 1M pre-drawn Gaussian samples (Box-Muller, fixed seed) for cheap per-frame noise
  const n = 1 << 20, t = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const u1 = hash2(i, 1, 21) || 1e-9, u2 = hash2(i, 2, 21);
    t[i] = Math.round(NOISE_SIGMA * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
  }
  return t;
})();

/** Draw everything that moves at time t onto `buf`. */
function drawDynamic(scene, buf, t) {
  const s = scene.motion(t), r = scene.ball.diameter / 2;
  if (scene.theme !== 'iss') drawFloorShadow(buf, s.X, Math.max(s.Y - r, 0), r);
  if (scene.pivot) {
    const ax = px(scene.pivot.X), ay = py(scene.pivot.Y), bx = px(s.X), by = py(s.Y);
    fillSDF(buf, [Math.min(ax, bx) - 3, Math.min(ay, by) - 3, Math.max(ax, bx) + 3, Math.max(ay, by) + 3], capsuleSDF(ax, ay, bx, by, 1.2), solid(34, 34, 38, 1));
  }
  drawBall(buf, px(s.X), py(s.Y), r * S, s.rot, scene.ball.kind);
}
function dynamicBBox(scene, t) {
  const s = scene.motion(t), r = scene.ball.diameter / 2 * S, bx = px(s.X), by = py(s.Y);
  const b = [bx - r - 8 - r * 0.4, by - r - 8, bx + r + 14 + r * 0.4, by + r + 8];
  if (scene.theme !== 'iss') { b[1] = Math.min(b[1], py(0) - 8); b[3] = Math.max(b[3], py(0) + 20); }  // floor shadow row
  if (scene.pivot) { b[0] = Math.min(b[0], px(scene.pivot.X) - 6); b[1] = Math.min(b[1], py(scene.pivot.Y) - 6); b[2] = Math.max(b[2], px(scene.pivot.X) + 6); }
  return b;
}

function spawnFfmpeg(file, fps) {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => { ff.on('error', reject); ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`)))); });
  return { ff, done };
}

/**
 * Render one scene to <outDir>/<id>.mp4 and <id>.truth.json.
 * `seconds` (optional) truncates the clip, used by the smoke test.
 */
export async function renderScene(sceneOrId, { outDir, seconds } = {}) {
  const scene = typeof sceneOrId === 'string' ? sceneById(sceneOrId) : sceneOrId;
  if (!scene) throw new Error(`unknown scene ${sceneOrId}`);
  mkdirSync(outDir, { recursive: true });
  addSceneDecor(scene);
  const fps = scene.fps, nFrames = Math.round(fps * Math.min(seconds ?? scene.duration, scene.duration));
  const bg = paintBackground(scene.theme, scene);
  const sub = new Uint8Array(bg), frame = new Uint8Array(W * H * 3), acc = new Float32Array(W * H * 3);
  const file = path.join(outDir, `${scene.id}.mp4`);
  const { ff, done } = spawnFfmpeg(file, fps);
  const truth = [];

  for (let k = 0; k < nFrames; k++) {
    const tk = k / fps;                                     // time at the CENTRE of the exposure
    const times = Array.from({ length: SUBFRAMES }, (_, s) => tk + ((s + 0.5) / SUBFRAMES - 0.5) * SHUTTER / fps);
    const boxes = times.map((t) => dynamicBBox(scene, t));
    const x0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b[0])))), x1 = Math.min(W - 1, Math.ceil(Math.max(...boxes.map((b) => b[2]))));
    const y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b[1])))), y1 = Math.min(H - 1, Math.ceil(Math.max(...boxes.map((b) => b[3]))));
    for (let y = y0; y <= y1; y++) acc.fill(0, (y * W + x0) * 3, (y * W + x1 + 1) * 3);
    for (const t of times) {
      for (let y = y0; y <= y1; y++) sub.set(bg.subarray((y * W + x0) * 3, (y * W + x1 + 1) * 3), (y * W + x0) * 3);
      drawDynamic(scene, sub, t);
      for (let y = y0; y <= y1; y++) for (let i = (y * W + x0) * 3, e = (y * W + x1 + 1) * 3; i < e; i++) acc[i] += sub[i];
    }
    frame.set(bg);
    for (let y = y0; y <= y1; y++) for (let i = (y * W + x0) * 3, e = (y * W + x1 + 1) * 3; i < e; i++) frame[i] = acc[i] / SUBFRAMES;
    const off = (k * 7919) & 0xfffff;                      // different noise offset each frame
    for (let i = 0; i < frame.length; i++) { const v = frame[i] + gaussTable[(i + off) & 0xfffff]; frame[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
    if (!ff.stdin.write(frame)) await new Promise((res) => ff.stdin.once('drain', res));

    const c = scene.motion(tk);
    truth.push({ frame: k, t: +tk.toFixed(6), X_m: c.X, Y_m: c.Y, cx_px: px(c.X), cy_px: py(c.Y) });
  }
  ff.stdin.end();
  await done;

  const r = scene.ball.diameter / 2;
  const doc = {
    id: scene.id, title: scene.title, expected_model: scene.expected_model, theme: scene.theme,
    video: `${scene.id}.mp4`, width: W, height: H, fps, frames: nFrames, duration_s: nFrames / fps,
    camera: {
      model: 'fixed fronto-parallel; image = scale + flip of the wall plane',
      px_per_metre: S, origin_px: [ox, oy], y_axis: 'up in world, down in image',
      world_to_pixel: 'px = origin_x + X * px_per_metre; py = origin_y - Y * px_per_metre',
      floor_contact_row_px: py(0), wall_base_row_px: wallBase,
    },
    reference_sheet: {
      description: 'white A4 sheet, portrait, pinned flat on the wall facing the camera',
      width_m: A4.w, height_m: A4.h,
      box_px: [px(A4.X), py(A4.Y + A4.h), px(A4.X + A4.w), py(A4.Y)],
      expected_width_px: A4.w * S, expected_height_px: A4.h * S,
    },
    object: { kind: scene.ball.kind, diameter_m: scene.ball.diameter, diameter_px: scene.ball.diameter * S, radius_px: r * S },
    params: scene.params,
    events: scene.events,
    motion_window_s: scene.motion_window,
    floor_y_m: scene.floor_y_m ?? null,
    render: { subframes: SUBFRAMES, shutter_fraction: SHUTTER, sensor_noise_sigma_levels: NOISE_SIGMA, note: 'frame k is centred on t = k / fps; per-frame centres are the exact object centre at that instant' },
    per_frame: truth.map((f) => ({ ...f, X_m: +f.X_m.toFixed(6), Y_m: +f.Y_m.toFixed(6), cx_px: +f.cx_px.toFixed(3), cy_px: +f.cy_px.toFixed(3) })),
  };
  if (scene.pivot) doc.pivot = { ...scene.pivot, px: [px(scene.pivot.X), py(scene.pivot.Y)] };
  writeFileSync(path.join(outDir, `${scene.id}.truth.json`), JSON.stringify(doc, null, 1));
  return { file, truthFile: path.join(outDir, `${scene.id}.truth.json`), frames: nFrames };
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const only = arg('--only');
  const outDir = path.resolve(arg('--out') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'synthetic'));
  const list = only ? only.split(',').map((id) => sceneById(id) ?? (() => { console.error(`unknown scene "${id}"; have: ${SCENES.map((s) => s.id).join(', ')}`); process.exit(1); })()) : SCENES;
  for (const sc of list) {
    const t0 = Date.now();
    const r = await renderScene(sc, { outDir });
    console.log(`${sc.id}: ${r.frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path.relative(process.cwd(), r.file)}`);
  }
}
