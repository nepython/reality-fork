# Reality Fork for coding agents

Four tools let a coding agent say "measure the physics in this video and use the numbers in my code":

| Tool | What it does | Cost |
| --- | --- | --- |
| `list_clips` | Sample clips, test scenes and uploads, marked analysed or not | free |
| `analyze_video` | Headline, answer, fitted law, measurements with sigma and units, assumptions, confidence for a video path or clip id | free if saved; a live run costs a few cents and needs `live=true` plus `RF_ALLOW_LIVE=1` |
| `fork_motion` | Re-simulate under `g`, `drag`, `e`; summary, landing/bounce events, path every 0.1 s in metres | free |
| `export_measurements` | The fitted law and parameters with sigmas, scale, frame range, fps, assumptions as JSON | free |

Three front ends share `mcp/tools.mjs`: an MCP server over stdio (`mcp/server.mjs`, `npm run mcp`), a shell CLI (`mcp/cli.mjs`) and a skill (`mcp/SKILL.md`). The server needs no network and no API key for saved runs. Live runs are off unless the server's environment has `RF_ALLOW_LIVE=1` (and the Meta key configured as for the web app; the budget cap is `RF_BUDGET_USD`).

Use an absolute path to this folder everywhere below (`/ABS/PATH/hackathon`).

## Muse Code (Meta)

Muse Code is a beta released 5 Aug 2026, and the public write-ups disagree, so there are two routes. I could not install or run it, and I found no official Meta documentation page for its configuration; everything below is from third-party articles. Check `muse --help` first.

**Route A: MCP.** Reported config file `~/.config/muse/settings.json`; it must contain `"schema_version": 1` or every command fails at startup ([porteden](https://porteden.com/blog/muse-code-mcp-servers/)). Stdio servers take `command`, `args`, `env`. The key name is reported two ways: `mcp_servers` ([porteden](https://porteden.com/blog/muse-code-mcp-servers/), [skillsplayground](https://skillsplayground.com/integrations/muse/)) and `mcpServers` (the Sept 11 update of [withone](https://www.withone.ai/blog/muse-code-skills-not-mcp/md), which says build `1.1.1-R2514.1` added a `muse mcp` command and that the first release said "plugins are not available in this build"). Try:
```json
{
  "schema_version": 1,
  "mcp_servers": {
    "reality-fork": {"transport": "stdio", "command": "node", "args": ["/ABS/PATH/hackathon/mcp/server.mjs"], "env": {}}
  }
}
```
If Muse ignores it, rename the key to `mcpServers` (and drop `transport` if it complains). `muse mcp --help` should show whether it can add/list servers. MCP servers reportedly run outside Muse's sandbox ([innfactory](https://innfactory.ai/en/ai-harness/muse/)); this one only reads `cache/` and the video you name.

**Route B: skill + CLI (no MCP needed).** Muse reads skills from `~/.agents/skills`, `~/.claude/skills` and `~/.codex/skills`, and project skills from `.agents/skills` or `.claude/skills`; each is a folder with a `SKILL.md`. Project skills are skipped until the workspace is trusted (`--trust-workspace` for one run) ([withone](https://www.withone.ai/blog/muse-code-skills-not-mcp/md)). Install:
```
mkdir -p ~/.agents/skills/reality-fork
sed 's|<DIR>|/ABS/PATH/hackathon|g' /ABS/PATH/hackathon/mcp/SKILL.md > ~/.agents/skills/reality-fork/SKILL.md
```
The skill makes the agent run `node /ABS/PATH/hackathon/mcp/cli.mjs ...`. Project instructions go in `AGENTS.md`.

Verified: nothing first-hand. Reported by one or two third-party sources: the paths and key names above. Unknown: which is true for your installed build.

## Claude Code
```
claude mcp add reality-fork -- node /ABS/PATH/hackathon/mcp/server.mjs
```
Add `-s project` to share via `.mcp.json`, or `-e RF_ALLOW_LIVE=1` to allow paid live runs. Check with `claude mcp list`. Optional skill: copy `mcp/SKILL.md` to `~/.claude/skills/reality-fork/SKILL.md`.

## Codex
Add to `~/.codex/config.toml`:
```toml
[mcp_servers.reality-fork]
command = "node"
args = ["/ABS/PATH/hackathon/mcp/server.mjs"]
# env = { RF_ALLOW_LIVE = "1" }   # only if you accept paid live runs
```
Or `codex mcp add reality-fork -- node /ABS/PATH/hackathon/mcp/server.mjs`. Skills folder is `~/.codex/skills/`.

## Try it without an agent
```
node mcp/cli.mjs list
node mcp/cli.mjs analyze synthetic:throw
node mcp/cli.mjs fork synthetic:throw --g moon
node mcp/cli.mjs export synthetic:throw
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/server.mjs
```
Tests: `node --test test/mcp.test.mjs` (no network).
