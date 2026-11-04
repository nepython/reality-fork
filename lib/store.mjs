// Clips (samples, synthetic test scenes, uploads) and finished lab runs, shared by the server and the benchmark.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CACHE_DIR, hashOf} from './meta.mjs';
import crypto from 'node:crypto';
import {probe, normalise} from './video.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS = path.join(CACHE_DIR, 'runs');
export const UPLOADS = path.join(CACHE_DIR, 'uploads');
export const ASSETS = path.join(CACHE_DIR, 'assets');
for (const d of [RUNS, UPLOADS, ASSETS]) fs.mkdirSync(d, {recursive: true});

// A fresh deployment starts from demo/ (scripts/export-demo.mjs): the samples' runs and SAM results, so replaying them
// costs nothing. Files already in the cache win; the run index gains only the clips it lacks.
const SEED = path.join(ROOT, 'demo');
if (fs.existsSync(SEED)) {
  for (const d of ['runs', 'sam', 'assets']) {
    const from = path.join(SEED, d), to = path.join(CACHE_DIR, d);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(to, {recursive: true});
    for (const f of fs.readdirSync(from)) if (f !== 'index.json' && !fs.existsSync(path.join(to, f))) fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
  const seedIndex = path.join(SEED, 'runs', 'index.json'), index = path.join(RUNS, 'index.json');
  if (fs.existsSync(seedIndex)) {
    const have = fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf8')) : {};
    fs.writeFileSync(index, JSON.stringify({...JSON.parse(fs.readFileSync(seedIndex, 'utf8')), ...have}, null, 1));
  }
}

export function samples() {
  const list = [];
  const man = path.join(ROOT, 'clips', 'manifest.json');
  if (fs.existsSync(man)) for (const c of JSON.parse(fs.readFileSync(man, 'utf8'))) {
    list.push({id: 'sample:' + c.id, title: c.title, file: path.join(ROOT, 'clips', c.file), poster: c.poster && '/clips/' + c.poster,
      url: '/clips/' + c.file, credit: c.attribution, motion: c.motion, question: c.question, chatTitle: c.chat_title, expected: c.expected});
  }
  const syn = path.join(ROOT, 'bench', 'synthetic');
  if (fs.existsSync(syn)) for (const f of fs.readdirSync(syn).filter(f => f.endsWith('.mp4')).sort()) {
    const id = f.replace(/\.mp4$/, ''), truthFile = path.join(syn, id + '.truth.json');
    const truth = fs.existsSync(truthFile) ? JSON.parse(fs.readFileSync(truthFile, 'utf8')) : null;
    list.push({id: 'synthetic:' + id, title: 'Test scene: ' + id, file: path.join(syn, f), url: '/bench/synthetic/' + f, synthetic: true, motion: 'test scene', truth});
  }
  return list;
}

// Store a video as an upload (normalised H.264 MP4, named by the hash of its bytes). Shared by /api/upload and the MCP tools.
export function saveUpload(body) {
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 24);
  const tmp = path.join(UPLOADS, hash + '.src'), out = path.join(UPLOADS, hash + '.mp4');
  if (!fs.existsSync(out)) {
    fs.writeFileSync(tmp, body);
    try { normalise(tmp, out); } finally { fs.rmSync(tmp, {force: true}); }
  }
  return {id: 'upload:' + hash, url: '/uploads/' + hash + '.mp4', info: probe(out)};
}

export function clipById(id) {
  if (id?.startsWith('upload:')) {
    const file = path.join(UPLOADS, id.slice(7).replace(/[^a-f0-9]/g, '') + '.mp4');
    return fs.existsSync(file) ? {id, file, url: '/uploads/' + path.basename(file), title: 'Your clip'} : null;
  }
  return samples().find(c => c.id === id) || null;
}

const infoCache = new Map();
export function clipInfo(clip) {
  if (!infoCache.has(clip.file)) infoCache.set(clip.file, probe(clip.file));
  return infoCache.get(clip.file);
}

export const runFile = (clipId, question) => path.join(RUNS, hashOf(clipId, (question || '').trim().toLowerCase()) + '.json');

const INDEX = path.join(RUNS, 'index.json');
const readIndex = () => fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : {};

export function latestRun(clipId) {
  const file = readIndex()[clipId];
  return file && fs.existsSync(path.join(RUNS, file)) ? JSON.parse(fs.readFileSync(path.join(RUNS, file), 'utf8')) : null;
}

export function saveRun(run) {
  const file = runFile(run.clip, run.question);
  fs.writeFileSync(file, JSON.stringify(run));
  const map = readIndex();
  map[run.clip] = path.basename(file);
  fs.writeFileSync(INDEX, JSON.stringify(map, null, 1));
  return file;
}

// Run a lab on a clip and save it; `emit` sees every event (the server streams them, the benchmark logs them).
export async function runLab(clip, question, emit = () => {}) {
  const {Lab} = await import('./agent.mjs');
  const events = [], prompts = {}, started = Date.now();
  const lab = new Lab({file: clip.file, info: clipInfo(clip), question, emit: ev => {
    if (ev.type === 'tracks') for (const o of ev.objects) prompts[o.key] = ev.prompt;
    if (ev.type !== 'sam' || ev.frames % 10 === 0) events.push(ev);
    emit(ev);
  }});
  const report = await lab.run();
  const run = {clip: clip.id, question: question || '', at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 100) / 10,
    info: clipInfo(clip), report, prompts, events};
  saveRun(run);
  return run;
}
