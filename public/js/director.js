// The director: paces a run so a person can follow it. Events from the server (a replay arrives in a few seconds, a live
// run in bursts after long waits) go into a queue; each becomes a beat, a chat message plus an act on the stage, held for a
// minimum dwell so that no change flashes by. Falling far behind a live run shortens the dwells; "Skip to results" flushes.
import {fetchMasks} from './masks.js';
import {esc, num, MODEL_NAME, keyValue, strayLine, STEPS} from './notebook.js';

const CANCEL = Symbol('cancel');
// Milliseconds. A normal beat is held ~2.5 s; the acts the eye must read (SAM's sweep, the fit drawing) get ~3 s.
export const T = {watch: 2400, call: 250, sweep: 2600, scale: 2000, fitDots: 700, fitCurve: 1700, fitHold: 300, overlayStep: 400,
  sayBase: 600, sayPerChar: 10, cps: 75, report: 3000, catchUp: 0.4, behind: 4};
const SAM = '#7c5cff', MEASURED = '#ffd60a', FIT = '#00c8ff', clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const unit = u => String(u ?? '').replace('^2', '²').replace('^3', '³');

export class Director {
  constructor({stage, nb, video, badge, hooks}) { Object.assign(this, {stage, nb, video, badge, hooks}); this.run = null; }
  // A new run replaces any that is still playing.
  start(clip) { this.cancel(); return this.run = new Run(this, clip); }
  cancel() { this.run?.kill(); this.run = null; }
  skip() { this.run?.skip(); }
  get playing() { return !!this.run && !this.run.finished; }
}

class Run {
  constructor(dir, clip) {
    Object.assign(this, {dir, clip, stage: dir.stage, nb: dir.nb, video: dir.video, badge: dir.badge, hooks: dir.hooks});
    Object.assign(this, {queue: [], waits: new Set(), dead: false, fast: false, pumping: false, finished: false, k: 1,
      objs: {}, masks: {}, fits: {}, jobs: new Map(), replay: false, arrived: 0, pending: null, samCard: null, watchLi: null, finalized: false, hasTrack: false});
    this.t0 = performance.now();
    this.finalP = Promise.resolve(this.hooks.final(clip)).catch(() => null);
    this.queue.push({type: '_watch'});
    this.pump();
  }

  // ---- intake -------------------------------------------------------------------------------------------------
  push(ev) {
    if (this.dead) return;
    // A saved run arrives in a burst; a live one never has four events within the first second and a half. Only a live
    // run is hurried when it falls behind: a replay is known to be short, so it is paced to its design.
    if (ev.type !== 'sam' && ++this.arrived >= 4 && performance.now() - this.t0 < 1500) this.replay = true;
    if (ev.type === 'tracks') this.jobs.set(ev, fetchMasks(this.clip.id, ev.prompt, ev.objects.map(o => o.key)).catch(() => null));
    this.queue.push(ev);
    this.pump();
  }
  skip() { this.fast = true; this.wake('skip'); this.hooks.busy?.(false); }
  kill() {
    this.dead = true; this.wake('cancel');
    const {stage, video} = this; stage.scene = null; video.pause(); video.playbackRate = 1; this.badge.hidden = true;
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.dead) {
        this.k = !this.replay && this.queue.length > T.behind ? T.catchUp : 1;
        const ev = this.queue.shift();
        await this.beat(ev);
      }
    } catch (e) { if (e !== CANCEL) console.error(e); }
    this.pumping = false;
  }

  // ---- timing helpers -----------------------------------------------------------------------------------------
  d(ms) { return ms * this.k; }
  wake(kind) { for (const w of [...this.waits]) { w.stop(); this.waits.delete(w); kind === 'cancel' ? w.rej(CANCEL) : w.res(); } }
  wait(setup) { // setup(res) -> stop(); resolves on its own, on skip, or throws CANCEL on kill
    if (this.dead) return Promise.reject(CANCEL);
    if (this.fast) return Promise.resolve();
    return new Promise((res, rej) => { const w = {rej, res: () => { w.fin?.(); res(); }}; w.stop = setup(() => { this.waits.delete(w); res(); }); this.waits.add(w); });
  }
  sleep(ms) { return ms > 0 ? this.wait(done => { const t = setTimeout(done, ms); return () => clearTimeout(t); }) : this.alive(); }
  alive() { return this.dead ? Promise.reject(CANCEL) : Promise.resolve(); }
  // Calls fn(0..1) on every frame for ms; a skip jumps to fn(1).
  anim(ms, fn) {
    if (this.dead) return Promise.reject(CANCEL);
    if (this.fast || ms <= 0) { fn(1); return Promise.resolve(); }
    return new Promise((res, rej) => {
      const t0 = performance.now(); let id;
      const w = {rej, res: () => { fn(1); res(); }, stop: () => cancelAnimationFrame(id)};
      const step = now => { const t = clamp((now - t0) / ms, 0, 1); fn(t); if (t < 1) id = requestAnimationFrame(step); else { this.waits.delete(w); res(); } };
      this.waits.add(w); id = requestAnimationFrame(step);
    });
  }
  // Holds the beat until `ms` have passed since it began.
  async hold(since, ms) { await this.sleep(this.d(ms) - (performance.now() - since)); }
  async type(el, text) {
    el.classList.add('typing');
    await this.anim(text.length / T.cps * 1000, t => { el.textContent = text.slice(0, Math.ceil(t * text.length)); this.nb.scroll(); });
    el.classList.remove('typing');
  }
  info() { return this.hooks.info(); }
  say(text) { this.badge.hidden = !text; if (text) this.badge.textContent = text; }

  // ---- the stage's acts ---------------------------------------------------------------------------------------
  rest() {
    const {stage, video} = this; stage.scene = null; video.pause(); video.playbackRate = 1;
    stage.seek(this.hasTrack ? Math.max(0, this.info().frames - 1) : 0);
    this.say('');
  }
  seekTo(f) {
    const {video, stage} = this; video.pause(); stage.stopFreeRun();
    return new Promise(res => {
      const t = setTimeout(res, 700); video.addEventListener('seeked', () => { clearTimeout(t); res(); }, {once: true});
      video.currentTime = (f + 0.5) / this.info().fps;
    }).then(() => this.alive());
  }
  // Plays the clip once from the start in `ms` (faster than real time for a long clip, never slower).
  playOnce(ms) {
    const {video} = this, info = this.info();
    if (this.fast || this.dead) return this.alive();
    video.pause(); video.currentTime = 0; video.playbackRate = clamp((video.duration || info.duration || 3) * 1000 / ms, 1, 8);
    return this.wait(done => {
      video.addEventListener('ended', done, {once: true}); const t = setTimeout(done, ms + 1500);
      video.play().catch(done);
      return () => { clearTimeout(t); video.removeEventListener('ended', done); video.pause(); };
    }).finally(() => { video.pause(); video.playbackRate = 1; });
  }
  settleWatch() { this.nb.settle(this.watchLi); this.nb.complete(this.watchLi); this.watchLi = null; }

  // ---- beats --------------------------------------------------------------------------------------------------
  async beat(ev) {
    const since = performance.now();
    switch (ev.type) {
      case '_watch': return this.watch(since);
      case 'say': return this.spark(ev, since);
      case 'call': return this.call(ev, since);
      case 'sam': if (!this.replay && !this.fast) this.nb.setBar(this.samCard, ev.frames / Math.max(1, ev.of)); return;
      case 'tracks': return this.tracks(ev);
      case 'scale': return this.scale(ev);
      case 'overlay': return this.overlay(ev);
      case 'result': return this.result(ev);
      case 'report': return this.report(ev);
      case 'error': this.settleWatch(); this.nb.settle(this.pending); this.nb.msg('err', esc(ev.message)); return this.end(ev);
      case 'done': return this.done(ev);
    }
  }

  // Spark looks at the clip: it plays once under a light sweep and a soft vignette.
  async watch(since) {
    this.watchLi = this.nb.msg('spark', 'Muse Spark is watching the clip…', {busy: true, step: STEPS.watch});
    const {stage} = this, ms = this.d(T.watch);
    this.say('Muse Spark watching');
    stage.scene = (s, f) => {
      const {ctx} = s, W = s.data.width, H = s.data.height, t = f / Math.max(1, this.info().frames - 1);
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      vg.addColorStop(0, 'rgba(0,10,20,0)'); vg.addColorStop(1, 'rgba(0,10,20,0.55)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
      const x = ((t * 2) % 1) * W * 1.2 - 0.1 * W, g = ctx.createLinearGradient(x - 0.14 * W, 0, x + 0.02 * W, 0);
      g.addColorStop(0, 'rgba(0,200,255,0)'); g.addColorStop(1, 'rgba(0,200,255,0.30)'); ctx.fillStyle = g; ctx.fillRect(x - 0.14 * W, 0, 0.16 * W, H);
      ctx.fillStyle = FIT; ctx.fillRect(x + 0.02 * W - s.scale(), 0, 2 * s.scale(), H);
    };
    stage.setAnalysis({});
    await this.playOnce(ms);
    this.rest();
    await this.hold(since, T.watch);
  }

  async spark(ev, since) {
    if (strayLine(ev.text)) return;
    this.settleWatch();
    const li = this.nb.msg('spark', '<span class="say"></span>', {step: STEPS.say});
    await this.type(li.querySelector('.say'), ev.text);
    await this.hold(since, T.sayBase + T.sayPerChar * ev.text.length);
    this.nb.complete(li);
  }

  async call(ev, since) {
    this.settleWatch(); this.nb.settle(this.pending);
    const li = this.pending = this.nb.toolCall(ev.name, ev.args);
    if (ev.name === 'track_objects') this.samCard = li;
    await this.hold(since, T.call);
  }

  async result(ev) {
    const li = this.pending, r = ev.result, nb = this.nb; this.pending = null;
    nb.settle(li);
    if (!li) return;
    if (r?.error) { nb.warn(li, r.error); return nb.complete(li); }
    if (ev.name === 'track_objects') nb.trackTable(li, r);
    else if (ev.name === 'set_scale') nb.scaleLine(li, r);
    else if (ev.name === 'fit_motion') await this.fit(li, r);
    else if (ev.name === 'check_overlay') nb.checkLine(li, r);
    nb.complete(li);
  }

  // SAM 3.1: the clip sweeps by with the object's mask filled and outlined, and its centre left behind as a dot per frame.
  async tracks(ev) {
    const {stage} = this, info = this.info(), since = performance.now();
    for (const o of ev.objects) this.objs[o.key] = {prompt: ev.prompt, points: o.points};
    const list = [...ev.objects].sort((a, b) => b.points.length - a.points.length).slice(0, 4);
    const best = list[0];
    this.hasTrack = true;
    if (this.fast || !best) { if (best) stage.setAnalysis({track: best.points}); return; }
    // The masks were being fetched since the event arrived; a replay is rarely kept waiting for them.
    const by = await Promise.race([this.jobs.get(ev), new Promise(r => setTimeout(() => r(null), 2500))]);
    await this.alive();
    for (const o of list) if (by?.[o.key]?.size) this.masks[o.key] = by[o.key];
    stage.setAnalysis({track: null});
    const ms = this.d(T.sweep), N = info.frames;
    stage.scene = (s, f) => {
      const {ctx} = s;
      for (const o of list) if (this.masks[o.key]) s.drawMaskOutlined(f, this.masks[o.key], 'rgba(124,92,255,0.42)', SAM);
      for (const o of list) s.dots(o.points.filter(p => p[0] <= f), MEASURED);
      // Without a mask for this frame, a ring on the tracked centre shows what SAM found.
      for (const o of list) if (!this.masks[o.key]?.get(f)) { const p = o.points.find(q => q[0] === f); if (p) s.ring(p[1], p[2], Math.max(6, (p[3] || 20) / 2), SAM); }
      this.say(`SAM 3.1 · frame ${Math.min(N, f + 1)} / ${N}`);
      if (this.replay) this.nb.setBar(this.samCard, (f + 1) / N);
    };
    await this.playOnce(ms);
    stage.setAnalysis({track: best.points});
    this.rest();
    await this.hold(since, T.sweep);
  }

  // A frozen frame and a bracket across the scale object, labelled with what the agent says it measures.
  async scale(ev) {
    const s = ev.scale, since = performance.now(), {stage} = this;
    const real = String(+Number(s.real_size_m).toPrecision(3)), text = `${real} m = ${Math.round(s.px)} px`;
    if (this.fast) return;
    const masks = this.masks[s.object], dim = s.dimension;
    const size = m => { const w = m.right - m.left, h = m.bottom - m.top; return dim === 'shortest' ? Math.min(w, h) : dim === 'diameter' ? (w + h) / 2 : Math.max(w, h); };
    let frame = 0, rec = null;
    if (masks?.size) { let best = Infinity; for (const [f, m] of masks) { const e = Math.abs(size(m) - s.px); if (e < best) { best = e; frame = f; rec = m; } } }
    this.say('Lab · setting the scale');
    stage.setAnalysis({});
    await this.seekTo(frame);
    const bracket = t => {
      stage.scene = (st) => {
        const {ctx} = st, k = st.scale();
        if (!rec) return st.label(st.data.width / 2, st.data.height / 2, text, MEASURED);
        st.drawMaskOutlined(frame, masks, 'rgba(255,214,10,0.22)', MEASURED);
        const w = rec.right - rec.left, h = rec.bottom - rec.top, horiz = dim === 'diameter' ? true : dim === 'shortest' ? w < h : w >= h, off = 12 * k;
        const [x0, y0, x1, y1] = horiz ? [rec.left, rec.top - off, rec.right, rec.top - off] : [rec.right + off, rec.top, rec.right + off, rec.bottom];
        // Grows from one end; the end caps and the label follow.
        const ex = x0 + (x1 - x0) * t, ey = y0 + (y1 - y0) * t;
        ctx.save(); ctx.strokeStyle = MEASURED; ctx.lineWidth = 2.5 * k; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(ex, ey);
        const cap = (x, y) => horiz ? (ctx.moveTo(x, y - 7 * k), ctx.lineTo(x, y + 7 * k)) : (ctx.moveTo(x - 7 * k, y), ctx.lineTo(x + 7 * k, y));
        cap(x0, y0); if (t > 0.98) cap(x1, y1); ctx.stroke(); ctx.restore();
        if (t > 0.5) st.label(horiz ? (x0 + x1) / 2 : x1 + off, horiz ? y0 - 18 * k : (y0 + y1) / 2, text, MEASURED, {align: horiz ? 'center' : 'left'});
      };
      stage.redraw();
    };
    await this.anim(this.d(700), bracket);
    await this.hold(since, T.scale);
    this.rest();
  }

  // Fit: the measured dots appear, then the best law's curve draws itself along them, labelled with its key value.
  async fit(li, r) {
    const {stage} = this, since = performance.now(), best = r.ranked?.[0];
    if (!best) { this.nb.warn(li, r.verdict?.reason || 'no law fits'); return; }
    const pts = this.objs[r.object]?.points || [], range = r.frames_used || [0, Infinity];
    let seg = pts.filter(p => p[0] >= range[0] && p[0] <= range[1]), curve = null;
    const final = await Promise.race([this.finalP, new Promise(res => setTimeout(() => res(null), 1500))]);
    await this.alive();
    // The curve is the server's own fit when this is the fit the saved run reports; otherwise (an earlier or live
    // fit) a quick least-squares polynomial through the dots, drawn only for the laws a polynomial can stand for.
    const same = final && final.model === best.model && final.object === r.object && final.frames?.[0] === range[0] && final.frames?.[1] === range[1];
    // (the dots are then the points the fit followed, which for an edge-tracked rocket are not the centroids)
    if (same) { curve = final.fitPath; seg = final.measured || seg; }
    else curve = polyCurve(seg, best.model, range);
    const kv = keyValue(best), label = `${MODEL_NAME[best.model] || best.model}${kv.text ? ' · ' + kv.text : ''}`;
    for (const m of r.ranked) this.fits[m.fit_id] = {curve, seg, range, label};
    this.lastFit = {curve, seg, range, label};
    if (this.fast) { stage.setAnalysis({track: seg, fitPath: curve}); this.rest(); return this.nb.fitTable(li, r, this, 0); }
    this.say('Lab · fitting laws of motion');
    stage.setAnalysis({});
    await this.seekTo(seg[0]?.[0] ?? range[0]);
    const show = {n: 0, c: 0};
    const draw = () => {
      stage.scene = st => {
        st.dots(seg.slice(0, Math.ceil(show.n * seg.length)), MEASURED);
        if (curve && show.c > 0) st.curve(curve.slice(0, Math.max(2, Math.ceil(show.c * curve.length))), FIT, 3);
        if (show.c > 0.85) { this.say(label); }
      };
      stage.redraw();
    };
    const acts = (async () => {
      await this.anim(this.d(T.fitDots), t => { show.n = t; draw(); });
      await this.anim(this.d(T.fitCurve), t => { show.c = t; draw(); });
      this.say(label);
    })();
    await Promise.all([acts, this.nb.fitTable(li, r, this, this.d(330))]);
    stage.setAnalysis({track: seg, fitPath: curve});
    await this.hold(since, T.fitDots + T.fitCurve + T.fitHold);
    this.rest();
  }

  // The check image in the chat; on the stage, six frames of the fitted stretch, the curve and a ring where the law says the object is.
  async overlay(ev) {
    const since = performance.now(), {stage} = this, fit = this.fits[ev.fit_id] || this.lastFit;
    this.nb.image(this.pending || this.nb.msg('lab', ''), ev.image);
    if (this.fast || !fit) return;
    const {seg, curve, range} = fit, f0 = seg[0]?.[0] ?? range[0], f1 = seg.at(-1)?.[0] ?? range[1], n = 6;
    const frames = [...new Set(Array.from({length: n}, (_, i) => Math.round(f0 + i * (f1 - f0) / (n - 1))))];
    stage.setAnalysis({});
    for (const [i, f] of frames.entries()) {
      this.say(`Lab · checking the fit · frame ${f} (${i + 1}/${frames.length})`);
      stage.scene = st => {
        st.dots(seg.filter(p => p[0] <= f), MEASURED);
        if (curve) st.curve(curve, FIT, 2.5);
        const p = curve?.reduce((a, q) => Math.abs(q[0] - f) < Math.abs(a[0] - f) ? q : a, curve[0]);
        if (p) st.ring(p[1], p[2], st.radius() * 1.3, '#ffffff');
      };
      await this.seekTo(f);
      stage.redraw();
      await this.sleep(this.d(T.overlayStep));
    }
    this.rest();
    await this.hold(since, T.overlayStep * frames.length);
  }

  // The report card; the clip plays once with the fit over it; the fork bar appears and is pointed at.
  async report(ev) {
    this.settleWatch(); this.nb.settle(this.pending); this.pending = null;
    this.nb.report(ev.report);
    this.say('');
    await this.finalize(ev.report);
    if (this.fast) return this.revealForks(true);
    const since = performance.now();
    this.stage.scene = null; this.stage.setAnalysis({});
    await this.playOnce(this.d(T.report));
    this.rest();
    await this.hold(since, T.report);
    await this.revealForks();
  }
  // With a report given, only a saved run whose report is that one is loaded: a live run is saved after its report, and
  // until then the clip's latest saved run is an older question's.
  async finalize(report) {
    if (this.finalized) return;
    this.finalized = !!(await this.hooks.finalize(this.clip, report));
    await this.alive();
  }
  async revealForks(instant) {
    this.nb.msg('lab', 'Now fork reality: press the shimmering Reality Fork button on the video, pick a world, and the clip replays with the physics changed.', {step: ['The lab is inviting you to fork reality', 'The lab invited you to fork reality']});
    this.hooks.reveal(instant);
    if (!instant) await this.sleep(500);
  }

  async done(ev) {
    this.settleWatch(); this.nb.settle(this.pending); this.pending = null;
    // A live run is saved only after its report, so the report beat may have found nothing to load yet.
    if (!this.finalized) { await this.finalize(); if (this.finalized) this.hooks.reveal(false); }
    return this.end(ev);
  }
  end(ev) {
    this.finished = true; this.stage.scene = null; this.say('');
    this.nb.state.textContent = ev.type === 'error' ? '' : ev.replay ? 'replayed from a saved run' : 'done';
    this.hooks.finished(ev, this.clip);
  }
}

// ---- a quick curve through the dots, for the laws a polynomial can stand for ----------------------------------------
function polyCurve(seg, model, [f0, f1]) {
  if (seg.length < 4) return null;
  const degs = {'constant-velocity': [1, 1], projectile: [1, 2], 'projectile-drag': [2, 2], incline: [2, 2]}[model];
  if (!degs) return null; // bouncing, pendulum, oscillation: a polynomial would be a false picture
  const a = seg[0][0], b = seg.at(-1)[0], u = f => (f - a) / Math.max(1, b - a);
  const cx = polyfit(seg.map(p => u(p[0])), seg.map(p => p[1]), degs[0]), cy = polyfit(seg.map(p => u(p[0])), seg.map(p => p[2]), degs[1]);
  if (!cx || !cy) return null;
  const ev = (c, x) => c.reduce((s, v, i) => s + v * x ** i, 0), out = [];
  for (let f = a; f <= b; f++) out.push([f, ev(cx, u(f)), ev(cy, u(f))]);
  return out;
}
function polyfit(xs, ys, deg) {
  const n = deg + 1, A = Array.from({length: n}, () => Array(n + 1).fill(0));
  xs.forEach((x, i) => { for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) A[r][c] += x ** (r + c); A[r][n] += ys[i] * x ** r; } });
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-12) return null;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < n; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c]; }
  }
  return A.map((row, i) => row[n] / row[i]);
}
