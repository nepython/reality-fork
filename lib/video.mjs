// Video plumbing on top of ffmpeg/ffprobe: probing the exact frame timing, normalising uploads into what SAM 3.1 and
// Muse Spark accept (H.264 MP4), and reading frames as raw RGB for the clean plate, cut-outs and check images.
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

export function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_packets,duration:stream_side_data=rotation:format=duration',
    '-of', 'json', file], {encoding: 'utf8'});
  if (r.status !== 0) throw new Error('ffprobe failed: ' + r.stderr.slice(0, 300));
  const j = JSON.parse(r.stdout), s = j.streams?.[0];
  if (!s) throw new Error('no video stream');
  const rate = str => { const [a, b] = String(str).split('/').map(Number); return b ? a / b : a; };
  const fps = rate(s.avg_frame_rate) || rate(s.r_frame_rate);
  const rotation = Number(s.side_data_list?.[0]?.rotation || 0);
  const swap = Math.abs(rotation) === 90;
  return {
    codec: s.codec_name, width: swap ? s.height : s.width, height: swap ? s.width : s.height, rotation,
    fps, fpsExact: s.avg_frame_rate || s.r_frame_rate,
    frames: Number(s.nb_read_packets) || Math.round(fps * Number(s.duration || j.format?.duration || 0)),
    duration: Number(s.duration || j.format?.duration || 0),
  };
}

// Re-encode to H.264 MP4, at most `maxWidth` wide, keeping every original frame and its timing (no resampling:
// timing is the measurement). Constant frame rate is forced only when the source is variable, using its average.
export function normalise(input, output, {maxWidth = 1280, maxSeconds = 20} = {}) {
  const info = probe(input);
  const ok = info.codec === 'h264' && info.width <= maxWidth && !info.rotation && info.duration <= maxSeconds + 0.1;
  if (ok) { if (input !== output) fs.copyFileSync(input, output); return probe(output); }
  const scale = info.width > maxWidth ? `scale=${maxWidth}:-2` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', input, '-t', String(maxSeconds), '-an', '-vf', scale,
    '-fps_mode', 'passthrough', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', output], {encoding: 'utf8'});
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr.slice(0, 400));
  return probe(output);
}

// Read frames as raw RGB24. `frames` is a list of frame indices (sorted), or null for all frames.
// Returns [{index, data: Buffer(width*height*3)}]; `scale` < 1 reads a smaller copy (for the plate).
export function readFrames(file, {frames = null, scale = 1} = {}) {
  const info = probe(file);
  const w = Math.round(info.width * scale / 2) * 2, h = Math.round(info.height * scale / 2) * 2;
  const select = frames ? `select='${frames.map(i => `eq(n\\,${i})`).join('+')}',` : '';
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', `${select}scale=${w}:${h}`, '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {maxBuffer: 1 << 30});
  if (r.status !== 0) throw new Error('ffmpeg frame read failed: ' + String(r.stderr).slice(0, 300));
  const size = w * h * 3, out = [];
  for (let k = 0; k * size < r.stdout.length; k++) out.push({index: frames ? frames[k] : k, data: r.stdout.subarray(k * size, (k + 1) * size)});
  return {width: w, height: h, frames: out};
}

// Clean plate: the per-pixel median of frames spread across the clip. A moving object occupies any one pixel in
// only a few frames, so the median is the background behind it, aligned exactly with the footage (an image model
// asked to "remove the ball" would also shift and resize the scene, which breaks compositing).
export function medianPlate(file, {samples = 31} = {}) {
  const info = probe(file);
  const n = Math.min(samples, info.frames);
  const idx = [...new Set(Array.from({length: n}, (_, k) => Math.round(k * (info.frames - 1) / Math.max(1, n - 1))))];
  const {width, height, frames} = readFrames(file, {frames: idx});
  const out = Buffer.alloc(width * height * 3), col = new Uint8Array(frames.length);
  for (let p = 0; p < out.length; p++) {
    for (let k = 0; k < frames.length; k++) col[k] = frames[k].data[p];
    col.sort();
    out[p] = col[col.length >> 1];
  }
  return {width, height, data: out};
}

// RGB24 buffer → JPEG/PNG bytes via ffmpeg.
export function encodeImage({width, height, data}, format = 'jpeg', {quality = 3} = {}) {
  const args = ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', 'pipe:0', '-frames:v', '1'];
  if (format === 'png') args.push('-f', 'image2', '-c:v', 'png', 'pipe:1');
  else args.push('-q:v', String(quality), '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1');
  const r = spawnSync(FFMPEG, args, {input: data, maxBuffer: 1 << 28});
  if (r.status !== 0) throw new Error('encode failed: ' + String(r.stderr).slice(0, 300));
  return r.stdout;
}

// RGBA PNG (for cut-outs with transparency).
export function encodeRGBA({width, height, data}) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'pipe:0',
    '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1'], {input: data, maxBuffer: 1 << 28});
  if (r.status !== 0) throw new Error('encode failed: ' + String(r.stderr).slice(0, 300));
  return r.stdout;
}

// Any image bytes → RGB24 at a given size (used to align a Muse Image restyle with the footage).
export function decodeImage(bytes, width, height) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', 'pipe:0', '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    {input: bytes, maxBuffer: 1 << 28});
  if (r.status !== 0) throw new Error('decode failed: ' + String(r.stderr).slice(0, 300));
  return {width, height, data: r.stdout};
}

export const dataUrl = (bytes, type = 'image/jpeg') => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

// Encode RGB frames to an H.264 MP4 (verification clips, fork renders).
export function writeVideo(file, {width, height, fps}, frames) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', String(fps),
      '-i', 'pipe:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', '-movflags', '+faststart', file]);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => code === 0 ? resolve(file) : reject(new Error('ffmpeg: ' + err.slice(0, 300))));
    (async () => {
      for await (const f of frames) if (!p.stdin.write(f)) await new Promise(r => p.stdin.once('drain', r));
      p.stdin.end();
    })().catch(reject);
  });
}
