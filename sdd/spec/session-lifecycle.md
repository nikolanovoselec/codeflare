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

1. The session creation endpoint accepts a trimmed session name and optional AI agent type (one of: claude-code, codex, antigravity, opencode, copilot, bash, pi). <!-- @impl: src/routes/session/crud.ts::CreateSessionBody --> <!-- @test: src/__tests__/routes/session-creation.test.ts (name+agentType accept all 7 types + sanitize + Terminal default) -->
2. A unique alphanumeric session ID (8-24 lowercase chars) is generated for each new session. <!-- @impl: src/lib/constants.ts::SESSION_ID_PATTERN --> <!-- @test: src/__tests__/routes/session-creation.test.ts (SESSION_ID_PATTERN) -->
3. The session record is persisted durably and retrievable by the user. <!-- @impl: src/lib/kv-keys.ts::putSessionWithMetadata --> <!-- @test: src/__tests__/routes/session-creation.test.ts (KV write) -->
4. The response returns the new session object with status 201. <!-- @impl: src/routes/session/crud.ts --> <!-- @test: src/__tests__/routes/session-creation.test.ts (201 response) -->
5. Session creation is rate-limited (10/min per user). <!-- @impl: src/routes/session/crud.ts::sessionCreateRateLimiter = 10/60_000ms --> <!-- @test: src/__tests__/routes/session-creation.test.ts (429 rate limit + 10/60_000 config) -->

**Constraints:**

- Session name is sanitized to prevent injection.
- Storage quota is checked before creation in SaaS mode; over-quota users receive a descriptive validation error and session creation is blocked.

**Priority:** P0

**Dependencies:** [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware) (requireActiveUser middleware)

**Verification:** [Integration test](../../src/__tests__/routes/session-creation.test.ts)

**Status:** Implemented

---

### REQ-SESSION-002: One container per session (isolation)

**Intent:** Each session maps to exactly one Durable Object container instance, providing full process-level isolation between sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Each session maps to a deterministic, unique container address derived from the user's storage identity and the session ID. <!-- @impl: src/lib/container-helpers.ts::getContainerId --> <!-- @test: src/__tests__/lib/container-id-isolation.test.ts (getContainerId deterministic + distinct per session) -->
2. The container address uniquely addresses a single isolated runtime; no two sessions share one. <!-- @impl: src/lib/container-helpers.ts::getContainerId --> <!-- @test: src/__tests__/lib/container-id-isolation.test.ts (distinct per session + SESSION_ID_PATTERN boundaries) -->
3. Different sessions belonging to the same user run in separate containers with separate PTY processes. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/lib/container-id-isolation.test.ts (same-user distinct) -->
4. A session's container cannot access files, processes, or network state of another session's container. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/lib/container-id-isolation.test.ts (REQ-SESSION-002: One container per session (isolation)) -->

**Constraints:**

- The container address derivation must never produce collisions for distinct sessions of the same user.
- The container address is never a fallback or default; validation rejects malformed inputs before container interaction.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** [Integration test](../../src/__tests__/lib/container-id-isolation.test.ts)

**Status:** Implemented

---

### REQ-SESSION-003: R2 bucket mounted and synced on start

**Intent:** When a container starts, the user's persistent R2 storage is mounted and bidirectionally synced so the workspace contains all previously persisted files.

**Applies To:** User

**Acceptance Criteria:**

1. The user's persistent storage bucket is provisioned if it does not exist. <!-- @impl: src/lib/r2-admin.ts::createBucketIfNotExists --> <!-- @impl: src/container/index.ts --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (createBucketIfNotExists called) --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (createBucketIfNotExists) -->
2. A scoped, bucket-specific credential pair is obtained or created for the user and injected into the container environment. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (scoped R2 token injected into setBucketName body) --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (createScopedR2Token) -->
3. An initial sync from persistent storage to the workspace completes before the container accepts terminal traffic, with a configurable safety timeout. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (initial rclone sync from R2) -->
4. After initial sync, changes are bidirectionally synced on a regular schedule for the container's lifetime, with support for on-demand triggers and a final sync on shutdown (see [REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)). <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync cadence + SIGUSR1 + final shutdown sync) -->
5. New buckets are seeded with getting-started docs and agent configs matching the user's session mode. <!-- @impl: src/lib/r2-seed.ts --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (seedGettingStartedDocs on new bucket) -->

**Constraints:**

- The master Cloudflare API token never enters the container; only per-user scoped credentials are injected.
- Scoped credentials are cached durably (optionally encrypted at rest) and verified before reuse.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](#req-session-002-one-container-per-session-isolation)

**Verification:** [Integration test](../../src/__tests__/routes/container-r2-start.test.ts)

**Status:** Implemented

---

### REQ-SESSION-004: Idle containers sleep after configurable timeout

**Intent:** Containers that receive no user input for a configurable duration are automatically stopped to conserve resources and reduce cost.

**Applies To:** User

**Acceptance Criteria:**

1. The idle timeout is user-configurable with allowed values: 5m, 15m, 30m, 1h, 2h. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/index.ts --> <!-- @test: src/__tests__/container-metrics.test.ts (sleepAfter enforcement + 24h sentinel) -->
2. Default is 30m for paying users; free-tier users are locked to 15m regardless of stored preference. <!-- @impl: src/routes/container/lifecycle-validation.ts::resolveEffectiveSleepAfter --> <!-- @test: src/__tests__/container-metrics.test.ts (free-tier lock) -->
3. The idle timer resets only when new user input is detected (not on heartbeats, reconnections, or protocol chatter). <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (sleepAfter enforcement) -->
4. The container is stopped once the user-configured idle threshold is exceeded; the host-side per-PTY keepalive is a separate safety net floor-clamped at the maximum idle timeout (see [AD47](../../documentation/decisions/README.md#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy)). <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: host/src/server.ts --> <!-- @test: src/__tests__/container-metrics.test.ts (sleepAfter enforcement) -->
5. The platform-level idle timer is functionally inert; idle policy is owned by the per-container metrics layer. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (sleepAfter enforcement) -->
6. Admins can always change their own idle timeout; non-subscribed users have the dropdown disabled. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: src/__tests__/container-metrics.test.ts (free-tier lock) -->

**Constraints:**

- The idle timeout is validated server-side against the supported value set.
- The preference survives container-orchestration resets; the storage shape is preserved for backwards compatibility with existing sessions.
- Free-tier override cannot be bypassed via API.
- Idle detection MUST NOT rely on the platform's built-in inactivity timer because it refreshes on any traffic (including background process output). The product semantics are "no user input", not "no traffic".

**Priority:** P0

**Dependencies:** [REQ-SESSION-005](#req-session-005-input-based-idle-detection)

**Verification:** [Automated test](../../src/__tests__/container-metrics.test.ts)

**Status:** Implemented

---

### REQ-SESSION-005: Input-based idle detection

**Intent:** Idle detection is based on actual user input (keystrokes, control keys, mouse clicks), not on WebSocket connection activity or heartbeat pings.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal server tracks the timestamp of the last real user input. <!-- @impl: host/src/activity-tracker.ts::createActivityTracker --> <!-- @test: host/__tests__/activity-tracker.test.js (containsUserInput whitelist) -->
2. User-input classification uses a whitelist: printable characters, control keys, arrow keys, function keys, Alt+key, and mouse clicks count as input. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/activity-tracker.test.js (containsUserInput whitelist) -->
3. Terminal protocol responses (cursor-position reports, OSC color queries, mouse movement, device-attribute reports) do not count as input. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/activity-tracker.test.js (protocol response stripping) -->
4. Terminal-emulator response sequences are stripped before being written to the PTY so the agent never sees them. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/activity-tracker.test.js (protocol response stripping) -->
5. Idle detection reads the authoritative last-input timestamp from within the container, not from WebSocket traffic, so background process output cannot reset the idle clock. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (/activity polling + idle computation) -->

**Constraints:**

- If no input is ever received, idle time is measured from container start.
- A container with an open terminal but no typing stops after the configured idle timeout has elapsed from start.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/activity-tracker.test.js)

**Status:** Implemented

---

### REQ-SESSION-006: User can stop, restart, and delete sessions

**Intent:** Users have explicit control over session lifecycle: stop a running session, restart a stopped session, or permanently delete a session.

**Applies To:** User

**Acceptance Criteria:**

1. Stopping a session marks the session record as stopped and tears down the container. <!-- @impl: src/container/index.ts::destroy --> <!-- @impl: src/routes/session/lifecycle.ts --> <!-- @test: src/__tests__/routes/session-stop-delete.test.ts (stop sets KV stopped + container.destroy called + best-effort on destroy failure) --> <!-- @test: src/__tests__/routes/session-lifecycle.test.ts (POST /:id/stop) -->
2. Stopping clears all session-side identifiers before initiating teardown to prevent background writebacks from resurrecting the session, then performs a graceful shutdown so the final sync runs before the container is terminated. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (super.destroy + cleans up operational storage + deletes SESSION_ID_KEY + nulls _bucketName) -->
3. If the graceful shutdown does not exit within the deadline, the platform forces termination so the user-initiated stop always returns. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (SIGTERM poll exits when !running + SIGKILL fallback after 135s timeout) -->
4. Restarting a session reconnects to the same workspace and applies any updated preferences without recreating the container. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/container/index.test.ts (setBucketName returns 409 when bucket already set but stores new sessionId + restart path updates USER_TIMEZONE via applyPrefsOnRestart) -->
5. Deleting a session runs the same graceful shutdown as Stop (so the final sync runs), then removes the session record permanently. <!-- @impl: src/container/index.ts::destroy --> <!-- @impl: src/routes/session/crud.ts --> <!-- @test: src/__tests__/routes/session-stop-delete.test.ts (delete calls destroy + removes KV record) -->
6. Frontend status transitions are user-visible: stopped to initializing to running on start; running to stopping to stopped on stop. <!-- @impl: web-ui/src/stores/session.ts::updateSessionStatus --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (set status to stopping immediately then stopped after polling) --> <!-- @test: src/__tests__/routes/session-lifecycle.test.ts (GET /:id/status transitions) -->

**Constraints:**

- Clearing session-side identifiers before teardown is critical to prevent asynchronous writebacks from re-creating a stale session record.
- The shutdown sync runs against credentials baked into the container at start, independent of the session-side identifier cleanup.
- The final shutdown sync is bounded so a deletion storm cannot wipe persistent storage.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type), [REQ-SESSION-002](#req-session-002-one-container-per-session-isolation)

**Verification:** [Integration test](../../src/__tests__/routes/session-stop-delete.test.ts)

**Status:** Implemented

---

### REQ-SESSION-007: Running session count limited per tier

**Intent:** The number of concurrently running sessions is capped per subscription tier to enforce fair usage and plan differentiation.

**Applies To:** User

**Acceptance Criteria:**

1. Before starting a container, running sessions are counted from storage metadata with a single list operation (no per-session reads). <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (kv.list metadata count) -->
2. If the running count (excluding the session being started) meets or exceeds the tier's concurrent-session cap, the start is rejected with a quota-exceeded error. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (tier comparison) -->
3. Default tier limits: free=1, trial=2, standard=1, advanced=2, max=3, unlimited=5, blocked=0, pending=0. <!-- @impl: src/lib/subscription.ts::getUserTier --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (tier comparison) -->
4. Outside SaaS mode, role-based defaults apply (regular users default 3, admins default 10), configurable per deployment. <!-- @impl: src/lib/constants.ts::getMaxSessions --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (non-SaaS fallback) -->
5. Stress-test deployment mode bypasses session and quota limits. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (kv.list metadata count + tier comparison) -->

**Constraints:**

- Tier limits are configurable per deployment via the admin Subscription Management panel.
- The session-cap lookup respects an explicit zero value (a zero cap blocks all starts, not a fallthrough to default).

**Priority:** P1

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** [Automated test](../../src/__tests__/routes/container-lifecycle-helpers.test.ts)

**Status:** Implemented

---

### REQ-SESSION-008: Container restart preserves R2 bucket

**Intent:** Restarting a session reconnects to the same R2 bucket, preserving all user files without data loss.

**Applies To:** User

**Acceptance Criteria:**

1. Restarting a session on the same workspace preserves the bucket association and applies any stored preference updates. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/container/index.test.ts (setBucketName returns 409 when bucket already set but stores new sessionId + applyPrefsOnRestart on restart branch) --> <!-- @test: src/__tests__/routes/preferences.test.ts (fastStartEnabled persisted across restart via 409 restart path) -->
2. The idle-metric polling schedule is re-armed and the container start timestamp is recorded on each start. <!-- @impl: src/container/index.ts::onStart --> <!-- @test: src/__tests__/container/index.test.ts (onStart re-arms collectMetrics + records containerStartedAt + re-populates envVars from stored bucketName) -->
3. Updated credentials and preferences take effect on restart without requiring container recreation. <!-- @impl: src/container/index.ts::onStart --> <!-- @test: src/__tests__/routes/container-restart-prefs.test.ts (onStart refreshes envVars via updateEnvVars) -->
4. The container entrypoint runs an initial sync that restores the workspace from persistent storage on restart. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (initial rclone sync from R2 on container start) -->
5. User preference changes (idle timeout, fast-start, session mode) take effect on restart without requiring container recreation. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/container-restart-prefs.test.ts (applyPrefsOnRestart updates sessionId/workspaceSyncEnabled/fastStartEnabled/tabConfig on restart) --> <!-- @test: src/__tests__/routes/preferences.test.ts (preference persistence across restart) -->

**Constraints:**

- A restart against a different storage identity triggers a full teardown and rebind cycle.

**Priority:** P0

**Dependencies:** [REQ-SESSION-003](#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** [Integration test](../../src/__tests__/routes/container-restart-prefs.test.ts)

**Status:** Implemented

---

### REQ-SESSION-009: Container destroy wipes session state

**Intent:** Destroying a container clears all transient session state from the Durable Object, leaving only the persistent KV record and R2 bucket.

**Applies To:** User

**Acceptance Criteria:**

1. Destroying a session clears all transient session state from the Durable Object; subsequent fetch attempts return 503. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (destroy() clears DO storage + memory + onStop schedule) -->
2. Session mode resets to default on destroy. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (destroy() clears DO storage + memory + onStop schedule) -->
3. Scheduled idle-metric polling is cancelled on destroy. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (destroy() clears DO storage + memory + onStop schedule) -->
4. After destroy, any delayed polling that fires detects the missing session state and exits without re-arming. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container/index.test.ts (destroy() clears DO storage + memory + onStop schedule) -->
5. The user's persistent storage bucket and its contents are NOT deleted by destroy; files persist across sessions. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (destroy() clears DO storage + memory + onStop schedule) -->

**Constraints:**

- Durable Object storage and in-memory state must be cleared before the platform teardown call to prevent asynchronous writebacks from re-creating a stale record.

**Priority:** P0

**Dependencies:** [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** [Automated test](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-SESSION-010: Session status observable from dashboard

**Intent:** The dashboard displays the current status of each session (running, stopped, initializing, stopping, error) with near-real-time updates.

**Applies To:** User

**Acceptance Criteria:**

1. The batch-status endpoint returns status for all user sessions in a single storage-metadata list call (no container wake, no per-session reads). <!-- @impl: src/routes/session/lifecycle.ts --> <!-- @impl: src/routes/session/crud.ts --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (batch-status uses KV list metadata no kv.get) -->
2. Persistent storage holds two statuses (running and stopped); the frontend adds ephemeral states (initializing, stopping, error) that are never persisted. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (r/s compression) -->
3. The frontend polls batch-status on a fixed cadence (about every 5 seconds). <!-- @impl: web-ui/src/stores/session-polling.ts::startSessionListPolling --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (SESSION_LIST_POLL_INTERVAL_MS constant) -->
4. Dashboard session cards display a three-color status dot: green (running + WebSocket connected), yellow (running + WebSocket disconnected), gray (stopped). <!-- @impl: web-ui/src/components/SessionStatCard.tsx::SessionStatCard --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (green dot when running and WS connected + yellow warning dot when running but WS disconnected + grey static dot for stopped) -->
5. Container metrics (CPU, memory, disk, sync status) are surfaced on the session cards with up to ~60s staleness. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (metrics in metadata) -->
6. Last-active and last-started timestamps are available for sleep-timer countdown display. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (lastActiveAt/lastStartedAt) -->
7. When polling transitions a session to stopped, its terminal connections are disposed; the currently active session is exempt from the poll-driven dispose only within the active-session guard window, not unconditionally. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (calls disposeSession when session transitions from running to stopped + no-op when stays running) -->

**Constraints:**

- Storage eventual consistency causes ~60s propagation delay for newly created sessions.
- Dashboard status is a pure storage read; no container is contacted, preserving container hibernation.

**Priority:** P1

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** [Integration test](../../src/__tests__/routes/session-batch-status.test.ts) (batch-status read path). The `@test` anchors above are the authoritative per-AC mapping.

**Status:** Implemented

---

### REQ-SESSION-011: Graceful shutdown with final sync

**Intent:** When a container is stopped for any reason (user stop, user delete, idle timeout, quota eviction), its workspace is fully synced to R2 before the container process is terminated, so no data is lost. The platform's grace period between SIGTERM and SIGKILL is far shorter than a bidirectional sync can take, so the final sync is performed as an *awaited live bisync while the container is still running* - the Durable Object triggers it and blocks on its completion before stopping the container - rather than relying on the SIGTERM trap, which is retained only as a best-effort backstop.

**Applies To:** User

**Acceptance Criteria:**

1. Before signalling the container to stop, every deliberate stop path runs a live bidirectional R2 sync to completion while the container is still fully running — including a delete where the platform reports `running:false` transiently (the drain is never gated on that reading, #516) — and records the drain outcome durably (DO storage `finalSyncAudit`, carrying the session id and the final-sync HTTP status/reason for post-mortem correlation) instead of silently swallowing it. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-lifecycle.ts::drainFinalSyncAudited --> <!-- @impl: src/container/container-lifecycle.ts::recordFinalSyncAudit --> <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @test: src/__tests__/container/index.test.ts (drains final-sync before stop + best-effort on drain failure; drain attempted despite running:false + finalSyncAudit outcome completed/incomplete/errored persisted) --> <!-- @test: src/__tests__/container-metrics.test.ts (drainFinalSync attempts despite transient not-running + best-effort + idle-stop drains before stop) -->
2. The container exposes an awaitable final-sync endpoint that triggers a fresh bisync and responds only once that bisync has completed (success or failure) or an internal timeout elapses, distinguishing completion from failure and timeout. <!-- @impl: host/src/server.ts --> <!-- @impl: host/src/final-sync.ts --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (evaluateFinalSync completion detection: in-flight ignored + syncing->success/failed) --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync cadence + SIGUSR1 coalesce + failure recovery + --resync fallback) -->
3. The sync-status record carries a monotonic timestamp and a `syncing`->`success`/`failed` transition, and the endpoint accepts a terminal status only after observing its own run's `syncing` (stamped strictly after the trigger), never a bare `success`. <!-- @impl: host/src/final-sync.ts --> <!-- @impl: entrypoint.sh --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (host INTERNAL_TIMEOUT_MS > DO FINAL_SYNC_BUDGET_MS ordering guard + entrypoint signal) --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync daemon runtime behavior) -->
4. The Durable Object waits up to a bounded sync budget (120s) for the live sync to report completion; a failed or timed-out sync still proceeds to stop rather than blocking teardown. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (drains final-sync before stop + best-effort on drain failure) -->
5. Total teardown is hard-capped: the container is force-terminated no later than 135s after teardown begins regardless of sync state, so a hung sync cannot wedge the session. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (destroy still completes when the drain rejects) -->
6. User stop and user delete behave identically: both route through the same graceful-destroy path, and idle-timeout and quota-eviction paths drain through the same endpoint before stopping. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (idle-stop drains before stop; quota-stop drains before stop) --> <!-- @test: src/__tests__/container/index.test.ts (graceful shutdown SIGTERM + poll ctx.container.running for up to 135s + super.destroy fallback when stop rejects + skip-when-not-running) -->
7. The SIGTERM trap is retained as a best-effort backstop final sync for paths that bypass the orchestrated drain, but is no longer the primary guarantee (see [REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync) for the trap's own constraints). <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @impl: Dockerfile --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (entrypoint trap handler catches SIGINT/SIGTERM + final rclone bisync before exit + Dockerfile STOPSIGNAL) --> <!-- @test: src/__tests__/container-metrics.test.ts (130 minute idle DOES trigger stop via collectMetrics calling stop('SIGTERM'); collectMetrics calls stop('SIGTERM') when idleMs exceeds idleTimeoutPref) -->

**Constraints:**

- The platform's post-SIGTERM kill grace is never relied on for sync completion; the authoritative sync runs while the container is alive and the DO holds teardown open awaiting it.
- The container's final-sync endpoint internal timeout MUST exceed the DO's drain budget (120s), so the DO's `AbortSignal` — not the endpoint — is the authoritative ceiling. A host endpoint timeout *below* the budget returns a premature 504 while rclone is still flushing, the DO records `incomplete`, and the session deletes with the last edits lost (the budget-inversion regression that defeated ~10 prior "raise the budget" fixes).
- A failed or timed-out drain proceeds to stop (135s hard force-kill ceiling) rather than blocking teardown indefinitely; liveness is preserved over a guaranteed-complete sync in the pathological case.
- Completion detection accepts a terminal status only after observing the triggered run's `syncing` stamped strictly after the trigger, so an in-flight or same-millisecond stamp is never mistaken for it and the rare missed-sample case degrades to a benign timeout, not data loss (rationale in [AD57](../../documentation/decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync)).
- The container image still declares a trappable stop signal so the backstop trap stays reachable.

**Priority:** P0

**Dependencies:** [REQ-SESSION-003](#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** [Drain-before-stop ordering + best-effort](../../src/__tests__/container/index.test.ts), [drainFinalSync + idle-stop drain](../../src/__tests__/container-metrics.test.ts), [awaitable endpoint + completion signal](../../host/__tests__/final-sync-endpoint.test.js)

**Status:** Implemented

---

### REQ-SESSION-012: Wake-loop prevention

**Intent:** A browser's automatic WebSocket reconnect must not wake a hibernated container in an infinite stop/start cycle.

**Applies To:** User

**Acceptance Criteria:**

1. When the container is not running, all non-internal requests receive 503 without waking the container. <!-- @impl: src/container/index.ts::fetch --> <!-- @test: src/__tests__/container/index.test.ts (DO fetch gate + 4503) -->
2. WebSocket upgrade requests are rejected when the session is stopped (defense-in-depth). <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (WS upgrade 503 when stopped) -->
3. The frontend detects running-to-stopped transitions and kills all WebSocket retry loops. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (calls disposeSession on running->stopped + no-op when stays running) -->
4. The server signals "container stopped" via a stable WebSocket close code. <!-- @impl: src/container/index.ts::fetch --> <!-- @test: src/__tests__/container/index.test.ts (DO fetch gate + 4503) -->
5. The client treats the container-stopped close code as authoritative and does not retry; other close codes trigger automatic reconnection. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (WS upgrade 503 when stopped) -->

**Constraints:**

- Fresh terminal connections are only opened when the user explicitly starts the session again.
- An anti-flapping guard prevents stale running status from auto-initializing terminals for non-active sessions.

**Priority:** P1

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout), [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

### REQ-SESSION-013: Sleep timer countdown UI

**Intent:** Users see how much idle time remains before their session hibernates.

**Applies To:** User

**Acceptance Criteria:**

1. Clock icon on session cards and header toolbar shows countdown. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Dashboard.tsx --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (Sleep timer icon shows tooltip on click) -->
2. Visible when < 10 min remaining. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (shows warning timer when remaining < 10 min + hides timer when remaining >= 10 min) -->
3. Orange pulse at < 10 min, red at < 5 min. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (shows warning timer when remaining < 10 min + shows critical timer when remaining < 5 min) -->
4. Hidden for stopped sessions. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (hides timer for stopped sessions) -->
5. Computed from the configured idle timeout minus elapsed idle time. <!-- @impl: web-ui/src/lib/sleep-timer.ts::getSleepTimerInfo --> <!-- @test: web-ui/src/__tests__/lib/sleep-timer.test.ts (getSleepTimerInfo computes remaining from idle timeout minus elapsed) -->

**Notes:** Sleep timer countdown UI is validated manually per the checklist in [documentation/lanes/troubleshooting.md](../../documentation/lanes/troubleshooting.md).

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/sleep-timer.test.ts)

**Status:** Implemented

---

### REQ-SESSION-014: User-configurable auto-sleep timeout in Settings

**Intent:** Users choose how long their sessions stay alive when idle.

**Applies To:** User

**Acceptance Criteria:**

1. Settings dropdown with 5 options (5m, 15m, 30m, 1h, 2h). <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (SleepAfterOptions exactly [5m,15m,30m,1h,2h] + all 5 accepted + invalid rejected) -->
2. Free tier locked to 15m with upgrade hint. <!-- @impl: src/routes/container/lifecycle.ts::resolveEffectiveSleepAfter --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (resolveEffectiveSleepAfter free->15m, paid/admin/unlimited honor stored, default 30m) -->
3. Admins and paying users can change. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (PATCH /preferences for admins/paying users) -->
4. Value saved to KV preferences and applied on next session start. <!-- @impl: src/routes/container/lifecycle.ts::resolveEffectiveSleepAfter --> <!-- @impl: src/routes/preferences.ts --> <!-- @impl: src/container/index.ts --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (KV persist + GET/PATCH round-trip) --> <!-- @test: src/__tests__/routes/preferences.test.ts (GET /preferences KV preference contract) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** [Integration test](../../src/__tests__/routes/session-sleep-timeout.test.ts)

**Status:** Implemented

---

### REQ-SESSION-015: Container Port-Readiness Gating with Pre-Warm Pre-Condition

**Intent:** A new container must bind its serving port quickly so Cloudflare's port-wait check succeeds, yet must refuse real terminal traffic until initial state restore and pre-warm are complete; the readiness gate sits between the port bind and the first accepted WebSocket upgrade.

**Applies To:** User

**Acceptance Criteria:**

1. The serving port binds within Cloudflare's container port-wait window even while initialization (R2 sync, MCP config merges) is still in progress. <!-- @impl: entrypoint.sh --> <!-- @test: host/__tests__/prewarm-readiness.test.js (getPrewarmConfig: tab-1 pre-warm command extraction) -->
2. The entrypoint writes an init-complete signal only after initial sync, file modifications, and tab-autostart configuration have completed. <!-- @impl: entrypoint.sh --> <!-- @test: host/__tests__/entrypoint-pi-warmup-guard.test.js (guarded warm-up calls still reach init-flag write on failure + regression sentinel that unguarded form aborts before flag) -->
3. Tab-1 PTY pre-warm is gated on the init-complete signal, so it never starts before initial state restore is in place. <!-- @impl: host/src/server.ts --> <!-- @impl: host/src/prewarm-config.ts::getPrewarmConfig --> <!-- @test: host/__tests__/server-prewarm.test.js (getPrewarmConfig returns first token of tab 1 command + null when tabConfig has no tab 1) -->
4. The host terminal server rejects terminal WebSocket upgrades with a retriable ("try again later") close code and a human-readable container-warming reason until both the init-complete signal is observed and the pre-warm session is registered. <!-- @impl: host/src/server.ts --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (container-warming-up 1013 retriable-reject gate) -->
5. The image bakes a pre-transpiled (jiti) cache for the full Pi extension set at build time — warmed via a throwaway `pi` run with the package list derived from the preseed `package.json`, the build failing if the cache comes out empty — and the entrypoint exposes it at jiti's tmpdir fallback path (`/tmp/jiti` symlink), so the pre-warm PTY's first output is not delayed by a cold extension transpile (measured ~9s cold vs ~4s warm; the cold path pushed pre-warm past its 20s hard cap and doubled perceived session startup). The `pi` CLI stays `@latest` like the other coding agents (user policy: agents auto-update at deploy); the bake remains self-consistent because the warm run executes with the pi installed in the same build. <!-- @impl: Dockerfile --> <!-- @impl: entrypoint.sh --> <!-- @test: host/__tests__/dockerfile-pi-warm.test.js (baked jiti cache layer + entrypoint /tmp/jiti symlink) -->

**Constraints:**

- The container must not signal readiness (PTY pre-warm complete) until the initial sync either succeeds or times out.
- Best-effort setup steps that run before the init-complete flag (agent npm warm-up, fast-start suppression) must be guarded so their failure cannot abort the entrypoint under `set -euo pipefail`; a degraded warm-up is preferable to PID 1 dying before the flag is written.

**Priority:** P0

**Dependencies:** [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** [Automated test](../../host/__tests__/prewarm-readiness.test.js) (AC1); [container-warming-up gate](../../src/__tests__/routes/terminal-ws.test.ts) (AC4); [dockerfile-pi-warm.test.js](../../host/__tests__/dockerfile-pi-warm.test.js) (AC5 — baked cache layer, derived package list, empty-cache build guard, entrypoint symlink)

**Status:** Implemented

---

### REQ-SESSION-016: User timezone propagated from preferences to container env

**Intent:** The capture pipeline and any other consumer of `$USER_TIMEZONE` inside the container must receive the user's IANA timezone choice without manual env-var configuration; the preference is set via the preferences API and persists across restarts.

**Applies To:** User

**Acceptance Criteria:**

1. The preferences endpoint accepts an optional user-timezone field (valid IANA timezone string, max 64 characters); invalid zones are rejected with a validation error. <!-- @impl: src/routes/preferences.ts::isValidIanaTz --> <!-- @test: src/__tests__/routes/preferences.test.ts (userTimezone validation) -->
2. The session persistently stores the user's timezone preference. <!-- @impl: src/routes/preferences.ts --> <!-- @test: src/__tests__/routes/preferences.test.ts (userTimezone persistence) -->
3. Subsequent container starts inject the user's timezone preference into the container environment; if unset, the entrypoint falls back to the container default and finally to UTC. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (USER_TIMEZONE injection on restart) -->
4. A timezone change takes effect on the next session start (no live re-injection into a running container). <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @test: src/__tests__/container/container-env.test.ts (USER_TIMEZONE injection on restart) -->
5. On Dashboard mount, the frontend reads the browser's IANA timezone and updates the stored preference (best-effort) when the resolved zone differs; a failed update never blocks the mount. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/lib/timezone-sync.test.ts (browser-side resolution + best-effort PATCH) -->

**Constraints:**

- Validation uses a runtime IANA-zone round-trip rather than a static zone allowlist, so the validator stays accurate as the IANA database evolves.
- The field is optional; absence is silently treated as "use the entrypoint fallback chain", not an error.

**Priority:** P1

**Dependencies:** [REQ-SESSION-014](#req-session-014-user-configurable-auto-sleep-timeout-in-settings) (preferences flow)

**Verification:** [Automated test](../../src/__tests__/routes/preferences.test.ts)

**Status:** Implemented

---

### REQ-SESSION-017: Container health and startup-status API

**Intent:** The dashboard needs a non-blocking way to learn whether a user's container is up and, while it is coming up, how far through initialization it has progressed, so the loading experience reflects real container state instead of a fixed timer.

**Applies To:** User

**Acceptance Criteria:**

1. `GET /api/container/health` reports whether the user's container is running and healthy, returning its metrics on success and an error with 500 when the health check fails. <!-- @impl: src/routes/container/status.ts --> <!-- @test: src/__tests__/routes/container-status.test.ts (health success/500) -->
2. `GET /api/container/startup-status` returns the current initialization stage without blocking, carrying a stage label, a 0-to-100 progress value, and a human-readable message. <!-- @impl: src/routes/container/status.ts --> <!-- @test: src/__tests__/routes/container-status.test.ts (startup-status stage progression) -->
3. The reported stage reflects real container state: `stopped` when state is indeterminate, `starting` before services respond, `syncing` during the initial R2 sync, `verifying` after sync while terminals are not yet up, `mounting` during terminal pre-warm, and `ready` when all services are up. <!-- @impl: src/routes/container/status.ts --> <!-- @test: src/__tests__/routes/container-status.test.ts (startup-status stage progression) -->
4. A failed initial R2 sync surfaces as an error stage carrying the sync error, while a skipped sync (no R2 credentials) still reaches the ready stage with the skip reason reported. <!-- @impl: src/routes/container/status.ts --> <!-- @test: src/__tests__/routes/container-status.test.ts (sync-failed/skipped) -->
5. An unexpected failure while computing startup status is caught and returned as an error stage rather than propagating an unhandled 500. <!-- @impl: src/routes/container/status.ts --> <!-- @test: src/__tests__/routes/container-status.test.ts (caught-error) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-SESSION-015](#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition)

**Verification:** [Automated test](../../src/__tests__/routes/container-status.test.ts)

**Status:** Implemented

---

### REQ-SESSION-018: Persisted status is authoritative on container exit

**Intent:** Session status in KV is the single source of truth. A container that exits for any reason writes `stopped` to its KV record, so the dashboard ([REQ-SESSION-010](#req-session-010-session-status-observable-from-dashboard)) reflects reality directly from the record without any read-side staleness guess. Conversely, a container that is demonstrably alive is never left showing stopped: the not-running signal is treated as authoritative only after it is confirmed, and a status that was wrongly flipped to stopped is self-healed back to running.

**Applies To:** User

**Acceptance Criteria:**

1. A container that exits for any reason (graceful stop, crash, or an SDK-surfaced error) transitions its KV status to stopped, and the dashboard reads status directly from the record with no read-side staleness reconciliation. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/index.ts::onError --> <!-- @test: src/__tests__/container-metrics.test.ts (writes status=stopped to KV only after the not-running confirmation window) --> <!-- @test: src/__tests__/container/index.test.ts (onStop updates KV with lastActiveAt and sets status to stopped) -->
2. The `collectMetrics` catch-all writes stopped only after the container reads not-running across a confirmation window spanning more than one alarm tick, so a single transient not-running reading never flips a live session to stopped. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (does not flip a live session to stopped on a single transient not-running tick) -->
3. On a not-running reading `onError` does not write stopped; it opens the same confirmation window and re-arms a `collectMetrics` tick, deferring the stopped decision to that window. <!-- @impl: src/container/container-lifecycle.ts::onError --> <!-- @impl: src/container/container-metrics.ts::openNotRunningConfirmation --> <!-- @test: src/__tests__/container/index.test.ts (onError opens the not-running confirmation window and re-arms instead of writing stopped) -->
4. When the container is demonstrably running (running branch after a successful `/health` probe) but KV reads stopped, `collectMetrics` re-asserts running, unless a persisted shutdown-requested marker shows a deliberate stop is in flight. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container-metrics.test.ts (skips the metrics write when stopped AND the persisted shutdown marker is set; re-asserts running when the container is alive but KV reads stopped and no shutdown marker is set) -->

**Constraints:**

- The not-running confirmation window and the deliberate-stop marker are persisted in DO storage (not in-memory), so a hibernation or mid-shutdown eviction cannot discard them; `destroy()` sets the marker before clearing identifiers and `onStart` clears it.
- Newly started sessions have a 3-minute startup guard during which only the container-stopped close code can transition them to stopped (anti-flapping).
- A genuine crash converges to stopped after the confirmation window (one to a few alarm ticks) rather than immediately, accepted as the price of never flipping a live session to stopped.
- Accepted residual: a tick landing in the sub-millisecond gap between the user-stop KV write and `destroy()` persisting the marker can self-heal the just-stopped session for a single tick before `destroy()` settles it back to stopped; the idle-stop path is immune.

**Priority:** P1

**Dependencies:** [REQ-SESSION-010](#req-session-010-session-status-observable-from-dashboard)

**Verification:** [collectMetrics catch-all](../../src/__tests__/container-metrics.test.ts), [onError / onStop lifecycle](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-SESSION-019: Final-sync drain endpoint authentication

**Intent:** Every Durable-Object-side drain to the in-container final-sync endpoint must authenticate with the container auth token, because the raw `port.fetch` bypasses the DO's public `fetch()` override that otherwise injects the Authorization header; an unauthenticated drain is rejected at the host auth gate and the session tears down with the last edits unsynced.

**Applies To:** User

**Acceptance Criteria:**

1. Every Durable-Object-side drain request to the final-sync endpoint authenticates with the container auth token (`Authorization: Bearer`). The drains use a raw `port.fetch`, which bypasses the DO's public fetch override — the only place the auth header is otherwise injected — and the in-container host's auth gate rejects unauthenticated `/internal/*` requests (only `/health` and `/activity` are exempt). The delete path captures the token BEFORE `destroy()`'s operational-storage clear deletes it (the drain runs after the clear by REQ-SESSION-009 ordering); the idle/quota-stop path reads it from DO storage, which is intact there. An unauthenticated drain dies at the auth gate in milliseconds (observed live: every stop/delete 401'd for ≥30 days, zero successful teardown syncs ever recorded) and the session stops/deletes with the last edits unsynced. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-lifecycle.ts::drainFinalSyncAudited --> <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @impl: host/src/auth-check.ts --> <!-- @test: src/__tests__/container/index.test.ts (drain authenticates with the pre-clear-captured Bearer token) --> <!-- @test: src/__tests__/container/container-metrics-drain.test.ts (idle/quota-stop drain sends stored Bearer token + headerless best-effort when absent) -->

**Constraints:** None.

**Priority:** P0

**Dependencies:** [REQ-SESSION-011](#req-session-011-graceful-shutdown-with-final-sync)

**Verification:** [Drain auth on the delete path](../../src/__tests__/container/index.test.ts), [idle/quota-stop drain auth](../../src/__tests__/container/container-metrics-drain.test.ts)

**Status:** Implemented
