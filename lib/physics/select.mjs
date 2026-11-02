// Fit every candidate model to a tracked trajectory, rank by BIC, and report a verdict.
// The output is plain JSON (numbers rounded sensibly) so an LLM agent can read it directly.
//
// Track contract: {t: seconds[], x: metres[] (right), y: metres[] (UP), w?: weights 0..1[]}.
// NaN/Infinity samples are dropped (a gap is simply a missing sample).

import { levenbergMarquardt, median, aic, bic } from './fit.mjs';
import { MODEL_LIST, MODELS, despike } from './models.mjs';

const sq = (v) => v * v;
const sigfig = (v, n = 4) => (Number.isFinite(v) ? Number(v.toPrecision(n)) : null);
const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** Drop bad samples, sort by time, merge duplicate times, shift so t[0] = 0. */
export function prepareTrack(track) {
  const { t, x, y, w } = track;
  const rows = [];
  for (let i = 0; i < t.length; i++) {
    if (Number.isFinite(t[i]) && Number.isFinite(x[i]) && Number.isFinite(y[i])) {
      const wi = w && Number.isFinite(w[i]) ? Math.min(Math.max(w[i], 0), 1) : 1;
      if (wi > 0) rows.push([t[i], x[i], y[i], wi, i]);
    }
  }
  rows.sort((a, b) => a[0] - b[0]);
  const keep = rows.filter((r, i) => i === 0 || r[0] > rows[i - 1][0]);
  const t0 = keep.length ? keep[0][0] : 0;
  return {
    t: keep.map((r) => r[0] - t0), x: keep.map((r) => r[1]), y: keep.map((r) => r[2]),
    w: keep.map((r) => r[3]), index: keep.map((r) => r[4]), t0,
  };
}

/**
 * Position noise (m) from third differences, which cancel any quadratic motion exactly.
 * Only windows of four consecutive, evenly spaced frames are used, so gaps do not bias it.
 */
export function noiseSigma(raw) {
  const track = despike(raw);          // bad masks would otherwise inflate the estimate on short clips
  const { t, x, y } = track;
  if (t.length < 8) return NaN;
  const dt = median(t.slice(1).map((v, i) => v - t[i]));
  const dx = [], dy = [];
  for (let i = 0; i + 3 < t.length; i++) {
    const even = [1, 2, 3].every((k) => Math.abs(t[i + k] - t[i + k - 1] - dt) < 0.02 * dt);
    if (!even) continue;
    dx.push(x[i + 3] - 3 * x[i + 2] + 3 * x[i + 1] - x[i]);
    dy.push(y[i + 3] - 3 * y[i + 2] + 3 * y[i + 1] - y[i]);
  }
  if (dx.length < 5) return NaN;
  // 30th percentile of |d| instead of the median: each bad sample contaminates four windows,
  // so on a short clip two outliers can touch half of them, which would break a median.
  const q30 = (a) => { const s = a.map(Math.abs).sort((u, v) => u - v); return s[Math.floor(0.3 * s.length)] / 0.3853; };
  return Math.max(q30(dx), q30(dy)) / Math.sqrt(20);
}

/**
 * Keep only the part of the clip where the object is actually moving: drop the still stretch
 * before the first movement (a ball held, then released) and after the last (lying on the floor).
 * "Still" is judged by POSITION, not speed: a head/tail sample is still if it stays within four
 * noise sigmas of where the clip starts/ends, so a slowly decaying oscillation is never mistaken
 * for rest.  Positions are 5-sample medians so a single bad mask cannot fake movement.
 * The window keeps two resting samples before the release (so a fork can start from rest) and ends
 * at the sample that arrives at the final resting place.
 * Returns the (prepared) track and how many samples were removed.
 */
export function trimToMotion(track) {
  const n = track.t.length;
  if (n < 12) return { track, trimmed: 0 };
  const tol = 4 * Math.max(noiseSigma(track) || 0, 1e-3);
  const med5 = (a, i) => median(a.slice(Math.max(0, i - 2), Math.min(n, i + 3)));
  const mx = track.x.map((_, i) => med5(track.x, i)), my = track.y.map((_, i) => med5(track.y, i));
  const refHead = [median(mx.slice(0, 3)), median(my.slice(0, 3))];
  const refTail = [median(mx.slice(-3)), median(my.slice(-3))];
  const away = (i, ref) => Math.hypot(mx[i] - ref[0], my[i] - ref[1]) > tol;
  let h = 0; while (h < n - 1 && !away(h + 1, refHead)) h++;          // last sample of the still head
  let c = n - 1; while (c > 0 && !away(c - 1, refTail)) c--;          // first sample of the still tail
  if (h >= c) return { track, trimmed: 0 };                           // never moves (or never rests): keep all
  const first = Math.max(h - 2, 0), last = c;
  if (last - first + 1 < Math.min(n, 8)) return { track, trimmed: 0 };
  const cut = (a) => a.slice(first, last + 1);
  const t0 = track.t[first];
  return {
    track: { t: cut(track.t).map((v) => v - t0), x: cut(track.x), y: cut(track.y), w: cut(track.w), index: cut(track.index), t0: track.t0 + t0 },
    trimmed: n - (last - first + 1),
  };
}

function expandBounds(model) {
  return {
    lower: model.params.map((q) => q.lo ?? -Infinity),
    upper: model.params.map((q) => q.hi ?? Infinity),
  };
}

/** Residual vector [x residuals..., y residuals...] for a parameter vector. */
function makeResiduals(model, track) {
  return (p) => {
    const pr = model.predict(track.t, p);
    return [...track.x.map((xi, i) => xi - pr.x[i]), ...track.y.map((yi, i) => yi - pr.y[i])];
  };
}

/**
 * Fit one model.  `fixed` pins named parameters (e.g. {g: 9.81}) to hypothesised values.
 * Returns {model, applicable, ...}; when the model is clearly not applicable (guess returns
 * null) it comes back with applicable:false and no parameters.
 */
export function fitPrepared(track, model, { fixed = {}, robust = true } = {}) {
  const names = model.params.map((q) => q.name);
  const unknown = Object.keys(fixed).filter((k) => !names.includes(k));
  if (unknown.length) throw new Error(`model ${model.id} has no parameter(s) ${unknown.join(', ')}; it has ${names.join(', ')}`);
  let p0 = null;
  try { p0 = track.t.length >= names.length + 2 ? model.guess(track) : null; } catch { p0 = null; }
  if (!p0 || p0.some((v) => !Number.isFinite(v))) return { model: model.id, label: model.label, applicable: false };
  names.forEach((nm, i) => { if (nm in fixed) p0[i] = fixed[nm]; });
  const free = names.map((_, i) => i).filter((i) => !(names[i] in fixed));
  const { lower, upper } = expandBounds(model);
  const res = makeResiduals(model, track);
  const w2 = [...track.w, ...track.w]; // each sample constrains x and y
  const fit = levenbergMarquardt({ residuals: res, p0, lower, upper, weights: w2, freeIdx: free, robust, maxIter: 60 });
  const N = track.t.length;
  const r = res(fit.p);
  // Model comparison must not let a wrong model "win" by robustly throwing away the data it
  // cannot explain.  So the score uses ONE model-independent loss: every residual counts,
  // but is capped at (4 sigma)^2 where sigma is the track's own noise level, so a few bad SAM
  // frames cost every model the same bounded amount while systematic misfit costs in full.
  const sig = Math.max(noiseSigma(track) || 0, 5e-4);
  const cap = sq(4 * sig);
  const ssrCap = r.reduce((s, v) => s + Math.min(v * v, cap), 0);
  const n = r.length, k = fit.k;
  const outliers = [];
  for (let i = 0; i < N; i++) if (Math.max(Math.abs(r[i]), Math.abs(r[N + i])) > 4 * sig) outliers.push(track.index[i]);
  return {
    model: model.id, label: model.label, applicable: true,
    p: Object.fromEntries(names.map((nm, i) => [nm, sigfig(fit.p[i], 7)])),
    sigma: Object.fromEntries(names.map((nm, i) => [nm, sigfig(fit.sigma[i], 3)])),
    cov: fit.cov.map((row) => row.map((v) => sigfig(v, 4))),
    fixed: Object.keys(fixed),
    rms: sigfig(Math.sqrt(ssrCap / n), 3), rms_inliers: sigfig(fit.rms, 3), n, k,
    aic: round(aic(ssrCap, n, k), 2), bic: round(bic(ssrCap, n, k), 2),
    derived: model.derived(fit.p, fit.cov).map((d) => ({ ...d, value: sigfig(d.value, 5), sigma: sigfig(d.sigma, 3) })),
    outliers, converged: fit.converged, iterations: fit.iterations,
    _vec: fit.p, _res: r, _N: N,
  };
}

function summariseData(track, trimmed) {
  const N = track.t.length;
  // Floor hint for fork(): the object counts as having landed only if the footage ends at its
  // lowest point after descending.  A ball rising or hovering at the end has no known floor.
  const clean = despike(track);               // a bad mask below the floor must not hide the landing
  const M = clean.t.length, k = Math.min(4, M - 1), yEnd = clean.y[M - 1], yMin = Math.min(...clean.y);
  const landed = M > 4 && clean.y[M - 1 - k] - yEnd > 0.02 && yEnd - yMin < Math.max(3 * (noiseSigma(track) || 0), 0.01);
  return {
    floorY: landed ? sigfig(yEnd, 5) : null,
    samples: N, t0: sigfig(track.t0, 7), duration: sigfig(track.t[N - 1] ?? 0, 5),
    noise_sigma_m: sigfig(noiseSigma(track), 3), trimmed_samples: trimmed,
    yMin: sigfig(yMin, 5), yEnd: sigfig(track.y[N - 1], 5), xEnd: sigfig(track.x[N - 1], 5),
  };
}

/** Strip private fields; optionally attach residuals (metres). */
function publish(fit, track, withResiduals) {
  const { _vec, _res, _N, ...pub } = fit;
  if (withResiduals && pub.applicable) {
    pub.residuals = { x: _res.slice(0, _N).map((v) => round(v, 5)), y: _res.slice(_N).map((v) => round(v, 5)) };
  }
  return pub;
}

/** Evidence labels for a BIC difference (Kass & Raftery). */
const strength = (d) => (d >= 10 ? 'decisive' : d >= 6 ? 'strong' : d >= 2 ? 'positive' : 'weak');

/**
 * Fit every applicable model and rank by BIC.
 *   fitAll(track, {models?: ids[], residuals?: bool, trim?: bool (default true)})
 * Returns {data, fits: [...ranked, inapplicable last], verdict}.
 * Each fit: {model, label, applicable, p, sigma, cov, rms, n, k, bic, aic, dBIC, derived[], outliers[]}.
 */
export function fitAll(track, { models, residuals = false, trim = true, robust = true } = {}) {
  const prep = prepareTrack(track);
  if (prep.t.length < 6) return { data: { samples: prep.t.length }, fits: [], verdict: { best: null, strength: 'none', reason: 'fewer than 6 usable samples' } };
  const { track: used, trimmed } = trim ? trimToMotion(prep) : { track: prep, trimmed: 0 };
  const list = (models ? models.map((id) => MODELS[id] ?? (() => { throw new Error(`unknown model ${id}`); })()) : MODEL_LIST);
  const all = list.map((m) => {
    try { return fitPrepared(used, m, { robust }); } catch (err) { return { model: m.id, label: m.label, applicable: false, error: String(err.message) }; }
  });
  const ok = all.filter((f) => f.applicable && Number.isFinite(f.bic)).sort((a, b) => a.bic - b.bic);
  const bad = all.filter((f) => !ok.includes(f));
  const best = ok[0];
  ok.forEach((f) => { f.dBIC = round(f.bic - best.bic, 2); });
  const verdict = best
    ? {
        best: best.model,
        runner_up: ok[1]?.model ?? null,
        dBIC: ok[1] ? ok[1].dBIC : null,
        strength: ok[1] ? strength(ok[1].dBIC) : 'only-candidate',
        rms_mm: round(best.rms * 1000, 2),
        ...(ok[1] && ok[1].dBIC < 2 ? { note: 'Top models are statistically indistinguishable; prefer the simpler or the more physical one.' } : {}),
      }
    : { best: null, strength: 'none', reason: 'no model applicable' };
  return { data: summariseData(used, trimmed), fits: [...ok, ...bad].map((f) => publish(f, used, residuals)), verdict };
}

/**
 * Fit a single model, optionally with some parameters pinned: fitModel(track, 'projectile', {fixed: {g: 9.81}}).
 * Use it to test a hypothesis ("is this Earth gravity?") by comparing rms/bic with the free fit.
 */
export function fitModel(track, id, { fixed = {}, residuals = false, trim = true, robust = true } = {}) {
  const model = MODELS[id];
  if (!model) throw new Error(`unknown model ${id}; available: ${MODEL_LIST.map((m) => m.id).join(', ')}`);
  const prep = prepareTrack(track);
  const { track: used, trimmed } = trim ? trimToMotion(prep) : { track: prep, trimmed: 0 };
  const fit = fitPrepared(used, model, { fixed, robust });
  return { data: summariseData(used, trimmed), fit: publish(fit, used, residuals) };
}

/** Model-specific access for other modules (fork, tests). */
export { MODELS, MODEL_LIST };
