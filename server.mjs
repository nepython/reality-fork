// Reality Fork web server: serves the app, the sample clips, and the API that runs the lab agent.
// Paid calls (Meta Model API) happen only in /api/analyze (live runs), /api/restyle and /api/transcribe; finished runs
// are cached on disk and replayed, so browsing the samples costs nothing.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {medianPlate, readFrames, encodeImage, encodeRGBA, decodeImage, dataUrl} from './lib/video.mjs';
import {ROOT, ASSETS, UPLOADS, samples, clipById, clipInfo, runFile, latestRun, runLab, saveUpload} from './lib/store.mjs';
import {spent, editImage, transcribe, samCachedOnly, hashOf} from './lib/meta.mjs';
import {parseSam, tracksFrom} from './lib/sam.mjs';
import {forkPixels} from './lib/forkview.mjs';
import {chooseSpriteFrame} from './lib/spritepick.mjs';

const PORT = Number(process.env.PORT || 8790);

// ---- rate limiting for live (paid) runs ------------------------------------------------------------------------
const LIVE_PER_HOUR = Number(process.env.RF_LIVE_PER_HOUR || 6);
const hits = new Map();
// Separate allowances per kind: a spoken question (a fraction of a cent) must not use up a visitor's live analyses.
// Live (paid) calls are open until RF_LIVE_UNTIL (an ISO date; unset = always): the hackathon's judging ends then, and
// afterwards the samples still replay their saved runs for free.
const LIVE_UNTIL = Date.parse(process.env.RF_LIVE_UNTIL || '');
const liveOpen = () => !Number.isFinite(LIVE_UNTIL) || Date.now() < LIVE_UNTIL;
const LIVE_CLOSED = 'Live analysis was open during the hackathon judging and has now ended; the sample clips still replay their saved runs.';

// Per visitor, and for everyone together: on a host that restarts with an empty disk the spending ledger starts again
// from zero, so an hourly ceiling across all visitors bounds what a restarted instance can spend.
const GLOBAL_PER_HOUR = {live: Number(process.env.RF_LIVE_GLOBAL_PER_HOUR || 20), restyle: 30, voice: 120};
function allowLive(req, kind = 'live', perHour = LIVE_PER_HOUR) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress, key = kind + ' ' + ip, all = kind + ' *';
  const now = Date.now(), recent = k => (hits.get(k) || []).filter(t => now - t < 3600e3), mine = recent(key), every = recent(all);
  if (mine.length >= perHour || every.length >= (GLOBAL_PER_HOUR[kind] ?? Infinity)) return false;
  mine.push(now); every.push(now); hits.set(key, mine); hits.set(all, every);
  return true;
}

// ---- helpers ---------------------------------------------------------------------------------------------------
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.md': 'text/markdown; charset=utf-8'};

function sendFile(req, res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, {error: 'not found'});
  const size = fs.statSync(file).size, type = TYPES[path.extname(file)] || 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  // Video seeking needs byte ranges (Safari refuses to play without them).
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1});
    return fs.createReadStream(file, {start, end}).pipe(res);
  }
  res.writeHead(200, {'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=300'});
  fs.createReadStream(file).pipe(res);
}

function send(res, code, body, type = 'application/json') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, {'Content-Type': type, 'Content-Length': data.length});
  res.end(data);
}

function readBody(req, limit = 150 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), {status: 413})); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const safeJoin = (base, rel) => { const p = path.resolve(base, '.' + path.posix.normalize('/' + rel)); return p.startsWith(base) ? p : null; };

// ---- assets for compositing: clean plate, the object's cut-out, its masks -----------------------------------
async function plateFor(clip) {
  // With an analysed run, the object's own SAM masks (grown by a margin for blur and shadow) keep it out of the plate.
  const run = latestRun(clip.id), obj = run?.report?.object, prompt = run?.prompts?.[obj];
  const file = path.join(ASSETS, hashOf(clip.id, 'plate', prompt || '', obj || '') + '.jpg');
  if (!fs.existsSync(file) || !fs.existsSync(file.replace(/\.jpg$/, '.json'))) {
    const masks = prompt ? await masksFor(clip, run, obj) : null;
    const pad = 8;
    const exclude = masks && (frame => {
      const m = masks.get(frame);
      if (!m) return null;
      return (x, y) => x >= m.left - pad && x < m.right + pad && y >= m.top - pad && y < m.bottom + pad &&
        near(m, x - m.left, y - m.top, pad);
    });
    const plate = medianPlate(clip.file, {exclude});
    fs.writeFileSync(file, encodeImage(plate, 'jpeg', {quality: 2}));
    // Measured: test scenes < 1, the ISS (an astronaut moving behind the globe) 5.6, the Artemis launch 48.
    fs.writeFileSync(file.replace(/\.jpg$/, '.json'), JSON.stringify({change: +plate.change.toFixed(2), steady: plate.change < 15}));
  }
  return file;
}

// Is (x, y) (relative to the mask's box) within `pad` pixels of a mask pixel? Sampled on a coarse ring for speed.
function near(m, x, y, pad) {
  for (const [dx, dy] of [[0, 0], [pad, 0], [-pad, 0], [0, pad], [0, -pad], [pad * .7, pad * .7], [-pad * .7, pad * .7], [pad * .7, -pad * .7], [-pad * .7, -pad * .7]]) {
    const u = Math.round(x + dx), v = Math.round(y + dy);
    if (u >= 0 && v >= 0 && u < m.right - m.left && v < m.bottom - m.top && m.at(u, v)) return true;
  }
  return false;
}

// The object's sprite: cut with SAM's mask from a frame where the object is whole and sharp (lib/spritepick.mjs), as an RGBA PNG.
async function spriteFor(clip, run, objectKey) {
  const file = path.join(ASSETS, hashOf(clip.id, run.prompts?.[objectKey] || objectKey, 'sprite2') + '.png');
  const meta = file.replace(/\.png$/, '.json');
  if (fs.existsSync(file) && fs.existsSync(meta)) return {file, meta: JSON.parse(fs.readFileSync(meta, 'utf8'))};
  const masks = await masksFor(clip, run, objectKey);
  if (!masks) return null;
  const pts = run.report.tracks[objectKey];
  const best = chooseSpriteFrame(pts, masks, run.info);
  if (best < 0) return null;
  const frame = pts[best][0], m = masks.get(frame);
  const {width, height, frames} = readFrames(clip.file, {frames: [frame]});
  const w = m.right - m.left, h = m.bottom - m.top, rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(width - 1, m.left + x), sy = Math.min(height - 1, m.top + y), si = (sy * width + sx) * 3, o = (y * w + x) * 4;
    rgba[o] = frames[0].data[si]; rgba[o + 1] = frames[0].data[si + 1]; rgba[o + 2] = frames[0].data[si + 2];
    rgba[o + 3] = m.at(x, y) ? 255 : 0;
  }
  fs.writeFileSync(file, encodeRGBA({width: w, height: h, data: rgba}));
  // Anchor points matching the ones the fit can follow: centroid, top edge, bottom edge (row-profile, as in lib/sam.mjs).
  const rows = Array.from({length: h}, (_, y) => { let n = 0, sx = 0; for (let x = 0; x < w; x++) if (m.at(x, y)) { n++; sx += x; } return [n, sx]; });
  const need = 0.15 * Math.max(...rows.map(r => r[0]));
  let r0 = 0, r1 = h - 1;
  while (r0 < h - 1 && rows[r0][0] < need) r0++;
  while (r1 > 0 && rows[r1][0] < need) r1--;
  const info = {frame, left: m.left, top: m.top, width: w, height: h, cx: pts[best][1], cy: pts[best][2],
    tx: m.left + rows[r0][1] / Math.max(1, rows[r0][0]) + 0.5, ty: m.top + r0, bx: m.left + rows[r1][1] / Math.max(1, rows[r1][0]) + 0.5, by: m.top + r1 + 1};
  fs.writeFileSync(meta, JSON.stringify(info));
  return {file, meta: info};
}

async function masksFor(clip, run, objectKey) {
  const prompt = run.prompts?.[objectKey];
  if (!prompt) return null;
  const buf = fs.readFileSync(clip.file);
  // Served from the SAM cache of the run; never a new paid call.
  const raw = samCachedOnly({mediaHash: hashOf(buf), prompt});
  if (!raw) return null;
  const result = await parseSam(raw);
  const {recordsOfKind, frameIndexOf, decodeMaskToRaster} = await import('@meta-sam/parser');
  const id = objectKey.split(':').pop(), map = new Map();
  for (const rec of recordsOfKind(result.records, 'mask')) if (rec.objectId === id) {
    const r = decodeMaskToRaster(rec.mask), b = rec.bounds, mw = rec.mask.width, mh = rec.mask.height;
    const sx = mw / (b.right - b.left), sy = mh / (b.bottom - b.top);
    map.set(frameIndexOf(rec), {...b, at: (x, y) => r[Math.min(mh - 1, Math.floor(y * sy)) * mw + Math.min(mw - 1, Math.floor(x * sx))]});
  }
  return map;
}

// ---- API -------------------------------------------------------------------------------------------------------
async function api(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  if (url.pathname === '/api/clips') {
    return send(res, 200, samples().map(({file, ...c}) => ({...c, analysed: !!latestRun(c.id)})));
  }
  if (url.pathname === '/api/status') return send(res, 200, {spent_usd: Math.round(spent() * 1000) / 1000, live: liveOpen(),
    live_until: Number.isFinite(LIVE_UNTIL) ? new Date(LIVE_UNTIL).toISOString() : null, ...(!liveOpen() && {notice: LIVE_CLOSED})});

  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, saveUpload(body));
  }

  const clip = q.clip && clipById(q.clip);
  if (q.clip && !clip) return send(res, 404, {error: 'unknown clip'});

  if (url.pathname === '/api/run') return send(res, 200, latestRun(clip.id) || {});

  if (url.pathname === '/api/analyze') {
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'});
    const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    // An empty box on a sample means "ask the clip's own question" (the page shows that question in the chat), so it
    // replays the saved run instead of starting a live one.
    if (!(q.q || '').trim() && clip.question) q.q = clip.question;
    const file = runFile(clip.id, q.q), norm = s => (s || '').trim().toLowerCase();
    // A sample's own question (the one the page fills in) replays its saved run under whatever wording that run was made
    // with. The street car was analysed from the CLI with no question, so without this every visitor's first "Run the
    // lab" on it would have been a paid live run (4 Nov 2026).
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : clip.question && norm(q.q) === norm(clip.question) ? latestRun(clip.id) : null;
    if (saved && q.live !== '1') {
      // Replay a finished run quickly: the browser's director (public/js/director.js) decides how long each step stays up.
      const run = saved;
      for (const ev of run.events) { emit(ev); await new Promise(r => setTimeout(r, ev.type === 'sam' ? 4 : 60)); }
      emit({type: 'done', replay: true});
      return res.end();
    }
    if (!liveOpen()) { emit({type: 'error', message: LIVE_CLOSED}); return res.end(); }
    if (!allowLive(req)) { emit({type: 'error', message: 'Live analysis limit reached for now; try a sample, or come back in an hour.'}); return res.end(); }
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    try {
      await runLab(clip, q.q, emit);
      emit({type: 'done'});
    } catch (e) {
      emit({type: 'error', message: String(e.message || e).slice(0, 400)});
    } finally { clearInterval(ping); res.end(); }
    return;
  }

  if (url.pathname === '/api/plate') {
    const file = await plateFor(clip), meta = file.replace(/\.jpg$/, '.json');
    if (q.meta) return send(res, 200, fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')) : {steady: true});
    return sendFile(req, res, file);
  }

  if (url.pathname === '/api/sprite') {
    const run = latestRun(clip.id);
    if (!run) return send(res, 404, {error: 'analyse first'});
    const s = await spriteFor(clip, run, q.object || run.report.object);
    if (!s) return send(res, 404, {error: 'no mask for that object'});
    if (q.meta) return send(res, 200, s.meta);
    return sendFile(req, res, s.file);
  }

  if (url.pathname === '/api/masks') {
    // The raw SAM text of the run's object, for the browser to decode with @meta-sam/parser (from cache only).
    // A live run is not saved until it ends, so the browser can name the prompt itself (from the `tracks` event).
    const run = q.prompt ? null : latestRun(clip.id);
    const prompt = q.prompt || run?.prompts?.[q.object || run?.report?.object];
    if (!prompt) return send(res, 404, {error: 'no masks'});
    const raw = samCachedOnly({mediaHash: hashOf(fs.readFileSync(clip.file)), prompt});
    return raw ? send(res, 200, {prompt, text: raw.text}) : send(res, 404, {error: 'not cached'});
  }

  if (url.pathname === '/api/fork' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1 << 16)).toString() || '{}');
    const run = latestRun(clip.id);
    if (!run) return send(res, 404, {error: 'analyse first'});
    const sprite = await spriteFor(clip, run, run.report.object).catch(() => null);
    return send(res, 200, forkPixels(run, body.overrides || {}, {fps: clipInfo(clip).fps, frames: clipInfo(clip).frames, sprite: sprite?.meta}));
  }

  if (url.pathname === '/api/restyle' && req.method === 'POST') {
    // Muse Image repaints the clean plate as another world; it is scaled back onto the footage's exact frame.
    const body = JSON.parse((await readBody(req, 1 << 16)).toString() || '{}');
    const worlds = {
      moon: 'Repaint this exact scene as if it were on the surface of the Moon: grey lunar regolith ground, black starry sky where the walls or sky are, harsh sunlight. Keep the camera angle, the layout, the horizon line and every object\'s position exactly the same.',
      mars: 'Repaint this exact scene as if it were on Mars: rusty red dust ground, butterscotch sky, scattered rocks. Keep the camera angle, the layout, the horizon line and every object\'s position exactly the same.',
      jupiter: 'Repaint this exact scene as if it were on a floating platform in Jupiter\'s upper clouds: swirling cream and orange cloud bands, a heavy hazy sky. Keep the camera angle, the layout and every object\'s position exactly the same.',
    };
    if (!worlds[body.world]) return send(res, 400, {error: 'unknown world'});
    const plate = fs.readFileSync(await plateFor(clip)), info = clipInfo(clip);
    const out = path.join(ASSETS, hashOf(clip.id, body.world, 'restyle') + '.jpg');
    if (!fs.existsSync(out)) {
      // Only a new picture is paid for, so only that counts against the hourly limit.
      if (!liveOpen()) return send(res, 403, {error: LIVE_CLOSED});
      if (!allowLive(req, 'restyle', 10)) return send(res, 429, {error: 'limit reached'});
      const img = await editImage({imageDataUrl: dataUrl(plate), prompt: worlds[body.world], size: `${info.width}x${info.height}`});
      fs.writeFileSync(out, encodeImage(decodeImage(Buffer.from(img.b64, 'base64'), info.width, info.height), 'jpeg', {quality: 2}));
    }
    return send(res, 200, {url: '/assets/' + path.basename(out)});
  }

  if (url.pathname === '/api/transcribe' && req.method === 'POST') {
    if (!liveOpen()) return send(res, 403, {error: LIVE_CLOSED});
    if (!allowLive(req, 'voice', 30)) return send(res, 429, {error: 'limit reached'});
    const wav = await readBody(req, 8 << 20);
    return send(res, 200, {text: await transcribe(wav, {keywords: ['gravity', 'pendulum', 'Moon', 'Mars', 'bounce', 'drag']})});
  }
  return send(res, 404, {error: 'unknown endpoint'});
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/vendor/sam-parser/')) return sendFile(req, res, safeJoin(path.join(ROOT, 'node_modules/@meta-sam/parser/dist'), url.pathname.slice(19)));
    if (url.pathname.startsWith('/clips/')) return sendFile(req, res, safeJoin(path.join(ROOT, 'clips'), url.pathname.slice(7)));
    if (url.pathname.startsWith('/bench/synthetic/')) return sendFile(req, res, safeJoin(path.join(ROOT, 'bench/synthetic'), url.pathname.slice(17)));
    if (url.pathname.startsWith('/uploads/')) return sendFile(req, res, safeJoin(UPLOADS, url.pathname.slice(9)));
    if (url.pathname.startsWith('/assets/')) return sendFile(req, res, safeJoin(ASSETS, url.pathname.slice(8)));
    return sendFile(req, res, safeJoin(path.join(ROOT, 'public'), url.pathname === '/' ? 'index.html' : url.pathname.slice(1)));
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, {error: String(e.message || e).slice(0, 300)});
    else res.end();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(PORT, () => console.log(`Reality Fork on http://localhost:${PORT}`));
export {server, spriteFor};
