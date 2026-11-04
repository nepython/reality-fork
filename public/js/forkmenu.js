// The fork menu: a grid of cards over the video frame, one per fork, each previewing the forked path on the clip's own plate.
// Every number on a card comes from the /api/fork response (free: no model call); nothing is invented here.
import {whatIf} from './whatif.js';
let sheet = false;
const cache = new Map(); // clip + overrides -> response promise, so reopening the menu is instant
let uid = 0;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const r1 = v => (Math.round(v * 10) / 10).toString();

// Which forks fit: Reality, then the worlds (the headline feature), the agent's own, then the rest; shown in their given order.
function pick(items, max) {
  if (items.length <= max) return items;
  const rank = it => it.real ? -1 : ['moon', 'mars', 'jupiter'].includes(kindOf(it)) ? 0 : it.agent ? 1 : 2;
  const keep = new Set([...items].sort((a, b) => rank(a) - rank(b)).slice(0, max));
  return items.filter(it => keep.has(it));
}

function ask(clipId, overrides) {
  const key = clipId + JSON.stringify(overrides || {});
  if (!cache.has(key)) {
    const p = fetch(`/api/fork?clip=${encodeURIComponent(clipId)}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({overrides: overrides || {}})})
      .then(r => r.json()).catch(e => ({error: 'Could not reach the physics engine (' + e.message + ').'}));
    cache.set(key, p);
    p.then(r => { if (r.error) cache.delete(key); }); // an error may be transient: ask again next time
  }
  return cache.get(key);
}

// ---- what kind of fork is it, and what does the response say about it --------------------------------------------------
const WORLDS = [['moon', 'Moon', 1.62], ['mars', 'Mars', 3.71], ['jupiter', 'Jupiter', 24.79]];
function kindOf(it) {
  const o = it.overrides || {};
  if (it.real) return 'real';
  if (it.vehicle || o.brake || o.speed_kmh != null) return 'car';
  const g = it.g ?? o.g, earth = g != null && Math.abs(g - 9.81) < 0.05;
  if (g != null && !(earth && ((it.e ?? o.e) != null || (it.drag ?? o.drag)))) return WORLDS.find(w => Math.abs(w[2] - g) < 0.01)?.[0] || 'world';
  if ((it.drag ?? o.drag) === 'none') return 'vacuum';
  if ((it.e ?? o.e) != null) return 'bounce';
  return 'other';
}

// The headline: what changed, in the response's own numbers. Returns {big, small, tone}.
function headline(it, res) {
  if (res.error) return {big: 'Cannot run this fork', small: res.error, tone: 'err'};
  const out = res.hazard?.outcome, s = res.summary || '';
  if (out) return out.kind === 'stops'
    ? {big: `Stops ${r1(out.short_m)} m short`, small: `from ${Math.round(res.hazard.speed_kmh)} km/h`, tone: 'ok'}
    : {big: `Hits at ${out.impact_kmh} km/h`, small: `from ${Math.round(res.hazard.speed_kmh)} km/h`, tone: 'bad'};
  let m;
  if ((m = s.match(/in the air for ([\d.]+) s instead of ([\d.]+) s/))) return {big: `${r1(+m[1])} s in the air`, small: `instead of ${r1(+m[2])} s`};
  if ((m = s.match(/lands ([\d.]+) m (farther|closer|shorter)/))) return {big: `Lands ${m[1]} m ${m[2]}`, small: 'than the filmed throw'};
  if ((m = s.match(/first hits the floor after ([\d.]+) s instead of ([\d.]+) s/))) return {big: `First bounce at ${r1(+m[1])} s`, small: `instead of ${r1(+m[2])} s`};
  if ((m = s.match(/bounces (\d+) times \(instead of (\d+)\)/))) return {big: `${m[1]} bounces`, small: `instead of ${m[2]}`};
  if (!s) return {big: 'Same as reality', small: 'this change leaves the path alone'};
  const first = s.split(/(?<=\.)\s/)[0];
  return {big: first.length > 78 ? first.slice(0, 75) + '…' : first, small: ''};
}

// ---- the preview picture ------------------------------------------------------------------------------------------------
const inside = (p, W, H) => p[1] >= 0 && p[1] <= W && p[2] >= 0 && p[2] <= H;

// Where the path last leaves the frame (interpolated on the edge) and which way it is heading; null if it stays in.
function exitOf(path, W, H) {
  let seen = false;
  for (let i = 0; i < path.length; i++) {
    if (inside(path[i], W, H)) { seen = true; continue; }
    if (!seen) continue;
    const a = path[i - 1], b = path[i], dx = b[1] - a[1], dy = b[2] - a[2];
    let t = 1;
    if (dx) t = Math.min(t, ((dx > 0 ? W : 0) - a[1]) / dx);
    if (dy) t = Math.min(t, ((dy > 0 ? H : 0) - a[2]) / dy);
    return {x: a[1] + dx * t, y: a[2] + dy * t, ang: Math.atan2(dy, dx) * 180 / Math.PI};
  }
  const last = path.at(-1);
  if (last && !seen) { // never in shot: point at where it is, from the nearest edge
    const x = Math.min(W, Math.max(0, last[1])), y = Math.min(H, Math.max(0, last[2]));
    return {x, y, ang: Math.atan2(last[2] - y, last[1] - x) * 180 / Math.PI};
  }
  return null;
}

function preview(box, d) {
  const {W, H} = d, bw = box.clientWidth || 200, bh = box.clientHeight || 110, asp = bw / bh;
  const fork = d.path || [], real = d.real || [];
  const pts = [...fork, ...real].filter(p => inside(p, W, H));
  const mark = d.mark && d.mark.x >= 0 && d.mark.x <= W && d.mark.y >= 0 && d.mark.y <= H ? d.mark : null;
  if (mark) pts.push([0, mark.x, mark.y]);
  if (d.hazard && inside([0, d.hazard.x_px, d.hazard.y_px], W, H)) pts.push([0, d.hazard.x_px, d.hazard.y_px]);
  let x0 = 0, y0 = 0, w = W, h = H;
  if (pts.length) {
    const xs = pts.map(p => p[1]), ys = pts.map(p => p[2]), bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    w = Math.max((bx1 - bx0) * 1.4, W * 0.45); h = w / asp;
    if (h < (by1 - by0) * 1.4) { h = (by1 - by0) * 1.4; w = h * asp; }
    if (w > W) { w = W; h = w / asp; }
    if (h > H) { h = H; w = h * asp; }
    x0 = Math.min(W - w, Math.max(0, (bx0 + bx1) / 2 - w / 2)); y0 = Math.min(H - h, Math.max(0, (by0 + by1) / 2 - h / 2));
  }
  const sw = w / 190, line = p => p.length > 1 ? 'M' + p.map(q => q[1] + ' ' + q[2]).join('L') : '';
  const id = 'c' + (++uid), ex = d.fork ? exitOf(fork, W, H) : null, m = sw * 6;
  let s = `<svg viewBox="${r1(x0)} ${r1(y0)} ${r1(w)} ${r1(h)}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><clipPath id="${id}"><rect width="${W}" height="${H}"/></clipPath></defs><g clip-path="url(#${id})">
    <image href="${esc(d.plateUrl)}" width="${W}" height="${H}" preserveAspectRatio="none"/>
    <rect width="${W}" height="${H}" fill="#070910" opacity=".28"/>`;
  if (real.length) s += `<path d="${line(real)}" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="${sw * 1.7}" stroke-linecap="round" stroke-dasharray="0 ${sw * 3.6}"/>`;
  if (d.fork && fork.length) s += `<path class="fm-line" pathLength="1" d="${line(fork)}" fill="none" stroke="var(--fork,#ff40a0)" stroke-width="${sw * 2.6}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const a = (d.fork ? fork : real)[0];
  if (a && inside(a, W, H)) s += `<circle cx="${a[1]}" cy="${a[2]}" r="${sw * 3}" fill="#fff" stroke="#0b0d12" stroke-width="${sw}"/>`;
  if (d.hazard) { // the person who steps out: a small walking figure on the road
    const {x_px: x, y_px: y} = d.hazard, k = sw * .75;
    if (inside([0, x, y], W, H)) s += `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><circle cx="0" cy="-27" r="4" fill="#ffb020" stroke="none"/><path d="M0-22v13M0-9l-5 10M0-9l6 9M0-19l-6 6M0-19l6 5"/></g>`;
  }
  if (mark) {
    const bad = d.mark.kind === 'impact', c = bad ? 'var(--bad,#ff5b5b)' : 'var(--ok,#3ddc97)';
    s += bad ? `<path transform="translate(${mark.x} ${mark.y}) scale(${sw})" d="M0-11l3 7 8-2-5 6 6 5-8 0-4 7-3-7-8 2 5-6-6-5 8 0z" fill="${c}" stroke="#0b0d12" stroke-width="1"/>`
      : `<g transform="translate(${mark.x} ${mark.y})"><circle r="${sw * 5}" fill="${c}" stroke="#0b0d12" stroke-width="${sw}"/><path d="M${-sw * 2.4} 0l${sw * 1.7} ${sw * 1.8} ${sw * 3.2}-${sw * 3.6}" fill="none" stroke="#0b0d12" stroke-width="${sw * 1.5}" stroke-linecap="round"/></g>`;
  } else if (d.fork && !ex && fork.length) { // it comes to rest in frame: a ball where it ends
    const z = fork.at(-1);
    if (inside(z, W, H)) s += `<circle cx="${z[1]}" cy="${z[2]}" r="${sw * 3.6}" fill="var(--fork,#ff40a0)" stroke="#fff" stroke-width="${sw * 1.2}"/>`;
  }
  s += '</g>';
  if (ex) { // it leaves the frame: an arrow on the edge it goes out through
    const x = Math.min(x0 + w, Math.max(x0, ex.x)), y = Math.min(y0 + h, Math.max(y0, ex.y)), k = m * 1.25;
    // Pulled in from the frame edge when that edge is the preview's too, so the arrow stays visible.
    const px = x - (x >= x0 + w - 0.5 ? k * .9 : 0) + (x <= x0 + .5 ? k * .9 : 0), py = y - (y >= y0 + h - .5 ? k * .9 : 0) + (y <= y0 + .5 ? k * .9 : 0);
    s += `<g class="fm-exit" transform="translate(${px} ${py}) rotate(${ex.ang})"><path d="M${-k * .7} ${-k * .75}L${k * .9} 0L${-k * .7} ${k * .75}L${-k * .3} 0Z" fill="var(--fork,#ff40a0)" stroke="#fff" stroke-width="${sw * 1.2}" stroke-linejoin="round"/></g>`;
  }
  box.querySelector(':scope > svg')?.remove();
  box.insertAdjacentHTML('afterbegin', s + '</svg>');
}

// ---- art per kind: inline SVG, no images -----------------------------------------------------------------------------------
function art(kind, it, res, p) {
  const disc = (fill, extra) => `<svg viewBox="0 0 48 48"><defs>${fill}</defs><circle cx="24" cy="24" r="21" fill="url(#${p}f)"/>${extra}<circle cx="24" cy="24" r="21" fill="url(#${p}s)"/></svg>`;
  const shade = `<radialGradient id="${p}s" cx=".32" cy=".28" r=".85"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>`;
  const grad = (a, b) => `${shade}<radialGradient id="${p}f" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient>`;
  if (kind === 'moon') return disc(grad('#d9d9dc', '#8a8a92'), '<g fill="#6f6f78" opacity=".6"><circle cx="16" cy="18" r="5"/><circle cx="31" cy="14" r="3"/><circle cx="30" cy="30" r="6"/><circle cx="14" cy="32" r="2.6"/><circle cx="24" cy="23" r="2"/></g><g fill="none" stroke="#fff" stroke-opacity=".3"><circle cx="16" cy="18" r="5"/><circle cx="30" cy="30" r="6"/></g>');
  if (kind === 'mars') return disc(grad('#e8956a', '#9c3d1e'), '<g fill="#6e2a14" opacity=".5"><path d="M8 24q6-6 12-2t8 7-9 6z"/><circle cx="33" cy="17" r="4"/></g><ellipse cx="24" cy="5.5" rx="9" ry="3" fill="#fff" opacity=".8"/>');
  if (kind === 'jupiter') return disc(grad('#f3dfbd', '#b27a48'), `<clipPath id="${p}c"><circle cx="24" cy="24" r="21"/></clipPath><g clip-path="url(#${p}c)"><rect y="9" width="48" height="5" fill="#c28b5a" opacity=".8"/><rect y="17" width="48" height="4" fill="#8e5532" opacity=".7"/><rect y="25" width="48" height="6" fill="#d9a977" opacity=".8"/><rect y="34" width="48" height="4" fill="#9a603a" opacity=".7"/><ellipse cx="31" cy="30" rx="5" ry="3" fill="#b83a22"/></g>`);
  if (kind === 'world') return disc(grad('#7fc3ff', '#2a4f8a'), (Math.abs((it.g ?? it.overrides?.g) - 9.81) < 0.05 ? '<g fill="#3a9a5a" opacity=".85"><path d="M10 16q8-6 14 0t-2 9-10-1z"/><path d="M28 28q7-3 10 3t-6 8z"/></g>' : '') + (Math.abs((it.g ?? it.overrides?.g) - 9.81) < 0.05 ? '' : '<ellipse cx="24" cy="24" rx="29" ry="6" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2" transform="rotate(-20 24 24)"/>'));
  if (kind === 'vacuum') return `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="#0a0d16" stroke="#8b93a7" stroke-opacity=".5" stroke-dasharray="2 3"/><path d="M12 35C14 20 26 11 38 11C37 24 28 34 14 36" fill="#cfe9ff" fill-opacity=".9" stroke="#fff"/><path d="M14 36L10 40M17 31C23 26 28 20 33 15M20 33C25 29 30 24 34 18" fill="none" stroke="#5a87a8" stroke-width="1.2" stroke-linecap="round"/><path d="M8 8L40 40" stroke="var(--fork,#ff40a0)" stroke-width="3.4" stroke-linecap="round"/></svg>`;
  if (kind === 'bounce') return `<svg viewBox="0 0 48 48"><path d="M3 42h42" stroke="#8b93a7" stroke-width="2" stroke-linecap="round"/><path d="M5 40Q9 5 20 40Q25 18 31 40Q34 28 38 40" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="2" stroke-dasharray="1 4" stroke-linecap="round"/><circle cx="38" cy="33" r="7" fill="#ff9d2e" stroke="#fff"/><path d="M32 33h12M38 26v14" stroke="#7a3d00" stroke-width="1.2" opacity=".7"/></svg>`;
  if (kind === 'car') { // a dial in km/h, with the speed the fork runs at
    const v = res?.hazard?.speed_kmh ?? it.vehicle?.speed_kmh ?? it.overrides?.speed_kmh;
    if (!Number.isFinite(v)) return '';
    const max = 60, f = Math.min(1, v / max), a = Math.PI * (1 - f), cx = 28, cy = 30, R = 22;
    const pt = (t, r) => `${r1(cx + Math.cos(t) * r)} ${r1(cy - Math.sin(t) * r)}`;
    let tk = ''; for (let i = 0; i <= 6; i++) { const t = Math.PI * (1 - i / 6); tk += `<path d="M${pt(t, R - 5)}L${pt(t, R)}" stroke="#fff" stroke-opacity=".55"/>`; }
    const col = v < 25 ? 'var(--ok,#3ddc97)' : v < 40 ? 'var(--warn,#ffb020)' : 'var(--bad,#ff5b5b)';
    return `<svg viewBox="0 0 56 44"><path d="M${pt(Math.PI, R)}A${R} ${R} 0 0 1 ${pt(0, R)}" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="5"/><path d="M${pt(Math.PI, R)}A${R} ${R} 0 0 1 ${pt(a, R)}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round"/><g fill="none" stroke-width="1.2">${tk}</g><path d="M${cx} ${cy}L${pt(a, R - 7)}" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="3" fill="#fff"/><text x="${cx}" y="43" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" font-family="var(--mono,monospace)">${Math.round(v)} km/h</text></svg>`;
  }
  if (kind === 'real') return `<svg viewBox="0 0 48 48"><rect x="6" y="12" width="36" height="26" rx="4" fill="#12151d" stroke="#fff" stroke-width="2"/><g fill="#fff"><rect x="9" y="15" width="3" height="3" rx=".8"/><rect x="9" y="22" width="3" height="3" rx=".8"/><rect x="9" y="29" width="3" height="3" rx=".8"/><rect x="36" y="15" width="3" height="3" rx=".8"/><rect x="36" y="22" width="3" height="3" rx=".8"/><rect x="36" y="29" width="3" height="3" rx=".8"/></g><path d="M20 19l11 6-11 6z" fill="var(--fit,#00c8ff)"/></svg>`;
  return `<svg viewBox="0 0 48 48"><path d="M24 5l4 13 13 4-13 4-4 13-4-13-13-4 13-4z" fill="var(--fork,#ff40a0)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

// ---- the menu ---------------------------------------------------------------------------------------------------------------
export function renderForkMenu(el, items, {clipId, info, plateUrl, realPath, onPick, active, question} = {}) {
  if (!sheet) { sheet = true; const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = new URL('../fork.css', import.meta.url).href; document.head.append(l); }
  items = pick(items || [], el.clientWidth >= 1000 ? 8 : 6);
  const W = info?.width || 1280, H = info?.height || 720, pre = 'fm' + (++uid) + '_';
  el.classList.add('fm'); el.innerHTML = '';
  const head = document.createElement('div'); head.className = 'fm-head';
  // The header repeats the context for someone who has forgotten the first question.
  head.innerHTML = `<h2><em>What if…</em></h2><p>${question ? `You asked: <b class="fm-q">${esc(question)}</b>. ` : ''}Pick a change and the same footage is replayed with it. <span>The object is re-simulated under the new rules, and the previews are computed live, not generated.</span></p>`;
  const grid = document.createElement('div'); grid.className = 'fm-grid'; grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', 'Forks of this clip');
  el.append(head, grid);
  let cur = active ?? null, dead = false, focus = 0;
  const cards = items.map((it, i) => {
    const b = document.createElement('button'), kind = kindOf(it);
    b.type = 'button'; b.className = 'fm-card loading'; b.dataset.kind = kind; b.style.setProperty('--i', i);
    if (it.agent) b.dataset.agent = '1';
    b.tabIndex = i === 0 ? 0 : -1;
    b.innerHTML = `<span class="fm-pv"><span class="fm-skel"></span><span class="fm-art"></span>${it.agent ? '<span class="fm-badge"><i></i>Muse Spark<span class="fm-bs">&nbsp;suggests</span></span>' : ''}<span class="fm-g"></span></span>
      <span class="fm-tx"><b class="fm-name">${esc(whatIf(it))}</b><span class="fm-big"></span><span class="fm-small"></span></span>`;
    b.querySelector('.fm-art').innerHTML = art(kind, it, null, pre + i);
    const gv = it.g ?? it.overrides?.g, ev = it.e ?? it.overrides?.e;
    b.querySelector('.fm-g').textContent = it.real ? 'as filmed' : gv != null ? `g = ${+(+gv).toFixed(2)} m/s²` : (it.drag ?? it.overrides?.drag) === 'none' ? 'no drag' : ev != null && ev >= 0 ? `bounce ${ev}` : '';
    b.setAttribute('aria-label', `${whatIf(it)} ${it.why || ''}`.trim());
    b.onclick = () => { setActive(it.label); onPick?.(it); };
    grid.append(b);
    return {b, it, kind, data: null};
  });

  function setActive(label) {
    cur = label ?? null;
    for (const c of cards) { const on = c.it.label === cur; c.b.classList.toggle('active', on); c.b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  }
  setActive(cur);

  // Columns chosen so cards are about 1.4:1 and the whole grid fits the frame without scrolling.
  function layout() {
    const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
    const u = Math.max(.6, Math.min(1.15, w / 1000)), n = cards.length, headH = head.offsetHeight + 8, gap = 12 * u;
    let best = 1, bestScore = 1e9;
    for (let c = 1; c <= Math.min(4, n); c++) {
      const rows = Math.ceil(n / c), cw = (w - 2 * 22 * u - gap * (c - 1)) / c, ch = (h - headH - 22 * u - gap * (rows - 1)) / rows;
      const score = Math.abs(Math.log(cw / ch / 1.4)) + (cw < 150 ? 2 : 0) + (c * rows - n) * .12;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    el.style.setProperty('--u', u); grid.style.setProperty('--cols', best); grid.dataset.cols = best;
    el.classList.toggle('short', h < 440); el.classList.toggle('tight', (h - headH - 22 * u - gap) / Math.ceil(n / best) < 140);
    for (const c of cards) if (c.data) preview(c.b.querySelector('.fm-pv'), c.data.pv);
  }
  const ro = new ResizeObserver(() => { if (!dead) layout(); }); ro.observe(el);
  layout();

  // Previews: all asked at once; each card fills in as its answer arrives.
  cards.forEach(async (c, i) => {
    const {it, b} = c, res = it.real ? {} : await ask(clipId, it.overrides);
    if (dead) return;
    const real = realPath || res.real || [], h = headline(it, res), pv = b.querySelector('.fm-pv');
    let path = res.path;
    if (it.real) { path = real; h.big = 'Exactly as measured'; h.small = info?.frames ? `${r1(info.frames / info.fps)} s of footage` : ''; h.tone = ''; }
    const mark = res.hazard?.event ? {x: res.hazard.event.x_px, y: res.hazard.event.y_px, kind: res.hazard.event.kind} : null;
    c.data = {pv: {W, H, plateUrl, real, path, fork: !it.real && !res.error, hazard: res.hazard, mark}, h};
    b.classList.remove('loading'); b.dataset.tone = h.tone || '';
    b.classList.toggle('err', !!res.error);
    b.querySelector('.fm-big').textContent = h.big; b.querySelector('.fm-small').textContent = h.small;
    b.querySelector('.fm-art').innerHTML = art(c.kind, it, res, pre + i);
    // The tooltip and the accessible name carry the fork's reason and its outcome, plus any warning the engine raised.
    const warn = (res.warnings || []).join(' ');
    const text = [whatIf(it), it.agent && it.label !== whatIf(it) ? `Muse Spark's suggestion: ${it.label}.` : '', it.why, h.big + (h.small && !res.error ? ' ' + h.small : '') + '.', res.error ? '' : res.summary, warn].filter(Boolean).join(' ');
    b.title = text; b.setAttribute('aria-label', text);
    if (warn) { const w = document.createElement('span'); w.className = 'fm-warn'; w.textContent = '!'; w.title = warn; pv.append(w); }
    preview(pv, c.data.pv);
    b.classList.add('ready');
  });

  grid.addEventListener('keydown', e => {
    const k = e.key, i = cards.findIndex(c => c.b === document.activeElement); if (i < 0) return;
    const cols = +grid.dataset.cols || 1; let j = i;
    if (k === 'ArrowRight') j = Math.min(cards.length - 1, i + 1); else if (k === 'ArrowLeft') j = Math.max(0, i - 1);
    else if (k === 'ArrowDown') j = Math.min(cards.length - 1, i + cols); else if (k === 'ArrowUp') j = Math.max(0, i - cols);
    else if (k === 'Home') j = 0; else if (k === 'End') j = cards.length - 1; else return;
    e.preventDefault(); cards[j].b.focus();
  });
  grid.addEventListener('focusin', e => { const i = cards.findIndex(c => c.b === e.target); if (i >= 0) { cards[focus].b.tabIndex = -1; focus = i; cards[i].b.tabIndex = 0; } });

  return {setActive, destroy() { dead = true; ro.disconnect(); el.innerHTML = ''; el.classList.remove('fm', 'short'); }};
}
