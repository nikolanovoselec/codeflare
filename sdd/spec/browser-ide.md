# Browser IDE

A full code-server browser editor for an advanced running session. The editor opens that session's workspace, stays isolated from every other session, and uses the existing authenticated session-container path.

**Domain owner:** Worker editor route, container host proxy, editor lifecycle supervisor, and header launch control

### Key Concepts

- **Browser IDE** -- The per-session code-server editor defined in the [glossary](glossary.md#glossary).
- **Session isolation** -- Editor routing, live databases, extension runtime state, server state, and workspace selection belong to one session. Only bounded UI-preference and user-extension manifests are shared through the user's storage identity; extension bytes remain session-local.
- **Lazy start** -- The editor consumes resources only after an eligible user first opens it.
- **Editor activity** -- Any message sent from the browser editor to the session counts as input for the same idle policy used by terminal input.

### Out of Scope

- A separate editor deployment, container, authentication system, or origin.
- Cross-session persistence of live editor databases, extension bytes or runtime state, SecretStorage, authentication, chat history, logs, or settings outside the two bounded manifests.
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

**Intent:** Each session receives an independent live editor for its own workspace while bounded UI-preference and user-extension manifests follow the user without persisting live editor databases or extension bytes.

**Applies To:** User

**Acceptance Criteria:**

1. Editor routing selects only the requested session and never substitutes a shared storage identity. <!-- @impl: src/routes/vscode-validation.ts::validateVscodeRoute --> <!-- @test: src/__tests__/routes/vscode-validation.test.ts (REQ-IDE-002: a valid route result carries a sessionId and never a bucketToken) -->
2. Opening different sessions yields independent workspace and live editor-state roots without reusing a live database. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-002 AC2: separate session launches use independent workspace and editor-state roots) -->
3. The snapshot's persisted settings and workspace state contain exactly allowlisted theme and keyboard-layout values plus schema-valid Explorer/open-file resources. <!-- @impl: scripts/browser-ide-ui-state.py::capture --> <!-- @impl: scripts/browser-ide-ui-state.py::safe_setting_value --> <!-- @impl: scripts/browser-ide-ui-state.py::safe_state_value --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: captures and restores only allowlisted theme, editor, and Explorer state) --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: persists the selected keyboard layout without broad settings state) --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: excludes unknown fields and opaque strings from allowlisted state rows) -->
4. Every restored file resource resolves canonically inside `/home/user/workspace`. <!-- @impl: scripts/browser-ide-ui-state.py::restore --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: excludes allowlisted rows whose file resources escape directly or through a symlink) -->
5. Launching from the header always opens the active session rather than another running session. <!-- @impl: web-ui/src/components/Layout.tsx::handleVscodeOpen --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Browser IDE button gating (REQ-IDE-001 / REQ-IDE-003)) -->
6. Live databases, extension bytes, WAL/SHM files, workspace storage, global extension state, SecretStorage, authentication, chat history, logs, and unallowlisted User settings never enter persistent sync; only the bounded UI snapshot and bounded user-extension manifest do. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @impl: scripts/browser-ide-ui-state.py::capture --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-IDE-002 AC6: syncs only bounded Browser IDE manifests) --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: persists the selected keyboard layout without broad settings state) -->
7. A user-selected web keyboard layout follows the user through the bounded snapshot. <!-- @impl: scripts/browser-ide-ui-state.py::capture --> <!-- @impl: scripts/browser-ide-ui-state.py::restore --> <!-- @test: host/__tests__/browser-ide-ui-state.test.js (REQ-IDE-002: persists the selected keyboard layout without broad settings state) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-002 AC7 + REQ-IDE-016 AC2 + REQ-IDE-040 AC2: settings preparation preserves safe UI preferences but replaces stale managed inventory settings) -->

**Constraints:**

- The selected session remains visible in the editor location for the lifetime of the page.
- Bucket-level UI state is limited to atomic, fail-closed `~/.codeflare/ide-ui-state.json`, capped at 1 MiB with only allowlisted UI values and resources.
- Bucket-level extension state is limited to atomic, fail-closed `~/.codeflare/ide-extensions.json`, capped at 64 KiB with bounded identity/version metadata, warning acknowledgement, and contributed User-scope settings.
- Managed Codeflare, Claude, and UI-continuity settings override extension-restored preferences on every launch.
- The upstream keyboard-layout status item and picker remain visible; Codeflare persists the user's selection instead of hiding or preselecting that control.

**Priority:** P2

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-VAULT-021](vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)

**Verification:** Automated test ([Route isolation tests](../../src/__tests__/routes/vscode-validation.test.ts); [launch tests](../../host/__tests__/entrypoint-openvscode.test.js); [UI-state snapshot tests](../../host/__tests__/browser-ide-ui-state.test.js); [settings preparation tests](../../openvscode/claude/test/prepare-sidebar-config.test.mjs))

**Status:** Implemented

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
4. Pi's IDE backend lifecycle is request-lazy and persistent across normally completed panel and editor turns. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005: lazy native Pi reuses one backend after settled turns) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-005: one IDE-owned Pi session reuses only its child) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-027: a native Pi panel turn streams reasoning, bounds tool progress, and settles with its answer) -->
5. A Pi session opens Codeflare native Chat without an account-setup prompt or authorization flow. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_FALLBACK_MODEL --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_VISIBLE_MODEL --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: Dockerfile::rm -rf /opt/code-server/lib/vscode/extensions/copilot --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat) --> <!-- @manual: On the deployed integration image, open Codeflare native Chat and complete one request without account or model setup in three fresh sessions. -->
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

1. Every native Pi request receives bounded current editor content, selection, open workspace documents, diagnostics, and explicit native references; outside-workspace paths, symbolic-link aliases, and malformed references are excluded. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::collectNativePiPromptInput --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005 AC2 + REQ-IDE-006 AC1: native Pi receives bounded editor, reference, diagnostic, and chat context) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006 AC1 + REQ-IDE-041 AC1: native host collection captures one-based panel selection and rejects a symlink escape) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006 AC1: malformed native reference ranges are ignored at the host boundary) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006: queued native requests capture their editor and Chat context at invocation) -->
2. Official Claude receives active-file, selection, native diff, and diagnostics integration through Anthropic's authenticated loopback-only IDE MCP server. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareOfficialClaudeIde --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildOpenVscodeSettings --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-005 AC2 + REQ-IDE-006 AC1: official Claude launch writes isolated OpenVSCode settings) --> <!-- @manual: On the deployed integration image, attach an active file and selection, request a native diff, and confirm diagnostics reach official Claude on three fresh sessions. -->
3. The IDE Pi conversation identity comprises panel and editor Inline Chat and excludes terminal tab 1. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/session.ts::FIXED_PI_SPAWN_SPEC --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005: lazy native Pi reuses one backend after settled turns) --> <!-- @test: openvscode/agent-sidebar/test/pi-session.test.ts (REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: visible Pi resolution uses only the fixed no-session spawn contract) -->
4. Claude uses a dedicated temporary config tree and cannot attach to or resume terminal tab 1. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::SIDEBAR_LINK_ALLOWLIST --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-006 AC4: projection excludes terminal history, runtime state, and unknown entries) -->
5. Claude preparation links approved credential and configuration sources without copying their values into generated files, settings, logs, or messages. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareSidebarConfig --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-006 AC1+AC2: projection links only allowlisted configuration and never copies secret bytes) -->
6. Native Pi context that exceeds its budget is reduced by discarding whole units, keeping current editor state ahead of the replayed conversation, rather than by cutting the serialized context. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-006 AC6: an over-budget history replay keeps the newest turns and drops the oldest) --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-006 AC6: a context over the envelope drops whole sections and stays parseable) -->

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
5. After a normally completed turn, the shared backend is retained for the next IDE request. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005: lazy native Pi reuses one backend after settled turns) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-027: a native Pi panel turn streams reasoning, bounds tool progress, and settles with its answer) -->
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
2. The seeded settings ignore extension recommendations, so the editor shows no "install recommended extensions" prompt for the opened workspace. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-009 + REQ-IDE-021 + REQ-IDE-024: base settings suppress the legacy startup editor) -->
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

1. The Pi inventory suppresses Code OSS's account-backed **Code Review** setup action. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat) -->
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

<a id="req-ide-015-fixed-workspace-projection-and-clean-browser-ide-url"></a>
### REQ-IDE-015: Clean Browser IDE URL and private workspace selection

**Intent:** The Browser IDE selects the fixed session workspace privately without exposing or accepting workspace selectors in the browser URL.

**Applies To:** User

**Acceptance Criteria:**

1. Only private root navigation selects the fixed session workspace. <!-- @impl: host/src/vscode-proxy.ts::vscodeUpstreamRequestTarget --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamRequestTarget / REQ-IDE-015 (fixed clean workspace navigation)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-015 AC1+AC2: keeps the browser URL clean while selecting the fixed loopback workspace) -->
2. Non-root protocol and asset requests preserve unrelated query parameters. <!-- @impl: host/src/vscode-proxy.ts::vscodeUpstreamRequestTarget --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamRequestTarget / REQ-IDE-015 (fixed clean workspace navigation)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-015 AC1+AC2: keeps the browser URL clean while selecting the fixed loopback workspace) -->
3. Root-relative editor redirects remain under the authenticated session route. <!-- @impl: host/src/vscode-proxy.ts::rewriteVscodeLocation --> <!-- @impl: host/src/request-router.ts::rewriteVscodeResponseHeaders --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamRequestTarget / REQ-IDE-015 (fixed clean workspace navigation)) -->
4. Browser-visible redirects contain no workspace selector. <!-- @impl: host/src/vscode-proxy.ts::rewriteVscodeLocation --> <!-- @impl: host/src/request-router.ts::rewriteVscodeResponseHeaders --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamRequestTarget / REQ-IDE-015 (fixed clean workspace navigation)) -->

**Constraints:**

- Initial IDE navigation confinement is not an operating-system sandbox; terminals, trusted extensions, and agents retain their existing container filesystem access.
- The fixed container path never appears in a browser-visible redirect or required public query.

**Priority:** P1

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-012](#req-ide-012-fixed-clean-browser-ide-workspace-selection)

**Verification:** Automated host proxy tests; deployed clean-URL and selector-rejection verification on three fresh sessions

**Status:** Implemented

---

<a id="req-ide-016-ui-state-capture-and-restore-ordering"></a>
### REQ-IDE-016: Bounded IDE-state capture and restore ordering

**Intent:** Safe Browser IDE preferences and user-extension metadata move between sessions without delaying editor launch or persisting live runtime storage.

**Applies To:** User

**Acceptance Criteria:**

1. UI snapshot capture starts only after the editor generation is reaped. <!-- @impl: entrypoint.sh::_openvscode_supervise_loop --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-016 AC1: captures UI state only after the code-server generation exits) -->
2. UI restore creates fresh storage before managed settings are reapplied. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::writeOpenVscodeUserSettings --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-016 AC2: restores safe UI state before managed settings and code-server launch) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-002 AC7 + REQ-IDE-016 AC2 + REQ-IDE-040 AC2: settings preparation preserves safe UI preferences but replaces stale managed inventory settings) -->
3. User-extension restore begins from the built-in welcome extension after workbench startup and never delays code-server launch. <!-- @impl: openvscode/agent-sidebar/src/welcome-extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/welcome-extension.test.ts (REQ-IDE-016 AC3: welcome activation starts lazy extension persistence) --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC3 + REQ-IDE-037 AC1+AC3+AC4: restores exact versions, falls back once, and preserves failures) -->
4. Debounced in-session capture is backed by one post-reap registry capture, so closing during the debounce window cannot lose an install or uninstall. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence --> <!-- @impl: scripts/browser-ide-extensions.py::capture --> <!-- @impl: entrypoint.sh::_openvscode_capture_extensions --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC4: extension-host changes debounce one capture) --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-016 AC4: captures the extension registry exactly once after a generation exits) --> <!-- @test: host/__tests__/browser-ide-extensions.test.js (REQ-IDE-016 AC4 + REQ-IDE-036 AC1+AC2+AC3+AC4+AC5+AC6: captures bounded extension registry without settings loss) -->

**Constraints:**

- Capture and restore use only the two bounded manifests defined by [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable).
- Managed Codeflare, Claude, and UI-continuity settings remain authoritative after restore.
- Gallery availability never gates code-server startup.

**Priority:** P1

**Dependencies:** [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-003](#req-ide-003-ide-lifecycle-and-availability)

**Verification:** GitHub Actions runs editor lifecycle, settings preparation, manifest, welcome-bootstrap, and complete-image tests.

**Status:** Implemented

---

<a id="req-ide-017-unsupported-ide-inventory-runtime-metadata"></a>
### REQ-IDE-017: Unsupported IDE base-inventory isolation

**Intent:** Selecting an unsupported terminal agent exposes no Codeflare-managed IDE agent while still permitting the user's agent-independent extension manifest.

**Applies To:** Operator

**Acceptance Criteria:**

1. The packaged unsupported base inventory contains no extension. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyUnsupportedInventory --> <!-- @test: host/__tests__/unsupported-ide-inventory.test.js (REQ-IDE-017 AC1: unsupported inventory remains extension-free after initialization) -->
2. Any extension visible in an unsupported-agent session comes only from the writable user layer and never changes the empty packaged base inventory. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-017 AC2: seeds immutable base extensions into a writable session layer) -->

**Constraints:**

- The packaged unsupported directory remains empty; code-server registry metadata and user-extension directories live only in the writable per-session layer.
- User extensions do not become Codeflare-managed agents and remain subject to [REQ-IDE-036](#req-ide-036-persistent-user-managed-extensions).

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-010](#req-ide-010-pinned-ide-inventory-compatibility), [REQ-IDE-036](#req-ide-036-persistent-user-managed-extensions)

**Verification:** GitHub Actions validates packaged-base emptiness, writable-layer isolation, and complete-image restore/capture behavior.

**Status:** Implemented

---

### REQ-IDE-018: Native Pi Chat browser notifications

**Intent:** Pi native Chat uses the pinned Code OSS browser-notification lifecycle for completed responses and native confirmations instead of a Codeflare-owned duplicate event path.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi inventory enables Code OSS OS notifications for received responses and confirmations when the editor window is not focused. <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings --> <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-018 + REQ-IDE-019 AC6 + REQ-IDE-021 AC1 + REQ-IDE-033: Pi settings keep Inline edits in the invoking editor) --> <!-- @manual: On deployed integration, complete and confirm Pi native Chat turns with the editor unfocused and verify Code OSS notification permission, focus, and lifetime behavior. -->
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
2. From initial workbench readiness, editor Inline Chat lists **Codeflare** as a selectable default model from Codeflare's own provider without a GitHub Copilot login. <!-- @impl: openvscode/agent-sidebar/package.json::activationEvents --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_VISIBLE_MODEL --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat) --> <!-- @manual: On a fresh deployed Pi inventory, verify Codeflare is the initial selectable default and no Copilot login is offered. -->
3. Selected-code editor refactoring invokes Codeflare without a GitHub Copilot login. <!-- @impl: openvscode/agent-sidebar/package.json::chatParticipants --> <!-- @manual: On a fresh deployed Pi inventory, select code, invoke editor Inline Chat, and verify Codeflare handles the request without Copilot login. -->
4. Empty-selection editor generation invokes Codeflare without a GitHub Copilot login. <!-- @impl: openvscode/agent-sidebar/package.json::chatParticipants --> <!-- @manual: On a fresh deployed Pi inventory, invoke editor Inline Chat without a selection and verify Codeflare handles the request without Copilot login. -->
5. Codeflare requests no model authorization. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_FALLBACK_MODEL --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_VISIBLE_MODEL --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat) -->
6. Each Codeflare custom agent appears once in Code OSS's Agent selector. <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-018 + REQ-IDE-019 AC6 + REQ-IDE-021 AC1 + REQ-IDE-033: Pi settings keep Inline edits in the invoking editor) --> <!-- @manual: On a fresh deployed Pi inventory, open the Code OSS Agent selector and verify each Codeflare custom agent appears exactly once. -->

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

1. Editor requests capture the invoking host document's unsaved content, selection, diagnostics, explicit references, and bounded recent history while excluding invalid and out-of-workspace resources. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::collectNativePiPromptInput --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006 AC1 + REQ-IDE-041 AC1: native host collection captures one-based panel selection and rejects a symlink escape) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006 AC1: malformed native reference ranges are ignored at the host boundary) --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006: queued native requests capture their editor and Chat context at invocation) -->
2. An editor request invokes the local Pi runtime directly without compatibility-provider generation or panel handoff. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::runNativePiChat --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
3. A valid proposal emits native text edits for the captured document. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
4. The host emits the native edit-completion marker after those edits. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
5. The rendered native transaction offers **Keep** for the proposed edits. <!-- @manual: On fresh deployed integration, generate an Inline Chat edit and verify Keep applies the displayed proposal. -->
6. Reject or Undo restores the document through the native Inline Chat transaction. <!-- @manual: On fresh deployed integration, reject or undo an Inline Chat proposal and verify the prior document content is restored. -->

**Constraints:**

- Codeflare neither patches Code OSS nor replays already-applied filesystem changes as host edits.
- Pi never writes the target document during an editor proposal turn.

**Priority:** P1

**Dependencies:** [REQ-IDE-006](#req-ide-006-ide-conversation-context-and-credential-isolation), [REQ-IDE-019](#req-ide-019-codeflare-eligibility-in-editor-inline-chat), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation), [REQ-IDE-026](#req-ide-026-native-inline-chat-edit-validation)

**Verification:** PR-boundary review and GitHub Actions CI validate native context and host-owned edit rendering. Fresh deployed editor generation remains the controller-owned Keep/Close evidence boundary.

**Status:** Partial

---

### REQ-IDE-021: Account-free Browser IDE chrome

**Intent:** Browser IDE sessions omit Code OSS's Copilot status, Chat title-bar sign-in, and left-side Accounts chrome while retaining Codeflare Chat and independent agent credentials.

**Applies To:** User

**Acceptance Criteria:**

1. Pi sessions hide unrelated built-in AI setup. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat) --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-018 + REQ-IDE-019 AC6 + REQ-IDE-021 AC1 + REQ-IDE-033: Pi settings keep Inline edits in the invoking editor) -->
2. Pi sessions retain account-free Codeflare models. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat) -->
3. Preparation preserves existing unrelated profile values and hidden status entries. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::writeOpenVscodeProfileState --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-021: every prepared inventory preserves status entries and hides Accounts chrome) -->
4. Pi, Claude, and unsupported inventories configure the left-side Accounts control as hidden. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::writeOpenVscodeProfileState --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-021: every prepared inventory preserves status entries and hides Accounts chrome) -->
5. Pi, Claude, and unsupported inventories omit Code OSS's Chat title-bar sign-in affordance. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-009 + REQ-IDE-021 + REQ-IDE-024: base settings suppress the legacy startup editor) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-002 AC7 + REQ-IDE-016 AC2 + REQ-IDE-040 AC2: settings preparation preserves safe UI preferences but replaces stale managed inventory settings) -->

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
5. The packaged unsupported base inventory remains extension-free after initialization. <!-- @impl: entrypoint.sh::_openvscode_extensions_dir --> <!-- @test: host/__tests__/unsupported-ide-inventory.test.js (REQ-IDE-017 AC1: unsupported inventory remains extension-free after initialization) -->

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

1. Pi, Claude, and unsupported sessions open exactly one startup welcome editor: Codeflare's non-empty owned HTML. <!-- @impl: openvscode/agent-sidebar/src/welcome-extension.ts::activate --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @impl: Dockerfile::codeflare-welcome --> <!-- @test: openvscode/agent-sidebar/test/welcome-extension.test.ts (REQ-IDE-024 AC1+AC4: every inventory opens one welcome editor with its fixed primary action) --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-009 + REQ-IDE-021 + REQ-IDE-024: base settings suppress the legacy startup editor) -->
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

1. Participant requests invoke the local Pi RPC backend instead of either compatibility provider's generation path. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::NodePiProcessSpawner --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-025 AC1 + REQ-IDE-034: panel requests run Pi without Inline diagnostics or provider generation) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
2. The Browser IDE creates at most one lazy IDE-owned Pi process, separate from terminal Pi. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPackagedNativeChat --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-025: panel-first then native inline edit reuses one unrestricted IDE Pi conversation) -->
3. Panel and editor turns retain one in-memory Pi conversation. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-025: panel and native inline edit turns reuse one backend with surface-specific output) -->
4. Panel turns retain their existing unrestricted tool set and conversation context without editor permission prompts. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-approval-host.ts::VsCodeApprovalHost --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools) --> <!-- @test: openvscode/agent-sidebar/test/vscode-approval-host.test.ts (REQ-IDE-007 AC2: Pi Edit Write and Bash need no confirmation and open no editor tabs) -->
5. An editor turn exposes only `codeflare_submit_inline_result` in the active tool set and final OpenAI Chat Completions payload. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::constrainInlineOpenAiPayload --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools) -->
6. That editor command dispatches exactly one current prompt into the shared IDE Pi conversation. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools) -->
7. Editor settlement restores the exact prior panel tool set before the external RPC settlement releases the next turn. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools) -->

**Constraints:**

- The fixed local `pi --mode rpc --no-session --no-themes` process serializes all IDE turns.
- Pi 0.84.1 awaits extension settlement handlers before emitting external settlement.
- Active cancellation or backend failure follows REQ-IDE-008 process-generation ownership.

**Priority:** P1

**Dependencies:** [REQ-IDE-007](#req-ide-007-ide-guarded-approval), [REQ-IDE-008](#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-019](#req-ide-019-codeflare-eligibility-in-editor-inline-chat)

**Verification:** PR-boundary review and GitHub Actions CI validate local routing, process reuse, result-only provider payloads, exact tool restoration, and complete-image behavior.

**Status:** Partial

---

### REQ-IDE-026: Native Inline Chat edit validation

**Intent:** Only bounded edits that still match the captured invoking document can enter the host-owned native Inline Chat transaction.

**Applies To:** User

**Acceptance Criteria:**

1. An edit result contains between one and 64 edits. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditResult --> <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: empty inline edit proposals fail closed) --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: more than 64 inline edits fail closed) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-026: inline Pi rejects more than 64 proposed edits and retires the backend) -->
2. The combined replacement text is at most 256 KiB in UTF-8. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditResult --> <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: inline edit payloads above 256 KiB fail closed) -->
3. Every coordinate is a non-negative safe integer whose start does not follow its end. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditResult --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: invalid inline edit coordinates fail closed) -->
4. Accepted edits are deterministically ordered and contain neither a repeated start nor a crossing range. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditResult --> <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: adjacent non-overlapping inline edits are accepted and ordered) --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: repeated edit starts fail closed) --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: overlapping inline edits fail closed) -->
5. Every edit position lies within the captured invoking document. <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: out-of-bounds inline edits fail closed) -->
6. The invoking document version still equals its captured version when the host emits edits. <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: openvscode/agent-sidebar/test/inline-edit-validation.test.ts (REQ-IDE-026: stale document versions fail closed) -->

**Notes:** Automated edit-validation coverage is complete; fresh integration verification is required before promotion to Implemented.

**Constraints:**

- Any validation failure prevents host edit emission; envelope validation belongs to [REQ-IDE-030](#req-ide-030-native-inline-chat-result-envelope).
- Dispatch-error isolation belongs to [REQ-IDE-028](#req-ide-028-native-inline-chat-dispatch-error-isolation).

**Priority:** P1

**Dependencies:** [REQ-IDE-008](#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation), [REQ-IDE-030](#req-ide-030-native-inline-chat-result-envelope)

**Verification:** PR-boundary review and GitHub Actions CI validate edit count, byte size, geometry, document bounds, and version freshness. Fresh deployment verifies rendered native transaction behavior under REQ-IDE-020.

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
- Editor Inline Chat remains a host-owned edit transaction and does not render final-answer markdown.
- code-server and Code OSS source remain unmodified.

**Priority:** P2

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation)

**Verification:** GitHub Actions validates reasoning forwarding and bounded activity reporting. Fresh integration verifies the native thinking presentation during a long panel turn.

**Status:** Partial

---

### REQ-IDE-028: Native Inline Chat dispatch-error isolation

**Intent:** An editor request fails closed when its nested Pi dispatch fails without allowing unrelated extension errors to discard a valid result.

**Applies To:** User

**Acceptance Criteria:**

1. An error attributed to the active editor command rejects that editor request. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: inline command extension errors reject immediately and retire the backend) -->
2. A later panel or editor request is not blocked by that command-failed request. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: inline command extension errors reject immediately and retire the backend) --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: protocol or process failure retires the backend before replacement) -->
3. An asynchronous failure starting the editor turn after command acceptance rejects that editor request. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: asynchronous inline dispatch errors reject after command acceptance and retire the backend) -->
4. A later panel or editor request is not blocked by that asynchronously failed request. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: asynchronous inline dispatch errors reject after command acceptance and retire the backend) --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-008: protocol or process failure retires the backend before replacement) -->
5. An unrelated extension error does not prevent a valid editor request from returning its result. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: unrelated extension errors do not discard a valid inline result) -->

**Constraints:**

- Runtime dispatch errors are owned only while an editor turn is active.
- No timeout, third process, Code OSS patch, or direct-write replay is introduced.

**Priority:** P1

**Dependencies:** [REQ-IDE-008](#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation)

**Verification:** GitHub Actions validates both Pi 0.84.1 dispatch-error envelopes and unrelated-error isolation. Fresh integration verifies that an editor request either renders host-owned edits or rejects without an indefinite wait.

**Status:** Partial

---

### REQ-IDE-029: Native Inline Chat feedback

**Intent:** A user can follow an editor request while the host retains bounded context about the completed result.

**Applies To:** User

**Acceptance Criteria:**

1. An accepted editor request immediately shows no more than two progress updates while native Inline Chat is active. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
2. Every completed Inline result carries one bounded what-and-why summary in result details. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-029 + REQ-IDE-030: an Inline no-change result explains itself without an editor transaction) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
3. An edit result reports its edit count in result details. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
4. A no-change result renders its bounded summary. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-029 + REQ-IDE-030: an Inline no-change result explains itself without an editor transaction) -->
5. A no-change result invokes no native text-edit method. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-029 + REQ-IDE-030: an Inline no-change result explains itself without an editor transaction) -->
6. Unstructured final-answer markdown remains hidden from the transactional editor response. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-029 + REQ-IDE-030: inline Pi returns one host-correlated edit result without markdown) -->

**Constraints:**

- Feedback is a concise authored explanation, never raw chain-of-thought.
- A response without pending confirmation is excluded from the pinned Inline view; result-detail visibility is secondary and not durable.
- Review lifecycle ownership belongs to [REQ-IDE-033](#req-ide-033-controller-owned-inline-review-lifecycle).
- code-server and Code OSS source remain unmodified.

**Priority:** P2

**Dependencies:** [REQ-IDE-020](#req-ide-020-native-pi-editor-proposal-execution), [REQ-IDE-026](#req-ide-026-native-inline-chat-edit-validation), [REQ-IDE-030](#req-ide-030-native-inline-chat-result-envelope), [REQ-IDE-033](#req-ide-033-controller-owned-inline-review-lifecycle)

**Verification:** GitHub Actions validates immediate bounded progress, hidden final markdown, bounded result explanations, no-change rendering, and edit-count details. Fresh integration verifies both no-change feedback and the controller-owned review journey under REQ-IDE-033.

**Status:** Partial

---

### REQ-IDE-030: Native Inline Chat result envelope

**Intent:** Only one host-correlated edit or no-change result with a bounded explanation can cross from Pi into an editor response.

**Applies To:** User

**Acceptance Criteria:**

1. Exactly one result is bound to the host-owned active process generation and editor turn. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditResult --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-030: inline results use host correlation and reject duplicates) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-029 + REQ-IDE-030: inline Pi returns one host-correlated edit result without markdown) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-030: a late result cannot settle a retired process generation) -->
2. The model receives no host request ID during an Inline turn. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools) -->
3. The flat result outcome is either an edit with one to 64 edits or a no-change explanation with zero edits. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditResult --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-030: inline Pi returns a host-correlated no-change result) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-030: inline result outcome and edit cardinality must agree) -->
4. Every accepted result includes one trimmed, single-line explanation of at most 500 characters. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditResult --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-030: inline result summaries are bounded plain text and fail closed) -->
5. After an invalid raw result, Pi may submit another attempt within the same turn, up to three total attempts; the first valid result is accepted. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-030: inline Pi accepts a valid retry after one invalid raw result) -->
6. Settlement without a valid result reports outcome, summary, edit-count, or geometry failure without result content. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditResult --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-030: invalid-only settlement reports a bounded result category) -->
7. A second valid result applies no additional editor changes. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-030: inline Pi rejects a duplicate result and retires the backend) -->

**Constraints:**

- Result fields cannot name another URI, choose another tool, or request direct filesystem mutation.
- Unknown provider payload shapes are not rewritten speculatively.
- Any envelope failure prevents host edit emission.

**Priority:** P1

**Dependencies:** [REQ-IDE-008](#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation)

**Verification:** PR-boundary review and GitHub Actions CI validate result cardinality, host-owned correlation, explanation bounds, bounded correction, categorized settlement, no-change behavior, and duplicate rejection.

**Status:** Partial

---

### REQ-IDE-033: Controller-owned Inline review lifecycle

**Intent:** Editor Inline Chat uses the invoking host document and leaves review settlement entirely to the pinned Inline controller.

**Applies To:** User

**Acceptance Criteria:**

1. An editor request derives document content, selection, edit target, and version from the host-supplied editor location captured for that request. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::parseInlineEditorLocation --> <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::collectNativePiPromptInput --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
2. Missing, malformed, closed, non-file, or out-of-workspace editor location data starts no Pi turn and emits no edits. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::parseInlineEditorLocation --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-033: missing or malformed host editor location fails before Pi or edit emission) -->
3. A valid editor turn emits one empty start marker, one non-empty text-edit batch, and one completion marker for the invoking URI. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
4. Codeflare emits no review confirmation, notification action, Chat Editing command, or document reopen request. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
5. The managed Pi profile disables the host configuration-gated automatic opening of chat-edited files. <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-018 + REQ-IDE-019 AC6 + REQ-IDE-021 AC1 + REQ-IDE-033: Pi settings keep Inline edits in the invoking editor) -->
6. Native Keep accepts the current Inline session, while native Close rejects it and disposes controller-owned state. <!-- @manual: On fresh integration, apply an Inline proposal with Keep, reject another with Close, and verify both sessions settle in the invoking editor. -->
7. A new Inline request reaches Codeflare immediately after both Keep and Close without a document-URI error or duplicate editor. <!-- @manual: On fresh integration, submit a second Inline request after each outcome and verify one editor group/tab remains. -->

**Constraints:**

- Codeflare never falls back to whichever editor is active when the participant runs.
- Codeflare does not patch code-server or Code OSS.
- Panel turns retain unrestricted tools and the shared IDE Pi conversation.

**Priority:** P1

**Dependencies:** [REQ-IDE-020](#req-ide-020-native-pi-editor-proposal-execution), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation), [REQ-IDE-026](#req-ide-026-native-inline-chat-edit-validation), [REQ-IDE-030](#req-ide-030-native-inline-chat-result-envelope)

**Verification:** GitHub Actions validates exact host-document binding, start/edit/done ordering, the configuration-gated edited-file opener disabled in Pi, and absence of extension-owned review side effects. Fresh integration owns Keep, Close, immediate second-request, single-editor, and URI-lifecycle evidence.

**Status:** Partial

---

### REQ-IDE-034: Bounded Inline lifecycle diagnostics

**Intent:** An operator can distinguish stale rollout, wrong invocation surface, and edit/session URI mismatch from one failed Inline request.

**Applies To:** Operator

**Acceptance Criteria:**

1. Pi activation records one diagnostic revision and the effective edited-file-opening and built-in-AI settings. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::createInlineDiagnostics --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat) -->
2. Each admitted editor request records its editor location, sanitized invoking-resource identity, version, and selection without recording document content. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::createInlineDiagnostics --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
3. The active request records tab-change events plus immediate, three-second, and eight-second snapshots. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::createInlineDiagnostics --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-034 AC3: delayed Inline diagnostics record three-second and eight-second snapshots) -->
4. Diagnostics remain in the local Output channel and exclude panel turns. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::createInlineDiagnostics --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-025 AC1 + REQ-IDE-034: panel requests run Pi without Inline diagnostics or provider generation) -->
5. One request records at most 16 tab events, and one diagnostic message contains at most 12,000 characters before its truncation marker. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::createInlineDiagnostics --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-034 AC5: Inline diagnostics cap tab events and line length) -->
6. Resource identity retains scheme, authority without userinfo, basename, and stable input type while excluding directory paths, query, fragment, tab labels, and document content. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::describeUri --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::describeTab --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->
7. Extension deactivation cancels delayed diagnostic writes, removes the tab listener, and disposes the Output channel. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::createInlineDiagnostics --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::deactivate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-034 AC7: deactivation cancels delayed diagnostics and the tab listener) -->

**Constraints:**

- Diagnostics do not alter edit, review, navigation, or Pi lifecycle behavior.
- Sanitized diagnostic identity remains local to the Browser IDE session unless the user copies it.

**Priority:** P1

**Dependencies:** [REQ-IDE-033](#req-ide-033-controller-owned-inline-review-lifecycle)

**Verification:** GitHub Actions validates activation settings, request identity, delayed snapshots, caps, sanitization, isolation, and disposal. Fresh integration uses the Output channel to classify the deployed failure before another lifecycle change.

**Status:** Implemented

---

### REQ-IDE-035: Canonical Browser IDE workspace projection

**Intent:** Clean root navigation materializes the fixed workspace under one remote URI identity without exposing the container path publicly.

**Applies To:** User

**Acceptance Criteria:**

1. Clean root navigation opens the fixed session workspace. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyCodeServerWorkspaceProjection --> <!-- @test: host/__tests__/openvscode-proxy.test.js (projectVscodeWorkbenchWorkspace / REQ-IDE-035 AC1+AC2+AC3+AC4 (canonical fixed workbench configuration)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-035 AC1+AC2+AC3+AC4: root workbench configuration projection) -->
2. The projected folder URI uses the canonical public browser authority rather than code-server's server-side placeholder. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyCodeServerWorkspaceProjection --> <!-- @test: host/__tests__/openvscode-proxy.test.js (projectVscodeWorkbenchWorkspace / REQ-IDE-035 AC1+AC2+AC3+AC4 (canonical fixed workbench configuration)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-035 AC1+AC2+AC3+AC4: root workbench configuration projection) -->
3. Unsafe fixed-workspace initialization fails closed instead of opening an empty window. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/openvscode-proxy.test.js (projectVscodeWorkbenchWorkspace / REQ-IDE-035 AC1+AC2+AC3+AC4 (canonical fixed workbench configuration)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-035 AC1+AC2+AC3+AC4: root workbench configuration projection) -->
4. Workspace projection leaves every server-provided IDE setting other than the selected folder unchanged. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace --> <!-- @test: host/__tests__/openvscode-proxy.test.js (projectVscodeWorkbenchWorkspace / REQ-IDE-035 AC1+AC2+AC3+AC4 (canonical fixed workbench configuration)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-035 AC1+AC2+AC3+AC4: root workbench configuration projection) -->

**Notes:** Version-pinned incompatibility conditions are owned by the [container documentation](../../documentation/lanes/container.md#code-server-browser-ide).

**Constraints:**

- The projected authority comes from the authenticated host's canonical external identity.
- code-server and embedded Code OSS remain unpatched.

**Priority:** P1

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-012](#req-ide-012-fixed-clean-browser-ide-workspace-selection), [REQ-IDE-015](#req-ide-015-clean-browser-ide-url-and-private-workspace-selection)

**Verification:** Automated host proxy tests and complete-image smoke; deployed one-tab Inline review confirms renderer and extension-host URI convergence.

**Status:** Implemented

---

### REQ-IDE-036: Persistent user-managed extensions

**Intent:** A user's bounded Open VSX extension selection and contributed User settings survive container replacement while launch remains lazy and packaged agent inventories remain immutable.

**Applies To:** User

**Acceptance Criteria:**

1. Persisted extension records remain inside the documented identity, count, type, and version bounds. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::loadExtensionManifest --> <!-- @impl: scripts/browser-ide-extensions.py::_validate_manifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-036 AC1+AC2+AC3: malformed manifests fail closed and valid manifests round-trip atomically) --> <!-- @test: host/__tests__/browser-ide-extensions.test.js (REQ-IDE-016 AC4 + REQ-IDE-036 AC1+AC2+AC3+AC4+AC5+AC6: captures bounded extension registry without settings loss) -->
2. Persisted contributed User settings remain inside the documented key, value, type, and size bounds. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::loadExtensionManifest --> <!-- @impl: scripts/browser-ide-extensions.py::_validate_manifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-036 AC1+AC2+AC3: malformed manifests fail closed and valid manifests round-trip atomically) --> <!-- @test: host/__tests__/browser-ide-extensions.test.js (REQ-IDE-016 AC4 + REQ-IDE-036 AC1+AC2+AC3+AC4+AC5+AC6: captures bounded extension registry without settings loss) -->
3. Malformed, oversized, redirected, noncanonical, or unknown persisted content remains byte-for-byte unchanged and is ignored. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::loadExtensionManifest --> <!-- @impl: scripts/browser-ide-extensions.py::_validate_manifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-036 AC1+AC2+AC3: malformed manifests fail closed and valid manifests round-trip atomically) --> <!-- @test: host/__tests__/browser-ide-extensions.test.js (REQ-IDE-036 AC3: malformed or unsafe manifests stay byte-for-byte unchanged) --> <!-- @test: host/__tests__/browser-ide-extensions.test.js (REQ-IDE-016 AC4 + REQ-IDE-036 AC1+AC2+AC3+AC4+AC5+AC6: captures bounded extension registry without settings loss) -->
4. Capture records canonical non-fixed extension identities with their observed versions and platforms. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @impl: scripts/browser-ide-extensions.py::capture --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC4 + REQ-IDE-036 AC4+AC5+AC6 + REQ-IDE-038 AC5: capture preserves intent, settings, and uninstall evidence) --> <!-- @test: host/__tests__/browser-ide-extensions.test.js (REQ-IDE-016 AC4 + REQ-IDE-036 AC1+AC2+AC3+AC4+AC5+AC6: captures bounded extension registry without settings loss) -->
5. Final capture preserves bounded contributed settings recorded by the live editor, including a pending setting-only change at extension deactivation. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence --> <!-- @impl: openvscode/agent-sidebar/src/welcome-extension.ts::deactivate --> <!-- @impl: scripts/browser-ide-extensions.py::capture --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC4 + REQ-IDE-036 AC4+AC5+AC6 + REQ-IDE-038 AC5: capture preserves intent, settings, and uninstall evidence) --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-036 AC5: setting-only changes flush during deactivation and restore) --> <!-- @test: openvscode/agent-sidebar/test/welcome-extension.test.ts (REQ-IDE-036 AC5: welcome deactivation flushes extension persistence) --> <!-- @test: host/__tests__/browser-ide-extensions.test.js (REQ-IDE-016 AC4 + REQ-IDE-036 AC1+AC2+AC3+AC4+AC5+AC6: captures bounded extension registry without settings loss) -->
6. Capture removes persisted intent after explicit uninstall evidence even while a stale registry row remains. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @impl: scripts/browser-ide-extensions.py::capture --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC4 + REQ-IDE-036 AC4+AC5+AC6 + REQ-IDE-038 AC5: capture preserves intent, settings, and uninstall evidence) --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-036 AC6: obsolete evidence removes a stale registry entry without platform metadata) --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-036 AC6 + REQ-IDE-038 AC1: obsolete evidence bypasses warning preflight and removes stale intent) --> <!-- @test: host/__tests__/browser-ide-extensions.test.js (REQ-IDE-016 AC4 + REQ-IDE-036 AC1+AC2+AC3+AC4+AC5+AC6: captures bounded extension registry without settings loss) -->

**Constraints:**

- User extensions execute arbitrary root-capable container code; code-server admits proposed APIs broadly.
- Open VSX is the sole gallery; Microsoft Marketplace and private or user-configured galleries are unsupported.
- code-server disables VSIX signatures; TLS to Open VSX is the transport boundary because install does not expose artifact bytes.
- The mode-0600 version-1 regular manifest is bounded to 64 KiB, 50 lowercase IDs, and 32 KiB of settings.
- Records require `version`; optional platform, UTC RFC3339 timestamp, and lowercase hexadecimal SHA-256 fields are bounded; unknown fields are invalid.
- Capture excludes fixed IDs, uses the disk registry plus bounded `.obsolete` markers as truth, and writes atomically.
- Managed `extensions.allowed` retains wildcard allowance plus one explicit Codeflare entry.
- Package bytes, enablement, keybindings, snippets, extension storage, SecretStorage, Accounts, policy UI, and extra coordination are excluded.
- Whole-file newest-wins convergence follows the existing R2 bisync contract.

**Priority:** P1

**Dependencies:** [REQ-IDE-002](#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-010](#req-ide-010-pinned-ide-inventory-compatibility), [REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)

**Verification:** GitHub Actions runs manifest unit tests, real shell/rclone behavior, welcome-bootstrap tests, and complete-image smoke. The image smoke exercises base/user layer composition, packaged bootstrap activation, install/uninstall capture, settings preservation, and base-inventory immutability. No local, browser-automation, Chromium, or manual test gate exists.

**Status:** Implemented

---

### REQ-IDE-037: Lazy extension restoration

**Intent:** Persisted user-extension intent restores after workbench startup without losing contributed settings or failed intent.

**Applies To:** User

**Acceptance Criteria:**

1. Restoration attempts each persisted extension version before any fallback. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC3 + REQ-IDE-037 AC1+AC3+AC4: restores exact versions, falls back once, and preserves failures) -->
2. Restoration limits simultaneous gallery installations to two. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-037 AC2: restores at most two missing extensions concurrently) -->
3. Only confirmed unavailability of the persisted version permits one gallery-selected fallback. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC3 + REQ-IDE-037 AC1+AC3+AC4: restores exact versions, falls back once, and preserves failures) -->
4. A failed restore leaves its persisted intent unchanged while remaining restoration work continues. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC3 + REQ-IDE-037 AC1+AC3+AC4: restores exact versions, falls back once, and preserves failures) -->
5. Contributed global settings restore only after their extensions have registered configuration keys. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-037 AC5: contributed settings restore after their missing extension registers) -->

**Constraints:**

- Restoration runs only from the built-in welcome extension after `onStartupFinished`; gallery latency never delays code-server readiness.
- Restore performs no retry loop beyond the single fallback in AC3.
- code-server alone resolves target platforms.

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-016](#req-ide-016-bounded-ide-state-capture-and-restore-ordering), [REQ-IDE-036](#req-ide-036-persistent-user-managed-extensions)

**Verification:** GitHub Actions runs exact-version/fallback, concurrency, failure-preservation, settings-ordering, welcome-activation, and complete-image tests without local, browser-automation, Chromium, or manual gates.

**Status:** Implemented

---

### REQ-IDE-038: Extension warning acknowledgement

**Intent:** Persisted user-extension intent is never written, and unacknowledged restored extension code never executes, before the user accepts its root-capable security boundary; that acknowledgement is not repeatedly requested.

**Applies To:** User

**Acceptance Criteria:**

1. The first capture that would persist a user extension requires an accepted warning before writing that identity. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @impl: scripts/browser-ide-extensions.py::capture --> <!-- @test: host/__tests__/browser-ide-extensions.test.js (REQ-IDE-038 AC1: an absent manifest awaits security acknowledgement) --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-038 AC1+AC4: capture warns once before the first persisted user extension) --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-038 AC1: declining a scheduled warning does not prompt again during capture) --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-036 AC6 + REQ-IDE-038 AC1: obsolete evidence bypasses warning preflight and removes stale intent) -->
2. Persisted user-extension code cannot execute until the user accepts the root-capable-code warning. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-038 AC2+AC3: restore warns before execution and never repeats an accepted warning) -->
3. A later restore does not repeat an accepted warning. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-038 AC2+AC3: restore warns before execution and never repeats an accepted warning) -->
4. A later capture does not repeat an accepted warning. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-038 AC1+AC4: capture warns once before the first persisted user extension) -->
5. Removing the final persisted extension does not clear the accepted warning. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC4 + REQ-IDE-036 AC4+AC5+AC6 + REQ-IDE-038 AC5: capture preserves intent, settings, and uninstall evidence) -->
6. A fresh activation does not repeat an accepted warning. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-038 AC6: fresh activations do not repeat an acknowledged warning) -->

**Constraints:**

- The durable `securityWarningShown` field records acknowledgement but grants no additional extension capability.
- Declining or failing the warning preserves the manifest unchanged and executes no restored user extension.
- The warning states that extensions execute root-capable code and that contributed global settings are synchronized.

**Priority:** P1

**Dependencies:** [REQ-IDE-036](#req-ide-036-persistent-user-managed-extensions)

**Verification:** GitHub Actions runs first-capture, pre-restore, non-repetition, reap-backstop, and complete-image tests without local, browser-automation, Chromium, or manual gates.

**Status:** Implemented

---

### REQ-IDE-039: Codeflare Browser IDE branding

**Intent:** The Browser IDE consistently identifies its product and owned agent surfaces as Codeflare through supported host and packaged-extension seams.

**Applies To:** User

**Acceptance Criteria:**

1. Browser IDE product-name surfaces identify the editor as Codeflare. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-039 AC1: code-server uses the Codeflare app name) -->
2. The Pi Chat participant uses the Codeflare brand icon. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-039 AC2: native Pi registers the Codeflare brand icon) -->
3. The welcome panel uses the Codeflare brand icon. <!-- @impl: openvscode/agent-sidebar/src/welcome-extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/welcome-extension.test.ts (REQ-IDE-039 AC3: welcome panel uses the Codeflare brand icon) -->
4. The packaged Browser IDE brand icon matches the established product icon. <!-- @impl: Dockerfile::COPY openvscode/agent-sidebar/media/ --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-039 AC4: packaged brand icon matches the product icon) -->

**Constraints:**

- Branding uses existing code-server options and packaged extension media without patching Code OSS.

**Priority:** P2

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-024](#req-ide-024-codeflare-browser-ide-welcome)

**Verification:** Automated launch, complete-image product-metadata, activation, welcome-extension, and package tests.

**Status:** Implemented

---

### REQ-IDE-040: User-extension allowance policy

**Intent:** Every Browser IDE inventory prepares and reapplies one managed User-setting allowance for user extensions.

**Applies To:** User

**Acceptance Criteria:**

1. Every Browser IDE inventory receives the managed wildcard user-extension allowance. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-040 AC1: every inventory applies the managed user-extension allowance) -->
2. Profile preparation replaces a stale user value with that managed allowance. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-002 AC7 + REQ-IDE-016 AC2 + REQ-IDE-040 AC2: settings preparation preserves safe UI preferences but replaces stale managed inventory settings) -->

**Constraints:** `extensions.allowed` retains wildcard allowance plus one explicit Codeflare entry; fresh installs and lazy restoration share that prepared profile, while Codeflare does not own or bypass a stricter code-server operator policy.

**Priority:** P1

**Dependencies:** [REQ-IDE-009](#req-ide-009-frictionless-workspace-open-for-every-ide-agent), [REQ-IDE-036](#req-ide-036-persistent-user-managed-extensions), [REQ-IDE-037](#req-ide-037-lazy-extension-restoration)

**Verification:** Automated managed-settings and profile-preparation tests.

**Status:** Implemented

---

### REQ-IDE-041: Native Chat coordinate representation

**Intent:** Pi receives editor positions in the coordinate system consumed by each native Chat surface.

**Applies To:** User

**Acceptance Criteria:**

1. Panel Chat exposes the invoking selection to Pi as one-based human-readable positions. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::snapshotActiveEditor --> <!-- @test: openvscode/agent-sidebar/test/vscode-native-chat.test.ts (REQ-IDE-006 AC1 + REQ-IDE-041 AC1: native host collection captures one-based panel selection and rejects a symlink escape) -->
2. Editor Inline Chat exposes the invoking selection and whole range to Pi in the same zero-based UTF-16 coordinate system required by edit proposals. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::snapshotActiveEditor --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->

**Constraints:** Coordinate representation differs only at the surface boundary; edit-envelope and document-range validation remain owned by [REQ-IDE-026](#req-ide-026-native-inline-chat-edit-validation).

**Priority:** P1

**Dependencies:** [REQ-IDE-005](#req-ide-005-selected-native-ide-agent), [REQ-IDE-006](#req-ide-006-ide-conversation-context-and-credential-isolation), [REQ-IDE-026](#req-ide-026-native-inline-chat-edit-validation)

**Verification:** Automated native panel and editor Inline Chat tests verify each coordinate basis; fresh integration verification confirms the selected-text edit transaction.

**Status:** Partial

---

### REQ-IDE-042: Additive company extension reconciliation

**Intent:** Company extension requirements coexist with personal extension installation and persistence.

**Applies To:** User

**Acceptance Criteria:**

1. Restored company requirements apply only when their release identity matches the Worker-applied release. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::loadManagedExtensions --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-042 AC1: a company manifest from another release is rejected before download) -->
2. Managed settings retain personal allowance while adding company identities. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-042 AC2: company extension identities extend the personal allowance map) -->
3. Personal exact-version restoration remains active after company reconciliation. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-045 AC1 + REQ-IDE-042 AC3+AC4: company reconciliation precedes personal restore and capture) -->
4. TypeScript capture remains active after company reconciliation. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-042 AC4+AC6: live capture excludes company-only installs from personal intent) -->
5. Generation-reap capture remains active after company reconciliation. <!-- @impl: scripts/browser-ide-extensions.py::capture --> <!-- @test: host/__tests__/browser-ide-extensions.test.js (REQ-IDE-042 AC5: generation-reap capture preserves prior intent but never creates it solely from company installs) -->
6. Company-only installations never become personal saved intent. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @impl: scripts/browser-ide-extensions.py::capture --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-042 AC4+AC6: live capture excludes company-only installs from personal intent) -->
7. Personal intent for an extension removed from the company manifest is restored only after its company uninstall succeeds. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::reconcileCompanyExtensions --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-042 AC7: removed company extensions are uninstalled before personal intent is restored) --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-042 AC7: failed company removal blocks personal restoration until retry succeeds) -->

**Constraints:**

- Company extension bytes remain session-local and never enter R2.
- The first release pins `cherryMarkdownPublisher.cherry-markdown@0.3.1081718`.
- Existing fixed Pi and Claude inventories remain immutable.

**Priority:** P1

**Dependencies:** [REQ-IDE-036](#req-ide-036-persistent-user-managed-extensions), [REQ-IDE-037](#req-ide-037-lazy-extension-restoration), [REQ-IDE-040](#req-ide-040-user-extension-allowance-policy), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases), [REQ-STOR-020](storage.md#req-stor-020-managed-environment-reconciliation), [REQ-STOR-024](storage.md#req-stor-024-managed-release-application)

**Verification:** Automated managed-settings, restore, capture, removal, and disable tests

**Status:** Implemented

---

### REQ-IDE-043: Native Pi provider history isolation

**Intent:** Each native Pi surface receives only the conversation history required for its current turn.

**Applies To:** User

**Acceptance Criteria:**

1. A cold or replacement panel turn receives bounded visible history from the requesting Chat surface. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-006: replacement Pi hydrates from the requesting Chat surface history) -->
2. A warm panel turn omits visible history already retained by the shared Pi conversation. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-006: warm turns omit visible history already held by the shared Pi conversation) -->
3. An Inline provider request excludes stored panel history. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-025: a cold Inline turn omits panel history from its embedded editor context) -->
4. An Inline provider request retains its complete current-turn suffix. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools) -->

**Constraints:** Provider-history filtering does not mutate the stored shared Pi conversation or import terminal Pi history.

**Priority:** P1

**Dependencies:** [REQ-IDE-006](#req-ide-006-ide-conversation-context-and-credential-isolation), [REQ-IDE-025](#req-ide-025-shared-ide-pi-surface-isolation)

**Verification:** GitHub Actions validates cold replacement hydration, warm replay omission, and Inline current-turn isolation. Fresh integration verifies immediate Panel Chat recovery after an Inline result.

**Status:** Partial

---

### REQ-IDE-044: Exact company VSIX verification

**Intent:** Every required company extension installs only from the exact release-approved package bytes.

**Applies To:** User

**Acceptance Criteria:**

1. The IDE accepts only the signed exact Open VSX download URL. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::loadManagedExtensions --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-044 AC1: unsigned company download URLs are rejected before download) -->
2. Acquisition follows only the fixed release-approved redirect policy. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::validateCompanyRedirect --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-044 AC2+AC4+AC5 + REQ-IDE-046 AC3: invalid bytes install nothing and clean every temporary directory) -->
3. Every company extension record carries an exact semantic version. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::loadManagedExtensions --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-044 AC3: non-semantic company versions are rejected before download) -->
4. Downloaded bytes match the signed declared size. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::downloadCompanyExtension --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-044 AC2+AC4+AC5 + REQ-IDE-046 AC3: invalid bytes install nothing and clean every temporary directory) -->
5. Downloaded bytes match the signed digest. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::downloadCompanyExtension --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-044 AC2+AC4+AC5 + REQ-IDE-046 AC3: invalid bytes install nothing and clean every temporary directory) -->
6. Signed package identity and dependency closure come from the verified release record. <!-- @impl: scripts/agent-seed-release.mjs::measureExtensionRecord --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::loadManagedExtensions --> <!-- @test: host/__tests__/agent-seed-release.test.js (REQ-AGENT-147 AC5: measures exact extension identity and bytes) --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-044 AC6 + REQ-IDE-045 AC3: exact dependencies install without gallery fallback) -->
7. A matching registry identity is reinstalled from verified bytes rather than trusted as sufficient evidence. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::reconcileCompanyExtensions --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-044 AC7: a matching registry identity is reinstalled from exact signed bytes) -->

**Constraints:** Invalid packages install nothing.

**Priority:** P1

**Dependencies:** [REQ-IDE-042](#req-ide-042-additive-company-extension-reconciliation), [REQ-AGENT-147](agents.md#req-agent-147-signed-managed-agent-configuration-releases)

**Verification:** Automated exact-package acquisition and verification tests

**Status:** Implemented

---

### REQ-IDE-045: Company extension reconciliation orchestration

**Intent:** Company reconciliation remains lazy, bounded, and isolated from IDE readiness.

**Applies To:** User

**Acceptance Criteria:**

1. After workbench readiness, company reconciliation precedes personal restore. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-045 AC1 + REQ-IDE-042 AC3+AC4: company reconciliation precedes personal restore and capture) -->
2. Company reconciliation does not delay initial IDE readiness. <!-- @impl: openvscode/agent-sidebar/src/welcome-extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/welcome-extension.test.ts (REQ-IDE-042 AC2 + REQ-IDE-045 AC2: company reconciliation stays lazy and cannot delay the ready workbench) -->
3. Company reconciliation never falls back to a gallery identity or latest version. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::reconcileCompanyExtensions --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-044 AC6 + REQ-IDE-045 AC3: exact dependencies install without gallery fallback) -->
4. Company extension installation uses fixed bounded concurrency. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::reconcileCompanyExtensions --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-045 AC4+AC5: company failures remain bounded and do not block the workbench) -->
5. One company extension failure reports one bounded warning while the IDE and remaining installations continue. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::reconcileCompanyExtensions --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-045 AC4+AC5: company failures remain bounded and do not block the workbench) -->

**Constraints:** Reconciliation starts only after workbench readiness.

**Priority:** P1

**Dependencies:** [REQ-IDE-042](#req-ide-042-additive-company-extension-reconciliation), [REQ-IDE-044](#req-ide-044-exact-company-vsix-verification)

**Verification:** Automated readiness, fallback, concurrency, and failure-isolation tests

**Status:** Implemented

---

### REQ-IDE-046: Session-local company VSIX installation

**Intent:** Verified company package bytes remain temporary installation inputs rather than durable user state.

**Applies To:** User

**Acceptance Criteria:**

1. Company installation uses a temporary local VSIX with synchronization disabled. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::installCompanyExtension --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-046 AC1+AC2: exact company VSIX installs from a deleted temporary file) -->
2. Successful installation removes the temporary package bytes. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::installCompanyExtension --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-046 AC1+AC2: exact company VSIX installs from a deleted temporary file) -->
3. Failed installation removes the temporary package bytes. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::installCompanyExtension --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-046 AC3: failed company installation removes the temporary VSIX) -->

**Constraints:** Package bytes never enter user R2 or persisted extension intent.

**Priority:** P1

**Dependencies:** [REQ-IDE-044](#req-ide-044-exact-company-vsix-verification)

**Verification:** Automated temporary-package installation tests

**Status:** Implemented

---

### REQ-IDE-047: Bash-first Browser IDE terminals

**Intent:** A newly opened Browser IDE terminal starts as a plain Bash shell while the session's configured agent remains available as an explicit terminal profile.

**Applies To:** User

**Acceptance Criteria:**

1. Every Browser IDE inventory sets the Linux integrated-terminal default profile to `Bash`. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-047: Browser IDE terminals default to Bash and keep the session agent selectable) -->
2. The `Bash` profile launches `/bin/bash` as a login shell with `MANUAL_TAB=1`, so the existing shell initialization bypasses tab-1 agent autostart. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-047: Browser IDE terminals default to Bash and keep the session agent selectable) -->
3. A separate `Session Agent` profile launches the same login shell without `MANUAL_TAB`, preserving the existing tab-1 agent command as an explicit choice. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-047: Browser IDE terminals default to Bash and keep the session agent selectable) -->
4. Both terminal settings are managed for Pi, Claude, and unsupported IDE inventories so restored user settings cannot silently retain the former default. <!-- @impl: openvscode/claude/managed-settings.mjs::MANAGED_OPENVSCODE_SETTING_KEYS --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-047: Browser IDE terminals default to Bash and keep the session agent selectable) -->

**Constraints:** The terminal profiles reuse the existing login-shell and `MANUAL_TAB` contract; they do not add another launcher, shell script, or agent process.

**Priority:** P1

**Dependencies:** [REQ-TERM-005](terminal.md#req-term-005-tab-1-auto-starts-the-configured-agent)

**Verification:** Automated managed-settings contract test

**Status:** Implemented

---
