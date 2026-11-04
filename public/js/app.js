import {Stage} from './stage.js';
import {Notebook, STEPS} from './notebook.js';
import {refreshTip} from './tips.js';
import {drawPlot} from './plot.js';
import {Voice} from './voice.js';
import {Director} from './director.js';
import {decodeMasks} from './masks.js';
import {vehicleOf, kmhText, roadY} from './vehicle.js';
import {whatIf, shortTitle} from './whatif.js';

const $ = id => document.getElementById(id);
const state = {vehicle: null, hazardPx: null, clips: [], clip: null, info: null, run: null, fit: null, axis: 'y'};

const stage = new Stage({video: $('video'), canvas: $('overlay'), badge: $('stageBadge'), onFrame: f => {
  $('scrub').value = Math.min(f, Number($('scrub').max));
  $('clock').textContent = (f / (state.info?.fps || 30)).toFixed(2) + ' s';
  if (state.fit) plot(f);
}});
const nb = new Notebook({list: $('steps'), state: $('nbState')});
// The chat's title is the question being asked, cut with an ellipsis; its tooltip holds the whole question and, after it,
// what the lab is doing ("replayed from a saved run"), which used to sit in the header. state.qTitle also heads the fork menu.
function setChatQ(title, full = title) {
  state.qTitle = title; state.question = full;
  const el = $('chatQ'); el.textContent = title || 'Pick a clip to begin'; el.classList.toggle('muted', !title);
  refreshChatTip();
}
function refreshChatTip() {
  const el = $('chatQ'), st = $('nbState').textContent;
  el.dataset.tip = [state.question, st && `(${st})`].filter(Boolean).join(' ');
  if (!el.dataset.tip) delete el.dataset.tip;
}
new MutationObserver(refreshChatTip).observe($('nbState'), {childList: true, characterData: true, subtree: true});
// A sample's question is its own title when short, else the manifest's chat_title; anything else is trimmed in code.
const titleOf = (clip, q) => q ? shortTitle(q) : clip.question ? (clip.question.length <= 48 ? clip.question : clip.chatTitle || shortTitle(clip.question)) : clip.title;
nb.clear();
// The director paces a run's events into chat messages and acts on the stage; these are its ways into the app.
const director = new Director({stage, nb, video: $('video'), badge: $('stageBadge'), hooks: {
  info: () => state.info,
  final: finalFit,
  finalize: (clip, report) => loadAnalysis(clip, report),
  reveal: instant => { state.reveal = true; if (state.forksReady) showForkBtn(); },
  busy: on => { $('skip').hidden = !on; },
  finished: (ev, clip) => { nb.finishAll(); $('run').disabled = false; $('skip').hidden = true; if (ev.type === 'done') markAnalysed(clip); },
}});

// ---- clips -----------------------------------------------------------------------------------------------------
async function loadClips() {
  state.clips = await (await fetch('/api/clips')).json();
  const box = $('clips'), side = $('clipSide');
  box.innerHTML = ''; side.innerHTML = '';
  // Real footage first, then the upload tile; the synthetic test scenes sit behind a toggle so judges meet real clips.
  const tile = c => {
    const b = document.createElement('button');
    b.className = 'clip'; b.dataset.id = c.id; b.dataset.tip = `Use this clip: ${c.title}`;
    b.innerHTML = `<div class="thumb">${c.poster ? `<img src="${c.poster}" alt="" style="width:100%;height:100%;object-fit:cover">` : `<video src="${c.url}#t=0.2" muted preload="metadata"></video>`}</div>
      <div class="meta"><div class="title"></div><div class="kind">${c.analysed ? '<i class="dot"></i>' : ''}<span></span></div></div>`;
    b.querySelector('.title').textContent = c.title;
    b.querySelector('.kind span').textContent = c.motion || (c.synthetic ? 'test scene' : '');
    b.onclick = () => select(c);
    return b;
  };
  for (const c of state.clips.filter(c => !c.synthetic)) box.append(tile(c));
  const up = document.createElement('button');
  up.className = 'clip upload'; up.innerHTML = '<span><b>+</b>Upload a clip</span>'; up.dataset.tip = 'Upload your own video (under 80 MB; a few seconds is plenty)';
  up.onclick = () => $('file').click();
  side.append(up);
  const synth = state.clips.filter(c => c.synthetic);
  if (!synth.length) return;
  const tog = document.createElement('button');
  tog.className = 'clip upload testToggle'; tog.setAttribute('aria-expanded', 'false'); tog.setAttribute('aria-controls', 'clips');
  tog.dataset.tip = 'Rendered scenes with exactly known physics, for checking the lab';
  const tiles = synth.map(tile);
  tiles.forEach(b => { b.hidden = true; b.classList.add('test'); });
  const label = open => `<span>${open ? 'Hide test scenes' : 'Test scenes'} (${synth.length}) ${open ? '\u2212' : '>'}</span>`;
  tog.innerHTML = label(false);
  tog.onclick = () => {
    const open = tog.getAttribute('aria-expanded') !== 'true';
    tog.setAttribute('aria-expanded', String(open)); tog.innerHTML = label(open);
    tiles.forEach(b => b.hidden = !open);
  };
  side.append(tog); box.append(...tiles);
}

// ---- the chooser: inside the video frame, folded into the menu button once a clip is chosen -------------------------
const chooser = $('chooser'), menuBtn = $('menuBtn');
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// FLIP: the chooser's full-frame box and the menu button's box are the two ends; a shrink and fade between them.
function morph(toIcon, ms) {
  if (calm()) return Promise.resolve();
  const r = chooser.getBoundingClientRect(), t = menuBtn.getBoundingClientRect();
  const to = `translate(${t.left - r.left}px, ${t.top - r.top}px) scale(${t.width / r.width}, ${t.height / r.height})`;
  const anim = chooser.animate([{transform: 'none', opacity: 1}, {opacity: 0.85, offset: 0.55}, {transform: to, opacity: 0}],
    {duration: ms, easing: 'cubic-bezier(.4, 0, .2, 1)', direction: toIcon ? 'normal' : 'reverse', fill: 'both'});
  return anim.finished.catch(() => {}).then(() => anim.cancel());
}
let chooserBusy = false;
const chooserShut = () => chooser.classList.contains('shut');
async function closeChooser({focus = true} = {}) {
  if (chooserShut() || chooserBusy) return;
  chooserBusy = true;
  chooser.classList.add('over');
  menuBtn.hidden = false; menuBtn.setAttribute('aria-expanded', 'false');
  await morph(true, 520);
  chooser.classList.add('shut'); chooserBusy = false;
  if (focus) menuBtn.focus();
}
async function openChooser() {
  if (!chooserShut() || chooserBusy) return;
  chooserBusy = true;
  closeForkMenu();
  chooser.classList.remove('shut'); menuBtn.setAttribute('aria-expanded', 'true');
  await morph(false, 380);
  chooserBusy = false;
  (chooser.querySelector('.clip.active') || chooser.querySelector('.clip'))?.focus();
}
menuBtn.onclick = () => chooserShut() ? openChooser() : closeChooser();

async function select(c) {
  // Choosing a sample sends its own question at once, as if Run were pressed, unless a run is going (that choice only
  // switches clips, as before) or the clip is not a sample. Whether to send is settled below, once the saved run is known.
  const midRun = $('run').disabled || director.playing;
  // A replay still streaming for the previous clip would otherwise land its notebook, overlays and forks on this one.
  state.es?.close(); state.es = null; $('run').disabled = false; $('skip').hidden = true;
  director.cancel();
  state.clip = c; state.run = null; state.fit = null; state.forksReady = false; state.reveal = false;
  resetFork(); setPlot(false);
  document.querySelectorAll('.clip').forEach(b => b.classList.toggle('active', b.dataset.id === c.id));
  $('stageBadge').hidden = true;
  $('credit').textContent = c.credit || ''; $('credit').dataset.tip = c.credit || ''; $('credit').dataset.tipSide = 'top';
  $('question').value = '';
  setChatQ(titleOf(c), c.question || '');
  closeChooser({focus: false});
  nb.clear(c.analysed ? 'analysed before: “Run the lab” replays it' : '');
  $('question').disabled = false;
  const saved = await (await fetch(`/api/run?clip=${encodeURIComponent(c.id)}`)).json();
  if (state.clip !== c) return;
  state.info = saved.info || await probeInBrowser(c.url);
  stage.load(c.url, state.info);
  $('scrub').max = state.info.frames - 1; $('scrub').value = 0;
  // Only a sample whose run is saved is sent: the server replays a saved run for the clip's own question at no cost, so
  // this can never start a live (paid) analysis. An unanalysed sample waits for Run, as before.
  if (!midRun && c.id.startsWith('sample:') && c.question && saved.report) run();
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
  const clip = state.clip, asked = $('question').value, q = asked.trim();
  setChatQ(titleOf(clip, q), q || clip.question || '');
  // An empty box asks the clip's own question (the server does the same, so a sample replays its saved run).
  nb.user(q || clip.question || 'What physics is happening here? Measure it.');
  $('question').value = '';
  $('run').disabled = true; $('skip').hidden = false;
  closeChooser({focus: false});
  state.fit = null; state.forksReady = false; state.reveal = false;
  resetFork(); setPlot(false);
  // The previous run's drawings go; the director draws this run's as its steps come.
  stage.setAnalysis({track: null, fitPath: null, masks: null, world: null, forkPath: null});
  nb.state.textContent = 'running…';
  state.es?.close();
  const dr = director.start(clip), es = state.es = new EventSource(`/api/analyze?clip=${encodeURIComponent(clip.id)}&q=${encodeURIComponent(asked)}${live ? '&live=1' : ''}`);
  es.onmessage = m => {
    if (state.es !== es) return;
    const ev = JSON.parse(m.data);
    dr.push(ev);
    if (ev.type === 'done' || ev.type === 'error') es.close();
  };
  es.onerror = () => { if (state.es !== es) return; es.close(); if (!dr.finished) dr.push({type: 'error', message: 'The connection to the lab dropped.'}); };
}
$('skip').onclick = () => director.skip();

function markAnalysed(clip) {
  const c = state.clips.find(x => x.id === clip.id); if (c) c.analysed = true;
  const b = document.querySelector(`.clip[data-id="${CSS.escape(clip.id)}"] .kind`);
  if (b && !b.querySelector('.dot')) b.insertAdjacentHTML('afterbegin', '<i class="dot"></i>');
}

async function loadAnalysis(clip, report) {
  const id = encodeURIComponent(clip.id), stale = () => state.clip !== clip;
  const runData = await (await fetch(`/api/run?clip=${id}`)).json();
  if (!runData.report || stale() || (report && runData.report.headline !== report.headline)) return false;
  state.run = runData; state.info = runData.info;
  const rep = runData.report;
  const obj = rep.object in (rep.tracks || {}) ? rep.object : Object.keys(rep.tracks || {})[0];
  const fit = await post(`/api/fork?clip=${id}`, {overrides: {}});
  if (stale()) return false;
  // The dots are the points the fit actually followed (centroid, or an edge for a partly hidden object).
  const measured = rep.fit?.measured || rep.tracks[obj];
  state.fit = {track: measured, fitPath: fit.real, ppm: rep.fit?.ppm, origin: rep.fit?.origin_px, start: rep.fit?.frames?.[0] || 0};
  state.axis = rep.fit?.model === 'pendulum' || rep.fit?.model === 'oscillator' && spread(state.fit.track, 1) > spread(state.fit.track, 2) ? 'x' : 'y';
  // A pendulum, or a car crossing the frame, is told by how far it moves across, not by its height.
  if (rep.fit?.model === 'pendulum' || vehicleOf(rep)) state.axis = 'x';
  stage.setAnalysis({track: state.fit.track, fitPath: fit.real, fps: state.info.fps, frames: state.info.frames, point: rep.fit?.point || 'centroid', ppm: rep.fit?.ppm});
  setPlot(true); plot(stage.frame);
  // Compositing assets, fetched in the background: masks, the clean plate, the object's cut-out.
  const [masks, plate, sprite, spriteMeta] = await Promise.all([
    fetch(`/api/masks?clip=${id}&object=${encodeURIComponent(obj)}`).then(r => r.ok ? r.json() : null).then(async m => { if (!m) return null; const id = obj.split(':').pop(); return (await decodeMasks(m.text, [id]))[id]; }),
    image(`/api/plate?clip=${id}`), image(`/api/sprite?clip=${id}&object=${encodeURIComponent(obj)}`).catch(() => null),
    fetch(`/api/sprite?clip=${id}&object=${encodeURIComponent(obj)}&meta=1`).then(r => r.ok ? r.json() : null),
  ]);
  // The plate is built by the request above, so its steadiness score exists now.
  const plateMeta = await fetch(`/api/plate?clip=${id}&meta=1`).then(r => r.ok ? r.json() : {steady: true}).catch(() => ({steady: true}));
  if (stale()) return false;
  stage.setAnalysis({masks, plate, sprite, spriteMeta, plateSteady: plateMeta.steady !== false});
  renderForks(rep);
  return true;
}

// The saved run's own fit curve, so the director can draw the real one when a fit beat is the fit the report rests on.
async function finalFit(clip) {
  const id = encodeURIComponent(clip.id), run = await (await fetch(`/api/run?clip=${id}`)).json(), rep = run.report;
  if (!rep?.fit) return null;
  const fit = await post(`/api/fork?clip=${id}`, {overrides: {}});
  return {model: rep.fit.model, object: rep.object, frames: rep.fit.frames, measured: rep.fit.measured, fitPath: fit.real};
}

const spread = (pts, k) => Math.max(...pts.map(p => p[k])) - Math.min(...pts.map(p => p[k]));

function image(src) {
  return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = src; });
}
async function post(url, body) {
  const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  return r.json();
}

// Until a run has a fit the plot's space shows a hint instead of an empty box, so the layout does not jump.
const setPlot = on => $('plotWrap').classList.toggle('idle', !on);

function plot(frame) {
  if (!state.fit?.ppm) return;
  // A car's fork is told in speed against time (reality's steady line against the fork's), not in position.
  const speed = state.vehicle && stage.forking ? state.fork?.res.speed : null;
  drawPlot($('plot'), {...state.fit, forkPath: stage.forking ? stage.data.forkPath : null, fps: state.info.fps, axis: state.axis, now: frame, speed});
  const cap = $('plotCaption');
  if (speed) { cap.innerHTML = '<span class="key f">reality, as filmed</span><span class="key k">fork</span>'; return; }
  cap.innerHTML = `<span class="key m">measured by SAM 3.1</span><span class="key f">fitted law</span>${stage.forking ? '<span class="key k">fork</span>' : ''}`;
}

// ---- forks -----------------------------------------------------------------------------------------------------
const PRESETS = [
  {label: 'Moon', g: 1.62, why: 'g = 1.62 m/s²'}, {label: 'Mars', g: 3.71, why: 'g = 3.71 m/s²'},
  {label: 'Jupiter', g: 24.79, why: 'g = 24.8 m/s²'}, {label: 'No air', drag: 'none', why: 'drag removed'},
  {label: 'Super bouncy', e: 0.95, why: 'restitution 0.95', models: ['bounce']},
];

// For a car crossing the frame the gravity worlds mean nothing; the story is a person stepping out (see lib/vehiclefork.mjs).
// Faster speeds are offered as well as slower: the filmed car may be slow enough to stop in time (a street clip at 17 km/h),
// and the point is then what a faster one would do. Only a speed within 2 km/h of the filmed one is left out (a duplicate).
const CAR_PRESETS = [
  {label: 'Someone steps out 20 m ahead', why: 'brakes at the measured speed', vehicle: {brake: true}},
  {label: 'Same, at 30 km/h', why: 'steps out 20 m ahead, 30 km/h', vehicle: {brake: true, speed_kmh: 30}},
  {label: 'Same, at 40 km/h', why: 'steps out 20 m ahead, 40 km/h', vehicle: {brake: true, speed_kmh: 40}},
  {label: 'Same, at 50 km/h', why: 'steps out 20 m ahead, 50 km/h', vehicle: {brake: true, speed_kmh: 50}},
];

// What /api/fork is sent for a preset: one function for the menu's items and for fork() itself.
function overridesFor(f) {
  const overrides = {}; if (f.g) overrides.g = f.g; if (f.drag) overrides.drag = f.drag; if (f.e != null) overrides.e = f.e;
  if (f.vehicle) {
    if (f.vehicle.speed_kmh) overrides.speed_kmh = f.vehicle.speed_kmh;
    if (f.vehicle.brake) overrides.brake = {hazard_px: Math.round(state.hazardPx), distance_m: 20};
  }
  return overrides;
}

function renderForks(rep) {
  state.rep = rep;
  state.vehicle = vehicleOf(rep); state.lastFork = null;
  if (state.vehicle) {
    // The crossing starts three quarters of the way across, in the direction the car travels; a click on the road moves it.
    state.hazardPx = state.info.width * (state.vehicle.dir > 0 ? 0.75 : 0.25);
    placeCrossing();
  } else stage.setAnalysis({crossing: null, road: null});
  // The director reveals the Reality Fork button when the report has been read; one loaded without a run shows at once.
  state.forksReady = true;
  if (state.reveal || !director.playing) showForkBtn();
}

// The presets that make sense for this clip, filtered as ever. Built when the menu opens, so that the hazard position
// in the car presets is the current one.
function forkItems() {
  const rep = state.rep, model = rep.fit?.model;
  // An agent fork that changes nothing (no g, drag or e) would replay reality, so it is not offered.
  const fromAgent = (rep.forks || []).map(f => ({label: f.label, g: f.g > 0 ? f.g : undefined, drag: f.drag === 'none' ? 'none' : undefined, e: f.e >= 0 ? f.e : undefined, why: f.why, agent: true}))
    .filter(f => f.g != null || f.drag || f.e != null);
  // A preset is left out when the agent already offers it, by name or by the same change under its own name
  // ("same throw on Moon" is the Moon preset; "vacuum flight" is No air).
  const seen = new Set(fromAgent.map(f => f.label.toLowerCase()));
  // Removing air from a law with no drag term changes nothing (lib/forkview.mjs drops it), so it does not count.
  const hasDrag = rep.fit?.p?.b != null || rep.fit?.p?.gamma != null;
  const near = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.01);
  const sameAs = p => fromAgent.some(f => near(f.g, p.g) && (hasDrag ? f.drag === p.drag : !p.drag) && near(f.e, p.e));
  // Nor is a world offered where the clip was filmed: "Moon" on Apollo footage would replay reality.
  const filmed = Number.isFinite(rep.filmed_g) ? rep.filmed_g : 9.81, home = p => p.g != null && Math.abs(p.g - filmed) < 0.05;
  const list = state.vehicle ? CAR_PRESETS.filter(p => !p.vehicle.speed_kmh || Math.abs(p.vehicle.speed_kmh - state.vehicle.kmh) > 2)
    : [...fromAgent, ...PRESETS.filter(p => !seen.has(p.label.toLowerCase()) && !sameAs(p) && !home(p) && (!p.models || p.models.includes(model)) && !(p.drag && model !== 'projectile-drag'))];
  return [{label: 'Reality', why: 'as filmed', real: true, overrides: {}}, ...list.slice(0, 7).map(f => ({...f, overrides: overridesFor(f)}))];
}

// The pill that invites a fork. It sits inside the frame at the lower right and moves up the right edge when something
// is in the way: the tracked object's path or the fork's, a car fork's bird's-eye strip, and the in-frame fork bar.
function showForkBtn() {
  const btn = $('forkBtn'); if (!btn.hidden) return;
  btn.hidden = false;
  placeForkBtn();
  $('crossHint').hidden = !state.vehicle;
}
function placeForkBtn() {
  const btn = $('forkBtn'); if (btn.hidden || !state.info) return;
  const stg = $('stage'), sw = stg.clientWidth, sh = stg.clientHeight, W = state.info.width, H = state.info.height;
  if (!sw || !sh) return;
  // The video is letterboxed inside the frame (object-fit: contain), so frame pixels map through a scale and an offset.
  const sc = Math.min(sw / W, sh / H), ox = (sw - W * sc) / 2, oy = (sh - H * sc) / 2;
  const pw = btn.offsetWidth || 150, ph = btn.offsetHeight || 42, right = 14, margin = 18;
  const pts = [...(state.fit?.track || []), ...(stage.forking ? stage.data.forkPath || [] : [])].map(p => [ox + p[1] * sc, oy + p[2] * sc]);
  const L = stage.forking ? stage.strip?.layout : null, strip = L && {x: ox + L.x * sc, y: oy + L.y * sc, w: L.w * sc, h: L.h * sc};
  // The fork bar is a DOM element along the bottom of the frame; the pill must clear it.
  const bar = $('forkActive').hidden ? null : $('forkActive').getBoundingClientRect(), sr = stg.getBoundingClientRect();
  const floor = bar ? bar.top - sr.top - 10 : sh - 14;
  const busy = top => {
    const r = {l: sw - right - pw - margin, t: top - margin, r: sw - right + margin, b: top + ph + margin};
    return pts.some(p => p[0] > r.l && p[0] < r.r && p[1] > r.t && p[1] < r.b)
      || strip && r.r > strip.x && r.l < strip.x + strip.w && r.b > strip.y && r.t < strip.y + strip.h
      || top + ph > floor || top < 56;
  };
  // Candidate tops, from the bottom up: first the lowest place that clears the bar, then every ~12% of the frame upward.
  const tops = [floor - ph]; for (let t = floor - ph - 0.12 * sh; t > 56; t -= 0.12 * sh) tops.push(t);
  // The strip (a bird's-eye panel) may span the width, so the first free place can be above it.
  let top = tops.find(t => !busy(t));
  if (top == null && strip) top = Math.max(56, strip.y - ph - 12);
  btn.style.bottom = 'auto'; btn.style.top = Math.max(8, top ?? tops[0]) + 'px';
}

async function openForkMenu() {
  if (!state.rep || director.playing) return;
  closeChooser({focus: false});
  closeForkMenu();
  const items = forkItems(), host = $('forkMenu'), clip = state.clip;
  $('forkOver').hidden = false; $('forkBtn').setAttribute('aria-expanded', 'true');
  const opts = {question: state.qTitle, clipId: clip.id, info: state.info, plateUrl: `/api/plate?clip=${encodeURIComponent(clip.id)}`, realPath: stage.data.fitPath, active: state.fork?.label || 'Reality', onPick};
  const gone = () => state.clip !== clip || $('forkOver').hidden;
  try {
    const {renderForkMenu} = await import('./forkmenu.js');
    if (gone()) return;
    state.menu = renderForkMenu(host, items, opts);
  } catch {
    // forkmenu.js is another module; until it exists (or if it fails to load) plain buttons do the job.
    if (gone()) return;
    host.innerHTML = '';
    const row = document.createElement('div'); row.className = 'fork-fallback';
    for (const it of items) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pillbtn';
      b.textContent = it.label; b.dataset.tip = it.why || ''; if (it.label === opts.active) b.setAttribute('aria-current', 'true');
      b.onclick = () => onPick(it); row.append(b);
    }
    host.append(row); state.menu = {destroy: () => { host.innerHTML = ''; }};
  }
  host.querySelector('button, [tabindex]')?.focus();
}
function closeForkMenu() {
  if ($('forkOver').hidden) return;
  $('forkOver').hidden = true; $('forkBtn').setAttribute('aria-expanded', 'false');
  state.menu?.destroy?.(); state.menu = null;
}
function onPick(item) {
  closeForkMenu();
  $('forkBtn').focus();
  if (item.real) goReality(); else fork(item);
}
$('forkBtn').onclick = () => $('forkOver').hidden ? openForkMenu() : closeForkMenu();
// The same invitation as a button inside the lab's last message (director.js revealForks).
$('steps').addEventListener('click', e => { if (e.target.closest('[data-open-forks]')) openForkMenu(); });
$('forkClose').onclick = () => { closeForkMenu(); $('forkBtn').focus(); };

// The in-frame bar while a fork plays: its name, the way back to the footage, save and repaint.
function showBar(label) { $('forkName').textContent = label; $('forkActive').hidden = false; $('stage').classList.add('bar'); }
function hideBar() { $('forkActive').hidden = true; $('stage').classList.remove('bar'); $('saveClip').hidden = true; $('forkSummary').textContent = ''; }
// Everything a clip switch or a new run must put away.
function resetFork() {
  if (stage.data) stage.setFork(null);
  state.fork = null; state.lastFork = null; state.rep = null;
  closeForkMenu(); hideBar();
  $('forkBtn').hidden = true; $('crossHint').hidden = true;
}
function goReality() {
  stage.setFork(null); state.fork = null; state.lastFork = null; hideBar(); $('stageBadge').hidden = true; plot(stage.frame); placeForkBtn();
  nb.user('Show it as filmed'); nb.msg('lab', 'Back to the footage as it was filmed.', {done: true});
}
$('realityBtn').onclick = () => { if (!director.playing) goReality(); };

async function fork(f, moved = false) {
  if (director.playing) return;
  nb.user(moved ? `${whatIf(f)} (crossing moved)` : whatIf(f));
  if (f.vehicle) state.lastFork = {f};
  showBar(f.label);
  const clip = state.clip, id = encodeURIComponent(clip.id);
  const res = await post(`/api/fork?clip=${id}`, {overrides: overridesFor(f)});
  if (state.clip !== clip) return;
  if (res.error) { hideBar(); nb.msg('err', res.error.replace(/</g, '&lt;')); return; }

  let world = null;
  // Picked by gravity, so the agent's own forks ("same throw on the Moon") get the world too. Only over a steady plate:
  // the repaint replaces the footage, which for a launch would take the plume away with it.
  const name = [['moon', 1.62], ['mars', 3.71], ['jupiter', 24.79]].find(([, g]) => Math.abs((f.g || 0) - g) < 0.01)?.[0];
  if ($('restyle').checked && name && stage.data.plateSteady !== false) {
    $('forkSummary').textContent = 'Muse Image is repainting the scene…';
    const paint = nb.msg('image', `Repainting the scene as ${name === 'mars' ? 'Mars' : name === 'jupiter' ? 'Jupiter' : 'the Moon'}…`, {busy: true});
    const r = await post(`/api/restyle?clip=${id}`, {world: name});
    nb.settle(paint); nb.complete(paint);
    if (r.url) world = await image(r.url);
    if (state.clip !== clip) return;
    $('forkSummary').textContent = '';
  }
  nb.body(nb.msg('lab', '', {done: true, step: STEPS.fork})).textContent = res.summary || `Replaying with ${f.why || f.label}.`;
  stage.setAnalysis({world});
  state.fork = {label: f.label, res};
  if (res.hazard) stage.setAnalysis({crossing: {x: res.hazard.x_px, y: res.hazard.y_px}});
  playFork();
  $('saveClip').hidden = false;
  plot(stage.frame);
}

const playFork = () => {
  const {label, res} = state.fork;
  stage.setFork(res.path, {label, start: res.path[0][0], end: res.end_frame, baseline: res.baseline, floor: res.floor_px, hazard: res.hazard, summary: res.summary});
  requestAnimationFrame(placeForkBtn);  // the strip's layout exists once the stage has drawn the fork's first frame
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

// ---- the crossing (cars) ---------------------------------------------------------------------------------------
function placeCrossing() {
  if (!state.vehicle) return;
  // `road(x)` is the car's line of travel on the footage, which the stage carries on past the picture's edges.
  stage.setAnalysis({crossing: {x: state.hazardPx, y: roadY(state.vehicle, state.hazardPx)}, road: x => roadY(state.vehicle, x)});
}
// Click the road on the video to move where the person steps out; an active braking fork is run again for the new spot.
$('overlay').addEventListener('click', e => {
  if (!state.vehicle || director.playing || !state.forksReady || !$('forkOver').hidden || !chooserShut()) return;
  const r = $('overlay').getBoundingClientRect(), W = state.info.width;
  const x = stage.toFrameX((e.clientX - r.left) * W / r.width);
  state.hazardPx = Math.max(0.08 * W, Math.min(0.97 * W, x));
  placeCrossing();
  const last = state.lastFork;
  if (last?.f.vehicle.brake && state.fork) fork(last.f, true);
});

// ---- transport, upload, voice ----------------------------------------------------------------------------------
$('play').onclick = () => {
  const v = $('video');
  if (stage.forking && stage.frame >= stage.forkEnd - 1) return state.fork ? playFork() : stage.seek(Math.max(0, stage.data.forkPath[0][0] - 12), true);
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
  director.cancel();
  const r = await fetch('/api/upload', {method: 'POST', body: file});
  const j = await r.json();
  if (j.error) return nb.msg('err', String(j.error).replace(/</g, '&lt;'));
  const c = {id: j.id, url: j.url, title: file.name.replace(/\.[^.]+$/, ''), motion: 'your clip'};
  state.clips.push(c);
  await select(c);
  state.info = j.info; stage.load(c.url, j.info); $('scrub').max = j.info.frames - 1;
  nb.clear('ready: ask a question, then Run the lab');
}

const voice = new Voice();
let recording = false;
// The waveform button animates while recording (static highlight under reduced motion); its tooltip follows.
function micState() {
  const m = $('mic');
  m.classList.toggle('rec', recording); m.setAttribute('aria-pressed', String(recording));
  m.dataset.tip = recording ? 'Recording. Click to stop and ask' : 'Ask by voice (Muse Voice Transcribe)';
  m.setAttribute('aria-label', recording ? 'Stop recording' : 'Ask by voice');
  refreshTip(m);
}
$('mic').onclick = async () => {
  if (!recording) {
    try { await voice.start(); } catch { return alert('Microphone not available.'); }
    recording = true; micState();
    return;
  }
  recording = false; micState();
  const wav = await voice.stop();
  $('question').value = 'Transcribing…';
  const r = await fetch('/api/transcribe', {method: 'POST', body: wav});
  const j = await r.json();
  $('question').value = j.text || '';
  if (j.text && state.clip) run();
};

// ---- info popover, Esc, layout ---------------------------------------------------------------------------------
const infoPop = $('infoPop'), infoBtn = $('infoBtn');
infoPop.innerHTML = Notebook.introHtml();
const setInfo = on => { infoPop.hidden = !on; infoBtn.setAttribute('aria-expanded', String(on)); };
infoBtn.onclick = () => setInfo(infoPop.hidden);
document.addEventListener('pointerdown', e => { if (!infoPop.hidden && !infoPop.contains(e.target) && !infoBtn.contains(e.target)) setInfo(false); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!infoPop.hidden) { setInfo(false); infoBtn.focus(); }
  else if (!$('forkOver').hidden) { closeForkMenu(); $('forkBtn').focus(); }
  else if (!chooserShut() && chooser.classList.contains('over')) closeChooser();
});

// The video frame is as tall as its width asks, but never so tall that the plot under it loses its room.
const sizeStage = () => {
  const col = document.querySelector('.stage-col');
  if (matchMedia('(max-width: 980px)').matches) return $('stage').style.removeProperty('--stage-max');
  $('stage').style.setProperty('--stage-max', Math.max(200, col.clientHeight - document.querySelector('.transport').offsetHeight - 170 - 20) + 'px');
};
addEventListener('resize', () => { sizeStage(); placeForkBtn(); state.fit && plot(stage.frame); });
new ResizeObserver(() => { sizeStage(); placeForkBtn(); state.fit && plot(stage.frame); }).observe(document.querySelector('.stage-col'));
sizeStage();
loadClips();
// After the hackathon's judging the server stops paid calls; say so once, where it is seen.
fetch('/api/status').then(r => r.json()).then(st => {
  if (st.live !== false) return;
  const t = $('toast'); t.textContent = st.notice; t.hidden = false; t.onclick = () => { t.hidden = true; };
}).catch(() => {});
