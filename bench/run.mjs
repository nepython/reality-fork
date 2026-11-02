// Benchmark: run the full lab (Muse Spark + SAM 3.1 + fitting) on clips whose physics is known, and score it.
//   node bench/run.mjs                 every synthetic scene and every sample clip with an expected value (saved runs reused)
//   node bench/run.mjs --fresh         re-run even when a saved run exists (paid calls)
//   node bench/run.mjs --only drop,pendulum
// Writes bench/results.json and bench/RESULTS.md. Scores use the fitted values the tools returned, not the model's prose.
import fs from 'node:fs';
import path from 'node:path';
import {samples, latestRun, runLab, ROOT} from '../lib/store.mjs';
import {spent} from '../lib/meta.mjs';

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const only = args.find(a => a.startsWith('--only'))?.split('=')[1]?.split(',') || (args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null);

// What we can score per clip, as {derived quantity name: true value}. Synthetic scenes carry exact truth; real clips
// carry their documented value (e.g. lunar g for Apollo footage).
function truthOf(c) {
  const t = c.truth?.params || c.expected || {};
  const out = {};
  if (typeof t.g === 'number' && t.g !== 0 && !('alpha_deg' in t)) out.g = t.g; // negative for powered ascent (a rocket)
  if (typeof t.e === 'number') out.e = t.e;
  if (typeof t.L === 'number') out.L = t.L;
  if (typeof t.drag_b === 'number') out.b = t.drag_b;
  if (typeof t.a_along_slope === 'number') out.a = t.a_along_slope;
  if (t.g === 0 && typeof t.vx === 'number') out.speed = Math.hypot(t.vx, t.vy || 0); // floating: nothing to measure but speed
  return out;
}

const QUESTIONS = {
  'free-fall': 'What is the gravitational acceleration here?', projectile: 'What is gravity here, and how fast was it thrown?',
  bounce: 'How bouncy is this ball, and what is g?', pendulum: 'How long is the pendulum and what g does its swing imply?',
  incline: 'How fast does it accelerate down the slope?', float: 'Is anything accelerating this object?', 'test scene': '',
};

const clips = samples().filter(c => (only ? only.some(o => c.id.endsWith(':' + o)) : true) && Object.keys(truthOf(c)).length);
const before = spent(), rows = [];
for (const c of clips) {
  let run = !fresh && latestRun(c.id);
  const t0 = Date.now();
  if (!run) {
    process.stdout.write(`▶ ${c.id} … `);
    try { run = await runLab(c, c.question || QUESTIONS[c.motion] || ''); }
    catch (e) { console.log('failed:', e.message); rows.push({clip: c.id, error: e.message}); continue; }
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const derived = Object.fromEntries((run.report.fit?.derived || []).map(d => [d.name, d]));
  const truth = truthOf(c), scores = {};
  for (const [k, v] of Object.entries(truth)) {
    const d = derived[k] || (k === 'b' ? derived.drag_b : null);
    if (!d) { scores[k] = {truth: v, measured: null}; continue; }
    const sigma = d.sigma_total ?? d.sigma;
    // Agreement: within 2σ, or within 1% (a noise-free test scene can give a statistical σ far below any real error).
    scores[k] = {truth: v, measured: d.value, sigma, error_pct: 100 * (d.value - v) / v, within_2sigma: Math.abs(d.value - v) <= Math.max(2 * (sigma || 0), 0.01 * Math.abs(v))};
  }
  rows.push({clip: c.id, title: c.title, model: run.report.fit?.model, headline: run.report.headline, confidence: run.report.confidence,
    seconds: run.seconds, scores, tools: run.events.filter(e => e.type === 'call').map(e => e.name)});
}

const ok = rows.filter(r => r.scores?.g?.measured != null);
const medianAbs = a => { const s = a.map(Math.abs).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const summary = {clips: rows.length, g_scored: ok.length, g_median_abs_error_pct: medianAbs(ok.map(r => r.scores.g.error_pct)),
  g_within_2sigma: ok.filter(r => r.scores.g.within_2sigma).length, spent_this_run_usd: +(spent() - before).toFixed(4), total_spent_usd: +spent().toFixed(4)};
fs.writeFileSync(path.join(ROOT, 'bench', 'results.json'), JSON.stringify({at: new Date().toISOString(), summary, rows}, null, 1));

const fmt = (v, n = 3) => v == null ? '–' : Number(v).toPrecision(n);
let md = `# Benchmark\n\nEach clip was analysed end to end by the agent (Muse Spark + SAM 3.1 + fitting); values are the fitted ones.\n\n`;
md += `| clip | law found | quantity | truth | measured | error | agrees (2σ or 1%) |\n|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  if (r.error) { md += `| ${r.clip} | failed: ${r.error.slice(0, 60)} | | | | | |\n`; continue; }
  for (const [k, s] of Object.entries(r.scores)) md += `| ${r.title} | ${r.model} | ${k} | ${fmt(s.truth)} | ${s.measured == null ? '–' : `${fmt(s.measured)} ± ${fmt(s.sigma, 2)}`} | ${s.error_pct == null ? '–' : s.error_pct.toFixed(1) + '%'} | ${s.within_2sigma == null ? '–' : s.within_2sigma ? 'yes' : 'no'} |\n`;
}
md += `\nMedian |error| in g: ${fmt(summary.g_median_abs_error_pct, 2)}% over ${summary.g_scored} clips; ${summary.g_within_2sigma} of ${summary.g_scored} within 2σ.\n`;
fs.writeFileSync(path.join(ROOT, 'bench', 'RESULTS.md'), md);
console.log(md);
console.log(summary);
