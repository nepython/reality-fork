// The benchmark scenes' ground truth must be consistent with the physics core: sample each
// scene's exact per-frame centre (no video needed), add tracker-like noise, and check the right
// model wins and recovers the documented parameters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENES, CAMERA, A4 } from '../bench/scenes.mjs';
import { fitAll } from '../lib/physics/select.mjs';
import { corrupt } from './helpers/tracks.mjs';

const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const track = (sc) => {
  const n = Math.round(sc.fps * sc.duration), t = Array.from({ length: n }, (_, i) => i / sc.fps);
  const pos = t.map((s) => sc.motion(s));
  return { t, x: pos.map((p) => p.X), y: pos.map((p) => p.Y) };
};

test('the scene list matches the brief', () => {
  assert.deepEqual(SCENES.map((s) => s.id), ['drop', 'throw', 'bounce', 'pendulum', 'incline', 'float', 'moon-drop', 'drop-60fps']);
  assert.equal(SCENES.find((s) => s.id === 'drop-60fps').fps, 60);
  assert.ok(SCENES.every((s) => s.duration >= 2 && s.duration <= 6));
  assert.equal(CAMERA.width, 1280); assert.equal(CAMERA.height, 720);
  assert.ok(Math.abs(A4.w - 0.21) < 1e-9 && Math.abs(A4.h - 0.297) < 1e-9);
});

for (const sc of SCENES) {
  test(`scene ${sc.id}: physics core identifies "${sc.expected_model}" and recovers the truth`, () => {
    const r = fitAll(corrupt(track(sc), { sigma: 0.0025, gaps: 1, outliers: 1, seed: 11 }));
    assert.equal(r.verdict.best, sc.expected_model, JSON.stringify(r.verdict));
    const f = r.fits[0], P = sc.params;
    switch (sc.expected_model) {
      case 'projectile': assert.ok(rel(f.p.g, P.g) < 0.03, `g ${f.p.g} vs ${P.g}`); break;
      case 'projectile-drag': assert.ok(rel(f.p.g, P.g) < 0.03 && rel(f.p.b, P.drag_b) < 0.1, JSON.stringify(f.p)); break;
      case 'bounce': assert.ok(rel(f.p.g, P.g) < 0.02 && Math.abs(f.p.e - P.e) < 0.03, JSON.stringify(f.p)); break;
      case 'pendulum': assert.ok(rel(f.p.L, P.L) < 0.025 && rel(f.p.g, P.g) < 0.03, JSON.stringify(f.p)); break;
      case 'incline': assert.ok(rel(f.p.a, P.a_along_slope) < 0.02 && rel(f.derived.find((d) => d.name === 'g_if_rolling_sphere').value, P.g) < 0.03, JSON.stringify(f.p)); break;
      case 'constant-velocity': assert.ok(Math.abs(f.p.vx - P.vx) < 0.01 && Math.abs(f.p.vy - P.vy) < 0.01); break;
    }
  });
}

test('truth motion stays inside the frame and on the right side of the floor', () => {
  for (const sc of SCENES) {
    const tr = track(sc);
    tr.x.forEach((x, i) => {
      const px = CAMERA.ox + x * CAMERA.pxPerMetre, py = CAMERA.oy - tr.y[i] * CAMERA.pxPerMetre;
      assert.ok(px > 0 && px < CAMERA.width && py > 0 && py < CAMERA.height, `${sc.id} frame ${i}: (${px}, ${py})`);
      if (sc.floor_y_m !== undefined) assert.ok(tr.y[i] >= sc.floor_y_m - 1e-9, `${sc.id} below the floor`);
    });
  }
});
