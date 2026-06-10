# Storage & Sync

R2 persistent storage, rclone bisync synchronization, sync modes, storage quotas, and conflict resolution.

**Audience:** Operators, Developers

---

## Contents

- [Storage Quota (REQ-STOR-006, REQ-STOR-014)](#storage-quota-req-stor-006-req-stor-014)
- [Why rclone bisync (Not s3fs)](#why-rclone-bisync-not-s3fs)
- [Initial Sync on Startup](#initial-sync-on-startup)
- [What's Synced vs Excluded (REQ-STOR-011)](#whats-synced-vs-excluded-req-stor-011)
- [rclone Sync Modes (REQ-STOR-003)](#rclone-sync-modes-req-stor-003)
- [Manual Sync Triggers (REQ-STOR-015)](#manual-sync-triggers-req-stor-015)
- [Session Transcript Cleanup](#session-transcript-cleanup)
- [Conflict Resolution](#conflict-resolution)

## Storage Quota (REQ-STOR-006, REQ-STOR-014)

Per-user R2 storage is capped by `maxStorageBytes` in `SubscriptionTierConfig`. R2 has no native per-bucket quota - enforcement is in application code.

**Tier defaults:** Configurable per tier in admin Subscription Management panel (Storage Quota field, in MB). Custom tier defaults to unlimited.

**Enforcement:** Session creation (`POST /api/sessions` in `crud.ts`) checks `storage-stats:{bucketName}` KV cache against the user's tier quota. If `totalSizeBytes > maxStorageBytes`, the request is rejected with a clear error message. Users must delete files from their storage browser to free space before starting new sessions.

**Stats endpoint:** `GET /api/storage/stats` returns `maxStorageBytes` alongside usage stats. The quota is cached in KV alongside the stats (`storage-stats:{bucketName}`) so cache hits don't need tier config resolution - tier config is only read on cache miss (every 60s). Frontend displays "X / Y" in the storage card. Subscribe page plan cards show storage quota in the specs line. Admin Subscription Management has an editable "Storage Quota (MB)" field per tier.

**What is NOT enforced:** Individual file uploads, rclone sync writes, and preseed writes are not blocked by quota. The quota is checked only at session start. Users can temporarily exceed their quota during an active session via rclone sync or file uploads. The overage is caught on the next session start attempt.

**Tier config merge:** `getTierConfig()` merges stored KV tiers with hardcoded defaults via `{ ...default, ...stored }`. New fields (like `maxStorageBytes`) backfill from defaults even when KV was saved before the field existed. Admin-saved values always take priority. The admin `PUT /api/admin/tiers` Zod schema includes `maxStorageBytes` so it persists on save.

## Why rclone bisync (Not s3fs)

s3fs FUSE: every file op = network call (~340ms PUT, ~50ms HEAD), fragile on network hiccups, "Socket not connected" errors.

rclone bisync: all file ops on local disk (<1ms), background daemon every 15 minutes (`sleep 900`, SIGUSR1-interruptible for manual triggers from the storage panel), final bisync on shutdown via the DO-side synchronous drain (`POST /internal/final-sync`, 120s budget) before stop. See [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers) for the cadence rationale and [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync) for the shutdown budget.

## Initial Sync on Startup

1. One-way `rclone sync` from R2 to local (restore data) - blocking, container waits for completion (120s timeout)
2. All file modifications run (`.claude.json`, `.codex/version.json`, tab autostart) - these complete before bisync starts to avoid hash mismatches
3. `rclone bisync --resync --ignore-checksum --max-delete 100 --check-sync=false --retries 3 --retries-sleep 10s` to establish baseline (non-blocking - runs in background), then start the 15-minute daemon (SIGUSR1-interruptible)

All bisync commands use `--ignore-checksum` to skip post-transfer MD5 verification. rclone v1.73+ treats hash mismatches as fatal ("corrupted on transfer"), which aborts bisync when files change during transfer (e.g., coding agents modifying workspace files). Change detection still uses modtime + size; files that change mid-transfer are caught in the next 15-minute cycle (or sooner via a manual Sync-now trigger).

`--min-size 1B` on all rclone commands (sync, bisync baseline, bisync daemon) excludes 0-byte files from transfer. R2 SSE-C fails on empty objects - the HeadObject call returns 400 when SSE-C headers are sent for a 0-byte object, which causes rclone to abort with "encryption parameters are not applicable". Empty files (`.lock`, `__init__.py`, etc.) carry no data and are excluded entirely.

`--max-delete 100` allows bisync to propagate bulk deletions (e.g., deleting entire workspace folders). The rclone default of 50% aborts bisync when more than half the files are deleted in one cycle - in a config-heavy sync with few files, even a single folder deletion can exceed this threshold.

## What's Synced vs Excluded (REQ-STOR-011)

| Path | Synced | Reason |
|------|--------|--------|
| `~/.claude/` | Yes | Claude credentials, config, projects |
| `~/.gitconfig` | Yes | Git configuration |
| `~/workspace/` | Depends on `SYNC_MODE` | Excluded by default (`none`). Synced when `full` or partially with `metadata`. |
| `~/.npm/`, `~/.bun/`, `~/.cache/**` | **NO** | Package manager caches, regenerated |
| `~/.wrangler/`, `~/.config/**` | **NO** | Wrangler state (root location) + all XDG tool configs (configstore, fish, opencode, uv, rclone, wrangler-XDG) - all regenerable on first use. No codeflare-managed state lives under `~/.config/`. |
| `~/.local/share/claude/**` | **NO** | Native installer version binaries (leftover data, removed from build) |
| `~/.local/share/uv/**`, `~/.local/bin/uv`, `~/.local/bin/uvx` | **NO** | uv tool venvs and binaries (graphifyy venv ~275MB lives at `/root/.local/share/uv` baked into the image; the user-side mirror is duplicate cruft, regenerable). |
| `~/.claude/context-mode/**` | **NO** | context-mode plugin FTS5 store and per-session SQLite DBs (~255MB on an active session, pure cache, regenerable by re-indexing). |
| `~/.copilot/logs/**`, `~/.copilot/pkg/**` | **NO** | Copilot session logs and auto-update binary |
| `~/.codex/sessions/**`, `~/.codex/log/**`, `~/.codex/tmp/**`, etc. | **NO** | Codex ephemeral session data and caches |
| `~/.codex/skills/.system/**` | **NO** | Codex's bundled system skills (imagegen, plugin-creator, skill-installer) ship inside the codex binary and are re-extracted on launch (`.codex-system-skills.marker` gate). Not codeflare-managed, not user content - same locally-regenerated rationale as `.agents/`. |
| `~/.claude/cache/**`, `~/.claude/debug/**`, `~/.claude/file-history/**`, etc. | **NO** | Claude Code session-specific ephemeral data |
| `~/.claude/projects/**/subagents/**` | **NO** | Subagent transcripts (results captured in main transcript) |
| `~/.claude/usage-data/**`, `~/.claude/backups/**`, `~/.claude/tasks/**` | **NO** | Insights reports, settings backups, task state (all regenerated) |
| `~/.claude/sessions/**`, `~/.claude/history.jsonl` | **NO** | Session metadata, command history (ephemeral) |
| `~/.pi/agent/sessions/**/*.jsonl` | Yes (partial) | Pi session transcripts synced for --resume. Task subdirs (`**/tasks/**`) and context-mode FTS5 store (`~/.pi/context-mode/**`) excluded. `~/.pi/agent/npm/node_modules/` excluded (image-seeded cache, see [container.md](container.md#pi-extension-npm-cache)). |
| `~/.cpan/**` | **NO** | Perl CPAN package manager cache, regenerated |
| `~/.gemini/tmp/**` | **NO** | Legacy no-op filter retained in entrypoint (Gemini CLI agent removed; filter is harmless) |
| `~/.local/share/opencode/log/**`, `opencode.db-shm`, `opencode.db-wal` | **NO** | OpenCode session logs and SQLite temp files |
| `.claude/mcp-*.json` | **NO** | MCP auth cache; created and deleted within milliseconds, listing-then-missing causes bisync fatal errors. Regenerated on every connect. |
| `~/.graphify/**` | **NO** | Per-machine global graph store (absolute paths, machine-specific). Each container builds its own from the per-repo `graphify-out/` artefacts. |
| `**/graphify-out/**` ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | **NO** | Knowledge-graph artifacts live in the repo, not in R2. Repo owners commit `graphify-out/` to git; the working tree gets them on clone. Repos without push permission keep the graph local-only and ephemeral. R2 bisync is not in the graphify persistence path. |
| `Vault/graphify-out/vault-graph.json`, `Vault/graphify-out/graph.html` (advanced mode) | Yes | Exception to the blanket `**/graphify-out/**` exclude. `vault-graph.json` is the cumulative vault graph ([REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions) source of truth - the global graph is rebuilt from it at boot, so it must persist); `graph.html` is the rendered viz. The `VAULT_FILTER` rules for these two precede `+ Vault/**` (rclone first-match), and `- Vault/graphify-out/**` drops the rest (per-run `graph.json`, chunks, `.graphify_labels.json`, `GRAPH_REPORT.md`, `cache/`, `manifest.json`) as derived. |

## rclone Sync Modes (REQ-STOR-003)

| Mode | Workspace Sync | Use Case |
|------|---------------|----------|
| `none` | Excluded entirely | Default. Settings and config only. |
| `full` | Entire `workspace/` (minus `node_modules/`) | Persistent storage across stop/resume |
| `metadata` | Only agent config files (`.claude/` and `CLAUDE.md`) per repo | Lightweight project context sync |

All modes always exclude: `.bashrc`, `.bash_profile`, `.npm/**`, `.bun/**`, `.cache/**`, `.wrangler/**`, `.config/**`, `**/node_modules/**`, `**/graphify-out/**`, `.graphify/**`, `.local/share/claude/**`, `.local/share/uv/**`, `.local/bin/uv`, `.local/bin/uvx`, `.claude/context-mode/**`, `.claude/mcp-*.json`, `.local/state/**`, `.copilot/logs/**`, `.copilot/pkg/**`, `.copilot/session-state/**`, `.codex/sessions/**`, `.codex/state*.sqlite-shm`, `.codex/state*.sqlite-wal`, `.codex/.tmp/**`, `.claude/cache/**`, `.claude/debug/**`, `.claude/file-history/**`, `.claude/plugins/marketplaces/**`, `.claude/projects/**/subagents/**`, `.claude/projects/**/tool-results/**`, `.claude/session-env/**`, `.claude/shell-snapshots/**`, `.claude/stats-cache.json`, `.claude.json.backup.*`, `.claude/usage-data/**`, `.claude/backups/**`, `.claude/tasks/**`, `.claude/sessions/**`, `.claude/history.jsonl`, `.claude/daemon/**`, `.claude/daemon.*`, `.claude/paste-cache/**`, `.claude/jobs/**`, `.claude/*.bak.*`, `.claude/settings.json.bak*`, `.claude/skills.bak.*/**`, `.codex/log/**`, `.codex/models_cache.json`, `.codex/.personality_migration`, `.codex/shell_snapshots/**`, `.codex/tmp/**`, `.codex/version.json`, `.cpan/**`, `.gemini/tmp/**`, `.local/share/opencode/log/**`, `.local/share/opencode/opencode.db-shm`, `.local/share/opencode/opencode.db-wal`, `.pi/agent/sessions/**/tasks/**`, `.pi/context-mode/**`, `.codex/skills/.system/**`. In advanced mode the `VAULT_FILTER` re-includes `Vault/graphify-out/vault-graph.json` and `Vault/graphify-out/graph.html` ahead of `+ Vault/**`, while `- Vault/graphify-out/**` keeps the rest of that directory excluded as derived. The broad `.config/**` exclude subsumes the older specific `.config/rclone/**` and `.config/.wrangler/**` entries; all rclone commands use `--filter` flags (NOT `--include`/`--exclude`). Memory-capture counter files used to live at `~/.memory/counter/**` and required an explicit exclude; they now live at `/tmp/.memory-counter/` which is not synced in the first place (Cloudflare Containers ephemeral disk; see [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages) AC6).

**Note:** The `metadata` mode is defined in `entrypoint.sh` but the Container DO currently only maps `workspaceSyncEnabled` to `full` or `none`. The `metadata` mode can be used by setting `SYNC_MODE` directly in the container environment (see [configuration.md](configuration.md#container-environment) for the env var reference).

**Why `none` is the default.** Workspace directories can be large (gigabytes for compiled projects). Bisyncing the full workspace on every session start adds significant latency and R2 egress cost for content that git already tracks. The recommended pattern for workspace persistence is `git push` before stopping a session and `git clone` on the next. Enable `full` mode only for files that are genuinely hard to reproduce from source: local build artifacts, large datasets, or binary assets not committed to git. See [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers) for the cost-vs-staleness rationale behind the 15-minute cadence.

## Manual Sync Triggers (REQ-STOR-015)

Because the periodic cadence is 15 minutes, one user-driven trigger lets users pull fresh state immediately; a second trigger provides a durability guarantee at shutdown:

1. **Sync-now button** (storage panel toolbar, cloud-download icon). Calls `POST /api/sessions/sync`, which enumerates the authenticated user's running sessions and fans out a per-session bisync trigger with a concurrency cap of 8. Per-session failures are isolated; the response carries `{ sessions: [{ sessionId, status: 'triggered' | 'not-running' | 'failed', error? }], count }` so the UI can show honest aggregate feedback ("Synced N sessions" / "Sync errors" / "No running sessions to sync"). Rate-limited to 6 requests per minute per user. See [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui).
2. **Final sync at shutdown** (durability, not user-driven). Before signalling stop, the Container DO's `destroy()` runs a synchronous drain (`drainFinalSync` → `POST /internal/final-sync`, which triggers the daemon via SIGUSR1) and blocks until that bisync reaches a terminal status, while the container is still fully alive. The DO aborts the drain at its 120-second budget (`FINAL_SYNC_BUDGET_MS`); the host endpoint's own poll cap is held strictly ABOVE that (125s) so the DO's abort — not the host loop — is the authoritative ceiling. An inverted host cap (below the budget) was the bisync-on-delete data-loss root cause and is now guarded against. The DO's teardown hard-cap is 135 seconds (120s drain + 15s clean-exit buffer). The legacy SIGTERM-trap watchdog is no longer the durability mechanism — the platform killed the container within ~3s of stop, never honoring the grace. See [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync) and [REQ-STOR-005](../../sdd/spec/storage.md#req-stor-005-graceful-shutdown-performs-final-sync).

R2 uploads do not auto-fan-out to running containers. The user clicks Sync-now to propagate a freshly uploaded file immediately, or waits for the next 15-minute cycle. The upload-side fire-and-forget trigger was removed: bursting many files at once (e.g., 20-file drag-drop) otherwise enumerated KV and fan-out RPC per file, blowing Worker subrequest budget for a feature that the manual button + cadence already cover.

**Daemon-side mechanism.** Triggers reach the daemon as SIGUSR1, sent by the host's `/internal/bisync-trigger` endpoint (which the Worker hits transparently through the Container DO's existing fetch-forward path). A SIGUSR1 trap inside the daemon subshell toggles two coalescing flags: `BISYNC_REQUESTED=1` (interrupt the current `sleep 900`) or `BISYNC_RERUN_REQUESTED=1` (queue exactly one rerun after the current cycle, if a bisync is mid-flight). N signals during one cycle coalesce to exactly one rerun. See [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui) AC5.

**Fan-out safety.** Parallel bisync across multiple running sessions is safe under the existing `--conflict-resolve newer` semantics: the merge is commutative and associative on absolute mtime, so parallel and serial fan-out produce the same final R2 state per file. R2's S3-compatible atomic per-object writes guarantee no partial-state corruption. The same concurrent mode already runs every 15 minutes for multi-session users; manual triggers introduce no new failure mode. See [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers).

**Hibernation note.** Triggers are best-effort. A SIGUSR1 sent while the container is sleeping never reaches the daemon (the daemon process is dead); the next container wake runs a forced baseline bisync per [REQ-STOR-004](../../sdd/spec/storage.md#req-stor-004-initial-sync-restores-files-on-container-start) AC4, which absorbs any pending trigger. The Sync-now button surfaces hibernated sessions as `'not-running'` in the per-session result so the user gets honest feedback rather than a hang.

## Session Transcript Cleanup

`cleanup_old_transcripts()` runs before each periodic bisync (sequential in the same loop iteration - no concurrent access). Keeps the 5 most recent session transcripts (`.claude/projects/**/*.jsonl` sorted by mtime), deletes older `.jsonl` files only - session directories are left intact so Claude Code can still resolve project paths. Deletions propagate to R2 via bisync automatically. Subagent transcripts are also excluded from bisync entirely (`--filter "- .claude/projects/**/subagents/**"`) since results are captured in the main transcript. `cleanup_old_transcripts()` is wrapped in a subshell with `|| true` so `set -euo pipefail` cannot kill the bisync daemon when cleanup encounters benign non-zero exits (e.g., empty `find` results, `xargs` with no input).

`cleanup_old_pi_transcripts()` runs immediately after the Claude cleanup in the same daemon loop. Same 5-most-recent retention policy, applied to `~/.pi/agent/sessions/**/*.jsonl` (excluding `tasks/` subdirs). Unlike the Claude version, Pi transcript cleanup also deletes the companion `tasks/` subdirectory alongside each removed transcript, since Pi task logs are only meaningful in the context of their parent session. Same subshell + `|| true` error-swallowing pattern.

## Conflict Resolution

Newest file wins (`--conflict-resolve newer`). `--resilient` + `--recover` handle transient bisync failures (e.g., interrupted transfers, listing mismatches) without losing deletion tracking. The sync daemon retries on the next 15-minute cycle after a failure (or sooner if SIGUSR1-triggered via the storage panel). `--max-delete 100` on ALL bisync commands (`establish_bisync_baseline` and `bisync_with_r2`) allows bulk workspace deletions to propagate. Final bisync at shutdown runs via the DO-side synchronous drain (`POST /internal/final-sync`, 120s budget) before stop — not the legacy SIGTERM-trap watchdog (see [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync)). All bisync commands use `--ignore-checksum` to prevent false hash-mismatch aborts - rclone v1.73 introduced stricter post-transfer MD5 verification that fails when files change during sync.

`--check-sync=false` disables rclone's post-sync listing validation on both `establish_bisync_baseline` and `bisync_with_r2`. The validation compares local/remote file listings after sync - if files change on R2 during the sync (e.g., another active session writing), the listings diverge and rclone exits with code 7 (critical abort). This was the most common trigger. With `--check-sync=false`, drift is caught by the next 15-minute cycle (or sooner via Sync-now).

`--retries 3 --retries-sleep 10s` (rclone v1.66+) on both functions adds bisync-level retries for transient R2 API failures. Each bisync invocation retries up to 3 times with 10s sleep between attempts, before the daemon-level retry logic even kicks in.

**Consecutive failure recovery:** The daemon tracks consecutive bisync failures. After 3 consecutive failures (each with 3 internal retries = 9 total attempts), falls back to `establish_bisync_baseline` (which uses `--resync`) to re-establish clean bisync state. `--resync` merges both sides (files present on only one side get copied to the other), so this is a last resort. The counter resets to 0 on any success or after the resync fallback. Resync failures are logged with full command output for diagnostic visibility. The baseline establishment timeout is 600s (10 minutes) to accommodate large initial syncs.

**After consecutive failure recovery:** Transient file errors (encryption mismatch, size mismatch, hash mismatch) are handled by `--resilient` + `--recover` flags and the resync fallback in the daemon. Vanishing-file errors are handled by the per-session recovery filter (see below). A planned `nuke_corrupted_r2_files` function that would scan all R2 objects and delete unrecoverable ones was considered but not implemented; encryption-mismatch orphans from older sessions remain in R2 until manually deleted.

**Bisync exit code handling:** `bisync_with_r2()` uses a temp file approach instead of `| tee` to capture both output and exit code. Piping through `tee` swallows the rclone exit code (the pipe's exit code is `tee`'s, not rclone's), masking bisync failures and breaking error detection in the daemon loop. Both functions redirect with `> "$FILE" 2>&1` (not `2>&1 > "$FILE"`). The old order sent stderr to the parent process's stdout (lost) and only captured stdout in the file. rclone outputs errors and verbose info to stderr, so all diagnostic output was invisible in `/tmp/sync.log`.

**Bisync-initialized flag on timeout:** The bisync-initialized flag (`/tmp/.bisync-initialized`) is now touched on the sync timeout path as well. Previously, if initial sync timed out, the flag was never set, causing the final shutdown sync to be skipped - losing any files created during the session.

### Vanishing-file recovery

When bisync/resync fails because a transient file was listed but deleted before rclone could copy it (error: `failed to open source object: lstat ... no such file or directory`), the system automatically:
1. Parses the rclone error output for the failing file path
2. Adds it to a session-scoped recovery filter at `/tmp/rclone-recovery-filters.txt`
3. Clears stale bisync locks
4. Retries the same operation (up to 3 recovery attempts)

Only non-workspace files are auto-excluded. If the vanishing file is under `workspace/` (user code), the system retries without excluding - the file likely reappeared after a save operation completed. Known ephemeral files (`.claude/mcp-*.json` - MCP auth cache that exists for milliseconds) are statically excluded to prevent the race condition entirely.

The recovery filter file starts empty on every container start and is never synced to R2. All rclone bisync/resync invocations include `--filter-from /tmp/rclone-recovery-filters.txt` in addition to the static filters.

**Daemon always starts:** The bisync daemon starts unconditionally after the baseline attempt - even if all baseline recovery attempts fail. A dead daemon means zero sync for the entire session. The daemon has its own recovery loop (vanishing-file recovery on each cycle + consecutive failure → resync fallback after 3 failures). This ensures sync can recover mid-session even if startup sync was disrupted.

---

## Troubleshooting

- **Storage panel doesn't show a file I just created in the terminal**: The periodic bisync runs every 15 minutes (see [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers)). Click the **Sync-now** button (cloud-sync icon in the storage panel toolbar) to trigger an immediate bisync across all your running sessions. Status surfaces in the button tooltip ("Synced N sessions" / "No running sessions to sync" / "Sync errors"). If a session shows as `'not-running'`, its container is hibernated; the next time you open that tab the container's wake-time baseline bisync will pull fresh state from R2.
- **Bisync empty listing**: Initial `establish_bisync_baseline()` uses `--resync` to create the baseline, handles this case. The periodic daemon never uses `--resync` (see [AD14](../decisions/README.md#ad14-never-auto---resync-on-bisync-failure)).
- **`lstat: no such file or directory` bisync failure**: A transient file was listed by rclone then deleted before the copy completed. Automatically recovered: the system parses the error, adds the file to `/tmp/rclone-recovery-filters.txt`, clears bisync locks, and retries (max 3 attempts). Check `/tmp/sync.log` for `[sync-recovery] Excluded vanished file:` entries. If the failure persists beyond 3 attempts, it escalates to the normal consecutive-failure path. See [Vanishing-file recovery](#vanishing-file-recovery) and [AD43](../decisions/README.md#ad43-parse-and-exclude-vanishing-files-before-escalating-to-nuke).
- **Transfers 0 files**: Filter order indeterminacy from mixed `--include`/`--exclude`. Use `--filter` flags instead.
- **Slow sync**: Switch to `SYNC_MODE=metadata` or manually clean large repos from R2.
- **Missing secrets**: Check `startup-status` response `details.syncError` for the missing variable.
- **Session-delete spinner takes ~2 minutes**: The Container DO `destroy()` budget is 135 seconds (120s DO-side final-bisync drain budget + 15s clean-exit buffer) — the DO drains the bisync synchronously (`POST /internal/final-sync`) before signalling stop, so unsaved local changes propagate to R2 before SIGKILL. Routine on sessions with large pending writes. See [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync).
- **Search button is missing from the storage panel**: Removed 2026-05-18 (sync-v2). The toolbar slot is now the Sync-now button. The underlying search-by-name filter (`storageStore.searchFiles`) is still in the codebase and can be restored by re-adding `<SearchInput />` in the toolbar - see comments in `web-ui/src/components/storage/StorageToolbar.tsx` and `web-ui/src/components/StorageBrowser.tsx`.

---

## Specification Coverage

- [REQ-STOR-002](../../sdd/spec/storage.md#req-stor-002-file-persistence-across-sessions) - File Persistence Across Sessions
- [REQ-STOR-004](../../sdd/spec/storage.md#req-stor-004-initial-sync-restores-files-on-container-start) - Initial Sync Restores Files on Container Start
- [REQ-STOR-005](../../sdd/spec/storage.md#req-stor-005-graceful-shutdown-performs-final-sync) - Graceful Shutdown Performs Final Sync
- [REQ-STOR-010](../../sdd/spec/storage.md#req-stor-010-agent-configs-auto-seeded-based-on-session-mode) - Agent Configs Auto-Seeded Based on Session Mode
- [REQ-STOR-011](../../sdd/spec/storage.md#req-stor-011-sync-mode-controls-workspace-scope) - Sync Mode Controls Workspace Scope
- [REQ-STOR-012](../../sdd/spec/storage.md#req-stor-012-session-transcript-cleanup) - Session Transcript Cleanup
- [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui) - Explicit Sync Trigger from UI
- [REQ-STOR-016](../../sdd/spec/storage.md#req-stor-016-file-browser-presentation-and-traversal-safety) - File browser presentation and traversal safety

---

## Related Documentation
- [Architecture](architecture.md#container-do-container) - Container DO lifecycle
- [Container](container.md#container-startup) - Startup sync sequence
- [Memory](vault.md#memory-capture-system) - Memory file sync and cleanup
- [Configuration](configuration.md#container-environment) - Sync environment variables
- [Troubleshooting](troubleshooting.md#r2-sync-issues) - Sync troubleshooting
