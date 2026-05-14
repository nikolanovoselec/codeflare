# graphify plugin (Codeflare-managed)

Bundles [graphify](https://github.com/safishamsi/graphify) (PyPI: `graphifyy`, Apache-2.0) as a preseed plugin so it behaves like a perfectly-configured user-installed Claude Code plugin. Turns any folder of code, SQL schemas, docs, and PDFs into a queryable knowledge graph; exposes the graph to the agent as an MCP server.

## Tier gating

Unlike `context-mode`, graphify uses a discipline-vs-capability split:

| Component | Deployed when |
|---|---|
| Plugin folder + `plugin.json` (MCP-server sentinel) | All session modes (Standard + Pro) |
| `~/.claude/skills/graphify/SKILL.md` (the discipline) | Pro session mode only |
| `~/.claude/rules/graph-first.md` (the discipline) | Pro session mode only |
| SessionStart + PostToolUse-on-clone hooks (the discipline) | Pro session mode only |

Rationale: the MCP server is harmless ambient capability that any session benefits from when the user discovers it; the rule + skill + hooks are what teach the agent to use the graph proactively. Standard-mode users have the capability without the proactive discipline. See AD52.

Mode gating is enforced via per-file entries in `preseed/agents/claude/manifest.json`. There is no `r2-seed.ts` filter for graphify (unlike `context-mode`, which gates the whole subtree on tier+mode); graphify ships at the manifest-mode granularity.

## How it works

The plugin folder ships a bare manifest (`name`, `description`, `version`), this README, and two hook scripts. The actual wiring is done by `entrypoint.sh` at session start, mirroring how `codeflare-memory`, `codeflare-hooks`, and `context-mode` are wired:

- The `graphify` MCP server is registered in `~/.claude.json` under `mcpServers` (always, when the manifest is present), invoking `python3 -m graphify.serve` against the build-time-installed `graphifyy` package.
- In Pro session mode only, two hooks are appended to `~/.claude/settings.json`:
  - **SessionStart** (matcher: `startup`) - inspects cwd for `graphify-out/graph.json` and injects a system reminder pointing the agent at `GRAPH_REPORT.md` and the MCP tools.
  - **PostToolUse** (matchers: `Bash`, `mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute`) - detects `git clone` and `gh repo clone` invocations and injects a directive instructing the agent to ask the user via AskUserQuestion whether to build a graph for the cloned repo.

graphify is installed globally during the Docker image build via `uv tool install graphifyy[mcp,sql,pdf]==<ver>`, version read from this plugin's `plugin.json`. The `graphify` CLI shim lands at `/root/.local/bin/graphify`; the MCP server entry-point is `python3 -m graphify.serve` from the same isolated venv.

Plugin updates ship as a Dependabot PR bumping the version in this `plugin.json`. The Dockerfile reads that file at build time, so the same PR rebuilds the image with the new version, keeping the runtime binary and the plugin manifest in lockstep.

## Works with and without context-mode

context-mode is preseeded only for the Custom tier (effectiveTier `unlimited` + Pro session mode). The vast majority of users (Standard, Advanced, Max tiers) run graphify without context-mode. The integration is designed to function in both regimes:

- **Without context-mode**: `/graphify` extraction uses upstream graphify's own subagent-chunking model. Each subagent reads a chunk of files, returns a short summary, and writes a chunk file to disk. The main agent's context stays bounded.
- **With context-mode**: subagent `Read`/`Grep`/`Glob`/`Agent` calls during extraction route through `ctx_execute` (bonus per-subagent token savings). The `graphify` CLI first-word is added to `enforce-ctx-mode.sh` whitelist so `graphify update .` is not denied.

The MCP query tools (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`) return bounded structured responses in both regimes; context-mode does not intercept MCP calls.

## Why preseed not runtime config

We deliver the plugin folder as a preseed asset (R2 bisync) rather than installing the plugin at runtime so:

- The folder presence is the gating sentinel - the entrypoint reads `~/.claude/plugins/graphify/.claude-plugin/plugin.json` to decide whether to register the MCP server and (in Pro mode) wire the hooks.
- The upstream `claude plugin install` path is never invoked.
- Adding/removing the plugin from a user's session is a R2 bisync operation; the wiring (MCP server + hook commands) is rebuilt on every session start and stays in sync with the deployed entrypoint.

## Persistence across sessions

`graphify-out/graph.json` and `graphify-out/GRAPH_REPORT.md` round-trip through R2 bisync (filter entries in `entrypoint.sh` rclone setup). One session builds the graph; every other session for the same user-project reads it. `graph.html`, `wiki/`, and `.cache/` are excluded (regenerable or local-only).

See `documentation/decisions/README.md` for the full architecture decision record (AD52).
