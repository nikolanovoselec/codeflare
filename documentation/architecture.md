# Architecture

System architecture, components, data flow, and design rationale for Codeflare.

**Audience:** Developers

---

## Architecture Overview

Codeflare runs AI coding agents in isolated containers, one per browser session (tab). All sessions for a user share a single R2 bucket for persistent storage, with periodic bidirectional sync (every 60 seconds).

```mermaid
graph TD
    B1["Browser Tab 1 (xterm.js)"] -->|WebSocket| W["Cloudflare Worker (Hono router)"]
    B2["Browser Tab 2 (xterm.js)"] -->|WebSocket| W
    W -->|"containerId=bucket-session1"| C1["Container 1"]
    W -->|"containerId=bucket-session2"| C2["Container 2"]
    C1 --- P1["PTY + Agent"]
    C2 --- P2["PTY + Agent"]
    P1 -->|"rclone bisync (every 60s)"| R2["R2 bucket (shared per user)"]
    P2 -->|"rclone bisync (every 60s)"| R2
```

**Workers.dev URL:** `https://<CLOUDFLARE_WORKER_NAME>.<ACCOUNT_SUBDOMAIN>.workers.dev` - used only for initial setup. After the setup wizard configures a custom domain, all traffic should go through the custom domain (protected by the configured auth mechanism — CF Access or GitHub OIDC). In CF Access mode, the workers.dev URL should be gated behind one-click Access in the Cloudflare dashboard.

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

**File:** `src/container/index.ts` - Extends `Container` from `@cloudflare/containers`. Exported from `src/index.ts` as lowercase `container` (matching `wrangler.toml` class_name). `defaultPort = 8080`, `sleepAfter = '5m'` class default (overridden per user from preferences on session start — see [Auto-sleep](container.md#auto-sleep-configurable-sleepafter)). SDK-managed lifecycle, renewed only on new user input via input-change detection. A second DO, `Timekeeper`, is exported from `src/timekeeper/index.ts` as lowercase `timekeeper` for per-user usage tracking (see [Timekeeper DO](authentication.md#timekeeper-do-usage-tracking)).

**SDK-Managed Hibernation:** `sleepAfter` lets the SDK handle container process lifecycle via its own alarm loop. `onStart()` records `containerStartedAt`, refreshes `envVars` via `updateEnvVars()`, updates KV with `lastStartedAt` timestamp AND `lastActiveAt` (set to start time so the frontend sleep timer icon has a reference timestamp even before any user input), clears stale `collectMetrics` schedules, and arms a fresh 60-second `collectMetrics` schedule. `onStop()` clears the `collectMetrics` schedule via `deleteSchedules('collectMetrics')` to kill the alarm loop immediately (preventing zombie alarms on dead containers), then sets KV status to `'stopped'` and updates `lastActiveAt` timestamp, ensuring other devices see correct status for hibernated containers.

**Fetch proxy bypass:** The `fetch()` override proxies requests via `getTcpPort().fetch()` instead of `super.fetch()` (which calls the SDK's `containerFetch()`). This is critical because `containerFetch()` calls `renewActivityTimeout()` internally, resetting the idle timer on every WebSocket reconnection — defeating the input-change-based renewal in `collectMetrics()`. By using `getTcpPort().fetch()`, only explicit `renewActivityTimeout()` calls (triggered by new user input) reset the timer.

**`collectMetrics()` Input-Change Detection (every 60s):**
1. Checks `this.ctx.container?.running` - returns early (no re-arm) if container is dead
2. Fetches `/activity` via `getTcpPort()` - uses input-change detection to decide whether to renew `sleepAfter`:
   - Reads `lastInputAt` from the activity response (Unix timestamp of last real user input)
   - Compares to `this.lastSeenInputAt` (the value from the previous poll)
   - **New input detected** (`lastInputAt !== null && lastInputAt !== lastSeenInputAt`): calls `renewActivityTimeout()` to reset the `sleepAfter` timer
   - **No new input**: does not renew — the `sleepAfter` timer continues counting down from the last renewal
   - Non-OK `/activity` response: does not renew (broken activity endpoint should not keep containers alive)
   - Activity logs are at info level for all renewal decisions
3. Fetches `/health` via `getTcpPort()` - reads cpu/mem/hdd/syncStatus
4. **Zombie DO detection**: When identifiers are missing (post-`destroy()`), returns early WITHOUT re-arming
5. Writes metrics to KV session record (`session.metrics`) if container still running
6. **Timekeeper usage ping** (SaaS mode only, when `SAAS_MODE=active` + `bucketName` + `userEmail` + `TIMEKEEPER` binding): increments `_usageSeconds` by 60, persists to DO storage, pings Timekeeper DO with `{ bucketName, sessionId, totalSeconds, email }`. If Timekeeper returns `quotaExceeded: true`, calls `stop('SIGTERM')` and returns without re-arming
7. Re-arms schedule if container still running

**Zombie DO Detection:** When `collectMetrics` reaches the health-fetch stage but `sessionId` or `bucketName` are missing from DO storage (happens after `destroy()` clears them), it logs `"missing identifiers, not re-arming (zombie DO)"` and returns without scheduling the next cycle. This is the kill switch for orphaned DOs.

```mermaid
flowchart TD
    CM["collectMetrics() fires<br/>(every 60s)"] --> CRunning{"container.running?"}
    CRunning -->|No| Exit1["Early return, no re-arm<br/>(loop dies -- container dead)"]
    CRunning -->|Yes| FetchAct["Fetch /activity<br/>from container"]
    FetchAct --> ActOK{"Response OK?"}
    ActOK -->|No| NoRenewErr["Don't renew<br/>(broken endpoint)"]
    ActOK -->|Yes| InputChanged{"lastInputAt changed<br/>since last poll?"}
    InputChanged -->|Yes| Renew["renewActivityTimeout()<br/>(reset sleepAfter timer)"]
    InputChanged -->|No| NoRenew["Don't renew<br/>(no new input)"]
    Renew --> FetchHealth["Fetch /health<br/>from container"]
    NoRenew --> FetchHealth
    NoRenewErr --> FetchHealth
    FetchHealth --> IDs{"identifiers exist?<br/>(sessionId + bucketName)"}
    IDs -->|No| Exit2["Early return, no re-arm<br/>(zombie DO detected)"]
    IDs -->|Yes| WriteKV["Write metrics to KV"]
    WriteKV --> TK{"SaaS mode +<br/>Timekeeper binding?"}
    TK -->|Yes| Ping["Timekeeper ping<br/>(+60s usage)"]
    Ping --> QuotaCheck{"quotaExceeded?"}
    QuotaCheck -->|Yes| Stop["stop(SIGTERM)<br/>(no re-arm)"]
    QuotaCheck -->|No| ReArm["schedule(60, 'collectMetrics')<br/>(if container.running)"]
    TK -->|No| ReArm
```

**`onActivityExpired()` Override:** Performs a final input-change check before stopping. Fetches `/activity` and compares `lastInputAt` to `lastSeenInputAt`. If new input was received since the last `collectMetrics` poll (i.e., user typed between the last poll and expiry), renews `sleepAfter` and returns. Otherwise calls `this.stop('SIGTERM')`. Container not running, non-OK `/activity` response, or fetch error all result in `this.stop('SIGTERM')`. By the time `onActivityExpired` fires, the user-configured `sleepAfter` duration of zero `renewActivityTimeout()` calls has elapsed.

**`destroy()` Override:** Clears `SESSION_ID_KEY`, `bucketName`, `workspaceSyncEnabled`, `tabConfig`, `fastStartEnabled` from DO storage and nulls `_bucketName`, `_sessionId`, `_r2AccessKeyId`, `_r2SecretAccessKey`, `_containerAuthToken`, `_openaiApiKey`, `_geminiApiKey`, `_githubToken`, `_cloudflareApiToken`, `_cloudflareAccountId`, `_encryptionKey` in memory, and resets `_sessionMode` to `'default'` BEFORE calling `super.destroy()`. This prevents `onStop()` (triggered asynchronously by `super.destroy()` killing the container) from resurrecting deleted sessions in KV.

**Environment Variables Injection:** R2 credentials flow via two paths: (1) `_internal/setBucketName` request body (primary, from Worker), (2) `this.env` fallback (DO restart). Fallback chain: Worker-provided > `this.env` > empty string.

```mermaid
sequenceDiagram
    participant W as Worker
    participant DO as DO (constructor)
    participant SBN as setBucketName
    participant OS as onStart
    participant C as Container

    W->>DO: new DO instance (blockConcurrencyWhile)
    DO->>DO: Load sessionId + bucketName + prefs<br/>+ usageSeconds + userEmail from storage
    W->>SBN: POST with R2 creds in body
    SBN->>DO: Store bucketName + creds in storage
    DO->>OS: startAndWaitForPorts()
    OS->>OS: Build envVars<br/>(Worker-provided > this.env > empty)
    OS->>C: Start with env vars
    Note over DO: On hibernation wake, constructor<br/>re-runs blockConcurrencyWhile,<br/>reloading from storage
```

**Critical: `envVars` must be set as a property assignment**, not as a getter. Cloudflare Containers reads `this.envVars` as a plain property at `start()` time.

**`setBucketName` Idempotency (409 Path):** Once `_bucketName` is set, subsequent `setBucketName` calls return 409. BUT the 409 handler still stores `sessionId`, `workspaceSyncEnabled`, `tabConfig`, `fastStartEnabled`, and `userEmail` in DO storage, updates in-memory LLM keys, deploy keys, encryption key, and session mode, and applies `sleepAfter` preference -- this ensures `collectMetrics`/`onStop` can find the KV entry even on session restarts (where the DO already has a bucket set but needs the sessionId for the new lifecycle), that user preference changes take effect without container recreation, and that the Timekeeper gets the correct user identity.

**Lifecycle Route Re-calls `setBucketName` After `destroy()`:** In the `needsBucketUpdate` path (restart with different bucket), `destroy()` wipes DO storage. The lifecycle route must call `setBucketName` again after `destroy()` to re-populate sessionId, bucketName, and R2 credentials. See `src/routes/container/lifecycle.ts`.

**Internal Endpoints:** `/_internal/setBucketName`, `/_internal/setSessionId`, `/_internal/getBucketName`

### Terminal Server (node-pty)

**File:** `host/src/server.ts` - Node.js/TypeScript server inside the container. Single port 8080 for WebSocket + REST + health/metrics.

Sync handled entirely by `entrypoint.sh` (60s daemon). Terminal server reads sync status from `/tmp/sync-status.json` and exposes via `/health`. Activity tracking (WebSocket connection state + user input timestamps: `hasActiveConnections`, `connectedClients`, `activeSessions`, `disconnectedForMs`, `lastInputAt`) for hibernation decisions via `GET /activity`. Unknown JSON `type` strings are silently ignored (guard against future message types leaking to PTY).

**Auth-Exempt Paths:** The terminal server validates `Authorization: Bearer <token>` on all HTTP requests. Paths called via `getTcpPort().fetch()` (which bypasses the DO's `fetch()` override that injects the auth header) must be in the `authExemptPaths` Set at `host/src/server.ts`: `['/health', '/activity']`. The `/activity` endpoint is also exempted from auth in the DO-level `fetch()` override so internal health checks don't require token injection.

**`GET /activity` Endpoint:** Returns `{ hasActiveConnections: boolean, connectedClients: number, activeSessions: number, disconnectedForMs: number | null, lastInputAt: number | null }`. Used by both `collectMetrics()` (input-change detection) and `onActivityExpired()` (final input check). Active connections = WebSocket clients that are currently connected. `disconnectedForMs` tracks time since all clients disconnected (null if clients are currently connected). `lastInputAt` is the Unix timestamp (ms) of the last real user input — determined by `containsUserInput()` after `stripTerminalResponses()` removes terminal protocol chatter (CPR, OSC, DA). The DO compares `lastInputAt` to its `lastSeenInputAt` field to detect new input between polls.

**Idle Detection (Two-Layer):** The Container DO enforces idle timeout through two complementary mechanisms:

1. **SDK timer (`onActivityExpired`):** The SDK's built-in `sleepAfter` timer fires when no HTTP requests pass through `super.fetch()` for the configured duration. Works well for longer timeouts (30m+) where WebSocket reconnects are infrequent. `onActivityExpired()` checks `/activity` one last time and calls `this.stop('SIGTERM')`. The KV status write happens in `onStop()`, not in `onActivityExpired()` itself.

2. **Explicit idle-stop (`collectMetrics`):** `collectMetrics()` polls `/activity` every 60s and independently checks idle time: `Date.now() - (lastInputAt ?? containerStartedAt)`. If this exceeds `parseSleepAfterMs()`, it writes KV status `'stopped'` and calls `this.stop('SIGTERM')`. This is the **primary** enforcement for short timeouts (5m) because `super.fetch()` resets the SDK timer on every HTTP request (including periodic WebSocket reconnects), preventing `onActivityExpired()` from firing.

The `containerStartedAt` fallback is critical: if a user opens a terminal but never types, `lastInputAt` stays `null`. Without the fallback, the idle check would be skipped and the container would run forever. With the fallback, idle time is measured from container start.

`containsUserInput()` in `host/src/session.ts` uses a whitelist approach — only actual keypresses count (printable characters, control keys, arrow keys, function keys, Alt+key, mouse clicks). Terminal protocol responses (CSI, OSC, DCS, APC, focus reports, mouse movement) do not count. `stripTerminalResponses()` removes terminal emulator response sequences (CPR, OSC 10/11/12, DA1) before writing to the PTY. Scenarios: user stops typing → container stops after `sleepAfter` + up to 60s (poll granularity); browser closed → same; user opens terminal but never types → container stops after `sleepAfter` from start time.

**WebSocket Wake-Loop Prevention:** Three layers prevent browser auto-reconnect from waking a hibernated container in an infinite stop/start cycle:
1. **DO fetch gate** (`container/index.ts`): The `fetch()` override returns 503 when `!this.ctx.container?.running` for all non-internal routes. This is authoritative (the DO knows container state directly, no KV read needed) and prevents `super.fetch()` from triggering the SDK's `startIfNotRunning`.
2. **Terminal route guard** (`routes/terminal.ts`): Rejects WebSocket upgrade requests with 503 when `session.status === 'stopped'` in KV. This is defense-in-depth — catches requests before they reach the DO.
3. **Frontend disposal** (`stores/session.ts`): The session poller detects running→stopped transitions and calls `terminalStore.disposeSession(sessionId)`, which kills all WebSocket retry loops for that session. Fresh `connect()` calls are only made when the user explicitly starts the session again.

**WebSocket Protocol:** Raw terminal data (NOT JSON-wrapped). Control messages (resize, process-name) as JSON. No application-level ping/pong -- Cloudflare handles protocol-level WebSocket keepalive for DO/Container connections. Headless terminal (xterm SerializeAddon) captures full state for reconnection.

**PTY:** Spawns `bash -l` (login shell for .bashrc) with `xterm-256color`, truecolor support.

**Terminal emulator response stripping:** `stripTerminalResponses()` in `host/src/session.ts` strips terminal emulator responses (CPR, OSC 10/11/12, DA1) from WebSocket input before writing to the PTY. These responses are generated by xterm.js in reply to terminal queries issued by CLI tools (e.g., `gh secret set` reads an OSC 11 response as the secret value). `containsUserInput()` then classifies the original data using a whitelist approach: printable characters, control keys (Enter, Backspace, Tab, Ctrl+key), arrow keys, function keys, Alt+key, and mouse clicks count as user input for idle detection. Terminal protocol chatter (CSI/OSC/DCS/APC sequences, focus reports, mouse movement/release) does not count. The `Session.write()` method calls both: PTY receives the filtered data, and `activityTracker.recordInput()` is called only when `containsUserInput()` returns true.

### Frontend (SolidJS + xterm.js)

**Directory:** `web-ui/`

Key files: `App.tsx` (root), `Terminal.tsx` (xterm.js), `TerminalTabs.tsx`, `Layout.tsx` (orchestrates dashboard/terminal views, manages WS disconnect/reconnect lifecycle), `SessionStatCard.tsx` (dashboard card with three-color status dot and metrics), `StorageBrowser.tsx` (R2 browser with toolbar), `StoragePanel.tsx` (slide-in drawer), `SettingsPanel.tsx`, `Dashboard.tsx`, `OnboardingLanding.tsx`, `OnboardingPage.tsx` (guided setup), `SubscribePage.tsx` (subscription flow), `UsagePage.tsx` (usage dashboard), `LoginPage.tsx` (SaaS login), `Header.tsx` (nav + user dropdown + inline usage), `KittScanner.tsx`.

Stores: `terminal.ts` (WebSocket state, compound key `sessionId:terminalId`, scheduled disconnect/reconnect), `terminal-url-detection.ts` (URL detection signals for floating buttons), `terminal-layout.ts` (terminal layout state), `session.ts` (CRUD, `terminalsPerSession`, `stopSession()` sets `'stopping'` and polls, `refreshSessionStatuses()` for lightweight dashboard polling — also updates storage stats from batch-status via `updateStatsFromBatch()`), `storage.ts` (R2 operations), `setup.ts`, `tiling.ts` (tiled terminal layout), `session-presets.ts` (preset/bookmark management), `session-tabs.ts` (tab configuration).

#### Dashboard WS Disconnect Flow

When user navigates to dashboard, `Layout.tsx` calls `scheduleDisconnect(DASHBOARD_WS_DISCONNECT_DELAY_MS)` (60s grace period). After the grace period, `disconnectAll()` closes all WS connections with reason `'dashboard-disconnect'`. Container can then idle to `sleepAfter` (user-configurable, default 30m for paying users, 5m for free tier). When user returns to terminal view, `cancelScheduledDisconnect()` cancels any pending timer, then `reconnectDisconnectedTerminals(activeSessionId)` reconnects only the active session's terminals. The `untrack()` fix in `Layout.tsx`'s `createEffect` wraps `activeSessionId` to prevent the reactive dependency from triggering reconnects on unrelated session changes.

**Tab Visibility Auto-Refresh:** `Layout.tsx` listens for `visibilitychange` events. When the tab returns from background (mobile browser tab switch, screen off/on), it auto-refreshes session statuses and storage listing. This prevents stale "Failed to fetch" errors that appear when background tabs have their network requests aborted by the browser. Storage refresh is silent (no loading spinner) to avoid UI flicker.

**Session Status Architecture:** KV polling (every 5s via batch-status) is the source of truth for session status. The Container DO sends custom WS close code **4503** when `!this.ctx.container?.running`, giving the client an authoritative "container stopped" signal distinct from network errors (code 1006). On 4503, the client immediately sets the terminal to `'disconnected'` with "Session stopped" message and stops retrying. On 1006 (network error), the client retries indefinitely — KV polling will update the status when propagation completes. Guards only block KV polling during user-initiated stop (`session.status === 'stopping'`) and session initialization (`session.status === 'initializing'`). When KV polling transitions a session to 'stopped', it also disposes terminal connections and clears `activeSessionId`.

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

#### Polling and Consistency

**Polling Interval:** `SESSION_LIST_POLL_INTERVAL_MS = 5000` -- frontend polls at 5s for responsive UI. The DO's `collectMetrics` pushes metrics to KV every 60s, so metrics may be up to ~60s stale on the dashboard. `CONTEXT_EXPIRY_MS = 30 * 60 * 1000` (30m) is the frontend context expiry threshold for detecting stale sessions. Note: backend `sleepAfter` is now user-configurable (5m–2h, default 30m), so context expiry may not exactly match all users' sleep timers.

**KV Eventual Consistency:** ~60s propagation delay for new sessions. Metrics may not appear at edge immediately after first `collectMetrics` write. The frontend handles this gracefully -- `SessionStatCard` shows last-known metrics for recently-stopped sessions.

#### KV Optimization (1500-User Scale)

Three optimizations reduce KV operations from ~910K/sec to ~350/sec at 1500 concurrent users:

**1. List Metadata for batch-status:** `putSessionWithMetadata()` in `kv-keys.ts` writes compressed `SessionListMetadata` (status, timestamps, metrics — ~195 bytes) alongside the session value via `kv.put(key, value, { metadata })`. `GET /api/sessions/batch-status` reads from `kv.list()` metadata instead of N individual `kv.get()` calls. Graceful fallback to `kv.get()` for pre-migration keys without metadata. Compressed field names: `s` (status: 'r'|'s'), `la` (lastActiveAt), `sa` (lastStartedAt), `m.c/e/h/y/u` (metrics). All 9 session write sites use `putSessionWithMetadata`. `validateSessionAndCheckLimits` also reads running count from metadata.

**2. Metrics via List Metadata:** `collectMetrics` writes metrics inline on the session record via `putSessionWithMetadata()`, which stores compressed `SessionListMetadata` (including metrics) as KV list metadata. `batch-status` reads these from `kv.list()` without individual `kv.get()` calls.

**3. User Record Cache:** Module-level `Map<string, { data, cachedAt }>` in Timekeeper with 60s TTL and 100-entry cap for `user:{email}` reads in `handlePing()`. Matches `getTierConfig()` cache pattern. Reduces 1500 uncached KV reads/min to ~25. `resetUserRecordCache()` exported for test cleanup.

| Metric | Before | After | Reduction |
|--------|--------|-------|-----------|
| batch-status KV reads/sec | ~901,500 | ~300 | 99.97% |
| Timekeeper user reads/min | 1,500 | ~25 | 98.3% |
| collectMetrics session reads/min | 1,500 | 0 | 100% |

**Auto-Reconnect:** Infinite retries with 1-second delay (`WS_RETRY_DELAY_MS = 1000`) for retryable close codes (1001, 1006, 1011, 1012, 1013). No dead-container inference from retry failure — only the server-authoritative close code 4503 stops retrying. Reconnection triggers session buffer replay via SerializeAddon state restore. AbortController-based cancellation prevents parallel retry loops.

**No Application-Level WS Pings:** Removed. Cloudflare's runtime handles protocol-level WebSocket keepalive for DO/Container connections automatically.

**Character Doubling Fix:** The `inputDisposable` must be stored outside `connect()` and disposed before creating a new handler on reconnect:
```typescript
let inputDisposable: IDisposable | null = null;
function connect() {
  inputDisposable?.dispose();
  inputDisposable = terminal.onData((data) => ws.send(data));
}
```

#### UI Features

**Nested Terminals (Multiple PTYs per Session):** Up to 6 terminal tabs per session. Compound key strategy: frontend `sessionId:terminalId`, WebSocket URL `/api/terminal/{sessionId}-{terminalId}/ws`. Backend parses compound ID, validates base session, forwards full ID to container. Container's SessionManager handles each compound ID as a separate PTY.

**StoragePanel (R2 File Browser):** Files: `StoragePanel.tsx`, `StorageBrowser.tsx`, `stores/storage.ts`. Desktop: 400px slide-in drawer. Mobile: bottom-sheet. Mutual exclusion with SettingsPanel. Reads directly from R2 via Worker API (no container-side sync trigger). Container sync handled by 60s bisync daemon.

**R2 Storage Stats Caching:** `GET /api/storage/stats` paginates all R2 objects and caches results in KV (`storage-stats:{bucketName}`, 60s TTL). `batch-status` piggybacks cached stats (no TTL check — relies on cache being fresh). Mutation endpoints (upload, delete, seed) invalidate the KV cache after successful operations. Dashboard calls `storageStore.fetchStats()` on mount, which hits `/api/storage/stats` and refreshes from R2 if the cache is stale or missing.

**Logout:** The frontend navigates to `/auth/logout` via `window.location.href`. The backend route (in `auth-redirects.ts`) dispatches based on mode: SaaS OIDC redirects to `/auth/github/logout` (clears `codeflare_session` cookie), CF Access mode redirects to `https://{authDomain}/cdn-cgi/access/logout?returnTo=https://{customDomain}/`.

**Header User Dropdown:** Clicking the avatar/username in both Header (terminal view) and Dashboard opens a dropdown with three items: Profile (`/app/subscribe`), Guided Setup (`/app/onboarding`), and Logout. Profile and Guided Setup use plain `<a href>` tags with no `onClick` handlers — SolidJS Router's top-level DOM listener intercepts clicks for client-side navigation (no full page reload, no white flash on dark backgrounds). This is critical for mobile: previous attempts using `<button>` + `window.location.href` or `onClick` handlers failed due to touch event race conditions with Portal DOM removal. Logout uses `window.location.href` to navigate to `/auth/logout` (dispatches to OIDC or CF Access logout depending on mode). Dashboard dropdown uses `Portal` with the dropdown nested inside the overlay as a child (not a sibling) — `stopPropagation` on the dropdown div prevents touch events from reaching the overlay's `onClick`. Desktop: positioned below avatar via `getBoundingClientRect()`. Mobile: bottom sheet.

**Onboarding Page (`/app/onboarding`):** Guided setup page for new users. Three sections: (1) Connect GitHub — saves PAT via `updateDeployKeys`, (2) Connect Cloudflare — saves API token, (3) Coding Agents — informational cards linking to signup pages for 6 supported agents. Reuses `ProviderRow` and `BrandIcons` from settings. "Skip and Continue to Codeflare" button always visible. Uses standalone `.onboarding-page` container (`position: fixed; inset: 0; overflow-y: auto`) instead of `.login-page` — same pattern as `.setup-wizard` — because `.login-page` has `overflow: hidden` that blocks scrolling. **First-time redirect:** In SaaS mode, `AppContent` checks `onboardingComplete` from `/api/user` — if `false`, redirects to `/app/onboarding`. The Skip/Continue buttons call `POST /api/user/onboarding-complete` which sets `onboardingComplete: true` in the user's KV entry. Subsequent visits go directly to the dashboard. Users can always revisit via the header dropdown ("Guided Setup").

**Font consistency:** Login, subscribe, and onboarding pages all use `JetBrains Mono` monospace font via `font-family` on `.login-content` and `.onboarding-content` root containers. All child text inherits — no sans-serif fallback.

**Admin Protection:** Admin users always have `unlimited` subscription tier and can switch between default/advanced session modes freely. `canUseAdvanced()` in SettingsPanel returns `true` for admins regardless of stored tier — prevents admin lockout when JIT-provisioned with `pending` tier before being promoted. Backend rejects both tier changes (`PATCH /api/users/:email`) and deletions (`DELETE /api/users/:email`) for admin-role users. Frontend hides tier dropdown and delete button for admins in UserManagement.

**Live Tier Refresh:** `SettingsPanel` re-fetches `/api/user` each time it opens, updating a `liveAccessTier` signal with `subscriptionTier ?? accessTier` and `userHasSubscribed` signal from `hasSubscribed`. This ensures tier upgrades (admin promotes user to a higher tier) and subscription status changes take effect without a full page reload — the user just needs to close and reopen Settings. The `hasSubscribed` flag controls whether the auto-sleep dropdown is enabled.

**Auto-advanced session mode:** When a user is promoted to `advanced` tier via `PATCH /api/users/:email`, the backend also writes `sessionMode: 'advanced'` to their preferences (`user-prefs:{bucketName}`) if no `sessionMode` is set yet. This ensures their first bucket creation seeds advanced skills and agent rules. Existing user preferences (where `sessionMode` is already set) are not overridden. Admin users created by setup also get `sessionMode: 'advanced'` in their preferences automatically.

**Bucket creation and seeding:** R2 buckets are auto-created on first access from two paths: (1) `POST /api/container/start` via `ensureBucketAndSeed` and (2) `GET /api/storage/browse` when the dashboard loads the storage panel. Both paths read `sessionMode` from user preferences (`user-prefs:{bucketName}`) via `resolveSessionMode()` and pass it to `seedAgentConfigs()`/`reconcileAgentConfigs()` so the correct mode-specific files are seeded. The storage browser path typically runs first (dashboard loads before user starts a session).

**Frontend Zod Validation:** `web-ui/src/lib/schemas.ts` -- Zod schemas validate API responses at runtime. Types derived from schemas via `z.infer`.

**Terminal Tab Configuration:** `web-ui/src/lib/terminal-config.ts` -- Generic "Terminal 1-6" defaults with live process detection via `PROCESS_ICON_MAP` (maps running process names like cu, codex, gemini, opencode, copilot, htop, yazi, lazygit, bash, sh, zsh to MDI icons). `PROCESS_DISPLAY_NAME` maps binary names to display names (e.g. `cu` → `claude`) so tabs show the product name instead of the binary name. Separate `AGENT_ICON_MAP` maps the 6 agent types (claude-code, codex, gemini, opencode, copilot, bash) to session card icons.

#### Frontend Constants

**File:** `web-ui/src/lib/constants.ts` -- 20 exported constants for polling intervals, timeouts, WebSocket close codes, max terminals, display lengths, URL detection patterns, view transitions, context expiry, dashboard WS disconnect delay.

---

## Backend Libraries

| File | Purpose |
|------|---------|
| `src/middleware/auth.ts` | Shared authentication middleware. Delegates to `authenticateRequest()` which throws `AuthError`/`ForbiddenError` on failure. Sets `c.get('user')` and `c.get('bucketName')` for downstream handlers. |
| `src/lib/container-helpers.ts` | Consolidated container initialization: `getSessionIdFromQuery()` (from query param), `getContainerId()` (with validation, never fallbacks), `getContainerContext()` (full context for route handlers). |
| `src/lib/error-types.ts` | `AppError` base class with `code`, `statusCode`, `message`, `userMessage`. Specialized: `NotFoundError` (404), `ValidationError` (400), `ContainerError` (500), `AuthError` (401), `ForbiddenError` (403), `SetupError` (400), `RateLimitError` (429), `QuotaExceededError` (402), `CircuitBreakerOpenError` (503). Utilities: `toError(unknown)`, `toErrorMessage(unknown)`. |
| `src/lib/type-guards.ts` | Runtime type validation replacing unsafe type casts (e.g., `isBucketNameResponse()`). |
| `src/lib/constants.ts` | Single source of truth for 18 constants + 1 exported function: ports (`TERMINAL_SERVER_PORT = 8080`), session ID validation, CORS defaults, rate limit keys/windows, container fetch timeouts, max presets/tabs, protected paths, request ID config, session limits (`getMaxSessions()`). |
| `src/lib/circuit-breaker.ts` | Prevents cascading failures. States: CLOSED (normal), OPEN (fail fast), HALF_OPEN (testing recovery). Wraps `container.fetch()` calls. |
| `src/middleware/rate-limit.ts` | Per-user rate limiting (bucketName from auth, IP fallback). Stores counts in KV. Adds `X-RateLimit-*` headers. |
| `src/lib/logger.ts` | JSON logging with `createLogger(module)`, child loggers with request context. |
| `src/lib/jwt.ts` | RS256 verification against CF Access JWKS (`https://{authDomain}/cdn-cgi/access/certs`). Per-isolate JWKS cache with `resetJWKSCache()`. |
| `src/lib/cache-reset.ts` | Centralized invalidation of CORS + auth config + JWKS caches. Called by setup wizard after configuration changes. |
| `src/lib/cf-api.ts` | Cloudflare API client. `parseCfResponse` checks `Content-Type` header before JSON parsing. When content-type is not `application/json`, attempts `JSON.parse` on the text body as a lenient fallback (Cloudflare sometimes omits content-type on valid JSON). Only throws a structured `AppError` with the first 200 chars of the response body if the parse actually fails -- this gives clear diagnostics for HTML error pages or plain text from expired tokens, instead of opaque JSON parse errors. |
| `src/lib/request-helpers.ts` | Shared request handling: `parseJsonBody(c)` (JSON parse with ValidationError on malformed input), `firstZodError(error)` (first Zod issue message with fallback), `validateSessionId(id)` (throws on invalid format), `maskSecret(value)` (shows last 4 chars). |
| `src/lib/kv-keys.ts` | KV key utilities: session/user key helpers, `SETUP_KEYS` const for all 20 `setup:*` configuration keys, `getBaseUrl(kv, requestUrl)`, `listAllKvKeys()`. |
| `src/types.ts` | `BillingStatus` union type (`'active' | 'trialing' | 'past_due' | 'canceled'`) with `BILLING_STATUS` const and `isBillingStatus()` guard. `ContainerConfigPayload` groups 16 container initialization params into logical sub-objects (R2 creds, LlmKeys, DeployKeys, preferences). |

### Setup Wizard Resilience

**Directory:** `src/routes/setup/`

All Cloudflare API calls in the setup wizard are wrapped in `withSetupRetry()` (defined in `shared.ts`) for transient failure resilience. The wrapper retries up to 2 times (3 total attempts) with exponential backoff (1s, 2s), skipping retry for `CircuitBreakerOpenError`.

**Cross-environment safety:** `resolveManagedAccessApp()` in `access.ts` uses a 4-tier fallback to find existing Access apps: (1) exact domain match, (2) stored app ID from KV, (3) name match + domain validation, (4) `/app/*` suffix + domain validation. Tiers 3 and 4 validate domain to prevent cross-environment collision when multiple environments share a CF account.

```mermaid
flowchart TD
    Start["resolveManagedAccessApp()"] --> T1{"Tier 1:<br/>Exact domain match<br/>in Access apps list?"}
    T1 -->|Found| R1["Return app"]
    T1 -->|Not found| T2{"Tier 2:<br/>Stored app ID<br/>from KV?"}
    T2 -->|Found| R2["Return app"]
    T2 -->|Not found| T3{"Tier 3:<br/>Name match +<br/>domain validation?"}
    T3 -->|Found| R3["Return app"]
    T3 -->|Not found| T4{"Tier 4:<br/>/app/* suffix +<br/>domain validation?"}
    T4 -->|Found| R4["Return app"]
    T4 -->|Not found| Create["Create new Access app"]

    T3 -.- Note1["Tiers 3-4: domain validation<br/>prevents cross-environment collision"]
    T4 -.- Note1
```

**Error propagation:** `listAccessApps()` and `listAccessGroups()` propagate errors through `withSetupRetry` rather than silently returning `[]`. Errors surface as `SetupError` with step details. The frontend `ApiError` carries a `steps` array from `SetupError` JSON responses.

**Stale user removal during reconfiguration:** When `POST /configure` is re-run with a new `allowedUsers` list, users no longer in the list are removed via `cleanupUserData()` (`src/lib/user-cleanup.ts`), wrapped in `runStep('cleanup_stale_users')` for progress visibility. This performs full cleanup identical to `DELETE /api/users/:email`: destroys all active sessions/containers, deletes bucket-keyed KV entries (`storage-stats:`, `presets:`, `user-prefs:`, `timekeeper:`), deletes the R2 scoped token, empties the R2 bucket (paginated `ListObjectsV2` + `DeleteObjects` via `emptyR2Bucket`), and deletes the bucket via CF API with retry logic (up to 3 attempts with exponential backoff for R2 eventual consistency). **SaaS mode:** only admin-role users removed from the admin list are cleaned up — JIT-provisioned regular users are preserved (managed via User Management, not setup). Each existing KV user is checked for `role: 'admin'` before deletion. Admin KV writes merge with existing entries (preserving tier fields) and always set `subscriptionTier: 'unlimited'`. **Self-removal prevention:** during reconfiguration, the backend rejects the request if the current authenticated user is not in the submitted admin list (`ValidationError: 'You cannot remove yourself from the admin list'`). The Zod schema enforces at least 1 admin user.

### Session Route Architecture

**Directory:** `src/routes/session/` - Split into `index.ts` (aggregator), `crud.ts` (CRUD), `lifecycle.ts` (start/stop/status/batch-status).

**Session Stop Flow (user-initiated):** Sets KV status to `'stopped'`, calls `container.destroy()` (sends SIGINT per Dockerfile STOPSIGNAL, then SIGKILL), entrypoint.sh shutdown handler runs final `rclone bisync`. `destroy()` override clears `SESSION_ID_KEY`/`bucketName` from DO storage before `super.destroy()` -- prevents `onStop()` from resurrecting the deleted session. Both `batch-status` and `GET /:id/status` trust the `'stopped'` KV status to avoid waking the DO (exception: stale >5 minutes triggers probe).

**Session Stop Flow (idle):** `onActivityExpired()` detects no new user input since last `collectMetrics` poll, or unreachable activity endpoint -> `this.stop('SIGTERM')` -> `onStop()` clears `collectMetrics` schedule and writes `status: 'stopped'` to KV. Note: `onActivityExpired()` itself does not write KV — the KV write happens in `onStop()`.

---

### Code Structure (Pre-Launch Refactoring)

**Container DO extraction:** `src/container/index.ts` split from 887 → 475 lines:
- `container-env.ts` (338 lines): env var construction, bucket name application, credential injection, prefs-on-restart
- `container-metrics.ts` (267 lines): collectMetrics, idle detection, Timekeeper ping, KV status updates (immutable spread, not mutation)
- `index.ts` (475 lines): thin facade owning DO lifecycle (constructor, fetch, onStart, onStop, alarm). Sub-modules receive state via explicit interface parameters, not class inheritance.

**Session store extraction (CF-013):** `web-ui/src/stores/session.ts` split from 768 → 582 lines:
- `session-polling.ts` (196 lines): refreshSessionStatuses, miss counters, start/stop polling. Uses dependency injection via `registerPollingDeps()`.
- `session-usage.ts` (73 lines): UsageState, warning levels, localStorage cache. Self-contained, no circular deps.
- `session.ts` (582 lines): facade re-exports all members. Public API unchanged.

**Type safety fixes (CF-007):** `countPaidSlots` typed (no more `any[]`). Admin PATCH user uses `updateUserRecord` (not raw `KV.put`). `maxUsers` added to frontend `GetUsersResponseSchema` (no more double cast).

**Validation consolidation (CF-009):** 4 inline `SESSION_ID_PATTERN.test()` in `crud.ts` replaced with `validateSessionId()` from `request-helpers.ts`. Errors flow through global handler with consistent JSON shape.

**Shared config schema (CF-006):** `SetBucketNameBodySchema` in `container-config-schema.ts` — Zod schema for setBucketName payload with `.passthrough()` for flexibility. Deploy credential fields use conditional spread (not explicit `null`).

**ScrambleText consolidation (CF-016):** `ScrambleText.tsx` rewritten as 15-line wrapper around `useScrambleText` hook (canonical `requestAnimationFrame` implementation). Single source of truth for scramble animation. Hook accepts `animateOnMount` option to trigger scramble on first render (used by standalone ScrambleText component on login/subscribe pages).

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

### Startup Status Stages

| Stage | Progress | Condition |
|-------|----------|-----------|
| stopped | 0% | Container not running |
| starting | 10-20% | Container running but health server not responding |
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
    running --> stopped : onActivityExpired (no new input)
```

**Stop (idle):** `sleepAfter` expires -> SDK calls `onActivityExpired()` -> checks `/activity` -> `lastInputAt` unchanged since last poll (no new input) or unreachable endpoint -> `this.stop('SIGTERM')` -> `onStop()` clears `collectMetrics` schedule -> KV status = `'stopped'`

**Fast container-stopped detection (frontend):** When the Container DO's "not running" guard returns close code `4503` (`WS_CONTAINER_STOPPED_CODE`), the terminal store stops retrying and marks the connection as disconnected. This is server-authoritative — the container is definitively not running. Non-4503 close codes (1006, 1001, 1011, etc.) trigger automatic reconnection with 1s delay.

**Anti-flapping (KV stopped→running):** When KV batch-status polling detects a `stopped→running` transition for a non-active session, `refreshSessionStatuses()` updates the session status dot but does **not** auto-initialize terminals. This prevents a flapping cycle: stale KV "running" → WS connections → 503 from dead container → disconnected → stale KV "running" restarts cycle. Newly started sessions have a 3-minute startup guard (`session-polling.ts`) during which only `4503` close code can transition them to stopped. The user explicitly clicks the session card to reconnect. Terminal initialization only occurs during: (1) explicit session start by user, (2) `loadSessions()` on initial page load where KV is authoritative.

**Stop (user-initiated):** Worker sets KV status to `'stopped'` -> calls `container.destroy()` -> `destroy()` clears `SESSION_ID_KEY` + `bucketName` from DO storage to prevent deleted session resurrection -> `super.destroy()` -> `onStop()` bails (no identifiers, so no KV write)

**Delete:** Worker `KV.delete()` -> `container.destroy()` -> `destroy()` clears `SESSION_ID_KEY` + `bucketName` -> `super.destroy()` -> `onStop()` bails (no identifiers, so deleted session cannot be resurrected in KV)

```mermaid
flowchart TD
    subgraph Idle["Idle Stop"]
        I1["sleepAfter expires"] --> I2["onActivityExpired()"]
        I2 --> I3["Check /activity"]
        I3 --> I4{"lastInputAt changed<br/>since last poll?"}
        I4 -->|Yes| I4R["renewActivityTimeout()"]
        I4 -->|No| I5["this.stop('SIGTERM')"]
        I5 --> I6["onStop()"]
        I6 --> I7["KV status = 'stopped'"]
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

    U3 -.- Key["destroy() clearing identifiers<br/>BEFORE onStop() prevents<br/>session resurrection"]
    D3 -.- Key
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

---

## Module-Level Caches

All module-level caches in the codebase. Workers isolates do not share memory, so each cache is per-isolate.

| Module | Cache Variable | TTL | What It Caches | Reset Function |
|---|---|---|---|---|
| `src/lib/access.ts` | `cachedAuthDomain`, `cachedAccessAud`, `cachedAccessAudList` | 5 min | CF Access auth domain and audience config | `resetAuthConfigCache()` |
| `src/lib/subscription.ts` | `cachedTierConfig` | 60s | Tier configuration from `tiers:config` KV key | `resetTierConfigCache()` |
| `src/lib/cors-cache.ts` | `cachedKvOrigins` | 5 min | CORS origins from `setup:custom_domain` + `setup:allowed_origins` | `resetCorsOriginsCache()` |
| `src/lib/jwt.ts` | JWKS key cache | 30s freshness threshold | Cloudflare Access JWKS public keys (re-fetched on kid miss after 30s) | `resetJWKSCache()` |
| `src/lib/stripe.ts` | `priceCache` | 1 hour | Stripe price amount/currency per price ID | (none — TTL-only) |
| `src/lib/kv-crypto.ts` | imported CryptoKey | Isolate lifetime | AES-256 key from `ENCRYPTION_KEY` env var | (none — persists for isolate lifetime) |
| `src/lib/rate-limit-core.ts` | `failedKvOps` | Isolate lifetime | Counter for consecutive KV failures (circuit breaker) | (none) |
| `src/lib/circuit-breakers.ts` | per-container breakers | Isolate lifetime | Circuit breaker state per container ID | (none) |
| `src/lib/session-jwt.ts` | `cachedKey` | Isolate lifetime | HMAC CryptoKey imported from `OAUTH_JWT_SECRET` | (none — re-imported if secret changes) |

After admin config changes, different isolates may enforce different values for up to the cache TTL. This is an accepted trade-off for KV read performance.

---

## Design Rationale

Architectural principles and design rationale.

1. **rclone bisync > s3fs FUSE** - FUSE mounts are fragile and slow. Periodic bisync with local disk is faster and more reliable.
2. **Newest file wins** - Simple conflict resolution for single-user scenarios.
3. **Resilient bisync over auto-resync** - `--resilient` + `--recover` handle transient failures without losing deletion tracking. `--resync` is only used for initial baseline establishment (see AD14).
4. **SDK-managed lifecycle with input-change detection** - `sleepAfter` with `collectMetrics` input-change detection keeps containers alive during active use. The DO polls `/activity` every 60s and compares `lastInputAt` to the previous value. Renewal only happens when new user input is detected (the value changed). This is simpler and more reliable than the previous heartbeat-based approach (which required frontend 60s heartbeat intervals, three-tier evaluation logic with heartbeat staleness, and legacy fallback paths). Input-change detection has a single signal: did the user type something new? Container stops ~30 min after the last user input.
5. **`onStop()` must set KV status and clear schedules** - SDK hibernation fires `onStop()` which must write `status: 'stopped'` to KV (otherwise other devices see stale 'running' status) and call `deleteSchedules('collectMetrics')` to kill the alarm loop (otherwise zombie alarms fire on a dead container indefinitely).
6. **`destroy()` must clear identifiers before `super.destroy()`** - `onStop()` fires asynchronously after `super.destroy()`. Without clearing identifiers first, `onStop()` resuscitates deleted sessions in KV via read-modify-write.
7. **Secrets persist with worker state** - `wrangler delete` destroys all secrets.
8. **Single port architecture** - All services on port 8080 eliminates port conflict bugs.
9. **CPU metrics show load average, not utilization** - `os.loadavg()[0] / cpus * 100` measures run queue depth. Values >100% are normal.
10. **Downgrade verbose activity logs to debug** - Per-cycle activity check logs at `info` level generate log volume (every 60s per container). Once input-change detection is confirmed stable, downgrade to `debug`.
11. **Stateless dashboard polling preserves hibernation** - Dashboard status endpoints must be pure KV reads with zero DO contact. Touching DOs resets `sleepAfter` on every poll, preventing containers from ever hibernating.
12. **Polling interval vs push cadence** - The backend pushes metrics to KV every 60s (`collectMetrics`). The frontend polls at 5s for responsive session status updates (start/stop transitions). Metrics on the dashboard may be up to ~60s stale.
13. **rclone version upgrades can break bisync** - The Alpine → Debian migration changed rclone v1.68 → v1.73, introducing stricter MD5 post-transfer verification that aborts on files modified during sync ("corrupted on transfer"). Fix: `--ignore-checksum` on all bisync commands. Pin rclone version in Dockerfile to prevent future surprise breakage. Additionally, `--max-delete 100` is required on all bisync commands — the default 50% threshold aborts syncs when bulk deletions (e.g., deleting a workspace folder) remove more than half the tracked files. **Warning**: `--resync` should never be used as an automatic recovery mechanism — it destroys bisync's deletion tracking (see AD14).
14. **Never auto-`--resync` on bisync failure** - `--resync` makes both sides identical by copying the newer version of every file, then creates a fresh baseline. This permanently loses any pending deletions — if side A deleted a file and bisync fails before propagating, `--resync` resurrects the file from side B. Use `--resilient` + `--recover` for self-healing: `--resilient` allows bisync to continue past non-critical errors, and `--recover` automatically reconstructs corrupted listing files without losing state. Manual `--resync` is still available via `establish_bisync_baseline()` on container startup (one-way restore runs first, so no data loss).
15. **Never `docker system prune` in CI deploy workflows** - `docker system prune -af` in the deploy workflow nukes the Docker layer cache on self-hosted runners, causing every subsequent build to pull all layers from scratch. This triggers Docker Hub 429 rate limit errors when base images need re-downloading. Let Docker manage its own cache; only prune manually if disk space is critical.
16. **Vanishing-file recovery before nuke** - When bisync fails with `lstat: no such file or directory`, the file was listed by rclone then deleted before the copy completed (race condition with agents writing/deleting transient files). The correct response is to parse the error, add the file to a session-scoped exclusion filter (`/tmp/rclone-recovery-filters.txt`), and retry — not escalate to `nuke_corrupted_r2_files`. Non-workspace files are auto-excluded; workspace files (user code) trigger a plain retry on the assumption the file reappeared. Known ephemeral files (`.claude/mcp-*.json`) are statically excluded from all sync operations to prevent the race from occurring. See [Vanishing-file recovery](storage-and-sync.md#vanishing-file-recovery) and [AD43](decisions/README.md#ad43-parse-and-exclude-vanishing-files-before-escalating-to-nuke).

---

## Appendix: CF-NNN Code Index

| Code | Description | Source Location |
|------|-------------|-----------------|
| CF-001 | Turnstile token enforcement; rate-limit bypass prevention | src/routes/auth.ts, src/routes/stripe-webhook.ts, src/index.ts |
| CF-002 | Promise dedup for concurrent cold-start KV reads | src/lib/access.ts |
| CF-003 | Deny requests when KV unavailable (security-critical) | src/middleware/rate-limit.ts, src/lib/rate-limit-core.ts |
| CF-004 | Reset tiers to free on subscription.deleted | src/routes/stripe-webhook.ts, src/routes/usage.ts |
| CF-005 | Default undefined tiers to pending (block access) | src/lib/access.ts, src/lib/subscription.ts |
| CF-006 | Explicit null check; use getEffectiveTier | src/routes/billing.ts, src/routes/terminal.ts |
| CF-007 | Fetch tiers before priceId lookup; staleness window | src/routes/billing.ts, src/lib/subscription.ts, src/timekeeper/index.ts |
| CF-008 | Atomic read-merge-write for user KV records | src/lib/user-record.ts |
| CF-009 | Default both undefined tiers to pending | src/lib/subscription.ts |
| CF-010 | Rate-limit webhook; parseUserRecord validation | src/routes/stripe-webhook.ts, src/lib/access.ts |
| CF-011 | Prefer metadata.email over customer_email; typed user records | src/routes/stripe-webhook.ts, src/lib/user-record.ts |
| CF-012 | Decode URI-encoded sequences before path-traversal check | src/routes/storage/validation.ts |
| CF-013 | Session store extraction (facade pattern) | web-ui/src/stores/session.ts, session-polling.ts, session-usage.ts |
| CF-014 | Module-level cache inventory | See [Module-Level Caches](#module-level-caches) section |
| CF-015 | Catch missed subscription.deleted via billing period expiry | src/lib/subscription.ts |
| CF-016 | ScrambleText consolidation to hook-based pattern | web-ui/src/lib/use-scramble-text.ts, web-ui/src/components/ScrambleText.tsx |
| CF-017 | Warn on plaintext credential storage when ENCRYPTION_KEY absent | src/index.ts, src/lib/kv-crypto.ts, src/lib/access.ts |
| CF-018 | billingPeriodEnd enforcement; unlimited tier exemption | src/lib/subscription.ts |
| CF-020 | Timekeeper delta clamping / alarm retry; admin inquiry email; mobile input dispatch | src/lib/email.ts, web-ui/src/lib/terminal-mobile-input.ts |
| CF-021 | Trial always in usage hours (trialDays fallback removed) | web-ui/src/components/SubscribePage.tsx |
| CF-022 | KV rollback on container start failure; separate try/catch for KV reads | src/lib/cors-cache.ts |
| CF-023 | Check existing subscription before overwriting | src/routes/stripe-webhook.ts |
| CF-024 | Missing webhook handler coverage | src/routes/billing.ts |
| CF-027 | Prices from Stripe via admin-configured stripePriceId | src/lib/subscription.ts |
| CF-029 | Cache invalidation for storage deletes | src/routes/storage/ |
| CF-030 | Idempotency key to prevent duplicate checkout sessions | src/lib/stripe.ts |
| CF-032 | Log warning on unresolved customer (was silently dropped) | src/routes/stripe-webhook.ts |

---

## Related Documentation
- [API Reference](api-reference.md) - All API endpoints
- [Authentication](authentication.md#authentication-modes) - Authentication modes and SaaS billing
- [Security](security.md) - Security model and rate limiting
- [Container](container.md) - Container image and startup
- [Storage & Sync](storage-and-sync.md) - R2 storage and rclone bisync
- [Configuration](configuration.md#worker-environment) - Environment variables
- [Decisions](decisions/README.md) - Architecture Decision Records
