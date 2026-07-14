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


**Intent:** Each authenticated user must have an isolated R2 bucket so that one user's files are never accessible to another user.

**Applies To:** User

**Acceptance Criteria:**

1. The bucket name is derived deterministically from the authenticated user's email so the same user always resolves to the same bucket. <!-- @impl: src/lib/r2-config.ts::getR2Config --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC4/AC5 (createBucketIfNotExists is idempotent and races safe)) -->
2. The bucket is auto-created via the Cloudflare API on first container start when it does not already exist. <!-- @impl: src/lib/r2-admin.ts::createBucketIfNotExists --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC4/AC5 (createBucketIfNotExists is idempotent and races safe)) -->
3. No API endpoint may return objects from a bucket the authenticated user does not own. <!-- @impl: src/lib/r2-config.ts::getR2Config --> <!-- @test: src/__tests__/lib/r2-config.test.ts (getR2Config / REQ-STOR-001 AC1/AC2/AC3 (dedicated per-user R2 bucket: account/jurisdiction-aware config, bucket naming derivation)) -->

**Constraints:**

- Bucket naming complies with R2's object-storage naming rules (lowercase, no special characters beyond hyphens).
- Bucket creation is idempotent: invoking it against an existing bucket is a no-op, not an error.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/lib/r2-config.test.ts)

**Status:** Implemented

---

### REQ-STOR-002: File Persistence Across Sessions


**Intent:** User files must survive container destruction and be available when a new session starts, because containers are ephemeral.

**Applies To:** User

**Acceptance Criteria:**

1. Files written during a session are readable in a subsequent session after the container is recreated. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->
2. Agent configuration directories and per-user dotfiles persist across sessions. The per-path inventory lives in [documentation/lanes/storage-and-sync.md](../../documentation/lanes/storage-and-sync.md#whats-synced-vs-excluded-req-stor-011). <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->
3. Workspace files persist across sessions when the user has enabled full workspace sync. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->

**Constraints:**

- R2 is the durable store; the local filesystem is ephemeral.
- Persistence depends on at least one successful sync completing before container shutdown.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Integration test](../../host/__tests__/entrypoint-bisync-behavior.test.js)

**Status:** Implemented

---

### REQ-STOR-003: Bidirectional Sync Every 15 Minutes (with Manual Triggers)


**Intent:** Changes made locally (by the agent or user) and changes in R2 (from the file browser or another session's sync) must converge within a bounded interval, balanced against R2 operation cost. The 15-minute cadence is supplemented by explicit user-driven triggers ([REQ-STOR-015](#req-stor-015-explicit-sync-trigger-from-ui)) so the user is never blocked waiting for a cycle when they want fresh state.

**Applies To:** User

**Acceptance Criteria:**

1. After the bisync baseline is established, a periodic bisync runs on a 15-minute cadence. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->
2. The daemon's periodic sleep is interruptible by an external trigger: a trigger wakes the daemon and skips the remaining sleep, producing an immediate bisync. Triggers delivered while a bisync is mid-flight coalesce into exactly one rerun after the current cycle completes (see [REQ-STOR-015](#req-stor-015-explicit-sync-trigger-from-ui) AC5). <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (SIGUSR1 interrupts the cadence sleep and triggers bisync immediately (REQ-STOR-003 AC2 / REQ-STOR-015 AC5 / REQ-MEM-004 AC4: SIGUSR1 trigger)) -->
3. Conflict resolution is newest-file-wins. <!-- @impl: entrypoint.sh::bisync_with_r2 -->
4. The daemon retries on transient failure and continues the periodic cycle. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (daemon retries after transient failure and continues the cycle (REQ-STOR-003 AC4)) -->
5. On bisync failure, the daemon attempts vanishing-file recovery (parse the error output, exclude transient files, clear stale locks, retry) before counting the failure against the failure budget. <!-- @impl: entrypoint.sh::recover_vanished_files --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (failure + vanishing-file recovery retries bisync and clears CONSECUTIVE_FAILURES (REQ-STOR-003 AC5)) -->
6. After three consecutive unrecoverable failures (each with internal retries exhausted), the daemon falls back to a resync baseline to re-establish a clean state. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (three consecutive failures trigger --resync fallback (REQ-STOR-003 AC6 / REQ-STOR-002 AC1: resync re-establishes baseline so next sync can persist files)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Bisync invocations must tolerate files changing mid-transfer (no false hash-mismatch aborts).
- Bulk deletions in the workspace must propagate (no conservative delete cap that strands removals locally).
- Post-sync listing validation must not abort the cycle when R2 changes during the sync window.
- Empty files are excluded from sync.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket), [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-STOR-004: Initial Sync Restores Files on Container Start


**Intent:** When a container boots, it must restore the user's persisted files from R2 before the agent or terminal becomes usable.

**Applies To:** User

**Acceptance Criteria:**

1. A one-way sync from R2 to local runs as the first initialization step after the in-container terminal server is ready to accept connections, blocking further startup until it completes. <!-- @impl: entrypoint.sh::initial_sync_from_r2 -->
2. The initial sync completes or times out within a bounded duration so the session is never blocked indefinitely on a slow R2 fetch. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: host/__tests__/entrypoint-vanished-file-recovery.test.js (does NOT exclude a vanished WORKSPACE file (user code) but still signals a plain retry (REQ-STOR-004 AC5: workspace files trigger plain retry)) -->
3. All per-agent config file modifications complete after the initial sync but before the bisync baseline, so the baseline observes a stable snapshot. The per-agent file enumeration lives in [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md). <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
4. A bisync baseline is established after the post-sync file modifications complete. <!-- @impl: entrypoint.sh::establish_bisync_baseline -->
5. If the initial baseline fails. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-vanished-file-recovery.test.js (adds a vanished NON-workspace file to the session recovery filter and signals retry (REQ-STOR-004 AC5)) -->
6. Known per-session ephemeral agent-state files are statically excluded from all sync operations, including Codex plugin/general caches and log databases, Copilot SQLite temporary files, and Claude workflow artifacts. The full per-path inventory lives in [documentation/lanes/storage-and-sync.md](../../documentation/lanes/storage-and-sync.md#whats-synced-vs-excluded-req-stor-011). <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (statically excludes ephemeral caches and the R2-secret rclone config in both modes (REQ-STOR-004 AC6)) -->
7. The bisync daemon starts unconditionally after the baseline phase, even if all baseline attempts fail; a dead daemon would mean zero sync for the entire session, and the daemon already has its own recovery path (vanishing-file recovery plus resync fallback). <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The bisync-initialized marker must be set even on the timeout path so the shutdown handler still attempts the final sync.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-STOR-005: Graceful Shutdown Performs Final Sync


**Intent:** When a container is stopped or evicted, unsaved local changes must be pushed to R2 before the process exits. This REQ covers the entrypoint SIGTERM-trap final bisync, which is now a best-effort BACKSTOP: the authoritative final sync is the awaited live drain the Durable Object runs before signalling stop, specified in [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync) (the platform SIGKILLs the container ~3s after stop, so the trap alone cannot guarantee completion). The trap still runs, still gated on the bisync-initialized marker, and still watchdogged as below.

**Applies To:** User

**Acceptance Criteria:**

1. A termination handler runs a final bisync before the process exits (best-effort backstop; the primary guarantee is the live drain in [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync)). <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
2. The final bisync runs only when the bisync-initialized marker is set. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
3. Files created during the session are available in R2 after shutdown completes successfully. <!-- @impl: entrypoint.sh::shutdown_handler -->
4. The final bisync runs under a hard watchdog. If it has not completed before the watchdog expires the process is force-killed; the user accepts that the last writes may not have synced. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
5. The container orchestrator's destroy budget exceeds the final-sync watchdog by enough time for a clean process exit so the orchestrator does not tear down mid-sync. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The shutdown handler's watchdog and the orchestrator's destroy budget must remain coordinated: destroy budget > watchdog + exit time.
- The final bisync uses the same correctness flags as the periodic bisync so behavior at shutdown matches steady-state.

**Priority:** P0

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-STOR-006: Storage Quota Enforced Per Tier at Session Start


**Intent:** Users must not be able to start new sessions when their storage usage exceeds their tier's quota, preventing unbounded R2 consumption.

**Applies To:** User

**Acceptance Criteria:**

1. Session creation reads the cached storage-usage figure and compares it to the user's tier-configured maximum. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->
2. If current usage exceeds the configured maximum, session creation is rejected with a clear user-facing error. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->
3. The storage-stats endpoint returns both current usage and the configured maximum so the UI can render an "X of Y" indicator. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->
4. An unset maximum is interpreted as unlimited and skips enforcement entirely. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->
5. When tier configuration adds new fields, previously persisted records inherit the new field's default rather than appearing unset. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Quota is checked at session start only; mid-session file uploads, sync writes, and preseed writes are not blocked.
- Users may temporarily exceed quota during an active session; the overage is caught at the next session-start attempt.
- The stats cache embeds the quota value so cache hits skip tier-configuration resolution.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-STOR-014](#req-stor-014-r2-storage-stats-caching)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-STOR-007: Web File Browser


**Intent:** Users must be able to browse, upload, download, delete, and preview files in their R2 storage via HTTP endpoints, without using the terminal.

**Applies To:** User

**Acceptance Criteria:**

1. The browse endpoint lists objects under a given R2 prefix with directory-style navigation. <!-- @test: src/__tests__/routes/storage-browse.test.ts (Storage Browse Routes / REQ-STOR-007 (web file browser: browse endpoint with prefix validation, rate-limited)) --> <!-- @impl: src/routes/storage/validation.ts::validateKey -->
2. The upload endpoint stores a file at a specified R2 key. <!-- @test: src/__tests__/routes/storage-upload.test.ts (exhausting limit on /upload/initiate causes a subsequent /upload/part to 429) -->
3. The download endpoint returns file contents as an attachment with a sanitized filename. <!-- @impl: src/routes/storage/download.ts::buildContentDisposition --> <!-- @test: src/__tests__/routes/storage-download.test.ts (Storage Download Routes) -->
4. The delete endpoint removes objects by key and/or prefix in a single server-side bulk operation. <!-- @impl: src/routes/storage/delete.ts::app --> <!-- @test: src/__tests__/routes/storage-delete.test.ts (Storage Delete Route) -->
5. The preview endpoint returns text content inline for text files and metadata-only for other types. <!-- @test: src/__tests__/routes/storage-preview.test.ts (Storage Preview Routes) -->
6. On request, the download endpoint serves a file inline for in-browser viewing rather than as an attachment when the caller passes `?disposition=inline`. <!-- @impl: src/routes/storage/download.ts::INLINE_IMAGE_TYPES --> <!-- @test: src/__tests__/routes/storage-download.test.ts (REQ-STOR-007: serves an inline image with its real type, inline disposition, and nosniff) -->
7. The inline view path enforces an XSS-safe content-type: known image types and PDF keep their real MIME type while all other types, including HTML and SVG, are served as inert text so user-supplied markup cannot execute in the user's session. <!-- @impl: src/routes/storage/download.ts::safeInlineContentType --> <!-- @test: src/__tests__/routes/storage-download.test.ts (safeInlineContentType) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- All R2 read and write operations use SSE-C when server-side encryption is configured.
- Each endpoint has its own per-user rate limit appropriate to its expected access pattern.
- UI presentation, architectural source-of-truth, and prefix-traversal validation are specified in [REQ-STOR-016](#req-stor-016-file-browser-presentation-and-traversal-safety).

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-STOR-008: Multipart Upload for Large Files


**Intent:** Files larger than the single-request upload limit must be uploadable via chunked multipart upload.

**Applies To:** User

**Acceptance Criteria:**

1. The multipart initiate endpoint creates a multipart upload and returns an upload identifier. <!-- @test: src/__tests__/routes/storage-upload.test.ts (Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)) -->
2. The multipart part endpoint uploads a single part for a given upload identifier. <!-- @test: src/__tests__/routes/storage-upload.test.ts (Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)) -->
3. The multipart complete endpoint finalizes the upload by assembling the recorded parts into the final object. <!-- @impl: src/routes/storage/upload.ts::CompleteUploadBodySchema --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)) -->
4. The multipart abort endpoint cancels an in-progress multipart upload and releases any retained parts. <!-- @test: src/__tests__/routes/storage-upload.test.ts (Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)) -->
5. All multipart endpoints share a single rate-limit bucket so an attacker cannot bypass the upload limit by interleaving phases. <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-STOR-008 AC5: shared rate limit across multipart endpoints) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Each uploaded part is encrypted with SSE-C when server-side encryption is configured.
- The multipart upload endpoints are exempt from the body-size limit applied to other API routes so chunked uploads can carry binary payloads.

**Priority:** P1

**Dependencies:** [REQ-STOR-007](#req-stor-007-web-file-browser)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-STOR-009: Getting-Started Docs Auto-Seeded on First Session


**Intent:** New users must find starter documentation in their storage on first use so they have immediate orientation material. Because a freshly created bucket is not always immediately writable on the R2 data plane, seeding must be self-healing rather than a single best-effort attempt at creation time.

**Applies To:** User

**Acceptance Criteria:**

1. When a user's R2 bucket is created for the first time, tutorial documents are written to the bucket root. <!-- @impl: src/lib/r2-seed.ts::seedGettingStartedDocs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedGettingStartedDocs / REQ-STOR-009 (per-user R2 bucket seeded with getting-started docs on first access)) -->
2. A seed endpoint allows the user to manually re-seed the tutorial content, optionally overwriting existing files.
3. After a successful seed, the storage-stats cache is invalidated so the next poll returns fresh data. <!-- @test: src/__tests__/routes/storage-seed.test.ts (invalidates storage-stats KV cache after successful getting-started seed) -->
4. The seed endpoint is rate-limited at a low ceiling appropriate to its destructive-overwrite mode. <!-- @impl: src/routes/storage/seed.ts::storageSeedRateLimiter --> <!-- @test: src/__tests__/routes/rate-limits.test.ts (POST /seed/getting-started - storage-seed (3/min)) -->
5. The first-session seed retries on a transient failure (e.g. a freshly created bucket not yet writable on the S3 data plane, or R2 credentials still propagating right after setup) with bounded backoff, so a new bucket reliably ends up seeded. <!-- @impl: src/lib/r2-seed.ts::seedGettingStartedDocs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedGettingStartedDocs / REQ-STOR-009 (per-user R2 bucket seeded with getting-started docs on first access)) -->
6. Getting-started doc seeding is self-healing and is not gated solely on first bucket creation: on session start, when a `gettingStartedSeeded` preference marker is not set, the idempotent seed is re-attempted. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (ensureBucketAndSeed) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Seeding is idempotent in non-overwrite mode: files that already exist at the target keys are skipped, never duplicated.
- Tutorial source content is a build-time artifact; the spec governs *that* it ships, not where the source lives.
- The self-healing seed must not clobber user edits: it runs in non-overwrite mode, and once the success marker is set it does not re-run.

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-STOR-010: Agent Configs Auto-Seeded Based on Session Mode


**Intent:** Each user's R2 bucket must contain the correct agent configuration files for their session mode (Standard or Pro) so that agents start with the right rules, skills, and tools.

**Applies To:** User

**Acceptance Criteria:**

1. On first bucket creation, the reconciler writes mode-appropriate preseed files to R2 without overwriting or cleaning up. <!-- @impl: src/lib/r2-seed.ts::seedAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs / REQ-AGENT-008 (preseed deployed to container on start) / REQ-STOR-010 (reconcileAgentConfigs deletes orphaned seed entries on tier change)) -->
2. The agent-config seed endpoint triggers a full reconcile that overwrites existing configs and removes files not present in the current mode. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs / REQ-AGENT-008 (preseed deployed to container on start) / REQ-STOR-010 (reconcileAgentConfigs deletes orphaned seed entries on tier change)) -->
3. Cleanup is strictly scoped to the registered preseed key set; user-created files outside that set are never deleted. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs / REQ-AGENT-008 (preseed deployed to container on start) / REQ-STOR-010 (reconcileAgentConfigs deletes orphaned seed entries on tier change)) -->
4. Variant-per-mode keys (instruction files whose content differs between modes) are excluded from cleanup so a mode switch never deletes a file the new mode still owns. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs / REQ-AGENT-008 (preseed deployed to container on start) / REQ-STOR-010 (reconcileAgentConfigs deletes orphaned seed entries on tier change)) -->
5. Partial delete failures produce warnings but do not fail the overall reconcile operation. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs / REQ-AGENT-008 (preseed deployed to container on start) / REQ-STOR-010 (reconcileAgentConfigs deletes orphaned seed entries on tier change)) -->
6. Pro mode seeds a strict superset of Standard's preseed files (Pro adds the memory plugin, agent definitions, hooks, slash commands, the discipline triad rules, and additional skills). <!-- @impl: src/lib/agent-seed.generated.ts::AGENTS_SEEDED_CONFIGS --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs / REQ-AGENT-008 (preseed deployed to container on start) / REQ-STOR-010 (reconcileAgentConfigs deletes orphaned seed entries on tier change)) -->

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


**Intent:** Users must be able to choose how much of their workspace is synced to R2, balancing persistence against sync overhead.

**Applies To:** User

**Acceptance Criteria:**

1. The default sync scope (`none`) syncs only settings and config directories and excludes the workspace directory entirely. <!-- @impl: entrypoint.sh::init_sync_log --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->
2. The full sync scope (`full`) syncs the entire workspace directory, excluding dependency-install directories. <!-- @impl: entrypoint.sh::init_sync_log --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->
3. The metadata sync scope (`metadata`) syncs only the agent-config files (per-repo agent instruction files and the per-repo agent rule directory). <!-- @impl: entrypoint.sh::init_sync_log --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->
4. All sync scopes exclude package-manager and rclone caches, agent logs and ephemeral data, build artifacts, regenerable tool state, and on-demand vendor credential caches; the path inventory is documented in [Storage & Sync](../../documentation/lanes/storage-and-sync.md#whats-synced-vs-excluded-req-stor-011). <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->

**Constraints:**

- Sync configuration uses filter rules with explicit precedence (not order-sensitive include/exclude lists) so the active scope is unambiguous when multiple rules match.
- The Container API surface currently exposes only the binary workspace-sync toggle (full or none); the metadata scope is reachable only by direct sync-mode configuration.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** [Automated test](../../host/__tests__/entrypoint-hooks-merge.test.js)

**Status:** Implemented

---

### REQ-STOR-012: Session Transcript Cleanup


**Intent:** Old session transcripts must be pruned to prevent unbounded R2 growth from long-lived users.

**Applies To:** User

**Acceptance Criteria:**

1. Transcript cleanup runs before each periodic bisync and never overlaps another cleanup run. <!-- @impl: entrypoint.sh::cleanup_old_transcripts --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (cleanup_old_transcripts / REQ-STOR-012 (keeps 5 newest .jsonl, deletes older, leaves session dirs intact, excludes subagents)) -->
2. The five most recent per-project session transcripts are retained by modification time; older transcripts are deleted. The exact filesystem path lives in [documentation/lanes/storage-and-sync.md](../../documentation/lanes/storage-and-sync.md#session-transcript-cleanup). <!-- @impl: entrypoint.sh::cleanup_old_transcripts --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (cleanup_old_transcripts / REQ-STOR-012 (keeps 5 newest .jsonl, deletes older, leaves session dirs intact, excludes subagents)) -->
3. Session directories themselves are left intact so the agent can still resolve project paths. <!-- @impl: entrypoint.sh::cleanup_old_transcripts --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (cleanup_old_transcripts / REQ-STOR-012 (keeps 5 newest .jsonl, deletes older, leaves session dirs intact, excludes subagents)) -->
4. Cleanup deletions propagate to R2 automatically via the next bisync. <!-- @impl: entrypoint.sh::cleanup_old_transcripts --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (cleanup_old_transcripts / REQ-STOR-012 (keeps 5 newest .jsonl, deletes older, leaves session dirs intact, excludes subagents)) -->
5. Subagent transcripts are excluded from bisync entirely so they never reach R2. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (cleanup_old_transcripts / REQ-STOR-012 (keeps 5 newest .jsonl, deletes older, leaves session dirs intact, excludes subagents)) -->

**Constraints:**

- Cleanup steps must isolate non-zero exit codes so a benign cleanup failure cannot terminate the bisync daemon.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** [Automated test](../../host/__tests__/entrypoint-transcript-cleanup.test.js)

**Status:** Implemented

---

### REQ-STOR-014: R2 Storage Stats Caching


**Intent:** Storage statistics must be available quickly without paginating all R2 objects on every request.

**Applies To:** User

**Acceptance Criteria:**

1. The storage-stats endpoint paginates all R2 objects in the user's bucket and caches the aggregated result with a short TTL. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->
2. The session batch-status endpoint reuses the cached stats without an additional TTL check, relying on the source-of-truth cache for freshness. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->
3. Mutation endpoints (upload, delete, seed) invalidate the stats cache after a successful operation so the next read reflects the change. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->
4. The cache entry embeds the tier-configured quota value so cache hits do not have to resolve tier configuration. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The stats endpoint has its own rate-limit budget separate from browse, upload, and download so a heavy stats poller cannot starve other operations.
- A cache miss triggers a full R2 listing which may be slow for large buckets; callers must tolerate elevated latency on miss.

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-STOR-015: Explicit Sync Trigger from UI


**Intent:** Because the periodic bisync cadence is 15 minutes ([REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), users must have explicit ways to force convergence between the container filesystem and R2 without waiting for the next cycle.

**Applies To:** User

**Acceptance Criteria:**

1. The sync-trigger endpoint fans out an immediate sync to every running session belonging to the authenticated user. Stopped sessions are skipped client-side using the session batch-status output before fan-out. <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (fanOutBisyncTrigger (REQ-STOR-015 backfill)) -->
2. Fan-out runs in parallel with a bounded concurrency cap; remaining sessions are queued so a user with many concurrent sessions cannot exhaust Worker subrequest budget. <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (fanOutBisyncTrigger (REQ-STOR-015 backfill)) -->
3. Per-session failures are isolated: one session's bisync failure does not prevent other sessions from completing. The response carries per-session sync status. <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (fanOutBisyncTrigger (REQ-STOR-015 backfill)) -->
4. The sync-trigger endpoint is rate-limited per user using the same destructive-action rate-limiter pattern applied to other expensive endpoints. <!-- @impl: src/routes/session/lifecycle.ts::sessionsSyncRateLimiter -->
5. The trigger is idempotent: an external trigger to the bisync daemon while a bisync is already in flight causes exactly one rerun after the current cycle completes (N concurrent triggers coalesce to one rerun, not N). <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (SIGUSR1 interrupts the cadence sleep and triggers bisync immediately (REQ-STOR-003 AC2 / REQ-STOR-015 AC5 / REQ-MEM-004 AC4: SIGUSR1 trigger)) -->
6. The frontend Sync-now control is disabled while any of the user's sessions reports an in-flight sync and re-enables once all sessions transition out. <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser / REQ-STOR-016 AC1/AC2 (file browser drawer/bottom-sheet presentation, R2 as source of truth via Worker API)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Sync runs only on the periodic cadence ([REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), explicit user action, or final shutdown ([REQ-STOR-005](#req-stor-005-graceful-shutdown-performs-final-sync)).
- R2 uploads never fan out automatically; users trigger sync or await the periodic cycle, avoiding subrequest bursts during multi-file uploads.
- Multi-session fan-out is safe under the newest-file-wins bisync semantics: the merge operation is commutative and associative under absolute modification time, so parallel and serial fan-out produce the same final R2 state per file.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-STOR-007](#req-stor-007-web-file-browser), [REQ-STOR-011](#req-stor-011-sync-mode-controls-workspace-scope)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-STOR-016: File browser presentation and traversal safety


**Intent:** The web file browser must present consistently across form factors, treat R2 as the single source of truth (not the container filesystem), and reject directory-traversal probes at the prefix-listing endpoint.

**Applies To:** User

**Acceptance Criteria:**

1. The file browser renders as a slide-in side drawer on desktop and a bottom-sheet on mobile. <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser / REQ-STOR-016 AC1/AC2 (file browser drawer/bottom-sheet presentation, R2 as source of truth via Worker API)) -->
2. The file browser reads directly from R2 via the Worker API (not from the container filesystem). <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser / REQ-STOR-016 AC1/AC2 (file browser drawer/bottom-sheet presentation, R2 as source of truth via Worker API)) -->
3. The browse endpoint validates the requested prefix against directory-traversal probes and rejects parent-directory references. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/routes/storage-browse.test.ts (Storage Browse Routes / REQ-STOR-007 (web file browser: browse endpoint with prefix validation, rate-limited)) -->
4. Clicking a file in the browser opens it inline in a new browser tab (view) rather than downloading it. <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (FileList — clicking a file opens it in a new tab (not download)) -->
5. Every folder row surfaces its in-container path in `~/<prefix>` form so the user can see where it maps, at any depth and including dotfolders. <!-- @impl: web-ui/src/components/storage/FileList.tsx::folderShortPath --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (FileList — every folder surfaces its ~/ container path (REQ-STOR-016)) -->
6. A special folder surfaces its canonical container-path mapping instead of the derived form, since its prefix casing can differ (`workspace/` maps to `~/Workspace`). <!-- @impl: web-ui/src/components/storage/FileList.tsx::shortContainerPath --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (FileList — special folder surfaces its container path on the row) -->
7. Reaching the list end requests the next R2 page and appends unique rows in order; a stale continuation cannot alter newer navigation, a failed continuation preserves existing rows and can retry the same token, and periodic listing replacement stops after pagination begins while statistics continue refreshing. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @impl: web-ui/src/components/storage/FileList.tsx::FileList --> <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-016 AC7: appends a continuation page once and deduplicates rows) --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-016 AC7: ignores a continuation response from an older browse generation) --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-016 AC7: preserves rows on failure and retries the same continuation) --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (REQ-STOR-016 AC7: requests the next page only at the scroll boundary) --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (renders the loading footer structurally while a continuation is active) --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (delegates continuation error retry to the store) --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (REQ-STOR-016 AC7: suppresses listing refresh after pagination starts while stats continue) -->

**Notes:** Manual presentation procedures remain in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist); continuation behavior and timer ownership are documented in [Storage and Sync](../../documentation/lanes/storage-and-sync.md#file-browser-req-stor-016). AC7 tests were authored before implementation; their static RED reasons were the absent `loadMore`/retry/state contract, absent scroll-boundary delegation/footer states, and the timer's unconditional page-one refresh.

**Constraints:**

- The file browser and settings panel are mutually exclusive in the UI.

**Priority:** P1

**Dependencies:** [REQ-STOR-007](#req-stor-007-web-file-browser)

**Verification:** [Storage store tests](../../web-ui/src/__tests__/stores/storage.test.ts), [file-list behavior tests](../../web-ui/src/__tests__/components/FileList.test.tsx), [Storage Browser timer tests](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx), and the [manual presentation checklist](../../documentation/lanes/architecture.md#manual-verification-checklist)

**Status:** Implemented

---

### REQ-STOR-017: Faster startup sync — bisync HEAD-storm fix + Governed Mode preseed bake


**Intent:** Startup and steady-state sync must not waste time on avoidable R2 round-trips, and startup must not re-pay work the image already did. Three costs are addressed: (a) the steady-state bisync issued one HEAD per object to read its mtime metadata (the dominant sync cost, ~2,900 HEADs/cycle on a populated bucket); (b) the blocking initial sync re-downloads the entire agent seed (~627 files, ~9 MB — about half of a populated bucket) every boot, because the container filesystem is ephemeral and the seed lives only in R2; and (c) the Pi extension jiti prewarm cache misses every session, re-transpiling the first-party extensions (~2.4s on the advanced set) even though the image already baked them. Cost (a) is fixed with server-modtime bisync; (b) is eliminated in Governed Mode by laying down an image-baked seed locally and letting a content-checksum sync transfer only the user's deltas; (c) is fixed because jiti keys its cache on *where* a file sits as well as its bytes, so the image warms the cache at the real runtime agent dir and the entrypoint relays the managed extension content over the synced tree in all modes, making both the path and content halves match. Persisted sync must also be unable to restore retired managed Pi extensions.

**Applies To:** User

**Acceptance Criteria:**

1. Both bisync invocations (the retrying `--resync` baseline and steady-state cycle) compare object freshness via R2 `LastModified` from the bulk `--fast-list` (`--use-server-modtime`) instead of a per-object mtime HEAD, and run with `--checkers 64`, eliminating the per-file HEAD storm. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 / AD88: bisync uses server-modtime + wider checkers (entrypoint.sh)) -->
2. The container image bakes the agent seed as an on-disk file tree, materialized from the single generated seed source, byte-identical to the set seeded to R2 for each session mode (the tier-gated context-mode subtree is excluded — it delta-syncs from R2). <!-- @impl: scripts/materialize-agent-seed.mjs::CONTEXT_MODE_KEY_PREFIX --> <!-- @test: src/__tests__/lib/agent-seed-bake.test.ts (agent-seed bake byte-identity (REQ-STOR-017 / AD90)) -->
3. In Governed Mode (R2 SSE-C disabled), the entrypoint lays the mode-appropriate baked seed into the user home before the initial sync, and the initial sync compares by `--checksum` (usable MD5 ETags) so it skips the unchanged seed files and transfers only user deltas. <!-- @impl: entrypoint.sh::lay_down_agent_seed_preseed --> <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 / AD90: image-baked agent-seed lay-down (entrypoint.sh lay_down_agent_seed_preseed)) -->
4. Pi's jiti prewarm cache hits in every deployment mode: entrypoint relays existing managed extensions from the unfiltered image while preserving mode gates. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 / AD90: post-sync managed Pi extension relay (entrypoint.sh relay_managed_pi_extensions)) -->
5. The background-init subshell runs concurrently with the PTY pre-warm on the single vCPU, so it self-deprioritizes so pi pre-warm preempts it for CPU and disk. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017: background init yields CPU/disk to pi pre-warm (entrypoint.sh)) -->
6. Every R2 sync excludes the exact retired Pi durable-review extension paths, so stale persisted copies cannot return before runtime initialization. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 AC6: retired Pi review extensions stay outside R2 sync) -->
7. The managed-extension relay prunes the exact retired durable-review filenames locally before Pi loads. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 AC7: removes retired durable-review extensions without deleting user additions) -->

**Constraints:**

- The preseed bake + `--checksum` initial sync are gated on Governed Mode.
- The bake is derived in-image from the committed, freshness-enforced `src/lib/agent-seed.generated.ts`, so it never drifts from the seed and needs no host.
- The jiti prewarm cache key is `hash(absolute path + source + version)` — path-sensitive, not content-only — so both the warm-bake path and the relayed runtime content must match the build for a cache hit.
- The jiti bake is a fail-closed build gate: after the warm bake the image asserts every extension in the source dir produced a baked cache.
- Retired-name pruning is exact and preserves every unrelated user-added extension.

**Priority:** P2

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-ENTERPRISE-018](enterprise-mode.md#req-enterprise-018-governed-mode-toggle-and-configuration-surface)

**Verification:** [Bisync server-modtime + lay-down/compare-flag + managed-extension relay + background-init deprioritization test](../../host/__tests__/entrypoint-governed-sync.test.js) (AC1, AC3–AC7); [bake byte-identity test](../../src/__tests__/lib/agent-seed-bake.test.ts) (AC2)

**Status:** Implemented
