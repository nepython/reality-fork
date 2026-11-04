#!/usr/bin/env node
// The Reality Fork tools from the shell, printing JSON. For agents that run commands or read a SKILL.md instead of using MCP.
//   node mcp/cli.mjs list
//   node mcp/cli.mjs analyze <video-path|clip_id> [--question "..."] [--live]
//   node mcp/cli.mjs fork <clip_id> [--g 1.62|moon] [--drag none|2] [--e 0.8]
//   node mcp/cli.mjs export <clip_id>
//   node mcp/cli.mjs brake <clip_id> [--distance 20] [--speed 30] [--react 1.5] [--decel 7]
//   node mcp/cli.mjs survey <clip_id...> [--limit 30]
import {analyze_video, fork_motion, export_measurements, list_clips, braking_fork, speed_survey} from './tools.mjs';

const USAGE = `usage:
  node mcp/cli.mjs list
  node mcp/cli.mjs analyze <video-path|clip_id> [--question "..."] [--live]   (--live needs RF_ALLOW_LIVE=1 and costs API credit)
  node mcp/cli.mjs fork <clip_id> [--g 1.62|moon] [--drag none|<scale>] [--e 0..1]
  node mcp/cli.mjs export <clip_id>
  node mcp/cli.mjs brake <clip_id> [--distance 20] [--speed 30] [--react 1.5] [--decel 7]   (someone steps out; needs a vehicle clip)
  node mcp/cli.mjs survey <clip_id...> [--limit 30]                                   (85th-percentile speed over many vehicle clips)`;

const [cmd, ...rest] = process.argv.slice(2);
const pos = [], opt = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); opt[k] = rest[i + 1] === undefined || rest[i + 1].startsWith('--') ? true : rest[++i]; }
  else pos.push(rest[i]);
}
// stdout stays clean JSON; errors go to stderr with a non-zero exit.
try {
  let out;
  if (cmd === 'list') out = list_clips();
  else if (cmd === 'analyze') {
    if (!pos[0]) throw new Error('analyze needs a video path or clip_id');
    const isClip = /^(sample|synthetic|upload):/.test(pos[0]);
    out = await analyze_video({[isClip ? 'clip_id' : 'path']: pos[0], question: opt.question === true ? undefined : opt.question, live: !!opt.live});
  } else if (cmd === 'fork') out = await fork_motion({clip_id: pos[0], g: opt.g === true ? undefined : opt.g, drag: opt.drag === true ? undefined : opt.drag, e: opt.e === true ? undefined : opt.e});
  else if (cmd === 'brake') {
    const n = k => opt[k] === undefined || opt[k] === true ? undefined : Number(opt[k]);
    out = braking_fork({clip_id: pos[0], hazard_distance_m: n('distance'), speed_kmh: n('speed'), react_s: n('react'), decel: n('decel')});
  } else if (cmd === 'survey') out = speed_survey({clip_ids: pos, limit_kmh: opt.limit === undefined || opt.limit === true ? undefined : Number(opt.limit)});
  else if (cmd === 'export') out = export_measurements({clip_id: pos[0]});
  else { console.error(USAGE); process.exit(cmd ? 2 : 0); }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
} catch (e) {
  console.error(JSON.stringify({error: String(e.message || e)}));
  process.exit(1);
}
