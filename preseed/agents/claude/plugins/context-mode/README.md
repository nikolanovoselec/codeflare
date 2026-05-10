# context-mode plugin (Codeflare-managed)

Bundles [context-mode](https://github.com/mksglu/context-mode) as a preseed plugin so it behaves like a perfectly-configured user-installed Claude Code plugin.

## Tier gating

This plugin is only deployed to user buckets when ALL of:

- `effectiveTier === 'unlimited'` (Custom tier in admin UI)
- `sessionMode === 'advanced'` (Pro session mode)

The R2 preseed filter at `src/lib/r2-seed.ts` excludes the entire `plugins/context-mode/` subtree for any other tier or mode combination. When excluded, the plugin folder simply does not appear in the user's `~/.claude/plugins/` and Claude Code does not load it.

## How it works

The plugin folder ships a bare manifest (`name`, `description`, `version`) and this README. The actual wiring is done by `entrypoint.sh` at session start, mirroring how `codeflare-memory` and `codeflare-hooks` are wired:

- The `context-mode` MCP server is registered in `~/.claude.json` under `mcpServers` (always, when the manifest is present).
- Four hooks are appended to `~/.claude/settings.json` (advanced mode + manifest present only):
  - PreToolUse on `Bash|Read|WebFetch|Grep|Glob|Agent`
  - PostToolUse on `Bash|Read|WebFetch|Grep|Glob`
  - PreCompact (no matcher)
  - SessionStart (no matcher)

Each hook is `npx -y context-mode@<version> hook claude-code <event>`. The first invocation downloads `context-mode@<version>` into the npx cache; subsequent invocations are cache-served.

The version comes from this plugin's `plugin.json` (entrypoint reads `.version` via `jq`), so plugin updates ship as a Dependabot PR bumping the version pin in `plugin.json`.

## Why preseed not runtime config

We deliver the plugin folder as a preseed asset (R2 bisync) rather than installing the plugin at runtime so:

- The folder presence is the tier-gating sentinel — the entrypoint reads `~/.claude/plugins/context-mode/.claude-plugin/plugin.json` to decide whether to enable the hooks.
- The upstream `claude plugin install` path is never invoked, so the matcher-null self-registration bug surfaced during PR #293 development cannot reach our users.
- Adding/removing the plugin from a user's session is a R2 bisync operation; the wiring (MCP server + hook commands) is rebuilt on every session start and stays in sync with the deployed entrypoint.

See `documentation/decisions/README.md` for the full architecture decision record.
