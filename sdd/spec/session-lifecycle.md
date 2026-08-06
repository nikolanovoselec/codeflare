# Session Lifecycle

Container creation, idle detection, auto-sleep, restart, and destroy.

**Domain owner:** Backend (Worker + Container DO)

### Key Concepts

- **Session** -- A named, user-owned workspace backed by a unique KV record and a single container.
- **Container** -- A Cloudflare Durable Object instance providing an isolated runtime (PTY, filesystem, network) for one session.
- **sleepAfter** -- The configurable idle timeout after which a container is automatically stopped.
- **Durable Object** -- Cloudflare's stateful compute primitive used to host each container; provides storage, alarms, and WebSocket hibernation.

### Out of Scope

- Multi-user sessions (each session belongs to exactly one user)
- Container customization (base image, resource limits)
- Custom Docker images (all containers use the standard Codeflare image)

### Domain Dependencies

- **Storage** (R2 bucket mount) -- Sessions mount the user's R2 bucket for persistent file storage.
- **Authentication** (user identity) -- Session creation and access require a resolved user identity.
- **Subscription** (session limits) -- Concurrent session counts are enforced per subscription tier.

---

### REQ-SESSION-001: Session creation with name and agent type

**Intent:** A user can create a named session associated with a specific AI agent, producing a unique session record stored in KV.

**Applies To:** User

**Acceptance Criteria:**

1. The session creation endpoint accepts a trimmed session name and optional AI agent type (one of: claude-code, codex, antigravity, opencode, copilot, bash, pi). <!-- @impl: src/routes/session/crud.ts::CreateSessionBody --> <!-- @test: src/__tests__/routes/session-creation.test.ts (REQ-SESSION-001: Session creation with name and agent type) -->
2. A unique alphanumeric session ID (8-24 lowercase chars) is generated for each new session. <!-- @impl: src/lib/constants.ts::SESSION_ID_PATTERN --> <!-- @test: src/__tests__/routes/session-creation.test.ts (REQ-SESSION-001: Session creation with name and agent type) -->
3. The session record is persisted durably and retrievable by the user. <!-- @impl: src/lib/kv-keys.ts::putSessionWithMetadata --> <!-- @test: src/__tests__/routes/session-creation.test.ts (REQ-SESSION-001: Session creation with name and agent type) -->
4. The response returns the new session object with status 201. <!-- @impl: src/routes/session/crud.ts::app --> <!-- @test: src/__tests__/routes/session-creation.test.ts (REQ-SESSION-001 AC4: response returns session object with status 201) -->
5. Session creation is rate-limited (10/min per user). <!-- @impl: src/routes/session/crud.ts::sessionCreateRateLimiter = maxRequests: 10 --> <!-- @test: src/__tests__/routes/session-creation.test.ts (REQ-SESSION-001: Session creation with name and agent type) -->

**Constraints:**

- Session name is sanitized to prevent injection.
- Storage quota is checked before creation in SaaS mode; over-quota users receive a descriptive validation error and session creation is blocked.

**Priority:** P0

**Dependencies:** [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware) (requireActiveUser middleware)

**Verification:** Automated test ([Integration test](../../src/__tests__/routes/session-creation.test.ts))

**Status:** Implemented

---

### REQ-SESSION-002: One container per session (isolation)

**Intent:** Each session maps to exactly one Durable Object container instance, providing full process-level isolation between sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Each session maps to a deterministic, unique container address derived from the user's storage identity and the session ID. <!-- @impl: src/lib/container-helpers.ts::getContainerId --> <!-- @test: src/__tests__/lib/container-id-isolation.test.ts (REQ-SESSION-002: One container per session (isolation)) -->
2. The container address uniquely addresses a single isolated runtime; no two sessions share one. <!-- @impl: src/lib/container-helpers.ts::getContainerId --> <!-- @test: src/__tests__/lib/container-id-isolation.test.ts (REQ-SESSION-002: One container per session (isolation)) -->
3. Different sessions belonging to the same user run in separate containers with separate PTY processes. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/lib/container-id-isolation.test.ts (REQ-SESSION-002: One container per session (isolation)) -->
4. A session's container cannot access files, processes, or network state of another session's container. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/lib/container-id-isolation.test.ts (REQ-SESSION-002: One container per session (isolation)) -->

**Constraints:**

- The container address derivation must never produce collisions for distinct sessions of the same user.
- The container address is never a fallback or default; validation rejects malformed inputs before container interaction.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** Automated test ([Integration test](../../src/__tests__/lib/container-id-isolation.test.ts))

**Status:** Implemented

---

### REQ-SESSION-003: R2 bucket mounted and synced on start

**Intent:** When a container starts, the user's persistent R2 storage is mounted and bidirectionally synced so the workspace contains all previously persisted files.

**Applies To:** User

**Acceptance Criteria:**

1. The user's persistent storage bucket is provisioned if it does not exist. <!-- @impl: src/lib/r2-admin.ts::createBucketIfNotExists --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (createBucketIfNotExists) -->
2. A scoped, bucket-specific credential pair is obtained or created for the user and injected into the container environment. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-SESSION-003 AC2: scoped R2 token obtained and injected) -->
3. An initial sync from persistent storage to the workspace completes before the container accepts terminal traffic, with a configurable safety timeout. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @manual -->
4. After initial sync, changes are bidirectionally synced on a regular schedule for the container's lifetime, with support for on-demand triggers and a final sync on shutdown (see [REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)). <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
5. New buckets are seeded with getting-started docs and agent configs matching the user's session mode. <!-- @impl: src/lib/r2-seed.ts::CONTEXT_MODE_KEY_PREFIX --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-SESSION-003 AC5: new buckets seeded with getting-started docs) -->

**Constraints:**

- The master Cloudflare API token never enters the container; only per-user scoped credentials are injected.
- Scoped credentials are cached durably (optionally encrypted at rest) and verified before reuse.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](#req-session-002-one-container-per-session-isolation)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SESSION-004: Idle containers sleep after configurable timeout

**Intent:** Containers that receive no user input for a configurable duration are automatically stopped to conserve resources and reduce cost.

**Applies To:** User

**Acceptance Criteria:**

1. The idle timeout is user-configurable with allowed values: 15m, 30m, 1h, 2h, 4h. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) -->
2. Default is 30m for paying users; free-tier users are locked to 15m regardless of stored preference. <!-- @impl: src/routes/container/lifecycle-validation.ts::resolveEffectiveSleepAfter --> <!-- @test: src/__tests__/lib/enterprise-mode.test.ts (flag-off: free tier is locked to 15m regardless of stored preference) -->
3. The idle timer resets for classified terminal input and for each client-to-server Browser IDE frame; reconnections and server-to-client output do not reset it. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) -->
4. The container is stopped once the user-configured idle threshold is exceeded; the host-side per-PTY keepalive is a separate safety net floor-clamped at the maximum idle timeout (see [AD47](../../documentation/decisions/README.md#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy)). <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) -->
5. The platform-level idle timer is functionally inert; idle policy is owned by the per-container metrics layer. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @manual -->
6. Admins can always change their own idle timeout; non-subscribed users have the dropdown disabled. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/settings/SessionSection.test.tsx (REQ-SESSION-004 AC6: idle-timeout dropdown gating) -->

**Constraints:**

- The idle timeout is validated server-side against the supported value set.
- The preference survives container-orchestration resets; the storage shape is preserved for backwards compatibility with existing sessions.
- Free-tier override cannot be bypassed via API.
- Idle detection MUST NOT rely on the platform's built-in inactivity timer.

**Priority:** P0

**Dependencies:** [REQ-SESSION-005](#req-session-005-input-based-idle-detection)

**Verification:** Automated test ([container-metrics](../../src/__tests__/container-metrics.test.ts))

**Status:** Implemented

---

### REQ-SESSION-005: Input-based idle detection

**Intent:** Idle detection uses classified terminal input and client-to-server Browser IDE frames, not connection presence or server output.

**Applies To:** User

**Acceptance Criteria:**

1. The host tracks one last-input timestamp shared by terminal input and client-to-server Browser IDE frames. <!-- @impl: host/src/activity-tracker.ts::createActivityTracker --> <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-004: advances the idle policy lastInputAt for every client-to-server frame) -->
2. User-input classification uses a whitelist: printable characters, control keys, arrow keys, function keys, Alt+key, and mouse clicks count as input. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-contains-user-input.test.js (containsUserInput) -->
3. Terminal protocol responses (cursor-position reports, OSC color queries, mouse movement, device-attribute reports) do not count as input. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-contains-user-input.test.js (containsUserInput) -->
4. Terminal-emulator response sequences are stripped before being written to the PTY so the agent never sees them. <!-- @impl: host/src/session.ts::Session --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) -->
5. Idle detection reads the authoritative host timestamp, which advances only for classified terminal input or client-to-server Browser IDE frames; background process and server-to-client output cannot reset it. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @manual -->

**Constraints:**

- If no input is ever received, idle time is measured from container start.
- A container with an open terminal but no typing stops after the configured idle timeout has elapsed from start.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SESSION-006: User can stop, restart, and delete sessions

**Intent:** Users have explicit control over session lifecycle: stop a running session, restart a stopped session, or permanently delete a session.

**Applies To:** User

**Acceptance Criteria:**

1. Stopping a session marks the session record as stopped and tears down the container. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/routes/session-lifecycle.test.ts (POST /:id/stop) -->
2. Stopping clears all session-side identifiers before initiating teardown to prevent background writebacks from resurrecting the session, then performs a graceful shutdown so the final sync runs before the container is terminated. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
3. If the graceful shutdown does not exit within the deadline, the platform forces termination so the user-initiated stop always returns. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
4. Restarting a session reconnects to the same workspace and applies any updated preferences without recreating the container. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/container/index.test.ts (setBucketName updates USER_TIMEZONE on restart (bucket already set, prefs change path)) -->
5. Deleting a session runs the same graceful shutdown as Stop (so the final sync runs), then removes the session record permanently. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/routes/session-stop-delete.test.ts (REQ-SESSION-006 AC5: delete calls container.destroy then removes KV record) -->
6. Frontend status transitions are user-visible: stopped to initializing to running on start; running to stopping to stopped on stop. <!-- @impl: web-ui/src/stores/session.ts::updateSessionStatus --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (should set status to stopping immediately then stopped after polling) -->

**Constraints:**

- Clearing session-side identifiers before teardown is critical to prevent asynchronous writebacks from re-creating a stale session record.
- The shutdown sync runs against credentials baked into the container at start, independent of the session-side identifier cleanup.
- The final shutdown sync is bounded so a deletion storm cannot wipe persistent storage.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type), [REQ-SESSION-002](#req-session-002-one-container-per-session-isolation)

**Verification:** Automated test ([Integration test](../../src/__tests__/routes/session-stop-delete.test.ts))

**Status:** Implemented

---

### REQ-SESSION-007: Running session count limited per tier

**Intent:** The number of concurrently running sessions is capped per subscription tier to enforce fair usage and plan differentiation.

**Applies To:** User

**Acceptance Criteria:**

1. Before starting a container, running sessions are counted from storage metadata with a single list operation (no per-session reads). <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (Container lifecycle extracted helpers / REQ-SESSION-007 (validateSessionAndCheckLimits enforces per-tier MAX_SESSIONS at session start) / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN)) -->
2. If the running count (excluding the session being started) meets or exceeds the tier's concurrent-session cap, the start is rejected with a quota-exceeded error. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (Container lifecycle extracted helpers / REQ-SESSION-007 (validateSessionAndCheckLimits enforces per-tier MAX_SESSIONS at session start) / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN)) -->
3. Default tier limits: free=1, trial=2, standard=1, advanced=2, max=3, unlimited=5, blocked=0, pending=0. <!-- @impl: src/lib/subscription.ts::getUserTier --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (Container lifecycle extracted helpers / REQ-SESSION-007 (validateSessionAndCheckLimits enforces per-tier MAX_SESSIONS at session start) / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN)) -->
4. Outside SaaS mode, role-based defaults apply (regular users default 3, admins default 10), configurable per deployment. <!-- @impl: src/lib/constants.ts::getMaxSessions --> <!-- @manual -->
5. Stress-test deployment mode bypasses session and quota limits. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (Container lifecycle extracted helpers / REQ-SESSION-007 (validateSessionAndCheckLimits enforces per-tier MAX_SESSIONS at session start) / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN)) -->

**Constraints:**

- Tier limits are configurable per deployment via the admin Subscription Management panel.
- The session-cap lookup respects an explicit zero value (a zero cap blocks all starts, not a fallthrough to default).

**Priority:** P1

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** Automated test ([container-lifecycle-helpers](../../src/__tests__/routes/container-lifecycle-helpers.test.ts))

**Status:** Implemented

---

### REQ-SESSION-008: Container restart preserves R2 bucket

**Intent:** Restarting a session reconnects to the same R2 bucket, preserving all user files without data loss.

**Applies To:** User

**Acceptance Criteria:**

1. Restarting a session on the same workspace preserves the bucket association and applies any stored preference updates. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/preferences.test.ts (fastStartEnabled preference / REQ-SESSION-008 (fast-start preference persists across restart)) -->
2. The idle-metric polling schedule is re-armed and the container start timestamp is recorded on each start. <!-- @impl: src/container/index.ts::onStart --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
3. Updated credentials and preferences take effect on restart without requiring container recreation. <!-- @impl: src/container/index.ts::onStart --> <!-- @test: src/__tests__/routes/container-restart-prefs.test.ts (REQ-SESSION-008: Container restart preserves R2 bucket) -->
4. The container entrypoint runs an initial sync that restores the workspace from persistent storage on restart. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: src/__tests__/routes/container-restart-prefs.test.ts (REQ-SESSION-008: Container restart preserves R2 bucket) -->
5. User preference changes (idle timeout, fast-start, session mode) take effect on restart without requiring container recreation. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/container-restart-prefs.test.ts (REQ-SESSION-008: Container restart preserves R2 bucket) -->

**Constraints:**

- A restart against a different storage identity triggers a full teardown and rebind cycle.

**Priority:** P0

**Dependencies:** [REQ-SESSION-003](#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** Automated test ([Integration test](../../src/__tests__/routes/container-restart-prefs.test.ts))

**Status:** Implemented

---

### REQ-SESSION-009: Container destroy wipes session state

**Intent:** Destroying a container clears all transient session state from the Durable Object, leaving only the persistent KV record and R2 bucket.

**Applies To:** User

**Acceptance Criteria:**

1. Destroying a session clears all transient session state from the Durable Object; subsequent fetch attempts return 503. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
2. Session mode resets to default on destroy. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (destroy) -->
3. Scheduled idle-metric polling is cancelled on destroy. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (onStop logs shutdownElapsedMs reflecting real elapsed time between destroy and onStop) -->
4. After destroy, any delayed polling that fires detects the missing session state and exits without re-arming. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
5. The user's persistent storage bucket and its contents are NOT deleted by destroy; files persist across sessions. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Constraints:**

- Durable Object storage and in-memory state must be cleared before the platform teardown call to prevent asynchronous writebacks from re-creating a stale record.

**Priority:** P0

**Dependencies:** [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** Automated test ([index](../../src/__tests__/container/index.test.ts))

**Status:** Implemented

---

### REQ-SESSION-010: Session status observable from dashboard

**Intent:** The dashboard displays the current status of each session (running, stopped, initializing, stopping, error) with near-real-time updates.

**Applies To:** User

**Acceptance Criteria:**

1. The batch-status endpoint returns status for all user sessions in a single storage-metadata list call (no container wake, no per-session reads). <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-SESSION-010 AC1: batch-status uses KV list metadata, no DO contact) -->
2. Persistent storage holds two statuses (running and stopped); the frontend adds ephemeral states (initializing, stopping, error) that are never persisted. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-SESSION-010 AC2: only running/stopped persisted to KV) -->
3. The frontend polls batch-status on a fixed cadence (about every 5 seconds). <!-- @impl: web-ui/src/stores/session-polling.ts::startSessionListPolling --> <!-- @manual -->
4. Dashboard session cards display a three-color status dot: green (running + WebSocket connected), yellow (running + WebSocket disconnected), gray (stopped). <!-- @impl: web-ui/src/components/SessionStatCard.tsx::SessionStatCard --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (SessionStatCard) -->
5. Container metrics (CPU, memory, disk, sync status) are surfaced on the session cards with up to ~60s staleness. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-SESSION-010 AC5: metrics included in list metadata) -->
6. Last-active and last-started timestamps are available for sleep-timer countdown display. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-SESSION-010 AC6: lastActiveAt and lastStartedAt in batch-status response) -->
7. When polling transitions a session to stopped, its terminal connections are disposed; the currently active session is exempt from the poll-driven dispose only within the active-session guard window, not unconditionally. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (calls disposeSession when session transitions from running to stopped) -->

**Constraints:**

- Storage eventual consistency causes ~60s propagation delay for newly created sessions.
- Dashboard status is a pure storage read; no container is contacted, preserving container hibernation.

**Priority:** P1

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SESSION-011: Graceful shutdown with final sync

**Intent:** When a container is stopped for any reason (user stop, user delete, idle timeout, quota eviction), its workspace is fully synced to R2 before the container process is terminated, so no data is lost. The platform's grace period between SIGTERM and SIGKILL is far shorter than a bidirectional sync can take, so the final sync is performed as an *awaited live bisync while the container is still running* - the Durable Object triggers it and blocks on its completion before stopping the container - rather than relying on the SIGTERM trap, which is retained only as a best-effort backstop.

**Applies To:** User

**Acceptance Criteria:**

1. Before signalling the container to stop, every deliberate stop path runs a live bidirectional R2 sync to completion while the container is still fully running including a delete where the platform reports `running:false` transiently. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-lifecycle.ts::drainFinalSyncAudited --> <!-- @impl: src/container/container-lifecycle.ts::recordFinalSyncAudit --> <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
2. The container exposes an awaitable final-sync endpoint that triggers a fresh bisync and responds only once that bisync has completed (success or failure) or an internal timeout elapses, distinguishing completion from failure and timeout. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (REQ-SESSION-011 AC2: final-sync endpoint wiring (structural)) -->
3. The sync-status record carries a monotonic timestamp and a `syncing`->`success`/`failed` transition, and the endpoint accepts a terminal status only after observing its own run's `syncing` (stamped strictly after the trigger), never a bare `success`. <!-- @impl: host/src/final-sync.ts::FinalSyncEval --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (REQ-SESSION-011 AC2/AC3: evaluateFinalSync completion detection (behavioral)) -->
4. The Durable Object waits up to a bounded sync budget (120s) for the live sync to report completion; a failed or timed-out sync still proceeds to stop rather than blocking teardown. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (destroy) -->
5. Total teardown is hard-capped: the container is force-terminated no later than 135s after teardown begins regardless of sync state, so a hung sync cannot wedge the session. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
6. User stop and user delete behave identically: both route through the same graceful-destroy path, and idle-timeout and quota-eviction paths drain through the same endpoint before stopping. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-011 AC6: quota-stop drains the final sync BEFORE stop (same order as idle-stop)) -->
7. The SIGTERM trap is retained as a best-effort backstop final sync for paths that bypass the orchestrated drain, but is no longer the primary guarantee (see [REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync) for the trap's own constraints). <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) -->

**Constraints:**

- The platform's post-SIGTERM kill grace is never relied on for sync completion; the authoritative sync runs while the container is alive and the DO holds teardown open awaiting it.
- The container's final-sync endpoint internal timeout MUST exceed the DO's drain budget (120s), so the DO's `AbortSignal` not the endpoint is the authoritative ceiling.
- A failed or timed-out drain proceeds to stop (135s hard force-kill ceiling).
- Completion detection accepts a terminal status only after observing the triggered run's `syncing` stamped strictly after the trigger, so an in-flight or same-millisecond stamp is.
- The container image still declares a trappable stop signal so the backstop trap stays reachable.

**Priority:** P0

**Dependencies:** [REQ-SESSION-003](#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** Automated test ([Drain-before-stop ordering + best-effort](../../src/__tests__/container/index.test.ts), [drainFinalSync + idle-stop drain](../../src/__tests__/container-metrics.test.ts), [awaitable endpoint + completion signal](../../host/__tests__/final-sync-endpoint.test.js))

**Status:** Implemented

---

### REQ-SESSION-012: Wake-loop prevention

**Intent:** A browser's automatic WebSocket reconnect must not wake a hibernated container in an infinite stop/start cycle.

**Applies To:** User

**Acceptance Criteria:**

1. When the container is not running, all non-internal requests receive 503 without waking the container. <!-- @impl: src/container/index.ts::fetch --> <!-- @test: src/__tests__/container/index.test.ts (fetch gate — 503 when container not running / REQ-SESSION-009 (DO fetch gates on container.running, returns 503 for non-internal routes) / REQ-SESSION-012 (wake-loop prevention: 503 on HTTP + 4503 close code on WS prevent client reconnect storms from waking hibernated containers)) -->
2. WebSocket upgrade requests are rejected when the session is stopped (defense-in-depth). <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (returns WebSocket upgrade with 4503 close for stopped session) -->
3. The frontend detects running-to-stopped transitions and kills all WebSocket retry loops. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (calls disposeSession when session transitions from running to stopped) -->
4. The server signals "container stopped" via a stable WebSocket close code. <!-- @impl: src/container/index.ts::fetch --> <!-- @test: src/__tests__/container/index.test.ts (fetch gate — 503 when container not running / REQ-SESSION-009 (DO fetch gates on container.running, returns 503 for non-internal routes) / REQ-SESSION-012 (wake-loop prevention: 503 on HTTP + 4503 close code on WS prevent client reconnect storms from waking hibernated containers)) -->
5. The client treats the container-stopped close code as authoritative and does not retry; other close codes trigger automatic reconnection. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (CF-015: Stopped session returns 4503 close code / REQ-SEC-020 AC1 (4503 short-circuit BEFORE WS rate-limit check)) -->

**Constraints:**

- Fresh terminal connections are only opened when the user explicitly starts the session again.
- An anti-flapping guard prevents stale running status from auto-initializing terminals for non-active sessions.

**Priority:** P1

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout), [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** Automated test ([session](../../web-ui/src/__tests__/stores/session.test.ts))

**Status:** Implemented

---

### REQ-SESSION-013: Sleep timer countdown UI

**Intent:** Users see how much idle time remains before their session hibernates.

**Applies To:** User

**Acceptance Criteria:**

1. Clock icon on session cards and header toolbar shows countdown. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (Sleep timer icon) -->
2. Visible when < 10 min remaining. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (shows warning timer when remaining < 10 min) -->
3. The countdown uses the warning treatment below 10 minutes remaining. <!-- @impl: web-ui/src/lib/sleep-timer.ts::getSleepTimerInfo --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (shows warning timer when remaining < 10 min) -->
4. The countdown uses the critical treatment below 5 minutes remaining. <!-- @impl: web-ui/src/lib/sleep-timer.ts::getSleepTimerInfo --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (shows critical timer when remaining < 5 min) -->
5. The countdown is hidden for stopped sessions. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (hides timer for stopped sessions) -->
6. The countdown is computed from the configured idle timeout minus elapsed idle time. <!-- @impl: web-ui/src/lib/sleep-timer.ts::getSleepTimerInfo --> <!-- @test: web-ui/src/__tests__/lib/sleep-timer.test.ts (getSleepTimerInfo / REQ-SESSION-013 (sleep timer countdown UI)) -->

**Notes:** Sleep timer countdown UI is validated manually per the checklist in [documentation/lanes/troubleshooting.md](../../documentation/lanes/troubleshooting.md).

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** Automated test ([sleep-timer](../../web-ui/src/__tests__/lib/sleep-timer.test.ts))

**Status:** Implemented

---

### REQ-SESSION-014: User-configurable auto-sleep timeout in Settings

**Intent:** Users choose how long their sessions stay alive when idle.

**Applies To:** User

**Acceptance Criteria:**

1. Settings dropdown with 5 options (15m, 30m, 1h, 2h, 4h). <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014: User-configurable auto-sleep timeout in Settings) -->
2. Free tier locked to 15m with upgrade hint. <!-- @impl: src/routes/container/lifecycle.ts::resolveEffectiveSleepAfter --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014 AC2: free tier locked to 15m idle timeout) -->
3. Admins and paying users can change. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014 AC3: admins and paying users can change sleepAfter) -->
4. Value saved to KV preferences and applied on next session start. <!-- @impl: src/routes/container/lifecycle.ts::resolveEffectiveSleepAfter --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014: User-configurable auto-sleep timeout in Settings) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** Automated test ([Integration test](../../src/__tests__/routes/session-sleep-timeout.test.ts))

**Status:** Implemented

---

### REQ-SESSION-015: Container Port-Readiness Gating with Pre-Warm Pre-Condition

**Intent:** A new container must bind its serving port quickly so Cloudflare's port-wait check succeeds, yet must refuse real terminal traffic until initial state restore and pre-warm are complete; the readiness gate sits between the port bind and the first accepted WebSocket upgrade.

**Applies To:** User

**Acceptance Criteria:**

1. The serving port binds within Cloudflare's container port-wait window even while initialization (R2 sync, MCP config merges) is still in progress. <!-- @impl: entrypoint.sh::TERMINAL_PID --> <!-- @manual: On a deployed cold start with delayed R2 initialization, confirm the serving port accepts health probes within the platform wait window. -->
2. The entrypoint writes an init-complete signal only after initial sync, file modifications, and tab-autostart configuration have completed. <!-- @test: host/__tests__/entrypoint-pi-warmup-guard.test.js (guarded warm-up calls from entrypoint.sh still reach the init-flag write when they fail) --> <!-- @manual -->
3. Tab-1 PTY pre-warm is gated on the init-complete signal, so it never starts before initial state restore is in place. <!-- @impl: host/src/server.ts::waitForInitFlag --> <!-- @manual: On a deployed cold start, hold back the init-complete signal and confirm tab 1 is not created until the signal appears. -->
4. The host terminal server rejects terminal WebSocket upgrades with a retriable ("try again later") close code and a human-readable container-warming reason until both the init-complete signal is observed and the pre-warm session is registered. <!-- @impl: host/src/server.ts::initFlagObserved --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (container-warming-up gate (PR #365) / REQ-SEC-020 AC2 (1013 close BEFORE WS rate-limit when terminalServiceReady=false; /health probe error falls through)) -->
5. The image bakes a pre-transpiled cache for the full Pi extension set, with package extensions derived from the preseed manifest. <!-- @impl: Dockerfile::PI_WARM_PACKAGES --> <!-- @manual -->
6. The image build fails if the transpile cache is empty or a required package extension is absent. <!-- @impl: Dockerfile::goal_hit --> <!-- @manual -->

**Constraints:**

- The container must not signal readiness (PTY pre-warm complete) until the initial sync either succeeds or times out.
- Best-effort setup steps that run before the init-complete flag (agent npm warm-up, fast-start suppression) must be guarded so their failure cannot abort the entrypoint under `set -euo pipefail`; a degraded warm-up is preferable to PID 1 dying before the flag is written.

**Priority:** P0

**Dependencies:** [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SESSION-016: User timezone propagated from preferences to container env

**Intent:** The capture pipeline and any other consumer of `$USER_TIMEZONE` inside the container must receive the user's IANA timezone choice without manual env-var configuration; the preference is set via the preferences API and persists across restarts.

**Applies To:** User

**Acceptance Criteria:**

1. The preferences endpoint accepts an optional user-timezone field (valid IANA timezone string, max 64 characters); invalid zones are rejected with a validation error. <!-- @impl: src/routes/preferences.ts::isValidIanaTz --> <!-- @test: src/__tests__/routes/preferences.test.ts (Preferences Routes) -->
2. The session persistently stores the user's timezone preference. <!-- @test: src/__tests__/routes/preferences.test.ts (Preferences Routes) --> <!-- @manual -->
3. Subsequent container starts inject the user's timezone preference into the container environment; if unset, the entrypoint falls back to the container default and finally to UTC. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
4. A timezone change takes effect on the next session start (no live re-injection into a running container). <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
5. On Dashboard mount, the frontend reads the browser's IANA timezone and updates the stored preference (best-effort) when the resolved zone differs; a failed update never blocks the mount. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/lib/timezone-sync.test.ts (syncBrowserTimezone (REQ-SESSION-016 AC5)) -->

**Constraints:**

- Validation uses a runtime IANA-zone round-trip.
- The field is optional; absence is silently treated as "use the entrypoint fallback chain", not an error.

**Priority:** P1

**Dependencies:** [REQ-SESSION-014](#req-session-014-user-configurable-auto-sleep-timeout-in-settings) (preferences flow)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SESSION-017: Container health and startup-status API

**Intent:** The dashboard needs a non-blocking way to learn whether a user's container is up and, while it is coming up, how far through initialization it has progressed, so the loading experience reflects real container state instead of a fixed timer.

**Applies To:** User

**Acceptance Criteria:**

1. `GET /api/container/health` reports whether the user's container is running and healthy, returning its metrics on success and an error with 500 when the health check fails. <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (Container Status Routes) -->
2. `GET /api/container/startup-status` returns the current initialization stage without blocking, carrying a stage label, a 0-to-100 progress value, and a human-readable message. <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (GET /container/startup-status) -->
3. The reported stage reflects real container state: `stopped` when state is indeterminate, `starting` before services respond, `syncing` during the initial R2 sync, `verifying` after sync while terminals are not yet up, `mounting` during terminal pre-warm, and `ready` when all services are up. <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (GET /container/startup-status) -->
4. A failed initial R2 sync surfaces as an error stage carrying the sync error, while a skipped sync (no R2 credentials) still reaches the ready stage with the skip reason reported. <!-- @impl: src/routes/container/status.ts::buildSyncFailedResponse --> <!-- @test: src/__tests__/routes/container-status.test.ts (GET /container/startup-status) -->
5. An unexpected failure while computing startup status is caught and returned as an error stage rather than propagating an unhandled 500. <!-- @test: src/__tests__/routes/container-status.test.ts (GET /container/startup-status) --> <!-- @manual -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-SESSION-015](#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition)

**Verification:** Automated test ([container-status](../../src/__tests__/routes/container-status.test.ts))

**Status:** Implemented

---

### REQ-SESSION-018: Persisted status is authoritative on container exit

**Intent:** Session status in KV is the single source of truth. A container that exits for any reason writes `stopped` to its KV record, so the dashboard ([REQ-SESSION-010](#req-session-010-session-status-observable-from-dashboard)) reflects reality directly from the record without any read-side staleness guess. Conversely, a container that is demonstrably alive is never left showing stopped: the not-running signal is treated as authoritative only after it is confirmed, and a status that was wrongly flipped to stopped is self-healed back to running.

**Applies To:** User

**Acceptance Criteria:**

1. A container that exits for any reason (graceful stop, crash, or an SDK-surfaced error) transitions its KV status to stopped, and the dashboard reads status directly from the record with no read-side staleness reconciliation. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/index.ts::onError --> <!-- @test: src/__tests__/container-metrics.test.ts (writes status=stopped to KV only after the not-running confirmation window (catch-all)) -->
2. Stopped is written only after the container reads not-running across a confirmation window spanning more than one alarm tick, so a single transient not-running reading never flips a live session to stopped. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (does not flip a live session to stopped on a single transient not-running tick) -->
3. On a not-running reading from the error path, stopped is not written; the same confirmation window opens and re-arms a metrics tick, deferring the stopped decision to that window. <!-- @impl: src/container/container-lifecycle.ts::onError --> <!-- @impl: src/container/container-metrics.ts::openNotRunningConfirmation --> <!-- @test: src/__tests__/container/lifecycle.test.ts (onError opens the not-running confirmation window and re-arms instead of writing stopped) -->
4. When the container is demonstrably running (running branch after a successful `/health` probe) but KV reads stopped, running is re-asserted, unless a persisted shutdown-requested marker shows a deliberate stop is in flight. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) -->

**Constraints:**

- The not-running confirmation window and the deliberate-stop marker are persisted in DO storage (not in-memory), so a hibernation or mid-shutdown eviction cannot discard them; `destroy()` sets the marker before clearing identifiers and `onStart` clears it.
- Newly started sessions have a 3-minute startup guard during which only the container-stopped close code can transition them to stopped (anti-flapping).
- A genuine crash converges to stopped after the confirmation window (one to a few alarm ticks).
- Accepted residual: a tick landing in the sub-millisecond gap between the user-stop KV write and `destroy()` persisting the marker can self-heal the just-stopped session for a single tick before `destroy()` settles it back to stopped; the idle-stop path is immune.

**Priority:** P1

**Dependencies:** [REQ-SESSION-010](#req-session-010-session-status-observable-from-dashboard)

**Verification:** Automated test ([collectMetrics catch-all](../../src/__tests__/container-metrics.test.ts), [onError / onStop lifecycle](../../src/__tests__/container/lifecycle.test.ts))

**Status:** Implemented

---

### REQ-SESSION-019: Final-sync drain endpoint authentication

**Intent:** Every Durable-Object-side final-sync request must authenticate with the container token so teardown cannot lose the user's last edits at the host authorization boundary.

**Applies To:** User

**Acceptance Criteria:**

1. Every Durable-Object-side drain request to the final-sync endpoint authenticates with the container auth token, including requests that bypass the public proxy path. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-lifecycle.ts::drainFinalSyncAudited --> <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Constraints:** None.

**Priority:** P0

**Dependencies:** [REQ-SESSION-011](#req-session-011-graceful-shutdown-with-final-sync)

**Verification:** Automated test ([Drain auth on the delete path](../../src/__tests__/container/index.test.ts), [idle/quota-stop drain auth](../../src/__tests__/container/container-metrics-drain.test.ts))

**Status:** Implemented

---

### REQ-SESSION-020: The metrics alarm outlives a container that stops answering

**Intent:** The metrics alarm is the only detector of a container that has stopped serving, so it must not be killable by that same condition. Its re-arm is the last statement of the tick and the schedule is one-shot, which means a poll that never returns takes the loop with it, and no other path restores it: a start hook only runs on a fresh container start, and an error hook only fires when the platform monitor sees the container exit, neither of which happens to a container that is wedged but still reported running.

**Applies To:** User

**Acceptance Criteria:**

1. Every request the metrics alarm awaits on an external party is bounded, so a peer that accepts the connection and never answers ends that request rather than the tick. <!-- @impl: src/container/container-metrics.ts::pollContainer --> <!-- @impl: src/container/container-metrics.ts::raceBudget --> <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-020 AC1-AC2: re-arms the alarm when an in-container poll never answers) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-020 AC1: re-arms the alarm when the Timekeeper ping never answers) -->
2. A single poll failure leaves the alarm armed, so idle detection and health reporting continue on the next tick. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-020 AC1-AC2: re-arms the alarm when an in-container poll never answers) -->
3. Teardown records the session stopped while the identifiers that write requires are still in hand, so a teardown that does not run to completion still leaves the session recorded as stopped rather than running. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (records the session stopped BEFORE clearing the identifiers that write needs) -->
4. The deliberate-stop marker is durable before that write, so a concurrent metrics tick reading a stopped record with no marker present cannot mistake it for a false stop and re-assert running. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container/index.test.ts (records the session stopped BEFORE clearing the identifiers that write needs) -->
5. A restart path that tears the container down goes on to start it, so the marker that teardown persisted is always cleared by a fresh start rather than left to hold the session stopped. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/container/lifecycle.test.ts (REQ-SESSION-020 AC5-AC6: starts the container and re-asserts running when the bucket forward fails after destroy) -->
6. A restart path that tears the container down records the session running again, so the authoritative stopped gate does not end the client's reconnects while the container is coming back up. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/container/lifecycle.test.ts (REQ-SESSION-020 AC5-AC6: starts the container and re-asserts running when the bucket forward fails after destroy) -->

**Constraints:** Bounds apply to awaited polls; confirmed lifecycle exits must still end the alarm loop.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-persisted-status-is-authoritative-on-container-exit)

**Verification:** Automated test ([metrics alarm survives an unanswered poll](../../src/__tests__/container-metrics.test.ts))

**Status:** Implemented

---

### REQ-SESSION-021: Unreachable container transport initiates coordinator reconstruction

**Intent:** Unreachable transport to a running container must initiate recovery without stopping the workload, changing its authoritative session status, or overcounting usage during accelerated confirmation.

**Applies To:** User

**Acceptance Criteria:**

1. A running session whose transport remains unreachable across the confirmation window initiates coordinator reconstruction. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-021 AC1-AC3: resets the Durable Object after three consecutive ticks while preserving the workload and running status) -->
2. Coordinator reconstruction does not stop the running workload. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-021 AC1-AC3: resets the Durable Object after three consecutive ticks while preserving the workload and running status) -->
3. Coordinator reconstruction does not record the session stopped. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-021 AC1-AC3: resets the Durable Object after three consecutive ticks while preserving the workload and running status) -->
4. A fresh container lifecycle clears transport-recovery evidence left by the prior lifecycle. <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-021 AC4: clears a prior lifecycle transport-failure streak on a fresh container start) -->
5. A response from either host route clears pending transport recovery, regardless of response status. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-021 AC5: any responding probe clears the reconstruction failure streak) -->
6. Accelerated transport-confirmation retries do not add billable usage. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-021 AC6-AC7: confirmation retries do not add billable usage or ping Timekeeper) -->
7. Accelerated transport-confirmation retries do not contact the quota service. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-021 AC6-AC7: confirmation retries do not add billable usage or ping Timekeeper) -->

**Constraints:** Recovery must neither signal nor destroy the workload and must remain suppressed, together with alarm re-arming, during deliberate teardown.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-persisted-status-is-authoritative-on-container-exit), [REQ-SESSION-020](#req-session-020-the-metrics-alarm-outlives-a-container-that-stops-answering)

**Verification:** Automated test ([transport reconstruction preserves the workload and usage cadence](../../src/__tests__/container-metrics.test.ts)); successful SDK reattachment remains a deployed smoke check outside AC1

**Status:** Implemented

---

### REQ-SESSION-022: Transport recovery is durable, observable, and bounded

**Intent:** Coordinator reconstruction must leave durable evidence, confirm recovery from a real host response, and stop resetting when reconstruction cannot restore transport.

**Applies To:** User

**Acceptance Criteria:**

1. Recovery evidence survives coordinator reconstruction until a host response confirms recovery or the container lifecycle ends. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-021 AC1-AC3: resets the Durable Object after three consecutive ticks while preserving the workload and running status) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-021 AC4 + REQ-SESSION-022 AC1: clears prior transport recovery state on a fresh container start) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-022 AC1: clears transport recovery independently when later teardown cleanup fails) -->
2. A responding post-reconstruction host route clears recovery evidence and restores the normal metrics cadence. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-022 AC1-AC2: confirms recovery only after a post-reset probe responds and keeps metrics armed) -->
3. One transport incident initiates at most two coordinator reconstructions. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-022 AC3-AC4: bounds a persistently unreachable host to two reconstructions and keeps slow checks armed) -->
4. Exhausted recovery retains 60-second checks and normal usage accounting without another reset. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-022 AC3-AC4: bounds a persistently unreachable host to two reconstructions and keeps slow checks armed) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-022 AC4: exhausted watchdog ticks resume SaaS usage accounting before and after transport responds) -->
5. Unreadable deliberate-stop ownership suppresses reconstruction and alarm re-arming. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-022 AC5: suppresses reconstruction and re-arming when deliberate-stop ownership cannot be read) -->
6. Recovery logs correlate DO and attempt identities, counts, elapsed time, container state, and classified per-route observations. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-021 AC1-AC3: resets the Durable Object after three consecutive ticks while preserving the workload and running status) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-022 AC1-AC2: confirms recovery only after a post-reset probe responds and keeps metrics armed) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-022 AC3-AC4: bounds a persistently unreachable host to two reconstructions and keeps slow checks armed) -->
7. Malformed recovery state cannot authorize coordinator reconstruction. <!-- @impl: src/container/container-metrics.ts::isTransportRecoveryRecord --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-022 AC7: malformed recovery state cannot authorize reconstruction) -->

**Constraints:** Recovery hardening must not stop the workload or change authoritative session status.

**Priority:** P0

**Dependencies:** [REQ-SESSION-021](#req-session-021-unreachable-container-transport-initiates-coordinator-reconstruction)

**Verification:** Automated test ([bounded and correlated transport recovery](../../src/__tests__/container-metrics.test.ts))

**Status:** Implemented

---
