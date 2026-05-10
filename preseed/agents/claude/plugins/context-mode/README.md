# context-mode plugin (Codeflare-managed)

Bundles [context-mode](https://github.com/mksglu/context-mode) as a preseed plugin so it behaves like a perfectly-configured user-installed Claude Code plugin.

## Tier gating

This plugin is only deployed to user buckets when ALL of:

- `effectiveTier === 'unlimited'` (Custom tier in admin UI)
- `sessionMode === 'advanced'` (Pro session mode)

The R2 preseed filter at `src/lib/r2-seed.ts` excludes the entire `plugins/context-mode/` subtree for any other tier or mode combination. When excluded, the plugin folder simply does not appear in the user's `~/.claude/plugins/` and Claude Code does not load it.

## How it works

`hooks/hooks.json` registers four hooks that invoke the upstream context-mode CLI via npx:

- PreToolUse on `Bash|Read|WebFetch|Grep|Glob|Agent`
- PostToolUse on `Bash|Read|WebFetch|Grep|Glob`
- PreCompact (no matcher)
- SessionStart (no matcher)

The first invocation downloads context-mode@1.0.111 into the npx cache. Subsequent invocations are cache-served.

## Why preseed not runtime config

We deliver this as a preseed asset (R2 bisync) rather than wiring at runtime in `entrypoint.sh` so:

- The configuration is data, not code in a shell heredoc.
- Plugin updates ship as a Dependabot PR bumping the version pin in `hooks/hooks.json`.
- The upstream `claude plugin install` path is never invoked, so the matcher-null self-registration bug surfaced during PR #293 development cannot reach our users.
- Adding/removing the plugin from a user's session is a R2 bisync operation, not a settings.json mutation.

See `documentation/decisions/README.md` for the full architecture decision record.
