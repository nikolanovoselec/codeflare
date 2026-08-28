# Terminal

PTY management, immutable classic or Herdr terminal ownership, WebSocket transport, MultiView workspaces, and browser terminal boundaries.

**Domain owner:** Frontend (SolidJS + xterm.js) + Container (terminal server)

### Key Concepts

- **PTY** -- Pseudo-terminal; the OS-level device that bridges a shell process to terminal I/O over the WebSocket.
- **WebSocket** -- The bidirectional transport carrying raw terminal data and JSON control messages between browser and container.
- **Terminal Mode** -- The immutable `classic` or `herdr` ownership choice stamped when a session is created; missing or invalid historical values resolve to `classic`.
- **Terminal Surface** -- One xterm.js and outer PTY. Classic sessions expose terminal IDs `1` through `6`; Herdr sessions expose only terminal ID `1`.
- **Herdr Runtime** -- The named, container-local terminal multiplexer that owns tabs, panes, splits, workspaces, shells, and agents inside an opt-in Herdr session.
- **MultiView** -- A virtual frontend workspace that displays one active surface from each of multiple existing backend sessions without creating another backend session.

### Out of Scope

- Terminal recording and playback (session replay)
- Collaborative terminal sharing (multi-user viewing or input on the same PTY)
- Saved terminal command presets / header "bookmarks" (feature removed; see [changes.md](changes.md))
- Running Codeflare and Herdr topology controls simultaneously inside one session

### Domain Dependencies

- **Session Lifecycle** (container must be running) -- Terminal connections require an active, running container.
- **Authentication** (WebSocket auth) -- WebSocket upgrade requests are authenticated via the Worker middleware and container auth token.

---

### REQ-TERM-001: Terminal surface count follows session mode

**Intent:** Each Terminal session preserves its immutable ownership mode: classic exposes Codeflare tabs and tiling, while Herdr exposes one outer surface and owns inner topology.

**Applies To:** User

**Acceptance Criteria:**

1. Classic single-session view supports terminal IDs `1` through `6`, tabs, labels, saved layouts, and tiling. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (renders classic tabs and tiling controls) -->
2. Herdr view mounts one outer xterm.js surface at terminal ID `1` without classic topology controls. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (renders one Herdr surface without classic tabs or tiling controls) -->
3. Dashboard view mounts no terminal surface. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-011: renders no terminal panes on Dashboard even when sessions are running) -->
4. A VS Code workspace mounts no standalone terminal surface. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (does not give a VS Code active session terminal workspace or WebSocket ownership) -->
5. MultiView resolves each member from its ownership mode. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::openMultiView --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (resolves mixed MultiView members by immutable terminal mode) -->

**Constraints:**

- The stable WebSocket path remains `/api/terminal/{sessionId}-{terminalId}/ws`.
- Previously deleted browser-local layouts cannot be recovered; absent classic layout state initializes defaults.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](session-lifecycle.md#req-session-002-one-container-per-session-isolation), [REQ-TERM-034](#req-term-034-terminal-mode-assignment-is-immutable)

**Verification:** Automated frontend and terminal-route tests.

**Status:** Implemented

---

### REQ-TERM-034: Terminal mode assignment is immutable

**Intent:** Session ownership is selected only at creation, remains stable for the session lifetime, and defaults safely for historical records.

**Applies To:** User

**Acceptance Criteria:**

1. New sessions use classic ownership by default and Herdr ownership only after the authenticated user opts in. <!-- @impl: src/routes/session/crud.ts::default --> <!-- @test: src/__tests__/routes/session.test.ts (creates a new session with default name) --> <!-- @test: src/__tests__/routes/session.test.ts (stamps Herdr only when the server preference is exactly true) -->
2. Missing or invalid historical ownership resolves to classic. <!-- @impl: src/types.ts::resolveTerminalMode --> <!-- @impl: src/routes/session/crud.ts::toWorkspaceApiSession --> <!-- @test: src/__tests__/routes/session.test.ts (resolves missing and invalid historical terminal modes to classic) -->
3. Changing the preference never mutates an existing session's mode. <!-- @impl: src/routes/preferences.ts::mergePreferences --> <!-- @test: src/__tests__/routes/preferences.test.ts (persists Herdr preference independently of existing session records) -->
4. Clients cannot choose or patch the authoritative stamp. <!-- @impl: src/routes/session/crud.ts::CreateSessionBody --> <!-- @test: src/__tests__/routes/session.test.ts (rejects client-selected terminal mode) --> <!-- @test: src/__tests__/routes/session.test.ts (rejects terminal mode mutation) -->
5. Settings presents Herdr as a beta option, contrasts its workspaces, splits, panes, and agent status with classic tabs and tiling, and states that the choice applies to new sessions. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/settings/SessionSection.test.tsx (REQ-TERM-034 AC5: explains Herdr and marks the terminal experience as beta) -->

**Constraints:**

- The persisted session stamp, never current preference or browser input, governs routing, startup, resume, prewarm, cleanup, and rendering.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](session-lifecycle.md#req-session-002-one-container-per-session-isolation)

**Verification:** Automated preference and session-route tests.

**Status:** Implemented

---

### REQ-TERM-002: WebSocket connection to container PTY

**Intent:** Each terminal surface connects to its outer PTY through the existing WebSocket; classic renders its shell or agent directly and Herdr renders the official client without a new browser protocol.

**Applies To:** User

**Acceptance Criteria:**

1. The stable WebSocket route accepts a backend session identity and terminal IDs `1` through `6`. <!-- @impl: src/routes/terminal.ts::validateWebSocketRoute --> <!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (REQ-TERM-002 AC1: WS URL pattern /api/terminal/{sessionId}-{terminalId}/ws) -->
2. Authenticated session lookup rejects IDs above `1` for Herdr while permitting valid classic IDs. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (mode-aware terminal authorization) -->
3. The Worker upgrades the HTTP request to a WebSocket and forwards it through the Container DO to the in-container terminal server. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal.test.ts (validateWebSocketRoute / REQ-TERM-002 (terminal WebSocket connection to container PTY)) -->
4. Each mode starts its owned terminal experience in a full-color PTY. <!-- @impl: host/src/server.ts::TERMINAL_MODE --> <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/terminal-mode.test.js (defaults missing and invalid values to classic login Bash) --> <!-- @test: host/__tests__/terminal-mode.test.js (selects the fixed Herdr launcher without shell arguments) -->
5. Raw terminal data flows over the WebSocket without JSON wrapping so binary-clean PTY output is preserved. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-wire-protocol.test.js (REQ-TERM-002 AC5: raw PTY output reaches clients without JSON wrapping) -->

**Constraints:**

- WebSocket upgrade handling must run before the application router.
- All proxied HTTP requests from the DO to the container carry the shared container auth token; only the health and activity probes are exempt.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](session-lifecycle.md#req-session-002-one-container-per-session-isolation), [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** Automated test ([Integration test](../../src/__tests__/routes/terminal-route-validate.test.ts))

**Status:** Implemented

---

### REQ-TERM-019: Terminal WebSocket Control Frames and Protocol Guards

**Intent:** The terminal WebSocket protocol must separate raw PTY bytes from out-of-band control behavior while avoiding client-side protocol noise that agent TUIs do not consume.

**Applies To:** User

**Acceptance Criteria:**

1. Out-of-band control messages (resize, process-name, restore, and client-requested PTY termination) are encoded as JSON objects identifiable by a leading type-discriminator field. <!-- @impl: host/src/session.ts::Session --> <!-- @impl: host/src/terminal-ws.ts::attachTerminalConnectionHandler --> <!-- @impl: web-ui/src/stores/terminal.ts::dispose --> <!-- @test: host/__tests__/session-wire-protocol.test.js (REQ-TERM-019 AC1: host-originated control frames are typed JSON) -->
2. Unknown control-message types are silently ignored so the wire protocol can grow without breaking older clients or servers. <!-- @impl: host/src/terminal-ws.ts::attachTerminalConnectionHandler --> <!-- @test: host/__tests__/ws-input-classification.test.js (WS input classification) -->
3. No application-level ping/pong is implemented; the transport layer handles WebSocket keepalive on its own. <!-- @impl: host/src/session.ts::Session --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (useTerminal hook) -->
4. The terminal emulator's optional VT extensions that inject emulator-generated reports into the PTY input stream (xterm ≥6.1 color-scheme reporting, `CSI ?997;x n`) are disabled at construction, so agent TUIs never receive asynchronous reports they do not consume. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (should disable xterm color-scheme reporting so no CSI ?997 report can reach the PTY) -->

**Constraints:**

- Control messages are JSON-framed out-of-band data; PTY output remains raw bytes.
- Protocol keepalive and browser/emulator guard behavior may require integration/manual verification when no genuine unit-test seam exists.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated test ([host wire-protocol tests](../../host/__tests__/session-wire-protocol.test.js), [client kill control-frame test](../../web-ui/src/__tests__/stores/terminal.test.ts), and [xterm VT-extension guard](../../web-ui/src/__tests__/hooks/useTerminal.test.ts).)

**Status:** Implemented

---

### REQ-TERM-003: Automatic WebSocket reconnection on transient failures

**Intent:** Transient network failures (connection drops, server restarts) trigger automatic reconnection so the user does not need to manually refresh.

**Applies To:** User

**Acceptance Criteria:**

1. The retryable close-code set covers the standard WebSocket "transient" codes: going-away, abnormal-closure, unexpected-condition, service-restart, and try-again-later. <!-- @impl: web-ui/src/lib/constants.ts::WS_RETRYABLE_CLOSE_CODES --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
2. Reconnection uses a backoff delay between attempts (see [REQ-TERM-020](#req-term-020-terminal-reconnect-teardown-timeout-and-backoff-timing) AC3) and retries indefinitely while close codes remain in the retryable set. <!-- @impl: web-ui/src/lib/constants.ts::WS_RECONNECT_BASE_MS --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
3. On reconnection, the terminal buffer state is restored by serializing the in-memory xterm buffer and replaying it into the new connection. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
4. The input handler subscription is owned outside the connect routine and disposed before a replacement handler is attached so reconnect cannot duplicate keystrokes. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
5. Reconnection attempts are cancellable so parallel retry loops cannot accumulate across rapid disconnect-reconnect cycles. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
6. Dead-container state is never inferred from a retry-failure counter; only the server-authoritative container-stopped close code stops retries. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->

**Constraints:**

- Retry loops are cancelled when a session is disposed (for example, when the session is stopped or the user navigates away).
- Dashboard navigation schedules a short WebSocket disconnect grace period; returning to the terminal within the grace window cancels the timer and reconnects without tearing down the connection.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated test ([terminal](../../web-ui/src/__tests__/stores/terminal.test.ts), [connect-timeout test](../../web-ui/src/__tests__/stores/terminal-connect-timeout.test.ts), [backoff test](../../web-ui/src/__tests__/stores/terminal-reconnect-backoff.test.ts))

**Status:** Implemented

---

### REQ-TERM-020: Terminal Reconnect Teardown, Timeout, and Backoff Timing

**Intent:** Terminal reconnection must handle in-flight sockets, stalled handshakes, and retry timing without noisy browser errors or parallel retry loops.

**Applies To:** User

**Acceptance Criteria:**

1. Tearing down a connection whose WebSocket is still mid-handshake (CONNECTING) neither force-closes the socket nor surfaces an error: the already-aborted connect handlers close it cleanly once it resolves, so rapid disconnect-reconnect cycles produce no "closed before the connection is established. <!-- @impl: web-ui/src/stores/terminal.ts::disconnect --> <!-- @impl: web-ui/src/stores/terminal.ts::connect --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-020 AC1: quiet teardown of in-flight connections) -->
2. A socket that stays in CONNECTING past `WS_CONNECT_TIMEOUT_MS` (no close or error event fires after a mobile app-switch) is force-closed and a backoff reconnect is scheduled, so it is no longer stranded mid-handshake. <!-- @impl: web-ui/src/stores/terminal.ts::connect --> <!-- @test: web-ui/src/__tests__/stores/terminal-connect-timeout.test.ts (Terminal Store / REQ-TERM-020 AC2: connect-timeout force-close & AC3 pause-while-hidden) -->
3. Reconnection delay is an equal-jitter exponential backoff; the backoff resets to attempt 1 on a successful open and on visibility return, and is paused while the page is hidden. <!-- @impl: web-ui/src/stores/terminal-protocol.ts::reconnectBackoffMs --> <!-- @test: web-ui/src/__tests__/stores/terminal-reconnect-backoff.test.ts (reconnectBackoffMs (REQ-TERM-020 AC3): equal-jitter exponential backoff) -->

**Constraints:**

- Retry timing resets on successful open and visibility return, and pauses while the document is hidden.
- CONNECTING-socket teardown avoids force-closing until the already-aborted handlers can close cleanly.

**Priority:** P1

**Dependencies:** [REQ-TERM-003](#req-term-003-automatic-websocket-reconnection-on-transient-failures)

**Verification:** Automated test ([quiet teardown](../../web-ui/src/__tests__/stores/terminal.test.ts), [connect-timeout test](../../web-ui/src/__tests__/stores/terminal-connect-timeout.test.ts), and [backoff test](../../web-ui/src/__tests__/stores/terminal-reconnect-backoff.test.ts).)

**Status:** Implemented

---

### REQ-TERM-004: Close code 4503 is authoritative (no retry)

**Intent:** The custom WebSocket close code 4503 is a server-authoritative signal that the container is not running. The client must stop retrying and display a "Session stopped" message.

**Applies To:** User

**Acceptance Criteria:**

1. The Container DO's WebSocket handler sends the dedicated container-stopped close code (4503) whenever the underlying container is not running. <!-- @impl: src/container/index.ts::container --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
2. On receiving the container-stopped close code, the frontend immediately moves the terminal into a disconnected state and surfaces a "Session stopped" message. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
3. The frontend does not retry the connection after receiving the container-stopped close code. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
4. Network and transient infrastructure close codes 1001, 1006, 1011, 1012, and 1013 retry indefinitely; intentional/normal and otherwise unclassified close codes remain disconnected while persistent state polling resolves final session status. <!-- @impl: web-ui/src/lib/constants.ts::WS_RETRYABLE_CLOSE_CODES --> <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
5. The container-stopped close code is distinct from a 503 HTTP response on the terminal route guard so the two layers can fail independently (defense in depth). <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->

**Constraints:**

- The 4503 code falls inside the WebSocket private-use range so it cannot collide with standardized codes.
- During the startup grace window for newly started sessions, only the container-stopped close code is allowed to transition a session into the stopped state, preventing flapping while the new container is still warming up.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-SESSION-012](session-lifecycle.md#req-session-012-wake-loop-prevention)

**Verification:** Automated test ([terminal](../../web-ui/src/__tests__/stores/terminal.test.ts))

**Status:** Implemented

---

### REQ-TERM-005: Herdr runtime and configured agent startup

**Intent:** An opt-in Herdr Terminal session starts one pinned runtime and bootstraps the configured command once; classic sessions retain direct shell startup.

**Applies To:** User

**Acceptance Criteria:**

1. The built image provides one verified, attributed Herdr runtime with managed non-updating terminal settings. <!-- @impl: Dockerfile::HERDR_VERSION --> <!-- @impl: image/herdr/config.toml::version_check --> <!-- @manual: The container-image workflow verifies the installed Herdr version, managed configuration, executable mode, license, provenance, SBOM, and vulnerability scan. -->
2. Each Herdr session starts or attaches to one deterministic private runtime, including at the maximum session-ID length. <!-- @impl: image/herdr/codeflare-herdr-terminal::prepare_runtime --> <!-- @test: host/__tests__/herdr-launcher.test.js (rejects malformed session identity before invoking Herdr) --> <!-- @test: host/__tests__/herdr-launcher.test.js (keeps the maximum-length session client socket within the Linux path limit) -->
3. Classic sessions never start or stop Herdr. <!-- @impl: host/src/server.ts::TERMINAL_MODE --> <!-- @test: host/__tests__/terminal-mode.test.js (defaults missing and invalid values to classic login Bash) -->
4. The launcher submits the reviewed configured command and publishes bootstrap readiness only after bounded expected-agent or process detection. <!-- @impl: image/herdr/codeflare-herdr-terminal::bootstrap --> <!-- @test: host/__tests__/herdr-launcher.test.js (submits fixed commands and waits for expected detection) -->
5. Bash or empty configuration remains a plain shell. <!-- @impl: image/herdr/codeflare-herdr-terminal::bootstrap --> <!-- @test: host/__tests__/herdr-launcher.test.js (leaves Bash untouched and maps ordinary TUI commands without shell interpolation) -->
6. Later Herdr tabs and panes open plain Bash instead of repeating Codeflare agent autostart. <!-- @impl: image/herdr/codeflare-herdr-terminal::prepare_runtime --> <!-- @manual: In integration, start a configured agent, open a new Herdr tab and pane, and confirm each new shell is plain Bash. -->

**Constraints:**

- Herdr is pinned to v0.8.2, commit `9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c`, with Linux x86-64 SHA-256 `976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4` and Apache-2.0 attribution.
- The launcher validates `SESSION_ID`, derives only `cf-<SESSION_ID>`, reads only `TAB_CONFIG` entry `1`, exports `TERMINAL_APP_STARTED=1`, and uses mode-0700 state under `/run/codeflare/herdr/<SESSION_ID>`.
- Herdr live processes and runtime artifacts stay container-local; only the structural snapshot defined by [REQ-TERM-033](#req-term-033-durable-herdr-structural-session-recovery) enters R2. No Herdr socket, API, or private client protocol is exposed through Worker routes.
- Startup maps reviewed values to fixed argv and never interpolates browser or `TAB_CONFIG` text into a shell command.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-SESSION-003](session-lifecycle.md#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated launcher tests plus container-image and manual verification.

**Status:** Implemented

---

### REQ-TERM-035: Terminal readiness follows mode and workspace

**Intent:** Prewarm settlement follows the immutable terminal mode while Browser IDE workspaces remain independent from the host terminal runtime.

**Applies To:** User

**Acceptance Criteria:**

1. Terminal prewarm preserves the existing outer Session and adoption flow. <!-- @impl: host/src/server.ts::beginSettlementWhenReady --> <!-- @manual: In integration, confirm both stamped modes adopt the prewarmed outer Session. -->
2. Herdr does not report readiness until configured-command bootstrap completes. <!-- @impl: host/src/server.ts::beginSettlementWhenReady --> <!-- @impl: host/src/terminal-mode.ts::isPrewarmTimeoutReady --> <!-- @test: host/__tests__/terminal-mode.test.js (REQ-AGENT-003 AC6 / REQ-TERM-035 AC2: Herdr timeout readiness requires bootstrap) -->
3. Classic retains first-output readiness and its bounded timeout fallback. <!-- @impl: host/src/server.ts::beginSettlementWhenReady --> <!-- @manual: In integration, confirm classic settles from first PTY output and remains reachable after the timeout fallback. -->
4. VS Code workspaces start no Herdr runtime and retain existing Browser IDE terminal profiles. <!-- @impl: host/src/server.ts::SESSION_WORKSPACE --> <!-- @test: host/__tests__/workspace-readiness.test.js (never constructs, inserts, or starts a host Session for VS Code) -->
5. An expired Herdr prewarm without completed bootstrap terminates the terminal host for container recovery instead of remaining indefinitely in preparation. <!-- @impl: host/src/server.ts::server.listen --> <!-- @impl: host/src/prewarm-readiness.ts::handlePrewarmOrphanExpiry --> <!-- @test: host/__tests__/prewarm-orphan-expiry.test.js (REQ-TERM-035 AC5: orphan expiry terminates unbootstrapped Herdr after cleanup) -->

**Constraints:**

- Readiness uses the persisted session stamp rather than current preferences.

**Priority:** P0

**Dependencies:** [REQ-TERM-005](#req-term-005-herdr-runtime-and-configured-agent-startup), [REQ-SESSION-015](session-lifecycle.md#req-session-015-pre-warmed-agent-startup)

**Verification:** Automated workspace tests plus manual mode-specific readiness verification.

**Status:** Implemented

---

### REQ-TERM-006: Herdr owns in-session terminal topology

**Intent:** In sessions stamped Herdr, users create tabs, Bash shells, panes, splits, and workspaces inside Herdr rather than through duplicate Codeflare controls.

**Applies To:** User

**Acceptance Criteria:**

1. Codeflare renders no per-session terminal tab bar or within-session tiling controls for a Herdr session. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (renders one Herdr surface without classic tabs or tiling controls) -->
2. The official Herdr client receives keyboard, mouse, focus, and resize input through the existing terminal surface. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-011 / REQ-TERM-030 AC3: changes focus without reconnecting the terminal) --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (resize handling) -->
3. Herdr-created tabs and panes start plain Bash unless the user explicitly launches another command. <!-- @impl: image/herdr/codeflare-herdr-terminal::prepare_runtime --> <!-- @test: host/__tests__/herdr-launcher.test.js (leaves Bash untouched and maps ordinary TUI commands without shell interpolation) -->
4. Browser disconnect preserves the outer PTY and named Herdr runtime while the container remains alive, and repeated client exits reattach while the server remains healthy. <!-- @impl: host/src/session.ts::Session --> <!-- @impl: image/herdr/codeflare-herdr-terminal::supervise_client --> <!-- @test: host/__tests__/herdr-launcher.test.js (reattaches after repeated client exits while the Herdr server remains healthy) --> <!-- @manual: In integration, disconnect and reconnect the browser while the container remains alive and confirm the same Herdr tabs, panes, and running processes remain. -->
5. Terminal and container lifecycle shutdowns stop the named Herdr runtime without orphan descendants. <!-- @impl: host/src/session.ts::kill --> <!-- @impl: host/src/server.ts::stopTerminalRuntime --> <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/session-wire-protocol.test.js (kill() invokes the injected terminal-runtime cleanup exactly once) --> <!-- @test: host/__tests__/herdr-launcher.test.js (stops only the deterministic named runtime) --> <!-- @manual: In integration, stop and delete a Terminal session and confirm no named Herdr runtime or descendants remain. -->

**Constraints:**

- Classic is a complete independent terminal mode, not a second topology layer inside a Herdr session.
- Codeflare adds no browser Herdr protocol.
- Browser IDE integrated terminals remain outside this runtime.

**Priority:** P0

**Dependencies:** [REQ-TERM-001](#req-term-001-terminal-surface-count-follows-session-mode), [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated frontend, launcher, and host cleanup tests plus manual lifecycle verification.

**Status:** Implemented

---

### REQ-TERM-033: Durable Herdr structural session recovery

**Intent:** A Herdr session can reconstruct its terminal topology after container replacement without persisting terminal output or pretending arbitrary processes survived.

**Applies To:** User

**Acceptance Criteria:**

1. Herdr writes its official structural session snapshot beneath the R2-synced `.codeflare` home directory while sockets, locks, logs, and other runtime state remain under the ephemeral runtime root. <!-- @impl: image/herdr/codeflare-herdr-terminal::prepare_runtime --> <!-- @test: host/__tests__/herdr-launcher.test.js (keeps the maximum-length session client socket within the Linux path limit) -->
2. Normal home restore makes the snapshot available before Herdr prewarm, and normal periodic, manual, and final sync carry later snapshots to R2 without a separate upload channel. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @impl: host/src/server.ts::waitForInitFlag --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (persists only Herdr structural session snapshots under .codeflare) -->
3. Restoring `session.json` may recover workspaces, tabs, panes, layout, cwd, focus, and supported native agent session references; it does not claim to preserve running shells, arbitrary processes, or terminal output. <!-- @impl: image/herdr/codeflare-herdr-terminal::wait_for_restored_agent --> <!-- @test: host/__tests__/herdr-launcher.test.js (falls back to persisted agent metadata when Pi lifecycle readiness is unavailable) --> <!-- @manual: Replace a stopped Herdr container after a successful sync and confirm structural topology restores without prior pane output. -->
4. Pane history, client and API sockets, updater state, logs, and user-edited Herdr configuration remain excluded from R2. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (persists only Herdr structural session snapshots under .codeflare) -->
5. With the pinned Pi integration, restored Pi panes delay readiness until every resumed Pi session has loaded its transcript and established live lifecycle authority; if that versioned signal is unavailable, restored metadata retains the compatibility path to readiness. <!-- @impl: image/herdr/codeflare-herdr-terminal::wait_for_live_restored_pi --> <!-- @impl: image/herdr/codeflare-herdr-terminal::wait_for_restored_agent --> <!-- @test: host/__tests__/herdr-launcher.test.js (waits for live Pi integration before completing restored bootstrap) --> <!-- @test: host/__tests__/herdr-launcher.test.js (falls back to persisted agent metadata when Pi lifecycle readiness is unavailable) -->

**Constraints:**

- Snapshot durability follows the existing 15-minute bisync cadence, explicit Sync trigger, and final-sync boundary; abrupt loss may discard changes newer than the last successful sync.
- `session-history.json` remains excluded because terminal output may contain prompts, credentials, tokens, and command output.
- Recovery uses Herdr v0.8.2's official snapshot format; Codeflare defines no parallel snapshot schema.

**Priority:** P0

**Dependencies:** [REQ-TERM-005](#req-term-005-herdr-runtime-and-configured-agent-startup), [REQ-STOR-002](storage.md#req-stor-002-file-persistence-across-sessions), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated launcher and rclone-filter tests plus manual replacement acceptance.

**Status:** Implemented

---

### REQ-TERM-007: Classic topology remains available

**Intent:** Sessions stamped classic retain the proven Codeflare tab, process-label, saved-layout, and tiling experience.

**Applies To:** User

**Acceptance Criteria:**

1. Classic session state owns up to six canonical ordered tabs and active-tab identity. <!-- @impl: web-ui/src/stores/session-tabs.ts::initializeTerminalsForSession --> <!-- @impl: web-ui/src/stores/session-tabs.ts::reorderTerminalTabs --> <!-- @test: web-ui/src/__tests__/stores/session-tabs.test.ts (REQ-TERM-007 AC1: rejects invalid and duplicate persisted terminal IDs) -->
2. On load, a supported saved layout compatible with the normalized tab count remains enabled; an unknown or incompatible layout resolves to disabled tabbed mode. <!-- @impl: web-ui/src/stores/session-tabs.ts::normalizeSessionTerminals --> <!-- @impl: web-ui/src/stores/tiling.ts::getTilingForSession --> <!-- @test: web-ui/src/__tests__/stores/session-tabs.test.ts (REQ-TERM-007 AC2: disables an invalid persisted tiling layout) --> <!-- @test: web-ui/src/__tests__/stores/session-tabs.test.ts (REQ-TERM-007 AC2: disables a persisted layout incompatible with validated tabs) --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (Tiling Module - Pure Helpers / REQ-TERM-007 (tiling layout selection, compatibility check, best-fit-for-tab-count, setTilingLayout)) -->
3. Classic terminal view exposes the established tab bar, manual Bash-tab action, drag ordering, and tiling controls. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (renders classic tabs and tiling controls) -->
4. Herdr terminal view suppresses Codeflare topology controls. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (renders one Herdr surface without classic tabs or tiling controls) -->
5. Classic right-click paste preserves existing permission behavior. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (should read clipboard on right-click when clipboardAccess is enabled) -->
6. Classic mobile gestures preserve buffer-authoritative scrolling and keyboard-open navigation. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (scrolls the buffer on vertical swipe when keyboard is closed) -->
7. Valid process labels update only the targeted classic outer tab. <!-- @impl: web-ui/src/stores/session-tabs.ts::updateTerminalLabel --> <!-- @test: web-ui/src/__tests__/stores/update-terminal-label.test.ts (REQ-TERM-009 AC2: only mutates the targeted terminalId, leaves siblings untouched) -->

**Constraints:**

- The `codeflare:terminalsPerSession` state is retained for classic sessions; absent state initializes defaults.
- Herdr sessions never read that state as topology authority.

**Priority:** P2

**Dependencies:** [REQ-TERM-006](#req-term-006-herdr-owns-in-session-terminal-topology)

**Verification:** Automated single-surface behavior plus source and dependency review.

**Status:** Implemented

---

### REQ-TERM-030: Herdr owns inner pane focus lifecycle

**Intent:** Focus changes inside an opt-in Herdr session belong to Herdr; classic retains Codeflare outer-pane focus, and MultiView coordinates focus among backend-session surfaces.

**Applies To:** User

**Acceptance Criteria:**

1. Codeflare has no inner pane focus model for a Herdr session. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (renders one Herdr surface without classic tabs or tiling controls) -->
2. Classic focus remains attached to visible outer terminal tabs or tiles. <!-- @impl: web-ui/src/components/TerminalTabs.tsx::TerminalTabs --> <!-- @test: web-ui/src/__tests__/components/TerminalTabs.test.tsx (REQ-TERM-007 AC1: exposes tab semantics and selects adjacent tabs with arrow keys) -->
3. MultiView focus moves among mounted backend-session surfaces without remounting or reconnecting them. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-011 / REQ-TERM-030 AC3: changes focus without reconnecting the terminal) -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-TERM-006](#req-term-006-herdr-owns-in-session-terminal-topology), [REQ-TERM-012](#req-term-012-multiview-virtual-session-workspace)

**Verification:** Automated TerminalArea and terminal focus tests.

**Status:** Implemented

---

### REQ-TERM-008: Write batching at 30fps

**Intent:** Rapid WebSocket messages are coalesced into terminal writes at 30fps to reduce rendering overhead without perceptible latency.

**Applies To:** User

**Acceptance Criteria:**

1. Incoming WebSocket messages are appended to a per-terminal write buffer keyed by the compound terminal identity. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
2. A flush is scheduled on a fixed cadence corresponding to roughly 30 frames per second so render passes are bounded even under burst output. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
3. On flush, all buffered output for a terminal is concatenated and written to the rendering library in a single call. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
4. The 30 fps flush rate halves the render-pass count compared to 60 fps without producing perceptible latency for typed input or interactive output. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
5. The added flush latency stays below the human input-feedback perception threshold. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @manual -->
6. Pending flushes are tracked per terminal and cancelled on terminal disposal. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @manual -->

**Constraints:**

- Write buffers use the compound terminal identity so each tab's stream is coalesced independently.
- Programmatic scroll-position adjustments after a write are tracked separately so they cannot be misinterpreted as a user-initiated scroll reset.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated test ([terminal](../../web-ui/src/__tests__/stores/terminal.test.ts))

**Status:** Implemented

---

### REQ-TERM-009: Process-label ownership follows terminal mode

**Intent:** Classic keeps outer process labels, while Herdr sessions label the one outer surface by backend session identity and leave inner process and agent state to Herdr.

**Applies To:** User

**Acceptance Criteria:**

1. Herdr sessions do not present the outer client process as inner pane or agent state. <!-- @impl: web-ui/src/stores/terminal.ts::connect --> <!-- @test: web-ui/src/__tests__/stores/terminal-control-message.test.ts (REQ-TERM-009 AC1: suppresses process-name callbacks when outer labels are disabled) -->
2. Classic sessions apply validated process identity updates only to the targeted outer tab. <!-- @impl: web-ui/src/stores/terminal-protocol.ts::parseControlMessage --> <!-- @impl: web-ui/src/stores/session-tabs.ts::updateTerminalLabel --> <!-- @test: web-ui/src/__tests__/stores/terminal-control-message.test.ts (REQ-TERM-009 AC2: routes a non-empty string process name to the process-name kind) --> <!-- @test: web-ui/src/__tests__/stores/update-terminal-label.test.ts (REQ-TERM-009 AC2: only mutates the targeted terminalId, leaves siblings untouched) -->
3. Session cards retain their configured agent icon. <!-- @impl: web-ui/src/lib/terminal-config.ts::AGENT_ICON_MAP --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (renders agent icon) -->
4. Classic terminal tabs expose outer process labels while the Herdr surface suppresses classic tabs. <!-- @impl: web-ui/src/components/TerminalTabs.tsx::resolveTabLabel --> <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (renders one Herdr surface without classic tabs or tiling controls) -->
5. Unknown control messages and raw terminal bytes remain raw terminal data. <!-- @impl: web-ui/src/stores/terminal-protocol.ts::parseControlMessage --> <!-- @test: web-ui/src/__tests__/stores/terminal-control-message.test.ts (REQ-TERM-009 AC5: an unknown control type (e.g. pong) is treated as raw) --> <!-- @test: web-ui/src/__tests__/stores/terminal-control-message.test.ts (REQ-TERM-009 AC5: raw terminal output does not invoke the process-name callback) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-006](#req-term-006-herdr-owns-in-session-terminal-topology)

**Verification:** Automated host and frontend protocol tests.

**Status:** Implemented

---

### REQ-TERM-011: Visible terminal panes own WebSocket connections

**Intent:** Terminal WebSockets are opened only for terminal panes that are visible in the current browser workspace, preventing hidden sessions from attaching to PTYs and sending stale resize or input traffic.

**Applies To:** User

**Acceptance Criteria:**

1. Dashboard view opens zero terminal WebSocket connections even when sessions are running or initializing. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::setDashboardWorkspace --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-011: renders no terminal panes on Dashboard even when sessions are running) -->
2. Single-session view opens exactly one terminal WebSocket for the visible backend session surface using internal terminal ID `1`. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::setSingleSessionWorkspace --> <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (REQ-TERM-011: single-session workspace exposes exactly one visible pane) -->
3. Running sessions outside the visible workspace have no connected terminal side effects. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (TerminalArea) -->
4. Workspace switches dispose local UI terminal resources for panes that leave the visible set without stopping the underlying PTY. <!-- @impl: web-ui/src/hooks/useTerminal.ts::canConnect --> <!-- @impl: web-ui/src/stores/terminal.ts::disposeLocalTerminal --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) -->
5. Session indicators distinguish container-running state from visible-terminal-connected state. <!-- @impl: web-ui/src/components/SessionStatCard.tsx::dotVariant --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (SessionStatCard) -->

**Constraints:**

- Hidden terminal preservation cannot be used as an instant-switching optimization if it opens a WebSocket.
- Dashboard status must remain a polling/storage concern and must not depend on terminal component side effects.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-003](#req-term-003-automatic-websocket-reconnection-on-transient-failures)

**Verification:** Automated test ([TerminalArea](../../web-ui/src/__tests__/components/TerminalArea.test.tsx), [Hook tests](../../web-ui/src/__tests__/hooks/useTerminal.test.ts), [Terminal store tests](../../web-ui/src/__tests__/stores/terminal.test.ts), [Layout tests](../../web-ui/src/__tests__/components/Layout.test.tsx))

**Status:** Implemented

---

### REQ-TERM-012: MultiView virtual session workspace

**Intent:** Users can open one virtual MultiView workspace that displays multiple existing sessions side by side without creating a backend session or changing the member sessions' lifecycle.

**Applies To:** User

**Acceptance Criteria:**

1. Exactly one virtual MultiView workspace can exist, and it is composed only from existing running or initializing sessions. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::MULTIVIEW_ID --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (terminalWorkspaceStore visible pane ownership) -->
2. Desktop MultiView accepts two to four member sessions; tablet MultiView accepts exactly two; mobile cannot launch MultiView. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::getMultiViewCapacity --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (terminalWorkspaceStore visible pane ownership) -->
3. MultiView never appears as a normal Dashboard session card; when saved panes exist, Dashboard exposes an icon-only MultiView action beside the new-session button. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 (session limit popup in frontend)) -->
4. Opening MultiView renders one connected internal terminal `1` surface for each selected backend session. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-012: renders one connected terminal pane for each visible MultiView member) -->
5. Workspace switches preserve MultiView membership while reconciling connections to visible panes. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (terminalWorkspaceStore visible pane ownership) -->

**Constraints:**

- MultiView is frontend workspace state and must not be sent to backend session lifecycle, terminal route validation, storage, quota, or metrics APIs as a real session ID.
- MultiView membership is local browser state unless a future requirement adds cross-browser workspace sync.

**Priority:** P1

**Dependencies:** [REQ-TERM-001](#req-term-001-terminal-surface-count-follows-session-mode), [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

**Verification:** Automated test ([Workspace store tests](../../web-ui/src/__tests__/stores/terminal-workspace.test.ts) + [TerminalArea tests](../../web-ui/src/__tests__/components/TerminalArea.test.tsx) + [TerminalGrid tests](../../web-ui/src/__tests__/components/TerminalGrid.test.tsx) + [Dashboard tests](../../web-ui/src/__tests__/components/Dashboard.test.tsx) + [Floating button tests](../../web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx))

**Status:** Implemented

---

### REQ-TERM-013: MultiView selection flow

**Intent:** Users create or reopen MultiView from the existing session switcher using a selection mode that is clear on desktop and tablet and unavailable on mobile.

**Applies To:** User

**Acceptance Criteria:**

1. The session switcher exposes a `Launch MultiView` control with the compact-view icon only when at least two sessions are running or initializing on tablet or desktop, and hides the control on mobile. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @impl: web-ui/src/components/MultiViewActionRow.tsx::MultiViewActionRow --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (SessionDropdown) -->
2. Activating the control enters selection mode, keeps the switcher open, and turns running or initializing session rows into toggleable choices. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (SessionDropdown) -->
3. The control exits selection mode without launching when fewer than two sessions are selected. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (REQ-TERM-013: rejects selection beyond desktop capacity without changing selected sessions) -->
4. The control launches MultiView when at least two sessions are selected. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @test: web-ui/src/__tests__/components/SessionSwitcher.test.tsx (REQ-TERM-013: creates MultiView from selected session ids and delegates opening to Layout) -->
5. Selecting beyond the viewport capacity is rejected without changing the existing selected set. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (REQ-TERM-013: rejects selection beyond desktop capacity without changing selected sessions) -->
6. Selected session rows expose a selected state using the success visual variant. <!-- @impl: web-ui/src/components/SelectableSessionCard.tsx::SelectableSessionCard --> <!-- @manual -->

**Constraints:**

- Stopped sessions are not selectable for MultiView.
- Capacity decisions must come from a shared viewport-capacity helper.

**Priority:** P1

**Dependencies:** [REQ-TERM-012](#req-term-012-multiview-virtual-session-workspace)

**Verification:** Automated test

**Status:** Implemented

---

<a id="req-term-014-stable-scrollback-under-sustained-output"></a>
### REQ-TERM-014: Terminal scroll anchoring under scrollback trimming

**Intent:** Long-running terminal output must keep bottom-following users at the live prompt while preserving a manually selected scrollback viewport until the user returns to bottom.

**Applies To:** User

**Acceptance Criteria:**

1. A terminal following the bottom remains at the bottom while output exceeds the scrollback cap. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-TERM-014: re-anchors a bottom-following terminal when scrollback trimming displaces it) -->
2. Any registered user-scroll intent establishes manual viewport ownership until the viewport returns to the live bottom, regardless of continuing output. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (useScrollCorrection / REQ-TERM-014 terminal scroll anchoring) -->
3. While manual ownership is active in the normal buffer, streamed output is deferred in the write buffer so the selected viewport does not move; on bottom return the hold releases progressively, and an owner who scrolls back up mid-release has the remainder deferred again. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-014 AC3: defers streamed output while the user owns the viewport and flushes on bottom return) --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-014 AC3: releases the hold in bounded slices and re-defers when the reader scrolls up mid-release) -->
4. Returning a manually owned viewport to the live bottom releases that ownership and restores bottom following for later output. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-TERM-014 AC1/AC2: returning to bottom releases manual ownership and restores bottom following) -->
5. Output held past the cap discards oldest whole atomic units, including an individually over-cap unit rather than retaining it; held output is never written while manual ownership is active. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-014 AC5: a cap-exceeding hold drops oldest chunks and never writes through a reader) -->
6. User input of any route while reading normal-buffer scrollback re-anchors the viewport to the live bottom; alternate-buffer applications are unaffected. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-014 AC6: user input while reading scrollback re-anchors the viewport to the live bottom) -->
7. Mouse-wheel scrollback navigation in the normal buffer moves the viewport by exactly the wheel delta; alternate-buffer and zoom-modified wheel events pass through to the application untouched. <!-- @impl: web-ui/src/lib/terminal-wheel.ts::attachWheelScrolling --> <!-- @test: web-ui/src/__tests__/lib/terminal-wheel.test.ts (terminal-wheel / REQ-TERM-014 AC7 buffer-authoritative wheel scrolling) -->

**Constraints:**

- The write buffer defers, drops oldest held data, or writes; it never scrolls the viewport.
- Output-driven trimming stays delegated to xterm.
- All scrollback navigation, bottom anchoring, and input re-anchoring scroll the buffer service directly with the paired repaint; `scrollOnUserInput` stays disabled; refits keeping a reader's position re-command the DOM scroll state ([AD105](../../documentation/decisions/README.md#ad105-streamed-output-defers-while-the-user-reads-scrollback-keyboard-open-swipes-are-always-terminal-input), [AD110](../../documentation/decisions/README.md#ad110-terminal-scrolling-is-buffer-authoritative-on-every-route-held-output-ring-drops)).
- Held output caps at 2,000,000 characters (oldest whole chunks dropped past it); bottom-return release is bounded to 65,536 characters per tick, re-checking ownership between ticks.
- Alternate-buffer output never defers — fullscreen applications own their history and have no scrollback to read.
- A zero display offset during full-buffer trimming is valid xterm behavior, not evidence of a browser reset.
- The short intent window correlates input (touch, pointer drags, floating-button navigation) with its first scroll event and never expires persistent manual ownership.
- Mobile keyboard resizing preserves the existing virtual-keyboard safeguards.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-008](#req-term-008-write-batching-at-30fps), [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

**Verification:** Automated test ([useScrollCorrection](../../web-ui/src/__tests__/hooks/useScrollCorrection.test.ts) + [Layout transition test](../../web-ui/src/__tests__/components/Layout.test.tsx) + [Full-buffer anchoring test](../../web-ui/src/__tests__/stores/terminal.test.ts) + [Input re-anchor tests](../../web-ui/src/__tests__/hooks/useTerminal.test.ts) + [Wheel navigation tests](../../web-ui/src/__tests__/lib/terminal-wheel.test.ts))

**Status:** Implemented

---

### REQ-TERM-021: Synchronized-output frame atomicity

**Intent:** Full-screen agent redraws authored as DEC 2026 synchronized frames (Pi's clear-and-replay frames foremost) reach xterm as the atomic units the application wrote, so a slow multi-message arrival can never trip xterm's synchronized-output safety timeout and paint a partially rebuilt transcript — the "viewport walks through the entire scrollback and snaps back" flash.

**Applies To:** User

**Acceptance Criteria:**

1. A synchronized-output frame arriving split across terminal WebSocket messages reaches xterm in exactly one write call, byte-identical and in stream order, including markers split across message boundaries; a redundant begin marker does not extend the frame. <!-- @impl: web-ui/src/lib/terminal-frames.ts::createFrameAssembler --> <!-- @impl: web-ui/src/stores/terminal-output.ts::scheduleWrite --> <!-- @test: web-ui/src/__tests__/lib/terminal-frames.test.ts (REQ-TERM-021 AC1: a frame split across chunks emits nothing until the end marker, then exactly one byte-identical unit) --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-021 AC1: a synchronized frame split across WebSocket messages reaches xterm as exactly one write) -->
2. Output containing no synchronized-output markers keeps the existing bounded write batching unchanged. <!-- @impl: web-ui/src/lib/terminal-frames.ts::createFrameAssembler --> <!-- @test: web-ui/src/__tests__/lib/terminal-frames.test.ts (REQ-TERM-021 AC2: ordinary output passes through unchanged, in order) -->
3. An unterminated or oversize frame fails open within the configured stall timeout and size ceiling instead of deferring output indefinitely. <!-- @impl: web-ui/src/lib/terminal-frames.ts::createFrameAssembler --> <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/lib/terminal-frames.test.ts (REQ-TERM-021 AC3: a stalled frame fails open after the stall timeout, not before) --> <!-- @test: web-ui/src/__tests__/lib/terminal-frames.test.ts (REQ-TERM-021 AC3: a frame exceeding the size ceiling fails open immediately) --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-021 AC3: a stalled partial frame fails open through the flush tick after the stall timeout) -->
4. The read-hold, held-output cap, and bounded release operate on whole atomic units: a synchronized frame held for a reading user releases in one write and is never split by the release budget. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-021 AC4: a held synchronized frame releases whole through the read-hold, never split) -->
5. Re-anchoring to the live bottom when the buffer already reports bottom restores output-follow and re-commands the viewport scroll state without repainting. <!-- @impl: web-ui/src/lib/xterm-internals.ts::scrollBufferToBottom --> <!-- @test: web-ui/src/__tests__/lib/xterm-internals.test.ts (REQ-TERM-021 AC5: repairs stale scroll state at the nominal bottom instead of no-opping) -->
6. A partially assembled frame never survives a WebSocket stream boundary; queued complete units are superseded by the host's authoritative restore on reconnectable closes and painted once on final closes. <!-- @impl: web-ui/src/stores/terminal.ts::handleWebSocketClose --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-021 AC6: a partially assembled frame does not survive a WebSocket stream boundary) --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-021 AC6: a final close paints already-complete units once and drops the partial frame) -->

**Constraints:**

- Frame markers are `ESC[?2026h`/`ESC[?2026l`, tracked as a set/reset mode (the first end marker closes the frame, matching the emulator); assembly is buffer-type-agnostic and byte-transparent for applications that never emit them.
- Atomicity relies on xterm parsing one write call synchronously — no asynchronous parser handlers may be registered on the terminal.
- Fail-open bounds are fixed constants (stall timeout, per-frame size ceiling); failing open restores pre-assembly behavior, never data loss beyond the existing held-output cap ([AD111](../../documentation/decisions/README.md#ad111-synchronized-output-frames-are-delivered-atomically-at-the-write-boundary)).
- The zero-delta bottom anchor clears a stale user-scroll lock through the buffer service without firing a scroll event or repaint.

**Priority:** P1

**Dependencies:** [REQ-TERM-008](#req-term-008-write-batching-at-30fps), [REQ-TERM-014](#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming)

**Verification:** Automated test ([Frame assembler tests](../../web-ui/src/__tests__/lib/terminal-frames.test.ts) + [Store delivery tests](../../web-ui/src/__tests__/stores/terminal.test.ts) + [Zero-delta anchor test](../../web-ui/src/__tests__/lib/xterm-internals.test.ts))

**Status:** Implemented

---

### REQ-TERM-022: An unreachable container ends the upgrade instead of escaping it

**Intent:** A terminal upgrade the container cannot answer must end as a close the client understands, because an escaping error reaches the browser as an abnormal closure on a socket that never opened, and a reconnect that never opens a socket never advances its backoff — so the tab retries at its base delay for as long as the session is unreachable.

**Applies To:** User

**Acceptance Criteria:**

1. A forward the container rejects ends the upgrade with a retryable close rather than propagating the error, so the client's reconnect backoff governs the retry rate. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (resolves with a WebSocket close instead of propagating the container reject) -->

**Constraints:** A rejected forward is treated as reachable-again-later, matching the unanswered forward: only the recorded session status may declare a session authoritatively over, so a transient failure cannot strand a user whose container is healthy.

**Priority:** P0

**Dependencies:** [REQ-SESSION-018](session-lifecycle.md#req-session-018-persisted-status-is-authoritative-on-container-exit)

**Verification:** Automated test ([rejected forward closes retryably](../../src/__tests__/routes/terminal-ws.test.ts))

**Status:** Implemented

---

### REQ-TERM-015: Focused Pane Owns URL Detection

**Intent:** Browser URL detection must belong to the focused connected terminal pane so stale panes cannot clear the active pane's detected URL.

**Applies To:** User

**Acceptance Criteria:**

1. Starting URL detection records the owning session and terminal id for the focused connected pane. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal-url-detection.ts::startUrlDetection --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (URL detection lifecycle / REQ-TERM-015) -->
2. Cleanup stops URL detection only for the same owning session and terminal id. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal-url-detection.ts::stopUrlDetection --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-015: stops URL detection for only the unmounted pane on cleanup) -->

**Constraints:**

- Unscoped cleanup is reserved for explicit global resets, not terminal component unmounts.

**Priority:** P0

**Dependencies:** [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

**Verification:** Automated test ([Hook tests](../../web-ui/src/__tests__/hooks/useTerminal.test.ts), [URL detection tests](../../web-ui/src/__tests__/stores/terminal-url-detection.test.ts))

**Status:** Implemented

---

### REQ-TERM-016: Terminal Pane Reconnect and Resize Authority

**Intent:** When a visible terminal pane returns to view or a focused pane reconnects, it reconnects only the panes visible in the current workspace, claims resize authority before sending dimensions, and a stale connection owner can never dispose the newer WebSocket for the same visible terminal. Connection ownership by visibility is defined in [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections).

**Applies To:** User

**Acceptance Criteria:**

1. Browser visibility return reconnects only panes or tiled tabs that are visible in the current workspace. <!-- @impl: web-ui/src/components/Layout.tsx::visibleTerminalKeys --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-TERM-011: reconnects only visible tiled slots after visibility return) -->
2. A focused visible terminal claims resize authority before sending dimensions, including retry reconnects that remain focused; Herdr owns focus and resizing among inner panes. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal.ts::claimResizeAuthority --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-011 / REQ-TERM-030 AC3: changes focus without reconnecting the terminal) --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-011 / REQ-TERM-016 AC2: resends focused resize authority after a retry reconnect opens) -->
3. Cleanup from a stale connection owner cannot dispose the newer WebSocket or input handler for the same visible terminal. <!-- @impl: web-ui/src/stores/terminal.ts::connect --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-012: stale cleanup from an older connection cannot close a newer connection for the same terminal) -->
4. A resize frame is emitted only for a visible, connected terminal, carrying its current fitted dimensions. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal.ts::resize --> <!-- @test: host/__tests__/session-resize-authority.test.js (REQ-TERM-016: accepts resize frames only from the foreground WebSocket owner) -->
5. A pane that loses focus before its terminal connection opens does not claim resize authority when that connection later opens. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal.ts::clearPendingResizeAuthority --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-016: clears a queued resize-authority claim when the pane loses focus) -->

**Constraints:**

- Hidden terminal preservation cannot be used as an instant-switching optimization if it opens a WebSocket.
- Dashboard status must remain a polling/storage concern and must not depend on terminal component side effects.

**Priority:** P0

**Dependencies:** [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

**Verification:** Automated test ([TerminalArea](../../web-ui/src/__tests__/components/TerminalArea.test.tsx), [Hook tests](../../web-ui/src/__tests__/hooks/useTerminal.test.ts), [Terminal store tests](../../web-ui/src/__tests__/stores/terminal.test.ts), [Layout tests](../../web-ui/src/__tests__/components/Layout.test.tsx), [Resize authority test](../../host/__tests__/session-resize-authority.test.js))

**Status:** Implemented

---

### REQ-TERM-017: MultiView Pane Focus and Input Routing

**Intent:** Within a MultiView workspace ([REQ-TERM-012](#req-term-012-multiview-virtual-session-workspace)), clicking between panes changes focus only without remounting or reconnecting, each member exposes exactly one terminal surface with no nested tab controls, and keyboard / floating-button input targets the focused pane even when no single session is active.

**Applies To:** User

**Acceptance Criteria:**

1. Clicking between MultiView panes changes focus only and does not remount panes or reconnect their WebSockets. <!-- @impl: web-ui/src/components/TerminalArea.tsx::multiViewGridPanes --> <!-- @impl: web-ui/src/components/TerminalArea.tsx::sessionNamesById --> <!-- @impl: web-ui/src/components/TerminalGrid.tsx::TerminalGrid --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-012: changes MultiView pane focus without remounting terminal panes) -->
2. Each MultiView member gets exactly one terminal surface; nested tab controls are absent. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-012: renders one connected terminal pane for each visible MultiView member) -->
3. Keyboard and floating-button input targets the focused MultiView pane even though no single session is active. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (REQ-TERM-012: sends floating-button keys to the focused MultiView pane when activeSessionId is null) -->

**Constraints:**

- MultiView is frontend workspace state and must not be sent to backend session lifecycle, terminal route validation, storage, quota, or metrics APIs as a real session ID.
- MultiView membership is local browser state unless a future requirement adds cross-browser workspace sync.

**Priority:** P1

**Dependencies:** [REQ-TERM-012](#req-term-012-multiview-virtual-session-workspace)

**Verification:** Automated test ([Workspace store tests](../../web-ui/src/__tests__/stores/terminal-workspace.test.ts) + [TerminalArea tests](../../web-ui/src/__tests__/components/TerminalArea.test.tsx) + [TerminalGrid tests](../../web-ui/src/__tests__/components/TerminalGrid.test.tsx) + [Dashboard tests](../../web-ui/src/__tests__/components/Dashboard.test.tsx) + [Floating button tests](../../web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx))

**Status:** Implemented

---

### REQ-TERM-018: MultiView Reopen and Close

**Intent:** Beyond the initial selection flow ([REQ-TERM-013](#req-term-013-multiview-selection-flow)), reopening an existing MultiView opens the same virtual workspace rather than creating another, and closing it from the session switcher deactivates the virtual workspace and closes the dropdown.

**Applies To:** User

**Acceptance Criteria:**

1. Reopening an existing MultiView opens the same virtual workspace rather than creating another MultiView. <!-- @impl: web-ui/src/components/SessionSwitcher.tsx::SessionSwitcher --> <!-- @test: web-ui/src/__tests__/components/SessionSwitcher.test.tsx (SessionSwitcher) -->
2. Closing an existing MultiView from the session switcher deactivates the virtual workspace and closes the dropdown. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @impl: web-ui/src/components/Layout.tsx::handleCloseMultiView --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (REQ-TERM-013: deactivates existing MultiView and closes the dropdown from the row close button) -->

**Constraints:**

- Stopped sessions are not selectable for MultiView.
- Capacity decisions must come from a shared viewport-capacity helper.

**Priority:** P1

**Dependencies:** [REQ-TERM-013](#req-term-013-multiview-selection-flow)

**Verification:** Automated test ([SessionDropdown](../../web-ui/src/__tests__/components/SessionDropdown.test.tsx), [Session switcher tests](../../web-ui/src/__tests__/components/SessionSwitcher.test.tsx))

**Status:** Implemented

---

### REQ-TERM-031: Herdr notification compatibility boundary

**Intent:** Herdr terminals preserve Codeflare's fixed attention-event trust model when inner terminal control bytes are unavailable to the outer surface.

**Applies To:** User

**Acceptance Criteria:**

1. Managed Pi and Claude producers preserve their fixed attention events inside Herdr, while non-Herdr terminals retain existing native behavior. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::emit --> <!-- @impl: entrypoint.sh::HERDR_NOTIFICATION_HOOKS --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (uses the fixed loopback helper instead of OSC bytes inside Herdr) --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (REQ-TERM-026 AC1: Claude keeps native Ghostty notifications and adds only the fixed Herdr permission hook) -->
2. Only authenticated fixed-kind events from the primary runtime enter notification coordination; malformed, unknown, oversized, or non-primary events are rejected. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/request-router.test.js (rejects missing auth, unknown kinds, non-primary identity, extra and duplicate keys) --> <!-- @test: host/__tests__/request-router.test.js (rejects oversized bodies before enqueue) -->
3. Accepted events retain existing suppression, grant, fallback, cancellation, expiry, and idle-isolation behavior without carrying display prose. <!-- @impl: host/src/session.ts::enqueueAgentEvent --> <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @test: host/__tests__/request-router.test.js (accepts one fixed primary-runtime kind without recording arbitrary prose) --> <!-- @test: host/__tests__/agent-events.test.js (classified input cancels pending, eligible, and drained-unacknowledged events) -->

**Constraints:**

- Herdr mode is selected only by `HERDR_ENV=1`; managed producers invoke `/usr/local/bin/codeflare-agent-event` rather than inner OSC 777.
- The helper accepts only `input-required`, `task-completed`, or `task-failed` and sends an enum-only request to the Bearer-protected loopback ingress for terminal ID `1`.
- Prompts, output, paths, credentials, arbitrary display text, user activity, and terminal content never cross or are logged by ingress.

**Priority:** P1

**Dependencies:** [REQ-TERM-023](#req-term-023-away-only-agent-notification-delivery), [REQ-SEC-024](security.md#req-sec-024-agent-notification-delivery-trust-boundaries)

**Verification:** Automated producer, ingress, and queue tests.

**Status:** Implemented

---

### REQ-TERM-032: Herdr clipboard compatibility boundary

**Intent:** The browser exposes only bounded Herdr clipboard writes under existing user permission.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal clipboard parser accepts bounded standard-selector base64 containing valid UTF-8. <!-- @impl: web-ui/src/lib/osc52.ts::parseOsc52ClipboardWrite --> <!-- @test: web-ui/src/__tests__/lib/osc52.test.ts (decodes a bounded standard clipboard UTF-8 write) -->
2. The parser rejects reads, malformed data, unsupported selectors, and invalid UTF-8. <!-- @impl: web-ui/src/lib/osc52.ts::parseOsc52ClipboardWrite --> <!-- @test: web-ui/src/__tests__/lib/osc52.test.ts (rejects query, selector, malformed, or invalid UTF-8 payload %s) -->
3. The parser rejects decoded content above the fixed byte limit. <!-- @impl: web-ui/src/lib/osc52.ts::parseOsc52ClipboardWrite --> <!-- @test: web-ui/src/__tests__/lib/osc52.test.ts (rejects decoded content above the fixed byte limit) -->
4. Herdr sessions register accepted clipboard writes only when the existing browser clipboard setting permits access. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @manual: In integration, send a valid clipboard write with access enabled and disabled and confirm only the enabled Herdr case updates the clipboard. -->
5. Classic sessions do not install the Herdr clipboard-write handler. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @manual: In integration, send the same clipboard control sequence to classic and confirm no browser clipboard write occurs. -->

**Constraints:**

- OSC 52 accepts only the standard `c` selector, valid base64, valid UTF-8 text, and at most 64 KiB decoded content.
- Clipboard read queries and clipboard content are never logged.
- No second clipboard service is installed.

**Priority:** P1

**Dependencies:** [REQ-TERM-019](#req-term-019-terminal-websocket-control-frames-and-protocol-guards)

**Verification:** Automated parser tests plus manual browser permission verification.

**Status:** Implemented

---

### REQ-TERM-036: Browser pointer interaction with Herdr

**Intent:** Browser-hosted Herdr controls remain usable with hardware mouse and touch while classic terminal input stays unchanged.

**Applies To:** User

**Acceptance Criteria:**

1. Herdr owns ordinary right-click, with its configured passthrough gesture preserved. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: image/herdr/config.toml::right_click_passthrough_modifier --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (leaves contextmenu ownership to Herdr) -->
2. Classic retains Codeflare right-click paste. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (should read clipboard on right-click when clipboardAccess is enabled) -->
3. Hardware mouse clicks operate the addressed Herdr control. <!-- @impl: web-ui/src/lib/herdr-mouse.ts::attachHerdrMouseInput --> <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/lib/herdr-mouse.test.ts (encodes physical and synthesized left clicks as SGR terminal input) -->
4. Held-button mouse movement operates the addressed Herdr control. <!-- @impl: web-ui/src/lib/herdr-mouse.ts::attachHerdrMouseInput --> <!-- @test: web-ui/src/__tests__/lib/herdr-mouse.test.ts (encodes held-button movement and ignores movement without an active press) -->
5. Mouse wheels navigate the addressed Herdr control. <!-- @impl: web-ui/src/lib/herdr-mouse.ts::attachHerdrMouseInput --> <!-- @test: web-ui/src/__tests__/lib/herdr-mouse.test.ts (encodes wheel navigation and modifier-aware right clicks) -->
6. Stationary touch taps operate the addressed Herdr control. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @impl: web-ui/src/lib/herdr-mouse.ts::attachHerdrMouseInput --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (sends a stationary touch to the xterm screen only when enabled) -->
7. Vertical touch swipes navigate Herdr application views. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @impl: web-ui/src/lib/herdr-mouse.ts::attachHerdrMouseInput --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-017 AC1-AC2: routes Herdr swipes as SGR wheel input without xterm mouse tracking) -->

**Constraints:**

- Herdr pointer events use terminal-cell SGR reports through the existing terminal transport without a second browser protocol.
- The Herdr adapter does not alter classic mouse, wheel, selection, or paste behavior.

**Priority:** P1

**Dependencies:** [REQ-TERM-019](#req-term-019-terminal-websocket-control-frames-and-protocol-guards), [REQ-MOB-017](mobile.md#req-mob-017-fullscreen-application-touch-scrolling)

**Verification:** Automated pointer encoding and mode-isolation tests plus manual browser interaction verification.

**Status:** Implemented

---

### REQ-TERM-037: Browser keyboard interaction with Herdr

**Intent:** Browser-hosted Herdr receives its standard prefix without browser chrome consuming it.

**Applies To:** User

**Acceptance Criteria:**

1. In a Herdr session, `Ctrl+B` sends Herdr's canonical control prefix and suppresses the browser's conflicting bookmark action. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-037 AC1-AC2: sends the canonical Herdr prefix and leaves its action key to xterm) -->
2. Herdr continues to own action interpretation after the prefix, including managed Help at `prefix+?` and Settings at `prefix+s`. <!-- @impl: image/herdr/config.toml::keys --> <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-037 AC1-AC2: sends the canonical Herdr prefix and leaves its action key to xterm) --> <!-- @manual: Container-image CI validates the managed bindings with the pinned Herdr binary. -->
3. Classic sessions and unrelated modified keys retain existing xterm keyboard handling. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-037 AC3: preserves classic and unrelated modified key handling) -->

**Constraints:**

- Codeflare forwards only the canonical prefix byte; it does not duplicate Herdr's action map or add a second keyboard protocol.
- Browser-delivered keys are supported; operating-system-reserved combinations remain outside browser control.

**Priority:** P1

**Dependencies:** [REQ-TERM-019](#req-term-019-terminal-websocket-control-frames-and-protocol-guards), [REQ-TERM-006](#req-term-006-herdr-owns-in-session-terminal-topology)

**Verification:** Automated mode-isolation and packaged-config checks plus manual browser shortcut verification.

**Status:** Implemented

---

### REQ-TERM-023: Away-only agent notification delivery

**Intent:** Agent attention events are delivered only while every connected view of the originating terminal is away, without waking or extending the session container.

**Applies To:** User

**Acceptance Criteria:**

1. Exact reviewed Pi or Claude OSC 777 frames from terminal one create fixed four-field events; malformed, oversized, unknown, near-match, and non-primary-terminal frames create no event and never alter PTY bytes. <!-- @impl: host/src/agent-events.ts::OscAgentEventParser --> <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/agent-events.test.js (REQ-TERM-023 AC1 / H1: bounded stream-safe OSC 777 parser) --> <!-- @test: host/__tests__/session-wire-protocol.test.js (REQ-TERM-023 AC1 / REQ-TERM-028 AC1-AC4: Session owns primary-terminal event coordination) -->
2. Every attached client submits one event-specific disposition; any initial or granted-client late `suppress` cancels local display and undelivered fallback for that event. <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @impl: host/src/terminal-ws.ts::attachTerminalConnectionHandler --> <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: host/__tests__/agent-events.test.js (lets one active client suppress every device before any display grant) --> <!-- @test: host/__tests__/agent-events.test.js (accepts a late suppress from the granted client and never makes the event drain-eligible) --> <!-- @test: host/__tests__/terminal-agent-events.test.js (cannot use a socket attached to another Session to affect the originating queue) --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-023 AC2: submits late suppression when presence changes during display) -->
3. When every snapshotted client reports away, the host grants one local display; only the grantee displays and confirms, and absent confirmation enables fallback. <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @impl: web-ui/src/lib/agent-notifications.ts::showGrantedAgentEvent --> <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: host/__tests__/agent-events.test.js (grants exactly one display only after every snapshotted client reports away) --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (REQ-TERM-023 AC3/AC5: granted local display) --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (native agent notifications / REQ-TERM-023 AC2/AC3) -->
4. Zero-client and timed-out events enter the authenticated DO drain and remain re-offered until fully processed, acknowledged, or expired after 15 minutes. <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: host/__tests__/agent-events.test.js (REQ-TERM-023 AC2-AC4 / H2-H3: global client coordination) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-TERM-023 AC4 / D2-D4: drains, validates, enriches, sends, then ACK-clears on every running tick) -->
5. Every notification contains fixed reason text plus trusted Session identity; terminal or agent prose, names, paths, output, tool data, and arbitrary links never reach display. <!-- @impl: web-ui/src/lib/agent-notifications.ts::showGrantedAgentEvent --> <!-- @impl: src/lib/push-sender.ts::sendAgentEventPushes --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (REQ-TERM-023 AC3/AC5: granted local display) --> <!-- @test: src/__tests__/lib/push-sender.test.ts (sends only the fixed seven-field payload enriched from the DO-owned Session) -->
6. Notification coordination, polling, delivery, and worker handling never mutate user activity, extend idle time, wake a stopped container, or create notification history. <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @impl: web-ui/public/agent-notifications-sw.js::push --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-TERM-023 AC5: a stalled push provider cannot stop metrics or alarm re-arming) --> <!-- @test: src/__tests__/container-metrics.test.ts (D3/D4: notification polling never mutates activity or usage inputs) --> <!-- @test: web-ui/src/__tests__/lib/agent-notification-worker.test.ts (registers no fetch, cache, or sync handlers) -->

**Notes:** Partial pending deployed one-active-client suppression, all-away single local display, no-client Push fallback, bounded pickup residue, and no-wake/no-idle-extension evidence.

**Constraints:**

- Queue, drain, and per-user subscription counts are bounded at 16, 8, and 10; events expire after 15 minutes and provider pickup TTL is one hour.
- Delivery is at least once until the host receives an acknowledgement.
- Trusted session records determine every display-facing identity and path; terminal bytes do not.
- Client coordination is event-specific and Session-bound.

**Priority:** P1

**Dependencies:** [REQ-TERM-005](#req-term-005-herdr-runtime-and-configured-agent-startup), [REQ-SEC-023](security.md#req-sec-023-agent-notification-capability-boundaries), [REQ-SEC-024](security.md#req-sec-024-agent-notification-delivery-trust-boundaries)

**Verification:** Automated host, Worker, frontend, and service-worker tests plus deployed suppression, pickup, and no-wake checks.

**Status:** Partial

---

### REQ-TERM-028: Notification reconnect reconciliation and cancellation

**Intent:** Reconnecting terminal views reconcile unresolved attention events without treating transport attachment as active presence.

**Applies To:** User

**Acceptance Criteria:**

1. A newly attached client receives every unresolved event for the originating Session. <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/agent-events.test.js (REQ-TERM-028 AC1-AC4 / H4 and queue lifecycle bounds) --> <!-- @test: host/__tests__/session-wire-protocol.test.js (REQ-TERM-023 AC1 / REQ-TERM-028 AC1-AC4: Session owns primary-terminal event coordination) -->
2. Attachment without a suppress disposition preserves the event's fallback eligibility. <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @test: host/__tests__/agent-events.test.js (reconciles a newly attached away client without discarding unresolved fallback) -->
3. A newly attached client's event-specific suppress disposition cancels local display and undelivered fallback globally. <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/agent-events.test.js (lets a newly attached active client suppress an unresolved fallback event) --> <!-- @test: host/__tests__/session-wire-protocol.test.js (a new attachment reconciles the pending event before active presence can suppress it) -->
4. Classified user input cancels pending, eligible, and drained-unacknowledged events. <!-- @impl: host/src/session.ts::Session --> <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @test: host/__tests__/agent-events.test.js (classified input cancels pending, eligible, and drained-unacknowledged events) --> <!-- @test: host/__tests__/session-wire-protocol.test.js (classified user input cancels pending and drained-unacknowledged events) -->

**Notes:** Partial pending deployed hidden-reconnect fallback preservation and active-reconnect suppression evidence.

**Constraints:**

- Reconciliation remains event-specific and Session-bound.
- Already copied or provider-accepted delivery remains bounded pickup residue.

**Priority:** P1

**Dependencies:** [REQ-TERM-023](#req-term-023-away-only-agent-notification-delivery), [REQ-SEC-024](security.md#req-sec-024-agent-notification-delivery-trust-boundaries)

**Verification:** Automated host queue and Session protocol tests plus deployed reconnect acceptance.

**Status:** Partial

---

### REQ-TERM-025: Per-device notification enrollment

**Intent:** One explicit per-device switch owns browser Push enrollment and subscription repair.

**Applies To:** User

**Acceptance Criteria:**

1. One Settings switch per device is the only permission-request path. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (Agent notifications / REQ-TERM-025 AC1-AC5) -->
2. Enabling reports on only after re-registering an existing valid subscription with the current application-server key. <!-- @impl: web-ui/src/lib/agent-notifications.ts::setAgentNotificationsEnabled --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (re-registers an existing matching subscription before reporting enrollment on) -->
3. Otherwise enabling replaces stale capability state and completes permission, worker readiness, subscription, and authenticated registration in one gesture. <!-- @impl: web-ui/src/lib/agent-notifications.ts::setAgentNotificationsEnabled --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (enables in one gesture: permission, public config, subscribe, then authenticated save) --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (replaces an existing subscription whose application server key cannot match current config) -->
4. Disabling deletes the server registration before unsubscribing locally. <!-- @impl: web-ui/src/lib/agent-notifications.ts::setAgentNotificationsEnabled --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (disables by deleting server capability then unsubscribing locally) -->
5. Denied permission reads denied, while granted permission without a valid subscription reads off. <!-- @impl: web-ui/src/lib/agent-notifications.ts::agentNotificationsEnabled --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (reads on only when permission is granted and a valid subscription exists) --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (does not subscribe or save after permission denial) -->

**Notes:** Partial pending desktop, Android-class, and installed iOS PWA enrollment, denial, disable, and re-enrollment evidence.

**Constraints:**

- Browser permission is per origin and browser profile.
- Codeflare stores only the vendor Push subscription.

**Priority:** P1

**Dependencies:** [REQ-TERM-023](#req-term-023-away-only-agent-notification-delivery), [REQ-SEC-023](security.md#req-sec-023-agent-notification-capability-boundaries)

**Verification:** Automated enrollment tests plus deployed desktop/mobile acceptance.

**Status:** Partial

---

### REQ-TERM-027: Service-worker notification display and navigation

**Intent:** Browser Push displays only fixed valid notifications and opens only the originating canonical session.

**Applies To:** User

**Acceptance Criteria:**

1. Invalid, unknown, or unsafe notification payloads produce no display. <!-- @impl: web-ui/public/agent-notifications-sw.js::push --> <!-- @test: web-ui/src/__tests__/lib/agent-notification-worker.test.ts (REQ-TERM-027 AC1-AC2 / REQ-SEC-024 AC4: agent notification service worker push) -->
2. Receiving the same identifiable event again visibly presents the notification again. <!-- @impl: web-ui/public/agent-notifications-sw.js::push --> <!-- @test: web-ui/src/__tests__/lib/agent-notification-worker.test.ts (REQ-TERM-027 AC1-AC2 / REQ-SEC-024 AC4: agent notification service worker push) -->
3. Notification clicks select only a loaded user-owned session at the canonical same-origin session path. <!-- @impl: web-ui/src/lib/session-path.ts::parseSessionPath --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/public/agent-notifications-sw.js::notificationclick --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-TERM-027 AC3: canonical session deep links) --> <!-- @test: web-ui/src/__tests__/lib/agent-notification-worker.test.ts (REQ-TERM-027 AC3: canonical notification click navigation) -->

**Notes:** Partial pending desktop, Android-class, and installed iOS PWA display plus exact two-session click-routing evidence.

**Constraints:**

- Push display is best effort.
- The service worker adds no fetch, cache, or sync handler.
- Only an explicit same-origin notification click follows normal authenticated navigation.

**Priority:** P1

**Dependencies:** [REQ-TERM-023](#req-term-023-away-only-agent-notification-delivery), [REQ-TERM-025](#req-term-025-per-device-notification-enrollment), [REQ-SEC-024](security.md#req-sec-024-agent-notification-delivery-trust-boundaries)

**Verification:** Automated worker and navigation tests plus deployed desktop/mobile acceptance.

**Status:** Partial

---

### REQ-TERM-024: Pi native terminal notification producer

**Intent:** Pi emits only fixed inert attention signals and does not interfere with RPC transport.

**Applies To:** User

**Acceptance Criteria:**

1. Pi emits one fixed `input-required` signal for the validated ask-user event and ignores question content. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-024 AC1: emits one fixed input-required frame without question content) -->
2. Completion and failure frames contain only their fixed constants and exclude provider prose. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::READY_FOR_INPUT --> <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::TASK_FAILED --> <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-024 AC2: completion and failure frames are fixed and inert) -->
3. Pi registers no notification behavior and writes no terminal bytes in RPC mode. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-024 AC3: registers nothing and writes no bytes in RPC mode) -->

**Notes:** Implemented after the [deployed Pi notification acceptance evidence](../../documentation/lanes/preseed.md#pi-notification-acceptance-evidence).

**Constraints:** Prompts, model output, tool data, commands, file content, and credentials never enter producer payloads.

**Priority:** P1

**Dependencies:** [REQ-TERM-005](#req-term-005-tab-1-auto-starts-the-configured-agent), [REQ-TERM-023](#req-term-023-away-only-agent-notification-delivery)

**Verification:** Automated Pi extension tests plus deployed interactive-run verification.

**Status:** Implemented

---

### REQ-TERM-029: Pi inactivity-gated terminal completion

**Intent:** Pi emits completion or failure only after the interactive root has remained inactive.

**Applies To:** User

**Acceptance Criteria:**

1. Completion requires interactive lineage, a settled structured success, and five uninterrupted minutes without new input or agent activity. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::PI_IDLE_NOTIFICATION_DELAY_MS = 5 * 60_000 --> <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-029 AC1: emits completion only after five idle minutes) -->
2. Failure requires interactive lineage and a settled structured error, then waits for the same uninterrupted interval. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-029 AC2: delays structured failure until five idle minutes) -->
3. New input or agent activity restarts the five-minute inactivity interval after the continuation settles. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::PI_IDLE_NOTIFICATION_DELAY_MS = 5 * 60_000 --> <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-029 AC3: reactivation restarts five idle minutes after settlement) -->
4. A cancelled input request emits no completion or failure. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-029 AC4: cancelled input emits no terminal signal) -->
5. An aborted run emits no completion or failure. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-029 AC5: aborted run emits no terminal signal) -->
6. A settled run without interactive lineage emits no completion or failure. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-029 AC6: absent interactive lineage emits no terminal signal) -->

**Notes:** Implemented after the [deployed Pi notification acceptance evidence](../../documentation/lanes/preseed.md#pi-notification-acceptance-evidence).

**Constraints:** Input-required signals remain immediate under [REQ-TERM-024](#req-term-024-pi-native-terminal-notification-producer).

**Priority:** P1

**Dependencies:** [REQ-TERM-024](#req-term-024-pi-native-terminal-notification-producer)

**Verification:** Automated Pi extension timing tests plus deployed interactive-run verification.

**Status:** Implemented

---

### REQ-TERM-026: Claude native terminal notification producer

**Intent:** Claude contributes only its exact native permission signal without Codeflare focus synthesis or text inference.

**Applies To:** User

**Acceptance Criteria:**

1. In both Claude session modes, Claude alone emits its native permission notification; Codeflare adds no competing producer behavior. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (REQ-TERM-026 AC1: Claude keeps its native notification path without competing Codeflare behavior) -->
2. Only the exact reviewed Claude permission frame maps to `input-required`; every other Claude or near-match frame emits nothing. <!-- @impl: host/src/agent-events.ts::AGENT_EVENT_FRAMES --> <!-- @impl: host/src/agent-events.ts::OscAgentEventParser --> <!-- @test: host/__tests__/agent-events.test.js (REQ-TERM-026 AC2: maps only reviewed Pi and Claude frames and ignores every near-match) -->
3. Claude notification handling preserves focus-in and focus-out bytes and never synthesizes focus-out on detach. <!-- @impl: host/src/session.ts::stripTerminalResponses --> <!-- @test: host/__tests__/session-wire-protocol.test.js (REQ-TERM-026 AC3: Claude notification focus independence) -->

**Notes:** Partial pending a fresh terminal-one record of Claude's native permission frame and silence for unsupported notification kinds.

**Constraints:**

- The official Claude IDE extension remains checksum-pinned and unmodified.
- Unsupported producer kinds remain disabled rather than inferred from text.

**Priority:** P1

**Dependencies:** [REQ-TERM-005](#req-term-005-tab-1-auto-starts-the-configured-agent), [REQ-TERM-023](#req-term-023-away-only-agent-notification-delivery)

**Verification:** Automated host parser, Session input, and entrypoint settings tests plus deployed permission verification.

**Status:** Partial

---
