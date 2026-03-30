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
| Sync | rclone bisync v1.73.2 | Bidirectional file sync between container and R2 every 60s |
| Billing | Stripe | Payment processing, subscription management, webhook-driven tier changes |
| Email | Resend | Transactional notifications (waitlist, access requests, tier changes) |
| Build | Vite | Frontend bundler, SPA output served as static assets |
| Language | TypeScript (strict) | Full stack -- Worker, frontend, and container host server |
| Validation | Zod | Runtime schema validation for API payloads and responses |
| Container Base | Node.js 24 (bookworm-slim) | Multi-stage Docker build; builder compiles native addons, runtime has no build tools |
| Linter | oxlint | Fast Rust-based linter for CI |
| Testing | Vitest | Unit/integration tests; Puppeteer for E2E; fast-check for fuzzing |
| Container Tools | git, gh, rclone, neovim, ripgrep, fd, fzf, yazi, lazygit, zoxide, tmux, htop, jq, bat | Pre-installed developer toolchain in every container |
| AI Agents | claude-unleashed, @openai/codex, @google/gemini-cli, opencode-ai, @github/copilot | Global npm packages, V8 compile cache pre-warmed at build time |

## Non-Functional Requirements

### Performance

| Metric | Value | Source |
|--------|-------|--------|
| Frontend polling interval | 5s (`SESSION_LIST_POLL_INTERVAL_MS`) | `web-ui/src/lib/constants.ts` |
| Backend metrics push interval | 60s (`collectMetrics` schedule) | Container DO alarm loop |
| KV eventual consistency delay | ~60s for new sessions | Cloudflare KV propagation |
| R2 bisync interval | 60s daemon + final sync on shutdown | `entrypoint.sh` |
| Initial R2 sync timeout | 120s (`SYNC_TIMEOUT`) | `entrypoint.sh` |
| Bisync baseline establishment timeout | 600s (10 min) | `entrypoint.sh` |
| WebSocket retry delay | 1s (`WS_RETRY_DELAY_MS`) | `web-ui/src/stores/terminal.ts` |
| Dashboard WS disconnect grace period | 60s (`DASHBOARD_WS_DISCONNECT_DELAY_MS`) | `web-ui/src/lib/constants.ts` |
| Container fetch timeout | 5s (`CONTAINER_FETCH_TIMEOUT`) | `src/lib/constants.ts` |
| CORS cache TTL | 5 min | `src/lib/cors-cache.ts` |
| Auth config cache TTL | 5 min | `src/lib/access.ts` |
| Tier config cache TTL | 60s | `src/lib/subscription.ts` |
| JWKS freshness threshold | 30s (re-fetched on kid miss) | `src/lib/jwt.ts` |
| Stripe price cache TTL | 1 hour | `src/lib/stripe.ts` |
| Timekeeper user record cache TTL | 60s (100-entry cap) | `src/timekeeper/index.ts` |
| V8 compile cache | Pre-warmed at Docker build time for all Node.js CLIs | `Dockerfile` |
| Node compile cache dir | `/root/.cache/node-compile-cache` | `Dockerfile` ENV |
| Context expiry threshold | 30 min (`CONTEXT_EXPIRY_MS`) | Frontend stale session detection |
| Bucket name settle delay | 100ms | `src/lib/constants.ts` |

### Security

| Control | Implementation |
|---------|----------------|
| Auth gate | All `/app`, `/api`, `/setup` surfaces protected by JWT verification (CF Access RS256 or GitHub OIDC HMAC-SHA256) |
| Encryption at rest | Optional AES-256-GCM for KV credentials (per-value random IVs, AAD binding to key name); R2 SSE-C for workspace files |
| API token containment | `CLOUDFLARE_API_TOKEN` never enters containers; containers receive per-user scoped R2 tokens only |
| Container auth | Random UUID per DO lifecycle, passed as `CONTAINER_AUTH_TOKEN`, validated on all non-exempt paths |
| Security headers | HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy on every response |
| Rate limiting | KV-backed, per-user (bucketName or IP fallback). WebSocket: 30 connections per 60s window. Security-critical endpoints fail-closed on KV error |
| Body limit | 64 KiB on all `/api/*` routes (storage routes exempt for file uploads) |
| Input validation | Zod schemas on all API payloads; 64 KiB body limit |
| Session ID validation | `/^[a-z0-9]{8,24}$/` enforced before any DO interaction |
| Path traversal prevention | `decodeURIComponent` before `..` check; catches `%2E%2E` and double-encoded variants |
| Supply chain | CodeQL, OSSF Scorecard, `npm audit`, dependency review, Dependabot, Trivy container scanning |
| Penetration testing | Weekly automated external pentest (auth gate, headers, TLS, injection, info disclosure) |
| Secret scanning | GitHub secret scanning with push protection enabled |
| Credential masking | `maskSecret()` shows only last 4 chars in all API responses |

### Reliability

| Mechanism | Implementation |
|-----------|----------------|
| Graceful shutdown | `STOPSIGNAL SIGINT`; entrypoint trap kills sync daemon via PID file, runs final bisync, kills terminal server |
| Bisync recovery | `--resilient` + `--recover` for self-healing; consecutive failure counter (3 failures = resync fallback) |
| Self-healing sync | `nuke_corrupted_r2_files` detects and removes files blocking bisync (encryption mismatch, size mismatch, corrupted transfer) |
| Circuit breaker | Three states (CLOSED/OPEN/HALF_OPEN) wrapping `container.fetch()` calls to prevent cascading failures |
| Setup wizard resilience | `withSetupRetry()` wraps all CF API calls (3 total attempts, exponential backoff 1s/2s) |
| Zombie DO detection | `collectMetrics` returns early without re-arming when identifiers are missing (post-`destroy()`) |
| WebSocket wake-loop prevention | Three-layer guard: DO fetch gate (503 when not running), terminal route guard (KV status check), frontend disposal on running-to-stopped transition |
| Anti-flapping | 3-minute startup guard; only close code 4503 can transition new sessions to stopped; KV polling does not auto-initialize terminals for non-active sessions |
| Session resurrection prevention | `destroy()` clears identifiers before `super.destroy()` so `onStop()` cannot write to KV for deleted sessions |
| KV optimization (1500-user scale) | List metadata for batch-status (99.97% read reduction), metrics inline on session records, user record cache with 60s TTL |
| Rate limiter fail modes | Security-critical endpoints fail-closed (503 on KV error); general resource endpoints fail-open with in-memory fallback |

### Cost

| Mechanism | Implementation |
|-----------|----------------|
| Hibernate on idle | Containers stop after configurable `sleepAfter` (5m, 15m, 30m, 1h, 2h) with no terminal input. Default 30m for paying users, 5m for free tier |
| Input-aware idle detection | Timer resets only on actual user input (keypresses, not WebSocket reconnects or background polls). `containsUserInput()` whitelist approach |
| Scale to zero | No running containers = no compute bill. R2 storage persists at storage-tier pricing |
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
