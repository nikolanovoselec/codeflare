# Architecture

System architecture, components, data flow, and design rationale for Codeflare.

**Audience:** Developers

---

## Contents

- [Architecture Overview](#architecture-overview)
- [System Components](#system-components)
- [Data Flow](#data-flow)
- [Module-Level Caches](#module-level-caches)
- [Design Rationale](#design-rationale)

> **Enterprise Mode:** For the outbound-interception LLM routing data flow (Enterprise Mode only), see [Enterprise LLM Routing](#enterprise-llm-routing).

## Architecture Overview

Codeflare runs AI coding agents in isolated containers, one per browser session (tab). All sessions for a user share a single R2 bucket for persistent storage, with periodic bidirectional sync every 15 minutes plus manual triggers from the storage panel and a final sync at shutdown (see [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers)).

```mermaid
graph TD
    B1["Browser Tab 1 (xterm.js)"] -->|WebSocket| W["Cloudflare Worker (Hono router)"]
    B2["Browser Tab 2 (xterm.js)"] -->|WebSocket| W
    W -->|"containerId=bucket-session1"| C1["Container 1"]
    W -->|"containerId=bucket-session2"| C2["Container 2"]
    C1 --- P1["PTY + Agent"]
    C2 --- P2["PTY + Agent"]
    P1 -->|"rclone bisync (15min + manual triggers)"| R2["R2 bucket (shared per user)"]
    P2 -->|"rclone bisync (15min + manual triggers)"| R2
```

**Workers.dev URL:** `https://<CLOUDFLARE_WORKER_NAME>.<ACCOUNT_SUBDOMAIN>.workers.dev` - used only for initial setup. After the setup wizard configures a custom domain, all traffic should go through the custom domain (protected by the configured auth mechanism - CF Access or GitHub OIDC). In CF Access mode, the workers.dev URL should be gated behind one-click Access in the Cloudflare dashboard.

---

## System Components

### Worker (Hono Router)

**File:** `src/index.ts`

Entry point and API gateway. Handles routing, WebSocket upgrade interception, authentication (CF Access JWT or GitHub OIDC session cookies), container lifecycle through Durable Objects, and CORS with configurable allowed origins.

**WebSocket must be intercepted BEFORE Hono routing** (required workaround for CF Workers):
```typescript
// See: https://github.com/cloudflare/workerd/issues/2319
const wsRouteResult = validateWebSocketRoute(request);
if (wsRouteResult.isWebSocketRoute) {
  return handleWebSocketUpgrade(request, env, ctx, wsRouteResult);
}
```

**CORS:** Checks static patterns from `env.ALLOWED_ORIGINS` + dynamic origins from KV (cached in memory). Uses `matchesPattern()` with domain-boundary enforcement (dot-prefixed = suffix match, bare domains = exact or subdomain with dot boundary).

**Route Registration:** `/health`, `/api/health`, `/api/auth`, `/auth`, `/public/auth/providers`, `/api/setup`, `/public`, `/api/user`, `/api/container`, `/api/sessions`, `/api/terminal`, `/api/users`, `/api/storage`, `/api/presets`, `/api/preferences`, `/api/llm-keys`, `/api/deploy-keys`, `/api/usage`, `/api/admin/tiers`

**Workers Assets Routing Guardrails (`wrangler.toml`):**

With SPA fallback (`not_found_handling = "single-page-application"`), control-plane paths must execute Worker logic first via `run_worker_first = ["/", "/auth/*", "/api/*", "/public/*", "/health"]`. Missing `/api/*` causes setup/auth flows to break (API endpoints return HTML instead of JSON).

### Container DO (container)

**File:** `src/container/index.ts` - Extends `Container` from `@cloudflare/containers`. Exported from `src/index.ts` as lowercase `container` (matching `wrangler.toml` class_name). `index.ts` is the thin DO class shell; it delegates config (`setBucketName`/`ensureVaultKey`) to `container-config.ts`, lifecycle hooks (onStart/onStop/alarm) to `container-lifecycle.ts`, internal `/_internal/*` dispatch to `container-router.ts`, and idle enforcement/metrics to `container-metrics.ts`. Together these own the full lifecycle of a single session's container: startup, idle enforcement via `collectMetrics()`, request proxying with auth token injection, and graceful shutdown with a 135-second budget for final bisync. A second DO, `Timekeeper`, is exported from `src/timekeeper/index.ts` for per-user usage tracking.

For Container DO internals including the `collectMetrics()` loop, `destroy()` override, auth token lifecycle, `setBucketName` idempotency, and SDK timer semantics, see [Container](container.md).

### LlmInterceptor (Enterprise Mode)

**File:** `src/llm-interceptor.ts`

A `WorkerEntrypoint` that transparently proxies agent LLM traffic to the customer's AI Gateway when `ENTERPRISE_MODE=active`. Instantiated per container session by the Container DO via `ctx.container.interceptOutboundHttps` + `ctx.exports`. The interceptor receives every outbound HTTPS connection the container opens to the LLM provider host (`api.openai.com`), strips the placeholder credential injected by `entrypoint.sh`, and forwards to the AI Gateway **REST API** first (`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/<path>`, authenticated with `Authorization: Bearer <AIG_TOKEN>` using the Workers AI scope, plus a `cf-aig-gateway-id` header). On a `404` from the REST API — a provider not yet on that surface (e.g. Google/Gemini today) — it replays the buffered request to the **deprecated compat path** (`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/<path>`, authenticated with `cf-aig-authorization: Bearer <AIG_TOKEN>` using the AI Gateway Run scope). The 404-fallback is safe because a 404 is a complete error body, not a started stream (no double-billing, no truncation), and it stops firing automatically as Cloudflare migrates providers onto the REST API. The account id and gateway id are parsed from `AIG_GATEWAY_URL`. Only OpenAI-wire-format agents (Copilot, Pi) run in enterprise mode — both via Chat Completions (`/chat/completions`); Pi runs with `reasoning: false` so gpt-5.5 stays in tools-only mode (an OpenAI **Responses API** path was evaluated but reverted). When `AIG_LANGUAGE_MODEL` is set the interceptor rewrites the request body's `model` field to that gateway route on `/chat/completions` and `/responses` ([REQ-ENTERPRISE-007](../../sdd/spec/enterprise-mode.md#req-enterprise-007-gateway-route-pinning)); otherwise the body is forwarded unchanged. On streaming `/chat/completions` it also normalizes the response stream (see **Streaming normalization** below). See [AD74](../decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api) for the REST transport (it amends [AD72](../decisions/README.md#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing), whose interception mechanism is unchanged). On the compat replay the interceptor strips OpenAI-only fields (`store`, `prompt_cache_key`) that non-OpenAI providers reject with a 400 (the REST leg keeps them, so OpenAI prompt caching is unaffected). Per-user attribution is stamped into `cf-aig-metadata` as `{ user: <email>, group: <access-group> }` — the IdP-verified email plus the single matched Cloudflare Access group (`group` omitted when the user matched none) — so the customer's gateway analytics attribute usage to the real identity and can branch per-group routing/cost/rate-limit policies.

`ctx.exports` is default-on at the project's compat date (`2026-02-05`). No `enable_ctx_exports` compat flag is needed.

The gateway URL (`AIG_GATEWAY_URL`) and token (`AIG_TOKEN`) live exclusively in the Worker/interceptor environment. They are never forwarded to the container and never appear in any container env var or log. When `ENTERPRISE_MODE` is unset the DO never calls `interceptOutboundHttps`, the interceptor is never instantiated, and the direct-key path is byte-identical to non-enterprise deployments.

### Terminal Server (node-pty)

**File:** `host/src/server.ts` - Node.js/TypeScript server inside the container. Single port 8080 for WebSocket + REST + health/metrics.

Sync handled entirely by `entrypoint.sh` (15-minute daemon, SIGUSR1-interruptible for manual triggers). Terminal server reads sync status from `/tmp/sync-status.json` and exposes via `/health`. The user-facing manual trigger surface is the Worker route `POST /api/sessions/sync`, which fans out per-session to each of the user's running containers; the per-container host endpoint it reaches is `POST /internal/bisync-trigger`, which reads `/tmp/sync-daemon.pid` and sends SIGUSR1 to the daemon. See [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers) and [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui). Activity tracking (WebSocket connection state + user input timestamps: `hasActiveConnections`, `connectedClients`, `activeSessions`, `disconnectedForMs`, `lastInputAt`) for hibernation decisions via `GET /activity`. Unknown JSON `type` strings are silently ignored (guard against future message types leaking to PTY).

**Auth-Exempt Paths:** The terminal server validates `Authorization: Bearer <token>` on all HTTP requests. `/health` and `/activity` are in the `authExemptPaths` Set at `host/src/server.ts` because `collectMetrics()` calls them directly via `ctx.container.getTcpPort(TERMINAL_SERVER_PORT).fetch(...)` from inside the DO class - that path enters the container over the SDK's private TCP plumbing and never runs through the public `fetch()` override, so no `Authorization` header is injected. The whitelist is safe because these two paths expose no user data and no mutable container state. The `/activity` endpoint is also exempted from auth in the DO-level `fetch()` override so internal health checks don't require token injection.

**`GET /activity` Endpoint:** Returns `{ hasActiveConnections: boolean, connectedClients: number, activeSessions: number, disconnectedForMs: number | null, lastInputAt: number | null }`. Consumed exclusively by the Container DO's `collectMetrics()` poll. Active connections = WebSocket clients currently connected. `disconnectedForMs` tracks time since all clients disconnected (null while clients are connected). `lastInputAt` is the Unix timestamp (ms) of the last real user input - determined by `containsUserInput()` after `stripTerminalResponses()` removes terminal protocol chatter (CPR, OSC, DA). This is the authoritative signal for codeflare's "user has walked away" idle policy.

**Idle Detection (Single Source of Truth):** Idle hibernation is enforced exclusively by `collectMetrics()`, which polls `/activity` every 60 s and computes `idleMs = Date.now() - (lastInputAt ?? containerStartedAt)`. When this exceeds `parseSleepAfterMs(idleTimeoutPref)`, it writes KV status `'stopped'` and calls `this.stop('SIGTERM')` directly. See [REQ-SESSION-004](../../sdd/spec/session-lifecycle.md#req-session-004-idle-containers-sleep-after-configurable-timeout) / [REQ-SESSION-005](../../sdd/spec/session-lifecycle.md#req-session-005-input-based-idle-detection). A secondary per-PTY reaper in `host/src/server.ts` (`PTY_KEEPALIVE_MS`, default 120 min) acts as a safety net if `lastInputAt` tracking gets stuck. It is floor-clamped at the maximum `sleepAfter` so it cannot fire before the authoritative `collectMetrics` path. See [AD47](../decisions/README.md#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy).

The SDK's `sleepAfter` timer is intentionally disabled - it's pinned to `'24h'` so it never fires in normal operation. This is necessary because `@cloudflare/containers` v0.2.x refreshes the SDK timer on every WebSocket message in both directions, which would give "any traffic" semantics (containers running `tail -f` or `yes` would never sleep even after the user walks away). Codeflare needs "no user input" semantics, which only an in-container PTY tracker (the terminal server's `lastInputAt`) can provide.

The `containerStartedAt` fallback is critical: if a user opens a terminal but never types, `lastInputAt` stays `null`. Without the fallback, the idle check would be skipped and the container would run forever. With the fallback, idle time is measured from container start, so an unused terminal still stops after the configured timeout.

`containsUserInput()` in `host/src/session.ts` uses a whitelist approach - only actual keypresses count (printable characters, control keys, arrow keys, function keys, Alt+key, mouse clicks). Terminal protocol responses (CSI, OSC, DCS, APC, focus reports, mouse movement) do not count. `stripTerminalResponses()` removes terminal emulator response sequences (CPR, OSC 10/11/12, DA1) before writing to the PTY. Scenarios: user stops typing → container stops after `sleepAfter` + up to 60s (poll granularity); browser closed → same; user opens terminal but never types → container stops after `sleepAfter` from start time.

**Timestamp taxonomy (four distinct timestamps, often confused):**

| Field | Source / owner | Advances on | Used for |
| --- | --- | --- | --- |
| `lastInputAt` | terminal server `/activity` (`host/src/session.ts`) | PTY **keystrokes only** - not output, not WS traffic, not vault/SB activity, not autonomous-agent output | The idle reference for `collectMetrics`. A long agent run with no keystrokes looks "idle". |
| `lastSeenInputAt` | Container DO in-memory cache of the last non-null `lastInputAt` | New keystroke observed by the poll | Surviving a poll where `/activity` momentarily returns `null`. |
| `lastActiveAt` | KV session record (written by `updateKvStatus`) | Input-driven status writes + the sleep-timer path | Dashboard "last active" display; persisted across hibernation. |
| `metrics.updatedAt` (`m.u` in list metadata) | `collectMetrics` heartbeat | **Wall-clock, every tick**, regardless of input | Metrics-staleness display **only**. **Not** a liveness signal - it freezes when the alarm loop is not running (hibernation). A heartbeat-age heuristic over this field previously caused false "stopped" kicks; removed in [codeflare#153](https://github.com/nikolanovoselec/codeflare/issues/153). Liveness comes from the authoritative KV `status`. |

**WebSocket Wake-Loop Prevention:** Three layers prevent browser auto-reconnect from waking a hibernated container in an infinite stop/start cycle:
1. **DO fetch gate** (`container/index.ts`): The `fetch()` override returns 503 when `!this.ctx.container?.running` for all non-internal routes. This is authoritative (the DO knows container state directly, no KV read needed) and prevents `super.fetch()` from triggering the SDK's `startIfNotRunning`.
2. **Terminal route guard** (`routes/terminal.ts`): Rejects WebSocket upgrade requests with 503 when `session.status === 'stopped'` in KV. This is defense-in-depth - catches requests before they reach the DO.
3. **Frontend disposal** (`stores/session.ts`): The session poller detects running→stopped transitions and calls `terminalStore.disposeSession(sessionId)`, which kills all WebSocket retry loops for that session. Fresh `connect()` calls are only made when the user explicitly starts the session again.

**WebSocket Protocol:** Raw terminal data (NOT JSON-wrapped). Control messages (resize, process-name) as JSON. No application-level ping/pong -- Cloudflare handles protocol-level WebSocket keepalive for DO/Container connections. Headless terminal (xterm SerializeAddon) captures full state for reconnection.

**PTY:** Spawns `bash -l` (login shell for .bashrc) with `xterm-256color`, truecolor support.

**Terminal emulator response stripping:** `stripTerminalResponses()` in `host/src/session.ts` strips terminal emulator responses (CPR, OSC 10/11/12, DA1) from WebSocket input before writing to the PTY. These responses are generated by xterm.js in reply to terminal queries issued by CLI tools (e.g., `gh secret set` reads an OSC 11 response as the secret value). `containsUserInput()` then classifies the original data using a whitelist approach: printable characters, control keys (Enter, Backspace, Tab, Ctrl+key), arrow keys, function keys, Alt+key, and mouse clicks count as user input for idle detection. Terminal protocol chatter (CSI/OSC/DCS/APC sequences, focus reports, mouse movement/release) does not count. The `Session.write()` method calls both: PTY receives the filtered data, and `activityTracker.recordInput()` is called only when `containsUserInput()` returns true.

### Frontend (SolidJS + xterm.js)

**Directory:** `web-ui/`

Key files: `App.tsx` (root), `Terminal.tsx` (xterm.js), `TerminalTabs.tsx`, `Layout.tsx` (orchestrates dashboard/terminal views, manages WS disconnect/reconnect lifecycle), `SessionStatCard.tsx` (dashboard card with three-color status dot and metrics), `StorageBrowser.tsx` (R2 browser with toolbar), `StoragePanel.tsx` (slide-in drawer), `SettingsPanel.tsx`, `Dashboard.tsx`, `OnboardingLanding.tsx`, `OnboardingPage.tsx` (guided setup), `SubscribePage.tsx` (subscription flow), `UsagePage.tsx` (usage dashboard), `LoginPage.tsx` (SaaS login), `Header.tsx` (nav + user dropdown + inline usage), `KittScanner.tsx`.

Stores: `terminal.ts` (WebSocket state, compound key `sessionId:terminalId`, scheduled disconnect/reconnect), `terminal-url-detection.ts` (URL detection signals for floating buttons), `terminal-layout.ts` (terminal layout state), `session.ts` (CRUD, `terminalsPerSession`, `stopSession()` sets `'stopping'` and polls, `refreshSessionStatuses()` for lightweight dashboard polling - also updates storage stats from batch-status via `updateStatsFromBatch()`), `storage.ts` (R2 operations), `setup.ts`, `tiling.ts` (tiled terminal layout), `session-presets.ts` (preset/bookmark management), `session-tabs.ts` (tab configuration).

#### Dashboard WS Disconnect Flow

When user navigates to dashboard, `Layout.tsx` calls `scheduleDisconnect(DASHBOARD_WS_DISCONNECT_DELAY_MS)` (60s grace period). After the grace period, `disconnectAll()` closes all WS connections with reason `'dashboard-disconnect'`. Container can then idle to `sleepAfter` (user-configurable, default 30m for paying users, 15m for free tier). When user returns to terminal view, `cancelScheduledDisconnect()` cancels any pending timer, then `reconnectDisconnectedTerminals(activeSessionId)` reconnects only the active session's terminals. The `untrack()` fix in `Layout.tsx`'s `createEffect` wraps `activeSessionId` to prevent the reactive dependency from triggering reconnects on unrelated session changes.

**Tab Visibility Auto-Refresh:** `Layout.tsx` listens for `visibilitychange` events. When the tab returns from background (mobile browser tab switch, screen off/on), it auto-refreshes session statuses and storage listing. This prevents stale "Failed to fetch" errors that appear when background tabs have their network requests aborted by the browser. Storage refresh is silent (no loading spinner) to avoid UI flicker.

**Session Status Architecture:** KV polling (every 5s via batch-status) is the source of truth for session status. The Container DO sends custom WS close code **4503** when `!this.ctx.container?.running`, giving the client an authoritative "container stopped" signal distinct from network errors (code 1006). On 4503, the client immediately sets the terminal to `'disconnected'` with "Session stopped" message and stops retrying. On 1006 (network error), the client retries indefinitely - KV polling will update the status when propagation completes. Guards only block KV polling during user-initiated stop (`session.status === 'stopping'`) and session initialization (`session.status === 'initializing'`). When KV polling transitions a session to 'stopped', it also disposes terminal connections and clears `activeSessionId`.

```mermaid
sequenceDiagram
    participant U as User
    participant L as Layout.tsx
    participant TS as TerminalStore
    participant DO as ContainerDO

    U->>L: Navigate to dashboard
    L->>TS: scheduleDisconnect() (60s grace)
    Note over TS: Status: green -> yellow (grace period)
    TS->>TS: 60s timer expires
    TS->>DO: disconnectAll()<br/>(close reason 'dashboard-disconnect')
    Note over TS: Status: yellow -> gray (disconnected)
    DO->>DO: No WS clients -><br/>sleepAfter can expire
    U->>L: Return to session
    L->>TS: cancelScheduledDisconnect()
    TS->>DO: reconnectDisconnectedTerminals()<br/>(active session only)
    Note over TS: Status: gray -> green (reconnected)
```

#### Three-Color Session Status

`SessionStatCard` displays green (running + WS connected), yellow (running + WS disconnected -- container alive but dashboard-disconnected), gray (stopped). Driven by `dotVariant()` which checks both `session.status` and `terminalStore.getConnectionState()`. The yellow indicator was added to make the dashboard-disconnect flow visible to the user -- without it, status jumped from green directly to gray.

**KV Optimization (1500-User Scale):** `putSessionWithMetadata()` writes compressed `SessionListMetadata` (~195 bytes) via `kv.put(key, value, { metadata })`. `batch-status` reads from `kv.list()` metadata instead of N individual `kv.get()` calls, reducing KV reads/sec from ~901K to ~300 at 1500 users. Timekeeper user-record cache (60s TTL, 100-entry cap) reduces KV reads/min from 1,500 to ~25.

**Auto-Reconnect:** Infinite retries (1s delay) for retryable close codes (1001, 1006, 1011, 1012, 1013). Only server-authoritative close code 4503 stops retrying. Reconnection replays buffer via xterm SerializeAddon.

**Nested Terminals:** Up to 6 terminal tabs per session. Compound key `sessionId:terminalId`; WebSocket URL `/api/terminal/{sessionId}-{terminalId}/ws`.

**Bucket creation and seeding:** R2 buckets are auto-created on first access from `POST /api/container/start` and `GET /api/storage/browse`. Both paths read `sessionMode` from user preferences via `resolveSessionMode()` and pass it to `reconcileAgentConfigs()`.

See [Architecture Internals](architecture-internals.md) for backend library reference, code structure index, and the CF-NNN code change index.

---

## Data Flow

### Session Creation to Terminal Connection

```mermaid
sequenceDiagram
    participant U as Browser
    participant W as Worker
    participant KV as KV Store
    participant DO as Container DO
    participant C as Container

    U->>W: POST /api/sessions { name }
    W->>KV: Store session metadata
    U->>W: POST /api/container/start?sessionId=xxx
    W->>DO: Create R2 bucket if needed, set bucket name
    DO->>C: container.start()
    Note over C: entrypoint.sh runs
    C->>C: Create rclone config
    C->>C: rclone sync R2 → local (restore)
    C->>C: Start terminal server (:8080)
    loop Poll startup
        U->>W: GET /api/container/startup-status
        W->>C: Health check
    end
    W-->>U: Stage: ready
    U->>W: WebSocket /api/terminal/{id}/ws
    W->>C: Forward WebSocket
    C->>C: Create PTY, spawn bash -l
    Note over C: .bashrc auto-starts agent
```

### Startup Status Stages ([REQ-SESSION-017](../../sdd/spec/session-lifecycle.md#req-session-017-container-health-and-startup-status-api))

| Stage | Progress | Condition |
|-------|----------|-----------|
| stopped | 0% | Container state cannot be determined (DO `getState()` unavailable) |
| starting | 10-20% | Container not yet running/healthy, or running with the health server not yet responding |
| syncing | 30-45% | Health server up, syncStatus = pending/syncing |
| verifying | 85% | Sync complete, terminal server not yet responding |
| mounting | 90% | Terminal server up, PTY pre-warming in progress. WebSocket connects, terminal canvas hidden (`visibility: hidden`) |
| ready | 100% | All checks passed. "Open" button appears. Click reveals terminal canvas with pre-buffered content |
| error | 0% | Sync failed or other error |

### Session Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> stopped
    stopped --> initializing : start
    initializing --> running : ports ready
    initializing --> error : error
    running --> stopping : stop
    stopping --> stopped : poll stopped
    running --> stopped : collectMetrics (idle &gt; idleTimeoutPref)
    running --> stopped : onError / collectMetrics (unexpected exit: crash, deploy-roll, platform reap)
```

(`error` is a frontend-ephemeral state, never persisted - AC2; it resolves to `stopped` on the next batch-status poll, not via a KV write. The SDK's `onError()` fires on a **running** container's unexpected exit, hence the `running --> stopped` transition above.)

**Stop (unexpected exit):** A crash, deploy-roll, or platform idle-reap exits the container without a graceful `stop()`, so the SDK fires `onError()` (**not** `onStop()`). `onError()` writes KV `status: 'stopped'` (guarded on `!ctx.container.running`); if it is skipped, the `collectMetrics()` `!running` branch writes `stopped` on the next 60s tick. Either way KV converges to `stopped` rather than dangling at `running`. See rationale #5 / #17 and [AD70](../decisions/README.md#ad70-container-exit-writes-kv-stopped-no-read-side-reconciliation).

**Stop (idle):** `collectMetrics()` poll -> `idleMs = Date.now() - (lastInputAt ?? containerStartedAt)` -> `idleMs > parseSleepAfterMs(idleTimeoutPref)` -> write KV `status: 'stopped'` (with `lastActiveAt`) -> `this.stop('SIGTERM')` -> `onStop()` clears `collectMetrics` schedule.

**Fast container-stopped detection (frontend):** When the Container DO's "not running" guard returns close code `4503` (`WS_CONTAINER_STOPPED_CODE`), the terminal store stops retrying and marks the connection as disconnected. This is server-authoritative - the container is definitively not running. Non-4503 close codes (1006, 1001, 1011, etc.) trigger automatic reconnection with 1s delay.

**Anti-flapping (KV stopped→running):** When KV batch-status polling detects a `stopped→running` transition for a non-active session, `refreshSessionStatuses()` updates the session status dot but does **not** auto-initialize terminals. This prevents a flapping cycle: stale KV "running" → WS connections → 503 from dead container → disconnected → stale KV "running" restarts cycle. The primary source of a stale KV "running" is now closed at the writer - every container exit persists `stopped` (rationale #5, [AD70](../decisions/README.md#ad70-container-exit-writes-kv-stopped-no-read-side-reconciliation)) - so this guard is defense-in-depth against a transient lag between exit and the catch-all write, not the load-bearing fix it once was when KV could dangle at `running` indefinitely. Newly started sessions have a 3-minute startup guard (`session-polling.ts`) during which only `4503` close code can transition them to stopped. The user explicitly clicks the session card to reconnect. Terminal initialization only occurs during: (1) explicit session start by user, (2) `loadSessions()` on initial page load where KV is authoritative.

**Stop (user-initiated):** Worker sets KV status to `'stopped'` -> calls `container.destroy()` -> `destroy()` clears `SESSION_ID_KEY` + `bucketName` from DO storage to prevent deleted session resurrection -> `super.destroy()` -> `onStop()` bails (no identifiers, so no KV write)

**Delete:** Worker `KV.delete()` -> `container.destroy()` -> `destroy()` clears `SESSION_ID_KEY` + `bucketName` -> `super.destroy()` -> `onStop()` bails (no identifiers, so deleted session cannot be resurrected in KV)

```mermaid
flowchart TD
    subgraph Idle["Idle Stop (collectMetrics)"]
        I1["collectMetrics() fires<br/>(every 60s)"] --> I2["Fetch /activity"]
        I2 --> I3{"idleMs &gt;<br/>idleTimeoutPref?"}
        I3 -->|No| I3N["Continue<br/>(container stays alive)"]
        I3 -->|Yes| I4["Write KV status='stopped'"]
        I4 --> I5["this.stop('SIGTERM')"]
        I5 --> I6["onStop()"]
        I6 --> I7["Clear collectMetrics schedule"]
        I6 -.- IN["Identifiers INTACT<br/>so onStop() writes KV"]
    end

    subgraph User["User-Initiated Stop"]
        U1["Worker sets KV<br/>status 'stopped'"] --> U2["container.destroy()"]
        U2 --> U3["destroy() clears<br/>SESSION_ID_KEY + bucketName"]
        U3 --> U4["super.destroy()"]
        U4 --> U5["onStop() bails<br/>(no identifiers, no KV write)"]
    end

    subgraph Del["Delete"]
        D1["Worker KV.delete()"] --> D2["container.destroy()"]
        D2 --> D3["destroy() clears<br/>SESSION_ID_KEY + bucketName"]
        D3 --> D4["super.destroy()"]
        D4 --> D5["onStop() bails<br/>(no identifiers, no KV write)"]
    end

    subgraph Crash["Unexpected Exit (crash / deploy-roll / platform reap)"]
        X1["Container exits<br/>(no graceful stop)"] --> X2["SDK fires onError()<br/>(NOT onStop)"]
        X2 --> X3{"ctx.container<br/>.running?"}
        X3 -->|"No (exited)"| X4["onError writes<br/>KV status='stopped'"]
        X3 -->|"Yes (transient<br/>startup error)"| X5["Skip write<br/>(guard)"]
        X5 -.-> X6["collectMetrics() 60s<br/>!running branch is the<br/>catch-all -> KV 'stopped'"]
    end

    U3 -.- Key["destroy() clearing identifiers<br/>BEFORE onStop() prevents<br/>session resurrection"]
    D3 -.- Key
    X4 -.- Auth["KV status is authoritative;<br/>no read-side reconciliation<br/>(AD70)"]
```

**Restart (same bucket):** `setBucketName` -> 409 (bucket already set, but stores `sessionId`, `workspaceSyncEnabled`, `tabConfig`, and `fastStartEnabled` in DO storage for KV reconciliation and preference updates) -> `startAndWaitForPorts()` -> `onStart()` re-arms metrics

**Restart (different bucket):** `setBucketName` succeeds -> `destroy()` (wipes DO storage) -> lifecycle route re-calls `setBucketName` (re-populates sessionId + bucketName + R2 creds) -> `startAndWaitForPorts()`

```mermaid
flowchart TD
    Start["setBucketName(newBucket)"] --> SameBucket{"Same bucket<br/>already set?"}

    SameBucket -->|"Yes (409 path)"| Store409["Store sessionId +<br/>workspaceSyncEnabled +<br/>tabConfig + fastStartEnabled<br/>in DO storage"]
    Store409 --> Start409["startAndWaitForPorts()"]
    Start409 --> OnStart409["onStart() re-arms metrics"]

    SameBucket -->|"No (new bucket)"| Destroy["destroy() wipes DO storage"]
    Destroy --> Recall["Lifecycle route re-calls<br/>setBucketName()"]
    Recall --> Repop["Re-populates sessionId +<br/>bucketName + R2 creds"]
    Repop --> StartNew["startAndWaitForPorts()"]
```

### Metrics Data Flow

```mermaid
flowchart TD
    subgraph ContainerDO["Container DO"]
        A1["collectMetrics()<br/>every 60s"]
        A2["/activity check<br/>renews on new input"]
        A3["/health fetch<br/>writes KV metrics"]
        A4["Zombie DO detection:<br/>missing IDs = early return,<br/>no re-arm"]
        A1 --> A2 --> A3
        A1 -.-> A4
    end

    subgraph Worker["Worker"]
        B1["GET batch-status<br/>(pure KV read, stateless,<br/>NO DO touch)"]
        B2["Returns: status, metrics,<br/>lastStartedAt, lastActiveAt,<br/>storageStats (from KV cache)"]
        B3["KV eventual consistency<br/>~60s for new sessions"]
        B1 --> B2
        B1 -.-> B3
    end

    subgraph Frontend["Frontend"]
        C1["refreshSessionStatuses()<br/>polls every 5s"]
        C2["Populates<br/>sessionMetrics map"]
        C3["SessionStatCard<br/>reads metrics<br/>(green/yellow/gray)"]
        C1 --> C2 --> C3
    end

    A3 -->|KV| B1
    B2 --> C1
```

### Enterprise LLM Routing

Applies only when `ENTERPRISE_MODE=active`. The Container DO wires outbound-HTTPS interception before starting the container; from that point every HTTPS connection the container makes to the LLM provider host (`api.openai.com`) is transparently TLS-terminated by the `LlmInterceptor` WorkerEntrypoint and re-issued to the customer's AI Gateway REST API. The container never sees the gateway credentials.

```mermaid
sequenceDiagram
    participant C as Container (agent CLI)
    participant I as LlmInterceptor (WorkerEntrypoint)
    participant G as AI Gateway REST API
    participant P as Backend (OpenAI / Bedrock / Workers AI / dynamic route)

    Note over C: entrypoint.sh:<br/>- Trusts CF containers CA (system store)<br/>- Persists CA env (NODE_EXTRA_CA_CERTS,<br/>  REQUESTS_CA_BUNDLE) to .bashrc<br/>- Persists Copilot BYOK vars to .bashrc<br/>- Sets placeholder credential<br/>- Points agent at api.openai.com
    C->>I: HTTPS to api.openai.com<br/>(TLS intercepted by platform;<br/>placeholder Bearer stripped)
    I->>G: POST api.cloudflare.com/.../ai/v1/<path><br/>Authorization: Bearer AIG_TOKEN<br/>cf-aig-gateway-id: <gateway>
    G->>P: Routed by model id (gateway-side)
    P-->>G: Response
    G-->>I: Response
    I-->>C: Response (transparent)
```

**CA trust:** The platform TLS-terminates each intercepted connection and presents a certificate signed by the Cloudflare containers CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`). `entrypoint.sh` installs this CA into the system trust store and persists `NODE_EXTRA_CA_CERTS` / `REQUESTS_CA_BUNDLE` exports into `.bashrc` (sourced by the agent PTYs via `bash -l` → `.bash_profile` → `.bashrc`; a process-only export in the entrypoint would not reach them) so all agent runtimes (Node, Python) trust the intercepted connections without errors.

**Pre-start interception ordering ([REQ-ENTERPRISE-011](../../sdd/spec/enterprise-mode.md#req-enterprise-011-container-start-interception-ordering)):** The Container DO calls `setupEnterpriseInterception()` (which invokes `ctx.container.interceptOutboundHttps`) inside `startAndWaitForPorts()` **before** the SDK's `container.start()` call. This ordering is load-bearing: the Cloudflare containers CA at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` is only mounted after `interceptOutboundHttps` is registered. If wired after boot (e.g. in `onStart`), `entrypoint.sh` finds no cert to install, and every intercepted TLS handshake to `api.openai.com` fails. When `ENTERPRISE_MODE` is unset the override performs no interception work and the container start path is byte-identical to the non-enterprise path.

**Credential flow:** `AIG_GATEWAY_URL` and `AIG_TOKEN` are Worker secrets. They reach `LlmInterceptor` through the Worker environment only — never through the container env. The account id and gateway id are parsed from `AIG_GATEWAY_URL`. The interceptor uses two auth headers depending on transport: `Authorization: Bearer <AIG_TOKEN>` on the REST API (`api.cloudflare.com/.../ai/v1/*`, Workers AI scope) and `cf-aig-authorization: Bearer <AIG_TOKEN>` on the compat fallback (`gateway.ai.cloudflare.com/.../compat/*`, AI Gateway Run scope); `AIG_TOKEN` must carry both permissions or the missing transport is rejected with `error 10000`. The placeholder credential (`codeflare-enterprise`) written by `entrypoint.sh` is what puts each agent CLI into API mode; the interceptor strips it before forwarding. **Backend selection** — native provider, Amazon Bedrock, Workers AI, or a dynamic route — is entirely gateway-side via each agent's configured model id; codeflare holds no provider keys (BYOK lives in the gateway). See [AD72](../decisions/README.md#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) for the interception mechanism and [AD74](../decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api) for the REST API transport.

**Streaming normalization ([REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC3):** On streaming `/chat/completions` responses the interceptor pipes the SSE body through a transform that guarantees a terminal `finish_reason` chunk before `[DONE]`. AI Gateway dynamic routes can end a stream with `finish_reason: null` followed by `[DONE]`, omitting the terminal chunk; OpenAI-wire **Chat Completions** clients (Copilot) reject this as "Stream ended without finish_reason" and retry, multiplying token cost. (Both Copilot and Pi run on `chat/completions`, so this shim guards both; the `/responses` path is not used in the current configuration.) The shim synthesizes the missing terminator (`tool_calls` when a tool-call delta was seen on the stream, otherwise `stop`), is idempotent (it never adds a second terminator when the upstream already sent a non-null `finish_reason`), reassembles SSE `data:` lines split across network chunk boundaries (a single `data:` line arriving across multiple TCP chunks), and is bypassed for non-streaming and `/responses` traffic. The gateway's stored response log is normalized and shows `finish_reason: stop` even when the live wire omits it, so the repair is only observable on the wire. When `ENTERPRISE_MODE` is unset the interceptor is never wired and no normalization runs.

---

## Module-Level Caches

All module-level caches in the codebase. Workers isolates do not share memory, so each cache is per-isolate.

| Module | Cache Variable | TTL | What It Caches | Reset Function |
|---|---|---|---|---|
| `src/lib/access.ts` | `cachedAuthDomain`, `cachedAccessAud`, `cachedAccessAudList` | 5 min | CF Access auth domain and audience config | `resetAuthConfigCache()` |
| `src/lib/subscription.ts` | `cachedTierConfig` | 60s | Tier configuration from `tiers:config` KV key | `resetTierConfigCache()` |
| `src/lib/cors-cache.ts` | `cachedKvOrigins` | 5 min | CORS origins from `setup:custom_domain` + `setup:allowed_origins` | `resetCorsOriginsCache()` |
| `src/lib/jwt.ts` | JWKS key cache | 30s freshness threshold | Cloudflare Access JWKS public keys (re-fetched on kid miss after 30s) | `resetJWKSCache()` |
| `src/lib/stripe.ts` | `priceCache` | 1 hour | Stripe price amount/currency per price ID, including `currency_options` for multi-currency pricing | (none - TTL-only) |
| `src/lib/kv-crypto.ts` | imported CryptoKey | Isolate lifetime | AES-256 key from `ENCRYPTION_KEY` env var | (none - persists for isolate lifetime) |
| `src/lib/rate-limit-core.ts` | `failedKvOps` | Isolate lifetime | Counter for consecutive KV failures (circuit breaker) | (none) |
| `src/lib/circuit-breakers.ts` | per-container breakers | Isolate lifetime | Circuit breaker state per container ID | (none) |
| `src/lib/session-jwt.ts` | `cachedKey` | Isolate lifetime | HMAC CryptoKey imported from `OAUTH_JWT_SECRET` | (none - re-imported if secret changes) |

After admin config changes, different isolates may enforce different values for up to the cache TTL. This is an accepted trade-off for KV read performance.

---

## Design Rationale

Architectural principles and design rationale.

1. **rclone bisync > s3fs FUSE** - FUSE mounts are fragile and slow. Periodic bisync with local disk is faster and more reliable.
2. **Newest file wins** - Simple conflict resolution for single-user scenarios.
3. **Resilient bisync over auto-resync** - `--resilient` + `--recover` handle transient failures without losing deletion tracking. `--resync` is only used for initial baseline establishment (see [AD14](../decisions/README.md#ad14-never-auto---resync-on-bisync-failure)).
4. **Single-source idle detection via `collectMetrics`** - The DO polls `/activity` inside the container every 60 s and explicitly calls `stop('SIGTERM')` when `idleMs > parseSleepAfterMs(idleTimeoutPref)`. The SDK's own `sleepAfter` timer is pinned to `'24h'` and plays no role in idle decisions (see AD/rationale #11). This replaced both the earlier heartbeat-based approach AND a short-lived input-change-detection design that leaned on the SDK timer - both were fragile when WebSocket reconnects reset the SDK's activity timer. One mechanism, one signal: has the user typed within the configured threshold? Container stops ~threshold + up to 60 s after the last keystroke.
5. **Every container exit must write KV `status: 'stopped'` - KV is the single source of truth** - The persisted KV `status` is authoritative; the dashboard renders it verbatim with no read-side staleness reconciliation (the former `reconcileStaleStatus` heartbeat-age heuristic was removed in [codeflare#153](https://github.com/nikolanovoselec/codeflare/issues/153), see rationale #17 / [AD70](../decisions/README.md#ad70-container-exit-writes-kv-stopped-no-read-side-reconciliation)). For that to hold, every exit path must persist `stopped`, written through the shared `updateKvStatus()` helper: (a) graceful hibernation/idle-stop fires `onStop()`, which writes `stopped` and calls `deleteSchedules('collectMetrics')` to kill the alarm loop (otherwise zombie alarms fire on a dead container indefinitely); (b) an **unexpected** exit (crash, deploy-roll, platform reap) fires `onError()` - **not** `onStop()` - which writes `stopped` guarded on `!ctx.container.running` so a transient startup error cannot flip a still-starting container; (c) `collectMetrics()` is the 60s catch-all: its `!ctx.container.running` branch writes `stopped` on the next tick after any exit the hooks missed, then returns without re-arming. Without (b)/(c) an unexpected exit would dangle as `running` in KV forever.
6. **`destroy()` must clear identifiers before `super.destroy()`** - `onStop()` fires asynchronously after `super.destroy()`. Without clearing identifiers first, `onStop()` resuscitates deleted sessions in KV via read-modify-write.
7. **Secrets persist with worker state** - `wrangler delete` destroys all secrets.
8. **Single port architecture** - All services on port 8080 eliminates port conflict bugs.
9. **CPU metrics show load average, not utilization** - `os.loadavg()[0] / cpus * 100` measures run queue depth. Values >100% are normal.
10. **Downgrade verbose activity logs to debug** - Per-cycle activity check logs at `info` level generate log volume (every 60 s per container). Once the single-source `collectMetrics` idle enforcement is confirmed stable in production, downgrade to `debug`.
11. **Stateless dashboard polling preserves hibernation** - Dashboard status endpoints must be pure KV reads with zero DO contact. Waking a DO resets the Container SDK's internal activity timer; even with the SDK timer pinned to 24 h (see [REQ-SESSION-004](../../sdd/spec/session-lifecycle.md#req-session-004-idle-containers-sleep-after-configurable-timeout) AC5), unnecessary DO wake-ups waste resources and can interfere with hibernation. `@cloudflare/containers` v0.2.x also auto-refreshes on any WebSocket message, so the SDK timer sees "any traffic" semantics, not "no user input" semantics - this is the primary reason idle enforcement is delegated entirely to `collectMetrics()` rather than the SDK timer.
12. **Polling interval vs push cadence** - The backend pushes metrics to KV every 60s (`collectMetrics`). The frontend polls at 5s for responsive session status updates (start/stop transitions). Metrics on the dashboard may be up to ~60s stale.
13. **rclone version upgrades can break bisync** - The Alpine → Debian migration changed rclone v1.68 → v1.73, introducing stricter MD5 post-transfer verification that aborts on files modified during sync ("corrupted on transfer"). Fix: `--ignore-checksum` on all bisync commands. Pin rclone version in Dockerfile to prevent future surprise breakage. Additionally, `--max-delete 100` is required on all bisync commands - the default 50% threshold aborts syncs when bulk deletions (e.g., deleting a workspace folder) remove more than half the tracked files. **Warning**: `--resync` should never be used as an automatic recovery mechanism - it destroys bisync's deletion tracking (see [AD14](../decisions/README.md#ad14-never-auto---resync-on-bisync-failure)).
14. **Never auto-`--resync` on bisync failure** - `--resync` makes both sides identical by copying the newer version of every file, then creates a fresh baseline. This permanently loses any pending deletions - if side A deleted a file and bisync fails before propagating, `--resync` resurrects the file from side B. Use `--resilient` + `--recover` for self-healing: `--resilient` allows bisync to continue past non-critical errors, and `--recover` automatically reconstructs corrupted listing files without losing state. Manual `--resync` is still available via `establish_bisync_baseline()` on container startup (one-way restore runs first, so no data loss).
15. **Never `docker system prune` in CI deploy workflows** - `docker system prune -af` in the deploy workflow nukes the Docker layer cache on self-hosted runners, causing every subsequent build to pull all layers from scratch. This triggers Docker Hub 429 rate limit errors when base images need re-downloading. Let Docker manage its own cache; only prune manually if disk space is critical.
16. **Vanishing-file recovery before nuke** - When bisync fails with `lstat: no such file or directory`, the file was listed by rclone then deleted before the copy completed (race condition with agents writing/deleting transient files). The correct response is to parse the error, add the file to a session-scoped exclusion filter (`/tmp/rclone-recovery-filters.txt`), and retry - not escalate to `nuke_corrupted_r2_files`. Non-workspace files are auto-excluded; workspace files (user code) trigger a plain retry on the assumption the file reappeared. Known ephemeral files (`.claude/mcp-*.json`) are statically excluded from all sync operations to prevent the race from occurring. See [Vanishing-file recovery](storage-and-sync.md#vanishing-file-recovery) and [AD43](../decisions/README.md#ad43-parse-and-exclude-vanishing-files-before-escalating-to-nuke).
17. **Exit-writes-`stopped` over read-side reconciliation** - KV `status` is the single source of truth: every container exit persists `stopped` (rationale #5), so the dashboard renders KV verbatim with no staleness heuristic. The former `reconcileStaleStatus` read-side guess inferred `stopped` from a stale `metrics.updatedAt` heartbeat and falsely kicked live-but-idle sessions whose alarm loop had legitimately paused; it was removed in [codeflare#153](https://github.com/nikolanovoselec/codeflare/issues/153). Writing on exit is both correct (no dangling `running`) and simpler (no clock-skew tuning of a staleness threshold). See [AD70](../decisions/README.md#ad70-container-exit-writes-kv-stopped-no-read-side-reconciliation).
18. **Outbound-HTTPS interception over a Worker-side proxy for enterprise gateway routing** - `LlmInterceptor` wires into the platform's `interceptOutboundHttps` mechanism rather than a public `/llm-proxy` Worker route. Interception is platform-internal: the gateway URL and token never leave the Worker environment, the container communicates with the real provider host (intercepted transparently), no public route carries gateway credentials, and no CF Access policy can be tripped. See [AD72](../decisions/README.md#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing).

---

## Specification Coverage

- [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) - Outbound-interception LLM routing to customer AI Gateway
- [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) - Container-side enterprise routing (CA trust + constant base-URLs)
- [REQ-ENTERPRISE-011](../../sdd/spec/enterprise-mode.md#req-enterprise-011-container-start-interception-ordering) - Container start interception ordering (pre-start `interceptOutboundHttps`)
- [REQ-TERM-003](../../sdd/spec/terminal.md#req-term-003-automatic-websocket-reconnection-on-transient-failures) - Automatic WebSocket reconnection on transient failures
- [REQ-TERM-005](../../sdd/spec/terminal.md#req-term-005-tab-1-auto-starts-the-configured-agent) - Tab 1 auto-starts the configured agent
- [REQ-TERM-007](../../sdd/spec/terminal.md#req-term-007-tiling-layouts-2-split-3-split-4-grid) - Tiling layouts (2-split, 3-split, 4-grid)
- [REQ-TERM-008](../../sdd/spec/terminal.md#req-term-008-write-batching-at-30fps) - Write batching at 30fps
- [REQ-TERM-009](../../sdd/spec/terminal.md#req-term-009-process-name-detection-via-control-messages) - Process name detection via control messages
- [REQ-TERM-010](../../sdd/spec/terminal.md#req-term-010-session-presets-saved-tab-configurations) - Session presets (saved tab configurations)

---

## Related Documentation
- [Architecture Internals](architecture-internals.md) - Backend libraries, code structure, CF-NNN index
- [API Reference](api-reference.md) - All API endpoints
- [Authentication](authentication.md#authentication-modes) - Authentication modes and SaaS billing
- [Security](security.md) - Security model and rate limiting
- [Container](container.md) - Container image and startup
- [Storage & Sync](storage-and-sync.md) - R2 storage and rclone bisync
- [Configuration](configuration.md#worker-environment) - Environment variables
- [Decisions](../decisions/README.md) - Architecture Decision Records
