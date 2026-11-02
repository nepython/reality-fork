// The lab notebook: the agent's run as it happens, one card per step, then the report.
const unit = u => String(u ?? '').replace('^2', '²').replace('^3', '³').replace('deg', '°');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const num = (v, s) => {
  if (v == null || !isFinite(v)) return '–';
  // Round the value to the precision its uncertainty supports (two significant figures of sigma).
  if (s && isFinite(s) && s > 0) { const d = Math.max(0, 1 - Math.floor(Math.log10(s))); return v.toFixed(Math.min(d, 6)); }
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3);
};
const TOOL = {
  track_objects: a => ['sam', `SAM 3.1 · tracking <code>${esc(a.prompt)}</code> in every frame`],
  set_scale: a => ['lab', `Setting the scale from ${esc(a.object || a.prompt)}: ${esc(a.real_size_m)} m ${esc(a.dimension)} (±${esc(a.size_uncertainty_m)} m)`],
  fit_motion: a => ['lab', `Fitting laws of motion to <code>${esc(a.object)}</code>${a.models?.length ? ' (' + a.models.map(esc).join(', ') + ')' : ''}${Object.keys(a.fixed || {}).length ? ' with ' + esc(JSON.stringify(a.fixed)) + ' fixed' : ''}`],
  check_overlay: a => ['lab', `Checking fit ${esc(a.fit_id)} against the footage`],
  final_report: () => ['spark', 'Writing the report'],
};
const MODEL_NAME = {'constant-velocity': 'constant velocity', projectile: 'free flight', 'projectile-drag': 'flight with air drag',
  bounce: 'bouncing', pendulum: 'pendulum', incline: 'down a slope', oscillator: 'oscillation'};

export class Notebook {
  constructor({list, report, state}) { Object.assign(this, {list, reportEl: report, state}); this.pending = null; }

  clear(note = '') { this.list.innerHTML = ''; this.reportEl.innerHTML = ''; this.state.textContent = note; this.pending = null; this.samCard = null; }

  card(who, label, html = '', busy = false) {
    const li = document.createElement('li');
    li.className = 'step';
    li.innerHTML = `<div class="who ${who}">${busy ? '<i class="spin"></i>' : ''}${esc(label)}</div><div class="body">${html}</div>`;
    this.list.append(li);
    this.list.scrollTop = this.list.scrollHeight;
    return li;
  }
  settle(li) { li?.querySelector('.spin')?.remove(); }

  event(ev) {
    switch (ev.type) {
      case 'say': this.card('spark', 'Muse Spark', esc(ev.text)); break;
      case 'call': {
        const [who, text] = (TOOL[ev.name] || (() => ['lab', ev.name]))(ev.args || {});
        this.pending = this.card(who, who === 'sam' ? 'SAM 3.1' : who === 'spark' ? 'Muse Spark' : 'Lab', text, true);
        if (ev.name === 'track_objects') { this.samCard = this.pending; this.pending.insertAdjacentHTML('beforeend', '<div class="bar"><i></i></div>'); }
        break;
      }
      case 'sam': if (this.samCard) this.samCard.querySelector('.bar i').style.width = Math.min(100, 100 * ev.frames / Math.max(1, ev.of)) + '%'; break;
      case 'overlay': if (this.pending) this.pending.querySelector('.body').insertAdjacentHTML('beforeend', `<img src="${ev.image}" alt="Fitted law drawn over six frames">`); break;
      case 'result': this.result(ev); break;
      case 'report': this.report(ev.report); break;
      case 'error': this.card('err', 'Problem', esc(ev.message)); this.state.textContent = ''; break;
      case 'done': this.state.textContent = ev.replay ? 'replayed from a saved run' : 'done'; break;
    }
  }

  result({name, result: r}) {
    const li = this.pending; this.settle(li);
    if (!li) return;
    const body = li.querySelector('.body');
    if (r?.error) { body.insertAdjacentHTML('beforeend', `<div style="color:var(--warn)">${esc(r.error)}</div>`); return; }
    if (name === 'track_objects') {
      li.querySelector('.bar')?.remove();
      body.insertAdjacentHTML('beforeend', r.found
        ? `<table><tr><th>object</th><th>frames</th><th>moves</th><th>conf.</th></tr>${r.objects.map(o => `<tr><td>${esc(o.object)}</td><td>${o.frames_seen}</td><td>${o.moving ? 'yes' : 'no'}</td><td>${o.mean_confidence ?? '–'}</td></tr>`).join('')}</table>`
        : `<div class="muted">${esc(r.note || 'nothing found')}</div>`);
    } else if (name === 'set_scale') {
      body.insertAdjacentHTML('beforeend', `<div class="mono" style="margin-top:4px">1 m = ${num(r.pixels_per_metre)} px <span class="muted">(±${Math.round(100 * r.relative_uncertainty)}%)</span></div>`);
    } else if (name === 'fit_motion') {
      const rows = r.ranked.map((m, i) => {
        const main = m.derived.find(d => d.name === 'g') || m.derived[0];
        // A parameter the data cannot pin down (sigma far above its value) is shown as such, not as a number.
        const loose = main && (!isFinite(main.sigma) || Math.abs(main.sigma) > 3 * Math.abs(main.value));
        const val = !main ? '' : loose ? `${esc(main.name)} unconstrained` : `${esc(main.name)} ${num(main.value, main.sigma)}${main.sigma ? '±' + num(main.sigma, main.sigma) : ''} ${esc(unit(main.unit))}`;
        return `<tr class="${i ? '' : 'best'}"><td>${esc(MODEL_NAME[m.model] || m.model)}</td><td>${i ? '+' + num(m.dBIC) : 'best'}</td><td>${m.rms_px != null ? num(m.rms_px) + ' px' : ''}</td><td>${val}</td></tr>`;
      }).join('');
      body.insertAdjacentHTML('beforeend', `<table><tr><th>law</th><th>ΔBIC</th><th>rms</th><th>key value</th></tr>${rows}</table>`);
    } else if (name === 'check_overlay') {
      body.insertAdjacentHTML('beforeend', `<div class="mono muted" style="margin-top:4px">worst miss ${num(r.worst_error_px)} px (object radius ${num(r.object_radius_px)} px)</div>`);
    }
    this.pending = null;
  }

  report(rep) {
    this.settle(this.pending); this.pending = null;
    const rows = (rep.measurements || []).map(m => `<div class="meas-row"><span class="n">${esc(m.name)}</span>
      <span class="v">${num(m.value, m.sigma)}${m.sigma ? ` <small>± ${num(m.sigma, m.sigma)}</small>` : ''} <small>${esc(unit(m.unit))}</small></span>
      ${m.compare_to ? `<span class="c">${esc(m.compare_to)}</span>` : ''}</div>`).join('');
    this.reportEl.innerHTML = `<div class="report"><div style="display:flex;justify-content:space-between;gap:10px;align-items:start">
      <h2>${esc(rep.headline)}</h2><span class="conf ${esc(rep.confidence)}">${esc(rep.confidence)} confidence</span></div>
      <p>${esc(rep.answer)}</p>${rows}
      ${rep.assumptions?.length ? `<ul class="assume">${rep.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}</div>`;
    this.reportEl.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  }
}
