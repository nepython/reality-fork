#!/usr/bin/env node
// Reality Fork as an MCP server over stdio (newline-delimited JSON-RPC 2.0), written by hand so there is no dependency.
// stdout carries the protocol and nothing else; every log line goes to stderr.
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {TOOLS, callTool} from './tools.mjs';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const log = (...a) => console.error('[reality-fork-mcp]', ...a);
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({jsonrpc: '2.0', id, result});
const fault = (id, code, message) => send({jsonrpc: '2.0', id, error: {code, message}});

async function handle(msg) {
  const {id, method, params} = msg;
  const isRequest = id !== undefined && id !== null;
  if (!method) return;  // a stray response from the client: nothing to do
  switch (method) {
    case 'initialize': {
      const want = params?.protocolVersion;
      return reply(id, {protocolVersion: SUPPORTED.includes(want) ? want : '2025-06-18', capabilities: {tools: {listChanged: false}},
        serverInfo: {name: 'reality-fork', version: '0.1.0'},
        instructions: 'Measure the physics of motion in a short video (gravity, speed, drag, bounciness, pendulums) with error bars, then fork it under other physics. Start with list_clips or analyze_video.'});
    }
    case 'notifications/initialized': case 'notifications/cancelled': return;
    case 'ping': return isRequest && reply(id, {});
    case 'tools/list': return reply(id, {tools: TOOLS.map(({run, ...t}) => t)});
    case 'tools/call': {
      const {result, isError} = await callTool(params?.name, params?.arguments || {});
      return reply(id, {content: [{type: 'text', text: JSON.stringify(result, null, 2)}], ...(isError && {isError: true})});
    }
    default:
      if (isRequest) fault(id, -32601, `method not found: ${method}`);
  }
}

export function serve(input = process.stdin) {
  const rl = readline.createInterface({input});
  // Requests are handled in order of arrival but may overlap; each answers by its own id.
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fault(null, -32700, 'parse error'); }
    try {
      if (Array.isArray(msg)) for (const m of msg) await handle(m); else await handle(msg);
    } catch (e) {
      log('error', e);
      if (msg?.id != null) fault(msg.id, -32603, String(e.message || e));
    }
  });
  rl.on('close', () => process.exit(0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  log(`ready; live runs ${process.env.RF_ALLOW_LIVE === '1' ? 'ALLOWED (paid)' : 'off'}`);
  serve();
}
