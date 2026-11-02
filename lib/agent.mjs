// The lab agent. Muse Spark watches the clip, then works like an experimentalist with four instruments:
//   track_objects  - SAM 3.1 follows a named object through every frame (pixel masks → sub-pixel centroids)
//   set_scale      - SAM measures something of known size, giving pixels per metre (with its uncertainty)
//   fit_motion     - candidate physical laws are fitted and ranked by BIC, with error bars on every parameter
//   check_overlay  - the fitted law is drawn over real frames and the picture is shown back to the model
// and finishes with `final_report`. Every number in the report comes from a tool result, not from the model.
import fs from 'node:fs';
import {respond, functionCalls, outputText, samSegment, uploadFile, hashOf} from './meta.mjs';
import {parseSam, tracksFrom, summarise, referencePixels, toMetres} from './sam.mjs';
import {readFrames, encodeImage, dataUrl} from './video.mjs';
import {circle, polyline, contactSheet, COLORS} from './draw.mjs';
import {fitAll, fitModel, MODELS} from './physics/select.mjs';

export const MODEL = process.env.RF_MODEL || 'muse-spark-1.3';

const INSTRUCTIONS = `You are the scientist inside Reality Fork. A person filmed something moving and asks a question about it.
Your job: measure what physically happened, find the law that explains it, report numbers with honest error bars, and suggest
"what if" forks (change gravity, remove air, change bounciness...). You have instruments; use them, never guess numbers.

How to work:
1. Watch the video. Decide which object's motion answers the question and what known-size thing can set the scale
   (the moving object itself is best when its size is standard: basketball 0.24 m, tennis ball 0.067 m, football 0.22 m,
   golf ball 0.043 m, A4 paper 0.297 x 0.210 m, door 2.0 m tall, a standard brick 0.215 m long). Give a realistic
   uncertainty for that size. Prefer a scale object at the same distance from the camera as the motion.
2. track_objects with a short noun phrase (e.g. "orange basketball", "pendulum bob", "hammer"). It returns every match;
   pick the object id that actually moves. If nothing useful is found, try another phrase.
3. set_scale, then fit_motion on the moving object. Read the ranking: the best model by BIC, the residuals, the parameters.
   If the best model is physically implausible, or residuals are large, investigate (a frame range around one bounce,
   a different object, fixing a parameter) before concluding.
4. check_overlay on your chosen fit and look at the picture: yellow dots are SAM's measured centres, the cyan curve is
   your fitted law, magenta rings are where the law puts the object. If they disagree, say so and fix it.
5. final_report. Compare measured values with known references when relevant (Earth g = 9.81 m/s², Moon 1.62). State
   assumptions (camera still, motion roughly in a plane facing the camera, scale object at the same depth). Be concise
   and concrete; the reader is curious, not an expert.
Keep tool calls purposeful: at most about 10. Never invent measurements that no tool returned.`;

const TOOLS = [
  {type: 'function', name: 'track_objects', description: 'Track every instance of an object through all frames with SAM 3.1. Returns per-object summaries (frames seen, pixel path, size, confidence).',
    parameters: {type: 'object', properties: {prompt: {type: 'string', description: 'Short noun phrase naming the object, e.g. "red ball". Not a sentence.'}}, required: ['prompt'], additionalProperties: false}},
  {type: 'function', name: 'set_scale', description: 'Set pixels-per-metre from an object of known real size. Use an object id from track_objects, or a noun phrase to segment on one frame.',
    parameters: {type: 'object', properties: {
      object: {type: 'string', description: 'Object id from track_objects (e.g. "ball:0"); empty to use `prompt` instead.'},
      prompt: {type: 'string', description: 'Noun phrase for a static reference object (used when object is empty).'},
      real_size_m: {type: 'number'}, size_uncertainty_m: {type: 'number'},
      dimension: {type: 'string', enum: ['diameter', 'longest', 'shortest'], description: 'Which size of the object real_size_m refers to.'},
      reason: {type: 'string'}},
    required: ['object', 'prompt', 'real_size_m', 'size_uncertainty_m', 'dimension', 'reason'], additionalProperties: false}},
  {type: 'function', name: 'fit_motion', description: 'Fit candidate physical laws to an object\'s measured path (in metres, y up) and rank them by BIC. Optionally restrict models, fix parameters, or a frame range.',
    parameters: {type: 'object', properties: {
      object: {type: 'string'},
      models: {type: 'array', items: {type: 'string', enum: ['constant-velocity', 'projectile', 'projectile-drag', 'bounce', 'pendulum', 'incline', 'oscillator']}, description: 'Empty for all.'},
      fixed: {type: 'object', description: 'Parameters to hold fixed, e.g. {"g": 9.81}. Empty object for none.', additionalProperties: {type: 'number'}},
      first_frame: {type: 'integer', description: '-1 for the start.'}, last_frame: {type: 'integer', description: '-1 for the end.'}},
    required: ['object', 'models', 'fixed', 'first_frame', 'last_frame'], additionalProperties: false}},
  {type: 'function', name: 'check_overlay', description: 'Draw the measured centres and a fitted law over six frames and show you the picture.',
    parameters: {type: 'object', properties: {object: {type: 'string'}, model: {type: 'string'}}, required: ['object', 'model'], additionalProperties: false}},
  {type: 'function', name: 'final_report', description: 'Finish with the answer.',
    parameters: {type: 'object', properties: {
      headline: {type: 'string', description: 'One short line, e.g. "Gravity on the Moon: 1.6 m/s²".'},
      answer: {type: 'string', description: '2-4 sentences answering the question in plain words, citing measured numbers.'},
      object: {type: 'string'}, model: {type: 'string'},
      measurements: {type: 'array', items: {type: 'object', properties: {name: {type: 'string'}, source: {type: 'string', description: 'The derived quantity name exactly as fit_motion returned it (e.g. "g", "e", "L"), or empty if not from a fit.'}, value: {type: 'number'}, sigma: {type: 'number'}, unit: {type: 'string'}, compare_to: {type: 'string'}}, required: ['name', 'source', 'value', 'sigma', 'unit', 'compare_to'], additionalProperties: false}},
      assumptions: {type: 'array', items: {type: 'string'}},
      forks: {type: 'array', description: '2-4 what-if experiments worth running on this footage.', items: {type: 'object', properties: {label: {type: 'string'}, g: {type: 'number', description: 'm/s², or -1 to keep'}, drag: {type: 'string', enum: ['keep', 'none']}, e: {type: 'number', description: 'restitution, or -1 to keep'}, why: {type: 'string'}}, required: ['label', 'g', 'drag', 'e', 'why'], additionalProperties: false}},
      confidence: {type: 'string', enum: ['high', 'medium', 'low']}},
    required: ['headline', 'answer', 'object', 'model', 'measurements', 'assumptions', 'forks', 'confidence'], additionalProperties: false}},
];

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'object';
const round = (v, n = 4) => typeof v === 'number' ? Number(v.toPrecision(n)) : v;

export class Lab {
  constructor({file, info, question, emit = () => {}}) {
    Object.assign(this, {file, info, question, emit});
    this.tracks = {};   // "prompt-slug:id" → [{frame, cx, cy, ...}] in pixels
    this.scale = null;  // {ppm, sigma_rel, ...}
    this.fits = {};     // "object|model" → fit result (metres)
    this.calls = 0;
  }

  async media() {
    if (!this._media) {
      const buf = fs.readFileSync(this.file);
      this.mediaHash = hashOf(buf);
      const f = await uploadFile(buf, 'clip.mp4', 'video/mp4');
      this._media = {file_id: f.id};
    }
    return this._media;
  }

  // ---- tools ---------------------------------------------------------------------------------------------------
  async track_objects({prompt}) {
    const media = await this.media();
    let seen = 0;
    const raw = await samSegment({media, mediaHash: this.mediaHash, prompt, frames: this.info.frames,
      onDelta: d => { seen += (d.match(/<\d+f>/g) || []).length; this.emit({type: 'sam', prompt, frames: seen, of: this.info.frames}); }});
    const result = await parseSam(raw);
    const tracks = tracksFrom(result);
    const out = [];
    for (const [id, pts] of Object.entries(tracks)) {
      const key = `${slug(prompt)}:${id}`;
      this.tracks[key] = pts;
      out.push(key);
    }
    const summary = summarise(Object.fromEntries(out.map(k => [k, this.tracks[k]])), this.info);
    this.emit({type: 'tracks', prompt, objects: out.map(k => ({key: k, points: this.tracks[k].map(p => [p.frame, round(p.cx, 5), round(p.cy, 5), round(p.across, 3)])}))});
    return {prompt, found: summary.length, objects: summary, note: summary.length ? undefined : 'No matches. Try a different noun phrase.'};
  }

  async set_scale({object, prompt, real_size_m, size_uncertainty_m, dimension, reason}) {
    let pts = object && this.tracks[object];
    if (object && !pts) return {error: `unknown object ${object}; known: ${Object.keys(this.tracks).join(', ')}`};
    if (!pts) {
      // Segment a static reference on the middle frame only (an image request is ~10x cheaper than a video).
      const mid = Math.floor(this.info.frames / 2);
      const {width, height, frames} = readFrames(this.file, {frames: [mid]});
      const jpg = encodeImage({width, height, data: frames[0].data});
      const raw = await samSegment({media: {image_url: dataUrl(jpg)}, mediaHash: hashOf(jpg), kind: 'image', prompt});
      const tracks = tracksFrom(await parseSam(raw));
      const best = Object.entries(tracks).map(([id, p]) => ({id, p, conf: p[0].conf ?? 0, area: p[0].area})).sort((a, b) => b.conf - a.conf || b.area - a.area)[0];
      if (!best) return {error: `SAM found no "${prompt}" on frame ${mid}`};
      pts = best.p.map(q => ({...q, frame: mid}));
      object = `${slug(prompt)}:${best.id}`;
      this.tracks[object] = pts;
    }
    const ref = referencePixels(pts, dimension);
    const ppm = ref.px / real_size_m;
    const sigma_rel = Math.hypot(ref.sigma_px / ref.px, size_uncertainty_m / real_size_m);
    this.scale = {object, ppm, sigma_rel, px: ref.px, real_size_m, dimension, reason};
    this.emit({type: 'scale', scale: this.scale});
    return {object, pixels: round(ref.px), pixels_per_metre: round(ppm), relative_uncertainty: round(sigma_rel, 2),
      note: sigma_rel > 0.1 ? 'Scale is uncertain by more than 10%; every length and g inherit it.' : undefined};
  }

  trackFor(object, first = -1, last = -1) {
    const pts = this.tracks[object];
    if (!pts) return null;
    const sel = pts.filter(p => (first < 0 || p.frame >= first) && (last < 0 || p.frame <= last));
    return sel.length >= 5 ? sel : null;
  }

  async fit_motion({object, models = [], fixed = {}, first_frame = -1, last_frame = -1}) {
    if (!this.scale) return {error: 'call set_scale first'};
    const pts = this.trackFor(object, first_frame, last_frame);
    if (!pts) return {error: `need ≥5 tracked frames of ${object}; known: ${Object.keys(this.tracks).join(', ')}`};
    const frameOffset = pts[0].frame;
    const track = toMetres(pts, {fps: this.info.fps, ppm: this.scale.ppm, frameOffset});
    const pinned = Object.keys(fixed || {}).length > 0;
    let fits, data, verdict;
    try {
      if (pinned && models.length === 1) { const r = fitModel(track, models[0], {fixed}); fits = [r.fit]; data = r.data; }
      else ({fits, data, verdict} = fitAll(track, {models: models.length ? models : undefined}));
    } catch (e) { return {error: String(e.message || e)}; }
    fits = fits.filter(f => f.applicable);
    for (const f of fits) {
      // The scale's uncertainty is systematic: it multiplies every length, so it adds in quadrature to each length-like value.
      for (const d of f.derived || []) if (/\bm\b|^m\b|m\/s|m\/s²/.test(d.unit || '') && Number.isFinite(d.sigma)) d.sigma_total = Math.hypot(d.sigma, Math.abs(d.value) * this.scale.sigma_rel);
      this.fits[`${object}|${f.model}`] = {...f, data, track: {origin_px: track.origin_px}, pts, ppm: this.scale.ppm, frameOffset, fps: this.info.fps,
        frames: [Math.round(frameOffset + data.t0 * this.info.fps), Math.round(frameOffset + (data.t0 + data.duration) * this.info.fps)]};
    }
    this.emit({type: 'fit', object, ranked: fits.map(r => ({model: r.model, bic: r.bic, derived: r.derived}))});
    return {object, samples: data.samples, frames_used: this.fits[`${object}|${fits[0]?.model}`]?.frames,
      trimmed_samples: data.trimmed_samples, noise_mm: round((data.noise_sigma_m || 0) * 1000, 2), verdict,
      ranked: fits.slice(0, 4).map(r => ({model: r.model, dBIC: r.dBIC ?? 0, rms_mm: round(r.rms * 1000, 3), rms_px: round(r.rms * this.scale.ppm, 3),
        outliers: r.outliers?.length || 0, fixed: r.fixed?.length ? r.fixed : undefined,
        derived: (r.derived || []).map(d => ({name: d.name, value: round(d.value), sigma: round(d.sigma_total ?? d.sigma, 2), unit: d.unit}))}))};
  }

  async check_overlay({object, model}) {
    const fit = this.fits[`${object}|${model}`];
    if (!fit) return {error: `no fit for ${object} with ${model}; run fit_motion first`};
    const [f0, f1] = fit.frames, n = 6;
    const idx = [...new Set(Array.from({length: n}, (_, k) => Math.round(f0 + k * (f1 - f0) / (n - 1))))];
    const {width, height, frames} = readFrames(this.file, {frames: idx});
    const px = predictPixels(fit, Array.from({length: f1 - f0 + 1}, (_, k) => f0 + k), this.info.fps);
    const radius = Math.max(4, (fit.pts[0].across || 20) / 2);
    let worst = 0;
    const tiles = frames.map(({index, data}) => {
      const img = {width, height, data: Buffer.from(data)};
      polyline(img, px.map(p => [p.x, p.y]), COLORS.fit, {width: 2, alpha: 0.9});
      for (const p of fit.pts) if (p.frame <= index) circle(img, p.cx, p.cy, 2.5, COLORS.measured);
      const pred = px.find(p => p.frame === index), meas = fit.pts.find(p => p.frame === index);
      if (pred) circle(img, pred.x, pred.y, radius, COLORS.ghost, {stroke: 3});
      if (pred && meas) worst = Math.max(worst, Math.hypot(pred.x - meas.cx, pred.y - meas.cy));
      return img;
    });
    const sheet = contactSheet(tiles, {cols: 3, scale: width > 900 ? 0.4 : 0.6});
    const jpg = encodeImage(sheet, 'jpeg', {quality: 4});
    this.emit({type: 'overlay', object, model, image: dataUrl(jpg)});
    this.pendingImages.push({text: `Overlay for ${object} with ${model} (frames ${idx.join(', ')}).`, url: dataUrl(jpg)});
    return {frames: idx, worst_error_px: round(worst, 3), object_radius_px: round(radius, 3), note: 'Picture attached in the next message.'};
  }

  // ---- loop ----------------------------------------------------------------------------------------------------
  async run({maxTurns = 14} = {}) {
    const media = await this.media();
    const {fps, frames, width, height, duration} = this.info;
    let input = [{type: 'message', role: 'user', content: [
      {type: 'input_text', text: `Question: ${this.question || 'What physics is happening here? Measure it.'}\n` +
        `Video: ${width}x${height}, ${fps.toFixed(3)} fps, ${frames} frames, ${duration.toFixed(2)} s. Frame n is at t = n / fps.`},
      {type: 'input_video', ...media}]}];
    let prev = null;
    for (let turn = 0; turn < maxTurns; turn++) {
      this.pendingImages = [];
      const r = await respond({model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, input, previous_response_id: prev || undefined,
        reasoning: {effort: 'medium'}, parallel_tool_calls: false}, {label: 'agent'});
      prev = r.id;
      const say = outputText(r);
      if (say) this.emit({type: 'say', text: say});
      const calls = functionCalls(r);
      if (!calls.length) {
        input = [{type: 'message', role: 'user', content: [{type: 'input_text', text: 'Please finish by calling final_report.'}]}];
        continue;
      }
      input = [];
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.arguments || '{}'); } catch { /* reported below */ }
        this.emit({type: 'call', name: call.name, args});
        if (call.name === 'final_report') {
          const report = this.finish(args);
          this.emit({type: 'report', report});
          return report;
        }
        let result;
        try { result = this[call.name] ? await this[call.name](args) : {error: `unknown tool ${call.name}`}; }
        catch (e) { result = {error: String(e.message || e).slice(0, 300)}; if (e.code === 'budget') throw e; }
        this.emit({type: 'result', name: call.name, result});
        input.push({type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result)});
      }
      for (const im of this.pendingImages) input.push({type: 'message', role: 'user', content: [{type: 'input_text', text: im.text}, {type: 'input_image', image_url: im.url}]});
    }
    throw new Error('the agent did not finish within its turn limit');
  }

  // Attach the chosen fit's numbers (from the tools, not the model) to the report the model wrote.
  finish(args) {
    const fit = this.fits[`${args.object}|${args.model}`] || Object.values(this.fits)[0];
    // Numbers shown to the reader are the tools' numbers: a measurement that names its source takes the fitted value
    // and its full uncertainty (statistical and scale), whatever the model typed.
    for (const m of args.measurements || []) {
      const d = fit?.derived?.find(q => q.name === m.source);
      if (d) Object.assign(m, {value: d.value, sigma: d.sigma_total ?? d.sigma, unit: d.unit, from_tool: true});
    }
    return {...args, fit: fit && {model: fit.model, p: fit.p, sigma: fit.sigma, data: fit.data, frames: fit.frames, frameOffset: fit.frameOffset,
      fps: fit.fps, ppm: fit.ppm, origin_px: fit.track.origin_px, derived: fit.derived, rms: fit.rms, dBIC: fit.dBIC}, scale: this.scale,
      tracks: Object.fromEntries(Object.entries(this.tracks).map(([k, v]) => [k, v.map(p => [p.frame, round(p.cx, 5), round(p.cy, 5), round(p.across, 3)])]))};
  }
}

// A fit (in metres, origin at the first tracked point, y up; model time starts at data.t0) → pixels for given frames.
export function predictPixels(fit, frames, fps = fit.fps) {
  const m = MODELS[fit.model];
  if (!m) throw new Error('unknown model ' + fit.model);
  const p = m.params.map(q => fit.p[q.name]);
  const t = frames.map(f => (f - fit.frameOffset) / fps - fit.data.t0);
  const {x, y} = m.predict(t, p);
  const [x0, y0] = fit.track.origin_px;
  return frames.map((f, i) => ({frame: f, x: x0 + x[i] * fit.ppm, y: y0 - y[i] * fit.ppm}));
}
