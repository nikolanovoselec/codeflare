# Storage & Sync

R2 persistent storage, rclone bisync synchronization, sync modes, storage quotas, and conflict resolution.

**Audience:** Operators, Developers

---

## Storage Quota

Per-user R2 storage is capped by `maxStorageBytes` in `SubscriptionTierConfig`. R2 has no native per-bucket quota — enforcement is in application code.

**Tier defaults:** Configurable per tier in admin Subscription Management panel (Storage Quota field, in MB). Custom tier defaults to unlimited.

**Enforcement:** Session creation (`POST /api/sessions` in `crud.ts`) checks `storage-stats:{bucketName}` KV cache against the user's tier quota. If `totalSizeBytes > maxStorageBytes`, the request is rejected with a clear error message. Users must delete files from their storage browser to free space before starting new sessions.

**Stats endpoint:** `GET /api/storage/stats` returns `maxStorageBytes` alongside usage stats. The quota is cached in KV alongside the stats (`storage-stats:{bucketName}`) so cache hits don't need tier config resolution — tier config is only read on cache miss (every 60s). Frontend displays "X / Y" in the storage card. Subscribe page plan cards show storage quota in the specs line. Admin Subscription Management has an editable "Storage Quota (MB)" field per tier.

**What is NOT enforced:** Individual file uploads, rclone sync writes, and preseed writes are not blocked by quota. The quota is checked only at session start. Users can temporarily exceed their quota during an active session via rclone sync or file uploads. The overage is caught on the next session start attempt.

**Tier config merge:** `getTierConfig()` merges stored KV tiers with hardcoded defaults via `{ ...default, ...stored }`. New fields (like `maxStorageBytes`) backfill from defaults even when KV was saved before the field existed. Admin-saved values always take priority. The admin `PUT /api/admin/tiers` Zod schema includes `maxStorageBytes` so it persists on save.

## Why rclone bisync (Not s3fs)

s3fs FUSE: every file op = network call (~340ms PUT, ~50ms HEAD), fragile on network hiccups, "Socket not connected" errors.

rclone bisync: all file ops on local disk (<1ms), background daemon every 60s, final bisync on shutdown (SIGINT/SIGTERM), stable.

## Initial Sync on Startup

1. One-way `rclone sync` from R2 to local (restore data) — blocking, container waits for completion (120s timeout)
2. All file modifications run (`.claude.json`, `.gemini/settings.json`, `.codex/version.json`, tab autostart) — these complete before bisync starts to avoid hash mismatches
3. `rclone bisync --resync --ignore-checksum --max-delete 100 --check-sync=false --retries 3 --retries-sleep 10s` to establish baseline (non-blocking — runs in background), then start 60-second daemon

All bisync commands use `--ignore-checksum` to skip post-transfer MD5 verification. rclone v1.73+ treats hash mismatches as fatal ("corrupted on transfer"), which aborts bisync when files change during transfer (e.g., coding agents modifying workspace files). Change detection still uses modtime + size; files that change mid-transfer are caught in the next 60s cycle.

`--min-size 1B` on all rclone commands (sync, bisync baseline, bisync daemon) excludes 0-byte files from transfer. R2 SSE-C fails on empty objects — the HeadObject call returns 400 when SSE-C headers are sent for a 0-byte object, which causes rclone to abort with "encryption parameters are not applicable". Empty files (`.lock`, `__init__.py`, etc.) carry no data and are excluded entirely.

`--max-delete 100` allows bisync to propagate bulk deletions (e.g., deleting entire workspace folders). The rclone default of 50% aborts bisync when more than half the files are deleted in one cycle — in a config-heavy sync with few files, even a single folder deletion can exceed this threshold.

## What's Synced vs Excluded

| Path | Synced | Reason |
|------|--------|--------|
| `~/.claude/` | Yes | Claude credentials, config, projects |
| `~/.config/` | Yes | App configs (gh CLI, etc.) |
| `~/.gitconfig` | Yes | Git configuration |
| `~/workspace/` | Depends on `SYNC_MODE` | Excluded by default (`none`). Synced when `full` or partially with `metadata`. |
| `~/.npm/`, `~/.bun/`, `~/.cache/**`, `~/.config/rclone/**` | **NO** | Package manager and rclone caches, regenerated |
| `~/.local/share/claude/**` | **NO** | Native installer version binaries (leftover data, removed from build) |
| `~/.copilot/logs/**`, `~/.copilot/pkg/**` | **NO** | Copilot session logs and auto-update binary |
| `~/.codex/sessions/**`, `~/.codex/log/**`, `~/.codex/tmp/**`, etc. | **NO** | Codex ephemeral session data and caches |
| `~/.claude/cache/**`, `~/.claude/debug/**`, `~/.claude/file-history/**`, etc. | **NO** | Claude Code session-specific ephemeral data |
| `~/.claude/projects/**/subagents/**` | **NO** | Subagent transcripts (results captured in main transcript) |
| `~/.claude/usage-data/**`, `~/.claude/backups/**`, `~/.claude/tasks/**` | **NO** | Insights reports, settings backups, task state (all regenerated) |
| `~/.claude/sessions/**`, `~/.claude/history.jsonl` | **NO** | Session metadata, command history (ephemeral) |
| `~/.cpan/**` | **NO** | Perl CPAN package manager cache, regenerated |
| `~/.gemini/tmp/**` | **NO** | Gemini CLI temp files (ripgrep binary, chat logs) |
| `~/.local/share/opencode/log/**`, `opencode.db-shm`, `opencode.db-wal` | **NO** | OpenCode session logs and SQLite temp files |

## rclone Sync Modes

| Mode | Workspace Sync | Use Case |
|------|---------------|----------|
| `none` | Excluded entirely | Default. Settings and config only. |
| `full` | Entire `workspace/` (minus `node_modules/`) | Persistent storage across stop/resume |
| `metadata` | Only agent config files (`.claude/` and `CLAUDE.md`) per repo | Lightweight project context sync |

All modes always exclude: `.bashrc`, `.bash_profile`, `.npm/**`, `.bun/**`, `.cache/**`, `.config/rclone/**`, `.config/.wrangler/**`, `**/node_modules/**`, `.local/share/claude/**`, `.local/state/**`, `.copilot/logs/**`, `.copilot/pkg/**`, `.copilot/session-state/**`, `.codex/sessions/**`, `.codex/state*.sqlite-shm`, `.codex/state*.sqlite-wal`, `.codex/.tmp/**`, `.claude/cache/**`, `.claude/debug/**`, `.claude/file-history/**`, `.claude/plugins/marketplaces/**`, `.claude/projects/**/subagents/**`, `.claude/projects/**/tool-results/**`, `.claude/session-env/**`, `.claude/shell-snapshots/**`, `.claude/stats-cache.json`, `.claude.json.backup.*`, `.claude/usage-data/**`, `.claude/backups/**`, `.claude/tasks/**`, `.claude/sessions/**`, `.claude/history.jsonl`, `.codex/log/**`, `.codex/models_cache.json`, `.codex/.personality_migration`, `.codex/shell_snapshots/**`, `.codex/tmp/**`, `.codex/version.json`, `.cpan/**`, `.gemini/tmp/**`, `.local/share/opencode/log/**`, `.local/share/opencode/opencode.db-shm`, `.local/share/opencode/opencode.db-wal`, `.memory/counter/**`. All rclone commands use `--filter` flags (NOT `--include`/`--exclude`).

**Note:** The `metadata` mode is defined in `entrypoint.sh` but the Container DO currently only maps `workspaceSyncEnabled` to `full` or `none`. The `metadata` mode can be used by setting `SYNC_MODE` directly in the container environment.

## Session Transcript Cleanup

`cleanup_old_transcripts()` runs before each periodic bisync (sequential in the same loop iteration — no concurrent access). Keeps the 5 most recent session transcripts (`.claude/projects/**/*.jsonl` sorted by mtime), deletes older `.jsonl` files only — session directories are left intact so Claude Code can still resolve project paths. Deletions propagate to R2 via bisync automatically. Subagent transcripts are also excluded from bisync entirely (`--filter "- .claude/projects/**/subagents/**"`) since results are captured in the main transcript. Both `cleanup_old_transcripts()` and `cleanup_old_memory_files()` are wrapped in subshells with `|| true` to prevent `set -euo pipefail` from killing the bisync daemon when cleanup encounters benign non-zero exits (e.g., empty `find` results, `xargs` with no input).

## Conflict Resolution

Newest file wins (`--conflict-resolve newer`). `--resilient` + `--recover` handle transient bisync failures (e.g., interrupted transfers, listing mismatches) without losing deletion tracking. The sync daemon retries in 60s on failure. `--max-delete 100` on ALL bisync commands (`establish_bisync_baseline` and `bisync_with_r2`) allows bulk workspace deletions to propagate. Shutdown handler runs final bisync. All bisync commands use `--ignore-checksum` to prevent false hash-mismatch aborts — rclone v1.73 introduced stricter post-transfer MD5 verification that fails when files change during sync.

`--check-sync=false` disables rclone's post-sync listing validation on both `establish_bisync_baseline` and `bisync_with_r2`. The validation compares local/remote file listings after sync — if files change on R2 during the sync (e.g., another active session writing), the listings diverge and rclone exits with code 7 (critical abort). This was the most common trigger. With `--check-sync=false`, drift is caught by the next 60s cycle instead.

`--retries 3 --retries-sleep 10s` (rclone v1.66+) on both functions adds bisync-level retries for transient R2 API failures. Each bisync invocation retries up to 3 times with 10s sleep between attempts, before the daemon-level retry logic even kicks in.

**Consecutive failure recovery:** The daemon tracks consecutive bisync failures. After 3 consecutive failures (each with 3 internal retries = 9 total attempts), falls back to `establish_bisync_baseline` (which uses `--resync`) to re-establish clean bisync state. `--resync` merges both sides (files present on only one side get copied to the other), so this is a last resort. The counter resets to 0 on any success or after the resync fallback. Resync failures are logged with full command output for diagnostic visibility. The baseline establishment timeout is 600s (10 minutes) to accommodate large initial syncs.

**Self-healing (`nuke_corrupted_r2_files`):** When resync fails (even after 3 daemon retries), the entrypoint automatically detects and removes files blocking bisync. Two strategies: (1) parse sync.log for ANY file path that caused a bisync error — catches encryption mismatch, size mismatch, corrupted transfer, copy failure, hash mismatch, listing conflicts. Files are deleted from both R2 (using both encrypted and unencrypted configs) and local. (2) If no error files found in logs, full R2 scan — list all objects with an unencrypted config, HEAD each with the encrypted config, delete any returning 400 (unencrypted orphans from older sessions). After nuking, bisync state is cleared and resync retried immediately. Self-healing runs both at startup (if initial baseline fails) and in the daemon (if resync fallback fails). Principle: losing one problematic file is better than losing all sync.

**Bisync exit code handling:** `bisync_with_r2()` uses a temp file approach instead of `| tee` to capture both output and exit code. Piping through `tee` swallows the rclone exit code (the pipe's exit code is `tee`'s, not rclone's), masking bisync failures and breaking error detection in the daemon loop. Both functions redirect with `> "$FILE" 2>&1` (not `2>&1 > "$FILE"`). The old order sent stderr to the parent process's stdout (lost) and only captured stdout in the file. rclone outputs errors and verbose info to stderr, so all diagnostic output was invisible in `/tmp/sync.log`.

**Bisync-initialized flag on timeout:** The bisync-initialized flag (`/tmp/.bisync-initialized`) is now touched on the sync timeout path as well. Previously, if initial sync timed out, the flag was never set, causing the shutdown trap to skip the final bisync — losing any files created during the session.

---

## Related Documentation
- [Architecture](architecture.md#container-do) - Container DO lifecycle
- [Container](container.md#container-startup) - Startup sync sequence
- [Memory](memory.md) - Memory file sync and cleanup
- [Configuration](configuration.md#container-environment) - Sync environment variables
- [Troubleshooting](troubleshooting.md#r2-sync-issues) - Sync troubleshooting
