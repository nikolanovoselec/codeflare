# Codeflare Technical Reference

Browser-based cloud IDE on Cloudflare Workers with per-session containers and R2 persistence.

**Workers.dev URL:** `https://<CLOUDFLARE_WORKER_NAME>.<ACCOUNT_SUBDOMAIN>.workers.dev` - used only for initial setup. After the setup wizard configures a custom domain, all traffic should go through the custom domain (protected by CF Access). The workers.dev URL should then be gated behind one-click Access in the Cloudflare dashboard.

---

## 1. Architecture Overview

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

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| One container per SESSION | CPU isolation - each tab gets full 1 vCPU instead of sharing |
| Container ID format | `{bucketName}-{sessionId}` (e.g., `codeflare-user-example-com-abc12345`) |
| Per-user R2 buckets | Bucket name derived from email, auto-created on first login |
| Periodic rclone bisync | Background daemon runs bisync every 60 seconds, plus final sync on shutdown (SIGINT/SIGTERM). Local disk for all file operations. |
| Login shell | `.bashrc` auto-starts the configured agent in workspace |
| KV read-modify-write races | Last-writer-wins is acceptable - session PATCH/stop overlap is rare, rate limit off-by-one is minor, lastAccessedAt is best-effort |
| Pre-setup public endpoints | Setup runs once during initial deploy; short exposure window is acceptable risk. Pre-setup auth trusts spoofable email header - bootstrap problem, mitigated by rate limiting and short exposure window. |
| Container runs as root with no internal auth | Network isolation via DO proxy is sufficient; root needed for rclone mount; wildcard CORS is internal-only |
| RESSOURCE_TIER spelling | French/German "ressource" is intentional - consistent across all config, changing would be a breaking API change |

---

## 2. Components

### 2.1 Worker (Hono Router)

**File:** `src/index.ts`

Entry point and API gateway. Handles routing, WebSocket upgrade interception, authentication via Cloudflare Access, container lifecycle through Durable Objects, and CORS with configurable allowed origins.

**WebSocket must be intercepted BEFORE Hono routing** (required workaround for CF Workers):
```typescript
// See: https://github.com/cloudflare/workerd/issues/2319
const wsMatch = url.pathname.match(/^\/api\/terminal\/([^\/]+)\/ws$/);
if (wsMatch && upgradeHeader?.toLowerCase() === 'websocket') {
  return container.fetch(new Request(terminalUrl.toString(), request));
}
```

**CORS:** Checks static patterns from `env.ALLOWED_ORIGINS` + dynamic origins from KV (cached in memory). Uses `matchesPattern()` with domain-boundary enforcement (dot-prefixed = suffix match, bare domains = exact or subdomain with dot boundary).

**Route Registration:** `/api/user`, `/api/users`, `/api/container`, `/api/sessions`, `/api/terminal`, `/api/setup`, `/api/storage`, `/api/presets`, `/api/preferences`, `/api/admin`, `/public`

**Workers Assets Routing Guardrails (`wrangler.toml`):**

With SPA fallback (`not_found_handling = "single-page-application"`), control-plane paths must execute Worker logic first via `run_worker_first = ["/", "/api/*", "/public/*", "/health"]`. Missing `/api/*` causes setup/auth flows to break (API endpoints return HTML instead of JSON).

### 2.2 Auth Middleware

**File:** `src/middleware/auth.ts` - Shared authentication middleware. Delegates to `authenticateRequest()` which throws `AuthError`/`ForbiddenError` on failure. Sets `c.get('user')` and `c.get('bucketName')` for downstream handlers.

### 2.3 Container Helpers

**File:** `src/lib/container-helpers.ts` - Consolidated container initialization: `getSessionIdFromRequest()` (from query param or header), `getContainerId()` (with validation, never fallbacks), `getContainerContext()` (full context for route handlers).

### 2.4 Error Handling

**File:** `src/lib/error-types.ts` - `AppError` base class with `code`, `statusCode`, `message`, `userMessage`. Specialized: `NotFoundError` (404), `ValidationError` (400), `ContainerError` (500), `AuthError` (401). Utilities: `toError(unknown)`, `toErrorMessage(unknown)`.

### 2.5 Type Guards

**File:** `src/lib/type-guards.ts` - Runtime type validation replacing unsafe type casts (e.g., `isBucketNameResponse()`).

### 2.6 Constants

**File:** `src/lib/constants.ts` - Single source of truth for 25 configuration values: ports (`TERMINAL_SERVER_PORT = 8080`), session ID validation, retry/polling config, CORS defaults, idle timeouts, rate limit keys, container fetch timeouts, max presets/tabs, sync timeouts.

### 2.7 Circuit Breaker

**File:** `src/lib/circuit-breaker.ts` - Prevents cascading failures. States: CLOSED (normal), OPEN (fail fast), HALF_OPEN (testing recovery). Wraps `container.fetch()` calls.

### 2.8 Rate Limiting

**File:** `src/middleware/rate-limit.ts` - Per-user rate limiting (bucketName from auth, IP fallback). Stores counts in KV. Adds `X-RateLimit-*` headers.

### 2.9 Structured Logging

**File:** `src/lib/logger.ts` - JSON logging with `createLogger(module)`, child loggers with request context.

### 2.10 JWT Verification

**File:** `src/lib/jwt.ts` - RS256 verification against CF Access JWKS (`https://{authDomain}/cdn-cgi/access/certs`). Per-isolate JWKS cache with `resetJWKSCache()`.

### 2.11 Cache Reset

**File:** `src/lib/cache-reset.ts` - Centralized invalidation of CORS + auth config + JWKS caches. Called by setup wizard after configuration changes.

### 2.12 DEV_MODE Gating

`/api/container/debug/*` restricted to `DEV_MODE = "true"`. Admin routes use CF Access `authMiddleware` + `requireAdmin` for production access.

### 2.13 Session Route Architecture

**Directory:** `src/routes/session/` - Split into `index.ts` (aggregator), `crud.ts` (CRUD), `lifecycle.ts` (start/stop/status/batch-status).

**Session Stop Flow:** Sets KV status to `'stopped'`, calls `container.destroy()` (sends SIGINT per Dockerfile STOPSIGNAL, then SIGKILL), entrypoint.sh shutdown handler runs final `rclone bisync`. Both `batch-status` and `GET /:id/status` trust the `'stopped'` KV status to avoid waking the DO (exception: stale >5 minutes triggers probe).

### 2.14 Frontend Zod Validation

**File:** `web-ui/src/lib/schemas.ts` - Zod schemas validate API responses at runtime. Types derived from schemas via `z.infer`.

### 2.15 Frontend Constants

**File:** `web-ui/src/lib/constants.ts` - 16 constants for polling intervals, timeouts, retry limits, WebSocket close codes, max terminals, display lengths.

### 2.16 Terminal Tab Configuration

**File:** `web-ui/src/lib/terminal-config.ts` - Generic "Terminal 1-6" defaults with live process detection via `PROCESS_ICON_MAP` (maps process names like claude, codex, gemini, opencode, htop, yazi, lazygit to MDI icons).

### 2.17 Container DO (CodeflareContainer)

**File:** `src/container/index.ts` - Extends `Container` from `@cloudflare/containers`. `defaultPort = 8080`, `sleepAfter = '24h'`.

**Activity-Based Hibernation:** DO alarm fires every 5 minutes, checks `/activity` endpoint (hasActiveConnections, lastPtyOutputMs, lastWsActivityMs). Hibernates when no connections AND no PTY output for 5 minutes. `destroy()` override MUST call `this.ctx.storage.deleteAlarm()` to prevent zombie containers.

**Environment Variables Injection:** R2 credentials flow via two paths: (1) `_internal/setBucketName` request body (primary, from Worker), (2) `this.env` fallback (DO restart). Fallback chain: Worker-provided > `this.env` > empty string.

**Critical: `envVars` must be set as a property assignment**, not as a getter. Cloudflare Containers reads `this.envVars` as a plain property at `start()` time.

**Internal Endpoints:** `/_internal/setBucketName`, `/_internal/getBucketName`, `/_internal/debugEnvVars`

### 2.18 Terminal Server (node-pty)

**File:** `host/server.js` - Node.js server inside the container. Single port 8080 for WebSocket + REST + health/metrics.

Sync handled entirely by `entrypoint.sh` (60s daemon). Terminal server reads sync status from `/tmp/sync-status.json` and exposes via `/health`. Activity tracking (`lastPtyOutputTimestamp`, `lastWsActivityTimestamp`) for hibernation decisions via `GET /activity`.

**WebSocket Protocol:** Raw terminal data (NOT JSON-wrapped). Control messages (resize, ping) as JSON. Headless terminal (xterm SerializeAddon) captures full state for reconnection.

**PTY:** Spawns `bash -l` (login shell for .bashrc) with `xterm-256color`, truecolor support.

### 2.19 Frontend (SolidJS + xterm.js)

**Directory:** `web-ui/`

Key files: `App.tsx` (root), `Terminal.tsx` (xterm.js), `TerminalTabs.tsx`, `Layout.tsx` (orchestrates sidebar/terminal/storage/settings with mutual exclusion), `SessionCard.tsx` (handles `'stopping'` with "Syncing" label), `StorageBrowser.tsx` (R2 browser with toolbar), `StoragePanel.tsx` (slide-in drawer), `SettingsPanel.tsx`, `Dashboard.tsx`, `OnboardingLanding.tsx`, `KittScanner.tsx`.

Stores: `terminal.ts` (WebSocket state, compound key `sessionId:terminalId`), `session.ts` (CRUD, `terminalsPerSession`, `stopSession()` sets `'stopping'` and polls), `storage.ts` (R2 operations), `setup.ts`.

**Auto-Reconnect:** 5 attempts with 2-second delay. Reconnection triggers session buffer replay.

**Character Doubling Fix:** The `inputDisposable` must be stored outside `connect()` and disposed before creating a new handler on reconnect:
```typescript
let inputDisposable: IDisposable | null = null;
function connect() {
  inputDisposable?.dispose();
  inputDisposable = terminal.onData((data) => ws.send(data));
}
```

---

## 3. UI Features

### 3.1 Nested Terminals (Multiple PTYs per Session)

Up to 6 terminal tabs per session. Compound key strategy: frontend `sessionId:terminalId`, WebSocket URL `/api/terminal/{sessionId}-{terminalId}/ws`. Backend parses compound ID, validates base session, forwards full ID to container. Container's SessionManager handles each compound ID as a separate PTY.

### 3.2 StoragePanel (R2 File Browser)

**Files:** `StoragePanel.tsx`, `StorageBrowser.tsx`, `stores/storage.ts`

Desktop: 400px slide-in drawer. Mobile: bottom-sheet. Mutual exclusion with SettingsPanel. Reads directly from R2 via Worker API (no container-side sync trigger). Container sync handled by 60s bisync daemon.

### 3.3 Conditional Logout

Depends on `onboardingActive` flag: active -> redirect to `/` (landing page), inactive -> redirect to `/cdn-cgi/access/logout`.

---

## 4. Data Flow

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
| mounting | 90% | Terminal server up, PTY pre-warming in progress |
| ready | 100% | All checks passed |
| error | 0% | Sync failed or other error |

---

## 5. Storage and Sync

### Why rclone bisync (Not s3fs)

s3fs FUSE: every file op = network call (~340ms PUT, ~50ms HEAD), fragile on network hiccups, "Socket not connected" errors.

rclone bisync: all file ops on local disk (<1ms), background daemon every 60s, final bisync on shutdown (SIGINT/SIGTERM), stable.

### Initial Sync on Startup

1. One-way `rclone sync` from R2 to local (restore data)
2. `rclone bisync --resync` to establish baseline, then start 60-second daemon

### What's Synced vs Excluded

| Path | Synced | Reason |
|------|--------|--------|
| `~/.claude/` | Yes | Claude credentials, config, projects |
| `~/.config/` | Yes | App configs (gh CLI, etc.) |
| `~/.gitconfig` | Yes | Git configuration |
| `~/workspace/` | Depends on `SYNC_MODE` | Excluded by default (`none`). Synced when `full` or partially with `metadata`. |
| `~/.npm/`, `.config/rclone/**`, `.cache/rclone/**`, `.claude/debug/**`, `.claude/plugins/cache/**` | **NO** | Cache/debug, regenerated |

### rclone Sync Modes

| Mode | Workspace Sync | Use Case |
|------|---------------|----------|
| `none` | Excluded entirely | Default. Settings and config only. |
| `full` | Entire `workspace/` (minus `node_modules/`) | Persistent storage across stop/resume |
| `metadata` | Only `CLAUDE.md` and `.claude/` per repo | Lightweight project context sync |

All modes always exclude: `.bashrc`, `.bash_profile`, `.config/rclone/`, `.cache/rclone/`, `.npm/`, `.claude/debug/`, `.claude/plugins/cache/`, `**/node_modules/`. All rclone commands use `--filter` flags (NOT `--include`/`--exclude`).

### Conflict Resolution

Newest file wins (`--conflict-resolve newer`). Auto `--resync` on bisync failure. Shutdown handler runs final bisync.

---

## 6. Authentication

### Cloudflare Access Integration

**Browser/JWT:** `cf-access-authenticated-user-email` + `cf-access-jwt-assertion` headers.

**Service Token:** `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers. Mapped to email via `SERVICE_TOKEN_EMAIL`.

**Email Normalization:** Trimmed + lowercased before KV lookup, role resolution, and bucket name derivation.

### Access Application Destination Strategy

One Access application with five destinations: `/app`, `/app/*`, `/api/*`, `/setup`, `/setup/*`. Including exact + wildcard variants removes ambiguity. Uses all 5 allowed entries.

### Access Group Model

Per-worker groups: `<worker-name>-admins`, `<worker-name>-users`. Setup upserts both, stores IDs in KV. `/api/users` syncs group membership via `syncAccessPolicy()`. `GET /api/setup/prefill` reads existing membership for redeploy prefill.

### Root Redirect

- Setup incomplete -> redirect to `/setup`
- Setup complete, default mode -> `/` redirects to `/app/`
- Setup complete, onboarding mode -> authenticated users to `/app/`, unauthenticated to public landing

### Auth Flow

```mermaid
flowchart LR
    A[Request] --> B[Edge routing]
    B --> C[CORS]
    C --> D[Auth Middleware]
    D --> E["getUserFromRequest()
    JWT / service token / DEV_MODE"]
    E --> F[Normalize email]
    F --> G[Check KV allowlist]
    G --> H["getBucketName()"]
    H --> I["Set c.get('user'), c.get('bucketName')"]
    I --> J[Route Handler]
```

### Per-User Bucket Naming

`user@example.com` -> `codeflare-user-example-com` (sanitized, max 63 chars).

### Bucket Auto-Creation

**File:** `src/lib/r2-admin.ts` - `createBucketIfNotExists()` via Cloudflare API on first container start.

---

## 7. API Reference

### Common Response Headers

| Header | Description |
|--------|-------------|
| `X-Request-ID` | Unique request identifier (UUID) |
| `X-RateLimit-Limit` | Max requests per window (rate-limited endpoints) |
| `X-RateLimit-Remaining` | Requests remaining (rate-limited endpoints) |

### Error Response Format

```json
{ "error": "User-friendly message", "code": "ERROR_CODE" }
```

Codes: `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `CONTAINER_ERROR` (500), `AUTH_ERROR` (401).

### Session Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create session (rate limited) |
| GET | `/api/sessions/:id` | Get session |
| PATCH | `/api/sessions/:id` | Update session |
| DELETE | `/api/sessions/:id` | Delete session and destroy container |
| POST | `/api/sessions/:id/touch` | Update lastAccessedAt |
| POST | `/api/sessions/:id/stop` | Stop session (KV 'stopped' + container.destroy()) |
| GET | `/api/sessions/:id/status` | Get session and container status |
| GET | `/api/sessions/batch-status` | Batch status for all sessions (status, ptyActive, startupStage) |

### Container Lifecycle

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/container/start` | Start container (non-blocking) |
| POST | `/api/container/destroy` | Destroy container (SIGKILL) |
| GET | `/api/container/startup-status` | Poll startup progress |
| GET | `/api/container/health` | Health check |
| GET | `/api/container/state` | Container state (DEV_MODE) |
| GET | `/api/container/debug` | Debug info (DEV_MODE) |
| GET | `/api/container/sync-log` | Sync log (DEV_MODE) |

### Terminal

| Method | Endpoint | Description |
|--------|----------|-------------|
| WS | `/api/terminal/:sessionId-:terminalId/ws` | Terminal WebSocket |
| GET | `/api/terminal/:sessionId/status` | Connection status |

### User Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/user` | Authenticated user info (includes `onboardingActive`) |
| GET | `/api/users` | List allowed users |
| POST | `/api/users` | Add allowed user |
| DELETE | `/api/users/:email` | Remove allowed user |

### Setup

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/setup/status` | Check setup status |
| GET | `/api/setup/detect-token` | Auto-detect token from env |
| GET | `/api/setup/prefill` | Prefill emails from existing Access groups |
| POST | `/api/setup/configure` | Run configuration (customDomain, users, origins) |

Public before setup; admin-only after. All `adminUsers` must also be in `allowedUsers`.

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/destroy-by-id` | Kill zombie container by raw DO ID (admin auth required) |

Body: `{ "doId": "<64-char-hex-do-id>" }`. **CRITICAL:** Only `destroy-by-id` uses `idFromString()` which safely references EXISTING DOs. All `idFromName()` approaches CREATE new DOs if they don't exist.

### Storage (R2 File Browser)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/storage/browse` | List objects in R2 prefix |
| POST | `/api/storage/upload` | Upload file |
| GET | `/api/storage/download` | Download file |
| POST | `/api/storage/delete` | Delete object |
| POST | `/api/storage/move` | Move/rename object |
| GET | `/api/storage/preview` | Preview file content |
| GET | `/api/storage/stats` | File/folder counts |
| POST | `/api/storage/seed/getting-started` | Seed tutorial docs |
| POST | `/api/storage/upload/initiate` | Initiate multipart upload |
| POST | `/api/storage/upload/part` | Upload a single part (base64 body) |
| POST | `/api/storage/upload/complete` | Complete multipart upload |
| POST | `/api/storage/upload/abort` | Abort multipart upload |

### Presets

GET `/api/presets`, POST `/api/presets`, DELETE `/api/presets/:id`

### Preferences

GET `/api/preferences`, PATCH `/api/preferences`

### Public (Onboarding)

GET `/public/onboarding-config`, POST `/public/waitlist` (rate limited)

### Health

GET `/health`, GET `/api/health`

---

## 8. Environment Variables

### Worker Environment

| Variable | Purpose | Source |
|----------|---------|--------|
| `DEV_MODE` | Bypasses CF Access auth | wrangler.toml |
| `SERVICE_TOKEN_EMAIL` | Email for service token auth | Optional |
| `CLOUDFLARE_API_TOKEN` | R2 bucket creation | Wrangler secret |
| `R2_ACCESS_KEY_ID` | R2 auth for containers | Wrangler secret |
| `R2_SECRET_ACCESS_KEY` | R2 auth for containers | Wrangler secret |
| `R2_ACCOUNT_ID` | R2 endpoint construction | Dynamic (env with KV fallback) |
| `R2_ENDPOINT` | S3-compatible endpoint | Dynamic (env with KV fallback) |
| `ALLOWED_ORIGINS` | CORS patterns (comma-separated) | wrangler.toml |
| `LOG_LEVEL` | Min log level (default: "info") | wrangler.toml |
| `ONBOARDING_LANDING_PAGE` | `"active"` enables public waitlist landing | wrangler.toml |
| `TURNSTILE_SECRET_KEY` | Optional direct Turnstile secret override | Optional |
| `RESEND_API_KEY` | Waitlist notification emails | Optional |
| `WAITLIST_FROM_EMAIL` | Sender identity for waitlist | Optional |
| `CLOUDFLARE_WORKER_NAME` | Worker name override for forks | GitHub Actions variable |

### Container Environment

| Variable | Purpose | Source |
|----------|---------|--------|
| `R2_BUCKET_NAME` | User's personal bucket | Worker → DO via `setBucketName` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | rclone auth | Worker → DO (preferred) or DO `this.env` fallback |
| `R2_ACCOUNT_ID` / `R2_ENDPOINT` | rclone endpoint | Worker → DO or `getR2Config()` fallback |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 compatibility | Mirrors R2 keys |
| `TERMINAL_PORT` | Always 8080 | Hardcoded |
| `SYNC_MODE` | Sync strategy (`bisync` or `copy`) | Worker → DO |
| `TAB_CONFIG` | JSON array of terminal tab configurations | Worker → DO |
| `TERMINAL_ID` | Unique ID for this terminal instance | Worker → DO |
| `CONTAINER_AUTH_TOKEN` | Auth token for container API calls | Worker → DO |

---

## 9. File Structure

```
codeflare/
├── src/
│   ├── index.ts              # Hono router, WebSocket intercept, CORS
│   ├── types.ts              # TypeScript types
│   ├── routes/
│   │   ├── container/        # Container lifecycle API
│   │   │   ├── index.ts      # Route aggregator
│   │   │   ├── lifecycle.ts  # Start/destroy
│   │   │   ├── status.ts     # Health, startup-status
│   │   │   ├── debug.ts      # Debug endpoints (DEV_MODE)
│   │   │   └── shared.ts     # Shared helpers
│   │   ├── session/          # Session API
│   │   │   ├── index.ts      # Route aggregator
│   │   │   ├── crud.ts       # CRUD operations
│   │   │   └── lifecycle.ts  # Start/stop/status/batch-status
│   │   ├── setup/            # Setup wizard
│   │   │   ├── index.ts      # Route aggregator
│   │   │   ├── handlers.ts   # Main configure handler
│   │   │   ├── secrets.ts    # Secret management
│   │   │   ├── custom-domain.ts # Domain configuration
│   │   │   ├── access.ts     # CF Access setup
│   │   │   ├── account.ts    # Account discovery
│   │   │   ├── credentials.ts # R2 credential setup
│   │   │   ├── turnstile.ts  # Turnstile widget setup
│   │   │   └── shared.ts     # Shared helpers
│   │   ├── storage/          # R2 file browser API
│   │   │   ├── index.ts      # Route aggregator
│   │   │   ├── browse.ts     # List objects
│   │   │   ├── delete.ts     # Delete objects
│   │   │   ├── download.ts   # Download files
│   │   │   ├── move.ts       # Move/rename
│   │   │   ├── preview.ts    # Preview content
│   │   │   ├── seed.ts       # Seed tutorial docs
│   │   │   ├── stats.ts      # File/folder counts
│   │   │   ├── upload.ts     # Upload (single + multipart)
│   │   │   └── validation.ts # Path validation
│   │   ├── public/
│   │   │   └── index.ts      # Onboarding endpoints
│   │   ├── admin.ts          # Admin endpoints (destroy-by-id)
│   │   ├── presets.ts        # Preset CRUD
│   │   ├── preferences.ts    # User preferences
│   │   ├── terminal.ts       # Terminal WebSocket proxy
│   │   ├── user-profile.ts   # User info
│   │   └── users.ts          # User management
│   ├── middleware/            # auth.ts, rate-limit.ts
│   ├── lib/                  # access, r2-admin, r2-config, kv-keys, constants, container-helpers,
│   │                         # error-types, type-guards, circuit-breaker, cors-cache, cache-reset,
│   │                         # jwt, cf-api, logger
│   ├── container/index.ts    # Container DO class
│   └── __tests__/            # Backend unit tests (19 files)
├── e2e/                      # E2E tests (API + Puppeteer UI)
├── host/
│   ├── server.js             # Terminal server (node-pty + WebSocket)
│   └── package.json
├── web-ui/
│   └── src/
│       ├── components/       # SolidJS components (Terminal, Layout, SessionCard, StorageBrowser, etc.)
│       ├── stores/           # terminal.ts, session.ts, storage.ts, setup.ts
│       ├── api/client.ts     # API client
│       ├── lib/              # constants, schemas, terminal-config, settings, format, mobile
│       ├── styles/           # CSS (design tokens, animations, component styles)
│       └── __tests__/        # Frontend unit tests (54 files)
├── Dockerfile                # Multi-stage container image
├── entrypoint.sh             # Container startup script
├── wrangler.toml             # Cloudflare configuration
└── vitest.config.ts          # Test configs
```

### Critical Paths Inside Container

| Path | Purpose |
|------|---------|
| `/home/user` | User home directory |
| `/home/user/workspace` | Working directory (synced to R2) |
| `/home/user/.claude/` | Claude config and credentials |
| `/home/user/.config/rclone/rclone.conf` | rclone configuration |
| `/tmp/sync-status.json` | Sync status (read by health server) |
| `/tmp/sync.log` | Sync log for debugging |

---

## 10. Container Startup

**File:** `entrypoint.sh`

Uses polling with safety timeouts: poll until success OR background process exits OR safety timeout expires. Exit immediately on success. Safety timeout `SYNC_TIMEOUT=120` (2 min) prevents infinite blocking.

### Parallel Startup

```mermaid
flowchart TD
    A[Container Start] --> B["initial_sync_from_r2() &"]
    A --> C[Wait for R2 sync]
    B -.->|Background| C
    C -->|Data restored| D["configure_tab_autostart()"]
    D --> E["Start terminal server (:8080)"]
```

Auto-start uses `cu --silent --no-consent` for fast boot. Updates are enabled - pre-patched at build time, so the update check is fast (~2s). Users can also update manually via `cu` in any tab.

---

## 11. Container Image

**File:** `Dockerfile` - Base: `node:22.13-alpine3.21`, multi-stage build (builder compiles native addons, runtime has no build tools).

### Installed Tools

| Category | Packages |
|----------|----------|
| Sync | rclone |
| Version Control | git, github-cli (gh), lazygit |
| Editors | vim, neovim, nano |
| Network | curl, openssh-client |
| Utilities | jq, ripgrep, fd, tree, htop, tmux, yazi, fzf, zoxide, bat |

### Global NPM Packages

`claude-unleashed` (wraps `@anthropic-ai/claude-code`), `@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`, `opencode-ai`

### V8 Compile Cache Warm-Up

Node.js CLIs (claude, codex, gemini) are warmed at Docker build time by running `--version`, which triggers V8 to compile and cache bytecode via `NODE_COMPILE_CACHE`. This pre-populates the compile cache so that first-launch inside containers skips the JavaScript compilation overhead, resulting in faster startup times. Go binaries (like `opencode`) are already natively compiled and do not need this optimization.

### OpenCode Database Pre-Initialization

OpenCode uses SQLite with Goose migrations (`internal/db/migrations/`) that run on every startup via `db.Connect()`. On first launch, this creates `.opencode/opencode.db` in the working directory and applies schema migrations (sessions, files, messages tables). To avoid this overhead at container start, the Dockerfile runs `opencode run --prompt "hello"` with a dummy API key at build time — the database connection and migrations execute before any LLM call, so the DB is pre-initialized in `/root/workspace/.opencode/`.

Port: 8080 (single port architecture).

---

## 12. Claude-Unleashed Integration

[claude-unleashed](https://github.com/nikolanovoselec/claude-unleashed) enables `--dangerously-skip-permissions` when running as root inside containers (standard CLI prevents this via `process.getuid() === 0` check).

**Two separate updaters:** (1) claude-unleashed's updater checks npm for latest `@anthropic-ai/claude-code` - runs on every `cu` invocation (including auto-start), pre-patched at build time so the check is fast. (2) Upstream CLI's internal auto-updater - disabled via `DISABLE_INSTALLATION_CHECKS=1`.

`claude` = vanilla CLI, `cu` = claude-unleashed.

### Environment Variables

**Global (Dockerfile ENV):** `CLAUDE_UNLEASHED_SKIP_CONSENT=1`, `IS_SANDBOX=1`, `DISABLE_INSTALLATION_CHECKS=1`

**Auto-start flags (.bashrc):** `--silent`, `--no-consent`

---

## 13. Testing

**Backend:** `vitest.config.ts` with `@cloudflare/vitest-pool-workers` (real Workers runtime). ~317 tests across 19 files. Run: `npm test`

**Frontend:** `web-ui/vitest.config.ts` with jsdom + SolidJS Testing Library. ~1161 tests across 54 files. Run: `cd web-ui && npm test`

**E2E API:** `e2e/` - tests against deployed worker. Run: `ACCOUNT_SUBDOMAIN=your-subdomain npm run test:e2e`

**E2E UI:** `e2e/ui/` - 132 Puppeteer tests. Run: `ACCOUNT_SUBDOMAIN=your-subdomain npm run test:e2e:ui`

**E2E Requirements:** `DEV_MODE = "true"` deployed, no CF Access on workers.dev domain. Re-deploy with `DEV_MODE = "false"` after testing. Cleanup via `afterAll` hooks; if tests fail, manually restore: `npx wrangler kv key put "setup:complete" "true" --namespace-id <id> --remote`

---

## 14. Development

```bash
npm install && cd web-ui && npm install && cd ..
npm run dev          # Run locally (requires Docker)
npm run typecheck    # Type check backend
npm test             # Backend unit tests
npm run test:e2e     # E2E API tests
npm run test:e2e:ui  # E2E UI tests (Puppeteer)
npm run deploy       # Deploy to Cloudflare
cd web-ui && npm run dev   # Frontend dev server
cd web-ui && npm run build # Frontend production build
```

---

## 15. CI/CD (GitHub Actions)

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `deploy.yml` | Push to main + manual | Full deploy: tests + typecheck + Docker build + wrangler deploy + secrets |
| `test.yml` | Pull requests + manual | Frontend/backend tests, typecheck, build verification, and security audit |
| `e2e.yml` | Manual | E2E tests against deployed worker |

### GitHub Secrets and Variables

**Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RESEND_API_KEY` (onboarding only)

**Variables:** `CLOUDFLARE_WORKER_NAME`, `RUNNER`, `ACCOUNT_SUBDOMAIN` (E2E), `ONBOARDING_LANDING_PAGE`, `RESSOURCE_TIER` (`low`/`high`/unset), `CLAUDE_UNLEASHED_CACHE_BUSTER`

### Deploy Workflow

1. Resolve/create KV namespace, patch `wrangler.toml`
2. Apply container tier from `RESSOURCE_TIER` (low=basic 0.25vCPU, default=1vCPU/3GiB, high=2vCPU/6GiB)
3. Optionally generate `.cache-bust`
4. Deploy with `--var ONBOARDING_LANDING_PAGE:<value>`
5. Set `CLOUDFLARE_API_TOKEN` + optional `RESEND_API_KEY` as worker secrets

---

## 16. API Token Permissions

### Account Permissions

| Permission | Access | Required | Why |
|-----------|--------|----------|-----|
| Account Settings | Read | Yes | Account ID discovery |
| Workers Scripts | Edit | Yes | Deploy worker + secrets |
| Workers KV Storage | Edit | Yes | KV namespace management |
| Workers R2 Storage | Edit | Yes | Per-user R2 buckets |
| Containers | Edit | Yes | Container lifecycle |
| Access: Apps and Policies | Edit | Yes | Managed Access app |
| Access: Organizations, Identity Providers, and Groups | Edit | Yes | Access groups + auth_domain |
| Turnstile | Edit | Only if onboarding active | Turnstile widget |

### Zone Permissions

| Permission | Access | Required | Why |
|-----------|--------|----------|-----|
| Zone | Read | Yes | Zone ID resolution |
| DNS | Edit | Yes | Proxied CNAME |
| Workers Routes | Edit | Yes | Worker route upsert |

---

## 17. Configuration

### Secrets

Repository: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, optional `RESEND_API_KEY`

Worker secrets lifecycle: deploy sets `CLOUDFLARE_API_TOKEN`, setup writes `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, Turnstile keys stored in KV.

### CORS

Dynamic: setup wizard adds custom domain + `.workers.dev` to KV. `ALLOWED_ORIGINS` env var is static fallback.

`R2_ACCOUNT_ID` and `R2_ENDPOINT` resolved dynamically (env vars with KV fallback).

---

## 18. Container Specs

| Tier | Config | Notes |
|------|--------|-------|
| `low` | `basic` (0.25 vCPU, 1 GiB, 4 GB) | Sub-1-vCPU workloads |
| default | 1 vCPU, 3 GiB, 4 GB | Baseline for node-pty + agent CLIs |
| `high` | 2 vCPU, 6 GiB, 8 GB | Higher parallelism |

Base image: Node.js 22 Alpine.

---

## 19. Troubleshooting

### `/api/*` Returns HTML (SPA Swallow)

API endpoints return HTML instead of JSON. Fix: ensure `run_worker_first = ["/", "/api/*", "/public/*", "/health"]` in `[assets]`.

### `/setup` Shows "Access Denied"

Check `GET /api/setup/status` returns JSON. Verify `setup:complete` in KV is absent/false for first-time setup.

### Auth Error After Successful Access Login

Stale `setup:auth_domain` (JWT mismatch), stale `setup:access_aud`, or email casing mismatch. Re-run setup configure. Confirm user keys are lowercase.

### "Unable to find your Access application!"

Browser retained stale Access session. Test in incognito. Clear CF Access cookies. Confirm one managed app with correct destinations.

### Bisync Empty Listing Error

On-demand sync uses `--resync` by default, handles this case.

### envVars Getter Not Working

Container starts without R2 credentials. Fix: set `envVars` as property assignment in constructor, not as a getter.

### R2 Sync Skipped - DO Missing Secrets

Worker now passes R2 credentials via `_internal/setBucketName` body. Check `startup-status` response `details.syncError` for the missing variable.

### Container Stuck at "Waiting for Services"

Terminal server not starting (sync blocking). Check: `GET /api/container/sync-log?sessionId=xxx`. Common: missing R2 credentials, bucket doesn't exist, network timeout.

### R2 Sync Transfers 0 Files

Mixing `--include`/`--exclude` makes filter order indeterminate. Fix: use `--filter` flags (`- pattern` for exclude, `+ pattern` for include).

### Slow Sync With Full Workspace

Switch to `SYNC_MODE=metadata` or manually clean large repos from R2.

### Zombie Container (DO Alarm Loop)

`destroy()` must clear DO alarm: `await this.ctx.storage.deleteAlarm()` before `super.destroy()`. Recovery: `POST /api/admin/destroy-by-id` with DO ID from dashboard.

### Character Doubling in Terminal

Multiple `terminal.onData()` handlers from reconnection. Store disposable outside `connect()`, dispose before creating new handler.

### Secrets Lost After Worker Deletion

`wrangler delete` nukes all secrets. Re-set with `wrangler secret put`.

### Orphan Container Root Cause

`getContainerId()` must NEVER fallback to just `bucketName`. Always throw on invalid sessionId. Container ID format is ALWAYS `${bucketName}-${sessionId}`.

### R2 Bucket Cleanup on User Deletion

Non-empty buckets fail to delete silently. Manual R2 cleanup may be needed.

### Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Container won't start | Missing R2 credentials | `wrangler secret list` then `wrangler secret put` |
| `403 Forbidden` on R2 | Expired credentials | Regenerate in CF dashboard |
| Container stuck "starting" | Port 8080 not responding | Check sync log |
| WebSocket fails | Container not running | Verify startup-status |
| Zombie restarts | DO alarm not cleared | Use admin destroy-by-id |
| Character doubling | inputDisposable not disposed | Check Terminal.tsx |

---

## 20. Debugging Guide

### Container Status

```bash
curl -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \
  https://codeflare.example.com/api/container/state?sessionId=abc12345
```

### Verify Secrets

```bash
wrangler secret list
# Expected: CLOUDFLARE_API_TOKEN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
```

### Monitor Logs

```bash
wrangler tail --service codeflare
wrangler tail --service codeflare --level error
```

### Debug Environment Variables (DEV_MODE)

```bash
curl .../api/container/debug?sessionId=abc12345  # Returns masked env vars
```

---

## 21. Cost

### Per-Container Pricing

| Tier | Specs | Monthly Cost (active) |
|------|-------|-----------------------|
| `low` | 0.25 vCPU, 1 GiB, 4 GB | Lower; check CF pricing |
| `default` | 1 vCPU, 3 GiB, 4 GB | ~$56 (reference) |
| `high` | 2 vCPU, 6 GiB, 8 GB | Higher; check CF pricing |

Cost scales per ACTIVE SESSION (each tab = container). Idle containers hibernate (no connections + no PTY output for 5 min). Hibernated containers = zero cost.

**R2:** First 10GB free, $0.015/GB/month after. User config typically <100MB.

---

## 22. Lessons Learned

1. **rclone bisync > s3fs FUSE** - FUSE mounts are fragile and slow. Periodic bisync with local disk is faster and more reliable.
2. **Newest file wins** - Simple conflict resolution for single-user scenarios.
3. **Auto-resync on failure** - Automatic `--resync` recovery handles most bisync failures.
4. **envVars in constructor** - Container class reads envVars as property, not getter.
5. **WebSocket sends RAW bytes** - xterm.js expects raw terminal data, not JSON.
6. **Login shell for .bashrc** - PTY must spawn `bash -l` for auto-start.
7. **Two-step sync prevents data loss** - Empty local + bisync resync = deleted R2 data. Always restore first.
8. **DO alarm cleanup in destroy()** - Alarms persist across hibernation. Clear before `super.destroy()`.
9. **Activity-based hibernation** - Poll actual usage (connections + PTY output), don't rely on `sleepAfter` alone.
10. **Don't getState() after destroy()** - Wakes the DO, undoing hibernation.
11. **inputDisposable scope matters** - Dispose on reconnect to prevent character doubling.
12. **No fallback container IDs** - `getContainerId()` must NEVER fallback to just `bucketName`. Root cause of zombies.
13. **Secrets persist with worker state** - `wrangler delete` destroys all secrets.
14. **Polling with safety timeouts** - Don't use fixed timeouts. Poll with `kill -0 $PID`, exit on success, safety timeout prevents hangs.
15. **Zombie prevention with _destroyed flag** - Set flag in DO storage before `super.destroy()`. In `alarm()`, check flag first via `ctx.storage.get()`, clear storage and exit if destroyed.
16. **Single port architecture** - All services on port 8080 eliminates port conflict bugs.
17. **idFromName() CREATES DOs, idFromString() references existing** - Admin endpoints using `idFromName()` were creating zombies. Only `idFromString(hexId)` safely references existing DOs.
18. **CPU metrics show load average, not utilization** - `os.loadavg()[0] / cpus * 100` measures run queue depth. Values >100% are normal.
19. **Use `--filter` not `--include`/`--exclude`** - Mixed include/exclude has indeterminate order in rclone.

---

## 23. Mobile Terminal Bug Fixes

### Bug 1: "Orange Square" Cursor Duplication

**Root cause:** xterm.js renders its own DOM cursor (`<span class="xterm-cursor-block">` with `outline: 1px solid #d97706`) AND the server-side CLI renders its cursor via ANSI escape sequences. Two cursors at different positions because xterm tracks cursor state independently from the server-side CLI.

**The fix (attempt 11):** Set `cursor: 'transparent'` in xterm theme + CSS `display: none !important` on all `.xterm-cursor-*` classes. The CLI's ANSI cursor is the only one needed.

**Key lesson:** 10+ attempts tried to hide what was assumed to be an Android native IME caret. A simple "Inspect Element" revealed it was xterm's own DOM element using the theme's orange color (`#d97706`). The orange color matched what one might expect from a native browser caret, leading to elaborate attempts to fight an OS-level compositor issue that didn't exist.

**Note:** The iframe compositor jail code (attempts 10-10h) remains in the codebase as a precaution for the genuine Android IME native caret problem, which is a separate issue from xterm's DOM cursor. Future work should verify via Chrome remote debugging on Android.

### Bug 2: Samsung Internet Keyboard Gap

**Root cause:** Samsung Internet's bottom navigation bar (~48px) inflates viewport height. VirtualKeyboard API reports keyboard height including this invisible area.

**The fix:** VirtualKeyboard API with `overlaysContent = true` for exact keyboard dimensions (`navigator.virtualKeyboard`, Chrome 94+, Samsung Internet 17+). Fallback: `clientHeight - visualViewport.height` for iOS. `boundingRect.height` returns 0 when `overlaysContent = false` - must enable before reading.

**Samsung-specific compensation** via user-facing settings toggle (`samsungAddressBarTop` in Settings). Samsung exposes NO API to detect address bar position - tested `clientHeight`, `fixedVpHeight`, sentinel elements, `env(keyboard-inset-bottom)`, `vk.boundingRect.top` - all return identical values regardless. When address bar is at top, no subtraction needed. When at bottom, subtract viewport growth. Wide-screen devices (>600px) bypass compensation entirely. All Samsung code gated behind `isSamsungBrowser` UA detection.

### Architecture Notes (Mobile)

**Iframe Compositor Jail:** Creates `<iframe>` with `srcdoc` containing `input[type=password]` for a separate compositor context. Android's IME caret is drawn inside iframe's 1x1px bounds (invisible). Keyboard input forwarded via `keydown` (functional keys -> ANSI) + `input` event (characters). `sentViaKeydown` flag prevents double-send.

**_syncTextArea Freeze:** `Object.defineProperty` getter returning `() => {}`, immune to xterm's internal reassignment.

**createElement Monkey-Patch:** Scoped to `terminal.open()` only. Returns `input[type=password]` instead of textarea. `.focus()` overridden to no-op at creation time.

**isFocused Getter Override:** `Object.defineProperty` returning `iframe.contentDocument?.hasFocus()`. Live reference avoids stale state across app backgrounding/tab switching.

**VK API Toggle:** `overlaysContent` is global per document. Enable BEFORE focus to beat the keyboard/layout race.
