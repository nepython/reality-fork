// The stage: the clip with its measurements drawn over it, and the fork, where the real object is erased from every
// frame (SAM's mask filled from the clean plate) and redrawn on the path the changed physics gives it.
const COL = {measured: '#ffd60a', fit: '#00c8ff', fork: '#ff40a0', mask: 'rgba(124, 92, 255, 0.38)'};

export class Stage {
  constructor({video, canvas, badge, onFrame}) {
    Object.assign(this, {video, canvas, badge, onFrame});
    this.ctx = canvas.getContext('2d');
    this.data = null;       // {fps, frames, width, height, track, fitPath, forkPath, masks, plate, sprite, spriteMeta, world}
    this.show = {mask: true, path: true, law: true};
    this.frame = 0;
    this.forking = false;
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
  setFork(path, {label, start, end, baseline} = {}) {
    this.data.forkPath = path;
    this.data.basePath = baseline || null;
    this.forking = !!path;
    this.forkLabel = label;
    this.forkEnd = end ?? (path ? path.at(-1)[0] : 0);
    this.video.style.visibility = this.forking ? 'hidden' : 'visible';
    this.stopFreeRun();
    if (this.forking) this.seek(Math.max(0, (start ?? path[0][0]) - Math.round(this.data.fps * 0.4)), true);
    else this.redraw();
  }

  seek(frame, play = false) {
    this.stopFreeRun();
    const f = Math.max(0, frame);
    if (f > this.data.frames - 1) { this.frame = f; this.draw(f); return; }
    this.video.currentTime = (f + 0.5) / this.data.fps;
    if (play) this.video.play().catch(() => {});
  }

  startFreeRun() {
    // The forked object can outlive the footage (a Moon fall lasts ~2.5x longer): hold the last frame and keep going.
    this.freeRun = true;
    this.t0 = performance.now();
    this.f0 = this.data.frames - 1;
    requestAnimationFrame(this.loop);
  }
  stopFreeRun() { this.freeRun = false; }
  loop(now) {
    if (!this.freeRun) return;
    const f = this.f0 + Math.floor((now - this.t0) / 1000 * this.data.fps);
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
    if (this.forking) this.drawFork(frame);
    else {
      if (this.show.mask && d.masks) this.drawMask(frame, COL.mask);
      if (this.show.law && d.fitPath) {
        this.curve(d.fitPath, COL.fit, 2.5);
        const p = d.fitPath.find(q => q[0] === frame);
        if (p) this.ring(p[1], p[2], this.radius(), COL.fit);
      }
      if (this.show.path && d.track) this.dots(d.track.filter(q => q[0] <= frame), COL.measured);
    }
    this.onFrame?.(frame);
  }

  drawFork(frame) {
    const d = this.data, ctx = this.ctx;
    const inClip = frame <= d.frames - 1;
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
    if (p && frame >= start) this.sprite(p[1], p[2]);
    this.gapText = '';
    if (p && frame >= start && d.plateSteady === false) this.gapLines(frame, p);
    else if (d.world && frame < start) { const q = d.track?.find(r => r[0] === frame); if (q) this.sprite(q[1], q[2]); }
    if (this.badge) {
      this.badge.hidden = false;
      const t = Math.max(0, (frame - start) / d.fps);
      this.badge.innerHTML = `<span class="k">${this.forkLabel || 'fork'}</span> · t = ${t.toFixed(2)} s${this.gapText ? ' · ' + this.gapText + ' than reality' : ''}`;
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
  maskCanvas(frame, pad = 6) {
    const d = this.data, cache = this.maskCache ||= new Map(), key = frame + ':' + pad;
    if (cache.has(key)) return cache.get(key);
    const m = d.masks?.get(frame);
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

  drawMask(frame, color, pad = 0) {
    const m = this.maskCanvas(frame, pad);
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
    tick(p[1], p[2], COL.fork, (this.forkLabel || 'fork') + (this.gapText ? '  ' + this.gapText : ''), true);
    ctx.restore();
  }

  radius() { const t = this.data.track; return t?.length ? Math.max(4, (t[Math.floor(t.length / 2)][3] || 16) / 2) : 10; }
  scale() { return this.data.width / 1280 + 0.4; }

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
