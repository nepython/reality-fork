// The MCP server and CLI, over saved runs only: no network, no Meta API (live runs are refused without RF_ALLOW_LIVE=1).
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {clipById, clipInfo, latestRun} from '../lib/store.mjs';
import {forkPixels} from '../lib/forkview.mjs';
import {spriteFor} from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'mcp/server.mjs'), CLI = path.join(ROOT, 'mcp/cli.mjs');
const CLIP = 'synthetic:throw';
// A throwaway cache, so the live-refusal test uploads into nothing the demo uses, and no key is ever read.
const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-mcp-'));
after(() => fs.rmSync(tmpCache, {recursive: true, force: true}));
const cleanEnv = extra => { const e = {...process.env, ...extra}; delete e.RF_ALLOW_LIVE; delete e.META_API_KEY; return {...e, ...extra}; };

function client(env = {}) {
  const child = spawn(process.execPath, [SERVER], {env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe']});
  const waiting = new Map(), lines = [];
  readline.createInterface({input: child.stdout}).on('line', l => { lines.push(l); const m = JSON.parse(l); waiting.get(m.id)?.(m); });
  let n = 0;
  const call = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n'); });
  const tool = async (name, args) => { const r = (await call('tools/call', {name, arguments: args})).result; return {isError: !!r.isError, data: JSON.parse(r.content[0].text)}; };
  return {child, call, tool, lines, notify: (method, params) => child.stdin.write(JSON.stringify({jsonrpc: '2.0', method, params}) + '\n'), close: () => child.kill()};
}

test('MCP: handshake, ping, tool list', async () => {
  const c = client();
  try {
    const init = (await c.call('initialize', {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test', version: '0'}})).result;
    assert.equal(init.protocolVersion, '2025-03-26');
    assert.equal(init.serverInfo.name, 'reality-fork');
    assert.ok(init.capabilities.tools);
    c.notify('notifications/initialized');
    assert.deepEqual((await c.call('ping')).result, {});
    const {tools} = (await c.call('tools/list')).result;
    assert.deepEqual(tools.map(t => t.name), ['list_clips', 'analyze_video', 'fork_motion', 'export_measurements', 'braking_fork', 'speed_survey']);
    for (const t of tools) { assert.equal(t.inputSchema.type, 'object'); assert.ok(t.description.length > 40); }
    assert.equal((await c.call('nope')).error.code, -32601);
    // An unknown protocol version is answered with one we support.
    const c2 = client();
    assert.equal((await c2.call('initialize', {protocolVersion: '1999-01-01'})).result.protocolVersion, '2025-06-18');
    c2.close();
    // stdout carried JSON-RPC only.
    assert.ok(c.lines.every(l => JSON.parse(l).jsonrpc === '2.0'));
  } finally { c.close(); }
});

test('MCP: analyze_video returns the saved run compactly, with no per-frame arrays', async () => {
  const c = client();
  try {
    const {isError, data} = await c.tool('analyze_video', {clip_id: CLIP});
    assert.equal(isError, false);
    const run = latestRun(CLIP).report;
    assert.equal(data.headline, run.headline);
    assert.equal(data.law.model, run.fit.model);
    assert.equal(data.measurements.length, run.measurements.length);
    assert.ok(data.measurements.every(m => m.unit !== undefined && Number.isFinite(m.sigma)));
    assert.ok(data.assumptions.length && data.confidence && data.suggested_forks.length);
    assert.ok(JSON.stringify(data).length < 5000, 'compact');
    assert.ok(!('tracks' in data) && !('measured' in data));
  } finally { c.close(); }
});

test('MCP: fork_motion equals what /api/fork computes', async () => {
  const c = client();
  try {
    const clip = clipById(CLIP), run = latestRun(CLIP), info = clipInfo(clip);
    const sprite = await spriteFor(clip, run, run.report.object).catch(() => null);
    for (const [args, ov] of [[{g: 1.62}, {g: 1.62}], [{e: 0.8}, {e: 0.8}], [{drag: 'none'}, {drag: 'none'}]]) {
      const want = forkPixels(run, ov, {fps: info.fps, frames: info.frames, sprite: sprite?.meta});
      const {isError, data} = await c.tool('fork_motion', {clip_id: CLIP, ...args});
      assert.equal(isError, false);
      assert.equal(data.summary, want.summary);
      assert.equal(data.events.length, want.events.length);
      want.events.forEach((ev, i) => { assert.ok(Math.abs(data.events[i].t - ev.t) < 1e-3); assert.ok(Math.abs(data.events[i].x - ev.x) < 1e-3); assert.equal(data.events[i].type, ev.type); });
      // The path in metres maps back to the app's pixel path: last point is the app's last point.
      const fit = run.report.fit, last = want.path.at(-1), p = data.path.at(-1);
      assert.ok(Math.abs(fit.origin_px[0] + p.x * fit.ppm - last[1]) < 0.2 && Math.abs(fit.origin_px[1] - p.y * fit.ppm - last[2]) < 0.2);
      assert.ok(Math.abs(p.t - (last[0] - fit.frameOffset) / info.fps) < 1e-3);
      assert.ok(data.path.length < want.path.length / 2 + 2, 'sampled about every 0.1 s');
    }
    const moon = (await c.tool('fork_motion', {clip_id: CLIP, g: 'moon'})).data;
    assert.deepEqual(moon.overrides, {g: 1.62});
    // Bad input is a tool error, not a crash.
    assert.equal((await c.tool('fork_motion', {clip_id: CLIP})).isError, true);
    assert.equal((await c.tool('fork_motion', {clip_id: CLIP, e: 3})).isError, true);
    assert.equal((await c.tool('export_measurements', {clip_id: 'nope'})).isError, true);
    assert.equal((await c.tool('no_such_tool', {})).isError, true);
  } finally { c.close(); }
});

test('MCP: export_measurements gives the law with sigmas, scale and frame range', async () => {
  const c = client();
  try {
    const {isError, data} = await c.tool('export_measurements', {clip_id: CLIP});
    const fit = latestRun(CLIP).report.fit;
    assert.equal(isError, false);
    assert.equal(data.law.model, fit.model);
    assert.equal(data.law.parameters.g.value, Math.round(fit.p.g * 1e6) / 1e6);
    assert.equal(data.law.parameters.g.unit, 'm/s^2');
    assert.ok(data.law.parameters.g.sigma > 0);
    assert.deepEqual([data.frames.first, data.frames.last], fit.frames);
    assert.equal(data.fps, fit.fps);
    assert.ok(Math.abs(data.scale.pixels_per_metre - fit.ppm) < 1e-2 && data.scale.sigma_rel > 0);
    assert.ok(data.assumptions.length);
  } finally { c.close(); }
});

test('MCP: a live request without RF_ALLOW_LIVE=1 is refused (nothing is run, nothing paid)', async () => {
  const video = path.join(ROOT, 'bench/synthetic/throw.mp4');
  const c = client({RF_CACHE_DIR: tmpCache});
  try {
    const r = await c.tool('analyze_video', {path: video, live: true});
    assert.equal(r.isError, true);
    assert.match(r.data.error, /RF_ALLOW_LIVE=1/);
    assert.match(r.data.error, /cost/);
    // Without live=true the same message appears (even RF_ALLOW_LIVE=1 does not run a lab unasked).
    const c2 = client({RF_CACHE_DIR: tmpCache, RF_ALLOW_LIVE: '1', RF_BUDGET_USD: '0'});
    const r2 = await c2.tool('analyze_video', {path: video});
    assert.equal(r2.isError, true);
    c2.close();
  } finally { c.close(); }
});

test('CLI: list, analyze, fork, export print JSON; a live request without the switch fails', () => {
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], {encoding: 'utf8', env: cleanEnv({RF_CACHE_DIR: ''})});
  assert.ok(JSON.parse(run('list').stdout).some(c => c.clip_id === CLIP && c.analysed));
  assert.equal(JSON.parse(run('analyze', CLIP, '--question', 'what is g?').stdout).clip_id, CLIP);
  const f = JSON.parse(run('fork', CLIP, '--g', '1.62').stdout);
  assert.equal(f.overrides.g, 1.62);
  assert.ok(JSON.parse(run('export', CLIP).stdout).law.parameters.g);
  const bad = spawnSync(process.execPath, [CLI, 'analyze', path.join(ROOT, 'bench/synthetic/throw.mp4'), '--live'],
    {encoding: 'utf8', env: cleanEnv({RF_CACHE_DIR: tmpCache})});
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /RF_ALLOW_LIVE=1/);
});
