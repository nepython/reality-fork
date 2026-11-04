// Sound effects, synthesised with WebAudio (no audio files). The stage announces moments with stage.onEffect(name, params)
// (see fx.js) and this module turns them into sound. Rules:
//  - nothing plays before a user gesture (browsers forbid it, and the page should not surprise anyone),
//  - nothing plays under prefers-reduced-motion, or when navigator.webdriver is set (tests and the video capture run muted),
//  - the mute button (injected into the fork bar) remembers its state in localStorage.
// renderSfxWav(name, params) draws the same sound with an OfflineAudioContext, so the video editor can lay it onto the demo
// video from a headless browser: it ignores the mute and gesture rules because it makes a file, not noise.

const MASTER = 0.34;                    // modest overall level; the peaks are also held by a compressor
const SR = 44100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const KEY = 'rf.muted';

// ---- the sounds -------------------------------------------------------------------------------------------------
// Each: dur(params) -> seconds of audio to render, and play(ctx, out, params, t0) that schedules the nodes.
// Noise is generated with a fixed seed so a rendered file is the same every time.
let noiseCache = new WeakMap();
function noise(ctx, kind = 'white') {
  const store = noiseCache.get(ctx) || {}; noiseCache.set(ctx, store);
  if (store[kind]) return store[kind];
  const len = SR * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), a = buf.getChannelData(0);
  let s = 12345, last = 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
  for (let i = 0; i < len; i++) {
    const w = rnd();
    if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; a[i] = last * 3.2; } else a[i] = w;
  }
  return store[kind] = buf;
}
function src(ctx, kind, t0, dur, loop = true) {
  const n = ctx.createBufferSource(); n.buffer = noise(ctx, kind); n.loop = loop; n.start(t0, 0); n.stop(t0 + dur + 0.05); return n;
}
function env(ctx, g, t0, pts) {            // pts: [[dt, value], ...] linear ramps from the first value
  g.gain.setValueAtTime(pts[0][1], t0 + pts[0][0]);
  for (let i = 1; i < pts.length; i++) g.gain.linearRampToValueAtTime(pts[i][1], t0 + pts[i][0]);
}
function chain(ctx, nodes, out) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); nodes.at(-1).connect(out); return nodes[0]; }
function bp(ctx, f, q, type = 'bandpass') { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
function gain(ctx, v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; }
function osc(ctx, type, f0, f1, t0, dur, curve = 'exp') {
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t0);
  if (curve === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur); else o.frequency.linearRampToValueAtTime(f1, t0 + dur);
  o.start(t0); o.stop(t0 + dur + 0.05); return o;
}

export const SOUNDS = {
  // Tyres locking up: band-passed noise with a downward sweep and a wobbling squeal on top. params: dur, level.
  skid: {
    dur: p => clamp(p.dur ?? 0.8, 0.2, 3) + 0.25,
    play(ctx, out, p, t0) {
      const d = clamp(p.dur ?? 0.8, 0.2, 3), lv = clamp(p.level ?? 0.7, 0.1, 1);
      const n = src(ctx, 'white', t0, d), f1 = bp(ctx, 1700, 5), f2 = bp(ctx, 3100, 9), g = gain(ctx, 0);
      f1.frequency.setValueAtTime(1900, t0); f1.frequency.exponentialRampToValueAtTime(900, t0 + d);
      const lfo = ctx.createOscillator(), lg = gain(ctx, 220); lfo.frequency.value = 13; lfo.connect(lg).connect(f1.frequency); lfo.start(t0); lfo.stop(t0 + d + 0.1);
      n.connect(f1); n.connect(f2); const sum = gain(ctx, 1); f1.connect(sum); const g2 = gain(ctx, 0.35); f2.connect(g2); g2.connect(sum);
      sum.connect(g).connect(out);
      env(ctx, g, t0, [[0, 0], [0.05, 2.1 * lv], [d * 0.8, 1.9 * lv], [d + 0.2, 0]]);
      const sq = osc(ctx, 'sawtooth', 1250, 760, t0, d), sf = bp(ctx, 1400, 3), sg = gain(ctx, 0);
      sq.connect(sf).connect(sg).connect(out); env(ctx, sg, t0, [[0, 0], [0.08, 0.1 * lv], [d, 0.06 * lv], [d + 0.2, 0]]);
    }
  },
  // A heavy, soft impact: a sine falling from 150 to 38 Hz, a low-passed noise burst, a short click. params: kmh.
  impact: {
    dur: () => 1.1,
    play(ctx, out, p, t0) {
      const lv = clamp(0.5 + 0.5 * (p.kmh ?? 40) / 50, 0.45, 1);
      const o = osc(ctx, 'sine', 150, 36, t0, 0.5), og = gain(ctx, 0); o.connect(og).connect(out);
      env(ctx, og, t0, [[0, 0], [0.004, 0.95 * lv], [0.5, 0]]);
      const o2 = osc(ctx, 'sine', 72, 30, t0, 0.7), o2g = gain(ctx, 0); o2.connect(o2g).connect(out); env(ctx, o2g, t0, [[0, 0], [0.01, 0.7 * lv], [0.7, 0]]);
      const n = src(ctx, 'white', t0, 0.4), lp = bp(ctx, 2200, 0.7, 'lowpass'), ng = gain(ctx, 0);
      lp.frequency.setValueAtTime(2200, t0); lp.frequency.exponentialRampToValueAtTime(260, t0 + 0.35);
      n.connect(lp).connect(ng).connect(out); env(ctx, ng, t0, [[0, 0], [0.003, 0.8 * lv], [0.3, 0]]);
      const c = src(ctx, 'white', t0, 0.03), hp = bp(ctx, 3000, 0.7, 'highpass'), cg = gain(ctx, 0);
      c.connect(hp).connect(cg).connect(out); env(ctx, cg, t0, [[0, 0], [0.001, 0.5 * lv], [0.02, 0]]);
    }
  },
  // A thrown body or object cutting the air (no crowd): noise through a band that rises then falls. params: dur, level.
  whoosh: {
    dur: p => clamp(p.dur ?? 0.7, 0.2, 3) + 0.2,
    play(ctx, out, p, t0) {
      const d = clamp(p.dur ?? 0.7, 0.2, 3), lv = clamp(p.level ?? 0.6, 0.1, 1);
      const n = src(ctx, 'white', t0, d), f = bp(ctx, 400, 1.3), g = gain(ctx, 0);
      f.frequency.setValueAtTime(350, t0); f.frequency.exponentialRampToValueAtTime(2600, t0 + d * 0.4); f.frequency.exponentialRampToValueAtTime(500, t0 + d);
      n.connect(f).connect(g).connect(out); env(ctx, g, t0, [[0, 0], [d * 0.4, 1.7 * lv], [d, 0]]);
    }
  },
  // Soft success: three sine notes (E5, B5, E6) with a faint triangle shimmer. No params.
  chime: {
    dur: () => 1.9,
    play(ctx, out, p, t0) {
      [[659.25, 0, 0.3], [987.77, 0.09, 0.22], [1318.5, 0.18, 0.16]].forEach(([f, dt, v]) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; const g = gain(ctx, 0);
        o.connect(g).connect(out); o.start(t0 + dt); o.stop(t0 + dt + 1.5); env(ctx, g, t0 + dt, [[0, 0], [0.012, v], [1.4, 0]]);
        const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f * 2; const g2 = gain(ctx, 0);
        o2.connect(g2).connect(out); o2.start(t0 + dt); o2.stop(t0 + dt + 0.6); env(ctx, g2, t0 + dt, [[0, 0], [0.01, v * 0.12], [0.5, 0]]);
      });
    }
  },
  // A ball's contact: a short pitch-dropping tock and a click, louder with speed. params: speed (m/s).
  bounce: {
    dur: () => 0.3,
    play(ctx, out, p, t0) {
      const lv = clamp(0.3 + 0.7 * (p.speed ?? 4) / 8, 0.25, 1);
      const o = osc(ctx, 'sine', 260, 95, t0, 0.12), g = gain(ctx, 0); o.connect(g).connect(out); env(ctx, g, t0, [[0, 0], [0.002, 1.5 * lv], [0.12, 0]]);
      const n = src(ctx, 'white', t0, 0.04), f = bp(ctx, 1600, 1.2), ng = gain(ctx, 0); n.connect(f).connect(ng).connect(out); env(ctx, ng, t0, [[0, 0], [0.001, 1.6 * lv], [0.03, 0]]);
    }
  },
  // A low rumble for an engine firing: brown noise under a throbbing saw, swelling in. params: dur, level.
  rumble: {
    dur: p => clamp(p.dur ?? 3, 0.5, 8) + 0.5,
    play(ctx, out, p, t0) {
      const d = clamp(p.dur ?? 3, 0.5, 8), lv = clamp(p.level ?? 0.7, 0.2, 1);
      const n = src(ctx, 'brown', t0, d), lp = bp(ctx, 160, 0.7, 'lowpass'), g = gain(ctx, 0); n.connect(lp).connect(g).connect(out);
      env(ctx, g, t0, [[0, 0], [0.5, 0.9 * lv], [d, 0.8 * lv], [d + 0.4, 0]]);
      const o = osc(ctx, 'sawtooth', 48, 62, t0, d, 'lin'), of = bp(ctx, 140, 0.5, 'lowpass'), og = gain(ctx, 0); o.connect(of).connect(og).connect(out);
      const lfo = ctx.createOscillator(), lg = gain(ctx, 0.12 * lv); lfo.frequency.value = 9; lfo.connect(lg).connect(og.gain); lfo.start(t0); lfo.stop(t0 + d + 0.5);
      env(ctx, og, t0, [[0, 0], [0.6, 0.2 * lv], [d, 0.22 * lv], [d + 0.4, 0]]);
      const c = src(ctx, 'white', t0, d), cf = bp(ctx, 700, 0.8), cg = gain(ctx, 0); c.connect(cf).connect(cg).connect(out); env(ctx, cg, t0, [[0, 0], [0.6, 0.07 * lv], [d, 0.06 * lv], [d + 0.4, 0]]);
    }
  },
  // A landing: a dull thump and a puff of noise. params: speed (m/s).
  thump: {
    dur: () => 0.6,
    play(ctx, out, p, t0) {
      const lv = clamp(0.35 + 0.65 * (p.speed ?? 4) / 8, 0.3, 1);
      const o = osc(ctx, 'sine', 95, 42, t0, 0.3), g = gain(ctx, 0); o.connect(g).connect(out); env(ctx, g, t0, [[0, 0], [0.005, 0.9 * lv], [0.3, 0]]);
      const n = src(ctx, 'white', t0, 0.2), f = bp(ctx, 500, 0.7, 'lowpass'), ng = gain(ctx, 0); n.connect(f).connect(ng).connect(out); env(ctx, ng, t0, [[0, 0], [0.004, 0.5 * lv], [0.16, 0]]);
    }
  },
  // A body sliding on the road: a gritty, fading scrape. params: dur, level.
  scrape: {
    dur: p => clamp(p.dur ?? 0.8, 0.2, 3) + 0.2,
    play(ctx, out, p, t0) {
      const d = clamp(p.dur ?? 0.8, 0.2, 3), lv = clamp(p.level ?? 0.5, 0.1, 1);
      const n = src(ctx, 'white', t0, d), f = bp(ctx, 900, 0.8), g = gain(ctx, 0);
      f.frequency.setValueAtTime(1100, t0); f.frequency.exponentialRampToValueAtTime(380, t0 + d);
      n.connect(f).connect(g).connect(out); env(ctx, g, t0, [[0, 0], [0.04, 1.2 * lv], [d * 0.5, 0.9 * lv], [d, 0]]);
    }
  },
};

function bus(ctx) {                      // a compressor and the master level: every sound goes through it
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;
  const m = gain(ctx, MASTER); m.connect(comp); comp.connect(ctx.destination); return m;
}

// ---- live playback ----------------------------------------------------------------------------------------------
let ctx = null, master = null, unlocked = false, muted = false;
try { muted = localStorage.getItem(KEY) === '1'; } catch { /* storage may be blocked: sound simply starts on */ }
const reduced = () => { try { return !!matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const silent = () => !!navigator.webdriver || reduced();
const listeners = new Set();

function unlock() {
  if (unlocked || silent()) return;
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
  try { ctx = new AC(); master = bus(ctx); unlocked = true; if (ctx.state === 'suspended') ctx.resume(); } catch { ctx = null; }
}
// A gesture can come from any control; the first one is enough.
if (typeof document !== 'undefined') for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, unlock, {once: false, passive: true});

export const sfx = {
  get muted() { return muted; },
  get available() { return !silent(); },
  setMuted(v) { muted = !!v; try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch { /* ignore */ } listeners.forEach(f => f(muted)); },
  toggle() { this.setMuted(!muted); if (!muted) unlock(); return muted; },
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  play(name, params = {}) {
    if (muted || !unlocked || !ctx || silent()) return;
    const s = SOUNDS[name]; if (!s) return;
    if (ctx.state === 'suspended') ctx.resume();
    try { s.play(ctx, master, params, ctx.currentTime + 0.01); } catch { /* a sound must never break the picture */ }
  },
};

// ---- offline rendering ------------------------------------------------------------------------------------------
/** Renders one effect to a mono 16-bit WAV (a Blob). Independent of the mute, gesture and reduced-motion rules. */
export async function renderSfxWav(name, params = {}) {
  const s = SOUNDS[name]; if (!s) throw new Error(`unknown sound ${name}`);
  const dur = s.dur(params), off = new OfflineAudioContext(1, Math.ceil(SR * dur), SR);
  s.play(off, bus(off), params, 0.0);
  const buf = await off.startRendering(), a = buf.getChannelData(0), out = new DataView(new ArrayBuffer(44 + a.length * 2));
  const w = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + a.length * 2, true); w(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, SR, true); out.setUint32(28, SR * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, a.length * 2, true);
  for (let i = 0; i < a.length; i++) out.setInt16(44 + i * 2, Math.round(clamp(a[i], -1, 1) * 32767), true);
  return new Blob([out.buffer], {type: 'audio/wav'});
}

// ---- the mute button --------------------------------------------------------------------------------------------
// Mounted by this module itself into the fork bar (#forkActive), so no other file needs to know about it. It carries a
// data-tip like the other controls; tips.js shows it.
function mountButton() {
  if (typeof document === 'undefined' || document.getElementById('sfxBtn')) return;
  const bar = document.getElementById('forkActive'); if (!bar) return;
  if (!document.getElementById('sfxStyle')) {
    const st = document.createElement('style'); st.id = 'sfxStyle';
    st.textContent = '.sfx-btn{background:transparent;border:1px solid var(--line,#394056);border-radius:999px;width:30px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;color:inherit;cursor:pointer}.sfx-btn:hover{border-color:var(--text,#fff)}.sfx-btn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.sfx-btn .off{display:none}.sfx-btn[aria-pressed="true"] .on{display:none}.sfx-btn[aria-pressed="true"] .off{display:inline}.sfx-btn[aria-pressed="true"]{opacity:.7}';
    document.head.append(st);
  }
  const b = document.createElement('button'); b.type = 'button'; b.id = 'sfxBtn'; b.className = 'sfx-btn';
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path class="on" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/><path class="off" d="M17 9l5 6M22 9l-5 6"/></svg>';
  const paint = () => { b.setAttribute('aria-pressed', String(muted)); b.setAttribute('aria-label', muted ? 'Turn effect sounds on' : 'Mute effect sounds'); b.dataset.tip = muted ? 'Sound effects are off. Click to turn them on' : 'Sound effects on (impact, brakes, bounces). Click to mute'; };
  paint(); b.onclick = () => { sfx.toggle(); paint(); };
  sfx.onChange(paint);
  const before = document.getElementById('saveClip') || document.getElementById('realityBtn'); bar.insertBefore(b, before);
  if (reduced()) b.hidden = true;   // reduced motion never plays sound, so the control would promise nothing (headless runs keep it for screenshots)
}
if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountButton); else mountButton(); }
