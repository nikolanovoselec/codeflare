# Terminal

PTY management, WebSocket transport, multi-tab support, tiling layouts, MultiView workspaces, and process detection.

**Domain owner:** Frontend (SolidJS + xterm.js) + Container (terminal server)

### Key Concepts

- **PTY** -- Pseudo-terminal; the OS-level device that bridges a shell process to terminal I/O over the WebSocket.
- **WebSocket** -- The bidirectional transport carrying raw terminal data and JSON control messages between browser and container.
- **Terminal Tab** -- A single terminal instance within a session, identified by a compound key (`sessionId:terminalId`), each backed by its own PTY.
- **Tiling Layout** -- An arrangement mode (tabbed, 2-split, 3-split, 4-grid) that displays multiple terminals simultaneously.
- **MultiView** -- A virtual frontend workspace that displays multiple existing sessions at once without creating another backend session.

### Out of Scope

- Terminal recording and playback (session replay)
- Collaborative terminal sharing (multi-user viewing or input on the same PTY)
- Saved terminal command presets / header "bookmarks" (feature removed; see [changes.md](changes.md))

### Domain Dependencies

- **Session Lifecycle** (container must be running) -- Terminal connections require an active, running container.
- **Authentication** (WebSocket auth) -- WebSocket upgrade requests are authenticated via the Worker middleware and container auth token.

---

### REQ-TERM-001: Up to 6 terminal tabs per session

**Intent:** Each session supports multiple concurrent terminal instances (up to 6) so users can run an agent in one tab and auxiliary commands in others.

**Applies To:** User

**Acceptance Criteria:**

1. The maximum terminal count per session is six, defined as a shared constant referenced by both frontend and backend so neither can drift. <!-- @impl: src/lib/constants.ts::MAX_TABS = 6 --> <!-- @test: src/__tests__/lib/cross-package-constants.test.ts (Cross-Package Constants / REQ-TERM-001 AC1 (MAX_TABS=6 enforced session-wide, shared backend<->frontend constant)) -->
2. Each terminal tab is identified by a compound key built from the session ID and the per-tab terminal ID; the same identity travels through the WebSocket URL. <!-- @impl: src/routes/terminal.ts::validateWebSocketRoute --> <!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (REQ-TERM-001 AC2: compound key {baseSession}-{terminalId} parsed from URL) -->
3. The backend parses the compound ID, validates the base session, and forwards the full compound ID into the container. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (REQ-TERM-001 AC2: compound key {baseSession}-{terminalId} parsed from URL) -->
4. The container's session manager handles each compound ID as a separate PTY process with independent state. <!-- @impl: host/src/session-manager.ts::SessionManager --> <!-- @test: host/__tests__/session-manager.test.js (SessionManager) -->
5. The container's session cap check excludes pre-warmed PTYs from the active count so pre-warming does not consume a tab slot. <!-- @impl: host/src/session-manager.ts::SessionManager --> <!-- @test: host/__tests__/session-manager.test.js (SessionManager) -->
6. Attempting to create a seventh terminal in a session is rejected. <!-- @impl: web-ui/src/stores/session-tabs.ts::addTerminalTab --> <!-- @test: web-ui/src/__tests__/stores/session-tabs.test.ts (returns null when max terminals reached) -->

**Constraints:**

- The frontend's compound-key encoding and the backend's URL-path encoding must be reversible into the same logical identity; mismatched encodings would break tab adoption.
- Terminal IDs are scoped within a session; they are not globally unique.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](session-lifecycle.md#req-session-002-one-container-per-session-isolation)

**Verification:** Automated test ([terminal-route-validate](../../src/__tests__/routes/terminal-route-validate.test.ts))

**Status:** Implemented

---

### REQ-TERM-002: WebSocket connection to container PTY

**Intent:** Each terminal tab connects to its PTY process inside the container via a WebSocket, carrying raw terminal data bidirectionally.

**Applies To:** User

**Acceptance Criteria:**

1. The WebSocket URL embeds the compound terminal identity (session ID and per-tab terminal ID) on a stable path under the terminal route. <!-- @impl: src/routes/terminal.ts::validateWebSocketRoute --> <!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (REQ-TERM-002 AC1: WS URL pattern /api/terminal/{sessionId}-{terminalId}/ws) -->
2. The Worker upgrades the HTTP request to a WebSocket and forwards it through the Container DO to the in-container terminal server. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal.test.ts (validateWebSocketRoute / REQ-TERM-002 (terminal WebSocket connection to container PTY)) -->
3. The terminal server spawns a login shell PTY with full-color terminal emulation so interactive TUI applications render correctly. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-wire-protocol.test.js (REQ-TERM-002 AC3: PTY spawned as a full-color login shell) -->
4. Raw terminal data flows over the WebSocket without JSON wrapping so binary-clean PTY output is preserved. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-wire-protocol.test.js (REQ-TERM-002 AC4: raw PTY output reaches clients without JSON wrapping) -->

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
2. A socket that stays in CONNECTING past the bounded handshake timeout (no close or error event fires after a mobile app-switch) is force-closed and a backoff reconnect is scheduled, so it is no longer stranded mid-handshake. <!-- @impl: web-ui/src/stores/terminal.ts::connect --> <!-- @test: web-ui/src/__tests__/stores/terminal-connect-timeout.test.ts (Terminal Store / REQ-TERM-020 AC2: connect-timeout force-close & AC3 pause-while-hidden) -->
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

### REQ-TERM-005: Tab 1 auto-starts the configured agent

**Intent:** The first terminal tab in a session automatically launches the user's selected AI agent so they can start coding immediately without manual setup.

**Applies To:** User

**Acceptance Criteria:**

1. The Container DO passes the per-tab agent configuration to the terminal server at container start so the server knows which agent to launch in tab 1. <!-- @impl: host/src/prewarm-config.ts::getPrewarmConfig --> <!-- @test: host/__tests__/prewarm-readiness.test.js (when tab 1 has a command / REQ-AGENT-003 (agent CLI auto-started in tab 1) / REQ-TERM-005 (pre-warm pty)) -->
2. Tab 1 is pre-warmed at container start: the terminal server spawns a dedicated pre-warm PTY whose login shell reads the user's shell init. <!-- @impl: host/src/server.ts::prewarmSession --> <!-- @test: host/__tests__/prewarm-readiness.test.js (when tab 1 has a command / REQ-AGENT-003 (agent CLI auto-started in tab 1) / REQ-TERM-005 (pre-warm pty)) -->
3. The shell init reads the per-tab configuration and launches the configured agent (Claude Code, Codex, Antigravity, OpenCode, Copilot CLI, or Pi), each in non-interactive sandboxed mode appropriate for its CLI, or a plain bash shell when the tab is configured with no agent. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (AC1 dynamic: TAB_CONFIG with id=1 command=lazygit emits the lazygit launch for tab 1 (overrides the default claude)) -->
4. Pre-warm readiness is detected by the first PTY output; a bounded hard timeout acts as a safety net so a permanently silent agent does not stall startup. <!-- @impl: host/src/server.ts::prewarmReady --> <!-- @test: host/__tests__/prewarm-readiness.test.js (when tab 1 has a command / REQ-AGENT-003 (agent CLI auto-started in tab 1) / REQ-TERM-005 (pre-warm pty)) -->
5. When the first WebSocket client connects for tab 1, the pre-warmed session is adopted (re-bound from the pre-warm identifier to the real terminal ID). If no client adopts it within a bounded window, the pre-warmed session is killed. <!-- @impl: host/src/session-manager.ts::SessionManager --> <!-- @test: host/__tests__/session-manager.test.js (SessionManager) -->
6. The startup status stage progresses through a fixed pipeline: starting -> syncing -> verifying -> mounting (pre-warm in progress, terminal canvas hidden) -> ready (pre-warm complete, "Open" control appears). <!-- @impl: web-ui/src/lib/stages.ts::stageOrder --> <!-- @test: web-ui/src/__tests__/lib/stages.test.ts (orders stages in correct progression (creating < starting < syncing < ... < ready)) -->

**Constraints:**

- Fast Start is on by default and disables CLI auto-update checks for all supported agents so startup is not blocked on remote version lookups.
- The pre-warm PTY uses a login shell so the shell-init agent-autostart logic runs.
- Agent auto-start requests sandbox-mode permission bypass so the agent starts non-interactively without prompting the user inside the pre-warm window.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-SESSION-003](session-lifecycle.md#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated test ([Integration test](../../host/__tests__/prewarm-readiness.test.js))

**Status:** Implemented

---

### REQ-TERM-006: User-created tabs start with plain bash

**Intent:** Tabs created by the user (clicking "+") start a plain bash shell without auto-launching an agent, giving the user a general-purpose terminal.

**Applies To:** User

**Acceptance Criteria:**

1. Tabs created by the user are marked manual in the tab configuration so downstream components can branch on the distinction. <!-- @impl: web-ui/src/stores/session-tabs.ts::addTerminalTab --> <!-- @test: web-ui/src/__tests__/stores/session-tabs.test.ts (REQ-TERM-006 AC1: marks a user-created tab with the manual flag) -->
2. The manual flag is propagated to the container via a query parameter on the WebSocket upgrade URL. <!-- @impl: web-ui/src/stores/terminal.ts::connect --> <!-- @test: web-ui/src/__tests__/stores/terminal-control-message.test.ts (REQ-TERM-006 AC2: connect() propagates the manual flag onto the WebSocket URL) -->
3. The terminal server exposes the manual flag to the PTY environment so the shell init can read it. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-process-name.test.js (a manual session exposes MANUAL_TAB=1 in the PTY env) -->
4. The shell init skips its agent-autostart block when the manual flag is set. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/session-process-name.test.js (Session PTY env / REQ-TERM-006 AC3 (MANUAL_TAB exposure)) -->
5. The resulting PTY is a plain login shell with no agent running. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @manual -->

**Constraints:**

- The manual flag is a frontend-originated UX hint; the backend trusts it for tab-behavior selection but not for security decisions.
- Manual tabs still have access to all installed CLI tools; the user can launch any agent from the shell.

**Priority:** P0

**Dependencies:** [REQ-TERM-001](#req-term-001-up-to-6-terminal-tabs-per-session)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-TERM-007: Tiling layouts (2-split, 3-split, 4-grid)

**Intent:** Users can arrange terminal tabs in tiled layouts for simultaneous visibility of multiple terminals, in addition to the default tabbed view.

**Applies To:** User

**Acceptance Criteria:**

1. Four layout modes are supported: tabbed (single terminal visible), two-split (side by side), three-split (one left, two right), and four-grid (2x2). <!-- @impl: web-ui/src/stores/tiling.ts::LAYOUT_MIN_TABS --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (should define minimum tab counts for each layout) -->
2. Each layout has a minimum tab count equal to the number of panes it shows. <!-- @impl: web-ui/src/stores/tiling.ts::isLayoutCompatible --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (Tiling Module - Pure Helpers / REQ-TERM-007 (tiling layout selection, compatibility check, best-fit-for-tab-count, setTilingLayout)) -->
3. A compatibility check validates whether a session has enough tabs for the requested layout before applying it. <!-- @impl: web-ui/src/stores/tiling.ts::isLayoutCompatible --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (Tiling Module - Pure Helpers / REQ-TERM-007 (tiling layout selection, compatibility check, best-fit-for-tab-count, setTilingLayout)) -->
4. Adding a tab beyond the current layout's pane count downgrades the layout to tabbed rather than auto-upgrading to a larger tiling layout. <!-- @impl: web-ui/src/stores/session-tabs.ts::addTerminalTab --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (Tiling Module - Pure Helpers / REQ-TERM-007 (tiling layout selection, compatibility check, best-fit-for-tab-count, setTilingLayout)) -->
5. A best-layout helper resolves the highest layout compatible with a given tab count so the UI can land users on the most spacious view by default. <!-- @impl: web-ui/src/stores/tiling.ts::getBestLayoutForTabCount --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (Tiling Module - Pure Helpers / REQ-TERM-007 (tiling layout selection, compatibility check, best-fit-for-tab-count, setTilingLayout)) -->
6. Layout state is persisted per session and restored on reconnection. <!-- @impl: web-ui/src/stores/tiling.ts::setTilingLayout --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (should return tiling state for initialized session) -->
7. Applying an incompatible layout (insufficient tabs) or targeting a missing session fails cleanly rather than partially applying. <!-- @impl: web-ui/src/stores/tiling.ts::setTilingLayout --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (Tiling Module - Store Integration) -->

**Constraints:**

- The tiling store accesses the session store lazily to avoid a circular dependency between the two pieces of UI state.
- Layout changes trigger terminal resize events so the rendering library reflows content.

**Priority:** P2

**Dependencies:** [REQ-TERM-001](#req-term-001-up-to-6-terminal-tabs-per-session)

**Verification:** Automated test ([tiling](../../web-ui/src/__tests__/stores/tiling.test.ts))

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

### REQ-TERM-009: Process name detection via control messages

**Intent:** The terminal server detects the foreground process running in each PTY and sends the process name to the frontend for display in tab labels and session cards.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal server emits process-name control messages over the WebSocket whenever the foreground process for a PTY changes. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-process-name.test.js (Session process-name emit / REQ-TERM-009 AC1 (emit only on change)) -->
2. The frontend distinguishes control messages from raw terminal data using the message's leading type-discriminator field. <!-- @impl: web-ui/src/stores/terminal-protocol.ts::parseControlMessage --> <!-- @test: web-ui/src/__tests__/stores/terminal-control-message.test.ts (Terminal control-message handling) -->
3. The frontend maps known foreground process names (supported agents plus common TUI tools and shells) to display icons via a static lookup. <!-- @impl: web-ui/src/lib/terminal-config.ts::getTabIcon --> <!-- @test: web-ui/src/__tests__/lib/terminal-config.test.ts (terminal-config / REQ-TERM-006 (per-tab agent autostart config) / REQ-TERM-009 (PROCESS_ICON_MAP renders icons per tab process kind)) -->
4. An optional binary-name-to-display-name override table exists for cases where the executable name differs from the user-facing name; the override table is empty when no remap is needed. <!-- @impl: web-ui/src/lib/terminal-config.ts::getTabDisplayName --> <!-- @test: web-ui/src/__tests__/lib/terminal-config.test.ts (returns claude display name) -->
5. The session card icon set covers each supported agent type so users can identify a session at a glance. <!-- @impl: web-ui/src/lib/terminal-config.ts::AGENT_ICON_MAP --> <!-- @test: web-ui/src/__tests__/lib/terminal-config.test.ts (terminal-config / REQ-TERM-006 (per-tab agent autostart config) / REQ-TERM-009 (PROCESS_ICON_MAP renders icons per tab process kind)) -->
6. The session store registers a process-name callback against the terminal store so process updates propagate without creating a circular import between the two stores. <!-- @impl: web-ui/src/stores/terminal.ts::registerProcessNameCallback --> <!-- @test: web-ui/src/__tests__/stores/terminal-control-message.test.ts (REQ-TERM-009 AC6: registerProcessNameCallback routes process-name frames to the callback) -->
7. Process name updates are reflected in tab headers and session status cards in real time. <!-- @impl: web-ui/src/stores/session-tabs.ts::updateTerminalLabel --> <!-- @test: web-ui/src/__tests__/stores/update-terminal-label.test.ts (REQ-TERM-009 AC7: updateTerminalLabel writes processName to the targeted tab) -->

**Constraints:**

- Control messages that fail to parse as JSON are treated as raw terminal data so an unexpected payload never blocks output.
- Unknown control-message types are silently ignored so the protocol can evolve without breaking older clients.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-TERM-011: Visible terminal panes own WebSocket connections

**Intent:** Terminal WebSockets are opened only for terminal panes that are visible in the current browser workspace, preventing hidden sessions from attaching to PTYs and sending stale resize or input traffic.

**Applies To:** User

**Acceptance Criteria:**

1. Dashboard view opens zero terminal WebSocket connections even when sessions are running or initializing. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::setDashboardWorkspace --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-011: renders no terminal panes on Dashboard even when sessions are running) -->
2. Single-session view opens terminal WebSockets only for the visible session surface: one active tab in tabbed mode, or each visible tiled tab when tiling is enabled. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::setSingleSessionWorkspace --> <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (REQ-TERM-011: single-session workspace exposes exactly one visible pane) -->
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
4. Opening MultiView renders connected terminal panes for the selected member sessions. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (REQ-TERM-012: renders one connected terminal pane for each visible MultiView member) -->
5. Workspace switches preserve MultiView membership while reconciling connections to visible panes. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (terminalWorkspaceStore visible pane ownership) -->

**Constraints:**

- MultiView is frontend workspace state and must not be sent to backend session lifecycle, terminal route validation, storage, quota, or metrics APIs as a real session ID.
- MultiView membership is local browser state unless a future requirement adds cross-browser workspace sync.

**Priority:** P1

**Dependencies:** [REQ-TERM-001](#req-term-001-up-to-6-terminal-tabs-per-session), [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-007](#req-term-007-tiling-layouts-2-split-3-split-4-grid), [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

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
2. A focused visible terminal claims resize authority before sending dimensions, including retry reconnects that remain focused. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal.ts::claimResizeAuthority --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-TERM-011: claims resize authority and sends current dimensions when a pane becomes focused) -->
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

**Dependencies:** [REQ-TERM-005](#req-term-005-tab-1-auto-starts-the-configured-agent), [REQ-SEC-023](security.md#req-sec-023-agent-notification-capability-boundaries), [REQ-SEC-024](security.md#req-sec-024-agent-notification-delivery-trust-boundaries)

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
