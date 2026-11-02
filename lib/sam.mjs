// SAM 3.1 output → measurements. SAM returns, for every frame, a box and a pixel-accurate mask per object; we turn
// the masks into sub-pixel centroids (the mean of the mask's pixels, steadier than a box centre when the outline
// flickers), pixel sizes along the object's own axes, and per-object tracks over time.
import {parseVideoStream, parseImageStream, recordsOfKind, frameIndexOf, decodeMaskToRaster} from '@meta-sam/parser';

async function* eventsOf(text) {
  const lane = {item_id: 'sam', output_index: 0, content_index: 0};
  if (text) yield {type: 'response.output_text.delta', delta: text, ...lane};
  yield {type: 'response.output_text.done', text, ...lane};
  yield {type: 'response.completed'};
}

export async function parseSam(raw) {
  const parse = raw.kind === 'image' ? parseImageStream : parseVideoStream;
  return parse(eventsOf(raw.text)).finalResult;
}

// Moments of a mask: area, centroid and the principal axes (PCA of the pixel coordinates), in source pixels.
export function maskMoments(record) {
  const {width, height} = record.mask, {left, top} = record.bounds;
  const raster = decodeMaskToRaster(record.mask);
  // A mask raster may be smaller than its box (SAM sends masks at reduced resolution for big objects): scale to the box.
  const sx = (record.bounds.right - left) / width, sy = (record.bounds.bottom - top) / height;
  let n = 0, mx = 0, my = 0;
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) if (raster[r * width + c]) { n++; mx += c; my += r; }
  if (!n) return null;
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) if (raster[r * width + c]) {
    const dx = (c - mx) * sx, dy = (r - my) * sy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
  // For a uniform rectangle the variance along an axis is L²/12, for a disc of diameter D it is D²/16.
  return {
    area: n * sx * sy,
    cx: left + (mx + 0.5) * sx, cy: top + (my + 0.5) * sy,
    major: Math.sqrt(12 * l1), minor: Math.sqrt(12 * l2), // as rectangle side lengths
    across: 4 * Math.sqrt(l2),                              // as a disc's diameter, measured across any motion blur
    diameter: 2 * Math.sqrt(n * sx * sy / Math.PI),         // equivalent-circle diameter (inflated by blur)
    angle: Math.atan2(l1 - sxx, sxy || 1e-12) * 180 / Math.PI,
    box: {left: record.bounds.left, top: record.bounds.top, right: record.bounds.right, bottom: record.bounds.bottom},
  };
}

// Video result → {objectId: [{frame, cx, cy, area, major, minor, diameter, box, conf}]} sorted by frame.
export function tracksFrom(result) {
  const tracks = {};
  for (const rec of recordsOfKind(result.records, 'mask')) {
    const m = maskMoments(rec);
    if (!m) continue;
    (tracks[rec.objectId] ||= []).push({frame: frameIndexOf(rec) ?? 0, ...m, conf: rec.confidence ?? null});
  }
  for (const id in tracks) tracks[id].sort((a, b) => a.frame - b.frame);
  return tracks;
}

// A compact, model-readable summary of each tracked object (the agent sees this, not the raw masks).
export function summarise(tracks, {fps, width, height}) {
  const r1 = v => Math.round(v * 10) / 10;
  return Object.entries(tracks).map(([id, pts]) => {
    let path = 0;
    for (let i = 1; i < pts.length; i++) path += Math.hypot(pts[i].cx - pts[i - 1].cx, pts[i].cy - pts[i - 1].cy);
    const xs = pts.map(p => p.cx), ys = pts.map(p => p.cy), first = pts[0], last = pts.at(-1);
    const sizes = pts.map(p => p.minor).sort((a, b) => a - b);
    const conf = pts.filter(p => p.conf != null).map(p => p.conf);
    return {
      object: id, frames_seen: pts.length, first_frame: first.frame, last_frame: last.frame,
      seconds: r1((last.frame - first.frame) / fps * 10) / 10,
      start_px: [r1(first.cx), r1(first.cy)], end_px: [r1(last.cx), r1(last.cy)],
      x_range_px: [r1(Math.min(...xs)), r1(Math.max(...xs))], y_range_px: [r1(Math.min(...ys)), r1(Math.max(...ys))],
      path_px: Math.round(path), moving: path > 0.05 * Math.hypot(width, height),
      size_px: {median_minor: r1(sizes[sizes.length >> 1]), median_major: r1(pts.map(p => p.major).sort((a, b) => a - b)[pts.length >> 1]), median_diameter: r1(pts.map(p => p.across).sort((a, b) => a - b)[pts.length >> 1])},
      mean_confidence: conf.length ? Math.round(conf.reduce((a, b) => a + b, 0) / conf.length * 100) / 100 : null,
    };
  });
}

// Pixel size of a reference object, robust to motion blur: blur stretches a moving object along its motion, so for
// a moving reference we take the size across the motion (minor axis) from the slowest frames.
export function referencePixels(pts, dimension = 'longest') {
  const pick = p => dimension === 'diameter' ? p.across : dimension === 'shortest' ? p.minor : p.major;
  const speed = pts.map((p, i) => i ? Math.hypot(p.cx - pts[i - 1].cx, p.cy - pts[i - 1].cy) : Infinity);
  const order = pts.map((p, i) => i).sort((a, b) => speed[a] - speed[b]);
  const slow = order.slice(0, Math.max(3, Math.ceil(pts.length / 3))).map(i => pick(pts[i])).sort((a, b) => a - b);
  const med = slow[slow.length >> 1];
  const mad = slow.map(v => Math.abs(v - med)).sort((a, b) => a - b)[slow.length >> 1];
  return {px: med, sigma_px: Math.max(1, 1.4826 * mad), samples: slow.length};
}

// Pixels → metres, y up, time in seconds. Scale is `ppm` pixels per metre; the origin is the first point.
export function toMetres(pts, {fps, ppm, frameOffset = 0}) {
  const x0 = pts[0].cx, y0 = pts[0].cy;
  return {
    t: pts.map(p => (p.frame - frameOffset) / fps),
    x: pts.map(p => (p.cx - x0) / ppm),
    y: pts.map(p => (y0 - p.cy) / ppm),
    w: pts.map(p => p.conf ?? 1),
    origin_px: [x0, y0], ppm, fps,
  };
}
