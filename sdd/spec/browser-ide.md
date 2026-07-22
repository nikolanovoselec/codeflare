# Browser IDE

A full browser editor for an advanced running session. The editor opens that session's workspace, stays isolated from every other session, and uses the existing authenticated session-container path.

**Domain owner:** Worker editor route, container host proxy, editor lifecycle supervisor, and header launch control

### Key Concepts

- **Browser IDE** -- The per-session OpenVSCode editor defined in the [glossary](glossary.md#glossary).
- **Session isolation** -- Editor routing, browser storage, server state, and workspace selection belong to one session and are never shared through the user's storage identity.
- **Lazy start** -- The editor consumes resources only after an eligible user first opens it.
- **Editor activity** -- Any message sent from the browser editor to the session counts as input for the same idle policy used by terminal input.

### Out of Scope

- A separate editor deployment, container, authentication system, or origin.
- Cross-session persistence of editor settings, extensions, or browser state.
- Desktop remote-development protocols or a graphical desktop surface.
- Parsing the upstream editor protocol to classify messages.

### Domain Dependencies

- [REQ-SESSION-001](session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type) -- the editor runs inside the selected session container.
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
3. Editor pages, assets, and sockets reach the selected session while retaining its session-scoped browser location. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @impl: host/src/vscode-proxy.ts::vscodeUpstreamPath --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) -->
4. Editor content may be framed only by the same origin. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/early-return-security.test.ts (REQ-IDE-001 AC4: a vscode proxy response carries SAMEORIGIN + frame-ancestors CSP) -->
5. A session not owned by the user is unavailable, and stopped or unhealthy sessions do not forward editor traffic. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) -->
6. Normal editor protocol messages of at least 256 KiB pass byte-for-byte without a payload-limit disconnect. <!-- @impl: host/src/vscode-proxy.ts::createVscodeWebSocketServer --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-001: accepts a 256 KiB binary protocol message intact without a 1009 close) -->

**Constraints:**

- The editor reuses the session container and existing authenticated proxy boundary.
- The editor listens only inside the container; it has no independently reachable network surface.
- The upstream OpenVSCode artifact remains unmodified under the accepted risk in [AD97](../../documentation/decisions/README.md#ad97-keep-openvscode-upstream-clean-and-accept-known-vulnerability-risk).

**Priority:** P2

**Dependencies:** [REQ-SESSION-001](session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-VAULT-005](vault.md#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response)

**Verification:** [Worker route tests](../../src/__tests__/routes/vscode-auth-chain.test.ts); [host proxy tests](../../host/__tests__/openvscode-proxy.test.js)

**Status:** Implemented

---

### REQ-IDE-002: Session-isolated IDE, not bucket-stable

**Intent:** Each session receives an independent editor for its own workspace; no editor identity or state is shared through the user's persistent-storage identity.

**Applies To:** User

**Acceptance Criteria:**

1. Editor routing selects only the requested session and never substitutes a shared storage identity. <!-- @impl: src/routes/vscode-validation.ts::validateVscodeRoute --> <!-- @test: src/__tests__/routes/vscode-validation.test.ts (REQ-IDE-002: a valid route result carries a sessionId and never a bucketToken) -->
2. Opening different sessions yields independent editor state for each session. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (_openvscode_launch_once / REQ-IDE-001, REQ-IDE-002 (session-isolated launch command)) -->
3. Editor preferences and extensions do not persist with workspace files after the session ends. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (_openvscode_launch_once / REQ-IDE-001, REQ-IDE-002 (session-isolated launch command)) -->
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
2. Repeated initial editor requests trigger only one start request. <!-- @impl: host/src/vscode-proxy.ts::requestOpenvscodeStart --> <!-- @test: host/__tests__/openvscode-proxy.test.js (requestOpenvscodeStart / REQ-IDE-003 AC2 (lazy-start trigger, idempotent)) -->
3. While the editor starts, the browser retries automatically and reaches the editor when it becomes ready. <!-- @impl: host/src/vscode-proxy.ts::vscodeWarmingResponse --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeWarmingResponse / REQ-IDE-003 AC3 (auto-refreshing warming page, not raw JSON)) -->
4. The editor becomes available again after an unexpected interruption. <!-- @impl: entrypoint.sh::_openvscode_supervise_loop --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (_openvscode_supervise_loop / REQ-IDE-003 AC1+AC4 (lazy no-launch, restart on exit)) -->
5. Stopping a session releases the editor before shutdown completes. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (kill_pidfile_subtree / REQ-IDE-003 AC5 (shutdown releases the IDE port)) -->
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

**Intent:** Editor input sent during connection start-up is preserved, and every message sent to the session refreshes the idle timer.

**Applies To:** User

**Acceptance Criteria:**

1. Messages sent while the editor is connecting are delivered afterward in their original order with text and binary forms preserved. <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-004: delivers immediate pre-open frames in order with binary flags preserved) -->
2. If retained start-up messages exceed either safety limit, the editor asks the browser to retry later and releases the pending connection resources. <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @test: host/__tests__/openvscode-proxy.test.js (bridgeVscodeClientMessages / REQ-IDE-004 (early-frame delivery and IDE activity)) -->
3. Disconnecting or failing either side stops further delivery and releases the pending connection resources. <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-004: releases bridge listeners when either socket closes or errors) -->
4. Every message sent from the browser editor refreshes the input timestamp used by idle shutdown. <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> <!-- @impl: host/src/activity-tracker.ts::createActivityTracker --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-004: advances the idle policy lastInputAt for every client-to-server frame) -->

**Constraints:**

- The editor transport does not inspect message content.
- Early-message buffering preserves order and retains at most 128 messages or 8 MiB, whichever limit is reached first.

**Priority:** P1

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-SESSION-005](session-lifecycle.md#req-session-005-input-based-idle-detection)

**Verification:** [Behavioral host proxy tests](../../host/__tests__/openvscode-proxy.test.js)

**Status:** Implemented

---

### REQ-IDE-005: Selected agent sidebar

**Intent:** An advanced-session user can open a separate Codeflare sidebar for the Pi or Claude agent selected in terminal tab 1.

**Applies To:** User

**Acceptance Criteria:**

1. Sidebar availability matches terminal tab 1 exactly: Pi enables Pi, Claude enables Claude, and every unsupported, malformed, duplicate, ambiguous, or missing selection enables no sidebar. <!-- @impl: entrypoint.sh::_openvscode_agent_kind --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-005 AC1+AC2: tab one selects only a fixed sidebar agent inventory) -->
2. Every available agent sidebar is Codeflare-owned. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @impl: openvscode/agent-sidebar/src/package-extension.ts::stageSidebarExtension --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC1+AC2: stages only the fixed Pi, Claude, and empty inventories) -->
3. The editor contains no Anthropic extension or VSIX package. <!-- @impl: openvscode/agent-sidebar/src/package-extension.ts::stageSidebarExtension --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC3: refuses VSIX or Anthropic-owned extension input before staging) -->
4. No sidebar agent runs before its view is visible; afterward exactly one selected agent runs and the unselected agent does not. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/lifecycle.ts::SidebarLifecycle --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC4: activation is inert until visible resolution starts the selected backend) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC4: a visibility-triggered start failure is reported without escaping) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC4: Claude selection never constructs the Pi backend) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: visible Pi resolution uses only the fixed no-session spawn contract) --> <!-- @test: openvscode/agent-sidebar/test/claude-pty.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: Claude starts only the fixed no-shell PTY contract) -->
5. Repeated visible resolution reuses one selected backend. <!-- @impl: openvscode/agent-sidebar/src/lifecycle.ts::SidebarLifecycle --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5: repeated visible resolution reuses one backend instance) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-005 AC5: repeated visible Pi resolution reuses one process) --> <!-- @test: openvscode/agent-sidebar/test/claude-pty.test.ts (REQ-IDE-005 AC5: repeated Claude resolution reuses the existing PTY) -->
6. A failed or unexpectedly exited backend leaves no duplicate and can be started once again. <!-- @impl: openvscode/agent-sidebar/src/lifecycle.ts::SidebarLifecycle --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC6 + REQ-IDE-008 AC4: visible resolution restarts a cached backend after an unexpected exit) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-005 AC6 + REQ-IDE-008 AC4: an asynchronous Pi spawn failure cannot leave a running backend) -->

**Constraints:**

- The sidebar is available only in advanced sessions and only for Pi or Claude.
- Sidebar selection does not execute or rewrite the terminal command; generic terminal-command behavior remains owned by [AD15](../../documentation/decisions/README.md#ad15-tabconfigschema-allows-arbitrary-command-strings).
- OpenVSCode remains upstream-clean under [AD97](../../documentation/decisions/README.md#ad97-keep-openvscode-upstream-clean-and-accept-known-vulnerability-risk).

**Priority:** P1

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-003](#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-004](#req-ide-004-resilient-editor-activity-transport), [REQ-AGENT-003](agents.md#req-agent-003-agent-cli-auto-started-in-tab-1), [REQ-OPS-003](operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit), [REQ-OPS-020](operations.md#req-ops-020-shadow-pin-version-bump-automation)

**Verification:** [Host selection tests](../../host/__tests__/entrypoint-openvscode.test.js); [extension packaging and activation tests](../../openvscode/agent-sidebar/test)

**Status:** Implemented

---

### REQ-IDE-006: Sidebar conversation and credential isolation

**Intent:** A sidebar conversation can use approved session configuration without copying credentials or exposing terminal history.

**Applies To:** User

**Acceptance Criteria:**

1. Each selected agent can work in the current session workspace using approved credentials, routing, and configuration. <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::FIXED_PI_SPAWN_SPEC --> <!-- @impl: openvscode/agent-sidebar/src/claude/pty-session.ts::ClaudePtySession --> <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareSidebarConfig --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: visible Pi resolution uses only the fixed no-session spawn contract) --> <!-- @test: openvscode/agent-sidebar/test/claude-pty.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: Claude starts only the fixed no-shell PTY contract) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-006 AC1+AC2: projection links only allowlisted configuration and never copies secret bytes) -->
2. Preparing sidebar configuration links approved credential sources without copying their values into generated files. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareSidebarConfig --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-006 AC1+AC2: projection links only allowlisted configuration and never copies secret bytes) -->
3. Every new sidebar conversation starts without terminal conversation history and cannot list, attach to, or resume it. <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::PiSession --> <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::SIDEBAR_LINK_ALLOWLIST --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: visible Pi resolution uses only the fixed no-session spawn contract) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-006 AC3: projection excludes terminal history, runtime state, and unknown entries) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-006 AC3: projection rejects an allowlisted source entry redirected by a symbolic link) -->

**Constraints:**

- The integration does not copy credential values into settings, logs, reports, or sidebar messages.
- Pi and Claude sidebars remain separate from terminal tab 1 and from each other.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-agent-sidebar), [REQ-OPS-003](operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** [Pi session tests](../../openvscode/agent-sidebar/test/pi-session.test.ts); [Claude PTY tests](../../openvscode/agent-sidebar/test/claude-pty.test.ts); [Claude isolation tests](../../openvscode/claude/test/prepare-sidebar-config.test.mjs); complete-image smoke in `.github/workflows/test.yml`

**Status:** Implemented

---

### REQ-IDE-007: Sidebar guarded approval

**Intent:** Guarded sidebar actions require a bounded, request-specific user decision before any mutation or command starts.

**Applies To:** User

**Acceptance Criteria:**

1. A guarded action changes a target or starts a command only after explicit user confirmation through the owning Pi extension host or Claude's native permission flow. <!-- @impl: preseed/agents/pi/extensions/sidebar-approval.ts::registerSidebarApproval --> <!-- @impl: openvscode/agent-sidebar/src/pi/approval-bridge.ts::ApprovalBridge --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildManagedSettings --> <!-- @test: src/__tests__/lib/pi-sidebar-approval.test.ts (REQ-IDE-007: Pi sidebar guarded approvals) --> <!-- @test: src/__tests__/lib/pi-sidebar-approval.test.ts (REQ-IDE-007 AC1: host approval request carries the serialized manifest digest) --> <!-- @test: openvscode/agent-sidebar/test/approval-bridge.test.ts (REQ-IDE-007 AC1: Pi approval resolves through extension-host manifest, diff, and confirmation authority) --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-007 AC1: native permission rules independently ask for guarded built-ins and MCP) -->
2. If a preview is oversized or confirmation is absent, rejected, expired, stale, malformed, or unrelated to the request, the target remains unchanged and no command starts. <!-- @impl: preseed/agents/pi/extensions/sidebar-approval.ts::registerSidebarApproval --> <!-- @impl: openvscode/agent-sidebar/src/pi/approval-bridge.ts::ApprovalBridge --> <!-- @test: src/__tests__/lib/pi-sidebar-approval.test.ts (REQ-IDE-007 AC2: an oversized serialized preview is denied before approval or mutation) --> <!-- @test: src/__tests__/lib/pi-sidebar-approval.test.ts (REQ-IDE-007 AC2: mutation boundary cannot follow a parent symlink swapped in after approval) --> <!-- @test: openvscode/agent-sidebar/test/approval-bridge.test.ts (REQ-IDE-007 AC2: rejected extension-host approval returns a correlated denial) --> <!-- @test: openvscode/agent-sidebar/test/approval-bridge.test.ts (REQ-IDE-007 AC2: substituted approval manifest content is rejected before preview or confirmation) --> <!-- @test: openvscode/agent-sidebar/test/webview-security.test.ts (REQ-IDE-007 AC2: webview messages cannot forge approval or choose process authority) -->

**Constraints:**

- Pi serializes one protected approval manifest, binds its SHA-256 digest to the host request, and rejects it before approval when it exceeds 1 MiB.
- Approval governs guarded agent tool calls, not arbitrary trusted code or an approved command inside the shared container.
- The sidebar exposes no public process-control surface.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-agent-sidebar), [REQ-IDE-006](#req-ide-006-sidebar-conversation-and-credential-isolation)

**Verification:** [Pi guard tests](../../src/__tests__/lib/pi-sidebar-approval.test.ts); [approval bridge tests](../../openvscode/agent-sidebar/test/approval-bridge.test.ts); [Claude permission tests](../../openvscode/claude/test)

**Status:** Implemented

---

### REQ-IDE-008: Sidebar process lifecycle

**Intent:** Sidebar abort, replacement, failure, and shutdown leave no stale callback, pending action, or surviving sidebar-created process.

**Applies To:** User

**Acceptance Criteria:**

1. Aborting a conversation sends the selected agent's native interrupt without replacing the active backend. <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::PiSession --> <!-- @impl: openvscode/agent-sidebar/src/claude/pty-session.ts::ClaudePtySession --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-008 AC1: Pi abort is sent while the current process remains available) --> <!-- @test: openvscode/agent-sidebar/test/claude-pty.test.ts (REQ-IDE-008 AC1: Claude PTY abort sends Ctrl+C through terminal input) -->
2. Starting a new conversation reaps every process carrying the previous conversation generation before replacement. <!-- @impl: openvscode/agent-sidebar/src/process-generation.ts::reapSidebarGeneration --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @impl: openvscode/agent-sidebar/src/claude/node-pty-backend.ts::ClaudePtyBackend --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-008 AC2: new Pi conversation reaps the old no-session process before replacement) --> <!-- @test: openvscode/agent-sidebar/test/claude-pty.test.ts (REQ-IDE-008 AC2: new Claude conversation reaps the old PTY before replacement) -->
3. Extension deactivation and backend disposal reap the selected managed process. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @impl: openvscode/agent-sidebar/src/claude/node-pty-backend.ts::ClaudePtyBackend --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-008 AC3: extension deactivation stops the selected backend) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-008 AC3: Pi disposal settles and reaps the managed process) --> <!-- @test: openvscode/agent-sidebar/test/claude-pty.test.ts (REQ-IDE-008 AC3: Claude disposal reaps the managed PTY) -->
4. Asynchronous start, input, approval, or exit callbacks from an old generation cannot survive or alter its replacement. <!-- @impl: openvscode/agent-sidebar/src/lifecycle.ts::SidebarLifecycle --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @impl: openvscode/agent-sidebar/src/claude/node-pty-backend.ts::ClaudePtyBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-005 AC6 + REQ-IDE-008 AC4: an asynchronous Pi stdin failure stops the backend without escaping) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-007 AC2 + REQ-IDE-008 AC4: a late Pi approval response cannot enter a replacement conversation) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-008 AC4: a stale Claude exit callback cannot stop a replacement conversation) -->
5. Editor restart and session stop reap all process groups carrying the OpenVSCode or sidebar generation before replacement or shutdown completes. <!-- @impl: entrypoint.sh::_openvscode_supervise_loop --> <!-- @impl: entrypoint.sh::kill_pidfile_subtree --> <!-- @impl: openvscode/agent-sidebar/src/process-generation.ts::reapSidebarGeneration --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (OpenVSCode launch generations / REQ-IDE-008 AC5) --> <!-- @test: openvscode/agent-sidebar/test/process-generation.test.ts (REQ-IDE-008 AC5: one sidebar generation reaps a TERM-ignoring descendant in another process group) -->

**Constraints:**

- Cleanup uses bounded TERM/KILL rescans and refuses replacement while matching descendants survive.
- Process generations are local to the shared session container; no public process-control surface is introduced.

**Priority:** P1

**Dependencies:** [REQ-IDE-003](#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-005](#req-ide-005-selected-agent-sidebar)

**Verification:** [Host lifecycle tests](../../host/__tests__/entrypoint-openvscode.test.js); [sidebar lifecycle tests](../../openvscode/agent-sidebar/test)

**Status:** Implemented
