# Browser IDE

A full browser editor for an advanced running session. The editor opens that session's workspace, stays isolated from every other session, and uses the existing authenticated session-container path.

**Domain owner:** Worker editor route, container host proxy, editor lifecycle supervisor, and header launch control

### Key Concepts

- **Browser IDE** -- The per-session OpenVSCode editor defined in the [glossary](glossary.md#glossary).
- **Session isolation** -- Editor routing, browser storage, server state, and workspace selection belong to one session and are never shared through the user's storage identity.
- **Lazy start** -- The editor consumes resources only after an eligible user first opens it.
- **Editor activity** -- Every client-to-server editor message counts as input for the same idle policy used by terminal input.

### Out of Scope

- A separate editor deployment, container, authentication system, or origin.
- Cross-session persistence of editor settings, extensions, or browser state.
- Desktop remote-development protocols or a graphical desktop surface.
- Parsing the upstream editor protocol to classify messages.

### Domain Dependencies

- [REQ-SESSION-001](session-lifecycle.md#req-session-001-container-creation-and-lifecycle) -- the editor runs inside the selected session container.
- [REQ-VAULT-005](vault.md#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) -- the editor reuses the authenticated container-proxy boundary.
- [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start) -- workspace files use the existing persistence lifecycle.
- [REQ-SEC-007](security.md#req-sec-007-rate-limiting-infrastructure) -- editor WebSocket upgrades share the connection budget.
- [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response) -- editor responses use same-origin framing controls.
- [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro) -- editor availability follows advanced session mode.

---

### REQ-IDE-001: Per-session browser IDE served through the Worker proxy

**Intent:** An authenticated user can open a full editor for a valid selected session without introducing another deployment or authentication boundary.

**Applies To:** User

**Acceptance Criteria:**

1. Malformed or missing session identifiers are rejected before container access. <!-- @impl: src/routes/vscode-validation.ts::validateVscodeRoute --> <!-- @test: src/__tests__/routes/vscode-validation.test.ts (validateVscodeRoute (REQ-IDE-001, REQ-IDE-002)) -->
2. Unauthenticated editor access is rejected, and requests from disallowed origins are forbidden. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) -->
3. Editor pages, assets, and sockets reach the selected session while retaining its session-scoped browser location. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @impl: host/src/vscode-proxy.ts::vscodeUpstreamPath --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamPath / REQ-IDE-001 (forward UNCHANGED, no strip)) -->
4. Editor content may be framed only by the same origin, and successful socket upgrades remain intact. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/early-return-security.test.ts (CF-001: security headers on pre-Hono early-return responses) -->
5. A session not owned by the user is unavailable, and stopped or unhealthy sessions do not forward editor traffic. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) -->
6. Normal editor protocol messages of at least 256 KiB pass byte-for-byte without a payload-limit disconnect. <!-- @impl: host/src/vscode-proxy.ts::createVscodeWebSocketServer --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-001: accepts a 256 KiB binary protocol message intact without a 1009 close) -->

**Constraints:**

- The editor reuses the session container and existing authenticated proxy boundary.
- The editor listens only inside the container; it has no independently reachable network surface.
- The upstream OpenVSCode artifact remains unmodified under the accepted risk in [AD97](../../documentation/decisions/README.md#ad97-keep-openvscode-upstream-clean-and-accept-known-vulnerability-risk).

**Priority:** P2

**Dependencies:** [REQ-SESSION-001](session-lifecycle.md#req-session-001-container-creation-and-lifecycle), [REQ-VAULT-005](vault.md#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response)

**Verification:** [Worker route tests](../../src/__tests__/routes/vscode-auth-chain.test.ts); [host proxy tests](../../host/__tests__/openvscode-proxy.test.js)

**Status:** Implemented

---

### REQ-IDE-002: Session-isolated IDE, not bucket-stable

**Intent:** Each session receives an independent editor for its own workspace; no editor identity or state is shared through the user's persistent-storage identity.

**Applies To:** User

**Acceptance Criteria:**

1. Editor routing selects only the requested session and never substitutes a shared storage identity. <!-- @impl: src/routes/vscode-validation.ts::validateVscodeRoute --> <!-- @test: src/__tests__/routes/vscode-validation.test.ts (REQ-IDE-002: a valid route result carries a sessionId and never a bucketToken) -->
2. Browser resource scope and editor server state are distinct for each session. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (_openvscode_launch_once / REQ-IDE-001, REQ-IDE-002 (session-isolated launch command)) -->
3. Editor-only state is ephemeral and is not synchronized with workspace files. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (_openvscode_launch_once / REQ-IDE-001, REQ-IDE-002 (session-isolated launch command)) -->
4. Launching from the header always opens the active session rather than another running session. <!-- @impl: web-ui/src/components/Layout.tsx::handleVscodeOpen --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Browser IDE button gating (REQ-IDE-001 / REQ-IDE-003)) -->

**Constraints:**

- The selected session remains visible in the editor location for the lifetime of the page.
- Editor state does not become a bucket-level or account-level store.

**Priority:** P2

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-VAULT-021](vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)

**Verification:** [Route isolation tests](../../src/__tests__/routes/vscode-validation.test.ts); [launch tests](../../host/__tests__/entrypoint-openvscode.test.js)

**Status:** Implemented

---

### REQ-IDE-003: IDE lifecycle and availability

**Intent:** The editor starts only when used, becomes available after warm-up or a process restart, stops cleanly with its session, and is offered only for an advanced running session.

**Applies To:** User

**Acceptance Criteria:**

1. The editor remains stopped until session initialization is complete and an eligible editor request has arrived. <!-- @impl: entrypoint.sh::_openvscode_should_launch --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (_openvscode_should_launch / REQ-IDE-003 AC1 (lazy-start gate)) -->
2. The first editor request records the start request idempotently. <!-- @impl: host/src/vscode-proxy.ts::requestOpenvscodeStart --> <!-- @test: host/__tests__/openvscode-proxy.test.js (requestOpenvscodeStart / REQ-IDE-003 AC2 (lazy-start trigger, idempotent)) -->
3. While the editor starts, the browser retries automatically and reaches the editor when it becomes ready. <!-- @impl: host/src/vscode-proxy.ts::vscodeWarmingResponse --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeWarmingResponse / REQ-IDE-003 AC2 (auto-refreshing warming page, not raw JSON)) -->
4. The editor becomes available again after its server process exits unexpectedly. <!-- @impl: entrypoint.sh::_openvscode_supervise_loop --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (_openvscode_supervise_loop / REQ-IDE-003 AC1+AC3 (lazy no-launch, restart on exit)) -->
5. Session shutdown terminates editor processes before the container lifecycle completes. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (kill_pidfile_subtree / REQ-IDE-003 AC4 (shutdown releases the IDE port)) -->
6. The header offers the editor only for the active advanced running session and opens that session when selected. <!-- @impl: web-ui/src/components/Layout.tsx::handleVscodeOpen --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Browser IDE button gating (REQ-IDE-001 / REQ-IDE-003)) -->
7. A non-advanced session cannot open the editor and is not left in an automatic retry loop. <!-- @impl: host/src/vscode-proxy.ts::vscodeModeAllowed --> <!-- @impl: host/src/vscode-proxy.ts::vscodeDisabledResponse --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeDisabledResponse / REQ-IDE-003 (non-advanced session: clear page, no refresh loop)) -->

**Constraints:**

- Workspace persistence continues through [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start); the editor adds no sync path.
- Sessions that never open the editor incur no editor-process cost.

**Priority:** P2

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** [Lifecycle tests](../../host/__tests__/entrypoint-openvscode.test.js); [host response tests](../../host/__tests__/openvscode-proxy.test.js); [header tests](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

### REQ-IDE-004: Resilient editor activity transport

**Intent:** Editor input reaches the upstream editor during connection start-up and refreshes the same input timestamp used by idle shutdown.

**Applies To:** User

**Acceptance Criteria:**

1. Client frames received before the upstream connection opens are delivered afterward in original order with text and binary flags preserved. <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-004: delivers immediate pre-open frames in order with binary flags preserved) -->
2. The pre-open frame queue has a fixed bound; overflow closes the stalled bridge with retry-later semantics and releases the queued frames and bridge listeners. <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-004: closes with 1013 on bounded-queue overflow and releases bridge listeners) -->
3. Closing or failing either side releases the bridge's queued frames and event listeners. <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-004: releases bridge listeners when either socket closes or errors) -->
4. Every client-to-server editor frame advances the host `lastInputAt` value consumed by idle shutdown. <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @impl: host/src/activity-tracker.ts::createActivityTracker --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-004: advances the idle policy lastInputAt for every client-to-server frame) -->

**Constraints:**

- The bridge does not parse or classify the editor protocol.
- Buffering is ordered and bounded by frame count.

**Priority:** P1

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-SESSION-005](session-lifecycle.md#req-session-005-input-based-idle-detection)

**Verification:** [Behavioral host proxy tests](../../host/__tests__/openvscode-proxy.test.js)

**Status:** Implemented
