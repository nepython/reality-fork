// Non-linear least squares for the physics core: dense linear algebra,
// Levenberg-Marquardt with a numeric Jacobian, optional robust (IRLS) loss,
// parameter covariance, and information criteria.  No dependencies.

// ---------------------------------------------------------------- linear algebra
// Matrices are arrays of row arrays.  They are tiny (k <= ~12), so clarity wins.

/** Solve A x = b by Gauss-Jordan elimination with partial pivoting. Returns null if singular. */
export function solve(A, b) {
  const k = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (!(Math.abs(M[piv][c]) > 1e-300)) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[k] / row[i]);
}

/** Matrix inverse (Gauss-Jordan, partial pivoting). Returns null if singular. */
export function invert(A) {
  const k = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (!(Math.abs(M[piv][c]) > 1e-300)) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * k; j++) M[c][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * k; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row.slice(k));
}

// ---------------------------------------------------------------- robust helpers
export const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
};
/** Robust standard deviation from the median absolute deviation. */
export const madSigma = (a) => {
  const m = median(a);
  return 1.4826 * median(a.map((v) => Math.abs(v - m)));
};

// Huber (c=1.345) and Tukey biweight (c=4.685) weight functions; u = |r| / sigma.
const huberW = (u) => (u <= 1.345 ? 1 : 1.345 / u);
const tukeyW = (u) => (u >= 4.685 ? 0 : (1 - (u / 4.685) ** 2) ** 2);

/** Robust sigma floor (metres): keeps weights sane on noise-free synthetic data. */
const SIGMA_FLOOR = 2e-4;

// ---------------------------------------------------------------- Levenberg-Marquardt
function numericJacobian(residuals, p, r0, lower, upper, free) {
  const n = r0.length;
  const J = Array.from({ length: n }, () => new Array(p.length).fill(0));
  for (const j of free) {
    const h = 1e-5 * Math.max(Math.abs(p[j]), 1e-2);
    const hi = Math.min(p[j] + h, upper[j]);
    const lo = Math.max(p[j] - h, lower[j]);
    if (hi === lo) continue;
    const ph = p.slice(); ph[j] = hi;
    const pl = p.slice(); pl[j] = lo;
    const rh = residuals(ph), rl = residuals(pl);
    for (let i = 0; i < n; i++) {
      const d = (rh[i] - rl[i]) / (hi - lo);
      J[i][j] = Number.isFinite(d) ? d : 0;
    }
  }
  return J;
}

const clampVec = (p, lo, hi) => p.map((v, i) => Math.min(hi[i], Math.max(lo[i], v)));
const safe = (r) => r.map((v) => (Number.isFinite(v) ? v : 1e6));

/** One weighted LM minimisation of sum(w_i r_i^2). */
function lmCore(residuals, p0, lower, upper, w, free, maxIter, tol) {
  let p = clampVec(p0, lower, upper);
  const wr = (q) => { const r = safe(residuals(q)); return r.map((v, i) => Math.sqrt(w[i]) * v); };
  let r = wr(p);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-3, iterations = 0, converged = false;
  for (; iterations < maxIter; iterations++) {
    const J = numericJacobian(wr, p, r, lower, upper, free);
    const k = p.length;
    const JtJ = Array.from({ length: k }, () => new Array(k).fill(0));
    const g = new Array(k).fill(0);
    for (let i = 0; i < r.length; i++) {
      for (const a of free) {
        const Jia = J[i][a];
        if (Jia === 0) continue;
        g[a] += Jia * r[i];
        for (const b of free) JtJ[a][b] += Jia * J[i][b];
      }
    }
    let improved = false;
    for (let tries = 0; tries < 25; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? (free.includes(i) ? v + lambda * Math.max(v, 1e-12) : 1) : v)));
      const rhs = g.map((v, i) => (free.includes(i) ? -v : 0));
      const d = solve(A, rhs);
      if (!d) { lambda *= 10; continue; }
      const pn = clampVec(p.map((v, i) => v + d[i]), lower, upper);
      const rn = wr(pn);
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) {
        const rel = (cost - cn) / (cost + 1e-30);
        const stepRel = Math.max(...free.map((i) => Math.abs(pn[i] - p[i]) / (Math.abs(p[i]) + 1e-6)), 0);
        p = pn; r = rn; cost = cn; lambda = Math.max(lambda / 3, 1e-12); improved = true;
        if (rel < tol || stepRel < 1e-9) converged = true;
        break;
      }
      lambda *= 4;
    }
    if (!improved) { converged = true; break; } // cannot improve: at a (local) minimum
    if (converged) break;
  }
  return { p, cost, iterations, converged };
}

/**
 * Levenberg-Marquardt least squares.
 *
 * @param {object} o
 * @param {(p:number[])=>number[]} o.residuals  residual vector (fixed length n)
 * @param {number[]} o.p0                        starting point
 * @param {number[]} [o.lower]  @param {number[]} [o.upper]   box bounds
 * @param {number[]} [o.weights]                 prior per-residual weights (e.g. SAM confidence)
 * @param {number[]} [o.freeIdx]                 indices that vary (others stay at p0): used for fixed params
 * @param {boolean|'huber'|'tukey'} [o.robust]   IRLS with Huber warm-up then Tukey biweight
 * @returns {{p, cov, sigma, rms, ssr, n, nEff, k, iterations, converged, weights}}
 *   cov = s^2 (J'WJ)^-1 with s^2 = SSR / (n - k); fixed params get zero variance.
 *   rms is over inliers (weights-weighted), so a rejected outlier does not inflate it.
 */
export function levenbergMarquardt({ residuals, p0, lower, upper, weights, freeIdx, maxIter = 80, robust = false, tol = 1e-11 }) {
  const k = p0.length;
  const lo = lower ?? new Array(k).fill(-Infinity);
  const hi = upper ?? new Array(k).fill(Infinity);
  const free = freeIdx ?? Array.from({ length: k }, (_, i) => i);
  const r0 = safe(residuals(clampVec(p0, lo, hi)));
  const n = r0.length;
  const prior = weights ?? new Array(n).fill(1);
  let w = prior.slice();
  let fit = lmCore(residuals, p0, lo, hi, w, free, maxIter, tol);
  let outer = 0;
  if (robust) {
    const kind = robust === 'huber' ? 'huber' : 'tukey';
    // IRLS can wander when the weights change under a poor start, so keep the iterate with the
    // smallest median absolute residual (a breakdown-resistant score) and return that one.
    const score = (p) => median(safe(residuals(p)).map(Math.abs));
    let best = { fit, w: w.slice(), s: score(fit.p) };
    for (; outer < 8; outer++) {
      const r = safe(residuals(fit.p));
      const sigma = Math.max(madSigma(r), SIGMA_FLOOR);
      const wf = kind === 'huber' || outer < 2 ? huberW : tukeyW;
      const wn = r.map((v, i) => prior[i] * wf(Math.abs(v) / sigma));
      const change = Math.max(...wn.map((v, i) => Math.abs(v - w[i])));
      w = wn;
      fit = lmCore(residuals, fit.p, lo, hi, w, free, Math.min(maxIter, 30), tol); // re-weighting only nudges the solution
      const s = score(fit.p);
      if (s <= best.s * 1.0000001) best = { fit, w: w.slice(), s };
      if (change < 1e-3 && outer >= 2) break;
    }
    fit = best.fit; w = best.w;
  }
  const r = safe(residuals(fit.p));
  const ssr = r.reduce((s, v, i) => s + w[i] * v * v, 0);
  const wsum = w.reduce((s, v) => s + v, 0);
  const nEff = w.reduce((s, v) => s + (v > 1e-3 ? 1 : 0), 0);
  const kFree = free.length;
  // covariance from the weighted Jacobian at the solution
  const wr = (q) => safe(residuals(q)).map((v, i) => Math.sqrt(w[i]) * v);
  const J = numericJacobian(wr, fit.p, wr(fit.p), lo, hi, free);
  const JtJ = free.map((a) => free.map((b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
  let inv = invert(JtJ);
  if (!inv) { // rank-deficient: add a tiny ridge so the well-determined directions still report
    const ridge = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + 1e-9) + 1e-18 : v)));
    inv = invert(ridge);
  }
  const s2 = ssr / Math.max(nEff - kFree, 1);
  const cov = Array.from({ length: k }, () => new Array(k).fill(0));
  if (inv) free.forEach((a, ia) => free.forEach((b, ib) => { cov[a][b] = s2 * inv[ia][ib]; }));
  else free.forEach((a) => { cov[a][a] = NaN; });
  const sigma = cov.map((row, i) => Math.sqrt(Math.max(row[i], 0)));
  return {
    p: fit.p, cov, sigma, ssr,
    rms: Math.sqrt(ssr / Math.max(wsum, 1e-12)),
    n, nEff, k: kFree, iterations: fit.iterations, converged: fit.converged, weights: w,
  };
}

// ---------------------------------------------------------------- information criteria
// Residual variance is floored at (0.5 mm)^2 so a numerically perfect fit does not make
// ln(SSR) diverge and so tiny model-error differences below the noise floor cannot
// decide a ranking.
const VAR_FLOOR = (5e-4) ** 2;
const lnVar = (ssr, n) => Math.log(Math.max(ssr / n, VAR_FLOOR));
/** Gaussian-likelihood AIC up to a constant: n ln(SSR/n) + 2k. */
export const aic = (ssr, n, k) => n * lnVar(ssr, n) + 2 * k;
/** Gaussian-likelihood BIC up to a constant: n ln(SSR/n) + k ln n. */
export const bic = (ssr, n, k) => n * lnVar(ssr, n) + k * Math.log(n);

// ---------------------------------------------------------------- small numeric helpers
/** Polynomial least squares (optionally Huber-robust). Returns coefficients c0 + c1 t + c2 t^2 ... */
export function polyfit(t, v, deg, w, robust = false) {
  const n = t.length;
  let wt = w ? w.slice() : new Array(n).fill(1);
  let c = new Array(deg + 1).fill(0);
  for (let it = 0; it < (robust ? 6 : 1); it++) {
    const A = Array.from({ length: deg + 1 }, () => new Array(deg + 1).fill(0));
    const b = new Array(deg + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const pw = [1];
      for (let d = 1; d <= 2 * deg; d++) pw.push(pw[d - 1] * t[i]);
      for (let a = 0; a <= deg; a++) {
        b[a] += wt[i] * pw[a] * v[i];
        for (let q = 0; q <= deg; q++) A[a][q] += wt[i] * pw[a + q];
      }
    }
    c = solve(A, b) ?? c;
    if (robust) {
      const r = t.map((ti, i) => v[i] - c.reduce((s, ck, d) => s + ck * ti ** d, 0));
      const s = Math.max(madSigma(r), SIGMA_FLOOR);
      wt = r.map((ri, i) => (w ? w[i] : 1) * huberW(Math.abs(ri) / s));
    }
  }
  return c;
}

/**
 * Propagate parameter covariance through f(p) with a numeric gradient: sigma^2 = g' C g.
 * Returns {value, sigma}; sigma is null when it cannot be computed.
 */
export function propagate(f, p, cov) {
  const value = f(p);
  const g = p.map((pj, j) => {
    const h = 1e-6 * Math.max(Math.abs(pj), 1e-2);
    const a = p.slice(); a[j] += h;
    const b = p.slice(); b[j] -= h;
    return (f(a) - f(b)) / (2 * h);
  });
  let s2 = 0;
  for (let i = 0; i < g.length; i++) for (let j = 0; j < g.length; j++) s2 += g[i] * cov[i][j] * g[j];
  const sigma = Number.isFinite(s2) && s2 >= 0 ? Math.sqrt(s2) : null;
  return { value: Number.isFinite(value) ? value : null, sigma };
}
