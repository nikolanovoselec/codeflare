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
- [File Browser (REQ-STOR-016)](#file-browser-req-stor-016)

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
| `~/.copilot/logs/**`, `~/.copilot/pkg/**`, `~/.copilot/*.db-{wal,shm}` | **NO** | Copilot logs, auto-update binary, and ephemeral SQLite companions |
| `~/.codex/sessions/**`, `~/.codex/plugins/cache/**`, `~/.codex/cache/**`, `~/.codex/logs*.sqlite*`, `~/.codex/log/**`, `~/.codex/tmp/**`, etc. | **NO** | Codex session data, regenerated plugin/app caches, and log databases |
| `~/.codex/skills/.system/**` | **NO** | Codex's bundled system skills (imagegen, plugin-creator, skill-installer) ship inside the codex binary and are re-extracted on launch (`.codex-system-skills.marker` gate). Not codeflare-managed, not user content - same locally-regenerated rationale as `.agents/`. |
| `~/.claude/cache/**`, `~/.claude/debug/**`, `~/.claude/file-history/**`, etc. | **NO** | Claude Code session-specific ephemeral data |
| `~/.claude/projects/**/subagents/**`, `tool-results/**`, `workflows/**` | **NO** | Subagent transcripts, tool artifacts, and per-session workflow state; all are captured or regenerated elsewhere |
| `~/.claude/usage-data/**`, `~/.claude/backups/**`, `~/.claude/tasks/**` | **NO** | Insights reports, settings backups, task state (all regenerated) |
| `~/.claude/sessions/**`, `~/.claude/history.jsonl` | **NO** | Session metadata, command history (ephemeral) |
| `~/.pi/agent/sessions/**/*.jsonl` | Yes (partial) | Pi session transcripts synced for --resume. Task subdirs (`**/tasks/**`) and context-mode FTS5 store (`~/.pi/context-mode/**`) excluded. `~/.pi/agent/npm/node_modules/` excluded (image-seeded cache, see [container.md](container.md#pi-extension-npm-cache)). |
| `~/.cpan/**` | **NO** | Perl CPAN package manager cache, regenerated |
| `~/.gemini/tmp/**` | **NO** | Legacy no-op filter retained in entrypoint (Gemini CLI agent removed; filter is harmless) |
| `~/.local/share/opencode/log/**`, `opencode.db-shm`, `opencode.db-wal` | **NO** | OpenCode session logs and SQLite temp files |
| `.claude/mcp-*.json` | **NO** | MCP auth cache; created and deleted within milliseconds, listing-then-missing causes bisync fatal errors. Regenerated on every connect. |
| `~/.graphify/**` | **NO** | Per-machine global graph store (absolute paths, machine-specific). Each container builds its own from the per-repo `graphify-out/` artefacts. |
| `**/graphify-out/**` ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | **NO** | Knowledge-graph artifacts live in the repo, not in R2. Repo owners commit `graphify-out/` to git; the working tree gets them on clone. Repos without push permission keep the graph local-only and ephemeral. R2 bisync is not in the graphify persistence path. |
| `Vault/graphify-out/vault-graph.json`, `Vault/graphify-out/vault-extract-manifest.json` (advanced mode) | Yes | Cumulative graph source and committed extraction high-water mark persist despite the blanket graphify exclude. |
| `Vault/graphify-out/vault-extract-manifest.*.pending.json`, `.graphify_chunk_*.json` | **NO** | Pi request-specific staging/chunks are ephemeral; only hash-validated success promotes the canonical manifest. |
| `Vault/graphify-out/graph.html` | **NO** | Derived visualization; the served durable copy is `Vault/Raw/Graphs/vault-graph.html`. |

`vault-graph.json` is the [REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions) source of truth; the global graph is rebuilt from it at boot. The extraction manifest prevents a restored vault from being reprocessed wholesale.

The two durable `VAULT_FILTER` allow-rules precede `+ Vault/**` because rclone uses first-match semantics. `- Vault/graphify-out/**` drops derived output: `graph.json`, `graph.html`, chunks, `.graphify_labels.json`, `GRAPH_REPORT.md`, cache, and Graphify's own manifest. The published visualization remains under `Vault/Raw/Graphs/`.

## rclone Sync Modes (REQ-STOR-003)

| Mode | Workspace Sync | Use Case |
|------|---------------|----------|
| `none` | Excluded entirely | Default. Settings and config only. |
| `full` | Entire `workspace/` (minus `node_modules/`) | Persistent storage across stop/resume |
| `metadata` | Only agent config files (`.claude/` and `CLAUDE.md`) per repo | Lightweight project context sync |

All modes always exclude these groups:

- Shell/runtime caches: `.bashrc`, `.bash_profile`, `.npm/**`, `.bun/**`, `.cache/**`, `.wrangler/**`, `.config/**`, `.local/state/**`, `.cpan/**`.
- Dependency and graph caches: `**/node_modules/**`, `**/graphify-out/**`, `.graphify/**`, `.claude/context-mode/**`, `.pi/context-mode/**`.
- Local tool stores: `.local/share/claude/**`, `.local/share/uv/**`, `.local/bin/uv`, `.local/bin/uvx`, `.claude/mcp-*.json`.
- Copilot/OpenCode/Gemini state: `.copilot/logs/**`, `.copilot/pkg/**`, `.copilot/session-state/**`, `.copilot/*.db-wal`, `.copilot/*.db-shm`, `.gemini/tmp/**`, `.local/share/opencode/log/**`, `.local/share/opencode/opencode.db-shm`, `.local/share/opencode/opencode.db-wal`.
- Codex volatile state: `.codex/sessions/**`, `.codex/plugins/cache/**`, `.codex/cache/**`, `.codex/logs*.sqlite*`, `.codex/state*.sqlite-shm`, `.codex/state*.sqlite-wal`, `.codex/.tmp/**`, `.codex/log/**`, `.codex/models_cache.json`, `.codex/.personality_migration`, `.codex/shell-snapshots/**`, `.codex/tmp/**`, `.codex/version.json`, `.codex/skills/.system/**`.
- Claude volatile state: `.claude/cache/**`, `.claude/debug/**`, `.claude/file-history/**`, `.claude/plugins/marketplaces/**`, `.claude/projects/**/subagents/**`, `.claude/projects/**/tool-results/**`, `.claude/projects/**/workflows/**`, `.claude/session-env/**`.
- More Claude volatile state: `.claude/shell-snapshots/**`, `.claude/stats-cache.json`, `.claude.json.backup.*`, `.claude/usage-data/**`, `.claude/backups/**`, `.claude/tasks/**`, `.claude/sessions/**`, `.claude/history.jsonl`, `.claude/daemon/**`, `.claude/daemon.*`, `.claude/paste-cache/**`, `.claude/jobs/**`, `.claude/*.bak.*`, `.claude/settings.json.bak*`, `.claude/skills.bak.*/**`.
- Pi task transcripts: `.pi/agent/sessions/**/tasks/**`.

In advanced mode the `VAULT_FILTER` re-includes `Vault/graphify-out/vault-graph.json` and the canonical `Vault/graphify-out/vault-extract-manifest.json` ahead of `+ Vault/**`; `- Vault/graphify-out/**` excludes derived HTML, request-specific pending manifests/chunks, and other generated output. Pi promotes staged bytes to the canonical manifest only after exact native success, so a crash or R2 sync cannot persist uncommitted high-water state ([REQ-VAULT-026](../../sdd/spec/vault.md#req-vault-026-vault-extract-change-detection-survives-container-restart-content-hash-manifest), [REQ-VAULT-027](../../sdd/spec/vault.md#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional)).

The broad `.config/**` exclude subsumes older specific `.config/rclone/**` and `.config/.wrangler/**` entries. All rclone commands use `--filter` flags, not `--include`/`--exclude`.

Memory-capture counter files used to live at `~/.memory/counter/**` and required an explicit exclude. They now live at `/tmp/.memory-counter/`, which is not synced because Cloudflare Containers use ephemeral disk; see [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages) AC6.

**Note:** The `metadata` mode is defined in `entrypoint.sh` but the Container DO currently only maps `workspaceSyncEnabled` to `full` or `none`. The `metadata` mode can be used by setting `SYNC_MODE` directly in the container environment (see [configuration.md](configuration.md#container-environment) for the env var reference).

**Why `none` is the default.** Workspace directories can be large (gigabytes for compiled projects). Bisyncing the full workspace on every session start adds significant latency and R2 egress cost for content that git already tracks. The recommended pattern for workspace persistence is `git push` before stopping a session and `git clone` on the next. Enable `full` mode only for files that are genuinely hard to reproduce from source: local build artifacts, large datasets, or binary assets not committed to git. See [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers) for the cost-vs-staleness rationale behind the 15-minute cadence.

## Manual Sync Triggers (REQ-STOR-015)

Because the periodic cadence is 15 minutes, one user-driven trigger lets users pull fresh state immediately; a second trigger provides a durability guarantee at shutdown:

1. **Sync-now button**

     (storage panel toolbar, cloud-download icon). Calls `POST /api/sessions/sync`, which enumerates the authenticated user's running sessions and fans out a per-session bisync trigger with a concurrency cap of 8. Per-session failures are isolated; the response carries `{ sessions: [{ sessionId, status: 'triggered' | 'not-running' | 'failed', error? }], count }` so the UI can show honest aggregate feedback ("Synced N sessions" / "Sync errors" / "No running sessions to sync"). Rate-limited to 6 requests per minute per user. See [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui).
2. **Final sync at shutdown**

     (durability, not user-driven). Before signalling stop, the Container DO's `destroy()` runs a synchronous drain (`drainFinalSync` → `POST /internal/final-sync`, which triggers the daemon via SIGUSR1) and blocks until that bisync reaches a terminal status, while the container is still fully alive. The DO aborts the drain at its 120-second budget (`FINAL_SYNC_BUDGET_MS`); the host endpoint's own poll cap is held strictly ABOVE that (125s) so the DO's abort — not the host loop — is the authoritative ceiling. An inverted host cap (below the budget) was the bisync-on-delete data-loss root cause and is now guarded against. The DO's teardown hard-cap is 135 seconds (120s drain + 15s clean-exit buffer).

     The legacy SIGTERM-trap watchdog is no longer the durability mechanism — the platform killed the container within ~3s of stop, never honoring the grace. See [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync) and [REQ-STOR-005](../../sdd/spec/storage.md#req-stor-005-graceful-shutdown-performs-final-sync).

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

- **Storage panel doesn't show a file I just created in the terminal**

    The periodic bisync runs every 15 minutes (see [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers)). Click the **Sync-now** button (cloud-sync icon in the storage panel toolbar) to trigger an immediate bisync across all your running sessions. Status surfaces in the button tooltip ("Synced N sessions" / "No running sessions to sync" / "Sync errors"). If a session shows as `'not-running'`, its container is hibernated; the next time you open that tab the container's wake-time baseline bisync will pull fresh state from R2.
- **Bisync empty listing**: Initial `establish_bisync_baseline()` uses `--resync` to create the baseline, handles this case. The periodic daemon never uses `--resync` (see [AD14](../decisions/README.md#ad14-never-auto---resync-on-bisync-failure)).
- **`lstat: no such file or directory` bisync failure**

    A transient file was listed by rclone then deleted before the copy completed. Automatically recovered: the system parses the error, adds the file to `/tmp/rclone-recovery-filters.txt`, clears bisync locks, and retries (max 3 attempts). Check `/tmp/sync.log` for `[sync-recovery] Excluded vanished file:` entries. If the failure persists beyond 3 attempts, it escalates to the normal consecutive-failure path. See [Vanishing-file recovery](#vanishing-file-recovery) and [AD43](../decisions/README.md#ad43-parse-and-exclude-vanishing-files-before-escalating-to-nuke).
- **Transfers 0 files**: Filter order indeterminacy from mixed `--include`/`--exclude`. Use `--filter` flags instead.
- **Slow sync**: Switch to `SYNC_MODE=metadata` or manually clean large repos from R2.
- **Missing secrets**: Check `startup-status` response `details.syncError` for the missing variable.
- **Session-delete spinner takes ~2 minutes**

    The Container DO `destroy()` budget is 135 seconds (120s DO-side final-bisync drain budget + 15s clean-exit buffer) — the DO drains the bisync synchronously (`POST /internal/final-sync`) before signalling stop, so unsaved local changes propagate to R2 before SIGKILL. Routine on sessions with large pending writes. See [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync).
- **Search button is missing from the storage panel**

    Removed 2026-05-18 (sync-v2). The toolbar slot is now the Sync-now button. The underlying search-by-name filter (`storageStore.searchFiles`) is still in the codebase and can be restored by re-adding `<SearchInput />` in the toolbar - see comments in `web-ui/src/components/storage/StorageToolbar.tsx` and `web-ui/src/components/StorageBrowser.tsx`.

---

## File Browser (REQ-STOR-016)

The storage browser reads directly from R2 via the Worker API (not the container
filesystem) and renders as a side drawer on desktop, a bottom-sheet on mobile.

**Folder paths.** Because rclone bisyncs the whole `/home/user` home directory to the bucket root, every folder maps to a real in-container directory. Each folder row shows that path in `~/<prefix>` form (`web-ui/src/components/storage/FileList.tsx::folderShortPath`) so operators can see where a prefix lands in the container — at any depth (`Documentation/guides/` → `~/Documentation/guides`) and for dotfolders (`.claude/` → `~/.claude`). Special folders (Vault, Uploads, Temporary, Workspace) instead show their canonical `containerPath` mapping, whose casing can differ from the R2 prefix (`workspace/` → `~/Workspace`).

Within a row the path is pinned to the right edge for every folder so all paths align identically; the special-folder container icon (a tooltip toggle) sits immediately after the folder name rather than trailing the row (`web-ui/src/components/storage/FileList.tsx`, `web-ui/src/styles/storage-browser.css`).

Clicking a file opens it inline in a new browser tab (served with an XSS-safe
Content-Type + `nosniff`) rather than downloading it.

**Append-only pagination.** The Worker already returns R2's continuation token and defaults each browser request to a 200-object page. While a page is truncated, the list keeps a visible continuation action available even when its content is too short to scroll; reaching the real `.storage-drop-zone` bottom invokes the same action automatically. The store requests one continuation at a time and appends only unseen object keys/prefixes in response order. A browse generation and prefix snapshot reject late success/failure from older navigation; continuation failure leaves existing rows and the token intact for explicit retry. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @impl: web-ui/src/components/storage/FileList.tsx::FileList -->

The first continuation attempt sets a sticky `paginationStarted` flag for that page-one generation, including on failure. The 30-second timer then stops replacing the accumulated listing but continues refreshing quota/statistics; explicit navigation/manual refresh starts a new generation and resets pagination state. The footer reuses the existing spinner and shows a local retry action without hiding loaded rows. <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser -->

**Traversal safety.** The browse endpoint (`src/routes/storage/validation.ts::validateKey`)
validates every requested prefix and rejects parent-directory (`../`) references, so a
probe cannot escape the user's bucket root — a rejected prefix causes the endpoint to
return an error response (4xx) rather than any listing.

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

## Startup & steady-state sync performance

Six startup costs and stale-state risks are controlled (REQ-STOR-017):

- **Bisync compares via server-modtime (AD88, all modes).**

    Both `rclone bisync` invocations in `entrypoint.sh` (the retrying `--resync` baseline and steady-state cycle) pass `--use-server-modtime` and `--checkers 64`. `--use-server-modtime` compares the `LastModified` already returned by the bulk `--fast-list` instead of issuing one mtime HEAD per object, eliminating the per-cycle HEAD storm (the dominant steady-state cost). This is sound under codeflare's newest-wins bisync because the bucket is the per-user source of truth and absolute upload order is the conflict key.
- **Governed Mode delta initial sync (AD90, Governed Mode only).**

    The blocking `initial_sync_from_r2` normally re-downloads the whole agent seed (~627 files, ~9 MB) every boot because the container filesystem is ephemeral. In [Governed Mode](#governed-mode-r2-sse-c-disabled) the entrypoint lays the image-baked seed (see [Preseed](preseed.md)) into the user home first, then runs the initial sync with `--checksum` (usable MD5 ETags, available only when SSE-C is off), so the unchanged seed files are skipped and only user deltas transfer. Under SSE-C (the default) the path is unchanged: `--size-only`, no lay-down.
- **Managed Pi extension relay (all modes).**

    Before the bisync `--resync` baseline, `entrypoint.sh` calls `relay_managed_pi_extensions()` to re-lay the image-baked managed Pi extension bytes over the post-sync `~/.pi/agent/extensions/` tree. This keeps the on-disk bytes equal to the build — the content precondition for the path-sensitive jiti prewarm cache (see [Container lane](container.md#pi-extension-jiti-transpile-cache-warm-up-ad79)) to hit at runtime. Without it, a stale bucket copy of a managed extension (faithfully restored by sync) hashes differently and costs ~2.4s of cold transpile every session. Only managed (codeflare-owned) filenames are overwritten; user-added extensions are preserved.
- **Retired review paths are excluded from R2 (all modes).**

    The common rclone filter excludes the exact managed paths `.pi/agent/extensions/review-job-helpers.ts`, `review-jobs.ts`, and `review-lane-guards.ts`. Initial restore, the retrying baseline, and steady-state bisync all consume the common filter, so stale bucket objects cannot restore retired review machinery.
- **Retired local copies are pruned before Pi loads (all modes).**

    `relay_managed_pi_extensions()` removes those same three exact local files before laying down current managed bytes. The pruning list is exact: unrelated user-added extensions remain untouched.
- **Background init deprioritization (all modes).**

    The background subshell running the bisync `--resync` baseline, vault seed, and sync/vault daemons runs at `nice 19` / `ionice -c 3` (idle I/O class), yielding the single vCPU and disk to the concurrent pi PTY pre-warm — whose latency was dominated by contention with the baseline, not by the baseline's own work.

## Governed Mode (R2 SSE-C disabled)

When an enterprise admin enables [Governed Mode](configuration.md#governed-mode-r2-sse-c-disable), R2 SSE-C is disabled deployment-wide so the corporate bucket is readable/scannable. Each bucket's actual encryption regime + any in-flight migration is tracked by a per-bucket **state object** (`r2-regime:<bucket>` — `{status: ready|migrating|mixed-recovery, regime, from?, to?, generation, cursor?, phase?, drained?, leaseExpiresAt?, keyMd5?, stuckCount?, lastFailedKey?}`; it replaced the old boolean `UserPreferences.r2SseRegime` marker, a boolean being unable to describe a partially in-place-migrated bucket). Flipping the policy losslessly re-encrypts the bucket in place — a same-key server-side `CopyObject` with `MetadataDirective=REPLACE` (never a nuke) — driven in resumable chunks by the dashboard `batch-status` poll, with the regime committed only after a full verification HEAD-scan.

While a bucket migrates, running containers are drained (best-effort — a drain failure leaves a brief stray-write window, caught by the verification rescan + read self-heal), every R2 writer is gated `409 BUCKET_MIGRATING`, and reads use a dual-regime fallback (a stray cross-regime object self-heals via a `mixed-recovery` scan). Session start never migrates, so session creation is never blocked. Sync behaviour follows the committed regime: rclone drops the SSE-C block from `rclone.conf` and compares by checksum once the bucket is plain. See [AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile) (migration mechanics; supersedes [AD89](../decisions/README.md#ad89-governed-mode-deployment-wide-r2-sse-c-disable-via-a-kv-toggle-with-lossless-in-place-re-encrypt-migration)) and the [Deployment lane](deployment.md#governed-mode-migration-batch-status-driven).

---

## Related Documentation
- [Architecture](architecture.md#container-do-container) - Container DO lifecycle
- [Container](container.md#container-startup) - Startup sync sequence
- [Memory](vault.md#memory-capture-system) - Memory file sync and cleanup
- [Configuration](configuration.md#container-environment) - Sync environment variables
- [Troubleshooting](troubleshooting.md#r2-sync-issues) - Sync troubleshooting
