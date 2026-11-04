// Braking physics, the vehicle fork in pixels, and the two vehicle tools, on a hand-built run (test/fixtures): no video, no API.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {brakingScenario, motionAlong, distanceAt, speedAt, percentile, survey85, brakingSentence} from '../lib/physics/braking.mjs';
import {forkPixels} from '../lib/forkview.mjs';
import {vehicleMotion} from '../lib/vehiclefork.mjs';
import {braking_fork, speed_survey} from '../mcp/tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test/fixtures/vehicle-runs.json');
const runs = JSON.parse(fs.readFileSync(FIX, 'utf8'));
const car = runs.find(r => r.clip === 'fixture:car47');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);
process.env.RF_EXTRA_RUNS = FIX;   // how the tools are handed a run that is not in cache/runs

test('braking: textbook stopping distances', () => {
  near(brakingScenario({v: 50 / 3.6, hazard_m: 100}).stopping_m, 34.6, 0.1);
  near(brakingScenario({v: 30 / 3.6, hazard_m: 100}).stopping_m, 17.5, 0.1);
  const s = brakingScenario({v: 30 / 3.6, hazard_m: 20});
  assert.equal(s.stops, true); near(s.short_m, 2.54, 0.01); near(s.reaction_m, 12.5, 0.01); near(s.braking_m, 4.96, 0.01);
  near(s.t_brake, 1.19, 0.01);
});

test('braking: impact speed, and full speed inside the reaction distance', () => {
  const v = 40 / 3.6, s = brakingScenario({v, hazard_m: 20});
  assert.equal(s.stops, false);
  near(s.impact_ms, Math.sqrt(v * v - 2 * 7 * (20 - v * 1.5)), 1e-9);
  near(s.impact_kmh, 31.5, 0.1);
  near(s.t_hazard, 1.5 + (v - s.impact_ms) / 7, 1e-9);
  const fast = brakingScenario({v: 50 / 3.6, hazard_m: 20});     // reaction alone is 20.8 m
  near(fast.impact_ms, 50 / 3.6, 1e-9); near(fast.t_hazard, 20 / (50 / 3.6), 1e-9);
});

test('braking: error bars propagate from sigma_v and the assumptions are parameters', () => {
  const s = brakingScenario({v: 13, sigma_v: 1, hazard_m: 20});
  const lo = brakingScenario({v: 12, hazard_m: 20}), hi = brakingScenario({v: 14, hazard_m: 20});
  assert.deepEqual(s.range.impact_kmh, [lo.impact_kmh, hi.impact_kmh]);
  assert.deepEqual(s.range.stopping_m, [lo.stopping_m, hi.stopping_m]);
  assert.ok(s.range.margin_m[0] < s.range.margin_m[1]);
  // 10.5 m/s needs 16.3 + 7.9 = 23.7 m; 13.5 m/s needs 33.5 m; a 28 m hazard splits the band.
  assert.equal(brakingScenario({v: 12, sigma_v: 1.5, hazard_m: 28}).range.stops_certain, false);
  const calm = brakingScenario({v: 10, hazard_m: 30, react_s: 1, decel: 4});
  near(calm.stopping_m, 10 + 100 / 8, 1e-9);
  assert.match(calm.assumptions, /1 s to react and hard braking at 4 m\/s²/);
  assert.throws(() => brakingScenario({v: 10, hazard_m: 0}));
});

test('braking: motionAlong holds speed, then brakes to rest, and keeps decelerating through a hazard', () => {
  const o = {v: 10, react_s: 1.5, decel: 5};
  assert.deepEqual(motionAlong(o, [-1, 0, 1]), [-10, 0, 10]);
  near(distanceAt(o, 1.5), 15, 1e-9);
  near(distanceAt(o, 1.5 + 2), 15 + 10, 1e-9);        // v²/2a = 10 m of braking, done at t = 2 s
  near(distanceAt(o, 10), 25, 1e-9);                   // at rest it stays put
  assert.equal(speedAt(o, 1), 10); near(speedAt(o, 2.5), 5, 1e-9); assert.equal(speedAt(o, 9), 0);
});

test('braking: sentences state the assumptions and the measured speed with its error bar', () => {
  const hit = brakingSentence(brakingScenario({v: 47 / 3.6, sigma_v: 3 / 3.6, hazard_m: 20}), {measured: true});
  assert.match(hit, /^If someone steps out 20 m ahead: at the measured 47 ± 3 km\/h it is still doing \d+ ± \d+ km\/h when it reaches them \(assuming 1\.5 s to react and hard braking at 7 m\/s²\)\.$/);
  const stop = brakingSentence(brakingScenario({v: 30 / 3.6, hazard_m: 20}));
  assert.match(stop, /at 30 km\/h it stops 2\.5 m short \(assuming 1\.5 s to react/);
});

test('survey: percentile on a known set, and a Monte Carlo interval around it', () => {
  const ones = Array.from({length: 20}, (_, i) => i + 1);
  near(percentile(ones, 0.85), 17.15, 1e-9);
  near(percentile([10, 20, 30, 40], 0.5), 25, 1e-9);
  const exact = survey85(ones.map(k => ({kmh: k, sigma: 0})));
  near(exact.median, 17.15, 1e-9); near(exact.high - exact.low, 0, 1e-9);
  const noisy = survey85(ones.map(k => ({kmh: k, sigma: 2})));
  assert.ok(noisy.low < noisy.median && noisy.median < noisy.high && noisy.high - noisy.low < 4);
  assert.deepEqual(survey85(ones.map(k => ({kmh: k, sigma: 2}))), noisy);   // seeded: same answer every time
});

test('fork: the fixture is a vehicle, a gravity-fit run is not', () => {
  near(vehicleMotion(car).speed * 3.6, 47, 0.1);
  assert.equal(vehicleMotion({report: {fit: {model: 'projectile', p: {}}}}), null);
});

const FORK = {fps: 30, frames: 90};
test('fork: speed only moves the same car along the same line at the new speed', () => {
  const f = forkPixels(car, {speed_kmh: 30}, FORK);
  assert.equal(f.hazard, undefined);
  const fit = car.report.fit, p = f.path.find(q => q[0] === 30);
  near(p[1], fit.origin_px[0] + (30 / 3.6) * 1 * fit.ppm, 1.5);            // 1 s at 30 km/h
  assert.match(f.summary, /30 km\/h instead of the measured 47 ± 3 km\/h/);
  assert.match(f.summary, /takes \d+\.\d s to leave the frame/);
  assert.ok(f.path.at(-1)[0] > 120);                                          // slower, so it stays in shot past the real car's exit (frame ~108)
});

test('fork: braking at the measured speed hits, and at 30 km/h stops short, with a hazard for the stage', () => {
  const hit = forkPixels(car, {brake: {hazard_px: 960, distance_m: 20}}, FORK);
  assert.equal(hit.hazard.x_px, 960); assert.equal(hit.hazard.outcome.kind, 'hits');
  assert.equal(hit.hazard.event.kind, 'impact');
  assert.match(hit.summary, /at the measured 47 ± 3 km\/h it is still doing/);
  assert.match(hit.hazard.assumptions, /1\.5 s to react and hard braking at 7 m\/s²/);
  near(hit.path.find(q => q[0] === hit.hazard.event.frame)[1], 960, 8);        // at the line at the impact frame
  const slow = forkPixels(car, {speed_kmh: 30, brake: {hazard_px: 960, distance_m: 20}}, FORK);
  assert.equal(slow.hazard.outcome.kind, 'stops'); near(slow.hazard.outcome.short_m, 2.5, 0.05);
  near(960 - slow.path.at(-1)[1], 2.54 * car.report.fit.ppm, 4);                // rests 2.5 m of road before the line
  assert.match(slow.summary, /at 30 km\/h it stops 2\.5 m short/);
  assert.equal(slow.baseline[0][0], slow.path[0][0]);
  assert.ok(slow.speed.fork.at(-1)[1] === 0 && slow.speed.real[0][1] > 46);
  // The bird's-eye strip draws from these numbers alone: reaction + braking = stopping, and the gap they are compared with.
  const d = slow.hazard.distances;
  near(d.reaction_m, 30 / 3.6 * 1.5, 0.06); near(d.braking_m, (30 / 3.6) ** 2 / 14, 0.06); near(d.stopping_m, d.reaction_m + d.braking_m, 0.11); assert.equal(d.gap_m, 20);
});

test('fork: someone steps out before the footage starts, by extrapolating back', () => {
  const f = forkPixels(car, {brake: {hazard_px: 400, distance_m: 20}}, FORK);   // the crossing is 11 m on, so the trigger is behind the start
  assert.ok(f.hazard.step_out_frame < 0 && f.path[0][0] < f.hazard.step_out_frame);   // the fork starts before the footage, half a second before the step-out
  assert.ok(f.path.every(p => Number.isFinite(p[1]) && Number.isFinite(p[2])));
});

test('fork: other forks are untouched, and a non-vehicle run refuses braking', () => {
  const f = forkPixels(car, {g: 1.62}, FORK);
  assert.ok(!f.hazard && !f.speed);
  const proj = {...car, report: {...car.report, fit: {...car.report.fit, model: 'projectile', p: {g: 9.8, vx: 1, vy: 5}}}};
  assert.match(forkPixels(proj, {brake: {distance_m: 20}}, FORK).error, /vehicle/);
});

test('tool braking_fork: both scenarios with numbers and ranges', () => {
  const r = braking_fork({clip_id: 'fixture:car47', speed_kmh: 30});
  assert.equal(r.scenarios.length, 2);
  const [a, b] = r.scenarios;
  assert.equal(a.stops, false); assert.ok(a.ranges.impact_kmh[0] < a.impact_kmh && a.impact_kmh < a.ranges.impact_kmh[1]);
  assert.equal(b.stops, true); assert.equal(b.metres_short, 2.5);
  assert.equal(r.assumptions.react_s, 1.5);
  assert.throws(() => braking_fork({clip_id: 'sample:apollo15_hammer_feather'}), /vehicle/);
  assert.equal(braking_fork({clip_id: 'fixture:car47', hazard_distance_m: 60}).scenarios[0].stops, true);
});

test('tool speed_survey: mean, 85th percentile, share over the limit, and skipped clips with reasons', () => {
  const r = speed_survey({clip_ids: ['fixture:car47', 'fixture:car28', 'fixture:car38', 'fixture:car52', 'sample:apollo15_hammer_feather', 'synthetic:throw', 'upload:nope'], limit_kmh: 30});
  assert.equal(r.n, 4); near(r.mean_kmh, 41.25, 0.1);
  near(r.p85_kmh, percentile([47, 28, 38, 52], 0.85), 0.2);
  assert.ok(r.p85_uncertainty.interval_68_kmh[0] < r.p85_uncertainty.interval_68_kmh[1]);
  assert.equal(r.n_over_limit, 3); assert.equal(r.share_over_limit, 0.75);
  assert.equal(r.skipped.length, 3);
  assert.match(r.skipped.find(s => s.clip_id === 'synthetic:throw').reason, /not a vehicle/);
  assert.match(r.skipped.find(s => s.clip_id === 'upload:nope').reason, /not analysed/);
  assert.match(r.summary, /85th-percentile/);
});

test('CLI: brake and survey print JSON from an injected run', () => {
  const env = {...process.env, RF_EXTRA_RUNS: FIX}; delete env.RF_ALLOW_LIVE;
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'mcp/cli.mjs'), ...a], {env, encoding: 'utf8'});
  const b = run('brake', 'fixture:car47', '--distance', '20', '--speed', '30');
  assert.equal(b.status, 0, b.stderr);
  assert.match(JSON.parse(b.stdout).scenarios[1].summary, /stops 2\.5 m short/);
  const s = run('survey', 'fixture:car47', 'fixture:car28', '--limit', '40');
  assert.equal(s.status, 0, s.stderr);
  assert.equal(JSON.parse(s.stdout).n_over_limit, 1);
  const bad = run('brake', 'sample:apollo15_hammer_feather');
  assert.equal(bad.status, 1); assert.match(bad.stderr, /vehicle/);
});

test('MCP: the new tools are listed and callable over the protocol', async () => {
  const env = {...process.env, RF_EXTRA_RUNS: FIX}; delete env.RF_ALLOW_LIVE;
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp/server.mjs')], {env, stdio: ['pipe', 'pipe', 'pipe']});
  const out = await new Promise(resolve => {
    let buf = '';
    child.stdout.on('data', d => { buf += d; const lines = buf.trim().split('\n'); if (lines.length >= 2) resolve(lines.map(l => JSON.parse(l))); });
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}) + '\n');
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'speed_survey', arguments: {clip_ids: ['fixture:car47']}}}) + '\n');
  });
  child.kill();
  assert.ok(out.find(m => m.id === 1).result.tools.some(t => t.name === 'braking_fork'));
  assert.equal(JSON.parse(out.find(m => m.id === 2).result.content[0].text).n, 1);
});
