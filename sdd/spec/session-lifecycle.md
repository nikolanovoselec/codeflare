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

<!-- @impl: entrypoint.sh::shutdown_handler -->
<!-- @impl: src/container/index.ts -->
<!-- @impl: Dockerfile -->

**Intent:** When a container stops (idle timeout or user-initiated), a final bidirectional sync to R2 runs before process termination, ensuring no data loss.

**Applies To:** User

**Acceptance Criteria:**

1. The container entrypoint catches graceful-stop signals.
2. The trap handler terminates the background sync daemon using a durable PID record.
3. A final bidirectional sync runs before the terminal server is terminated; deletion safeguards prevent accidental mass deletion.
4. The shutdown sync runs even when the initial sync timed out.
5. The container image declares a stop signal the entrypoint can trap.
6. User-initiated stop and delete reach the trap via a graceful shutdown that polls for the trap to exit before forcing termination.
7. Idle-timeout and quota-eviction paths reach the trap via the same graceful-shutdown signal.

**Constraints:**

- The sync daemon's PID record is the sole mechanism for shutdown; no in-memory fallback exists.
- No invocation path goes straight to forced termination while the container is still running; the graceful signal + poll is always the precursor.

**Priority:** P0

**Dependencies:** [REQ-SESSION-003](#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** [Integration test](../../host/__tests__/entrypoint-shutdown.test.js)

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

1. The terminal server's tab-1 PTY pre-warm is gated on an init-complete signal written by the entrypoint after initial sync, file modifications, and tab autostart configuration complete; this preserves the readiness contract while letting the serving port bind before Cloudflare's container port-wait timeout.
2. The host terminal server rejects terminal WebSocket upgrades with a retriable close code (the WebSocket "try again later" class) and a human-readable container-warming reason until both the init-complete signal is observed AND the pre-warm session is registered; this is the host-side guard against reconnects landing before shell autostart is in place.

**Constraints:**

- The terminal server must bind its serving port within Cloudflare's container port-wait window; slow initialization (R2 sync, MCP config merges) must not block the port bind.
- The container must not signal readiness (PTY pre-warm complete) until the initial sync either succeeds or times out.
- Any best-effort setup step executed before the init-complete flag is written (e.g. agent npm dependency warm-up, fast-start update suppression) must be guarded so that its failure does not abort the entrypoint under `set -euo pipefail`; a degraded warm-up is always preferable to PID 1 dying before the flag is written.

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
5. On Dashboard mount, the frontend reads the browser's IANA timezone and updates the stored preference when the resolved zone differs. The sync is best-effort: failures never block the mount path so a transient API error cannot strand the Dashboard.

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
3. The reported stage reflects real container state: stopped when the container state cannot be determined, starting while the container exists but its services are not yet responding, syncing while the initial R2 sync runs, verifying after sync while terminal sessions are not yet responding, mounting while the terminal pre-warms, and ready when all services are up. <!-- @impl: src/routes/container/status.ts -->
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
<!-- @test: src/__tests__/container/index.test.ts (onStop lifecycle describe -> onError updates KV with status stopped (unexpected exit dangling-running guard) -> AC1) -->
<!-- @test: src/__tests__/container/index.test.ts (onStop lifecycle describe -> onStop updates KV with lastActiveAt and sets status to stopped -> AC1) -->
### REQ-SESSION-018: Persisted status is authoritative on container exit

<!-- @impl: src/container/container-metrics.ts::collectMetrics -->
<!-- @impl: src/container/index.ts::onError -->

**Intent:** Session status in KV is the single source of truth. A container that exits for any reason writes `stopped` to its KV record, so the dashboard ([REQ-SESSION-010](#req-session-010-session-status-observable-from-dashboard)) reflects reality directly from the record without any read-side staleness guess.

**Applies To:** User

**Acceptance Criteria:**

1. Persisted status is authoritative: a container that exits for any reason - graceful stop, crash, or an unexpected exit surfaced by the SDK as an error - transitions the persisted status to stopped, so the dashboard reflects reality directly from the KV record with no read-side staleness reconciliation. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/index.ts::onError -->
2. The `collectMetrics` catch-all does not flip a live session to stopped on a transient not-running reading. The SDK's `ctx.container.running` flag momentarily reads false when an alarm wakes a hibernated DO or during a deploy-roll, while the container is actually alive; the catch-all writes stopped only after the container has read not-running continuously for a confirmation window spanning more than one alarm tick, re-arming the alarm meanwhile so the streak can be observed. A single transient false reading therefore leaves the running session intact rather than both kicking the user to the dashboard and freezing metrics. `onError` remains the immediate authority for genuine crashes. <!-- @impl: src/container/container-metrics.ts::collectMetrics -->

**Constraints:**

- Newly started sessions have a 3-minute startup guard during which only the container-stopped close code can transition them to stopped (anti-flapping).
- The `collectMetrics` not-running confirmation window is persisted in DO storage (not in-memory), because the hibernation/reset that produces the transient false reading would discard an in-memory streak counter.

**Priority:** P1

**Dependencies:** [REQ-SESSION-010](#req-session-010-session-status-observable-from-dashboard)

**Verification:** [collectMetrics catch-all](../../src/__tests__/container-metrics.test.ts), [onError / onStop lifecycle](../../src/__tests__/container/index.test.ts)

**Status:** Implemented
