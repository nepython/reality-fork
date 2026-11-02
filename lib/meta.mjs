// Meta Model API client: Responses (Muse Spark, SAM 3.1), Files, Images (Muse Image) and ASR (Muse Voice Transcribe).
// Plain fetch, no SDK. Every paid call goes through `spend()`, which keeps a ledger and refuses calls past the budget,
// and every deterministic call can be cached on disk so a replayed demo costs nothing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.MODEL_API_BASE || 'https://api.meta.ai/v1';
export const CACHE_DIR = process.env.RF_CACHE_DIR || path.join(ROOT, 'cache');

// Published prices (dev.meta.ai/docs/pricing-rate-limits, 2 November 2026), in US dollars.
export const PRICES = {
  'muse-spark-1.3': {input: 1.25e-6, output: 4.25e-6, cached: 0.15e-6},
  'muse-wonder-1.0': {input: 4e-6, output: 20e-6, cached: 0.2e-6},
  'sam-3.1': {image: 2.5e-3, frame: 0.2e-3, minFrames: 50},
  'muse-image-1.0': {image: 0.01},
  'muse-voice-transcribe-1.0': {second: 0.18 / 3600},
};

// The key is read from the environment, or from hackathon/.env, and never logged.
export function apiKey() {
  if (process.env.MODEL_API_KEY) return process.env.MODEL_API_KEY;
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*MODEL_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/);
      if (m) return (process.env.MODEL_API_KEY = m[1]);
    }
  }
  throw new Error('MODEL_API_KEY is not set (put it in hackathon/.env or the environment)');
}

// ---- spending ledger -------------------------------------------------------------------------------------------
const LEDGER = path.join(CACHE_DIR, 'ledger.jsonl');
const budget = () => Number(process.env.RF_BUDGET_USD || 25);

export function spent() {
  if (!fs.existsSync(LEDGER)) return 0;
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
    .reduce((s, l) => s + (JSON.parse(l).usd || 0), 0);
}

function checkBudget(estimate = 0) {
  const total = spent();
  if (total + estimate > budget()) {
    throw Object.assign(new Error(`budget reached: $${total.toFixed(3)} spent of $${budget()} (RF_BUDGET_USD)`), {code: 'budget'});
  }
}

function spend(entry) {
  fs.mkdirSync(CACHE_DIR, {recursive: true});
  fs.appendFileSync(LEDGER, JSON.stringify({at: new Date().toISOString(), ...entry}) + '\n');
}

export function tokenCost(model, usage = {}) {
  const p = PRICES[model.replace(/-contributor$/, '')] || PRICES['muse-spark-1.3'];
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  return ((usage.input_tokens || 0) - cached) * p.input + cached * p.cached + (usage.output_tokens || 0) * p.output;
}

// ---- disk cache ------------------------------------------------------------------------------------------------
export function hashOf(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' || Buffer.isBuffer(p) ? p : JSON.stringify(p));
  return h.digest('hex').slice(0, 24);
}

export function cached(kind, key, make) {
  const file = path.join(CACHE_DIR, kind, key + '.json');
  if (fs.existsSync(file) && !process.env.RF_NO_CACHE) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  return Promise.resolve(make()).then(value => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify(value));
    return value;
  });
}

// ---- HTTP ------------------------------------------------------------------------------------------------------
// Transient failures (rate limits, 5xx such as the API's occasional "persistence service error") are retried with
// backoff; a request is only billed when it succeeds, so a retry costs nothing extra.
async function post(route, body, {headers = {}, raw = false, timeout = 300000, attempts = 4} = {}) {
  const isForm = body instanceof FormData;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(BASE + route, {
      method: 'POST',
      headers: {Authorization: `Bearer ${apiKey()}`, ...(isForm ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    }).catch(e => ({ok: false, status: 0, text: async () => String(e.message || e)}));
    if (res.ok) return raw ? res : res.json();
    const text = await res.text().catch(() => '');
    const retry = res.status === 0 || res.status === 429 || res.status >= 500;
    if (!retry || attempt >= attempts) throw Object.assign(new Error(`${route} ${res.status}: ${text.slice(0, 600)}`), {status: res.status});
    await new Promise(r => setTimeout(r, 1500 * 2 ** (attempt - 1) + Math.random() * 500));
  }
}

// Server-sent events → parsed event objects. The parser of @meta-sam/parser consumes exactly these.
export async function* sse(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, {stream: true});
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      yield JSON.parse(data);
    }
  }
}

// ---- Responses -------------------------------------------------------------------------------------------------
// Non-streaming call for the agent (Muse Spark / Muse Wonder). Returns the response object and records its cost.
export async function respond(body, {label = 'respond'} = {}) {
  checkBudget(0.05);
  const t0 = Date.now();
  const r = await post('/responses', {store: true, ...body});
  spend({kind: label, model: body.model, usd: tokenCost(body.model, r.usage), usage: r.usage, ms: Date.now() - t0});
  return r;
}

export const outputText = r => (r.output || []).filter(o => o.type === 'message')
  .flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');

export const functionCalls = r => (r.output || []).filter(o => o.type === 'function_call');

// SAM 3.1 on a video or image: returns the raw output text (one line per frame), cached by media hash and prompt.
// `onLine` sees each frame line as it streams in, so the UI can draw masks while SAM is still working.
const samKey = (kind, mediaHash, prompt, meta) => hashOf('sam-3.1', kind, mediaHash, prompt, meta);

// A finished SAM result from the cache, or null; never a paid call (the server uses this to serve masks).
export function samCachedOnly({mediaHash, kind = 'video', prompt, metadata = {}}) {
  const file = path.join(CACHE_DIR, 'sam', samKey(kind, mediaHash, prompt, {include_confidence: 'true', ...metadata}) + '.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export async function samSegment({media, mediaHash, kind = 'video', prompt, frames = 0, onDelta, metadata = {}}) {
  const meta = {include_confidence: 'true', ...metadata};
  const key = samKey(kind, mediaHash, prompt, meta);
  return cached('sam', key, async () => {
    const estimate = kind === 'video' ? Math.max(frames, PRICES['sam-3.1'].minFrames) * PRICES['sam-3.1'].frame : PRICES['sam-3.1'].image;
    checkBudget(estimate);
    const part = kind === 'video' ? {type: 'input_video', ...media} : {type: 'input_image', ...media};
    const t0 = Date.now();
    const res = await post('/responses', {
      model: 'sam-3.1', stream: true, store: false, metadata: meta,
      input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: prompt}, part]}],
    }, {headers: {Accept: 'text/event-stream'}, raw: true, timeout: 600000});
    let text = '', status = 'eof', detail;
    for await (const ev of sse(res)) {
      if (ev.type === 'response.output_text.delta') { text += ev.delta; onDelta?.(ev.delta); }
      else if (ev.type === 'response.completed') status = 'completed';
      else if (ev.type === 'response.incomplete') { status = 'incomplete'; detail = ev.response?.incomplete_details?.reason; }
      else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error('SAM failed: ' + JSON.stringify(ev).slice(0, 400));
    }
    spend({kind: 'sam', model: 'sam-3.1', usd: estimate, frames, prompt, ms: Date.now() - t0});
    return {text, status, detail, prompt, kind};
  });
}

// ---- Files -----------------------------------------------------------------------------------------------------
export async function uploadFile(buffer, filename, type, {expiresSeconds = 7 * 24 * 3600} = {}) {
  const key = hashOf('file', buffer);
  return cached('files', key, async () => {
    const form = new FormData();
    // purpose and expiry before the file part, as the docs recommend for lower latency.
    form.append('purpose', 'user_data');
    form.append('expires_after[anchor]', 'created_at');
    form.append('expires_after[seconds]', String(expiresSeconds));
    form.append('file', new Blob([buffer], {type}), filename);
    const r = await post('/files', form);
    return {id: r.id, bytes: buffer.length, expires: Date.now() + expiresSeconds * 1000};
  }).then(async f => {
    if (f.expires && f.expires < Date.now() + 3600e3) { // re-upload a file that is about to expire
      fs.rmSync(path.join(CACHE_DIR, 'files', key + '.json'), {force: true});
      return uploadFile(buffer, filename, type, {expiresSeconds});
    }
    return f;
  });
}

// ---- Muse Image ------------------------------------------------------------------------------------------------
export async function editImage({imageDataUrl, prompt, size = 'auto', outputFormat = 'jpeg'}) {
  const key = hashOf('muse-image-1.0', imageDataUrl, prompt, size);
  return cached('images', key, async () => {
    checkBudget(PRICES['muse-image-1.0'].image);
    const t0 = Date.now();
    const r = await post('/images/edits', {
      model: 'muse-image-1.0', prompt, n: 1, size, output_format: outputFormat, response_format: 'b64_json',
      images: [{image_url: imageDataUrl}],
    });
    spend({kind: 'image-edit', model: 'muse-image-1.0', usd: PRICES['muse-image-1.0'].image, ms: Date.now() - t0});
    return {b64: r.data?.[0]?.b64_json, format: outputFormat};
  });
}

// ---- Muse Voice Transcribe -------------------------------------------------------------------------------------
// `wav` must be mono 16-bit PCM at 16 or 24 kHz (the endpoint accepts nothing else).
export async function transcribe(wav, {keywords = []} = {}) {
  const seconds = Math.max(0, (wav.length - 44) / (2 * 24000));
  checkBudget(seconds * PRICES['muse-voice-transcribe-1.0'].second);
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({mode: 'PUSH_TO_TALK', model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', languageBias: ['English'], keywords})], {type: 'application/json'}));
  form.append('audio', new Blob([wav], {type: 'audio/wav'}), 'question.wav');
  const r = await post('/asr/transcribe', form);
  spend({kind: 'asr', model: 'muse-voice-transcribe-1.0', usd: (r.audioDurationMs || seconds * 1000) / 1000 * PRICES['muse-voice-transcribe-1.0'].second});
  return r.transcript || '';
}
