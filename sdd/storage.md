# Storage Domain Specification

R2 persistence, rclone bisync, quotas, and file browser.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| R2 Bucket | Per-user Cloudflare R2 storage bucket, named deterministically from user email, providing isolated durable file storage |
| Bisync | Bidirectional rclone sync that reconciles local filesystem and R2 every 60 seconds, using newest-file-wins conflict resolution |
| Sync Mode | User-configurable scope of what gets synced: `none` (configs only), `full` (entire workspace), or `metadata` (agent configs per repo) |
| Storage Quota | Per-tier limit on total R2 usage (`maxStorageBytes`), enforced at session start, cached in KV with 60-second TTL |

### Out of Scope

- **Version history** -- R2 stores current file state only. No file versioning, rollback to previous revisions, or change tracking within storage.
- **File collaboration** -- Storage is single-user. No shared buckets, shared folders, or multi-user access to the same R2 prefix.
- **Real-time file sync** -- Bisync runs on a 60-second interval. Sub-second or event-driven sync between browser and container is not supported.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Session Lifecycle | Container start triggers initial R2 sync and mounts the user's bucket; container stop triggers final sync |
| Subscription | Tier config provides `maxStorageBytes` for quota enforcement at session start |
| Security | SSE-C encryption of R2 objects when `ENCRYPTION_KEY` is configured; scoped R2 tokens per user |

---

## REQ-STOR-001: Dedicated Per-User R2 Bucket

**Intent:** Each authenticated user must have an isolated R2 bucket so that one user's files are never accessible to another user.

**Acceptance Criteria:**
1. Bucket name is derived deterministically from the user's email (sanitized, max 63 characters).
2. Bucket is auto-created via Cloudflare API on first container start if it does not already exist.
3. No API endpoint returns objects from a bucket the authenticated user does not own.

**Constraints:**
- Bucket naming must comply with S3/R2 naming rules (lowercase, no special characters beyond hyphens).
- `createBucketIfNotExists` must be idempotent (no error on duplicate).

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test

**Status:** Implemented

---

## REQ-STOR-002: File Persistence Across Sessions

**Intent:** User files must survive container destruction and be available when a new session starts, because containers are ephemeral.

**Acceptance Criteria:**
1. Files written during session N are readable in session N+1 after the container is recreated.
2. Agent configuration files (`.claude/`, `.config/`, `.gitconfig`) persist across sessions.
3. Workspace files persist when workspace sync is enabled (`SYNC_MODE=full`).

**Constraints:**
- R2 is the durable store; the local filesystem is ephemeral.
- Persistence depends on at least one successful sync completing before container shutdown.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-STOR-001
**Verification:** Integration test

**Status:** Implemented

---

## REQ-STOR-003: Bidirectional Sync Every 60 Seconds

**Intent:** Changes made locally (by the agent or user) and changes in R2 (from the file browser or another session's sync) must converge within a bounded interval.

**Acceptance Criteria:**
1. After bisync baseline is established, a periodic rclone bisync runs every 60 seconds.
2. Conflict resolution uses newest-file-wins (`--conflict-resolve newer`).
3. The daemon retries on transient failure and continues the 60-second cycle.
4. On bisync failure, the daemon attempts vanishing-file recovery (parse error output, exclude transient files, clear locks, retry) before counting the failure.
5. After 3 consecutive unrecoverable failures (each with 3 internal retries), the daemon falls back to a `--resync` baseline to re-establish clean state.

**Constraints:**
- All bisync commands must use `--ignore-checksum` to prevent false hash-mismatch aborts from files changing mid-transfer.
- `--max-delete 100` must be set to allow bulk workspace deletions to propagate.
- `--check-sync=false` must be set to prevent post-sync listing validation failures when R2 changes during sync.
- `--min-size 1B` must exclude 0-byte files (R2 SSE-C fails on empty objects).

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-STOR-001, REQ-STOR-004
**Verification:** Integration test

**Status:** Implemented

---

## REQ-STOR-004: Initial Sync Restores Files on Container Start

**Intent:** When a container boots, it must restore the user's persisted files from R2 before the agent or terminal becomes usable.

**Acceptance Criteria:**
1. A one-way `rclone sync` from R2 to local runs as the first startup step (blocking).
2. The sync completes or times out within 120 seconds (`SYNC_TIMEOUT`).
3. All file modifications (`.claude.json`, `.gemini/settings.json`, `.codex/version.json`, tab autostart) complete after the initial sync but before bisync baseline, to avoid hash mismatches.
4. A bisync baseline (`--resync`) is established after file modifications complete.
5. If the initial baseline fails due to a vanishing file (file listed but deleted before copy), the system parses the error output, adds the file to a session-scoped recovery filter (`/tmp/rclone-recovery-filters.txt`), and retries (max 3 attempts). Only non-workspace files are auto-excluded; workspace files trigger a plain retry.
6. Known ephemeral files (`.claude/mcp-*.json`) are statically excluded from all sync operations.
7. The bisync daemon starts unconditionally after baseline — even if all baseline attempts fail. A dead daemon means zero sync for the entire session; the daemon has its own recovery (vanishing-file recovery + consecutive failure → resync fallback).

**Constraints:**
- Container must not serve terminal connections until the initial sync either succeeds or times out.
- The bisync-initialized flag (`/tmp/.bisync-initialized`) must be set even on the timeout path to prevent the shutdown trap from skipping the final sync.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-STOR-001
**Verification:** Integration test

**Status:** Implemented

---

## REQ-STOR-005: Graceful Shutdown Performs Final Sync

**Intent:** When a container is stopped or evicted, unsaved local changes must be pushed to R2 before the process exits.

**Acceptance Criteria:**
1. A SIGINT/SIGTERM handler triggers a final bisync before exit.
2. The final bisync only runs if the bisync-initialized flag is set.
3. Files created during the session are available in R2 after shutdown completes.

**Constraints:**
- The shutdown handler must complete within the container runtime's grace period.
- Final bisync uses the same flags as periodic bisync (`--ignore-checksum`, `--max-delete 100`, `--check-sync=false`).

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-STOR-003
**Verification:** Integration test

**Status:** Implemented

---

## REQ-STOR-006: Storage Quota Enforced Per Tier at Session Start

**Intent:** Users must not be able to start new sessions when their storage usage exceeds their tier's quota, preventing unbounded R2 consumption.

**Acceptance Criteria:**
1. Session creation (`POST /api/sessions`) reads `storage-stats:{bucketName}` from KV and compares `totalSizeBytes` against the user's `maxStorageBytes` tier config value.
2. If usage exceeds quota, session creation is rejected with a clear error message.
3. `GET /api/storage/stats` returns both current usage and `maxStorageBytes` so the frontend can display "X / Y".
4. A `null` value for `maxStorageBytes` means unlimited (no enforcement).
5. Tier config changes backfill from defaults when the field did not exist in previously saved KV data (`{ ...default, ...stored }` merge).

**Constraints:**
- Quota is checked only at session start; individual file uploads, rclone sync writes, and preseed writes are not blocked mid-session.
- Users can temporarily exceed quota during an active session; overage is caught on the next session start attempt.
- Stats are cached in KV with 60-second TTL; the quota value is embedded in the cache so cache hits skip tier config resolution.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-001, REQ-STOR-014
**Verification:** Automated test

**Status:** Implemented

---

## REQ-STOR-007: Web File Browser

**Intent:** Users must be able to browse, upload, download, delete, and preview files in their R2 storage without using the terminal.

**Acceptance Criteria:**
1. `GET /api/storage/browse` lists objects in a given R2 prefix with directory-style navigation.
2. `POST /api/storage/upload` uploads a file to a specified R2 key.
3. `GET /api/storage/download` returns a file's contents with `Content-Disposition: attachment` and sanitized filename.
4. `POST /api/storage/delete` deletes objects by key and/or prefix (server-side bulk delete).
5. `GET /api/storage/preview` returns file content for text files inline and metadata for other types.
6. The frontend renders as a 400px slide-in drawer on desktop and a bottom-sheet on mobile.
7. The file browser reads directly from R2 via Worker API (not from the container filesystem).
8. Browse endpoint validates prefix against directory traversal (`..` rejection).

**Constraints:**
- All R2 operations use SSE-C headers when `ENCRYPTION_KEY` is set.
- Each endpoint has its own rate limit (browse: 30/min, upload: 60/min, download: 120/min, preview: 120/min).
- The file browser and settings panel are mutually exclusive in the UI.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-STOR-001
**Verification:** Automated test

**Status:** Implemented

---

## REQ-STOR-008: Multipart Upload for Large Files

**Intent:** Files larger than the single-request upload limit must be uploadable via chunked multipart upload.

**Acceptance Criteria:**
1. `POST /api/storage/upload/initiate` creates a multipart upload and returns an upload ID.
2. `POST /api/storage/upload/part` uploads a single part (base64 body) for a given upload ID.
3. `POST /api/storage/upload/complete` finalizes the multipart upload, assembling parts into the final object.
4. `POST /api/storage/upload/abort` cancels an in-progress multipart upload.
5. All multipart upload endpoints share the upload rate limit (60/min).

**Constraints:**
- Each part must include SSE-C headers when encryption is enabled.
- The upload endpoints are exempt from the 64 KiB body size limit applied to other API routes.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-STOR-007
**Verification:** Integration test

**Status:** Implemented

---

## REQ-STOR-009: Getting-Started Docs Auto-Seeded on First Session

**Intent:** New users must find starter documentation in their storage on first use so they have immediate orientation material.

**Acceptance Criteria:**
1. When a user's R2 bucket is created for the first time, tutorial documents are written to the bucket root.
2. `POST /api/storage/seed/getting-started` allows manual re-seeding with `overwrite: true`.
3. After seeding, the `storage-stats:{bucketName}` KV cache is invalidated so the next poll returns fresh data.
4. The seed endpoint is rate-limited (3/min).

**Constraints:**
- Seeding must be idempotent when called with `overwrite: false` (skip files that already exist).
- Tutorial source content is maintained in `tutorials/` directory.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-STOR-001
**Verification:** Automated test

**Status:** Implemented

---

## REQ-STOR-010: Agent Configs Auto-Seeded Based on Session Mode

**Intent:** Each user's R2 bucket must contain the correct agent configuration files for their session mode (Standard or Pro) so that agents start with the right rules, skills, and tools.

**Acceptance Criteria:**
1. On first bucket creation, `reconcileAgentConfigs(mode, { overwrite: false, cleanup: false })` writes mode-appropriate preseed files to R2.
2. `POST /api/storage/seed/agent-configs` triggers `reconcileAgentConfigs(mode, { overwrite: true, cleanup: true })`, overwriting existing configs and deleting files not in the current mode.
3. Cleanup is strictly scoped to keys from `AGENTS_SEEDED_CONFIGS`; user-created files are never deleted.
4. Variant-per-mode keys (instruction files with different content per mode) are excluded from deletion by `getPreseedKeysNotInMode()`.
5. Partial delete failures produce warnings but do not fail the overall operation.
6. Pro mode seeds a strict superset of Standard's preseed files (Pro adds the memory plugin, agent definitions, hooks, slash commands, the discipline triad rules, and additional skills).

**Constraints:**
- Mode takes effect only on explicit "Recreate AI agent skills & rules" or new bucket creation; existing users keep current files until they recreate.
- No duplicate preseed source files exist on disk; all agent variants are generated from the Claude Code preseed as single source of truth.
- `getConfigsForMode()` must validate no duplicate keys within a single mode.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-AGENT-006, REQ-STOR-001
**Verification:** Automated test

**Status:** Implemented

---

## REQ-STOR-011: Sync Mode Controls Workspace Scope

**Intent:** Users must be able to choose how much of their workspace is synced to R2, balancing persistence against sync overhead.

**Acceptance Criteria:**
1. `SYNC_MODE=none` (default): only settings and config directories are synced; `~/workspace/` is excluded entirely.
2. `SYNC_MODE=full`: entire `~/workspace/` is synced (minus `node_modules/`).
3. `SYNC_MODE=metadata`: only agent config files (`.claude/` and `CLAUDE.md`) per repo are synced.
4. All modes exclude: package manager caches, rclone caches, agent session logs, ephemeral agent data, and build artifacts.

**Constraints:**
- All rclone commands must use `--filter` flags (not `--include`/`--exclude`).
- The Container DO currently only maps `workspaceSyncEnabled` to `full` or `none`; `metadata` requires setting `SYNC_MODE` directly.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-STOR-003
**Verification:** Manual check

**Status:** Implemented

---

## REQ-STOR-012: Session Transcript Cleanup

**Intent:** Old session transcripts must be pruned to prevent unbounded R2 growth from long-lived users.

**Acceptance Criteria:**
1. Before each periodic bisync, `cleanup_old_transcripts()` runs (sequential, no concurrent access).
2. The 5 most recent session transcripts (`.claude/projects/**/*.jsonl` by mtime) are retained; older `.jsonl` files are deleted.
3. Session directories are left intact so Claude Code can still resolve project paths.
4. Deletions propagate to R2 via bisync automatically.
5. Subagent transcripts are excluded from bisync entirely.

**Constraints:**
- Cleanup functions are wrapped in subshells with `|| true` to prevent `set -euo pipefail` from killing the bisync daemon on benign non-zero exits.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-STOR-003
**Verification:** Automated test

**Status:** Implemented

---

## REQ-STOR-013: Self-Healing Corrupted R2 Files

**Intent:** When bisync is blocked by corrupted or incompatible R2 objects, the system must automatically detect and remove the problematic files to restore sync functionality.

**Acceptance Criteria:**
1. When resync fails after 3 daemon retries, `nuke_corrupted_r2_files` runs automatically.
2. Strategy 1: parse sync.log for any file path causing a bisync error (encryption mismatch, size mismatch, corrupted transfer, copy failure, hash mismatch, listing conflicts) and delete from both R2 and local.
3. Strategy 2: if no error files found in logs, perform full R2 scan -- list all objects with unencrypted config, HEAD each with encrypted config, delete any returning 400 (unencrypted orphans).
4. After nuking, bisync state is cleared and resync retried immediately.
5. Self-healing runs both at startup (if initial baseline fails) and in the daemon (if resync fallback fails).

**Constraints:**
- Losing one problematic file is acceptable; losing all sync is not.
- Files are deleted from R2 using both encrypted and unencrypted configs.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-STOR-003, REQ-STOR-004
**Verification:** Integration test

**Status:** Deprecated -- The `nuke_corrupted_r2_files` function was never implemented. Self-healing for transient file errors is now handled by the vanishing-file recovery mechanism (REQ-STOR-004 AC5, REQ-STOR-003 AC4). Corruption from encryption mismatches is handled by `--resilient` + `--recover` flags and the resync fallback in the daemon.

---

## REQ-STOR-014: R2 Storage Stats Caching

**Intent:** Storage statistics must be available quickly without paginating all R2 objects on every request.

**Acceptance Criteria:**
1. `GET /api/storage/stats` paginates all R2 objects and caches results in KV (`storage-stats:{bucketName}`) with 60-second TTL.
2. `batch-status` piggybacks cached stats without TTL check (relies on cache freshness).
3. Mutation endpoints (upload, delete, seed) invalidate the KV cache after successful operations.
4. The quota value (`maxStorageBytes`) is embedded in the cache entry so cache hits skip tier config resolution.

**Constraints:**
- Stats rate limited at its own rate (separate from browse/upload/download).
- Cache miss triggers full R2 pagination, which may be slow for large buckets.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-STOR-001, REQ-STOR-006
**Verification:** Automated test

**Status:** Implemented
