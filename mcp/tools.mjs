// The Reality Fork lab as four plain functions, shared by the MCP server (mcp/server.mjs) and the shell CLI (mcp/cli.mjs).
// Nothing here calls a paid API unless a live run is asked for AND the process was started with RF_ALLOW_LIVE=1.
import fs from 'node:fs';
import path from 'node:path';
import {UPLOADS, samples, clipById, clipInfo, latestRun, runFile, runLab, saveUpload} from '../lib/store.mjs';
import {forkPixels} from '../lib/forkview.mjs';
import {GRAVITY} from '../lib/physics/fork.mjs';
import {MODELS} from '../lib/physics/models.mjs';
// spriteFor lives in server.mjs (importing it does not start the server); /api/fork passes its cut-out so that "leaves the
// frame" is judged on the whole object, and we do the same so the numbers match the web app.
import {spriteFor} from '../server.mjs';

const round = (v, d = 4) => Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v;
const fail = message => Object.assign(new Error(message), {toolError: true});

const LIVE_HELP = 'No saved analysis exists for this clip, and live runs are off. A live run asks Meta\'s Muse Spark and SAM 3.1 models and costs a few cents of API credit ' +
  '(capped by RF_BUDGET_USD). To allow it, start this server or CLI with RF_ALLOW_LIVE=1 in its environment (and the Meta API key configured), then call again with live=true.';

export function list_clips() {
  return samples().map(c => {
    const run = latestRun(c.id);
    return {clip_id: c.id, title: c.title, analysed: !!run, headline: run?.report?.headline, expected: c.expected, motion: c.motion};
  }).concat(listUploads());
}

function listUploads() {
  return uploadIds().map(id => ({clip_id: id, title: 'Uploaded clip', analysed: !!latestRun(id), headline: latestRun(id)?.report?.headline}));
}
// Uploads are the .mp4 files in cache/uploads named by hash.
function uploadIds() {
  const dir = UPLOADS;
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.mp4')).map(f => 'upload:' + f.slice(0, -4)) : [];
}

function resolveClip({path: file, clip_id}) {
  if (file) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw fail(`no such video file: ${abs}`);
    // Same normalisation and naming as /api/upload, so the clip is shared with the web app.
    return clipById(saveUpload(fs.readFileSync(abs)).id);
  }
  if (!clip_id) throw fail('give either path (a local video file) or clip_id (see list_clips)');
  const clip = clipById(clip_id);
  if (!clip) throw fail(`unknown clip_id "${clip_id}"; call list_clips for the ids`);
  return clip;
}

export async function analyze_video({path: file, clip_id, question, live = false} = {}) {
  const clip = resolveClip({path: file, clip_id});
  const exact = runFile(clip.id, question), allowed = live === true && process.env.RF_ALLOW_LIVE === '1';
  // A saved run for this very question is free; a different question gets a new run when live runs are allowed, and
  // otherwise the clip's latest run with a note (asking the same clip something new is how a user steers the lab).
  let run = fs.existsSync(exact) ? JSON.parse(fs.readFileSync(exact, 'utf8')) : allowed ? null : latestRun(clip.id), note;
  if (run && question && run.question.trim().toLowerCase() !== question.trim().toLowerCase())
    note = `Returned the saved analysis (asked: "${run.question || 'general'}"), not a new one for your question; pass live=true (with RF_ALLOW_LIVE=1) for a new one.`;
  if (!run) {
    if (!allowed) throw fail(LIVE_HELP);
    run = await runLab(clip, question, () => {});
  }
  return compact(run, clip, note);
}

function compact(run, clip, note) {
  const r = run.report || {};
  return {
    clip_id: clip.id, headline: r.headline, answer: r.answer,
    law: r.fit && {model: r.fit.model, label: MODELS[r.fit.model]?.label, object: r.object, frames: r.fit.frames},
    measurements: (r.measurements || []).map(m => ({name: m.name, value: round(m.value), sigma: round(m.sigma), unit: m.unit, compare_to: m.compare_to || undefined})),
    assumptions: r.assumptions, confidence: r.confidence,
    suggested_forks: (r.forks || []).map(f => ({label: f.label, why: f.why, ...overridesOf(f)})),
    seconds_spent: run.seconds, analysed_at: run.at, ...(note && {note}),
    next: 'fork_motion({clip_id, g?, drag?, e?}) re-simulates under other physics; export_measurements({clip_id}) gives the fitted law as JSON.',
  };
}
const overridesOf = ({g, drag, e}) => Object.fromEntries(Object.entries({g, drag, e}).filter(([, v]) => v !== undefined));

function needRun(clip_id) {
  const clip = resolveClip({clip_id});
  const run = latestRun(clip.id);
  if (!run?.report?.fit) throw fail(`clip ${clip.id} has no saved analysis with a fitted law; call analyze_video first`);
  return {clip, run};
}

export async function fork_motion({clip_id, g, drag, e} = {}) {
  const {clip, run} = needRun(clip_id);
  const ov = {};
  if (g != null) {
    const v = typeof g === 'string' && Number.isNaN(Number(g)) ? GRAVITY[g.toLowerCase()] : Number(g);
    if (!Number.isFinite(v)) throw fail(`unknown gravity "${g}": give m/s^2 or one of ${Object.keys(GRAVITY).join(', ')}`);
    ov.g = v;
  }
  // drag: "none" (or 0) removes the air; a number scales the fitted drag (2 = twice as draggy, 1 = unchanged).
  if (drag != null) {
    if (drag === 'none' || Number(drag) === 0) ov.drag = 'none';
    else if (Number(drag) > 0) ov.drag = Number(drag);
    else if (drag !== 'keep') throw fail('drag must be "none", "keep" or a positive scale factor');
  }
  if (e != null) {
    if (!(Number(e) >= 0 && Number(e) <= 1)) throw fail('e (bounciness, coefficient of restitution) must be between 0 and 1');
    ov.e = Number(e);
  }
  if (!Object.keys(ov).length) throw fail('give at least one of g (m/s^2 or a name like moon), drag ("none" or a scale), e (0..1)');
  const info = clipInfo(clip), sprite = await spriteFor(clip, run, run.report.object).catch(() => null);
  // Exactly what /api/fork does, then converted from pixels to metres with the fit's own scale.
  const f = forkPixels(run, ov, {fps: info.fps, frames: info.frames, sprite: sprite?.meta});
  if (f.error) throw fail(f.error);
  const fit = run.report.fit, [x0, y0] = fit.origin_px, fps = info.fps;
  const toM = ([frame, x, y]) => ({t: round((frame - fit.frameOffset) / fps, 3), x: round((x - x0) / fit.ppm, 3), y: round((y0 - y) / fit.ppm, 3)});
  const pts = f.path.map(toM);
  // One point per ~0.1 s (the web app's path has one per frame).
  const path10 = [];
  let next = -Infinity;
  for (const p of pts) if (p.t >= next - 1e-9) { path10.push(p); next = p.t + 0.1; }
  if (pts.length && path10.at(-1) !== pts.at(-1)) path10.push(pts.at(-1));
  return {
    clip_id: clip.id, overrides: ov, summary: f.summary,
    events: (f.events || []).map(ev => ({type: ev.type, t: round(ev.t, 3), x: round(ev.x, 3), y: round(ev.y, 3), speed: round(ev.speed, 3), n: ev.n})),
    path: path10, path_note: 'seconds from the track start, metres from the start of the fit, x to the right, y up; one point per 0.1 s',
    warnings: f.warnings,
  };
}

export function export_measurements({clip_id} = {}) {
  const {clip, run} = needRun(clip_id);
  const r = run.report, fit = r.fit, model = MODELS[fit.model];
  const units = Object.fromEntries((model?.params || []).map(p => [p.name, p]));
  const parameters = Object.fromEntries(Object.entries(fit.p).map(([k, v]) => [k, {value: round(v, 6), sigma: round(fit.sigma?.[k], 6), unit: units[k]?.unit, meaning: units[k]?.desc}]));
  return {
    clip_id: clip.id, object: r.object, law: {model: fit.model, label: model?.label, parameters},
    derived: (fit.derived || []).map(d => ({name: d.name, value: round(d.value, 5), sigma_fit: round(d.sigma, 6), sigma_total: round(d.sigma_total, 5), unit: d.unit, meaning: d.desc})),
    sigma_note: 'sigma is the fit\'s 1-sigma statistical error in the track\'s metres; sigma_total also includes the scale uncertainty (use it for real-world claims).',
    frames: {first: fit.frames[0], last: fit.frames[1], clip_frames: run.info?.frames}, fps: fit.fps,
    time_axis: 'seconds = (frame - frame_offset) / fps', frame_offset: fit.frameOffset,
    scale: {pixels_per_metre: round(fit.ppm, 3), sigma_rel: round(r.scale?.sigma_rel, 4), from: r.scale && `${r.scale.dimension} of ${r.scale.real_size_m} m (${r.scale.reason})`},
    origin_px: fit.origin_px, coordinates: 'metres from origin_px, x to the right, y up',
    fit_quality: {rms_m: fit.rms, noise_sigma_m: fit.data?.noise_sigma_m, samples: fit.data?.samples},
    measurements: (r.measurements || []).map(m => ({name: m.name, value: round(m.value), sigma: round(m.sigma), unit: m.unit})),
    assumptions: r.assumptions, confidence: r.confidence, filmed_g: r.filmed_g,
  };
}

// Schemas for MCP tools/list; the CLI prints them in its help.
export const TOOLS = [
  {name: 'list_clips', description: 'List the video clips Reality Fork knows (sample clips, test scenes, uploads), with the clip_id to use in the other tools and whether each has been analysed already. Free.',
    inputSchema: {type: 'object', properties: {}}, run: list_clips},
  {name: 'analyze_video', description: 'Measure the physics of a moving object in a short video (thrown ball, drop, bounce, pendulum, slide down a slope, rocket). Muse Spark plans the experiment, SAM 3.1 tracks the object in every frame, and a law of motion is fitted with error bars. ' +
    'Returns the headline, a plain answer, the fitted law, measurements with 1-sigma errors and units, assumptions and confidence. Give a local video path or a clip_id. If this clip was analysed before the saved result is returned for free. ' +
    'A new analysis is only run with live=true and when the server was started with RF_ALLOW_LIVE=1; it costs a few cents of Meta API credit, otherwise a message says how to allow it.',
    inputSchema: {type: 'object', properties: {
      path: {type: 'string', description: 'Absolute or relative path of a local video file (mp4, mov, webm; up to 20 s are used). Use this or clip_id.'},
      clip_id: {type: 'string', description: 'A clip id from list_clips, e.g. "synthetic:throw".'},
      question: {type: 'string', description: 'What you want to know, e.g. "what is the gravity?" or "how bouncy is the ball?". Optional.'},
      live: {type: 'boolean', description: 'Allow a new paid analysis if none is saved. Default false.', default: false}}},
    run: analyze_video},
  {name: 'fork_motion', description: 'Fork reality: re-simulate the measured motion under different physics and get where the object would be. Give at least one of g (gravity in m/s^2, or a name: moon, mars, jupiter, earth, ceres, titan, iss), drag ("none" for no air, or a factor such as 2) and e (bounciness 0..1). ' +
    'Needs a clip that has been analysed. Returns a summary sentence, events (landing and bounce times and positions) and a path sampled every 0.1 s, in metres. Free.',
    inputSchema: {type: 'object', required: ['clip_id'], properties: {
      clip_id: {type: 'string', description: 'Clip id (from list_clips or analyze_video).'},
      g: {type: ['number', 'string'], description: 'New gravity in m/s^2 (Moon 1.62, Mars 3.71) or a name such as "moon".'},
      drag: {type: ['string', 'number'], description: '"none" removes air drag; a number scales the fitted drag; "keep" leaves it.'},
      e: {type: 'number', minimum: 0, maximum: 1, description: 'Coefficient of restitution for floor bounces (0 dead, 1 perfectly bouncy).'}}},
    run: fork_motion},
  {name: 'export_measurements', description: 'The fitted law and its parameters as plain JSON to paste into a simulator or analysis script: parameters with 1-sigma errors and units, derived quantities (g, launch speed, drag, ...), frame range, fps, the pixel-per-metre scale with its uncertainty, coordinate conventions and assumptions. Needs an analysed clip. Free.',
    inputSchema: {type: 'object', required: ['clip_id'], properties: {clip_id: {type: 'string', description: 'Clip id (from list_clips or analyze_video).'}}},
    run: export_measurements},
];

// Run a tool by name; failures that are the caller's to fix come back as {error}, never as a crash.
export async function callTool(name, args = {}) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return {isError: true, result: {error: `unknown tool ${name}`}};
  try { return {result: await tool.run(args)}; }
  catch (e) { return {isError: true, result: {error: String(e.message || e)}}; }
}
