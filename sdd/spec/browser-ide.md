# Browser IDE

A full code-server browser editor for an advanced running session. The editor opens that session's workspace, stays isolated from every other session, and uses the existing authenticated session-container path.

**Domain owner:** Worker editor route, container host proxy, editor lifecycle supervisor, and header launch control

### Key Concepts

- **Browser IDE** -- The per-session code-server editor defined in the [glossary](glossary.md#glossary).
- **Session isolation** -- Editor routing, live databases, extension state, server state, and workspace selection belong to one session. Only a bounded, credential-free UI-preference snapshot is shared through the user's storage identity.
- **Lazy start** -- The editor consumes resources only after an eligible user first opens it.
- **Editor activity** -- Any message sent from the browser editor to the session counts as input for the same idle policy used by terminal input.

### Out of Scope

- A separate editor deployment, container, authentication system, or origin.
- Cross-session persistence of live editor databases, extension state, SecretStorage, authentication, chat history, logs, or arbitrary settings.
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
3. Editor pages, assets, redirects, service workers, cookies, and sockets remain beneath the selected session's browser location. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @impl: host/src/upgrade-dispatcher.ts::createUpgradeDispatcher --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (REQ-IDE-001 AC3: forwards the external path and exact query with canonical host identity) --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (REQ-IDE-001 AC3: preserves an allowlisted caller Origin for code-server to compare independently) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-001 AC3: code-server HTTP caller routing and proxy identity) --> <!-- @test: host/__tests__/browser-ide-upgrade.test.js (REQ-IDE-001 AC3: code-server WebSocket caller routing and proxy identity) --> <!-- @manual: On the deployed integration image, verify redirects, service-worker scope, cookie paths, assets, and reconnect URLs remain under /api/vscode/<sessionId> on three fresh sessions. -->
4. Editor content may be framed only by the same origin. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/early-return-security.test.ts (REQ-IDE-001 AC4: a vscode proxy response carries SAMEORIGIN + frame-ancestors CSP) -->
5. A session not owned by the user is unavailable, and stopped or unhealthy sessions do not forward editor traffic. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) -->
6. Normal editor protocol messages of at least 256 KiB pass byte-for-byte without a payload-limit disconnect. <!-- @impl: host/src/vscode-proxy.ts::createVscodeWebSocketServer --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-001: accepts a 256 KiB binary protocol message intact without a 1009 close) -->
7. A path for any session other than the selected session never reaches the editor. <!-- @impl: host/src/vscode-proxy.ts::vscodeUpstreamPath --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @impl: host/src/upgrade-dispatcher.ts::createUpgradeDispatcher --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamPath / REQ-IDE-001 AC7 (exact session prefix strip)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-001 AC7: rejects a mismatched session prefix without contacting code-server) --> <!-- @test: host/__tests__/browser-ide-upgrade.test.js (REQ-IDE-001 AC7: rejects a mismatched session prefix before opening a code-server socket) -->

**Constraints:**

- The editor reuses the session container and existing authenticated proxy boundary.
- The editor listens only inside the container; it has no independently reachable network surface.
- The pinned MIT-licensed code-server release remains unmodified under [AD119](../../documentation/decisions/README.md#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy).

**Priority:** P2

**Dependencies:** [REQ-SESSION-001](session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-VAULT-005](vault.md#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response)

**Verification:** Automated test ([Worker route tests](../../src/__tests__/routes/vscode-auth-chain.test.ts); [host proxy tests](../../host/__tests__/openvscode-proxy.test.js))

**Status:** Implemented

---

### REQ-IDE-002: Session-isolated IDE, not bucket-stable

**Intent:** Each session receives an independent live editor for its own workspace while a bounded, credential-free UI-preference snapshot follows the user across sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Editor routing selects only the requested session and never substitutes a shared storage identity. <!-- @impl: src/routes/vscode-validation.ts::validateVscodeRoute --> <!-- @test: src/__tests__/routes/vscode-validation.test.ts (REQ-IDE-002: a valid route result carries a sessionId and never a bucketToken) -->
2. Opening different sessions yields independent workspace and live editor-state roots without reusing a live database. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-002 AC2: separate session launches use independent workspace and editor-state roots) -->
3. The snapshot's persisted settings and workspace state contain exactly allowlisted theme and keyboard-layout values plus schema-valid Explorer/open-file resources. <!-- @impl: scripts/browser-ide-ui-state.py::capture --> <!-- @impl: scripts/browser-ide-ui-state.py::safe_setting_value --> <!-- @impl: scripts/browser-ide-ui-state.py::safe_state_value --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: captures and restores only allowlisted theme, editor, and Explorer state) --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: persists the selected keyboard layout without broad settings state) --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: excludes unknown fields and opaque strings from allowlisted state rows) -->
4. Every restored file resource resolves canonically inside `/home/user/workspace`. <!-- @impl: scripts/browser-ide-ui-state.py::restore --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: excludes allowlisted rows whose file resources escape directly or through a symlink) -->
5. Launching from the header always opens the active session rather than another running session. <!-- @impl: web-ui/src/components/Layout.tsx::handleVscodeOpen --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Browser IDE button gating (REQ-IDE-001 / REQ-IDE-003)) -->
6. Live databases, WAL/SHM files, workspace storage, global extension state, SecretStorage, authentication, chat history, logs, and unallowlisted User settings never enter persistent sync. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @impl: scripts/browser-ide-ui-state.py::capture --> <!-- @impl: scripts/browser-ide-ui-state.py::safe_setting_value --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-IDE-002: syncs only the bounded Browser IDE UI-state snapshot) --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: persists the selected keyboard layout without broad settings state) -->
7. A user-selected web keyboard layout follows the user through the bounded snapshot. <!-- @impl: scripts/browser-ide-ui-state.py::capture --> <!-- @impl: scripts/browser-ide-ui-state.py::restore --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: persists the selected keyboard layout without broad settings state) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-002 AC7 + REQ-IDE-016 AC2: settings preparation preserves safe UI preferences but replaces stale managed inventory settings) -->

**Constraints:**

- The selected session remains visible in the editor location for the lifetime of the page.
- The per-user snapshot at `~/.codeflare/ide-ui-state.json` is the only bucket-level IDE state; it is atomically written, capped at 1 MiB, contains only allowlisted theme values, a string-valued `keyboard.layout`, and concrete resource-only workspace-state schemas, and contains no raw database.
- Managed Codeflare and Claude settings override restored preferences on every launch.
- The upstream keyboard-layout status item and picker remain visible; Codeflare persists the user's selection instead of hiding or preselecting that control.

**Priority:** P2

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-VAULT-021](vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)

**Verification:** Automated test ([Route isolation tests](../../src/__tests__/routes/vscode-validation.test.ts); [launch tests](../../host/__tests__/entrypoint-openvscode.test.js); [UI-state snapshot tests](../../host/__tests__/browser-ide-ui-state.test.js); [settings preparation tests](../../openvscode/claude/test/prepare-sidebar-config.test.mjs))

**Status:** Partial

---

### REQ-IDE-003: IDE lifecycle and availability

**Intent:** The editor starts only when used, becomes available after warm-up or a process restart, stops cleanly with its session, and is offered only for an advanced running session.

**Applies To:** User

**Acceptance Criteria:**

1. The editor remains stopped until session initialization is complete and an eligible editor request has arrived. <!-- @impl: entrypoint.sh::_openvscode_should_launch --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (_openvscode_should_launch / REQ-IDE-003 AC1 (lazy-start gate)) -->
2. Repeated initial editor requests trigger only one start request. <!-- @impl: host/src/vscode-proxy.ts::requestOpenvscodeStart --> <!-- @test: host/__tests__/openvscode-proxy.test.js (requestOpenvscodeStart / REQ-IDE-003 AC2 (lazy-start trigger, idempotent)) -->
3. While the editor starts, the browser retries automatically until it becomes ready, or gives up and reports failure. This covers both waits a tab can land in: the container becoming healthy and the editor binding inside it. <!-- @impl: host/src/vscode-proxy.ts::vscodeWarmingResponse --> <!-- @impl: src/routes/vscode.ts::warmingPage --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeWarmingResponse / REQ-IDE-003 AC3 (bounded warming)) --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (REQ-IDE-003 AC3: an unhealthy container answers a navigable request with a refreshing HTML page) --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (REQ-IDE-003 AC3: the warming page gives up instead of refreshing forever) --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeWarmingResponse / REQ-IDE-003 AC3 (auto-refreshing warming page, not raw JSON)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-003 AC3: the browser-IDE warming clock spans reloads and resets on success) --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (REQ-IDE-003 AC3: the warming page reports the real wait and carries the same start forward) --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (REQ-IDE-003 AC3: a future start is rejected instead of pinning the tab on the warming page) --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (REQ-IDE-003 AC3: a healthy container takes the episode start back out of the tab URL) -->
4. The editor becomes available again after an unexpected interruption. <!-- @impl: entrypoint.sh::_openvscode_supervise_loop --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (_openvscode_supervise_loop / REQ-IDE-003 AC1+AC4 (lazy no-launch, restart on exit)) -->
5. Stopping a session releases the editor before shutdown completes. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (kill_pidfile_subtree / REQ-IDE-003 AC5 (shutdown releases the IDE port)) -->
6. The header offers the editor only for the active advanced running session and opens that session when selected. <!-- @impl: web-ui/src/components/Layout.tsx::handleVscodeOpen --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Browser IDE button gating (REQ-IDE-001 / REQ-IDE-003)) -->
7. A non-advanced session cannot open the editor and is not left in an automatic retry loop. <!-- @impl: host/src/vscode-proxy.ts::vscodeModeAllowed --> <!-- @impl: host/src/vscode-proxy.ts::vscodeDisabledResponse --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeDisabledResponse / REQ-IDE-003 (non-advanced session: clear page, no refresh loop)) -->

**Constraints:**

- Workspace persistence continues through [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start); the editor adds no sync path.
- Sessions that never open the editor incur no editor-process cost.

**Priority:** P2

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** Automated test ([Lifecycle tests](../../host/__tests__/entrypoint-openvscode.test.js); [host response tests](../../host/__tests__/openvscode-proxy.test.js); [header tests](../../web-ui/src/__tests__/components/Layout.test.tsx))

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

**Verification:** Automated test ([Behavioral host proxy tests](../../host/__tests__/openvscode-proxy.test.js))

**Status:** Implemented

---

### REQ-IDE-005: Selected native IDE agent

**Intent:** An advanced-session user gets the editor-native Pi or Claude experience selected by terminal tab 1, without an unrelated login or duplicate agent surface.

**Applies To:** User

**Acceptance Criteria:**

1. When tab configuration is supplied, IDE agent availability matches terminal tab 1 exactly: Pi selects the owned Pi inventory, Claude selects the official Claude inventory, and unsupported, malformed, duplicate, ambiguous, or missing tab-one selections select the empty inventory. Absent configuration preserves the legacy Claude inventory. <!-- @impl: entrypoint.sh::_openvscode_agent_kind --> <!-- @impl: entrypoint.sh::_openvscode_extensions_dir --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-005 AC1+AC2: tab one selects only a fixed IDE agent inventory) --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC1: stages native Pi, official Claude, and empty unsupported inventories) -->
2. A Pi session presents Codeflare as code-server's default native Chat participant and presents no duplicate custom Pi webview. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/package-extension.ts::stageSidebarExtension --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC2 + REQ-IDE-011 AC1 + REQ-IDE-014 AC1 + REQ-IDE-019 AC1 + REQ-IDE-023 AC1: contributes native Pi panel and editor Chat) -->
3. A Claude session keeps code-server's unrelated native Chat and Copilot setup disabled. <!-- @impl: openvscode/claude/managed-settings.mjs::buildOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-005 AC3: Claude suppresses unrelated native Chat setup) -->
4. Pi's IDE backend lifecycle is request-lazy and persistent across normally completed panel and editor turns. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005: lazy native Pi reuses one backend after settled turns) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-005: one IDE-owned Pi session reuses only its child) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-005 AC4: a native Pi turn streams only assistant text, reports tool progress, and completes at agent_settled) -->
5. A Pi session opens Codeflare native Chat without an account-setup prompt or authorization flow. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_FALLBACK_MODEL --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_VISIBLE_MODEL --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: Dockerfile::rm -rf /opt/code-server/lib/vscode/extensions/copilot --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5: native Pi registers account-free panel and editor Chat) --> <!-- @manual: On the deployed integration image, open Codeflare native Chat and complete one request without account or model setup in three fresh sessions. -->
6. The selected fixed inventory becomes available in the running editor. <!-- @impl: entrypoint.sh::_openvscode_extensions_dir --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyOfficialClaudeExtension --> <!-- @manual: On the deployed integration image, confirm the selected Pi, Claude, or empty inventory on three fresh sessions. -->
7. Codeflare answers native Chat independently of the editor-selected model. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::FIXED_PI_SPAWN_SPEC --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-005 AC7: native Pi context collection ignores the host-selected model) -->

**Constraints:**

- The IDE agent is available only in advanced sessions and only for exact Pi or Claude selections.
- Selection does not execute or rewrite the terminal command; generic terminal-command behavior remains owned by [AD15](../../documentation/decisions/README.md#ad15-tabconfigschema-allows-arbitrary-command-strings).
- code-server and embedded Code source remain unpatched under [AD119](../../documentation/decisions/README.md#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy); the SHA-256-verified archive's bundled GitHub Copilot extension is removed at image build.
- The local Pi compatibility model is selectable and default for panel and editor Inline Chat, requires no authorization, reports tool calling for the pinned editor filter, and fails closed if any caller attempts generation.
- VS Code Authentication is outside the Pi and Claude integration contracts; no Codeflare-owned path requests, bridges, exports, persists, or syncs generic Accounts credentials.
- The owner accepts bundling the exact unmodified official Anthropic VSIX from Open VSX despite its all-rights-reserved license notice; Codeflare neither patches nor serves the archive.
- Official Claude remains request-lazy and separate from the persistent IDE-owned Pi runtime.

**Priority:** P1

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-003](#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-004](#req-ide-004-resilient-editor-activity-transport), [REQ-AGENT-003](agents.md#req-agent-003-agent-cli-auto-started-in-tab-1), [REQ-OPS-003](operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit), [REQ-OPS-020](operations.md#req-ops-020-shadow-pin-version-bump-automation)

**Verification:** Automated test ([Host selection tests](../../host/__tests__/entrypoint-openvscode.test.js); [native Pi tests](../../openvscode/agent-sidebar/test); [official Claude tests](../../openvscode/claude/test); deployment smoke in `.github/workflows/container-image.yml`)

**Status:** Partial

---

### REQ-IDE-006: IDE conversation, context, and credential isolation

**Intent:** An IDE conversation understands the editor state and approved session configuration without importing terminal conversation history or copying credentials.

**Applies To:** User

**Acceptance Criteria:**

1. Every native Pi request receives bounded current editor content, selection, open workspace documents, diagnostics, and explicit native references; outside-workspace paths, symbolic-link aliases, and malformed references are excluded. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::collectNativePiPromptInput --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005 AC2 + REQ-IDE-006 AC1: native Pi receives bounded editor, reference, diagnostic, and chat context) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-005 AC2: native host collection captures active selection and rejects a symlink escape) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006 AC1: malformed native reference ranges are ignored at the host boundary) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006: queued native requests capture their editor and Chat context at invocation) -->
2. Official Claude receives active-file, selection, native diff, and diagnostics integration through Anthropic's authenticated loopback-only IDE MCP server. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareOfficialClaudeIde --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildOpenVscodeSettings --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-005 AC2 + REQ-IDE-006 AC1: official Claude launch writes isolated OpenVSCode settings) --> <!-- @manual: On the deployed integration image, attach an active file and selection, request a native diff, and confirm diagnostics reach official Claude on three fresh sessions. -->
3. The IDE Pi conversation identity comprises panel and editor Inline Chat and excludes terminal tab 1. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::FIXED_PI_SPAWN_SPEC --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005: lazy native Pi reuses one backend after settled turns) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: visible Pi resolution uses only the fixed no-session spawn contract) -->
4. Claude uses a dedicated temporary config tree and cannot attach to or resume terminal tab 1. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::SIDEBAR_LINK_ALLOWLIST --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-006 AC4: projection excludes terminal history, runtime state, and unknown entries) -->
5. Claude preparation links approved credential and configuration sources without copying their values into generated files, settings, logs, or messages. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareSidebarConfig --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-006 AC1+AC2: projection links only allowlisted configuration and never copies secret bytes) -->
6. Native Pi context that exceeds its budget is reduced by discarding whole units, keeping current editor state ahead of the replayed conversation, rather than by cutting the serialized context. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-006 AC6: an over-budget history replay keeps the newest turns and drops the oldest) --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-006 AC6: a context over the envelope drops whole sections and stays parseable) -->
7. Pi history hydration follows one temperature-sensitive policy: cold or replacement processes receive bounded visible history, while warm turns omit replay. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-006: warm turns omit visible history already held by the shared Pi conversation) --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-006: replacement Pi hydrates from the requesting Chat surface history) -->

**Constraints:**

- Pi context is capped at 1 MiB and treats editor content as untrusted data.
- Anthropic's IDE MCP is limited to `127.0.0.1`, a random port, and a fresh token in the isolated mode-0700 config directory, with no Codeflare-owned relay or public listener (owner-approved exception in [AD114](../../documentation/decisions/README.md#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration)).
- The one shared panel/editor Pi transcript is hidden IDE process state. It is separate from terminal Pi, and replacement bootstrap reflects only the bounded visible history of the surface whose request creates the replacement.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-OPS-003](operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Automated test ([Native Pi context tests](../../openvscode/agent-sidebar/test/native-chat.test.ts); [Pi session tests](../../openvscode/agent-sidebar/test/pi-session.test.ts); [Claude isolation tests](../../openvscode/claude/test/prepare-sidebar-config.test.mjs); deployment smoke in `.github/workflows/container-image.yml`)

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

**Verification:** Automated test ([Pi unrestricted-action tests](../../src/__tests__/lib/pi-sidebar-approval.test.ts); [extension-host tests](../../openvscode/agent-sidebar/test/vscode-approval-host.test.ts); [Claude permission tests](../../openvscode/claude/test))

**Status:** Implemented

---

### REQ-IDE-008: IDE-agent process lifecycle

**Intent:** Cancellation, failure, editor restart, and shutdown leave no surviving IDE-agent process.

**Applies To:** User

**Acceptance Criteria:**

1. Cancellation affects only its owning lifecycle state: queued work is skipped, while a touched backend is aborted and reaped without waiting indefinitely. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::runNativePiChat --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: queued cancellation skips its prompt without aborting the active turn) --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: startup cancellation after backend creation retires without a prompt) --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: active cancellation retires the backend before replacement) -->
2. Extension deactivation atomically closes the IDE Pi lifecycle: the shared backend stops once and no pending or later work can spawn. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::deactivate --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::PiSession --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: deactivation reaps once and prevents queued or later work from spawning) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-008 AC2: Pi disposal uses bounded generation reaping when TERM is ignored) -->
3. Spawn, input, protocol, transport, or unexpected-exit failure retires and boundedly reaps the shared backend before a later request creates its replacement. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::PiSession --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: protocol or process failure retires the backend before replacement) --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: an unexpected idle process exit is reaped before transparent replacement) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-008: idle blocking UI fails closed without displaying and prevents reuse) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-008: an unexpected idle Pi exit marks the backend unavailable for reuse) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-008 AC3: an asynchronous Pi spawn failure cannot leave a running backend) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-008 AC3: an asynchronous Pi stdin failure stops the backend without escaping) -->
4. Editor restart and session stop reap every process carrying the Browser IDE launch generation, including code-server extension hosts and official Claude's bundled child, before replacement or shutdown completes. <!-- @impl: entrypoint.sh::_openvscode_supervise_loop --> <!-- @impl: entrypoint.sh::kill_pidfile_subtree --> <!-- @impl: openvscode/agent-sidebar/src/process-generation.ts::reapSidebarGeneration --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (OpenVSCode launch generations / REQ-IDE-008 AC4) --> <!-- @test: openvscode/agent-sidebar/test/process-generation.test.ts (REQ-IDE-008 AC4: one Pi generation reaps a TERM-ignoring descendant in another process group) -->
5. After a normally completed turn, the shared backend is retained for the next IDE request. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005: lazy native Pi reuses one backend after settled turns) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-005 AC4: a native Pi turn streams only assistant text, reports tool progress, and completes at agent_settled) -->
6. Concurrent panel and editor requests execute in strict invocation order so prompt-unscoped Pi stream events belong to only one active turn. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: concurrent native Chat requests execute in strict FIFO order) -->

**Constraints:**

- Cleanup uses bounded TERM/KILL rescans and refuses replacement while matching descendants survive.
- The persistent IDE-owned process generation is local to the shared session container, separate from terminal Pi, and exposes no public process-control surface.

**Priority:** P1

**Dependencies:** [REQ-IDE-003](#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-005](#req-ide-005-selected-native-ide-agent)

**Verification:** Automated test ([Host lifecycle tests](../../host/__tests__/entrypoint-openvscode.test.js); [native Pi lifecycle tests](../../openvscode/agent-sidebar/test); deployment smoke in `.github/workflows/container-image.yml`)

**Status:** Partial

---

### REQ-IDE-009: Frictionless workspace open for every IDE agent

**Intent:** The editor opens its session workspace without a workspace-trust prompt or an extension-recommendation prompt, for every agent kind, so the selected agent is usable immediately.

**Applies To:** User

**Acceptance Criteria:**

1. Every agent kind — Pi, Claude, and the empty selection — opens its session workspace without a workspace-trust prompt. <!-- @impl: entrypoint.sh::_openvscode_prepare_agent --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareBaseOpenVscodeSettings --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-005 AC1 + REQ-IDE-009: every agent kind prepares IDE settings before code-server launches) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-009 + REQ-IDE-018: Pi settings seed writes workspace and native notification keys) -->
2. The seeded settings ignore extension recommendations, so the editor shows no "install recommended extensions" prompt for the opened workspace. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-009 + REQ-IDE-021: base settings remove workspace and account setup chrome) -->
3. A Claude session keeps its existing isolated Claude settings and also carries the base workspace-trust and recommendation settings. <!-- @impl: openvscode/claude/managed-settings.mjs::buildOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-009: Claude settings also carry the base workspace-trust and recommendation keys) -->
4. A settings-preparation failure fails closed and refuses the editor launch for any agent kind. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @impl: entrypoint.sh::_openvscode_prepare_agent --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-009: IDE settings preparation failure prevents code-server launch) -->

**Constraints:**

- Disabling workspace trust removes VS Code's own gate on untrusted repository input; the container is the security boundary and IDE agents already run fully unrestricted ([REQ-IDE-007](#req-ide-007-ide-guarded-approval), [AD114](../../documentation/decisions/README.md#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration)).
- The upstream code-server artifact stays unmodified under [AD119](../../documentation/decisions/README.md#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy).
- The seeded settings live only in the ephemeral code-server `--user-data-dir` under `/tmp` and never persist with workspace files ([REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable)).

**Priority:** P2

**Dependencies:** [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-007](#req-ide-007-ide-guarded-approval)

**Verification:** Automated test ([Base settings tests](../../openvscode/claude/test/managed-settings.test.mjs); [base seed tests](../../openvscode/claude/test/prepare-sidebar-config.test.mjs); [all-kinds launch tests](../../host/__tests__/entrypoint-openvscode.test.js))

**Status:** Implemented

---

### REQ-IDE-010: Pinned IDE inventory compatibility

**Intent:** Every fixed IDE inventory remains compatible with the installed code-server host at the packaged-image boundary.

**Applies To:** Operator

**Acceptance Criteria:**

1. The complete image contains fixed packaged Pi and Claude inventories and an empty packaged unsupported inventory. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::main --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyOfficialClaudeExtension --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC1: stages native Pi, official Claude, and empty unsupported inventories) -->
2. The installed Code host satisfies each extension API floor. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::assertExtensionApiFloor --> <!-- @manual: Retain the complete-image extension API-floor evidence artifact. -->
3. Packaged Pi and Claude extensions retain their pinned publisher, package, and version identities without a staged VSIX. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyOfficialClaudeExtension --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-010 AC3: refuses retained VSIX and substituted publisher or version metadata) -->
4. Each fixed inventory activates without an unexpected extension-permission requirement. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyOfficialClaudeExtension --> <!-- @manual: Retain the complete-image permission evidence before promotion. -->
5. Activation introduces no code-server account requirement for either fixed inventory. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyOfficialClaudeExtension --> <!-- @manual: Retain the complete-image account evidence before promotion. -->
6. Before first use, the complete-image process inventory contains no Pi or Claude agent process. <!-- @manual: Retain the complete-image process-laziness evidence before promotion. -->
7. The installed Code host admits the proposals required by the Pi inventory. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @manual: Retain the complete-image proposal-admission evidence artifact. -->

**Constraints:**

- The exact upstream artifacts and fixed inventories remain unchanged at runtime.
- Agent-process laziness remains behaviorally owned by [REQ-IDE-005](#req-ide-005-selected-native-ide-agent) AC4.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-OPS-027](operations.md#req-ops-027-code-server-coupled-pin-automation)

**Verification:** Automated test (packaged inventory tests in PR Checks; deployment smoke in `.github/workflows/container-image.yml` before a fresh image is scanned and pushed)

**Status:** Implemented

---

<a id="req-ide-011-review-with-pi-explorer-action"></a>
### REQ-IDE-011: File review with Codeflare

**Intent:** A Pi user can send one Explorer workspace file to Codeflare for review without entering a separate account-backed workflow.

**Applies To:** User

**Acceptance Criteria:**

1. A Pi session offers **Review with Codeflare** for an Explorer workspace file. <!-- @impl: openvscode/agent-sidebar/package.json::explorer/context --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC2 + REQ-IDE-011 AC1 + REQ-IDE-014 AC1 + REQ-IDE-019 AC1 + REQ-IDE-023 AC1: contributes native Pi panel and editor Chat) -->
2. The Explorer action attaches the chosen file to native Chat. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::openFileReview --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-011 AC2+AC3: explorer review attaches one file and submits Codeflare ask mode) -->
3. The Explorer action submits the request to the Codeflare native Chat participant in ask mode. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::openFileReview --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-011 AC2+AC3: explorer review attaches one file and submits Codeflare ask mode) -->
4. Outside-workspace resources are rejected before native Chat opens. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::canonicalWorkspaceFilePath --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-011 AC4: explorer review rejects resources outside the workspace) -->
5. Symbolic-link-alias resources are rejected before native Chat opens. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::canonicalWorkspaceFilePath --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-011 AC5: explorer review rejects a symlink alias before opening native Chat) -->

**Constraints:**

- The action reuses the native Codeflare participant and canonical workspace boundary; it adds no comment controller, agent process, account provider, or Copilot integration.
- The review action is available only in the fixed Pi inventory.

**Priority:** P2

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-006](#req-ide-006-ide-conversation-context-and-credential-isolation), [REQ-IDE-010](#req-ide-010-pinned-ide-inventory-compatibility)

**Verification:** Automated test ([activation behavior](../../openvscode/agent-sidebar/test/activation.test.ts); deployment smoke in `.github/workflows/container-image.yml`)

**Status:** Implemented

---

### REQ-IDE-012: Fixed, clean Browser IDE workspace selection

**Intent:** Public Browser IDE navigation cannot select another folder, workspace file, or empty window.

**Applies To:** User

**Acceptance Criteria:**

1. The Worker rejects every public Browser IDE workspace selector before container access for HTTP requests, including encoded and repeated forms. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (REQ-IDE-012: rejects public workspace selectors before the container boundary) -->
2. The Worker rejects public Browser IDE workspace selectors before container access for WebSocket requests. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (REQ-IDE-012: rejects a WebSocket workspace selector before the container boundary) -->
3. The container host independently rejects the selector set before opening an HTTP connection to code-server. <!-- @impl: host/src/vscode-proxy.ts::vscodeUpstreamRequestTarget --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-012: rejects public workspace selectors before contacting code-server) -->
4. The container host independently rejects the selector set before opening a WebSocket connection to code-server. <!-- @impl: host/src/vscode-proxy.ts::vscodeUpstreamRequestTarget --> <!-- @impl: host/src/upgrade-dispatcher.ts::createUpgradeDispatcher --> <!-- @test: host/__tests__/browser-ide-upgrade.test.js (REQ-IDE-012: rejects public workspace selectors before opening a code-server socket) -->

**Constraints:**

- Worker and host validation remain independent defense-in-depth boundaries.
- This confines public workspace selection; it is not an operating-system sandbox.

**Priority:** P1

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy)

**Verification:** Automated test (Worker and host HTTP/WebSocket tests); deployed selector-rejection verification on three fresh sessions

**Status:** Implemented

---

<a id="req-ide-013-account-free-native-pi-chat"></a>
### REQ-IDE-013: Account-backed Code Review suppression

**Intent:** A Pi user sees the account-free Codeflare review path without Code OSS's unrelated account-backed Code Review action.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi inventory suppresses Code OSS's account-backed **Code Review** setup action. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5: native Pi registers account-free panel and editor Chat) -->
2. Suppressing the account-backed action leaves **Review with Codeflare** available. <!-- @impl: openvscode/agent-sidebar/package.json::explorer/context --> <!-- @impl: openvscode/agent-sidebar/package.json::editor/context --> <!-- @manual: On the deployed integration image, confirm Review with Codeflare remains and Code Review is absent in three fresh Pi sessions. -->

**Constraints:**

- Generic Chat setup completion is a pinned Code OSS compatibility mechanism, not an authentication boundary.
- Native Codeflare Chat remains enabled.

**Priority:** P2

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-011](#req-ide-011-file-review-with-codeflare), [REQ-IDE-014](#req-ide-014-active-editor-review-with-codeflare)

**Verification:** Automated test (activation and packaged-image tests); deployed menu verification

**Status:** Implemented

---

<a id="req-ide-014-editor-context-native-chat-review"></a>
<a id="req-ide-014-review-with-pi-editor-context-action"></a>
### REQ-IDE-014: Active-editor review with Codeflare

**Intent:** A Pi user can send the active workspace file to Codeflare from the editor context menu.

**Applies To:** User

**Acceptance Criteria:**

1. A Pi session offers **Review with Codeflare** in the active file editor's context menu. <!-- @impl: openvscode/agent-sidebar/package.json::editor/context --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC2 + REQ-IDE-011 AC1 + REQ-IDE-014 AC1 + REQ-IDE-019 AC1 + REQ-IDE-023 AC1: contributes native Pi panel and editor Chat) -->
2. An absent or malformed command resource falls back to the active file. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::openFileReview --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-014 AC2: editor review ignores a malformed command argument and uses the active file) -->
3. The editor action attaches the active file to native Chat. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::openFileReview --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-014 AC3+AC4: editor review attaches the active file and submits Codeflare ask mode) -->
4. The editor action submits the request to the Codeflare native Chat participant in ask mode. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::openFileReview --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-014 AC3+AC4: editor review attaches the active file and submits Codeflare ask mode) -->

**Constraints:**

- Canonical workspace validation remains owned by [REQ-IDE-011](#req-ide-011-file-review-with-codeflare) AC4-AC5.
- The review action is available only in the fixed Pi inventory.

**Priority:** P2

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-011](#req-ide-011-file-review-with-codeflare)

**Verification:** Automated test (activation and packaging tests)

**Status:** Implemented

---

### REQ-IDE-015: Fixed workspace projection and clean Browser IDE URL

**Intent:** The Browser IDE opens the fixed session workspace without exposing the container path in the browser URL.

**Applies To:** User

**Acceptance Criteria:**

1. Only private root navigation selects the fixed session workspace. <!-- @impl: host/src/vscode-proxy.ts::vscodeUpstreamRequestTarget --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamRequestTarget / REQ-IDE-015 (fixed clean workspace navigation)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-015 AC1+AC2: keeps the browser URL clean while selecting the fixed loopback workspace) -->
2. Non-root protocol and asset requests preserve unrelated query parameters. <!-- @impl: host/src/vscode-proxy.ts::vscodeUpstreamRequestTarget --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamRequestTarget / REQ-IDE-015 (fixed clean workspace navigation)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-015 AC1+AC2: keeps the browser URL clean while selecting the fixed loopback workspace) -->
3. Root-relative editor redirects remain under the authenticated session route. <!-- @impl: host/src/vscode-proxy.ts::rewriteVscodeLocation --> <!-- @impl: host/src/request-router.ts::rewriteVscodeResponseHeaders --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamRequestTarget / REQ-IDE-015 (fixed clean workspace navigation)) -->
4. Browser-visible redirects contain no workspace selector. <!-- @impl: host/src/vscode-proxy.ts::rewriteVscodeLocation --> <!-- @impl: host/src/request-router.ts::rewriteVscodeResponseHeaders --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamRequestTarget / REQ-IDE-015 (fixed clean workspace navigation)) -->
5. Clean root navigation opens the fixed session workspace. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyCodeServerWorkspaceProjection --> <!-- @test: host/__tests__/openvscode-proxy.test.js (projectVscodeWorkbenchWorkspace / REQ-IDE-015 AC5+AC6+AC7 (clean fixed workbench configuration)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-015 AC5+AC6+AC7: root workbench configuration projection) -->
6. Unsafe fixed-workspace initialization fails closed instead of opening an empty window. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/openvscode-proxy.test.js (projectVscodeWorkbenchWorkspace / REQ-IDE-015 AC5+AC6+AC7 (clean fixed workbench configuration)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-015 AC5+AC6+AC7: root workbench configuration projection) -->
7. Workspace projection leaves every server-provided IDE setting other than the selected folder unchanged. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace --> <!-- @test: host/__tests__/openvscode-proxy.test.js (projectVscodeWorkbenchWorkspace / REQ-IDE-015 AC5+AC6+AC7 (clean fixed workbench configuration)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-015 AC5+AC6+AC7: root workbench configuration projection) -->

**Notes:** Version-pinned incompatibility conditions are owned by the [container documentation](../../documentation/lanes/container.md#code-server-browser-ide).

**Constraints:**

- Initial IDE navigation confinement is not an operating-system sandbox; terminals, trusted extensions, and agents retain their existing container filesystem access.
- The fixed container path never appears in a browser-visible redirect or required public query.

**Priority:** P1

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-012](#req-ide-012-fixed-clean-browser-ide-workspace-selection)

**Verification:** Automated test (host proxy tests and complete-image smoke); deployed clean-URL verification on three fresh sessions

**Status:** Implemented

---

### REQ-IDE-016: UI-state capture and restore ordering

**Intent:** Safe Browser IDE preferences move between sessions only after live state is closed and before managed settings are applied to fresh storage.

**Applies To:** User

**Acceptance Criteria:**

1. Snapshot capture starts only after the editor generation is reaped. <!-- @impl: entrypoint.sh::_openvscode_supervise_loop --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-016 AC1: captures UI state only after the code-server generation exits) -->
2. Restore creates fresh storage before managed settings are reapplied. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::writeOpenVscodeUserSettings --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-016 AC2: restores safe UI state before managed settings and code-server launch) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-002 AC7 + REQ-IDE-016 AC2: settings preparation preserves safe UI preferences but replaces stale managed inventory settings) -->

**Constraints:**

- Capture and restore use only the bounded snapshot defined by [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable).
- Managed Codeflare and Claude settings remain authoritative after restore.

**Priority:** P1

**Dependencies:** [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-003](#req-ide-003-ide-lifecycle-and-availability)

**Verification:** Automated test (editor lifecycle and settings-preparation tests)

**Status:** Implemented

---

### REQ-IDE-017: Unsupported IDE inventory runtime metadata

**Intent:** Starting code-server with the unsupported inventory cannot install or expose an unsupported editor extension.

**Applies To:** Operator

**Acceptance Criteria:**

1. After code-server initializes the unsupported inventory, that inventory contains no extension. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyUnsupportedInventory --> <!-- @test: host/__tests__/unsupported-ide-inventory.test.js (REQ-IDE-017 AC1: unsupported inventory remains extension-free after initialization) -->

**Constraints:**

- code-server may create one regular `extensions.json` registry file containing exactly `[]`; every other runtime entry is rejected.
- The packaged unsupported inventory remains empty under [REQ-IDE-010](#req-ide-010-pinned-ide-inventory-compatibility) AC1.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-010](#req-ide-010-pinned-ide-inventory-compatibility)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-IDE-018: Native Pi Chat browser notifications

**Intent:** Pi native Chat uses the pinned Code OSS browser-notification lifecycle for completed responses and native confirmations instead of a Codeflare-owned duplicate event path.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi inventory enables Code OSS OS notifications for received responses and confirmations when the editor window is not focused. <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings --> <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-018 + REQ-IDE-019 AC6 + REQ-IDE-021 AC1: Pi native Chat settings suppress Copilot and retain one personal agent source) --> <!-- @manual: On deployed integration, complete and confirm Pi native Chat turns with the editor unfocused and verify Code OSS notification permission, focus, and lifetime behavior. -->
2. The unsupported inventory retains its existing disabled native Chat behavior. <!-- @impl: openvscode/claude/managed-settings.mjs::buildUnsupportedOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-005: unsupported inventory suppresses native Chat and Copilot setup) -->
3. The Claude inventory retains its existing suppression of unrelated native Chat setup. <!-- @impl: openvscode/claude/managed-settings.mjs::buildOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-005 AC3: Claude suppresses unrelated native Chat setup) -->
4. The Claude inventory presents the official upstream panel's in-product notification behavior. <!-- @impl: openvscode/agent-sidebar/src/package-extension.ts::stageSidebarExtension --> <!-- @manual: On deployed integration, exercise the official Claude panel's upstream in-product notification behavior. -->
5. The packaged official Claude extension remains unmodified. <!-- @impl: openvscode/agent-sidebar/src/package-extension.ts::stageSidebarExtension --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyOfficialClaudeExtension --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC1: stages native Pi, official Claude, and empty unsupported inventories) -->

**Constraints:**

- Code OSS owns permission requests, focus policy, notification lifetime, and click-to-focus behavior for native Chat.
- The terminal OSC bridge under [REQ-TERM-023](terminal.md#req-term-023-native-agent-browser-notification-delivery) does not duplicate Pi native Chat events.
- The official Claude package remains checksum-pinned during the image build; no extension patch, DOM observer, or private relay is introduced.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-TERM-023](terminal.md#req-term-023-native-agent-browser-notification-delivery)

**Verification:** Automated test (managed-settings and fixed-inventory tests); deployed Pi native Chat and Claude panel verification.

**Status:** Partial


---

### REQ-IDE-019: Codeflare eligibility in editor Inline Chat

**Intent:** A Pi-selected advanced session exposes Codeflare as the account-free default in panel and editor Inline Chat.

**Applies To:** User

**Acceptance Criteria:**

1. The same Codeflare participant is available in panel and editor Inline Chat. <!-- @impl: openvscode/agent-sidebar/package.json::chatParticipants --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC2 + REQ-IDE-011 AC1 + REQ-IDE-014 AC1 + REQ-IDE-019 AC1 + REQ-IDE-023 AC1: contributes native Pi panel and editor Chat) -->
2. From initial workbench readiness, editor Inline Chat lists **Codeflare** as a selectable default model from Codeflare's own provider without a GitHub Copilot login. <!-- @impl: openvscode/agent-sidebar/package.json::activationEvents --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_VISIBLE_MODEL --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5: native Pi registers account-free panel and editor Chat) --> <!-- @manual: On a fresh deployed Pi inventory, verify Codeflare is the initial selectable default and no Copilot login is offered. -->
3. Selected-code editor refactoring invokes Codeflare without a GitHub Copilot login. <!-- @impl: openvscode/agent-sidebar/package.json::chatParticipants --> <!-- @manual: On a fresh deployed Pi inventory, select code, invoke editor Inline Chat, and verify Codeflare handles the request without Copilot login. -->
4. Empty-selection editor generation invokes Codeflare without a GitHub Copilot login. <!-- @impl: openvscode/agent-sidebar/package.json::chatParticipants --> <!-- @manual: On a fresh deployed Pi inventory, invoke editor Inline Chat without a selection and verify Codeflare handles the request without Copilot login. -->
5. Codeflare requests no model authorization. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_FALLBACK_MODEL --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_VISIBLE_MODEL --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5: native Pi registers account-free panel and editor Chat) -->
6. Each Codeflare custom agent appears once in Code OSS's Agent selector. <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-018 + REQ-IDE-019 AC6 + REQ-IDE-021 AC1: Pi native Chat settings suppress Copilot and retain one personal agent source) --> <!-- @manual: On a fresh deployed Pi inventory, open the Code OSS Agent selector and verify each Codeflare custom agent appears exactly once. -->

**Constraints:**

- The Pi package enables `chatParticipantAdditions`, `chatParticipantPrivate`, `chatProvider`, and `defaultChatParticipant` for panel/editor locations.
- The hidden, non-selectable `copilot` fallback preserves the pinned extension host's absent-request-model lookup; it is panel-default only and has no tool-calling capability.
- The `codeflare` vendor keeps the selectable model outside Copilot setup; tool-calling metadata is host eligibility, not inference.
- Pi settings disable the duplicate `~/.claude/agents` source while retaining Code OSS discovery from `~/.copilot/agents` and Pi discovery from `~/.pi/agent/agents`.
- Both compatibility providers remain fail-closed if any caller attempts generation.
- Codeflare does not patch code-server or Code OSS, so the host's generic **Refactor...** action and editor Inline Chat area remain upstream-owned.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-013](#req-ide-013-account-free-native-pi-chat), [REQ-IDE-014](#req-ide-014-editor-context-native-chat-review)

**Verification:** PR-boundary review and GitHub Actions CI validate package metadata, adapter metadata, fail-closed generation, and inventory isolation through `scripts/ci/smoke-openvscode-sidebar-image.mjs` and the `Measure idle code-server resources` job block in `.github/workflows/container-image.yml`. AC2–AC4 and AC6 remain explicit deployed manual checks.

**Status:** Partial

---

### REQ-IDE-020: Native Pi editor proposal execution

**Intent:** Editor-originated requests become host-owned native Inline Chat edit transactions without panel handoff or direct Pi filesystem mutation.

**Applies To:** User

**Acceptance Criteria:**

1. Editor requests capture the canonical active document's unsaved content, selection, diagnostics, explicit references, and bounded recent history when invoked while excluding invalid and out-of-workspace resources. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::collectNativePiPromptInput --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-005 AC2: native host collection captures active selection and rejects a symlink escape) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006 AC1: malformed native reference ranges are ignored at the host boundary) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006: queued native requests capture their editor and Chat context at invocation) -->
2. An editor request invokes the local Pi runtime directly without compatibility-provider generation or panel handoff. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::runNativePiChat --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026: inline-first renders one host-owned edit through shared Pi) -->
3. A valid proposal emits native text edits for the captured document. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026: inline-first renders one host-owned edit through shared Pi) -->
4. The host emits the native edit-completion marker after those edits. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026: inline-first renders one host-owned edit through shared Pi) -->
5. The rendered native transaction offers **Keep** for the proposed edits. <!-- @manual: On fresh deployed integration, generate an Inline Chat edit and verify Keep applies the displayed proposal. -->
6. Reject or Undo restores the document through the native Inline Chat transaction. <!-- @manual: On fresh deployed integration, reject or undo an Inline Chat proposal and verify the prior document content is restored. -->

**Constraints:**

- Codeflare neither patches Code OSS nor replays already-applied filesystem changes as host edits.
- Pi never writes the target document during an editor proposal turn.

**Priority:** P1

**Dependencies:** [REQ-IDE-006](#req-ide-006-ide-conversation-context-and-credential-isolation), [REQ-IDE-019](#req-ide-019-codeflare-eligibility-in-editor-inline-chat), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation), [REQ-IDE-026](#req-ide-026-native-inline-edit-proposal-validation)

**Verification:** PR-boundary review and GitHub Actions CI validate native context and host-owned edit rendering. Fresh deployed editor generation remains the Keep/Undo evidence boundary.

**Status:** Partial

---

### REQ-IDE-021: Account-free Browser IDE chrome

**Intent:** Browser IDE sessions omit Code OSS's Copilot status, Chat title-bar sign-in, and left-side Accounts chrome while retaining Codeflare Chat and independent agent credentials.

**Applies To:** User

**Acceptance Criteria:**

1. Pi sessions hide unrelated built-in AI setup. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5: native Pi registers account-free panel and editor Chat) --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-018 + REQ-IDE-019 AC6 + REQ-IDE-021 AC1: Pi native Chat settings suppress Copilot and retain one personal agent source) -->
2. Pi sessions retain account-free Codeflare models. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5: native Pi registers account-free panel and editor Chat) -->
3. Preparation preserves existing unrelated profile values and hidden status entries. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::writeOpenVscodeProfileState --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-021: every prepared inventory preserves status entries and hides Accounts chrome) -->
4. Pi, Claude, and unsupported inventories configure the left-side Accounts control as hidden. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::writeOpenVscodeProfileState --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-021: every prepared inventory preserves status entries and hides Accounts chrome) -->
5. Pi, Claude, and unsupported inventories omit Code OSS's Chat title-bar sign-in affordance. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-009 + REQ-IDE-021: base settings remove workspace and account setup chrome) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-002 AC7 + REQ-IDE-016 AC2: settings preparation preserves safe UI preferences but replaces stale managed inventory settings) -->

**Constraints:**

- Server-side `User/State/storage.json` does not own Code OSS status-entry visibility.
- The upstream artifact, Docker pin, and Bump Shadow Pins workflow remain unchanged; authentication APIs, credentials, unrelated status entries, and UI-snapshot contents remain outside these bounded context, profile, and User-setting mutations.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-010](#req-ide-010-pinned-ide-inventory-compatibility), [REQ-IDE-019](#req-ide-019-codeflare-eligibility-in-editor-inline-chat)

**Verification:** PR-boundary review and GitHub Actions CI validate context, settings, and profile preparation plus complete-image packaging. Fresh deployed Pi, Claude, and unsupported sessions remain the manual rendered-chrome evidence boundary.

**Status:** Partial

---

### REQ-IDE-022: Native Pi blocking UI protocol

**Intent:** Native Pi questions complete through bounded editor dialogs without leaving the active shared-backend turn blocked or approving unsupported requests.

**Applies To:** User

**Acceptance Criteria:**

1. Select requests present only their bounded options and return the selected value to the matching Pi request. <!-- @impl: openvscode/agent-sidebar/src/pi/approval-bridge.ts::ApprovalBridge --> <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-approval-host.ts::VsCodeApprovalHost --> <!-- @test: openvscode/agent-sidebar/test/approval-bridge.test.ts (REQ-IDE-022: Pi RPC select and input dialogs return correlated values) --> <!-- @test: openvscode/agent-sidebar/test/vscode-approval-host.test.ts (REQ-IDE-022: Pi RPC select and input use bounded native VS Code dialogs) -->
2. Input requests present a bounded native input dialog and return its value to the matching Pi request. <!-- @impl: openvscode/agent-sidebar/src/pi/approval-bridge.ts::ApprovalBridge --> <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-approval-host.ts::VsCodeApprovalHost --> <!-- @test: openvscode/agent-sidebar/test/approval-bridge.test.ts (REQ-IDE-022: Pi RPC select and input dialogs return correlated values) --> <!-- @test: openvscode/agent-sidebar/test/vscode-approval-host.test.ts (REQ-IDE-022: Pi RPC select and input use bounded native VS Code dialogs) -->
3. Dialog dismissal returns cancellation to the matching Pi request. <!-- @impl: openvscode/agent-sidebar/src/pi/approval-bridge.ts::ApprovalBridge --> <!-- @test: openvscode/agent-sidebar/test/approval-bridge.test.ts (REQ-IDE-022: Pi RPC dialog dismissal returns a correlated cancellation) -->
4. A bounded Pi timeout closes the dialog, returns cancellation, and allows the active turn to continue. <!-- @impl: openvscode/agent-sidebar/src/pi/approval-bridge.ts::ApprovalBridge --> <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-approval-host.ts::VsCodeApprovalHost --> <!-- @test: openvscode/agent-sidebar/test/approval-bridge.test.ts (REQ-IDE-022: Pi RPC dialog timeout returns a correlated cancellation) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-022: a timed-out Pi RPC dialog writes cancellation and the active turn continues) -->
5. Request cancellation closes an active native dialog and returns a correlated cancellation response. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-approval-host.ts::VsCodeApprovalHost --> <!-- @test: openvscode/agent-sidebar/test/vscode-approval-host.test.ts (REQ-IDE-022: cancelling active Pi dialogs closes them with correlated responses) -->
6. Malformed, editor, and unknown blocking UI requests stop the shared backend generation without approval or silent fallback. <!-- @impl: openvscode/agent-sidebar/src/pi/approval-bridge.ts::ApprovalBridge --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/approval-bridge.test.ts (REQ-IDE-022: Pi approval bridge rejects malformed or unsupported UI requests) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-022: an unknown blocking Pi UI request fails and stops the active generation) -->

**Constraints:**

- Manifest-backed `confirm` remains unchanged; no multiline `editor` substitute or unknown-method approval is introduced, and dialog fields and timeouts remain bounded at the RPC boundary.
- Strict FIFO execution permits only the active shared-process turn to own a blocking dialog; queued cancellation cannot close that active turn's UI.

**Priority:** P1

**Dependencies:** [REQ-IDE-007](#req-ide-007-ide-guarded-approval), [REQ-IDE-008](#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-020](#req-ide-020-native-pi-editor-proposal-execution)

**Verification:** PR-boundary review and GitHub Actions CI only. Configured bridge, host, backend, and shared-runtime tests cover each blocking protocol result, FIFO ownership, and generation behavior.

**Status:** Partial

---

### REQ-IDE-023: Browser IDE inventory compatibility preservation

**Intent:** Native Pi editor eligibility does not regress the independently packaged Browser IDE entry surfaces.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi inventory contributes Codeflare to panel Chat. <!-- @impl: openvscode/agent-sidebar/package.json::chatParticipants --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC2 + REQ-IDE-011 AC1 + REQ-IDE-014 AC1 + REQ-IDE-019 AC1 + REQ-IDE-023 AC1: contributes native Pi panel and editor Chat) -->
2. **Review with Codeflare** attaches an Explorer workspace file and submits it to Codeflare ask mode. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-011 AC2+AC3: explorer review attaches one file and submits Codeflare ask mode) -->
3. The Pi inventory contributes **Review with Codeflare** to the editor context menu. <!-- @impl: openvscode/agent-sidebar/package.json::editor/context --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC2 + REQ-IDE-011 AC1 + REQ-IDE-014 AC1 + REQ-IDE-019 AC1 + REQ-IDE-023 AC1: contributes native Pi panel and editor Chat) -->
4. Image staging installs the official Claude inventory. <!-- @impl: openvscode/agent-sidebar/src/package-extension.ts::stageSidebarExtension --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC1: stages native Pi, official Claude, and empty unsupported inventories) -->
5. The unsupported inventory remains extension-free after initialization. <!-- @impl: entrypoint.sh::_openvscode_extensions_dir --> <!-- @test: host/__tests__/unsupported-ide-inventory.test.js (REQ-IDE-017 AC1: unsupported inventory remains extension-free after initialization) -->

**Constraints:** Compatibility preservation adds no code-server or Code OSS patch and changes no Bump Shadow Pins ownership.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-011](#req-ide-011-review-with-pi-explorer-action), [REQ-IDE-014](#req-ide-014-review-with-pi-editor-context-action), [REQ-IDE-017](#req-ide-017-unsupported-ide-inventory-runtime-metadata), [REQ-IDE-019](#req-ide-019-codeflare-eligibility-in-editor-inline-chat)

**Verification:** PR-boundary review and GitHub Actions CI validate the five independently packaged compatibility surfaces.

**Status:** Implemented

---

### REQ-IDE-024: Codeflare Browser IDE welcome

**Intent:** Every Browser IDE opens with a Codeflare-owned explanation of the editor’s traditional and agentic roles, while agent controls remain truthful to the selected inventory.

**Applies To:** User

**Acceptance Criteria:**

1. Pi, Claude, and unsupported sessions open one Codeflare welcome editor with non-empty owned HTML. <!-- @impl: openvscode/agent-sidebar/src/welcome-extension.ts::activate --> <!-- @impl: Dockerfile::codeflare-welcome --> <!-- @test: openvscode/agent-sidebar/test/welcome-extension.test.ts (REQ-IDE-024 AC1+AC4: every inventory opens one welcome editor with its fixed primary action) -->
2. The welcome editor explains full VS Code availability, the observability-plane role, and the shared isolated ephemeral container. <!-- @impl: openvscode/agent-sidebar/src/welcome.ts::renderWelcomeHtml --> <!-- @test: openvscode/agent-sidebar/test/welcome.test.ts (REQ-IDE-024 AC2+AC5+AC7: welcome HTML renders universal editor foundations and the selected native plane without external content) -->
3. The welcome editor adapts to light and dark themes, responsive viewport widths, and reduced-motion preferences. <!-- @impl: openvscode/agent-sidebar/src/welcome.ts::renderWelcomeHtml --> <!-- @manual: On deployed integration, verify the welcome editor in light and dark themes at desktop and mobile widths, including reduced motion. -->
4. The welcome action opens Codeflare Chat for Pi, opens the official Claude Code panel for Claude, and exposes no agent action for unsupported selections. <!-- @impl: openvscode/agent-sidebar/src/welcome.ts::buildWelcomePresentation --> <!-- @impl: openvscode/agent-sidebar/src/welcome-extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/welcome-extension.test.ts (REQ-IDE-024 AC1+AC4: every inventory opens one welcome editor with its fixed primary action) --> <!-- @test: openvscode/agent-sidebar/test/welcome.test.ts (REQ-IDE-024 AC4+AC7: every inventory gets an honest fixed welcome action) --> <!-- @test: openvscode/agent-sidebar/test/welcome.test.ts (REQ-IDE-024 AC4: only exact Pi and Claude selections enable an IDE agent) -->
5. The welcome extension loads no external content. <!-- @impl: openvscode/agent-sidebar/src/welcome.ts::renderWelcomeHtml --> <!-- @test: openvscode/agent-sidebar/test/welcome.test.ts (REQ-IDE-024 AC2+AC5+AC7: welcome HTML renders universal editor foundations and the selected native plane without external content) -->
6. The welcome extension contributes no Chat participant, language-model provider, or agent view and leaves agent inventory ownership unchanged. <!-- @impl: openvscode/agent-sidebar/welcome-package.json::contributes --> <!-- @impl: Dockerfile::codeflare-welcome --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-024 AC6: the shared welcome extension contributes no agent surface) -->
7. The welcome editor identifies native Pi, official Claude Code, or editor-only mode according to the selected inventory. <!-- @impl: openvscode/agent-sidebar/src/welcome.ts::buildWelcomePresentation --> <!-- @impl: openvscode/agent-sidebar/src/welcome.ts::renderWelcomeHtml --> <!-- @test: openvscode/agent-sidebar/test/welcome.test.ts (REQ-IDE-024 AC4+AC7: every inventory gets an honest fixed welcome action) --> <!-- @test: openvscode/agent-sidebar/test/welcome.test.ts (REQ-IDE-024 AC2+AC5+AC7: welcome HTML renders universal editor foundations and the selected native plane without external content) -->

**Constraints:**

- The keyboard-accessible welcome package is installed without modifying code-server or Code OSS source.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-009](#req-ide-009-frictionless-workspace-open-for-every-ide-agent), [REQ-IDE-017](#req-ide-017-unsupported-ide-inventory-runtime-metadata)

**Verification:** PR-boundary review and GitHub Actions CI validate owned rendering, inventory-specific actions, CSP isolation, and packaged built-in extension bytes. A fresh deployed session remains the manual non-empty rendered-editor evidence boundary.

**Status:** Partial

---

### REQ-IDE-025: Shared IDE Pi surface isolation

**Intent:** Panel and editor turns share one persistent IDE Pi conversation while each surface retains its truthful capability boundary.

**Applies To:** User

**Acceptance Criteria:**

1. Participant requests invoke the local Pi RPC backend instead of either compatibility provider's generation path. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::NodePiProcessSpawner --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-025 AC1: participant requests run the local Pi backend without provider generation) -->
2. The Browser IDE creates at most one lazy IDE-owned Pi process, separate from terminal Pi. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-025: panel-first then native inline edit reuses one unrestricted IDE Pi conversation) -->
3. Panel and editor turns retain one in-memory Pi conversation. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-025: panel and native inline edit turns reuse one backend with surface-specific output) -->
4. Panel turns retain their existing unrestricted tool set without editor permission prompts. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-approval-host.ts::VsCodeApprovalHost --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline edit mode exposes only one proposal tool and restores unrestricted panel tools) --> <!-- @test: openvscode/agent-sidebar/test/vscode-approval-host.test.ts (REQ-IDE-007 AC2: Pi Edit Write and Bash need no confirmation and open no editor tabs) -->
5. An editor turn activates only `codeflare_submit_inline_edits`. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline edit mode exposes only one proposal tool and restores unrestricted panel tools) -->
6. That editor command dispatches exactly one prompt into the shared IDE Pi conversation. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline edit mode exposes only one proposal tool and restores unrestricted panel tools) -->
7. Editor settlement restores the exact prior panel tool set before the external RPC settlement releases the next turn. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline edit mode exposes only one proposal tool and restores unrestricted panel tools) -->

**Constraints:**

- The fixed local `pi --mode rpc --no-session --no-themes` process serializes all IDE turns.
- Pi 0.84.1 awaits extension settlement handlers before emitting external settlement.
- Active cancellation or backend failure follows REQ-IDE-008 process-generation ownership.

**Priority:** P1

**Dependencies:** [REQ-IDE-007](#req-ide-007-ide-guarded-approval), [REQ-IDE-008](#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-019](#req-ide-019-codeflare-eligibility-in-editor-inline-chat)

**Verification:** PR-boundary review and GitHub Actions CI validate local routing, process reuse, proposal-only activation, exact tool restoration, and complete-image behavior.

**Status:** Partial

---

### REQ-IDE-026: Native Inline Chat proposal validation

**Intent:** Only one bounded, correlated, current-document edit proposal can cross from Pi into the host-owned native Inline Chat transaction.

**Applies To:** User

**Acceptance Criteria:**

1. Exactly one proposal whose request ID matches the active editor turn crosses the backend; every other cardinality or correlation outcome retires that backend. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditProposal --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-026: inline Pi returns one correlated host-owned edit proposal without markdown) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-026: inline Pi rejects a duplicate proposal and retires the backend) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-026: inline Pi rejects an uncorrelated proposal and retires the backend) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-026: inline Pi fails closed when settlement has no valid proposal) -->
2. A proposal contains between one and 64 edits. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditProposal --> <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: empty inline edit proposals fail closed) --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: more than 64 inline edits fail closed) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-026: inline Pi rejects more than 64 proposed edits and retires the backend) -->
3. The combined replacement text is at most 256 KiB in UTF-8. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditProposal --> <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: inline edit payloads above 256 KiB fail closed) -->
4. Every coordinate is a non-negative safe integer whose start does not follow its end. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditProposal --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: invalid inline edit coordinates fail closed) -->
5. Accepted edits are deterministically ordered and contain neither a repeated start nor a crossing range. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditProposal --> <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: adjacent non-overlapping inline edits are accepted and ordered) --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: repeated edit starts fail closed) --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: overlapping inline edits fail closed) -->
6. Every edit position lies within the captured active document. <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: out-of-bounds inline edits fail closed) -->
7. The active document version still equals its captured version when the host emits edits. <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: stale document versions fail closed) -->

**Constraints:**

- Proposal fields cannot name another URI or request direct filesystem mutation.
- Any proposal validation failure prevents host edit emission; dispatch-error isolation is owned by [REQ-IDE-028](#req-ide-028-native-inline-chat-dispatch-error-isolation).

**Priority:** P1

**Dependencies:** [REQ-IDE-008](#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation)

**Verification:** PR-boundary review and GitHub Actions CI validate proposal cardinality, correlation, count, byte size, geometry, document bounds, and version freshness. Fresh deployment verifies rendered native transaction behavior under REQ-IDE-020.

**Status:** Partial

---

### REQ-IDE-027: Native Pi panel reasoning and bounded progress

**Intent:** A Pi user can follow a long native panel turn without waiting behind an unbounded list of repetitive tool messages.

**Applies To:** User

**Acceptance Criteria:**

1. Panel turns stream provider-emitted reasoning through Code OSS's native thinking UI separately from the final answer. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-027: a native Pi panel turn streams reasoning, bounds tool progress, and settles with its answer) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-025: panel-first then native inline edit reuses one unrestricted IDE Pi conversation) -->
2. A panel turn reports each bounded tool-activity category at most once. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-027: a native Pi panel turn streams reasoning, bounds tool progress, and settles with its answer) -->

**Constraints:**

- Tool progress exposes neither command arguments nor file contents.
- Editor Inline Chat remains a host-owned edit transaction and does not render panel reasoning.
- code-server and Code OSS source remain unmodified.

**Priority:** P2

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation)

**Verification:** GitHub Actions validates reasoning forwarding and bounded activity reporting. Fresh integration verifies the native thinking presentation during a long panel turn.

**Status:** Partial

---

### REQ-IDE-028: Native Inline Chat dispatch-error isolation

**Intent:** An editor request fails closed when its nested Pi dispatch fails without allowing unrelated extension errors to discard a valid proposal.

**Applies To:** User

**Acceptance Criteria:**

1. An error attributed to the active editor command rejects that editor request. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: inline command extension errors reject immediately and retire the backend) -->
2. The next IDE request after that command failure uses a replacement IDE Pi process. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: inline command extension errors reject immediately and retire the backend) --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: protocol or process failure retires the backend before replacement) -->
3. An asynchronous failure starting the editor turn after command acceptance rejects that editor request. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: asynchronous inline dispatch errors reject after command acceptance and retire the backend) -->
4. The next IDE request after that asynchronous failure uses a replacement IDE Pi process. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: asynchronous inline dispatch errors reject after command acceptance and retire the backend) --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: protocol or process failure retires the backend before replacement) -->
5. An unrelated extension error does not prevent a valid editor request from returning its proposed edits. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: unrelated extension errors do not discard a valid inline proposal) -->

**Constraints:**

- Runtime dispatch errors are owned only while an editor turn is active.
- No timeout, third process, Code OSS patch, or direct-write replay is introduced.

**Priority:** P1

**Dependencies:** [REQ-IDE-008](#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation)

**Verification:** GitHub Actions validates both Pi 0.84.1 dispatch-error envelopes and unrelated-error isolation. Fresh integration verifies that an editor request either renders host-owned edits or rejects without an indefinite wait.

**Status:** Partial

---
