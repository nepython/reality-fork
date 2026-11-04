// The stage: the clip with its measurements drawn over it, and the fork, where the real object is erased from every
// frame (SAM's mask filled from the clean plate) and redrawn on the path the changed physics gives it.
import {pedestrian, PEDESTRIAN_M} from './pedestrian.js';
import {stripLayout, drawStrip} from './strip.js';

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
  // `summary` (optional) is the fork's sentence for the result chip; without it the chip reads the page's own summary line.
  setFork(path, {label, start, end, baseline, floor, hazard, summary} = {}) {
    this.hazard = hazard || null; this.strip = null; this.strobe = null;
    const page = document.getElementById('forkSummary')?.textContent;
    this.summary = summary ?? (page && !/^Muse Image/.test(page) ? page : '');
    this.data.forkPath = path;
    this.data.floorPx = floor ?? null;
    this.data.basePath = baseline || null;
    this.cam = null;
    this.forking = !!path;
    this.forkLabel = label;
    this.forkEnd = end ?? (path ? path.at(-1)[0] : 0);
    this.video.style.visibility = this.forking ? 'hidden' : 'visible';
    this.stopFreeRun();
    const from = (start ?? path?.[0]?.[0] ?? 0) - Math.round(this.data.fps * 0.4);
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
    const d = this.data, ctx = this.ctx, W = d.width, H = d.height;
    const inClip = frame <= d.frames - 1;
    const cam = this.camera(frame), pulled = cam.s < 0.999;
    if (pulled) {
      // Pulled back, the footage is a lit window in a dark metre grid: the void, then a soft shadow the footage casts on it.
      this.drawVoid(cam);
      ctx.setTransform(cam.s, 0, 0, cam.s, W / 2 - cam.s * cam.cx, H / 2 - cam.s * cam.cy);
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 28; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.restore();
    }
    const live = inClip ? this.video : this.last;
    if (d.world) ctx.drawImage(d.world, 0, 0, W, H);
    else if (inClip) {
      ctx.drawImage(this.video, 0, 0, W, H);
      this.last.getContext('2d').drawImage(this.video, 0, 0, W, H);
    } else ctx.drawImage(this.last, 0, 0);
    const start = d.forkPath[0][0];
    // Before the fork begins (the object is still held), the footage plays untouched. On a scene that changes behind
    // the object (a launch: plume and lighting), the plate is no true background, so the real object stays, veiled.
    if (frame >= start && !d.world) {
      if (d.plateSteady === false) this.drawMask(Math.min(frame, d.frames - 1), 'rgba(8, 10, 20, 0.5)', 3);
      else this.eraseObject(Math.min(frame, d.frames - 1), live);
    }
    // The real path, a faint dotted ghost; the fork's own path so far, and (when it is not a car at a crossing) the
    // stroboscopic copies of the cut-out along it.
    const real = d.basePath || d.fitPath;
    if (this.show.path && real) this.dotted(real, 'rgba(255,255,255,0.5)');
    // A car that hits the person stays where it hit (the path goes on past the crossing and out of shot, which left the
    // person alone in the final frame with nothing to explain the red callout).
    const pf = this.hazard?.outcome?.kind === 'hits' ? Math.min(frame, this.hazard.event.frame) : frame;
    const p = d.forkPath.find(q => q[0] === pf) || (pf > this.forkEnd ? d.forkPath.at(-1) : null);
    this.gapText = '';
    this.curve(d.forkPath.filter(q => q[0] <= pf), COL.fork, 2.5);
    if (!this.hazard && frame >= start) this.strobeCopies(frame);
    if (p && frame >= start) {
      this.sprite(p[1], p[2], {ground: !!this.hazard});
      // Pulled back, a ball is a few pixels across: ring it so the eye can follow it.
      if (cam.s < 0.8) { ctx.strokeStyle = COL.fork; ctx.lineWidth = 2.5 / cam.s; ctx.beginPath(); ctx.arc(p[1], p[2], 14 / cam.s, 0, 7); ctx.stroke(); }
      if (d.plateSteady === false) this.gapLines(frame, p);
    } else if (d.world && frame < start) { const q = d.track?.find(r => r[0] === frame); if (q) this.sprite(q[1], q[2]); }
    if (d.crossing) this.drawCrossing(frame);
    if (pulled) {
      // The footage's own edges, so the viewer sees how far beyond the shot the fork has gone.
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5 / cam.s; ctx.setLineDash([]); ctx.strokeRect(0, 0, W, H);
      ctx.font = `700 ${11 / cam.s}px ui-monospace, monospace`; ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
      ctx.fillText('FOOTAGE', 2 / cam.s, -5 / cam.s);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (this.hazard) this.drawBirdsEye(frame);
    else this.drawChip(frame, start);
    if (this.badge) {
      this.badge.hidden = false;
      const t = Math.max(0, (frame - start) / d.fps);
      this.badge.innerHTML = `<span class="k">${this.forkLabel || 'fork'}</span> · t = ${t.toFixed(2)} s${this.gapText ? ' · ' + this.gapText + ' than reality' : ''}`;
    }
  }

  // ---- the bird's-eye strip (braking forks) --------------------------------------------------------------------
  // The footage stays at full size, and the road beyond the frame is not guessed at (it used to be the plate's edge pixels
  // stretched outward, which read as smears): the strip, drawn from the response's numbers, carries the off-frame story.
  // It sits where it hides least of the cut-out's path and the crossing: the top (sky) on a street clip, else the bottom.
  drawBirdsEye(frame) {
    const d = this.data, h = this.hazard;
    if (!h.distances || !h.outcome) return;
    if (!this.strip || this.strip.path !== d.forkPath) {
      const W = d.width, H = d.height, k = W / 1280, sh = 168 * k, b = this.spriteBox(), ground = h.y_px + Math.max(0, b.b), tall = this.personH();
      // Rows the car (over the frames it is in shot) and the crossing's person occupy, against the two candidate bands.
      const rows = d.forkPath.filter(q => q[1] + b.r > 0 && q[1] + b.l < W).map(q => [q[2] + b.t, q[2] + b.b]).concat([[ground - tall - 20 * k, ground + 8 * k]]);
      const cover = (y0, y1) => rows.reduce((n, [a, c]) => n + Math.max(0, Math.min(c, y1) - Math.max(a, y0)), 0);
      const top = 60 * k, atTop = cover(top, top + sh) <= cover(H - sh - 14 * k, H - 14 * k);
      this.strip = {path: d.forkPath, layout: stripLayout({W, H, path: d.forkPath, hz: h, atTop, color: this.carColor(), fps: d.fps})};
    }
    drawStrip(this.ctx, this.strip.layout, frame, d.fps);
  }

  // The footage car's own colour (mean of its cut-out's opaque pixels), so its top-view icon matches.
  carColor() {
    const s = this.data.sprite; if (!s) return undefined;
    try {
      const c = document.createElement('canvas'); c.width = c.height = 12; const g = c.getContext('2d', {willReadFrequently: true});
      g.drawImage(s, 0, 0, 12, 12); const px = g.getImageData(0, 0, 12, 12).data; let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 200) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++; }
      return n ? `rgb(${Math.round(r / n * 1.4)},${Math.round(gg / n * 1.4)},${Math.round(b / n * 1.4)})` : undefined;
    } catch { return undefined; }
  }

  // ---- result chip, stroboscopic trail, dotted ghost (every fork but a braking one) ------------------------------
  // The fork's headline: the first sentence of its summary, cut at a clause when it is long.
  headline() {
    const t = (this.summary || '').replace(/\s+/g, ' ').trim(); if (!t) return '';
    let first = t.split(/(?<=[.!?])\s/)[0];
    if (first.length > 96) { const i = first.search(/[,;(]/); if (i > 30) first = first.slice(0, i); else first = first.slice(0, 93) + '…'; }
    return first.replace(/[.]$/, '');
  }
  drawChip(frame, start) {
    const text = this.headline(); if (!text) return;
    const d = this.data, ctx = this.ctx, k = d.width / 1280, t = Math.max(0, (frame - start) / d.fps), a = Math.min(1, t / 0.5);
    ctx.save(); ctx.globalAlpha = a; ctx.font = `600 ${19 * k}px system-ui, sans-serif`; ctx.textBaseline = 'middle';
    const lines = wrap(ctx, text, Math.min(0.55 * d.width, 640 * k) - 44 * k), lh = 25 * k, w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 52 * k, h = lines.length * lh + 18 * k;
    // Below the page's badge row (the badge's text can run to the middle of the picture).
    const x = d.width - 16 * k - w, y = 62 * k - (1 - a) * 8 * k;
    ctx.fillStyle = 'rgba(8, 10, 18, 0.82)'; ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = k; ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 14 * k;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 12 * k); ctx.fill(); ctx.shadowBlur = 0; ctx.stroke();
    ctx.fillStyle = COL.fork; ctx.beginPath(); ctx.arc(x + 19 * k, y + h / 2, 5.5 * k, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; lines.forEach((l, i) => ctx.fillText(l, x + 34 * k, y + 9 * k + lh / 2 + i * lh));
    ctx.restore();
  }

  // Copies of the cut-out at regular time steps along the fork's path, fading with age: the classic physics photograph.
  // The step starts at 0.2 s and doubles until neighbouring copies sit about half a cut-out apart, so a slow fork is not
  // a smear of overlapping copies and a fast one still shows several.
  strobeCopies(frame) {
    const d = this.data, path = d.forkPath;
    if (!this.strobe || this.strobe.path !== path) {
      const b = this.spriteBox(), size = Math.max(24, Math.min(b.r - b.l, b.b - b.t) * 0.9), moved = n => path.map((q, i) => i + n < path.length ? Math.hypot(path[i + n][1] - q[1], path[i + n][2] - q[2]) : null).filter(v => v != null).sort((a, c) => a - c);
      let n = Math.max(1, Math.round(0.2 * d.fps));
      for (; n < path.length / 3; n *= 2) { const m = moved(n); if (m.length && m[m.length >> 1] >= 0.5 * size) break; }
      this.strobe = {path, n};
    }
    const {n} = this.strobe, f0 = path[0][0], ctx = this.ctx;
    const copies = []; for (let f = f0; f < frame; f += n) { const q = path[f - f0]; if (q) copies.push(q); }
    const shown = copies.slice(-10);
    ctx.save();
    shown.forEach((q, i) => { ctx.globalAlpha = 0.14 + 0.36 * (i + 1) / shown.length; this.sprite(q[1], q[2]); });
    ctx.restore();
  }

  dotted(pts, color) {
    if (!pts || pts.length < 2) return;
    const ctx = this.ctx, k = this.scale();
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 3.2 * k; ctx.lineCap = 'round'; ctx.setLineDash([0.1, 9 * k]);
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[1], p[2]) : ctx.moveTo(p[1], p[2])); ctx.stroke(); ctx.restore();
  }

  // The dark void a pulled-back camera sees beyond the footage: a soft gradient, a metre grid (minor and major lines),
  // the ground tinted below the floor, and metre labels along the screen's edges (distance from where the fork starts,
  // height above the floor). Labels are in screen space, so they keep their size however far the camera goes back.
  drawVoid(cam) {
    const d = this.data, ctx = this.ctx, W = d.width, H = d.height, ppm = d.ppm;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#090c18'); bg.addColorStop(1, '#10162a');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    if (!ppm) return;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200], major = nice.find(m => m * ppm * cam.s >= 90) || 500, minor = major / (major === 2 || major === 20 ? 4 : 5);
    const q = d.forkPath[0], b = this.spriteBox(), floor = d.floorPx != null ? d.floorPx + Math.max(0, b.b) : null, yRef = floor ?? q[2];
    const sx = x => W / 2 + cam.s * (x - cam.cx), sy = y => H / 2 + cam.s * (y - cam.cy);
    const vx0 = cam.cx - W / 2 / cam.s, vx1 = cam.cx + W / 2 / cam.s, vy0 = cam.cy - H / 2 / cam.s, vy1 = cam.cy + H / 2 / cam.s;
    if (floor != null) { const g = ctx.createLinearGradient(0, sy(floor), 0, H); g.addColorStop(0, 'rgba(214,180,130,0.16)'); g.addColorStop(1, 'rgba(214,180,130,0.02)'); ctx.fillStyle = g; ctx.fillRect(0, sy(floor), W, H - sy(floor)); }
    const lines = (step, col, lw) => {
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
      for (let m = Math.ceil((vx0 - q[1]) / ppm / step) * step; q[1] + m * ppm <= vx1; m += step) { const x = Math.round(sx(q[1] + m * ppm)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let m = Math.ceil((yRef - vy1) / ppm / step) * step; yRef - m * ppm >= vy0; m += step) { const y = Math.round(sy(yRef - m * ppm)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
    };
    if (minor * ppm * cam.s >= 14) lines(minor, 'rgba(130,150,200,0.07)', 1);
    lines(major, 'rgba(130,150,200,0.2)', 1);
    if (floor != null) { ctx.strokeStyle = 'rgba(214,180,130,0.55)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, sy(floor)); ctx.lineTo(W, sy(floor)); ctx.stroke(); }
    const k = Math.max(0.8, W / 1280);
    ctx.font = `600 ${11 * k}px ui-monospace, monospace`; ctx.fillStyle = 'rgba(190,205,240,0.65)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (let m = Math.ceil((vx0 - q[1]) / ppm / major) * major; q[1] + m * ppm <= vx1; m += major) { const x = sx(q[1] + m * ppm); if (x > 30 && x < W - 30) ctx.fillText(m === 0 ? '0' : `${m > 0 ? '+' : '−'}${Math.abs(m)} m`, x, H - 62 * k); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    for (let m = Math.ceil((yRef - vy1) / ppm / major) * major; yRef - m * ppm >= vy0; m += major) { const y = sy(yRef - m * ppm); if (y > 40 && y < H - 24) ctx.fillText(m === 0 ? (floor != null ? 'ground' : '0') : `${m > 0 ? '' : '−'}${Math.abs(m)} m`, 8 * k, y - 3 * k); }
  }

  // A click's x on the canvas as an x on the footage (the camera may be pulled back while a fork plays).
  toFrameX(x) {
    const c = this.forking && this.cam && this.cam.s < 0.999 ? this.cam : null;
    return c ? c.cx + (x - this.data.width / 2) / c.s : x;
  }

  // The person at their true height: a child with a school bag, 1.3 m, times the footage's pixels per metre (an adult would be
  // 1.7 m; see pedestrian.js). Never under ~48 screen px, so it still reads on a small clip or a pulled-back camera.
  personH() { const cs = this.forking && this.cam ? this.cam.s : 1; return Math.max(PEDESTRIAN_M.child * (this.data.ppm || 30), 48 / cs); }

  // Where someone steps out in front of a car: a zebra band across the road, the person once they step out (walking off
  // the near kerb), and when the fork reaches its outcome a callout that stays (red for a hit, green for a stop in time).
  drawCrossing(frame) {
    const d = this.data, ctx = this.ctx, h = this.hazard, x = h?.x_px ?? d.crossing.x, y = h?.y_px ?? d.crossing.y;
    const k = this.scale(), ppm = d.ppm || 30, bw = Math.max(0.8 * ppm, 10 / (this.cam?.s || 1));
    const ground = y + Math.max(0, this.spriteBox().b), tall = this.personH();
    const top = Math.max(0, ground - 1.2 * tall), bot = Math.min(d.height, ground + 0.35 * tall);
    ctx.save();
    // The band: pale stripes across the road, fading out at both ends so it sits in the picture rather than on it.
    const fade = ctx.createLinearGradient(0, top, 0, bot); fade.addColorStop(0, 'rgba(255,255,255,0)'); fade.addColorStop(0.3, 'rgba(255,255,255,0.5)'); fade.addColorStop(1, 'rgba(255,255,255,0.5)');
    const n = Math.max(8, Math.round((bot - top) / (bw * 0.2)));
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x - bw, top, 2 * bw, bot - top);
    ctx.fillStyle = fade; for (let i = 0; i < n; i += 2) ctx.fillRect(x - bw, top + (i * (bot - top)) / n, 2 * bw, (bot - top) / n);
    ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2.5 * k; ctx.setLineDash([8 * k, 6 * k]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.stroke(); ctx.setLineDash([]);
    // The person appears when they step out; the idle marker (no fork yet) shows them faintly so the spot is clear.
    // Walking off the near kerb they move up the picture, away from the camera, over about two seconds.
    const tOut = h ? (frame - (h.step_out_frame ?? 0)) / d.fps : 0, out = !h || tOut >= 0;
    if (out) {
      const p = h ? Math.min(1, tOut / 2.2) : 0;
      ctx.globalAlpha = h ? Math.min(1, tOut / 0.25 + 0.001) : 0.6;
      pedestrian(ctx, x, ground + (0.2 - 0.34 * p) * tall, tall, h ? Math.max(0, tOut) : 0.3);
      ctx.globalAlpha = 1;
    }
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
      if (hit) {   // the impact: a red ring spreading from the person, for the first second
        const a = Math.max(0, 1 - (frame - ev.frame) / d.fps), r = (0.4 + 1.1 * (1 - a)) * tall;
        ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = 5 * k; ctx.beginPath(); ctx.arc(x, ground - 0.5 * tall, r, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
      }
      // Beside the strip, not under it: just below a strip at the top, just above one at the bottom.
      const st = this.strip?.layout, cy = !st ? Math.max(40 * k, top - 66 * k) : st.atTop ? st.y + st.h + 30 * k : st.y - 30 * k;
      this.callout(Math.min(Math.max(x, 140 * k), d.width - 140 * k), cy, h.outcome.text, col);
    }
    ctx.restore();
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
    // A braking fork keeps the footage at full size: the off-frame road is the bird's-eye strip's job, not a pulled-back camera's.
    if (this.hazard) return this.cam = {s: 1, cx: this.data.width / 2, cy: this.data.height / 2};
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

  // Erase the real object: the clean plate's pixels over its mask. Two things made a grey blob of it before. The mask hugged
  // the object (so its blur, shade and the shadow under it stayed), and the plate's exposure and shadows differ from the
  // frame's. So the mask is grown (more below, where the object's shadow falls) and feathered, and the patch is shifted by
  // the plate-versus-frame colour difference measured on a ring just outside it, spread smoothly inside (a coarse grid
  // relaxed to its border values: the idea of Poisson cloning without the solver). A patch that matches its surroundings has no edge.
  eraseObject(frame, live = this.video) {
    const d = this.data, m = this.maskCanvas(frame, 0);
    if (!m || !d.plate) return;
    const W = d.width, H = d.height, bw = m.canvas.width, bh = m.canvas.height, R = 7, RING = 9, down = Math.round(Math.min(14, 0.07 * bh)), M = R + RING + 3;
    const rx = Math.max(0, m.x - M), ry = Math.max(0, m.y - M), rw = Math.min(W, m.x + bw + M) - rx, rh = Math.min(H, m.y + bh + M + down) - ry;
    if (rw < 2 || rh < 2) return;
    const grown = r => {   // the mask grown by r pixels (and `down` more downward), as an alpha canvas over the region
      const c = document.createElement('canvas'); c.width = rw; c.height = rh; const g = c.getContext('2d');
      const put = (dx, dy) => g.drawImage(m.canvas, m.x - rx + dx, m.y - ry + dy);
      put(0, 0);
      for (let a = 0; a < 16; a++) for (const rr of [r, r * 0.55]) { const dx = Math.cos(a * Math.PI / 8) * rr, dy = Math.sin(a * Math.PI / 8) * rr; put(dx, dy); if (dy > 0) put(dx, dy + down); }
      for (let j = 1; j <= down; j += 2) put(0, r + j);
      return c;
    };
    const inner = grown(R), outer = grown(R + RING);
    const px = c => c.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, rw, rh).data;
    const crop = (src, c) => { const g = c.getContext('2d', {willReadFrequently: true}), sw = (src.naturalWidth || src.videoWidth || src.width) / W, sh = (src.naturalHeight || src.videoHeight || src.height) / H; g.drawImage(src, rx * sw, ry * sh, rw * sw, rh * sh, 0, 0, rw, rh); return g.getImageData(0, 0, rw, rh).data; };
    const mk = () => { const c = document.createElement('canvas'); c.width = rw; c.height = rh; return c; };
    const A = px(inner), O = px(outer), P = crop(d.plate, mk()), F = crop(live, mk());
    // Feathered alpha: the grown mask blurred a little (where the canvas can blur; elsewhere the edge stays crisp but matched).
    const soft = mk(), sg = soft.getContext('2d', {willReadFrequently: true});
    if ('filter' in sg) sg.filter = 'blur(2.4px)';
    sg.drawImage(inner, 0, 0); const S = sg.getImageData(0, 0, rw, rh).data;
    // Colour difference (frame − plate) on the ring, in cells of 6 px; known where the ring touches, relaxed elsewhere.
    const cs = 6, gw = Math.ceil(rw / cs), gh = Math.ceil(rh / cs), sum = new Float32Array(gw * gh * 3), cnt = new Float32Array(gw * gh);
    for (let y = 0; y < rh; y += 2) for (let x = 0; x < rw; x += 2) {
      const i = (y * rw + x) * 4;
      if (A[i + 3] > 20 || O[i + 3] < 20) continue;
      const dr = F[i] - P[i], dg = F[i + 1] - P[i + 1], db = F[i + 2] - P[i + 2];
      if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 150) continue;     // something else entirely (a pole, another car): not the object's surroundings
      const c = ((y / cs) | 0) * gw + ((x / cs) | 0); sum[c * 3] += dr; sum[c * 3 + 1] += dg; sum[c * 3 + 2] += db; cnt[c]++;
    }
    const val = new Float32Array(gw * gh * 3), known = new Uint8Array(gw * gh); let n = 0; const mean = [0, 0, 0];
    for (let c = 0; c < gw * gh; c++) if (cnt[c]) { known[c] = 1; n++; for (let j = 0; j < 3; j++) { val[c * 3 + j] = sum[c * 3 + j] / cnt[c]; mean[j] += val[c * 3 + j]; } }
    if (n) {
      for (let c = 0; c < gw * gh; c++) if (!known[c]) for (let j = 0; j < 3; j++) val[c * 3 + j] = mean[j] / n;
      for (let it = 0; it < 60; it++) for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
        const c = gy * gw + gx; if (known[c]) continue;
        for (let j = 0; j < 3; j++) { let t = 0, k = 0; for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = gx + u, b = gy + v; if (a >= 0 && b >= 0 && a < gw && b < gh) { t += val[(b * gw + a) * 3 + j]; k++; } } val[c * 3 + j] = t / k; }
      }
    }
    const at = (x, y, j) => {   // bilinear sample of the grid, at pixel (x, y)
      const fx = clamp01((x / cs - 0.5), gw - 1), fy = clamp01((y / cs - 0.5), gh - 1), x0 = fx | 0, y0 = fy | 0, x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      return (val[(y0 * gw + x0) * 3 + j] * (1 - tx) + val[(y0 * gw + x1) * 3 + j] * tx) * (1 - ty) + (val[(y1 * gw + x0) * 3 + j] * (1 - tx) + val[(y1 * gw + x1) * 3 + j] * tx) * ty;
    };
    const out = sg.createImageData(rw, rh), clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const i = (y * rw + x) * 4, a = S[i + 3]; if (!a) continue;
      for (let j = 0; j < 3; j++) out.data[i + j] = clamp255(P[i + j] + (n ? at(x, y, j) : 0));
      out.data[i + 3] = a;
    }
    const patch = mk(); patch.getContext('2d').putImageData(out, 0, 0);
    this.ctx.drawImage(patch, rx, ry);
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

  sprite(x, y, {ground = false} = {}) {
    const s = this.data.sprite, m = this.data.spriteMeta;
    // The fit may follow the object's top or bottom edge (see fit.point); anchor the cut-out at the same point.
    const point = this.data.point, ax = point === 'top' ? m?.tx : point === 'bottom' ? m?.bx : m?.cx, ay = point === 'top' ? m?.ty : point === 'bottom' ? m?.by : m?.cy;
    if (s && m) {
      // Beside a veiled real object the forked one needs to stand apart: a fork-coloured glow.
      const ctx = this.ctx; ctx.save();
      if (ground) {   // a car stands on the road: a soft contact shadow under it (the footage's own shadow is not part of the cut-out)
        const cx = x - (ax - m.left) + m.width / 2, by = y - (ay - m.top) + m.height * 0.96, rx = m.width * 0.5, ry = Math.max(4, m.height * 0.09);
        ctx.save(); ctx.translate(cx, by); ctx.scale(1, ry / rx); const g = ctx.createRadialGradient(0, 0, rx * 0.2, 0, 0, rx);
        g.addColorStop(0, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, 7); ctx.fill(); ctx.restore();
      }
      if (this.data.plateSteady === false && this.forking) { ctx.shadowColor = COL.fork; ctx.shadowBlur = 16 * this.scale(); }
      // Pulled back far, a small object (a ball) would be a speck: it is drawn up to ~16 screen px across, about its anchor.
      const cs = this.forking && this.cam ? this.cam.s : 1, up = Math.max(1, 16 / (Math.max(m.width, m.height) * cs));
      ctx.translate(x, y); ctx.scale(up, up); ctx.drawImage(s, -(ax - m.left), -(ay - m.top)); ctx.restore();
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

const clamp01 = (v, hi) => Math.max(0, Math.min(hi, v));

function wrap(ctx, text, width) {
  const out = []; let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? line + ' ' + word : word;
    if (ctx.measureText(next).width > width && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}
