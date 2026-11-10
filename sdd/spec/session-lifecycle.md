# Session Lifecycle

Container creation, idle detection, auto-sleep, restart, and destroy.

**Domain owner:** Backend (Worker + Container DO)

Test-method and deployed-runtime evidence have distinct scope; see [Lifecycle evidence boundaries](../../documentation/lanes/container.md#lifecycle-evidence-boundaries).

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

<a id="req-session-001-session-creation-with-name-and-agent-type"></a>
### REQ-SESSION-001: Session creation with complete D1 record

**Intent:** A user can create a named session with an immutable workspace configuration as a complete D1-owned record.

**Applies To:** User

**Acceptance Criteria:**

1. Creation accepts a trimmed name and optional supported AI agent type. <!-- @impl: src/routes/session/crud.ts::CreateSessionBody --> <!-- @test: src/__tests__/routes/session-public-d1.test.ts (AC3/4/5 subsets: Create persists defaults and stopped generation zero; immutable PATCH preserves the row) -->
2. Each session receives a unique valid lowercase alphanumeric ID. <!-- @impl: src/lib/kv-keys.ts::generateSessionId --> <!-- @test: src/__tests__/lib/kv-keys.test.ts (generateSessionId) -->
3. One complete non-secret D1 row durably stores owner, name, configuration, timestamps, lifecycle fencing and runtime projection fields. <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-001 AC3 / REQ-SESSION-031 AC1: valid agent and six configured tabs retain complete nonsecret creation data) --> <!-- @impl: src/lib/session-repository.ts::create -->
4. A missing workspace value resolves to Terminal and the immutable terminal/workspace stamps cannot be patched by clients. <!-- @test: src/__tests__/routes/session-public-d1.test.ts (AC3/4/5 subsets: Create persists defaults and stopped generation zero; immutable PATCH preserves the row) --> <!-- @impl: src/routes/session/crud.ts::CreateSessionBody --> <!-- @impl: src/routes/session/crud.ts::UpdateSessionBody --> <!-- @impl: src/routes/session/crud.ts::app -->
5. Creation returns 201 with lifecycle `stopped`, generation zero and an ordered revision; it does not start a container or consume running capacity. <!-- @impl: src/routes/session/crud.ts::toWorkspaceApiSession --> <!-- @impl: src/routes/session/crud.ts::app --> <!-- @impl: src/lib/session-repository.ts::create --> <!-- @test: src/__tests__/routes/session-public-d1.test.ts (AC3/4/5 subsets: Create persists defaults and stopped generation zero; immutable PATCH preserves the row) -->
6. Creation remains rate-limited. <!-- @test: src/__tests__/routes/session-public-d1.test.ts (AC6 subset: route limiter rejects request eleven without creating any invalid session) --> <!-- @impl: src/routes/session/crud.ts::sessionCreateRateLimiter -->
7. Storage quota is checked in SaaS mode. <!-- @test: src/__tests__/routes/session-public-d1.test.ts (AC6 subset: cached SaaS storage above the tier cap denies creation without inserting a row) --> <!-- @impl: src/routes/session/crud.ts::app -->

**Constraints:**

- Secrets remain in their established stores.
- Session records are never written to KV.

**Priority:** P0

**Dependencies:** [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** Automated: [session-public-d1.test.ts](../../src/__tests__/routes/session-public-d1.test.ts), [session-authority-outcomes.test.ts](../../src/__tests__/lib/session-authority-outcomes.test.ts), [kv-keys.test.ts](../../src/__tests__/lib/kv-keys.test.ts)

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

**Verification:** Automated: [container-id-isolation.test.ts](../../src/__tests__/lib/container-id-isolation.test.ts)

**Status:** Implemented

---

### REQ-SESSION-003: R2 bucket mounted and synced on start

**Intent:** When a container starts, the user's persistent R2 storage is mounted and bidirectionally synced so the workspace contains all previously persisted files.

**Applies To:** User

**Acceptance Criteria:**

1. The user's persistent storage bucket is provisioned if it does not exist. <!-- @impl: src/lib/r2-admin.ts::createBucketIfNotExists --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (createBucketIfNotExists) -->
2. A scoped, bucket-specific credential pair is obtained or created for the user. Direct-storage containers receive the real pair; strict-egress and restricted Operator containers instead receive intentional non-secret placeholders for both R2 credential values, with storage access mediated by Worker-held scoped credentials. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-SESSION-003 AC2: scoped R2 token obtained and injected) --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-016/021: strict egress + Governed Mode leaves CONTAINER_AUTH_TOKEN as the ONLY real secret) --> <!-- @test: src/__tests__/container/container-env.test.ts (REQ-ENTERPRISE-016: emits a NON-SECRET placeholder R2 key when _strictEgress is true (real key never enters the container); no AWS_*) --> <!-- @test: src/__tests__/container/container-env.test.ts (REQ-ENTERPRISE-016: emits the real R2 key verbatim when _strictEgress is falsy (strict-off unchanged); no AWS_*) --> <!-- @test: src/__tests__/container/operator-env.test.ts (emits parent-bound Pi config and no broad credentials or whole-home restore) -->
3. An initial sync from persistent storage to the workspace settles before ordinary terminal traffic is released, with a shipped 120-second safety timeout; timeout emits a warning log and allows bounded startup to continue, without a distinct persisted degraded-restore record. Non-timeout restore failures remain failures even though startup may continue. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @manual: Stall the R2 source and confirm initial sync leaves its blocking phase after 120 seconds before bounded host fallback can release terminal traffic. -->
4. After initial sync, changes are bidirectionally synced on a regular schedule for the container's lifetime (see [REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)). <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->
5. After initial sync, on-demand triggers support bidirectional sync during the container's lifetime. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (SIGUSR1 interrupts the cadence sleep and triggers bisync immediately (REQ-STOR-003 AC2 / REQ-STOR-015 AC5 / REQ-MEM-004 AC4: SIGUSR1 trigger)) -->
6. A final sync runs on shutdown. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
7. New buckets are seeded with getting-started docs and agent configs matching the user's session mode. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @impl: src/lib/r2-seed.ts::seedGettingStartedDocs -->

**Constraints:**

- The master Cloudflare API token never enters the container; direct storage receives only per-user scoped credentials, while strict-egress and restricted Operator storage receives placeholders, not the real pair.
- Scoped credentials are cached durably (optionally encrypted at rest) and verified before reuse.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](#req-session-002-one-container-per-session-isolation)

**Verification:** Automated: [r2-admin.test.ts](../../src/__tests__/lib/r2-admin.test.ts), [container-r2-start.test.ts](../../src/__tests__/routes/container-r2-start.test.ts), [entrypoint-shutdown.test.js](../../host/__tests__/entrypoint-shutdown.test.js), [entrypoint-bisync-behavior.test.js](../../host/__tests__/entrypoint-bisync-behavior.test.js), [container-env-llm.test.ts](../../src/__tests__/container/container-env-llm.test.ts), [container-env.test.ts](../../src/__tests__/container/container-env.test.ts), [operator-env.test.ts](../../src/__tests__/container/operator-env.test.ts); Manual: [Initial-sync timeout check](session-lifecycle.md#req-session-003-r2-bucket-mounted-and-synced-on-start)

**Status:** Implemented

---

### REQ-SESSION-004: Idle containers sleep after configurable timeout

**Intent:** Containers that receive no user input for a configurable duration are automatically stopped to conserve resources and reduce cost.

**Applies To:** User

**Acceptance Criteria:**

1. New configurable idle timeouts are 1h, 2h, 4h, 8h and 12h. <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-004: %s stays alive until its configured idle deadline and then requests SIGTERM) --> <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) -->
2. New non-free users default to 1h; free-tier users remain locked to 15m regardless of stored preference. <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (defaults to 1h for non-free tiers without stored preference) --> <!-- @impl: src/routes/container/lifecycle-validation.ts::resolveEffectiveSleepAfter --> <!-- @test: src/__tests__/lib/enterprise-mode.test.ts (flag-off: free tier is locked to 15m regardless of stored preference) -->
3. The idle timer resets for classified terminal input and for each client-to-server Browser IDE frame; reconnections and server-to-client output do not reset it. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) -->
4. The container is stopped once the user-configured idle threshold is exceeded. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) --> <!-- @test: src/__tests__/container-metrics.test.ts (stops after genuine idle expiry from the persisted startup reference) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-004/034: valid input enforces its 1h deadline with %s startup timing) -->
5. The host-side per-PTY keepalive is a separate safety net floor-clamped at the maximum idle timeout (see [AD47](../../documentation/decisions/README.md#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy)). <!-- @test: host/__tests__/session-idle-timeout.test.js (REQ-SESSION-004 AC4: PTY safety net respects the maximum idle preset) -->
6. The platform-level idle timer is functionally inert; idle policy is owned by the per-container metrics layer. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @manual -->
7. Admins can always change their own idle timeout; non-subscribed users have the dropdown disabled. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/settings/SessionSection.test.tsx (REQ-SESSION-004 AC6: idle-timeout dropdown gating) -->

**Constraints:**

- The idle timeout is validated server-side against the supported value set.
- The preference survives container-orchestration resets; the storage shape is preserved for backwards compatibility with existing sessions.
- Free-tier override cannot be bypassed via API.
- Idle detection MUST NOT rely on the platform's built-in inactivity timer.

**Priority:** P0

**Dependencies:** [REQ-SESSION-005](#req-session-005-input-based-idle-detection)

**Verification:** Automated: [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [session-sleep-timeout.test.ts](../../src/__tests__/routes/session-sleep-timeout.test.ts), [enterprise-mode.test.ts](../../src/__tests__/lib/enterprise-mode.test.ts), [session-idle-timeout.test.js](../../host/__tests__/session-idle-timeout.test.js), [SessionSection.test.tsx](../../web-ui/src/__tests__/components/settings/SessionSection.test.tsx); Manual: [Session policy and preference record acceptance](../../documentation/lanes/container.md#session-policy-and-preference-record-acceptance)

**Status:** Implemented

---

### REQ-SESSION-005: Input-based idle detection

**Intent:** Idle detection uses classified terminal input and client-to-server Browser IDE frames, not connection presence or server output.

**Applies To:** User

**Acceptance Criteria:**

1. The host tracks one last-input timestamp shared by terminal input and client-to-server Browser IDE frames. <!-- @impl: host/src/activity-tracker.ts::createActivityTracker --> <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-004: advances the idle policy lastInputAt for every client-to-server frame) -->
2. User-input classification uses a whitelist: printable characters, control keys, arrow keys, function keys, Alt+key, and mouse clicks count as input. <!-- @impl: host/src/session.ts::Session.write --> <!-- @test: host/__tests__/session-wire-protocol.test.js (forwards ${name} unchanged and advances real lastInputAt) -->
3. Terminal protocol responses (cursor-position reports, OSC color queries, mouse movement, device-attribute reports) do not count as input. <!-- @impl: host/src/session.ts::Session.write --> <!-- @test: host/__tests__/session-wire-protocol.test.js (handles ${name} PTY bytes without changing real lastInputAt) -->
4. Only 7-bit CPR (two nonempty decimal fields), OSC 10/11/12 (BEL/ESC-free payload; BEL or ESC-backslash terminator), and DA1 (CSI `?`, zero or more digits/semicolons, `c`) are stripped before PTY writes. DA2 and focus reports remain forwarded non-input; classification is separate. <!-- @impl: host/src/session.ts::Session.write --> <!-- @test: host/__tests__/session-wire-protocol.test.js (filters mixed ${name} while advancing real lastInputAt) -->
5. Idle detection reads the authoritative host timestamp, which advances only for classified terminal input or client-to-server Browser IDE frames; background process and server-to-client output cannot reset it. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @manual -->

**Constraints:**

- If no input is ever received, idle time is measured from a valid durable container-start reference.
- A container with an open terminal but no typing stops after the configured idle timeout has elapsed from that reference.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated: [openvscode-proxy.test.js](../../host/__tests__/openvscode-proxy.test.js), [session-wire-protocol.test.js](../../host/__tests__/session-wire-protocol.test.js), [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts); Manual: [Session policy and preference record acceptance](../../documentation/lanes/container.md#session-policy-and-preference-record-acceptance)

**Status:** Implemented

---

<a id="req-session-006-user-can-stop-restart-and-delete-sessions"></a>
### REQ-SESSION-006: User can start, stop, restart and delete sessions

**Intent:** Explicit lifecycle mutations are ordered by D1 authority and preserve graceful process control.

**Applies To:** User

**Acceptance Criteria:**

1. An accepted Start advances generation once and writes `starting` in D1 before process launch. The Durable Object adopts that generation during startup before publishing running state or generation-owned observations. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @impl: src/lib/session-repository.ts::start --> <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-018 AC4 / REQ-SESSION-028 AC4: retained stopped row restarts and Delete fences late writers) -->
2. New Start admission fails closed when D1 authority is unavailable, a termination intent is outstanding, or capacity validation rejects it. An idempotent already-running response does not launch a process or allocate another generation. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @impl: src/lib/session-repository.ts::start --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC5: unavailable D1 rejects admission without changing durable authority) --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC1/2: %s denies another Start at cap without counting another owner) -->
3. Stop conditionally claims `stopping` for the current generation, performs established graceful destruction, and reaches `stopped` only after a generation-fenced positive process-exit monitor observation or awaited destruction that confirms exit. An old `stopping` transition alone cannot release ownership. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session-stop-delete.test.ts (returns failure and preserves retryable state when destruction is unconfirmed) --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-035: old stopping remains owner-scoped and retains managed-mutation ownership without exit evidence) -->
4. Restart preserves the same D1 session row, workspace and storage identity while applying current preferences in a new generation. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @impl: src/lib/session-repository.ts::start --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (REQ-SESSION-006 AC4: restart applies changed sync preference to the same retained workspace) -->
5. Delete uses the same confirmed graceful destruction path and hard-deletes the D1 row only after exit; delayed writers cannot recreate it. <!-- @impl: src/routes/session/crud.ts::app --> <!-- @impl: src/lib/session-repository.ts::deleteConfirmed --> <!-- @impl: src/lib/session-repository.ts::project --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-018 AC4 / REQ-SESSION-028 AC4: retained stopped row restarts and Delete fences late writers) -->
6. Failed or ambiguous destruction retains retryable authoritative state and does not report stopped or deleted. <!-- @impl: src/routes/session/crud.ts::app --> <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @test: src/__tests__/container/session-stop.test.ts (retains stopping when D1 confirmation fails and completes after recovery with a new coordinator) --> <!-- @test: src/__tests__/container/session-stop.test.ts (keeps an unconfirmed destruction stopping and lets the owner retry it) -->
7. The frontend retains mounted workspace state through uncertainty and disposes it only after newer authoritative stopping/stopped or successful deletion evidence. <!-- @impl: web-ui/src/stores/session.ts::stopSession --> <!-- @impl: web-ui/src/stores/session.ts::deleteSession --> <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatusesOnce --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-006 AC7 / SESSION-012 AC3 / TERM-045 AC6: 4503 is transport evidence, not session authority) -->

**Constraints:** Existing final agent-event drain, final sync, teardown ceilings and storage durability remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record), [REQ-SESSION-002](#req-session-002-one-container-per-session-isolation)

**Verification:** Automated: [session-authority-outcomes.test.ts](../../src/__tests__/lib/session-authority-outcomes.test.ts), [container-lifecycle.test.ts](../../src/__tests__/routes/container-lifecycle.test.ts), [session-stop.test.ts](../../src/__tests__/container/session-stop.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts), [session-stop-delete.test.ts](../../src/__tests__/routes/session-stop-delete.test.ts)

**Status:** Implemented

---

### REQ-SESSION-041: Stop recovery controls and local attempt fencing

**Intent:** Users can retry an uncertain Stop without deleting their session or submitting duplicate local attempts.

**Applies To:** User

**Acceptance Criteria:**

1. Dashboard and session-dropdown actions offer non-deleting Retry Stop for persisted `stopping` and Stop for `unreachable`. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-SESSION-035: offers non-deleting Stop recovery for a persisted %s dashboard session) --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (REQ-SESSION-035: offers non-deleting Stop recovery for a persisted %s session) -->
2. An active local Stop attempt suppresses duplicate submissions; failure or polling cancellation releases the attempt so a retained session can retry. <!-- @impl: web-ui/src/stores/session.ts::stopSession --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-035: suppresses duplicate local Stop submissions until the first attempt finishes) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-035: a failed Stop leaves retry available and retry completes the same session) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-006: a failed Delete during Stop polling leaves Retry Stop usable) -->

**Constraints:** Existing final agent-event drain, final sync, teardown ceilings and storage durability remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-SESSION-006](#req-session-006-user-can-start-stop-restart-and-delete-sessions), [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record), [REQ-SESSION-002](#req-session-002-one-container-per-session-isolation)

**Verification:** Automated: [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx), [SessionDropdown.test.tsx](../../web-ui/src/__tests__/components/SessionDropdown.test.tsx), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

### REQ-SESSION-038: User can force-kill a session container

**Intent:** Dashboard and in-session menus offer an explicit KILL recovery action that reaches SDK force-destroy without waiting for graceful Stop, while retaining the session and persistent files.

**Applies To:** User

**Acceptance Criteria:**

1. Dashboard and in-session context menus offer `Kill` for `starting`, `running`, `unreachable` and persisted `stopping`, but not for a confirmed-stopped session. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-SESSION-038: dashboard KILL remains accessible for %s without entering the session) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-SESSION-038: dashboard does not offer KILL for a confirmed-stopped session) --> <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @impl: web-ui/src/components/SessionContextMenu.tsx::SessionContextMenu --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (REQ-SESSION-038: KILL in the existing session menu) --> <!-- @test: web-ui/src/__tests__/components/SessionContextMenu.test.tsx (REQ-SESSION-038: optional KILL action) -->
2. KILL remains usable while a local Stop attempt is pending. <!-- @impl: web-ui/src/stores/session.ts::killSession --> <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @test: web-ui/src/__tests__/stores/session-kill.test.ts (REQ-SESSION-038: session KILL through the public store and HTTP boundary) --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (REQ-SESSION-038: KILL in the existing session menu) -->
3. Clicking KILL targets only the selected session. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @impl: web-ui/src/components/SessionContextMenu.tsx::SessionContextMenu --> <!-- @impl: web-ui/src/api/client.ts::killSession --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (REQ-SESSION-038: KILL in the existing session menu) --> <!-- @test: web-ui/src/__tests__/components/SessionContextMenu.test.tsx (REQ-SESSION-038: optional KILL action) -->
4. The frontend retains the session row, workspace identity and tabs after KILL. <!-- @impl: web-ui/src/stores/session.ts::killSession --> <!-- @test: web-ui/src/__tests__/stores/session-kill.test.ts (REQ-SESSION-038: session KILL through the public store and HTTP boundary) -->
5. Failed or uncertain KILL presents a retryable error without inventing stopped or deleted state. <!-- @impl: web-ui/src/stores/session.ts::killSession --> <!-- @impl: web-ui/src/api/client.ts::killSession --> <!-- @test: web-ui/src/__tests__/stores/session-kill.test.ts (REQ-SESSION-038: session KILL through the public store and HTTP boundary) --> <!-- @test: web-ui/src/__tests__/api/session-kill.test.ts (REQ-SESSION-039 AC1: KILL HTTP contract) -->
6. An active local KILL attempt suppresses duplicate submissions. <!-- @impl: web-ui/src/stores/session.ts::killSession --> <!-- @test: web-ui/src/__tests__/stores/session-kill.test.ts (REQ-SESSION-038: session KILL through the public store and HTTP boundary) -->
7. The selected session's mounted runtime is disposed only after newer authoritative stopped evidence. <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @test: web-ui/src/__tests__/stores/session-kill.test.ts (REQ-SESSION-038: session KILL through the public store and HTTP boundary) -->

**Constraints:**

- Preserve Rename, Stop, Kill, Delete ordering and behavior, with the Material Design `file-excel-box` glyph for Kill. <!-- @impl: web-ui/src/components/SessionContextMenu.tsx::SessionContextMenu --> <!-- @test: web-ui/src/__tests__/components/SessionContextMenu.test.tsx (REQ-SESSION-038: optional KILL action) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-SESSION-038: dashboard KILL remains accessible for %s without entering the session) -->
- Existing context-menu dismissal on action invocation remains unchanged. <!-- @impl: web-ui/src/components/SessionContextMenu.tsx::SessionContextMenu --> <!-- @test: web-ui/src/__tests__/components/SessionContextMenu.test.tsx (REQ-SESSION-038: optional KILL action) --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (REQ-SESSION-038: KILL in the existing session menu) -->
- Existing Stop, Rename, Delete and idle-timeout behavior remains unchanged. <!-- @impl: web-ui/src/components/SessionContextMenu.tsx::SessionContextMenu --> <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: web-ui/src/__tests__/components/SessionContextMenu.test.tsx (REQ-SESSION-038: optional KILL action) --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
- No automatic recovery scheduler, idle-policy change or new user setting.
- KILL does not promise to save unsynced container-local edits.

**Priority:** P0

**Dependencies:** [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions), [REQ-SESSION-039](#req-session-039-authorized-do-owned-native-kill), [REQ-SESSION-040](#req-session-040-kill-confirmation-retry-and-generation-fencing)

**Verification:** Automated: [SessionDropdown.test.tsx](../../web-ui/src/__tests__/components/SessionDropdown.test.tsx), [SessionContextMenu.test.tsx](../../web-ui/src/__tests__/components/SessionContextMenu.test.tsx), [session-kill.test.ts](../../web-ui/src/__tests__/stores/session-kill.test.ts), [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx)

**Status:** Implemented

---

### REQ-SESSION-039: Authorized DO-owned native KILL

**Intent:** An explicit owner-authorized KILL reaches native force-destroy independently of graceful Stop and the calling request.

**Applies To:** User

**Acceptance Criteria:**

1. KILL is an owner-authenticated addressed mutation using existing session validation, access policy and mutation protections. <!-- @impl: src/routes/session/index.ts::app --> <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: owner-authenticated POST /api/sessions/:id/kill) -->
2. The Worker reads current owner-scoped D1 authority and fails closed if unavailable. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: owner-authenticated POST /api/sessions/:id/kill) -->
3. The DO alone claims stopping upon acceptance and owns completion independently of the HTTP caller, from termination claim through Protected Action cancellation, operational cleanup, native destruction and D1 exit confirmation. <!-- @impl: src/container/index.ts::container --> <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
4. The generation's Protected Action cancellation fence must settle successfully before operational cleanup or native termination. <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @impl: src/routes/session/boundary-stop.ts::fencePendingBoundaryStart --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
5. Operational teardown cleanup precedes awaited native force-destroy. <!-- @impl: src/container/container-lifecycle.ts::killSession --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
6. KILL bypasses final notification drain, workspace final-sync wait and SIGTERM polling; a hung graceful Stop cannot block it. <!-- @impl: src/container/container-lifecycle.ts::killSession --> <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
7. KILL preserves the D1 session row, workspace identity and persistent R2 files. <!-- @impl: src/container/container-lifecycle.ts::killSession --> <!-- @impl: src/lib/session-repository.ts::confirmStopped --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->

**Constraints:**

- Native force-destroy uses the public Containers SDK inside the owning DO.
- No SDK patch, forged identity or historical Activity replay.
- No session-row deletion or persistent-storage deletion.
- No promise to save unsynced container-local edits.

**Priority:** P0

**Dependencies:** [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions), [REQ-SESSION-009](#req-session-009-container-destroy-wipes-session-state), [REQ-SESSION-040](#req-session-040-kill-confirmation-retry-and-generation-fencing)

**Verification:** Automated: [session-kill.test.ts](../../src/__tests__/routes/session-kill.test.ts), [session-kill.test.ts](../../src/__tests__/container/session-kill.test.ts)

**Status:** Implemented

---

### REQ-SESSION-040: KILL confirmation, retry and generation fencing

**Intent:** KILL retains authoritative termination ownership through uncertainty and cannot affect a replacement runtime.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. D1 confirms stopped only from a generation-fenced positive process-exit monitor observation or awaited native destruction confirming exit. Stale stopping, SDK hints, unevidenced callbacks, transport rejection and elapsed time cannot establish exit. <!-- @impl: src/container/container-lifecycle.ts::killSession --> <!-- @impl: src/container/container-lifecycle.ts::confirmMonitoredExit --> <!-- @impl: src/lib/session-repository.ts::confirmStoppedOrObserved --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
2. Failed or unconfirmed destruction or D1 confirmation retains retryable termination ownership without reporting stopped or deleted. <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @impl: src/container/container-lifecycle.ts::killSession --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
3. Same-generation retries reuse the retained termination intent, including after operational identity erasure or coordinator reconstruction. <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @impl: src/container/container-lifecycle.ts::killSession --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
4. Duplicate KILL requests do not perform competing native teardowns. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
5. A retry after confirmed stopped succeeds idempotently without another teardown. <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
6. Before effects and after asynchronous work, the addressed DO validates captured owner/session identity, address, lifecycle generation and termination-intent ownership; mismatches fail closed. <!-- @impl: src/container/index.ts::container --> <!-- @impl: src/container/container-lifecycle.ts::killSession --> <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->
7. Graceful teardown superseded by KILL cannot later clear a replacement generation's operational state, signal it or destroy it. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @impl: src/container/container-lifecycle.ts::killSession --> <!-- @test: src/__tests__/container/session-kill.test.ts (REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination) -->

**Constraints:**

- Current D1 authority, not erased operational keys, governs same-intent retry.
- Caller-independent completion is not automatic crash recovery or a new scheduler.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced), [REQ-SESSION-035](#req-session-035-stale-stopping-retains-ownership-until-confirmed-exit)

**Verification:** Automated: [session-kill.test.ts](../../src/__tests__/container/session-kill.test.ts), [session-kill.test.ts](../../src/__tests__/routes/session-kill.test.ts)

**Status:** Implemented

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

**Verification:** Automated: [SessionContextMenu.test.tsx](../../web-ui/src/__tests__/components/SessionContextMenu.test.tsx), [SessionDropdown.test.tsx](../../web-ui/src/__tests__/components/SessionDropdown.test.tsx), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

<a id="req-session-007-running-session-count-limited-per-tier"></a>
### REQ-SESSION-007: Workload-owning session count is limited per tier

**Intent:** Each Start performs best-effort capacity enforcement from the consistent D1 lifecycle projection without introducing an atomic reservation protocol.

**Applies To:** User

**Acceptance Criteria:**

1. Before Start, capacity counts only the authenticated owner's other sessions in `starting`, `running`, `unreachable`, or `stopping`, excluding the session being started. The query budget is normative at the [architecture admission boundary](../../documentation/lanes/architecture.md#capacity-caching-and-performance-assumptions). <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @impl: src/routes/container/lifecycle-validation.ts::countsTowardSessionLimit --> <!-- @impl: src/lib/session-repository.ts::listSessions --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC1/2: %s denies another Start at cap without counting another owner) -->
2. A count at or above the configured tier cap rejects Start; an explicit zero cap blocks it. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC1/2: %s denies another Start at cap without counting another owner) --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC2/4: zero blocks empty capacity while stopped creation consumes no slot) -->
3. Existing SaaS tier limits, non-SaaS role defaults, deployment overrides and stress-test bypass remain unchanged. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC3: existing non-SaaS stress bypass preserves the zero-cap exception) --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC3: SaaS tier capacity wins over role cap and preserves explicit zero) --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC3: role defaults and deployment overrides do not lose explicit zero) -->
4. Create in `stopped` does not consume capacity. <!-- @impl: src/lib/session-repository.ts::create --> <!-- @impl: src/routes/container/lifecycle-validation.ts::countsTowardSessionLimit --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC2/4: zero blocks empty capacity while stopped creation consumes no slot) -->
5. D1 query failure fails Start closed rather than using KV, SDK state or stale client data. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC5: unavailable D1 rejects admission without changing durable authority) -->
6. Enforcement remains best effort: concurrent Starts may both pass and exceed the nominal cap. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @impl: src/lib/session-repository.ts::start --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC6: concurrent validations and later Start claims retain the specified best-effort semantics) -->

**Constraints:**

- Do not add stronger reservation guarantees.
- Session KV LIST/get operations are prohibited.

**Priority:** P1

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record)

**Verification:** Automated: [session-authority-outcomes.test.ts](../../src/__tests__/lib/session-authority-outcomes.test.ts)

**Status:** Implemented

---

### REQ-SESSION-008: Container restart preserves R2 bucket

**Intent:** Restarting a session reconnects to the same R2 bucket, preserving all user files without data loss.

**Applies To:** User

**Acceptance Criteria:**

1. Restarting a session on the same workspace preserves the bucket association and applies any stored preference updates. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (REQ-SESSION-006 AC4: restart applies changed sync preference to the same retained workspace) -->
2. Following restart, automatic idle detection remains active. <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @test: src/__tests__/container-metrics.test.ts (should call schedule(60, "collectMetrics") on start) -->
3. Updated credentials and preferences take effect on restart without requiring container recreation. <!-- @impl: src/container/index.ts::onStart --> <!-- @test: src/__tests__/routes/container-restart-prefs.test.ts (applyPrefsOnRestart updates workspaceSyncEnabled when changed) --> <!-- @test: src/__tests__/routes/container-restart-prefs.test.ts (applyPrefsOnRestart updates fastStartEnabled when changed) --> <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart -->
4. The container entrypoint runs an initial sync that restores the workspace from persistent storage on restart. <!-- @impl: entrypoint.sh::initial_sync_from_r2 -->
5. User preference changes (idle timeout, fast-start, session mode) take effect on restart without requiring container recreation. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer -->

**Constraints:**

- A restart against a different storage identity triggers a full teardown and rebind cycle.

**Priority:** P0

**Dependencies:** [REQ-SESSION-003](#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** Automated: [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [container-restart-prefs.test.ts](../../src/__tests__/routes/container-restart-prefs.test.ts), [preferences.test.ts](../../src/__tests__/routes/preferences.test.ts), [container-lifecycle.test.ts](../../src/__tests__/routes/container-lifecycle.test.ts)

**Status:** Implemented

---

### REQ-SESSION-009: Container destroy wipes session state

**Intent:** Destroying a container clears transient Durable Object state while preserving the authoritative D1 session record and persistent R2 storage.

**Applies To:** User

**Acceptance Criteria:**

1. Destroying a session clears all transient session state from the Durable Object; subsequent fetch attempts return 503. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-009 AC1: public destroy removes the forwarding credential and subsequent fetch stays unavailable without starting) -->
2. Session mode resets to default on destroy. <!-- @impl: src/container/container-lifecycle.ts::clearOperationalMemory -->
3. Scheduled idle-metric polling is cancelled on destroy. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-009 AC4: a delivered metrics callback after public destroy leaves schedules and service effects unchanged) -->
4. After destroy, any delayed polling that fires detects the missing session state and exits without re-arming. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-009 AC4: a delivered metrics callback after public destroy leaves schedules and service effects unchanged) -->
5. The user's persistent storage bucket and its contents are NOT deleted by destroy; files persist across sessions. <!-- @impl: src/container/index.ts::destroy --> <!-- @manual: Session replacement storage acceptance -->

**Constraints:**

- Durable Object storage and in-memory state must be cleared before the platform teardown call to prevent asynchronous writebacks from re-creating a stale record.

**Priority:** P0

**Dependencies:** [REQ-SESSION-006](#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** Automated: [index.test.ts](../../src/__tests__/container/index.test.ts); Manual: [Session replacement storage acceptance](../../documentation/lanes/storage-and-sync.md#session-replacement-storage-acceptance)

**Status:** Implemented

---

<a id="req-session-010-session-status-observable-from-dashboard"></a>
### REQ-SESSION-010: Session lifecycle is observable from one D1 projection

**Intent:** Devices share one strongly ordered backend lifecycle while terminal ACTIVE/IDLE remains local presentation.

**Applies To:** User

**Acceptance Criteria:**

1. Frequent batch status uses one owner-indexed primary-consistent D1 query, no session KV operation, no per-session query or container/SDK probe, and sends `no-store` semantics. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @impl: src/lib/session-repository.ts::listSessions --> <!-- @test: src/__tests__/routes/session-public-d1.test.ts (AC1/2 subsets: owner filtering, seeded lifecycle metadata and no-store response contract) -->
2. Responses return complete session projections with lifecycle, generation, revision, readiness, incident/deadline, metrics and observation timestamps. <!-- @impl: src/lib/session-repository.ts::fromRow --> <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (returns ordered lifecycle, metrics, readiness, and incident fields) -->

**Constraints:**

- Dashboard polling never wakes a container.
- Authentication and revocation middleware may retain unrelated KV use.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record), [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced)

**Verification:** Automated: [session-public-d1.test.ts](../../src/__tests__/routes/session-public-d1.test.ts), [session-presentation.test.ts](../../web-ui/src/__tests__/lib/session-presentation.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

### REQ-SESSION-243: Ordered lifecycle presentation and read availability

**Intent:** Clients retain ordered lifecycle authority while presenting device-local activity and separate read availability.

**Applies To:** User

**Acceptance Criteria:**

1. Clients apply responses monotonically by generation and revision so delayed success or failure cannot undo newer state. <!-- @impl: web-ui/src/lib/session-presentation.ts::applyOrderedProjection --> <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatusesOnce --> <!-- @test: web-ui/src/__tests__/lib/session-presentation.test.ts (ignores delayed generation and revision responses) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC1/AC2: stale %s batch readiness and metrics cannot overwrite a newer projection) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-010/012/029: failed status reads retain workspace authority and expose unavailable until recovery) -->
2. For Terminal workspaces, backend `running` plus this device's connected terminal WebSocket renders green ACTIVE; without it, blue IDLE; neither label is persisted. <!-- @impl: web-ui/src/lib/session-presentation.ts::terminalPresentation --> <!-- @impl: web-ui/src/components/SessionStatCard.tsx::SessionStatCard --> <!-- @test: web-ui/src/__tests__/components/workspace-lifecycle.test.tsx (REQ-TERM-045 AC3: local ACTIVE/IDLE never changes persisted workspace or shared lifecycle) -->
3. `starting` and `unreachable` use yellow recovery presentation and `stopped` is gray. <!-- @impl: web-ui/src/lib/session-presentation.ts::terminalPresentation -->
4. D1 read failure retains the last ordered state and shows a separate status-unavailable warning. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatusesOnce --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-010/012/029: failed status reads retain workspace authority and expose unavailable until recovery) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-SESSION-010/029: %s announces unavailable status without replacing cards and clears on recovery) -->

**Constraints:**

- Dashboard polling never wakes a container.
- Authentication and revocation middleware may retain unrelated KV use.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record), [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced), [REQ-SESSION-010](#req-session-010-session-lifecycle-is-observable-from-one-d1-projection)

**Verification:** Automated: [session-public-d1.test.ts](../../src/__tests__/routes/session-public-d1.test.ts), [session-presentation.test.ts](../../web-ui/src/__tests__/lib/session-presentation.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

### REQ-SESSION-244: Lifecycle polling and ancillary scheduling

**Intent:** Frequent lifecycle refresh and separately owned ancillary work preserve serialized polling and last-good dashboard state.

**Applies To:** User

**Acceptance Criteria:**

1. Polling is serialized, pauses while hidden, refreshes on visibility, and uses transition and stable cadences without overlapping requests. <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-010 AC6: %s uses its transition or stable polling cadence) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-010/029 AC6: hidden polling pauses and repeated visible refreshes remain serialized) --> <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @impl: web-ui/src/stores/session-polling.ts::scheduleNextPoll --> <!-- @impl: web-ui/src/stores/session-polling.ts::handlePollingVisibilityChange -->
2. Usage, storage, entitlement, managed-release, preseed and governed-migration work has a separate initial/slower/event-driven owner and retains last good values on failure. <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-010 AC7: failed ancillary lookup preserves last-good fields and recovery replaces them) --> <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionAncillaryStatus -->

**Constraints:**

- Dashboard polling never wakes a container.
- Authentication and revocation middleware may retain unrelated KV use.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record), [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced), [REQ-SESSION-010](#req-session-010-session-lifecycle-is-observable-from-one-d1-projection)

**Verification:** Automated: [session-public-d1.test.ts](../../src/__tests__/routes/session-public-d1.test.ts), [session-presentation.test.ts](../../web-ui/src/__tests__/lib/session-presentation.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

### REQ-SESSION-011: Graceful shutdown with final sync

**Intent:** Graceful stop/delete paths complete one bounded live workspace sync before terminating the container; the SIGTERM trap remains only a best-effort backstop. Explicit KILL ([REQ-SESSION-038](#req-session-038-user-can-force-kill-a-session-container)) intentionally bypasses this graceful drain.

**Applies To:** User

**Acceptance Criteria:**

1. Before signalling the container to stop, every graceful stop/delete path runs a live bidirectional R2 sync to completion while the container is still fully running including a delete where the platform reports `running:false` transiently. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-lifecycle.ts::drainFinalSyncAudited --> <!-- @impl: src/container/container-lifecycle.ts::recordFinalSyncAudit --> <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-011: drains a final R2 sync (POST /internal/final-sync) BEFORE signalling stop) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-011 AC1 / REQ-SESSION-019 AC1: authenticated final-sync completion precedes SIGTERM even with a transient false running flag) --> <!-- @manual: Final persistence acceptance -->
2. For runnable sync, the final-sync endpoint starts and awaits its own run, distinguishing success, failure and timeout. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (REQ-SESSION-011 AC2: final-sync HTTP boundary (behavioral)) -->
3. The sync-status record carries a monotonic timestamp and a `syncing`->`success`/`failed` transition, and the endpoint accepts a terminal status only after observing its own run's `syncing` (stamped strictly after the trigger), never a bare `success`. <!-- @impl: host/src/final-sync.ts::FinalSyncEval --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (REQ-SESSION-011 AC2/AC3: evaluateFinalSync completion detection (behavioral)) -->
4. The Durable Object waits up to a bounded sync budget (120s) for the live sync to report completion; a failed or timed-out sync still proceeds to stop rather than blocking teardown. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (destroy) -->
5. Total teardown is hard-capped from teardown entry: every awaited teardown stage consumes the same 135s deadline, so storage, sync, stop, or provider stalls cannot extend the operation. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-011 AC5: an awaited %s stall cannot extend the shared 135-second teardown deadline) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-011 AC5: rejects at the entry-to-exit deadline and observes a later forced-destroy rejection) -->
6. User stop and user delete behave identically: both route through the same graceful-destroy path, and idle-timeout and quota-eviction paths drain through the same endpoint before stopping. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-011 AC6 / REQ-SESSION-032 AC1: quota-stop drains final agent events, then final sync, then stop) -->
7. The SIGTERM trap is retained as a best-effort backstop final sync for paths that bypass the orchestrated drain, but is no longer the primary guarantee (see [REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync) for the trap's own constraints). <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC4 / REQ-STOR-003 AC6: final, periodic, and baseline bisync use the 5000-file deletion limit) -->

**Constraints:**

- The authoritative sync runs while the container is alive; post-SIGTERM grace is not its completion mechanism.
- The final-sync endpoint timeout exceeds the DO's 120-second drain budget.
- Successful completion requires this run's `syncing` state before its terminal state.
- A [persisted disk blocker](storage.md#req-stor-044-disk-space-failure-visibility) is reported without starting a new run; an in-memory-only block may time out.
- The container image retains a trappable stop signal.

**Priority:** P0

**Dependencies:** [REQ-SESSION-003](#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** Automated: [final-sync-endpoint.test.js](../../host/__tests__/final-sync-endpoint.test.js), [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [index.test.ts](../../src/__tests__/container/index.test.ts), [entrypoint-shutdown.test.js](../../host/__tests__/entrypoint-shutdown.test.js); Manual: [Final persistence acceptance](../../documentation/lanes/storage-and-sync.md#req-stor-005-final-persistence-acceptance)

**Status:** Implemented

---

### REQ-SESSION-032: Final notification drain precedes shutdown sync

**Intent:** Deliberate stop paths give pending away notifications one bounded final attempt before final workspace sync and container stop.

**Applies To:** User

**Acceptance Criteria:**

1. Idle, quota, Stop, and Delete invoke one independently bounded final agent-event drain before final sync. <!-- @impl: src/container/container-metrics.ts::drainAgentEventsBeforeStop --> <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-011 AC6 / REQ-SESSION-032 AC1: quota-stop drains final agent events, then final sync, then stop) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-032 AC1: calls final agent-event drain, then final sync, then stop) --> <!-- @test: src/__tests__/container/lifecycle.test.ts (REQ-SESSION-032 AC1/AC4-AC5: destroy preserves credentials, drains before sync, and clears storage) -->
2. A final drain makes unresolved client decisions eligible for fallback before reading events. <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @test: host/__tests__/agent-events.test.js (final drain atomically promotes pending and awaiting-confirmation events) -->
3. Neither unclaimed transport uncertainty nor termination of a durably claimed expired incident performs final agent-event or final workspace-sync drains. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/container-lifecycle.ts::terminateUnreachable --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (first failed probe is nonbillable, survives reconstruction, signals at 120s even with SDK false, destroys only after 135s grace) -->
4. Teardown preserves the lifecycle Bearer and session ID until the final event request is built, then clears stored state. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/lifecycle.test.ts (REQ-SESSION-032 AC1/AC4-AC5: destroy preserves credentials, drains before sync, and clears storage) -->
5. Final event delivery consumes the teardown deadline without reducing the reserved final-sync budget. <!-- @impl: src/container/container-lifecycle.ts::destroy -->
6. A failed final event drain still permits final sync and container stop. <!-- @impl: src/container/container-metrics.ts::drainAgentEventsBeforeStop --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-032 AC6: an event-drain failure still runs final sync and stop) -->
7. A failed final sync preserves the completed event attempt and still permits container stop. <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-032 AC7: final-sync failure preserves the event attempt and still stops) -->

**Constraints:**

- Final order is agent-event drain, R2 sync, then stop.
- Failed or timed-out drains still proceed within the 135-second teardown ceiling.

**Priority:** P0

**Dependencies:** [REQ-SESSION-011](#req-session-011-graceful-shutdown-with-final-sync), [REQ-SESSION-024](#req-session-024-recovery-deadline-and-termination-intent-are-durable), [REQ-TERM-023](terminal.md#req-term-023-away-only-agent-notification-delivery), [REQ-SEC-024](security.md#req-sec-024-agent-notification-delivery-trust-boundaries)

**Verification:** Automated: [agent-events.test.js](../../host/__tests__/agent-events.test.js), [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [lifecycle.test.ts](../../src/__tests__/container/lifecycle.test.ts), [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts)

**Status:** Implemented

---

<a id="req-session-028-session-metadata-projection-compatibility"></a>
### REQ-SESSION-028: Session authority has no KV compatibility path

**Intent:** After clean-slate cutover, all session catalog and lifecycle behavior uses D1 without migration or shadow state.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. Session CRUD, discovery, status, metrics, admission, terminal/editor authorization, sync fanout, managed reconciliation and user cleanup perform no session KV LIST/get/write. <!-- @test: src/__tests__/routes/session-public-d1.test.ts (serves D1 catalog/status/create without importing or deleting conflicting legacy records) --> <!-- @impl: src/lib/session-repository.ts::D1SessionRepository --> <!-- @impl: src/lib/session-helpers.ts::listRunningSessionIds --> <!-- @impl: src/lib/session-helpers.ts::hasOwningSessionContainer -->
2. There is no legacy-session import, backfill, dual write, shadow projection, fallback read or reverse migration. <!-- @impl: src/lib/session-repository.ts::D1SessionRepository --> <!-- @test: src/__tests__/routes/session-public-d1.test.ts (fails closed during a D1 outage rather than falling back to preserved legacy sessions) -->
3. Session-specific KV helpers and list metadata types are removed or narrowed so unrelated KV data remains intact. <!-- @test: src/__tests__/routes/session-public-d1.test.ts (serves D1 catalog/status/create without importing or deleting conflicting legacy records) --> <!-- @impl: src/lib/kv-keys.ts::listAllKvKeys --> <!-- @impl: src/lib/kv-keys.ts::getPreferencesKey -->
4. A stopped session remains an ordinary D1 row until Delete hard-deletes it. <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-018 AC4 / REQ-SESSION-028 AC4: retained stopped row restarts and Delete fences late writers) --> <!-- @impl: src/lib/session-repository.ts::confirmStopped --> <!-- @impl: src/lib/session-repository.ts::deleteConfirmed -->
5. Post-cutover rollback uses a reviewed D1-compatible build or forward fix and never a KV-only Worker. <!-- @manual: Before an authorized rollback, review candidate D1 compatibility and retained session authority using documentation/lanes/deployment.md#production-rollback and documentation/lanes/container.md#cutover-boundary; reject KV-only builds or choose a reviewed forward fix. No rollback qualification is claimed by this procedure. -->

**Constraints:** Credentials, preferences, configuration, entitlements, managed releases, storage caches and unrelated records remain in existing stores.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-complete-d1-record)

**Verification:** Automated: [session-public-d1.test.ts](../../src/__tests__/routes/session-public-d1.test.ts), [session-authority-outcomes.test.ts](../../src/__tests__/lib/session-authority-outcomes.test.ts); Manual: [D1-compatible rollback review](session-lifecycle.md#req-session-028-session-authority-has-no-kv-compatibility-path)

**Status:** Implemented

---

<a id="req-session-029-latest-session-load-owns-batch-derived-state"></a>
### REQ-SESSION-029: Ordered client state retains last good authority

**Intent:** Concurrent loads and D1 outages cannot replace newer lifecycle context or mounted workspaces with stale data or errors.

**Applies To:** User

**Acceptance Criteria:**

1. Session responses are applied only when their generation/revision pair is newer than or equal to the client's accepted pair under the defined monotonic ordering. <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC1: equal or newer catalog revision %s still updates current metadata) --> <!-- @impl: web-ui/src/lib/session-presentation.ts::applyOrderedProjection --> <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatusesOnce -->
2. A stale list or status success has no observable effect. <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC2: stale catalog $generation/$revision preserves the complete newer session metadata) --> <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @impl: web-ui/src/stores/session-polling.ts::invalidateSessionStatusReads --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC2: batch absence captured before a newer catalog cannot remove its cards) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC2: an older catalog cannot undo successful %s) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC1/AC2: stale %s batch readiness and metrics cannot overwrite a newer projection) -->
3. A stale failure cannot replace the latest request's availability state. <!-- @impl: web-ui/src/stores/session-polling.ts::beginSessionStatusRead --> <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC3: old poll failure cannot replace newer successful catalog availability) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC3: old catalog failure cannot replace newer successful poll availability) -->
4. D1 read failure retains last good session records, metrics and ancillary values and presents a distinct status-unavailable warning. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatusesOnce --> <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-010/012/029: failed status reads retain workspace authority and expose unavailable until recovery) -->
5. Read failure does not remove sessions, dispose terminal/editor state, or synthesize lifecycle transitions. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatusesOnce --> <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-010/012/029: failed status reads retain workspace authority and expose unavailable until recovery) -->
6. Background polling remains serialized by a one-request-in-flight guard. <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-010/029 AC6: hidden polling pauses and repeated visible refreshes remain serialized) --> <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC6: overlapping visibility refreshes count one successful absence, not three) -->
7. Accepted initial session catalogs and ordered status updates are published without waiting for unrelated ancillary work. <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC7: initial authoritative cards appear before pending batch and ancillary reads) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-029 AC7: slow ancillary work cannot hold a newer lifecycle projection) -->

**Constraints:** Transport unreachability and D1 status unavailability are separate notices and state machines.

**Priority:** P0

**Dependencies:** [REQ-SESSION-010](#req-session-010-session-lifecycle-is-observable-from-one-d1-projection)

**Verification:** Automated: [session-presentation.test.ts](../../web-ui/src/__tests__/lib/session-presentation.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

<a id="req-session-030-negative-kv-evidence-preserves-lifecycle-owned-sessions"></a>
<a id="req-session-030-one-time-clean-slate-cutover-is-guarded-and-exact"></a>
### REQ-SESSION-030: Clean-slate D1 admission is live on deployment

**Intent:** A D1-only deployment admits new sessions immediately without importing, reading, or deleting legacy KV session records.

**Applies To:** User

**Acceptance Criteria:**

1. The additive D1 migrations apply safely before the reviewed D1-only Worker and matching image are admitted. <!-- @impl: .github/workflows/deploy.yml::Resolve, bind, and migrate usage database --> <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 --> <!-- @test: src/__tests__/ci/usage-d1-deploy.test.ts (creates one absent database with supported Wrangler arguments, resolves its ID, then applies migrations) -->
2. Create and Start admission is open in every environment immediately after deployment. <!-- @impl: src/lib/session-repository.ts::create --> <!-- @impl: src/lib/session-repository.ts::start --> <!-- @test: src/__tests__/lib/session-cutover.test.ts (opens Create and Start admission when the deployment completion migration runs) -->
3. Legacy KV session records have no authority, compatibility read, migration, or automatic deletion path. <!-- @test: src/__tests__/routes/session-public-d1.test.ts (serves D1 catalog/status/create without importing or deleting conflicting legacy records) --> <!-- @test: src/__tests__/routes/session-public-d1.test.ts (fails closed during a D1 outage rather than falling back to preserved legacy sessions) --> <!-- @impl: src/lib/session-repository.ts::D1SessionRepository -->

**Constraints:** The D1 authority starts clean; deployment never blocks a new session on legacy-session quiescence or cleanup.

**Priority:** P0

**Dependencies:** [REQ-SESSION-028](#req-session-028-session-authority-has-no-kv-compatibility-path)

**Verification:** Automated: [session-cutover.test.ts](../../src/__tests__/lib/session-cutover.test.ts), [usage-d1-deploy.test.ts](../../src/__tests__/ci/usage-d1-deploy.test.ts), [session-public-d1.test.ts](../../src/__tests__/routes/session-public-d1.test.ts)

**Status:** Implemented

---

<a id="req-session-012-wake-loop-prevention"></a>
### REQ-SESSION-012: Transport retry never invents lifecycle state

**Intent:** Browser reconnect and container forwarding preserve recoverable transport uncertainty without waking or disposing a surviving runtime.

**Applies To:** User

**Acceptance Criteria:**

1. Non-internal requests cannot auto-start a non-running container. After authenticated owner-scoped D1 authorization, a verified surviving workload may be forwarded through no-start even after coordinator reconstruction; SDK `running` is not definitive live-process evidence. <!-- @impl: src/container/index.ts::fetch --> <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @impl: src/lib/container-helpers.ts::forwardExisting --> <!-- @test: src/__tests__/container/index.test.ts (should return 503 for non-internal routes when container is not running) --> <!-- @test: src/__tests__/container/index.test.ts (forwards to the surviving runtime with its existing auth token despite stale persisted SDK state) --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (REQ-SESSION-012 AC1: absent runtime returns retryable 1013 without invoking auto-starting SDK fetch) -->
2. WebSocket upgrades receive authoritative 4503 only from current D1 `stopping` or `stopped` evidence; transient forwarding failures remain retryable. <!-- @impl: src/routes/terminal.ts::app --> <!-- @impl: src/container/index.ts::fetch --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (REQ-SESSION-012 AC2 / REQ-SEC-020 AC4: D1 %s remains retryable despite transient SDK stop) --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (REQ-SESSION-012 AC3 / REQ-SEC-020 AC2: D1 %s closes 4503 without probing a healthy SDK container) -->
3. During `unreachable`, terminal/editor objects, tabs and tiling remain mounted with bounded-jitter retries. <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (REQ-SESSION-012 AC3: unreachable reconciliation retains workspace tabs, focus and layout through recovery) --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-SESSION-012 AC3 / TERM-045 AC5: retains the same rendered panes through unreachable and recovery) --> <!-- @impl: web-ui/src/stores/terminal.ts::connect --> <!-- @impl: web-ui/src/lib/session-presentation.ts::isMountedLifecycle --> <!-- @impl: web-ui/src/stores/terminal-workspace.ts::terminalWorkspaceStore -->
4. Authenticated terminal upgrades reconnect to the verified existing process without starting a replacement or allocating a new generation. Absent or unverified runtime remains retryable; authoritative D1 `stopping`/`stopped` still closes 4503. <!-- @impl: src/container/index.ts::fetch --> <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/container/index.test.ts (native terminal upgrade fails closed when the existing runtime is absent) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-012 AC4: native terminal fetch probes only the existing port when SDK state is stale) --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (REQ-SESSION-012 AC4: a surviving runtime with stale SDK stopped state forwards health and authenticated terminal without starting) -->
5. Client countdown expiry changes messaging only and cannot declare stopped or dispose the workspace. <!-- @impl: web-ui/src/lib/sleep-timer.ts::getSleepTimerInfo --> <!-- @impl: web-ui/src/components/SessionStatCard.tsx::SessionStatCard --> <!-- @impl: web-ui/src/lib/session-presentation.ts::terminalPresentation --> <!-- @test: web-ui/src/__tests__/components/workspace-lifecycle.test.tsx (expires the rendered idle timer without inventing stopped lifecycle) -->
6. D1 read failure retains transport state and shows status unavailable; it never synthesizes `unreachable` or `stopped`. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatusesOnce --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-SESSION-010/012/029: failed status reads retain workspace authority and expose unavailable until recovery) -->

**Constraints:** Disposal requires newer authoritative stopping/stopped evidence or explicit successful deletion.

**Priority:** P0

**Dependencies:** [REQ-SESSION-010](#req-session-010-session-lifecycle-is-observable-from-one-d1-projection), [REQ-SESSION-021](#req-session-021-complete-transport-failure-opens-one-unreachable-incident)

**Verification:** Automated: [index.test.ts](../../src/__tests__/container/index.test.ts), [terminal-ws.test.ts](../../src/__tests__/routes/terminal-ws.test.ts), [session-presentation.test.ts](../../web-ui/src/__tests__/lib/session-presentation.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts), [TerminalArea.test.tsx](../../web-ui/src/__tests__/components/TerminalArea.test.tsx), [workspace-lifecycle.test.tsx](../../web-ui/src/__tests__/components/workspace-lifecycle.test.tsx); Manual: [Terminal snapshot restoration acceptance](../../documentation/lanes/terminal-and-ide.md#terminal-snapshot-restoration-acceptance)

**Status:** Implemented

---

### REQ-SESSION-245: Transport recovery terminal snapshot and editor state

**Intent:** Recovery restores authoritative terminal contents while retaining editor state and deliberately discarding prior terminal selection and viewport position.

**Applies To:** User

**Acceptance Criteria:**

1. Terminal reattachment replaces client buffer/scrollback with the authoritative host snapshot; prior terminal selection and viewport position are not retained. <!-- @manual: Terminal snapshot restoration acceptance --> <!-- @impl: web-ui/src/stores/terminal.ts::connect -->
2. During `unreachable` and terminal reattachment, editor state stays intact. <!-- @impl: web-ui/src/lib/session-presentation.ts::isMountedLifecycle -->

**Constraints:** Disposal requires newer authoritative stopping/stopped evidence or explicit successful deletion.

**Priority:** P0

**Dependencies:** [REQ-SESSION-010](#req-session-010-session-lifecycle-is-observable-from-one-d1-projection), [REQ-SESSION-021](#req-session-021-complete-transport-failure-opens-one-unreachable-incident), [REQ-SESSION-012](#req-session-012-transport-retry-never-invents-lifecycle-state)

**Verification:** Automated: [index.test.ts](../../src/__tests__/container/index.test.ts), [terminal-ws.test.ts](../../src/__tests__/routes/terminal-ws.test.ts), [session-presentation.test.ts](../../web-ui/src/__tests__/lib/session-presentation.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts), [TerminalArea.test.tsx](../../web-ui/src/__tests__/components/TerminalArea.test.tsx), [workspace-lifecycle.test.tsx](../../web-ui/src/__tests__/components/workspace-lifecycle.test.tsx); Manual: [Terminal snapshot restoration acceptance](../../documentation/lanes/terminal-and-ide.md#terminal-snapshot-restoration-acceptance)

**Status:** Implemented

---

### REQ-SESSION-013: Sleep timer countdown UI

**Intent:** Users see how much idle time remains before their session hibernates.

**Applies To:** User

**Acceptance Criteria:**

1. A clock icon on session cards shows the countdown. <!-- @impl: web-ui/src/components/SessionStatCard.tsx::SessionStatCard --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (Sleep timer icon) -->
2. The card countdown is visible when less than 10 minutes remain. <!-- @impl: web-ui/src/components/SessionStatCard.tsx::SessionStatCard --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (shows warning timer when remaining < 10 min) -->
3. The countdown uses the warning treatment below 10 minutes remaining. <!-- @impl: web-ui/src/lib/sleep-timer.ts::getSleepTimerInfo --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (shows warning timer when remaining < 10 min) -->
4. The countdown uses the critical treatment below 5 minutes remaining. <!-- @impl: web-ui/src/lib/sleep-timer.ts::getSleepTimerInfo --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (shows critical timer when remaining < 5 min) -->
5. The card countdown is hidden for stopped sessions. <!-- @impl: web-ui/src/components/SessionStatCard.tsx::SessionStatCard --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (hides timer for stopped sessions) -->
6. The countdown is computed from the configured idle timeout minus elapsed idle time. <!-- @impl: web-ui/src/lib/sleep-timer.ts::getSleepTimerInfo --> <!-- @test: web-ui/src/__tests__/lib/sleep-timer.test.ts (getSleepTimerInfo / REQ-SESSION-013 (sleep timer countdown UI)) -->
7. A running session's warning/critical display uses D1 terminal input from its current run, or that run's start time before new input; it never uses old input from an earlier run. <!-- @impl: src/lib/session-repository.ts::fromRow --> <!-- @impl: src/routes/session/crud.ts::toWorkspaceApiSession --> <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-013: list and detail use D1 input time for a resumed running session) --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-013: batch status uses fresh D1 terminal input for the countdown without changing lifecycle) --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-013: a restarted run without new input uses its current start rather than prior input) --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-013: batch status uses the current start when a restarted run has no new input) -->

**Notes:** Sleep timer countdown UI is validated manually per the checklist in [documentation/lanes/troubleshooting.md](../../documentation/lanes/troubleshooting.md).

**Constraints:**

- Non-running sessions retain lifecycle `lastActiveAt` for context expiry.
- Countdown projection cannot change stop authority.

**Priority:** P2

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** Automated: [session.test.ts](../../src/__tests__/routes/session.test.ts), [SessionStatCard.test.tsx](../../web-ui/src/__tests__/components/SessionStatCard.test.tsx), [sleep-timer.test.ts](../../web-ui/src/__tests__/lib/sleep-timer.test.ts)

**Status:** Implemented

---

### REQ-SESSION-036: Header sleep countdown presentation

**Intent:** The active running session's header independently presents its remaining idle time.

**Applies To:** User

**Acceptance Criteria:**

1. The header clock control shows the active running session's countdown. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (REQ-SESSION-036 AC1: opens the active running session countdown and explains idle stopping) -->
2. The header countdown is visible below ten minutes remaining. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (REQ-SESSION-036 AC2: shows the Header countdown only below ten minutes and before expiry ($remainingMs ms remaining)) -->
3. The header countdown uses warning treatment below ten minutes remaining. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (REQ-SESSION-036 $ac: renders $bucket with its warning or critical treatment ($remainingMs ms remaining)) -->
4. The header countdown uses critical treatment below five minutes remaining. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (REQ-SESSION-036 $ac: renders $bucket with its warning or critical treatment ($remainingMs ms remaining)) -->
5. Stopped or absent active sessions show no header countdown. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (REQ-SESSION-036 AC5: hides the Header countdown when the active session is $state even when another session is running) -->
6. The header recomputes remaining time from configured timeout minus elapsed idle time as time passes. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/lib/sleep-timer.ts::getSleepTimerInfo --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (REQ-SESSION-036 AC6: recomputes the configured idle countdown as time passes without session updates) -->
7. The header uses current-run terminal input or current-run start before new input, never prior-run input. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/lib/sleep-timer.ts::getSleepTimerInfo --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (REQ-SESSION-036 AC7: uses current-run start before new input ($context)) -->

**Constraints:** Header presentation cannot change Stop authority; non-running lifecycle context remains governed by [REQ-SESSION-013](#req-session-013-sleep-timer-countdown-ui).

**Priority:** P2

**Dependencies:** [REQ-SESSION-013](#req-session-013-sleep-timer-countdown-ui)

**Verification:** Automated: [Header.test.tsx](../../web-ui/src/__tests__/components/Header.test.tsx)

**Status:** Implemented

---

### REQ-SESSION-014: User-configurable auto-sleep timeout in Settings

**Intent:** Users choose how long their sessions stay alive when idle.

**Applies To:** User

**Acceptance Criteria:**

1. Settings offers exactly five selectable idle presets: 1h, 2h, 4h, 8h and 12h. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014: User-configurable auto-sleep timeout in Settings) -->
2. Free tier locked to 15m with upgrade hint. <!-- @impl: src/routes/container/lifecycle.ts::resolveEffectiveSleepAfter --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014 AC2: free tier locked to 15m idle timeout) -->
3. Admins can change the timeout regardless of subscription tier; non-admin paying users can change it while free users remain locked. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::canChangeSleepAfter --> <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014 AC3: admins and paying users can change sleepAfter) -->
4. Value saved to KV preferences and applied on next session start. <!-- @impl: src/routes/container/lifecycle-validation.ts::resolveEffectiveSleepAfter --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014: User-configurable auto-sleep timeout in Settings) --> <!-- @impl: src/routes/preferences.ts::app --> <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer -->
5. Reading saved legacy minute preferences does not rewrite their duration or replace them with the new default. <!-- @impl: src/routes/preferences.ts::app --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (keeps saved legacy %s readable until explicitly changed) -->
6. Legacy minute preferences display as disabled current values, never as new selectable presets. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/settings/SessionSection.test.tsx (displays legacy %s honestly without offering it as a new selection) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout)

**Verification:** Automated: [session-sleep-timeout.test.ts](../../src/__tests__/routes/session-sleep-timeout.test.ts), [SessionSection.test.tsx](../../web-ui/src/__tests__/components/settings/SessionSection.test.tsx)

**Status:** Implemented

---

### REQ-SESSION-015: Container Port-Readiness Gating with Pre-Warm Pre-Condition

**Intent:** A new container must bind its serving port quickly so Cloudflare's port-wait check succeeds, yet must refuse real terminal traffic until initial state restore and pre-warm are complete; the readiness gate sits between the port bind and the first accepted WebSocket upgrade.

**Applies To:** User

**Acceptance Criteria:**

1. The serving port binds within Cloudflare's container port-wait window even while initialization (R2 sync, MCP config merges) is still in progress. <!-- @impl: entrypoint.sh::TERMINAL_PID --> <!-- @manual: On a deployed cold start with delayed R2 initialization, confirm the serving port accepts health probes within the platform wait window. -->
2. The entrypoint writes an init-complete signal only after initial sync, file modifications, and tab-autostart configuration have completed. <!-- @test: host/__tests__/entrypoint-pi-warmup-guard.test.js (guarded warm-up call from entrypoint.sh still reaches the init-flag write when it fails) --> <!-- @manual -->
3. Terminal pre-warm waits up to 130 seconds for initialization, then starts the stamped Classic or Herdr surface; timeout proceeds in degraded state. <!-- @impl: host/src/server.ts::waitForInitFlag --> <!-- @manual: Hold back the init-complete signal and confirm pre-warm remains gated until the 130-second bound, then starts with `/health.initFlagObserved` still false. -->
4. The host rejects terminal WebSocket upgrades with retriable close code 1013 and a warming reason until pre-warm registers. <!-- @impl: host/src/server.ts::terminalServiceReady --> <!-- @impl: host/src/terminal-ws.ts::attachTerminalConnectionHandler -->
5. Pre-warm registration normally follows initialization; after the 130-second bound, degraded startup may register without requiring `initFlagObserved`. <!-- @impl: host/src/server.ts::waitForInitFlag --> <!-- @manual: Hold back the init-complete signal and confirm degraded startup registers after the 130-second bound with `/health.initFlagObserved` still false. -->

**Constraints:**

- Container readiness waits for sync success, sync timeout, or the host's 130-second degraded-start bound.
- Herdr also requires configured bootstrap detection, while Classic retains first-output settlement.
- Best-effort setup failures before the init-complete flag cannot abort the entrypoint.

**Priority:** P0

**Dependencies:** [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated: [entrypoint-pi-warmup-guard.test.js](../../host/__tests__/entrypoint-pi-warmup-guard.test.js), [terminal-ws.test.ts](../../src/__tests__/routes/terminal-ws.test.ts); Manual: [Startup and packaged image record acceptance](../../documentation/lanes/container.md#startup-and-packaged-image-record-acceptance)

**Status:** Implemented

---

### REQ-SESSION-246: Packaged Pi extension cache construction

**Intent:** The image packages the complete pre-transpiled Pi extension cache and fails closed on incomplete cache construction.

**Applies To:** User

**Acceptance Criteria:**

1. The image bakes a pre-transpiled cache for the full Pi extension set, with package extensions derived from the preseed manifest. <!-- @impl: Dockerfile::PI_WARM_PACKAGES --> <!-- @manual -->
2. The image build fails if the transpile cache is empty or a required package extension is absent. <!-- @impl: Dockerfile::goal_hit --> <!-- @manual -->

**Constraints:**

Runtime readiness remains governed by [REQ-SESSION-015](#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition); extracting image-construction criteria changes none of its gates.

**Priority:** P0

**Dependencies:** [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start), [REQ-SESSION-015](#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition)

**Verification:** Manual: [Startup and packaged image record acceptance](../../documentation/lanes/container.md#startup-and-packaged-image-record-acceptance)

**Status:** Implemented

---

### REQ-SESSION-016: User timezone propagated from preferences to container env

**Intent:** The capture pipeline and any other consumer of the user's timezone setting inside the container must receive the user's IANA timezone choice without manual env-var configuration; the preference is set via the preferences API and persists across restarts.

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

**Dependencies:** [REQ-SESSION-014](#req-session-014-user-configurable-auto-sleep-timeout-in-settings)

**Verification:** Automated: [preferences.test.ts](../../src/__tests__/routes/preferences.test.ts), [container-env.test.ts](../../src/__tests__/container/container-env.test.ts), [timezone-sync.test.ts](../../web-ui/src/__tests__/lib/timezone-sync.test.ts); Manual: [Session policy and preference record acceptance](../../documentation/lanes/container.md#session-policy-and-preference-record-acceptance)

**Status:** Implemented

---

### REQ-SESSION-017: Container health and startup-status API

**Intent:** The dashboard needs a non-blocking way to learn whether a user's container is up and, while it is coming up, how far through initialization it has progressed, so the loading experience reflects real container state instead of a fixed timer.

**Applies To:** User

**Acceptance Criteria:**

1. Health inspection reports whether the user's container is running and healthy, returning metrics on success and an error with 500 when the health check fails. <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (Container Status Routes) -->
2. Startup-status inspection returns the current initialization stage without blocking, carrying a stage label, 0-to-100 progress and a human-readable message. <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (GET /container/startup-status) -->
3. The reported stage reflects real container state: `stopped` when state is indeterminate, `starting` before services respond, `syncing` during the initial R2 sync, `verifying` after sync while terminals are not yet up, `mounting` during terminal pre-warm, and `ready` when all services are up. <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (GET /container/startup-status) -->
4. Failed initial R2 sync reports an error stage and sync error while terminal service is unavailable. After terminal/pre-warm readiness, degraded startup may report `ready` with failed `syncStatus` retained, never successful restoration. Skipped sync (no R2 credentials) still reaches `ready` with its reason. <!-- @impl: src/routes/container/status.ts::buildSyncFailedResponse --> <!-- @test: src/__tests__/routes/container-status.test.ts (returns error stage when sync failed during startup) --> <!-- @impl: src/routes/container/status.ts::buildReadyResponse --> <!-- @test: src/__tests__/routes/container-status.test.ts (REQ-SESSION-017 AC4: becomes ready after degraded prewarm while retaining failed sync status) -->
5. A transient private health or sessions probe failure remains retryable as `starting` or `verifying`. <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (keeps startup retryable when the health fetch rejects during boot) --> <!-- @test: src/__tests__/routes/container-status.test.ts (keeps terminal verification retryable when the sessions fetch rejects) -->
6. Another unexpected startup-status computation failure is caught and returned as an error stage rather than propagating an unhandled 500. <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (returns error stage on unexpected exception) --> <!-- @manual -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-SESSION-015](#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition)

**Verification:** Automated: [container-status.test.ts](../../src/__tests__/routes/container-status.test.ts); Manual: [Session policy and preference record acceptance](../../documentation/lanes/container.md#session-policy-and-preference-record-acceptance)

**Status:** Implemented

---

<a id="req-session-018-persisted-status-is-authoritative-on-container-exit"></a>
### REQ-SESSION-018: D1 lifecycle evidence is generation-fenced

**Intent:** D1 is the shared lifecycle authority, while the Durable Object owns process control and may project only observations belonging to its assigned execution generation.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. Persisted backend lifecycle is exactly `stopped`, `starting`, `running`, `unreachable`, or `stopping`; ACTIVE and IDLE are never persisted. <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (AC2/4: database rejects invalid authority update %s without changing the row) --> <!-- @impl: src/lib/session-repository.ts::SessionLifecycleState --> <!-- @impl: web-ui/src/lib/session-presentation.ts::terminalPresentation -->
2. Creating a session inserts a complete D1 row in `stopped`; only an accepted Start advances its lifecycle generation and enters `starting`. <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-001 AC3 / REQ-SESSION-018 AC2: optional creation survives a new repository instance with owner isolation) --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-018 AC3/5: stale generation and non-increasing sequence leave the durable projection unchanged) --> <!-- @impl: src/lib/session-repository.ts::create --> <!-- @impl: src/lib/session-repository.ts::start -->
3. Runtime projection accepts a write only when its generation matches and its observation sequence is greater than the last accepted sequence. <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-018 AC3/5: stale generation and non-increasing sequence leave the durable projection unchanged) --> <!-- @impl: src/lib/session-repository.ts::project -->
4. Delayed callbacks retain their original generation and cannot mutate a replacement lifecycle; delayed writers use conditional `UPDATE` and cannot recreate a deleted row. <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-018 AC4 / REQ-SESSION-028 AC4: retained stopped row restarts and Delete fences late writers) --> <!-- @impl: src/container/container-metrics.ts::captureMetricsExecution --> <!-- @impl: src/lib/session-repository.ts::project --> <!-- @impl: src/lib/session-repository.ts::deleteConfirmed -->
5. Every accepted mutation advances a response revision used with generation to order API responses. <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-018 AC3/5: stale generation and non-increasing sequence leave the durable projection unchanged) --> <!-- @impl: src/lib/session-repository.ts::project --> <!-- @impl: src/lib/session-repository.ts::start --> <!-- @impl: web-ui/src/lib/session-presentation.ts::applyOrderedProjection --> <!-- @impl: src/lib/session-repository.ts::updateMutable --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-001: mutable metadata preserves creation identity and workspace choices) -->
6. A zero-change or ambiguous D1 result is not ownership proof; exceptional reconciliation uses one bounded read and remains fail closed. <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (reconciles a lost write acknowledgement idempotently; unreadable D1 grants no authority) --> <!-- @impl: src/lib/session-repository.ts::reconcileRuntime --> <!-- @impl: src/lib/session-repository.ts::claimUnreachableTermination -->
7. Only a generation-fenced positive process-exit monitor observation or awaited destroy confirming exit writes `stopped`; transport failure, D1 failure, signal acceptance, elapsed time, an owner read, or SDK state does not. Uncertain exit preserves `stopping` and termination ownership. <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @impl: src/container/container-lifecycle.ts::confirmMonitoredExit --> <!-- @impl: src/container/index.ts::monitorExistingRuntime --> <!-- @impl: src/lib/session-repository.ts::confirmStopped --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-SESSION-035: aged Stop ownership remains fenced until its current-generation exit is confirmed) -->

**Constraints:**

- D1 owns shared lifecycle truth.
- The Durable Object retains SDK/process identity, assigned generation, observation sequence and schedules, but not competing lifecycle business truth.

**Priority:** P0

**Dependencies:** [REQ-SESSION-001](#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** Automated: [session-authority-outcomes.test.ts](../../src/__tests__/lib/session-authority-outcomes.test.ts), [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts)

**Status:** Implemented

---

### REQ-SESSION-033: Start callbacks preserve lifecycle ownership

**Intent:** Repeated or delayed start callbacks cannot disturb the current session lifecycle.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. A replay for an already-running generation preserves established lifecycle ownership. <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @test: src/__tests__/container-metrics.test.ts (preserves generation ownership and idle baseline on a duplicate onStart) -->
2. Stale or stopping start callbacks cannot clear lifecycle ownership or re-arm lifecycle work. <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-SESSION-033: fresh-start completion preserves a newer shutdown when durable fencing fails) --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-SESSION-033: stale fresh-start handoff cannot clear an assigned generation shutdown fence) --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-SESSION-033: %s onStart preserves the %s shutdown fence and sealed principal) --> <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @test: src/__tests__/container-metrics.test.ts (rejects a stale onStart replay without clearing shutdown ownership) --> <!-- @test: src/__tests__/container-metrics.test.ts (rejects a stopping onStart callback without clearing shutdown ownership) -->

**Constraints:** Same-generation replays and rejected stale or stopping callbacks do not project lifecycle transitions.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced)

**Verification:** Automated: [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [terminal-native-pi-authority.test.ts](../../src/__tests__/routes/terminal-native-pi-authority.test.ts)

**Status:** Implemented

---

### REQ-SESSION-035: Stale stopping retains ownership until confirmed exit

**Intent:** An interrupted Stop request remains visible and retryable without declaring a possibly live workload stopped.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. An owner batch-status read leaves `stopping` sessions in `stopping` regardless of age; it cannot turn elapsed time or SDK state into process-exit evidence. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-035: old stopping remains owner-scoped and retains managed-mutation ownership without exit evidence) -->
2. Old `stopping` rows retain termination and unreachable ownership, editor readiness, revision and transition reason until positive exit confirmation for their generation. <!-- @impl: src/lib/session-repository.ts::confirmStopped --> <!-- @impl: src/container/container-lifecycle.ts::confirmMonitoredExit --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-SESSION-035: aged Stop ownership remains fenced until its current-generation exit is confirmed) --> <!-- @test: src/__tests__/container/index.test.ts (confirms a running session only when its attached process monitor resolves) -->
3. A stopping row keeps managed-mutation ownership and cannot claim a replacement Start; other owners and lifecycle states remain unchanged. <!-- @impl: src/lib/session-helpers.ts::hasOwningSessionContainer --> <!-- @impl: src/lib/session-repository.ts::start --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-035: old stopping remains owner-scoped and retains managed-mutation ownership without exit evidence) --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-SESSION-035: aged Stop ownership remains fenced until its current-generation exit is confirmed) -->

4. Once the session DO accepts Stop, its complete claim, pending Protected Action cancellation, existing bounded graceful teardown and D1 exit confirmation continue independently of the calling HTTP request. <!-- @impl: src/container/index.ts::container --> <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @test: src/__tests__/container/session-stop.test.ts (protects the entire Stop when the caller disconnects during %s I/O) -->
5. Before DO acceptance the Worker does not claim `stopping`. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/session.test.ts (REQ-SESSION-035: an RPC rejected before DO acceptance cannot leave a Worker-owned stopping claim) -->

**Constraints:**

- No automatic existing-record repair, migration or recovery scheduler.
- Explicit owner Stop retry uses current D1 authority.
- Stale duration is diagnostic, not authority to clear a termination intent.
- Browser-independent completion does not promise automatic recovery across DO crashes or persistent D1 outages.
- Existing final notification drain, authenticated final sync and teardown deadlines remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced), [REQ-SESSION-011](#req-session-011-graceful-shutdown-with-final-sync)

**Verification:** Automated: [session.test.ts](../../src/__tests__/routes/session.test.ts), [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts), [session-stop.test.ts](../../src/__tests__/container/session-stop.test.ts)

**Status:** Implemented

---

### REQ-SESSION-042: Same-generation Stop retry authority

**Intent:** Explicit Stop retries recover the original termination intent without repeating completed teardown or affecting a replacement workload.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. Stop retry after coordinator reconstruction, operational identity cleanup or transient D1 failure reuses the same generation's current termination intent. <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @test: src/__tests__/container/session-stop.test.ts (finishes the claimed Stop after caller loss and erased operational identity, preserving the session for restart) --> <!-- @test: src/__tests__/container/session-stop.test.ts (retains stopping when D1 confirmation fails and completes after recovery with a new coordinator) --> <!-- @test: src/__tests__/container/session-stop.test.ts (retains the same intent while retrying a reconstructed stopping generation) -->
2. Retry after confirmed completion succeeds idempotently without another teardown. <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @test: src/__tests__/container/session-stop.test.ts (treats a retry after a lost successful response as already completed) -->
3. Stop retry rejects a mismatched owner/session identity, replacement lifecycle generation or differently pinned termination intent without terminating another workload. <!-- @impl: src/container/index.ts::container --> <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @test: src/__tests__/container/session-stop.test.ts (rejects a termination intent pinned to a different generation without changing ownership) --> <!-- @test: src/__tests__/container/session-stop.test.ts (rejects a stale retry without terminating a replacement generation) --> <!-- @test: src/__tests__/container/session-stop.test.ts (rejects an owner/session address mismatch without claiming or terminating either session) -->


**Constraints:**

- No automatic existing-record repair, migration or recovery scheduler.
- Explicit owner Stop retry uses current D1 authority.
- Stale duration is diagnostic, not authority to clear a termination intent.
- Browser-independent completion does not promise automatic recovery across DO crashes or persistent D1 outages.
- Existing final notification drain, authenticated final sync and teardown deadlines remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-SESSION-035](#req-session-035-stale-stopping-retains-ownership-until-confirmed-exit), [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced), [REQ-SESSION-011](#req-session-011-graceful-shutdown-with-final-sync)

**Verification:** Automated: [session-stop.test.ts](../../src/__tests__/container/session-stop.test.ts)

**Status:** Implemented

---

### REQ-SESSION-037: Dashboard navigation remains available during startup

**Intent:** Leaving a session's startup progress selects a usable dashboard without canceling or taking ownership of background startup.

**Applies To:** User (desktop and mobile)

**Acceptance Criteria:**

1. Browser Back to the dashboard and the dashboard button render usable dashboard controls during session start/resume without requiring a page reload. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (preserves startup navigation at %s px via %s through background %s) -->
2. An initializing terminal session cannot suppress an explicitly selected dashboard, including when that session is not selected. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-SESSION-037: renders the selected dashboard while a %s terminal retains startup progress) --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-SESSION-037: another initializing session cannot hide the dashboard as background startup completes or fails) -->
3. Dashboard navigation does not issue Stop, duplicate Start or prematurely dismiss session readiness. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (preserves startup navigation at %s px via %s through background %s) -->
4. Returning to the session restores its owned startup/progress or ready surface. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (preserves startup navigation at %s px via %s through background %s) -->
5. Background startup completion or failure does not hide the selected dashboard or steal navigation ownership. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (preserves startup navigation at %s px via %s through background %s) -->
6. Existing VS Code and MultiView workspace behavior remains intact. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (keeps Dashboard mounted while a VS Code session initializes) --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-012: does not clear a pending MultiView workspace before the terminal transition renders it) -->


**Constraints:**

- Keep the existing view transitions, startup protocol and workspace ownership.
- No router redesign or backend lifecycle change for navigation.

**Priority:** P0

**Dependencies:** [REQ-SESSION-010](#req-session-010-session-lifecycle-is-observable-from-one-d1-projection)

**Verification:** Automated: [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx), [TerminalArea.test.tsx](../../web-ui/src/__tests__/components/TerminalArea.test.tsx)

**Status:** Implemented

---

### REQ-SESSION-034: Durable idle baseline survives coordinator reconstruction

**Intent:** A reconstructed coordinator cannot stop a healthy no-input container from invalid or unavailable startup timing evidence.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. For no-input idle timing, enforcement reuses a valid durable container-start reference after coordinator reconstruction; absent or invalid references initialize one durable fallback. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (persists one fallback baseline across a second coordinator reconstruction) --> <!-- @test: src/__tests__/container-metrics.test.ts (replaces non-finite persisted startup baselines) -->
2. Unreadable or unpersistable no-input timing evidence skips idle termination while observation and polling continue. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (does not authorize idle stopping when fallback baseline persistence fails) --> <!-- @test: src/__tests__/container-metrics.test.ts (keeps host transport healthy when startup-reference storage cannot be read) -->

**Constraints:** A valid expired idle reference remains eligible for termination under [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout). <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-004/034: valid input enforces its 1h deadline with %s startup timing) -->

**Priority:** P0

**Dependencies:** [REQ-SESSION-004](#req-session-004-idle-containers-sleep-after-configurable-timeout), [REQ-SESSION-005](#req-session-005-input-based-idle-detection)

**Verification:** Automated: [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts)

**Status:** Implemented

---

### REQ-SESSION-019: Final-sync drain endpoint authentication

**Intent:** Every Durable-Object-side final-sync request must authenticate with the container token so teardown cannot lose the user's last edits at the host authorization boundary.

**Applies To:** User

**Acceptance Criteria:**

1. Every drain request authenticates with the container token; missing credentials suppress the request and record a bounded teardown audit. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-lifecycle.ts::drainFinalSyncAudited --> <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-011: the final-sync drain authenticates with the container token captured BEFORE the storage clear (401 regression)) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-019 AC1: missing token emits no outgoing request and leaves a readable bounded teardown audit) --> <!-- @test: src/__tests__/container/container-metrics-drain.test.ts (sends the stored container token as a Bearer header on the drain request) --> <!-- @test: src/__tests__/container/container-metrics-drain.test.ts (REQ-SESSION-019 AC1: %s credentials suppress the request and retain a bounded audit) --> <!-- @test: src/__tests__/container/container-metrics-drain.test.ts (REQ-SESSION-019 AC1: %s audit storage cannot wedge the best-effort drain) --> <!-- @test: src/__tests__/container/container-metrics-drain.test.ts (REQ-SESSION-019 AC1: a late credential read cannot issue a request after the drain budget) -->

**Constraints:** None.

**Priority:** P0

**Dependencies:** [REQ-SESSION-011](#req-session-011-graceful-shutdown-with-final-sync)

**Verification:** Automated: [container-metrics-drain.test.ts](../../src/__tests__/container/container-metrics-drain.test.ts), [index.test.ts](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

<a id="req-session-020-the-metrics-alarm-outlives-a-container-that-stops-answering"></a>
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

**Verification:** Automated: [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [session-unreachable-policy.test.ts](../../src/__tests__/lib/session-unreachable-policy.test.ts)

**Status:** Implemented

---

<a id="req-session-021-unreachable-container-transport-initiates-coordinator-reconstruction"></a>
### REQ-SESSION-021: Complete transport failure opens one unreachable incident

**Intent:** Host transport uncertainty becomes recoverable shared state without stopping or replacing the workload.

**Applies To:** User

**Acceptance Criteria:**

1. A complete bounded host-transport failure conditionally opens one incident for the current generation and persists `unreachable`, incident identity, first-observed time and an absolute deadline 120 seconds later. <!-- @impl: src/lib/session-repository.ts::observeUnreachable --> <!-- @impl: src/lib/session-repository.ts::observedAtMs + 120_000 = 120_000 --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (persists the first complete failure, joins replay/reconstruction without extending its 120s deadline) -->
2. Opening an incident occurs before Durable Object reset or reconstruction and leaves the container and PTY untouched. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (D1 remains authoritative across both bounded reconstructions and exhaustion, without restarting the incident) -->
3. Repeated failures join the existing incident and never move its first-observed time or deadline. <!-- @impl: src/lib/session-repository.ts::observeUnreachable --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (persists the first complete failure, joins replay/reconstruction without extending its 120s deadline) -->
4. D1 failure is treated as persistence uncertainty and never opens a transport incident. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (D1 outage or ambiguous failed projection cannot authorize reconstruction, SIGTERM or force) -->
5. `unreachable` retains workload ownership, counts toward best-effort capacity and blocks destructive managed reconciliation. <!-- @impl: src/lib/session-authority.ts::countWorkloadOwningSessions --> <!-- @impl: src/lib/session-helpers.ts::hasOwningSessionContainer --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (an unreachable workload retains capacity and managed reconciliation ownership) -->
6. Accelerated recovery work remains non-billable and does not create another quota or usage source. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (all failure, reconstruction, recovery and stopping ticks skip actual Timekeeper I/O and quota-stop drains) -->

**Constraints:** The deadline is earliest termination eligibility, not guaranteed exit time.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced), [REQ-SESSION-020](#req-session-020-runtime-observation-is-bounded-and-projected-once)

**Verification:** Automated: [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts)

**Status:** Implemented

---

<a id="req-session-022-transport-recovery-is-confirmed-and-bounded"></a>
### REQ-SESSION-022: Unreachable recovery preserves process identity

**Intent:** Coordinator reconstruction reattaches to the existing process and confirms recovery only from current-generation host evidence.

**Applies To:** User

**Acceptance Criteria:**

1. A reconstructed Durable Object performs one bounded primary-consistent D1 recovery read and adopts only its previously assigned generation, incident and absolute deadline. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (D1 remains authoritative across both bounded reconstructions and exhaustion, without restarting the incident) -->
2. Reconstruction probes the existing container through retained SDK/process identity and never invokes Start or allocates another generation. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (SDK false uses an authenticated no-start probe; HTTP and malformed JSON are reachability, not incidents) -->
3. A qualifying host response proves transport reachability; a valid snapshot separately determines whether metrics and activity may be projected. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (a healthy host with a failed D1 projection or local timing read never opens a transport incident) -->
4. Recovery conditionally clears the same incident and returns `unreachable` to `running` without replacing the container or PTY. <!-- @impl: src/lib/session-repository.ts::recoverUnreachable --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (recovers on any same-incident host response before deadline without an ordinary projection bypass) -->
5. Reconstruction failure or another transport failure retains the same incident and deadline. <!-- @impl: src/lib/session-repository.ts::observeUnreachable --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (D1 remains authoritative across both bounded reconstructions and exhaustion, without restarting the incident) -->
6. Old callbacks, alarms and reconstruction work cannot adopt a newer generation. <!-- @impl: src/container/container-metrics.ts::captureMetricsExecution --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (a late failed observation and old alarm cannot affect a replacement generation) -->

**Constraints:** Existing Durable Object reconstruction and PTY reattachment behavior is preserved.

**Priority:** P0

**Dependencies:** [REQ-SESSION-021](#req-session-021-complete-transport-failure-opens-one-unreachable-incident)

**Verification:** Automated: [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts)

**Status:** Implemented

---

<a id="req-session-023-accelerated-recovery-preserves-usage-and-quota"></a>
### REQ-SESSION-023: Recovery and persistence uncertainty do not bill usage

**Intent:** Recovery probes and D1 reconciliation do not alter the user's usage or quota.

**Applies To:** User

**Acceptance Criteria:**

1. Accelerated transport-recovery probes add no billable usage and do not ping Timekeeper. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (all failure, reconstruction, recovery and stopping ticks skip actual Timekeeper I/O and quota-stop drains) -->
2. D1 persistence-reconciliation work adds no billable usage and does not change quota. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (a hung %s is bounded and nonbillable; late SQL cannot overwrite a newer %s) -->
3. Unreachable time and stopping retries do not create a second accounting source. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (all failure, reconstruction, recovery and stopping ticks skip actual Timekeeper I/O and quota-stop drains) -->
4. Ordinary classified-input idle policy and Timekeeper authority remain unchanged. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (an exhausted incident recovers without billing, then ordinary healthy usage and the single projection resume) -->

**Constraints:** Accounting remains owned by the existing usage subsystem.

**Priority:** P0

**Dependencies:** [REQ-SESSION-021](#req-session-021-complete-transport-failure-opens-one-unreachable-incident)

**Verification:** Automated: [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts)

**Status:** Implemented

---

<a id="req-session-024-transport-recovery-evidence-is-durable-and-observable"></a>

<a id="req-session-024-transport-recovery-ownership-is-durable"></a>
### REQ-SESSION-024: Recovery deadline and termination intent are durable

**Intent:** Recovery ownership survives coordinator replacement, and deadline expiry cannot target a replacement process.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. D1 retains incident identity, first-observed time, absolute deadline, lifecycle generation and termination intent until recovery or confirmed exit resolves them. <!-- @impl: src/lib/session-repository.ts::observeUnreachable --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (persists the first complete failure, joins replay/reconstruction without extending its 120s deadline) -->
2. At the first available execution at or after the deadline, the current owner conditionally claims `stopping` for the same generation and incident. <!-- @impl: src/lib/session-repository.ts::claimUnreachableTermination --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (claims only the exact expired incident, blocks Start, and never treats signal acceptance as exit) -->
3. Outstanding termination intent blocks Start until confirmed exit or a reviewed reconciliation resolves it. <!-- @impl: src/lib/session-repository.ts::start --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (claims only the exact expired incident, blocks Start, and never treats signal acceptance as exit) -->
4. Immediately before signalling, execution rechecks generation ownership and cannot signal a replacement generation. <!-- @impl: src/container/container-lifecycle.ts::terminateUnreachable --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (a teardown epoch change during D1 authorization prevents a stale native %s) -->
5. Recovery sends low-level SIGTERM even when the SDK `running` flag is transiently false. <!-- @impl: src/container/container-lifecycle.ts::terminateUnreachable --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (first failed probe is nonbillable, survives reconstruction, signals at 120s even with SDK false, destroys only after 135s grace) -->
6. Unconfirmed recovery termination escalates to one durably claimed, same-generation native destruction attempt after the existing 135-second shutdown budget. <!-- @impl: src/container/container-lifecycle.ts::terminateUnreachable --> <!-- @impl: src/container/container-lifecycle.ts::hardKillMs = 135_000 --> <!-- @impl: src/lib/session-repository.ts::markRecoveryForceStarted --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (first failed probe is nonbillable, survives reconstruction, signals at 120s even with SDK false, destroys only after 135s grace) --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (the automatic force CAS consumes only the exact intent with no pending boundary and preserves its grace origin) -->
7. Signal acceptance and failed or unconfirmed destruction retain actionable `stopping` ownership; only generation-fenced positive process exit or awaited destruction confirming exit transitions to `stopped`. <!-- @impl: src/lib/session-repository.ts::confirmStopped --> <!-- @impl: src/container/container-lifecycle.ts::terminateUnreachable --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (a failed force is durable across reconstruction; only manual %s retries native destruction) --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (a never-settling provider is bounded with no automatic alarm, yet late completion confirms the current generation) -->

**Constraints:**

- Exactly-once external signalling is not promised.
- Established final-event, final-sync and teardown deadlines are unchanged.

**Priority:** P0

**Dependencies:** [REQ-SESSION-022](#req-session-022-unreachable-recovery-preserves-process-identity)

**Verification:** Automated: [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts)

**Status:** Implemented

---

<a id="req-session-025-transport-recovery-failures-are-observable"></a>
### REQ-SESSION-025: Lifecycle recovery is observably correlated

**Intent:** Operators receive bounded, privacy-safe evidence for lifecycle transitions without high-volume normal-path logging.

**Applies To:** Operator

**Acceptance Criteria:**

1. Structured recovery events identify generation and available incident for opening, reconstruction, recovery and recovery-expiry termination/signalling. Context-bearing final-sync and exit observations retain their known lifecycle identity; unavailable identity remains explicit. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/container-lifecycle.ts::terminateUnreachable --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-025 AC1-2: user Stop retains final-sync context and confirms only after native completion) -->
2. Event reasons or bounded error categories distinguish supported user, idle, quota, recovery-expiry, host-transport, D1-outage and platform/unknown evidence without inventing an initiator. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/container-lifecycle.ts::onError --> <!-- @test: src/__tests__/container-metrics.test.ts (AC1/4: an SDK error retains actionable context without exporting private payloads or changing retry timing) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-025 AC1-2: $completion exit preserves observed incident without inventing an initiator) -->
3. Normal metrics ticks, individual WebSocket retries and unchanged state are not logged per occurrence. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (AC3: repeated healthy observations retain runtime state without repeating ordinary log output) -->
4. Logs contain no credentials, tokens, transcript or terminal content, or per-file paths. <!-- @impl: src/routes/container/lifecycle.ts::runStartStage --> <!-- @impl: src/routes/session/crud.ts::app --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-025 AC4: teardown %s retains safe diagnostics and best-effort/exit authority) --> <!-- @test: src/__tests__/index.test.ts (REQ-SESSION-025: final Worker lifecycle error logging) -->
5. D1 row and statement metadata is sampled or aggregated during integration rather than emitted as another high-volume stream. <!-- @manual: Integration D1 metadata sampling -->

**Notes:** Recovery observations use available identities and bounded categories, not a universal event enum or reconstructed initiator. [Integration aggregation](../../documentation/lanes/container.md#integration-d1-metadata-sampling) uses existing platform analytics rather than an application telemetry stream.

**Constraints:** Use the existing structured logger; no new telemetry framework.

**Priority:** P0

**Dependencies:** [REQ-SESSION-024](#req-session-024-recovery-deadline-and-termination-intent-are-durable)

**Verification:** Automated: [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts), [container/index.test.ts](../../src/__tests__/container/index.test.ts), [index.test.ts](../../src/__tests__/index.test.ts), [lifecycle.test.ts](../../src/__tests__/routes/container/lifecycle.test.ts), [session.test.ts](../../src/__tests__/routes/session.test.ts); Manual: [Integration D1 metadata sampling](../../documentation/lanes/container.md#integration-d1-metadata-sampling)

**Status:** Implemented

---

<a id="req-session-026-transport-recovery-scheduling-failures-reach-lifecycle-callers"></a>
### REQ-SESSION-026: Lifecycle scheduling and persistence failures remain actionable

**Intent:** Recovery work never reports success when required scheduling or authoritative persistence did not complete.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. Failure to schedule required recovery, reconciliation, termination or confirmed-exit work is logged with generation and available incident identity. After existing bounded retry handling, terminal scheduling failure propagates to its lifecycle caller. <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (required scheduling failure is observable and does not signal, reset, or release ownership) --> <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/container-metrics.ts::scheduleRecoveryOwnershipReadRetry --> <!-- @impl: src/container/container-lifecycle.ts::onStop --> <!-- @impl: src/container/container-lifecycle.ts::onError --> <!-- @test: src/__tests__/container-metrics.test.ts (propagates a required ownership-read retry alarm failure without billing or destructive effects) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-026 AC1: required alarm failure retains the observed D1 incident identity) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-026 AC1: %s callback alarm failures retain captured context and ownership) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-026 AC1: %s stop propagates its required alarm failure, not an ancillary failure) -->
2. Failed authoritative mutations retain retryable ownership and cannot be converted into `stopped` or successful recovery. <!-- @impl: src/container/container-lifecycle.ts::terminateUnreachable --> <!-- @impl: src/lib/session-repository.ts::recoverUnreachable --> <!-- @impl: src/lib/session-repository.ts::confirmStoppedOrObserved --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (D1 outage or ambiguous failed projection cannot authorize reconstruction, SIGTERM or force) --> <!-- @test: src/__tests__/container/session-stop.test.ts (retains stopping when D1 confirmation fails and completes after recovery with a new coordinator) -->
3. Retry work is bounded, duplicate-safe and non-billable. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: src/container/container-lifecycle.ts::terminateUnreachable --> <!-- @impl: src/lib/session-repository.ts::markRecoveryForceStarted --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (first failed probe is nonbillable, survives reconstruction, signals at 120s even with SDK false, destroys only after 135s grace) --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (a failed force is durable across reconstruction; only manual %s retries native destruction) -->
4. If lifecycle authority cannot be established, Start, Stop, Delete, migration and destructive reconciliation fail closed. <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @impl: src/container/container-lifecycle.ts::stopSession --> <!-- @impl: src/routes/session/crud.ts::app --> <!-- @impl: src/lib/migration-containers.ts::hasHealthyContainer --> <!-- @impl: src/lib/session-helpers.ts::hasOwningSessionContainer --> <!-- @test: src/__tests__/container/session-stop.test.ts (does not claim or destroy on a D1 outage before the claim and permits retry after recovery) --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC5: unavailable D1 rejects admission without changing durable authority) -->

**Constraints:** A D1 failure and a host-transport failure remain distinct conditions.

**Priority:** P0

**Dependencies:** [REQ-SESSION-024](#req-session-024-recovery-deadline-and-termination-intent-are-durable)

**Verification:** Automated: [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [index.test.ts](../../src/__tests__/container/index.test.ts), [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts), [session-stop.test.ts](../../src/__tests__/container/session-stop.test.ts)

**Status:** Implemented

---

### REQ-SESSION-031: D1 session schema stores complete ordered authority

**Intent:** One minimal owner-indexed D1 table stores complete non-secret session records and the fields needed for fenced lifecycle projection.

**Applies To:** System (session lifecycle)

**Acceptance Criteria:**

1. The session table has primary key `(owner_key, session_id)` and complete API fields for name, creation/access timestamps, agent, workspace, terminal mode, tab configuration and clone intent. <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-001 AC3 / REQ-SESSION-031 AC1: valid agent and six configured tabs retain complete nonsecret creation data) --> <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions -->
2. Lifecycle columns store state, generation, revision, last accepted observation sequence, transition timestamps, reason, readiness and readiness error under database checks. <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (AC2/4: database rejects invalid authority update %s without changing the row) --> <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions -->
3. Projection columns store last classified input plus latest CPU, memory, disk, sync and observation time without retaining metric history. <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-018 AC3/5: stale generation and non-increasing sequence leave the durable projection unchanged) --> <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions -->
4. Incident columns store incident identity, first-observed time and absolute deadline; termination columns store intent identity, generation, claim and signal timestamps. <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (AC2/4: database rejects invalid authority update %s without changing the row) --> <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions -->
5. The only required secondary index leads with `owner_key` and supports the batch ordering; frequently updated lifecycle or metric fields are not indexed. <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE INDEX runtime_sessions_owner_activity --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (migration creates one owner-led projection index) -->
6. A singleton cutover table records `pending` or `complete`, and Create/Start require `complete`; its migration default is `pending`. <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (AC6: database rejects a second cutover identity or unsupported cutover state) --> <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE session_cutover --> <!-- @impl: src/lib/session-repository.ts::create --> <!-- @impl: src/lib/session-repository.ts::start -->
7. The additive migration is idempotently managed by the existing usage-database migration path and does not alter analytics tables. <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions --> <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 --> <!-- @test: src/__tests__/ci/usage-d1-deploy.test.ts (creates one absent database with supported Wrangler arguments, resolves its ID, then applies migrations) --> <!-- @manual: D1 additive migration review -->

**Constraints:**

- Times are UTC ISO-8601 text except explicit millisecond deadlines where arithmetic is required.
- JSON configuration columns are validated at the typed repository boundary.
- Secrets are excluded.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](#req-session-018-d1-lifecycle-evidence-is-generation-fenced), [REQ-SESSION-030](#req-session-030-one-time-clean-slate-cutover-is-guarded-and-exact)

**Verification:** Automated: [session-authority-outcomes.test.ts](../../src/__tests__/lib/session-authority-outcomes.test.ts), [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts), [session-cutover.test.ts](../../src/__tests__/lib/session-cutover.test.ts); Manual: [D1 additive migration review](../../documentation/lanes/billing.md#d1-additive-migration-review)

**Status:** Implemented

---

### REQ-OPS-048: Cleanup-safe service and Browser IDE state

**Intent:** Clearing disposable temporary files must not break service lifecycle or Browser IDE continuity.

**Applies To:** Operator

**Acceptance Criteria:**

1. Shutdown reads service PID files from protected runtime storage. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC3 / REQ-OPS-048 AC1: trap handler kills services through protected runtime PID files) -->
2. Host health reports live readiness independently of disposable files. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/request-router.test.js (REQ-OPS-048 AC2: serves /health auth-exempt and reads readiness flags live) -->
3. Browser IDE restart requests use the protected trigger file. <!-- @impl: host/src/vscode-proxy.ts::requestOpenvscodeStart --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-OPS-048 AC3: writes the protected restart trigger on first call) -->
4. Browser IDE data and extension roots remain in protected runtime storage. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-039 AC1 / REQ-OPS-048 AC4: code-server uses protected data and extension roots) -->
5. Extension state capture remains operational through its protected session paths. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC4 + REQ-IDE-036 AC4+AC5+AC6 + REQ-IDE-038 AC5 + REQ-OPS-048 AC5: capture preserves state) -->

**Constraints:** Service and Browser IDE runtime data remains container-scoped and is not synced to R2.

**Priority:** P0

**Dependencies:** [REQ-OPS-010](operations.md#req-ops-010-graceful-container-shutdown-preserves-data), [REQ-IDE-003](browser-ide.md#req-ide-003-ide-lifecycle-and-availability)

**Verification:** Automated: [entrypoint-shutdown.test.js](../../host/__tests__/entrypoint-shutdown.test.js), [request-router.test.js](../../host/__tests__/request-router.test.js), [openvscode-proxy.test.js](../../host/__tests__/openvscode-proxy.test.js), [entrypoint-openvscode.test.js](../../host/__tests__/entrypoint-openvscode.test.js), [extension-persistence.test.ts](../../openvscode/agent-sidebar/test/extension-persistence.test.ts)

**Status:** Implemented

---
