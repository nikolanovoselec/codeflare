# Constraints

Architectural and technology decisions that apply across all domains.

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Cloudflare Workers | Edge deployment, global distribution, web-standard runtime |
| Framework | Hono | Lightweight Workers-compatible router with middleware support |
| Frontend | SolidJS | Reactive, small bundle, signal-based state management |
| Terminal | xterm.js | Industry-standard terminal emulator with SerializeAddon for state replay |
| Database | Cloudflare D1 and KV | D1 owns complete session lifecycle records and historical usage/report state; KV retains settings, preferences and credentials, not a session shadow catalog |
| Storage | Cloudflare R2 | S3-compatible object storage, per-user buckets, SSE-C encryption |
| Containers | Cloudflare Containers | Isolated compute per session, SDK-managed lifecycle |
| State | Durable Objects | Per-session (`container`) and per-user (`timekeeper`) stateful coordination |
| Sync | rclone bisync v1.75.2-codeflare-bisync1 | Bidirectional file sync between container and R2 every 15 minutes, with verified per-side bookkeeping; explicit UI Sync-now recovery uses SIGUSR2, ordinary/final requests use SIGUSR1 |
| Billing | Stripe | Payment processing, subscription management, webhook-driven tier changes |
| Email | Resend | Transactional notifications (waitlist, access requests, tier changes) |
| Build | Vite | Frontend bundler, SPA output served as static assets |
| Language | TypeScript (strict) | Full stack -- Worker, frontend, and container host server |
| Validation | Zod | Runtime schema validation for API payloads and responses |
| Container Base | Pinned Node.js 26 (bookworm-slim) | Application builder and final runtime; IDE dependency/build stages retain their separate Node 22/26 pins. Native build toolchains are purged from runtime |
| Linter | oxlint | Fast Rust-based linter for CI |
| Testing | Vitest | Unit/integration tests; Puppeteer for E2E; fast-check for fuzzing |
| Container Tools | git, gh, rclone, neovim, ripgrep, fd, fzf, yazi, lazygit, zoxide, tmux, htop, jq, python/python3, bat | Pre-installed developer toolchain in every container |
| AI Agents | @anthropic-ai/claude-code, @openai/codex, opencode-ai, @github/copilot, Pi (npm); antigravity (`agy`, Go-native, curl-installed) | Selected npm agents use committed prefix-local lock-backed installations, pruned by `CODEFLARE_CODING_AGENTS`; Antigravity is separately curl-installed only when selected. Claude Code runs as root via `IS_SANDBOX=1` + `--dangerously-skip-permissions` |

## Non-Functional Requirements

### Security

### CON-SEC-001: All non-public endpoints require authentication
Non-public surfaces require their owning authenticator: browser/user paths use JWT verification (CF Access RS256 or GitHub OIDC HMAC-SHA256); service and capability paths have distinct authenticators. Initial setup bootstrap/status is deliberately public; post-setup configuration requires admin authorization. Container bearer auth uses a random UUID per DO lifecycle, passed as `CONTAINER_AUTH_TOKEN`, on non-exempt paths (`/health` and `/activity` are exempt). This does not expand the accepted AUTH-002/AUTH-008 guarantees or limitations.
**Applies To:** All endpoints

<a id="con-sec-002-api-tokens-never-enter-containers"></a>
### CON-SEC-002: Deployment master API tokens never enter containers
The deployment master token must remain Worker-side. `CLOUDFLARE_API_TOKEN` may be a non-secret mediated placeholder, or an ordinary non-enterprise user's deploy credential; the variable name alone does not identify a leaked master secret. Strict/restricted R2 paths use placeholders and Worker-held exact-bucket credentials; ordinary direct R2 paths use scoped credentials. These distinctions do not resolve outstanding legacy-token feature security gaps.
**Applies To:** System (container provisioning)

<a id="con-sec-003-credentials-encrypted-at-rest-when-encryption_key-configured"></a>
### CON-SEC-003: Credentials encrypted at rest when ENCRYPTION_KEY configured
Optional AES-256-GCM for KV credentials (per-value random IVs, AAD binding to key name); R2 SSE-C for workspace files.
**Applies To:** System (storage layer)

### CON-SEC-004: Rate limiting on all mutation endpoints
KV-backed, per-user (bucketName or IP fallback). WebSocket: 30 connections per 60s window. Security-critical limiters deny on KV error (HTTP 429 via `RateLimitError`, not 503). The all-mutation limiting obligation remains. Deploy-key PUT and DELETE share a 20/minute authenticated-owner budget before credential I/O; GET does not consume it. They retain the general resource-protection fallback policy, not the security-critical fail-closed policy. <!-- @impl: src/routes/deploy-keys.ts::app --> <!-- @test: src/__tests__/routes/deploy-keys.test.ts (CON-SEC-004 / REQ-SEC-007 AC1/3/4: unwrapped %s shares the authenticated mutation bound) --> 64 KiB body limit on all `/api/*` routes (storage routes exempt for file uploads).
**Applies To:** All endpoints

<a id="con-sec-005-security-headers-on-every-response"></a>
### CON-SEC-005: Security headers on ordinary responses
Ordinary responses receive HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy and Permissions-Policy. The shared wrapper returns WebSocket 101 upgrades unchanged. Same-origin proxy content has narrow CSP/frame exceptions; MCP OAuth callbacks use `no-referrer` for privacy.
**Applies To:** Ordinary responses; WebSocket upgrades as qualified above

<a id="con-gh-001-github-token-encrypted-at-rest-and-never-returned-to-the-browser"></a>
### CON-GH-001: GitHub token encrypted at rest when configured and never returned to the browser
The per-user GitHub token is stored in the existing `deploy-keys:<bucket>` KV entry (`DeployKeys.githubToken`), encrypted with AES-256-GCM (AAD bound to the KV key) when `ENCRYPTION_KEY` is configured, with the accepted plaintext JSON fallback when absent, per CON-SEC-003 (unchanged key identity; no key-rotation migration), and is never serialized into any client response (status/list endpoints return only non-secret metadata such as the login handle).
**Applies To:** System (GitHub integration)

### CON-GH-002: The real GitHub token never enters the enterprise container
In enterprise mode the container receives only a non-secret placeholder `GH_TOKEN`; the real per-user token is injected into outbound `github.com` / `api.github.com` requests at the egress boundary by the Worker interceptor. Ordinary non-enterprise user sessions carry the real token via `GH_TOKEN` by design (leakage-hygiene, not agent-containment); restricted Operator sessions use a placeholder even outside enterprise. Injection remains scoped solely by the session binding.
**Applies To:** System (enterprise container egress)

### CON-GH-003: Egress injection is scoped by the per-session binding
The GitHub interceptor resolves which user's token to inject solely from the per-session interceptor binding (`props.bucket`), never from the incoming request; the container placeholder is identical for all users, so a session can only ever inject its own user's token.
**Applies To:** System (enterprise container egress)

#### Additional Security Controls

| Control | Implementation |
|---------|----------------|
| Input validation | Boundary validation remains the obligation of [REQ-SEC-009](security.md#req-sec-009-input-validation-at-system-boundaries) and its owning feature predicates; `parseJsonBody` validates only when given a schema. Helper and terminal-route tests establish scoped outcomes, not universal coverage or a defect in every schema-free caller. 64 KiB `/api/*` body limit, with storage upload exceptions |
| Session ID validation | `/^[a-z0-9]{8,24}$/` enforced before any DO interaction |
| Path traversal prevention | `validateKey` decodes once before the `..` check: rejects `%2E%2E`, but `%252E%252E` returns literal `%2E%2E`. This is not double-encoding detection or proof of downstream safety ([REQ-SEC-010](security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints)) |
| Supply chain | CodeQL, OSSF Scorecard, `npm audit`, dependency review, Dependabot, Trivy container scanning |
| Deploy gate | `deploy.yml` `workflow_run` trigger requires `event == 'push'` and `head_repository.full_name == github.repository` so a fork PR cannot trigger a deploy by naming its head branch `main` (defeats Scorecard DangerousWorkflowID pwn-request pattern). |
| CI token scope | PR Checks receive no container-cache permission and never build images. The deployment container job alone receives `packages: write` to import and publish cache updates. Top-level workflow permissions remain `contents: read`, limiting blast radius on token compromise. `bump-shadow-pins.yml` mirrors this read-only baseline, with only jobs that push bump branches and open PRs elevating to write. |
| Penetration testing | Weekly automated external pentest (auth gate, headers, TLS, injection, info disclosure) |
| Secret scanning | GitHub secret scanning with push protection enabled |
| Credential masking | `maskSecret()` shows only last 4 chars in all API responses |

### Performance

<a id="con-perf-001-dashboard-polling-interval-5-seconds"></a>
### CON-PERF-001: Visibility-aware dashboard polling
Visible transitional state polls at 5s and stable state at 60s. Hidden documents cancel scheduled polling; visibility return refreshes, with requests serialized. Backend metrics normally run every 60s via the Container DO loop, retaining bounded recovery exceptions.
**Applies To:** User (dashboard), System (metrics)

### CON-PERF-002: Bisync interval 15 minutes (with manual triggers)
R2 bisync runs every 15 minutes via the daemon, plus the explicit UI Sync-now recovery trigger via SIGUSR2 (ordinary/final daemon requests retain SIGUSR1), plus a final sync on shutdown under the 120 s watchdog. Initial sync timeout 120 s (`SYNC_TIMEOUT`). Baseline establishment timeout is 600 s (10 min) per attempt, at most three attempts, not a total 600 s budget. Existing rescue and recovery semantics remain unchanged. See [AD56](../../documentation/decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers) for the cost-vs-staleness rationale.
**Applies To:** System (sync daemon)

### CON-PERF-003: Tier config cache TTL 60 seconds
Tier configuration cached for 60s in `src/lib/subscription.ts`. Other cache TTLs: CORS 5 min, auth config 5 min, JWKS 30s freshness, Stripe prices 1 hour, Timekeeper user records 60s (100-entry cap).
**Applies To:** System (Worker caches)

#### Additional Performance Metrics

| Metric | Value | Source |
|--------|-------|--------|
| Session projection ordering | Complete owner-scoped D1 records with monotonic generation/revision and intent fences; no new-session KV propagation wait | D1 session repository and ordered client state |
| WebSocket retry delay | Equal-jitter exponential backoff, 500ms base and 15s cap; reset on successful open | Terminal protocol and reconnect store |
| Dashboard WS disconnect grace period | 60s | Web UI shared constants |
| Container fetch timeout | 5s | Worker request constants |
| V8 compile cache | Pre-warmed at image build time for Pi only (Codex/Copilot excluded — owner decision, image-size) | Image build step |
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
Three states (CLOSED/OPEN/HALF_OPEN) wrapping `container.fetch()` calls to prevent cascading failures. Only operations invoking `withSetupRetry()` get 3 total attempts with 1s/2s backoff; open breakers fail immediately. Zone lookup and secret PUT call `cfApiCB` directly without that retry wrapper.
**Applies To:** System (Worker, setup wizard)

#### Additional Reliability Mechanisms

| Mechanism | Implementation |
|-----------|----------------|
| Zombie DO detection | `collectMetrics` returns early without re-arming when identifiers are missing (post-`destroy()`) |
| WebSocket wake-loop prevention | Generation-fenced runtime admission and D1 lifecycle projection; transport failures do not independently grant terminal restart or disposal authority |
| Anti-flapping | Monotonic generation/revision ordering and intent fences prevent stale observations from reversing newer lifecycle state; close code 4503 is transport evidence, not stopped authority |
| Session resurrection prevention | Owner/generation/termination-intent fences prevent stale teardown from affecting replacements. SDK `onStop()` is unconfirmed exit evidence and reschedules generation-pinned monitoring where needed; it does not write session KV authority |
| Session projection and ancillary caches | Complete D1 batch-status includes persisted metrics; unrelated KV user/settings caches retain their own TTLs, not session list-metadata authority |
| Rate limiter fail modes | Security-critical limiters deny with HTTP 429 on KV error; general resource protection uses in-memory fallback on KV operation failure (missing KV may skip general limiting) |

### Cost

### CON-COST-001: Idle containers stop Container metering
New `sleepAfter` options are 1h, 2h, 4h, 8h and 12h; legacy minute values remain readable. Ordinary non-free default is 1h, ordinary free tier is locked to 15m; enterprise honors the stored preference or 1h default. Admins can change their own timeout; non-subscribed users have the dropdown disabled. Classified terminal input and each client-to-server Browser IDE frame reset the timer; reconnects, background polls and server output do not. The SDK idle sentinel remains inert; Codeflare owns idle policy and bounded final drains. After Codeflare's stop completes and the Container sleeps, Container vCPU, provisioned-memory, and local-disk metering ends. Local disk is ephemeral rather than hibernated state, and Workers, Durable Objects, R2, requests, logs, storage, and network usage may still incur charges.
**Applies To:** System (container lifecycle), Admin (cost management)

#### Additional Cost Mechanisms

| Mechanism | Implementation |
|-----------|----------------|
| Timekeeper DO | Per-user usage tracking: accumulates seconds per session, flushes to KV every 5 min, enforces monthly quotas |
| Stateless dashboard | Complete owner-scoped D1 session projection for frequent status reads; no container wake or session-DO contact. Ancillary usage/storage/entitlement/migration work has a separate slower/event-driven owner |
| Read ownership | D1 owns persisted lifecycle/metrics projection; unrelated KV caches retain scoped TTLs. Timekeeper remains live quota/accounting authority; historical D1 data does not replace it |

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
| default (saas alias) | 1 | 3 GiB | 6 GB | 10 |
| high | 2 | 6 GiB | 12 GB | 10 |

Container tier (`RESSOURCE_TIER`) is independent of subscription tier and `MAX_INSTANCES`. All three can be combined freely.

These are configured profiles, not verified physical/effective allocations; provider receipts remain required. The low tier selects the provider `basic` preset. The following limits apply to custom instances, not `basic`: disk (GB) <= 2 x memory (GiB) and >= 3 GiB memory per vCPU. The default tier's 6 GB ceiling is set by its 3 GiB memory; raising default disk above 6 GB requires raising default memory to >=4 GiB first. The high tier's 12 GB is its 6 GiB x 2 ceiling; going higher would require more memory (max custom instance: 4 vCPU / 12 GiB / 20 GB).

## Boundaries

- **No Node.js APIs in Worker** -- Workers use a web-standard runtime. `fetch()` not `http`; `crypto.subtle` not `require('crypto')`; `Request`/`Response` not Express objects. The `nodejs_compat` flag enables specific modules only.
- **No server-side rendering** -- SolidJS SPA with static asset serving. `not_found_handling = "single-page-application"` in wrangler.toml.
- **No hosted user database** -- Codeflare does not host PostgreSQL, MySQL or MongoDB for user projects. Its own D1 database owns the complete session catalog and historical usage/report state; KV settings, credentials and preferences remain separate. Session authority has no KV compatibility path.
- **No shared state between Worker isolates** -- Module-level caches (CORS, auth config, JWKS, tier config, circuit breakers) are per-isolate. Different isolates may see different values for up to the cache TTL.
- **No application-level WebSocket pings** -- Cloudflare handles protocol-level WebSocket keepalive for DO/Container connections automatically.
- **No FUSE mounts** -- rclone bisync with local disk, not s3fs FUSE. Every file op is <1ms local, not ~340ms network.
- **Bounded resync only after ordinary recovery is exhausted** -- `--resync` can resurrect a pending deletion, so steady-state recovery first uses resilient/recover semantics and vanished-file repair. Baseline re-establishment is automatic only after three consecutive unrecoverable failures, or immediately when the missing prior listing makes ordinary retry impossible, as constrained by [REQ-STOR-045](storage.md#req-stor-045-bisync-baseline-recovery).
- **Session isolation** -- Each container has its own processes/PTY, transport and authorization binding. This does not promise separate persistent files for sessions of the same owner: they intentionally share that owner's R2 bucket. Cross-tenant access remains forbidden.
- **Single exposed host ingress** -- WebSocket, REST, health and metrics enter through port 8080. Internal loopback services include SilverBullet on 3030 and Browser IDE on 13337; this is not a single-listener claim.
- **No Docker layer pruning in CI** -- `docker system prune -af` nukes the cache on self-hosted runners and triggers Docker Hub rate limits. Let Docker manage its own cache.
