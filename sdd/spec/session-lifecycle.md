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

<!-- @test: src/__tests__/routes/session-creation.test.ts (REQ-SESSION-001 describe -> name+agentType accept (all 7 types) + sanitize + Terminal default + SESSION_ID_PATTERN + KV write + 201 + 429 rate limit + 10/60_000 config -> AC1..AC5) -->
### REQ-SESSION-001: Session creation with name and agent type

<!-- @impl: src/routes/session/crud.ts -->
<!-- @impl: src/lib/constants.ts::SESSION_ID_PATTERN -->

**Intent:** A user can create a named session associated with a specific AI agent, producing a unique session record stored in KV.

**Applies To:** User

**Acceptance Criteria:**

1. The session creation endpoint accepts a trimmed session name and optional AI agent type (one of: claude-code, codex, antigravity, opencode, copilot, bash, pi).
2. A unique alphanumeric session ID (8-24 lowercase chars) is generated for each new session.
3. The session record is persisted durably and retrievable by the user.
4. The response returns the new session object with status 201.
5. Session creation is rate-limited (10/min per user).

**Constraints:**

- Session name is sanitized to prevent injection.
- Storage quota is checked before creation in SaaS mode; over-quota users receive a descriptive validation error and session creation is blocked.

**Priority:** P0

**Dependencies:** [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware) (requireActiveUser middleware)

**Verification:** [Integration test](../../src/__tests__/routes/session-creation.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/container-id-isolation.test.ts (REQ-SESSION-002 describe -> getContainerId(bucketName,sessionId) deterministic + distinct per session + same-user distinct + SESSION_ID_PATTERN boundaries -> AC1..AC3) -->
### REQ-SESSION-002: One container per session (isolation)

<!-- @impl: src/container/index.ts -->
<!-- @impl: src/lib/container-helpers.ts::getContainerId -->

**Intent:** Each session maps to exactly one Durable Object container instance, providing full process-level isolation between sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Each session maps to a deterministic, unique container address derived from the user's storage identity and the session ID.
2. The container address uniquely addresses a single isolated runtime; no two sessions share one.
3. Different sessions belonging to the same user run in separate containers with separate PTY processes.
4. A session's container cannot access files, processes, or network state of another session's container.

**Constraints:**

- The container address derivation must never produce collisions for distinct sessions of the same user.
- The container address is never a fallback or default; validation rejects malformed inputs before container interaction.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** [Integration test](../../src/__tests__/lib/container-id-isolation.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-SESSION-003 describe -> createBucketIfNotExists called + scoped R2 token injected into setBucketName body + seedGettingStartedDocs on new bucket -> AC1, AC2, AC5) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (entrypoint.sh bisync daemon behavior (real) describe -> initial rclone sync from R2 (REQ-STOR-004) + bisync cadence + SIGUSR1 + final shutdown sync -> AC3 initial sync, AC4 bisync daemon + SIGUSR1) -->
### REQ-SESSION-003: R2 bucket mounted and synced on start

<!-- @impl: src/container/index.ts -->
<!-- @impl: src/container/container-env.ts -->
<!-- @impl: src/lib/r2-admin.ts::createBucketIfNotExists -->
<!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-SESSION-003 AC1/AC2/AC5 describes -> bucket provision + scoped token + seed-on-create) + src/__tests__/lib/r2-admin.test.ts (createBucketIfNotExists + createScopedR2Token describes -> AC1/AC2) + host/__tests__/entrypoint-bisync-behavior.test.js (REQ-SESSION-003 AC3/AC4 describes -> initial sync + bisync daemon) -->

**Intent:** When a container starts, the user's persistent R2 storage is mounted and bidirectionally synced so the workspace contains all previously persisted files.

**Applies To:** User

**Acceptance Criteria:**

1. The user's persistent storage bucket is provisioned if it does not exist.
2. A scoped, bucket-specific credential pair is obtained or created for the user and injected into the container environment.
3. An initial sync from persistent storage to the workspace completes before the container accepts terminal traffic, with a configurable safety timeout.
4. After initial sync, changes are bidirectionally synced on a regular schedule for the container's lifetime, with support for on-demand triggers and a final sync on shutdown (see [REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)).
5. New buckets are seeded with getting-started docs and agent configs matching the user's session mode.

**Constraints:**

- The master Cloudflare API token never enters the container; only per-user scoped credentials are injected.
- Scoped credentials are cached durably (optionally encrypted at rest) and verified before reuse.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](#req-session-002-one-container-per-session-isolation)

**Verification:** [Integration test](../../src/__tests__/routes/container-r2-start.test.ts)

**Status:** Implemented

---

### REQ-SESSION-004: Idle containers sleep after configurable timeout

<!-- @impl: src/container/container-metrics.ts::collectMetrics -->
<!-- @impl: src/container/index.ts -->
<!-- @impl: host/src/server.ts -->
<!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics describe → sleepAfter enforcement + 24h sentinel + free-tier lock → AC1-AC6) -->

**Intent:** Containers that receive no user input for a configurable duration are automatically stopped to conserve resources and reduce cost.

**Applies To:** User

**Acceptance Criteria:**

1. The idle timeout is user-configurable with allowed values: 5m, 15m, 30m, 1h, 2h.
2. Default is 30m for paying users; free-tier users are locked to 15m regardless of stored preference.
3. The idle timer resets only when new user input is detected (not on heartbeats, reconnections, or protocol chatter).
4. The container is stopped once the user-configured idle threshold is exceeded; the host-side per-PTY keepalive is a separate safety net floor-clamped at the maximum idle timeout (see [AD47](../../documentation/decisions/README.md#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy)).
5. The platform-level idle timer is functionally inert; idle policy is owned by the per-container metrics layer.
6. Admins can always change their own idle timeout; non-subscribed users have the dropdown disabled.

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

<!-- @impl: host/src/activity-tracker.ts -->
<!-- @impl: host/src/session.ts -->
<!-- @impl: src/container/container-metrics.ts::collectMetrics -->
<!-- @test: host/__tests__/activity-tracker.test.js (activity-tracker describe → containsUserInput whitelist + protocol response stripping → AC1-AC4) -->
<!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics describe → /activity polling + idle computation → AC5/AC6) -->

**Intent:** Idle detection is based on actual user input (keystrokes, control keys, mouse clicks), not on WebSocket connection activity or heartbeat pings.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal server tracks the timestamp of the last real user input.
2. User-input classification uses a whitelist: printable characters, control keys, arrow keys, function keys, Alt+key, and mouse clicks count as input.
3. Terminal protocol responses (cursor-position reports, OSC color queries, mouse movement, device-attribute reports) do not count as input.
4. Terminal-emulator response sequences are stripped before being written to the PTY so the agent never sees them.
5. Idle detection reads the authoritative last-input timestamp from within the container, not from WebSocket traffic, so background process output cannot reset the idle clock.

**Constraints:**

- If no input is ever received, idle time is measured from container start.
- A container with an open terminal but no typing stops after the configured idle timeout has elapsed from start.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/activity-tracker.test.js)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/session-stop-delete.test.ts (REQ-SESSION-006 describe -> stop sets KV stopped + container.destroy called + best-effort on destroy failure (AC1) + delete calls destroy + removes KV record (AC5) -> AC1, AC5) -->
<!-- @test: src/__tests__/container/index.test.ts (destroy describe -> super.destroy + cleans up operational storage + deletes SESSION_ID_KEY + nulls _bucketName + SIGTERM poll exits when !running + SIGKILL fallback after 135s timeout + best-effort on stop rejection + skip SIGTERM when already !running -> AC2 storage cleanup, AC3 SIGKILL fallback) -->
<!-- @test: src/__tests__/container/index.test.ts (internal route dispatch -> setBucketName returns 409 when bucket already set but stores new sessionId + restart path updates USER_TIMEZONE via applyPrefsOnRestart -> AC4 restart 409 path) -->
<!-- @test: web-ui/src/__tests__/stores/session.test.ts (set status to stopping immediately then stopped after polling -> AC6 frontend transition vocabulary) -->
### REQ-SESSION-006: User can stop, restart, and delete sessions

<!-- @impl: src/routes/session/lifecycle.ts -->
<!-- @impl: src/routes/session/crud.ts -->
<!-- @impl: src/container/index.ts -->
<!-- @test: src/__tests__/routes/session-lifecycle.test.ts (Session Lifecycle Routes POST /:id/stop + GET /:id/status describes -> AC1/AC2/AC3/AC6 stop + status transitions) + src/__tests__/routes/session-stop-delete.test.ts (AC1/AC5 describes -> stop sets KV stopped + delete cascade) -->

**Intent:** Users have explicit control over session lifecycle: stop a running session, restart a stopped session, or permanently delete a session.

**Applies To:** User

**Acceptance Criteria:**

1. Stopping a session marks the session record as stopped and tears down the container.
2. Stopping clears all session-side identifiers before initiating teardown to prevent background writebacks from resurrecting the session, then performs a graceful shutdown so the final sync runs before the container is terminated.
3. If the graceful shutdown does not exit within the deadline, the platform forces termination so the user-initiated stop always returns.
4. Restarting a session reconnects to the same workspace and applies any updated preferences without recreating the container.
5. Deleting a session runs the same graceful shutdown as Stop (so the final sync runs), then removes the session record permanently.
6. Frontend status transitions are user-visible: stopped to initializing to running on start; running to stopping to stopped on stop.

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

<!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits -->
<!-- @impl: src/lib/subscription.ts::getUserTier -->
<!-- @impl: src/lib/constants.ts::getMaxSessions -->
<!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (Container lifecycle extracted helpers describe → kv.list metadata count + tier comparison + non-SaaS fallback → AC1-AC5) -->

**Intent:** The number of concurrently running sessions is capped per subscription tier to enforce fair usage and plan differentiation.

**Applies To:** User

**Acceptance Criteria:**

1. Before starting a container, running sessions are counted from storage metadata with a single list operation (no per-session reads).
2. If the running count (excluding the session being started) meets or exceeds the tier's concurrent-session cap, the start is rejected with a quota-exceeded error.
3. Default tier limits: free=1, trial=2, standard=1, advanced=2, max=3, unlimited=5, blocked=0, pending=0.
4. Outside SaaS mode, role-based defaults apply (regular users default 3, admins default 10), configurable per deployment.
5. Stress-test deployment mode bypasses session and quota limits.

**Constraints:**

- Tier limits are configurable per deployment via the admin Subscription Management panel.
- The session-cap lookup respects an explicit zero value (a zero cap blocks all starts, not a fallthrough to default).

**Priority:** P1

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** [Automated test](../../src/__tests__/routes/container-lifecycle-helpers.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/container-restart-prefs.test.ts (REQ-SESSION-008 describe -> onStart refreshes envVars via updateEnvVars (AC3) + applyPrefsOnRestart updates sessionId/workspaceSyncEnabled/fastStartEnabled/tabConfig on restart (AC5) -> AC3, AC5) -->
<!-- @test: src/__tests__/container/index.test.ts (internal route dispatch -> setBucketName returns 409 when bucket already set but stores new sessionId + applyPrefsOnRestart on restart branch (AC1) + onStart lifecycle -> re-arms collectMetrics + records containerStartedAt + re-populates envVars from stored bucketName (AC2) -> AC1, AC2) -->
<!-- @test: src/__tests__/routes/preferences.test.ts (fastStartEnabled persisted across restart via 409 restart path -> AC1) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (entrypoint.sh bisync daemon behavior describe -> initial rclone sync from R2 on container start = REQ-STOR-004 = REQ-SESSION-008 AC4) -->
### REQ-SESSION-008: Container restart preserves R2 bucket

<!-- @impl: src/container/index.ts -->
<!-- @impl: src/routes/container/lifecycle.ts -->
<!-- @impl: entrypoint.sh -->
<!-- @test: src/__tests__/routes/container-restart-prefs.test.ts (AC3/AC5 describes -> onStart refreshes envVars + preferences apply on restart) + src/__tests__/routes/preferences.test.ts (fastStartEnabled preference describe -> AC1/AC3/AC5 preference persistence across restart) -->

**Intent:** Restarting a session reconnects to the same R2 bucket, preserving all user files without data loss.

**Applies To:** User

**Acceptance Criteria:**

1. Restarting a session on the same workspace preserves the bucket association and applies any stored preference updates.
2. The idle-metric polling schedule is re-armed and the container start timestamp is recorded on each start.
3. Updated credentials and preferences take effect on restart without requiring container recreation.
4. The container entrypoint runs an initial sync that restores the workspace from persistent storage on restart.
5. User preference changes (idle timeout, fast-start, session mode) take effect on restart without requiring container recreation.

**Constraints:**

- A restart against a different storage identity triggers a full teardown and rebind cycle.

**Priority:** P0

**Dependencies:** [REQ-SESSION-003](#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** [Integration test](../../src/__tests__/routes/container-restart-prefs.test.ts)

**Status:** Implemented

---

### REQ-SESSION-009: Container destroy wipes session state

<!-- @impl: src/container/index.ts -->
<!-- @test: src/__tests__/container/index.test.ts (fetch gate - 503 when container not running describe → destroy() clears DO storage + memory + onStop schedule → AC1-AC6) -->

**Intent:** Destroying a container clears all transient session state from the Durable Object, leaving only the persistent KV record and R2 bucket.

**Applies To:** User

**Acceptance Criteria:**

1. Destroying a session clears all transient session state from the Durable Object; subsequent fetch attempts return 503.
2. Session mode resets to default on destroy.
3. Scheduled idle-metric polling is cancelled on destroy.
4. After destroy, any delayed polling that fires detects the missing session state and exits without re-arming.
5. The user's persistent storage bucket and its contents are NOT deleted by destroy; files persist across sessions.

**Constraints:**

- Durable Object storage and in-memory state must be cleared before the platform teardown call to prevent asynchronous writebacks from re-creating a stale record.

**Priority:** P0

**Dependencies:** [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** [Automated test](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-SESSION-010 describe -> batch-status uses KV list metadata no kv.get + r/s compression + metrics in metadata + lastActiveAt/lastStartedAt + SESSION_LIST_POLL_INTERVAL_MS constant -> AC1,2,3,5,6) -->
### REQ-SESSION-010: Session status observable from dashboard

<!-- @impl: src/routes/session/crud.ts -->
<!-- @impl: src/routes/session/lifecycle.ts -->
<!-- @impl: web-ui/src/stores/session-polling.ts -->

**Intent:** The dashboard displays the current status of each session (running, stopped, initializing, stopping, error) with near-real-time updates.

**Applies To:** User

**Acceptance Criteria:**

1. The batch-status endpoint returns status for all user sessions in a single storage-metadata list call (no container wake, no per-session reads).
2. Persistent storage holds two statuses (running and stopped); the frontend adds ephemeral states (initializing, stopping, error) that are never persisted.
3. The frontend polls batch-status on a fixed cadence (about every 5 seconds).
4. Dashboard session cards display a three-color status dot: green (running + WebSocket connected), yellow (running + WebSocket disconnected), gray (stopped).
5. Container metrics (CPU, memory, disk, sync status) are surfaced on the session cards with up to ~60s staleness.
6. Last-active and last-started timestamps are available for sleep-timer countdown display.
7. When polling transitions a session to stopped, its terminal connections are disposed; the currently active session is exempt from the poll-driven dispose only within the active-session guard window, not unconditionally.

**Constraints:**

- Storage eventual consistency causes ~60s propagation delay for newly created sessions.
- Dashboard status is a pure storage read; no container is contacted, preserving container hibernation.

**Priority:** P1

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** [Integration test](../../src/__tests__/routes/session-batch-status.test.ts) (batch-status read path). The `@test` anchors above are the authoritative per-AC mapping.

**Status:** Implemented

---

<!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 describe -> entrypoint trap handler catches SIGINT/SIGTERM (AC1) + trap kills sync daemon via /tmp/sync-daemon.pid (AC2) + final rclone bisync with --ignore-checksum --max-delete 100 before exit (AC3) + bisync-initialized flag touched on timeout path (AC4) + Dockerfile STOPSIGNAL SIGINT (AC5) -> AC1..AC5) -->
<!-- @test: src/__tests__/container/index.test.ts (destroy describe -> graceful shutdown SIGTERM + poll ctx.container.running for up to 135s + super.destroy fallback when stop rejects -> AC6 user-initiated Stop/Delete reach trap via destroy()) -->
<!-- @test: src/__tests__/container-metrics.test.ts (idle timeout resolution describe -> respects 2h pref / 130 minute idle DOES trigger stop via collectMetrics calling stop('SIGTERM') -> AC7 idle-timeout path reaches trap via collectMetrics) -->
<!-- @test: src/__tests__/container/index.test.ts (destroy describe -> SIGTERM via stop() + poll ctx.container.running + super.destroy fallback + skip-when-not-running -> AC6) -->
<!-- @test: src/__tests__/container-metrics.test.ts (idle timeout resolution describe -> collectMetrics calls stop('SIGTERM') when idleMs exceeds idleTimeoutPref -> AC7) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (entrypoint.sh bisync daemon behavior (real) describe -> bisync cadence + SIGUSR1 coalesce + failure recovery + --resync fallback -> AC2/AC3 daemon-side runtime behavior) -->
### REQ-SESSION-011: Graceful shutdown with final sync

<!-- @impl: src/container/container-lifecycle.ts::destroy -->
<!-- @impl: src/container/container-metrics.ts::drainFinalSync -->
<!-- @impl: src/container/container-metrics.ts::collectMetrics -->
<!-- @impl: host/src/server.ts -->
<!-- @impl: host/src/final-sync.ts -->
<!-- @impl: entrypoint.sh::shutdown_handler -->
<!-- @impl: Dockerfile -->
<!-- @test: src/__tests__/container/index.test.ts (destroy describe -> drains final-sync before stop + best-effort on drain failure -> AC1/AC4/AC5) -->
<!-- @test: src/__tests__/container-metrics.test.ts (final-sync drain describe -> drainFinalSync no-op/best-effort + idle-stop drains before stop -> AC1/AC6; REQ-SUB-008 describe -> quota-stop drains before stop -> AC6) -->
<!-- @test: host/__tests__/final-sync-endpoint.test.js (evaluateFinalSync completion detection describe -> in-flight ignored + syncing->success/failed -> AC2/AC3; structural describes -> endpoint wiring + entrypoint signal) -->

**Intent:** When a container is stopped for any reason (user stop, user delete, idle timeout, quota eviction), its workspace is fully synced to R2 before the container process is terminated, so no data is lost. The platform's grace period between SIGTERM and SIGKILL is far shorter than a bidirectional sync can take, so the final sync is performed as an *awaited live bisync while the container is still running* - the Durable Object triggers it and blocks on its completion before stopping the container - rather than relying on the SIGTERM trap, which is retained only as a best-effort backstop.

**Applies To:** User

**Acceptance Criteria:**

1. Before signalling the container to stop, every deliberate stop path runs a live bidirectional R2 sync to completion while the container is still fully running. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-metrics.ts::drainFinalSync -->
2. The container exposes an awaitable final-sync endpoint that triggers a fresh bisync and responds only once that bisync has completed (success or failure) or an internal timeout elapses, distinguishing completion from failure and timeout. <!-- @impl: host/src/server.ts --> <!-- @impl: host/src/final-sync.ts -->
3. The sync-status record carries a monotonic timestamp and a `syncing`->`success`/`failed` transition, and the endpoint accepts a terminal status only after observing its own run's `syncing` (stamped strictly after the trigger), never a bare `success`. <!-- @impl: host/src/final-sync.ts --> <!-- @impl: entrypoint.sh -->
4. The Durable Object waits up to a bounded sync budget (120s) for the live sync to report completion; a failed or timed-out sync still proceeds to stop rather than blocking teardown. <!-- @impl: src/container/container-lifecycle.ts::destroy -->
5. Total teardown is hard-capped: the container is force-terminated no later than 135s after teardown begins regardless of sync state, so a hung sync cannot wedge the session. <!-- @impl: src/container/container-lifecycle.ts::destroy -->
6. User stop and user delete behave identically: both route through the same graceful-destroy path, and idle-timeout and quota-eviction paths drain through the same endpoint before stopping. <!-- @impl: src/container/container-metrics.ts::collectMetrics -->
7. The SIGTERM trap is retained as a best-effort backstop final sync for paths that bypass the orchestrated drain, but is no longer the primary guarantee (see [REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync) for the trap's own constraints). <!-- @impl: entrypoint.sh::shutdown_handler -->

**Constraints:**

- The platform's post-SIGTERM kill grace is never relied on for sync completion; the authoritative sync runs while the container is alive and the DO holds teardown open awaiting it.
- A failed or timed-out drain proceeds to stop (135s hard force-kill ceiling) rather than blocking teardown indefinitely; liveness is preserved over a guaranteed-complete sync in the pathological case.
- Completion detection accepts a terminal status only after observing the triggered run's `syncing` stamped strictly after the trigger, so an in-flight or same-millisecond stamp is never mistaken for it and the rare missed-sample case degrades to a benign timeout, not data loss (rationale in [AD57](../../documentation/decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync)).
- The container image still declares a trappable stop signal so the backstop trap stays reachable.

**Priority:** P0

**Dependencies:** [REQ-SESSION-003](#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** [Drain-before-stop ordering + best-effort](../../src/__tests__/container/index.test.ts), [drainFinalSync + idle-stop drain](../../src/__tests__/container-metrics.test.ts), [awaitable endpoint + completion signal](../../host/__tests__/final-sync-endpoint.test.js)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/stores/session.test.ts (disposeSession on server-side stop describe -> calls disposeSession on running->stopped + no-op when stays running -> AC3) -->
### REQ-SESSION-012: Wake-loop prevention

<!-- @impl: src/container/index.ts -->
<!-- @impl: src/routes/terminal.ts -->
<!-- @impl: web-ui/src/stores/terminal.ts -->
<!-- @test: src/__tests__/container/index.test.ts (fetch gate - 503 when container not running describe → DO fetch gate + 4503 → AC1/AC4) -->
<!-- @test: src/__tests__/routes/terminal-ws.test.ts (terminal route describe → WS upgrade 503 when stopped → AC2/AC5) -->

**Intent:** A browser's automatic WebSocket reconnect must not wake a hibernated container in an infinite stop/start cycle.

**Applies To:** User

**Acceptance Criteria:**

1. When the container is not running, all non-internal requests receive 503 without waking the container.
2. WebSocket upgrade requests are rejected when the session is stopped (defense-in-depth).
3. The frontend detects running-to-stopped transitions and kills all WebSocket retry loops.
4. The server signals "container stopped" via a stable WebSocket close code.
5. The client treats the container-stopped close code as authoritative and does not retry; other close codes trigger automatic reconnection.

**Constraints:**

- Fresh terminal connections are only opened when the user explicitly starts the session again.
- An anti-flapping guard prevents stale running status from auto-initializing terminals for non-active sessions.

**Priority:** P1

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout), [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

### REQ-SESSION-013: Sleep timer countdown UI

<!-- @impl: web-ui/src/components/Dashboard.tsx -->
<!-- @impl: web-ui/src/components/Header.tsx -->

**Intent:** Users see how much idle time remains before their session hibernates.

**Applies To:** User

**Acceptance Criteria:**

1. Clock icon on session cards and header toolbar shows countdown.
2. Visible when < 10 min remaining.
3. Orange pulse at < 10 min, red at < 5 min.
4. Hidden for stopped sessions.
5. Computed from the configured idle timeout minus elapsed idle time.

**Notes:** Sleep timer countdown UI is validated manually per the checklist in [documentation/lanes/troubleshooting.md](../../documentation/lanes/troubleshooting.md).

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/sleep-timer.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014 describe -> SleepAfterOptions exactly [5m,15m,30m,1h,2h] + all 5 accepted + invalid rejected (AC1) + resolveEffectiveSleepAfter free->15m, paid/admin/unlimited honor stored, default 30m (AC2) + PATCH /preferences for admins/paying users (AC3) + KV persist + GET/PATCH round-trip (AC4) -> AC1..AC4) -->
### REQ-SESSION-014: User-configurable auto-sleep timeout in Settings

<!-- @impl: src/routes/preferences.ts -->
<!-- @impl: src/container/index.ts -->
<!-- @impl: src/routes/container/lifecycle.ts::resolveEffectiveSleepAfter -->
<!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014 AC1/AC2/AC3/AC4 describes -> 5 valid options + free-tier lock + admin/paying mutation + KV persistence) + src/__tests__/routes/preferences.test.ts (GET /preferences describe -> AC4 KV preference contract) -->

**Intent:** Users choose how long their sessions stay alive when idle.

**Applies To:** User

**Acceptance Criteria:**

1. Settings dropdown with 5 options (5m, 15m, 30m, 1h, 2h).
2. Free tier locked to 15m with upgrade hint.
3. Admins and paying users can change.
4. Value saved to KV preferences and applied on next session start.

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** [Integration test](../../src/__tests__/routes/session-sleep-timeout.test.ts)

**Status:** Implemented

---

### REQ-SESSION-015: Container Port-Readiness Gating with Pre-Warm Pre-Condition

<!-- @impl: host/src/server.ts -->
<!-- @impl: host/src/prewarm-config.ts -->
<!-- @impl: entrypoint.sh -->
<!-- @test: host/__tests__/prewarm-readiness.test.js (1013 reject + init-flag gate → AC2) -->
<!-- @test: src/__tests__/container/index.test.ts (DO-side prewarm contract → AC1) -->
<!-- @test: host/__tests__/entrypoint-pi-warmup-guard.test.js (REQ-SESSION-015 describe → guarded warm-up calls still reach init-flag write on failure + regression sentinel that unguarded form aborts before flag → Constraints fault-containment invariant) -->

**Intent:** A new container must bind its serving port quickly so Cloudflare's port-wait check succeeds, yet must refuse real terminal traffic until initial state restore and pre-warm are complete; the readiness gate sits between the port bind and the first accepted WebSocket upgrade.

**Applies To:** User

**Acceptance Criteria:**

1. The serving port binds within Cloudflare's container port-wait window even while initialization (R2 sync, MCP config merges) is still in progress. <!-- @impl: entrypoint.sh -->
2. The entrypoint writes an init-complete signal only after initial sync, file modifications, and tab-autostart configuration have completed. <!-- @impl: entrypoint.sh -->
3. Tab-1 PTY pre-warm is gated on the init-complete signal, so it never starts before initial state restore is in place. <!-- @impl: host/src/server.ts -->
4. The host terminal server rejects terminal WebSocket upgrades with a retriable ("try again later") close code and a human-readable container-warming reason until both the init-complete signal is observed and the pre-warm session is registered. <!-- @impl: host/src/server.ts -->

**Constraints:**

- The container must not signal readiness (PTY pre-warm complete) until the initial sync either succeeds or times out.
- Best-effort setup steps that run before the init-complete flag (agent npm warm-up, fast-start suppression) must be guarded so their failure cannot abort the entrypoint under `set -euo pipefail`; a degraded warm-up is preferable to PID 1 dying before the flag is written.

**Priority:** P0

**Dependencies:** [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** [Automated test](../../host/__tests__/prewarm-readiness.test.js)

**Status:** Implemented

---

### REQ-SESSION-016: User timezone propagated from preferences to container env

<!-- @impl: src/routes/preferences.ts -->
<!-- @impl: src/container/container-env.ts -->
<!-- @impl: web-ui/src/components/Dashboard.tsx -->
<!-- @test: src/__tests__/routes/preferences.test.ts (preferences endpoint describe → userTimezone validation + persistence → AC1/AC2) -->
<!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars describe → USER_TIMEZONE injection on restart → AC3/AC4) -->
<!-- @test: web-ui/src/__tests__/lib/timezone-sync.test.ts (browser-side resolution + best-effort PATCH → AC5) -->

**Intent:** The capture pipeline and any other consumer of `$USER_TIMEZONE` inside the container must receive the user's IANA timezone choice without manual env-var configuration; the preference is set via the preferences API and persists across restarts.

**Applies To:** User

**Acceptance Criteria:**

1. The preferences endpoint accepts an optional user-timezone field (valid IANA timezone string, max 64 characters); invalid zones are rejected with a validation error.
2. The session persistently stores the user's timezone preference.
3. Subsequent container starts inject the user's timezone preference into the container environment; if unset, the entrypoint falls back to the container default and finally to UTC.
4. A timezone change takes effect on the next session start (no live re-injection into a running container).
5. On Dashboard mount, the frontend reads the browser's IANA timezone and updates the stored preference (best-effort) when the resolved zone differs; a failed update never blocks the mount.

**Constraints:**

- Validation uses a runtime IANA-zone round-trip rather than a static zone allowlist, so the validator stays accurate as the IANA database evolves.
- The field is optional; absence is silently treated as "use the entrypoint fallback chain", not an error.

**Priority:** P1

**Dependencies:** [REQ-SESSION-014](#req-session-014-user-configurable-auto-sleep-timeout-in-settings) (preferences flow), [REQ-MEM-010](memory.md#req-mem-010-memory-capture-hook-plumbing) AC4 (the capture pipeline consumes the resulting env var)

**Verification:** [Automated test](../../src/__tests__/routes/preferences.test.ts)

**Status:** Implemented

---

### REQ-SESSION-017: Container health and startup-status API

<!-- @impl: src/routes/container/status.ts -->
<!-- @test: src/__tests__/routes/container-status.test.ts (Container Status Routes / REQ-SESSION-017 describe -> health success/500 + startup-status stage progression + sync-failed/skipped + caught-error -> AC1-AC5) -->

**Intent:** The dashboard needs a non-blocking way to learn whether a user's container is up and, while it is coming up, how far through initialization it has progressed, so the loading experience reflects real container state instead of a fixed timer.

**Applies To:** User

**Acceptance Criteria:**

1. `GET /api/container/health` reports whether the user's container is running and healthy, returning its metrics on success and an error with 500 when the health check fails. <!-- @impl: src/routes/container/status.ts -->
2. `GET /api/container/startup-status` returns the current initialization stage without blocking, carrying a stage label, a 0-to-100 progress value, and a human-readable message. <!-- @impl: src/routes/container/status.ts -->
3. The reported stage reflects real container state: `stopped` when state is indeterminate, `starting` before services respond, `syncing` during the initial R2 sync, `verifying` after sync while terminals are not yet up, `mounting` during terminal pre-warm, and `ready` when all services are up. <!-- @impl: src/routes/container/status.ts -->
4. A failed initial R2 sync surfaces as an error stage carrying the sync error, while a skipped sync (no R2 credentials) still reaches the ready stage with the skip reason reported. <!-- @impl: src/routes/container/status.ts -->
5. An unexpected failure while computing startup status is caught and returned as an error stage rather than propagating an unhandled 500. <!-- @impl: src/routes/container/status.ts -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-SESSION-015](#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition)

**Verification:** [Automated test](../../src/__tests__/routes/container-status.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/container-metrics.test.ts (collectMetrics describe -> writes status=stopped to KV only after the not-running confirmation window (catch-all) -> AC1) -->
<!-- @test: src/__tests__/container-metrics.test.ts (collectMetrics describe -> does not flip a live session to stopped on a single transient not-running tick -> AC2) -->
<!-- @test: src/__tests__/container/index.test.ts (onStop lifecycle describe -> onStop updates KV with lastActiveAt and sets status to stopped -> AC1) -->
### REQ-SESSION-018: Persisted status is authoritative on container exit

<!-- @impl: src/container/container-metrics.ts::collectMetrics -->
<!-- @impl: src/container/container-metrics.ts::openNotRunningConfirmation -->
<!-- @impl: src/container/container-lifecycle.ts::onError -->
<!-- @impl: src/container/index.ts::onError -->
<!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 describe > onStop lifecycle > onError opens the not-running confirmation window and re-arms instead of writing stopped -> AC3) -->
<!-- @test: src/__tests__/container-metrics.test.ts (collectMetrics describe -> skips the metrics write when stopped AND the persisted shutdown marker is set (clobber-race guard) -> AC4 deliberate-stop guard; re-asserts running when the container is alive but KV reads stopped and no shutdown marker is set (self-heal) -> AC4 self-heal) -->

**Intent:** Session status in KV is the single source of truth. A container that exits for any reason writes `stopped` to its KV record, so the dashboard ([REQ-SESSION-010](#req-session-010-session-status-observable-from-dashboard)) reflects reality directly from the record without any read-side staleness guess. Conversely, a container that is demonstrably alive is never left showing stopped: the not-running signal is treated as authoritative only after it is confirmed, and a status that was wrongly flipped to stopped is self-healed back to running.

**Applies To:** User

**Acceptance Criteria:**

1. A container that exits for any reason (graceful stop, crash, or an SDK-surfaced error) transitions its KV status to stopped, and the dashboard reads status directly from the record with no read-side staleness reconciliation. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/index.ts::onError -->
2. The `collectMetrics` catch-all writes stopped only after the container reads not-running across a confirmation window spanning more than one alarm tick, so a single transient not-running reading never flips a live session to stopped. <!-- @impl: src/container/container-metrics.ts::collectMetrics -->
3. On a not-running reading `onError` does not write stopped; it opens the same confirmation window and re-arms a `collectMetrics` tick, deferring the stopped decision to that window. <!-- @impl: src/container/container-lifecycle.ts::onError --> <!-- @impl: src/container/container-metrics.ts::openNotRunningConfirmation -->
4. When the container is demonstrably running (running branch after a successful `/health` probe) but KV reads stopped, `collectMetrics` re-asserts running, unless a persisted shutdown-requested marker shows a deliberate stop is in flight. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/container-lifecycle.ts::destroy -->

**Constraints:**

- The not-running confirmation window and the deliberate-stop marker are persisted in DO storage (not in-memory), so a hibernation or mid-shutdown eviction cannot discard them; `destroy()` sets the marker before clearing identifiers and `onStart` clears it.
- Newly started sessions have a 3-minute startup guard during which only the container-stopped close code can transition them to stopped (anti-flapping).
- A genuine crash converges to stopped after the confirmation window (one to a few alarm ticks) rather than immediately, accepted as the price of never flipping a live session to stopped.
- Accepted residual: a tick landing in the sub-millisecond gap between the user-stop KV write and `destroy()` persisting the marker can self-heal the just-stopped session for a single tick before `destroy()` settles it back to stopped; the idle-stop path is immune.

**Priority:** P1

**Dependencies:** [REQ-SESSION-010](#req-session-010-session-status-observable-from-dashboard)

**Verification:** [collectMetrics catch-all](../../src/__tests__/container-metrics.test.ts), [onError / onStop lifecycle](../../src/__tests__/container/index.test.ts)

**Status:** Implemented
