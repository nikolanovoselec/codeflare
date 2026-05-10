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

Each hook is `context-mode hook claude-code <event>` invoking the build-time-installed global binary at `/usr/local/bin/context-mode`. No runtime download.

context-mode is installed globally during the Docker image build (`npm install -g context-mode@<ver>`, version read from this plugin's `plugin.json`). The Dockerfile then prepends a 2-line `createRequire` shim to both `cli.bundle.mjs` and `server.bundle.mjs` in the global install. Without that shim, esbuild's ESM bundle fails on every dynamic `require('node:*')` with `Dynamic require of "node:fs" is not supported` because esbuild does not inject a CommonJS-require polyfill in `--format=esm` output. The bug reproduces under both Node and Bun ESM loaders (see [codeflare#309](https://github.com/nikolanovoselec/codeflare/issues/309)), so a runtime swap from `npx` to `bunx` does not fix it. Build-time patching is the durable fix until upstream `mksglu/context-mode` ships a release with the esbuild banner.

Plugin updates ship as a Dependabot PR bumping the version in this `plugin.json`. The Dockerfile reads that file at build time, so the same PR rebuilds the image with the new version, keeping the runtime binary and the plugin manifest in lockstep.

## Why preseed not runtime config

We deliver the plugin folder as a preseed asset (R2 bisync) rather than installing the plugin at runtime so:

- The folder presence is the tier-gating sentinel — the entrypoint reads `~/.claude/plugins/context-mode/.claude-plugin/plugin.json` to decide whether to enable the hooks.
- The upstream `claude plugin install` path is never invoked, so the matcher-null self-registration bug surfaced during PR #293 development cannot reach our users.
- Adding/removing the plugin from a user's session is a R2 bisync operation; the wiring (MCP server + hook commands) is rebuilt on every session start and stays in sync with the deployed entrypoint.

See `documentation/decisions/README.md` for the full architecture decision record.
