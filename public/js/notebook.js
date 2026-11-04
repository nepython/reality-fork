// The lab chat: the user's questions and forks as bubbles, the agent's run as assistant messages with inline results.
// What is shown, and when, is decided by director.js; this file only builds and fills the messages.
import {vehicleOf, kmhText} from './vehicle.js';
const unit = u => String(u ?? '').replace('^2', '²').replace('^3', '³').replace('deg', '°');
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
export const num = (v, s) => {
  if (v == null || !isFinite(v)) return '–';
  // Round the value to the precision its uncertainty supports (two significant figures of sigma).
  if (s && isFinite(s) && s > 0) { const d = Math.max(0, 1 - Math.floor(Math.log10(s))); return v.toFixed(Math.min(d, 6)); }
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3);
};
export const TOOL = {
  track_objects: a => ['sam', `Tracking <code>${esc(a.prompt)}</code> in every frame`],
  set_scale: a => ['lab', `Setting the scale from ${esc(a.object || a.prompt)}: ${+Number(a.real_size_m).toPrecision(3)} m ${esc(a.dimension)} (±${+Number(a.size_uncertainty_m).toPrecision(2)} m)`],
  fit_motion: a => ['lab', `Fitting laws of motion to <code>${esc(a.object)}</code>${a.models?.length ? ' (' + a.models.map(esc).join(', ') + ')' : ''}${Object.keys(a.fixed || {}).length ? ' with ' + esc(JSON.stringify(a.fixed)) + ' fixed' : ''}`],
  check_overlay: a => ['lab', `Checking the fit against the footage`],
  final_report: () => ['spark', 'Writing the report'],
};
export const MODEL_NAME = {'constant-velocity': 'constant velocity', projectile: 'free flight', 'projectile-drag': 'flight with air drag',
  bounce: 'bouncing', pendulum: 'pendulum', incline: 'down a slope', oscillator: 'oscillation'};
// Tooltips of the step indicator for each tool the agent calls: [in progress, done].
const STEP = {
  track_objects: ['SAM 3.1 is tracking the object in every frame', 'SAM 3.1 tracked the object in every frame'],
  set_scale: ['The lab is setting the scale from an object of known size', 'The lab set the scale from an object of known size'],
  fit_motion: ['The lab is fitting and ranking laws of motion', 'The lab fitted and ranked the laws of motion'],
  check_overlay: ['The lab is checking its law against the footage', 'The lab checked its law against the footage'],
  final_report: ['Muse Spark is writing the report', 'Muse Spark wrote the report'],
};
export const STEPS = {
  watch: ['Muse Spark is watching the clip', 'Muse Spark watched the clip'],
  say: ['Muse Spark is explaining its next step', 'Muse Spark explained its next step'],
  report: ['Muse Spark is writing the report', 'Muse Spark wrote the report with error bars'],
  fork: ['The lab is preparing the fork', 'The lab prepared the fork'],
};
const WHO = {spark: 'Muse Spark', sam: 'SAM 3.1', lab: 'Lab', image: 'Muse Image', err: 'Problem'};
// Runs saved before lib/agent.mjs filtered them can still hold markup or the stray chat-product line.
export const strayLine = t => /<[a-z]+:function_calls|<invoke name=|feedback on this answer|type it here/i.test(t);

// The value a law is best known by, as text: "g = 1.85 ± 0.18 m/s²", or "g unconstrained" when the data cannot pin it down.
export function keyValue(m) {
  const main = m.derived?.find(d => d.name === 'g') || m.derived?.[0];
  if (!main) return {main, text: ''};
  // A parameter the data cannot pin down (sigma far above its value) is shown as such, not as a number.
  const loose = !isFinite(main.sigma) || Math.abs(main.sigma) > 3 * Math.abs(main.value);
  return {main, loose, text: loose ? `${main.name} unconstrained` : `${main.name} = ${num(main.value, main.sigma)}${main.sigma ? ' ± ' + num(main.sigma, main.sigma) : ''} ${unit(main.unit)}`.trim()};
}

export class Notebook {
  constructor({list, state, panel}) { Object.assign(this, {list, state, panel}); this.open = new Set(); }

  clear(note = '') { this.list.innerHTML = ''; this.open.clear(); this.state.textContent = note; this.welcome(); }

  // What a run does. It is the chat's first message while the chat is empty and, from the first question on, lives
  // behind the info button (app.js shows the same text in a popover).
  static introHtml() {
    return `Pick a sample clip and its own question is sent at once; or type your own question and press <b>Run the lab</b>. Here is what happens:
      <ol class="intro">
        <li><span class="chip spark">Muse Spark</span> watches your clip and plans the experiment: what moves, what sets the scale.</li>
        <li><span class="chip sam">SAM 3.1</span> follows the object through every frame, pixel-accurate, giving its path to a fraction of a pixel.</li>
        <li><b>Laws are fitted and ranked</b>: free flight, drag, bouncing, pendulum, slope, spring. Every number gets an error bar.</li>
        <li><b>The agent checks itself</b>: it draws its law over the real frames, looks, and fixes what doesn't match.</li>
        <li><span class="chip image">Muse Image</span> <b>Fork reality</b>: replay your footage on the Moon, without air, or bouncier.</li>
      </ol>`;
  }
  welcome() { this.msg('spark', Notebook.introHtml(), {intro: true}); }

  scroll() { this.list.scrollTop = this.list.scrollHeight; }

  user(text) {
    const li = document.createElement('li');
    li.className = 'msg user';
    li.innerHTML = '<div class="bubble"></div>';
    li.firstChild.textContent = text;
    this.list.querySelector('.intro-msg')?.remove();
    this.finishAll();
    this.list.append(li); this.scroll();
    return li;
  }

  // An assistant message with a header chip naming who acts. At its left sits a step indicator: a ring while the beat is
  // in progress, a tick once it is done. `step` is [while working, when done] for its tooltip; `done` skips the ring.
  // A beat ends when the director completes it (complete), or, for a message nobody tracks, when the next message
  // begins or the run finishes (finishAll). `busy` adds a spinner until settle().
  msg(who, html = '', {busy = false, intro = false, step, done = false} = {}) {
    const li = document.createElement('li');
    li.className = 'msg assistant' + (intro ? ' intro-msg' : '');
    li.innerHTML = `${intro ? '' : '<span class="step" tabindex="0" role="img"></span>'}<div class="who"><span class="chip ${who === 'lab' ? 'lab' : who === 'err' ? 'err' : who}">${WHO[who] || who}</span>${busy ? '<i class="spin"></i>' : ''}</div><div class="body">${html}</div>`;
    if (!intro) {
      const name = WHO[who] || who;
      li.stepText = step || [`${name} is working on this step`, `${name} finished this step`];
      this.finishAll();
      this.mark(li, done || who === 'err' ? 'done' : 'doing');
      if (!done && who !== 'err') this.open.add(li);
    }
    this.list.append(li); this.scroll();
    return li;
  }
  mark(li, state) {
    const el = li?.querySelector('.step'); if (!el) return;
    const text = li.stepText[state === 'done' ? 1 : 0];
    el.className = 'step ' + state; el.dataset.tip = text; el.dataset.tipSide = 'right'; el.setAttribute('aria-label', text);
    if (state === 'done') this.open.delete(li);
  }
  complete(li) { if (li) this.mark(li, 'done'); }
  finishAll() { for (const li of [...this.open]) this.mark(li, 'done'); }
  settle(li) { li?.querySelector('.spin')?.remove(); }
  body(li) { return li.querySelector('.body'); }
  add(li, html) { li.querySelector('.body').insertAdjacentHTML('beforeend', html); this.scroll(); }

  toolCall(name, args) {
    const [who, text] = (TOOL[name] || (() => ['lab', esc(name)]))(args || {});
    const li = this.msg(who, text, {busy: true, step: STEP[name]});
    if (name === 'track_objects') this.add(li, '<div class="bar"><i></i></div>');
    return li;
  }
  setBar(li, frac) { const i = li?.querySelector('.bar i'); if (i) i.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%'; }

  trackTable(li, r) {
    li.querySelector('.bar')?.remove();
    this.add(li, r.found
      ? `<table><tr><th>object</th><th>frames</th><th>moves</th><th>conf.</th></tr>${r.objects.map(o => `<tr><td>${esc(o.object)}</td><td>${o.frames_seen}</td><td>${o.moving ? 'yes' : 'no'}</td><td>${o.mean_confidence ?? '–'}</td></tr>`).join('')}</table>`
      : `<div class="muted">${esc(r.note || 'nothing found')}</div>`);
  }
  scaleLine(li, r) { this.add(li, `<div class="mono line">1 m = ${num(r.pixels_per_metre)} px <span class="muted">(±${Math.round(100 * r.relative_uncertainty)}%)</span></div>`); }
  checkLine(li, r) { this.add(li, `<div class="mono muted line">worst miss ${num(r.worst_error_px)} px (object radius ${num(r.object_radius_px)} px)</div>`); }
  warn(li, text) { this.add(li, `<div class="warn line">${esc(text)}</div>`); }
  image(li, src) { this.add(li, `<img src="${src}" alt="The fitted law drawn over six frames of the footage">`); }

  // The ranked laws as a table whose rows appear one by one (`gap` ms apart; 0 = all at once).
  async fitTable(li, r, ctl, gap = 330) {
    const head = '<tr><th>law</th><th>ΔBIC</th><th>rms</th><th>key value</th></tr>';
    this.add(li, `<table class="laws">${head}</table>`);
    const table = li.querySelector('table.laws:last-of-type');
    for (const [i, m] of r.ranked.entries()) {
      table.insertAdjacentHTML('beforeend', `<tr class="${i ? '' : 'best'} row-in"><td>${esc(MODEL_NAME[m.model] || m.model)}</td><td>${i ? '+' + num(m.dBIC) : 'best'}</td><td>${m.rms_px != null ? num(m.rms_px) + ' px' : ''}</td><td>${esc(keyValue(m).text)}</td></tr>`);
      this.scroll();
      if (gap && i < r.ranked.length - 1) await ctl.sleep(gap);
    }
  }

  report(rep) {
    const car = vehicleOf(rep);
    const rows = (rep.measurements || []).map(m => {
      // An error bar drawn against ±50%: the whisker's length is the relative uncertainty, so a tight value looks tight.
      const rel = m.sigma && m.value ? Math.min(0.5, Math.abs(m.sigma / m.value)) : 0;
      return `<div class="meas-row"><span class="n">${esc(m.name)}</span>
      <span class="v">${num(m.value, m.sigma)}${m.sigma ? ` <small>± ${num(m.sigma, m.sigma)}</small>` : ''} <small>${esc(unit(m.unit))}</small>${car && m.unit === 'm/s' && Math.abs(m.value - car.speed) < 0.01 * car.speed ? ` <small class="kmh">= ${kmhText(car)}</small>` : ''}</span>
      ${m.sigma ? `<span class="eb" title="±${(100 * Math.abs(m.sigma / m.value)).toFixed(1)}% uncertainty"><i style="left:${50 - rel * 100}%;width:${rel * 200}%"></i><b></b></span>` : ''}
      ${m.compare_to ? `<span class="c">${esc(m.compare_to)}</span>` : ''}</div>`;
    }).join('');
    return this.msg('spark', `<div class="report"><div class="rep-head"><h2>${esc(rep.headline)}</h2><span class="conf ${esc(rep.confidence)}">${esc(rep.confidence)} confidence</span></div>
      <p>${esc(rep.answer)}</p>${rows}
      ${rep.assumptions?.length ? `<ul class="assume">${rep.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}</div>`, {step: STEPS.report});
  }
}
