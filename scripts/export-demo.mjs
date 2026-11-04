// Copy what the deployed app needs to replay the samples for free into demo/ (tracked in git): each sample's latest
// run, the SAM results its object was tracked with, and any Muse Image repaints. The server seeds an empty cache from it.
//   node scripts/export-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import {samples, latestRun, ROOT, RUNS, ASSETS} from '../lib/store.mjs';
import {CACHE_DIR, hashOf} from '../lib/meta.mjs';

const OUT = path.join(ROOT, 'demo');
for (const d of ['runs', 'sam', 'assets']) fs.rmSync(path.join(OUT, d), {recursive: true, force: true});
for (const d of ['runs', 'sam', 'assets']) fs.mkdirSync(path.join(OUT, d), {recursive: true});

const index = JSON.parse(fs.readFileSync(path.join(RUNS, 'index.json'), 'utf8')), kept = {};
let bytes = 0;
const copy = (from, to) => { fs.copyFileSync(from, to); bytes += fs.statSync(to).size; };
for (const clip of samples()) {
  const run = latestRun(clip.id);
  if (!run) { console.log('no run:', clip.id); continue; }
  kept[clip.id] = index[clip.id];
  copy(path.join(RUNS, index[clip.id]), path.join(OUT, 'runs', index[clip.id]));
  // The SAM key is the one lib/meta.mjs uses: model, kind, media hash, prompt, request metadata.
  const mediaHash = hashOf(fs.readFileSync(clip.file));
  for (const prompt of new Set(Object.values(run.prompts || {}))) {
    const key = hashOf('sam-3.1', 'video', mediaHash, prompt, {include_confidence: 'true'});
    const file = path.join(CACHE_DIR, 'sam', key + '.json');
    if (fs.existsSync(file)) copy(file, path.join(OUT, 'sam', key + '.json'));
    else console.log('missing SAM result:', clip.id, prompt);
  }
  // The clean plate and the object's cut-out, built once here: a small free host (one tenth of a CPU, no lasting disk)
  // would otherwise rebuild them with ffmpeg on every cold start, and the first visitor would wait.
  const obj = run.report?.object, prompt = run.prompts?.[obj];
  for (const name of [hashOf(clip.id, 'plate', prompt || '', obj || ''), hashOf(clip.id, prompt || obj, 'sprite')])
    for (const ext of ['.jpg', '.png', '.json']) if (fs.existsSync(path.join(ASSETS, name + ext))) copy(path.join(ASSETS, name + ext), path.join(OUT, 'assets', name + ext));
  for (const world of ['moon', 'mars', 'jupiter']) {
    const name = hashOf(clip.id, world, 'restyle') + '.jpg';
    if (fs.existsSync(path.join(ASSETS, name))) copy(path.join(ASSETS, name), path.join(OUT, 'assets', name));
  }
}
fs.writeFileSync(path.join(OUT, 'runs', 'index.json'), JSON.stringify(kept, null, 1));
console.log(`demo/: ${Object.keys(kept).length} runs, ${(bytes / 1e6).toFixed(1)} MB`);
