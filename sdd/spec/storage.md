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
- **Herdr live-process persistence** -- Running shells, arbitrary processes, pane history, sockets, logs, updater state, and container-local settings never enter R2. Herdr's structural `session.json` snapshot is the sole durable Herdr artifact and follows the normal `.codeflare` sync cadence.

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

1. The bucket identity is resolved deterministically through a strongly consistent Durable Object ownership claim; unambiguous legacy assignments remain stable and later sanitization collisions use a digest-suffixed v2 name. <!-- @impl: src/lib/access.ts::resolveBucketName --> <!-- @impl: src/container/index.ts::claimBucketOwner --> <!-- @test: src/__tests__/lib/access.test.ts (resolveBucketName / REQ-AUTH-006 tenant isolation) --> <!-- @test: src/__tests__/container/index.test.ts (claimBucketOwner / REQ-STOR-001 tenant isolation) -->
2. The bucket is auto-created via the Cloudflare API on first container start when it does not already exist. <!-- @impl: src/lib/r2-admin.ts::createBucketIfNotExists --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC2 (createBucketIfNotExists is idempotent and race-safe)) -->
3. No API endpoint may read, mutate, or delete objects from a bucket the acting user does not own; authentication, setup, billing, preferences, administration, and offboarding resolve the strongly claimed identity before bucket access, while unresolved legacy collisions fail closed. <!-- @impl: src/lib/access.ts::resolveBucketName --> <!-- @impl: src/lib/user-cleanup.ts::cleanupUserData --> <!-- @test: src/__tests__/lib/access.test.ts (resolveBucketName / REQ-AUTH-006 tenant isolation) -->
4. Concurrent authenticated requests resolve the same owned bucket without rate-limit failures. <!-- @impl: src/lib/access.ts::resolveBucketName --> <!-- @test: src/__tests__/lib/access.test.ts (does not project ownership into a same-key KV hot path during a 52-request burst) -->

**Constraints:**

- Bucket naming complies with R2's object-storage naming rules (lowercase, no special characters beyond hyphens).
- Bucket creation is idempotent: invoking it against an existing bucket is a no-op, not an error.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([r2-config](../../src/__tests__/lib/r2-config.test.ts))

**Status:** Implemented

---

### REQ-STOR-002: File Persistence Across Sessions

**Intent:** User files must survive container destruction and be available when a new session starts, because containers are ephemeral.

**Applies To:** User

**Acceptance Criteria:**

1. Files written during a session are readable in a subsequent session after the container is recreated. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->
2. Agent configuration directories and per-user dotfiles persist across sessions. The per-path inventory lives in [documentation/lanes/storage-and-sync.md](../../documentation/lanes/storage-and-sync.md#whats-synced-vs-excluded-req-stor-011). <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->
3. Workspace files persist across sessions when the user has enabled full workspace sync. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->
4. A hook script the sync restored or rewrote is executable again before it is next invoked, since a hook registered by bare path is spawned through its shebang. <!-- @impl: entrypoint.sh::repair_hook_exec_bits --> <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-hook-exec-bits.test.js (restores +x on hook scripts a sync stripped, leaving other files alone) --> <!-- @test: host/__tests__/entrypoint-hook-exec-bits.test.js (repairs and can execute a hook after a successful bisync) -->

**Constraints:**

- R2 is the durable store; the local filesystem is ephemeral.
- Persistence depends on at least one successful sync completing before container shutdown.
- R2 round-trips content and modification time only; each sync re-establishes local executable modes.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated test ([Integration test](../../host/__tests__/entrypoint-bisync-behavior.test.js), [hook exec-bit repair](../../host/__tests__/entrypoint-hook-exec-bits.test.js))

**Status:** Implemented

---

### REQ-STOR-003: Bidirectional Sync Every 15 Minutes (with Manual Triggers)

**Intent:** Changes made locally (by the agent or user) and changes in R2 (from the file browser or another session's sync) must converge within a bounded interval, balanced against R2 operation cost. The 15-minute cadence is supplemented by explicit user-driven triggers ([REQ-STOR-015](#req-stor-015-explicit-sync-trigger-from-ui)) so the user is never blocked waiting for a cycle when they want fresh state.

**Applies To:** User

**Acceptance Criteria:**

1. After the bisync baseline is established, a periodic bisync runs on a 15-minute cadence. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->
2. External triggers interrupt daemon sleep for immediate bisync and coalesce during an active cycle into one rerun ([REQ-STOR-015](#req-stor-015-explicit-sync-trigger-from-ui)). <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (SIGUSR1 interrupts the cadence sleep and triggers bisync immediately (REQ-STOR-003 AC2 / REQ-STOR-015 AC5 / REQ-MEM-004 AC4: SIGUSR1 trigger)) -->
3. Conflict resolution is newest-file-wins. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @manual -->
4. The daemon retries on transient failure and continues the periodic cycle. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (daemon retries after transient failure and continues the cycle (REQ-STOR-003 AC4)) -->
5. On bisync failure, the daemon attempts vanishing-file recovery (parse the error output, exclude transient files, clear stale locks, retry) before counting the failure against the failure budget. <!-- @impl: entrypoint.sh::recover_vanished_files --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (failure + vanishing-file recovery retries bisync and clears CONSECUTIVE_FAILURES (REQ-STOR-003 AC5)) -->
6. The default fallback remains three consecutive unrecoverable failures (each with internal retries exhausted). When exit code 7 coincides with a missing prior listing, the daemon immediately re-establishes a resync baseline because two more attempts cannot use absent state. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (three consecutive failures trigger --resync fallback (REQ-STOR-003 AC6 / REQ-STOR-002 AC1: resync re-establishes baseline so next sync can persist files)) --> <!-- @manual: Remove the listing, force exit 7, and confirm the first failed cycle enters baseline re-establishment. -->

**Constraints:**

- Bisync invocations must tolerate files changing mid-transfer (no false hash-mismatch aborts).
- Bulk deletions in the workspace must propagate (no conservative delete cap that strands removals locally).
- Post-sync listing validation must not abort the cycle when R2 changes during the sync window.
- Empty files are excluded from sync.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket), [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated test ([entrypoint-bisync-behavior](../../host/__tests__/entrypoint-bisync-behavior.test.js))

**Status:** Implemented

---

### REQ-STOR-004: Initial Sync Restores Files on Container Start

**Intent:** When a container boots, it must restore the user's persisted files from R2 before the agent or terminal becomes usable.

**Applies To:** User

**Acceptance Criteria:**

1. A one-way sync from R2 to local runs as the first initialization step after the in-container terminal server is ready to accept connections, blocking further startup until it completes. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @manual -->
2. The initial sync completes or times out within a bounded duration so the session is never blocked indefinitely on a slow R2 fetch. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @manual: Start a session against a deliberately stalled R2 endpoint and confirm startup leaves the blocking sync phase within its configured bound. -->
3. All per-agent config file modifications complete after the initial sync but before the bisync baseline, so the baseline observes a stable snapshot. The per-agent file enumeration lives in [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md). <!-- @impl: entrypoint.sh::run_managed_curation_startup --> <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-031 AC1/AC2/AC7: restores managed content and declared image companions before baseline) --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (executes the reachable baked restore, relay, cleanup, and baseline in order when curation is disabled) --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
4. A bisync baseline is established after the post-sync file modifications complete. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings merge runs before bisync baseline) -->
5. Vanished non-workspace files enter the recovery filter before retry; vanished workspace files retry without exclusion. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-vanished-file-recovery.test.js (adds a vanished NON-workspace file to the session recovery filter and signals retry (REQ-STOR-004 AC5)) -->
6. Known per-session ephemeral agent-state files are statically excluded from all sync operations, including Codex plugin/general caches and log databases, Copilot SQLite temporary files, and Claude workflow artifacts. The full per-path inventory lives in [documentation/lanes/storage-and-sync.md](../../documentation/lanes/storage-and-sync.md#whats-synced-vs-excluded-req-stor-011). <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (statically excludes ephemeral caches, repo graphify-out, and R2 secrets in both modes (REQ-STOR-004 AC6 / REQ-AGENT-026 AC1)) -->
7. The bisync daemon starts unconditionally after the baseline phase, even if all baseline attempts fail; a dead daemon would mean zero sync for the entire session, and the daemon already has its own recovery path (vanishing-file recovery plus resync fallback). <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->

**Constraints:**

- The bisync-initialized marker must be set even on the timeout path so the shutdown handler still attempts the final sync.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-STOR-005: Graceful Shutdown Performs Final Sync

**Intent:** When a container is stopped or evicted, unsaved local changes must reach R2 before exit. The awaited live drain in [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync) is authoritative, while the signal-triggered final sync remains a bounded best-effort backstop.

**Applies To:** User

**Acceptance Criteria:**

1. A termination handler runs a final bisync before the process exits (best-effort backstop; the primary guarantee is the live drain in [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync)). <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
2. The final bisync runs only when the bisync-initialized marker is set. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
3. Files created during the session are available in R2 after shutdown completes successfully. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @manual -->
4. The final bisync runs under a hard watchdog. If it has not completed before the watchdog expires the process is force-killed; the user accepts that the last writes may not have synced. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
5. The container orchestrator's destroy budget exceeds the final-sync watchdog by enough time for a clean process exit so the orchestrator does not tear down mid-sync. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Constraints:**

- The shutdown handler's watchdog and the orchestrator's destroy budget must remain coordinated: destroy budget > watchdog + exit time.
- The final bisync uses the same correctness flags as the periodic bisync so behavior at shutdown matches steady-state.

**Priority:** P0

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-STOR-006: Storage Quota Enforced Per Tier at Session Start

**Intent:** Users must not be able to start new sessions when their storage usage exceeds their tier's quota, preventing unbounded R2 consumption.

**Applies To:** User

**Acceptance Criteria:**

1. Session creation reads the cached storage-usage figure and compares it to the user's tier-configured maximum. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) --> <!-- @manual -->
2. If current usage exceeds the configured maximum, session creation is rejected with a clear user-facing error. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) --> <!-- @manual -->
3. The storage-stats endpoint returns both current usage and the configured maximum so the UI can render an "X of Y" indicator. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) --> <!-- @manual -->
4. An unset maximum is interpreted as unlimited and skips enforcement entirely. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) --> <!-- @manual -->
5. When tier configuration adds new fields, previously persisted records inherit the new field's default rather than appearing unset. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->

**Constraints:**

- Quota is checked at session start only; mid-session file uploads, sync writes, and preseed writes are not blocked.
- Users may temporarily exceed quota during an active session; the overage is caught at the next session-start attempt.
- The stats cache embeds the quota value so cache hits skip tier-configuration resolution.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-STOR-014](#req-stor-014-r2-storage-stats-caching)

**Verification:** Automated test ([storage-stats](../../src/__tests__/routes/storage-stats.test.ts))

**Status:** Implemented

---

### REQ-STOR-007: Web File Browser

**Intent:** Users must be able to browse, upload, download, delete, and preview files in their R2 storage via HTTP endpoints, without using the terminal.

**Applies To:** User

**Acceptance Criteria:**

1. The browse endpoint lists objects under a given R2 prefix with directory-style navigation. <!-- @test: src/__tests__/routes/storage-browse.test.ts (Storage Browse Routes / REQ-STOR-007 (web file browser: browse endpoint with prefix validation, rate-limited)) --> <!-- @impl: src/routes/storage/browse.ts::app -->
2. The upload endpoint stores a file at a specified R2 key. <!-- @test: src/__tests__/routes/storage-upload.test.ts (exhausting limit on /upload/initiate causes a subsequent /upload/part to 429) --> <!-- @manual -->
3. The download endpoint returns file contents as an attachment with a sanitized filename. <!-- @impl: src/routes/storage/download.ts::buildContentDisposition --> <!-- @test: src/__tests__/routes/storage-download.test.ts (Storage Download Routes) -->
4. The delete endpoint removes objects by key and/or prefix in a single server-side bulk operation. <!-- @impl: src/routes/storage/delete.ts::app --> <!-- @test: src/__tests__/routes/storage-delete.test.ts (Storage Delete Route) -->
5. The preview endpoint returns text content inline for text files and metadata-only for other types. <!-- @test: src/__tests__/routes/storage-preview.test.ts (Storage Preview Routes) --> <!-- @manual -->
6. On request, the download endpoint serves a file inline for in-browser viewing rather than as an attachment when the caller passes `?disposition=inline`. <!-- @impl: src/routes/storage/download.ts::INLINE_IMAGE_TYPES --> <!-- @test: src/__tests__/routes/storage-download.test.ts (REQ-STOR-007: serves an inline image with its real type, inline disposition, and nosniff) -->
7. The inline view path enforces an XSS-safe content-type: known image types and PDF keep their real MIME type while all other types, including HTML and SVG, are served as inert text so user-supplied markup cannot execute in the user's session. <!-- @impl: src/routes/storage/download.ts::safeInlineContentType --> <!-- @test: src/__tests__/routes/storage-download.test.ts (safeInlineContentType) -->

**Constraints:**

- All R2 read and write operations use SSE-C when server-side encryption is configured.
- Each endpoint has its own per-user rate limit appropriate to its expected access pattern.
- UI presentation, architectural source-of-truth, and prefix-traversal validation are specified in [REQ-STOR-016](#req-stor-016-file-browser-presentation-and-traversal-safety).

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-STOR-008: Multipart Upload for Large Files

**Intent:** Files larger than the single-request upload limit must be uploadable via chunked multipart upload.

**Applies To:** User

**Acceptance Criteria:**

1. The multipart initiate endpoint creates a multipart upload and returns an upload identifier. <!-- @test: src/__tests__/routes/storage-upload.test.ts (Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)) --> <!-- @manual -->
2. The multipart part endpoint uploads a single part for a given upload identifier. <!-- @test: src/__tests__/routes/storage-upload.test.ts (Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)) --> <!-- @manual -->
3. The multipart complete endpoint finalizes the upload by assembling the recorded parts into the final object. <!-- @impl: src/routes/storage/upload.ts::CompleteUploadBodySchema --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)) -->
4. The authenticated, bucket-scoped multipart abort endpoint reports success only when R2 accepts the abort; non-2xx responses fail the request rather than claiming cleanup. <!-- @impl: src/routes/storage/upload.ts::default --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)) -->
5. All multipart endpoints share a single rate-limit bucket so an attacker cannot bypass the upload limit by interleaving phases. <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-STOR-008 AC5: shared rate limit across multipart endpoints) --> <!-- @manual -->

**Constraints:**

- Each uploaded part is encrypted with SSE-C when server-side encryption is configured.
- The multipart upload endpoints are exempt from the body-size limit applied to other API routes so chunked uploads can carry binary payloads.

**Priority:** P1

**Dependencies:** [REQ-STOR-007](#req-stor-007-web-file-browser)

**Verification:** Automated test ([storage-upload](../../src/__tests__/routes/storage-upload.test.ts))

**Status:** Implemented

---

### REQ-STOR-009: Getting-Started Docs Auto-Seeded on First Session

**Intent:** New users must find starter documentation in their storage on first use so they have immediate orientation material. Because a freshly created bucket is not always immediately writable on the R2 data plane, seeding must be self-healing rather than a single best-effort attempt at creation time.

**Applies To:** User

**Acceptance Criteria:**

1. When a user's R2 bucket is created for the first time, tutorial documents are written to the bucket root. <!-- @impl: src/lib/r2-seed.ts::seedGettingStartedDocs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedGettingStartedDocs / REQ-STOR-009 (per-user R2 bucket seeded with getting-started docs on first access)) -->
2. A seed endpoint allows the user to manually re-seed the tutorial content, optionally overwriting existing files. <!-- @manual -->
3. After a successful seed, the storage-stats cache is invalidated so the next poll returns fresh data. <!-- @test: src/__tests__/routes/storage-seed.test.ts (invalidates storage-stats KV cache after successful getting-started seed) --> <!-- @manual -->
4. The seed endpoint is rate-limited at a low ceiling appropriate to its destructive-overwrite mode. <!-- @impl: src/routes/storage/seed.ts::storageSeedRateLimiter --> <!-- @test: src/__tests__/routes/rate-limits.test.ts (POST /seed/getting-started - storage-seed (3/min)) -->
5. The first-session seed retries on a transient failure (e.g. a freshly created bucket not yet writable on the S3 data plane, or R2 credentials still propagating right after setup) with bounded backoff, so a new bucket reliably ends up seeded. <!-- @impl: src/lib/r2-seed.ts::seedGettingStartedDocs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedGettingStartedDocs / REQ-STOR-009 (per-user R2 bucket seeded with getting-started docs on first access)) -->
6. Getting-started doc seeding is self-healing and is not gated solely on first bucket creation: on session start, when the seed-complete preference marker is not set, the idempotent seed is re-attempted. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (ensureBucketAndSeed) -->

**Constraints:**

- Seeding is idempotent in non-overwrite mode: files that already exist at the target keys are skipped, never duplicated.
- Tutorial source content is a build-time artifact; the spec governs *that* it ships, not where the source lives.
- The self-healing seed must not clobber user edits: it runs in non-overwrite mode, and once the success marker is set it does not re-run.

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated test

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

- Reconciliation activation and ownership semantics follow [REQ-STOR-033](#req-stor-033-managed-release-delta-planning-and-resume): explicit re-seed and mode changes overwrite desired keys, while automatic upgrades preserve release-identical keys.
- Only files the build never seeded are preserved as the user's own outside automatic managed-release delta semantics ([REQ-STOR-019](#req-stor-019-seeded-files-are-marked-and-retired-ones-are-removed)).
- No duplicate preseed source files exist on disk; all agent variants are generated from the Claude Code preseed as the single source of truth.
- Preseed configuration must validate that no two entries within a single mode share the same key.

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated test ([r2-seed](../../src/__tests__/lib/r2-seed.test.ts))

**Status:** Implemented

---

### REQ-STOR-011: Sync Mode Controls Workspace Scope

**Intent:** Users must be able to choose how much of their workspace is synced to R2, balancing persistence against sync overhead.

**Applies To:** User

**Acceptance Criteria:**

1. The default sync scope (`none`) syncs only settings and config directories and excludes the workspace directory entirely. <!-- @impl: entrypoint.sh::SYNC_MODE --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->
2. The full sync scope (`full`) syncs the entire workspace directory, excluding dependency-install directories. <!-- @impl: entrypoint.sh::SYNC_MODE --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->
3. The metadata sync scope (`metadata`) syncs only the agent-config files (per-repo agent instruction files and the per-repo agent rule directory). <!-- @impl: entrypoint.sh::SYNC_MODE --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->
4. All sync scopes exclude package-manager and sync-tool caches, agent logs and ephemeral data, build artifacts, regenerable tool state, and on-demand vendor credential caches; the path inventory is documented in [Storage & Sync](../../documentation/lanes/storage-and-sync.md#whats-synced-vs-excluded-req-stor-011). <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->

**Constraints:**

- Sync configuration uses filter rules with explicit precedence (not order-sensitive include/exclude lists) so the active scope is unambiguous when multiple rules match.
- The Container API surface currently exposes only the binary workspace-sync toggle (full or none); the metadata scope is reachable only by direct sync-mode configuration.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** Automated test ([entrypoint-hooks-merge](../../host/__tests__/entrypoint-hooks-merge.test.js))

**Status:** Implemented

---

### REQ-STOR-012: Main Session Transcript Cleanup

**Intent:** Claude Code and Pi main-session transcripts must be pruned without trusting restored filesystem modification times, preventing unbounded R2 growth while preserving resumable recent work.

**Applies To:** User

**Acceptance Criteria:**

1. Cleanup searches only the Claude Code and Pi main-session stores; native child directories and all Codex stores remain outside cleanup. <!-- @impl: transcript-retention.mjs::discoverTranscripts --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (main transcript retention / REQ-STOR-012) -->
2. R2 transcript persistence retains the existing exclusions for Claude child artifacts, Pi task transcripts, and Codex session recordings. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-012: child transcripts stay outside R2 sync) -->
3. Each agent independently retains at most ten main transcript files across all nested directories, ranked by recoverable native activity with a deterministic path tie-breaker. <!-- @impl: transcript-retention.mjs::retainLatest --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (main transcript retention / REQ-STOR-012) -->
4. If one candidate has an unsupported shape or no recoverable native activity, that entire agent retains ten files by deterministic filesystem modification time instead. <!-- @impl: transcript-retention.mjs::parseClaudeTimestamp --> <!-- @impl: transcript-retention.mjs::parsePiTimestamp --> <!-- @impl: transcript-retention.mjs::retainLatest --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (main transcript retention / REQ-STOR-012) -->
5. Cleanup changes only selected candidate files; every non-candidate path remains untouched. <!-- @impl: transcript-retention.mjs::retainLatest --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (main transcript retention / REQ-STOR-012) -->
6. Restored transcript candidates are pruned before the first agent PTY is released. <!-- @impl: entrypoint.sh::release_agent_pty_after_cleanup --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (main transcript retention / REQ-STOR-012) -->
7. Every regular or final bisync attempts transcript cleanup first and still proceeds when cleanup fails. <!-- @impl: entrypoint.sh::cleanup_main_transcripts --> <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (main transcript retention / REQ-STOR-012) -->

**Constraints:**

- Adapter paths and native schema checks live in [storage-and-sync.md](../../documentation/lanes/storage-and-sync.md#session-transcript-cleanup); recoverable malformed records retain native ordering, while content heuristics and Codeflare capture/extraction state never classify candidates.
- Codex retains its existing storage and filtering behavior.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** Automated test ([entrypoint-transcript-cleanup](../../host/__tests__/entrypoint-transcript-cleanup.test.js))

**Status:** Implemented

---

### REQ-STOR-014: R2 Storage Stats Caching

**Intent:** Storage statistics must be available quickly without paginating all R2 objects on every request.

**Applies To:** User

**Acceptance Criteria:**

1. The storage-stats endpoint paginates all R2 objects in the user's bucket and caches the aggregated result with a short TTL. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) --> <!-- @manual -->
2. The session batch-status endpoint reuses the cached stats without an additional TTL check, relying on the source-of-truth cache for freshness. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) -->
3. Mutation endpoints (upload, delete, seed) invalidate the stats cache after a successful operation so the next read reflects the change. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) --> <!-- @manual -->
4. The cache entry embeds the tier-configured quota value so cache hits do not have to resolve tier configuration. <!-- @test: src/__tests__/routes/storage-stats.test.ts (Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)) --> <!-- @manual -->

**Constraints:**

- The stats endpoint has its own rate-limit budget separate from browse, upload, and download so a heavy stats poller cannot starve other operations.
- A cache miss triggers a full R2 listing which may be slow for large buckets; callers must tolerate elevated latency on miss.

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated test ([storage-stats](../../src/__tests__/routes/storage-stats.test.ts))

**Status:** Implemented

---

<a id="req-stor-015-user-triggered-multi-session-sync"></a>
### REQ-STOR-015: Explicit Sync Trigger from UI

**Intent:** Because the periodic bisync cadence is 15 minutes ([REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), users must have explicit ways to force convergence between the container filesystem and R2 without waiting for the next cycle.

**Applies To:** User

**Acceptance Criteria:**

1. The sync-trigger endpoint fans out an immediate sync to every running session belonging to the authenticated user. Stopped sessions are skipped client-side using the session batch-status output before fan-out. <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (fanOutBisyncTrigger (REQ-STOR-015 backfill)) -->
2. Fan-out runs in parallel with a bounded concurrency cap; remaining sessions are queued so a user with many concurrent sessions cannot exhaust Worker subrequest budget. <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (fanOutBisyncTrigger (REQ-STOR-015 backfill)) -->
3. Per-session failures are isolated: one session's bisync failure does not prevent other sessions from completing. The response carries per-session sync status. <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (fanOutBisyncTrigger (REQ-STOR-015 backfill)) -->
4. The sync-trigger endpoint is rate-limited per user using the same destructive-action rate-limiter pattern applied to other expensive endpoints. <!-- @impl: src/routes/session/lifecycle.ts::sessionsSyncRateLimiter --> <!-- @manual -->
5. The trigger is idempotent: an external trigger to the bisync daemon while a bisync is already in flight causes exactly one rerun after the current cycle completes (N concurrent triggers coalesce to one rerun, not N). <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (SIGUSR1 interrupts the cadence sleep and triggers bisync immediately (REQ-STOR-003 AC2 / REQ-STOR-015 AC5 / REQ-MEM-004 AC4: SIGUSR1 trigger)) -->
6. The frontend Sync-now control is disabled while any of the user's sessions reports an in-flight sync and re-enables once all sessions transition out. <!-- @impl: web-ui/src/components/storage/StorageToolbar.tsx::StorageToolbar --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (Sync-now fan-out button (REQ-STOR-015 AC6)) -->

**Constraints:**

- Sync runs only on the periodic cadence ([REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), explicit user action, or final shutdown ([REQ-STOR-005](#req-stor-005-graceful-shutdown-performs-final-sync)).
- R2 uploads never fan out automatically; users trigger sync or await the periodic cycle, avoiding subrequest bursts during multi-file uploads.
- Multi-session fan-out is safe under the newest-file-wins bisync semantics: the merge operation is commutative and associative under absolute modification time, so parallel and serial fan-out produce the same final R2 state per file.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-STOR-007](#req-stor-007-web-file-browser), [REQ-STOR-011](#req-stor-011-sync-mode-controls-workspace-scope)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-STOR-016: File browser presentation and traversal safety

**Intent:** The web file browser must present consistently across form factors, treat R2 as the single source of truth (not the container filesystem), and reject directory-traversal probes at the prefix-listing endpoint.

**Applies To:** User

**Acceptance Criteria:**

1. The file browser renders as a slide-in side drawer on desktop and a bottom-sheet on mobile. <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser / REQ-STOR-016 AC1/AC2 (file browser drawer/bottom-sheet presentation, R2 as source of truth via Worker API)) -->
2. The file browser reads directly from R2 via the Worker API (not from the container filesystem). <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser / REQ-STOR-016 AC1/AC2 (file browser drawer/bottom-sheet presentation, R2 as source of truth via Worker API)) -->
3. The browse endpoint validates the requested prefix against directory-traversal probes and rejects parent-directory references. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/routes/storage-browse.test.ts (Storage Browse Routes / REQ-STOR-007 (web file browser: browse endpoint with prefix validation, rate-limited)) -->
4. Clicking a file in the browser opens it inline in a new browser tab (view) rather than downloading it. <!-- @impl: web-ui/src/components/storage/FileList.tsx::FileList --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (FileList — clicking a file opens it in a new tab (not download)) -->
5. Every folder row surfaces its in-container path in `~/<prefix>` form so the user can see where it maps, at any depth and including dotfolders. <!-- @impl: web-ui/src/components/storage/FileList.tsx::folderShortPath --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (FileList — every folder surfaces its ~/ container path (REQ-STOR-016)) -->
6. A special folder surfaces its canonical container-path mapping instead of the derived form, since its prefix casing can differ (`workspace/` maps to `~/Workspace`). <!-- @impl: web-ui/src/components/storage/FileList.tsx::shortContainerPath --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (FileList — special folder surfaces its container path on the row) -->

**Constraints:**

- The file browser and settings panel are mutually exclusive in the UI.

**Priority:** P1

**Dependencies:** [REQ-STOR-007](#req-stor-007-web-file-browser)

**Verification:** Automated test ([File-list behavior tests](../../web-ui/src/__tests__/components/FileList.test.tsx), [Storage Browser component tests](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx))

**Status:** Implemented

---

### REQ-STOR-017: Faster startup sync — bisync HEAD-storm fix + Governed Mode preseed bake

**Intent:** Startup and steady-state sync must avoid unnecessary R2 round-trips, reuse image-baked seed and transpilation work, and never restore retired managed Pi extensions.

**Applies To:** User

**Acceptance Criteria:**

1. Both bisync invocations (the retrying `--resync` baseline and steady-state cycle) compare object freshness via R2 server modification times from the bulk listing instead of a per-object metadata request, and check up to 64 objects concurrently, eliminating the per-file HEAD storm. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 / AD88: bisync uses server-modtime + wider checkers (entrypoint.sh)) -->
2. The image-baked agent tree is byte-identical to each mode's generated R2 seed, excluding the independently synchronized context-mode subtree. <!-- @impl: scripts/materialize-agent-seed.mjs::CONTEXT_MODE_KEY_PREFIX --> <!-- @test: src/__tests__/lib/agent-seed-bake.test.ts (agent-seed bake byte-identity (REQ-STOR-017 / AD90)) -->
3. Governed Mode lays down the matching baked seed before checksum-based initial sync, transferring only changed user data. <!-- @impl: entrypoint.sh::lay_down_agent_seed_preseed --> <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 / AD90: image-baked agent-seed lay-down (entrypoint.sh lay_down_agent_seed_preseed)) -->
4. Pi's pre-transpilation cache hits in every deployment mode: entrypoint relays existing managed extensions from the unfiltered image, backfills managed extensions missing from the post-sync runtime out of the mode-filtered bake, and preserves mode gates. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 / AD90: post-sync managed Pi extension relay (entrypoint.sh relay_managed_pi_extensions)) --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (backfills a managed extension missing from the runtime from the mode-filtered bake) -->
5. The background-init subshell runs concurrently with the PTY pre-warm on the single vCPU, so it self-deprioritizes so pi pre-warm preempts it for CPU and disk. <!-- @impl: entrypoint.sh::renice --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017: background init yields CPU/disk to pi pre-warm (entrypoint.sh)) -->
6. Every R2 sync excludes the exact retired Pi durable-review extension paths, so stale persisted copies cannot return before runtime initialization. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 AC6: retired Pi review extensions stay outside R2 sync) -->
7. The managed-extension relay prunes the exact retired durable-review filenames locally before Pi loads. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 AC7: removes retired durable-review extensions without deleting user additions) -->

**Constraints:**

- The preseed bake + `--checksum` initial sync are gated on Governed Mode.
- The bake is derived in-image from the committed, freshness-enforced `src/lib/agent-seed.generated.ts`, so it never drifts from the seed and needs no host.
- The jiti prewarm cache key is `hash(absolute path + source + version)` — path-sensitive, not content-only — so both the warm-bake path and the relayed runtime content must match the build for a cache hit.
- The jiti bake is a fail-closed build gate: after the warm bake the image asserts every extension in the source dir produced a baked cache.
- Retired-name pruning is exact and preserves every unrelated user-added extension.
- The missing-extension backfill sources only the mode-filtered bake, never the unfiltered warm tree, so a default-mode session cannot gain advanced-only extensions.

**Priority:** P2

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-ENTERPRISE-018](enterprise-mode.md#req-enterprise-018-governed-mode-toggle-and-configuration-surface)

**Verification:** Automated test ([Bisync server-modtime + lay-down/compare-flag + managed-extension relay + background-init deprioritization test](../../host/__tests__/entrypoint-governed-sync.test.js) (AC1, AC3–AC7); [bake byte-identity test](../../src/__tests__/lib/agent-seed-bake.test.ts) (AC2))

**Status:** Implemented

---

### REQ-STOR-018: File browser pagination is append-only and recoverable

**Intent:** Truncated R2 listings must remain navigable without replacing rows already shown or allowing stale continuation work to affect newer navigation.

**Applies To:** User

**Acceptance Criteria:**

1. A truncated listing exposes a continuation action even when the current rows do not fill a scrollable viewport. <!-- @impl: web-ui/src/components/storage/FileList.tsx::FileList --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (REQ-STOR-018 AC1: exposes continuation when the first page cannot scroll) -->
2. Reaching the list's scroll boundary requests the next R2 page once. <!-- @impl: web-ui/src/components/storage/FileList.tsx::FileList --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (REQ-STOR-018 AC2: requests the next page only at the scroll boundary) -->
3. A successful continuation appends unique rows in response order. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-018 AC3: appends a continuation page once and deduplicates rows) -->
4. A continuation response from an older browse generation cannot alter the current listing. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-018 AC4: ignores a continuation response from an older browse generation) -->
5. A failed continuation preserves the rows already loaded. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-018: preserves rows on failure and retries the same continuation) -->
6. Retrying a failed continuation reuses its continuation token. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-018: preserves rows on failure and retries the same continuation) -->
7. After pagination starts, periodic refresh updates statistics without replacing the accumulated listing. <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (REQ-STOR-018 AC7: suppresses listing refresh after pagination starts while stats continue) -->

**Constraints:**

- Explicit navigation or manual refresh starts a new browse generation and resets pagination state.
- Only one continuation request is active at a time.

**Priority:** P1

**Dependencies:** [REQ-STOR-007](#req-stor-007-web-file-browser), [REQ-STOR-016](#req-stor-016-file-browser-presentation-and-traversal-safety)

**Verification:** Automated test ([Storage store tests](../../web-ui/src/__tests__/stores/storage.test.ts), [file-list behavior tests](../../web-ui/src/__tests__/components/FileList.test.tsx), [Storage Browser timer tests](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx))

**Status:** Implemented

---

### REQ-STOR-019: Seeded Files Are Marked and Retired Ones Are Removed

**Intent:** Preseed files that a release stops shipping must leave existing user buckets instead of accumulating beside whatever replaced them, while files codeflare never wrote are never deleted.

**Applies To:** User

**Acceptance Criteria:**

1. Every seed write stamps a provenance marker in the object's R2 custom metadata whose value is the writing build's preseed content hash. <!-- @impl: src/lib/r2-seed.ts::seedDocuments --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (stamps the marker on every overwrite write) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (stamps the marker on writes issued by the non-overwrite path) -->
2. Reconcile cleanup deletes an object under the seed's own prefixes that carries a provenance marker other than the current build's. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (deletes an object carrying a different build marker) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (keeps an object carrying the current build marker) -->
3. An object with no provenance marker is never deleted by the sweep, which is what makes a user-created file and a user-edited seed file equally safe. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (keeps an unmarked object as the user file) -->
4. Listing is confined to the two-segment prefixes the seed writes, keeping both the getting-started documents and the large runtime trees outside the sweep's reach. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (lists only inside the seed two-segment prefixes) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (never HEADs a key under a runtime tree outside those prefixes) -->
5. A prefix that is not listed completely, or a candidate set past the fan-out cap, produces a warning and withholds deletion over the scope it cannot vouch for — that prefix for an incomplete listing, the whole sweep for the cap. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (warns and deletes nothing when a prefix cannot be listed) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (deletes nothing from a prefix whose listing failed part-way) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (treats a truncated page with no continuation token as a failed listing) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (skips the sweep and warns when the candidate set is implausibly large) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (skips the sweep when two prefixes are each under the cap but over it combined) -->
6. The generated seed enumerates every key no marker can identify — those shipped before the marker existed, recovered by walking the seed module's history, and product-generated files that were never seeded keys at all — and cleanup deletes them by name. <!-- @impl: src/lib/agent-seed.generated.ts::RETIRED_PRESEED_KEYS --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (sweeps the pre-marker list even when no key is out of mode) -->
7. A key the current build still seeds is never deleted, by the by-name path or by the sweep. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (never deletes a key the current build still seeds, by name or by sweep) -->

**Constraints:**

- The marker value identifies the writing build and is never used to infer staleness on its own; only an object outside the current build's key set is a candidate.
- A key the seed once shipped is never appended to the by-name list; the marker identifies it instead.
- The list grows only for a product-generated file that was never a seeded key at all.
- Deletion requires a provenance marker or by-name membership that positively identifies product-generated content; all unproven content is kept.
- The preseed content hash covers the by-name list, so shipping the list triggers the upgrade that applies it.
- The generator refuses to emit a by-name list naming a key the current build still seeds.
- Paths the agent runtime writes and owns are excluded from the sweep before the candidate cap is counted.

**Priority:** P1

**Dependencies:** [REQ-STOR-010](#req-stor-010-agent-configs-auto-seeded-based-on-session-mode), [REQ-AGENT-049](agents.md#req-agent-049-auto-upgrade-preseed-on-release)

**Verification:** Manual verification

**Status:** Implemented

---

### REQ-STOR-020: Managed environment reconciliation

**Intent:** Verified managed releases advance monotonically within one runtime dependency set while deployments may switch safely between distinct runtime sets.

**Applies To:** Admin

**Acceptance Criteria:**

1. Verified assets are content-addressed in one deployment cache. <!-- @impl: src/lib/remote-curation-cache.ts::activateManagedRelease --> <!-- @test: src/__tests__/lib/remote-curation-cache.test.ts (REQ-STOR-020 AC1+AC2: active release cache is content-addressed and monotonic) -->
2. Each trust configuration advances monotonically within one runtime dependency set without same-sequence conflicts. <!-- @impl: src/lib/remote-curation-cache.ts::activateManagedRelease --> <!-- @test: src/__tests__/lib/remote-curation-cache.test.ts (REQ-STOR-020 AC1+AC2: active release cache is content-addressed and monotonic) -->
3. Selecting a different deployed runtime dependency set may replace a globally newer incompatible pointer. <!-- @impl: src/lib/remote-curation-cache.ts::activateManagedRelease --> <!-- @test: src/__tests__/lib/remote-curation-cache.test.ts (replaces an incompatible active pointer even when its global sequence is higher) -->
4. Concurrent key selections for one repository settle on one authoritative winner. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
5. A losing concurrent selection makes at most four repair attempts. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
6. Reconfiguration fails explicitly when selection does not settle within the repair bound. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
7. Exhausted repair preserves the last observed authoritative selection. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->

**Constraints:** A losing selection cannot overwrite or roll back the winner.

**Priority:** P1

**Dependencies:** [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated cache and reconciliation tests

**Status:** Implemented

---

### REQ-STOR-021: Managed content ownership

**Intent:** Managed reconciliation preserves mutable user ownership while treating signed retirements as authoritative under an active protected policy.

**Applies To:** User

**Acceptance Criteria:**

1. Managed writes carry active release provenance. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC1 + REQ-STOR-024 AC2: Default and Advanced stream identical mode payloads with active release provenance) -->
2. A path proven obsolete by direct applied-to-target comparison is deleted in mutable mode only while it retains a valid Codeflare provenance marker; marker equality with the immediately applied release is not required. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC2 + REQ-STOR-035 AC5: direct delta cleanup accepts older valid markers and preserves markerless edits) -->
3. In mutable mode, signed retirements delete earlier seeded content only while a Codeflare ownership marker remains. <!-- @impl: src/lib/r2-seed.ts::deleteRetiredManagedConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC3: signed retirements delete only Codeflare-owned paths) -->
4. Image-owned runtime files, user roots, transcripts, Vault content, and company package bytes remain outside managed documents. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @impl: src/lib/r2-seed.ts::reseedContextModePlugin --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC4: image-owned and user-owned roots remain outside managed documents) -->
5. In protected modes, signed retirements delete prior content without requiring an ownership marker. <!-- @impl: src/lib/r2-seed.ts::deleteRetiredManagedConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC5: protected signed retirement deletes markerless prior content) -->

**Constraints:** Changed or absent ownership markers preserve mutable content except active protected signed retirements; company extension metadata may enter R2, but package bytes may not.

**Priority:** P1

**Dependencies:** [REQ-STOR-019](#req-stor-019-seeded-files-are-marked-and-retired-ones-are-removed), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated provenance and retirement tests

**Status:** Implemented

---

### REQ-STOR-022: Managed reconciliation admission

**Intent:** Managed reconciliation never mutates a user bucket while a session owns it.

**Applies To:** User

**Acceptance Criteria:**

1. A release mismatch performs no bucket mutation while any user session owns the bucket. <!-- @impl: src/routes/session/lifecycle.ts::default --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-022 AC1+AC2: a running session defers mutation and reports pending status) --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-022 AC1+AC2: initializing metadata also defers reconciliation) -->
2. A release mismatch reports pending status while any user session owns the bucket. <!-- @impl: src/routes/session/lifecycle.ts::default --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-022 AC1+AC2: a running session defers mutation and reports pending status) --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-022 AC1+AC2: initializing metadata also defers reconciliation) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-STOR-022 AC2: maps update_pending without invoking reconciliation) -->
3. The backend rejects another start until release mismatch or pending-target reconciliation succeeds. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (returns a typed 409 before user-bucket or container work when the active release is not applied) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-STOR-022 AC3: blocks container start while interrupted targets remain pending) -->
4. Disabling curation restores baked reconciliation expectations. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-022 AC4+AC5+AC6: disable restores baked state and preserves personal intent) -->
5. Disabling curation clears company applied state. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-022 AC4+AC5+AC6: disable restores baked state and preserves personal intent) -->
6. Disabling curation preserves personal extension intent. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-022 AC4+AC5+AC6: disable restores baked state and preserves personal intent) -->
7. Disabling curation with no available prior release fails without bucket mutation or applied-state clearing. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-022 AC7 + REQ-STOR-024 AC7: cacheless disable fails closed with applied state intact) -->

**Constraints:** Unconfigured baked behavior remains byte-identical.

**Priority:** P1

**Dependencies:** [REQ-STOR-023](#req-stor-023-managed-release-status-and-discovery), [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-IDE-042](browser-ide.md#req-ide-042-additive-company-extension-reconciliation)

**Verification:** Automated session-status, start-admission, dashboard, and disable tests

**Status:** Implemented

---

### REQ-STOR-023: Managed release status and discovery

**Intent:** Status polling detects managed-release changes without expanding release payloads.

**Applies To:** User

**Acceptance Criteria:**

1. Initial status compares the verified active descriptor, resolved mode, and managed-resource policy identity with applied user state. <!-- @impl: src/lib/managed-release-active.ts::getActiveManagedRelease --> <!-- @impl: src/lib/session-mode.ts::resolveEffectiveSessionMode --> <!-- @impl: src/routes/session/lifecycle.ts::default --> <!-- @test: src/__tests__/lib/managed-release-active.test.ts (REQ-STOR-023 AC1: returns configured managed resource policy with the active descriptor) --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-023 AC1+AC2: initial status compares descriptor and mode without payload bytes) --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (reports upgrading when a downgraded SaaS user has advanced managed content applied) --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-023 AC1: a pre-upgrade applied stamp without a manifest digest requires reconciliation) --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-023 AC1: reports upgrading when managed resource %s) -->
2. An unchanged release status check does not load payload bytes. <!-- @impl: src/lib/managed-release-active.ts::getActiveManagedRelease --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-023 AC1+AC2: initial status compares descriptor and mode without payload bytes) -->
3. After the five-minute freshness window, the resolver may fetch and activate a newly discovered release. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (uses the stored ETag after five minutes and treats 304 as a fresh no-op) -->
4. During cache failure, last-known-good startup is allowed only when its applied mode matches the resolved mode. <!-- @impl: src/lib/managed-release-active.ts::getActiveManagedRelease --> <!-- @impl: src/lib/session-mode.ts::resolveEffectiveSessionMode --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-023 AC4: an outage rejects last-known-good state for another mode) -->
5. Pending target identities report upgrading even when applied identity matches the active release. <!-- @impl: src/routes/session/lifecycle.ts::default --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-023 AC5: pending target state retries even when applied identity matches active) -->

**Constraints:** Polling does not parse or decompress a managed payload.

**Priority:** P1

**Dependencies:** [REQ-STOR-020](#req-stor-020-managed-environment-reconciliation), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated resolver and session-status tests

**Status:** Implemented

---

### REQ-STOR-024: Managed release application

**Intent:** A verified managed release converges into an unowned user bucket within fixed integrity and resource bounds.

**Applies To:** User

**Acceptance Criteria:**

1. A release mismatch with no owning session reads one verified cached gzip for reconciliation. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC1+AC4: successful managed reconcile loads cached content and stamps applied state last) -->
2. Reconciliation writes byte-identical content selected for the resolved mode. <!-- @impl: src/lib/session-mode.ts::resolveEffectiveSessionMode --> <!-- @impl: src/lib/remote-curation.ts::streamManagedReleaseDocuments --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC1 + REQ-STOR-024 AC2: Default and Advanced stream identical mode payloads with active release provenance) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (reconciles and stamps the entitlement-clamped mode for a downgraded SaaS user) -->
3. Reconciliation uses at most six concurrent R2 operations. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024 AC3: bounds R2 concurrency for a maximum-size managed document set) -->
4. Applied release and synthesized-manifest digests are stamped only after every reconciliation operation succeeds. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @impl: src/lib/r2-seed.ts::managedExtensionsDocumentDigest --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC1+AC4: successful managed reconcile loads cached content and stamps applied state last) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC4: does not stamp applied state when context-mode reconciliation fails) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024 AC4: trusted digest hashes the exact valid empty company manifest bytes) -->
5. Applying a current release after deployment-cache replacement does not require a historical cached bundle. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC5: reconciles from current release when disposable cache history is absent) -->
6. Cacheless application removes prior-digest paths that the current release excludes from the resolved mode. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024 AC6: cacheless application cleans only current-release paths outside the effective mode) -->
7. Disabling curation without the prior release fails without mutation or applied-state clearing. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-022 AC7 + REQ-STOR-024 AC7: cacheless disable fails closed with applied state intact) -->

**Constraints:** Applied state is written last.

**Priority:** P1

**Dependencies:** [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start), [REQ-STOR-019](#req-stor-019-seeded-files-are-marked-and-retired-ones-are-removed), [REQ-STOR-021](#req-stor-021-managed-content-ownership), [REQ-AGENT-049](agents.md#req-agent-049-auto-upgrade-preseed-on-release), [REQ-AGENT-151](agents.md#req-agent-151-bounded-managed-release-streaming)

**Verification:** Automated streaming, reconciliation, and storage-route tests

**Status:** Implemented

---

### REQ-STOR-025: Managed deployment cache migration

**Intent:** Each deployment safely retires its exact opaque managed cache predecessor.

**Applies To:** Admin

**Acceptance Criteria:**

1. Automatic migration records the recognizable cache only after it contains a verified active release. <!-- @impl: src/lib/remote-curation.ts::prepareManagedCacheMigration --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
2. Automatic migration never rewrites the selected repository or trust configuration. <!-- @impl: src/lib/remote-curation.ts::prepareManagedCacheMigration --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
3. Cleanup empties and deletes only the exact authenticated legacy bucket. <!-- @impl: src/lib/remote-curation.ts::cleanupLegacyManagedCache --> <!-- @impl: src/lib/r2-admin.ts::deleteR2BucketIfExists --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (REQ-STOR-025 AC3: empties and deletes only an existing named bucket) --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
4. Failed cleanup remains pending for a later resolver retry. <!-- @impl: src/lib/remote-curation.ts::cleanupLegacyManagedCache --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->

**Constraints:** Cleanup never scans by prefix or deletes an unauthenticated bucket identity.

**Priority:** P1

**Dependencies:** [REQ-STOR-020](#req-stor-020-managed-environment-reconciliation), [REQ-STOR-026](#req-stor-026-managed-deployment-cache-identity), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated migration ordering, concurrency, retry, and deletion tests

**Status:** Implemented

---

### REQ-STOR-026: Managed deployment cache identity

**Intent:** Each deployment exposes one recognizable collision-resistant managed cache identity.

**Applies To:** Admin

**Acceptance Criteria:**

1. The cache bucket name includes the sanitized Worker name. <!-- @impl: src/lib/remote-curation-cache.ts::getManagedReleaseCacheBucketName --> <!-- @test: src/__tests__/lib/remote-curation-cache.test.ts (REQ-STOR-026 AC1-AC3: derives a recognizable bounded bucket from account and worker identity) -->
2. The cache bucket name includes a collision-resistant account-and-Worker suffix. <!-- @impl: src/lib/remote-curation-cache.ts::getManagedReleaseCacheBucketName --> <!-- @test: src/__tests__/lib/remote-curation-cache.test.ts (REQ-STOR-026 AC1-AC3: derives a recognizable bounded bucket from account and worker identity) -->
3. The cache bucket name is at most 63 characters. <!-- @impl: src/lib/remote-curation-cache.ts::getManagedReleaseCacheBucketName --> <!-- @test: src/__tests__/lib/remote-curation-cache.test.ts (REQ-STOR-026 AC1-AC3: derives a recognizable bounded bucket from account and worker identity) -->

**Constraints:** The suffix remains stable for one account-and-Worker identity.

**Priority:** P1

**Dependencies:** [REQ-STOR-020](#req-stor-020-managed-environment-reconciliation)

**Verification:** Automated cache identity tests

**Status:** Implemented

---

### REQ-STOR-027: Review completion marker sync

**Intent:** Exact-head review completion survives container, clone, worktree, and shared-device boundaries without delaying local acknowledgement.

**Applies To:** User

**Acceptance Criteria:**

1. Completion uses one regular JSON file per normalized GitHub host, repository, PR, case-sensitive branch, protected base, and lowercase full head under `~/.codeflare/review-state/v1`. Reads validate schema, exact identity, timestamp, and regular-file boundaries without following symbolic links. <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::completionPath --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::completionPath --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (isolates host, repository, PR, branch, base, and head identities) --> <!-- @test: host/__tests__/review-completion-state.test.js (isolates protected bases in marker paths) -->
2. Marker publication uses a mode-`0600` same-directory temporary file and atomic hard-link publication. A valid destination is idempotent and never refreshes `reviewedAt`; an invalid destination is removed and publication retries once. <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::publish --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::publish --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (writes one immutable exact marker and never refreshes its age) --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (replaces an invalid exact destination once and rejects symlinks) -->
3. Invalid or expired markers are pruned before lookup and after write; each repository branch retains ten newest markers, and first root startup performs one bounded symlink-safe global prune. <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::pruneCompletionState --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::pruneCompletionState --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (deletes expired markers and retains ten newest per repository and branch) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (prunes marker state once on first root startup without traversing symlinks) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (prunes marker state once on first root startup without traversing symlinks) -->
4. Every workspace sync mode includes only `~/.codeflare/review-state/v1/**` through the common restore, baseline, regular bisync, and final-sync filter set while other private `.codeflare` files remain excluded. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (persists user-scoped review completion in every workspace sync mode) -->
5. A successful local marker write reads `CODEFLARE_SYNC_DAEMON_PIDFILE`, defaulting to `/run/codeflare/sync/sync-daemon.pid`, and sends `SIGUSR1` once. Missing or invalid PID state and signaling failure log one bounded warning but never roll back local completion. <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::requestCompletionSync --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::requestCompletionSync --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (keeps local acknowledgement when sync signaling fails) --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (warns for malformed daemon PID state without changing local acknowledgement) --> <!-- @test: host/__tests__/review-completion-state.test.js (warns for malformed daemon PID state) -->

**Constraints:** No review-specific R2 service, Worker endpoint, database, or direct `/internal/bisync-trigger` call exists. R2 convergence may repeat a prompt but cannot fabricate completion.

**Priority:** P1

**Dependencies:** [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start), [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-AGENT-171](agents.md#req-agent-171-user-scoped-review-completion-and-common-consent)

**Verification:** Automated marker and rclone-filter tests plus one integration container-replacement round trip

**Status:** Implemented

---

### REQ-STOR-028: Canonical managed-resource persistence policy

**Intent:** Enterprise managed-resource persistence paths are derived canonically from verified release inventory.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Protected modes derive deterministic UTF-8 JSON from every verified release document, retired path, and Codeflare-owned synthetic managed path, independent of session mode. <!-- @impl: src/lib/managed-r2-policy.ts::buildManagedR2Policy --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (deterministically protects both modes, retirements, and synthetic policy paths) -->
2. Canonical policy paths are sorted and deduplicated. <!-- @impl: src/lib/managed-r2-policy.ts::buildManagedR2Policy --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (deterministically protects both modes, retirements, and synthetic policy paths) -->
3. Policy identity is stable for identical canonical bytes and changes whenever those bytes change. <!-- @impl: src/lib/managed-r2-policy.ts::buildManagedR2Policy --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (deterministically protects both modes, retirements, and synthetic policy paths) -->

**Constraints:** `.codeflare/managed-paths.json` is the only persisted runtime policy document. No policy KV store or cache object is introduced.

**Priority:** P0

**Dependencies:** [REQ-STOR-020](#req-stor-020-managed-environment-reconciliation), [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-SETUP-015](setup.md#req-setup-015-managed-resource-persistence-controls)

**Verification:** Automated policy derivation, ordering, and digest tests

**Status:** Implemented

---

### REQ-STOR-029: Managed-resource reconciliation

**Intent:** Existing managed reconciliation applies canonical policy and bounded exclusive cleanup before stamping applied identity.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Managed-seed reconciliation writes and read-verifies protected policy after managed content. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC1: writes and read-verifies canonical protected policy after managed content) -->
2. Exclusive cleanup prevalidates the 10,000-object and 1-GiB object-size bounds, including exact root objects. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC2: exclusive cleanup bounds fail before every mutation) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC2: exclusive cleanup rejects summed object size above 1 GiB with zero mutations) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC2: exact root object size contributes to the exclusive cleanup bound) -->
3. Exclusive cleanup uses bounded delete batches without touching managed or similarly prefixed objects. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC3: exclusive cleanup preserves managed objects in one bounded delete batch) -->
4. Exclusive reconciliation writes canonical policy only after every delete response confirms error-free completion. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC4: partial exclusive batch failures prevent policy identity from being committed) -->
5. Malformed or over-bound exclusive listing or root metadata fails before every cleanup mutation. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC5: invalid exact root size %s causes zero mutations) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC5: malformed exclusive listings cause zero mutations) -->
6. Mutable transition removes stale R2 policy. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC6: mutable transition removes stale canonical policy) -->
7. Applied release, mode, and policy identity are stamped only after successful reconciliation. <!-- @impl: src/routes/storage/seed.ts::updatedPreferences --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-029 AC7: transports configured policy and stamps verified identity last) -->

**Constraints:** Reconciliation reuses the managed-seed path; no queue, database, or separate reconciler is introduced.

**Priority:** P0

**Dependencies:** [REQ-STOR-020](#req-stor-020-managed-environment-reconciliation), [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-STOR-028](#req-stor-028-canonical-managed-resource-persistence-policy), [REQ-STOR-030](#req-stor-030-managed-resource-policy-loading), [REQ-STOR-032](#req-stor-032-exclusive-managed-resource-boundaries)

**Verification:** Automated reconciliation-order, cleanup-bound, delete-response, mutable-transition, and stamping tests

**Status:** Implemented

---

### REQ-STOR-030: Managed-resource policy loading

**Intent:** Worker boundaries accept managed-resource policy only under exact applied identity.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Policy loading accepts only bounded canonical bytes matching the applied policy identity, release, and resource mode. <!-- @impl: src/lib/managed-r2-policy.ts::readVerifiedManagedR2Policy --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (loader verifies exact digest, release, mode, and canonical bytes) -->
2. Reused policy results revalidate the caller's expected identity. <!-- @impl: src/lib/managed-r2-policy.ts::readVerifiedManagedR2Policy --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (cache hits still revalidate expected release and mode) -->
3. Callers can require fresh policy verification without reusing an earlier result. <!-- @impl: src/lib/managed-r2-policy.ts::readVerifiedManagedR2Policy --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (verifies protected bucket policy without cache and transports only its identity) -->

**Constraints:** Policy loading does not create another persisted policy object.

**Priority:** P0

**Dependencies:** [REQ-STOR-028](#req-stor-028-canonical-managed-resource-persistence-policy)

**Verification:** Automated canonical-byte, identity-revalidation, and fresh-verification tests

**Status:** Implemented

---

### REQ-STOR-031: Managed-resource container sync

**Intent:** Containers restore policy before generating non-authoritative filters that keep protected mutations out of ordinary bisync.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Initial restore includes the canonical managed-policy document before policy validation. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-IDE-002 AC6 / REQ-STOR-031 AC1: syncs bounded Browser IDE manifests and managed policy) --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-031 AC1/AC2/AC7: restores managed content and declared image companions before baseline) -->
2. Protected modes verify exact policy identity after restore and before baseline creation. <!-- @impl: entrypoint.sh::prepare_managed_resource_filter --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-031 AC1/AC2/AC7: restores managed content and declared image companions before baseline) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (validates canonical exclusive identity and excludes exact paths and roots while preserving adjacent paths) -->
3. The generated filter excludes protected exact paths. <!-- @impl: entrypoint.sh::prepare_managed_resource_filter --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (validates canonical exclusive identity and excludes exact paths and roots while preserving adjacent paths) -->
4. Exclusive filtering also excludes governed resource roots. <!-- @impl: entrypoint.sh::prepare_managed_resource_filter --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (validates canonical exclusive identity and excludes exact paths and roots while preserving adjacent paths) -->
5. Mutable transition removes stale local policy and filter state before baseline. <!-- @impl: entrypoint.sh::prepare_managed_resource_filter --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (mutable reset removes stale policy and filter before baseline) -->
6. Baseline, periodic, manual, recovery, and final bisync use the common generated filter. <!-- @impl: entrypoint.sh::RCLONE_FILTERS --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (validates canonical exclusive identity and excludes exact paths and roots while preserving adjacent paths) --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (entrypoint.sh bisync daemon behavior (real) / REQ-STOR-002 (file persistence) / REQ-STOR-004 (initial sync) / REQ-STOR-005 (graceful shutdown final sync) / REQ-SESSION-003 AC3 (entrypoint initial rclone sync) + AC4 (bisync daemon + SIGUSR1) / REQ-SESSION-011 (graceful shutdown with final sync) / REQ-VAULT-006 (shutdown bisync vault writes) / REQ-OPS-010 (graceful container shutdown) / REQ-MEM-004 (memory dirs in bisync filter)) -->
7. With remote curation active, post-restore startup restores declared image-owned runtime companions required by managed extensions without replacing release-owned extension bytes. <!-- @impl: entrypoint.sh::IMAGE_OWNED_MANAGED_EXTENSION_COMPANIONS --> <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-031 AC1/AC2/AC7: restores managed content and declared image companions before baseline) -->

**Constraints:** Container policy is non-authoritative, with no Durable Object policy persistence or replacement of release-owned extension bytes by image copies.

**Priority:** P0

**Dependencies:** [REQ-STOR-029](#req-stor-029-managed-resource-reconciliation), [REQ-STOR-030](#req-stor-030-managed-resource-policy-loading), [REQ-STOR-032](#req-stor-032-exclusive-managed-resource-boundaries)

**Verification:** Automated restore-scope, identity, exact-path, root, mutable-transition, image-companion, and bisync-consumer tests

**Status:** Implemented

---

### REQ-STOR-032: Exclusive managed-resource boundaries

**Intent:** Exclusive policy protects only recognized managed-resource trees while preserving adjacent and unrelated personal paths.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Exclusive mode derives segment-aware resource roots only from the governed category allowlist. <!-- @impl: src/lib/managed-r2-policy.ts::deriveManagedResourceRoots --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (REQ-STOR-032 AC1/AC2: exclusive roots derive segment-aware while sessions and root files remain outside) -->
2. Exclusive roots protect root objects and descendants without covering similarly prefixed names, session state, or unrelated personal paths. <!-- @impl: src/lib/managed-r2-policy.ts::isManagedMutationProtected --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (REQ-STOR-032 AC1/AC2: exclusive roots derive segment-aware while sessions and root files remain outside) -->
3. Exclusive generation fails before reconciliation when a managed or retired path uses an unknown nested category. <!-- @impl: src/lib/managed-r2-policy.ts::deriveManagedResourceRoots --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (REQ-STOR-032 AC3: exclusive generation rejects a novel or later nested managed category) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-032 AC3: exclusive generation fails before every R2 request) -->

**Constraints:** Root derivation introduces no policy outside recognized managed-resource categories.

**Priority:** P0

**Dependencies:** [REQ-STOR-028](#req-stor-028-canonical-managed-resource-persistence-policy), [REQ-SETUP-015](setup.md#req-setup-015-managed-resource-persistence-controls)

**Verification:** Automated root-boundary and category tests

**Status:** Implemented

---

### REQ-STOR-033: Managed-release delta planning and resume

**Intent:** Automatic upgrades write the release-required target objects and resume same-target work from R2 provenance.

**Applies To:** User

**Acceptance Criteria:**

1. Automatic reconciliation compares the exact applied release directly with the active target without replaying intermediate releases. <!-- @impl: src/lib/r2-seed.ts::buildManagedAutomaticPlan --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033 AC1/AC2: direct delta handles a fifteen-release gap and writes only added or changed release paths) -->
2. The direct plan includes only target paths whose release content or content type changed, so release-identical markerless edits remain untouched. <!-- @impl: src/lib/r2-seed.ts::buildManagedAutomaticPlan --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033 AC1/AC2: direct delta handles a fifteen-release gap and writes only added or changed release paths) -->
3. A same-target retry skips objects that already carry the target marker. <!-- @impl: src/lib/r2-seed.ts::seedManagedDocuments --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033 AC3 + REQ-STOR-034 AC3: target provenance resumes and increments progress) -->
4. Fresh or missing-history fallback plans every target path before stale-marker cleanup. <!-- @impl: src/lib/r2-seed.ts::buildManagedAutomaticPlan --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033 AC4 + REQ-STOR-035 AC5: full-target fallback sweeps stale managed markers only after desired writes) -->
5. Fallback accepts absent applied identity or unavailable valid history. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC5 + REQ-STOR-033 AC5: reconciles from current release when disposable cache history is absent) -->
6. Malformed or conflicting applied identity fails before bucket mutation. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-033 AC6: invalid applied identity fails closed before bucket mutation) -->
7. Manual Recreate and non-dashboard callers retain full-overwrite behavior. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @impl: web-ui/src/stores/session.ts::applyManagedReleaseBatch --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-033 AC7: automatic endpoint is separate and manual Recreate remains full overwrite) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-STOR-033 AC7: should trigger the automatic upgrade endpoint when preseedNeedsUpgrade is true) -->

**Constraints:**

- No more than six R2 operations run concurrently.
- Same-target retries do not replay completed target objects.

**Priority:** P0

**Dependencies:** [REQ-STOR-021](#req-stor-021-managed-content-ownership), [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-AGENT-049](agents.md#req-agent-049-auto-upgrade-preseed-on-release)

**Verification:** Automated delta and route tests plus Enterprise Integration interruption verification

**Status:** Implemented

---

### REQ-STOR-034: Observational managed reconciliation progress writes

**Intent:** Automatic reconciliation reports bounded progress without making telemetry an execution authority.

**Applies To:** User

**Acceptance Criteria:**

1. Progress write failures never block reconciliation. <!-- @impl: src/lib/managed-reconcile-progress.ts::writeManagedReconcileProgress --> <!-- @test: src/__tests__/lib/managed-reconcile-progress.test.ts (REQ-STOR-034 AC1: progress write failure remains observational) -->
2. Stored progress distinguishes planning, writing, and finalizing. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-034 AC2: finalizing progress is persisted before cleanup begins) -->
3. Completed counts include objects recovered from matching target provenance. <!-- @impl: src/lib/r2-seed.ts::seedManagedDocuments --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033 AC3 + REQ-STOR-034 AC3: target provenance resumes and increments progress) -->
4. Stored progress expires within 24 hours. <!-- @impl: src/lib/managed-reconcile-progress.ts::writeManagedReconcileProgress --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-034 AC4/AC5: automatic progress is bounded, observational, and cleared after stamping) -->
5. Successful applied publication clears matching progress. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @impl: src/lib/managed-reconcile-progress.ts::clearMatchingManagedReconcileProgress --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-034 AC4/AC5: automatic progress is bounded, observational, and cleared after stamping) -->
6. Progress cleanup failure cannot change the reconciliation outcome. <!-- @impl: src/lib/managed-reconcile-progress.ts::clearMatchingManagedReconcileProgress --> <!-- @test: src/__tests__/lib/managed-reconcile-progress.test.ts (REQ-STOR-034 AC6: progress cleanup failure cannot change applied reconciliation outcome) -->

**Constraints:** Progress is observational and never an execution checkpoint.

**Priority:** P1

**Dependencies:** [REQ-STOR-023](#req-stor-023-managed-release-status-and-discovery), [REQ-STOR-033](#req-stor-033-managed-release-delta-planning-and-resume)

**Verification:** Automated progress-helper and reconciliation-route tests

**Status:** Implemented

---

### REQ-STOR-035: Managed reconciliation cleanup and finalization

**Intent:** Interrupted targets and obsolete managed paths converge without deleting user-owned or concurrently replaced objects.

**Applies To:** User

**Acceptance Criteria:**

1. Before managed-release R2 writes, at most 32 target identities are recorded. <!-- @impl: src/lib/managed-release-active.ts::appendManagedReconciliationTarget --> <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @impl: src/routes/preferences.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1: rejects unbounded interrupted target state before bucket mutation) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1/AC2: failed manual Recreate records and retains its active target) --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-STOR-035 AC1/AC2: a failed managed mode change records and retains its active target) -->
2. A failed reconciliation retains its recorded pending target identities. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @impl: src/routes/preferences.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC2/AC7: target changes before cleanup, preserves pending ownership, and prevents finalization) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC2: unavailable interrupted history fails before bucket mutation and retains state) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1/AC2: failed manual Recreate records and retains its active target) --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-STOR-035 AC1/AC2: a failed managed mode change records and retains its active target) --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-STOR-035 AC2: unavailable interrupted history rejects a mode change and preserves pending state) -->
3. Successful publication clears pending identities only after every recorded target has been repaired or superseded by a complete full-target reconcile. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @impl: src/routes/preferences.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1/AC3: records automatic target ownership before writes and clears it with applied publication) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC3: manual Recreate repairs interrupted targets before clearing their state) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC3: managed disable cleans interrupted targets before clearing their state) --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-STOR-035 AC3: mode-change disable repairs interrupted targets before clearing state) -->
4. After target drift, desired paths are repaired only when they carry an interrupted target marker; markerless paths remain untouched. <!-- @impl: src/lib/r2-seed.ts::buildManagedAutomaticPlan --> <!-- @impl: src/lib/r2-seed.ts::seedManagedDocuments --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC4: interrupted target drift repairs only objects carrying interrupted provenance) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC4: repairs markers from repeated interrupted targets) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC4: repairs an interrupted extensions manifest when applied already matches target) -->
5. Cleanup removes source-absent, interrupted-only, or signed-retired paths only when they meet the active ownership rule. <!-- @impl: src/lib/r2-seed.ts::deleteManagedConfigsByDigest --> <!-- @impl: src/lib/r2-seed.ts::deleteRetiredManagedConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC2 + REQ-STOR-035 AC5: direct delta cleanup accepts older valid markers and preserves markerless edits) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC5: managed disable removes interrupted-only objects with matching provenance) -->
6. Cleanup does not delete an object replaced after cleanup inspection. <!-- @impl: src/lib/r2-seed.ts::deleteManagedConfigsByDigest --> <!-- @impl: src/lib/r2-seed.ts::deleteRetiredManagedConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC6: cleanup preserves an object replaced after inspection) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC6: fallback cleanup preserves an object replaced after inspection) -->
7. Applied publication requires unchanged target identity, mode, resource policy, storage encryption, session ownership, migration state, and pending target set. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC2/AC7: target changes before cleanup, preserves pending ownership, and prevents finalization) -->

**Constraints:**

- Interrupted target state never uses observational progress as authority.

**Priority:** P0

**Dependencies:** [REQ-STOR-021](#req-stor-021-managed-content-ownership), [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-STOR-033](#req-stor-033-managed-release-delta-planning-and-resume)

**Verification:** Automated drift, cleanup, replacement, and publication tests

**Status:** Implemented

---

### REQ-STOR-036: Managed reconciliation progress reads

**Intent:** Batch status exposes current progress without letting malformed or unavailable telemetry replace release truth.

**Applies To:** User

**Acceptance Criteria:**

1. Malformed progress is omitted. <!-- @impl: src/lib/managed-reconcile-progress.ts::readManagedReconcileProgress --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-036 AC1: malformed progress is omitted) -->
2. Progress is exposed only for the matching target while authoritative status is upgrading. <!-- @impl: src/routes/session/lifecycle.ts::default --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-036 AC2: batch status exposes only matching pending progress) --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-036 AC2: update-pending state omits progress) -->
3. Progress read failure cannot replace authoritative release status. <!-- @impl: src/lib/managed-reconcile-progress.ts::readManagedReconcileProgress --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-036 AC3: progress read failure cannot replace authoritative upgrading status) -->
4. Status observation clears matching progress after the target is already applied. <!-- @impl: src/routes/session/lifecycle.ts::default --> <!-- @impl: src/lib/managed-reconcile-progress.ts::clearMatchingManagedReconcileProgress --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-STOR-036 AC4: applied target omits and opportunistically clears stale progress) -->

**Constraints:** Batch status does not infer reconciliation completion from progress.

**Priority:** P1

**Dependencies:** [REQ-STOR-023](#req-stor-023-managed-release-status-and-discovery), [REQ-STOR-034](#req-stor-034-observational-managed-reconciliation-progress-writes)

**Verification:** Automated batch-status and progress-reader tests

**Status:** Implemented

---

### REQ-STOR-037: Page-local managed seed-action coordination

**Intent:** One dashboard page does not start overlapping managed seed updates.

**Applies To:** User

**Acceptance Criteria:**

1. While a managed seed update is active, another managed seed action started from the same page does not run. <!-- @impl: web-ui/src/stores/session.ts::sessionStore --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-STOR-037 AC1: blocks a second managed seed action within one page) -->
2. Session-mode and Manual Recreate controls are disabled while that page has a managed seed update active. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/settings/SessionSection.test.tsx (REQ-STOR-037 AC2: blocks managed seed controls while an in-page update is active) -->

**Constraints:** Coordination is page-local; cross-client serialization is tracked in [issue #1006](https://github.com/nikolanovoselec/codeflare/issues/1006) and is not claimed here.

**Priority:** P0

**Dependencies:** [REQ-STOR-035](#req-stor-035-managed-reconciliation-cleanup-and-finalization), [REQ-AGENT-049](agents.md#req-agent-049-auto-upgrade-preseed-on-release)

**Verification:** Automated session-store and settings-control tests

**Status:** Implemented

---
