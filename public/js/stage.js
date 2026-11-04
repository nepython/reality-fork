// The stage: the clip with its measurements drawn over it, and the fork, where the real object is erased from every
// frame (SAM's mask filled from the clean plate) and redrawn on the path the changed physics gives it.
const COL = {measured: '#ffd60a', fit: '#00c8ff', fork: '#ff40a0', mask: 'rgba(124, 92, 255, 0.38)', sam: '#7c5cff', samFill: 'rgba(124, 92, 255, 0.42)'};

export class Stage {
  constructor({video, canvas, badge, onFrame}) {
    Object.assign(this, {video, canvas, badge, onFrame});
    this.ctx = canvas.getContext('2d');
    this.data = null;       // {fps, frames, width, height, track, fitPath, forkPath, masks, plate, sprite, spriteMeta, world}
    this.show = {mask: true, path: true, law: true};
    this.frame = 0;
    this.forking = false;
    this.scene = null;      // a director's act: (stage, frame) draws instead of the usual overlay (see director.js)
    this.last = document.createElement('canvas');
    this.loop = this.loop.bind(this);
    const tick = (now, meta) => {
      if (!this.freeRun) this.draw(Math.round(meta.mediaTime * this.data?.fps || 0));
      video.requestVideoFrameCallback(tick);
    };
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(tick);
    else video.addEventListener('timeupdate', () => this.draw(Math.round(video.currentTime * (this.data?.fps || 30))));
    video.addEventListener('seeked', () => !this.freeRun && this.draw(Math.round(video.currentTime * (this.data?.fps || 30))));
    video.addEventListener('ended', () => { if (this.forking && this.forkEnd > this.data.frames - 1) this.startFreeRun(); });
  }

  load(src, info) {
    this.stopFreeRun();
    this.scene = null; this.caption = null; this.video.pause(); this.video.playbackRate = 1;
    this.maskCache = new WeakMap();
    this.data = {...info};
    this.forking = false;
    this.video.src = src;
    this.video.style.visibility = 'visible';
    this.canvas.width = info.width; this.canvas.height = info.height;
    this.last.width = info.width; this.last.height = info.height;
    this.ctx.clearRect(0, 0, info.width, info.height);
  }

  setAnalysis(a) { Object.assign(this.data, a); this.redraw(); }
  redraw() { this.draw(this.frame); }

  // ---- fork playback -------------------------------------------------------------------------------------------
  setFork(path, {label, start, end, baseline, floor, hazard} = {}) {
    this.hazard = hazard || null; this.followKey = null;
    this.data.forkPath = path;
    this.data.floorPx = floor ?? null;
    this.data.basePath = baseline || null;
    this.cam = null;
    this.forking = !!path;
    this.forkLabel = label;
    this.forkEnd = end ?? (path ? path.at(-1)[0] : 0);
    this.video.style.visibility = this.forking ? 'hidden' : 'visible';
    this.stopFreeRun();
    const from = (start ?? path[0][0]) - Math.round(this.data.fps * 0.4);
    // A story that begins before the footage (someone steps out while the car is still off-shot) pre-rolls on the first frame.
    if (this.forking && from < 0) this.startPreroll(from);
    else if (this.forking) this.seek(from, true);
    else this.redraw();
  }

  seek(frame, play = false) {
    this.stopFreeRun();
    const f = Math.max(0, frame);
    if (f > this.data.frames - 1) { this.frame = f; this.draw(f); return; }
    this.video.currentTime = (f + 0.5) / this.data.fps;
    if (play) this.video.play().catch(() => {});
  }

  startPreroll(from) {
    this.freeRun = true; this.pre = true;
    this.video.pause(); this.video.currentTime = 0.5 / this.data.fps;
    this.t0 = performance.now(); this.f0 = from;
    this.draw(from);
    requestAnimationFrame(this.loop);
  }

  startFreeRun() {
    // The forked object can outlive the footage (a Moon fall lasts ~2.5x longer): hold the last frame and keep going.
    this.freeRun = true;
    this.t0 = performance.now();
    this.f0 = this.data.frames - 1;
    requestAnimationFrame(this.loop);
  }
  stopFreeRun() { this.freeRun = false; this.pre = false; }
  loop(now) {
    if (!this.freeRun) return;
    const f = this.f0 + Math.floor((now - this.t0) / 1000 * this.data.fps);
    if (this.pre && f >= 0) return this.seek(0, true);   // the footage takes over from its first frame
    this.draw(Math.min(f, this.forkEnd));
    if (f < this.forkEnd) requestAnimationFrame(this.loop); else this.freeRun = false;
  }

  // ---- drawing -------------------------------------------------------------------------------------------------
  draw(frame) {
    const d = this.data;
    if (!d) return;
    this.frame = frame;
    const ctx = this.ctx, W = d.width, H = d.height;
    ctx.clearRect(0, 0, W, H);
    if (this.scene) this.scene(this, frame);
    else if (this.forking) this.drawFork(frame);
    else {
      if (this.show.mask && d.masks) this.drawMask(frame, COL.mask);
      if (this.show.law && d.fitPath) {
        this.curve(d.fitPath, COL.fit, 2.5);
        const p = d.fitPath.find(q => q[0] === frame);
        if (p) this.ring(p[1], p[2], this.radius(), COL.fit);
      }
      if (this.show.path && d.track) this.dots(d.track.filter(q => q[0] <= frame), COL.measured);
      if (d.crossing) this.drawCrossing(frame);
    }
    if (this.caption) this.drawCaption();
    this.onFrame?.(frame);
  }

  // Burned into saved clips (the badge and summary are page elements a recording of the canvas would not include).
  drawCaption() {
    const ctx = this.ctx, d = this.data, k = d.width / 1280 + 0.4, pad = 14 * k;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `600 ${15 * k}px ui-monospace, monospace`; ctx.textBaseline = 'top';
    const head = this.badge?.textContent || '', tag = 'REALITY FORK';
    const w = Math.max(ctx.measureText(head).width, ctx.measureText(tag).width) + 2 * pad;
    ctx.fillStyle = 'rgba(7, 9, 16, 0.78)'; ctx.fillRect(pad, pad, w, 50 * k);
    ctx.fillStyle = COL.fork; ctx.fillText(tag, 2 * pad, pad + 8 * k);
    ctx.fillStyle = '#fff'; ctx.fillText(head, 2 * pad, pad + 28 * k);
    if (this.caption.foot) {
      ctx.font = `500 ${13 * k}px system-ui, sans-serif`;
      const lines = wrap(ctx, this.caption.foot, d.width - 4 * pad);
      const h = lines.length * 18 * k + 12 * k;
      ctx.fillStyle = 'rgba(7, 9, 16, 0.78)'; ctx.fillRect(pad, d.height - pad - h, d.width - 2 * pad, h);
      ctx.fillStyle = '#e8ecf6'; lines.forEach((l, i) => ctx.fillText(l, 2 * pad, d.height - pad - h + 6 * k + i * 18 * k));
    }
    ctx.restore();
  }

  drawFork(frame) {
    const d = this.data, ctx = this.ctx;
    const inClip = frame <= d.frames - 1;
    const cam = this.camera(frame);
    if (cam.s < 0.999) {
      ctx.fillStyle = '#070910'; ctx.fillRect(0, 0, d.width, d.height);
      ctx.setTransform(cam.s, 0, 0, cam.s, d.width / 2 - cam.s * cam.cx, d.height / 2 - cam.s * cam.cy);
      if (this.followed()) this.drawRoad(cam);
      this.grid(cam);
    }
    if (d.world) ctx.drawImage(d.world, 0, 0, d.width, d.height);
    else if (inClip) {
      ctx.drawImage(this.video, 0, 0, d.width, d.height);
      this.last.getContext('2d').drawImage(this.video, 0, 0, d.width, d.height);
    } else ctx.drawImage(this.last, 0, 0);
    const start = d.forkPath[0][0];
    // Before the fork begins (the object is still held), the footage plays untouched. On a scene that changes behind
    // the object (a launch: plume and lighting), the plate is no true background, so the real object stays, veiled.
    if (frame >= start && !d.world) {
      if (d.plateSteady === false) this.drawMask(Math.min(frame, d.frames - 1), 'rgba(8, 10, 20, 0.5)', 3);
      else this.eraseObject(Math.min(frame, d.frames - 1));
    }
    if (this.show.path && d.fitPath) this.curve(d.fitPath, 'rgba(255,214,10,0.55)', 1.5, [4, 5]);
    this.curve(d.forkPath.filter(q => q[0] <= frame), COL.fork, 2.5);
    const p = d.forkPath.find(q => q[0] === frame) || (frame > this.forkEnd ? d.forkPath.at(-1) : null);
    this.gapText = '';
    if (p && frame >= start) {
      this.sprite(p[1], p[2]);
      // Pulled back, a ball is a few pixels across: ring it so the eye can follow it.
      if (cam.s < 0.8) { ctx.strokeStyle = COL.fork; ctx.lineWidth = 2.5 / cam.s; ctx.beginPath(); ctx.arc(p[1], p[2], 14 / cam.s, 0, 7); ctx.stroke(); }
      if (d.plateSteady === false) this.gapLines(frame, p);
    } else if (d.world && frame < start) { const q = d.track?.find(r => r[0] === frame); if (q) this.sprite(q[1], q[2]); }
    if (d.crossing) this.drawCrossing(frame);
    if (cam.s < 0.999) {
      // The footage's own edges, so the viewer sees how far beyond the shot the fork has gone.
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 2 / cam.s; ctx.setLineDash([]);
      ctx.strokeRect(0, 0, d.width, d.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (this.badge) {
      this.badge.hidden = false;
      const t = Math.max(0, (frame - start) / d.fps);
      this.badge.innerHTML = `<span class="k">${this.forkLabel || 'fork'}</span> · t = ${t.toFixed(2)} s${this.gapText ? ' · ' + this.gapText + ' than reality' : ''}`;
    }
  }

  // A braking fork on a vehicle run is shown by a following camera and a continued road (see followCamera, drawRoad).
  followed() { const d = this.data; return !!(this.forking && this.hazard && d.road && d.plate); }

  // The following camera is a pure function of the frame (scrubbing and replay agree): the zoom is fixed per fork, never
  // below 55% so the footage stays over half the stage; the centre glides from the car to a soft-clamped view of the
  // crossing over the first 2.5 s (so the person's step-out and the crossing are in view), follows the car in, and after
  // the stop or impact eases to the midpoint of car and crossing and holds there on the callout.
  followCamera(frame) {
    const d = this.data, W = d.width, H = d.height, path = d.forkPath, h = this.hazard, fps = d.fps, f0 = path[0][0];
    const key = path;
    if (this.followKey !== key) {
      const b = this.spriteBox(), carW = b.r - b.l, at0 = path[Math.max(0, Math.min(path.length - 1, h.step_out_frame - f0))];
      const need = Math.abs(h.x_px - at0[1]) + carW, ev = path[Math.max(0, Math.min(path.length - 1, h.event.frame - f0))];
      const end = Math.abs(h.x_px - ev[1]) + carW;
      this.followKey = key; this.followS = Math.max(0.55, Math.min(1, W / (1.15 * Math.max(need, end))));
    }
    const s = this.followS;
    if (s >= 0.999) return this.cam = {s: 1, cx: W / 2, cy: H / 2};
    const sm = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
    const car = path[Math.max(0, Math.min(path.length - 1, frame - f0))], cross = h.x_px, evf = h.event.frame;
    const evCar = path[Math.max(0, Math.min(path.length - 1, evf - f0))];
    const L = 0.25 * W / s;
    const lead = cross + L * Math.tanh((car[1] - cross) / L);
    const w1 = sm((frame - f0 - 0.2 * fps) / (2.3 * fps)), w2 = sm((frame - evf) / (2 * fps));
    const base = car[1] + (lead - car[1]) * w1;
    const cx = base + ((evCar[1] + cross) / 2 - base) * w2;
    const roadAt = d.road(cx), cy = (H / 2 + roadAt) / 2;
    return this.cam = {s, cx, cy};
  }

  // The scene carried on past the footage's edges, so a car driving out of shot stays on its road: the plate's own edge
  // strips are stretched outward (sky, trees, road and kerb stay continuous with the footage, as streaks), the colours
  // just inside its letterbox fill the corners, and a light veil marks all of it as not filmed. The road's edges and
  // centre line continue faintly on either side. (Flat sampled bands alone read as coloured blocks with a seam.)
  drawRoad(cam) {
    const m = this.roadModel(); if (!m) return;
    const d = this.data, ctx = this.ctx, W = d.width, k = this.scale();
    const vx0 = cam.cx - W / 2 / cam.s - 10, vx1 = cam.cx + W / 2 / cam.s + 10, vy0 = cam.cy - d.height / 2 / cam.s - 10, vy1 = cam.cy + d.height / 2 / cam.s + 10;
    const P = d.plate, pw = P.naturalWidth || P.width, ph = P.naturalHeight || P.height, rx = pw / W, ry = ph / d.height;
    const {t0, b0} = m, strip = (sx, sy, sw, sh, x, y, w, h) => w > 0 && h > 0 && ctx.drawImage(P, sx * rx, sy * ry, sw * rx, sh * ry, x, y, w, h);
    ctx.save();
    for (const [x0, x1, e] of [[vx0, 0, m.left], [W, vx1, m.right]]) {
      if (x1 <= x0) continue;
      ctx.fillStyle = e.above; ctx.fillRect(x0, vy0, x1 - x0, t0 - vy0);
      ctx.fillStyle = e.below; ctx.fillRect(x0, b0, x1 - x0, vy1 - b0);
      strip(e.x < W / 2 ? 1 : W - 7, t0, 6, b0 - t0, x0, t0, x1 - x0, b0 - t0);
    }
    strip(0, t0 + 1, W, 3, 0, vy0, W, t0 - vy0);
    strip(0, b0 - 4, W, 3, 0, b0, W, vy1 - b0);
    // The veil covers the footage's rectangle too; the footage is drawn over it next.
    ctx.fillStyle = 'rgba(8,10,14,0.24)'; ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
    for (const [x0, x1, e] of [[vx0, 0, m.left], [W, vx1, m.right]]) {
      if (x1 <= x0) continue;
      const at = (x, y) => y + m.slope * (x - e.x);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 2.5 * k;
      ctx.beginPath(); for (const y of [e.top, e.bot]) { ctx.moveTo(x0, at(x0, y)); ctx.lineTo(x1, at(x1, y)); } ctx.stroke();
      ctx.setLineDash([22 * k, 18 * k]); ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath();
      const mid = (e.top + e.bot) / 2; ctx.moveTo(x0, at(x0, mid)); ctx.lineTo(x1, at(x1, mid)); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // Measured once per plate: at each side edge, the run of asphalt-coloured rows round the car's wheels, and the colours
  // just above and below it. Nothing is assumed about the colour or width of the road.
  roadModel() {
    const d = this.data;
    if (this.road?.plate === d.plate && this.road.road === d.road) return this.road.model;
    const W = d.width, H = d.height, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', {willReadFrequently: true}); g.drawImage(d.plate, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data, at = (x, y) => { const i = (Math.max(0, Math.min(H - 1, Math.round(y))) * W + Math.max(0, Math.min(W - 1, Math.round(x)))) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const med = a => a.sort((p, q) => p - q)[a.length >> 1];
    const mean = pts => [0, 1, 2].map(i => Math.round(med(pts.map(p => p[i]))));
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const b = this.spriteBox(), carH = Math.max(20, d.spriteMeta?.height || 1.5 * (d.ppm || 60));
    const slope = d.road(W) - d.road(0); const sl = slope / W;
    const edge = x => {
      const gy = d.road(x) + (d.spriteMeta ? Math.max(0, b.b) : 0.35 * carH);
      const seed = mean([-0.25, -0.2, -0.15, -0.1, -0.05, -0.03].flatMap(o => [-3, 0, 3].map(dx => at(x + dx, gy + o * carH))));
      const y0 = gy - 0.1 * carH, lim = 0.5 * H, scan = dir => {
        let last = y0, gap = 0;
        for (let y = y0; Math.abs(y - y0) < lim && y > 0 && y < H - 1; y += dir) { if (dist(at(x, y), seed) < 45) { last = y; gap = 0; } else if (++gap > 8) break; }
        return last;
      };
      let top = scan(-1), bot = scan(1);
      if (bot - top < 0.4 * carH) { top = gy - 0.6 * carH; bot = gy + 0.3 * carH; }
      const col = a => `rgb(${a.join(',')})`;
      // Above and below: the colours just inside the picture's letterbox, carried on past the stretched strip.
      return {x, top, bot, above: col(mean([...Array(8)].map((_, i) => at(x, t0 + 2 + i)))), below: col(mean([...Array(8)].map((_, i) => at(x, b0 - 2 - i))))};
    };
    // Letterbox bars (near-black rows at the top and bottom of the whole width) are left out of the stretched strip.
    const lum = y => { let s = 0; for (let x = 0; x < W; x += 16) { const p = at(x, y); s += p[0] + p[1] + p[2]; } return s / (3 * Math.ceil(W / 16)); };
    let t0 = 0, b0 = H - 1;
    while (t0 < H / 4 && lum(t0) < 16) t0++;
    while (b0 > 3 * H / 4 && lum(b0) < 16) b0--;
    b0 += 1;
    const left = edge(6), right = edge(W - 7);
    // Edge rows and the lines run along the car's own line of travel; the left/right rows are relative to their edge column.
    this.road = {plate: d.plate, road: d.road, model: {slope: sl, t0, b0, left, right}};
    return this.road.model;
  }

  // A click's x on the canvas as an x on the footage (the camera may be pulled back while a fork plays).
  toFrameX(x) {
    const c = this.forking && this.cam && this.cam.s < 0.999 ? this.cam : null;
    return c ? c.cx + (x - this.data.width / 2) / c.s : x;
  }

  // Where someone steps out in front of a car: a zebra band across the road, a little walker once they have stepped
  // out, and when the fork reaches its outcome a callout that stays (red for a hit, green for a stop in time).
  drawCrossing(frame) {
    const d = this.data, ctx = this.ctx, h = this.hazard, x = h?.x_px ?? d.crossing.x, y = h?.y_px ?? d.crossing.y;
    // A person at their true height (1.7 m), but never smaller than ~60 screen px, so it reads when the camera is pulled back.
    const k = this.scale(), cs = this.forking && this.cam ? this.cam.s : 1, ppm = d.ppm || 30, bw = Math.max(0.8 * ppm, 10 / cs);
    const ground = y + Math.max(0, this.spriteBox().b), tall = Math.max(1.7 * ppm, 60 / cs);
    ctx.save();
    // The band: pale stripes across the road, with a line down its middle that reads at any size.
    const top = Math.max(0, ground - 1.2 * tall), bot = Math.min(d.height, ground + 0.35 * tall);
    ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(x - bw, top, 2 * bw, bot - top);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    const n = Math.max(3, Math.round((bot - top) / (bw * 0.7)));
    for (let i = 0; i < n; i += 2) ctx.fillRect(x - bw, top + (i * (bot - top)) / n, 2 * bw, (bot - top) / n);
    ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2.5 * k; ctx.setLineDash([8 * k, 6 * k]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, d.height); ctx.stroke(); ctx.setLineDash([]);
    // The person appears when they step out; the idle marker (no fork yet) shows them faintly so the spot is clear.
    const out = !h || frame >= (h.step_out_frame ?? 0);
    ctx.globalAlpha = h ? (out ? 1 : 0) : 0.6;
    if (ctx.globalAlpha) this.walker(x, ground, tall, frame);
    ctx.globalAlpha = 1;
    this.label(x, Math.max(18, top - 14 * k), h ? 'crossing' : 'crossing · click the road to move', '#ffd60a');
    const ev = h?.event;
    if (ev && frame >= ev.frame) {
      const hit = ev.kind === 'impact', col = hit ? '#ff453a' : '#30d158';
      // A stop in time: a green bar from the car's front to the crossing shows the gap the callout names.
      if (!hit) {
        const dir = Math.sign(x - ev.x_px) || 1, bx = this.spriteBox(), x0 = ev.x_px + (dir > 0 ? bx.r : bx.l), yb = ground + 0.18 * tall;
        ctx.strokeStyle = col; ctx.lineWidth = 4 * k; ctx.beginPath(); ctx.moveTo(x0, yb); ctx.lineTo(x, yb);
        ctx.moveTo(x0, yb - 8 * k); ctx.lineTo(x0, yb + 8 * k); ctx.moveTo(x, yb - 8 * k); ctx.lineTo(x, yb + 8 * k); ctx.stroke();
      }
      this.callout(Math.min(Math.max(x, 140 * k), d.width - 140 * k), Math.max(40 * k, top - 66 * k), h.outcome.text, col);
    }
    ctx.restore();
  }

  // A walking person from simple strokes: head, body, swinging arms and legs.
  walker(x, ground, tall, frame) {
    const ctx = this.ctx, s = tall / 100, sw = Math.sin(frame * 0.5) * 12 * s, hip = ground - 45 * s, sh = ground - 78 * s;
    const draw = (c, w) => {
      ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.beginPath();
      ctx.moveTo(x, sh); ctx.lineTo(x, hip);                                   // body
      ctx.moveTo(x, sh + 4 * s); ctx.lineTo(x + sw, sh + 30 * s);               // arms
      ctx.moveTo(x, sh + 4 * s); ctx.lineTo(x - sw, sh + 30 * s);
      ctx.moveTo(x, hip); ctx.lineTo(x - sw * 1.2, ground);                     // legs
      ctx.moveTo(x, hip); ctx.lineTo(x + sw * 1.2, ground);
      ctx.stroke(); ctx.beginPath(); ctx.arc(x, sh - 10 * s, 9 * s, 0, 7); ctx.stroke();
    };
    draw('rgba(8,10,18,0.9)', 7 * s); draw('#fff', 3.5 * s);
  }

  callout(x, y, text, color) {
    const ctx = this.ctx, k = this.scale() * 1.5;
    ctx.save(); ctx.font = `700 ${16 * k}px system-ui, sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const w = ctx.measureText(text).width + 24 * k, hgt = 34 * k;
    ctx.fillStyle = color; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.roundRect(x - w / 2, y - hgt / 2, w, hgt, 8 * k); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  // Where the fork leaves the shot, pull the camera back (the server trims the path at five frames across) so the
  // whole arc stays in view. It looks a few frames ahead and eases, so it moves before the object reaches the edge.
  camera(frame) {
    if (this.followed()) return this.followCamera(frame);
    const d = this.data, W = d.width, H = d.height, b = this.spriteBox();
    let x0 = 0, y0 = 0, x1 = W, y1 = H;
    for (const q of d.forkPath) {
      if (q[0] > frame + 8) break;
      x0 = Math.min(x0, q[1] + b.l); x1 = Math.max(x1, q[1] + b.r); y0 = Math.min(y0, q[2] + b.t); y1 = Math.max(y1, q[2] + b.b);
    }
    // Pull back only when the cut-out really leaves the shot (a few pixels over the edge is not worth it). The margin
    // used to apply to a box that already filled the frame, so every fork was shown a little pulled back.
    const tol = 0.02 * Math.max(W, H), out = x0 < -tol || y0 < -tol || x1 > W + tol || y1 > H + tol;
    // Pulled back, keep the top 12% clear: the badge (and a saved clip's caption) sits there, and a climbing rocket's
    // nose and its fork marker ended up under it.
    const room = 0.12 * H, s = Math.min(1, W / ((x1 - x0) * 1.06), (H - room) / ((y1 - y0) * 1.06));
    const target = !out ? {s: 1, cx: W / 2, cy: H / 2} : {s, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 - room / 2 / s};
    const c = this.cam, k = 0.14;
    this.cam = !c || Math.abs(frame - this.camFrame) > 3 ? target
      : {s: c.s + (target.s - c.s) * k, cx: c.cx + (target.cx - c.cx) * k, cy: c.cy + (target.cy - c.cy) * k};
    this.camFrame = frame;
    return this.cam;
  }

  // The cut-out's box relative to the point the fit follows (centroid, top or bottom edge).
  spriteBox() {
    const m = this.data.spriteMeta, point = this.data.point;
    if (!m) return {l: -20, r: 20, t: -20, b: 20};
    const ax = point === 'top' ? m.tx : point === 'bottom' ? m.bx : m.cx, ay = point === 'top' ? m.ty : point === 'bottom' ? m.by : m.cy;
    return {l: m.left - ax, r: m.left + m.width - ax, t: m.top - ay, b: m.top + m.height - ay};
  }

  // A faint metre grid in the dark beyond the footage: scale for how far out of shot the fork goes.
  grid(cam) {
    const d = this.data, ctx = this.ctx, ppm = d.ppm;
    if (!ppm) return;
    const step = ppm * (ppm * cam.s < 12 ? 10 : ppm * cam.s < 40 ? 5 : 1);
    const vx0 = cam.cx - d.width / 2 / cam.s, vx1 = cam.cx + d.width / 2 / cam.s, vy0 = cam.cy - d.height / 2 / cam.s, vy1 = cam.cy + d.height / 2 / cam.s;
    ctx.strokeStyle = 'rgba(120,140,190,0.13)'; ctx.lineWidth = 1 / cam.s; ctx.beginPath();
    for (let x = Math.floor(vx0 / step) * step; x <= vx1; x += step) { ctx.moveTo(x, vy0); ctx.lineTo(x, vy1); }
    for (let y = Math.floor(vy0 / step) * step; y <= vy1; y += step) { ctx.moveTo(vx0, y); ctx.lineTo(vx1, y); }
    ctx.stroke();
    // The floor the fork lands on, carried on beyond the footage on both sides. floorPx is where the tracked point
    // stops (a ball's centre, a jumper's backpack); the floor itself is under the cut-out's bottom edge.
    if (d.floorPx != null) {
      const y = d.floorPx + Math.max(0, this.spriteBox().b);
      ctx.strokeStyle = 'rgba(214,180,130,0.6)'; ctx.lineWidth = 2 / cam.s; ctx.beginPath();
      ctx.moveTo(vx0, y); ctx.lineTo(0, y); ctx.moveTo(d.width, y); ctx.lineTo(vx1, y); ctx.stroke();
    }
  }

  eraseObject(frame) {
    const m = this.maskCanvas(frame);
    if (!m || !this.data.plate) return;
    const ctx = this.ctx, tmp = this.tmp ||= document.createElement('canvas');
    tmp.width = m.canvas.width; tmp.height = m.canvas.height;
    const t = tmp.getContext('2d');
    t.clearRect(0, 0, tmp.width, tmp.height);
    t.drawImage(this.data.plate, m.x, m.y, tmp.width, tmp.height, 0, 0, tmp.width, tmp.height);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(m.canvas, 0, 0);
    t.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmp, m.x, m.y);
  }

  // A frame's mask as an alpha canvas, dilated so the motion-blur halo is covered too; cached per frame.
  // The cache is per masks map: the director draws other objects' masks too, and a map must never see another's frames.
  maskCanvas(frame, pad = 6, masks = this.data.masks) {
    if (!masks) return null;
    const all = this.maskCache ||= new WeakMap();
    if (!all.has(masks)) all.set(masks, new Map());
    const cache = all.get(masks), key = frame + ':' + pad;
    if (cache.has(key)) return cache.get(key);
    const m = masks.get(frame);
    if (!m) { cache.set(key, null); return null; }
    const w = m.right - m.left + 2 * pad, h = m.bottom - m.top + 2 * pad;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), img = g.createImageData(w, h);
    const sx = m.w / (m.right - m.left), sy = m.h / (m.bottom - m.top);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let on = 0;
      for (let v = -pad; v <= pad && !on; v += 2) for (let u = -pad; u <= pad && !on; u += 2) {
        if (u * u + v * v > pad * pad) continue;
        const mx = x - pad + u, my = y - pad + v;
        if (mx < 0 || my < 0 || mx >= m.right - m.left || my >= m.bottom - m.top) continue;
        on = m.raster[Math.floor(my * sy) * m.w + Math.floor(mx * sx)];
      }
      img.data[(y * w + x) * 4 + 3] = on ? 255 : 0;
    }
    g.putImageData(img, 0, 0);
    const out = {canvas: c, x: m.left - pad, y: m.top - pad};
    cache.set(key, out);
    return out;
  }

  drawMask(frame, color, pad = 0, masks) {
    const m = this.maskCanvas(frame, pad, masks);
    if (!m) return;
    const tmp = this.tmp2 ||= document.createElement('canvas');
    tmp.width = m.canvas.width; tmp.height = m.canvas.height;
    const t = tmp.getContext('2d');
    t.drawImage(m.canvas, 0, 0);
    t.globalCompositeOperation = 'source-in';
    t.fillStyle = color; t.fillRect(0, 0, tmp.width, tmp.height);
    t.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(tmp, m.x, m.y);
  }

  // A mask filled and outlined (the outline is the mask grown a few pixels, minus the mask itself).
  drawMaskOutlined(frame, masks, fill, stroke) {
    const m = this.maskCanvas(frame, 0, masks);
    if (!m) return false;
    const k = Math.max(1.5, 2 * this.scale()), pad = Math.ceil(k) + 1, w = m.canvas.width + 2 * pad, h = m.canvas.height + 2 * pad;
    const t = (this.tmp3 ||= document.createElement('canvas')); t.width = w; t.height = h;
    const g = t.getContext('2d');
    for (let a = 0; a < 8; a++) g.drawImage(m.canvas, pad + Math.cos(a * Math.PI / 4) * k, pad + Math.sin(a * Math.PI / 4) * k);
    g.globalCompositeOperation = 'source-in'; g.fillStyle = stroke; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-out'; g.drawImage(m.canvas, pad, pad);
    this.ctx.drawImage(t, m.x - pad, m.y - pad);
    this.drawMask(frame, fill, 0, masks);
    return true;
  }

  // A text pill on the picture, sized with the picture (so it reads on a 1280 px clip and on a 360 px one alike).
  label(x, y, text, color, {align = 'center'} = {}) {
    const ctx = this.ctx, k = this.scale() * 1.15;
    ctx.save(); ctx.font = `600 ${14 * k}px ui-monospace, monospace`; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 14 * k, h = 24 * k, W = this.data.width, H = this.data.height;
    let x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    x0 = Math.max(6, Math.min(W - w - 6, x0)); const y0 = Math.max(6, Math.min(H - h - 6, y - h / 2));
    ctx.fillStyle = 'rgba(8, 10, 18, 0.82)'; ctx.strokeStyle = color; ctx.lineWidth = 1.5 * k;
    ctx.beginPath(); ctx.roundRect(x0, y0, w, h, 6 * k); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillText(text, x0 + 7 * k, y0 + h / 2 + 1); ctx.restore();
  }

  sprite(x, y) {
    const s = this.data.sprite, m = this.data.spriteMeta;
    // The fit may follow the object's top or bottom edge (see fit.point); anchor the cut-out at the same point.
    const point = this.data.point, ax = point === 'top' ? m?.tx : point === 'bottom' ? m?.bx : m?.cx, ay = point === 'top' ? m?.ty : point === 'bottom' ? m?.by : m?.cy;
    if (s && m) {
      // Beside a veiled real object the forked one needs to stand apart: a fork-coloured glow.
      const ctx = this.ctx; ctx.save();
      if (this.data.plateSteady === false && this.forking) { ctx.shadowColor = COL.fork; ctx.shadowBlur = 16 * this.scale(); }
      ctx.drawImage(s, x - (ax - m.left), y - (ay - m.top)); ctx.restore();
    }
    else { this.ctx.fillStyle = COL.fork; this.ctx.beginPath(); this.ctx.arc(x, y, this.radius(), 0, 7); this.ctx.fill(); }
  }

  // A real object that cannot be erased overlaps its fork (a 600 px rocket ahead by 100 px), so mark both tracked
  // points with lines across the object, as a swimming broadcast marks the record pace, and print the gap.
  gapLines(frame, p) {
    const d = this.data, q = d.basePath?.find(r => r[0] === frame) || d.track?.find(r => r[0] === frame);
    if (!q) return;
    const ctx = this.ctx, k = this.scale(), half = Math.max(40, (d.spriteMeta?.width || 40) * 0.9);
    const tick = (x, y, color, text, right) => {
      ctx.strokeStyle = color; ctx.lineWidth = 3 * k; ctx.beginPath(); ctx.moveTo(x - half, y); ctx.lineTo(x + half, y); ctx.stroke();
      ctx.fillStyle = color; ctx.textAlign = right ? 'left' : 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(text, right ? x + half + 8 * k : x - half - 8 * k, y);
    };
    ctx.save(); ctx.font = `600 ${13 * k}px ui-monospace, monospace`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 4;
    tick(q[1], q[2], COL.measured, 'reality', false);
    const gap = d.ppm ? Math.hypot(p[1] - q[1], p[2] - q[2]) / d.ppm : null;
    this.gapText = gap != null && gap >= 0.5 ? `${gap.toFixed(gap < 10 ? 1 : 0)} m ${p[2] < q[2] ? 'higher' : 'lower'}` : '';
    // Just "fork", matching "reality": the label and the gap are in the badge, and repeating them here put a second
    // copy beside the badge once the forked rocket climbed to the top of the picture.
    tick(p[1], p[2], COL.fork, 'fork', true);
    ctx.restore();
  }

  radius() { const t = this.data.track; return t?.length ? Math.max(4, (t[Math.floor(t.length / 2)][3] || 16) / 2) : 10; }
  scale() { return (this.data.width / 1280 + 0.4) / (this.forking && this.cam ? this.cam.s : 1); }

  curve(pts, color, width, dash = []) {
    if (!pts || pts.length < 2) return;
    const ctx = this.ctx;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width * this.scale(); ctx.setLineDash(dash); ctx.lineJoin = 'round';
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[1], p[2]) : ctx.moveTo(p[1], p[2])); ctx.stroke(); ctx.restore();
  }
  ring(x, y, r, color) {
    const ctx = this.ctx; ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2.5 * this.scale();
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke(); ctx.restore();
  }
  dots(pts, color) {
    const ctx = this.ctx, r = 2.6 * this.scale();
    ctx.save(); ctx.fillStyle = color;
    for (const p of pts) { ctx.beginPath(); ctx.arc(p[1], p[2], r, 0, 7); ctx.fill(); }
    ctx.restore();
  }
}

function wrap(ctx, text, width) {
  const out = []; let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? line + ' ' + word : word;
    if (ctx.measureText(next).width > width && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}
