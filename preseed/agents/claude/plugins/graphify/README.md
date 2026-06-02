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

graphify is installed globally during the Docker image build via `uv tool install graphifyy[mcp,sql,pdf]==<ver>`, version read from this plugin's `plugin.json`. The `graphify` CLI shim lands at `/root/.local/bin/graphify`; the MCP server entry-point is `python3 -m graphify.serve` from the same isolated venv. Provider/backend extras are intentionally omitted; interactive semantic extraction and community labels are produced by the active agent session, not Graphify provider backends.

Plugin updates ship as a Dependabot PR bumping the version in this `plugin.json`. The Dockerfile reads that file at build time, so the same PR rebuilds the image with the new version, keeping the runtime binary and the plugin manifest in lockstep.

## Works with and without context-mode

context-mode is preseeded only for the Custom tier (effectiveTier `unlimited` + Pro session mode). The vast majority of users (Standard, Advanced, Max tiers) run graphify without context-mode. The integration is designed to function in both regimes:

- **Without context-mode**: `/graphify` extraction uses upstream graphify's own subagent-chunking model. Each subagent reads a chunk of files, returns a short summary, and writes a chunk file to disk. The main agent's context stays bounded.
- **With context-mode**: subagent `Read`/`Grep`/`Glob`/`Agent` calls during extraction can route through `ctx_execute` (bonus per-subagent token savings). Graphify runs unimpeded because the old context-mode Bash deny-gate was removed.

The MCP query tools (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`) return bounded structured responses in both regimes; context-mode does not intercept MCP calls.

## Why preseed not runtime config

We deliver the plugin folder as a preseed asset (R2 bisync) rather than installing the plugin at runtime so:

- The folder presence is the gating sentinel - the entrypoint reads `~/.claude/plugins/graphify/.claude-plugin/plugin.json` to decide whether to register the MCP server and (in Pro mode) wire the hooks.
- The upstream `claude plugin install` path is never invoked.
- Adding/removing the plugin from a user's session is a R2 bisync operation; the wiring (MCP server + hook commands) is rebuilt on every session start and stays in sync with the deployed entrypoint.

## Persistence across sessions

Repo graph persistence lives in git, not R2. When the user can push, commit `graphify-out/graph.json`, `graphify-out/GRAPH_REPORT.md`, `graphify-out/graph.html`, `graphify-out/callflow.html`, and `.graphify_labels.json` (plus optional `wiki/`) with `graphify-out/graph.json merge=graphify` in `.gitattributes`; caches and intermediates stay ignored. R2 bisync excludes `graphify-out/` so large graph artifacts do not churn session storage.

See `documentation/decisions/README.md` for the full architecture decision record (AD52).
