# Terminal

PTY management, WebSocket transport, multi-tab support, tiling layouts, and process detection.

**Domain owner:** Frontend (SolidJS + xterm.js) + Container (terminal server)

### Key Concepts

- **PTY** -- Pseudo-terminal; the OS-level device that bridges a shell process to terminal I/O over the WebSocket.
- **WebSocket** -- The bidirectional transport carrying raw terminal data and JSON control messages between browser and container.
- **Terminal Tab** -- A single terminal instance within a session, identified by a compound key (`sessionId:terminalId`), each backed by its own PTY.
- **Tiling Layout** -- An arrangement mode (tabbed, 2-split, 3-split, 4-grid) that displays multiple terminals simultaneously.

### Out of Scope

- Terminal recording and playback (session replay)
- Collaborative terminal sharing (multi-user viewing or input on the same PTY)

### Domain Dependencies

- **Session Lifecycle** (container must be running) -- Terminal connections require an active, running container.
- **Authentication** (WebSocket auth) -- WebSocket upgrade requests are authenticated via the Worker middleware and container auth token.

---

<!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (REQ-TERM-001 AC2 describe -> compound key parse + URL forward + KV baseSessionId validate; REQ-TERM-001 AC3 describe -> SESSION_ID_PATTERN reject + 400 INVALID_SESSION -> AC2,3) -->
<!-- @test: host/__tests__/session-manager.test.js (SessionManager describe -> getOrCreate cap-null + prewarm exclusion + adopt prewarm + compound-id map keying -> AC4,5,6) -->
<!-- @test: host/__audits__/terminal-compound-key.audit.js (REQ-TERM-001 AC6 describe -> server "Session limit reached" close -> AC6 server-side close half) -->
### REQ-TERM-001: Up to 6 terminal tabs per session

<!-- @test: src/__tests__/lib/cross-package-constants.test.ts (Cross-Package Constants describe → MAX_TABS == MAX_TERMINALS_PER_SESSION → AC1) -->

**Intent:** Each session supports multiple concurrent terminal instances (up to 6) so users can run an agent in one tab and auxiliary commands in others.

**Applies To:** User

**Acceptance Criteria:**

1. The maximum terminal count per session is six, defined as a shared constant referenced by both frontend and backend so neither can drift. <!-- @impl: src/lib/constants.ts::MAX_TABS = 6 -->
2. Each terminal tab is identified by a compound key built from the session ID and the per-tab terminal ID; the same identity travels through the WebSocket URL. <!-- @impl: src/routes/terminal.ts::validateWebSocketRoute -->
3. The backend parses the compound ID, validates the base session, and forwards the full compound ID into the container. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade -->
4. The container's session manager handles each compound ID as a separate PTY process with independent state. <!-- @impl: host/src/session-manager.ts::SessionManager -->
5. The container's session cap check excludes pre-warmed PTYs from the active count so pre-warming does not consume a tab slot. <!-- @impl: host/src/session-manager.ts::SessionManager -->
6. Attempting to create a seventh terminal in a session is rejected. <!-- @impl: host/src/session-manager.ts::SessionManager -->

**Constraints:**

- The frontend's compound-key encoding and the backend's URL-path encoding must be reversible into the same logical identity; mismatched encodings would break tab adoption.
- Terminal IDs are scoped within a session; they are not globally unique.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](session-lifecycle.md#req-session-002-one-container-per-session-isolation)

**Verification:** [Automated test](../../src/__tests__/routes/terminal-route-validate.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (REQ-TERM-002 AC1 describe -> WS URL pattern + Upgrade header gating -> AC1) -->
<!-- @test: host/__audits__/terminal-compound-key.audit.js (REQ-TERM-002 describe -> login shell + xterm-256color env + raw send + JSON control msgs + resize + type guard + protocol ping -> AC3..AC7 host-side) -->
### REQ-TERM-002: WebSocket connection to container PTY

<!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (REQ-TERM-002 AC1 describe -> WS URL shape /api/terminal/{sid}-{tid}/ws) + src/__tests__/routes/terminal.test.ts (validateWebSocketRoute describes -> AC1/AC2 WS URL + upgrade) + host/__audits__/terminal-compound-key.audit.js (REQ-TERM-002 audit -> AC3/AC4/AC5/AC6/AC7 PTY spawn + raw data + JSON control frames + unknown-type tolerance + no app-level ping) -->

**Intent:** Each terminal tab connects to its PTY process inside the container via a WebSocket, carrying raw terminal data bidirectionally.

**Applies To:** User

**Acceptance Criteria:**

1. The WebSocket URL embeds the compound terminal identity (session ID and per-tab terminal ID) on a stable path under the terminal route. <!-- @impl: src/routes/terminal.ts::validateWebSocketRoute -->
2. The Worker upgrades the HTTP request to a WebSocket and forwards it through the Container DO to the in-container terminal server. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade -->
3. The terminal server spawns a login shell PTY with full-color terminal emulation so interactive TUI applications render correctly. <!-- @impl: host/src/session.ts::Session -->
4. Raw terminal data flows over the WebSocket without JSON wrapping so binary-clean PTY output is preserved. <!-- @impl: host/src/session.ts::Session -->
5. Out-of-band control messages (resize, process-name, restore) are encoded as JSON objects identifiable by a leading type-discriminator field. <!-- @impl: host/src/session.ts::Session -->
6. Unknown control-message types are silently ignored so the wire protocol can grow without breaking older clients or servers. <!-- @impl: host/src/session.ts::Session -->
7. No application-level ping/pong is implemented; the transport layer handles WebSocket keepalive on its own. <!-- @impl: host/src/session.ts::Session -->

**Constraints:**

- WebSocket upgrade handling must run before the application router because of a Worker-runtime limitation that prevents WebSocket frames from reaching downstream middleware.
- All proxied HTTP requests from the DO to the container carry the shared container auth token; only the health and activity probes are exempt.

**Priority:** P0

**Dependencies:** [REQ-SESSION-002](session-lifecycle.md#req-session-002-one-container-per-session-isolation), [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** [Integration test](../../src/__tests__/routes/terminal-route-validate.test.ts)

**Status:** Implemented

---

### REQ-TERM-003: Automatic WebSocket reconnection on transient failures

<!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store describe → retryable code set + 1s delay + AbortController cancellation + inputDisposable lifecycle → AC1-AC6) -->

**Intent:** Transient network failures (connection drops, server restarts) trigger automatic reconnection so the user does not need to manually refresh.

**Applies To:** User

**Acceptance Criteria:**

1. The retryable close-code set covers the standard WebSocket "transient" codes: going-away, abnormal-closure, unexpected-condition, service-restart, and try-again-later. <!-- @impl: web-ui/src/lib/constants.ts::WS_RETRYABLE_CLOSE_CODES -->
2. Reconnection uses a short fixed delay and retries indefinitely while close codes remain in the retryable set. <!-- @impl: web-ui/src/lib/constants.ts::WS_RETRY_DELAY_MS = 1000 -->
3. On reconnection, the terminal buffer state is restored by serializing the in-memory xterm buffer and replaying it into the new connection. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->
4. The input handler subscription is owned outside the connect routine and disposed before a replacement handler is attached so reconnect cannot duplicate keystrokes. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->
5. Reconnection attempts are cancellable so parallel retry loops cannot accumulate across rapid disconnect-reconnect cycles. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->
6. Dead-container state is never inferred from a retry-failure counter; only the server-authoritative container-stopped close code stops retries. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->

**Constraints:**

- Retry loops are cancelled when a session is disposed (for example, when the session is stopped or the user navigates away).
- Dashboard navigation schedules a short WebSocket disconnect grace period; returning to the terminal within the grace window cancels the timer and reconnects without tearing down the connection.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/terminal.test.ts)

**Status:** Implemented

---

### REQ-TERM-004: Close code 4503 is authoritative (no retry)

<!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store describe → 4503 stops retry + disconnected state → AC1-AC5) -->

**Intent:** The custom WebSocket close code 4503 is a server-authoritative signal that the container is not running. The client must stop retrying and display a "Session stopped" message.

**Applies To:** User

**Acceptance Criteria:**

1. The Container DO's WebSocket handler sends the dedicated container-stopped close code (4503) whenever the underlying container is not running. <!-- @impl: src/container/index.ts::container -->
2. On receiving the container-stopped close code, the frontend immediately moves the terminal into a disconnected state and surfaces a "Session stopped" message. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->
3. The frontend does not retry the connection after receiving the container-stopped close code. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->
4. On any other close code (network failures, transient infrastructure errors), the client retries indefinitely; persistent state polling resolves the final session status. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->
5. The container-stopped close code is distinct from a 503 HTTP response on the terminal route guard so the two layers can fail independently (defense in depth). <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade -->

**Constraints:**

- The 4503 code falls inside the WebSocket private-use range so it cannot collide with standardized codes.
- During the startup grace window for newly started sessions, only the container-stopped close code is allowed to transition a session into the stopped state, preventing flapping while the new container is still warming up.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty), [REQ-SESSION-012](session-lifecycle.md#req-session-012-wake-loop-prevention)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/terminal.test.ts)

**Status:** Implemented

---

<!-- @test: host/__tests__/prewarm-readiness.test.js (REQ-SESSION-015 / REQ-TERM-005 describe -> tab 1 command extraction + first-token + ignore non-tab-1 -> AC1) -->
<!-- @test: host/__tests__/server-prewarm.test.js (getPrewarmConfig (server integration) describe -> TAB_CONFIG absent/empty + first-token -> AC1) -->
<!-- @test: host/__tests__/session-manager.test.js (SessionManager describe -> PREWARM_SESSION_ID adoption + orphanTimeout clear + tab-1-only rename -> AC2,5 adoption mechanism) -->
<!-- @test: host/__audits__/server-prewarm-lifecycle.audit.js (REQ-TERM-005 describe -> server-boot wiring: sessions.set + onData + 20s setTimeout + orphan setTimeout + terminalServiceReady -> AC2..AC6 server-boot half) -->
### REQ-TERM-005: Tab 1 auto-starts the configured agent

<!-- @impl: entrypoint.sh::configure_tab_autostart -->
<!-- @impl: host/src/prewarm-config.ts -->
<!-- @impl: host/src/session-manager.ts -->
<!-- @test: host/__audits__/server-prewarm-lifecycle.audit.js (REQ-TERM-005 server.ts boot wiring audit -> AC1/AC2/AC3/AC4/AC5/AC6 prewarm PTY + readiness gate + adoption window + status pipeline) + host/__tests__/prewarm-readiness.test.js (getPrewarmConfig describes -> AC1 tab-1 config propagation + AC3 agent-launch dispatch) -->

**Intent:** The first terminal tab in a session automatically launches the user's selected AI agent so they can start coding immediately without manual setup.

**Applies To:** User

**Acceptance Criteria:**

1. The Container DO passes the per-tab agent configuration to the terminal server at container start so the server knows which agent to launch in tab 1. <!-- @impl: host/src/prewarm-config.ts::getPrewarmConfig -->
2. Tab 1 is pre-warmed at container start: the terminal server spawns a dedicated pre-warm PTY whose login shell reads the user's shell init. <!-- @impl: host/src/session-manager.ts::SessionManager -->
3. The shell init reads the per-tab configuration and launches the configured agent (Claude Code, Codex, Antigravity, OpenCode, Copilot CLI, or Pi), each in non-interactive sandboxed mode appropriate for its CLI, or a plain bash shell when the tab is configured with no agent. <!-- @impl: entrypoint.sh::configure_tab_autostart -->
4. Pre-warm readiness is detected by the first PTY output; a bounded hard timeout acts as a safety net so a permanently silent agent does not stall startup.
5. When the first WebSocket client connects for tab 1, the pre-warmed session is adopted (re-bound from the pre-warm identifier to the real terminal ID). If no client adopts it within a bounded window, the pre-warmed session is killed. <!-- @impl: host/src/session-manager.ts::SessionManager -->
6. The startup status stage progresses through a fixed pipeline: starting -> syncing -> verifying -> mounting (pre-warm in progress, terminal canvas hidden) -> ready (pre-warm complete, "Open" control appears).

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

<!-- @impl: host/src/session.ts -->
<!-- @impl: entrypoint.sh::configure_tab_autostart -->
<!-- @test: web-ui/src/__tests__/lib/terminal-config.test.ts (terminal-config describe → manual flag + ?manual=1 query → MANUAL_TAB env → AC1-AC5) -->

**Intent:** Tabs created by the user (clicking "+") start a plain bash shell without auto-launching an agent, giving the user a general-purpose terminal.

**Applies To:** User

**Acceptance Criteria:**

1. Tabs created by the user are marked manual in the tab configuration so downstream components can branch on the distinction.
2. The manual flag is propagated to the container via a query parameter on the WebSocket upgrade URL.
3. The terminal server exposes the manual flag to the PTY environment so the shell init can read it. <!-- @impl: host/src/session.ts::Session -->
4. The shell init skips its agent-autostart block when the manual flag is set. <!-- @impl: entrypoint.sh::configure_tab_autostart -->
5. The resulting PTY is a plain login shell with no agent running. <!-- @impl: entrypoint.sh::configure_tab_autostart -->

**Constraints:**

- The manual flag is a frontend-originated UX hint; the backend trusts it for tab-behavior selection but not for security decisions.
- Manual tabs still have access to all installed CLI tools; the user can launch any agent from the shell.

**Priority:** P0

**Dependencies:** [REQ-TERM-001](#req-term-001-up-to-6-terminal-tabs-per-session)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/terminal-config.test.ts)

**Status:** Implemented

---

### REQ-TERM-007: Tiling layouts (2-split, 3-split, 4-grid)

<!-- @impl: web-ui/src/stores/tiling.ts::setTilingLayout -->
<!-- @impl: web-ui/src/stores/tiling.ts::isLayoutCompatible -->
<!-- @impl: web-ui/src/stores/tiling.ts::getBestLayoutForTabCount -->
<!-- @impl: web-ui/src/stores/session-tabs.ts::addTerminalTab -->
<!-- @test: web-ui/src/__tests__/stores/tiling.test.ts (Tiling Module - Pure Helpers describe → 4 layout modes + min tab count + upgrade order → AC1-AC7) -->

**Intent:** Users can arrange terminal tabs in tiled layouts for simultaneous visibility of multiple terminals, in addition to the default tabbed view.

**Applies To:** User

**Acceptance Criteria:**

1. Four layout modes are supported: tabbed (single terminal visible), two-split (side by side), three-split (one left, two right), and four-grid (2x2).
2. Each layout has a minimum tab count equal to the number of panes it shows. <!-- @impl: web-ui/src/stores/tiling.ts::isLayoutCompatible -->
3. A compatibility check validates whether a session has enough tabs for the requested layout before applying it. <!-- @impl: web-ui/src/stores/tiling.ts::isLayoutCompatible -->
4. Adding a tab beyond the current layout's pane count downgrades the layout to tabbed rather than auto-upgrading to a larger tiling layout. <!-- @impl: web-ui/src/stores/session-tabs.ts::addTerminalTab -->
5. A best-layout helper resolves the highest layout compatible with a given tab count so the UI can land users on the most spacious view by default. <!-- @impl: web-ui/src/stores/tiling.ts::getBestLayoutForTabCount -->
6. Layout state is persisted per session and restored on reconnection. <!-- @impl: web-ui/src/stores/tiling.ts::setTilingLayout -->
7. Applying an incompatible layout (insufficient tabs) or targeting a missing session fails cleanly rather than partially applying. <!-- @impl: web-ui/src/stores/tiling.ts::setTilingLayout -->

**Constraints:**

- The tiling store accesses the session store lazily to avoid a circular dependency between the two pieces of UI state.
- Layout changes trigger terminal resize events so the rendering library reflows content.

**Priority:** P2

**Dependencies:** [REQ-TERM-001](#req-term-001-up-to-6-terminal-tabs-per-session)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/tiling.test.ts)

**Status:** Implemented

---

### REQ-TERM-008: Write batching at 30fps

<!-- @impl: web-ui/src/stores/terminal.ts::flushWriteBuffer -->
<!-- @impl: web-ui/src/stores/terminal.ts -->
<!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store describe → 33ms flush + buffer coalescing + per-key cancellation → AC1-AC6) -->

**Intent:** Rapid WebSocket messages are coalesced into batched `terminal.write()` calls at 30fps to reduce rendering overhead without perceptible latency increase.

**Applies To:** User

**Acceptance Criteria:**

1. Incoming WebSocket messages are appended to a per-terminal write buffer keyed by the compound terminal identity. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->
2. A flush is scheduled on a fixed cadence corresponding to roughly 30 frames per second so render passes are bounded even under burst output. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->
3. On flush, all buffered output for a terminal is concatenated and written to the rendering library in a single call. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->
4. The 30 fps flush rate halves the render-pass count compared to 60 fps without producing perceptible latency for typed input or interactive output.
5. The added flush latency stays below the human input-feedback perception threshold.
6. Pending flushes are tracked per terminal and cancelled on terminal disposal. <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore -->

**Constraints:**

- Write buffers use the compound terminal identity so each tab's stream is coalesced independently.
- Programmatic scroll-position adjustments after a write are tracked separately so they cannot be misinterpreted as a user-initiated scroll reset.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/terminal.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/stores/update-terminal-label.test.ts (REQ-TERM-009 AC7 describe -> updateTerminalLabel writes processName + overwrites + only targeted tab + no-op for missing session/terminal -> AC7) -->
<!-- @test: web-ui/src/__tests__/lib/terminal-process-name.test.ts (REQ-TERM-009 describe -> host JSON wire shape + change-gated send + {"type": prefix + onProcessName dispatch + registerProcessNameCallback wiring -> AC1,2,6 wire-protocol) -->
### REQ-TERM-009: Process name detection via control messages

<!-- @impl: host/src/session.ts -->
<!-- @impl: web-ui/src/lib/terminal-config.ts::PROCESS_ICON_MAP -->
<!-- @test: web-ui/src/__tests__/lib/terminal-config.test.ts (terminal-config describe → PROCESS_ICON_MAP + AGENT_ICON_MAP + getTabIcon + getTabDisplayName → AC3/AC5) -->

**Intent:** The terminal server detects the foreground process running in each PTY and sends the process name to the frontend for display in tab labels and session cards.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal server emits process-name control messages over the WebSocket whenever the foreground process for a PTY changes. <!-- @impl: host/src/session.ts::Session -->
2. The frontend distinguishes control messages from raw terminal data using the message's leading type-discriminator field.
3. The frontend maps known foreground process names (supported agents plus common TUI tools and shells) to display icons via a static lookup. <!-- @impl: web-ui/src/lib/terminal-config.ts::getTabIcon -->
4. An optional binary-name-to-display-name override table exists for cases where the executable name differs from the user-facing name; the override table is empty when no remap is needed.
5. The session card icon set covers each supported agent type so users can identify a session at a glance.
6. The session store registers a process-name callback against the terminal store so process updates propagate without creating a circular import between the two stores.
7. Process name updates are reflected in tab headers and session status cards in real time.

**Constraints:**

- Control messages that fail to parse as JSON are treated as raw terminal data so an unexpected payload never blocks output.
- Unknown control-message types are silently ignored so the protocol can evolve without breaking older clients.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/stores/update-terminal-label.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/presets-req-term-010.test.ts (REQ-TERM-010 describe -> POST/GET/PATCH/DELETE /api/presets + max-3 enforcement + 201/200 -> AC1,2,3,5) -->
<!-- @test: web-ui/src/__tests__/stores/session-presets-ac-coverage.test.ts (REQ-TERM-010 describe -> savePreset state append + applyPresetToSession populates tabConfig + tab 1 preserved + 404 on missing -> AC1,4) -->
### REQ-TERM-010: Session presets (saved tab configurations)

<!-- @impl: src/routes/presets.ts -->
<!-- @test: src/__tests__/routes/presets-req-term-010.test.ts (REQ-TERM-010 AC1/AC2/AC3/AC5 describes -> preset name+tabs + 3-max cap + CRUD endpoints + delete removal) + src/__tests__/routes/presets.test.ts (Presets Routes GET/POST/DELETE describes -> AC3 CRUD endpoints) + web-ui/src/__tests__/stores/session-presets-ac-coverage.test.ts (AC1/AC4 describes -> preset object shape + applyPresetToSession session populate) -->

**Intent:** Users save and reuse their preferred tab layouts across sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Users can save the current tab configuration as a named preset.
2. Each user is capped at a small fixed number of presets to keep the preset picker scannable.
3. Presets are exposed via a dedicated CRUD endpoint set. <!-- @impl: src/routes/presets.ts::app -->
4. Applying a preset to a new session populates the tab configuration from the preset.
5. Deleting a preset removes it from the user's preset list.

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-TERM-001](#req-term-001-up-to-6-terminal-tabs-per-session)

**Verification:** [Integration test](../../src/__tests__/routes/presets-req-term-010.test.ts)

**Status:** Implemented
