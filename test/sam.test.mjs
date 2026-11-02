// Mask measurements on synthetic SAM output, encoded with the parser's own encoder so the wire format is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeSegmentationMask} from '../node_modules/@meta-sam/parser/dist/mask-codec.js';
import {parseSam, tracksFrom, summarise, referencePixels, toMetres} from '../lib/sam.mjs';

// One record line for an object id with a filled disc of radius r at (cx, cy) in a W×H frame.
function discRecord(id, cx, cy, r, W, H, conf = 0.9) {
  const left = Math.floor(cx - r), top = Math.floor(cy - r), right = Math.ceil(cx + r), bottom = Math.ceil(cy + r);
  const w = right - left, h = bottom - top, raster = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raster[y * w + x] = Math.hypot(left + x + 0.5 - cx, top + y + 0.5 - cy) <= r ? 1 : 0;
  const m = encodeSegmentationMask(raster, w, h); // the payload starts with its own encoding marker
  return `${id}<|box;x1=${left};y1=${top};x2=${right - 1};y2=${bottom - 1};w=${W};h=${H};c=${conf}|><|mask;x=0;y=0;c=${conf};data=${h},${w},${m.payload}|>`;
}

test('centroids and sizes come back from SAM-format masks', async () => {
  const W = 640, H = 360, fps = 30, lines = [];
  // A ball of radius 20 px falling from rest at 300 px/s² for 20 frames, plus a static sheet-sized disc.
  for (let f = 0; f < 20; f++) {
    const t = f / fps, y = 60 + 0.5 * 300 * t * t;
    lines.push(`<${f}f>` + discRecord(1, 200.3, y, 20, W, H) + ',' + discRecord(4, 500, 100, 30, W, H, 0.95));
  }
  const result = await parseSam({kind: 'video', text: lines.join('\n') + '\n'});
  assert.equal(result.outcome.status, 'completed');
  assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), []);
  const tracks = tracksFrom(result);
  assert.deepEqual(Object.keys(tracks).sort(), ['1', '4']);
  const ball = tracks['1'];
  assert.equal(ball.length, 20);
  for (let f = 0; f < 20; f++) {
    const t = f / fps;
    assert.ok(Math.abs(ball[f].cy - (60 + 150 * t * t)) < 0.6, `frame ${f} cy ${ball[f].cy}`);
    assert.ok(Math.abs(ball[f].cx - 200.3) < 0.6);
  }
  const ref = referencePixels(ball, 'diameter');
  assert.ok(Math.abs(ref.px - 40) < 1.5, 'diameter ' + ref.px);
  const sum = summarise(tracks, {fps, width: W, height: H});
  assert.equal(sum.find(s => s.object === '1').moving, true);
  assert.equal(sum.find(s => s.object === '4').moving, false);
  // 40 px = 0.24 m ball → ppm 166.7; acceleration 300 px/s² → 1.8 m/s² downward.
  const m = toMetres(ball, {fps, ppm: 40 / 0.24});
  const last = m.y.at(-1), t = m.t.at(-1);
  assert.ok(Math.abs(-2 * last / (t * t) - 300 / (40 / 0.24)) < 0.05);
});
