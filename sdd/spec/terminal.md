# Terminal

PTY management, immutable classic or Herdr terminal ownership, WebSocket transport, MultiView workspaces, browser terminal boundaries, and mobile/browser compatibility.

**Domain owner:** Frontend (SolidJS + xterm.js) + Container (terminal server)

### Key Concepts

- **PTY** -- Pseudo-terminal; the OS-level device that bridges a shell process to terminal I/O over the WebSocket.
- **WebSocket** -- The bidirectional transport carrying raw terminal data and JSON control messages between browser and container.
- **Terminal Mode** -- The immutable `classic` or `herdr` ownership choice stamped when a session is created; missing or invalid historical values resolve to `classic`.
- **Terminal Surface** -- One xterm.js and outer PTY. Classic sessions expose terminal IDs `1` through `6`; Herdr sessions expose only terminal ID `1`.
- **Herdr Runtime** -- The named, container-local terminal multiplexer that owns tabs, panes, splits, workspaces, shells, and agents inside an opt-in Herdr session.
- **MultiView** -- A virtual frontend workspace that displays one active surface from each of multiple existing backend sessions without creating another backend session.
- **VirtualKeyboard API** -- The browser API (`navigator.virtualKeyboard`) used to detect keyboard geometry changes and control `overlaysContent` behavior.
- **Touch Gesture** -- Swipe-based input on touchscreens, translated to arrow keys (horizontal) or terminal scroll (vertical).
- **Scroll Stability** -- The set of mechanisms (viewport overflow hidden, scroll-drop detection, programmatic suppression) that prevent the terminal from jumping during output bursts or keyboard transitions.

### Out of Scope

- Terminal recording and playback (session replay)
- Collaborative terminal sharing (multi-user viewing or input on the same PTY)
- Saved terminal command presets / header "bookmarks" (feature removed; see [changes.md](changes.md))
- Running Codeflare and Herdr topology controls simultaneously inside one session
- Native mobile app (Codeflare runs entirely in the mobile browser)
- Offline mobile support (requires active WebSocket connection to container)

### Domain Dependencies

- **Session Lifecycle** (container must be running) -- Terminal connections require an active, running container. Backend lifecycle authority is distinct from device-local connectivity.
- **Authentication** (WebSocket auth) -- WebSocket upgrade requests are authenticated via the Worker middleware and container auth token.
- **Terminal compatibility implementation** -- Mobile features extend xterm rendering/input through mobile.ts, touch-gestures.ts and terminal-mobile-input.ts; REQ-MOB identifiers and verification qualifiers are retained, not renumbered or promoted.

---

## Terminal ownership and runtime

<a id="req-term-001-up-to-6-terminal-tabs-per-session"></a>
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

6. Enterprise reconnect rebinds only the credential to verified same-owner authority, treating invalid context as same-generation revocation; the immutable principal and running compute remain unchanged. <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-ENTERPRISE-090: failed renewal revokes old authority while ordinary terminal remains usable) --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-ENTERPRISE-090: a changed human subject cannot replace the immutable same-email session principal) --> <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @impl: src/container/review-session-human.ts::bindReviewSessionHuman --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-TERM-002: same-owner warm reconnect refreshes %s authority without restarting compute) --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-ENTERPRISE-090: %s human reconnect cannot retain a previously valid sealed credential) -->
7. Unconfirmed or stale-generation credential revocation rejects reconnect with close code `1011` instead of forwarding it. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-ENTERPRISE-090: unconfirmed credential revocation rejects the reconnect rather than forwarding it) --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-ENTERPRISE-090: stale reconnect cannot revoke valid replacement-generation authority) -->

**Constraints:**

- Unavailable renewal warnings expose only a closed stage/failure classification, never credentials, identifiers, claims or arbitrary errors. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-ENTERPRISE-090: %s human reconnect cannot retain a previously valid sealed credential) --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-ENTERPRISE-090: a changed human subject cannot replace the immutable same-email session principal) -->
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

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-SESSION-012](session-lifecycle.md#req-session-012-transport-retry-never-invents-lifecycle-state)

**Verification:** Automated test ([terminal](../../web-ui/src/__tests__/stores/terminal.test.ts))

**Status:** Implemented

---

<a id="req-term-005-tab-1-auto-starts-the-configured-agent"></a>
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
- Herdr processes and runtime artifacts remain local; only [REQ-TERM-033](#req-term-033-durable-herdr-structural-session-recovery) snapshots enter R2, and no private Herdr interface reaches Worker routes.
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
6. Fresh Herdr Pi sessions do not report ready before Pi finishes initialization when supported readiness evidence is available. <!-- @impl: image/herdr/codeflare-herdr-terminal::run_agent --> <!-- @impl: image/herdr/codeflare-herdr-terminal::wait_for_live_pi --> <!-- @test: host/__tests__/herdr-launcher.test.js (waits for live Pi integration on a fresh start) -->
7. Unsupported or unavailable readiness evidence does not block access after normal fresh Pi startup. <!-- @impl: image/herdr/codeflare-herdr-terminal::supports_pi_live_readiness --> <!-- @impl: image/herdr/codeflare-herdr-terminal::run_agent --> <!-- @test: host/__tests__/herdr-launcher.test.js (uses regular fresh Pi startup when native readiness version changes) --> <!-- @test: host/__tests__/herdr-launcher.test.js (uses regular fresh Pi startup when the native readiness probe hangs) --> <!-- @test: host/__tests__/herdr-launcher.test.js (uses regular fresh Pi startup when pinned live readiness fails) -->

**Constraints:**

- Readiness uses the persisted session stamp rather than current preferences.

**Priority:** P0

**Dependencies:** [REQ-TERM-005](#req-term-005-herdr-runtime-and-configured-agent-startup), [REQ-SESSION-015](session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition)

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
5. With the pinned Pi integration, restored Pi panes delay readiness until every resumed Pi session has loaded its transcript and established live lifecycle authority. <!-- @impl: image/herdr/codeflare-herdr-terminal::wait_for_live_pi --> <!-- @test: host/__tests__/herdr-launcher.test.js (waits for live Pi integration before completing restored bootstrap) -->
6. If the versioned Pi readiness signal is unavailable, restored metadata retains the compatibility path to readiness. <!-- @impl: image/herdr/codeflare-herdr-terminal::wait_for_restored_agent --> <!-- @test: host/__tests__/herdr-launcher.test.js (falls back to persisted agent metadata when Pi lifecycle readiness is unavailable) -->
7. If live Pi readiness fails within its bounded wait, restored metadata retains the same compatibility path to readiness. <!-- @impl: image/herdr/codeflare-herdr-terminal::wait_for_restored_agent --> <!-- @test: host/__tests__/herdr-launcher.test.js (falls back to persisted metadata when pinned Pi live readiness fails) -->

**Constraints:**

- Snapshot durability follows the existing 15-minute bisync cadence, explicit Sync trigger, and final-sync boundary; abrupt loss may discard changes newer than the last successful sync.
- `session-history.json` remains excluded because terminal output may contain prompts, credentials, tokens, and command output.
- Recovery uses Herdr v0.8.2's official snapshot format; Codeflare defines no parallel snapshot schema.

**Priority:** P0

**Dependencies:** [REQ-TERM-005](#req-term-005-herdr-runtime-and-configured-agent-startup), [REQ-STOR-002](storage.md#req-stor-002-file-persistence-across-sessions), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated launcher and rclone-filter tests plus manual replacement acceptance.

**Status:** Implemented

---

<a id="req-term-007-tiling-layouts-2-split-3-split-4-grid"></a>
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

<a id="req-term-030-tiled-pane-focus-lifecycle"></a>
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

<a id="req-term-009-process-name-detection-via-control-messages"></a>
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

## Visible workspaces, focus and rendering compatibility

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

### REQ-TERM-043: Visible terminal readiness gating

**Intent:** Visible terminal panes adopt the prepared PTY as soon as the terminal service is available, while focus and display remain behind explicit readiness acknowledgement.

**Applies To:** User

**Acceptance Criteria:**

1. A visible initializing session opens no terminal connection before startup reaches `mounting`. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-043 AC1: does not connect before the terminal service reaches mounting) -->
2. At `mounting`, the visible pane creates exactly one startup terminal connection that remains unchanged through `ready`. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-043 AC2-AC3: keeps one unfocused startup attachment through ready) -->
3. The pane does not focus while readiness remains unacknowledged. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-043 AC2-AC3: keeps one unfocused startup attachment through ready) -->
4. OPEN displays a renderable selected terminal pane without requiring a page reload. <!-- @impl: web-ui/src/components/Terminal.tsx::Terminal --> <!-- @test: web-ui/src/__tests__/components/Terminal.test.tsx (REQ-TERM-043 AC4, AC7; REQ-TERM-044 AC2: OPEN creates and focuses a fresh renderable terminal) -->
5. An already-running visible session connects immediately. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-043 AC5: connects immediately when the session is already ready) -->
6. OPEN leaves terminal panes belonging to other sessions unchanged. <!-- @impl: web-ui/src/components/Layout.tsx::handleOpenSessionById --> <!-- @impl: web-ui/src/components/Terminal.tsx::Terminal --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-TERM-043 AC6: OPEN dismisses readiness without directly manipulating transport) --> <!-- @test: web-ui/src/__tests__/components/Terminal.test.tsx (REQ-TERM-043 AC6: OPEN leaves foreign-session terminal instances unchanged) -->
7. After OPEN, the selected terminal pane receives focus. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/components/Terminal.test.tsx (REQ-TERM-043 AC4, AC7; REQ-TERM-044 AC2: OPEN creates and focuses a fresh renderable terminal) -->

**Constraints:** The three-minute startup guard, bounded prewarm orphan window, and MultiView visible-pane ownership remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-SESSION-015](session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition), [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

**Verification:** Automated hook tests

**Status:** Implemented

---

### REQ-TERM-044: Terminal restore and readiness rendering

**Intent:** Terminal surfaces preserve their current screen across genuine reattachments and complete readiness display transitions when layout is temporarily unavailable.

**Applies To:** User

**Acceptance Criteria:**

1. Reattaching an existing PTY restores its current serialized screen before normal output continues. <!-- @impl: host/src/session.ts::attach --> <!-- @test: host/__tests__/session-wire-protocol.test.js (attach() sends a restore frame as JSON carrying type="restore" once buffer has state) -->
2. OPEN completes and the terminal remains renderable when terminal layout dimensions are not yet available. <!-- @impl: web-ui/src/components/Terminal.tsx::Terminal --> <!-- @impl: web-ui/src/lib/xterm-internals.ts::resyncViewportScrollState --> <!-- @test: web-ui/src/__tests__/components/Terminal.test.tsx (REQ-TERM-043 AC4, AC7; REQ-TERM-044 AC2: OPEN creates and focuses a fresh renderable terminal) --> <!-- @test: web-ui/src/__tests__/lib/xterm-internals.test.ts (REQ-TERM-044 AC2: does not abort OPEN when viewport dimensions are not initialized yet) -->

**Constraints:** Rendering recovery must preserve the transport ownership defined by [REQ-TERM-043](#req-term-043-visible-terminal-readiness-gating).

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-043](#req-term-043-visible-terminal-readiness-gating)

**Verification:** Automated host wire-protocol and frontend terminal-internals tests.

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
3. Manual normal-buffer ownership defers streamed output; returning to bottom releases it progressively, and renewed upward scrolling defers the remainder. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-014 AC3: defers streamed output while the user owns the viewport and flushes on bottom return) --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-014 AC3: releases the hold in bounded slices and re-defers when the reader scrolls up mid-release) -->
4. Returning a manually owned viewport to the live bottom releases that ownership and restores bottom following for later output. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-TERM-014 AC1/AC2: returning to bottom releases manual ownership and restores bottom following) -->
5. Output held past the cap discards oldest whole atomic units, including an individually over-cap unit rather than retaining it; held output is never written while manual ownership is active. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-014 AC5: a cap-exceeding hold drops oldest chunks and never writes through a reader) -->
6. User input of any route while reading normal-buffer scrollback re-anchors the viewport to the live bottom; alternate-buffer applications are unaffected. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-014 AC6: user input while reading scrollback re-anchors the viewport to the live bottom) -->
7. Mouse-wheel scrollback navigation in the normal buffer moves the viewport by exactly the wheel delta; alternate-buffer and zoom-modified wheel events pass through to the application untouched. <!-- @impl: web-ui/src/lib/terminal-wheel.ts::attachWheelScrolling --> <!-- @test: web-ui/src/__tests__/lib/terminal-wheel.test.ts (terminal-wheel / REQ-TERM-014 AC7 buffer-authoritative wheel scrolling) -->

**Constraints:**

- The write buffer defers, drops oldest held data, or writes; it never scrolls the viewport.
- Output-driven trimming stays delegated to xterm.
- Navigation and anchoring scroll the buffer service with paired repaint; `scrollOnUserInput` stays disabled; refits retaining reader position re-command DOM scroll state ([AD105](../../documentation/decisions/README.md#ad105-streamed-output-defers-while-the-user-reads-scrollback-keyboard-open-swipes-are-always-terminal-input), [AD110](../../documentation/decisions/README.md#ad110-terminal-scrolling-is-buffer-authoritative-on-every-route-held-output-ring-drops)).
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

**Dependencies:** [REQ-SESSION-018](session-lifecycle.md#req-session-018-d1-lifecycle-evidence-is-generation-fenced)

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
6. A visible Herdr surface returning from browser background forces a full current-pane repaint even when its fitted dimensions did not change. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (forces a repaint and same-size PTY resize when a hidden page becomes visible) -->
7. A replacement pane that reconnects before the previous owner disconnects uses its latest fitted dimensions once resize authority transfers, including subsequent terminal restoration. <!-- @impl: host/src/session.ts::Session.resize --> <!-- @impl: host/src/session.ts::Session.detach --> <!-- @test: host/__tests__/session-resize-authority.test.js (REQ-TERM-016: applies a replacement pane resize when authority transfers after overlapping reconnects) -->

**Constraints:**

- Hidden terminal preservation cannot be used as an instant-switching optimization if it opens a WebSocket.
- Dashboard status must remain a polling/storage concern and must not depend on terminal component side effects.

**Priority:** P0

**Dependencies:** [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

**Verification:** Automated test ([TerminalArea](../../web-ui/src/__tests__/components/TerminalArea.test.tsx), [Hook tests](../../web-ui/src/__tests__/hooks/useTerminal.test.ts), [Terminal store tests](../../web-ui/src/__tests__/stores/terminal.test.ts), [Layout tests](../../web-ui/src/__tests__/components/Layout.test.tsx), [Resize authority test](../../host/__tests__/session-resize-authority.test.js))

**Status:** Implemented

---

### REQ-TERM-017: MultiView Pane Focus and Input Routing

**Intent:** Within a MultiView workspace ([REQ-TERM-012](#req-term-012-multiview-virtual-session-workspace)), activating a pane by click or touch changes focus only without remounting or reconnecting, each member exposes exactly one terminal surface with no nested tab controls, and keyboard / floating-button input targets the focused pane even when no single session is active.

**Applies To:** User

**Acceptance Criteria:**

1. Clicking a MultiView pane changes the focused pane. <!-- @impl: web-ui/src/components/TerminalGrid.tsx::TerminalGrid --> <!-- @test: web-ui/src/__tests__/components/TerminalGrid.test.tsx (REQ-TERM-007: renders the requested layout slots and routes pane clicks) -->
2. Touching a MultiView pane changes the focused pane. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-017: routes direct terminal touch activation to MultiView pane focus) --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-022 AC1/AC3: activates the pane and snaps Pi fullscreen history before opening mobile input) -->
3. Changing focused pane does not remount panes or reconnect their WebSockets. <!-- @impl: web-ui/src/components/TerminalArea.tsx::multiViewGridPanes --> <!-- @impl: web-ui/src/components/TerminalArea.tsx::sessionNamesById --> <!-- @impl: web-ui/src/components/TerminalGrid.tsx::TerminalGrid --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-012: changes MultiView pane focus without remounting terminal panes) -->
4. Each MultiView member gets exactly one terminal surface. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-012: renders one connected terminal pane for each visible MultiView member) -->
5. MultiView displays no nested terminal tab controls. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-012: renders one connected terminal pane for each visible MultiView member) -->
6. Keyboard input targets the focused MultiView pane even though no single session is active. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (REQ-TERM-017 AC6: sends keyboard input only to the focused MultiView pane without an active session) -->
7. Floating-button input targets the focused MultiView pane even though no single session is active. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (REQ-TERM-012: sends floating-button keys to the focused MultiView pane when activeSessionId is null) -->

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

## Herdr browser compatibility

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

**Intent:** Explicit Herdr copy and paste actions bridge the browser clipboard while retaining bounded OSC 52 parsing and browser permission authority.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal clipboard parser accepts bounded standard-selector base64 containing valid UTF-8. <!-- @impl: web-ui/src/lib/osc52.ts::parseOsc52ClipboardWrite --> <!-- @test: web-ui/src/__tests__/lib/osc52.test.ts (decodes a bounded standard clipboard UTF-8 write) -->
2. The parser rejects reads, malformed data, unsupported selectors, and invalid UTF-8. <!-- @impl: web-ui/src/lib/osc52.ts::parseOsc52ClipboardWrite --> <!-- @test: web-ui/src/__tests__/lib/osc52.test.ts (rejects query, selector, malformed, or invalid UTF-8 payload %s) -->
3. The parser rejects decoded content above the fixed byte limit. <!-- @impl: web-ui/src/lib/osc52.ts::parseOsc52ClipboardWrite --> <!-- @test: web-ui/src/__tests__/lib/osc52.test.ts (rejects decoded content above the fixed byte limit) -->
4. Herdr sessions forward accepted OSC 52 writes to the browser clipboard even when the separate desktop right-click paste setting is disabled, because Herdr copy is an explicit user action. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-032: writes Herdr OSC 52 copy output even when desktop paste access is disabled) -->
5. Classic sessions do not install the Herdr clipboard-write handler. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @manual: In integration, send the same clipboard control sequence to classic and confirm no browser clipboard write occurs. -->
6. `Ctrl+V` or `Cmd+V` reads clipboard text during the browser key gesture and pastes it into the active terminal. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (pastes browser clipboard text through xterm on Ctrl+V) -->

**Constraints:**

- OSC 52 accepts only the standard `c` selector, valid base64, valid UTF-8 text, and at most 64 KiB decoded content.
- Browser clipboard permission remains authoritative.
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
6. With the keyboard closed or open, a stationary touch activates the addressed Herdr control exactly once. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @impl: web-ui/src/lib/herdr-mouse.ts::sendHerdrTap --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-020 AC1: forwards one deterministic tap and suppresses compatibility mouse events) --> <!-- @test: web-ui/src/__tests__/lib/herdr-mouse.test.ts (sends a touch tap as one press/release pair at one computed cell) --> <!-- @manual: On Samsung Internet with the keyboard closed and open, tap Pi input and Herdr controls and confirm each activates once. -->
7. Vertical touch swipes send proportional wheel steps to Herdr and stop at release. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-017 AC1-AC2: routes proportional Herdr wheel steps without inertia) -->

**Constraints:**

- Herdr pointer events use terminal-cell SGR reports through the existing terminal transport without a second browser protocol.
- The Herdr adapter does not alter classic mouse, wheel, selection, or paste behavior.

**Priority:** P1

**Dependencies:** [REQ-TERM-019](#req-term-019-terminal-websocket-control-frames-and-protocol-guards), [REQ-MOB-017](#req-mob-017-fullscreen-application-touch-scrolling), [REQ-MOB-020](#req-mob-020-terminal-touch-activation)

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

### REQ-TERM-040: Stable Herdr pane scrollback

**Intent:** Keep Pi history visually stable in Herdr by letting Pi own its fullscreen transcript while Codeflare transports every Herdr differential frame intact.

**Applies To:** User

**Acceptance Criteria:**

1. A fresh Pi launched by a Herdr session starts in Pi fullscreen mode. <!-- @impl: image/herdr/codeflare-herdr-terminal::bootstrap --> <!-- @test: host/__tests__/herdr-launcher.test.js (waits for live Pi integration on a fresh start) -->
2. Complete Herdr screen updates are presented on the standard output schedule and in arrival order. <!-- @impl: web-ui/src/stores/terminal-output.ts::scheduleWrite --> <!-- @test: web-ui/src/__tests__/stores/herdr-output-delivery.test.ts (delivers every complete frame on schedule and in order) -->
3. While Pi output continues, Pi's application-owned fullscreen transcript preserves a user-selected historical viewport without mixed rows or a click-to-repair step. <!-- @manual: On Samsung Internet, scroll above bottom during Pi output and confirm the historical viewport remains stable until explicitly moved. -->

**Constraints:**

- Herdr remains an unmodified release binary.
- Codeflare does not expose Herdr socket paths or pane identifiers to the browser.
- Classic retains its existing main-screen output hold and scroll behavior.

**Priority:** P0

**Dependencies:** [REQ-TERM-008](#req-term-008-write-batching-at-30fps), [REQ-TERM-021](#req-term-021-synchronized-output-frame-atomicity), [REQ-MOB-017](#req-mob-017-fullscreen-application-touch-scrolling)

**Verification:** Automated launcher and ordered-frame tests plus manual Samsung Internet viewport verification.

**Status:** Implemented

---

### REQ-TERM-041: Rejected Herdr clipboard recovery

**Intent:** Recover the latest rejected asynchronous Herdr clipboard write through the next trusted Paste gesture without allowing stale failures to replace newer clipboard state.

**Applies To:** User

**Acceptance Criteria:**

1. The next trusted floating Paste control pastes the latest retained rejected text exactly once into the active terminal. <!-- @impl: web-ui/src/lib/osc52.ts::retainFailedClipboardWrite --> <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::pasteFromClipboard --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (REQ-TERM-041: retries a rejected OSC 52 copy during trusted paste and pastes retained text) -->
2. The same trusted Paste control retries writing the latest retained text to the browser clipboard. <!-- @impl: web-ui/src/lib/osc52.ts::beginClipboardWrite --> <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::pasteFromClipboard --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (REQ-TERM-041: retries a rejected OSC 52 copy during trusted paste and pastes retained text) -->
3. An older rejected write cannot replace newer retained clipboard state. <!-- @impl: web-ui/src/lib/osc52.ts::retainFailedClipboardWrite --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (does not retain an older failed write after a newer write succeeds) -->

**Constraints:**

- Browser clipboard permission remains authoritative.
- Retained clipboard content stays browser-local and is never logged.
- No second clipboard service is installed.

**Priority:** P1

**Dependencies:** [REQ-TERM-032](#req-term-032-herdr-clipboard-compatibility-boundary)

**Verification:** Automated trusted-gesture, exact-once paste, and latest-write ordering tests.

**Status:** Implemented

---

### REQ-TERM-042: Browser terminal link activation

**Intent:** Links detected in terminal output open through one browser-owned path in Classic and Herdr sessions.

**Applies To:** User

**Acceptance Criteria:**

1. A hardware Ctrl-click or Cmd-click on a Herdr link opens it once without sending SGR input, including after same-cell pointer jitter. <!-- @impl: web-ui/src/lib/herdr-mouse.ts::attachHerdrMouseInput --> <!-- @impl: web-ui/src/lib/terminal-link-provider.ts::registerMultiLineLinkProvider --> <!-- @test: web-ui/src/__tests__/lib/herdr-mouse.test.ts (REQ-TERM-042 AC1: opens Ctrl-click and Cmd-click links once without sending terminal input) --> <!-- @test: web-ui/src/__tests__/lib/herdr-mouse.test.ts (REQ-TERM-042 AC1: tolerates same-cell pointer jitter during modified link activation) -->
2. Pointer movement into another terminal cell after a modified Herdr link press cancels activation. <!-- @impl: web-ui/src/lib/herdr-mouse.ts::attachHerdrMouseInput --> <!-- @test: web-ui/src/__tests__/lib/herdr-mouse.test.ts (REQ-TERM-042 AC2: cancels a modified link click after cross-cell movement without leaking mouseup) -->
3. A stationary mobile tap on a Herdr link opens it once. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-042 AC3/AC4: opens a touched link without terminal touch side effects) -->
4. Mobile link activation leaves terminal input, fullscreen history, and keyboard focus unchanged. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-042 AC3/AC4: opens a touched link without terminal touch side effects) -->
5. A modified non-link hardware click continues to send its Herdr SGR press and release. <!-- @impl: web-ui/src/lib/herdr-mouse.ts::attachHerdrMouseInput --> <!-- @test: web-ui/src/__tests__/lib/herdr-mouse.test.ts (REQ-TERM-042 AC5: keeps modified non-link clicks in Herdr) -->

**Constraints:** URL reconstruction and opening remain owned by the existing terminal link provider.

**Priority:** P1

**Dependencies:** [REQ-TERM-036](#req-term-036-browser-pointer-interaction-with-herdr), [REQ-AGENT-013](agents.md#req-agent-013-browser-shim-for-oauth-flows)

**Verification:** Automated link lookup, desktop pointer, and mobile touch tests plus manual browser verification.

**Status:** Implemented

---

## Attention notification compatibility

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

**Intent:** When Push sender configuration exists, one explicit per-device switch owns browser Push enrollment and subscription repair.

**Applies To:** User

**Acceptance Criteria:**

1. One Settings switch per device is the only permission-request path. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (Agent notifications / REQ-TERM-025 AC1-AC6) -->
2. Enabling reports on only after re-registering an existing valid subscription with the current application-server key. <!-- @impl: web-ui/src/lib/agent-notifications.ts::setAgentNotificationsEnabled --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (re-registers an existing matching subscription before reporting enrollment on) -->
3. Otherwise enabling replaces stale capability state and completes permission, worker readiness, subscription, and authenticated registration in one gesture. <!-- @impl: web-ui/src/lib/agent-notifications.ts::setAgentNotificationsEnabled --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (enables in one gesture: permission, public config, subscribe, then authenticated save) --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (replaces an existing subscription whose application server key cannot match current config) -->
4. Disabling deletes the server registration before unsubscribing locally. <!-- @impl: web-ui/src/lib/agent-notifications.ts::setAgentNotificationsEnabled --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (disables by deleting server capability then unsubscribing locally) -->
5. Denied permission reads denied, while granted permission without a valid subscription reads off. <!-- @impl: web-ui/src/lib/agent-notifications.ts::agentNotificationsEnabled --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (reads on only when permission is granted and a valid subscription exists) --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (does not subscribe or save after permission denial) -->
6. Settings omits the notification control when the authenticated sender-config route reports that notification delivery is not configured. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (Agent notifications / REQ-TERM-025 AC1-AC6) -->

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

<a id="req-term-024-native-agent-terminal-notification-producers"></a>
### REQ-TERM-024: Pi native terminal notification producer

**Intent:** Pi emits only its fixed, immediate input-required signal and does not infer completion or interfere with RPC transport.

**Applies To:** User

**Acceptance Criteria:**

1. Pi emits one fixed `input-required` signal for the validated ask-user event and ignores question content. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-024 AC1: emits one fixed input-required frame without question content) -->
2. One foreground run emits at most one input-required signal. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (emits at most one needs-input event per foreground run) -->
3. Pi registers no notification behavior and writes no terminal bytes in RPC mode. <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @test: src/__tests__/lib/pi-native-notifications.test.ts (REQ-TERM-024 AC3: registers nothing and writes no bytes in RPC mode) -->

**Notes:** Herdr completion authority is documented at [Herdr attention and completion](../../documentation/lanes/terminal-and-ide.md#herdr-attention-and-completion).

**Constraints:** Prompts, model output, tool data, commands, file content, and credentials never enter producer payloads.

**Priority:** P1

**Dependencies:** [REQ-TERM-005](#req-term-005-herdr-runtime-and-configured-agent-startup), [REQ-TERM-023](#req-term-023-away-only-agent-notification-delivery)

**Verification:** Automated Pi extension tests plus deployed interactive-run verification.

**Status:** Implemented

---

### REQ-TERM-029: Herdr status-gated terminal completion

**Intent:** Completion notifications must follow Herdr's semantic agent status after a sustained idle period, not inferred Pi lifecycle timing.

**Applies To:** User

**Acceptance Criteria:**

1. After at least one tracked Pi or Claude pane is `working`, all tracked panes becoming `idle` or `done` starts one ten-minute completion timer. <!-- @impl: host/src/herdr-agent-status.ts::HerdrCompletionDelay --> <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @test: host/__tests__/herdr-agent-status.test.js (subscribes to every Herdr agent and waits until all panes are ready) -->
2. Changes between `idle` and `done` while every tracked pane remains ready preserve the existing timer. <!-- @impl: host/src/herdr-agent-status.ts::HerdrCompletionDelay --> <!-- @test: host/__tests__/herdr-agent-status.test.js (starts ten minutes at working→idle/done and preserves idle↔done) -->
3. Any tracked pane entering `working` cancels the timer; all panes must become ready again to receive a fresh ten minutes. <!-- @impl: host/src/herdr-agent-status.ts::HerdrCompletionDelay --> <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @test: host/__tests__/herdr-agent-status.test.js (cancels on working snapshots and requires a fresh ten idle minutes) --> <!-- @test: host/__tests__/herdr-agent-status.test.js (subscribes to every Herdr agent and waits until all panes are ready) -->
4. Timer expiry emits `task-completed` only while every tracked pane remains `idle` or `done`. <!-- @impl: host/src/herdr-agent-status.ts::HerdrCompletionDelay --> <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @test: host/__tests__/herdr-agent-status.test.js (subscribes to every Herdr agent and waits until all panes are ready) -->
5. An initial all-ready snapshot never starts completion timing. <!-- @impl: host/src/herdr-agent-status.ts::HerdrCompletionDelay --> <!-- @test: host/__tests__/herdr-agent-status.test.js (does not notify from an initial idle snapshot or while blocked/unknown) -->
6. A snapshot with no recognized Pi or Claude panes never starts completion timing. <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @test: host/__tests__/herdr-agent-status.test.js (does not notify when the snapshot has no recognized agents) -->
7. Completion timing does not run while any tracked pane is `blocked` or `unknown`. <!-- @impl: host/src/herdr-agent-status.ts::HerdrCompletionDelay --> <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @test: host/__tests__/herdr-agent-status.test.js (preserves observed work through blocked and unknown until ready) -->

**Constraints:**

- The ten-minute timer runs only in the container host and does not extend user activity or container lifetime.
- Validated input-required signals remain immediate under [REQ-TERM-024](#req-term-024-pi-native-terminal-notification-producer).
- Classic mode has no completion producer under [REQ-TERM-024](#req-term-024-pi-native-terminal-notification-producer).

**Priority:** P1

**Dependencies:** [REQ-TERM-005](#req-term-005-herdr-runtime-and-configured-agent-startup), [REQ-TERM-023](#req-term-023-away-only-agent-notification-delivery), [REQ-TERM-024](#req-term-024-pi-native-terminal-notification-producer)

**Verification:** Automated Herdr status, host queue, and Pi extension tests.

**Status:** Implemented

---

### REQ-TERM-038: Herdr semantic status owns completion readiness

**Intent:** Codeflare must consume the same semantic status that Herdr renders instead of reconstructing foreground and background activity.

**Applies To:** System

**Acceptance Criteria:**

1. Herdr mode snapshots every recognized Pi or Claude pane across tabs and splits. <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @test: host/__tests__/herdr-agent-status.test.js (subscribes to every Herdr agent and waits until all panes are ready) -->
2. The host subscribes to each pane's public `pane.agent_status_changed` event. <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @test: host/__tests__/herdr-agent-status.test.js (subscribes to every Herdr agent and waits until all panes are ready) -->
3. The initial aggregate status establishes a baseline and never produces completion by itself. <!-- @impl: host/src/herdr-agent-status.ts::HerdrCompletionDelay --> <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @test: host/__tests__/herdr-agent-status.test.js (does not notify from an initial idle snapshot or while blocked/unknown) -->
4. Any `working` pane cancels queued completion events without cancelling input-required events. <!-- @impl: host/src/herdr-agent-status.ts::HerdrCompletionDelay --> <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @impl: host/src/session.ts::Session --> <!-- @impl: host/src/agent-events.ts::AgentEventQueue --> <!-- @test: host/__tests__/herdr-agent-status.test.js (subscribes to every Herdr agent and waits until all panes are ready) --> <!-- @test: host/__tests__/agent-events.test.js (working status cancels queued completion without cancelling needs-input) -->
5. After a bounded snapshot failure, tracked-pane lifecycle event, malformed status event, or disconnect, the host reconnects and snapshots status authority before producing completion. <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @test: host/__tests__/herdr-agent-status.test.js (reconnects after a bounded unanswered snapshot) --> <!-- @test: host/__tests__/herdr-agent-status.test.js (resnapshots after tracked-pane lifecycle events) --> <!-- @test: host/__tests__/herdr-agent-status.test.js (reconnects after a malformed subscribed status event or disconnect) -->

**Constraints:**

- Herdr remains an unmodified pinned binary; only its packaged public socket schema is consumed.
- Malformed, oversized, unavailable, or interrupted API streams fail closed and reconnect.
- Browser messages never expose the Herdr socket path or pane identifier.

**Priority:** P1

**Dependencies:** [REQ-TERM-029](#req-term-029-herdr-status-gated-terminal-completion), [REQ-OPS-055](operations.md#req-ops-055-herdr-release-integration)

**Verification:** Automated socket, timer, queue, and packaged-schema tests.

**Status:** Implemented

---

### REQ-TERM-039: Herdr completion delivery is readiness-oriented

**Intent:** Eligible Herdr completion uses fixed copy that reflects configured-agent readiness.

**Applies To:** User

**Acceptance Criteria:**

1. An eligible delayed Herdr completion becomes available to normal notification delivery. <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> <!-- @impl: host/src/herdr-agent-status.ts::createHerdrAgentStatusCallbacks --> <!-- @impl: host/src/server.ts --> <!-- @test: host/__tests__/herdr-agent-status.test.js (routes Herdr completion to primary session notification delivery) -->
2. Local display labels Pi completion `Ready for input`. <!-- @impl: web-ui/src/lib/agent-notifications.ts::showGrantedAgentEvent --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (REQ-TERM-039 AC2: labels local Pi completion as ready for input) -->
3. Push display labels Pi completion `Ready for input`. <!-- @impl: web-ui/public/agent-notifications-sw.js::push --> <!-- @test: web-ui/src/__tests__/lib/agent-notification-worker.test.ts (REQ-TERM-039 AC3: labels Pi Push completion as ready for input) -->
4. Local display retains `Task completed` for Claude completion. <!-- @impl: web-ui/src/lib/agent-notifications.ts::showGrantedAgentEvent --> <!-- @test: web-ui/src/__tests__/lib/agent-notifications.test.ts (REQ-TERM-039 AC4: keeps local Claude completion copy task-oriented) -->
5. Push display retains `Task completed` for Claude completion. <!-- @impl: web-ui/public/agent-notifications-sw.js::push --> <!-- @test: web-ui/src/__tests__/lib/agent-notification-worker.test.ts (REQ-TERM-039 AC5: keeps Claude Push completion copy task-oriented) -->

**Constraints:** Display reason text remains fixed and excludes provider, task, and tool content.

**Priority:** P1

**Dependencies:** [REQ-TERM-023](#req-term-023-away-only-agent-notification-delivery), [REQ-TERM-031](#req-term-031-herdr-notification-compatibility-boundary), [REQ-TERM-038](#req-term-038-herdr-semantic-status-owns-completion-readiness)

**Verification:** Automated Herdr status transport, local-display, and Push-display tests plus deployed browser verification.

**Status:** Implemented

---

### REQ-TERM-026: Claude native terminal notification producer

**Intent:** Claude contributes only its exact native permission signal without Codeflare focus synthesis or text inference.

**Applies To:** User

**Acceptance Criteria:**

1. In both Claude session modes, Claude alone emits its native permission notification; Codeflare adds no competing producer behavior. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (REQ-TERM-026 AC1: Claude keeps native Ghostty notifications and adds only the fixed Herdr permission hook) -->
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

## Device-local lifecycle presentation

### REQ-TERM-045: Local terminal presence presents ACTIVE or IDLE

**Intent:** Terminal status describes this device's socket while preserving the shared D1 lifecycle and mounted workspace through uncertainty.

**Applies To:** User

**Acceptance Criteria:**

1. Backend `running` with this device's terminal WebSocket connected renders green ACTIVE. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->
2. Backend `running` without this device's terminal WebSocket connected renders blue IDLE. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->
3. ACTIVE and IDLE are never persisted or inferred for another device; devices may differ while agreeing on backend lifecycle. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->
4. Backend `starting` and `unreachable` render yellow starting/recovery presentation, and `stopped` renders gray. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->
5. During `unreachable`, retries use bounded jitter and terminal objects, buffers, tabs, tiling, selection and scrollback remain mounted. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->
6. Countdown expiry changes recovery messaging only; disposal requires newer authoritative `stopping`/`stopped` or deletion evidence. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->
7. D1 status failure retains the last ordered view and mounted workspace and presents a distinct status-unavailable notice. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->

**Constraints:** Classified input and idle timeout do not use ACTIVE/IDLE or socket presence as activity evidence.

**Priority:** P0

**Dependencies:** [REQ-SESSION-010](session-lifecycle.md#req-session-010-session-lifecycle-is-observable-from-one-d1-projection), [REQ-SESSION-012](session-lifecycle.md#req-session-012-transport-retry-never-invents-lifecycle-state)

**Verification:** Planned cross-device, recovery, countdown and D1-outage frontend tests.

**Status:** Planned

---

<a id="mobile-terminal"></a>
## Mobile viewport, focus and input compatibility

### REQ-MOB-001: Terminal fully usable on mobile devices

**Intent:** The terminal must be fully functional on phones and tablets, providing a usable coding experience without requiring a desktop browser.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal renders correctly on mobile viewports (phones and tablets). <!-- @impl: web-ui/src/lib/mobile.ts::isMobile --> <!-- @manual: Open the deployed terminal at phone and tablet viewport widths and confirm xterm renders without clipping or overflow. -->
2. Text input, command execution, and output display work identically to desktop except where touch interaction necessarily differs. <!-- @manual -->
3. On the deployed worker, a user can open a terminal, enter and execute a command, observe its output, and navigate scrollback at supported phone and tablet viewport widths. <!-- @manual: On the deployed worker at supported phone and tablet viewport widths, open a terminal, execute a command that emits multiple screens of output, confirm the output renders, and navigate its scrollback. -->
4. Terminal dimensions are recalculated on every viewport change (virtual keyboard open/close, orientation change, resize), keeping the layout free of visual corruption. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (REQ-MOB-001 AC4: visualViewport resize event triggers keyboard state update (fallback path)) -->
5. The terminal layout recalculation is skipped when the terminal container has no visible height, preventing row calculation corruption on inactive terminals. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-001 AC5: skips the keyboard refit (no fit, no PTY resize) when the container has zero visible height) --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-001 AC5: skips the deferred font-ready refit when the container has zero visible height) -->
6. Floating page controls navigate normal terminal scrollback through xterm's buffer scroll pipeline with buffer-derived deltas. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (REQ-MOB-001 AC6: navigates normal-buffer pages through the buffer scroll pipeline) -->
7. Floating page controls send PageUp/PageDown input to navigate alternate-screen application history. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (REQ-MOB-001 AC7: sends PageUp and PageDown to an alternate-screen application) -->

**Constraints:**

- Mobile-specific code paths activate only on touch devices.
- Mobile keyboard and layout state is driven by browser events, not polling or timers.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated test ([Mobile behavior](../../web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts), [terminal lifecycle](../../web-ui/src/__tests__/hooks/useTerminal.test.ts), [page controls](../../web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx)); deployed phone and tablet interaction verified manually

**Status:** Implemented

---

### REQ-MOB-002: Virtual keyboard opens reliably on tap

**Intent:** Tapping the terminal must reliably open the device's virtual keyboard, and the terminal must resize correctly to accommodate it.

**Applies To:** User

**Acceptance Criteria:**

1. The virtual keyboard overlay is activated before terminal focus to prevent keyboard/layout race conditions. <!-- @impl: web-ui/src/lib/mobile.ts::enableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
2. The overlay mode is disabled on terminal exit so other inputs receive normal browser resizing. <!-- @impl: web-ui/src/lib/mobile.ts::disableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
3. Keyboard height changes are detected via the browser's VirtualKeyboard geometry change event. <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
4. Terminal height is reduced by the keyboard height so content is not obscured. <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
5. Focus state detection uses a live browser query rather than a cached value. <!-- @impl: web-ui/src/lib/mobile.ts::isFocusOnTerminalInput --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
6. Terminal touch events cannot reach document listeners; outside touches remain unchanged, and cleanup removes the propagation shield. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)) -->

**Constraints:**

- The overlay mode is only re-stamped on genuine state changes; redundant no-op toggles must not restart the stale-event ignore window.
- The stale-event ignore window applies only to genuine toggles.
- The touch-propagation shield must run in bubble phase so the capture-phase swipe/scroll handlers ([REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll)) always execute first; `stopPropagation` (never `preventDefault`) is required so the browser's tap→click synthesis keeps working.

**Priority:** P0

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices)

**Verification:** Automated test ([Integration test](../../web-ui/src/__tests__/lib/mobile.test.ts))

**Status:** Implemented

---

### REQ-MOB-016: Mobile Terminal Input Compositor and Autocorrect Controls

**Intent:** Mobile terminal input must suppress native browser/IME behaviours that interfere with terminal typing while preserving the terminal's own gesture handling.

**Applies To:** User

**Acceptance Criteria:**

1. An isolated compositor context prevents the Android IME native caret from appearing outside the terminal bounds. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @manual -->
2. Autocorrect is suppressed at the OS level on mobile. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-016 AC2: swaps a textarea created during terminal.open() for a password input and restores createElement afterward) -->

**Constraints:**

- The compositor isolation and autocorrect suppression are device/IME behaviours; visual/device verification is valid when no genuine unit-test seam exists.

**Priority:** P0

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** Automated test ([useTerminal](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-003: Samsung Internet keyboard viewport state

**Intent:** Samsung Internet's `geometrychange` event is unreliable (stale-event cache, viewport inflation from bottom nav bar). Viewport state must be filtered and compensated so the terminal lays out correctly under Samsung devices.

**Applies To:** User

**Acceptance Criteria:**

1. Stale keyboard-geometry events (cached from previous toggles) are ignored within a 50ms window after the overlay state actually changes. <!-- @impl: web-ui/src/lib/mobile.ts::enableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
2. The stale-event ignore window is only restamped on genuine overlay state changes; no-op calls do not restart it. <!-- @impl: web-ui/src/lib/mobile.ts::enableVirtualKeyboardOverlay --> <!-- @impl: web-ui/src/lib/mobile.ts::disableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
3. Samsung's bottom-navigation-bar viewport inflation is compensated so keyboard height is calculated correctly. <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (getKeyboardHeight - Samsung compensation / REQ-MOB-003 (Samsung keyboard viewport state)) -->
4. The pre-keyboard viewport height reference is immutable after initialization, except on Galaxy Fold screen-switch events (large delta with keyboard closed). <!-- @impl: web-ui/src/lib/mobile.ts::baselineInnerHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
5. The pre-keyboard viewport height reference is never updated during keyboard close or any keyboard-state-reset path. <!-- @impl: web-ui/src/lib/mobile.ts::baselineInnerHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->

**Constraints:**

- Samsung Internet Browser requires a separate detection path.
- State recovery + UI configuration concerns live in [REQ-MOB-011](#req-mob-011-samsung-internet-keyboard-state-recovery).

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** Automated test ([SettingsPanel](../../web-ui/src/__tests__/components/SettingsPanel.test.tsx))

**Status:** Implemented

---

## Mobile scroll and touch compatibility

### REQ-MOB-004: Scroll-drop detection during burst output

**Intent:** Burst output must preserve explicit terminal viewport ownership without treating xterm's normal full-buffer trimming as a browser reset.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal viewport disables native scrolling on all devices so xterm's own scroll layer is the sole scroller. <!-- @impl: web-ui/src/styles/terminal.css::.xterm .xterm-viewport --> <!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (REQ-MOB-004 AC1: the terminal stylesheet disables native scrolling on the xterm viewport) --> <!-- @manual -->
2. Manual scroll intent transfers viewport ownership to the user, and that ownership persists until the viewport reaches the live bottom rather than expiring on a timer. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-TERM-014 AC2: manual scroll ownership persists when output trimming reaches zero) -->
3. A bottom-following scroll-event guard re-applies bottom alignment before paint and yields when the user owns the viewport. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-TERM-014: re-anchors a bottom-following terminal when scrollback trimming displaces it) -->
4. Streamed output is deferred while the user owns the viewport, so trimming never moves the owned viewport and no synthetic restoration or bottom snap is injected. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-014 AC3: defers streamed output while the user owns the viewport and flushes on bottom return) -->
5. Ordinary trim shifts, including shallow movement to the oldest available line, are not corrected while the user owns the viewport. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-MOB-004 AC4/AC5: keeps a shallow manually owned viewport at top when viewed lines age out) -->

**Constraints:**

- Post-write handling cannot override xterm's native anchor, including when it reaches zero.
- Frontend xterm scrollback is limited to 5000 lines, and agent-side virtual scrolling is disabled. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (scrollback: 5000) -->
- The host headless renderer retains 1000 lines. <!-- @impl: host/src/session.ts::Session -->
- Output deferral and its held-output cap are specified in [REQ-TERM-014](#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming) AC3.
- The keyboard-transition correction + user-anchoring behavior live in [REQ-MOB-012](#req-mob-012-scroll-anchoring-during-keyboard-transitions).

**Priority:** P0

**Dependencies:** [REQ-TERM-008](#req-term-008-write-batching-at-30fps), [REQ-TERM-014](#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming)

**Verification:** Automated test ([Scroll-ownership tests](../../web-ui/src/__tests__/hooks/useScrollCorrection.test.ts), [full-buffer deferral tests](../../web-ui/src/__tests__/stores/terminal.test.ts), [stylesheet contract test](../../web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts))

**Status:** Implemented

---

### REQ-MOB-005: Swipe gestures send arrow keys or scroll

**Intent:** Horizontal swipes provide command-line navigation, while vertical swipes scroll either terminal scrollback or the active fullscreen application.

**Applies To:** User

**Acceptance Criteria:**

1. Horizontal swipe gestures (left/right) send arrow-key escape sequences to the terminal. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)) -->
2. While the finger is held, arrow-key sends auto-repeat at roughly twelve times per second. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)) -->
3. Touch event handlers are registered in capture phase to ensure cleanup runs before xterm's internal gesture handling. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)) -->
4. The repeat is always cleared when the finger lifts or the touch is cancelled. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)) -->
5. When the keyboard is closed and terminal scrollback is active, vertical swipes scroll that buffer directly. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (scrolls the buffer on vertical swipe when keyboard is closed) -->
6. Scroll sensitivity scales with the terminal's font metrics so a swipe travels the same number of lines on different font sizes. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (should scroll proportionally to finger movement including threshold distance) -->
7. When the keyboard is open, vertical swipes send arrow keys while horizontal swipes remain available, regardless of any fullscreen application wheel capture. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-005 AC7: keyboard-open vertical swipes send arrow keys even under fullscreen wheel tracking) -->

**Constraints:**

- Normal scrollback uses xterm's buffer service directly ([REQ-TERM-014](#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming)).
- Classic alternate-screen scrolling uses xterm's public DOM wheel pipeline with inertia; Herdr uses proportional wheel steps without inertia.

**Priority:** P1

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated test ([touch-gestures](../../web-ui/src/__tests__/lib/touch-gestures.test.ts))

**Status:** Implemented

---

### REQ-MOB-017: Fullscreen application touch scrolling

**Intent:** Keyboard-closed vertical swipes navigate application-owned history when a fullscreen terminal program uses the alternate buffer, preserving mobile access to conversations that do not use terminal scrollback.

**Applies To:** User

**Acceptance Criteria:**

1. With the keyboard closed, vertical swipes navigate a fullscreen application's alternate-buffer history. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-017 AC1-AC2: routes proportional Herdr wheel steps without inertia) --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-017 AC3: preserves classic fullscreen wheel forwarding) -->
2. A keyboard-closed Herdr swipe emits proportional wheel steps from accumulated finger distance and stops when the finger lifts. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-017 AC1-AC2: routes proportional Herdr wheel steps without inertia) -->
3. Classic preserves its existing fullscreen wheel forwarding. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-017 AC3: preserves classic fullscreen wheel forwarding) -->

**Constraints:**

- Normal scrollback remains owned by [REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll).
- While the keyboard is open, vertical swipes remain terminal input ([REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll) AC7); wheel routing never applies.

**Priority:** P1

**Dependencies:** [REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll), [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated gesture routing tests.

**Status:** Implemented

---

### REQ-MOB-020: Terminal touch activation

**Intent:** A mobile tap activates one terminal control without duplicate activation or changes to Classic tap behavior.

**Applies To:** User

**Acceptance Criteria:**

1. A stationary single-finger Herdr tap activates the control at the touched location exactly once. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @impl: web-ui/src/lib/herdr-mouse.ts::sendHerdrTap --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-020 AC1: forwards one deterministic tap and suppresses compatibility mouse events) --> <!-- @test: web-ui/src/__tests__/lib/herdr-mouse.test.ts (sends a touch tap as one press/release pair at one computed cell) -->
2. A touch that becomes a movement gesture does not activate a control. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-020 AC2: suppresses every touch-derived mouse event after movement) -->
3. A cancelled touch does not activate a control. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-020 AC3: does not activate a tap after cancellation) -->
4. Classic stationary tap behavior remains unchanged. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-020 AC4: preserves the Classic stationary tap path without a synthetic mouse sequence) -->

**Constraints:** Long press and multi-touch do not activate the addressed control.

**Priority:** P1

**Dependencies:** [REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll), [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated gesture and duplicate-suppression tests plus manual Samsung Internet tap verification.

**Status:** Implemented

---

### REQ-MOB-022: Herdr mobile input focus and viewport

**Intent:** Trusted Herdr taps coordinate mobile input focus with application-owned fullscreen history.

**Applies To:** User

**Acceptance Criteria:**

1. A stationary Herdr tap opens mobile input when the keyboard is closed. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::focusMobileTerminal --> <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-022 AC1/AC3: activates the pane and snaps Pi fullscreen history before opening mobile input) --> <!-- @manual: On Samsung Internet with the keyboard closed, tap Pi input and confirm the keyboard opens. -->
2. A stationary Herdr tap remains usable while the keyboard is open. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-022 AC2: forwards a keyboard-open tap through sub-threshold jitter) --> <!-- @manual: On Samsung Internet with the keyboard open, tap Pi input and Herdr controls and confirm each activates once without selection. -->
3. Opening mobile input from a trusted Herdr tap resets application-owned fullscreen history to the live bottom. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-022 AC1/AC3: activates the pane and snaps Pi fullscreen history before opening mobile input) --> <!-- @manual: In Samsung Internet, scroll Pi history up with the keyboard closed, tap to open the keyboard, and confirm the latest output and prompt become visible. -->
4. Tapping Herdr while mobile input is already open does not reset the application-owned viewport. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-022 AC4: does not reset Pi fullscreen history when mobile input is already open) --> <!-- @manual: With the keyboard open and Pi history scrolled up, tap a control and confirm the viewport stays fixed. -->
5. A confirmed Herdr scroll releases stale mobile-input focus so the keyboard remains closed. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-022 AC5: releases stale Herdr input focus when scrolling without changing Classic) --> <!-- @manual: In Samsung Internet with the keyboard closed, scroll Herdr and confirm the keyboard remains closed after release. -->

**Constraints:** Classic terminal focus and viewport behavior remain unchanged.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-MOB-017](#req-mob-017-fullscreen-application-touch-scrolling), [REQ-MOB-020](#req-mob-020-terminal-touch-activation)

**Verification:** Manual check.

**Status:** Implemented

---

### REQ-MOB-023: Opt-in mobile input diagnostics

**Intent:** A user can capture bounded mobile browser input evidence without exposing terminal content.

**Applies To:** User

**Acceptance Criteria:**

1. Explicitly opting into mobile input diagnostics displays the input and viewport diagnostic overlay. <!-- @manual: Open a terminal URL with `debug=1` and confirm the diagnostic overlay appears. -->
2. The input trace retains at most the twelve newest event records. <!-- @impl: web-ui/src/lib/touch-event-debug.ts::attachTouchEventDebug --> <!-- @test: web-ui/src/__tests__/lib/touch-event-debug.test.ts (REQ-MOB-023 AC2-AC4: bounds content-free input metadata and move counts) -->
3. The overlay reports input ordering, final cancellation, touch origin, target, focus, move count, and keyboard geometry. <!-- @impl: web-ui/src/lib/touch-event-debug.ts::attachTouchEventDebug --> <!-- @manual: Reproduce a terminal touch and confirm the overlay reports input events and viewport state. -->
4. The input trace does not record terminal text. <!-- @impl: web-ui/src/lib/touch-event-debug.ts::attachTouchEventDebug --> <!-- @test: web-ui/src/__tests__/lib/touch-event-debug.test.ts (REQ-MOB-023 AC2-AC4: bounds content-free input metadata and move counts) -->

**Constraints:** Diagnostics activate only through the explicit query parameter and retain no server-side state.

**Priority:** P2

**Dependencies:** [REQ-MOB-003](#req-mob-003-samsung-internet-keyboard-viewport-state), [REQ-MOB-020](#req-mob-020-terminal-touch-activation)

**Verification:** Automated trace tests for AC2 and AC4; manual deployed overlay checks for AC1 and AC3.

**Status:** Implemented

---

## Mobile auxiliary input and cursor compatibility

### REQ-MOB-006: Sticky Ctrl button for mobile

**Intent:** Mobile users can send Ctrl-modified key sequences (Ctrl+C, Ctrl+D, etc.) without a physical keyboard by using a persistent on-screen Ctrl button.

**Applies To:** User

**Acceptance Criteria:**

1. A floating Ctrl button is visible on mobile when the terminal keyboard is open. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (FloatingTerminalButtons / REQ-MOB-006 (sticky Ctrl button)) -->
2. Tapping the Ctrl button enters a "sticky" state where the next key press is sent as a Ctrl-modified sequence. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::activateStickyCtrl --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (sticky Ctrl / REQ-MOB-006 (sticky Ctrl button state machine)) -->
3. Common sequences (Ctrl+C for interrupt, Ctrl+D for EOF) work correctly via the sticky Ctrl mechanism. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::resolveKeyAction --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (returns SIGINT sequence (Ctrl+C = 0x03) when no selection) -->
4. The Ctrl button state resets after one modified key press (single-use sticky behavior). <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::deactivateStickyCtrl --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (sticky Ctrl / REQ-MOB-006 (sticky Ctrl button state machine)) -->
5. The Ctrl button does not interfere with normal text input when not activated. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::resolveKeyAction --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (sticky Ctrl / REQ-MOB-006 (sticky Ctrl button state machine)) -->

**Constraints:**

- The button must be positioned to avoid overlapping with the virtual keyboard or terminal content.
- The button is part of the floating button UI layer alongside other mobile controls.

**Priority:** P0

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** Automated test ([FloatingTerminalButtons](../../web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx))

**Status:** Implemented

---

### REQ-MOB-007: Voice input via Web Speech API

**Intent:** Users can dictate text into the terminal using the device microphone, providing an alternative input method on mobile (and desktop).

**Applies To:** User

**Acceptance Criteria:**

1. Voice input uses the browser's Web Speech API where available. <!-- @impl: web-ui/src/lib/speech-input.ts::isSpeechSupported --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (speech-input / REQ-MOB-007 (voice input via Web Speech API)) -->
2. Voice input is completely decoupled from the keyboard/iframe input system. <!-- @impl: web-ui/src/lib/speech-input.ts::startListening --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (speech-input / REQ-MOB-007 (voice input via Web Speech API)) -->
3. On mobile, a floating microphone button starts recognition. On desktop, a small mic icon and a `Ctrl+Space` keyboard shortcut toggle voice input. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (renders desktop mic button when not touch device and speech supported) -->
4. Each activation captures one utterance; recognition auto-deactivates after the user pauses. <!-- @impl: web-ui/src/lib/speech-input.ts::startListening --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (onerror resets listening state and calls onEnd callback) -->
5. Final transcribed text is sent to the terminal as keyboard input. <!-- @impl: web-ui/src/lib/speech-input.ts::startListening --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (speech-input / REQ-MOB-007 (voice input via Web Speech API)) -->
6. The mic button is hidden on browsers that do not support the Web Speech API. <!-- @impl: web-ui/src/lib/speech-input.ts::isSpeechSupported --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (renders desktop mic button when not touch device and speech supported) -->

**Constraints:**

- Reliability over features: one utterance per activation, no interim results.
- The first-use permission-prompt pattern and IME composition compatibility live in [REQ-MOB-013](#req-mob-013-mobile-input-system-platform-compatibility).

**Priority:** P2

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices)

**Verification:** Automated test ([speech-input](../../web-ui/src/__tests__/lib/speech-input.test.ts))

**Status:** Implemented

---

### REQ-MOB-008: Cursor visible for all supported agents

**Intent:** The terminal cursor must be visible and correctly rendered for all supported CLI agents (Claude Code, Copilot, etc.) without duplication or visual artifacts.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal cursor is enabled and displays as a blinking bar. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (initializeTerminal creates Terminal with correct options) -->
2. Cursor colors match the Codeflare theme palette. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @manual -->
3. No CSS rules hide the terminal cursor elements. <!-- @manual -->
4. The cursor is not hidden in alternate buffer mode; only explicit DECTCEM hide sequences from the connected agent suppress it. <!-- @impl: web-ui/src/hooks/useTerminal.ts::DECTCEM_CURSOR_PARAM --> <!-- @manual: In each supported agent, enter and exit the alternate buffer and confirm the cursor remains visible until an explicit DECTCEM hide sequence. -->
5. No double-cursor duplication occurs between the terminal's native cursor and the agent's ANSI cursor on supported agent versions. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @manual -->
6. The isolated compositor context for the Android IME caret remains in place as a precaution, separate from the terminal cursor layer. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @manual -->

**Constraints:**

- Cursor visibility depends on the agent version using the terminal's native cursor layer.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated test ([useTerminal](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---

## Mobile visibility, fit and keyboard recovery compatibility

### REQ-MOB-009: Visibility return recovers keyboard state

**Intent:** When the browser is backgrounded and returned to, keyboard state signals must be reset so the terminal functions correctly without manual intervention.

**Applies To:** User

**Acceptance Criteria:**

1. On visibility return, focus restoration first resets all keyboard-state signals and re-enables the virtual-keyboard overlay before refocusing the input. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @manual -->
2. A document-visibility handler in the layout shell triggers the same keyboard-state reset as a fallback when focus-restore does not fire. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Visibility Return Keyboard Reset / REQ-MOB-009 (visibility-return keyboard recovery)) -->
3. The keyboard-state reset is unconditional because cached browser geometry is stale on resume. <!-- @impl: web-ui/src/lib/mobile.ts::forceResetKeyboardState --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (REQ-MOB-001 AC4: should reset signals and re-sync baseline when keyboard is closed (boundingRect.height=0)) -->
4. On Samsung, the dashboard bounce ([REQ-MOB-011](#req-mob-011-samsung-internet-keyboard-state-recovery)) replaces focus-based recovery. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Samsung: bounces through dashboard on visibility return to reset keyboard state) -->
5. On Samsung, the virtual-keyboard overlay re-enable is delayed enough on visibility return that stale browser keyboard-geometry events arrive inside the ignore window. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Visibility Return Keyboard Reset / REQ-MOB-009 (visibility-return keyboard recovery)) -->
6. Any WebSockets dropped while the page was hidden are re-established on visibility return. <!-- @impl: web-ui/src/stores/terminal.ts::reconnectOnVisibilityReturn --> <!-- @test: web-ui/src/__tests__/stores/terminal-connect-timeout.test.ts (pauses reconnect while hidden and resumes on visibility return) -->

**Constraints:**

- Visibility-return recovery does not rely on cached browser geometry.
- Chrome and Samsung paths are separate; Samsung requires full session deactivation/reactivation.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-MOB-003](#req-mob-003-samsung-internet-keyboard-viewport-state)

**Verification:** Automated test

**Status:** Implemented

---

<a id="req-mob-018-decorative-webgl-retirement-on-mobile-background-and-context-loss"></a>
### REQ-MOB-018: Decorative WebGL canvas retirement

**Intent:** The app's decorative WebGL canvas retires when mobile backgrounding or graphics-context loss makes continued rendering unreliable, preserving a stable dark application surface.

**Applies To:** User

**Acceptance Criteria:**

1. Backgrounding on a coarse-pointer device permanently retires the decorative WebGL canvas. <!-- @impl: web-ui/src/components/SplashCursor.tsx::SplashCursor --> <!-- @test: web-ui/src/__tests__/components/SplashCursor.test.tsx (REQ-MOB-018 AC1: retires a coarse-pointer canvas when the page is backgrounded) -->
2. WebGL context loss retires the canvas on any device and leaves the app root's dark CSS surface visible. <!-- @impl: web-ui/src/components/SplashCursor.tsx::SplashCursor --> <!-- @impl: web-ui/src/index.css::#root --> <!-- @test: web-ui/src/__tests__/components/SplashCursor.test.tsx (REQ-MOB-018 AC2: context loss permanently retires the canvas without requesting restoration) --> <!-- @manual -->

**Constraints:**

- The canvas is decorative and does not request context restoration after retirement.

**Priority:** P2

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-MOB-010: FitAddon fit calls are coordinated

**Intent:** Multiple code paths that trigger terminal-fit recalculation must not conflict with each other or cause visual artifacts.

**Applies To:** User

**Acceptance Criteria:**

1. After a completed keyboard refit, viewport resizing fits the terminal to its visible container. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-010 AC1/AC2: fits after viewport resizing once keyboard refit finishes) -->
2. While a keyboard refit is in flight, the viewport resize observer is suppressed so the two paths do not contend. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-010 AC2: suppresses competing fits while a keyboard refit is pending) -->
3. With the keyboard open on mobile, the buffer scrolls to the bottom after every refit so new output remains visible. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (keyboard height refit) -->
4. Without the keyboard open (desktop or mobile), scroll-to-bottom only runs when the user was already at the bottom; scrollback position is preserved otherwise. <!-- @impl: web-ui/src/stores/terminal-layout.ts::refitAllTerminalsExported --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (useTerminal hook) -->
5. While the keyboard is open, the resize observer does not force scroll-to-bottom; the keyboard-height-change handler owns that. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (useTerminal hook) -->
6. A refit that produces unchanged dimensions does not send a resize message to the container. <!-- @impl: web-ui/src/stores/terminal-layout.ts::refitAllTerminalsExported --> <!-- @test: web-ui/src/__tests__/stores/terminal-layout.test.ts (REQ-MOB-010 AC6: unchanged-dimensions skip resize message) -->
7. A visible Herdr terminal restores a current fitted surface when the document returns from hidden state. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (forces a repaint and same-size PTY resize when a hidden page becomes visible) -->

**Constraints:**

- The keyboard-refit gate is implemented so cleanup cannot leave it stuck on after a cancelled refit.
- The write callback owns bottom-anchoring during keyboard-open output; no other path competes for that decision.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-TERM-008](#req-term-008-write-batching-at-30fps)

**Verification:** Automated test ([useTerminal](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-021: Terminal follows visible container changes

**Intent:** Terminal activation and mobile keyboard geometry changes keep the rendered terminal aligned with its visible container.

**Applies To:** User

**Acceptance Criteria:**

1. Activating a terminal fits it to the visible container before publishing its PTY dimensions. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-021 AC1: fits the visible container when a terminal becomes active) -->
2. A mobile keyboard geometry change refits the visible terminal before publishing its PTY dimensions. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-021 AC2: fits the visible container after keyboard geometry changes) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-MOB-010](#req-mob-010-fitaddon-fit-calls-are-coordinated)

**Verification:** Automated test ([useTerminal](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-011: Samsung Internet keyboard state recovery

**Intent:** Samsung's back-button dismiss and browser-resume paths leave the VirtualKeyboard compositor in stale states. State must be force-reset on those edges, and the user must be able to tell codeflare where Samsung's address bar sits (the API does not expose it).

**Applies To:** User

**Acceptance Criteria:**

1. Samsung's back-button keyboard dismiss is intercepted; all keyboard-state signals are reset on that event. <!-- @impl: web-ui/src/lib/mobile.ts::forceResetKeyboardState --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (Samsung focusout keyboard dismiss (Fix 1) / REQ-MOB-011 (Samsung keyboard state recovery)) -->
2. Samsung browser resume uses an automatic dashboard bounce (deactivate then reactivate the session after a brief delay) to reset the unreliable keyboard compositor state. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Visibility Return Keyboard Reset / REQ-MOB-009 (visibility-return keyboard recovery)) -->
3. Samsung's address-bar position is configured via a user-settings toggle because no browser API exposes it. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (should show Samsung section when Samsung browser) -->

**Notes:** Samsung Internet manual verification checklist lives in [documentation/lanes/terminal-and-ide.md](../../documentation/lanes/terminal-and-ide.md#samsung-internet-quirks).

**Constraints:**

- Samsung session re-initialisation requires a brief delay between deactivation and reactivation for cleanup effects to settle.
- Samsung input resume does not auto-focus the terminal; the keyboard stays closed until the user taps, to avoid stale keyboard-geometry events.

**Priority:** P1

**Dependencies:** [REQ-MOB-003](#req-mob-003-samsung-internet-keyboard-viewport-state)

**Verification:** Automated test ([useTerminal](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-012: Scroll anchoring during keyboard transitions

**Intent:** Mobile keyboard mode must explicitly own terminal fit and bottom anchoring while open, without competing with generic scroll correction or changing the established swipe-input contract.

**Applies To:** User

**Acceptance Criteria:**

1. Batched output delegates every output-driven scrollback shift to xterm and performs no write-side correction. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-014 AC3: writes batched output without viewport correction when $name) -->
2. Opening the touch keyboard performs the established fit-and-bottom transition. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-021 AC2: fits the visible container after keyboard geometry changes) -->
3. Generic viewport correction remains inactive while the touch keyboard is open. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-MOB-012 AC3: freezes correction-owned viewport movement while the touch keyboard is open) -->
4. Closing the touch keyboard hands viewport correction back to bottom-following mode. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-MOB-012 AC4: keyboard close hands viewport ownership back to bottom following) -->
5. After keyboard control ends, manual scroll ownership persists until the viewport returns to bottom. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-MOB-012 AC5: keyboard transition preserves later manual viewport ownership) -->

**Constraints:**

- Keyboard-open bottom anchoring is intentional and has priority over manual scrollback.
- The touch-keyboard exception applies only when both touch capability and virtual-keyboard-open state are present.

**Priority:** P0

**Dependencies:** [REQ-MOB-004](#req-mob-004-scroll-drop-detection-during-burst-output), [REQ-TERM-014](#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming)

**Verification:** Automated test ([Scroll-event tests](../../web-ui/src/__tests__/hooks/useScrollCorrection.test.ts); [full-buffer batched-write test](../../web-ui/src/__tests__/stores/terminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-019: Keyboard-mode swipe semantics

**Intent:** Vertical terminal swipes remain typing input while the touch keyboard is open and return to scrollback navigation once keyboard mode ends.

**Applies To:** User

**Acceptance Criteria:**

1. Vertical swipes remain terminal input while the touch keyboard is open. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (should call preventDefault and send up arrow) -->
2. After the touch keyboard closes, vertical swipes scroll through terminal history. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (scrolls the buffer on vertical swipe when keyboard is closed) -->

**Constraints:**

- The established tap-to-focus keyboard opening remains unchanged.
- Fullscreen wheel routing applies only while the keyboard is closed ([REQ-MOB-017](#req-mob-017-fullscreen-application-touch-scrolling)).

**Priority:** P0

**Dependencies:** [REQ-MOB-012](#req-mob-012-scroll-anchoring-during-keyboard-transitions), [REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll), [REQ-MOB-017](#req-mob-017-fullscreen-application-touch-scrolling)

**Verification:** Automated test ([Touch gesture tests](../../web-ui/src/__tests__/lib/touch-gestures.test.ts))

**Status:** Implemented

---

## Mobile permission and background focus compatibility

### REQ-MOB-013: Mobile input-system platform compatibility

**Intent:** Mobile browsers stack the virtual keyboard above the permission prompt and route swipe-typed text as IME composition events. The input system must blur the iframe before triggering permission prompts (so the user sees the prompt) and buffer composition events until commit (so swipe typing arrives as whole words).

**Applies To:** User

**Acceptance Criteria:**

1. On first use, when the microphone permission state is `prompt` or cannot be determined, the iframe input is blurred (dismissing the keyboard) before requesting permission so the user can see a possible browser prompt. <!-- @impl: web-ui/src/lib/speech-input.ts::getMicPermissionState --> <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (REQ-MOB-013 AC1: dismisses the mobile keyboard before speech may issue a first prompt when permission state is unknown) -->
2. The same blur-before-permission pattern applies to clipboard paste. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @manual -->
3. Swipe-typed text is buffered through the browser's IME composition events and sent only when the IME commits, so partial composition does not reach the terminal as individual keystrokes. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @manual -->

**Constraints:**

- Permission prompt handling is critical on mobile where the prompt appears behind the virtual keyboard if the iframe still holds focus.

**Priority:** P2

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-MOB-007](#req-mob-007-voice-input-via-web-speech-api)

**Verification:** Automated test ([speech-input](../../web-ui/src/__tests__/lib/speech-input.test.ts))

**Status:** Implemented

---

### REQ-MOB-014: Mobile background-surface focus isolation

**Intent:** Hidden same-origin surfaces must not steal focus from an active mobile terminal.

**Applies To:** User

**Acceptance Criteria:**

1. Background same-origin surfaces that run while the keyboard is open do not blur the terminal input or dismiss the keyboard. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (REQ-MOB-014 / REQ-VAULT-020: vault browser prewarm protocol) -->
2. Vault browser prewarm remains eager but uses a focus-inert hidden document. <!-- @impl: src/lib/vault-view.ts::injectVaultPrewarmFocusGuard --> <!-- @test: src/__tests__/routes/vault-html-direct.test.ts (CF-045: vault-html direct unit tests) -->
3. If a hidden iframe captures focus, the terminal/input focus is restored. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (restores prior focus if the hidden prewarm iframe captures parent focus) -->

**Constraints:**

- Background prewarm remains eager while the keyboard is open.

**Priority:** P0

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** Automated test ([Vault prewarm test](../../web-ui/src/__tests__/lib/vault-prewarm.test.ts), [Vault shell helper test](../../src/__tests__/routes/vault-html-direct.test.ts))

**Status:** Implemented

---

### REQ-MOB-015: Virtual keyboard persists across terminal pane focus handoff

**Intent:** On touch devices the virtual-keyboard mode (locked/anchored layout, swipe-as-arrows, keyboard-height padding) is driven by a single shared signal. When several backend-session terminal surfaces are visible in tablet MultiView and focus moves while the keyboard is open, the keyboard must stay open and the newly focused surface must keep keyboard mode without the user dismissing and reopening the keyboard. Classic focus remains among Codeflare outer panes; focus among panes inside a Herdr session belongs to Herdr within one xterm.js surface. Shared keyboard state is torn down only when focus leaves terminal surfaces, not on a MultiView handoff.

**Applies To:** User

**Acceptance Criteria:**

1. A live focus query reports whether browser focus currently rests on a terminal input surface; it is the single discriminator used by every per-pane keyboard-teardown site. <!-- @impl: web-ui/src/lib/mobile.ts::isFocusOnTerminalInput --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (reports focus resting on a terminal input iframe) -->
2. When a terminal pane loses focus to a sibling terminal pane, the per-pane focus-loss cleanup does not disable the keyboard overlay or zero the keyboard signals, so the newly focused pane stays in keyboard mode. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::releaseKeyboardOnBlur --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (useTerminal hook) -->
3. A Samsung back-button keyboard dismiss still zeroes keyboard state, but a pane-to-pane focus handoff does not. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (Samsung focusout keyboard dismiss (Fix 1) / REQ-MOB-011 (Samsung keyboard state recovery)) -->
4. When focus leaves all terminal surfaces, the shared keyboard overlay and signals are released. Unmount releases them only when the retiring pane owns focus or no terminal input owns focus; a sibling-pane focus handoff preserves them. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (REQ-MOB-015 AC4: preserves shared keyboard state when a sibling pane owns focus) --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (REQ-MOB-015 AC4: retires shared keyboard state when no terminal input owns focus) -->

**Constraints:**

- The discriminator reads live focus state, never a cached value.
- Exit/unmount teardown is owner-aware: it cannot clear a sibling terminal's live keyboard state, and it resets state when no terminal input remains focused.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-MOB-009](#req-mob-009-visibility-return-recovers-keyboard-state)

**Verification:** Automated test ([Mobile keyboard test](../../web-ui/src/__tests__/lib/mobile.test.ts), [useTerminal hook test](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---
