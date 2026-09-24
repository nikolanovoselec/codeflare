# Session Lifecycle

Container creation, idle detection, auto-sleep, restart, and destroy.

**Domain owner:** Backend (Worker + Container DO)

### Key Concepts

- **Session** -- A named, user-owned workspace whose complete non-secret record and shared lifecycle truth are stored in D1 and whose isolated runtime is controlled by one Container Durable Object.
- **Lifecycle generation** -- A D1-assigned start epoch. Delayed work from an older generation cannot mutate or terminate a replacement generation.
- **Observation sequence** -- A strictly increasing, generation-local Durable Object sequence used to reject delayed runtime projections.
- **Unreachable incident** -- A D1-owned transport-failure episode with one identity, first-observed time, and absolute 120-second termination-eligibility deadline.
- **ACTIVE / IDLE** -- Device-local terminal presentation derived from the local WebSocket; neither is a persisted backend state.
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

### REQ-SESSION-001: Session creation with complete D1 record

**Intent:** A user can create a named session with an immutable workspace configuration as a complete D1-owned record.

**Applies To:** User

**Acceptance Criteria:**

1. Creation accepts a trimmed name and optional supported AI agent type.
2. Each session receives a unique valid lowercase alphanumeric ID.
3. One complete non-secret D1 row durably stores owner, name, configuration, timestamps, lifecycle fencing and runtime projection fields.
4. A missing workspace value resolves to Terminal and the immutable terminal/workspace stamps cannot be patched by clients.
5. Creation returns 201 with lifecycle `stopped`, generation zero and an ordered revision; it does not start a container or consume running capacity.
6. Creation remains rate-limited and storage quota is checked in SaaS mode.

**Constraints:** Secrets remain in their established stores. Session records are never written to KV.

**Priority:** P0

**Dependencies:** [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** Planned D1 creation, validation and workspace tests.

**Status:** Planned

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
3. An initial sync from persistent storage to the workspace settles before ordinary terminal traffic is released, with a shipped 120-second safety timeout; timeout records degraded restore and allows bounded startup to continue. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @manual: Stall the R2 source and confirm initial sync leaves its blocking phase after 120 seconds before bounded host fallback can release terminal traffic. -->
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
4. The container is stopped once the user-configured idle threshold is exceeded; the host-side per-PTY keepalive is a separate safety net floor-clamped at the maximum idle timeout (see [AD47](../../documentation/decisions/README.md#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy)). <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) --> <!-- @test: src/__tests__/container-metrics.test.ts (stops after genuine idle expiry from the persisted startup reference) -->
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

- If no input is ever received, idle time is measured from a valid durable container-start reference.
- A container with an open terminal but no typing stops after the configured idle timeout has elapsed from that reference.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SESSION-006: User can start, stop, restart and delete sessions

**Intent:** Explicit lifecycle mutations are ordered by D1 authority and preserve graceful process control.

**Applies To:** User

**Acceptance Criteria:**

1. An accepted Start advances generation once, writes `starting`, and assigns that generation to the Durable Object before process work begins.
2. Start fails closed when D1 authority is unavailable, a termination intent is outstanding, or capacity validation rejects it.
3. Stop conditionally claims `stopping` for the current generation, performs established graceful destruction, and reaches `stopped` only after a generation-fenced positive process-exit monitor observation or awaited destruction that confirms exit. An old `stopping` transition alone cannot release ownership. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session-stop-delete.test.ts (returns failure and preserves retryable state when destruction is unconfirmed) --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-035: old stopping remains owner-scoped and retains managed-mutation ownership without exit evidence) -->
4. Restart preserves the same D1 session row, workspace and storage identity while applying current preferences in a new generation.
5. Delete uses the same confirmed graceful destruction path and hard-deletes the D1 row only after exit; delayed writers cannot recreate it.
6. Failed or ambiguous destruction retains retryable authoritative state and does not report stopped or deleted.
7. The frontend retains mounted workspace state through uncertainty and disposes it only after newer authoritative stopping/stopped or successful deletion evidence.

**Constraints:** Existing final agent-event drain, final sync, teardown ceilings and storage durability remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record), [REQ-SESSION-002](#req-session-002-one-container-per-session-isolation)

**Verification:** Planned start/stop/delete, ambiguous-result and frontend lifecycle tests.

**Status:** Planned

---

### REQ-SESSION-027: User can rename sessions

**Intent:** A user can change a session's display name without affecting its runtime or workspace.

**Applies To:** User

**Acceptance Criteria:**

1. Rename is available for running and stopped sessions regardless of how the existing name was assigned. <!-- @impl: web-ui/src/components/SessionContextMenu.tsx::SessionContextMenu --> <!-- @test: web-ui/src/__tests__/components/SessionContextMenu.test.tsx (REQ-SESSION-027 AC1: Rename action) --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (REQ-SESSION-027 AC1: rename) -->
2. After rename succeeds, the user sees the server-accepted name. <!-- @impl: web-ui/src/stores/session.ts::renameSession --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-027 AC2: shows the name the server accepted, not the one typed) -->
3. A rejected rename leaves the session unchanged and presents the failure. <!-- @impl: web-ui/src/stores/session.ts::renameSession --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-027 AC3: should set error on API failure) -->

**Constraints:**

- Renaming never restarts a session or alters its workspace, repositories, or terminals.

**Priority:** P1

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** Automated test ([Integration test](../../web-ui/src/__tests__/stores/session.test.ts))

**Status:** Implemented

---

### REQ-SESSION-007: Workload-owning session count is limited per tier

**Intent:** Each Start performs best-effort capacity enforcement from the consistent D1 lifecycle projection without introducing an atomic reservation protocol.

**Applies To:** User

**Acceptance Criteria:**

1. Before Start, one owner-indexed D1 query counts other sessions in `starting`, `running`, `unreachable`, or `stopping`.
2. A count at or above the configured tier cap rejects Start; an explicit zero cap blocks it.
3. Existing SaaS tier limits, non-SaaS role defaults, deployment overrides and stress-test bypass remain unchanged.
4. Create in `stopped` does not consume capacity.
5. D1 query failure fails Start closed rather than using KV, SDK state or stale client data.
6. Enforcement remains best effort: concurrent Starts may both pass and exceed the nominal cap.

**Constraints:** Do not add stronger reservation guarantees. Session KV LIST/get operations are prohibited.

**Priority:** P1

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record)

**Verification:** Planned D1 capacity and concurrent-start tests.

**Status:** Planned

---

### REQ-SESSION-008: Container restart preserves R2 bucket

**Intent:** Restarting a session reconnects to the same R2 bucket, preserving all user files without data loss.

**Applies To:** User

**Acceptance Criteria:**

1. Restarting a session on the same workspace preserves the bucket association and applies any stored preference updates. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/preferences.test.ts (fastStartEnabled preference / REQ-SESSION-008 (fast-start preference persists across restart)) -->
2. Following restart, automatic idle detection remains active. <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @test: src/__tests__/container-metrics.test.ts (should call schedule(60, "collectMetrics") on start) -->
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

### REQ-SESSION-010: Session lifecycle is observable from one D1 projection

**Intent:** Devices share one strongly ordered backend lifecycle while terminal ACTIVE/IDLE remains local presentation.

**Applies To:** User

**Acceptance Criteria:**

1. Frequent batch status uses one owner-indexed primary-consistent D1 query, no session KV operation, no per-session query or container/SDK probe, and sends `no-store` semantics.
2. Responses return complete session projections with lifecycle, generation, revision, readiness, incident/deadline, metrics and observation timestamps.
3. Clients apply responses monotonically by generation and revision so delayed success or failure cannot undo newer state.
4. For Terminal workspaces, backend `running` plus this device's connected terminal WebSocket renders green ACTIVE; without it, blue IDLE; neither label is persisted.
5. `starting` and `unreachable` use yellow recovery presentation and `stopped` is gray, while D1 read failure retains the last ordered state and shows a separate status-unavailable warning.
6. Polling is serialized, pauses while hidden, refreshes on visibility, and uses transition and stable cadences without overlapping requests.
7. Usage, storage, entitlement, managed-release, preseed and governed-migration work has a separate initial/slower/event-driven owner and retains last good values on failure.

**Constraints:** Dashboard polling never wakes a container. Authentication and revocation middleware may retain unrelated KV use.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record), [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced)

**Verification:** Planned backend query-budget, frontend ordering and cross-device tests.

**Status:** Planned

---

### REQ-SESSION-011: Graceful shutdown with final sync

**Intent:** Deliberate stop paths complete one bounded live workspace sync before terminating the container; the SIGTERM trap remains only a best-effort backstop.

**Applies To:** User

**Acceptance Criteria:**

1. Before signalling the container to stop, every deliberate stop path runs a live bidirectional R2 sync to completion while the container is still fully running including a delete where the platform reports `running:false` transiently. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-lifecycle.ts::drainFinalSyncAudited --> <!-- @impl: src/container/container-lifecycle.ts::recordFinalSyncAudit --> <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
2. For runnable sync, the final-sync endpoint starts and awaits its own run, distinguishing success, failure and timeout. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (REQ-SESSION-011 AC2: final-sync HTTP boundary (behavioral)) -->
3. The sync-status record carries a monotonic timestamp and a `syncing`->`success`/`failed` transition, and the endpoint accepts a terminal status only after observing its own run's `syncing` (stamped strictly after the trigger), never a bare `success`. <!-- @impl: host/src/final-sync.ts::FinalSyncEval --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (REQ-SESSION-011 AC2/AC3: evaluateFinalSync completion detection (behavioral)) -->
4. The Durable Object waits up to a bounded sync budget (120s) for the live sync to report completion; a failed or timed-out sync still proceeds to stop rather than blocking teardown. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (destroy) -->
5. Total teardown is hard-capped from `destroy()` entry: every awaited teardown stage consumes the same 135s deadline, so storage, sync, stop, or provider stalls cannot extend the operation. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
6. User stop and user delete behave identically: both route through the same graceful-destroy path, and idle-timeout and quota-eviction paths drain through the same endpoint before stopping. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-011 AC6 / REQ-SESSION-032 AC1: quota-stop drains final agent events, then final sync, then stop) -->
7. The SIGTERM trap is retained as a best-effort backstop final sync for paths that bypass the orchestrated drain, but is no longer the primary guarantee (see [REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync) for the trap's own constraints). <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) -->

**Constraints:**

- The authoritative sync runs while the container is alive; post-SIGTERM grace is not its completion mechanism.
- The final-sync endpoint timeout exceeds the DO's 120-second drain budget.
- Successful completion requires this run's `syncing` state before its terminal state.
- A [persisted disk blocker](storage.md#req-stor-044-disk-space-failure-visibility) is reported without starting a new run; an in-memory-only block may time out.
- The container image retains a trappable stop signal.

**Priority:** P0

**Dependencies:** [REQ-SESSION-003](#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** Automated test ([drainFinalSync and idle-stop drain](../../src/__tests__/container-metrics.test.ts), [awaitable endpoint and completion signal](../../host/__tests__/final-sync-endpoint.test.js))

**Status:** Implemented

---

### REQ-SESSION-032: Final notification drain precedes shutdown sync

**Intent:** Deliberate stop paths give pending away notifications one bounded final attempt before final workspace sync and container stop.

**Applies To:** User

**Acceptance Criteria:**

1. Idle, quota, Stop, and Delete invoke one independently bounded final agent-event drain before final sync. <!-- @impl: src/container/container-metrics.ts::drainAgentEventsBeforeStop --> <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-011 AC6 / REQ-SESSION-032 AC1: quota-stop drains final agent events, then final sync, then stop) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-032 AC1: calls final agent-event drain, then final sync, then stop) --> <!-- @test: src/__tests__/container/lifecycle.test.ts (REQ-SESSION-032 AC1/AC4-AC5: destroy preserves credentials, drains before sync, and clears storage) -->
2. A final drain makes unresolved client decisions eligible for fallback before reading events. <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @test: host/__tests__/agent-events.test.js (final drain atomically promotes pending and awaiting-confirmation events) -->
3. Exhausted transport uncertainty neither drains final events nor signals a possibly surviving workload; the lifecycle remains owning until exit is confirmed. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-022 AC6: exhausted uncertainty cannot signal or release a surviving workload) -->
4. Teardown preserves the lifecycle Bearer and session ID until the final event request is built, then clears stored state. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/lifecycle.test.ts (REQ-SESSION-032 AC1/AC4-AC5: destroy preserves credentials, drains before sync, and clears storage) -->
5. Final event delivery consumes the teardown deadline without reducing the reserved final-sync budget. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/lifecycle.test.ts (REQ-SESSION-032 AC1/AC4-AC5: destroy preserves credentials, drains before sync, and clears storage) -->
6. A failed final event drain still permits final sync and container stop. <!-- @impl: src/container/container-metrics.ts::drainAgentEventsBeforeStop --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-032 AC6: an event-drain failure still runs final sync and stop) -->
7. A failed final sync preserves the completed event attempt and still permits container stop. <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-032 AC7: final-sync failure preserves the event attempt and still stops) -->

**Constraints:**

- Final order is agent-event drain, R2 sync, then stop.
- Failed or timed-out drains still proceed within the 135-second teardown ceiling.

**Priority:** P0

**Dependencies:** [REQ-SESSION-011](#req-session-011-graceful-shutdown-with-final-sync), [REQ-TERM-023](terminal.md#req-term-023-away-only-agent-notification-delivery), [REQ-SEC-024](security.md#req-sec-024-agent-notification-delivery-trust-boundaries)

**Verification:** Automated test ([destroy ordering](../../src/__tests__/container/lifecycle.test.ts), [idle and quota ordering](../../src/__tests__/container-metrics.test.ts))

**Status:** Implemented

---

### REQ-SESSION-028: Session authority has no KV compatibility path

**Intent:** After clean-slate cutover, all session catalog and lifecycle behavior uses D1 without migration or shadow state.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. Session CRUD, discovery, status, metrics, admission, terminal/editor authorization, sync fanout, managed reconciliation and user cleanup perform no session KV LIST/get/write.
2. There is no legacy-session import, backfill, dual write, shadow projection, fallback read or reverse migration.
3. Session-specific KV helpers and list metadata types are removed or narrowed so unrelated KV data remains intact.
4. A stopped session remains an ordinary D1 row until Delete hard-deletes it.
5. Post-cutover rollback uses a reviewed D1-compatible build or forward fix and never a KV-only Worker.

**Constraints:** Credentials, preferences, configuration, entitlements, managed releases, storage caches and unrelated records remain in existing stores.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record)

**Verification:** Planned negative-path and repository-wide session-KV audit tests.

**Status:** Planned

---

### REQ-SESSION-029: Ordered client state retains last good authority

**Intent:** Concurrent loads and D1 outages cannot replace newer lifecycle context or mounted workspaces with stale data or errors.

**Applies To:** User

**Acceptance Criteria:**

1. Session responses are applied only when their generation/revision pair is newer than or equal to the client's accepted pair under the defined monotonic ordering.
2. A stale list or status success has no observable effect.
3. A stale failure cannot replace the latest request's availability state.
4. D1 read failure retains last good session records, metrics and ancillary values and presents a distinct status-unavailable warning.
5. Read failure does not remove sessions, dispose terminal/editor state, or synthesize lifecycle transitions.
6. Background polling remains serialized by a one-request-in-flight guard.

**Constraints:** Transport unreachability and D1 status unavailability are separate notices and state machines.

**Priority:** P0

**Dependencies:** [REQ-SESSION-010](#req-session-010-session-lifecycle-is-observable-from-one-d1-projection)

**Verification:** Planned concurrent-load, delayed-response and outage tests.

**Status:** Planned

---

### REQ-SESSION-030: Clean-slate D1 admission is live on deployment

**Intent:** A D1-only deployment admits new sessions immediately without importing, reading, or deleting legacy KV session records.

**Applies To:** User

**Acceptance Criteria:**

1. The additive D1 migrations apply safely before the reviewed D1-only Worker and matching image are admitted. <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 --> <!-- @test: src/__tests__/ci/usage-d1-deploy.test.ts (creates one absent database with supported Wrangler arguments, resolves its ID, then applies migrations) -->
2. Create and Start admission is open in every environment immediately after deployment. <!-- @impl: src/lib/session-repository.ts::D1SessionRepository.create --> <!-- @impl: src/lib/session-repository.ts::D1SessionRepository.start --> <!-- @test: src/__tests__/lib/session-cutover.test.ts (opens Create and Start admission when the deployment completion migration runs) -->
3. Legacy KV session records have no authority, compatibility read, migration, or automatic deletion path. <!-- @impl: src/lib/session-repository.ts::D1SessionRepository --> <!-- @test: src/__tests__/lib/session-cutover.test.ts (opens D1 admission when the deployment completion migration runs) -->

**Constraints:** The D1 authority starts clean; deployment never blocks a new session on legacy-session quiescence or cleanup.

**Priority:** P0

**Dependencies:** [REQ-SESSION-028](#req-session-028-session-authority-has-no-kv-compatibility-path)

**Verification:** Automated D1 deployment, migration, and session-admission tests.

**Status:** Planned

---

### REQ-SESSION-012: Transport retry never invents lifecycle state

**Intent:** Browser reconnect and container forwarding preserve recoverable transport uncertainty without waking or disposing a surviving runtime.

**Applies To:** User

**Acceptance Criteria:**

1. Non-internal requests cannot auto-start a non-running container. After authenticated owner-scoped D1 authorization, a verified surviving workload may be forwarded through no-start even after coordinator reconstruction; SDK `running` is not definitive live-process evidence.
2. WebSocket upgrades receive authoritative 4503 only from current D1 `stopping` or `stopped` evidence; transient forwarding failures remain retryable.
3. During `unreachable`, terminal/editor objects, buffers, tabs, selection, tiling and scrollback stay mounted while retries use bounded jitter.
4. Recovery reconnects to the verified existing process without invoking Start or allocating a new generation. Terminal WebSocket upgrades cross the Durable Object boundary through native stub `fetch` (not an RPC-serialized WebSocket response), while the object forwards only to the existing private port. Absent or unverified runtime returns retryable 1013 without forwarding or unsanctioned rate-limit writes; authoritative D1 `stopping`/`stopped` still closes 4503. <!-- @impl: src/container/index.ts::fetch --> <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-012 AC4: native terminal fetch probes only the existing port when SDK state is stale) --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (REQ-SESSION-012 AC4: a surviving runtime with stale SDK stopped state forwards health and authenticated terminal without starting) -->
5. Client countdown expiry changes messaging only and cannot declare stopped or dispose the workspace.
6. D1 read failure retains transport state and shows status unavailable; it never synthesizes `unreachable` or `stopped`.

**Constraints:** Disposal requires newer authoritative stopping/stopped evidence or explicit successful deletion.

**Priority:** P0

**Dependencies:** [REQ-SESSION-010](#req-session-010-session-lifecycle-is-observable-from-one-d1-projection), [REQ-SESSION-021](#req-session-021-complete-transport-failure-opens-one-unreachable-incident)

**Verification:** Planned WebSocket, D1 outage and mounted-workspace tests.

**Status:** Planned

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
3. Admins can change the timeout regardless of subscription tier; non-admin paying users can change it while free users remain locked. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::canChangeSleepAfter --> <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014 AC3: admins and paying users can change sleepAfter) -->
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
2. The entrypoint writes an init-complete signal only after initial sync, file modifications, and tab-autostart configuration have completed. <!-- @test: host/__tests__/entrypoint-pi-warmup-guard.test.js (guarded warm-up call from entrypoint.sh still reaches the init-flag write when it fails) --> <!-- @manual -->
3. Terminal pre-warm waits up to 130 seconds for initialization, then starts the stamped Classic or Herdr surface; timeout proceeds in degraded state. <!-- @impl: host/src/server.ts::waitForInitFlag --> <!-- @manual: Hold back the init-complete signal and confirm pre-warm remains gated until the 130-second bound, then starts with `/health.initFlagObserved` still false. -->
4. The host rejects terminal WebSocket upgrades with retriable close code 1013 and a warming reason until pre-warm registers. <!-- @impl: host/src/server.ts::terminalServiceReady --> <!-- @impl: host/src/terminal-ws.ts::attachTerminalConnectionHandler --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (container-warming-up gate (PR #365) / REQ-SEC-020 AC3 (1013 close BEFORE WS rate-limit while readiness is unverified)) -->
5. Pre-warm registration normally follows initialization; after the 130-second bound, degraded startup may register without requiring `initFlagObserved`. <!-- @impl: host/src/server.ts::waitForInitFlag --> <!-- @manual: Hold back the init-complete signal and confirm degraded startup registers after the 130-second bound with `/health.initFlagObserved` still false. -->
6. The image bakes a pre-transpiled cache for the full Pi extension set, with package extensions derived from the preseed manifest. <!-- @impl: Dockerfile::PI_WARM_PACKAGES --> <!-- @manual -->
7. The image build fails if the transpile cache is empty or a required package extension is absent. <!-- @impl: Dockerfile::goal_hit --> <!-- @manual -->

**Constraints:**

- Container readiness waits for sync success, sync timeout, or the host's 130-second degraded-start bound.
- Herdr also requires configured bootstrap detection, while Classic retains first-output settlement.
- Best-effort setup failures before the init-complete flag cannot abort the entrypoint.

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
5. A transient private health or sessions probe failure remains retryable as `starting` or `verifying`. <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (keeps startup retryable when the health fetch rejects during boot) --> <!-- @test: src/__tests__/routes/container-status.test.ts (keeps terminal verification retryable when the sessions fetch rejects) -->
6. Another unexpected startup-status computation failure is caught and returned as an error stage rather than propagating an unhandled 500. <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (returns error stage on unexpected exception) --> <!-- @manual -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-SESSION-015](#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition)

**Verification:** Automated test ([container-status](../../src/__tests__/routes/container-status.test.ts))

**Status:** Implemented

---

### REQ-SESSION-018: D1 lifecycle evidence is generation-fenced

**Intent:** D1 is the shared lifecycle authority, while the Durable Object owns process control and may project only observations belonging to its assigned execution generation.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. Persisted backend lifecycle is exactly `stopped`, `starting`, `running`, `unreachable`, or `stopping`; ACTIVE and IDLE are never persisted.
2. Creating a session inserts a complete D1 row in `stopped`; only an accepted Start advances its lifecycle generation and enters `starting`.
3. Runtime projection accepts a write only when its generation matches and its observation sequence is greater than the last accepted sequence.
4. Delayed callbacks retain their original generation and cannot mutate a replacement lifecycle; delayed writers use conditional `UPDATE` and cannot recreate a deleted row.
5. Every accepted mutation advances a response revision used with generation to order API responses.
6. A zero-change or ambiguous D1 result is not ownership proof; exceptional reconciliation uses one bounded read and remains fail closed.
7. Only a generation-fenced positive process-exit monitor observation or awaited destroy confirming exit writes `stopped`; transport failure, D1 failure, signal acceptance, elapsed time, an owner read, or SDK state does not. Uncertain exit preserves `stopping` and termination ownership. <!-- @impl: src/lib/session-repository.ts::D1SessionRepository.confirmStopped --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-SESSION-035: aged Stop ownership remains fenced until its current-generation exit is confirmed) -->

**Constraints:** D1 owns shared lifecycle truth. The Durable Object retains SDK/process identity, assigned generation, observation sequence and schedules, but not competing lifecycle business truth.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** Planned behavioral D1 repository, lifecycle and delayed-callback tests.

**Status:** Planned

---

### REQ-SESSION-033: Start callbacks preserve lifecycle ownership

**Intent:** Repeated or delayed start callbacks cannot disturb the current session lifecycle.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. A replay for an already-running generation preserves established lifecycle ownership. <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @test: src/__tests__/container-metrics.test.ts (preserves generation ownership and idle baseline on a duplicate onStart) -->
2. Stale or stopping start callbacks cannot clear lifecycle ownership or re-arm lifecycle work. <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @test: src/__tests__/container-metrics.test.ts (rejects a stale onStart replay without clearing shutdown ownership) --> <!-- @test: src/__tests__/container-metrics.test.ts (rejects a stopping onStart callback without clearing shutdown ownership) -->

**Constraints:** Same-generation replays and rejected stale or stopping callbacks do not project lifecycle transitions.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced)

**Verification:** Automated test ([container metrics](../../src/__tests__/container-metrics.test.ts))

**Status:** Implemented

---

### REQ-SESSION-035: Stale stopping retains ownership until confirmed exit

**Intent:** An interrupted Stop request remains visible and retryable without declaring a possibly live workload stopped.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. An owner batch-status read leaves `stopping` sessions in `stopping` regardless of age; it cannot turn elapsed time or SDK state into process-exit evidence. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-035: old stopping remains owner-scoped and retains managed-mutation ownership without exit evidence) -->
2. Old `stopping` rows retain termination and unreachable ownership, editor readiness, revision and transition reason until positive exit confirmation for their generation. <!-- @impl: src/lib/session-repository.ts::confirmStopped --> <!-- @impl: src/container/container-lifecycle.ts::confirmMonitoredExit --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-SESSION-035: aged Stop ownership remains fenced until its current-generation exit is confirmed) --> <!-- @test: src/__tests__/container/index.test.ts (confirms a running session only when its attached process monitor resolves) -->
3. A stopping row keeps managed-mutation ownership and cannot claim a replacement Start; other owners and lifecycle states remain unchanged. <!-- @impl: src/lib/session-helpers.ts::hasOwningSessionContainer --> <!-- @impl: src/lib/session-repository.ts::start --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-035: old stopping remains owner-scoped and retains managed-mutation ownership without exit evidence) --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-SESSION-035: aged Stop ownership remains fenced until its current-generation exit is confirmed) -->

**Constraints:** Applies to future sessions only; no existing-record repair or migration. Stale duration is diagnostic, not authority to clear a termination intent.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced)

**Verification:** Automated D1 repository and route tests.

**Status:** Implemented

---

### REQ-SESSION-034: Durable idle baseline survives coordinator reconstruction

**Intent:** A reconstructed coordinator cannot stop a healthy no-input container from invalid or unavailable startup timing evidence.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. For no-input idle timing, enforcement reuses a valid durable container-start reference after coordinator reconstruction; absent or invalid references initialize one durable fallback. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (persists one fallback baseline across a second coordinator reconstruction) --> <!-- @test: src/__tests__/container-metrics.test.ts (replaces non-finite persisted startup baselines) -->
2. Unreadable or unpersistable no-input timing evidence skips idle termination while observation and polling continue. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (does not authorize idle stopping when fallback baseline persistence fails) --> <!-- @test: src/__tests__/container-metrics.test.ts (keeps host transport healthy when startup-reference storage cannot be read) -->

**Constraints:** A valid expired idle reference remains eligible for termination under [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout).

**Priority:** P0

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout), [REQ-SESSION-005](#req-session-005-input-based-idle-detection)

**Verification:** Automated test ([container metrics](../../src/__tests__/container-metrics.test.ts))

**Status:** Implemented

---

### REQ-SESSION-019: Final-sync drain endpoint authentication

**Intent:** Every Durable-Object-side final-sync request must authenticate with the container token so teardown cannot lose the user's last edits at the host authorization boundary.

**Applies To:** User

**Acceptance Criteria:**

1. Every drain request authenticates with the container token; missing credentials suppress the request and record a bounded teardown audit. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-lifecycle.ts::drainFinalSyncAudited --> <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Constraints:** None.

**Priority:** P0

**Dependencies:** [REQ-SESSION-011](#req-session-011-graceful-shutdown-with-final-sync)

**Verification:** Automated test ([Drain auth on the delete path](../../src/__tests__/container/index.test.ts), [idle/quota-stop drain auth](../../src/__tests__/container/container-metrics-drain.test.ts))

**Status:** Implemented

---

### REQ-SESSION-020: Runtime observation is bounded and projected once

**Intent:** Metrics monitoring survives failed peers while normal projection uses one bounded host observation and one conditional D1 mutation.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. A normal metrics tick performs one bounded authenticated host observation containing classified input, CPU, memory, disk, sync and editor readiness. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (authenticates the private runtime observation probe) -->
2. After local policy decisions, a normal tick performs one conditional lifecycle D1 projection update and no normal-path D1 pre-read or readback; separately owned tracked-clones persistence is excluded. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (projects one lifecycle observation when no separate clone inventory is reported) -->
3. Every awaited host or peer operation is bounded and a failed peer cannot prevent the next eligible schedule from being armed. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-020 AC1-AC2: re-arms the alarm when an in-container poll never answers) -->
4. Host transport reachability, snapshot validity, readiness and confirmed process exit remain distinct evidence. <!-- @impl: src/container/container-metrics.ts::reconcileContainerTransport --> <!-- @test: src/__tests__/container-metrics.test.ts (does not flip a live session to stopped on a single transient not-running tick) -->
5. D1 projection failure cannot authorize reconstruction, termination, `unreachable`, or `stopped`. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (continues without transport recovery when the lifecycle projection fails) -->
6. Trusted identity, agent events, Timekeeper accounting and Durable Object storage remain separately owned and are excluded from the one-observation/one-update budget. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (D3/D4: notification polling never mutates activity or usage inputs) -->

**Constraints:** Existing idle-input policy, usage authority and final-sync deadlines remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced)

**Verification:** Automated test ([runtime-observation authentication](../../src/__tests__/container-metrics.test.ts), [bounded poll re-arm](../../src/__tests__/container-metrics.test.ts), [transport evidence](../../src/__tests__/container-metrics.test.ts), [unreachable policy](../../src/__tests__/lib/session-unreachable-policy.test.ts)).

**Status:** Implemented

---

### REQ-SESSION-021: Complete transport failure opens one unreachable incident

**Intent:** Host transport uncertainty becomes recoverable shared state without stopping or replacing the workload.

**Applies To:** User

**Acceptance Criteria:**

1. A complete bounded host-transport failure conditionally opens one incident for the current generation and persists `unreachable`, incident identity, first-observed time and an absolute deadline 120 seconds later.
2. Opening an incident occurs before Durable Object reset or reconstruction and leaves the container and PTY untouched.
3. Repeated failures join the existing incident and never move its first-observed time or deadline.
4. D1 failure is treated as persistence uncertainty and never opens a transport incident.
5. `unreachable` retains workload ownership, counts toward best-effort capacity and blocks destructive managed reconciliation.
6. Accelerated recovery work remains non-billable and does not create another quota or usage source.

**Constraints:** The deadline is earliest termination eligibility, not guaranteed exit time.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced), [REQ-SESSION-020](#req-session-020-runtime-observation-is-bounded-and-projected-once)

**Verification:** Planned bounded failure, D1 outage and ownership tests.

**Status:** Planned

---

### REQ-SESSION-022: Unreachable recovery preserves process identity

**Intent:** Coordinator reconstruction reattaches to the existing process and confirms recovery only from current-generation host evidence.

**Applies To:** User

**Acceptance Criteria:**

1. A reconstructed Durable Object performs one bounded primary-consistent D1 recovery read and adopts only its previously assigned generation, incident and absolute deadline.
2. Reconstruction probes the existing container through retained SDK/process identity and never invokes Start or allocates another generation.
3. A qualifying host response proves transport reachability; a valid snapshot separately determines whether metrics and activity may be projected.
4. Recovery conditionally clears the same incident and returns `unreachable` to `running` without replacing the container or PTY.
5. Reconstruction failure or another transport failure retains the same incident and deadline.
6. Old callbacks, alarms and reconstruction work cannot adopt a newer generation.

**Constraints:** Existing Durable Object reconstruction and PTY reattachment behavior is preserved.

**Priority:** P0

**Dependencies:** [REQ-SESSION-021](#req-session-021-complete-transport-failure-opens-one-unreachable-incident)

**Verification:** Planned reconstruction, process-identity and deadline-survival tests.

**Status:** Planned

---

### REQ-SESSION-023: Recovery and persistence uncertainty do not bill usage

**Intent:** Recovery probes and D1 reconciliation do not alter the user's usage or quota.

**Applies To:** User

**Acceptance Criteria:**

1. Accelerated transport-recovery probes add no billable usage and do not ping Timekeeper.
2. D1 persistence-reconciliation work adds no billable usage and does not change quota.
3. Unreachable time and stopping retries do not create a second accounting source.
4. Ordinary classified-input idle policy and Timekeeper authority remain unchanged.

**Constraints:** Accounting remains owned by the existing usage subsystem.

**Priority:** P0

**Dependencies:** [REQ-SESSION-021](#req-session-021-complete-transport-failure-opens-one-unreachable-incident)

**Verification:** Planned metrics accounting tests.

**Status:** Planned

---

<a id="req-session-024-transport-recovery-evidence-is-durable-and-observable"></a>

### REQ-SESSION-024: Recovery deadline and termination intent are durable

**Intent:** Recovery ownership survives coordinator replacement, and deadline expiry cannot target a replacement process.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. D1 retains incident identity, first-observed time, absolute deadline, lifecycle generation and termination intent until recovery or confirmed exit resolves them.
2. At the first available execution at or after the deadline, the current owner conditionally claims `stopping` for the same generation and incident.
3. Outstanding termination intent blocks Start until confirmed exit or a reviewed reconciliation resolves it.
4. Immediately before signalling, execution rechecks generation ownership and cannot signal a replacement generation.
5. Stop signalling uses the low-level SIGTERM path even when the SDK `running` flag is transiently false; retries are bounded and duplicate-safe.
6. Signal acceptance retains `stopping`; only a generation-fenced positive process-exit monitor observation or awaited destroy confirming exit transitions to `stopped`. <!-- @impl: src/lib/session-runtime-policy.ts::confirmProcessExit --> <!-- @test: src/__tests__/lib/session-unreachable-policy.test.ts (signal acceptance is not exit; confirmed matching exit alone reports stopped) --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-SESSION-035: aged Stop ownership remains fenced until its current-generation exit is confirmed) -->

**Constraints:** Exactly-once external signalling is not promised. Established final-event, final-sync and teardown deadlines are unchanged.

**Priority:** P0

**Dependencies:** [REQ-SESSION-022](#req-session-022-unreachable-recovery-preserves-process-identity)

**Verification:** Planned deadline, duplicate-signal, replacement-generation and confirmed-exit tests.

**Status:** Planned

---

### REQ-SESSION-025: Lifecycle recovery is observably correlated

**Intent:** Operators receive bounded, privacy-safe evidence for lifecycle transitions without high-volume normal-path logging.

**Applies To:** Operator

**Acceptance Criteria:**

1. Structured transition events identify lifecycle generation and unreachable incident when an incident opens, reconstruction begins, recovery succeeds, termination is claimed, SIGTERM fails or is accepted, final sync completes or fails, and exit is confirmed.
2. Reason classification distinguishes supported evidence for user, idle, quota, recovery-expiry, host-transport, D1-outage and platform/unknown paths without inventing an initiator.
3. Normal metrics ticks, individual WebSocket retries and unchanged state are not logged per occurrence.
4. Logs contain no credentials, tokens, transcript or terminal content, or per-file paths.
5. D1 row and statement metadata is sampled or aggregated during integration rather than emitted as another high-volume stream.

**Constraints:** Use the existing structured logger; no new telemetry framework.

**Priority:** P0

**Dependencies:** [REQ-SESSION-024](#req-session-024-recovery-deadline-and-termination-intent-are-durable)

**Verification:** Planned structured-event and negative-volume tests.

**Status:** Planned

---

### REQ-SESSION-026: Lifecycle scheduling and persistence failures remain actionable

**Intent:** Recovery work never reports success when required scheduling or authoritative persistence did not complete.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. Failure to schedule required recovery, reconciliation, termination or confirmed-exit work is logged with generation and incident identity and propagates to its lifecycle caller.
2. Failed authoritative mutations retain retryable ownership and cannot be converted into `stopped` or successful recovery.
3. Retry work is bounded, duplicate-safe and non-billable.
4. If lifecycle authority cannot be established, Start, Stop, Delete, migration and destructive reconciliation fail closed.

**Constraints:** A D1 failure and a host-transport failure remain distinct conditions.

**Priority:** P0

**Dependencies:** [REQ-SESSION-024](#req-session-024-recovery-deadline-and-termination-intent-are-durable)

**Verification:** Planned scheduling, ambiguous-write and fail-closed tests.

**Status:** Planned

---

---

### REQ-SESSION-031: D1 session schema stores complete ordered authority

**Intent:** One minimal owner-indexed D1 table stores complete non-secret session records and the fields needed for fenced lifecycle projection.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. The session table has primary key `(owner_key, session_id)` and complete API fields for name, creation/access timestamps, agent, workspace, terminal mode, tab configuration and clone intent. <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions -->
2. Lifecycle columns store state, generation, revision, last accepted observation sequence, transition timestamps, reason, readiness and readiness error under database checks. <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions -->
3. Projection columns store last classified input plus latest CPU, memory, disk, sync and observation time without retaining metric history. <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions -->
4. Incident columns store incident identity, first-observed time and absolute deadline; termination columns store intent identity, generation, claim and signal timestamps. <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions -->
5. The only required secondary index leads with `owner_key` and supports the batch ordering; frequently updated lifecycle or metric fields are not indexed. <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions -->
6. A singleton cutover table records `pending` or `complete`, and Create/Start require `complete`; its migration default is `pending`. <!-- @impl: src/lib/session-repository.ts::D1SessionRepository.create -->
7. The additive migration is idempotently managed by the existing `USAGE_DB` migration path and does not alter analytics tables. <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions -->

**Constraints:** Times are UTC ISO-8601 text except explicit millisecond deadlines where arithmetic is required. JSON configuration columns are validated at the typed repository boundary. Secrets are excluded.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced), [REQ-SESSION-030](#req-session-030-one-time-clean-slate-cutover-is-guarded-and-exact)

**Verification:** Planned migration-shape, constraint, index and rerun tests.

**Status:** Planned
