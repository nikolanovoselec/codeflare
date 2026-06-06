# Storage Domain Specification

R2 persistence, rclone bisync, quotas, and file browser.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| R2 Bucket | Per-user Cloudflare R2 storage bucket, named deterministically from user email, providing isolated durable file storage |
| Bisync | Bidirectional rclone sync that reconciles local filesystem and R2 every 15 minutes (plus on user-initiated triggers and at shutdown), using newest-file-wins conflict resolution |
| Sync Mode | User-configurable scope of what gets synced: `none` (configs only), `full` (entire workspace), or `metadata` (agent configs per repo) |
| Storage Quota | Per-tier limit on total R2 usage (`maxStorageBytes`), enforced at session start, cached in KV with 60-second TTL |

### Out of Scope

- **Version history** -- R2 stores current file state only. No file versioning, rollback to previous revisions, or change tracking within storage.
- **File collaboration** -- Storage is single-user. No shared buckets, shared folders, or multi-user access to the same R2 prefix.
- **Real-time file sync** -- Bisync runs on a 15-minute cadence with one user-driven trigger (Sync-now button) and a final sync at container shutdown. R2-side changes and multi-tab convergence wait up to the 15-minute ceiling unless the user clicks Sync-now. R2 uploads do not auto-fan-out to running containers. Sub-second or event-driven sync between browser and container is not supported.
- **Corrupted R2 self-healing via nuke** -- Automatic detection and deletion of corrupted or encryption-mismatched R2 objects via a full-bucket scan was considered but not implemented. Transient file errors are handled by the vanishing-file recovery mechanism; encryption mismatches are handled by `--resilient`/`--recover` flags and the resync fallback in the bisync daemon.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Session Lifecycle | Container start triggers initial R2 sync and mounts the user's bucket; container stop triggers final sync |
| Subscription | Tier config provides `maxStorageBytes` for quota enforcement at session start |
| Security | SSE-C encryption of R2 objects when `ENCRYPTION_KEY` is configured; scoped R2 tokens per user |

---

### REQ-STOR-001: Dedicated Per-User R2 Bucket

<!-- @impl: src/lib/r2-admin.ts::createBucketIfNotExists -->
<!-- @impl: src/lib/r2-config.ts -->
<!-- @test: src/__tests__/lib/r2-config.test.ts (getR2Config describe → AC1/AC2/AC3) -->
<!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin describe → bucket creation idempotency → AC2 constraints) -->

**Intent:** Each authenticated user must have an isolated R2 bucket so that one user's files are never accessible to another user.

**Applies To:** User

**Acceptance Criteria:**

1. The bucket name is derived deterministically from the authenticated user's email so the same user always resolves to the same bucket.
2. The bucket is auto-created via the Cloudflare API on first container start when it does not already exist.
3. No API endpoint may return objects from a bucket the authenticated user does not own.

**Constraints:**

- Bucket naming complies with R2's object-storage naming rules (lowercase, no special characters beyond hyphens).
- Bucket creation is idempotent: invoking it against an existing bucket is a no-op, not an error.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/lib/r2-config.test.ts)

**Status:** Implemented

---

### REQ-STOR-002: File Persistence Across Sessions

<!-- @impl: entrypoint.sh::initial_sync_from_r2 -->
<!-- @impl: entrypoint.sh::bisync_with_r2 -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync daemon behavior describe -> periodic bisync runs the mechanism behind cross-session persistence -> AC1/AC2/AC3 mechanism) -->

**Intent:** User files must survive container destruction and be available when a new session starts, because containers are ephemeral.

**Applies To:** User

**Acceptance Criteria:**

1. Files written during a session are readable in a subsequent session after the container is recreated.
2. Agent configuration directories and per-user dotfiles persist across sessions. The per-path inventory lives in [documentation/lanes/storage-and-sync.md](../../documentation/lanes/storage-and-sync.md).
3. Workspace files persist across sessions when the user has enabled full workspace sync.

**Constraints:**

- R2 is the durable store; the local filesystem is ephemeral.
- Persistence depends on at least one successful sync completing before container shutdown.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Integration test](../../host/__tests__/entrypoint-bisync-behavior.test.js)

**Status:** Implemented

---

### REQ-STOR-003: Bidirectional Sync Every 15 Minutes (with Manual Triggers)

<!-- @impl: entrypoint.sh::start_sync_daemon -->
<!-- @impl: entrypoint.sh::bisync_with_r2 -->
<!-- @impl: entrypoint.sh::recover_vanished_files -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync daemon behavior describe -> periodic bisync runs -> AC1) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync daemon behavior describe -> SIGUSR1 sleep-interrupt -> AC2) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync daemon behavior describe -> SIGUSR1 in-flight coalesce -> AC2) -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (bisync constraint flags describe -> --conflict-resolve newer -> AC3) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync daemon behavior describe -> daemon retries after transient failure -> AC4) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync daemon behavior describe -> vanishing-file recovery retries -> AC5) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync daemon behavior describe -> three consecutive failures trigger resync -> AC6) -->

**Intent:** Changes made locally (by the agent or user) and changes in R2 (from the file browser or another session's sync) must converge within a bounded interval, balanced against R2 operation cost. The 15-minute cadence is supplemented by explicit user-driven triggers ([REQ-STOR-015](#req-stor-015-explicit-sync-trigger-from-ui)) so the user is never blocked waiting for a cycle when they want fresh state.

**Applies To:** User

**Acceptance Criteria:**

1. After the bisync baseline is established, a periodic bisync runs on a 15-minute cadence.
2. The daemon's periodic sleep is interruptible by an external trigger: a trigger wakes the daemon and skips the remaining sleep, producing an immediate bisync. Triggers delivered while a bisync is mid-flight coalesce into exactly one rerun after the current cycle completes (see [REQ-STOR-015](#req-stor-015-explicit-sync-trigger-from-ui) AC5).
3. Conflict resolution is newest-file-wins.
4. The daemon retries on transient failure and continues the periodic cycle.
5. On bisync failure, the daemon attempts vanishing-file recovery (parse the error output, exclude transient files, clear stale locks, retry) before counting the failure against the failure budget.
6. After three consecutive unrecoverable failures (each with internal retries exhausted), the daemon falls back to a resync baseline to re-establish a clean state.

**Constraints:**

- Bisync invocations must tolerate files changing mid-transfer (no false hash-mismatch aborts).
- Bulk deletions in the workspace must propagate (no conservative delete cap that strands removals locally).
- Post-sync listing validation must not abort the cycle when R2 changes during the sync window.
- Empty files are excluded from sync because R2's per-object encryption rejects zero-byte uploads.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket), [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** [Integration test](../../host/__tests__/entrypoint-bisync-behavior.test.js)

**Status:** Implemented

---

### REQ-STOR-004: Initial Sync Restores Files on Container Start

<!-- @impl: entrypoint.sh::initial_sync_from_r2 -->
<!-- @impl: entrypoint.sh::establish_bisync_baseline -->
<!-- @impl: entrypoint.sh::init_recovery_filters -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (initial sync on container start describe -> rclone sync R2->local -> AC1) -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (initial sync on container start describe -> 120s timeout -> AC2) -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (initial sync on container start describe -> config writes ordering -> AC3) -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (initial sync on container start describe -> --resync flag -> AC4) -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (initial sync on container start describe -> vanishing-file retry max 3 -> AC5) -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (initial sync on container start describe -> MCP static excludes -> AC6) -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (initial sync on container start describe -> daemon starts unconditionally -> AC7) -->

**Intent:** When a container boots, it must restore the user's persisted files from R2 before the agent or terminal becomes usable.

**Applies To:** User

**Acceptance Criteria:**

1. A one-way sync from R2 to local runs as the first initialization step after the in-container terminal server is ready to accept connections, blocking further startup until it completes.
2. The initial sync completes or times out within a bounded duration so the session is never blocked indefinitely on a slow R2 fetch.
3. All per-agent config file modifications complete after the initial sync but before the bisync baseline, so the baseline observes a stable snapshot. The per-agent file enumeration lives in [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md).
4. A bisync baseline is established after the post-sync file modifications complete.
5. If the initial baseline fails because of a vanishing file (listed by R2 but deleted before copy), the system parses the error, adds the missing file to a session-scoped recovery filter, and retries with a bounded number of attempts. Only non-workspace files are auto-excluded; workspace files trigger a plain retry.
6. Known per-session ephemeral agent-state files are statically excluded from all sync operations. The full per-path inventory of static excludes lives in [documentation/lanes/storage-and-sync.md](../../documentation/lanes/storage-and-sync.md).
7. The bisync daemon starts unconditionally after the baseline phase, even if all baseline attempts fail; a dead daemon would mean zero sync for the entire session, and the daemon already has its own recovery path (vanishing-file recovery plus resync fallback).

**Constraints:**

- The bisync-initialized marker must be set even on the timeout path so the shutdown handler still attempts the final sync.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Integration test](../../host/__audits__/entrypoint-initial-sync.audit.js)

**Status:** Implemented

---

### REQ-STOR-005: Graceful Shutdown Performs Final Sync

<!-- @impl: entrypoint.sh::shutdown_handler -->
<!-- @impl: src/container/container-lifecycle.ts::destroy -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (graceful shutdown final sync describe -> SIGTERM trap -> AC1) -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (graceful shutdown final sync describe -> bisync-initialized gate -> AC2) -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (graceful shutdown final sync describe -> 120s watchdog -> AC4) -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (graceful shutdown final sync describe -> 135s destroy budget documented -> AC5) -->

**Intent:** When a container is stopped or evicted, unsaved local changes must be pushed to R2 before the process exits. This REQ covers the entrypoint SIGTERM-trap final bisync, which is now a best-effort BACKSTOP: the authoritative final sync is the awaited live drain the Durable Object runs before signalling stop, specified in [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync) (the platform SIGKILLs the container ~3s after stop, so the trap alone cannot guarantee completion). The trap still runs, still gated on the bisync-initialized marker, and still watchdogged as below.

**Applies To:** User

**Acceptance Criteria:**

1. A termination handler runs a final bisync before the process exits (best-effort backstop; the primary guarantee is the live drain in [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync)).
2. The final bisync runs only when the bisync-initialized marker is set.
3. Files created during the session are available in R2 after shutdown completes successfully.
4. The final bisync runs under a hard watchdog. If it has not completed before the watchdog expires the process is force-killed; the user accepts that the last writes may not have synced.
5. The container orchestrator's destroy budget exceeds the final-sync watchdog by enough time for a clean process exit so the orchestrator does not tear down mid-sync.

**Constraints:**

- The shutdown handler's watchdog and the orchestrator's destroy budget must remain coordinated: destroy budget > watchdog + exit time.
- The final bisync uses the same correctness flags as the periodic bisync so behavior at shutdown matches steady-state.

**Priority:** P0

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** [Integration test](../../host/__audits__/entrypoint-initial-sync.audit.js)

**Status:** Implemented

---

### REQ-STOR-006: Storage Quota Enforced Per Tier at Session Start

<!-- @impl: src/routes/storage/stats.ts -->
<!-- @impl: src/lib/subscription.ts::getTierConfig -->
<!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes describe → quota enforcement at session start → AC1-AC5) -->

**Intent:** Users must not be able to start new sessions when their storage usage exceeds their tier's quota, preventing unbounded R2 consumption.

**Applies To:** User

**Acceptance Criteria:**

1. Session creation reads the cached storage-usage figure and compares it to the user's tier-configured maximum.
2. If current usage exceeds the configured maximum, session creation is rejected with a clear user-facing error.
3. The storage-stats endpoint returns both current usage and the configured maximum so the UI can render an "X of Y" indicator.
4. An unset maximum is interpreted as unlimited and skips enforcement entirely.
5. When tier configuration adds new fields, previously persisted records inherit the new field's default rather than appearing unset.

**Constraints:**

- Quota is checked at session start only; mid-session file uploads, sync writes, and preseed writes are not blocked.
- Users may temporarily exceed quota during an active session; the overage is caught at the next session-start attempt.
- The stats cache embeds the quota value so cache hits skip tier-configuration resolution.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-STOR-014](#req-stor-014-r2-storage-stats-caching)

**Verification:** [Automated test](../../src/__tests__/routes/storage-stats.test.ts)

**Status:** Implemented

---

### REQ-STOR-007: Web File Browser

<!-- @impl: src/routes/storage/browse.ts -->
<!-- @impl: src/routes/storage/upload.ts -->
<!-- @impl: src/routes/storage/download.ts -->
<!-- @impl: src/routes/storage/delete.ts -->
<!-- @impl: src/routes/storage/preview.ts -->
<!-- @impl: src/routes/storage/validation.ts::validateKey -->
<!-- @test: src/__tests__/routes/storage-browse.test.ts (Storage Browse Routes describe → AC1) -->
<!-- @test: src/__tests__/routes/storage-upload.test.ts (upload endpoint → AC2) -->
<!-- @test: src/__tests__/routes/storage-download.test.ts (download endpoint → AC3) -->
<!-- @test: src/__tests__/routes/storage-delete.test.ts (delete endpoint → AC4) -->
<!-- @test: src/__tests__/routes/storage-preview.test.ts (preview endpoint → AC5) -->

**Intent:** Users must be able to browse, upload, download, delete, and preview files in their R2 storage via HTTP endpoints, without using the terminal.

**Applies To:** User

**Acceptance Criteria:**

1. The browse endpoint lists objects under a given R2 prefix with directory-style navigation.
2. The upload endpoint stores a file at a specified R2 key.
3. The download endpoint returns file contents as an attachment with a sanitized filename.
4. The delete endpoint removes objects by key and/or prefix in a single server-side bulk operation.
5. The preview endpoint returns text content inline for text files and metadata-only for other types.

**Constraints:**

- All R2 read and write operations use SSE-C when server-side encryption is configured.
- Each endpoint has its own per-user rate limit appropriate to its expected access pattern.
- UI presentation, architectural source-of-truth, and prefix-traversal validation are specified in [REQ-STOR-016](#req-stor-016-file-browser-presentation-and-traversal-safety).

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Automated test](../../src/__tests__/routes/storage-browse.test.ts)

**Status:** Implemented

---

### REQ-STOR-016: File browser presentation and traversal safety

<!-- @impl: web-ui/src/components/StorageBrowser.tsx -->
<!-- @impl: src/routes/storage/validation.ts::validateKey -->
<!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser describe → drawer/bottom-sheet + R2-source → AC1/AC2) -->
<!-- @test: src/__tests__/routes/storage-browse.test.ts (Storage Browse Routes describe → prefix traversal rejection → AC3) -->

**Intent:** The web file browser must present consistently across form factors, treat R2 as the single source of truth (not the container filesystem), and reject directory-traversal probes at the prefix-listing endpoint.

**Applies To:** User

**Acceptance Criteria:**

1. The file browser renders as a slide-in side drawer on desktop and a bottom-sheet on mobile.
2. The file browser reads directly from R2 via the Worker API (not from the container filesystem).
3. The browse endpoint validates the requested prefix against directory-traversal probes and rejects parent-directory references.

**Constraints:**

- The file browser and settings panel are mutually exclusive in the UI.

**Priority:** P1

**Dependencies:** [REQ-STOR-007](#req-stor-007-web-file-browser)

**Verification:** [Automated test](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx)

**Status:** Implemented

---

### REQ-STOR-008: Multipart Upload for Large Files

<!-- @impl: src/routes/storage/upload.ts -->
<!-- @test: src/__tests__/routes/storage-upload.test.ts (POST /upload/initiate describe -> returns uploadId -> AC1) -->
<!-- @test: src/__tests__/routes/storage-upload.test.ts (POST /upload/part describe -> returns etag -> AC2) -->
<!-- @test: src/__tests__/routes/storage-upload.test.ts (POST /upload/complete describe -> succeeds with valid parts -> AC3) -->
<!-- @test: src/__tests__/routes/storage-upload.test.ts (POST /upload/abort describe -> succeeds and returns success -> AC4) -->
<!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-STOR-008 AC5: shared rate limit across multipart endpoints describe -> exhausting limit on /upload/initiate causes /upload/part to 429 + exhausting limit on /upload/part causes /upload/complete to 429 -> AC5 shared 60/min limiter across all multipart routes) -->

**Intent:** Files larger than the single-request upload limit must be uploadable via chunked multipart upload.

**Applies To:** User

**Acceptance Criteria:**

1. The multipart initiate endpoint creates a multipart upload and returns an upload identifier.
2. The multipart part endpoint uploads a single part for a given upload identifier.
3. The multipart complete endpoint finalizes the upload by assembling the recorded parts into the final object.
4. The multipart abort endpoint cancels an in-progress multipart upload and releases any retained parts.
5. All multipart endpoints share a single rate-limit bucket so an attacker cannot bypass the upload limit by interleaving phases.

**Constraints:**

- Each uploaded part is encrypted with SSE-C when server-side encryption is configured.
- The multipart upload endpoints are exempt from the body-size limit applied to other API routes so chunked uploads can carry binary payloads.

**Priority:** P1

**Dependencies:** [REQ-STOR-007](#req-stor-007-web-file-browser)

**Verification:** [Integration test](../../src/__tests__/routes/storage-upload.test.ts)

**Status:** Implemented

---

### REQ-STOR-009: Getting-Started Docs Auto-Seeded on First Session

<!-- @impl: src/routes/storage/seed.ts -->
<!-- @impl: src/lib/r2-seed.ts -->
<!-- @test: src/__tests__/lib/r2-seed.test.ts (seedGettingStartedDocs describe → AC1 + retries on transient failure and succeeds on a later attempt + throws after exhausting retries → AC5) -->
<!-- @test: src/__tests__/routes/storage-seed.test.ts (seed endpoint → AC2/AC3/AC4) -->

**Intent:** New users must find starter documentation in their storage on first use so they have immediate orientation material.

**Applies To:** User

**Acceptance Criteria:**

1. When a user's R2 bucket is created for the first time, tutorial documents are written to the bucket root.
2. A seed endpoint allows the user to manually re-seed the tutorial content, optionally overwriting existing files.
3. After a successful seed, the storage-stats cache is invalidated so the next poll returns fresh data.
4. The seed endpoint is rate-limited at a low ceiling appropriate to its destructive-overwrite mode.
5. The first-session seed retries on a transient failure (e.g. a freshly created bucket not yet writable on the S3 data plane, or R2 credentials still propagating right after setup) with bounded backoff, so a new bucket reliably ends up seeded rather than left empty until a manual re-seed; once retries are exhausted the failure surfaces to the caller.

**Constraints:**

- Seeding is idempotent in non-overwrite mode: files that already exist at the target keys are skipped, never duplicated.
- Tutorial source content is a build-time artifact; the spec governs *that* it ships, not where the source lives.

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Automated test](../../src/__tests__/lib/r2-seed.test.ts)

**Status:** Implemented

---

### REQ-STOR-010: Agent Configs Auto-Seeded Based on Session Mode

<!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
<!-- @impl: src/lib/r2-seed.ts::seedAgentConfigs -->
<!-- @impl: src/lib/agent-seed.generated.ts -->
<!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs describe → AC1-AC6) -->
<!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (mode-gating → Pro vs Standard superset → AC6) -->
<!-- @test: src/__tests__/lib/r2-seed-context-mode.test.ts (context-mode preseed mode-gating) -->

**Intent:** Each user's R2 bucket must contain the correct agent configuration files for their session mode (Standard or Pro) so that agents start with the right rules, skills, and tools.

**Applies To:** User

**Acceptance Criteria:**

1. On first bucket creation, the reconciler writes mode-appropriate preseed files to R2 without overwriting or cleaning up.
2. The agent-config seed endpoint triggers a full reconcile that overwrites existing configs and removes files not present in the current mode.
3. Cleanup is strictly scoped to the registered preseed key set; user-created files outside that set are never deleted.
4. Variant-per-mode keys (instruction files whose content differs between modes) are excluded from cleanup so a mode switch never deletes a file the new mode still owns.
5. Partial delete failures produce warnings but do not fail the overall reconcile operation.
6. Pro mode seeds a strict superset of Standard's preseed files (Pro adds the memory plugin, agent definitions, hooks, slash commands, the discipline triad rules, and additional skills).

**Constraints:**

- Mode takes effect only on explicit re-seed action or new bucket creation; existing users keep their current files until they re-seed.
- No duplicate preseed source files exist on disk; all agent variants are generated from the Claude Code preseed as the single source of truth.
- Preseed configuration must validate that no two entries within a single mode share the same key.

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Automated test](../../src/__tests__/lib/r2-seed.test.ts)

**Status:** Implemented

---

### REQ-STOR-011: Sync Mode Controls Workspace Scope

<!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON -->
<!-- @impl: entrypoint.sh::create_rclone_config -->
<!-- @test: host/__audits__/entrypoint-initial-sync.audit.js (bisync constraint flags (REQ-STOR-003 constraints) describe -> AC4 always-excluded categories enforced via RCLONE_FILTERS_COMMON) + host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011) describe -> AC1/AC2/AC3 none vs full vs metadata workspace scope toggle) -->

**Intent:** Users must be able to choose how much of their workspace is synced to R2, balancing persistence against sync overhead.

**Applies To:** User

**Acceptance Criteria:**

1. The default sync scope (`none`) syncs only settings and config directories and excludes the workspace directory entirely.
2. The full sync scope (`full`) syncs the entire workspace directory, excluding dependency-install directories.
3. The metadata sync scope (`metadata`) syncs only the agent-config files (per-repo agent instruction files and the per-repo agent rule directory).
4. All sync scopes exclude these categories (per-path inventory lives in [documentation/lanes/storage-and-sync.md](../../documentation/lanes/storage-and-sync.md); the spec governs the categories so future filter changes have something to be verified against): package-manager caches, rclone caches, agent session logs, ephemeral agent data, build artifacts, regenerable tool state, and vendor credential caches that the agent regenerates on demand.

**Constraints:**

- Sync configuration uses filter rules with explicit precedence (not order-sensitive include/exclude lists) so the active scope is unambiguous when multiple rules match.
- The Container API surface currently exposes only the binary workspace-sync toggle (full or none); the metadata scope is reachable only by direct sync-mode configuration.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** [Automated test](../../host/__tests__/entrypoint-hooks-merge.test.js)

**Status:** Implemented

---

### REQ-STOR-012: Session Transcript Cleanup

<!-- @impl: entrypoint.sh::cleanup_old_transcripts -->
<!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (cleanup_old_transcripts describe → 5-most-recent retention against scratch USER_HOME → AC1-AC5) -->

**Intent:** Old session transcripts must be pruned to prevent unbounded R2 growth from long-lived users.

**Applies To:** User

**Acceptance Criteria:**

1. Transcript cleanup runs before each periodic bisync and never overlaps another cleanup run.
2. The five most recent per-project session transcripts are retained by modification time; older transcripts are deleted. The exact filesystem path lives in [documentation/lanes/storage-and-sync.md](../../documentation/lanes/storage-and-sync.md).
3. Session directories themselves are left intact so the agent can still resolve project paths.
4. Cleanup deletions propagate to R2 automatically via the next bisync.
5. Subagent transcripts are excluded from bisync entirely so they never reach R2.

**Constraints:**

- Cleanup steps must isolate non-zero exit codes so a benign cleanup failure cannot terminate the bisync daemon.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** [Automated test](../../host/__tests__/entrypoint-transcript-cleanup.test.js)

**Status:** Implemented

---

### REQ-STOR-014: R2 Storage Stats Caching

<!-- @impl: src/routes/storage/stats.ts -->
<!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes describe → pagination caching + TTL + mutation-driven invalidation → AC1-AC4) -->

**Intent:** Storage statistics must be available quickly without paginating all R2 objects on every request.

**Applies To:** User

**Acceptance Criteria:**

1. The storage-stats endpoint paginates all R2 objects in the user's bucket and caches the aggregated result with a short TTL.
2. The session batch-status endpoint reuses the cached stats without an additional TTL check, relying on the source-of-truth cache for freshness.
3. Mutation endpoints (upload, delete, seed) invalidate the stats cache after a successful operation so the next read reflects the change.
4. The cache entry embeds the tier-configured quota value so cache hits do not have to resolve tier configuration.

**Constraints:**

- The stats endpoint has its own rate-limit budget separate from browse, upload, and download so a heavy stats poller cannot starve other operations.
- A cache miss triggers a full R2 listing which may be slow for large buckets; callers must tolerate elevated latency on miss.

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Automated test](../../src/__tests__/routes/storage-stats.test.ts)

**Status:** Implemented

---

### REQ-STOR-015: Explicit Sync Trigger from UI

<!-- @impl: src/routes/session/index.ts -->
<!-- @impl: src/lib/sync-fanout.ts -->
<!-- @impl: entrypoint.sh::start_sync_daemon -->
<!-- @test: src/__tests__/lib/sync-fanout.test.ts (sync-fanout describe → fan-out + concurrency cap + per-session isolation + rate-limit → AC1/AC2/AC3/AC4) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (SIGUSR1 sleep-interrupt branch → AC5; in-flight coalesce branch pending plan) -->
<!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (Sync-now button disabled-while-syncing → AC6) -->

**Intent:** Because the periodic bisync cadence is 15 minutes ([REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), users must have explicit ways to force convergence between the container filesystem and R2 without waiting for the next cycle.

**Applies To:** User

**Acceptance Criteria:**

1. The sync-trigger endpoint fans out an immediate sync to every running session belonging to the authenticated user. Stopped sessions are skipped client-side using the session batch-status output before fan-out.
2. Fan-out runs in parallel with a bounded concurrency cap; remaining sessions are queued so a user with many concurrent sessions cannot exhaust Worker subrequest budget.
3. Per-session failures are isolated: one session's bisync failure does not prevent other sessions from completing. The response carries per-session sync status.
4. The sync-trigger endpoint is rate-limited per user using the same destructive-action rate-limiter pattern applied to other expensive endpoints.
5. The trigger is idempotent: an external trigger to the bisync daemon while a bisync is already in flight causes exactly one rerun after the current cycle completes (N concurrent triggers coalesce to one rerun, not N).
6. The frontend Sync-now control is disabled while any of the user's sessions reports an in-flight sync and re-enables once all sessions transition out.

**Constraints:**

- Three sync triggers only: the periodic cadence ([REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), the explicit user trigger (this REQ), and the final shutdown sync ([REQ-STOR-005](#req-stor-005-graceful-shutdown-performs-final-sync)). R2-side uploads do not auto-fan-out to running containers; the user either triggers a sync or waits for the next periodic cycle. The upload-side auto-trigger was removed to avoid bursting Worker subrequest budget on multi-file uploads.
- Multi-session fan-out is safe under the newest-file-wins bisync semantics: the merge operation is commutative and associative under absolute modification time, so parallel and serial fan-out produce the same final R2 state per file. The same concurrent mode already runs on every periodic cycle for users with multiple sessions, so manual triggers introduce no new failure mode.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-STOR-007](#req-stor-007-web-file-browser), [REQ-STOR-011](#req-stor-011-sync-mode-controls-workspace-scope)

**Verification:** [Automated test](../../src/__tests__/lib/sync-fanout.test.ts)

**Status:** Implemented
