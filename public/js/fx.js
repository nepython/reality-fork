// The fork's visual effects: impact, skid, dust, trails, ambient light. Everything is a pure function of the stage's
// time `stage.ft` (a fractional frame number) and the fork's own numbers (path, hazard, floor, summary), so a still, a
// scrub and a saved clip show the same picture, and no effect keeps state between frames. Particles are "spawned" at fixed
// frames and their position is computed from their age; their count is bounded by life / spawn interval.
// Effects scale with real quantities (impact speed, braking distance, landing speed, thrust) and never move anything the
// physics placed: the car's path, the ball's path and the callout's numbers are exactly the response's. What fx.js adds
// is the story told around them. The honest exception is the knocked person: the server has no model of a body being
// thrown, so the throw's distance and height are a visual scale of the impact speed (stronger at 50 than at 32 km/h),
// compressed to fit the room left in the picture.
import {pedestrian} from './pedestrian.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const easeOut = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const hash = (a, b = 0) => { const x = Math.sin(a * 127.1 + b * 311.7 + 7.7) * 43758.5453; return x - Math.floor(x); };
const PINK = '#ff40a0';
// A soft round puff (a radial fade, so overlapping puffs read as smoke or dust rather than flat discs).
const puff = (ctx, x, y, r, rgb, a) => {
  if (a <= 0.004 || r <= 0.5) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(0.55, `rgba(${rgb},${a * 0.55})`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
};
const SLOW = 0.3, SLOW_BEFORE = 0.4, SLOW_AFTER = 0.6;      // slow motion around a hit: seconds of footage at 0.3x

export class Fx {
  constructor(stage) { this.s = stage; this.kind = null; this.sched = []; this.lastEv = null; }

  // ---- analysis (once per fork) ----------------------------------------------------------------------------------
  setup() {
    const s = this.s, d = s.data, path = d.forkPath, hz = s.hazard;
    this.kind = null; this.sched = []; this.lastEv = null; this.contacts = []; this.world = null; this.hit = false;
    this.rm = (() => { try { return !!matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
    if (!path || path.length < 3 || !d.fps) return;
    this.fps = d.fps; this.k = d.width / 1280; this.ppm = d.ppm || 30; this.f0 = path[0][0]; this.fN = path.at(-1)[0];
    this.b = s.spriteBox(); this.n = path.length;
    const lab = s.forkLabel || '';
    this.world = /moon/i.test(lab) ? 'moon' : /mars/i.test(lab) ? 'mars' : /jupiter/i.test(lab) ? 'jupiter' : null;
    if (hz?.outcome && hz.event) return this.setupHazard(hz);
    this.setupMotion();
  }

  pos(ft) {                                              // the fork's path at a fractional frame, held at both ends
    const p = this.s.data.forkPath, i = clamp(ft - this.f0, 0, this.n - 1), a = Math.floor(i), c = Math.min(this.n - 1, a + 1), t = i - a;
    return [p[a][1] + (p[c][1] - p[a][1]) * t, p[a][2] + (p[c][2] - p[a][2]) * t];
  }
  vel(ft, w = 2) { const a = this.pos(ft - w), c = this.pos(ft + w); return [(c[0] - a[0]) / (2 * w), (c[1] - a[1]) / (2 * w)]; }   // px per frame

  // ---- a car at a crossing ---------------------------------------------------------------------------------------
  setupHazard(hz) {
    const s = this.s, d = s.data, path = d.forkPath, fps = this.fps, b = this.b, ev = hz.event, ou = hz.outcome, hit = ou.kind === 'hits';
    this.kind = hit ? 'hit' : 'stop'; this.hz = hz; this.hit = hit;
    this.dir = Math.sign(path.at(-1)[1] - path[0][1]) || 1;
    this.tall = s.personH(); this.px = hz.x_px;
    const kmh = hit ? ou.impact_kmh : (hz.speed_kmh ?? 30), reactF = hz.step_out_frame + hz.react_s * fps;
    this.vint = clamp((hz.speed_kmh ?? 30) / 45, 0.35, 1);
    // First touch: the car's front reaches the person (the footage's car is a cut-out, so its front is the sprite's edge, not
    // the fit's centroid that the strip's "at the crossing" frame refers to; the touch comes a little earlier than that frame).
    let Fc = ev.frame;
    if (hit) {
      const hx = this.px - this.dir * 0.12 * this.tall, q = path.find(q => this.dir > 0 ? q[1] + b.r >= hx : q[1] + b.l <= hx);
      if (q) Fc = clamp(q[0], this.f0, ev.frame);
    }
    this.Fc = Fc; this.Fs = ev.frame;
    this.Tc = 0.12;                                      // seconds the car takes to stop after a hit
    this.brakeS = hit ? Math.min(Fc, Math.max(this.f0, reactF)) : clamp(reactF, this.f0, ev.frame);
    this.brakeE = hit ? Fc + this.Tc * fps : ev.frame;
    // Strength 0..1.1 from the impact speed: 3 m/s is a bump, 14 m/s (50 km/h) a hard throw.
    const v = kmh / 3.6; this.str = clamp((v - 3) / 11, 0.15, 1.1); this.kmh = kmh;
    if (hit) {
      const [vx, vy] = this.vel(Fc); this.carV = [vx * fps, vy * fps];          // px per second at the touch
      this.setupThrow();
    } else {
      this.look = {from: ev.frame - 0.7 * fps, to: ev.frame + 0.9 * fps};
    }
    // Sound, on the media clock; durations in real seconds.
    const sched = [];
    const bd = hit ? this.realBetween(this.brakeS, this.brakeE) : (this.brakeE - this.brakeS) / fps;
    if (bd > 0.12) sched.push([this.brakeS, 'skid', {dur: bd, level: 0.35 + 0.65 * this.vint}]);
    if (hit) {
      sched.push([Fc, 'impact', {kmh}]);
      sched.push([Fc + 0.03 * fps, 'whoosh', {dur: this.realBetween(Fc, Fc + this.T1 * fps), level: 0.35 + 0.5 * this.str}]);
      sched.push([Fc + this.T1 * fps, 'thump', {speed: 3 + 6 * this.str}]);
      sched.push([Fc + this.T1 * fps + 0.05 * fps, 'scrape', {dur: this.realBetween(Fc + this.T1 * fps, Fc + (this.T1 + this.T2) * fps), level: 0.3 + 0.5 * this.str}]);
    } else sched.push([ev.frame + 0.05 * fps, 'chime', {}]);
    this.sched = sched.sort((a, c) => a[0] - c[0]);
  }

  setupThrow() {
    const s = this.s, ppm = this.ppm, W = s.data.width, tall = this.tall, str = this.str, dir = this.dir;
    const room = (dir > 0 ? W - this.px - 0.1 * W : this.px - 0.1 * W);
    // Distance: the physical scale (0.045 v² metres) would carry the person out of the picture at 50 km/h, so it is mapped
    // linearly with strength into the room that is left. Height and spin scale with strength too.
    this.D = room * 0.92 * clamp(0.35 + 0.65 * str, 0.4, 1.0);
    this.H = (0.18 + 0.9 * clamp(str, 0, 1.1)) * ppm;                 // apex above the road, px
    this.T1 = 0.42 + 0.26 * clamp(str, 0, 1.1); this.T2 = 0.5 + 0.5 * clamp(str, 0, 1.1);
    this.spin = dir * (Math.PI / 2 + (str > 0.8 ? 2 * Math.PI : 0));
    // The road row the person stood on at the touch, where they will slide.
    const hz = this.hz, p = Math.min(1, (this.Fc - hz.step_out_frame) / this.fps / 2.2);
    this.footY = hz.y_px + Math.max(0, this.b.b) + (0.2 - 0.34 * p) * tall;
    // The car carries on a little while it brakes hard (and never past the person's rest place).
    // The car carries on a little while it brakes hard; the person comes to rest clear of its front.
    this.carStop = Math.abs(this.carV[0]) * this.Tc / 2;
    this.D = Math.max(this.D, this.carStop + 0.45 * tall, 0.5 * tall);
  }

  // Real seconds between two frames when the slow motion around the touch applies.
  realBetween(f1, f2) { return this.hit ? this.real((f2 - this.Fc) / this.fps) - this.real((f1 - this.Fc) / this.fps) : (f2 - f1) / this.fps; }
  // Real seconds since the touch, for t seconds of footage after it (and before it, t < 0, one-to-one outside the slow window).
  real(t) { if (this.rm) return t; return t < -SLOW_BEFORE ? t - SLOW_BEFORE * (1 / SLOW - 1) : t <= SLOW_AFTER ? t / SLOW : t - SLOW_AFTER + SLOW_AFTER / SLOW; }

  /** Playback speed for the frame: slow motion around a hit, 1 elsewhere (and always 1 under reduced motion). */
  rate(ft = this.s.ft) {
    if (!this.hit || this.rm) return 1;
    const t = (ft - this.Fc) / this.fps;
    return t >= -SLOW_BEFORE && t <= SLOW_AFTER ? SLOW : 1;
  }
  // Real seconds since the touch at the current time.
  rt() { return this.real((this.s.ft - this.Fc) / this.fps); }

  /** Where the forked car is: the path, but a car that hit someone brakes hard and stops a few metres on. */
  carPos(frame) {
    const ft = this.s.ft, d = this.s.data;
    if (!this.hit) { const q = this.pos(Math.min(ft, this.fN)); return [frame, q[0], q[1]]; }
    const q = this.pos(Math.min(ft, this.Fc)), t = Math.max(0, (ft - this.Fc) / this.fps), Tc = this.Tc;
    const u = Math.min(t, Tc), run = u - u * u / (2 * Tc);
    return [frame, q[0] + this.carV[0] * run, q[1] + this.carV[1] * run];
  }

  /** The car's nose dip: braking leans it forward, the release rocks it back. Radians, sign by travel direction. */
  carPitch() {
    if (this.rm || !this.hz) return 0;
    const ft = this.s.ft, fps = this.fps;
    const pb = 0.017 * this.vint, ramp = ease((ft - this.brakeS) / (0.3 * fps));
    let p = ft < this.brakeE ? pb * ramp : pb * Math.exp(-(ft - this.brakeE) / fps / 0.3) * Math.cos(2 * Math.PI * 1.4 * (ft - this.brakeE) / fps);
    if (this.hit) { const t = (ft - this.Fc) / fps; if (t >= 0) p += 0.045 * Math.exp(-t / 0.2) * Math.cos(2 * Math.PI * 1.6 * t); }
    return p * this.dir;
  }

  // ---- the person -----------------------------------------------------------------------------------------------
  /** Pose of the person while they have not been hit: eyes toward the car, arms up a little; or a stop: a look, then on. */
  personPose() {
    const ft = this.s.ft, fps = this.fps, hz = this.hz;
    if (!hz || !this.kind) return {};
    if (this.hit) {
      const a = ease((ft - (this.Fc - 0.55 * fps)) / (0.4 * fps));
      return {look: -this.dir * a, flail: 0.3 * a};
    }
    const l = this.look, a = ease((ft - l.from) / (0.35 * fps)) * (1 - ease((ft - (l.to - 0.35 * fps)) / (0.35 * fps)));
    return {look: -this.dir * a, flail: 0};
  }
  /** After a stop short, the person walks on a little further up the road. */
  stepOn() { return this.kind === 'stop' ? 0.45 * ease((this.s.ft - this.Fs) / (1.4 * this.fps)) : 0; }

  // The knocked person's state at t seconds (footage time) after the touch.
  throwAt(t) {
    const {T1, T2, D, H, dir, spin, tall} = this, u = clamp(t / T1, 0, 1), D1 = 0.6 * D;
    const th = spin * easeOut(u), ext = a => 0.49 * tall * Math.abs(Math.cos(a)) + 0.2 * tall * Math.abs(Math.sin(a));
    let X, h;
    if (t <= T1) { X = D1 * u; h = 4 * H * u * (1 - u); }
    else {
      const w = clamp((t - T1) / T2, 0, 1); X = D1 + (D - D1) * (1 - Math.pow(1 - w, 2.2));
      const hop = clamp((t - T1) / 0.32, 0, 1); h = 4 * 0.2 * H * hop * (1 - hop);
    }
    return {x: this.px + dir * X, y: this.footY - ext(th) - h, th, h, air: t > 0 && t < T1, slide: t > T1 && t < T1 + T2, sp: t < T1 ? 1 : Math.max(0, 1 - (t - T1) / T2)};
  }
  /** Draws the person as the flung silhouette (the same filled figure, rotated). Returns false before the touch. */
  drawKnocked(ctx) {
    const ft = this.s.ft, fps = this.fps;
    if (!this.hit || ft < this.Fc) return false;
    const t = (ft - this.Fc) / fps, tall = this.tall;
    if (this.rm) {                                         // reduced motion: they are simply down on the road, faded in
      const st = this.throwAt(1e3); ctx.save(); ctx.globalAlpha = ease(t / 0.4); this.figure(ctx, st, 0); ctx.restore(); return true;
    }
    // Motion trail: earlier copies, fainter, while they are moving fast.
    for (let i = 4; i >= 1; i--) {
      const tt = t - i * 0.03; if (tt < 0) continue;
      const g = this.throwAt(tt), sp = this.throwAt(t).sp;
      if (sp < 0.2) continue;
      ctx.save(); ctx.globalAlpha = 0.2 * (1 - i / 5) * sp; this.figure(ctx, g, t); ctx.restore();
    }
    this.figure(ctx, this.throwAt(t), t); return true;
  }
  figure(ctx, st, t) {
    const tall = this.tall, fl = this.rm ? 0 : clamp(Math.sin(Math.PI * clamp(t / this.T1, 0, 1)) * (0.45 + 0.55 * this.str), 0, 1);
    ctx.save(); ctx.translate(st.x, st.y); ctx.rotate(st.th);
    pedestrian(ctx, 0, 0.49 * tall, tall, 0.3, {shadow: false, flail: fl, look: 0});
    ctx.restore();
  }

  // ---- layers -----------------------------------------------------------------------------------------------------
  // The tyre contact line under the car: the sprite's near edge, where its wheels meet the road.
  wheelLine(p) {
    const m = this.s.data.spriteMeta, point = this.s.data.point;
    const ax = point === 'top' ? m.tx : point === 'bottom' ? m.bx : m.cx, ay = point === 'top' ? m.ty : point === 'bottom' ? m.by : m.cy;
    const left = p[1] - (ax - m.left), top = p[2] - (ay - m.top);
    return {left, w: m.width, h: m.height, y: top + m.height * 0.955, front: left + m.width * (this.dir > 0 ? 0.82 : 0.18), rear: left + m.width * (this.dir > 0 ? 0.2 : 0.8)};
  }

  /** Drawn on the road before the car: skid marks, the person's shadow and slide mark; the other clips' under-glow. */
  under(ctx) {
    const kind = this.kind; if (!kind) return;
    if (kind === 'hit' || kind === 'stop') { this.skidMarks(ctx); this.personShadow(ctx); }
    else if (kind === 'launch') this.exhaust(ctx);
    else if (kind === 'swing') this.ribbon(ctx);
    else if (kind === 'roll') this.rollDust(ctx);
    else if (kind === 'drift' || kind === 'flight' && !this.contacts.length) this.speedLines(ctx);
    if (kind !== 'hit' && kind !== 'stop') this.glowTrail(ctx);
    if (this.contacts.length) this.contactFx(ctx);
  }
  /** Drawn after the car: tyre smoke, the contact puffs of a bounce. */
  over(ctx) {
    if (this.kind === 'hit' || this.kind === 'stop') this.smoke(ctx);
  }

  skidMarks(ctx) {
    const ft = this.s.ft, fps = this.fps; if (ft < this.brakeS + 1) return;
    const at = f => this.wheelLine(this.carAt(f)), cur = at(Math.min(ft, this.brakeE)), st = at(this.brakeS);
    const x0 = st.front, x1 = cur.front, len = Math.abs(x1 - x0); if (len < 2) return;
    const hw = Math.max(3, cur.h * 0.04), lvl = 0.5 + 0.35 * this.vint;
    ctx.save(); ctx.lineCap = 'butt';
    for (const [dy, a] of [[0, 1], [-cur.h * 0.075, 0.7]]) {          // near-side and far-side tyres
      const g = ctx.createLinearGradient(x0, 0, x1, 0); g.addColorStop(0, 'rgba(8,8,12,0)'); g.addColorStop(Math.min(0.5, 36 / len), `rgba(8,8,12,${lvl * a})`); g.addColorStop(1, `rgba(8,8,12,${lvl * a})`);
      ctx.strokeStyle = g; ctx.lineWidth = hw * (a === 1 ? 1 : 0.8);
      ctx.beginPath(); ctx.moveTo(x0, cur.y + dy); ctx.lineTo(x1, cur.y + dy); ctx.stroke();
    }
    ctx.restore();
  }
  carAt(f) {                                           // the car's drawn position at a frame (same rule as carPos)
    const keep = this.s.ft; this.s.ft = f; const r = this.carPos(Math.round(f)); this.s.ft = keep; return r;
  }

  smoke(ctx) {
    if (this.rm) return;
    const ft = this.s.ft, fps = this.fps, life = 1.1, step = 3;
    const bs = this.brakeS, be = Math.min(ft, this.brakeE); if (be <= bs) return;
    const first = Math.max(bs, ft - life * fps), a0 = Math.ceil(first / step) * step;
    ctx.save();
    for (let f = a0; f <= be; f += step) {
      const age = (ft - f) / fps, k = age / life, w = this.wheelLine(this.carAt(f));
      for (const [which, wx] of [[0, w.front], [1, w.rear]]) {
        const seed = f * 3 + which, r = (0.1 + 0.55 * k) * w.h * 0.45 * (0.6 + 0.8 * this.vint) * (0.8 + 0.4 * hash(seed));
        const x = wx - this.dir * (6 + 70 * k) + (hash(seed, 1) - 0.5) * 18, y = w.y - 4 - 0.35 * w.h * k * (0.6 + hash(seed, 2) * 0.8);
        puff(ctx, x, y, r * 1.5, '232,234,240', 0.5 * (1 - k) * (1 - k) * (0.4 + 0.6 * this.vint));
      }
    }
    ctx.restore();
  }

  personShadow(ctx) {
    if (!this.hit || this.s.ft < this.Fc) return;
    const t = (this.s.ft - this.Fc) / this.fps, st = this.throwAt(t), tall = this.tall, a = this.rm ? ease(t / 0.4) : 1;
    const lift = clamp(st.h / (this.H * 1.2 + 1), 0, 1), w = tall * (0.34 + 0.22 * (Math.abs(Math.sin(st.th)))), ground = this.footY + 0.02 * tall;
    ctx.save(); ctx.translate(st.x, ground); ctx.scale(1, 0.2); const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 1.3);
    g.addColorStop(0, `rgba(0,0,0,${0.42 * (1 - 0.7 * lift) * a})`); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, w * 1.3, 0, 7); ctx.fill(); ctx.restore();
    // The mark the slide leaves on the road, from where they came down to where they are.
    const T1 = this.T1, sl = this.throwAt(Math.max(T1, Math.min(t, 1e3))), land = this.throwAt(T1);
    if (t > T1 && !this.rm) {
      ctx.save(); ctx.strokeStyle = 'rgba(30,26,22,0.22)'; ctx.lineCap = 'round'; ctx.lineWidth = 0.07 * tall;
      ctx.beginPath(); ctx.moveTo(land.x, ground); ctx.lineTo(sl.x, ground); ctx.stroke(); ctx.restore();
    }
  }

  /** The impact itself, drawn above the person: starburst, rings, debris, dust. Real-time clock rt() so slow motion stretches it. */
  impact(ctx) {
    if (!this.hit) return;
    const ft = this.s.ft, fps = this.fps, t = (ft - this.Fc) / fps; if (t < 0) return;
    const r = this.rt(), tall = this.tall, dir = this.dir, str = this.str, k = this.k;
    const cx = this.px - dir * 0.12 * tall, cy = this.footY - 0.46 * tall;
    ctx.save();
    if (this.rm) {                                          // a single soft ring fading, nothing sudden
      ctx.globalAlpha = 0.6 * (1 - ease(t / 0.8)); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * k; ctx.beginPath(); ctx.arc(cx, cy, tall * (0.3 + 0.6 * ease(t / 0.8)), 0, 7); ctx.stroke(); ctx.restore(); return;
    }
    // starburst: ten jittered spikes, white core inside a yellow-orange body, popping and fading in ~0.22 s real
    if (r < 0.24) {
      const pop = r < 0.07 ? easeOut(r / 0.07) * 1.15 : 1.15 - 0.15 * ease((r - 0.07) / 0.05), fade = 1 - ease((r - 0.1) / 0.14), R = tall * (0.62 + 0.4 * str) * pop;
      ctx.translate(cx, cy); ctx.rotate(hash(3) * 3);
      for (const [rr, col] of [[1, `rgba(255,170,30,${fade})`], [0.74, `rgba(255,236,120,${fade})`], [0.4, `rgba(255,255,255,${fade})`]]) {
        ctx.fillStyle = col; ctx.beginPath();
        for (let i = 0; i < 20; i++) { const rad = (i % 2 ? 0.36 : 1) * R * rr * (i % 2 ? 1 : 0.82 + 0.3 * hash(i, 5)), an = i * Math.PI / 10; ctx.lineTo(Math.cos(an) * rad, Math.sin(an) * rad); }
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore(); ctx.save();
    // shockwave rings on the real clock
    for (let i = 0; i < 2; i++) {
      const rr = r - i * 0.09; if (rr < 0 || rr > 0.7) continue;
      const e = easeOut(rr / 0.7); ctx.globalAlpha = (1 - e) * (i ? 0.55 : 0.9); ctx.strokeStyle = '#fff6d8'; ctx.lineWidth = (7 - 5 * e) * k * (1 + str * 0.4);
      ctx.beginPath(); ctx.arc(cx, cy, tall * (0.2 + (1.15 + 0.6 * str) * e), 0, 7); ctx.stroke();
    }
    ctx.restore();
    // debris chips and dust, on the footage clock (so they hang in the slow motion)
    if (t < 1.4) {
      ctx.save();
      const n = 16, g = 900 * (this.ppm / 119);
      for (let i = 0; i < n; i++) {
        const an = (-0.5 + (hash(i, 1) - 0.1) * 1.9) * (dir > 0 ? 1 : 1), sp = (160 + 420 * hash(i, 2)) * (0.5 + 0.7 * str) * (this.ppm / 119);
        const vx = Math.cos(an) * sp * dir * (hash(i, 7) < 0.25 ? -0.5 : 1), vy = -Math.abs(Math.sin(an)) * sp * 0.9 - 120 * hash(i, 3);
        const life = 0.55 + 0.7 * hash(i, 4); if (t > life) continue;
        const x = cx + vx * t, y = cy + vy * t + 0.5 * g * t * t, a = 1 - ease(t / life), sz = (2 + 3.2 * hash(i, 6)) * k * (1 + 0.4 * str);
        ctx.fillStyle = i % 3 === 0 ? `rgba(255,255,255,${a})` : i % 3 === 1 ? `rgba(196,180,160,${a})` : `rgba(120,116,112,${a})`;
        ctx.save(); ctx.translate(x, y); ctx.rotate(t * (hash(i, 8) - 0.5) * 18); ctx.fillRect(-sz, -sz * 0.6, sz * 2, sz * 1.2); ctx.restore();
      }
      for (let i = 0; i < 9; i++) {                               // dust at the road, rising and spreading
        const life = 1.2, tt = t - 0.02 * i; if (tt < 0 || tt > life) continue;
        const kk = tt / life, x = cx + dir * (hash(i, 9) - 0.2) * tall * 0.9 * (0.6 + str) * kk + (hash(i, 10) - 0.5) * 0.4 * tall, y = this.footY - 0.05 * tall - 0.35 * tall * easeOut(kk) * (0.5 + hash(i, 11));
        puff(ctx, x, y, tall * (0.16 + 0.4 * kk) * (0.7 + 0.6 * hash(i, 12)), '206,192,170', 0.5 * (1 - kk) * (1 - kk));
      }
      // landing and slide dust
      const tl = t - this.T1;
      if (tl > -0.02) {
        const land = this.throwAt(this.T1);
        for (let i = 0; i < 7; i++) {
          const life = 0.9, tt = tl - 0.02 * i; if (tt < 0 || tt > life) continue; const kk = tt / life;
          puff(ctx, land.x - dir * (hash(i, 13) * 0.2 * tall) + dir * kk * 0.4 * tall, this.footY - 0.12 * tall * easeOut(kk) * (0.5 + hash(i, 14)), tall * (0.14 + 0.34 * kk) * (0.8 + 0.5 * str), '206,192,170', 0.5 * (1 - kk) * (1 - kk));
        }
        const T2 = this.T2;
        for (let j = 0; j < 14; j++) {                           // a trail of puffs along the slide
          const ts = this.T1 + j * T2 / 14, tt = t - ts; if (tt < 0 || tt > 0.7 || ts > this.T1 + T2) continue; const kk = tt / 0.7, st = this.throwAt(ts);
          puff(ctx, st.x - dir * 0.2 * tall, this.footY - 0.06 * tall - 0.18 * tall * kk, tall * (0.1 + 0.22 * kk), '206,192,170', 0.4 * (1 - kk) * (1 - kk) * st.sp);
        }
      }
      ctx.restore();
    }
  }

  /** A stop short: the gap bracket pulses green and a small sparkle goes up. x0..x1 is the bracket on the road at row yb. */
  stopFx(ctx, x0, x1, yb) {
    if (this.kind !== 'stop') return;
    const ft = this.s.ft, fps = this.fps, t = (ft - this.Fs) / fps; if (t < 0) return;
    const k = this.k, tall = this.tall, mx = (x0 + x1) / 2;
    ctx.save();
    if (this.rm) { ctx.restore(); return; }
    for (let i = 0; i < 2; i++) {                               // two pulses along the ground plane, from the bracket's middle
      const tt = t - 0.25 * i; if (tt < 0 || tt > 0.9) continue; const e = easeOut(tt / 0.9);
      ctx.globalAlpha = (1 - e) * 0.95; ctx.strokeStyle = '#30d158'; ctx.shadowColor = '#30d158'; ctx.shadowBlur = 12 * k; ctx.lineWidth = (6 - 3.4 * e) * k;
      ctx.beginPath(); ctx.ellipse(mx, yb, (Math.abs(x1 - x0) / 2 + 18 * k) * (0.3 + 0.9 * e) + 6 * k, (0.1 + 0.16 * e) * tall, 0, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    // "safe" sparkles: four-point stars in green and white, twinkling over about a second
    for (let i = 0; i < 10; i++) {
      const tt = t - 0.05 * i; if (tt < 0 || tt > 1.1) continue; const e = tt / 1.1, sc = Math.sin(Math.PI * e);
      const near = x1 - Math.sign(x1 - x0) * Math.min(Math.abs(x1 - x0) / 2, 1.3 * tall), sx = near + (hash(i, 21) - 0.5) * Math.min(Math.abs(x1 - x0) + 0.9 * tall, 2.6 * tall), sy = yb - 0.15 * tall - (0.2 + 0.7 * hash(i, 22)) * tall * easeOut(e);
      const R = (12 + 12 * hash(i, 23)) * k * sc;
      ctx.fillStyle = i % 2 ? '#d6ffe4' : '#30d158'; ctx.beginPath();
      for (let a = 0; a < 8; a++) { const rad = a % 2 ? R * 0.28 : R, an = a * Math.PI / 4; ctx.lineTo(sx + Math.cos(an) * rad, sy + Math.sin(an) * rad); }
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // ---- camera, flash, callout ------------------------------------------------------------------------------------
  /** The matrix of the picture's shake: a few px, 250 ms real, decaying; plus a faint continuous tremor while a rocket fires. */
  shake() {
    if (this.rm || !this.kind) return null;
    let dx = 0, dy = 0, z = 1;
    const ft = this.s.ft, k = this.k, W = this.s.data.width, H = this.s.data.height;
    const burst = (r, A, f1 = 31, f2 = 27) => { if (r < 0 || r > 0.25) return; const e = (1 - r / 0.25) ** 2; dx += A * e * Math.sin(2 * Math.PI * f1 * r); dy += 0.7 * A * e * Math.cos(2 * Math.PI * f2 * r + 1); z += 0.006 * e * A / 6; };
    if (this.hit) { const t = (ft - this.Fc) / this.fps; if (t >= 0) { burst(this.rt(), 7 * k * (0.6 + 0.7 * this.str)); const tl = t - this.T1; if (tl >= 0) burst(this.real(t) - this.real(this.T1), 2.4 * k * (0.5 + this.str), 37, 29); } }
    if (this.kind === 'launch' && ft >= this.f0 && this.thrust) { const w = ft / this.fps, A = 1.8 * k * this.thrust; dx += A * Math.sin(w * 2 * Math.PI * 23) * 0.6; dy += A * Math.sin(w * 2 * Math.PI * 31 + 1); z += 0.002 * this.thrust; }
    if (this.contacts.length) for (const c of this.contacts) { const r = (ft - c.f) / this.fps; if (r >= 0 && r < 0.25 && c.shake) burst(r, c.shake * k); }
    if (dx === 0 && dy === 0 && z === 1) return null;
    return [z, 0, 0, z, W / 2 * (1 - z) + dx, H / 2 * (1 - z) + dy];
  }
  /** A white flash over the whole picture, 0.1 s real, at the touch. Drawn last, in screen space. */
  flash(ctx) {
    if (!this.hit || this.rm) return;
    const r = this.rt(); if (r < 0 || r > 0.11) return;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.6 * (1 - r / 0.11); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, this.s.data.width, this.s.data.height); ctx.restore();
  }

  /** The callout text, counting up from 0 once it lands, and its pop scale. */
  callout(text) {
    const ev = this.hz?.event; if (!ev || !this.kind) return {text, pop: 1};
    const ft = this.s.ft, r = this.hit ? this.real((ft - this.Fc) / this.fps) - this.real((ev.frame - this.Fc) / this.fps) : (ft - ev.frame) / this.fps;
    const pop = this.rm ? 1 : 1 + 0.22 * Math.exp(-Math.max(0, r) / 0.16) * Math.cos(Math.max(0, r) * 14) ;
    if (this.rm || r >= 0.9) return {text, pop};
    const n = easeOut(r / 0.9);
    if (this.hit) return {text: text.replace(/^\d+/, String(Math.round(this.hz.outcome.impact_kmh * n))), pop};
    const sh = this.hz.outcome.short_m;
    if (sh != null) return {text: text.replace(/[\d.]+(?= m short)/, (sh * n).toFixed(1)), pop};
    return {text, pop};
  }

  // ---- other clips ------------------------------------------------------------------------------------------------
  setupMotion() {
    const s = this.s, d = s.data, path = d.forkPath, fps = this.fps, b = this.b, n = path.length, ppm = this.ppm;
    const ys = path.map(p => p[2]), xs = path.map(p => p[1]);
    const ball = Math.max(8, Math.min(b.r - b.l, b.b - b.t));
    this.ball = ball;
    const floor = d.floorPx, sched = [];
    // Contacts with the floor: local maxima of y near the floor line (the 30 fps samples rarely land on the exact bottom of a
    // bounce, so "near" is a share of the ball's size), and the frame a path first reaches the floor and stays (a landing).
    if (floor != null) {
      const tol = Math.max(3, 0.4 * ball), cand = [];
      for (let i = 1; i < n; i++) {
        if (ys[i] > ys[i - 1] + 0.01 && (i === n - 1 || ys[i] > ys[i + 1]) && ys[i] >= floor - tol && i > 1) cand.push(i);
        else if (ys[i] >= floor - 0.6 && ys[i - 1] < floor - 0.6) cand.push(i);
      }
      let lastI = -9;
      for (const i of cand.sort((a, c) => a - c)) {
        if (i - lastI < 4) continue; lastI = i;
        const j = Math.max(0, i - 2), vx = (xs[i] - xs[j]) / (i - j), vy = (ys[i] - ys[j]) / (i - j), v = Math.hypot(vx, vy) * fps / ppm;
        this.contacts.push({f: path[i][0], x: xs[i], y: ys[i] + Math.max(0, b.b), v, vy: Math.abs(vy) * fps / ppm, last: ys.slice(i).every(y => y >= floor - 0.6)});
      }
    }
    // The clip classes, by what the path does.
    if (d.plateSteady === false) {
      this.kind = 'launch';
      // Thrust glow from the net upward acceleration along the path (the response carries no thrust figure): a rocket still
      // burns when gravity holds it on the pad, so the glow never drops below a floor, and grows to its full size at 10 m/s².
      const i = Math.min(n - 6, Math.max(5, Math.floor(n * 0.5))), a = -((ys[i + 5] - 2 * ys[i] + ys[i - 5]) * fps * fps / 25) / ppm;
      this.accel = a; this.thrust = clamp(0.5 + 0.5 * clamp(a / 10, 0, 1), 0.4, 1);
      sched.push([this.f0, 'rumble', {dur: Math.min(5, (this.fN - this.f0) / fps), level: this.thrust}]);
    } else if (this.contacts.length >= 2) {
      this.kind = 'bounce';
      for (const c of this.contacts) { c.shake = Math.min(2.2, 0.3 * c.v); sched.push([c.f, 'bounce', {speed: c.v}]); }
    } else if (this.contacts.length === 1) {
      this.kind = 'flight';
      const c = this.contacts[0]; c.shake = clamp(0.35 * c.v, 0.4, 3);
      sched.push([this.f0, 'whoosh', {dur: Math.min(1.5, (c.f - this.f0) / fps), level: clamp(0.3 + 0.1 * c.v, 0.3, 0.8)}]);
      sched.push([c.f, 'thump', {speed: c.v}]);
      // hang time: the fork's own, against the real one the response's summary states
      this.hang = (c.f - this.f0) / fps;
      const m = /instead of ([\d.]+) s/.exec(s.summary || ''); this.hangReal = m && /air/.test(s.summary) ? +m[1] : null;
    } else {
      // Reversals of x: a swing. Straight and speeding up: a roll. Straight at a steady speed: a drift. Else a plain flight.
      let rev = 0; for (let i = 2; i < n; i++) if ((xs[i] - xs[i - 1]) * (xs[i - 1] - xs[i - 2]) < 0) rev++;
      const sp = (a, c) => Math.hypot(xs[c] - xs[a], ys[c] - ys[a]) / Math.max(1, c - a);
      const t3 = Math.floor(n / 3), a1 = sp(0, t3), a2 = sp(n - 1 - t3, n - 1);
      const dev = (() => { let m = 0; const dx = xs[n - 1] - xs[0], dy = ys[n - 1] - ys[0], L = Math.hypot(dx, dy) || 1; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs((xs[i] - xs[0]) * dy - (ys[i] - ys[0]) * dx) / L); return m; })();
      this.kind = rev >= 3 ? 'swing' : dev < 0.03 * Math.hypot(xs[n - 1] - xs[0], ys[n - 1] - ys[0]) + 2 ? (a2 > 1.35 * a1 ? 'roll' : 'drift') : 'flight';
      if (this.kind === 'flight') sched.push([this.f0, 'whoosh', {dur: 0.9, level: 0.4}]);
    }
    this.sched = sched.sort((a, c) => a[0] - c[0]);
  }

  // The comet-like glowing trail of the path so far, and a bright head.
  glowTrail(ctx) {
    const ft = this.s.ft, p = this.s.data.forkPath, last = Math.min(this.n - 1, Math.floor(ft - this.f0)); if (last < 2 || ft < this.f0) return;
    const cs = this.s.cam?.s || 1, k = this.s.scale();
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,64,160,0.22)'; ctx.lineWidth = 11 * k; ctx.shadowColor = PINK; ctx.shadowBlur = 16 / cs;
    ctx.beginPath(); for (let i = 0; i <= last; i++) i ? ctx.lineTo(p[i][1], p[i][2]) : ctx.moveTo(p[i][1], p[i][2]); ctx.stroke();
    // the head: the last 0.4 s brighter and thicker, fading toward the tail
    const from = Math.max(0, last - Math.round(0.4 * this.fps)), segs = last - from;
    ctx.shadowBlur = 0;
    for (let i = from + 1; i <= last; i++) { const a = (i - from) / Math.max(1, segs); ctx.strokeStyle = `rgba(255,170,215,${0.15 + 0.6 * a})`; ctx.lineWidth = (3 + 4 * a) * k; ctx.beginPath(); ctx.moveTo(p[i - 1][1], p[i - 1][2]); ctx.lineTo(p[i][1], p[i][2]); ctx.stroke(); }
    ctx.restore();
  }

  // Landing and bounces: a ring and dust at each contact scaled with the speed, and (a bounce) squash and stretch.
  contactFx(ctx) {
    const ft = this.s.ft, fps = this.fps, cs = this.s.cam?.s || 1, k = this.s.scale(), ppm = this.ppm;
    ctx.save();
    for (const c of this.contacts) {
      const t = (ft - c.f) / fps; if (t < 0 || t > 1.3 || this.rm && t > 0.8) continue;
      const base = Math.max((0.12 + 0.05 * c.v) * ppm, 30 / cs), kk = clamp(t / 1.0, 0, 1);
      // ring along the ground
      if (t < 0.5) { const e = easeOut(t / 0.5); ctx.globalAlpha = (1 - e) * 0.85; ctx.strokeStyle = '#ffe9f4'; ctx.lineWidth = 3 * k * (1 - 0.6 * e); ctx.beginPath(); ctx.ellipse(c.x, c.y, base * (0.4 + 1.6 * e), base * (0.14 + 0.3 * e), 0, 0, 7); ctx.stroke(); }
      if (this.rm) continue;
      for (let i = 0; i < 8; i++) {
        const dir = i % 2 ? 1 : -1, sp = (0.4 + 0.9 * hash(c.f, i)) * base * 2.2, x = c.x + dir * sp * easeOut(kk) * (0.5 + 0.5 * hash(c.f, i + 9)), y = c.y - base * (0.1 + 0.9 * hash(c.f, i + 20)) * easeOut(kk * 1.2);
        puff(ctx, x, y, base * (0.36 + 0.4 * kk) * (0.7 + 0.6 * hash(c.f, i + 30)), this.dustRgb(), 0.45 * (1 - kk) * (1 - kk));
      }
    }
    ctx.restore();
  }
  dustRgb() { return this.world === 'mars' ? '214,140,96' : this.world === 'jupiter' ? '226,196,160' : this.world === 'moon' ? '190,196,208' : '206,192,170'; }

  /** Squash and stretch for the cut-out: a stretch along the fall just before a contact, a squash at it. {sx, sy} about its base. */
  deform() {
    if (this.rm || !this.contacts.length || this.kind === 'flight') return null;
    const ft = this.s.ft, fps = this.fps; let sy = 1, sx = 1;
    for (const c of this.contacts) {
      const dt = (ft - c.f) / fps, inten = clamp(c.v / 6, 0.25, 1);
      const squash = Math.exp(-((dt / 0.045) ** 2)) * 0.3 * inten, stretch = Math.exp(-(((dt + 0.075) / 0.05) ** 2)) * 0.13 * inten + Math.exp(-(((dt - 0.09) / 0.05) ** 2)) * 0.1 * inten;
      sy += stretch - squash; sx += squash * 0.7 - stretch * 0.5;
    }
    return Math.abs(sy - 1) < 0.003 ? null : {sx, sy};
  }

  // A rocket's exhaust: a flickering plume glow under the sprite and a smoke trail along the path.
  exhaust(ctx) {
    const ft = this.s.ft, fps = this.fps, b = this.b, p = this.s.data.forkPath; if (ft < this.f0) return;
    const bw = b.r - b.l, bot = q => [q[0] + (b.l + b.r) / 2, q[1] + b.b];
    const k = this.s.scale(), th = this.thrust, cs = this.s.cam?.s || 1;
    ctx.save();
    // smoke trail: puffs dropped every 2 frames at the engine, expanding and fading over 2 s
    const life = 2.0, step = 2, a0 = Math.ceil(Math.max(this.f0, ft - life * fps) / step) * step;
    for (let f = a0; f <= Math.min(ft, this.fN); f += step) {
      const kk = (ft - f) / fps / life, q = bot(this.pos(f)), sd = f * 1.7, rr = bw * (0.35 + 1.5 * kk) * (0.8 + 0.4 * hash(sd));
      puff(ctx, q[0] + (hash(sd, 1) - 0.5) * bw * 0.6 * kk * 2, q[1] + bw * 0.4 * kk, rr * 1.4, '214,208,200', 0.3 * (1 - kk) * (1 - kk) * th);
    }
    if (ft <= this.fN + 1) {
      const q = bot(this.pos(Math.min(ft, this.fN))), fl = 0.85 + 0.15 * Math.sin(ft * 2.9) + 0.1 * Math.sin(ft * 7.3), len = bw * (1.8 + 3.2 * th) * fl, w = bw * (0.5 + 0.35 * th);
      ctx.globalCompositeOperation = 'lighter';
      for (const [sc, col] of [[1, 'rgba(255,120,30,0.5)'], [0.62, 'rgba(255,190,80,0.7)'], [0.3, 'rgba(255,250,220,0.9)']]) {
        const g = ctx.createLinearGradient(q[0], q[1], q[0], q[1] + len * sc); g.addColorStop(0, col); g.addColorStop(1, 'rgba(255,80,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(q[0] - w * sc, q[1]); ctx.quadraticCurveTo(q[0] - w * 0.5 * sc, q[1] + len * sc * 0.5, q[0], q[1] + len * sc); ctx.quadraticCurveTo(q[0] + w * 0.5 * sc, q[1] + len * sc * 0.5, q[0] + w * sc, q[1]); ctx.closePath(); ctx.fill();
      }
      const gl = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], bw * 3.2 * th); gl.addColorStop(0, 'rgba(255,170,70,0.5)'); gl.addColorStop(1, 'rgba(255,100,20,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(q[0], q[1], bw * 3.2 * th, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  // A pendulum's swing trail: a ribbon over the last 0.6 s, tapering to nothing.
  ribbon(ctx) {
    const ft = this.s.ft, fps = this.fps, p = this.s.data.forkPath; if (ft < this.f0) return;
    const last = Math.min(this.n - 1, Math.floor(ft - this.f0)), from = Math.max(0, last - Math.round(0.6 * fps));
    if (last - from < 2) return;
    ctx.save(); ctx.lineCap = 'round'; ctx.globalCompositeOperation = 'lighter';
    for (let i = from + 1; i <= last; i++) {
      const a = (i - from) / (last - from);
      ctx.strokeStyle = `rgba(255,90,175,${0.85 * a * a})`; ctx.lineWidth = this.ball * 0.95 * a;
      ctx.beginPath(); ctx.moveTo(p[i - 1][1], p[i - 1][2]); ctx.lineTo(p[i][1], p[i][2]); ctx.stroke();
    }
    ctx.restore();
  }

  // A ball rolling down a ramp: small dust puffs kicked up where it touches.
  rollDust(ctx) {
    const ft = this.s.ft, fps = this.fps, life = 0.7, step = 2; if (ft < this.f0) return;
    const a0 = Math.ceil(Math.max(this.f0, ft - life * fps) / step) * step, b = this.b;
    ctx.save();
    for (let f = a0; f <= Math.min(ft, this.fN); f += step) {
      const kk = (ft - f) / fps / life, q = this.pos(f), v = this.vel(f), sp = Math.hypot(v[0], v[1]) || 1, nx = v[0] / sp, ny = v[1] / sp;
      const x = q[0] - nx * this.ball * 0.5 * (1 + 2 * kk), y = q[1] + b.b * 0.92 - this.ball * 0.5 * kk * (0.4 + hash(f, 3)) - ny * this.ball * 0.4;
      puff(ctx, x + (hash(f, 1) - 0.5) * this.ball * 0.3, y, this.ball * (0.3 + 0.6 * kk) * (0.7 + 0.6 * hash(f, 2)), this.dustRgb(), 0.7 * (1 - kk) * (1 - kk));
    }
    ctx.restore();
  }

  // Something drifting at a steady speed: long thin motion lines trailing behind it, longer when it is faster.
  speedLines(ctx) {
    const ft = this.s.ft; if (ft < this.f0) return;
    const q = this.pos(Math.min(ft, this.fN)), v = this.vel(Math.min(ft, this.fN)), sp = Math.hypot(v[0], v[1]) * this.fps; if (sp < 1) return;
    const nx = v[0] / Math.hypot(...v), ny = v[1] / Math.hypot(...v), len = clamp(sp * 0.12, 24, 260 * this.s.scale()), r = this.ball;
    ctx.save(); ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const off = (i - 2.5) * r * 0.36, ph = (ft * 0.04 + hash(i, 4)) % 1, l = len * (0.5 + 0.6 * hash(i, 5)), a = 0.5 * (0.4 + 0.6 * Math.sin(Math.PI * ph));
      const x0 = q[0] - ny * off - nx * (r * 0.6 + 0.15 * len * ph), y0 = q[1] + nx * off - ny * (r * 0.6 + 0.15 * len * ph), x1 = x0 - nx * l, y1 = y0 - ny * l;
      const g = ctx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, `rgba(255,220,240,${a})`); g.addColorStop(1, 'rgba(255,220,240,0)');
      ctx.strokeStyle = g; ctx.lineWidth = Math.max(1.5, r * 0.1); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.restore();
  }

  // ---- ambient light and the counters (screen space) -------------------------------------------------------------
  /** Per-world tint and floating particles: stars and a cold vignette (Moon), dust (Mars), cloud wisps (Jupiter). */
  ambient(ctx) {
    const w = this.world; if (!w) return;
    const d = this.s.data, W = d.width, H = d.height, k = this.k, t = this.s.ft / this.fps, cam = this.s.cam;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    const tint = {moon: 'rgba(120,150,230,0.10)', mars: 'rgba(255,110,50,0.13)', jupiter: 'rgba(240,170,100,0.12)'}[w];
    ctx.fillStyle = tint; ctx.fillRect(0, 0, W, H);
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, w === 'moon' ? 'rgba(0,0,12,0.34)' : 'rgba(20,6,0,0.22)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    if (this.rm) { ctx.restore(); return; }
    if (w === 'moon') {
      // stars only in the void around the footage (a pulled-back camera), or over the upper sky of a repainted world
      ctx.save();
      if (cam && cam.s < 0.999) { const fx0 = W / 2 + cam.s * (0 - cam.cx), fy0 = H / 2 + cam.s * (0 - cam.cy); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(fx0, fy0, W * cam.s, H * cam.s); ctx.clip('evenodd'); }
      else if (d.world) { ctx.beginPath(); ctx.rect(0, 0, W, H * 0.4); ctx.clip(); } else { ctx.restore(); ctx.restore(); return; }
      for (let i = 0; i < 46; i++) { const a = 0.25 + 0.7 * (0.5 + 0.5 * Math.sin(t * (1 + hash(i, 2) * 2.5) + i * 7)); ctx.fillStyle = `rgba(236,240,255,${a * 0.8})`; ctx.beginPath(); ctx.arc(hash(i, 0) * W, hash(i, 1) * H, (0.6 + 1.4 * hash(i, 3)) * Math.max(1, k), 0, 7); ctx.fill(); }
      ctx.restore();
    } else if (w === 'mars') {
      for (let i = 0; i < 34; i++) { const sp = 30 + 90 * hash(i, 2), x = ((hash(i, 0) * W + t * sp * k) % (W + 40)) - 20, y = hash(i, 1) * H + Math.sin(t * 1.3 + i) * 8 * k, a = 0.12 + 0.22 * hash(i, 4); ctx.fillStyle = `rgba(236,160,110,${a})`; ctx.beginPath(); ctx.arc(x, y, (1 + 2.2 * hash(i, 3)) * Math.max(1, k), 0, 7); ctx.fill(); }
    } else {
      for (let i = 0; i < 7; i++) {
        const sp = 8 + 16 * hash(i, 2), ww = (260 + 280 * hash(i, 3)) * k, x = ((hash(i, 0) * (W + ww) + t * sp * k) % (W + ww)) - ww, y = (0.1 + 0.8 * hash(i, 1)) * H, hh = ww * 0.09;
        const g = ctx.createLinearGradient(x, 0, x + ww, 0); g.addColorStop(0, 'rgba(255,236,210,0)'); g.addColorStop(0.5, 'rgba(255,236,210,0.12)'); g.addColorStop(1, 'rgba(255,236,210,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x + ww / 2, y, ww / 2, hh, 0, 0, 7); ctx.fill();
      }
    }
    ctx.restore();
  }

  /** The counter pill: hang time against the real one (a thrown or dropped object), or the bounce count. */
  hud(ctx) {
    const kind = this.kind; if (kind !== 'flight' && kind !== 'bounce' || kind === 'flight' && !this.contacts.length) return;
    const ft = this.s.ft, fps = this.fps, d = this.s.data, k = this.k * 1.1; let text, done = false, hit = 0;
    if (kind === 'flight') {
      const c = this.contacts[0], t = clamp((ft - this.f0) / fps, 0, this.hang); done = ft >= c.f;
      text = `hang time ${t.toFixed(2)} s` + (this.hangReal != null ? `  ·  real ${this.hangReal.toFixed(2)} s` : ''); hit = done ? (ft - c.f) / fps : -1;
    } else {
      const n = this.contacts.filter(c => ft >= c.f).length; text = `bounces ${n}`; const c = this.contacts.filter(c => ft >= c.f).at(-1); hit = c ? (ft - c.f) / fps : -1;
    }
    const pop = hit >= 0 && !this.rm ? 1 + 0.12 * Math.exp(-hit / 0.12) : 1;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.font = `700 ${15 * k}px ui-monospace, monospace`; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 24 * k, h = 30 * k, x = 16 * k, y = d.height - 92 * k;
    ctx.translate(x + w / 2, y + h / 2); ctx.scale(pop, pop);
    ctx.fillStyle = 'rgba(8,10,18,0.86)'; ctx.strokeStyle = done || kind === 'bounce' && hit >= 0 ? PINK : 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1.5 * k;
    ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, 8 * k); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(text, -w / 2 + 12 * k, 1);
    ctx.restore();
  }

  // ---- sound cues -------------------------------------------------------------------------------------------------
  /** Fires the sound cues whose frame was crossed since the last draw (not on a scrub or a jump). */
  events() {
    const ft = this.s.ft, fps = this.fps; if (!this.sched.length || !this.s.onEffect) return;
    const prev = this.lastEv; this.lastEv = ft;
    if (prev == null || ft < prev || ft - prev > 0.6 * fps) return;
    for (const [f, name, params] of this.sched) if (f > prev && f <= ft) this.s.onEffect(name, params);
  }
  resetEvents() { this.lastEv = null; }
}
