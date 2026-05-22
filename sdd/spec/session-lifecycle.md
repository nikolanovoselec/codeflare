# Session Lifecycle

Container creation, idle detection, auto-sleep, restart, and destroy.

**Domain owner:** Backend (Worker + Container DO)

### Key Concepts

- **Session** -- A named, user-owned workspace backed by a unique KV record and a single container.
- **Container** -- A Cloudflare Durable Object instance providing an isolated runtime (PTY, filesystem, network) for one session.
- **sleepAfter** -- The configurable idle timeout after which a container is automatically stopped.
- **Durable Object** -- Cloudflare's stateful compute primitive used to host each container; provides storage, alarms, and WebSocket hibernation.

### Out of Scope

- Multi-user sessions (each session belongs to exactly one user)
- Container customization (base image, resource limits)
- Custom Docker images (all containers use the standard Codeflare image)

### Domain Dependencies

- **Storage** (R2 bucket mount) -- Sessions mount the user's R2 bucket for persistent file storage.
- **Authentication** (user identity) -- Session creation and access require a resolved user identity.
- **Subscription** (session limits) -- Concurrent session counts are enforced per subscription tier.

---

## REQ-SESSION-001: Session creation with name and agent type

**Intent:** A user can create a named session associated with a specific AI agent, producing a unique session record stored in KV.

**Applies To:** User

**Acceptance Criteria:**
1. `POST /api/sessions` accepts a `name` (string, trimmed, sanitized) and optional `agentType` (one of: claude-code, codex, gemini, opencode, copilot, bash).
2. A unique alphanumeric session ID (8-24 lowercase chars, matching `SESSION_ID_PATTERN`) is generated.
3. The session record is persisted to KV at `session:{bucketName}:{sessionId}` with compressed list metadata.
4. The response returns the session object with status 201.
5. Session creation is rate-limited (10/min per user).

**Constraints:**
- Session name is sanitized to prevent injection.
- Storage quota is checked before creation in SaaS mode; over-quota users receive a `ValidationError`.

**Priority:** P0
**Dependencies:** REQ-AUTH-005 (requireActiveUser middleware)
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SESSION-002: One container per session (isolation)

**Intent:** Each session maps to exactly one Durable Object container instance, providing full process-level isolation between sessions.

**Applies To:** User

**Acceptance Criteria:**
1. `POST /api/container/start?sessionId=xxx` derives a deterministic container ID from the user's bucket name and the session ID.
2. The container ID uniquely addresses a single Durable Object; no two sessions share a DO.
3. Different sessions belonging to the same user run in separate containers with separate PTY processes.
4. A session's container cannot access files, processes, or network state of another session's container.

**Constraints:**
- Container ID derivation must never produce collisions for distinct (bucketName, sessionId) pairs.
- Container ID is never a fallback or default; validation rejects malformed inputs before DO interaction.

**Priority:** P0
**Dependencies:** REQ-SESSION-001
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SESSION-003: R2 bucket mounted and synced on start

**Intent:** When a container starts, the user's persistent R2 storage is mounted and bidirectionally synced so the workspace contains all previously persisted files.

**Applies To:** User

**Acceptance Criteria:**
1. `POST /api/container/start` creates the user's R2 bucket if it does not exist (`createBucketIfNotExists`).
2. A scoped R2 API token (bucket-specific Object Read + Write) is obtained or created for the user and injected as container environment variables.
3. `entrypoint.sh` runs an initial `rclone sync` from R2 to the local workspace (blocking, with a 120-second safety timeout).
4. After initial sync, a background daemon performs `rclone bisync` every 15 minutes for the container's lifetime, with SIGUSR1-driven manual triggers and a final sync on shutdown (see REQ-STOR-003).
5. New buckets are seeded with getting-started docs and agent configs matching the user's session mode.

**Constraints:**
- The master `CLOUDFLARE_API_TOKEN` never enters the container; only per-user scoped R2 credentials are injected.
- R2 tokens are cached in KV (optionally encrypted with AES-256-GCM) and verified before reuse.

**Priority:** P0
**Dependencies:** REQ-SESSION-002
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SESSION-004: Idle containers sleep after configurable timeout

**Intent:** Containers that receive no user input for a configurable duration are automatically stopped to conserve resources and reduce cost.

**Applies To:** User

**Acceptance Criteria:**
1. The `sleepAfter` value is user-configurable with allowed values: 5m, 15m, 30m, 1h, 2h.
2. Default is 30m for paying users; free-tier users are locked to 15m regardless of stored preference.
3. The idle timer resets only when new user input is detected (not on heartbeats, reconnections, or protocol chatter).
4. `collectMetrics()` is the sole enforcer of the container-level idle timeout: it polls the in-container `/activity` endpoint every 60 seconds, computes idle time from `lastInputAt`, and explicitly calls `this.stop('SIGTERM')` once the user-configured threshold is exceeded. (The host-side per-PTY keepalive in `host/src/server.ts` is a separate safety net for stuck `lastInputAt`, floor-clamped at the maximum `sleepAfter` so it cannot fire first; see AD47.)
5. The Container SDK's own `sleepAfter` timer is pinned to a 24h sentinel so it never fires in normal operation; idle policy is owned exclusively by `collectMetrics()`. The user-facing preference is held in the `idleTimeoutPref` field.
6. Admins can always change their own `sleepAfter`; non-subscribed users have the dropdown disabled.

**Constraints:**
- `sleepAfter` is validated against `/^(5m|15m|30m|1h|2h)$/` on the DO side.
- `sleepAfter` is persisted to DO storage so it survives Cloudflare DO resets. The wire-protocol and storage key remain `sleepAfter` for backwards compatibility with existing sessions even though the in-memory field is named `idleTimeoutPref`.
- Backend enforcement in `lifecycle.ts`: free-tier override cannot be bypassed via API.
- Idle detection MUST NOT rely on the Container SDK's built-in timer, because it refreshes on any WebSocket traffic in either direction (including background process output like `tail -f`). Codeflare requires "no user input" semantics, not "no traffic" semantics.

**Priority:** P0
**Dependencies:** REQ-SESSION-005
**Verification:** Automated test
**Status:** Implemented

---

## REQ-SESSION-005: Input-based idle detection

**Intent:** Idle detection is based on actual user input (keystrokes, control keys, mouse clicks), not on WebSocket connection activity or heartbeat pings.

**Applies To:** User

**Acceptance Criteria:**
1. The terminal server tracks `lastInputAt` (Unix timestamp ms) representing the last real user input.
2. `containsUserInput()` uses a whitelist: printable characters, control keys (Enter, Backspace, Tab, Ctrl+key), arrow keys, function keys, Alt+key, and mouse clicks count as input.
3. Terminal protocol responses (CSI, OSC, DCS, APC, focus reports, mouse movement) do not count as input.
4. `stripTerminalResponses()` removes terminal emulator response sequences (CPR, OSC 10/11/12, DA1) before writing to PTY.
5. The Container DO's `fetch()` override dispatches `_internal/*` routes locally and delegates all other traffic to `super.fetch()` (optionally with an `Authorization: Bearer <token>` header for in-container auth). The SDK's activity timer being refreshed on every proxied request is harmless because `sleepAfter` is pinned to `'24h'` (REQ-SESSION-004 AC5), making the SDK timer functionally inert as an idle detector.
6. `collectMetrics()` polls the in-container `/activity` endpoint every 60 s over the DO's private TCP port (not via the public fetch proxy), reads the authoritative `lastInputAt` value tracked by the terminal server, and computes `idleMs = Date.now() - (lastInputAt ?? containerStartedAt)` to drive its own idle-stop decision. There is no dependency on the SDK's activity timer.

**Constraints:**
- If no input is ever received (`lastInputAt` is null), idle time is measured from `containerStartedAt`.
- A container with an open terminal but no typing stops after `sleepAfter` from start time.

**Priority:** P0
**Dependencies:** None
**Verification:** Automated test
**Status:** Implemented

---

## REQ-SESSION-006: User can stop, restart, and delete sessions

**Intent:** Users have explicit control over session lifecycle: stop a running session, restart a stopped session, or permanently delete a session.

**Applies To:** User

**Acceptance Criteria:**
1. **Stop (user-initiated):** `POST /api/sessions/:id/stop` sets KV status to `'stopped'` and calls `container.destroy()`. The `destroy()` override first clears `SESSION_ID_KEY`, `bucketName` and other identifiers from DO storage (preventing session resurrection via the asynchronous `onStop()` writeback), then performs a graceful shutdown: sends `SIGTERM` to the container, polls `ctx.container.running` for up to 25 s while the entrypoint trap runs the final `rclone bisync`, and only then calls `super.destroy()` to teardown. If the trap does not exit within the timeout the DO falls back to SIGKILL via `super.destroy()` so the route always returns.
2. **Restart:** `POST /api/container/start` on a stopped session. Same-bucket restart receives 409 from `setBucketName` (bucket already set) but still updates sessionId, preferences, and tab config. Different-bucket restart calls `destroy()` then re-calls `setBucketName`.
3. **Delete:** `DELETE /api/sessions/:id` calls `container.destroy()` (same graceful-shutdown path as Stop, so the final bisync runs before SDK teardown) and then removes the KV record.
4. Frontend transitions: `stopped` -> `initializing` -> `running` (start); `running` -> `stopping` -> `stopped` (stop).

**Constraints:**
- `destroy()` clearing identifiers before `super.destroy()` is critical to prevent the asynchronous `onStop()` from writing a stale session back to KV.
- The entrypoint trap reads R2 credentials from process env vars baked in at container start; clearing DO storage identifiers first does not affect bisync.
- Final bisync on shutdown uses `--ignore-checksum --max-delete 100` for safety.

**Priority:** P0
**Dependencies:** REQ-SESSION-001, REQ-SESSION-002
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SESSION-007: Running session count limited per tier

**Intent:** The number of concurrently running sessions is capped per subscription tier to enforce fair usage and plan differentiation.

**Applies To:** User

**Acceptance Criteria:**
1. Before starting a container, `validateSessionAndCheckLimits` counts running sessions from KV list metadata (zero individual `kv.get()` calls).
2. If the running count (excluding the session being started) meets or exceeds the tier's `maxSessions`, a `QuotaExceededError` is thrown.
3. Default tier limits: free=1, trial=2, standard=1, advanced=2, max=3, unlimited=5, blocked=0, pending=0.
4. Non-SaaS mode falls back to role-based limits from environment variables (`MAX_SESSIONS_USER` default 3, `MAX_SESSIONS_ADMIN` default 10).
5. Stress-test mode (`STRESS_TEST_MODE=active`) bypasses session and quota limits.

**Constraints:**
- Tier limits are configurable per deployment via admin Subscription Management panel.
- `getMaxSessions(role, env)` respects explicit `0` values (uses `NaN` check, not `||` fallback).

**Priority:** P1
**Dependencies:** REQ-SESSION-001
**Verification:** Automated test
**Status:** Implemented

---

## REQ-SESSION-008: Container restart preserves R2 bucket

**Intent:** Restarting a session reconnects to the same R2 bucket, preserving all user files without data loss.

**Applies To:** User

**Acceptance Criteria:**
1. Same-bucket restart: `setBucketName` returns 409 (bucket already set) but the 409 handler stores the new `sessionId`, `workspaceSyncEnabled`, `tabConfig`, `fastStartEnabled`, and `userEmail` in DO storage.
2. `startAndWaitForPorts()` triggers `onStart()` which re-arms the `collectMetrics` schedule and records `containerStartedAt`.
3. `onStart()` refreshes `envVars` via `updateEnvVars()` so that any updated LLM keys, deploy keys, or preferences take effect.
4. The initial `rclone sync` in `entrypoint.sh` restores the workspace from R2 on restart.
5. User preference changes (sleepAfter, fastStart, sessionMode) take effect on restart without requiring container recreation.

**Constraints:**
- Different-bucket restart (user email change) triggers full `destroy()` + re-`setBucketName` cycle.

**Priority:** P0
**Dependencies:** REQ-SESSION-003, REQ-SESSION-006
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SESSION-009: Container destroy wipes session state

**Intent:** Destroying a container clears all transient session state from the Durable Object, leaving only the persistent KV record and R2 bucket.

**Applies To:** User

**Acceptance Criteria:**
1. `destroy()` override clears from DO storage: `SESSION_ID_KEY`, `bucketName`, `workspaceSyncEnabled`, `tabConfig`, `fastStartEnabled`.
2. `destroy()` nulls in memory: `_bucketName`, `_sessionId`, `_r2AccessKeyId`, `_r2SecretAccessKey`, `_containerAuthToken`, `_openaiApiKey`, `_geminiApiKey`, `_githubToken`, `_cloudflareApiToken`, `_cloudflareAccountId`, `_encryptionKey`.
3. `_sessionMode` resets to `'default'`.
4. `onStop()` schedule clearing runs (`deleteSchedules('collectMetrics')`).
5. After `destroy()`, `collectMetrics` detects missing identifiers (zombie DO) and stops the alarm loop without re-arming.
6. The R2 bucket and its contents are NOT deleted by `destroy()` (files persist across sessions).

**Constraints:**
- DO storage and memory must be cleared BEFORE `super.destroy()` to prevent `onStop()` race conditions.

**Priority:** P0
**Dependencies:** REQ-SESSION-006
**Verification:** Automated test
**Status:** Implemented

---

## REQ-SESSION-010: Session status observable from dashboard

**Intent:** The dashboard displays the current status of each session (running, stopped, initializing, stopping, error) with near-real-time updates.

**Applies To:** User

**Acceptance Criteria:**
1. `GET /api/sessions/batch-status` returns status for all user sessions from KV list metadata in a single `kv.list()` call (no DO contact, no container wake).
2. Backend KV stores two statuses: `'running'` and `'stopped'`. Frontend adds ephemeral states: `'initializing'`, `'stopping'`, `'error'` (never persisted).
3. Frontend polls `batch-status` every 5 seconds (`SESSION_LIST_POLL_INTERVAL_MS`).
4. Dashboard session cards display a three-color status dot: green (running + WS connected), yellow (running + WS disconnected), gray (stopped).
5. Metrics (CPU, memory, disk, sync status) from `collectMetrics` are included in list metadata and displayed on session cards, with up to ~60s staleness.
6. `lastActiveAt` and `lastStartedAt` timestamps are available for sleep timer countdown display.
7. When KV polling transitions a session to `'stopped'`, terminal connections are disposed and `activeSessionId` is cleared.

**Constraints:**
- KV eventual consistency: ~60s propagation delay for new sessions.
- Dashboard status is pure KV read; no Durable Object is contacted, preserving container hibernation.
- Newly started sessions have a 3-minute startup guard during which only close code 4503 can transition them to stopped (anti-flapping).

**Priority:** P1
**Dependencies:** REQ-SESSION-001
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SESSION-011: Graceful shutdown with final sync

**Intent:** When a container stops (idle timeout or user-initiated), a final bidirectional sync to R2 runs before process termination, ensuring no data loss.

**Applies To:** User

**Acceptance Criteria:**
1. `entrypoint.sh` traps SIGINT and SIGTERM signals.
2. The trap handler kills the sync daemon via PID file at `/tmp/sync-daemon.pid`.
3. A final `rclone bisync` with `--ignore-checksum --max-delete 100` runs before the terminal server is killed.
4. The bisync-initialized flag is touched on the timeout path to ensure final bisync runs even when initial sync timed out.
5. Dockerfile uses `STOPSIGNAL SIGINT` so the container runtime sends a trappable signal.
6. User-initiated Stop and Delete both reach the trap via the DO's `destroy()` override, which sends `SIGTERM` and polls `ctx.container.running` for up to 25 s before falling back to `super.destroy()`'s SIGKILL. Idle-timeout and quota-eviction paths reach the trap via `collectMetrics`'s `stop('SIGTERM')` call. There is no path that goes straight to SIGKILL while the container is still running.

**Constraints:**
- PID file is the sole mechanism for killing the sync daemon (no in-memory PID variable fallback).
- The `--max-delete 100` flag prevents catastrophic mass deletion during final sync.

**Priority:** P0
**Dependencies:** REQ-SESSION-003, REQ-SESSION-004
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SESSION-012: Wake-loop prevention

**Intent:** A browser's automatic WebSocket reconnect must not wake a hibernated container in an infinite stop/start cycle.

**Applies To:** User

**Acceptance Criteria:**
1. **DO fetch gate:** The `fetch()` override returns 503 when `!this.ctx.container?.running` for all non-internal routes, preventing `super.fetch()` from triggering `startIfNotRunning`.
2. **Terminal route guard:** Rejects WebSocket upgrade requests with 503 when `session.status === 'stopped'` in KV (defense-in-depth).
3. **Frontend disposal:** Session poller detects running-to-stopped transitions and calls `terminalStore.disposeSession(sessionId)`, killing all WebSocket retry loops.
4. **Close code 4503:** The DO sends custom WebSocket close code 4503 when the container is not running. The client treats 4503 as authoritative (no retry). Non-4503 codes (1006, 1001, etc.) trigger automatic reconnection.

**Constraints:**
- Fresh `connect()` calls are only made when the user explicitly starts the session again.
- Anti-flapping guard prevents stale KV "running" status from auto-initializing terminals for non-active sessions.

**Priority:** P1
**Dependencies:** REQ-SESSION-004, REQ-SESSION-006
**Verification:** Automated test
**Status:** Implemented

---

## REQ-SESSION-013: Sleep timer countdown UI

**Intent:** Users see how much idle time remains before their session hibernates.

**Applies To:** User

**Acceptance Criteria:**
1. Clock icon on session cards and header toolbar shows countdown.
2. Visible when < 10 min remaining.
3. Orange pulse at < 10 min, red at < 5 min.
4. Hidden for stopped sessions.
5. Computed from sleepAfterMs - (now - lastActiveAt).

**Constraints:**
- None
**Priority:** P2
**Dependencies:** REQ-SESSION-004
**Verification:** Manual check
**Status:** Implemented

---

## REQ-SESSION-014: User-configurable auto-sleep timeout in Settings

**Intent:** Users choose how long their sessions stay alive when idle.

**Applies To:** User

**Acceptance Criteria:**
1. Settings dropdown with 5 options (5m, 15m, 30m, 1h, 2h).
2. Free tier locked to 15m with upgrade hint.
3. Admins and paying users can change.
4. Value saved to KV preferences and applied on next session start.

**Constraints:**
- None

**Priority:** P1
**Dependencies:** REQ-SESSION-004
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SESSION-015: Container Port-Readiness Gating with Pre-Warm Pre-Condition

**Intent:** A new container must bind its serving port quickly so Cloudflare's port-wait check succeeds, yet must refuse real terminal traffic until initial state restore and pre-warm are complete; the readiness gate sits between the port bind and the first accepted WebSocket upgrade.

**Applies To:** User

**Acceptance Criteria:**
1. The terminal server's tab-1 PTY pre-warm is gated on an init-complete signal written by the entrypoint after initial sync, file modifications, and tab autostart configuration complete; this preserves the readiness contract while letting the serving port bind before Cloudflare's container port-wait timeout.
2. The host terminal server rejects `/terminal` WebSocket upgrades with close code 1013 (reason `container-warming-up`) until both the init-complete flag is observed AND the pre-warm session is registered in the session map; this is the host-side guard against reconnects landing before shell autostart is in place.

**Constraints:**
- The terminal server must bind its serving port within Cloudflare's container port-wait window; slow initialization (R2 sync, MCP config merges) must not block the port bind.
- The container must not signal readiness (PTY pre-warm complete) until the initial sync either succeeds or times out.

**Priority:** P0
**Dependencies:** REQ-STOR-004
**Verification:** Automated test (`host/__tests__/prewarm-readiness.test.js` for the 1013 reject + init-flag gate; `src/__tests__/container/index.test.ts` for the DO-side prewarm contract).
**Status:** Implemented

---

## REQ-SESSION-016: User timezone propagated from preferences to container env

**Intent:** The capture pipeline and any other consumer of `$USER_TIMEZONE` inside the container must receive the user's IANA timezone choice without manual env-var configuration; the preference is set via the preferences API and persists across restarts.

**Applies To:** User

**Acceptance Criteria:**
1. `PATCH /api/preferences` accepts an optional `userTimezone` field (valid IANA timezone string, max 64 characters); invalid zones return a `ValidationError`.
2. The Container DO persists the value to `ctx.storage` under the `userTimezone` key.
3. Subsequent container starts inject `USER_TIMEZONE=<value>` into the container environment via the standard env-var pipeline; if the field is unset, the entrypoint falls back to `$TZ`, then `/etc/timezone`, then UTC.
4. A timezone change takes effect on the next session start (no live re-injection into a running container).
5. On Dashboard mount, the frontend reads the browser's IANA timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone` and PATCHes `userTimezone` when the resolved zone differs from the stored preference. The sync is best-effort: failures are swallowed and never block the mount path, so a transient API error cannot strand the Dashboard.

**Constraints:**
- Validation uses a runtime IANA-zone round-trip rather than a static zone allowlist, so the validator stays accurate as the IANA database evolves.
- The field is optional; absence is silently treated as "use the entrypoint fallback chain", not an error.

**Priority:** P1
**Dependencies:** REQ-SESSION-014 (preferences flow), REQ-MEM-001 AC9 (the capture pipeline consumes the resulting env var)
**Verification:** Automated test (`src/__tests__/routes/preferences.test.ts` for endpoint + validation; `src/__tests__/container/container-env.test.ts` for env-var injection on restart; `web-ui/src/__tests__/lib/timezone-sync.test.ts` for the browser-side resolution).
**Status:** Implemented
