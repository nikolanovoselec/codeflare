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

## REQ-TERM-001: Up to 6 terminal tabs per session

**Applies To:** User

**Intent:** Each session supports multiple concurrent terminal instances (up to 6) so users can run an agent in one tab and auxiliary commands in others.

**Acceptance Criteria:**
1. The maximum terminal count per session is 6, defined as `MAX_TERMINALS_PER_SESSION` (frontend) and `MAX_TABS` (backend).
2. Each terminal tab has a unique compound key: `sessionId:terminalId` on the frontend and `{sessionId}-{terminalId}` in the WebSocket URL path.
3. The backend parses the compound ID, validates the base session, and forwards the full ID to the container.
4. The container's `SessionManager` handles each compound ID as a separate PTY process with independent state.
5. The session cap check in `SessionManager` excludes prewarm sessions from the active count.
6. Creating a 7th terminal is rejected.

**Constraints:**
- Frontend and backend must agree on the compound key format (`sessionId:terminalId` vs `sessionId-terminalId`).
- Terminal IDs are scoped within a session; they are not globally unique.

**Priority:** P0
**Dependencies:** REQ-SESSION-002
**Verification:** Automated test
**Status:** Implemented

---

## REQ-TERM-002: WebSocket connection to container PTY

**Applies To:** User

**Intent:** Each terminal tab connects to its PTY process inside the container via a WebSocket, carrying raw terminal data bidirectionally.

**Acceptance Criteria:**
1. The WebSocket URL is `/api/terminal/{sessionId}-{terminalId}/ws`.
2. The Worker upgrades the HTTP request to a WebSocket and forwards it through the Container DO to the terminal server at port 8080.
3. The terminal server spawns `bash -l` (login shell, `xterm-256color`, truecolor) as the PTY process.
4. Raw terminal data flows over the WebSocket without JSON wrapping.
5. Control messages (resize, process-name, restore) are sent as JSON objects prefixed with `{"type":`.
6. Unknown JSON `type` strings are silently ignored (forward compatibility).
7. No application-level ping/pong; Cloudflare handles protocol-level WebSocket keepalive automatically.

**Constraints:**
- WebSocket must be intercepted BEFORE Hono routing due to a Cloudflare Workers limitation (`workerd/issues/2319`).
- All proxied HTTP requests from the DO to the container include a `CONTAINER_AUTH_TOKEN` Bearer header; auth-exempt paths (`/health`, `/activity`) are whitelisted.

**Priority:** P0
**Dependencies:** REQ-SESSION-002, REQ-AUTH-005
**Verification:** Integration test
**Status:** Implemented

---

## REQ-TERM-003: Automatic WebSocket reconnection on transient failures

**Applies To:** User

**Intent:** Transient network failures (connection drops, server restarts) trigger automatic reconnection so the user does not need to manually refresh.

**Acceptance Criteria:**
1. Retryable close codes are: 1001 (Going Away), 1006 (Abnormal Closure), 1011 (Unexpected Condition), 1012 (Service Restart), 1013 (Try Again Later).
2. Reconnection uses a 1-second delay (`WS_RETRY_DELAY_MS = 1000`) with infinite retries for retryable codes.
3. On reconnection, terminal buffer state is restored via xterm SerializeAddon (headless terminal captures full state).
4. The `inputDisposable` is stored outside `connect()` and disposed before creating a new handler on reconnect to prevent character doubling.
5. AbortController-based cancellation prevents parallel retry loops from accumulating.
6. Dead-container state is never inferred from retry failure count; only the server-authoritative close code 4503 stops retrying.

**Constraints:**
- Retry loops are cancelled when a session is disposed (e.g., session stopped, user navigated away).
- Dashboard navigation schedules a 60-second WebSocket disconnect grace period; returning cancels the timer and reconnects.

**Priority:** P1
**Dependencies:** REQ-TERM-002
**Verification:** Automated test
**Status:** Implemented

---

## REQ-TERM-004: Close code 4503 is authoritative (no retry)

**Applies To:** User

**Intent:** The custom WebSocket close code 4503 is a server-authoritative signal that the container is not running. The client must stop retrying and display a "Session stopped" message.

**Acceptance Criteria:**
1. The Container DO's `fetch()` override sends close code 4503 (`WS_CONTAINER_STOPPED_CODE`) when `!this.ctx.container?.running`.
2. On receiving 4503, the frontend immediately sets the terminal to `'disconnected'` state with a "Session stopped" message.
3. The frontend does not retry after 4503.
4. On non-4503 close codes (e.g., 1006 network error), the client retries indefinitely; KV polling updates the status when propagation completes.
5. The 4503 code is distinct from HTTP 503 responses on the terminal route guard (defense-in-depth).

**Constraints:**
- 4503 is in the WebSocket private-use range (4000-4999), safe for application-specific semantics.
- During the 3-minute startup guard for newly started sessions, only 4503 can transition a session to stopped (anti-flapping).

**Priority:** P0
**Dependencies:** REQ-TERM-002, REQ-SESSION-012
**Verification:** Automated test
**Status:** Implemented

---

## REQ-TERM-005: Tab 1 auto-starts the configured agent

**Applies To:** User

**Intent:** The first terminal tab in a session automatically launches the user's selected AI agent so they can start coding immediately without manual setup.

**Acceptance Criteria:**
1. `TAB_CONFIG` environment variable is set by the Container DO and parsed by the terminal server.
2. Tab 1 is pre-warmed at container start: the terminal server spawns a `PREWARM_SESSION_ID` PTY with a login shell that reads `.bashrc`.
3. `.bashrc` reads `TAB_CONFIG` and launches the configured agent (e.g., `claude --dangerously-skip-permissions` for Claude Code, `codex` for Codex, etc.).
4. Pre-warm readiness is detected by the first PTY output (any terminal output indicates the agent has started). A 20-second hard timeout acts as a safety net.
5. When the first WebSocket client connects for tab 1, the pre-warmed session is adopted (renamed from `prewarm-1` to the actual terminal ID). If not adopted within 2 minutes, the pre-warmed session is killed.
6. The startup status stage progresses through: `starting` -> `syncing` -> `verifying` -> `mounting` (pre-warm in progress, terminal canvas hidden) -> `ready` (pre-warm complete, "Open" button appears).

**Constraints:**
- Fast Start (`FAST_CLI_START=true`, default) disables auto-update checks for all 5 AI tools to eliminate 5-30s startup delay.
- PTY spawns `bash -l` (login shell) so `.bashrc` agent autostart logic runs.
- Auto-start uses `--dangerously-skip-permissions` flag with `IS_SANDBOX=1` for permission bypass when running as root.

**Priority:** P0
**Dependencies:** REQ-TERM-002, REQ-SESSION-003
**Verification:** Integration test
**Status:** Implemented

---

## REQ-TERM-006: User-created tabs start with plain bash

**Applies To:** User

**Intent:** Tabs created by the user (clicking "+") start a plain bash shell without auto-launching an agent, giving the user a general-purpose terminal.

**Acceptance Criteria:**
1. When a tab is created by the user, the `manual` flag is set to `true` in the tab configuration.
2. The WebSocket URL includes `?manual=1` query parameter.
3. The terminal server sets `MANUAL_TAB=1` in the PTY environment variables for manual tabs.
4. `.bashrc` reads `MANUAL_TAB` and skips the agent autostart block when set to `1`.
5. The resulting PTY is a plain `bash -l` login shell with no agent running.

**Constraints:**
- The `manual` flag is a frontend-initiated signal; the backend trusts it for tab behavior but not for security decisions.
- Manual tabs still have access to all installed CLI tools (agents can be started manually by the user).

**Priority:** P0
**Dependencies:** REQ-TERM-001
**Verification:** Automated test
**Status:** Implemented

---

## REQ-TERM-007: Tiling layouts (2-split, 3-split, 4-grid)

**Applies To:** User

**Intent:** Users can arrange terminal tabs in tiled layouts for simultaneous visibility of multiple terminals, in addition to the default tabbed view.

**Acceptance Criteria:**
1. Four layout modes are supported: `tabbed` (single terminal visible), `2-split` (side by side), `3-split` (one left, two right), `4-grid` (2x2).
2. Each layout has a minimum tab count: tabbed=1, 2-split=2, 3-split=3, 4-grid=4.
3. `isLayoutCompatible(layout, tabCount)` validates that a session has enough tabs for the requested layout.
4. Layout auto-upgrades when tab count matches a higher layout (`LAYOUT_UPGRADE_ORDER`).
5. `getBestLayoutForTabCount(tabCount)` returns the highest compatible layout for a given tab count.
6. Layout state is persisted per session and restored on reconnection.
7. `setTilingLayout()` returns `false` if the session does not exist or the layout is incompatible.

**Constraints:**
- Tiling state is managed in `web-ui/src/stores/tiling.ts` and accesses session store state via lazy registration to avoid circular imports.
- Layout changes trigger terminal resize events via `triggerLayoutResize()` so xterm.js reflows content.

**Priority:** P2
**Dependencies:** REQ-TERM-001
**Verification:** Automated test
**Status:** Implemented

---

## REQ-TERM-008: Write batching at 30fps

**Applies To:** User

**Intent:** Rapid WebSocket messages are coalesced into batched `terminal.write()` calls at 30fps to reduce rendering overhead without perceptible latency increase.

**Acceptance Criteria:**
1. Incoming WebSocket messages are appended to a per-terminal write buffer (`writeBuffers` Map).
2. A flush is scheduled at 33ms intervals (`WRITE_FLUSH_INTERVAL_MS = 33`, approximately 30fps).
3. On flush, all buffered strings are joined and written to the xterm.js terminal in a single `terminal.write()` call.
4. At 30fps, each frame triggers roughly half the render passes compared to 60fps, cutting `renderRows` style recalculations in half during burst output.
5. The ~33ms latency (vs ~16ms at 60fps) is imperceptible to users.
6. Pending flushes are tracked per terminal key and cancelled on terminal disposal.

**Constraints:**
- Write buffers use the compound key `sessionId:terminalId`.
- Programmatic scroll suppression (`scrollSuppressionCounts`) prevents post-write scroll corrections from triggering false scroll-reset detection.

**Priority:** P1
**Dependencies:** REQ-TERM-002
**Verification:** Automated test
**Status:** Implemented

---

## REQ-TERM-009: Process name detection via control messages

**Applies To:** User

**Intent:** The terminal server detects the foreground process running in each PTY and sends the process name to the frontend for display in tab labels and session cards.

**Acceptance Criteria:**
1. The terminal server sends JSON control messages with `{"type":"process-name","processName":"..."}` over the WebSocket.
2. The frontend parses control messages (identified by the `{"type":` prefix) separately from raw terminal data.
3. `PROCESS_ICON_MAP` maps running process names (claude, codex, gemini, opencode, copilot, htop, yazi, lazygit, bash, sh, zsh) to MDI icons.
4. `PROCESS_DISPLAY_NAME` provides optional overrides from binary name to display name (currently empty -- all agent binary names match their display names).
5. `AGENT_ICON_MAP` maps the 6 agent types to session card icons.
6. The `onProcessName` callback is registered by the session store to receive process-name updates from the terminal store (avoiding circular imports).
7. Process name updates are reflected in tab headers and session status cards in real time.

**Constraints:**
- Control messages that fail JSON parsing are treated as raw terminal data (written to xterm.js).
- Unknown `type` values in control messages are silently ignored (forward compatibility).

**Priority:** P1
**Dependencies:** REQ-TERM-002
**Verification:** Automated test
**Status:** Implemented

---

## REQ-TERM-010: Session presets (saved tab configurations)

**Applies To:** User

**Intent:** Users save and reuse their preferred tab layouts across sessions.

**Acceptance Criteria:**
1. Users can save current tab configuration as a preset (name + tabs).
2. Max 3 presets per user.
3. Presets stored via /api/presets CRUD.
4. Apply preset to new session populates tab config.
5. Delete preset removes it.

**Constraints:**
- None

**Priority:** P2
**Dependencies:** REQ-TERM-001
**Verification:** Integration test
**Status:** Implemented
