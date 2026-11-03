import {Stage} from './stage.js';
import {Notebook} from './notebook.js';
import {drawPlot} from './plot.js';
import {Voice} from './voice.js';
import {parseVideoStream, recordsOfKind, frameIndexOf, decodeMaskToRaster} from '/vendor/sam-parser/index.js';

const $ = id => document.getElementById(id);
const state = {clips: [], clip: null, info: null, run: null, fit: null, axis: 'y'};

const stage = new Stage({video: $('video'), canvas: $('overlay'), badge: $('stageBadge'), onFrame: f => {
  $('scrub').value = Math.min(f, Number($('scrub').max));
  $('clock').textContent = (f / (state.info?.fps || 30)).toFixed(2) + ' s';
  if (state.fit) plot(f);
}});
const nb = new Notebook({list: $('steps'), report: $('report'), state: $('nbState')});

// ---- clips -----------------------------------------------------------------------------------------------------
async function loadClips() {
  state.clips = await (await fetch('/api/clips')).json();
  const box = $('clips');
  box.innerHTML = '';
  for (const c of state.clips) {
    const b = document.createElement('button');
    b.className = 'clip'; b.dataset.id = c.id;
    b.innerHTML = `<div class="thumb">${c.poster ? `<img src="${c.poster}" alt="" style="width:100%;height:100%;object-fit:cover">` : `<video src="${c.url}#t=0.2" muted preload="metadata"></video>`}</div>
      <div class="meta"><div class="title"></div><div class="kind">${c.analysed ? '<i class="dot" title="analysed"></i>' : ''}<span></span></div></div>`;
    b.querySelector('.title').textContent = c.title;
    b.querySelector('.kind span').textContent = c.motion || (c.synthetic ? 'test scene' : '');
    b.onclick = () => select(c);
    box.append(b);
  }
  const up = document.createElement('button');
  up.className = 'clip upload'; up.innerHTML = '<span><b>+</b>Upload a clip</span>';
  up.onclick = () => $('file').click();
  box.append(up);
}

async function select(c) {
  // A replay still streaming for the previous clip would otherwise land its notebook, overlays and forks on this one.
  state.es?.close(); state.es = null; $('run').disabled = false;
  state.clip = c; state.run = null; state.fit = null; state.fork = null; $('saveClip').hidden = true;
  document.querySelectorAll('.clip').forEach(b => b.classList.toggle('active', b.dataset.id === c.id));
  $('stageEmpty').hidden = true; $('forkbar').hidden = true; $('plotWrap').hidden = true; $('stageBadge').hidden = true;
  $('credit').textContent = c.credit || '';
  $('question').value = c.question || '';
  nb.clear(c.analysed ? 'analysed before: “Run the lab” replays it' : '');
  const run = await (await fetch(`/api/run?clip=${encodeURIComponent(c.id)}`)).json();
  if (state.clip !== c) return;
  state.info = run.info || await probeInBrowser(c.url);
  stage.load(c.url, state.info);
  $('scrub').max = state.info.frames - 1; $('scrub').value = 0;
  if (run.report && c.question == null) $('question').value = run.question || '';
}

function probeInBrowser(url) {
  // Before a clip is analysed we only know what the browser can tell; the server measures exact timing on analysis.
  return new Promise(resolve => {
    const v = document.createElement('video'); v.preload = 'metadata'; v.src = url;
    v.onloadedmetadata = () => resolve({width: v.videoWidth, height: v.videoHeight, fps: 30, frames: Math.round(v.duration * 30), duration: v.duration});
  });
}

// ---- running the lab -------------------------------------------------------------------------------------------
function run(live = false) {
  if (!state.clip) return;
  nb.clear('running…');
  $('run').disabled = true;
  stage.setFork(null);
  state.es?.close();
  const clip = state.clip, es = state.es = new EventSource(`/api/analyze?clip=${encodeURIComponent(state.clip.id)}&q=${encodeURIComponent($('question').value)}${live ? '&live=1' : ''}`);
  es.onmessage = async m => {
    if (state.es !== es) return;
    const ev = JSON.parse(m.data);
    nb.event(ev);
    if (ev.type === 'tracks') showTracks(ev);
    if (ev.type === 'done' || ev.type === 'error') {
      es.close(); $('run').disabled = false;
      if (ev.type === 'done') { await loadAnalysis(clip); markAnalysed(clip); }
    }
  };
  es.onerror = () => { es.close(); $('run').disabled = false; };
}

function showTracks(ev) {
  // Draw what SAM found as soon as it arrives: the longest-moving object's centres.
  const best = ev.objects.map(o => ({o, span: o.points.length})).sort((a, b) => b.span - a.span)[0];
  if (best) stage.setAnalysis({track: best.o.points});
}

function markAnalysed(clip) {
  const c = state.clips.find(x => x.id === clip.id); if (c) c.analysed = true;
  const b = document.querySelector(`.clip[data-id="${CSS.escape(clip.id)}"] .kind`);
  if (b && !b.querySelector('.dot')) b.insertAdjacentHTML('afterbegin', '<i class="dot"></i>');
}

async function loadAnalysis(clip) {
  const id = encodeURIComponent(clip.id), stale = () => state.clip !== clip;
  const runData = await (await fetch(`/api/run?clip=${id}`)).json();
  if (!runData.report || stale()) return;
  state.run = runData; state.info = runData.info;
  const rep = runData.report;
  const obj = rep.object in (rep.tracks || {}) ? rep.object : Object.keys(rep.tracks || {})[0];
  const fit = await post(`/api/fork?clip=${id}`, {overrides: {}});
  if (stale()) return;
  // The dots are the points the fit actually followed (centroid, or an edge for a partly hidden object).
  const measured = rep.fit?.measured || rep.tracks[obj];
  state.fit = {track: measured, fitPath: fit.real, ppm: rep.fit?.ppm, origin: rep.fit?.origin_px, start: rep.fit?.frames?.[0] || 0};
  state.axis = rep.fit?.model === 'pendulum' || rep.fit?.model === 'oscillator' && spread(state.fit.track, 1) > spread(state.fit.track, 2) ? 'x' : 'y';
  if (rep.fit?.model === 'pendulum') state.axis = 'x';
  stage.setAnalysis({track: state.fit.track, fitPath: fit.real, fps: state.info.fps, frames: state.info.frames, point: rep.fit?.point || 'centroid', ppm: rep.fit?.ppm});
  $('plotWrap').hidden = false; plot(stage.frame);
  // Compositing assets, fetched in the background: masks, the clean plate, the object's cut-out.
  const [masks, plate, sprite, spriteMeta] = await Promise.all([
    fetch(`/api/masks?clip=${id}&object=${encodeURIComponent(obj)}`).then(r => r.ok ? r.json() : null).then(m => m && decodeMasks(m.text, obj.split(':').pop())),
    image(`/api/plate?clip=${id}`), image(`/api/sprite?clip=${id}&object=${encodeURIComponent(obj)}`).catch(() => null),
    fetch(`/api/sprite?clip=${id}&object=${encodeURIComponent(obj)}&meta=1`).then(r => r.ok ? r.json() : null),
  ]);
  // The plate is built by the request above, so its steadiness score exists now.
  const plateMeta = await fetch(`/api/plate?clip=${id}&meta=1`).then(r => r.ok ? r.json() : {steady: true}).catch(() => ({steady: true}));
  if (stale()) return;
  stage.setAnalysis({masks, plate, sprite, spriteMeta, plateSteady: plateMeta.steady !== false});
  renderForks(rep);
}

const spread = (pts, k) => Math.max(...pts.map(p => p[k])) - Math.min(...pts.map(p => p[k]));

async function decodeMasks(text, id) {
  async function* ev() {
    const lane = {item_id: 'sam', output_index: 0, content_index: 0};
    yield {type: 'response.output_text.delta', delta: text, ...lane};
    yield {type: 'response.output_text.done', text, ...lane};
    yield {type: 'response.completed'};
  }
  const res = await parseVideoStream(ev()).finalResult, map = new Map();
  for (const r of recordsOfKind(res.records, 'mask')) if (r.objectId === id)
    map.set(frameIndexOf(r), {...r.bounds, w: r.mask.width, h: r.mask.height, raster: decodeMaskToRaster(r.mask)});
  return map;
}

function image(src) {
  return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = src; });
}
async function post(url, body) {
  const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  return r.json();
}

function plot(frame) {
  if (!state.fit?.ppm) return;
  drawPlot($('plot'), {...state.fit, forkPath: stage.forking ? stage.data.forkPath : null, fps: state.info.fps, axis: state.axis, now: frame});
  const cap = $('plotCaption');
  cap.innerHTML = `<span class="key m">measured by SAM 3.1</span><span class="key f">fitted law</span>${stage.forking ? '<span class="key k">fork</span>' : ''}`;
}

// ---- forks -----------------------------------------------------------------------------------------------------
const PRESETS = [
  {label: 'Moon', g: 1.62, why: 'g = 1.62 m/s²'}, {label: 'Mars', g: 3.71, why: 'g = 3.71 m/s²'},
  {label: 'Jupiter', g: 24.79, why: 'g = 24.8 m/s²'}, {label: 'No air', drag: 'none', why: 'drag removed'},
  {label: 'Super bouncy', e: 0.95, why: 'restitution 0.95', models: ['bounce']},
];

function renderForks(rep) {
  const box = $('forks'); box.innerHTML = '';
  const model = rep.fit?.model;
  const fromAgent = (rep.forks || []).map(f => ({label: f.label, g: f.g > 0 ? f.g : undefined, drag: f.drag === 'none' ? 'none' : undefined, e: f.e >= 0 ? f.e : undefined, why: f.why, agent: true}));
  // A preset is left out when the agent already offers it, by name or by the same change under its own name
  // ("same throw on Moon" is the Moon preset; "vacuum flight" is No air).
  const seen = new Set(fromAgent.map(f => f.label.toLowerCase()));
  // Removing air from a law with no drag term changes nothing (lib/forkview.mjs drops it), so it does not count.
  const hasDrag = rep.fit?.p?.b != null || rep.fit?.p?.gamma != null;
  const near = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.01);
  const sameAs = p => fromAgent.some(f => near(f.g, p.g) && (hasDrag ? f.drag === p.drag : !p.drag) && near(f.e, p.e));
  const list = [...fromAgent, ...PRESETS.filter(p => !seen.has(p.label.toLowerCase()) && !sameAs(p) && (!p.models || p.models.includes(model)) && !(p.drag && model !== 'projectile-drag'))];
  const real = document.createElement('button');
  real.className = 'fork real active'; real.innerHTML = 'Reality<small>as filmed</small>';
  real.onclick = () => { activate(real); stage.setFork(null); state.fork = null; $('saveClip').hidden = true; $('forkSummary').textContent = ''; $('stageBadge').hidden = true; plot(stage.frame); };
  box.append(real);
  for (const f of list.slice(0, 7)) {
    const b = document.createElement('button');
    b.className = 'fork';
    b.innerHTML = `${f.label}<small>${f.why ? f.why.slice(0, 44) : ''}</small>`;
    b.title = f.why || '';
    b.onclick = () => fork(f, b);
    box.append(b);
  }
  $('forkbar').hidden = false;
}

function activate(b) { document.querySelectorAll('.fork').forEach(x => x.classList.toggle('active', x === b)); }

async function fork(f, button) {
  activate(button);
  const overrides = {}; if (f.g) overrides.g = f.g; if (f.drag) overrides.drag = f.drag; if (f.e != null) overrides.e = f.e;
  const clip = state.clip, id = encodeURIComponent(clip.id);
  const res = await post(`/api/fork?clip=${id}`, {overrides});
  if (state.clip !== clip) return;
  if (res.error) { $('forkSummary').textContent = res.error; return; }
  $('forkSummary').textContent = res.summary || '';
  let world = null;
  // Picked by gravity, so the agent's own forks ("same throw on the Moon") get the world too. Only over a steady plate:
  // the repaint replaces the footage, which for a launch would take the plume away with it.
  const name = [['moon', 1.62], ['mars', 3.71], ['jupiter', 24.79]].find(([, g]) => Math.abs((f.g || 0) - g) < 0.01)?.[0];
  if ($('restyle').checked && name && stage.data.plateSteady !== false) {
    $('forkSummary').textContent = 'Muse Image is repainting the scene…';
    const r = await post(`/api/restyle?clip=${id}`, {world: name});
    if (r.url) world = await image(r.url);
    if (state.clip !== clip) return;
    $('forkSummary').textContent = res.summary || '';
  }
  stage.setAnalysis({world});
  state.fork = {label: f.label, res};
  playFork();
  $('saveClip').hidden = false;
  plot(stage.frame);
}

const playFork = () => {
  const {label, res} = state.fork;
  stage.setFork(res.path, {label, start: res.path[0][0], end: res.end_frame, baseline: res.baseline, floor: res.floor_px});
};

// Save the fork as a video: record the stage canvas while the fork replays from the start, with the label and the
// summary burned in. MP4 where the browser can encode it (Chrome, Safari), else WebM. Nothing goes to the server.
$('saveClip').onclick = async () => {
  if (!state.fork) return;
  const btn = $('saveClip'), canvas = $('overlay');
  const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => window.MediaRecorder?.isTypeSupported(t));
  if (!type) return alert('This browser cannot record video.');
  const rec = new MediaRecorder(canvas.captureStream(Math.round(state.info.fps)), {mimeType: type, videoBitsPerSecond: 8e6});
  const chunks = [], stopped = new Promise(r => { rec.onstop = r; });
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  btn.disabled = true; btn.textContent = 'Recording…';
  stage.caption = {foot: state.fork.res.summary};
  playFork();
  rec.start(250);
  const limit = Date.now() + 1000 * ((stage.forkEnd - state.fork.res.path[0][0]) / state.info.fps + 6);
  while (Date.now() < limit && !(stage.frame >= stage.forkEnd && !stage.freeRun)) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 800));
  rec.stop(); await stopped;
  stage.caption = null; stage.redraw();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(chunks, {type}));
  a.download = `reality-fork-${(state.clip.title || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${state.fork.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
  a.click();
  btn.disabled = false; btn.textContent = 'Save this fork as a clip';
};

// ---- transport, upload, voice ----------------------------------------------------------------------------------
$('play').onclick = () => {
  const v = $('video');
  if (stage.forking && stage.frame >= stage.forkEnd - 1) return stage.seek(Math.max(0, stage.data.forkPath[0][0] - 12), true);
  if (v.paused) v.play(); else v.pause();
};
$('video').addEventListener('play', () => { $('play').textContent = '❚❚'; });
$('video').addEventListener('pause', () => { $('play').textContent = '▶'; });
$('scrub').oninput = e => { $('video').pause(); stage.seek(Number(e.target.value)); };
for (const [id, key] of [['showMask', 'mask'], ['showPath', 'path'], ['showLaw', 'law']]) $(id).onchange = e => { stage.show[key] = e.target.checked; stage.redraw(); };
$('ask').onsubmit = e => { e.preventDefault(); run(e.submitter?.dataset.live === '1' || e.shiftKey); };
$('run').addEventListener('click', e => { if (e.shiftKey || e.altKey) { e.preventDefault(); run(true); } });

$('file').onchange = async e => {
  const f = e.target.files[0]; if (f) await upload(f);
  e.target.value = '';
};
const stageEl = $('stage');
stageEl.addEventListener('dragover', e => { e.preventDefault(); stageEl.classList.add('drag'); });
stageEl.addEventListener('dragleave', () => stageEl.classList.remove('drag'));
stageEl.addEventListener('drop', async e => { e.preventDefault(); stageEl.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) await upload(f); });

async function upload(file) {
  if (file.size > 80 << 20) return alert('Please use a clip under 80 MB (a few seconds is plenty).');
  nb.clear('uploading…');
  const r = await fetch('/api/upload', {method: 'POST', body: file});
  const j = await r.json();
  if (j.error) return nb.event({type: 'error', message: j.error});
  const c = {id: j.id, url: j.url, title: file.name.replace(/\.[^.]+$/, ''), motion: 'your clip'};
  state.clips.push(c);
  await select(c);
  state.info = j.info; stage.load(c.url, j.info); $('scrub').max = j.info.frames - 1;
  nb.clear('ready: ask a question, then Run the lab');
}

const voice = new Voice();
let recording = false;
$('mic').onclick = async () => {
  if (!recording) {
    try { await voice.start(); } catch { return alert('Microphone not available.'); }
    recording = true; $('mic').classList.add('rec'); $('mic').textContent = '■';
    return;
  }
  recording = false; $('mic').classList.remove('rec'); $('mic').textContent = '🎙';
  const wav = await voice.stop();
  $('question').value = 'Transcribing…';
  const r = await fetch('/api/transcribe', {method: 'POST', body: wav});
  const j = await r.json();
  $('question').value = j.text || '';
  if (j.text && state.clip) run();
};

addEventListener('resize', () => state.fit && plot(stage.frame));
loadClips();
