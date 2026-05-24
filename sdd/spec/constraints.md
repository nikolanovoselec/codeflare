# Constraints

Architectural and technology decisions that apply across all domains.

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Cloudflare Workers | Edge deployment, global distribution, web-standard runtime |
| Framework | Hono | Lightweight Workers-compatible router with middleware support |
| Frontend | SolidJS | Reactive, small bundle, signal-based state management |
| Terminal | xterm.js | Industry-standard terminal emulator with SerializeAddon for state replay |
| Database | Cloudflare KV | Key-value store, eventually consistent (~60s propagation), global |
| Storage | Cloudflare R2 | S3-compatible object storage, per-user buckets, SSE-C encryption |
| Containers | Cloudflare Containers | Isolated compute per session, SDK-managed lifecycle |
| State | Durable Objects | Per-session (`container`) and per-user (`timekeeper`) stateful coordination |
| Sync | rclone bisync v1.73.2 | Bidirectional file sync between container and R2 every 15 minutes, plus SIGUSR1-driven manual triggers and a final sync on shutdown |
| Billing | Stripe | Payment processing, subscription management, webhook-driven tier changes |
| Email | Resend | Transactional notifications (waitlist, access requests, tier changes) |
| Build | Vite | Frontend bundler, SPA output served as static assets |
| Language | TypeScript (strict) | Full stack -- Worker, frontend, and container host server |
| Validation | Zod | Runtime schema validation for API payloads and responses |
| Container Base | Node.js 24 (bookworm-slim) | Multi-stage Docker build; builder compiles native addons, runtime has no build tools |
| Linter | oxlint | Fast Rust-based linter for CI |
| Testing | Vitest | Unit/integration tests; Puppeteer for E2E; fast-check for fuzzing |
| Container Tools | git, gh, rclone, neovim, ripgrep, fd, fzf, yazi, lazygit, zoxide, tmux, htop, jq, bat | Pre-installed developer toolchain in every container |
| AI Agents | @anthropic-ai/claude-code, @openai/codex, @google/gemini-cli, opencode-ai, @github/copilot | Global npm packages; Claude Code runs as root via `IS_SANDBOX=1` + `--dangerously-skip-permissions` |

## Non-Functional Requirements

### Security

### CON-SEC-001: All non-public endpoints require authentication
All `/app`, `/api`, `/setup` surfaces protected by JWT verification (CF Access RS256 or GitHub OIDC HMAC-SHA256). Container auth uses a random UUID per DO lifecycle, passed as `CONTAINER_AUTH_TOKEN`, validated on all non-exempt paths.
**Applies To:** All endpoints

### CON-SEC-002: API tokens never enter containers
`CLOUDFLARE_API_TOKEN` never enters containers; containers receive per-user scoped R2 tokens only.
**Applies To:** System (container provisioning)

### CON-SEC-003: Credentials encrypted at rest when ENCRYPTION_KEY configured
Optional AES-256-GCM for KV credentials (per-value random IVs, AAD binding to key name); R2 SSE-C for workspace files.
**Applies To:** System (storage layer)

### CON-SEC-004: Rate limiting on all mutation endpoints
KV-backed, per-user (bucketName or IP fallback). WebSocket: 30 connections per 60s window. Security-critical endpoints fail-closed on KV error. 64 KiB body limit on all `/api/*` routes (storage routes exempt for file uploads).
**Applies To:** All endpoints

### CON-SEC-005: Security headers on every response
HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy on every response.
**Applies To:** All responses

#### Additional Security Controls

| Control | Implementation |
|---------|----------------|
| Input validation | Zod schemas on all API payloads; 64 KiB body limit |
| Session ID validation | `/^[a-z0-9]{8,24}$/` enforced before any DO interaction |
| Path traversal prevention | `decodeURIComponent` before `..` check; catches `%2E%2E` and double-encoded variants |
| Supply chain | CodeQL, OSSF Scorecard, `npm audit`, dependency review, Dependabot, Trivy container scanning |
| Deploy gate | `deploy.yml` `workflow_run` trigger requires `event == 'push'` and `head_repository.full_name == github.repository` so a fork PR cannot trigger a deploy by naming its head branch `main` (defeats Scorecard DangerousWorkflowID pwn-request pattern). |
| Penetration testing | Weekly automated external pentest (auth gate, headers, TLS, injection, info disclosure) |
| Secret scanning | GitHub secret scanning with push protection enabled |
| Credential masking | `maskSecret()` shows only last 4 chars in all API responses |

### Performance

### CON-PERF-001: Dashboard polling interval 5 seconds
Frontend polls session list every 5s (`SESSION_LIST_POLL_INTERVAL_MS`). Backend metrics push every 60s via Container DO alarm loop.
**Applies To:** User (dashboard), System (metrics)

### CON-PERF-002: Bisync interval 15 minutes (with manual triggers)
R2 bisync runs every 15 minutes via the daemon, plus one manual trigger (UI Sync-now button) that wakes the daemon via SIGUSR1, plus a final sync on shutdown under the 120 s watchdog. Initial sync timeout 120 s (`SYNC_TIMEOUT`). Baseline establishment timeout 600 s (10 min). See AD56 for the cost-vs-staleness rationale.
**Applies To:** System (sync daemon)

### CON-PERF-003: Tier config cache TTL 60 seconds
Tier configuration cached for 60s in `src/lib/subscription.ts`. Other cache TTLs: CORS 5 min, auth config 5 min, JWKS 30s freshness, Stripe prices 1 hour, Timekeeper user records 60s (100-entry cap).
**Applies To:** System (Worker caches)

#### Additional Performance Metrics

| Metric | Value | Source |
|--------|-------|--------|
| KV eventual consistency delay | ~60s for new sessions | Cloudflare KV propagation |
| WebSocket retry delay | 1s | Terminal WebSocket reconnect store |
| Dashboard WS disconnect grace period | 60s | Web UI shared constants |
| Container fetch timeout | 5s | Worker request constants |
| V8 compile cache | Pre-warmed at image build time for Node.js agent CLIs (Codex, Gemini, Copilot) | Image build step |
| Context expiry threshold | 30 min | Frontend stale-session detection |
| Bucket name settle delay | 100ms | Worker request constants |

### Reliability

### CON-REL-001: Graceful shutdown with final sync before exit
`STOPSIGNAL SIGINT`; entrypoint trap kills sync daemon via PID file, runs final bisync, kills terminal server.
**Applies To:** System (container lifecycle)

### CON-REL-002: Self-healing bisync recovery on corruption
`--resilient` + `--recover` for self-healing; consecutive failure counter (3 failures = resync fallback). Vanishing-file recovery parses rclone error output, dynamically excludes transient files via session-scoped recovery filter, clears bisync locks, and retries before counting a failure. Known ephemeral files (MCP auth cache) are statically excluded to prevent the race condition entirely.
**Applies To:** System (sync daemon)

### CON-REL-003: Circuit breaker on external service calls
Three states (CLOSED/OPEN/HALF_OPEN) wrapping `container.fetch()` calls to prevent cascading failures. `withSetupRetry()` wraps all CF API calls (3 total attempts, exponential backoff 1s/2s).
**Applies To:** System (Worker, setup wizard)

#### Additional Reliability Mechanisms

| Mechanism | Implementation |
|-----------|----------------|
| Zombie DO detection | `collectMetrics` returns early without re-arming when identifiers are missing (post-`destroy()`) |
| WebSocket wake-loop prevention | Three-layer guard: DO fetch gate (503 when not running), terminal route guard (KV status check), frontend disposal on running-to-stopped transition |
| Anti-flapping | 3-minute startup guard; only close code 4503 can transition new sessions to stopped; KV polling does not auto-initialize terminals for non-active sessions |
| Session resurrection prevention | `destroy()` clears identifiers before `super.destroy()` so `onStop()` cannot write to KV for deleted sessions |
| KV optimization (1500-user scale) | List metadata for batch-status (99.97% read reduction), metrics inline on session records, user record cache with 60s TTL |
| Rate limiter fail modes | Security-critical endpoints fail-closed (503 on KV error); general resource endpoints fail-open with in-memory fallback |

### Cost

### CON-COST-001: Idle containers hibernate (zero cost when not running)
Containers stop after configurable `sleepAfter` (5m, 15m, 30m, 1h, 2h) with no terminal input. Default 30m for paying users, 15m for free tier. Timer resets only on actual user input (keypresses, not WebSocket reconnects or background polls). No running containers = no compute bill.
**Applies To:** System (container lifecycle), Admin (cost management)

#### Additional Cost Mechanisms

| Mechanism | Implementation |
|-----------|----------------|
| Timekeeper DO | Per-user usage tracking: accumulates seconds per session, flushes to KV every 5 min, enforces monthly quotas |
| Stateless dashboard | Pure KV reads for status polling; never touches DOs, preserving hibernation |
| KV read optimization | Batch-status via list metadata, module-level caches with TTLs, reduces KV operations from ~910K/sec to ~350/sec at 1500 users |

## Subscription Tiers (Default Configuration)

| Tier | Monthly Hours | Max Sessions | Session Modes | Storage | Trial Hours |
|------|--------------|--------------|---------------|---------|-------------|
| blocked | 0 | 0 | none | 0 | 0 |
| pending | 0 | 0 | none | 0 | 0 |
| free | 4h (14,400s) | 1 | default | 250 MB | 0 |
| trial | 5h (18,000s) | 2 | default | 500 MB | 0 |
| standard (Starter) | 40h (144,000s) | 1 | default, advanced | 500 MB | 40 |
| advanced | 80h (288,000s) | 2 | default, advanced | 1 GB | 80 |
| max | 160h (576,000s) | 3 | default, advanced | 2 GB | 160 |
| unlimited (Custom) | unlimited | 5 | default, advanced | unlimited | 0 |

Tier configuration is admin-editable via the Subscription Management panel. Stored in KV as `tiers:config` with 60s cache. `getDefaultTiers()` provides hardcoded fallback. New fields backfill from defaults via merge on read.

## Container Tiers

| Tier | vCPU | Memory | Disk | Default Max Instances |
|------|------|--------|------|-----------------------|
| low | 0.25 | 1 GiB | 4 GB | 10 |
| default | 1 | 3 GiB | 6 GB | 10 |
| high | 2 | 6 GiB | 8 GB | 10 |

Container tier (`RESSOURCE_TIER`) is independent of subscription tier and `MAX_INSTANCES`. All three can be combined freely.

Cloudflare Containers enforces disk (GB) <= 2 x memory (GiB). The default tier's 6 GB ceiling is set by its 3 GiB memory; raising default disk above 6 GB requires raising default memory to >=4 GiB first.

## Boundaries

- **No Node.js APIs in Worker** -- Workers use a web-standard runtime. `fetch()` not `http`; `crypto.subtle` not `require('crypto')`; `Request`/`Response` not Express objects. The `nodejs_compat` flag enables specific modules only.
- **No server-side rendering** -- SolidJS SPA with static asset serving. `not_found_handling = "single-page-application"` in wrangler.toml.
- **No relational database** -- All persistent state lives in KV (session metadata, user records, tier config, usage data, CORS config, setup state). No D1, no SQL.
- **No shared state between Worker isolates** -- Module-level caches (CORS, auth config, JWKS, tier config, circuit breakers) are per-isolate. Different isolates may see different values for up to the cache TTL.
- **No application-level WebSocket pings** -- Cloudflare handles protocol-level WebSocket keepalive for DO/Container connections automatically.
- **No FUSE mounts** -- rclone bisync with local disk, not s3fs FUSE. Every file op is <1ms local, not ~340ms network.
- **No auto-resync on bisync failure** -- `--resync` destroys deletion tracking. Self-healing uses `--resilient` + `--recover`. Manual resync only via `establish_bisync_baseline()` on startup (one-way restore first).
- **No cross-session access** -- Each container has its own PTY, its own R2 credentials (scoped to owner's bucket), and its own auth token. Sessions cannot communicate.
- **Single port architecture** -- All container services (WebSocket, REST, health, metrics) on port 8080. Eliminates port conflict bugs.
- **No Docker layer pruning in CI** -- `docker system prune -af` nukes the cache on self-hosted runners and triggers Docker Hub rate limits. Let Docker manage its own cache.
