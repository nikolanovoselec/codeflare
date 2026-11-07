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

The image installs exact `context-mode@2.1.4` into both committed npm trees (`preseed/npm-tools` and `preseed/agents/pi`), with `/usr/local/bin/context-mode` linked to the shared copy. The dedicated Shadow Pins context-mode job owns the plugin manifest, both manifests/locks, Pi runtime pin, entrypoint settings and generated seed atomically; a Pi-only Dependabot diff is not sufficient.

v2 requires Node >=24.15.0 and built-in SQLite; it bundles dependencies rather than installing better-sqlite3. The CLI entry is `cli.mjs`, MCP entry is `server.mjs`, and Pi's in-process extension is `pi/index.js`. Codeflare registers `context-mode server --agent claude-code` explicitly: no arguments now print help. Legacy `context-mode hook claude-code <event>` remains supported. Pi retains `/ctx` opt-in and the single-foreground-owner guard, without a bridge child.

The image helper validates both versions and retains the idempotent ESM shim/update-probe suppression on the v2 runtime entries. The reviewed archive has no automatic npm latest probe. Image qualification uses the real CLI/MCP, shell execution and SQLite index/search, not just imports. Explicit upgrade/setup is not a startup operation.

Tool migration: `ctx_batch({commands: ["command"], queries: ["query"]})` replaces object-based `ctx_batch_execute`; `ctx_index({url: "https://…"})` replaces `ctx_fetch_and_index`; `ctx_execute` accepts `file` instead of a separate `ctx_execute_file`. Discover live schemas; no context-mode tool is required when disabled.

**Security qualification is separate:** the integrity-verified 2.1.4 tarball contains its own Zod v4.0.0 code as well as MCP's v4.6.7 copies. Removing lockfile Zod v3 records does not prove embedded validators patched. A manifest override cannot alter bundled code; upstream remediation or a separately reviewed rebuild is required before claiming full Zod remediation. [Published package](https://registry.npmjs.org/context-mode/2.1.4), [source manifest](https://github.com/mksglu/context-mode/blob/v2.1.4/package.json), [Pi entry](https://github.com/mksglu/context-mode/blob/v2.1.4/src/entries/pi.ts).

## Why preseed not runtime config

We deliver the plugin folder as a preseed asset (R2 bisync) rather than installing the plugin at runtime so:

- The folder presence is the tier-gating sentinel — the entrypoint reads `~/.claude/plugins/context-mode/.claude-plugin/plugin.json` to decide whether to enable the hooks.
- The upstream `claude plugin install` path is never invoked, so the matcher-null self-registration bug surfaced during PR #293 development cannot reach our users.
- Adding/removing the plugin from a user's session is a R2 bisync operation; the wiring (MCP server + hook commands) is rebuilt on every session start and stays in sync with the deployed entrypoint.

See `documentation/decisions/README.md` for the full architecture decision record.
