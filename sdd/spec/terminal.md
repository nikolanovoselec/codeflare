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

### Domain Dependencies

- **Session Lifecycle** (container must be running) -- Terminal connections require an active, running container.
- **Authentication** (WebSocket auth) -- WebSocket upgrade requests are authenticated via the Worker middleware and container auth token.

---

### REQ-TERM-001: Up to 6 terminal tabs per session


**Intent:** Each session supports multiple concurrent terminal instances (up to 6) so users can run an agent in one tab and auxiliary commands in others.

**Applies To:** User

**Acceptance Criteria:**

1. The maximum terminal count per session is six, defined as a shared constant referenced by both frontend and backend so neither can drift. <!-- @impl: src/lib/constants.ts::MAX_TABS = 6 --> <!-- @test: src/__tests__/lib/cross-package-constants.test.ts (MAX_TABS == MAX_TERMINALS_PER_SESSION) -->
2. Each terminal tab is identified by a compound key built from the session ID and the per-tab terminal ID; the same identity travels through the WebSocket URL. <!-- @impl: src/routes/terminal.ts::validateWebSocketRoute --> <!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (compound key parse + URL forward + KV baseSessionId validate) -->
3. The backend parses the compound ID, validates the base session, and forwards the full compound ID into the container. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (SESSION_ID_PATTERN reject + 400 INVALID_SESSION) -->
4. The container's session manager handles each compound ID as a separate PTY process with independent state. <!-- @impl: host/src/session-manager.ts::SessionManager --> <!-- @test: host/__tests__/session-manager.test.js (getOrCreate cap-null + compound-id map keying) -->
5. The container's session cap check excludes pre-warmed PTYs from the active count so pre-warming does not consume a tab slot. <!-- @impl: host/src/session-manager.ts::SessionManager --> <!-- @test: host/__tests__/session-manager.test.js (prewarm exclusion from active count) -->
6. Attempting to create a seventh terminal in a session is rejected. <!-- @impl: host/src/session-manager.ts::SessionManager --> <!-- @test: host/__tests__/session-manager.test.js (seventh terminal rejected) -->

**Constraints:**

- The frontend's compound-key encoding and the backend's URL-path encoding must be reversible into the same logical identity; mismatched encodings would break tab adoption.
- Terminal IDs are scoped within a session; they are not globally unique.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](session-lifecycle.md#req-session-002-one-container-per-session-isolation)

**Verification:** [Automated test](../../src/__tests__/routes/terminal-route-validate.test.ts)

**Status:** Implemented

---

### REQ-TERM-002: WebSocket connection to container PTY


**Intent:** Each terminal tab connects to its PTY process inside the container via a WebSocket, carrying raw terminal data bidirectionally.

**Applies To:** User

**Acceptance Criteria:**

1. The WebSocket URL embeds the compound terminal identity (session ID and per-tab terminal ID) on a stable path under the terminal route. <!-- @impl: src/routes/terminal.ts::validateWebSocketRoute --> <!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (WS URL shape /api/terminal/{sid}-{tid}/ws + Upgrade header gating) --> <!-- @test: src/__tests__/routes/terminal.test.ts (validateWebSocketRoute WS URL + upgrade) -->
2. The Worker upgrades the HTTP request to a WebSocket and forwards it through the Container DO to the in-container terminal server. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal.test.ts (validateWebSocketRoute upgrade forwarding) -->
3. The terminal server spawns a login shell PTY with full-color terminal emulation so interactive TUI applications render correctly. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-wire-protocol.test.js (imports the compiled Session, mock.module's node-pty, runs the real start() spawn path and asserts buildPtyEnv() returns TERM=xterm-256color + COLORTERM=truecolor, that the captured pty.spawn opts.name==='xterm-256color', and that the '-l' login-shell flag and configured terminalArgs reach the spawned argv) -->
4. Raw terminal data flows over the WebSocket without JSON wrapping so binary-clean PTY output is preserved. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-wire-protocol.test.js (drives the real onData broadcast wiring installed by start(): fires a PTY data frame through the captured node-pty listener and asserts the OPEN client receives the bytes verbatim (frame===raw, not JSON-wrapped) while a CLOSED client receives nothing) -->
5. Out-of-band control messages (resize, process-name, restore, and client-requested PTY termination) are encoded as JSON objects identifiable by a leading type-discriminator field. <!-- @impl: host/src/session.ts::Session --> <!-- @impl: host/src/server.ts::wss --> <!-- @impl: web-ui/src/stores/terminal.ts::dispose --> <!-- @test: host/__tests__/session-wire-protocol.test.js (covers the host-emitted control-frame half: after seeding real PTY output into the @xterm/headless buffer, attach() emits a JSON.parse-able {type:'restore', state:<non-empty>} frame and emitProcessNameIfChanged() emits {type:'process-name', processName, terminalId} on a foreground-process change) --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (client kill control frame) -->
6. Unknown control-message types are silently ignored so the wire protocol can grow without breaking older clients or servers. <!-- @impl: host/src/session.ts::Session --> <!-- coverage-gap: the unknown-control-type forward-compat guard lives inline in server.ts's wss.on('connection') message closure interwoven with the resize/focus/data/kill branches; it is not on Session and is not cleanly extractable, and host/__tests__/ws-input-classification.test.js already re-implements the logic locally (would stay green if server.ts were gutted), so a second copy would be theater. Genuine coverage needs a real in-container WebSocket server -->
7. No application-level ping/pong is implemented; the transport layer handles WebSocket keepalive on its own. <!-- @impl: host/src/session.ts::Session --> <!-- coverage-gap: protocol-level keepalive is `ws.ping()` on a setInterval inside server.ts's wss.on('connection') closure (per-connection pingInterval/lastPongAt/pong handler); verifying ping vs the absence of any JSON {type:'ping'} frame requires a real WebSocket pair observing wire frames over time, which node:test cannot do -->

**Constraints:**

- WebSocket upgrade handling must run before the application router because of a Worker-runtime limitation that prevents WebSocket frames from reaching downstream middleware.
- All proxied HTTP requests from the DO to the container carry the shared container auth token; only the health and activity probes are exempt.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](session-lifecycle.md#req-session-002-one-container-per-session-isolation), [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** [Integration test](../../src/__tests__/routes/terminal-route-validate.test.ts)

**Status:** Implemented

---

### REQ-TERM-003: Automatic WebSocket reconnection on transient failures


**Intent:** Transient network failures (connection drops, server restarts) trigger automatic reconnection so the user does not need to manually refresh.

**Applies To:** User

**Acceptance Criteria:**

1. The retryable close-code set covers the standard WebSocket "transient" codes: going-away, abnormal-closure, unexpected-condition, service-restart, and try-again-later. <!-- @impl: web-ui/src/lib/constants.ts::WS_RETRYABLE_CLOSE_CODES --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (retryable code set + 1s delay + AbortController cancellation + inputDisposable lifecycle) -->
2. Reconnection uses a short fixed delay and retries indefinitely while close codes remain in the retryable set. <!-- @impl: web-ui/src/lib/constants.ts::WS_RETRY_DELAY_MS = 1000 --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (retryable code set + 1s delay + AbortController cancellation + inputDisposable lifecycle) -->
3. On reconnection, the terminal buffer state is restored by serializing the in-memory xterm buffer and replaying it into the new connection. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (retryable code set + 1s delay + AbortController cancellation + inputDisposable lifecycle) -->
4. The input handler subscription is owned outside the connect routine and disposed before a replacement handler is attached so reconnect cannot duplicate keystrokes. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (retryable code set + 1s delay + AbortController cancellation + inputDisposable lifecycle) -->
5. Reconnection attempts are cancellable so parallel retry loops cannot accumulate across rapid disconnect-reconnect cycles. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (retryable code set + 1s delay + AbortController cancellation + inputDisposable lifecycle) -->
6. Dead-container state is never inferred from a retry-failure counter; only the server-authoritative container-stopped close code stops retries. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (retryable code set + 1s delay + AbortController cancellation + inputDisposable lifecycle) -->

**Constraints:**

- Retry loops are cancelled when a session is disposed (for example, when the session is stopped or the user navigates away).
- Dashboard navigation schedules a short WebSocket disconnect grace period; returning to the terminal within the grace window cancels the timer and reconnects without tearing down the connection.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/terminal.test.ts)

**Status:** Implemented

---

### REQ-TERM-004: Close code 4503 is authoritative (no retry)


**Intent:** The custom WebSocket close code 4503 is a server-authoritative signal that the container is not running. The client must stop retrying and display a "Session stopped" message.

**Applies To:** User

**Acceptance Criteria:**

1. The Container DO's WebSocket handler sends the dedicated container-stopped close code (4503) whenever the underlying container is not running. <!-- @impl: src/container/index.ts::container --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (4503 stops retry + disconnected state) -->
2. On receiving the container-stopped close code, the frontend immediately moves the terminal into a disconnected state and surfaces a "Session stopped" message. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (4503 stops retry + disconnected state) -->
3. The frontend does not retry the connection after receiving the container-stopped close code. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (4503 stops retry + disconnected state) -->
4. On any other close code (network failures, transient infrastructure errors), the client retries indefinitely; persistent state polling resolves the final session status. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (4503 stops retry + disconnected state) -->
5. The container-stopped close code is distinct from a 503 HTTP response on the terminal route guard so the two layers can fail independently (defense in depth). <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (4503 stops retry + disconnected state) -->

**Constraints:**

- The 4503 code falls inside the WebSocket private-use range so it cannot collide with standardized codes.
- During the startup grace window for newly started sessions, only the container-stopped close code is allowed to transition a session into the stopped state, preventing flapping while the new container is still warming up.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-SESSION-012](session-lifecycle.md#req-session-012-wake-loop-prevention)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/terminal.test.ts)

**Status:** Implemented

---

### REQ-TERM-005: Tab 1 auto-starts the configured agent


**Intent:** The first terminal tab in a session automatically launches the user's selected AI agent so they can start coding immediately without manual setup.

**Applies To:** User

**Acceptance Criteria:**

1. The Container DO passes the per-tab agent configuration to the terminal server at container start so the server knows which agent to launch in tab 1. <!-- @impl: host/src/prewarm-config.ts::getPrewarmConfig --> <!-- @test: host/__tests__/prewarm-readiness.test.js (tab 1 command extraction + first-token + ignore non-tab-1) --> <!-- @test: host/__tests__/server-prewarm.test.js (getPrewarmConfig TAB_CONFIG absent/empty + first-token) --> <!-- @test: host/__tests__/prewarm-readiness.test.js (getPrewarmConfig(parsed TAB_CONFIG) returns the tab-1 command first-token (claude/opencode/bash), null when TAB_CONFIG is absent/empty, and ignores non-id-1 entries — the mechanism by which the server knows which agent to launch in tab 1 (dist-import behavioral test)) -->
2. Tab 1 is pre-warmed at container start: the terminal server spawns a dedicated pre-warm PTY whose login shell reads the user's shell init. <!-- @impl: host/src/session-manager.ts::SessionManager --> <!-- @test: host/__tests__/session-manager.test.js (PREWARM_SESSION_ID adoption + orphanTimeout clear) --> <!-- @test: host/__tests__/session-manager.test.js (the SessionManager half of AC2: a planted PREWARM_SESSION_ID session is excluded from the active cap count, counts toward map size, and is adopted for terminal id '-1' (mocks ../dist/session.js with a FakeSession; asserts map mutations + returned object identity)) -->
3. The shell init reads the per-tab configuration and launches the configured agent (Claude Code, Codex, Antigravity, OpenCode, Copilot CLI, or Pi), each in non-interactive sandboxed mode appropriate for its CLI, or a plain bash shell when the tab is configured with no agent. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (bash-subshell harness extracts configure_tab_autostart, runs it with a temp USER_HOME + TAB_CONFIG and reads back the generated .bashrc to assert the agent launch line is emitted per CLI (claude default; dynamic lazygit/agy arms; bash fallback), invalid tab ids are rejected, and the unknown-command warning is absent for known agents) -->
4. Pre-warm readiness is detected by the first PTY output; a bounded hard timeout acts as a safety net so a permanently silent agent does not stall startup. <!-- @impl: host/src/session-manager.ts::SessionManager --> <!-- coverage-gap: the readiness gate (prewarmSession.ptyProcess.onData first-output detection, 1.5s settle, 20s PREWARM_TIMEOUT_MS hard-timeout flipping prewarmReady=true) lives entirely inside the async server.listen callback in host/src/server.ts, closing over un-exported module-level state; exercising it requires booting the real listening server and spawning a real node-pty, and it is not cleanly extractable without a non-trivial boot-path rewrite -->
5. When the first WebSocket client connects for tab 1, the pre-warmed session is adopted (re-bound from the pre-warm identifier to the real terminal ID). If no client adopts it within a bounded window, the pre-warmed session is killed. <!-- @impl: host/src/session-manager.ts::SessionManager --> <!-- @test: host/__tests__/session-manager.test.js (adoption rename + orphan timeout kill) --> <!-- @test: host/__tests__/session-manager.test.js (adoption + orphan handling: on first connect for terminal id '-1', getOrCreate rebinds the PREWARM_SESSION_ID session to the real id (prewarm key removed, new key present, same object) and clears its orphanTimeout; non-'1' ids do not adopt; delete() kills the session and removes it (asserts object identity, map state, orphanTimeout===null, _killed===true)) -->
6. The startup status stage progresses through a fixed pipeline: starting -> syncing -> verifying -> mounting (pre-warm in progress, terminal canvas hidden) -> ready (pre-warm complete, "Open" control appears). <!-- @impl: web-ui/src/lib/stages.ts::stageOrder --> <!-- @test: web-ui/src/__tests__/lib/stages.test.ts (the fixed startup pipeline ordering (creating<starting<syncing<verifying<mounting<ready, error/stopped below) via stageOrder numeric assertions and a real sort using stageOrder as comparator; the mounting-hides-canvas / ready-shows-Open gating is additionally covered behaviorally by web-ui/src/__tests__/hooks/useTerminal.test.ts (no WebSocket connect before stage reaches mounting)) -->

**Constraints:**

- Fast Start is on by default and disables CLI auto-update checks for all supported agents so startup is not blocked on remote version lookups.
- The pre-warm PTY uses a login shell so the shell-init agent-autostart logic runs.
- Agent auto-start requests sandbox-mode permission bypass so the agent starts non-interactively without prompting the user inside the pre-warm window.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-SESSION-003](session-lifecycle.md#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** [Integration test](../../host/__tests__/prewarm-readiness.test.js)

**Status:** Implemented

---

### REQ-TERM-006: User-created tabs start with plain bash


**Intent:** Tabs created by the user (clicking "+") start a plain bash shell without auto-launching an agent, giving the user a general-purpose terminal.

**Applies To:** User

**Acceptance Criteria:**

1. Tabs created by the user are marked manual in the tab configuration so downstream components can branch on the distinction. <!-- @impl: web-ui/src/stores/session-tabs.ts::addTerminalTab --> <!-- @test: web-ui/src/__tests__/stores/session-tabs.test.ts (addTerminalTab marks manually-created tabs) -->
2. The manual flag is propagated to the container via a query parameter on the WebSocket upgrade URL. <!-- @impl: web-ui/src/stores/terminal.ts::connect --> <!-- @test: web-ui/src/__tests__/stores/terminal-control-message.test.ts (connect appends ?manual=1 to the WS URL for manual terminals) -->
3. The terminal server exposes the manual flag to the PTY environment so the shell init can read it. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-process-name.test.js (manual session exposes MANUAL_TAB=1 in the PTY env) -->
4. The shell init skips its agent-autostart block when the manual flag is set. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (generated .bashrc guards autostart with MANUAL_TAB skip branch) -->
5. The resulting PTY is a plain login shell with no agent running. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (MANUAL_TAB short-circuit yields plain login shell, no agent launch) -->

**Constraints:**

- The manual flag is a frontend-originated UX hint; the backend trusts it for tab-behavior selection but not for security decisions.
- Manual tabs still have access to all installed CLI tools; the user can launch any agent from the shell.

**Priority:** P0

**Dependencies:** [REQ-TERM-001](#req-term-001-up-to-6-terminal-tabs-per-session)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/terminal-config.test.ts)

**Status:** Implemented

---

### REQ-TERM-007: Tiling layouts (2-split, 3-split, 4-grid)


**Intent:** Users can arrange terminal tabs in tiled layouts for simultaneous visibility of multiple terminals, in addition to the default tabbed view.

**Applies To:** User

**Acceptance Criteria:**

1. Four layout modes are supported: tabbed (single terminal visible), two-split (side by side), three-split (one left, two right), and four-grid (2x2). <!-- @impl: web-ui/src/stores/tiling.ts::LAYOUT_MIN_TABS --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (4 layout modes + min tab count + upgrade order) -->
2. Each layout has a minimum tab count equal to the number of panes it shows. <!-- @impl: web-ui/src/stores/tiling.ts::isLayoutCompatible --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (4 layout modes + min tab count + upgrade order) -->
3. A compatibility check validates whether a session has enough tabs for the requested layout before applying it. <!-- @impl: web-ui/src/stores/tiling.ts::isLayoutCompatible --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (4 layout modes + min tab count + upgrade order) -->
4. Adding a tab beyond the current layout's pane count downgrades the layout to tabbed rather than auto-upgrading to a larger tiling layout. <!-- @impl: web-ui/src/stores/session-tabs.ts::addTerminalTab --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (4 layout modes + min tab count + upgrade order) -->
5. A best-layout helper resolves the highest layout compatible with a given tab count so the UI can land users on the most spacious view by default. <!-- @impl: web-ui/src/stores/tiling.ts::getBestLayoutForTabCount --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (4 layout modes + min tab count + upgrade order) -->
6. Layout state is persisted per session and restored on reconnection. <!-- @impl: web-ui/src/stores/tiling.ts::setTilingLayout --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (4 layout modes + min tab count + upgrade order) -->
7. Applying an incompatible layout (insufficient tabs) or targeting a missing session fails cleanly rather than partially applying. <!-- @impl: web-ui/src/stores/tiling.ts::setTilingLayout --> <!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (4 layout modes + min tab count + upgrade order) -->

**Constraints:**

- The tiling store accesses the session store lazily to avoid a circular dependency between the two pieces of UI state.
- Layout changes trigger terminal resize events so the rendering library reflows content.

**Priority:** P2

**Dependencies:** [REQ-TERM-001](#req-term-001-up-to-6-terminal-tabs-per-session)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/tiling.test.ts)

**Status:** Implemented

---

### REQ-TERM-008: Write batching at 30fps


**Intent:** Rapid WebSocket messages are coalesced into batched `terminal.write()` calls at 30fps to reduce rendering overhead without perceptible latency increase.

**Applies To:** User

**Acceptance Criteria:**

1. Incoming WebSocket messages are appended to a per-terminal write buffer keyed by the compound terminal identity. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (33ms flush + buffer coalescing + per-key cancellation) -->
2. A flush is scheduled on a fixed cadence corresponding to roughly 30 frames per second so render passes are bounded even under burst output. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (33ms flush + buffer coalescing + per-key cancellation) -->
3. On flush, all buffered output for a terminal is concatenated and written to the rendering library in a single call. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (33ms flush + buffer coalescing + per-key cancellation) -->
4. The 30 fps flush rate halves the render-pass count compared to 60 fps without producing perceptible latency for typed input or interactive output. <!-- @impl: web-ui/src/stores/terminal.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (33ms flush + buffer coalescing + per-key cancellation) -->
5. The added flush latency stays below the human input-feedback perception threshold. <!-- @impl: web-ui/src/stores/terminal.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (33ms flush + buffer coalescing + per-key cancellation) -->
6. Pending flushes are tracked per terminal and cancelled on terminal disposal. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (33ms flush + buffer coalescing + per-key cancellation) -->

**Constraints:**

- Write buffers use the compound terminal identity so each tab's stream is coalesced independently.
- Programmatic scroll-position adjustments after a write are tracked separately so they cannot be misinterpreted as a user-initiated scroll reset.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/terminal.test.ts)

**Status:** Implemented

---

### REQ-TERM-009: Process name detection via control messages


**Intent:** The terminal server detects the foreground process running in each PTY and sends the process name to the frontend for display in tab labels and session cards.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal server emits process-name control messages over the WebSocket whenever the foreground process for a PTY changes. <!-- @impl: host/src/session.ts::Session --> <!-- @test: host/__tests__/session-process-name.test.js (emitProcessNameIfChanged broadcasts a process-name frame only when the value changes) -->
2. The frontend distinguishes control messages from raw terminal data using the message's leading type-discriminator field. <!-- @impl: web-ui/src/stores/terminal.ts::parseControlMessage --> <!-- @test: web-ui/src/__tests__/stores/terminal-control-message.test.ts (control-message type discrimination: process-name/restore/raw/malformed) -->
3. The frontend maps known foreground process names (supported agents plus common TUI tools and shells) to display icons via a static lookup. <!-- @impl: web-ui/src/lib/terminal-config.ts::getTabIcon --> <!-- @test: web-ui/src/__tests__/lib/terminal-config.test.ts (PROCESS_ICON_MAP -> getTabIcon per process kind) -->
4. An optional binary-name-to-display-name override table exists for cases where the executable name differs from the user-facing name; the override table is empty when no remap is needed. <!-- @impl: web-ui/src/lib/terminal-config.ts::getTabDisplayName --> <!-- @test: web-ui/src/__tests__/lib/terminal-config.test.ts (getTabDisplayName fallback when override empty) -->
5. The session card icon set covers each supported agent type so users can identify a session at a glance. <!-- @impl: web-ui/src/lib/terminal-config.ts::AGENT_ICON_MAP --> <!-- @test: web-ui/src/__tests__/lib/terminal-config.test.ts (AGENT_ICON_MAP covers all agent types) -->
6. The session store registers a process-name callback against the terminal store so process updates propagate without creating a circular import between the two stores. <!-- @impl: web-ui/src/stores/terminal.ts::registerProcessNameCallback --> <!-- @test: web-ui/src/__tests__/stores/terminal-control-message.test.ts (registered callback routes a dispatched process-name frame) -->
7. Process name updates are reflected in tab headers and session status cards in real time. <!-- @impl: web-ui/src/stores/session-tabs.ts::updateTerminalLabel --> <!-- @test: web-ui/src/__tests__/stores/update-terminal-label.test.ts (updateTerminalLabel writes processName + overwrites + only targeted tab + no-op for missing session/terminal) -->

**Constraints:**

- Control messages that fail to parse as JSON are treated as raw terminal data so an unexpected payload never blocks output.
- Unknown control-message types are silently ignored so the protocol can evolve without breaking older clients.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/update-terminal-label.test.ts)

**Status:** Implemented

---

### REQ-TERM-010: Session presets (saved tab configurations)


**Intent:** Users save and reuse their preferred tab layouts across sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Users can save the current tab configuration as a named preset. <!-- @impl: src/routes/presets.ts::app --> <!-- @test: src/__tests__/routes/presets-req-term-010.test.ts (POST preset name+tabs + 201) --> <!-- @test: web-ui/src/__tests__/stores/session-presets-ac-coverage.test.ts (savePreset state append) -->
2. Each user is capped at a small fixed number of presets to keep the preset picker scannable. <!-- @impl: src/routes/presets.ts::app --> <!-- @test: src/__tests__/routes/presets-req-term-010.test.ts (3-max cap enforcement) -->
3. Presets are exposed via a dedicated CRUD endpoint set. <!-- @impl: src/routes/presets.ts::app --> <!-- @test: src/__tests__/routes/presets-req-term-010.test.ts (POST/GET/PATCH/DELETE CRUD endpoints) --> <!-- @test: src/__tests__/routes/presets.test.ts (Presets Routes GET/POST/DELETE) -->
4. Applying a preset to a new session populates the tab configuration from the preset. <!-- @impl: web-ui/src/stores/session-presets.ts::applyPresetToSession --> <!-- @test: web-ui/src/__tests__/stores/session-presets-ac-coverage.test.ts (applyPresetToSession populates tabConfig + tab 1 preserved + 404 on missing) -->
5. Deleting a preset removes it from the user's preset list. <!-- @impl: src/routes/presets.ts::app --> <!-- @test: src/__tests__/routes/presets-req-term-010.test.ts (DELETE removes preset from list) -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-TERM-001](#req-term-001-up-to-6-terminal-tabs-per-session)

**Verification:** [Integration test](../../src/__tests__/routes/presets-req-term-010.test.ts)

**Status:** Implemented

---

### REQ-TERM-011: Visible terminal panes own WebSocket connections

**Intent:** Terminal WebSockets are opened only for terminal panes that are visible in the current browser workspace, preventing hidden sessions from attaching to PTYs and sending stale resize or input traffic.

**Applies To:** User

**Acceptance Criteria:**

1. Dashboard view opens zero terminal WebSocket connections even when sessions are running or initializing. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::setDashboardWorkspace --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (dashboard zero panes) --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (dashboard no terminals) -->
2. Single-session view opens terminal WebSockets only for the visible session surface: one active tab in tabbed mode, or each visible tiled tab when tiling is enabled. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::setSingleSessionWorkspace --> <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (single-session one pane) --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (visible single pane) -->
3. Running sessions outside the visible workspace have no connected terminal side effects. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (connect=false no WS) --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (MultiView panes only) -->
4. Workspace switches dispose local UI terminal resources for panes that leave the visible set without stopping the underlying PTY. <!-- @impl: web-ui/src/hooks/useTerminal.ts::canConnect --> <!-- @impl: web-ui/src/stores/terminal.ts::disposeLocalTerminal --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (single-pane teardown without stopping PTY) --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (visible-key reconnect filter) -->
5. Session indicators distinguish container-running state from visible-terminal-connected state. <!-- @impl: web-ui/src/components/SessionStatCard.tsx::dotVariant --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (shows yellow warning dot when running but WS disconnected + shows green dot when running and WS connected) -->

**Constraints:**

- Hidden terminal preservation cannot be used as an instant-switching optimization if it opens a WebSocket.
- Dashboard status must remain a polling/storage concern and must not depend on terminal component side effects.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-003](#req-term-003-automatic-websocket-reconnection-on-transient-failures)

**Verification:** [Automated tests](../../web-ui/src/__tests__/components/TerminalArea.test.tsx), [Hook tests](../../web-ui/src/__tests__/hooks/useTerminal.test.ts), [Terminal store tests](../../web-ui/src/__tests__/stores/terminal.test.ts), [Layout tests](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented
---

### REQ-TERM-012: MultiView virtual session workspace

**Intent:** Users can open one virtual MultiView workspace that displays multiple existing sessions side by side without creating a backend session or changing the member sessions' lifecycle.

**Applies To:** User

**Acceptance Criteria:**

1. Exactly one virtual MultiView workspace can exist, and it is composed only from existing running or initializing sessions. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::MULTIVIEW_ID --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (single MultiView composed from existing sessions) -->
2. Desktop MultiView accepts two to four member sessions; tablet MultiView accepts exactly two; mobile cannot launch MultiView. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::getMultiViewCapacity --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (desktop/tablet/mobile capacity) -->
3. MultiView never appears as a normal Dashboard session card; when saved panes exist, Dashboard exposes an icon-only MultiView action beside the new-session button. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (MultiView never a session card; icon-only action opens without backend session ID) -->
4. Opening MultiView renders connected terminal panes for the selected member sessions. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (one connected pane per MultiView member) --> <!-- @test: web-ui/src/__tests__/components/TerminalGrid.test.tsx (reusable layout slots) -->
5. Workspace switches preserve MultiView membership while reconciling connections to visible panes. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/stores/terminal-workspace.test.ts (membership preserved across reconciliation) --> <!-- @test: web-ui/src/__tests__/components/TerminalGrid.test.tsx (stable pane ids do not dispose) -->

**Constraints:**

- MultiView is frontend workspace state and must not be sent to backend session lifecycle, terminal route validation, storage, quota, or metrics APIs as a real session ID.
- MultiView membership is local browser state unless a future requirement adds cross-browser workspace sync.

**Priority:** P1

**Dependencies:** [REQ-TERM-001](#req-term-001-up-to-6-terminal-tabs-per-session), [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-007](#req-term-007-tiling-layouts-2-split-3-split-4-grid), [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

**Verification:** [Workspace store tests](../../web-ui/src/__tests__/stores/terminal-workspace.test.ts) + [TerminalArea tests](../../web-ui/src/__tests__/components/TerminalArea.test.tsx) + [TerminalGrid tests](../../web-ui/src/__tests__/components/TerminalGrid.test.tsx) + [Dashboard tests](../../web-ui/src/__tests__/components/Dashboard.test.tsx) + [Floating button tests](../../web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx)

**Status:** Implemented
---

### REQ-TERM-013: MultiView selection flow

**Intent:** Users create or reopen MultiView from the existing session switcher using a selection mode that is clear on desktop and tablet and unavailable on mobile.

**Applies To:** User

**Acceptance Criteria:**

1. The session switcher exposes a `Launch MultiView` control with the compact-view icon only when at least two sessions are running or initializing on tablet or desktop, and hides the control on mobile. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @impl: web-ui/src/components/MultiViewActionRow.tsx::MultiViewActionRow --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (Launch MultiView label/icon + mobile hidden) -->
2. Activating the control enters selection mode, keeps the switcher open, and turns running or initializing session rows into toggleable choices. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (enter selection mode keeps switcher open + toggleable rows) -->
3. The control exits selection mode without launching when fewer than two sessions are selected. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (exit selection without launch when < 2 selected) -->
4. The control launches MultiView when at least two sessions are selected. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (launch when >= 2 selected) --> <!-- @test: web-ui/src/__tests__/components/SessionSwitcher.test.tsx (selected ids create the workspace) -->
5. Selecting beyond the viewport capacity is rejected without changing the existing selected set. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (capacity rejection without changing selected set) -->
6. Selected session rows expose a selected state using the success visual variant. <!-- @impl: web-ui/src/components/SelectableSessionCard.tsx::SelectableSessionCard --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (selectable session rows expose data-selected state for the success variant) -->

**Constraints:**

- Stopped sessions are not selectable for MultiView.
- Capacity decisions must come from a shared viewport-capacity helper rather than duplicated component branches.

**Priority:** P1

**Dependencies:** [REQ-TERM-012](#req-term-012-multiview-virtual-session-workspace)

**Verification:** [Automated tests](../../web-ui/src/__tests__/components/SessionDropdown.test.tsx), [Session switcher tests](../../web-ui/src/__tests__/components/SessionSwitcher.test.tsx)

**Status:** Implemented
---

### REQ-TERM-014: Terminal scroll anchoring under scrollback trimming

**Intent:** Long-running terminal output remains stable when scrollback is trimmed, so following output stays at the prompt and user-scrolled views do not jump unexpectedly.

**Applies To:** User

**Acceptance Criteria:**

1. A terminal following the bottom remains at the bottom while output exceeds the scrollback cap. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (bottom re-anchor) -->
2. A terminal scrolled away from the bottom preserves its distance from the bottom while additional output arrives. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (user scroll distance preservation) -->
3. Catastrophic scroll reset correction runs only for true reset events and does not loop on ordinary scrollback trimming. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (reset correction does not loop on trimming) -->
4. Resizing a visible terminal preserves the user's scroll anchor. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-TERM-014 terminal scroll anchoring) -->
5. Visible terminal resize frames carry the current fitted dimensions. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (resize handling) -->
6. Hidden or disconnected terminals do not send resize frames. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal.ts::resize --> <!-- @test: host/__tests__/session-resize-authority.test.js (foreground owner only + detach promotion) -->
7. A pane that loses focus before its terminal connection opens does not claim resize authority when that connection later opens. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal.ts::clearPendingResizeAuthority --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (stale queued focus clearing) --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (queued focus clearing) -->

**Constraints:**

- Scroll ownership must be centralized so write, resize, and reset-correction paths do not fight each other.
- Mobile keyboard resize behavior must preserve the existing virtual-keyboard safeguards.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-008](#req-term-008-write-batching-at-30fps), [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

**Verification:** [Automated tests](../../web-ui/src/__tests__/hooks/useScrollCorrection.test.ts) + [Resize authority test](../../host/__tests__/session-resize-authority.test.js) + [Layout transition test](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

### REQ-TERM-015: Focused Pane Owns URL Detection


**Intent:** Browser URL detection must belong to the focused connected terminal pane so stale panes cannot clear the active pane's detected URL.

**Applies To:** User

**Acceptance Criteria:**

1. Starting URL detection records the owning session and terminal id for the focused connected pane. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal-url-detection.ts::startUrlDetection --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (URL detection lifecycle start records owner) --> <!-- @test: web-ui/src/__tests__/stores/terminal-url-detection.test.ts (startUrlDetection records owning session+terminal id) -->
2. Cleanup stops URL detection only for the same owning session and terminal id. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal-url-detection.ts::stopUrlDetection --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (URL detection cleanup scoped to owner) --> <!-- @test: web-ui/src/__tests__/stores/terminal-url-detection.test.ts (stopUrlDetection only for same owner) -->

**Constraints:**

- Unscoped cleanup is reserved for explicit global resets, not terminal component unmounts.

**Priority:** P0

**Dependencies:** [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

**Verification:** [Hook tests](../../web-ui/src/__tests__/hooks/useTerminal.test.ts), [URL detection tests](../../web-ui/src/__tests__/stores/terminal-url-detection.test.ts)

**Status:** Implemented

### REQ-TERM-016: Terminal Pane Reconnect and Resize Authority

**Intent:** When a visible terminal pane returns to view or a focused pane reconnects, it reconnects only the panes visible in the current workspace, claims resize authority before sending dimensions, and a stale connection owner can never dispose the newer WebSocket for the same visible terminal. Connection ownership by visibility is defined in [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections).

**Applies To:** User

**Acceptance Criteria:**

1. Browser visibility return reconnects only panes or tiled tabs that are visible in the current workspace. <!-- @impl: web-ui/src/components/Layout.tsx::visibleTerminalKeys --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (queued focus before initial resize) -->
2. A focused visible terminal claims resize authority before sending dimensions, including retry reconnects that remain focused. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/stores/terminal.ts::claimResizeAuthority --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (focused=false clears stale focus + focused pane claims resize authority) --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (focus ownership control frame) -->
3. Cleanup from a stale connection owner cannot dispose the newer WebSocket or input handler for the same visible terminal. <!-- @impl: web-ui/src/stores/terminal.ts::connect --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (stale cleanup from an older connection cannot close a newer connection for the same terminal) -->

**Constraints:**

- Hidden terminal preservation cannot be used as an instant-switching optimization if it opens a WebSocket.
- Dashboard status must remain a polling/storage concern and must not depend on terminal component side effects.

**Priority:** P0

**Dependencies:** [REQ-TERM-011](#req-term-011-visible-terminal-panes-own-websocket-connections)

**Verification:** [Automated tests](../../web-ui/src/__tests__/components/TerminalArea.test.tsx), [Hook tests](../../web-ui/src/__tests__/hooks/useTerminal.test.ts), [Terminal store tests](../../web-ui/src/__tests__/stores/terminal.test.ts), [Layout tests](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

### REQ-TERM-017: MultiView Pane Focus and Input Routing

**Intent:** Within a MultiView workspace ([REQ-TERM-012](#req-term-012-multiview-virtual-session-workspace)), clicking between panes changes focus only without remounting or reconnecting, each member exposes exactly one terminal surface with no nested tab controls, and keyboard / floating-button input targets the focused pane even when no single session is active.

**Applies To:** User

**Acceptance Criteria:**

1. Clicking between MultiView panes changes focus only and does not remount panes or reconnect their WebSockets. <!-- @impl: web-ui/src/components/TerminalArea.tsx::multiViewGridPanes --> <!-- @impl: web-ui/src/components/TerminalArea.tsx::sessionNamesById --> <!-- @impl: web-ui/src/components/TerminalGrid.tsx::TerminalGrid --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (focus changes do not remount panes + workspace terminal id source of truth) --> <!-- @test: web-ui/src/__tests__/components/TerminalGrid.test.tsx (keyed pane-id subtree replacement + clearing panes renders empty slots without stale deref) -->
2. Each MultiView member gets exactly one terminal surface; nested tab controls are absent. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/TerminalArea.test.tsx (no nested tabs per member) -->
3. Keyboard and floating-button input targets the focused MultiView pane even though no single session is active. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (floating-button keys route to focused MultiView pane when activeSessionId is null) -->

**Constraints:**

- MultiView is frontend workspace state and must not be sent to backend session lifecycle, terminal route validation, storage, quota, or metrics APIs as a real session ID.
- MultiView membership is local browser state unless a future requirement adds cross-browser workspace sync.

**Priority:** P1

**Dependencies:** [REQ-TERM-012](#req-term-012-multiview-virtual-session-workspace)

**Verification:** [Workspace store tests](../../web-ui/src/__tests__/stores/terminal-workspace.test.ts) + [TerminalArea tests](../../web-ui/src/__tests__/components/TerminalArea.test.tsx) + [TerminalGrid tests](../../web-ui/src/__tests__/components/TerminalGrid.test.tsx) + [Dashboard tests](../../web-ui/src/__tests__/components/Dashboard.test.tsx) + [Floating button tests](../../web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx)

**Status:** Implemented

---

### REQ-TERM-018: MultiView Reopen and Close

**Intent:** Beyond the initial selection flow ([REQ-TERM-013](#req-term-013-multiview-selection-flow)), reopening an existing MultiView opens the same virtual workspace rather than creating another, and closing it from the session switcher deactivates the virtual workspace and closes the dropdown.

**Applies To:** User

**Acceptance Criteria:**

1. Reopening an existing MultiView opens the same virtual workspace rather than creating another MultiView. <!-- @impl: web-ui/src/components/SessionSwitcher.tsx::SessionSwitcher --> <!-- @test: web-ui/src/__tests__/components/SessionSwitcher.test.tsx (reopen existing MultiView delegates to Layout) -->
2. Closing an existing MultiView from the session switcher deactivates the virtual workspace and closes the dropdown. <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @impl: web-ui/src/components/Layout.tsx::handleCloseMultiView --> <!-- @test: web-ui/src/__tests__/components/SessionDropdown.test.tsx (close button deactivates existing MultiView and closes dropdown) --> <!-- @test: web-ui/src/__tests__/components/SessionSwitcher.test.tsx (close delegates to Layout) -->

**Constraints:**

- Stopped sessions are not selectable for MultiView.
- Capacity decisions must come from a shared viewport-capacity helper rather than duplicated component branches.

**Priority:** P1

**Dependencies:** [REQ-TERM-013](#req-term-013-multiview-selection-flow)

**Verification:** [Automated tests](../../web-ui/src/__tests__/components/SessionDropdown.test.tsx), [Session switcher tests](../../web-ui/src/__tests__/components/SessionSwitcher.test.tsx)

**Status:** Implemented

---
