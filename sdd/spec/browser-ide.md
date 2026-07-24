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

### REQ-IDE-005: Selected native IDE agent

**Intent:** An advanced-session user gets the editor-native Pi or Claude experience selected by terminal tab 1, without an unrelated login or duplicate agent surface.

**Applies To:** User

**Acceptance Criteria:**

1. IDE agent availability matches terminal tab 1 exactly: Pi selects the owned Pi inventory, Claude selects the official Claude inventory, and every unsupported, malformed, duplicate, ambiguous, or missing selection selects the empty inventory. <!-- @impl: entrypoint.sh::_openvscode_agent_kind --> <!-- @impl: entrypoint.sh::_openvscode_extensions_dir --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-005 AC1+AC2: tab one selects only a fixed IDE agent inventory) --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC1: stages native Pi, official Claude, and empty unsupported inventories) -->
2. A Pi session presents Codeflare Pi as the default participant in OpenVSCode's native Chat and presents no duplicate custom Pi webview. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/package-extension.ts::stageSidebarExtension --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC2: contributes Codeflare as the default native Pi Chat participant) -->
3. A Claude session keeps OpenVSCode's unrelated native Chat and Copilot setup disabled. <!-- @impl: openvscode/claude/managed-settings.mjs::buildOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-005 AC3: Claude suppresses unrelated native Chat setup) -->
4. Neither Pi nor Claude starts an agent process before a native Chat request or Claude panel request; every Pi request uses one fresh isolated backend. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::runNativePiChat --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC3: each native Chat request uses and reaps a fresh isolated Pi backend) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-005 AC4: a native Pi turn streams only assistant text, reports tool progress, and completes at agent_settled) --> <!-- @manual: Run the Browser IDE complete-image job and confirm both host inventories remain free of Pi or Claude agent processes before first use. -->
5. A Pi session opens Codeflare Pi native Chat without an account-setup prompt or authorization flow. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_COMPATIBILITY_PROVIDER --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5: native Pi registers an account-free panel model that rejects generation) -->
6. In the pinned complete image, OpenVSCode positively discovers both fixed extension IDs, packaged Pi activation registers the inert host model and default participant without account access, and official Claude retains its exact identity, version, platform, permission, and process-laziness contracts. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyOfficialClaudeExtension --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC6: refuses retained VSIX and substituted publisher or version metadata) --> <!-- @manual: Run the Browser IDE complete-image job and retain its extension-discovery, package-identity, permission, and process-laziness evidence artifact. -->
7. Codeflare Pi answers native Chat independently of the editor-selected model. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::FIXED_PI_SPAWN_SPEC --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-005 AC7: native Pi context collection ignores the host-selected model) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: visible Pi resolution uses only the fixed no-session spawn contract) -->

**Constraints:**

- The IDE agent is available only in advanced sessions and only for exact Pi or Claude selections.
- Selection does not execute or rewrite the terminal command; generic terminal-command behavior remains owned by [AD15](../../documentation/decisions/README.md#ad15-tabconfigschema-allows-arbitrary-command-strings).
- OpenVSCode remains upstream-clean under [AD97](../../documentation/decisions/README.md#ad97-keep-openvscode-upstream-clean-and-accept-known-vulnerability-risk).
- The local Pi compatibility model applies only to panel Chat, is not user-selectable, requires no authorization, and fails closed if any caller attempts generation.
- VS Code Authentication is outside the Pi and Claude integration contracts; no Codeflare-owned path requests, bridges, exports, persists, or syncs generic Accounts credentials.
- The owner accepts bundling the exact unmodified official Anthropic VSIX from Open VSX despite its all-rights-reserved license notice; Codeflare neither patches nor serves the archive.

**Priority:** P1

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-003](#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-004](#req-ide-004-resilient-editor-activity-transport), [REQ-AGENT-003](agents.md#req-agent-003-agent-cli-auto-started-in-tab-1), [REQ-OPS-003](operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit), [REQ-OPS-020](operations.md#req-ops-020-shadow-pin-version-bump-automation)

**Verification:** [Host selection tests](../../host/__tests__/entrypoint-openvscode.test.js); [native Pi tests](../../openvscode/agent-sidebar/test); [official Claude tests](../../openvscode/claude/test); complete-image smoke in `.github/workflows/test.yml`

**Status:** Implemented

---

### REQ-IDE-006: IDE conversation, context, and credential isolation

**Intent:** An IDE conversation understands the editor state and approved session configuration without importing terminal conversation history or copying credentials.

**Applies To:** User

**Acceptance Criteria:**

1. Every native Pi request receives bounded current editor content, selection, open workspace documents, diagnostics, explicit native references, and that native Chat's bounded history; outside-workspace paths, symbolic-link aliases, and malformed references are excluded. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::collectNativePiPromptInput --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005 AC2 + REQ-IDE-006 AC1: native Pi receives bounded editor, reference, diagnostic, and chat context) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-005 AC2: native host collection captures active selection and rejects a symlink escape) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006 AC1: malformed native reference ranges are ignored at the host boundary) -->
2. Official Claude receives active-file, selection, native diff, and diagnostics integration through Anthropic's authenticated loopback-only IDE MCP server. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareOfficialClaudeIde --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildOpenVscodeSettings --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-005 AC2 + REQ-IDE-006 AC1: official Claude launch writes isolated OpenVSCode settings) --> <!-- @manual: On the deployed integration image, attach an active file and selection, request a native diff, and confirm diagnostics reach official Claude on three fresh sessions. -->
3. Each Pi request starts with only the bounded native Chat history supplied for that request, while Claude uses a dedicated temporary config tree; neither agent can attach to or resume terminal tab 1. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::runNativePiChat --> <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::FIXED_PI_SPAWN_SPEC --> <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::SIDEBAR_LINK_ALLOWLIST --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC3: each native Chat request uses and reaps a fresh isolated Pi backend) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: visible Pi resolution uses only the fixed no-session spawn contract) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-006 AC3: projection excludes terminal history, runtime state, and unknown entries) -->
4. Claude preparation links approved credential and configuration sources without copying their values into generated files, settings, logs, or messages. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareSidebarConfig --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-006 AC1+AC2: projection links only allowlisted configuration and never copies secret bytes) -->

**Constraints:**

- Pi context is capped at 512 KiB and treats editor content as untrusted data rather than instructions.
- Anthropic's IDE MCP is limited to `127.0.0.1`, a random port, and a fresh token in the isolated mode-0700 config directory, with no Codeflare-owned relay or public listener (owner-approved exception in [AD114](../../documentation/decisions/README.md#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration)).
- Pi, official Claude, and terminal tab 1 remain separate conversations and processes.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-OPS-003](operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** [Native Pi context tests](../../openvscode/agent-sidebar/test/native-chat.test.ts); [Pi session tests](../../openvscode/agent-sidebar/test/pi-session.test.ts); [Claude isolation tests](../../openvscode/claude/test/prepare-sidebar-config.test.mjs); complete-image smoke in `.github/workflows/test.yml`

**Notes:** AC2 awaits deployed authenticated pass@3 evidence for official Claude's active-file, selection, native-diff, and diagnostics behavior.

**Status:** Partial

---

### REQ-IDE-007: IDE guarded approval

**Intent:** IDE agents in the ephemeral container execute tools without approval prompts or editor-tab churn.

**Applies To:** User

**Acceptance Criteria:**

1. Sidebar Pi tool calls execute without an approval gate. <!-- @impl: preseed/agents/pi/extensions/sidebar-approval.ts::sidebarApproval --> <!-- @test: src/__tests__/lib/pi-sidebar-approval.test.ts (REQ-IDE-007 AC1: sidebar Pi leaves built-in tools unrestricted) -->
2. Pi extension-host confirmation requests resolve approved without opening a modal or editor document. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-approval-host.ts::VsCodeApprovalHost --> <!-- @test: openvscode/agent-sidebar/test/vscode-approval-host.test.ts (REQ-IDE-007 AC2: arbitrary Pi confirmations auto-approve without UI) -->
3. Official Claude launches and restarts in `bypassPermissions` mode, allows dangerous permission skipping, and installs no managed ask rules or permission hook. <!-- @impl: openvscode/claude/managed-settings.mjs::buildManagedSettings --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-007 AC3: Claude uses unrestricted mode without permission hooks) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-007 AC3: official Claude restart restores unrestricted managed settings) -->

**Constraints:**

- No IDE-agent tool call is approval-gated or command-content sandboxed; tools can perform destructive or external actions.
- Container ephemerality does not undo synced workspace changes or external side effects.
- Neither integration exposes a public process-control surface.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-006](#req-ide-006-ide-conversation-context-and-credential-isolation)

**Verification:** [Pi unrestricted-action tests](../../src/__tests__/lib/pi-sidebar-approval.test.ts); [extension-host tests](../../openvscode/agent-sidebar/test/vscode-approval-host.test.ts); [Claude permission tests](../../openvscode/claude/test)

**Status:** Implemented

---

### REQ-IDE-008: IDE-agent process lifecycle

**Intent:** Cancellation, failure, editor restart, and shutdown leave no surviving IDE-agent process.

**Applies To:** User

**Acceptance Criteria:**

1. Cancelling during Pi startup sends no prompt; after prompt acceptance, cancellation sends Pi's correlated abort and reaps that request's process generation without waiting indefinitely for `agent_settled`. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::runNativePiChat --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008 AC1+AC3: native Chat cancellation is registered before the Pi request and cleanup still runs) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-008 AC1: cancellation during Pi startup cannot send a prompt after spawn completes) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-008 AC1: accepted Pi cancellation settles without agent_settled) -->
2. Every native Pi request owns a fresh process generation; completion, failure, or extension deactivation stops and reaps every active generation without permitting a disposed session to respawn. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::deactivate --> <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::PiSession --> <!-- @impl: openvscode/agent-sidebar/src/process-generation.ts::reapSidebarGeneration --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC3: each native Chat request uses and reaps a fresh isolated Pi backend) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-008 AC2: Pi disposal settles and reaps the request generation) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-008 AC2: Pi disposal uses bounded generation reaping when TERM is ignored) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-008 AC2+AC3: a disposed request session cannot spawn a replacement child) -->
3. Asynchronous Pi start, input, output, or exit callbacks cannot survive, resurrect, or alter a completed or cancelled request. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-008 AC2+AC3: disposal during Pi startup cannot resurrect the backend) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-008 AC3: an asynchronous Pi stdin failure stops the backend without escaping) -->
4. Editor restart and session stop reap every process carrying the OpenVSCode launch generation, including official Claude's bundled child, before replacement or shutdown completes. <!-- @impl: entrypoint.sh::_openvscode_supervise_loop --> <!-- @impl: entrypoint.sh::kill_pidfile_subtree --> <!-- @impl: openvscode/agent-sidebar/src/process-generation.ts::reapSidebarGeneration --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (OpenVSCode launch generations / REQ-IDE-008 AC4) --> <!-- @test: openvscode/agent-sidebar/test/process-generation.test.ts (REQ-IDE-008 AC4: one Pi request generation reaps a TERM-ignoring descendant in another process group) -->

**Constraints:**

- Cleanup uses bounded TERM/KILL rescans and refuses replacement while matching descendants survive.
- Process generations are local to the shared session container; no public process-control surface is introduced.

**Priority:** P1

**Dependencies:** [REQ-IDE-003](#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-005](#req-ide-005-selected-native-ide-agent)

**Verification:** [Host lifecycle tests](../../host/__tests__/entrypoint-openvscode.test.js); [native Pi lifecycle tests](../../openvscode/agent-sidebar/test); complete-image smoke in `.github/workflows/test.yml`

**Status:** Implemented
