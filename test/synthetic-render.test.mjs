// Renderer smoke test: needs ffmpeg/ffprobe; skipped when they are not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderScene } from '../bench/render-synthetic.mjs';
import { CAMERA } from '../bench/scenes.mjs';

const have = (bin) => spawnSync(bin, ['-version']).status === 0;
const skip = !(have('ffmpeg') && have('ffprobe')) && 'ffmpeg/ffprobe not installed';

test('renders a 1 s clip with the right size, fps, frame count, truth and ball position', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rf-synth-'));
  try {
    const out = await renderScene('drop', { outDir: dir, seconds: 1 });
    assert.equal(out.frames, 30);
    const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames,codec_name,pix_fmt', '-of', 'json', out.file]).stdout.toString()).streams[0];
    assert.equal(probe.width, 1280); assert.equal(probe.height, 720);
    assert.equal(probe.r_frame_rate, '30/1'); assert.equal(probe.nb_read_frames, '30');
    assert.equal(probe.codec_name, 'h264'); assert.equal(probe.pix_fmt, 'yuv420p');
    assert.ok(statSync(out.file).size < 1.5e6);

    const truth = JSON.parse(readFileSync(out.truthFile, 'utf8'));
    assert.equal(truth.per_frame.length, 30);
    assert.equal(truth.camera.px_per_metre, CAMERA.pxPerMetre);
    const sheet = truth.reference_sheet.box_px;
    assert.ok(Math.abs((sheet[2] - sheet[0]) / (sheet[3] - sheet[1]) - 0.210 / 0.297) < 1e-9, 'A4 aspect ratio, portrait');
    assert.equal(truth.params.g, 9.81);

    // The orange ball in the decoded frame sits where the truth says (within ~1.5 px, despite blur + compression).
    const k = 22, rgb = spawnSync('ffmpeg', ['-v', 'error', '-i', out.file, '-vf', `select=eq(n\\,${k})`, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 }).stdout;
    assert.equal(rgb.length, 1280 * 720 * 3);
    const f = truth.per_frame[k];
    let n = 0, sx = 0, sy = 0;
    for (let y = Math.round(f.cy_px) - 60; y < Math.round(f.cy_px) + 60; y++) for (let x = Math.round(f.cx_px) - 60; x < Math.round(f.cx_px) + 60; x++) {  // window: the wooden floor is orange too
      const i = (y * 1280 + x) * 3, r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      if (r > 60 && r - b > 35 && r > g + 15 && g < 160) { n++; sx += x; sy += y; }
    }
    assert.ok(n > 800, `ball pixels: ${n}`);
    assert.ok(Math.abs(sx / n - f.cx_px) < 1.5 && Math.abs(sy / n - f.cy_px) < 2, `centroid (${sx / n}, ${sy / n}) vs truth (${f.cx_px}, ${f.cy_px})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
