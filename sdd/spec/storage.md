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
2. The bucket is auto-created via the Cloudflare API on first container start when it does not already exist. <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-STOR-001 AC2: first Start creates the absent bucket and configures the runtime with that bucket) --> <!-- @impl: src/lib/r2-admin.ts::createBucketIfNotExists --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC2 (createBucketIfNotExists is idempotent and race-safe)) -->
3. No API endpoint may read, mutate, or delete objects from a bucket the acting user does not own; authentication, setup, billing, preferences, administration, and offboarding resolve the strongly claimed identity before bucket access, while unresolved legacy collisions fail closed. <!-- @test: src/__tests__/routes/storage-browse.test.ts (REQ-STOR-001 AC3/AC4: authenticated owner-to-object request composition) --> <!-- @impl: src/lib/access.ts::resolveBucketName --> <!-- @impl: src/lib/user-cleanup.ts::cleanupUserData --> <!-- @test: src/__tests__/lib/access.test.ts (resolveBucketName / REQ-AUTH-006 tenant isolation) -->
4. Concurrent authenticated requests resolve the same owned bucket without rate-limit failures. <!-- @test: src/__tests__/routes/storage-browse.test.ts (concurrent authenticated requests read the same owner bucket without ownership-write rate-limit failures) --> <!-- @impl: src/lib/access.ts::resolveBucketName --> <!-- @test: src/__tests__/lib/access.test.ts (does not project ownership into a same-key KV hot path during a 52-request burst) -->

**Constraints:**

- Bucket naming complies with R2's object-storage naming rules (lowercase, no special characters beyond hyphens).
- Bucket creation is idempotent: invoking it against an existing bucket is a no-op, not an error.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated: [Owner identity](../../src/__tests__/lib/access.test.ts), [ownership claim](../../src/__tests__/container/index.test.ts), [bucket provisioning](../../src/__tests__/lib/r2-admin.test.ts), [first Start](../../src/__tests__/routes/container-r2-start.test.ts), [authenticated object access](../../src/__tests__/routes/storage-browse.test.ts)

**Status:** Implemented

---

<a id="req-stor-002-bidirectional-sync-with-r2"></a>
### REQ-STOR-002: File Persistence Across Sessions

**Intent:** User files must survive container destruction and be available when a new session starts, because containers are ephemeral.

**Applies To:** User

**Acceptance Criteria:**

1. Nonempty files written during a session are readable in a subsequent session after the container is recreated. <!-- @test: host/__tests__/entrypoint-storage-restart.test.js (REQ-STOR-002 AC1/AC2/AC3: S3 restores ordinary, config, dotfile and full-workspace bytes after first local runtime is discarded) --> <!-- @impl: entrypoint.sh::initial_sync_from_r2 -->
2. Agent configuration directories and per-user dotfiles persist across sessions. <!-- @test: host/__tests__/entrypoint-storage-restart.test.js (REQ-STOR-002 AC1/AC2/AC3: S3 restores ordinary, config, dotfile and full-workspace bytes after first local runtime is discarded) --> <!-- @impl: entrypoint.sh::bisync_with_r2 -->
3. Nonempty workspace files persist across sessions when the user has enabled full workspace sync. <!-- @test: host/__tests__/entrypoint-storage-restart.test.js (REQ-STOR-002 AC1/AC2/AC3: S3 restores ordinary, config, dotfile and full-workspace bytes after first local runtime is discarded) --> <!-- @impl: entrypoint.sh::bisync_with_r2 -->
4. After restore and each successful bisync, startup or sync attempts to restore executable permissions for `.mjs` and `.sh` files at any depth under the hooks root without following symlinks. A permission repair failure does not fail startup or sync. <!-- @test: host/__tests__/entrypoint-storage-restart.test.js (REQ-STOR-002 AC4: restore completes before boot repair; actual chmod failure is nonfatal at startup and successful bisync) --> <!-- @test: host/__tests__/entrypoint-hook-exec-bits.test.js (REQ-STOR-002 AC4 / P41: restored deep registered hook executes without following symlink escapes) --> <!-- @impl: entrypoint.sh::repair_hook_exec_bits --> <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-hook-exec-bits.test.js (restores +x on hook scripts a sync stripped, leaving other files alone) --> <!-- @test: host/__tests__/entrypoint-hook-exec-bits.test.js (repairs and can execute a hook after a successful bisync) -->

**Notes:** The per-path inventory is documented in [Storage and Sync](../../documentation/lanes/storage-and-sync.md#whats-synced-vs-excluded-req-stor-011).

**Constraints:**

- R2 is the durable store; the local filesystem is ephemeral.
- Zero-byte files are excluded by the existing sync policy.
- Persistence depends on at least one successful sync completing before container shutdown.
- R2 round-trips content and modification time, not executable modes. Permission repair is best effort and does not guard concurrent hook invocations.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated: [transfer and fresh local restore](../../host/__tests__/entrypoint-storage-restart.test.js), [hook executable repair](../../host/__tests__/entrypoint-hook-exec-bits.test.js)

**Status:** Implemented

---

### REQ-STOR-003: Bidirectional Sync Every 15 Minutes (with Manual Triggers)

**Intent:** Changes made locally (by the agent or user) and changes in R2 (from the file browser or another session's sync) must converge within a bounded interval, balanced against R2 operation cost. The 15-minute cadence is supplemented by explicit user-driven triggers ([REQ-STOR-015](#req-stor-015-explicit-sync-trigger-from-ui)) so the user is never blocked waiting for a cycle when they want fresh state.

**Applies To:** User

**Acceptance Criteria:**

1. After the bisync baseline is established, a periodic bisync runs on a 15-minute cadence. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->
2. External triggers interrupt daemon sleep for immediate bisync and coalesce during an active cycle into one rerun ([REQ-STOR-015](#req-stor-015-explicit-sync-trigger-from-ui)). <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (N SIGUSR1s arriving mid-flight coalesce into exactly one rerun (REQ-STOR-003 AC2 / REQ-STOR-015 AC5: in-flight coalesce branch)) --> <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (SIGUSR1 interrupts the cadence sleep and triggers bisync immediately (REQ-STOR-003 AC2 / REQ-STOR-015 AC5 / REQ-MEM-004 AC4: SIGUSR1 trigger)) -->
3. Conflict resolution is newest-file-wins. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_server_modtime_sync) -->
4. After a transient failure, the next automatic retry begins after two minutes. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (daemon retries two minutes after transient failure and continues the cycle (REQ-STOR-003 AC4)) -->
5. Before charging a vanished-file failure to the failure budget, sync retries without obstruction from stale locks. <!-- @impl: entrypoint.sh::recover_vanished_files --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (REQ-STOR-003 AC5: real vanished-file parsing excludes once, preserves workspace retry, and clears stale locks) -->
6. Baseline and subsequent bisync invocations permit admitted deletions up to 100% of prior files, without an absolute file-count cap or forced bypass of other safety checks. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC4 / REQ-STOR-003 AC6: final, periodic, and baseline bisync preserve the 100-percent deletion policy) -->
7. Vanished workspace files remain eligible on retry; applicable recovery exclusions take precedence over positive persistence rules. <!-- @impl: entrypoint.sh::recover_vanished_files --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (REQ-STOR-003 AC5: real vanished-file parsing excludes once, preserves workspace retry, and clears stale locks) -->

**Notes:** Standalone test scope and CI exclusions are documented under [Storage verification](../../documentation/lanes/storage-and-sync.md#storage-verification).

**Constraints:**

- Disk-exhausted sync recovery follows [REQ-STOR-045](#req-stor-045-bisync-baseline-recovery).
- Bisync invocations must tolerate files changing mid-transfer (no false hash-mismatch aborts).
- Bulk workspace deletions admitted by the persistence policy must propagate.
- Post-sync listing validation must not abort the cycle when R2 changes during the sync window.
- Whole-home bisync excludes empty files; the separate Hermes transfer preserves zero-byte session Markdown under [REQ-MEM-041 AC2](memory.md#req-mem-041-session-isolated-hermes-markdown).

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket), [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated: [entrypoint-bisync-behavior.test.js](../../host/__tests__/entrypoint-bisync-behavior.test.js), [entrypoint-shutdown.test.js](../../host/__tests__/entrypoint-shutdown.test.js), [rclone-bisync-s3.py](../../scripts/ci/rclone-bisync-s3.py)

**Status:** Implemented

---

### REQ-STOR-045: Bisync Baseline Recovery

**Intent:** Failed bisync state must recover promptly without overwriting newer data or leaving stale status visible.

**Applies To:** User

**Acceptance Criteria:**

1. Except while disk-space recovery is blocked, three consecutive unrecoverable failures trigger baseline re-establishment. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (REQ-STOR-045 AC1+AC3 / REQ-STOR-002 AC1: three consecutive failures trigger resync fallback) -->
2. When synchronization reports that prior state is unavailable, recovery immediately establishes a newest-side-wins baseline. <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-002/004/011/031/032: production persistence policy matrix) --> <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-STOR-045 AC2: recovery baseline uses the real workdir and newest-side convergence) --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (REQ-STOR-045 AC2: forces immediate resync when protected workdir listings are absent) -->
3. Baseline recovery publishes success only after completing. A timed-out rebuild publishes timeout rather than success, and one more failed cycle retries the rebuild. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (REQ-STOR-045 AC1+AC3 / REQ-STOR-002 AC1: three consecutive failures trigger resync fallback) --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-STOR-045 AC3: timed-out resync reports timeout and retries after one more failed cycle) -->

**Notes:** Standalone test scope and CI exclusions are documented under [Storage verification](../../documentation/lanes/storage-and-sync.md#storage-verification).

**Constraints:**

- Disk-exhausted sync waits for [explicit recovery](#req-stor-041-disk-space-recovery).

**Priority:** P0

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start), [REQ-STOR-041](#req-stor-041-disk-space-recovery)

**Verification:** Automated: [entrypoint-bisync-behavior.test.js](../../host/__tests__/entrypoint-bisync-behavior.test.js), [entrypoint-runtime-behavior.test.js](../../host/__tests__/entrypoint-runtime-behavior.test.js), [entrypoint-shutdown.test.js](../../host/__tests__/entrypoint-shutdown.test.js), [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js)

**Status:** Implemented

---

### REQ-STOR-004: Initial Sync Restores Files on Container Start

**Intent:** When a container boots, it must restore the user's persisted files from R2 before the agent or terminal becomes usable.

**Applies To:** User

**Acceptance Criteria:**

1. After terminal server readiness and bootstrap preparation, the one-way R2 restore blocks user workspace initialization until the restore settles or reaches its timeout. <!-- @impl: entrypoint.sh::run_initial_r2_restore --> <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @manual -->
2. The initial sync completes or times out within a bounded duration so the session is never blocked indefinitely on a slow R2 fetch. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @manual: Start a session against a deliberately stalled R2 endpoint and confirm startup leaves the blocking sync phase within its configured bound. -->
3. Post-restore per-agent configuration finishes before the bisync baseline so it sees a stable snapshot; eligible Governed baked seed staging precedes restore under [REQ-STOR-256](#req-stor-256-image-seed-relay-cache-reuse-and-prewarm-priority). <!-- @impl: entrypoint.sh::run_managed_curation_startup --> <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-004 AC3/AC4 / REQ-STOR-031: baseline observes real post-restore Pi settings and managed content) --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (executes the reachable baked restore, relay, cleanup, and baseline in order when curation is disabled) --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
4. A bisync baseline is established after the post-sync file modifications complete. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-004 AC3/AC4 / REQ-STOR-031: baseline observes real post-restore Pi settings and managed content) -->
5. Vanished non-workspace files enter the recovery filter before retry; vanished workspace files retry without exclusion. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-vanished-file-recovery.test.js (adds a vanished NON-workspace file to the session recovery filter and signals retry (REQ-STOR-004 AC5)) -->
6. Known per-session ephemeral agent-state files are statically excluded from all sync operations, including Codex plugin/general caches and SQLite WAL/SHM companions, Copilot SQLite temporary files, Claude workflow/daemon caches, code-server logs, and desktop Trash. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (statically excludes ephemeral caches, repo graphify-out, and R2 secrets in both modes (REQ-STOR-004 AC6 / REQ-AGENT-026 AC1)) -->
7. The bisync daemon starts unconditionally after the baseline phase, even if all baseline attempts fail; a dead daemon would mean zero sync for the entire session, and the daemon already has its own recovery path (vanishing-file recovery plus resync fallback). <!-- @test: host/__tests__/entrypoint-storage-restart.test.js (REQ-STOR-004 AC7: exhausted ordinary baseline failure still starts a live sync daemon) --> <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->

**Notes:** The per-agent file enumeration is documented in [Configuration](../../documentation/lanes/configuration.md). The full per-path inventory is documented in [Storage and Sync](../../documentation/lanes/storage-and-sync.md#whats-synced-vs-excluded-req-stor-011).

**Constraints:**

- Set the bisync-initialized marker even on timeout; shutdown still attempts final sync.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated: [entrypoint-managed-curation.test.js](../../host/__tests__/entrypoint-managed-curation.test.js), [entrypoint-vault-boot.test.js](../../host/__tests__/entrypoint-vault-boot.test.js), [entrypoint-hooks-merge.test.js](../../host/__tests__/entrypoint-hooks-merge.test.js), [entrypoint-vanished-file-recovery.test.js](../../host/__tests__/entrypoint-vanished-file-recovery.test.js), [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js), [entrypoint-storage-restart.test.js](../../host/__tests__/entrypoint-storage-restart.test.js); Manual: [startup restore acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-004-startup-restore-acceptance)

**Status:** Implemented

---

### REQ-STOR-005: Graceful Shutdown Performs Final Sync

**Intent:** When a container is stopped or evicted, unsaved local changes must reach R2 before exit. The awaited live drain in [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync) is authoritative, while the signal-triggered final sync remains a bounded best-effort backstop.

**Applies To:** User

**Acceptance Criteria:**

1. A termination handler runs a final bisync before the process exits (best-effort backstop; the primary guarantee is the live drain in [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync)). <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
2. The signal-triggered final bisync is eligible only after recorded baseline success or timeout. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
3. Successful final sync persists admitted session writes in R2. Successful shutdown alone does not prove persistence; failed or timed-out sync can leave writes unsynced. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @impl: src/container/container-lifecycle.ts::drainFinalSyncAudited --> <!-- @manual: Compare admitted final bytes by the existing final persistence acceptance procedure. -->
4. The final bisync runs under a hard watchdog. If it has not completed before the watchdog expires the process is force-killed; the user accepts that the last writes may not have synced. <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-STOR-005 AC4 / REQ-MEM-004 AC6: real watchdog signals and kills stuck sync after released 108s and 12s clock waits) --> <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
5. From teardown entry, the awaited live drain gets at most 120 seconds within a shared 135-second cap. The best-effort SIGTERM final-sync trap gets only remaining time, not another 120 seconds; forced teardown can interrupt it and lose final writes. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Constraints:**

- All teardown shares the 135-second cap; live drain gets the lesser of 120 seconds and remaining time.
- The nominal 120-second trap watchdog neither extends the cap nor guarantees clean exit after SIGTERM; final-byte persistence still requires acceptance.
- Final and periodic bisync use the same correctness flags.

**Priority:** P0

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** Automated: [entrypoint-shutdown.test.js](../../host/__tests__/entrypoint-shutdown.test.js), [index.test.ts](../../src/__tests__/container/index.test.ts); Manual: [final persistence acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-005-final-persistence-acceptance)

**Status:** Implemented

---

### REQ-STOR-006: Storage Quota Enforced Per Tier at Session Start

**Intent:** Creating a session in SaaS refuses a known cached storage overage against a finite tier cap.

**Applies To:** User

**Acceptance Criteria:**

1. In SaaS outside Enterprise, session creation compares any present cached storage usage to the effective tier's finite cap. <!-- @impl: src/routes/session/crud.ts::app --> <!-- @test: src/__tests__/routes/session-public-d1.test.ts (AC6 subset: cached SaaS storage above the tier cap denies creation without inserting a row) --> <!-- @manual -->
2. Cached usage above the cap rejects creation with a user-facing quota error and leaves no session record. <!-- @impl: src/routes/session/crud.ts::app --> <!-- @test: src/__tests__/routes/session-public-d1.test.ts (AC6 subset: cached SaaS storage above the tier cap denies creation without inserting a row) --> <!-- @manual -->
3. The storage-stats endpoint returns usage and the quota used by the UI's "X of Y" indicator. Both come from a fresh cached aggregate; on a miss, SaaS resolves the effective tier's maximum, or returns `null` if none applies. <!-- @impl: src/routes/storage/stats.ts::app --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (returns 200 with correct shape) --> <!-- @manual -->
4. A resolved null or missing cap skips the storage quota check; zero remains a finite cap. <!-- @test: src/__tests__/routes/session-public-d1.test.ts (REQ-STOR-006 AC4: zero storage cap rejects Create with nonzero cached usage and leaves no D1 row) --> <!-- @test: src/__tests__/routes/session-public-d1.test.ts (REQ-STOR-006 AC4: zero storage cap admits Create when cached usage is zero) --> <!-- @impl: src/routes/session/crud.ts::app --> <!-- @test: src/__tests__/routes/session-public-d1.test.ts (REQ-SUB-002 AC2: unlimited storage admits creation despite high cached usage) --> <!-- @manual -->
5. When tier configuration adds new fields, previously persisted records inherit the new field's default rather than appearing unset. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-009 AC4: admin-stored values take priority via merge (stored overrides default)) -->

**Constraints:**

- The cached storage gate applies to Create, not Start or restart. Upload, sync, and preseed writes are not gated.
- Create uses the cached usage if present without refreshing it. Missing usage does not block Create; stale usage may not reflect a current overage.
- The stats cache stores quota; a cache hit does not resolve tier configuration.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-STOR-014](#req-stor-014-r2-storage-stats-caching)

**Verification:** Automated: [session-public-d1.test.ts](../../src/__tests__/routes/session-public-d1.test.ts), [storage-stats.test.ts](../../src/__tests__/routes/storage-stats.test.ts), [subscription-req-sub-gaps.test.ts](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts); Manual: [quota admission acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-006-quota-admission-acceptance)

**Status:** Implemented

---

### REQ-STOR-007: Web File Browser

**Intent:** Users must be able to browse, upload, download, delete, and preview files in their R2 storage via HTTP endpoints, without using the terminal.

**Applies To:** User

**Acceptance Criteria:**

1. The browse endpoint returns one page of objects and directory prefixes for the requested R2 prefix, forwarding the continuation token when supplied. The browser follows subsequent pages under [REQ-STOR-018](#req-stor-018-file-browser-pagination-is-append-only-and-recoverable). <!-- @impl: src/routes/storage/browse.ts::app --> <!-- @test: src/__tests__/routes/storage-browse.test.ts (returns objects and prefixes for valid request) --> <!-- @test: src/__tests__/routes/storage-browse.test.ts (passes continuationToken when provided) -->
2. The upload endpoint stores a file at a specified R2 key. <!-- @manual --> <!-- @impl: src/routes/storage/upload.ts::app -->
3. The download endpoint returns file contents as an attachment with a sanitized filename. <!-- @impl: src/routes/storage/download.ts::buildContentDisposition --> <!-- @test: src/__tests__/routes/storage-download.test.ts (Storage Download Routes) -->
4. One delete request processes keys and/or prefixes server-side. It reports confirmed deletions and explicit failures for unconfirmed responses, per-object rejection, or incomplete pagination. A failed prefix is not reported as complete and does not roll back earlier deletions. <!-- @impl: src/routes/storage/delete.ts::app --> <!-- @impl: src/lib/r2-client.ts::emptyR2Bucket --> <!-- @test: src/__tests__/routes/storage-delete.test.ts (Storage Delete Route) --> <!-- @test: src/__tests__/routes/storage-delete-prefix-results.test.ts (Storage Delete Route real prefix results / REQ-STOR-007 AC4) --> <!-- @test: src/__tests__/lib/r2-client.test.ts (emptyR2Bucket) -->
5. The preview endpoint returns recognized text inline only when the successful GET body is at most 1 MiB (1,048,576 bytes). Oversized or non-text objects return metadata without content. A failed GET is not a preview. <!-- @impl: src/routes/storage/preview.ts::app --> <!-- @test: src/__tests__/routes/storage-preview.test.ts (REQ-STOR-007 AC5: accepts exactly 1 MiB of UTF-8 text) --> <!-- @test: src/__tests__/routes/storage-preview.test.ts (REQ-STOR-007 AC5: cancels oversized text despite HEAD length %s) --> <!-- @test: src/__tests__/routes/storage-preview.test.ts (REQ-STOR-007 AC5: does not return a failed GET body as a preview) --> <!-- @test: src/__tests__/routes/storage-preview.test.ts (returns binary metadata for image files (no content GET)) --> <!-- @manual -->
6. On request, the download endpoint serves a file inline for in-browser viewing rather than as an attachment when the caller passes `?disposition=inline`. <!-- @impl: src/routes/storage/download.ts::INLINE_IMAGE_TYPES --> <!-- @test: src/__tests__/routes/storage-download.test.ts (REQ-STOR-007: serves an inline image with its real type, inline disposition, and nosniff) -->
7. The inline view path enforces an XSS-safe content-type: known image types and PDF keep their real MIME type while all other types, including HTML and SVG, are served as inert text so user-supplied markup cannot execute in the user's session. <!-- @impl: src/routes/storage/download.ts::safeInlineContentType --> <!-- @test: src/__tests__/routes/storage-download.test.ts (safeInlineContentType) -->

**Constraints:**

- R2 reads and writes observe the committed encryption regime and its explicit exceptions in [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine).
- Each endpoint has its own per-user rate limit appropriate to its expected access pattern.
- UI presentation, architectural source-of-truth, and prefix-traversal validation are specified in [REQ-STOR-016](#req-stor-016-file-browser-presentation-and-traversal-safety).

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated: [storage-browse.test.ts](../../src/__tests__/routes/storage-browse.test.ts), [storage-upload.test.ts](../../src/__tests__/routes/storage-upload.test.ts), [storage-download.test.ts](../../src/__tests__/routes/storage-download.test.ts), [storage-delete.test.ts](../../src/__tests__/routes/storage-delete.test.ts), [storage-delete-prefix-results.test.ts](../../src/__tests__/routes/storage-delete-prefix-results.test.ts), [r2-client.test.ts](../../src/__tests__/lib/r2-client.test.ts), [storage-preview.test.ts](../../src/__tests__/routes/storage-preview.test.ts); Manual: [upload and preview acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-007-upload-and-preview-acceptance)

**Status:** Implemented

---

### REQ-STOR-008: Multipart Upload for Large Files

**Intent:** Files larger than the single-request upload limit must be uploadable via chunked multipart upload.

**Applies To:** User

**Acceptance Criteria:**

1. The multipart initiate endpoint creates a multipart upload and returns an upload identifier bound durably to the bucket owner, object key, regime and generation. <!-- @test: src/__tests__/container/storage-multipart-durable.test.ts (REQ-STOR-008 AC1/AC2: native storage retains multipart binding across coordinator reconstruction and rejects a mismatched owner before part mutation) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-STOR-008 AC1/AC2: %s part replay is rejected without changing stored receipts or part bytes) --> <!-- @impl: src/container/index.ts::runBucketMultipart --> <!-- @impl: src/routes/storage/upload.ts::performBucketMultipart --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (returns uploadId on success) --> <!-- @manual -->
2. The multipart part endpoint uploads a single part for a current-generation managed upload identifier. <!-- @test: src/__tests__/container/storage-multipart-durable.test.ts (REQ-STOR-008 AC1/AC2: native storage retains multipart binding across coordinator reconstruction and rejects a mismatched owner before part mutation) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-STOR-008 AC1/AC2: %s part replay is rejected without changing stored receipts or part bytes) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-SEC-005: %s emits SSE-C only for the committed encrypted regime) --> <!-- @impl: src/routes/storage/upload.ts::performBucketMultipart --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (returns etag on success) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (sends partNumber and uploadId in URL) --> <!-- @manual -->
3. The multipart complete endpoint finalizes current-generation managed uploads only on a verified provider result. Unknown/stale IDs require restart without deleting parts; uncertain completion retains a durable recovery fence. <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-086: in-flight completion settles before migration; stale/unknown IDs preserve parts and request restart) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-086: lost completion response gates migration until explicit abort confirms recovery) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-ENTERPRISE-086: %s completion returns actionable restart without R2 writes) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-ENTERPRISE-086: unverifiable completion response %s retains recovery admission) --> <!-- @impl: src/routes/storage/upload.ts::performBucketMultipart --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (succeeds with valid parts) -->
4. The authenticated, bucket-scoped multipart abort endpoint reports success only when R2 accepts the abort; ordinary non-2xx responses fail. Only explicit recovery of the exact durable pending completion accepts definitive 404 as confirmed absence. <!-- @impl: src/routes/storage/upload.ts::performBucketMultipart --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (succeeds and returns { success: true }) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (does not report success when R2 rejects the bucket-scoped abort) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-086: lost completion response gates migration until explicit abort confirms recovery) -->
5. All multipart endpoints share a single rate-limit bucket so an attacker cannot bypass the upload limit by interleaving phases. <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-STOR-008 AC5: shared rate limit across multipart endpoints) --> <!-- @manual -->
6. The browser automatically aborts ordinary multipart failures before sending Complete. A `MULTIPART_RESTART_REQUIRED` refusal never triggers automatic deletion of parts. <!-- @impl: web-ui/src/stores/storage.ts::uploadFiles --> <!-- @test: web-ui/src/__tests__/api/storage.test.ts (REQ-STOR-008 AC6: preserves the multipart restart refusal code) --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-008 AC6: pre-completion failure preserves refused parts=%s) -->
7. The upload queue offers explicit abort for unconfirmed Complete. After reload it rediscovers the bucket’s pending identity; that recovery request refuses a changed key or ID. Dismissing confirmation leaves the upload untouched; an unconfirmed abort remains retryable. <!-- @impl: web-ui/src/stores/storage.ts::abortUnconfirmedUpload --> <!-- @impl: web-ui/src/components/storage/UploadQueue.tsx::UploadQueue --> <!-- @impl: web-ui/src/stores/storage.ts::refreshMultipartRecovery --> <!-- @impl: src/routes/storage/upload.ts::performBucketMultipart --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-STOR-008 AC7: a fresh bucket-scoped request recovers only the exact pending upload) --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-008 AC7: a fresh upload queue rediscovers the server-recorded recovery action) --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-008 AC7: only confirmed recovery aborts the unconfirmed upload, and failed recovery stays available) -->

**Constraints:**

- Platform multipart operations share the bucket DO admission with migration; pending completion blocks migration until explicit matching abort confirmation.
- Direct R2 writers must remain quiescent during migration maintenance.
- Each uploaded part is encrypted with SSE-C when server-side encryption is configured.
- `/upload/*` uses a 100 MiB request-body limit instead of the general API limit. The part endpoint receives JSON with base64 content and decodes it before the binary R2 write. <!-- @impl: src/routes/storage/index.ts::app --> <!-- @impl: src/routes/storage/upload.ts::performBucketMultipart -->

**Priority:** P1

**Dependencies:** [REQ-STOR-007](#req-stor-007-web-file-browser)

**Verification:** Automated: [index.test.ts](../../src/__tests__/container/index.test.ts), [native multipart reconstruction](../../src/__tests__/container/storage-multipart-durable.test.ts), [storage-upload.test.ts](../../src/__tests__/routes/storage-upload.test.ts), [storage API tests](../../web-ui/src/__tests__/api/storage.test.ts), [storage store tests](../../web-ui/src/__tests__/stores/storage.test.ts); Manual: [multipart and shared limit acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-008-multipart-and-shared-limit-acceptance)

**Status:** Implemented

---

### REQ-STOR-009: Getting-Started Docs Auto-Seeded on First Session

**Intent:** New users must find starter documentation in their storage on first use so they have immediate orientation material. Because a freshly created bucket is not always immediately writable on the R2 data plane, seeding must be self-healing rather than a single best-effort attempt at creation time.

**Applies To:** User

**Acceptance Criteria:**

1. When a user's R2 bucket is created for the first time, tutorial documents are written to the bucket root. <!-- @impl: src/lib/r2-seed.ts::seedGettingStartedDocs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedGettingStartedDocs / REQ-STOR-009 (per-user R2 bucket seeded with getting-started docs on first access)) -->
2. An explicit manual action recreates tutorial documents, overwriting their existing files. <!-- @impl: src/routes/storage/seed.ts::app --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (recreates getting-started docs with overwrite enabled) --> <!-- @manual -->
3. Successful explicit tutorial recreation invalidates cached storage stats so the next stats request recomputes them. Startup and browse seeding do not invalidate them. <!-- @test: src/__tests__/routes/storage-seed.test.ts (invalidates storage-stats KV cache after successful getting-started seed) --> <!-- @manual -->
4. A failed seed call retries with bounded exponential backoff, up to four attempts by default. Exhausting the attempts does not record success. <!-- @test: src/__tests__/lib/r2-seed.test.ts (REQ-STOR-009 AC4: default backoff reaches the fourth attempt at 2100ms (last attempt succeeds: %s)) --> <!-- @impl: src/lib/r2-seed.ts::seedGettingStartedDocs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (retries on a transient failure and succeeds on a later attempt (AC5)) --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (throws after exhausting retries when the failure persists (AC5)) -->
5. Session start retries non-overwriting tutorial seeding until success is recorded, including for existing buckets. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (ensureBucketAndSeed) -->

**Constraints:**

- Seeding is idempotent in non-overwrite mode: files that already exist at the target keys are skipped, never duplicated.
- Tutorial source content is a build-time artifact; the spec governs *that* it ships, not where the source lives.
- Destructive manual overwrite uses the low storage-seed ceiling in [REQ-SEC-019](security.md#req-sec-019-per-endpoint-rate-limit-policy) AC6.
- Once success is recorded, startup preserves edits and deletions without reseeding.

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated: [r2-seed.test.ts](../../src/__tests__/lib/r2-seed.test.ts), [storage-seed.test.ts](../../src/__tests__/routes/storage-seed.test.ts), [container-lifecycle-helpers.test.ts](../../src/__tests__/routes/container-lifecycle-helpers.test.ts); Manual: [tutorial recreation acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-009-tutorial-recreation-acceptance)

**Status:** Implemented

---

### REQ-STOR-010: Agent Configs Auto-Seeded Based on Session Mode

**Intent:** Each user's R2 bucket must contain the correct agent configuration files for their session mode (Standard or Pro) so that agents start with the right rules, skills, and tools.

**Applies To:** User

**Acceptance Criteria:**

1. On first bucket creation, seeding writes mode-appropriate preseed files to R2 without overwriting or cleaning up. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @impl: src/routes/storage/browse.ts::app --> <!-- @impl: src/lib/r2-seed.ts::seedAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seeds only missing agent configs when overwrite=false) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-MEM-011 AC3: reconciles agent configs (overwrite:false, cleanup:false) when the bucket is newly created) --> <!-- @test: src/__tests__/routes/storage-browse.test.ts (auto-creates missing bucket and seeds docs once) -->
2. The agent-config seed endpoint runs a full reconciliation that overwrites existing selected configs. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC1 + REQ-STOR-024 AC2: Default and Advanced stream identical mode payloads with active release provenance) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (REQ-STOR-010 AC2/AC3/AC4: real mode reconciliation overwrites variants, removes out-of-mode configs, and retains user bytes) -->
3. Cleanup outside verified Exclusive roots stays within preseed ownership rules. Within those roots, the active Exclusive policy may remove personal additions under [AD147](../../documentation/decisions/README.md#ad147-active-managed-resource-policy-supersedes-provenance-ownership). <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC2: prior release markers guard managed cleanup) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (REQ-STOR-010 AC2/AC3/AC4: real mode reconciliation overwrites variants, removes out-of-mode configs, and retains user bytes) -->
4. Variant-per-mode keys (instruction files whose content differs between modes) are excluded from cleanup so a mode switch never deletes a file the new mode still owns. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (REQ-STOR-010 AC2/AC3/AC4: real mode reconciliation overwrites variants, removes out-of-mode configs, and retains user bytes) -->
5. Best-effort baked cleanup reports partial deletion warnings; managed reconciliation treats cleanup warnings as failure and does not publish an incomplete release as applied. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForBootstrap --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-010 AC5: cleanup warnings fail the endpoint without replacing a protected applied identity) -->
6. The universal Pro seed inventory strictly contains the Standard inventory and adds the memory plugin, agent definitions, hooks, slash commands, discipline rules, and skills. Deployment agent selection and context-mode eligibility govern what is actually written. <!-- @impl: src/lib/agent-seed.generated.ts::AGENTS_SEEDED_CONFIGS --> <!-- @impl: src/lib/r2-seed.ts::getConfigsForMode --> <!-- @test: src/__tests__/lib/agent-seed-bake.test.ts (REQ-STOR-010 AC6: actual Pro seed is a strict file superset with all advanced capability families) -->
7. Full reconciliation from the agent-config seed endpoint removes out-of-mode files subject to the ownership and variant safeguards in AC3/AC4. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (REQ-STOR-010 AC2/AC3/AC4: real mode reconciliation overwrites variants, removes out-of-mode configs, and retains user bytes) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024 AC6: cacheless application cleans only current-release paths outside the effective mode) -->

**Constraints:**

- Reconciliation activation and ownership semantics follow [REQ-STOR-033](#req-stor-033-managed-release-delta-planning-and-resume): explicit re-seed and mode changes overwrite desired keys, while automatic upgrades preserve release-identical keys.
- Only files the build never seeded are preserved as the user's own outside automatic managed-release delta semantics ([REQ-STOR-019](#req-stor-019-seeded-files-are-marked-and-retired-ones-are-removed)).
- Claude source supplies shared variants; separately owned Pi native entries follow [REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth).
- Preseed configuration must validate that no two entries within a single mode share the same key.

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated: [r2-seed.test.ts](../../src/__tests__/lib/r2-seed.test.ts), [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts), [r2-seed-mode.test.ts](../../src/__tests__/lib/r2-seed-mode.test.ts), [storage-seed-managed.test.ts](../../src/__tests__/routes/storage-seed-managed.test.ts), [agent-seed-bake.test.ts](../../src/__tests__/lib/agent-seed-bake.test.ts), [first-Start seeding](../../src/__tests__/routes/container-r2-start.test.ts), [first-browse seeding](../../src/__tests__/routes/storage-browse.test.ts)

**Status:** Implemented

---

### REQ-STOR-011: Sync Mode Controls Workspace Scope

**Intent:** Users must be able to choose how much of their workspace is synced to R2, balancing persistence against sync overhead.

**Applies To:** User

**Acceptance Criteria:**

1. The default workspace sync scope (`none`) excludes the workspace directory entirely. <!-- @impl: entrypoint.sh::SYNC_MODE --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->
2. The full sync scope (`full`) syncs the entire workspace directory, excluding dependency-install directories. <!-- @impl: entrypoint.sh::SYNC_MODE --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->
3. The metadata sync scope (`metadata`) syncs only the agent-config files (per-repo agent instruction files and the per-repo agent rule directory). <!-- @impl: entrypoint.sh::SYNC_MODE --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) -->
4. Every sync scope excludes the [documented caches, logs, ephemeral data, root Pi work-evidence, dependency trees, build artifacts, regenerable state, vendor credential caches and disposable Temporary checkout/download paths](../../documentation/lanes/storage-and-sync.md#whats-synced-vs-excluded-req-stor-011). Ordinary Temporary and Uploads content remains persistent. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (workspaceSyncEnabled scope (REQ-STOR-011)) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-011 AC4: excludes only root Pi work-evidence in every sync scope) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-011 AC4: disposable agent checkouts never sync while user trays remain persistent) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-011 AC4: excludes directories ending in node_modules in both persistence modes) -->

**Constraints:**

- In `none` scope, home persistence still follows the selected Include/Exclude policy and session mode under [REQ-STOR-055](#req-stor-055-home-persistence-admission-and-scope-transitions).
- [REQ-STOR-258](#req-stor-258-home-cache-exclusion) keeps `~/.cache/` out of R2 restore and sync in every scope.
- Hermes transient files follow [REQ-MEM-035 AC2](memory.md#req-mem-035-durable-pi-facts-with-disposable-local-search), even when colocated with durable session Markdown.
- Unknown future files inside admitted durable namespaces remain eligible; detecting every novel cache is not guaranteed.
- Exclusion authorizes neither deletion nor classifying user content as disposable.
- Administration’s single Data governance selector applies to new/restarted sessions; workspace toggle remains independent; no per-file enrollment/second settings surface/additional scheduler.
- In normal restore and sync, managed-resource, cache and sync-recovery exclusions take precedence over base scope filters.
- Container API remains binary workspace sync (full/none); metadata scope is direct-configuration-only.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** Automated: [entrypoint-hooks-merge.test.js](../../host/__tests__/entrypoint-hooks-merge.test.js), [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js)

**Status:** Implemented

---

<a id="req-stor-258-recovery-archive-isolation"></a>
### REQ-STOR-258: Home cache exclusion

**Intent:** The home cache is not an R2 persistence location. Users keep files they want to persist in designated folders under their existing sync rules.

**Applies To:** User

**Acceptance Criteria:**

1. R2 restore and bisync neither download nor upload `~/.cache/` in any session or workspace mode, even when a nested name would otherwise match an inclusion rule. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_recovery_archive_filters) -->
2. The R2 transfer filters do not remove existing excluded home-cache files on either side. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_recovery_archive_filters) -->
3. Excluding the home cache does not change which files outside it are restored or synchronized under the selected session and workspace modes. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_recovery_archive_filters) -->

**Notes:** Standalone test scope and CI exclusions are documented under [Storage verification](../../documentation/lanes/storage-and-sync.md#storage-verification).

**Constraints:** Cache exclusion takes precedence over base scope rules and authorizes no deletion. The home cache has no supported backup or recovery workflow.

**Priority:** P1

**Dependencies:** [REQ-STOR-011](#req-stor-011-sync-mode-controls-workspace-scope)

**Verification:** Automated: [rclone-bisync-s3.py](../../scripts/ci/rclone-bisync-s3.py)

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
5. Apart from separately required [Pi conflict-copy removal](#req-stor-051-pi-transcript-conflict-cleanup), cleanup changes only selected candidate files. Cleanup skips a store if its configured path resolves through a symlink. <!-- @impl: transcript-retention.mjs::main --> <!-- @impl: transcript-retention.mjs::deletePiConflictFiles --> <!-- @impl: transcript-retention.mjs::retainLatest --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (AC5: Claude subagents, Pi tasks, and Codex state are untouched) --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (REQ-STOR-012 AC1/AC5: a symlinked transcript-root ancestor cannot prune another directory) -->
6. Normal startup attempts transcript pruning after restore and before signaling PTY prewarm. The degraded host timeout may release prewarm without that signal under [REQ-SESSION-015](session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition). <!-- @impl: entrypoint.sh::release_agent_pty_after_cleanup --> <!-- @impl: host/src/server.ts::waitForInitFlag --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (main transcript retention / REQ-STOR-012) -->
7. After regular or final bisync passes its disk-space and filter checks, it attempts transcript cleanup before invoking the transfer. Cleanup failure alone does not prevent the transfer. <!-- @impl: entrypoint.sh::cleanup_main_transcripts --> <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (AC7: cleanup failure does not prevent the outbound bisync) -->

**Constraints:**

- Adapter paths and native schema checks live in [storage-and-sync.md](../../documentation/lanes/storage-and-sync.md#session-transcript-cleanup); recoverable malformed records retain native ordering, while content heuristics and Codeflare capture/extraction state never classify candidates.
- Codex retains its existing storage and filtering behavior.

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** Automated: [entrypoint-governed-sync.test.js](../../host/__tests__/entrypoint-governed-sync.test.js), [entrypoint-transcript-cleanup.test.js](../../host/__tests__/entrypoint-transcript-cleanup.test.js)

**Status:** Implemented

---

### REQ-STOR-014: R2 Storage Stats Caching

**Intent:** Storage statistics must be available quickly without paginating all R2 objects on every request.

**Applies To:** User

**Acceptance Criteria:**

1. On a cache miss, storage stats paginate all R2 objects in the owner's bucket. A malformed page, invalid or repeated continuation, or failed continuation returns an error without caching an aggregate. A first-page not-found response returns empty stats. <!-- @impl: src/routes/storage/stats.ts::app --> <!-- @impl: src/lib/r2-client.ts::parseListObjectsXml --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (paginates through IsTruncated responses) --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (REQ-STOR-014 AC1: refuses to cache a listing with %s) --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (REQ-STOR-014 AC1: a continuation 404 is not an empty bucket) --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (returns zeroes for a first-page 404) --> <!-- @manual -->
2. Ancillary session status reuses cached storage stats without an age check or an R2 listing. It can show an older aggregate until the stats endpoint refreshes it or a mutation invalidates it. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (returns cached storage and entitlement state outside the D1 hot path) -->
3. Successful uploads, deletes, and seeds invalidate the stats cache. A dispatched prefix delete also invalidates it when later listing or deletion fails because earlier deletions may already have taken effect. <!-- @impl: src/routes/storage/upload.ts::app --> <!-- @impl: src/routes/storage/delete.ts::app --> <!-- @test: src/__tests__/routes/storage-delete-prefix-results.test.ts (REQ-STOR-014 AC3: invalidates stats when a later page fails after deletion) --> <!-- @test: src/__tests__/routes/storage-delete-prefix-results.test.ts (reports a quiet per-object error against the prefix, never as completed deletion) --> <!-- @impl: src/routes/storage/seed.ts::app --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (invalidates KV cache after successful simple upload) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (invalidates KV cache after successful multipart complete) --> <!-- @test: src/__tests__/routes/storage-delete.test.ts (pre-populated stats cache is removed after single delete) --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (invalidates storage-stats KV cache after successful getting-started seed) --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (invalidates storage-stats KV cache after successful agent-configs seed) --> <!-- @manual -->
4. A stats cache hit returns the cached tier quota without an additional tier-configuration lookup. <!-- @impl: src/routes/storage/stats.ts::app --> <!-- @manual -->
5. The stats endpoint caches the complete aggregate and treats it as fresh for 60 seconds. The KV record itself does not expire on that schedule. <!-- @impl: src/routes/storage/stats.ts::app --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (uses KV cache when fresh (<60s)) --> <!-- @test: src/__tests__/routes/storage-stats.test.ts (refreshes stale cache (>60s)) --> <!-- @manual -->

**Constraints:**

- The stats endpoint has a separate rate-limit budget that polling cannot spend on behalf of browse, upload, or download.
- A cache miss triggers a full R2 listing which may be slow for large buckets; callers must tolerate elevated latency on miss.

**Priority:** P1

**Dependencies:** [REQ-STOR-001](#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated: [storage-stats.test.ts](../../src/__tests__/routes/storage-stats.test.ts), [session-ancillary-status.test.ts](../../src/__tests__/routes/session-ancillary-status.test.ts), [storage-upload.test.ts](../../src/__tests__/routes/storage-upload.test.ts), [storage-delete.test.ts](../../src/__tests__/routes/storage-delete.test.ts), [storage-delete-prefix-results.test.ts](../../src/__tests__/routes/storage-delete-prefix-results.test.ts), [storage-seed.test.ts](../../src/__tests__/routes/storage-seed.test.ts); Manual: [cached statistics acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-014-cached-statistics-acceptance)

**Status:** Implemented

---

<a id="req-stor-015-user-triggered-multi-session-sync"></a>
### REQ-STOR-015: Explicit Sync Trigger from UI

**Intent:** Because the periodic bisync cadence is 15 minutes ([REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), users must have explicit ways to force convergence between the container filesystem and R2 without waiting for the next cycle.

**Applies To:** User

**Acceptance Criteria:**

1. The endpoint fans out trigger requests to the authenticated owner's D1 workload-owning sessions (`starting`, `running`, `unreachable`, `stopping`), excluding stopped sessions on the server. During bucket migration it sends no triggers and returns an empty result. <!-- @test: src/__tests__/lib/sync-fanout.test.ts (REQ-STOR-015 AC1: fans out to all owner workload states but not stopped or foreign sessions) --> <!-- @impl: src/lib/session-helpers.ts::listRunningSessionIds --> <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/routes/sessions-sync.test.ts (fans the bisync trigger out to each running session (happy path)) --> <!-- @test: src/__tests__/routes/sessions-sync.test.ts (skips stopped sessions (only running sessions are fanned out)) --> <!-- @test: src/__tests__/routes/sessions-sync.test.ts (skips the entire fan-out while the bucket is migrating (no container is contacted)) -->
2. Fan-out runs triggers in bounded parallel batches, starting the next batch only after the current one settles. The concurrency bound does not cap total requests across all selected sessions. <!-- @test: src/__tests__/lib/sync-fanout.test.ts (REQ-STOR-015 AC2: the next batch waits for the last settlement, including a rejection) --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (REQ-STOR-015 AC2: accounts for all boundary requests in a 128-session fan-out) --> <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (AC2: caps concurrent in-flight container.fetch calls at 8) -->
3. Failure to trigger one session does not prevent attempts for the other sessions. A successful trigger does not establish bisync completion. <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/routes/sessions-sync.test.ts (isolates a per-session failure (one container errors, the other still triggers)) --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (AC3: per-session failures do not break the rest of the fan-out) -->
4. The sync-trigger endpoint is rate-limited per user using the same destructive-action rate-limiter pattern applied to other expensive endpoints. <!-- @impl: src/routes/session/lifecycle.ts::sessionsSyncRateLimiter --> <!-- @manual -->
5. The trigger is idempotent: an external trigger to the bisync daemon while a bisync is already in flight causes exactly one rerun after the current cycle completes (N concurrent triggers coalesce to one rerun, not N). <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (N SIGUSR1s arriving mid-flight coalesce into exactly one rerun (REQ-STOR-003 AC2 / REQ-STOR-015 AC5: in-flight coalesce branch)) -->
6. The frontend Sync-now control is disabled while any of the user's sessions reports an in-flight sync and re-enables once all sessions transition out. <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (REQ-STOR-015 AC6: stays disabled after the first session settles and enables only after the last) --> <!-- @impl: web-ui/src/components/storage/StorageToolbar.tsx::StorageToolbar --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (Sync-now fan-out button (REQ-STOR-015 AC6)) -->
7. Each response row reports trigger admission (`triggered`, `not-running`, or `failed`), not transfer completion. The top-level `count` includes all result rows. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/routes/sessions-sync.test.ts (isolates a per-session failure (one container errors, the other still triggers)) --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (AC3: per-session failures do not break the rest of the fan-out) -->

**Constraints:**

- Sync runs only on the periodic cadence ([REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), explicit user action, or final shutdown ([REQ-STOR-005](#req-stor-005-graceful-shutdown-performs-final-sync)).
- R2 uploads never trigger automatic fan-out; users can trigger sync or await the periodic cycle.
- Multi-session fan-out retains newest-file-wins bisync semantics and its merge/concurrency qualifications; see [Conflict Resolution](../../documentation/lanes/storage-and-sync.md#conflict-resolution).

**Priority:** P1

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-STOR-007](#req-stor-007-web-file-browser), [REQ-STOR-011](#req-stor-011-sync-mode-controls-workspace-scope)

**Verification:** Automated: [sessions-sync.test.ts](../../src/__tests__/routes/sessions-sync.test.ts), [sync-fanout.test.ts](../../src/__tests__/lib/sync-fanout.test.ts), [entrypoint-bisync-behavior.test.js](../../host/__tests__/entrypoint-bisync-behavior.test.js), [StorageBrowser.test.tsx](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx); Manual: [per-user sync limit acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-015-per-user-sync-limit-acceptance)

**Status:** Implemented

---

### REQ-STOR-016: File browser presentation and traversal safety

**Intent:** The web file browser must present consistently across form factors, treat R2 as the single source of truth (not the container filesystem), and reject directory-traversal probes at the prefix-listing endpoint. Breadcrumb navigation follows [REQ-STOR-261](#req-stor-261-storage-breadcrumb-navigation).

**Applies To:** User

**Acceptance Criteria:**

1. The file browser renders as a slide-in side drawer on desktop and a bottom-sheet on mobile. <!-- @impl: web-ui/src/components/StoragePanel.tsx::StoragePanel --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser / REQ-STOR-016 AC1/AC2 (file browser drawer/bottom-sheet presentation, R2 as source of truth via Worker API)) -->
2. The file browser lists persisted R2 content, not the live container filesystem. <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser / REQ-STOR-016 AC1/AC2 (file browser drawer/bottom-sheet presentation, R2 as source of truth via Worker API)) --> <!-- @impl: src/routes/storage/browse.ts::app -->
3. The browse endpoint validates the requested prefix against directory-traversal probes and rejects parent-directory references. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/routes/storage-browse.test.ts (Storage Browse Routes / REQ-STOR-007 (web file browser: browse endpoint with prefix validation, rate-limited)) -->
4. Clicking a file in the browser opens it inline in a new browser tab (view) rather than downloading it. <!-- @impl: web-ui/src/components/storage/FileList.tsx::FileList --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (FileList — clicking a file opens it in a new tab (not download)) -->
5. Every folder row surfaces its in-container path in `~/<prefix>` form so the user can see where it maps, at any depth and including dotfolders. <!-- @impl: web-ui/src/components/storage/FileList.tsx::folderShortPath --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (FileList — every folder surfaces its ~/ container path (REQ-STOR-016)) -->
6. A special folder surfaces its canonical container-path mapping instead of the derived form, since its prefix casing can differ (`workspace/` maps to `~/Workspace`). <!-- @impl: web-ui/src/components/storage/FileList.tsx::shortContainerPath --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (FileList — special folder surfaces its container path on the row) --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (REQ-STOR-016 AC6: lowercase workspace prefix uses the canonical ~/Workspace mapping) -->

**Constraints:** The file browser and settings panel are mutually exclusive in the UI.

**Priority:** P1

**Dependencies:** [REQ-STOR-007](#req-stor-007-web-file-browser)

**Verification:** Automated: [storage-browse.test.ts](../../src/__tests__/routes/storage-browse.test.ts), [FileList.test.tsx](../../web-ui/src/__tests__/components/FileList.test.tsx), [StorageBrowser.test.tsx](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx)

**Status:** Implemented

---

### REQ-STOR-261: Storage breadcrumb navigation

**Intent:** Make the current storage path discoverable at any viewport width.

**Applies To:** User

**Acceptance Criteria:**

1. On folder navigation, an overflowing breadcrumb scrolls once to its current end on desktop, tablet, and mobile, without animation under reduced motion. <!-- @impl: web-ui/src/components/storage/StorageBreadcrumbs.tsx::StorageBreadcrumbs --> <!-- @impl: web-ui/src/styles/storage-browser.css::.storage-breadcrumbs --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (REQ-STOR-261: opening an overflowing directory scrolls to the end once at width %s) --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (REQ-STOR-261: reduced motion reveals the breadcrumb end without animation at width %s) --> <!-- @manual: Use the Storage breadcrumb browser acceptance procedure to observe the rendered rail. -->
2. The focusable current crumb exposes its full path. <!-- @impl: web-ui/src/components/storage/StorageBreadcrumbs.tsx::StorageBreadcrumbs --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (REQ-STOR-261: the current folder exposes its full path on a focusable crumb and ancestors still navigate) -->
3. Users can scroll back to earlier path segments and navigate to an ancestor. <!-- @impl: web-ui/src/components/storage/StorageBreadcrumbs.tsx::StorageBreadcrumbs --> <!-- @impl: web-ui/src/styles/storage-browser.css::.storage-breadcrumbs --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (REQ-STOR-261: opening an overflowing directory scrolls to the end once at width %s) --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (REQ-STOR-261: the current folder exposes its full path on a focusable crumb and ancestors still navigate) --> <!-- @manual: Use the Storage breadcrumb browser acceptance procedure to observe the rendered rail. -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-STOR-016](#req-stor-016-file-browser-presentation-and-traversal-safety)

**Verification:** Automated: [StorageBrowser.test.tsx](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx); Manual: [Storage breadcrumb browser acceptance](../../documentation/lanes/storage-and-sync.md#storage-breadcrumb-browser-acceptance)

**Status:** Implemented

---

### REQ-STOR-017: Faster startup sync — bisync HEAD-storm fix + Governed Mode preseed bake

**Intent:** Startup and steady-state sync must avoid unnecessary R2 round-trips, reuse image-baked seed and transpilation work, and never restore retired managed Pi extensions.

**Applies To:** User

**Acceptance Criteria:**

1. Both bisync invocations (the retrying `--resync` baseline and steady-state cycle) compare object freshness via R2 server modification times from the bulk listing instead of a per-object metadata request, and check up to 64 objects concurrently, eliminating the per-file HEAD storm. <!-- @test: scripts/ci/rclone-bisync-s3.py (test_server_modtime_sync) --> <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 / AD88: bisync uses server-modtime + wider checkers (entrypoint.sh)) -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface)

**Verification:** Automated: [entrypoint-governed-sync.test.js](../../host/__tests__/entrypoint-governed-sync.test.js), [rclone-bisync-s3.py](../../scripts/ci/rclone-bisync-s3.py)

**Status:** Implemented

---

### REQ-STOR-256: Image seed relay cache reuse and prewarm priority

**Intent:** Applicable image seed and baked relay work accelerates startup while remote curation retains release ownership and background initialization yields to Pi pre-warm.

**Applies To:** User

**Acceptance Criteria:**

1. The image-baked agent tree is byte-identical to each mode's generated R2 seed, excluding the independently synchronized context-mode subtree. <!-- @impl: scripts/materialize-agent-seed.mjs::CONTEXT_MODE_KEY_PREFIX --> <!-- @test: src/__tests__/lib/agent-seed-bake.test.ts (agent-seed bake byte-identity (REQ-STOR-017 / AD90)) -->
2. Governed startup without active verified remote curation lays down the matching baked seed before checksum-based initial sync, so unchanged seed files do not transfer. <!-- @test: host/__tests__/entrypoint-storage-restart.test.js (REQ-STOR-256 AC2: checksum restore skips unchanged baked payload and downloads changed same-size remote bytes) --> <!-- @impl: entrypoint.sh::lay_down_agent_seed_preseed --> <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 / AD90: image-baked agent-seed lay-down (entrypoint.sh lay_down_agent_seed_preseed)) -->
3. In the applicable baked relay branch, Pi's pre-transpilation cache hits across deployment modes: entrypoint relays existing managed extensions from the unfiltered image, backfills missing post-sync managed extensions from the mode-filtered bake, and preserves mode gates. <!-- @test: host/__tests__/entrypoint-storage-restart.test.js (REQ-STOR-256 AC3: relayed Pi extension loads from the real Jiti cache in a fresh process) --> <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 / AD90: post-sync managed Pi extension relay (entrypoint.sh relay_managed_pi_extensions)) --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (backfills a managed extension missing from the runtime from the mode-filtered bake) -->
4. With remote curation active, the relay preserves release-owned extension bytes and restores only declared image-owned runtime companions, without promising baked Jiti cache hits for curated sources. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-004 AC3/AC4 / REQ-STOR-031: baseline observes real post-restore Pi settings and managed content) -->
5. Concurrent background initialization yields CPU and disk priority to Pi PTY pre-warm independently of the deployment resource profile. <!-- @impl: entrypoint.sh::renice --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 AC5: real background and child priorities change without changing the foreground) --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017: background init yields CPU/disk to pi pre-warm (entrypoint.sh)) -->

**Constraints:**

- Preseed bake and checksum initial sync require Governed Mode.
- The in-image bake derives from the committed, freshness-enforced `src/lib/agent-seed.generated.ts`; it cannot drift from the seed or require a host.
- Jiti cache identity is `hash(absolute path + source + version)`, never a content-only key.
- Image construction fails unless every extension in the source directory has a baked cache after warming.
- Missing-extension backfill uses only the mode-filtered bake, never the unfiltered warm tree; Standard cannot gain advanced-only extensions.

**Priority:** P2

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-STOR-017](#req-stor-017-faster-startup-sync--bisync-head-storm-fix--governed-mode-preseed-bake)

**Verification:** Automated: [entrypoint-governed-sync.test.js](../../host/__tests__/entrypoint-governed-sync.test.js), [agent-seed-bake.test.ts](../../src/__tests__/lib/agent-seed-bake.test.ts), [entrypoint-managed-curation.test.js](../../host/__tests__/entrypoint-managed-curation.test.js), [entrypoint-storage-restart.test.js](../../host/__tests__/entrypoint-storage-restart.test.js)

**Status:** Implemented

---

### REQ-STOR-257: Retired Pi extension sync exclusion and baked pruning

**Intent:** Common R2 filters exclude retired extension paths and the applicable baked relay prunes exact local retired names without deleting unrelated user extensions.

**Applies To:** User

**Acceptance Criteria:**

1. Every R2 sync excludes the exact retired Pi durable-review extension paths, so stale persisted copies cannot return before runtime initialization. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 AC6: retired Pi review extensions stay outside R2 sync) -->
2. In the applicable baked relay branch, the managed-extension relay prunes the exact retired durable-review filenames locally before Pi loads. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-STOR-017 AC7: removes retired durable-review extensions without deleting user additions) --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-004 AC3/AC4 / REQ-STOR-031: baseline observes real post-restore Pi settings and managed content) -->

**Constraints:**

- Retired-name pruning is exact and preserves every unrelated user-added extension.

**Priority:** P2

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-STOR-017](#req-stor-017-faster-startup-sync--bisync-head-storm-fix--governed-mode-preseed-bake)

**Verification:** Automated: [entrypoint-governed-sync.test.js](../../host/__tests__/entrypoint-governed-sync.test.js), [entrypoint-managed-curation.test.js](../../host/__tests__/entrypoint-managed-curation.test.js)

**Status:** Implemented

---

### REQ-STOR-018: File browser pagination is append-only and recoverable

**Intent:** Truncated R2 listings must remain navigable without replacing rows already shown or allowing stale continuation work to affect newer navigation.

**Applies To:** User

**Acceptance Criteria:**

1. A truncated listing exposes a continuation action even when the current rows do not fill a scrollable viewport. <!-- @impl: web-ui/src/components/storage/FileList.tsx::FileList --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (REQ-STOR-018 AC1: exposes continuation when the first page cannot scroll) -->
2. Reaching the list's scroll boundary requests the next R2 page once. <!-- @impl: web-ui/src/components/storage/FileList.tsx::FileList --> <!-- @test: web-ui/src/__tests__/components/FileList.test.tsx (REQ-STOR-018 AC2: requests the next page only at the scroll boundary) -->
3. A successful continuation appends unique rows in response order. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-018 AC3: appends a continuation page once and deduplicates rows) -->
4. A continuation response from a superseded browse cannot change the current listing, even after returning to the same prefix. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-018 AC4: ignores a continuation response from an older browse generation) -->
5. A failed continuation preserves the rows already loaded. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-018: preserves rows on failure and retries the same continuation) -->
6. Retrying a failed continuation reuses its continuation token. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-018: preserves rows on failure and retries the same continuation) -->
7. On Dashboard or browser-tab visibility return, Storage reuses the current folder and quietly refreshes it at most once per five minutes. Automatic refresh never replaces paginated rows. Periodic statistics updates continue without reloading the file list. <!-- @impl: web-ui/src/stores/storage.ts::refreshListingOnReturn --> <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (REQ-STOR-018 AC7: keeps periodic stats without periodically reloading the file list) --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-018 AC7: reuses fresh folder rows and quietly refreshes a stale return) --> <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-STOR-018 AC7: keeps accumulated pages on return but manual reload replaces them) --> <!-- @impl: web-ui/src/components/Layout.tsx::handleVisibilityChange --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-STOR-018 AC7: visibility return preserves loaded pages while manual Reload replaces them) -->

**Constraints:**

- Explicit navigation or manual refresh starts a new browse generation and resets pagination state.
- Only one continuation request is active per current browse generation. A superseded request may finish but cannot change the current listing.

**Priority:** P1

**Dependencies:** [REQ-STOR-007](#req-stor-007-web-file-browser), [REQ-STOR-016](#req-stor-016-file-browser-presentation-and-traversal-safety)

**Verification:** Automated: [FileList.test.tsx](../../web-ui/src/__tests__/components/FileList.test.tsx), [StorageBrowser.test.tsx](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx), [storage.test.ts](../../web-ui/src/__tests__/stores/storage.test.ts), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

### REQ-STOR-019: Seeded Files Are Marked and Retired Ones Are Removed

**Intent:** Remove retired preseed files supported by provenance or the explicit historical inventory while preserving files whose ownership is unproven.

**Applies To:** User

**Acceptance Criteria:**

1. Every seed write stamps a provenance marker in the object's R2 custom metadata: baked writes use the writing build's preseed content hash; managed writes use the active release digest. <!-- @impl: src/lib/r2-seed.ts::seedDocuments --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (stamps the marker on every overwrite write) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (stamps the marker on writes issued by the non-overwrite path) --> <!-- @impl: src/lib/r2-seed.ts::seedManagedDocuments --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC1 + REQ-STOR-024 AC2: Default and Advanced stream identical mode payloads with active release provenance) -->
2. Reconcile cleanup deletes an object under the seed's own prefixes that carries a provenance marker other than the current build's. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (deletes an object carrying a different build marker) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (keeps an object carrying the current build marker) -->
3. An object with no provenance marker is never deleted by the sweep, which is what makes a user-created file and a user-edited seed file equally safe. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (keeps an unmarked object as the user file) -->
4. Listing is confined to the two-segment prefixes the seed writes, keeping both the getting-started documents and the large runtime trees outside the sweep's reach. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (lists only inside the seed two-segment prefixes) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (never HEADs a key under a runtime tree outside those prefixes) -->
5. A prefix that is not listed completely, or a candidate set past the fan-out cap, produces a warning and withholds deletion over the scope it cannot vouch for — that prefix for an incomplete listing, the whole sweep for the cap. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (warns and deletes nothing when a prefix cannot be listed) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (deletes nothing from a prefix whose listing failed part-way) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (treats a truncated page with no continuation token as a failed listing) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (skips the sweep and warns when the candidate set is implausibly large) --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (skips the sweep when two prefixes are each under the cap but over it combined) -->
6. The generated seed carries the frozen historical retirement list and explicit product-generated orphan keys; cleanup deletes those by name. The list does not establish exhaustive coverage of historical unmarked keys. <!-- @impl: src/lib/agent-seed.generated.ts::RETIRED_PRESEED_KEYS --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (sweeps the pre-marker list even when no key is out of mode) -->
7. A key the current build still seeds is never deleted, by the by-name path or by the sweep. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (never deletes a key the current build still seeds, by name or by sweep) -->

**Constraints:**

- The marker value identifies the writing build and is never used to infer staleness on its own; only an object outside the current build's key set is a candidate.
- A key the seed once shipped is never appended to the by-name list; the marker identifies it instead.
- The list grows only for a product-generated file that was never a seeded key at all.
- Deletion requires a provenance marker or by-name membership that positively identifies product-generated content; all unproven content is kept.
- The preseed content hash includes the by-name list; shipping a changed list triggers the upgrade that applies it.
- The generator refuses to emit a by-name list naming a key the current build still seeds.
- Paths the agent runtime writes and owns are excluded from the sweep before the candidate cap is counted.

**Priority:** P1

**Dependencies:** [REQ-STOR-010](#req-stor-010-agent-configs-auto-seeded-based-on-session-mode), [REQ-AGENT-049](agents.md#req-agent-049-auto-upgrade-preseed-on-release)

**Verification:** Automated: [r2-seed-mode.test.ts](../../src/__tests__/lib/r2-seed-mode.test.ts), [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-020: Managed environment reconciliation

**Intent:** Verified managed releases advance monotonically within one runtime dependency set while deployments may switch safely between distinct runtime sets.

**Applies To:** Admin

**Acceptance Criteria:**

1. Verified assets are content-addressed in one deployment cache. <!-- @impl: src/lib/remote-curation-cache.ts::activateManagedRelease --> <!-- @test: src/__tests__/lib/remote-curation-cache.test.ts (REQ-STOR-020 AC1+AC2: active release cache is content-addressed and monotonic) -->
2. Each trust configuration advances monotonically within one runtime dependency set without same-sequence conflicts. <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) --> <!-- @impl: src/lib/remote-curation-cache.ts::activateManagedRelease --> <!-- @test: src/__tests__/lib/remote-curation-cache.test.ts (REQ-STOR-020 AC1+AC2: active release cache is content-addressed and monotonic) -->
3. Selecting a different deployed runtime dependency set may replace a globally newer incompatible pointer. <!-- @impl: src/lib/remote-curation-cache.ts::activateManagedRelease --> <!-- @test: src/__tests__/lib/remote-curation-cache.test.ts (replaces an incompatible active pointer even when its global sequence is higher) -->
4. Concurrent key selections for one repository settle on one authoritative winner. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
5. A losing concurrent selection makes at most four repair attempts. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
6. Reconfiguration fails explicitly when selection does not settle within the repair bound. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
7. Exhausted repair preserves the last observed authoritative selection. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->

**Constraints:** A losing selection cannot overwrite or roll back the winner.

**Priority:** P1

**Dependencies:** [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated: [remote-curation-cache.test.ts](../../src/__tests__/lib/remote-curation-cache.test.ts), [remote-curation.test.ts](../../src/__tests__/lib/remote-curation.test.ts)

**Status:** Implemented

---

### REQ-STOR-021: Managed content ownership

**Intent:** Managed reconciliation preserves mutable user ownership while removing exact files that verified inventory assigns to inactive deployment agents.

**Applies To:** User

**Acceptance Criteria:**

1. Managed writes carry active release provenance. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC1 + REQ-STOR-024 AC2: Default and Advanced stream identical mode payloads with active release provenance) -->
2. Active-agent and unknown historical paths are deleted in mutable mode only while valid Codeflare provenance remains. <!-- @impl: src/lib/r2-seed.ts::deleteManagedConfigsByMarkerRules --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021: active and unknown historical markerless paths retain ordinary marker ownership) -->
3. Exact paths assigned by current or available verified inventory to an inactive agent are deleted without requiring provenance, using conditional object identity. <!-- @impl: src/lib/r2-seed.ts::deleteExactInactiveConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021: exact inactive paths from current, prior, and interrupted inventories delete markerless with HEAD ETags) -->
4. Image-owned runtime files, user roots, transcripts, Vault content, and company package bytes remain outside managed documents. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @impl: src/lib/r2-seed.ts::reseedContextModePlugin --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC4: image-owned and user-owned roots remain outside managed documents) -->
5. In protected modes, signed retirements delete prior content without requiring an ownership marker. <!-- @impl: src/lib/r2-seed.ts::deleteRetiredManagedConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC5: protected signed retirement deletes markerless prior content) -->

**Constraints:**

- Except for protected signed retirements in AC5, markerless deletion requires an exact path with a verified inactive owner.
- Unknown historical paths keep existing marker rules; company extension metadata may enter R2, but package bytes may not.

**Priority:** P1

**Dependencies:** [REQ-STOR-019](#req-stor-019-seeded-files-are-marked-and-retired-ones-are-removed), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated: [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-259: Managed reconciliation admission

**Intent:** Managed reconciliation never mutates a user bucket while a session owns it.

**Applies To:** User

**Acceptance Criteria:**

1. A release mismatch performs no bucket mutation while any D1 session lifecycle is workload-owning (`starting`, `running`, `unreachable`, `stopping`); stale running or stopped KV projections do not decide ownership. Unavailable D1 reads fail closed rather than authorizing mutation. <!-- @impl: src/lib/session-helpers.ts::hasOwningSessionContainer --> <!-- @impl: src/routes/storage/seed.ts::assertNoOwningSession --> <!-- @test: src/__tests__/lib/session-helpers.test.ts (hasOwningSessionContainer) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (retries automatic reconciliation when stale running metadata points to persisted stopped state) -->
2. A reconcilable mismatch or pending target reports pending status while a container owns the bucket and upgrading after the last owner stops. Journal-only targets remain visible. <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC4: journal-only reconciliation remains visible with bucket ownership %s) --> <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @impl: src/lib/session-helpers.ts::hasOwningSessionContainer --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-022 AC1+AC2: a running session defers mutation and reports pending status) --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-022: stale running metadata does not strand reconciliation after persisted stop) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-STOR-022 AC2: maps update_pending without invoking reconciliation) -->
3. The backend rejects another start until mismatch or pending-target reconciliation succeeds. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (returns a typed 409 before user-bucket or container work when the active release is not applied) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-STOR-022 AC3: blocks container start while interrupted targets remain pending) -->

**Constraints:** State lookup inspects existing session records without waking containers; unavailable or unknown state fails closed as ownership.

**Priority:** P1

**Dependencies:** [REQ-STOR-023](#req-stor-023-managed-release-status-projection), [REQ-STOR-024](#req-stor-024-managed-release-application)

**Verification:** Automated: [session-helpers.test.ts](../../src/__tests__/lib/session-helpers.test.ts), [container-r2-start.test.ts](../../src/__tests__/routes/container-r2-start.test.ts), [session-ancillary-status.test.ts](../../src/__tests__/routes/session-ancillary-status.test.ts), [storage-seed-managed.test.ts](../../src/__tests__/routes/storage-seed-managed.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

<a id="req-stor-022-managed-reconciliation-admission"></a>
### REQ-STOR-022: Restore baked state after disabling curation

**Intent:** Disabling managed curation restores baked reconciliation without losing personal extension intent or clearing applied state on failure.

**Applies To:** User

**Acceptance Criteria:**

1. Disabling curation restores baked reconciliation expectations. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-022 AC4+AC5+AC6: disable restores baked state and preserves personal intent) -->
2. Disabling curation clears company applied state. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-022 AC4+AC5+AC6: disable restores baked state and preserves personal intent) -->
3. Disabling curation preserves personal extension intent. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-022 AC4+AC5+AC6: disable restores baked state and preserves personal intent) -->
4. Disabling curation with no available prior release fails without bucket mutation or applied-state clearing. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-022 AC7 + REQ-STOR-024 AC7: cacheless disable fails closed with applied state intact) -->

**Constraints:** Unconfigured baked behavior remains byte-identical.

**Priority:** P1

**Dependencies:** [REQ-STOR-259](#req-stor-259-managed-reconciliation-admission), [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-IDE-042](browser-ide.md#req-ide-042-additive-company-extension-reconciliation)

**Verification:** Automated: [storage-seed-managed.test.ts](../../src/__tests__/routes/storage-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-023: Managed release status projection

**Intent:** Status polling detects managed-release changes without expanding release payloads.

**Applies To:** User

**Acceptance Criteria:**

1. Initial status compares the verified active descriptor, resolved mode, managed-resource policy, and canonical agent-projection identity with applied user state. <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC1: matching managed release with %s projection is not current) --> <!-- @impl: src/lib/managed-release-active.ts::getActiveManagedRelease --> <!-- @impl: src/lib/session-mode.ts::resolveEffectiveSessionMode --> <!-- @impl: src/routes/session/lifecycle.ts::default --> <!-- @test: src/__tests__/lib/managed-release-active.test.ts (REQ-STOR-023 AC1: returns configured managed resource policy with the active descriptor) --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC1+AC2: initial status compares descriptor and mode without payload bytes) --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (reports upgrading when a downgraded SaaS user has advanced managed content applied) --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC1: a pre-upgrade applied stamp without a manifest digest requires reconciliation) --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC1: reports upgrading when managed resource %s) -->
2. An unchanged release status check does not load payload bytes. <!-- @impl: src/lib/managed-release-active.ts::getActiveManagedRelease --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC1+AC2: initial status compares descriptor and mode without payload bytes) -->
3. During cache failure, last-known-good startup is allowed only when its applied mode and projection identity match the deployment. <!-- @impl: src/lib/managed-release-active.ts::getActiveManagedRelease --> <!-- @impl: src/lib/session-mode.ts::resolveEffectiveSessionMode --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-STOR-023 AC3: blocks container start when applied projection identity is %s) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (blocks an old applied mode during a cache outage when Enterprise resolves advanced mode) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (retains a previously applied verified release during a transient cache outage) --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC3: an outage rejects last-known-good state for another mode) -->
4. Pending targets remain visible even when applied identity matches the active release or neither active nor applied identity is available. <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC4: journal-only reconciliation remains visible with bucket ownership %s) --> <!-- @impl: src/routes/session/lifecycle.ts::default --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC4: pending target state retries even when applied identity matches active) -->
5. Without a compatible descriptor, status remains pending without attributing unknown lookup failure to runtime incompatibility. <!-- @impl: src/lib/remote-curation.ts::readManagedEnvironmentSnapshot --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC5: an unavailable descriptor does not invent a runtime incompatibility) --> <!-- @impl: src/routes/session/lifecycle.ts::default --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC5: reports update pending when no compatible verified active release is available) -->
6. Requested status exposes a stable target identity covering release or baked hash, sequence, mode, policy, and projection, independent of progress. <!-- @impl: src/routes/session/lifecycle.ts::default --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023: exposes a stable desired target for retry suppression without confusing progress with identity) --> <!-- @test: web-ui/src/__tests__/api/client.test.ts (REQ-AGENT-049: carries the authoritative upgrade target through ancillary status parsing) --> <!-- @test: web-ui/src/__tests__/api/client.test.ts (REQ-AGENT-049: rejects an invalid upgrade target from ancillary status (%s)) -->
7. Proven runtime incompatibility explains the block without claiming or scheduling reconciliation. <!-- @impl: src/lib/remote-curation.ts::readManagedEnvironmentSnapshot --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-023 AC5: an incompatible published runtime is blocked, not upgrading, without scheduling reconciliation) --> <!-- @impl: src/routes/session/lifecycle.ts::default -->

**Constraints:**

- Unchanged polling does not parse or decompress a managed payload.
- The opaque target is observation metadata, not applied state or mutation authority.

**Priority:** P1

**Dependencies:** [REQ-STOR-020](#req-stor-020-managed-environment-reconciliation), [REQ-STOR-040](#req-stor-040-managed-release-discovery-freshness), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated: [managed-release-active.test.ts](../../src/__tests__/lib/managed-release-active.test.ts), [container-r2-start.test.ts](../../src/__tests__/routes/container-r2-start.test.ts), [session-ancillary-status.test.ts](../../src/__tests__/routes/session-ancillary-status.test.ts), [client.test.ts](../../web-ui/src/__tests__/api/client.test.ts)

**Status:** Implemented

---

### REQ-STOR-040: Managed release discovery freshness

**Intent:** Managed release discovery remains retryable and bounded outside explicit validation.

**Applies To:** User

**Acceptance Criteria:**

1. After the five-minute freshness window, the resolver rechecks the latest release. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (uses the stored ETag after five minutes and treats 304 as a fresh no-op) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-STOR-040 AC1: checks for a later managed release while status is current) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-STOR-040 AC1: an overlapping poll does not duplicate the managed-release check) -->
2. The newest runtime-compatible release becomes active only after its immutable assets and signature verify. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (REQ-STOR-040 AC2: activates only a GitHub immutable release whose two immutable asset digests and signature verify) -->
3. A failed initial managed-release check remains retryable. <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-STOR-040 AC3: retries the managed-release check after the initial batch request fails) -->
4. A failed background managed-release check remains retryable. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-STOR-040 AC4: a failed ancillary-status call does not consume the managed-release check window) -->
5. A degraded background attempt is cached for the five-minute freshness window. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (REQ-STOR-040 AC5: status refresh caches failed compatible discovery for five minutes) -->

**Constraints:**

- Background refresh and explicit fresh-required validation share [REQ-AGENT-154](agents.md#req-agent-154-build-compatible-managed-release-discovery)'s ten-page, 1,000-record compatible-history traversal past newer incompatible releases. <!-- @test: src/__tests__/lib/remote-curation.test.ts (REQ-AGENT-154 AC2+AC3+AC4 + REQ-STOR-040 AC2: skips mismatches and unrelated releases then activates the newest compatible seed (fresh-required=%s)) -->
- Traversal preserves signature, immutable-asset, runtime-hash and activation monotonicity checks.
- A degraded attempt remains cached for five minutes; session startup remains snapshot-only.

**Priority:** P1

**Dependencies:** [REQ-STOR-020](#req-stor-020-managed-environment-reconciliation), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated: [remote-curation.test.ts](../../src/__tests__/lib/remote-curation.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

### REQ-STOR-024: Managed release application

**Intent:** A verified managed release converges into an unowned user bucket within fixed integrity and resource bounds.

**Applies To:** User

**Acceptance Criteria:**

1. A release mismatch with no owning session reads one verified cached gzip for reconciliation. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC1+AC4: successful managed reconcile loads cached content and stamps applied state last) -->
2. Reconciliation writes byte-identical content selected for the resolved mode and deployment coding-agent set. <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024: automatic fingerprints, streaming writes, and progress use the same selected keys) --> <!-- @impl: src/lib/session-mode.ts::resolveEffectiveSessionMode --> <!-- @impl: src/lib/remote-curation.ts::streamManagedReleaseDocuments --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC1 + REQ-STOR-024 AC2: Default and Advanced stream identical mode payloads with active release provenance) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (reconciles and stamps the entitlement-clamped mode for a downgraded SaaS user) -->
3. The main document phase uses at most six concurrent R2 operations and settles before stale-marker cleanup. <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024 AC3 + REQ-STOR-033 AC4: settles documents and metadata before separate 25-task HEAD/conditional-DELETE batches) --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024 AC3: bounds R2 concurrency for a maximum-size managed document set) -->
4. Applied release, projection, and synthesized-manifest identities are stamped only after every reconciliation operation succeeds. <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1/AC3: journals the canonical projection before R2 work and publishes it with applied state) --> <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @impl: src/lib/r2-seed.ts::managedExtensionsDocumentDigest --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC1+AC4: successful managed reconcile loads cached content and stamps applied state last) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC4: does not stamp applied state when context-mode reconciliation fails) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC4 + REQ-STOR-039 AC1: failed automatic byte verification does not publish applied state) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024 AC4: trusted digest hashes the exact valid empty company manifest bytes) -->
5. Applying a current release after deployment-cache replacement does not require a historical cached bundle. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC5 + REQ-STOR-033 AC5: reconciles from current release when disposable cache history is absent) -->
6. Cacheless application removes exact current-release paths excluded by mode or verified inactive ownership. <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (REQ-STOR-024: filters baked planning and inactive cleanup by the canonical agent selection) --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024 AC6: cacheless application cleans only current-release paths outside the effective mode) -->
7. Stale-marker cleanup uses separate batches of at most 25 tasks, each awaiting HEAD before conditional DELETE. The six-operation document bound does not apply to cleanup. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024 AC3 + REQ-STOR-033 AC4: settles documents and metadata before separate 25-task HEAD/conditional-DELETE batches) -->

**Constraints:** Applied state is written last.

**Priority:** P1

**Dependencies:** [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start), [REQ-STOR-019](#req-stor-019-seeded-files-are-marked-and-retired-ones-are-removed), [REQ-STOR-021](#req-stor-021-managed-content-ownership), [REQ-AGENT-049](agents.md#req-agent-049-auto-upgrade-preseed-on-release), [REQ-AGENT-151](agents.md#req-agent-151-bounded-managed-release-streaming)

**Verification:** Automated: [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts), [r2-seed-mode.test.ts](../../src/__tests__/lib/r2-seed-mode.test.ts), [storage-seed-managed.test.ts](../../src/__tests__/routes/storage-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-025: Managed deployment cache migration

**Intent:** Each deployment safely retires its exact opaque managed cache predecessor.

**Applies To:** Admin

**Acceptance Criteria:**

1. Automatic migration records the recognizable cache only after it contains a verified active release. <!-- @impl: src/lib/remote-curation.ts::prepareManagedCacheMigration --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
2. Automatic migration never rewrites the selected repository or trust configuration. <!-- @impl: src/lib/remote-curation.ts::prepareManagedCacheMigration --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
3. Cleanup empties and deletes only the exact authenticated legacy bucket. <!-- @impl: src/lib/remote-curation.ts::cleanupLegacyManagedCache --> <!-- @impl: src/lib/r2-admin.ts::deleteR2BucketIfExists --> <!-- @impl: src/lib/r2-client.ts::emptyR2Bucket --> <!-- @test: src/__tests__/lib/r2-client.test.ts (paginates through multiple pages) --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (REQ-STOR-025 AC3: empties and deletes only an existing named bucket) --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->
4. Failed cleanup remains pending for a later resolver retry. <!-- @impl: src/lib/remote-curation.ts::cleanupLegacyManagedCache --> <!-- @test: src/__tests__/lib/remote-curation.test.ts (stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement) -->

**Constraints:** Cleanup never scans by prefix or deletes an unauthenticated bucket identity.

**Priority:** P1

**Dependencies:** [REQ-STOR-020](#req-stor-020-managed-environment-reconciliation), [REQ-STOR-026](#req-stor-026-managed-deployment-cache-identity), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated: [r2-admin.test.ts](../../src/__tests__/lib/r2-admin.test.ts), [r2-client.test.ts](../../src/__tests__/lib/r2-client.test.ts), [remote-curation.test.ts](../../src/__tests__/lib/remote-curation.test.ts)

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

**Verification:** Automated: [remote-curation-cache.test.ts](../../src/__tests__/lib/remote-curation-cache.test.ts)

**Status:** Implemented

---

### REQ-STOR-027: Review completion marker sync

**Intent:** Exact-head review completion survives container, clone, worktree, and shared-device boundaries without delaying local acknowledgement.

**Applies To:** User

**Acceptance Criteria:**

1. A private user-scoped review-completion namespace holds one regular JSON file per normalized GitHub host, repository, PR, case-sensitive branch, protected base and lowercase full head. <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::completionPath --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::completionPath --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (isolates host, repository, PR, branch, base, and head identities) --> <!-- @test: host/__tests__/review-completion-state.test.js (isolates protected bases in marker paths) -->
2. Marker publication refuses symlinked roots/ancestors/repository/branch directories before filesystem effects. <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::safeDirectory --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::safeDirectory --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (REQ-STOR-027: ${redirected} symlink refuses read/publication/prune without outside effects) --> <!-- @test: host/__tests__/review-completion-state.test.js (REQ-STOR-027: ${redirected} symlink refuses read/publication/prune without outside effects) --> It uses a mode-`0600` same-directory temporary file and atomic hard-link publication. <!-- @test: host/__tests__/review-completion-state.test.js (REQ-STOR-027 AC2: ${owner}atomic publication exposes complete hard-linked bytes (competing winner: ${competitor})) --> A valid destination is idempotent and never refreshes `reviewedAt`; an invalid destination is removed and publication retries once. <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::publish --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::publish --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (writes one immutable exact marker and never refreshes its age) --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (replaces an invalid exact destination once and rejects symlinks) -->
3. Marker reads validate schema, exact identity, timestamp and regular-file boundaries without following symlinks. Directory containment precedes lookup or pruning; redirection of the root, its parent, repository or branch leaves outside marker and sentinel bytes, modes and inventory unchanged. <!-- @test: host/__tests__/review-completion-state.test.js (REQ-STOR-027 AC3: rejects ${label} without changing outside bytes) --> <!-- @test: host/__tests__/review-completion-state.test.js (REQ-STOR-027 AC3: refuses a ${kind} marker without blocking or reading its contents) --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (REQ-STOR-027 AC3: Pi marker validation) --> <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::readCompletion --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::readCompletion --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (REQ-STOR-027: ${redirected} symlink refuses read/publication/prune without outside effects) --> <!-- @test: host/__tests__/review-completion-state.test.js (REQ-STOR-027: ${redirected} symlink refuses read/publication/prune without outside effects) --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (isolates host, repository, PR, branch, base, and head identities) -->
4. First root startup performs one symlink-safe full global inventory prune, without a global count or time ceiling. <!-- @test: src/__tests__/lib/review-completion-state.test.ts (REQ-STOR-027: ${redirected} symlink refuses read/publication/prune without outside effects) --> <!-- @test: host/__tests__/review-completion-state.test.js (REQ-STOR-027: ${redirected} symlink refuses read/publication/prune without outside effects) --> <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::pruneCompletionState --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::pruneCompletionState --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (deletes expired markers and retains ten newest per repository and branch) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (prunes marker state once on first root startup without traversing symlinks) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (prunes marker state once on first root startup without traversing symlinks) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-STOR-027 AC4: child startup preserves markers and leaves the first root prune available) -->
5. Every workspace sync mode includes only the review-completion namespace through common restore, baseline, regular bisync and final-sync filters, while other private coordination files remain excluded. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (persists user-scoped review completion in every workspace sync mode) -->
6. Marker writes and pruning rely on regular or final workspace sync and do not force an additional sync. <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::writeCompletion --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::writeCompletion --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (writes local acknowledgement without forcing an R2 sync) --> <!-- @test: host/__tests__/review-completion-state.test.js (writes local completion without forcing an R2 sync) -->
7. Before lookup and after write, prune invalid or expired markers and keep the ten newest for each repository branch. <!-- @impl: preseed/agents/pi/extensions/review-completion-state.ts::pruneBranch --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs::pruneBranch --> <!-- @test: src/__tests__/lib/review-completion-state.test.ts (deletes expired markers and retains ten newest per repository and branch) -->

**Constraints:**

- No review-specific R2 service, Worker endpoint, database, or direct `/internal/bisync-trigger` call exists.
- R2 convergence may repeat a prompt but cannot fabricate completion.
- Both native owners check canonical directory identity and every ancestor before read, prune, mkdir/chmod or publication; publication permits missing directories only for preflight and rechecks after creation.
- Symlink containment does not establish protection from arbitrary concurrent ancestor renames.

**Priority:** P1

**Dependencies:** [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start), [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-AGENT-244](agents.md#req-agent-244-exact-round-review-completion)

**Verification:** Automated: [review-completion-state.test.ts](../../src/__tests__/lib/review-completion-state.test.ts), [review-completion-state.test.js](../../host/__tests__/review-completion-state.test.js), [review-enforcement.test.ts](../../src/__tests__/lib/review-enforcement.test.ts), [git-push-review-reminder.test.js](../../host/__tests__/git-push-review-reminder.test.js), [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js); Manual: [Integration replacement-container marker acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-027-integration-replacement-container-marker-acceptance)

**Status:** Implemented

---

### REQ-STOR-028: Canonical managed-resource persistence policy

**Intent:** Enterprise managed-resource persistence paths are derived canonically from verified release inventory.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Protected modes derive deterministic UTF-8 JSON from every verified release document, retired path, and Codeflare-owned synthetic managed path, independent of session mode. <!-- @impl: src/lib/managed-r2-policy.ts::buildManagedR2Policy --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (deterministically protects both modes, retirements, and synthetic policy paths) -->
2. Canonical policy paths are sorted and deduplicated. <!-- @impl: src/lib/managed-r2-policy.ts::buildManagedR2Policy --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (deterministically protects both modes, retirements, and synthetic policy paths) --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (REQ-STOR-028 AC2: duplicate and independently permuted inventories produce identical canonical bytes and identity) -->
3. Policy identity is stable for identical canonical bytes and changes whenever those bytes change. <!-- @impl: src/lib/managed-r2-policy.ts::buildManagedR2Policy --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (deterministically protects both modes, retirements, and synthetic policy paths) -->

**Constraints:**

- `.codeflare/managed-paths.json` is the only persisted runtime policy document.
- No policy KV store or cache object is introduced.

**Priority:** P0

**Dependencies:** [REQ-STOR-020](#req-stor-020-managed-environment-reconciliation), [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-SETUP-015](setup.md#req-setup-015-managed-resource-persistence-controls)

**Verification:** Automated: [managed-r2-policy.test.ts](../../src/__tests__/lib/managed-r2-policy.test.ts)

**Status:** Implemented

---

### REQ-STOR-029: Managed-resource reconciliation

**Intent:** Existing managed reconciliation applies canonical policy and bounded exclusive cleanup before stamping applied identity.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Managed-seed reconciliation writes and read-verifies protected policy after managed content. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC1: writes and read-verifies canonical protected policy after managed content) -->
2. Exclusive cleanup prevalidates the 10,000-object and 1-GiB object-size bounds, including exact root objects. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC2: exclusive cleanup bounds fail before every mutation) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC2: exclusive cleanup rejects summed object size above 1 GiB with zero mutations) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC2: exact root object size contributes to the exclusive cleanup bound) -->
3. Exclusive cleanup deletes unrecognized objects in bounded batches only inside governed resource roots. <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029: exclusive policy stays universal while selected cleanup removes only governed inactive and personal resources) --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC3: exclusive cleanup preserves managed objects in one bounded delete batch) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC3: exclusive cleanup bounds each delete batch to 1,000 objects) -->
4. Exclusive reconciliation writes canonical policy only after every requested deletion is confirmed and no per-object error is reported. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC4: verbose delete confirmation decodes valid numeric XML character references) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC4: partial exclusive batch failures prevent policy identity from being committed) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC4: %s cannot commit exclusive policy identity) -->
5. Malformed or over-bound exclusive listing or root metadata fails before every cleanup mutation. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC5: invalid exact root size %s causes zero mutations) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC5: malformed exclusive listings cause zero mutations) -->
6. Mutable transition removes stale R2 policy. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-029 AC6: mutable transition removes stale canonical policy) -->
7. Applied release, mode, projection, and policy identity are stamped only after successful reconciliation. <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1/AC3: journals the canonical projection before R2 work and publishes it with applied state) --> <!-- @impl: src/routes/storage/seed.ts::updatedPreferences --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-029 AC7: transports configured policy and stamps verified identity last) -->

**Constraints:** Reconciliation reuses the managed-seed path; no queue, database, or separate reconciler is introduced.

**Priority:** P0

**Dependencies:** [REQ-STOR-020](#req-stor-020-managed-environment-reconciliation), [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-STOR-028](#req-stor-028-canonical-managed-resource-persistence-policy), [REQ-STOR-030](#req-stor-030-managed-resource-policy-loading), [REQ-STOR-032](#req-stor-032-exclusive-managed-resource-boundaries)

**Verification:** Automated: [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts), [storage-seed-managed.test.ts](../../src/__tests__/routes/storage-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-030: Managed-resource policy loading

**Intent:** Worker boundaries accept managed-resource policy only under exact applied identity.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Policy loading accepts only bounded canonical bytes matching the applied policy identity, release, and resource mode. <!-- @impl: src/lib/managed-r2-policy.ts::readVerifiedManagedR2Policy --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (loader verifies exact digest, release, mode, and canonical bytes) --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (REQ-STOR-030 AC1: oversized streamed policy is refused and its body cancelled) -->
2. Reused policy results revalidate the caller's expected identity. <!-- @impl: src/lib/managed-r2-policy.ts::readVerifiedManagedR2Policy --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (cache hits still revalidate expected release and mode) -->
3. Callers can require fresh policy verification without reusing an earlier result. <!-- @impl: src/lib/managed-r2-policy.ts::readVerifiedManagedR2Policy --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (verifies protected bucket policy without cache and transports only its identity) -->

**Constraints:** Policy loading does not create another persisted policy object.

**Priority:** P0

**Dependencies:** [REQ-STOR-028](#req-stor-028-canonical-managed-resource-persistence-policy)

**Verification:** Automated: [managed-r2-policy.test.ts](../../src/__tests__/lib/managed-r2-policy.test.ts), [container-r2-start.test.ts](../../src/__tests__/routes/container-r2-start.test.ts)

**Status:** Implemented

---

### REQ-STOR-031: Managed-resource container sync

**Intent:** Containers restore policy before generating non-authoritative filters that keep protected mutations out of ordinary bisync.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Initial restore includes the universal managed-policy document. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-IDE-002 AC6 / REQ-STOR-031 AC1: syncs bounded Browser IDE manifests and managed policy) --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-004 AC3/AC4 / REQ-STOR-031: baseline observes real post-restore Pi settings and managed content) -->
2. Protected modes verify exact policy identity after restore and before baseline. <!-- @impl: entrypoint.sh::prepare_managed_resource_filter --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-004 AC3/AC4 / REQ-STOR-031: baseline observes real post-restore Pi settings and managed content) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (validates canonical exclusive identity and excludes exact paths and roots while preserving adjacent paths) -->
3. The generated filter excludes protected exact paths even when positive persistence rules also match. <!-- @impl: entrypoint.sh::prepare_managed_resource_filter --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (validates canonical exclusive identity and excludes exact paths and roots while preserving adjacent paths) -->
4. Exclusive filtering also excludes governed resource roots. <!-- @impl: entrypoint.sh::prepare_managed_resource_filter --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (validates canonical exclusive identity and excludes exact paths and roots while preserving adjacent paths) -->
5. Mutable transition removes stale local policy and filter state before baseline. <!-- @impl: entrypoint.sh::prepare_managed_resource_filter --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (mutable reset removes stale policy and filter before baseline) -->
6. Baseline, periodic, manual, recovery, compaction and final bisync use one effective ordered filter policy: verified managed vetoes, applicable recovery vetoes, transient exclusions and mode-specific inclusions, then the selected Include deny or Exclude admission fallback. <!-- @impl: entrypoint.sh::compose_rclone_filters --> <!-- @impl: entrypoint.sh::RCLONE_FILTERS --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (validates canonical exclusive identity and excludes exact paths and roots while preserving adjacent paths) --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (entrypoint.sh bisync daemon behavior (real) / REQ-STOR-002 (file persistence) / REQ-STOR-004 (initial sync) / REQ-STOR-005 (graceful shutdown final sync) / REQ-SESSION-003 AC3 (entrypoint initial rclone sync) + AC4 (bisync daemon + SIGUSR1) / REQ-SESSION-011 (graceful shutdown with final sync) / REQ-VAULT-006 (shutdown bisync vault writes) / REQ-OPS-010 (graceful container shutdown) / REQ-MEM-004 (memory dirs in bisync filter)) -->
7. With remote curation active, startup restores declared image-owned runtime companions without replacing release-owned bytes.  <!-- @impl: entrypoint.sh::IMAGE_OWNED_MANAGED_EXTENSION_COMPANIONS --> <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-004 AC3/AC4 / REQ-STOR-031: baseline observes real post-restore Pi settings and managed content) -->


**Constraints:**

- Container policy is non-authoritative, with no Durable Object policy persistence or replacement of release-owned extension bytes by image copies.
- Worker-side authorization is unchanged; an upstream denial does not substitute for correct local filter composition.

**Priority:** P0

**Dependencies:** [REQ-STOR-029](#req-stor-029-managed-resource-reconciliation), [REQ-STOR-030](#req-stor-030-managed-resource-policy-loading), [REQ-STOR-032](#req-stor-032-exclusive-managed-resource-boundaries)

**Verification:** Automated: [entrypoint-bisync-behavior.test.js](../../host/__tests__/entrypoint-bisync-behavior.test.js), [entrypoint-managed-curation.test.js](../../host/__tests__/entrypoint-managed-curation.test.js), [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js)

**Status:** Implemented

---

### REQ-STOR-032: Exclusive managed-resource boundaries

**Intent:** Exclusive policy protects only recognized managed-resource trees while preserving adjacent and unrelated personal paths.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Exclusive mode derives segment-aware resource roots across all six managed homes from the governed category allowlist, independent of the selected keep-set. <!-- @impl: src/lib/managed-r2-policy.ts::deriveManagedResourceRoots --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (REQ-STOR-032 AC1/AC2: exclusive roots derive segment-aware while sessions and root files remain outside) --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (REQ-STOR-032 AC1: derives category roots across all six managed homes, including retirements) -->
2. Exclusive roots protect root objects and descendants without covering similarly prefixed names, session state, or unrelated personal paths. <!-- @impl: src/lib/managed-r2-policy.ts::isManagedMutationProtected --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (REQ-STOR-032 AC1/AC2: exclusive roots derive segment-aware while sessions and root files remain outside) -->
3. Exclusive generation fails before reconciliation when a managed or retired path uses an unknown nested category. <!-- @impl: src/lib/managed-r2-policy.ts::deriveManagedResourceRoots --> <!-- @test: src/__tests__/lib/managed-r2-policy.test.ts (REQ-STOR-032 AC3: exclusive generation rejects a novel or later nested managed category) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-032 AC3: exclusive generation fails before every R2 request) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-032 AC3: an unknown retired category rejects reconciliation before bucket access) -->

**Constraints:** Root derivation introduces no policy outside recognized managed-resource categories.

**Priority:** P0

**Dependencies:** [REQ-STOR-028](#req-stor-028-canonical-managed-resource-persistence-policy), [REQ-SETUP-015](setup.md#req-setup-015-managed-resource-persistence-controls)

**Verification:** Automated: [managed-r2-policy.test.ts](../../src/__tests__/lib/managed-r2-policy.test.ts), [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-033: Managed-release delta planning and resume

**Intent:** Automatic upgrades write the release-required target objects and resume same-target work from R2 provenance.

**Applies To:** User

**Acceptance Criteria:**

1. Automatic reconciliation compares the exact applied release directly with the active target without replaying intermediate releases. <!-- @impl: src/lib/r2-seed.ts::buildManagedAutomaticPlan --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033 AC1/AC2: direct delta handles a fifteen-release gap and writes only added or changed release paths) -->
2. The direct plan includes only target paths whose release content or content type changed, so release-identical markerless edits remain untouched. <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024: automatic fingerprints, streaming writes, and progress use the same selected keys) --> <!-- @impl: src/lib/r2-seed.ts::buildManagedAutomaticPlan --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033 AC1/AC2: direct delta handles a fifteen-release gap and writes only added or changed release paths) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-039 AC1/AC3 + REQ-STOR-033 AC1/AC2: arbitrary-gap delta materializes exact target R2 bytes and content types) -->
3. A same-target retry skips objects that carry the target marker only after its bytes and content type verify against the target release. <!-- @impl: src/lib/r2-seed.ts::seedManagedDocuments --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-039 AC2 + REQ-STOR-033 AC3 + REQ-STOR-034 AC3: target provenance resumes and increments progress) -->
4. Fresh buckets, absent or changed projection identity, policy changes, missing history, and manual recreation run a full selected-target pass before cleanup. <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-033 AC4: %s materializes all selected bytes before cleanup) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-033 AC3: same-release %s forces a full selected-target pass) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033: a full selected-target pass verifies every selected document and metadata) --> <!-- @impl: src/lib/r2-seed.ts::buildManagedAutomaticPlan --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033 AC4 + REQ-STOR-035 AC5: full-target fallback sweeps stale managed markers only after desired writes) -->
5. Fallback accepts absent applied identity or unavailable valid history. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-024 AC5 + REQ-STOR-033 AC5: reconciles from current release when disposable cache history is absent) -->
6. Malformed or conflicting applied identity fails before bucket mutation. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-033 AC6: invalid applied identity fails closed before bucket mutation) -->
7. Manual Recreate and non-dashboard callers retain full-overwrite behavior. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @impl: web-ui/src/stores/session.ts::applyManagedReleaseBatch --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-033 AC7: automatic endpoint is separate and manual Recreate remains full overwrite) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-STOR-033 AC7: should trigger the automatic upgrade endpoint when preseedNeedsUpgrade is true) -->

**Constraints:**

- The document phase runs at most six concurrent R2 operations and settles before stale-marker cleanup.
- Cleanup runs at most 25 concurrent tasks, each awaiting HEAD before conditional DELETE, while retaining candidate, ownership-marker, ETag and deletion safeguards.
- Document-concurrency evidence does not establish cleanup concurrency.
- Same-target retries do not replay completed target objects.

**Priority:** P0

**Dependencies:** [REQ-STOR-021](#req-stor-021-managed-content-ownership), [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-AGENT-049](agents.md#req-agent-049-auto-upgrade-preseed-on-release)

**Verification:** Automated: [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts), [storage-seed-managed.test.ts](../../src/__tests__/routes/storage-seed-managed.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts); Manual: [Enterprise Integration interrupted-upgrade acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-033-enterprise-integration-interrupted-upgrade-acceptance)

**Status:** Implemented

---

### REQ-STOR-034: Observational managed reconciliation progress writes

**Intent:** Automatic reconciliation reports bounded progress without making telemetry an execution authority.

**Applies To:** User

**Acceptance Criteria:**

1. Progress write failures never block reconciliation. <!-- @impl: src/lib/managed-reconcile-progress.ts::writeManagedReconcileProgress --> <!-- @test: src/__tests__/lib/managed-reconcile-progress.test.ts (REQ-STOR-034 AC1: progress write failure remains observational) -->
2. Stored progress distinguishes planning, writing, and finalizing. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-034 AC2: finalizing progress is persisted before cleanup begins) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-034 AC2: public progress moves from planning through writing to finalizing) -->
3. Completed counts include objects recovered from matching target provenance. <!-- @impl: src/lib/r2-seed.ts::seedManagedDocuments --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-039 AC2 + REQ-STOR-033 AC3 + REQ-STOR-034 AC3: target provenance resumes and increments progress) -->
4. Stored progress expires within 24 hours. <!-- @impl: src/lib/managed-reconcile-progress.ts::writeManagedReconcileProgress --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-034 AC4/AC5/AC6: response and stored completion survive a stale KV read) -->
5. Successful applied publication returns matching completion progress. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-034 AC4/AC5/AC6: response and stored completion survive a stale KV read) -->
6. Successful applied publication retains matching completion progress. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-034 AC4/AC5/AC6: response and stored completion survive a stale KV read) -->
7. Progress cleanup failure cannot change the reconciliation outcome. <!-- @impl: src/lib/managed-reconcile-progress.ts::clearMatchingManagedReconcileProgress --> <!-- @test: src/__tests__/lib/managed-reconcile-progress.test.ts (REQ-STOR-034 AC7: progress cleanup failure cannot change applied reconciliation outcome) -->

**Constraints:** Progress is observational and never an execution checkpoint.

**Priority:** P1

**Dependencies:** [REQ-STOR-023](#req-stor-023-managed-release-status-projection), [REQ-STOR-033](#req-stor-033-managed-release-delta-planning-and-resume)

**Verification:** Automated: [managed-reconcile-progress.test.ts](../../src/__tests__/lib/managed-reconcile-progress.test.ts), [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts), [storage-seed-managed.test.ts](../../src/__tests__/routes/storage-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-035: Managed reconciliation cleanup and finalization

**Intent:** Interrupted targets and obsolete managed paths converge without deleting user-owned or concurrently replaced objects.

**Applies To:** User

**Acceptance Criteria:**

1. Before managed-release R2 writes, at most 32 release, mode, and projection target identities are recorded. <!-- @impl: src/lib/managed-release-active.ts::appendManagedReconciliationTarget --> <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @impl: src/routes/preferences.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1: rejects unbounded interrupted target state before bucket mutation) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1/AC2: failed manual Recreate records and retains its active target) --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-STOR-035 AC1/AC2: a failed managed mode change records and retains its active target) -->
2. A failed reconciliation retains its recorded pending target identities. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @impl: src/routes/preferences.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC2/AC7: target changes before cleanup, preserves pending ownership, and prevents finalization) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC2: unavailable interrupted history fails before bucket mutation and retains state) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1/AC2: failed manual Recreate records and retains its active target) --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-STOR-035 AC1/AC2: a failed managed mode change records and retains its active target) --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-STOR-035 AC2: unavailable interrupted history rejects a mode change and preserves pending state) -->
3. Successful publication clears pending identities only after every recorded target has been repaired or superseded by a complete full-target reconcile. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @impl: src/routes/preferences.ts::default --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1/AC3: records automatic target ownership before writes and clears it with applied publication) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC3: manual Recreate repairs interrupted targets before clearing their state) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC3: managed disable cleans interrupted targets before clearing their state) --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-STOR-035 AC3: mode-change disable repairs interrupted targets before clearing state) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC4: interrupted target drift repairs only objects carrying interrupted provenance) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033: a full selected-target pass verifies every selected document and metadata) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-SETUP-016 AC5: admits the same stopped session only after real protected reconciliation publishes last) -->
4. After target drift, repair desired paths selected solely by interrupted history only if they carry the interrupted target's marker. This guard does not suppress paths independently selected for a direct release delta. <!-- @impl: src/lib/r2-seed.ts::buildManagedAutomaticPlan --> <!-- @impl: src/lib/r2-seed.ts::seedManagedDocuments --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC4: interrupted target drift repairs only objects carrying interrupted provenance) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC4: repairs markers from repeated interrupted targets) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC4: repairs an interrupted extensions manifest when applied already matches target) -->
5. Cleanup applies existing ownership-marker rules to active or unknown source-absent, interrupted-only, and signed-retired paths. <!-- @impl: src/lib/r2-seed.ts::buildReconcileCleanupPreflight --> <!-- @impl: src/lib/r2-seed.ts::deleteExactInactiveConfigs --> <!-- @impl: src/lib/r2-seed.ts::deleteRetiredManagedConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 AC2 + REQ-STOR-035 AC5: direct delta cleanup accepts older valid markers and preserves markerless edits) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC5: managed disable removes interrupted-only objects with matching provenance) -->
6. Conditional per-object cleanup keeps its inspected ETag guard and treats a provider `412` as a replacement, not a successful deletion. Exclusive bulk cleanup remains key-based under [REQ-STOR-029](#req-stor-029-managed-resource-reconciliation) and does not promise replacement detection. <!-- @impl: src/lib/r2-seed.ts::deleteManagedConfigsByMarkerRules --> <!-- @impl: src/lib/r2-seed.ts::deleteRetiredManagedConfigs --> <!-- @impl: src/lib/r2-seed.ts::deleteExactInactiveConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC6: cleanup preserves an object replaced after inspection) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-035 AC6: fallback cleanup preserves an object replaced after inspection) -->
7. Applied publication requires unchanged release, projection, mode, resource policy, storage encryption, session ownership, migration state, and pending target set. <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC7: %s drift after completed R2 work refuses applied publication) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC7: selection drift after journaling blocks applied publication) --> <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC2/AC7: target changes before cleanup, preserves pending ownership, and prevents finalization) -->

**Constraints:**

- Interrupted target state never uses observational progress as authority.

**Priority:** P0

**Dependencies:** [REQ-STOR-021](#req-stor-021-managed-content-ownership), [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-STOR-033](#req-stor-033-managed-release-delta-planning-and-resume)

**Verification:** Automated: [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts), [preferences.test.ts](../../src/__tests__/routes/preferences.test.ts), [storage-seed-managed.test.ts](../../src/__tests__/routes/storage-seed-managed.test.ts), [Start admission after protected reconciliation](../../src/__tests__/routes/container-r2-start.test.ts)

**Status:** Implemented

---

### REQ-STOR-036: Managed reconciliation progress reads

**Intent:** The separate ancillary status response exposes managed reconciliation progress without letting malformed or unavailable telemetry replace release truth.

**Applies To:** User

**Acceptance Criteria:**

1. Malformed progress is omitted. <!-- @impl: src/lib/managed-reconcile-progress.ts::readManagedReconcileProgress --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-036 AC1: malformed progress is omitted) -->
2. Ancillary status exposes valid progress only when its release digest matches the active release, while status is `upgrading` or during the applied-finalization handoff. <!-- @impl: src/routes/session/lifecycle.ts::app.get('/ancillary-status', --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-036 AC2: batch status exposes only matching pending progress) --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-036 AC2: update-pending state omits progress) --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-036 AC4: applied target exposes finalizing once and clears it) -->
3. Progress read failure cannot replace authoritative release status. <!-- @impl: src/lib/managed-reconcile-progress.ts::readManagedReconcileProgress --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-036 AC3: progress read failure cannot replace authoritative upgrading status) -->
4. After the target is applied, matching `finalizing` progress may appear as a transient `upgrading` handoff. The status read attempts to clear it; concurrent reads or failed cleanup can repeat the display. <!-- @impl: src/routes/session/lifecycle.ts::app.get('/ancillary-status', --> <!-- @impl: src/lib/managed-reconcile-progress.ts::clearMatchingManagedReconcileProgress --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-STOR-036 AC4: applied target exposes finalizing once and clears it) -->

**Constraints:** The D1-only batch status response excludes progress under [REQ-SESSION-244](session-lifecycle.md#req-session-244-lifecycle-polling-and-ancillary-scheduling). Ancillary status does not infer reconciliation completion from progress; the Dashboard orders responses under [REQ-STOR-260](#req-stor-260-dashboard-reconciliation-response-ordering).

**Priority:** P1

**Dependencies:** [REQ-STOR-023](#req-stor-023-managed-release-status-projection), [REQ-STOR-034](#req-stor-034-observational-managed-reconciliation-progress-writes)

**Verification:** Automated: [session-ancillary-status.test.ts](../../src/__tests__/routes/session-ancillary-status.test.ts)

**Status:** Implemented

---

<a id="req-stor-260-dashboard-reconciliation-response-ordering"></a>
### REQ-STOR-260: Dashboard reconciliation progress and ordering

**Intent:** Dashboard progress stays observational: a stale or merely successful reconciliation response cannot replace authoritative release status.

**Applies To:** User

**Acceptance Criteria:**

1. Late reconcile responses cannot revert observed current or update-pending status. <!-- @impl: web-ui/src/stores/session.ts::performPreseedUpgrade --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (ignores a late success after newer %s status) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (ignores a late failure after newer %s status) -->
2. Successful reconcile responses alone do not mark a managed release current in the dashboard. <!-- @impl: web-ui/src/stores/session.ts::performPreseedUpgrade --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (does not claim current from a successful POST without completion progress) -->

3. For nonzero reconciliation completed between polls, the dashboard can display returned completion counts as writing progress while upgrading. Subsequent upgrading polls may replace them with older, lower, or absent progress; these nonmonotonic observations never authorize publication, readiness, or session launch. <!-- @impl: web-ui/src/stores/session.ts::applyManagedReleaseBatch --> <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-AGENT-175 AC5: mirrors managed release progress on transient polling) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-AGENT-049 AC5 + REQ-AGENT-175 AC5: preserves fast upgrade progress through finalization) --> <!-- @test: web-ui/src/__tests__/api/storage.test.ts (REQ-STOR-033 AC7 + REQ-AGENT-175 AC5: calls the automatic endpoint and preserves completion progress) -->
4. The dashboard displays observed planning as "Upgrading", finalization as "Finalizing", and nonzero writing work with completed and total counts. These observations need not form a monotonic phase sequence; authoritative status and independent publication/readiness/launch gates remain unchanged. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @impl: web-ui/src/stores/session.ts::applyManagedReleaseBatch --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-AGENT-175 AC6: shows planning and finalizing managed upgrade phases) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-AGENT-049 AC5 + REQ-AGENT-175 AC5: preserves fast upgrade progress through finalization) -->
5. Managed progress advances across the whole button behind centered accessible text. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-AGENT-175 AC7: whole-button managed upgrade progress preserves centered text and ordinary completion color) -->

**Constraints:** The response ordering does not replace authoritative batch status.

**Priority:** P1

**Dependencies:** [REQ-STOR-036](#req-stor-036-managed-reconciliation-progress-reads)

**Verification:** Automated: [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts), [storage.test.ts](../../web-ui/src/__tests__/api/storage.test.ts), [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx)

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

**Verification:** Automated: [SessionSection.test.tsx](../../web-ui/src/__tests__/components/settings/SessionSection.test.tsx), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

### REQ-STOR-038: Exact Initial Restore Materialization

**Intent:** Container startup materializes admitted nonempty R2 files using the mode's comparison rules and removes stale local paths in that scope.

**Applies To:** User

**Acceptance Criteria:**

1. Initial restore materializes admitted nonempty additions and detected changes. Under SSE-C, a same-size change requires a differing modification time; Governed Mode retains checksum comparison. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (materializes exact remote bytes for added, removed, same-size changed, and different-size changed files) -->
2. Within the admitted nonempty file scope, initial restore removes local paths absent from R2. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (materializes exact remote bytes for added, removed, same-size changed, and different-size changed files) -->

**Constraints:** Governed Mode retains checksum comparison; SSE-C does not use `--size-only`.

**Priority:** P0

**Dependencies:** [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated: [entrypoint-governed-sync.test.js](../../host/__tests__/entrypoint-governed-sync.test.js)

**Status:** Implemented

---

### REQ-STOR-039: Automatic Managed Materialization Verification

**Intent:** Automatic reconciliation reports success only after R2 contains the exact target materialization.

**Applies To:** User

**Acceptance Criteria:**

1. Changed writes verify exact bytes, content type, and release provenance before succeeding. <!-- @impl: src/lib/r2-seed.ts::verifyManagedDocument --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-039 AC1/AC3 + REQ-STOR-033 AC1/AC2: arbitrary-gap delta materializes exact target R2 bytes and content types) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-039 AC1: automatic reconciliation rejects an acknowledged PUT with wrong %s) -->
2. Target-marker resumes verify exact bytes, content type, and release provenance before skipping the write. <!-- @impl: src/lib/r2-seed.ts::verifyManagedDocument --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-039 AC2 + REQ-STOR-033 AC3 + REQ-STOR-034 AC3: target provenance resumes and increments progress) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-039 AC2 + REQ-STOR-033 AC3: target-marked resume refuses wrong read-back %s) -->
3. Automatic removals verify object absence before succeeding. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-039 AC1/AC3 + REQ-STOR-033 AC1/AC2: arbitrary-gap delta materializes exact target R2 bytes and content types) --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-039 AC3: automatic reconciliation rejects an acknowledged deletion that remains in R2) -->

**Constraints:** Verification failure prevents applied-state publication.

**Priority:** P0

**Dependencies:** [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-STOR-033](#req-stor-033-managed-release-delta-planning-and-resume)

**Verification:** Automated: [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-042: Per-Side Sync Change Tracking

**Intent:** Sync distinguishes its own completed transfers from later edits without slowing unchanged-file scans.

**Applies To:** User

**Acceptance Criteria:**

1. A local append after an upload does not create a false conflict. <!-- @impl: scripts/patch-rclone-bisync.py::patch --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_server_modtime_sync) -->
2. Same-size remote edits remain detectable. <!-- @impl: scripts/patch-rclone-bisync.py::patch --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_server_modtime_sync) -->
3. Completed transfers retain independent source and destination timestamps. <!-- @impl: scripts/patch-rclone-bisync.py::patch --> <!-- @test: scripts/ci/rclone-bookkeeping_test.go (TestCodeflareCompletedCopyKeepsIndependentMetadata) -->
4. Genuine divergence preserves the newer canonical content. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/rclone-conflict-cleanup.test.js (REQ-STOR-054 AC1: a genuine divergence preserves the winner and discards eligible loser copies) -->
5. Unchanged sync cycles do not multiply conflict copies. <!-- @impl: scripts/patch-rclone-bisync.py::patch --> <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_server_modtime_sync) -->
6. Change detection avoids an all-object metadata-request scan. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_server_modtime_sync) -->

**Constraints:**

- Server-modtime listing semantics remain enabled.
- Eligible loser copies follow [REQ-STOR-054](#req-stor-054-post-sync-rclone-conflict-copy-cleanup) after sync.

**Priority:** P0

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-STOR-017](#req-stor-017-faster-startup-sync--bisync-head-storm-fix--governed-mode-preseed-bake)

**Verification:** Automated: [Conflict cleanup](../../host/__tests__/rclone-conflict-cleanup.test.js), [S3 bisync](../../scripts/ci/rclone-bisync-s3.py), [transfer bookkeeping](../../scripts/ci/rclone-bookkeeping_test.go)

**Status:** Implemented

---

### REQ-STOR-041: Disk-Space Recovery

**Intent:** Disk exhaustion cannot cause an automatic resync loop.

**Applies To:** User

**Acceptance Criteria:**

1. Missing listings do not lift a disk-space block. <!-- @impl: entrypoint.sh::record_sync_disk_failure --> <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (keeps disk-full sync blocked when subsequent errors report missing listings) -->
2. Failure to persist a disk-space marker does not lift the block. <!-- @impl: entrypoint.sh::record_sync_disk_failure --> <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (blocks recovery when the disk-failure marker cannot be written) -->
3. Only authenticated manual Sync now authorizes a recovery attempt. <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: src/__tests__/lib/sync-fanout.test.ts (marks only explicit Sync now as an authorized disk-space retry) --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (REQ-STOR-015: authenticated manual recovery uses SIGUSR2; ordinary triggers use SIGUSR1) -->
4. Another disk-space failure blocks subsequent automatic attempts. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (failed manual recovery blocks again until a later successful explicit retry) -->
5. Successful recovery resumes periodic sync. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (disk-space recovery requires explicit Sync now, then resumes periodic sync) -->
6. Baseline disk exhaustion does not prevent the recovery daemon from starting. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (starts a reachable recovery daemon when baseline fails for disk space) -->

**Constraints:** Recovery requires local disk space, not merely remote deletion.

**Priority:** P0

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-STOR-015](#req-stor-015-explicit-sync-trigger-from-ui)

**Verification:** Automated: [entrypoint-bisync-behavior.test.js](../../host/__tests__/entrypoint-bisync-behavior.test.js), [entrypoint-runtime-behavior.test.js](../../host/__tests__/entrypoint-runtime-behavior.test.js), [final-sync-endpoint.test.js](../../host/__tests__/final-sync-endpoint.test.js), [sync-fanout.test.ts](../../src/__tests__/lib/sync-fanout.test.ts)

**Status:** Implemented

---

### REQ-STOR-043: Completed Transfer Acknowledgment

**Intent:** Only verified completed transfers advance sync bookkeeping.

**Applies To:** User

**Acceptance Criteria:**

1. Failed transfers do not advance completion bookkeeping. <!-- @impl: scripts/patch-rclone-bisync.py::patch --> <!-- @test: scripts/ci/rclone-bookkeeping_test.go (TestCodeflareCompletedCopyKeepsIndependentMetadata) -->
2. Dry runs do not advance completion bookkeeping. <!-- @impl: scripts/patch-rclone-bisync.py::patch --> <!-- @test: scripts/ci/rclone-bookkeeping_test.go (TestCodeflareCompletedCopyKeepsIndependentMetadata) -->
3. Destination metadata inconsistent with the completed transfer is not acknowledged. <!-- @impl: scripts/patch-rclone-bisync.py::patch --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_server_modtime_sync) -->

**Constraints:** No uncertain destination metadata is acknowledged.

**Priority:** P0

**Dependencies:** [REQ-STOR-042](#req-stor-042-per-side-sync-change-tracking)

**Verification:** Automated: [S3 bisync](../../scripts/ci/rclone-bisync-s3.py), [transfer bookkeeping](../../scripts/ci/rclone-bookkeeping_test.go)

**Status:** Implemented

---

### REQ-STOR-044: Disk-Space Failure Visibility

**Intent:** Users can recognize disk exhaustion and request recovery.

**Applies To:** User

**Acceptance Criteria:**

1. Disk exhaustion immediately publishes failed sync status. <!-- @impl: entrypoint.sh::record_sync_disk_failure --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (starts a reachable recovery daemon when baseline fails for disk space) -->
2. When a running session reports failed sync, Storage displays disk-space recovery guidance. <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (shows a recovery notice and leaves the cloud button usable after sync failure) -->
3. The cloud retry control remains usable after sync failure. <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (shows a recovery notice and leaves the cloud button usable after sync failure) -->
4. Final sync reports a persisted disk-space blocker immediately without requesting a sync cycle. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (reports a disk-space blocker promptly without signaling or clearing it) -->

**Constraints:** An in-memory-only block prevents transfers but may leave final drain waiting for its timeout.

**Priority:** P0

**Dependencies:** [REQ-STOR-041](#req-stor-041-disk-space-recovery)

**Verification:** Automated: [entrypoint-runtime-behavior.test.js](../../host/__tests__/entrypoint-runtime-behavior.test.js), [final-sync-endpoint.test.js](../../host/__tests__/final-sync-endpoint.test.js), [StorageBrowser.test.tsx](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx)

**Status:** Implemented

---

### REQ-STOR-046: Managed projection identity lifecycle

**Intent:** Projection identity controls publication, reconciliation, and inactive-agent cleanup.

**Applies To:** User

**Acceptance Criteria:**

1. Published pending and applied state carries projection identity. <!-- @impl: src/routes/storage/seed.ts::reconcileAgentConfigsForRequest --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-035 AC1/AC3: journals the canonical projection before R2 work and publishes it with applied state) -->
2. Published baked state carries projection identity. <!-- @impl: src/routes/preferences.ts::app --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-STOR-033: baked mode reconciliation stamps selection identity beside the content hash) -->
3. Absent or changed projection identity triggers a full selected-target reconciliation. <!-- @impl: src/lib/r2-seed.ts::buildManagedAutomaticPlan --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-033: a full selected-target pass verifies every selected document and metadata) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (REQ-STOR-033 AC3: same-release %s forces a full selected-target pass) -->
4. Markerless inactive-agent deletion requires a matching conditional identity check. <!-- @impl: src/lib/r2-seed.ts::deleteExactInactiveConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 + REQ-STOR-035: a competing replacement blocks inactive cleanup and policy publication) -->

**Constraints:** Projection does not change the universal signed release digest.

**Priority:** P0

**Dependencies:** [REQ-STOR-033](#req-stor-033-managed-release-delta-planning-and-resume), [REQ-STOR-035](#req-stor-035-managed-reconciliation-cleanup-and-finalization)

**Verification:** Automated: [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts), [preferences.test.ts](../../src/__tests__/routes/preferences.test.ts), [storage-seed-managed.test.ts](../../src/__tests__/routes/storage-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-047: Coding-agent selection resolution

**Intent:** Deployment configuration resolves one valid active coding-agent set.

**Applies To:** User

**Acceptance Criteria:**

1. Omitted selection resolves to every supported coding agent. <!-- @impl: scripts/ci/coding-agent-selection-core.mjs::resolveCodingAgents --> <!-- @test: host/__tests__/coding-agent-selection.test.js (defaults to every coding agent and canonicalizes a configured subset) -->
2. Configured supported names resolve in canonical order without duplicates. <!-- @impl: scripts/ci/coding-agent-selection-core.mjs::resolveCodingAgents --> <!-- @test: host/__tests__/coding-agent-selection.test.js (defaults to every coding agent and canonicalizes a configured subset) -->
3. An empty explicit selection is rejected. <!-- @impl: scripts/ci/coding-agent-selection-core.mjs::resolveCodingAgents --> <!-- @test: host/__tests__/coding-agent-selection.test.js (rejects empty explicit sets and unknown agent names) -->
4. An unknown selected agent fails before storage work. <!-- @impl: entrypoint.sh::validate_coding_agent_selection --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-024: rejects invalid explicit selection before initial restore or baseline work) -->

**Constraints:** Image and Worker paths share the canonical resolver.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated: [coding-agent-selection.test.js](../../host/__tests__/coding-agent-selection.test.js), [entrypoint-managed-curation.test.js](../../host/__tests__/entrypoint-managed-curation.test.js)

**Status:** Implemented

---

### REQ-STOR-048: Selected agent startup

**Intent:** Container startup activates only image resources owned by selected coding agents.

**Applies To:** User

**Acceptance Criteria:**

1. Startup validates agent selection before initial restore. <!-- @impl: entrypoint.sh::run_initial_r2_restore --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-024: rejects invalid explicit selection before initial restore or baseline work) -->
2. Baked lay-down copies only selected agent roots. <!-- @impl: entrypoint.sh::lay_down_agent_seed_preseed --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-024: lays down only selected agent roots and skips the Pi relay when Pi is inactive) -->
3. Pi relay does not run when Pi is inactive. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-024: lays down only selected agent roots and skips the Pi relay when Pi is inactive) -->
4. Claude context setup does not run when Claude Code is inactive. <!-- @impl: entrypoint.sh::claude_context_mode_is_selected --> <!-- @test: host/__tests__/entrypoint-context-mode.test.js (REQ-STOR-024: Claude-inactive startup does not register or enable Claude context-mode) -->

**Constraints:** Remote curation retains release-owned bytes and image-owned companions.

**Priority:** P0

**Dependencies:** [REQ-STOR-004](#req-stor-004-initial-sync-restores-files-on-container-start), [REQ-STOR-031](#req-stor-031-managed-resource-container-sync), [REQ-STOR-047](#req-stor-047-coding-agent-selection-resolution)

**Verification:** Automated: [entrypoint-context-mode.test.js](../../host/__tests__/entrypoint-context-mode.test.js), [entrypoint-managed-curation.test.js](../../host/__tests__/entrypoint-managed-curation.test.js)

**Status:** Implemented

---

### REQ-STOR-049: Selected managed-target execution

**Intent:** Managed planning, writes, and progress use one selected-agent target.

**Applies To:** User

**Acceptance Criteria:**

1. Fingerprint planning uses only selected managed documents. <!-- @impl: src/lib/r2-seed.ts::getSelectedManagedDocumentKeys --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024: automatic fingerprints, streaming writes, and progress use the same selected keys) -->
2. Streaming writes use the same selected target as planning. <!-- @impl: src/lib/r2-seed.ts::seedManagedDocuments --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024: automatic fingerprints, streaming writes, and progress use the same selected keys) -->
3. Reconciliation progress counts the selected target. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-024: automatic fingerprints, streaming writes, and progress use the same selected keys) -->

**Constraints:** Target projection does not change release bytes.

**Priority:** P0

**Dependencies:** [REQ-STOR-024](#req-stor-024-managed-release-application), [REQ-STOR-046](#req-stor-046-managed-projection-identity-lifecycle), [REQ-STOR-047](#req-stor-047-coding-agent-selection-resolution)

**Verification:** Automated: [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-050: Managed-path agent ownership

**Intent:** Every managed agent path has one known owner before mutation.

**Applies To:** User

**Acceptance Criteria:**

1. Every recognized managed agent path resolves to one owner. <!-- @impl: scripts/ci/coding-agent-selection-core.mjs::managedPathOwner --> <!-- @test: host/__tests__/coding-agent-selection.test.js (REQ-STOR-021: classifies every managed home by one owner and rejects unknown roots) -->
2. An unknown current managed path fails before R2 mutation. <!-- @impl: src/lib/r2-seed.ts::requireManagedDocumentOwners --> <!-- @test: src/__tests__/lib/r2-seed-managed.test.ts (REQ-STOR-021 + REQ-STOR-029: an unknown current owner fails before any R2 mutation) -->

**Constraints:** Ownership applies only to governed agent resource homes.

**Priority:** P0

**Dependencies:** [REQ-STOR-021](#req-stor-021-managed-content-ownership), [REQ-STOR-047](#req-stor-047-coding-agent-selection-resolution)

**Verification:** Automated: [coding-agent-selection.test.js](../../host/__tests__/coding-agent-selection.test.js), [r2-seed-managed.test.ts](../../src/__tests__/lib/r2-seed-managed.test.ts)

**Status:** Implemented

---

### REQ-STOR-051: Pi transcript conflict cleanup

**Intent:** Pi transcript conflict copies must not accumulate because Pi cannot resume them.

**Applies To:** User

**Acceptance Criteria:**

1. Cleanup deletes every file or symbolic link whose name contains `.conflict` beneath the Pi session root while preserving canonical transcripts. <!-- @impl: transcript-retention.mjs::deletePiConflictFiles --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (REQ-STOR-051 AC1: Pi deletes every conflict file and preserves canonical transcripts) -->
2. Before regular bisync, cleanup deletes matching remote Pi session objects while preserving canonical transcripts. <!-- @impl: entrypoint.sh::cleanup_remote_pi_transcript_conflicts --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (REQ-STOR-051 AC2: regular bisync removes remote Pi conflicts while preserving canonical transcripts) -->
3. Pi conflict copies are excluded from synchronization so a failed remote cleanup cannot restore or nest them. <!-- @impl: entrypoint.sh::RCLONE_FILTERS --> <!-- @test: host/__tests__/entrypoint-transcript-cleanup.test.js (REQ-STOR-051 AC3: a failed remote cleanup cannot restore conflict copies through bisync) -->

**Constraints:** Unique turns in conflict copies are disposable; failures remain retryable without blocking canonical transcript synchronization.

**Priority:** P1

**Dependencies:** [REQ-STOR-012](#req-stor-012-main-session-transcript-cleanup)

**Verification:** Automated: [entrypoint-transcript-cleanup.test.js](../../host/__tests__/entrypoint-transcript-cleanup.test.js)

**Status:** Implemented

---

### REQ-STOR-052: Session capture compaction converges through bisync

**Intent:** Cold session captures are archived and removed locally, then the existing bisync publishes the complete result to R2.

**Applies To:** User

**Acceptance Criteria:**

1. The daily UTC path prepares the deterministic local archive from the selected cold captures. <!-- @impl: scripts/compact-session-captures.mjs::prepareArchive --> <!-- @test: host/__tests__/session-capture-compaction.test.js (REQ-MEM-024 AC1-AC4: builds a deterministic idempotent archive with recoverable source boundaries) -->
2. Graph provenance is relocated and the complete cumulative contribution is republished before source deletion. <!-- @impl: entrypoint.sh::run_daily_vault_session_compaction --> <!-- @test: host/__tests__/entrypoint-session-capture-compaction.test.js (archives, relocates, deletes, and bisyncs once per UTC day) -->
3. The compactor deletes only recorded cold sources whose current content still matches its manifest. <!-- @impl: scripts/compact-session-captures.mjs::deleteVerifiedSources --> <!-- @test: host/__tests__/session-capture-compaction.test.js (REQ-STOR-052 AC3: deletes only exact unchanged archived sources) -->
4. One bisync publishes the archive, graph update, and source deletions together before the UTC-day completion stamp is written. <!-- @impl: entrypoint.sh::run_daily_vault_session_compaction --> <!-- @test: host/__tests__/entrypoint-session-capture-compaction.test.js (archives, relocates, deletes, and bisyncs once per UTC day) -->
5. A failed step leaves the UTC day unstamped so later synchronization and compaction attempts can continue. <!-- @impl: entrypoint.sh::run_daily_vault_session_compaction --> <!-- @test: host/__tests__/entrypoint-session-capture-compaction.test.js (stops at the first failed step without stamping completion) -->

**Constraints:**

- Compaction reuses the existing rclone remote, filters, lock, and bisync owner; it introduces no direct R2 credential, scheduler service, or parallel sync authority.
- Compaction performs no independent remote reads or verification.
- The final bisync waits for graph provenance relocation and cumulative `user_vault` publication under [REQ-MEM-023](memory.md#req-mem-023-cold-session-captures-compact-without-losing-memory).

**Priority:** P0

**Dependencies:** [REQ-STOR-003](#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-STOR-042](#req-stor-042-per-side-sync-change-tracking), [REQ-MEM-023](memory.md#req-mem-023-cold-session-captures-compact-without-losing-memory)

**Verification:** Automated: [entrypoint-session-capture-compaction.test.js](../../host/__tests__/entrypoint-session-capture-compaction.test.js), [session-capture-compaction.test.js](../../host/__tests__/session-capture-compaction.test.js)

**Status:** Implemented

---

### REQ-STOR-053: Regenerable Python artifacts stay outside home sync

**Intent:** Python environments and bytecode do not consume durable home storage while ordinary user content retains its existing sync scope.

**Applies To:** User

**Acceptance Criteria:**

1. Contents of directories named `.venv` or beginning `.venv-` are excluded at any depth in every session and workspace sync mode. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-053: regenerable Python artifacts stay outside home sync) -->
2. Contents of `__pycache__` directories and files ending `.pyc` or `.pyo` are excluded before positive content-path rules. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-053: regenerable Python artifacts stay outside home sync) -->
3. Adjacent source, dependency manifests and similarly named ordinary files retain their previous session/workspace inclusion behavior. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-053: regenerable Python artifacts stay outside home sync) -->
4. Normal restore and bisync leave existing excluded Python artifacts unchanged on each side without copying them to the other side. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_recovery_archive_filters) -->

**Constraints:**

- No allowlist migration, package-directory scanning, automatic object cleanup or broad `venv`/`site-packages` exclusion.
- The rules classify names, not virtualenv validity; these directory names are reserved for ephemeral artifacts.

**Priority:** P1

**Dependencies:** [REQ-STOR-011](#req-stor-011-sync-mode-controls-workspace-scope)

**Verification:** Automated: [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js), [rclone-bisync-s3.py](../../scripts/ci/rclone-bisync-s3.py)

**Status:** Implemented

---

### REQ-ENTERPRISE-018: Governed Mode Toggle and Configuration Surface

**Intent:** In enterprise, bucket data is corporate-owned and the company must be able to scan agent config (skills, hooks, extensions) for malicious content with its own security tooling. By default every R2 object is encrypted with SSE-C, so the bucket is opaque even to the company. An enterprise admin can enable **Governed Mode** — a deployment-wide, KV-backed toggle (no redeploy) that disables R2 SSE-C so objects use R2's default at-rest encryption and stay readable/scannable by R2-credential holders. Default OFF (SSE-C on); when off, behavior is byte-identical to before. The toggle is configured from the Setup wizard behind an explicit admin confirmation and forwarded to each session's container as the resolved regime, which drives the re-encrypt migration in [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine).

**Applies To:** Admin

**Acceptance Criteria:**

1. Setup configuration accepts an enterprise-only Governed Mode Boolean and stores active/inactive setup state; non-enterprise configuration never writes it. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup.test.ts (REQ-ENTERPRISE-018 AC1 + REQ-ENTERPRISE-019 AC1: configure server storage flag persistence) -->
2. Enterprise Setup configuration reports the storage-encryption progress step. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup.test.ts (REQ-ENTERPRISE-018 AC1 + REQ-ENTERPRISE-019 AC1: configure server storage flag persistence) -->
3. Enterprise Setup prefill round-trips the Governed Mode Boolean. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-ENTERPRISE-018: Governed Mode (R2 SSE-C disable) prefill) -->
4. The Setup wizard renders an enterprise-only Governed Mode toggle (default off, not rendered outside enterprise) whose change requires an explicit admin confirmation of the re-encrypt consequence before it flips the store value. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->
5. The Enterprise Administration SSE-C toggle has accessible help explaining that authorized tools can scan converted files without the customer key, unconverted SSE-C files still require it, migration may skip files, and default R2 encryption and bucket visibility are unchanged. <!-- @impl: web-ui/src/components/admin/EnvironmentAreaFields.tsx::EnvironmentAreaFields --> <!-- @test: web-ui/src/__tests__/components/EnvironmentAreaFields.test.tsx (Data governance copy contract: accessible persistence choice %s explains consequences and submits both directions) -->

**Constraints:**

- Governed Mode gates only R2 SSE-C; vault and secret-at-rest encryption remain active.
- Deployment-wide policy stored in KV (no redeploy to flip), mirroring [REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress); With Governed Mode off (the default) all SSE-C behavior, seeding, and sync are byte-identical to before.

**Priority:** P2

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated: [setup.test.ts](../../src/__tests__/routes/setup.test.ts), [handlers.test.ts](../../src/__tests__/routes/setup/handlers.test.ts), [ConfigureStep.test.tsx](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx), [setup.test.ts](../../web-ui/src/__tests__/stores/setup.test.ts), [EnvironmentAreaFields.test.tsx](../../web-ui/src/__tests__/components/EnvironmentAreaFields.test.tsx)

**Status:** Implemented

---

### REQ-ENTERPRISE-300: Committed bucket regime for storage IO

**Intent:** Storage helpers, every writer and migration readers obey their distinct encryption-regime obligations.

**Applies To:** Admin

**Acceptance Criteria:**

1. SSE helpers suppress headers for disabled buckets. <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @impl: src/lib/r2-sse.ts::getSseCopyHeaders --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (regime helpers (REQ-ENTERPRISE-018)) -->
2. Every writer follows the bucket's committed regime. <!-- @impl: src/lib/r2-regime-state.ts::isR2SseDisabledForBucket --> <!-- @impl: src/lib/r2-seed.ts::seedDocuments --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-SEC-005: %s emits SSE-C only for the committed encrypted regime) --> <!-- @manual: documentation/lanes/storage-and-sync.md#committed-regime-writer-acceptance -->
3. Readers use dual-regime fallback throughout migration. <!-- @impl: src/lib/r2-migration.ts::fetchObjectWithRegimeFallback --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (falls back without flagging a stray while the bucket is migrating) -->

**Constraints:**

- Governed Mode gates only R2 SSE-C; vault and secret-at-rest encryption remain active.
- Deployment-wide policy stored in KV (no redeploy to flip), mirroring [REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress); With Governed Mode off (the default) all SSE-C behavior, seeding, and sync are byte-identical to before.

**Priority:** P2

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface)

**Verification:** Automated: [r2-sse.test.ts](../../src/__tests__/lib/r2-sse.test.ts), [r2-migration.test.ts](../../src/__tests__/lib/r2-migration.test.ts), [storage-upload.test.ts](../../src/__tests__/routes/storage-upload.test.ts); Manual: [Committed-regime writer acceptance](../../documentation/lanes/storage-and-sync.md#committed-regime-writer-acceptance)

**Status:** Implemented

---

### REQ-ENTERPRISE-301: Container regime propagation and governed sync configuration

**Intent:** Containers receive the resolved bucket regime without unused server encryption keys, and governed sync uses matching headers and checksums.

**Applies To:** Admin

**Acceptance Criteria:**

1. The resolved bucket regime is forwarded to the container. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: src/container/container-env.ts::applyBucketName --> <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @test: src/__tests__/container/container-env.test.ts (applyBucketName / applyPrefsOnRestart propagate userTimezone (REQ-SESSION-016 AC3 wiring regression) / REQ-AGENT-029 (container env vars contract)) -->
2. Governed Mode withholds the server encryption key from the container environment. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-018: omits ENCRYPTION_KEY in Governed Mode (SSE-C off → rclone never uses it); emits it when SSE-C on) -->
3. Governed Mode omits SSE-C sync configuration. <!-- @impl: entrypoint.sh::create_rclone_config --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (Governed Mode (R2_SSE_DISABLED=true): omits SSE-C even with ENCRYPTION_KEY and enables checksums) -->
4. Governed Mode re-enables sync checksums. <!-- @impl: entrypoint.sh::create_rclone_config --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (Governed Mode (R2_SSE_DISABLED=true): omits SSE-C even with ENCRYPTION_KEY and enables checksums) -->

**Constraints:**

- Governed Mode gates only R2 SSE-C; vault and secret-at-rest encryption remain active.
- Deployment-wide policy stored in KV (no redeploy to flip), mirroring [REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress); With Governed Mode off (the default) all SSE-C behavior, seeding, and sync are byte-identical to before.

**Priority:** P2

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface)

**Verification:** Automated: [container-env.test.ts](../../src/__tests__/container/container-env.test.ts), [container-env-llm.test.ts](../../src/__tests__/container/container-env-llm.test.ts), [entrypoint-governed-sync.test.js](../../host/__tests__/entrypoint-governed-sync.test.js)

**Status:** Implemented

---

### REQ-ENTERPRISE-020: Governed Mode Re-Encrypt Migration Engine

**Intent:** Reconcile each bucket losslessly to the selected encryption regime. Background dashboard refresh drives eligible migration without manual file transfers, and the new regime is published only after verification.

**Applies To:** Admin

**Acceptance Criteria:**

1. Re-encryption uses conditional same-key server copy, preserving metadata and ETag while applying source and destination SSE-C headers; success requires a parsed result ETag without an embedded error. <!-- @impl: src/lib/r2-migration.ts::migrateBucketEncryption --> <!-- @impl: src/lib/r2-sse.ts::computeKeyMd5 --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (migrateBucketEncryption (lossless REPLACE re-encrypt)) -->
2. That same source-regime HEAD is the idempotency check: a `400`/`403` SSE-mismatch means the object already reads in the target regime and is skipped ([AD91](../../documentation/decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile)). <!-- @impl: src/lib/r2-migration.ts::migrateBucketEncryption --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (migrateBucketEncryption (lossless REPLACE re-encrypt)) -->
3. An object over the 5 GB single-copy limit is recorded `oversized` and skipped. <!-- @impl: src/lib/r2-migration.ts::migrateBucketEncryption --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (migrateBucketEncryption (lossless REPLACE re-encrypt)) -->
4. Each poll advances ready, migrating, and mixed-recovery bucket state: policy drift starts migration only when D1 confirms no workload-owning session, otherwise remaining pending. <!-- @impl: src/lib/r2-regime-state.ts::getRegimeState --> <!-- @impl: src/lib/r2-migration.ts::planRegimeReconcile --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-020 AC3/7: ancillary polls checkpoint and finish %s through real reconciliation) -->
5. Advance the regime and generation only after target-regime verification of all eligible objects, excluding recorded oversized skips and independently verified empty objects. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-020 AC4/AC5: a timed-out copy is aborted, leaves source intact, releases the lease, and resumes) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (an oversized object does not wedge the migration — verify skips it and the bucket reaches ready) -->
6. SSE-C migration preserves a default-encrypted empty object only if a fresh authenticated read without SSE-C independently verifies zero length. A listing alone or a failed probe does not qualify. <!-- @impl: src/lib/r2-migration.ts::verifyChunk --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-020 AC5: independently proves a plain empty object alongside SSE-C objects (%s)) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-020 AC5: verifies the empty exception from fresh R2 evidence (%s)) -->
7. Start verification after the copy pass in the same work interval if budget permits; otherwise resume from the saved checkpoint. <!-- @impl: src/lib/r2-migration.ts::advanceMigrationChunk --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->

**Constraints:** [CON-STOR-001](constraints.md#con-stor-001-r2-regime-migration-boundaries); copy and checkpoint mechanics in [AD91](../../documentation/decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated: [r2-migration.test.ts](../../src/__tests__/lib/r2-migration.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-302: Migration chunk admission checkpoint and failure isolation

**Intent:** Resumable migration uses bounded slices, per-operation aborts, subsequent deadline admission and lease release while isolating failures.

**Applies To:** Admin

**Acceptance Criteria:**

1. Each poll's background migration work scans at most 1,000 keys per page. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
2. Per-object failures are isolated. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
3. Each migration R2 fetch aborts if response headers do not arrive within its operation budget. The fetch timer does not cover later body reads. <!-- @impl: src/lib/r2-migration.ts::fetchWithTimeout --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-020 AC4/AC5: a timed-out copy is aborted, leaves source intact, releases the lease, and resumes) -->
4. After every chunk, the cursor checkpoints the last processed key so resume starts at the next key. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
5. The initial bounded slice runs unconditionally; subsequent slices and chunks require deadline admission, without a universal aggregate wall-clock bound. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
6. At exit, release only the invocation’s own lease. On chunk failure, attempt to persist the error and release for retry without throwing. If failure recovery cannot persist the release, lease expiry permits retry. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (never throws and records lastError when a chunk fails (releases the lease for retry)) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (the failure catch never clobbers a successor poll’s lease (releases only its own)) -->
7. Each poll's background re-encryption runs in slices of at most six. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->

**Constraints:**

The migration integrity, safe retry, termination and session-creation constraints of [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine) apply unchanged.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine)

**Verification:** Automated: [r2-migration.test.ts](../../src/__tests__/lib/r2-migration.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-303: Migration counting and progress projection

**Intent:** Migration counts once and accumulates both passes before projecting rounded progress with unknown and halted omissions.

**Applies To:** Admin

**Acceptance Criteria:**

1. At drain, the bucket object `total` is counted once via a bounded listing. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
2. `processed` accumulates across both passes. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
3. `batch-status` returns the rounded `bucketMigrationPercent`, omitted until `total` is known and while `halted`. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->

**Constraints:**

The migration integrity, safe retry, termination and session-creation constraints of [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine) apply unchanged.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine)

**Verification:** Automated: [r2-migration.test.ts](../../src/__tests__/lib/r2-migration.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-021: Governed Mode Migration Safety and Access Boundary

**Intent:** While a bucket's regime migrates ([REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine)), the system must stay correct and safe for concurrent access: platform writers are backend-gated and direct R2 writers require maintenance quiescence, D1-owned workloads defer conversion, reads stay up via a dual-regime fallback with self-heal for eligible strays, and the dashboard reflects migration progress. Under strict Gateway egress ([REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress)) together with Governed Mode, this boundary also keeps the container's real-secret footprint down to just the DO-issued container-authentication credential.

**Applies To:** Admin

**Acceptance Criteria:**

1. Strict egress with Governed Mode exposes only the DO-issued container credential; all service credentials remain placeholders or absent ([REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress)). <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (container secret hygiene: no AWS_* anywhere, CF token placeholder-only in enterprise) -->
2. While a bucket migrates, platform write attempts are blocked before user R2 I/O, except explicit matching uncertain-completion abort recovery under REQ-ENTERPRISE-086. <!-- @impl: src/routes/storage/upload.ts::app --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (Governed Mode write gate (REQ-ENTERPRISE-021)) -->
3. While a bucket migrates, sync fan-out performs no container work. <!-- @impl: src/lib/r2-regime-state.ts::isBucketMigrating --> <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/routes/sessions-sync.test.ts (skips the entire fan-out while the bucket is migrating (no container is contacted)) -->
4. Migration preflight defers while D1 records a workload owner, without destroying that workload. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
5. Ancillary status returns `bucketMigrating`, a 0–99 `bucketMigrationPercent` when known and not halted, and the halt timestamp instead of percentage when halted. <!-- @impl: src/routes/session/lifecycle.ts::app.get --> <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-021: one authenticated retry resets the halt and keeps writes gated until the next poll verifies) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-020 AC3/7: ancillary polls checkpoint and finish %s through real reconciliation) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-021 AC5: ancillary progress never reports 100 before verification completes) -->
6. Read paths (download, preview) try the committed regime first and fall back once to the opposite regime on a `400`/`403` SSE-mismatch, so a partially-migrated bucket stays readable. <!-- @impl: src/lib/r2-migration.ts::fetchObjectWithRegimeFallback --> <!-- @impl: src/lib/r2-regime-state.ts::resolveReadRegime --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (fetchObjectWithRegimeFallback (D2 reads stay up)) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (%s reads committed bytes and starts mixed recovery on eligible %s fallback) -->
7. An eligible fallback hit on a `ready` bucket starts one `mixed-recovery` scan only without a healthy container, otherwise keeps the bucket ready, and changes neither regime nor generation. Verified empty default-encrypted objects are not eligible. <!-- @impl: src/lib/r2-migration.ts::fetchObjectWithRegimeFallback --> <!-- @impl: src/lib/r2-migration.ts::markMixedRecovery --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (flips a ready bucket into a mixed-recovery scan) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (is a no-op when a migration is already in flight) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (D1: defers (does not flip/gate) when a session container is still healthy) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-021: a ready SSE-C bucket downloads an empty plain object without starting self-heal) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (falls back to the opposite regime on a 400 and flags a stray on a READY bucket) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (%s reads committed bytes and starts mixed recovery on eligible %s fallback) -->

**Constraints:** [CON-STOR-001](constraints.md#con-stor-001-r2-regime-migration-boundaries).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine), [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SEC-005](security.md#req-sec-005-r2-files-encrypted-at-rest-with-sse-c-when-operator-configures-an-encryption-key), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)

**Verification:** Automated: [container-env-llm.test.ts](../../src/__tests__/container/container-env-llm.test.ts), [storage-upload.test.ts](../../src/__tests__/routes/storage-upload.test.ts), [sessions-sync.test.ts](../../src/__tests__/routes/sessions-sync.test.ts), [r2-migration.test.ts](../../src/__tests__/lib/r2-migration.test.ts), [halt status HTTP fixture](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-304: Dashboard migration affordance and refresh

**Intent:** The dashboard reflects migration flags through disabled creation and initial and periodic refresh.

**Applies To:** User

**Acceptance Criteria:**

1. During bucket migration, Dashboard disables New Session in the existing upgrade slot. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @manual: documentation/lanes/storage-and-sync.md#req-enterprise-021-migration-progress-acceptance -->
2. Initial load and five-second migration polling mirror `bucketMigrating` and `bucketMigrationPercent` flags. <!-- @test: web-ui/src/__tests__/stores/session.test.ts (Session Store) --> <!-- @impl: web-ui/src/stores/session-polling.ts::scheduleNextPoll --> <!-- @impl: web-ui/src/lib/constants.ts::SESSION_POLL_TRANSITION_MS = 5_000 -->
3. During bucket migration, Dashboard displays `Migrating N%` in the New Session slot when progress is known. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @manual: documentation/lanes/storage-and-sync.md#req-enterprise-021-migration-progress-acceptance -->
4. On halt, the disabled New Session slot displays `Migration halted` beside the same square icon control used for failed seed activation, labeled `Retry migration` for assistive technology and the tooltip. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-304: a halt keeps creation disabled and offers an icon-only retry (bucketMigrating=%s)) --> <!-- @manual: documentation/lanes/storage-and-sync.md#req-enterprise-021-migration-progress-acceptance -->
5. The dashboard prevents duplicate retry submissions while pending and, after acknowledgment, for the same halt even across view switches. <!-- @impl: web-ui/src/components/MigrationRetryNotice.tsx::createMigrationRetry --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-304: Retry migration submits the halt timestamp once while pending and does not unlock New Session on success) --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-ENTERPRISE-323: shares clone notices and preserves retry acknowledgment when returning to Dashboard) -->
6. A retry acknowledgment does not enable New Session before the migration completes. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-304: Retry migration submits the halt timestamp once while pending and does not unlock New Session on success) -->
7. The dashboard shows a refusal without waiting for a refresh, only while its halt is current; observed progress replaces it if that halt clears without being superseded. <!-- @impl: web-ui/src/components/MigrationRetryNotice.tsx::createMigrationRetry --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-304: a rejected retry is reported without rendering server markup or lifting the halt) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-304: a retry refusal belongs only to the halt that was retried) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-304: a late refusal stays hidden after a different halt becomes current) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-323: a stalled refresh does not hide a refusal for the current halt) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-323: reports running instead of retry failure after an updated status (%s)) -->

**Constraints:** Under [CON-STOR-001](constraints.md#con-stor-001-r2-regime-migration-boundaries), the backend gates platform writes and defers migration while a session owns the bucket; operators separately pause direct R2 writes.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine), [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SEC-005](security.md#req-sec-005-r2-files-encrypted-at-rest-with-sse-c-when-operator-configures-an-encryption-key), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container), [REQ-ENTERPRISE-021](#req-enterprise-021-governed-mode-migration-safety-and-access-boundary)

**Verification:** Automated: [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx), [session store](../../web-ui/src/__tests__/stores/session.test.ts); Manual: [migration progress acceptance](../../documentation/lanes/storage-and-sync.md#req-enterprise-021-migration-progress-acceptance)

**Status:** Implemented

---

### REQ-ENTERPRISE-323: Migration retry feedback

**Intent:** Confirm that a retry is in progress without changing the creation gate.

**Applies To:** User

**Acceptance Criteria:**

1. Dashboard announces `Retrying migration` when retry starts. <!-- @impl: web-ui/src/components/MigrationRetryNotice.tsx::MigrationRetryNotice --> <!-- @manual: documentation/lanes/storage-and-sync.md#req-enterprise-021-migration-progress-acceptance -->
2. Dashboard exposes the retry control as busy while a retry is pending and the control remains visible. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-304: Retry migration submits the halt timestamp once while pending and does not unlock New Session on success) -->
3. Dashboard keeps `Retrying migration` visible until the retry settles, even if the halt clears first; the notice can be dismissed only after settlement. <!-- @impl: web-ui/src/components/MigrationRetryNotice.tsx::MigrationRetryNotice --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-304: Retry migration submits the halt timestamp once while pending and does not unlock New Session on success) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-304: pending feedback survives the halt clearing before the retry settles) -->
4. The empty retry status adds no extra gap above Recent Sessions. <!-- @impl: web-ui/src/styles/layout.css::.dashboard-migration-retry-notice:not(.repository-restore-notice) --> <!-- @manual: documentation/lanes/storage-and-sync.md#req-enterprise-021-migration-progress-acceptance -->
5. Retry feedback uses the repository-clone activity overlay. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/components/MigrationRetryNotice.tsx::MigrationRetryNotice --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-ENTERPRISE-323: shares clone notices and preserves retry acknowledgment when returning to Dashboard) -->
6. Dashboard requests fresh status after retry settlement unless redirected to sign in. <!-- @impl: web-ui/src/components/MigrationRetryNotice.tsx::createMigrationRetry --> <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionAncillaryStatus --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-323: reports running instead of retry failure after an updated status (%s)) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-ENTERPRISE-323: checks status after a poll already in flight when retry settles) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-323: a sign-in redirect settles retry without refreshing status or showing a refusal) -->
7. After acknowledgment, Dashboard explains that it is waiting for updated status while the same halt remains current, including across view switches. A replacement halt retires the earlier retry feedback. <!-- @impl: web-ui/src/components/MigrationRetryNotice.tsx::createMigrationRetry --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-304: Retry migration submits the halt timestamp once while pending and does not unlock New Session on success) --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-ENTERPRISE-323: shares clone notices and preserves retry acknowledgment when returning to Dashboard) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-ENTERPRISE-323: a late retry acknowledgment does not revive feedback after a replacement halt clears) -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-304](#req-enterprise-304-dashboard-migration-affordance-and-refresh)

**Verification:** Automated: [Dashboard retry fixtures](../../web-ui/src/__tests__/components/Dashboard.test.tsx), [shared overlay](../../web-ui/src/__tests__/components/Layout.test.tsx), [status refresh](../../web-ui/src/__tests__/stores/session.test.ts); Manual: [migration progress acceptance](../../documentation/lanes/storage-and-sync.md#req-enterprise-021-migration-progress-acceptance)

**Status:** Implemented

---

### REQ-ENTERPRISE-322: Owner-authorized migration retry

**Intent:** Let the bucket owner retry a halted scan without bypassing migration safeguards.

**Applies To:** User

**Acceptance Criteria:**

1. A retry can restart only the authenticated owner's matching current halt. Duplicate or stale attempts do not start new work. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @impl: src/container/index.ts::retryBucketMigration --> <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-021: one authenticated retry resets the halt and keeps writes gated until the next poll verifies) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-322: an authenticated owner cannot retry another bucket’s halt) -->
2. Unsafe retries return an actionable refusal without clearing the halt. If the original key identity was never recorded, the refusal directs the owner to administrator recovery. <!-- @impl: src/container/index.ts::retryBucketMigration --> <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-021: refuses %s without changing the halted migration) -->
3. An accepted retry retains the committed regime, generation, and write gate until verification. <!-- @impl: src/container/index.ts::retryBucketMigration --> <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-021: one authenticated retry resets the halt and keeps writes gated until the next poll verifies) -->
4. Newly started mixed recovery records the configured key identity so a matching halt can be retried without changing the committed regime or generation. <!-- @impl: src/lib/r2-migration.ts::markMixedRecovery --> <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-322: a mixed recovery can retry its own halt without advancing the generation) -->

**Constraints:** Retry does not override workload ownership, held leases, pending multipart recovery, policy, or the original key check.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-021](#req-enterprise-021-governed-mode-migration-safety-and-access-boundary)

**Verification:** Automated: [bucket-owner HTTP retry fixtures](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-086: Governed Mode Migration Multipart Safety

**Intent:** Platform-controlled multipart completion must not publish an object in a stale encryption regime across migration; capped provider cleanup is preparation, not universal external-upload tracking.

**Applies To:** System

**Acceptance Criteria:**

1. Migration preparation lists at most 100 uploads without continuation and attempts bounded-concurrency aborts before the first migration chunk. All attempted aborts settle; discovery/abort failure retains retry/error state without publishing drained or ready. This is not an exhaustive-abort guarantee. <!-- @impl: src/lib/r2-migration.ts::advanceMigrationChunk --> <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-086 AC1: prepares one capped multipart page without continuation) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-086: %s prevents drained and ready publication) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-ENTERPRISE-086 AC1: bounded abort attempts settle before the first copy) -->

**Constraints:**

- The existing bucket-scoped Container DO serializes platform multipart operations and migration chunks, binds bucket ownership and durably records upload key/regime/generation.
- Verified generation/regime is durable before KV ready publication; stale KV visibility cannot revive old upload IDs. <!-- @impl: src/container/index.ts::runBucketMultipart --> <!-- @impl: src/container/index.ts::advanceBucketMigration --> <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-086: in-flight completion settles before migration; stale/unknown IDs preserve parts and request restart) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-ENTERPRISE-086: lost completion response gates migration until explicit abort confirms recovery) -->
- Unknown, legacy or stale managed part/completion IDs return `409 MULTIPART_RESTART_REQUIRED` without consuming or deleting parts.
- Completion requires a complete result root and one valid closed ETag.
- Lost or unverifiable completion durably blocks migration until an explicit matching abort confirms removal or definitive 404 absence. <!-- @impl: src/routes/storage/upload.ts::performBucketMultipart --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-ENTERPRISE-086: %s completion returns actionable restart without R2 writes) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-ENTERPRISE-086: unverifiable completion response %s retains recovery admission) -->
- Platform admission cannot fence arbitrary direct R2 writers; external writers must be quiescent throughout migration maintenance.
- Capped listing does not discover or abort every external upload.
- Dual-regime reads, readable-byte preservation and read repair are independent safeguards, not substitutes for safe completion.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine), [REQ-ENTERPRISE-021](#req-enterprise-021-governed-mode-migration-safety-and-access-boundary)

**Verification:** Automated: [index.test.ts](../../src/__tests__/container/index.test.ts), [storage-upload.test.ts](../../src/__tests__/routes/storage-upload.test.ts), [r2-migration.test.ts](../../src/__tests__/lib/r2-migration.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-019: View-Only Storage (download disable)

**Intent:** Enterprise view-only storage restricts attachment and non-viewable file downloads while preserving permitted inline viewing. Non-Enterprise behavior is unchanged.

**Applies To:** User

**Acceptance Criteria:**

1. Active enterprise view-only policy runs before R2 access: attachments and non-viewable inline types return distinct `403 DOWNLOADS_DISABLED`; text, Markdown, HTML-as-text, images, and PDF remain inline. <!-- @impl: src/routes/storage/download.ts::isInlineViewable --> <!-- @impl: src/lib/error-types.ts::DownloadsDisabledError --> <!-- @impl: src/lib/downloads-policy.ts::isDownloadsDisabled --> <!-- @test: src/__tests__/routes/storage-download.test.ts (Storage Download Routes) -->
2. The user profile delivers download policy so Storage Panel controls remain blocked-looking, visible and tappable; any interaction opens an administrator-disabled notice instead of fetching. <!-- @test: web-ui/src/__tests__/stores/storage.test.ts (REQ-ENTERPRISE-019 AC2: fetched user-profile policy reaches storage controls and opens the blocked-download notice) --> <!-- @impl: web-ui/src/lib/schemas.ts::UserResponseSchema --> <!-- @impl: web-ui/src/lib/download.ts::downloadFile --> <!-- @impl: web-ui/src/stores/storage.ts::storageStore --> <!-- @impl: web-ui/src/stores/storage.ts::refreshDownloadsDisabled --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser / REQ-STOR-016 AC1/AC2 (file browser drawer/bottom-sheet presentation, R2 as source of truth via Worker API)) -->
3. The resolver never reads policy KV outside enterprise; enterprise reads the stored toggle. <!-- @impl: src/lib/downloads-policy.ts::isDownloadsDisabled --> <!-- @test: src/__tests__/routes/storage-download.test.ts (REQ-ENTERPRISE-019 AC5: enterprise mode %s never enters the policy KV boundary) --> <!-- @test: src/__tests__/routes/storage-download.test.ts (blocks a non-inline (attachment) download with 403 and the DOWNLOADS_DISABLED code) -->

**Constraints:**

- Direct requests are subject to server-side enforcement; the Storage Panel notice alone is not a guard.
- [REQ-ENTERPRISE-309](setup.md#req-enterprise-309-configure-view-only-storage) owns the saved toggle; absent or unreadable state defaults off.
- Upload and delete are unaffected.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SEC-013](security.md#req-sec-013-content-disposition-hardening-on-downloads)

**Verification:** Automated: [storage-download.test.ts](../../src/__tests__/routes/storage-download.test.ts), [StorageBrowser.test.tsx](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx), [download.test.ts](../../web-ui/src/__tests__/lib/download.test.ts), [FilePreview.test.tsx](../../web-ui/src/__tests__/components/FilePreview.test.tsx), [DownloadsDisabledPopup.test.tsx](../../web-ui/src/__tests__/components/DownloadsDisabledPopup.test.tsx), [storage.test.ts](../../web-ui/src/__tests__/stores/storage.test.ts), [contract.test.ts](../../web-ui/src/__tests__/api/contract.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-305: View-only policy off-state and read-failure compatibility

**Intent:** Download compatibility and the accepted default-off read-failure behavior preserve existing downloads and API shape.

**Applies To:** System

**Acceptance Criteria:**

1. With the Enterprise stored toggle OFF, the existing download path and behavior remain unchanged. <!-- @impl: src/lib/downloads-policy.ts::isDownloadsDisabled --> <!-- @test: src/__tests__/routes/storage-download.test.ts (REQ-ENTERPRISE-305 AC1: enterprise download retains bytes and attachment headers with stored toggle %s) -->
2. A transient policy read failure defaults OFF and preserves downloads. <!-- @impl: src/lib/downloads-policy.ts::isDownloadsDisabled --> <!-- @test: src/__tests__/routes/storage-download.test.ts (REQ-ENTERPRISE-019 AC5: keeps downloads available when the enterprise policy KV read rejects) -->
3. With the Enterprise stored toggle OFF, Setup retains the existing configure request and response shape. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup.test.ts (persists $field=$enabled in enterprise and reports completed progress) -->
4. A transient policy read failure reports `downloadsDisabled: false` in the user profile. <!-- @impl: src/lib/downloads-policy.ts::isDownloadsDisabled --> <!-- @test: src/__tests__/routes/user-profile.test.ts (REQ-ENTERPRISE-019 AC5: reports downloadsDisabled false when the policy KV read rejects) -->

**Constraints:**

- Server-side enforcement covers direct download URLs; frontend controls and notices are not enforcement.
- The toggle persists explicit active or inactive state; absent or unreadable state defaults off, and non-enterprise deployments never read it.
- Scope is **download (exfil) only**: upload and delete are intentionally unaffected (they are not exfiltration vectors).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SEC-013](security.md#req-sec-013-content-disposition-hardening-on-downloads), [REQ-ENTERPRISE-019](#req-enterprise-019-view-only-storage-download-disable)

**Verification:** Automated: [storage-download.test.ts](../../src/__tests__/routes/storage-download.test.ts), [setup.test.ts](../../src/__tests__/routes/setup.test.ts), [handlers.test.ts](../../src/__tests__/routes/setup/handlers.test.ts), [setup.test.ts](../../web-ui/src/__tests__/stores/setup.test.ts), [StorageBrowser.test.tsx](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx), [download.test.ts](../../web-ui/src/__tests__/lib/download.test.ts), [FilePreview.test.tsx](../../web-ui/src/__tests__/components/FilePreview.test.tsx), [DownloadsDisabledPopup.test.tsx](../../web-ui/src/__tests__/components/DownloadsDisabledPopup.test.tsx), [storage.test.ts](../../web-ui/src/__tests__/stores/storage.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-030: Managed-resource Storage enforcement

**Intent:** User-facing Storage mutations that may affect managed resources enforce the applied policy before user-object R2 requests; ordinary user files remain usable during managed updates.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Storage uploads, multipart operations, and exact, batch, or prefix deletes check bucket migration before policy evaluation. <!-- @impl: src/routes/storage/upload.ts::app --> <!-- @impl: src/routes/storage/delete.ts::app --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-ENTERPRISE-030 AC1: migration refusal precedes conflicting managed policy for %s (%j)) -->
2. For potentially managed targets, Storage compares full desired and applied identity before policy loading. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (fails update-pending before policy lookup on %s mismatch) -->
3. Storage verifies policy before a potentially managed user-object R2 request. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-ENTERPRISE-030: denies protected upload before the user-object R2 request) -->
4. Exact or intersecting protected targets return `403`. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (blocks exact keys and intersecting prefixes but permits adjacent paths) -->
5. For potentially managed targets, including root/ancestor prefixes and mixed selections, uncertain desired, applied, pending-target, or policy state returns managed-update-pending without a user-object R2 request. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (fails update-pending before policy lookup on %s mismatch) --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (REQ-ENTERPRISE-030 AC5: blocks storage mutation while interrupted targets remain pending) --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (retains pending protection for managed or overlapping targets: %j) -->
6. Managed-update-pending Storage responses explain that the requested upload or deletion may affect managed resources and remains blocked until the update finishes. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @impl: src/lib/error-types.ts::ManagedEnvironmentUpdatePendingError --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (returns a conflict for managed targets during a managed update) --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (returns a conflict when managed policy verification is unavailable) -->

7. A nonempty request bypasses managed readiness only when every validated key and deletion prefix lies outside managed-release roots, legacy agent resources and private coordinator metadata. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (allows ordinary targets during an interrupted update: %j) --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (allows ordinary upload operation %s while managed reconciliation is pending) --> <!-- @test: src/__tests__/routes/storage-delete.test.ts (deletes an ordinary file while managed reconciliation is pending) --> <!-- @test: src/__tests__/routes/storage-download.test.ts (downloads an ordinary file while managed reconciliation is pending) -->

**Constraints:**

- Storage uses the verified user-bucket policy and does not create another authority.
- Authentication, bucket migration checks, and administrator download restrictions remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-ENTERPRISE-027](security.md#req-enterprise-027-managed-resource-admission-and-transport), [REQ-STOR-030](storage.md#req-stor-030-managed-resource-policy-loading)

**Verification:** Automated: [managed-storage-guard.test.ts](../../src/__tests__/lib/managed-storage-guard.test.ts), [storage-upload.test.ts](../../src/__tests__/routes/storage-upload.test.ts), [storage-delete.test.ts](../../src/__tests__/routes/storage-delete.test.ts), [storage-download.test.ts](../../src/__tests__/routes/storage-download.test.ts)

**Status:** Implemented

---

### REQ-STOR-054: Post-sync rclone conflict-copy cleanup

**Intent:** Conflict-copy files do not accumulate in synchronized local storage or its R2 destination.

**Applies To:** User

**Acceptance Criteria:**

1. After each existing user-storage sync attempt, including initial restore, baseline attempts and periodic/final bisync, eligible files whose basenames contain the case-sensitive `.conflict` marker are removed from the same local and remote roots. <!-- @impl: scripts/rclone-conflict-cleanup.sh::cleanup_rclone_conflicts --> <!-- @test: host/__tests__/rclone-conflict-cleanup.test.js (REQ-STOR-054 AC1: post-sync cleanup removes local and remote conflict copies) --> <!-- @test: host/__tests__/rclone-conflict-cleanup.test.js (REQ-STOR-054 AC1: a genuine divergence preserves the winner and discards eligible loser copies) -->
2. Nonmatching originals, directories, symlinks, protected Operator output and receipt-metadata roots, and other buckets/prefixes remain unchanged. <!-- @impl: scripts/rclone-conflict-cleanup.sh::cleanup_rclone_conflicts --> <!-- @test: host/__tests__/rclone-conflict-cleanup.test.js (REQ-STOR-054 AC2: cleanup preserves originals and scopes deletion to the sync roots) -->
3. Cleanup runs after the transfer attempt and cannot turn an existing sync failure into success. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/rclone-conflict-cleanup.test.js (REQ-STOR-054 AC3: cleanup follows the sync attempt without masking its failure) -->
4. Cleanup failures remain visible through existing sync diagnostics. <!-- @impl: scripts/rclone-conflict-cleanup.sh::cleanup_rclone_conflicts --> <!-- @test: host/__tests__/rclone-conflict-cleanup.test.js (REQ-STOR-054 AC4: cleanup errors remain visible and empty repeats are harmless) -->
5. Repeated cleanup with no matches preserves ordinary files unchanged. <!-- @impl: scripts/rclone-conflict-cleanup.sh::cleanup_rclone_conflicts --> <!-- @test: host/__tests__/rclone-conflict-cleanup.test.js (REQ-STOR-054 AC5: empty repeats preserve ordinary files) -->
6. Remote cleanup uses the remaining startup/baseline attempt deadline and the existing network-timeout bound for ordinary cycles. <!-- @impl: scripts/rclone-conflict-cleanup.sh::cleanup_rclone_conflicts --> <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/rclone-conflict-cleanup.test.js (REQ-STOR-054 AC6: startup and baseline share their existing transfer deadline with cleanup) --> <!-- @test: host/__tests__/rclone-conflict-cleanup.test.js (REQ-STOR-054 AC6: a stalled remote cleanup obeys its remaining deadline) --> <!-- @test: host/__tests__/rclone-conflict-cleanup.test.js (REQ-STOR-054 AC6: ordinary cleanup uses the existing thirty-second network bound) -->

**Notes:** [Conflict cleanup](../../documentation/lanes/storage-and-sync.md#conflict-resolution) is implemented and tested. Exact-runtime activation remains a separate deployment observation, not proof supplied by a source checkout.

**Constraints:**

- Use only the configured user sync roots and existing rclone credentials.
- Restricted Operator upload roots remain outside cleanup scope.
- No global binary wrapper, timer, UI, secret store or merge/archive workflow is introduced.
- No protected-workload replay is authorized.

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated: [rclone-conflict-cleanup.test.js](../../host/__tests__/rclone-conflict-cleanup.test.js)

**Status:** Implemented

---

### REQ-STOR-055: Home persistence admission and scope transitions

**Intent:** Persistence preserves eligible user state while allowing an explicit approved-location policy.

**Applies To:** User

**Acceptance Criteria:**

1. Exclude is the compatible default and admits home paths unless explicitly restricted; Include denies paths outside root-anchored durable namespaces. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-002/004/011/031/032: production persistence policy matrix) -->
2. Approved agent and application-data namespaces admit new nested files without filename inventories, including Pi base configuration and recovery archives; transient and managed restrictions still apply. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-002/004/011/031/032: production persistence policy matrix) -->
3. Personal npm manifests, locks and local package source, MCP recovery archives, shared IDE state and getting-started documentation remain eligible under the existing session and workspace gates. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-002/004/011/031/032: production persistence policy matrix) -->
4. A scope transition preserves newly excluded local and remote objects. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-011/045: restart scope migration keeps excluded old data while admitted deletions still propagate) --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_recovery_archive_filters) -->
5. Subsequent ordinary synchronization propagates deletions of admitted files. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-011/045: restart scope migration keeps excluded old data while admitted deletions still propagate) --> <!-- @test: scripts/ci/rclone-bisync-s3.py (test_recovery_archive_filters) -->
6. Ordinary synchronization rejects missing, invalid or incomplete required protected policy without treating authoritative bootstrap restoration as a verified baseline. <!-- @impl: entrypoint.sh::prepare_managed_resource_filter --> <!-- @impl: entrypoint.sh::compose_rclone_filters --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-003/004/031: recovery veto wins over namespace positives and invalid policy prevents baseline and ordinary sync I/O) -->
7. A scope transition uses the existing newest-side-wins baseline for admitted objects. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-STOR-011/045: restart scope migration keeps excluded old data while admitted deletions still propagate) -->

**Constraints:** Exclusion does not authorize deletion.

**Priority:** P1

**Dependencies:** [REQ-STOR-011](#req-stor-011-sync-mode-controls-workspace-scope), [REQ-STOR-031](#req-stor-031-managed-resource-container-sync)

**Verification:** Automated: [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js), [rclone-bisync-s3.py](../../scripts/ci/rclone-bisync-s3.py)

**Status:** Implemented

---
