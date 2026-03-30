# Architecture Decisions

Architecture Decision Records for Codeflare. Each decision documents a design trade-off with rationale. Referenced as AD1-AD42 throughout the codebase and documentation.

**Audience:** Developers

---

## Decision Index

| ID | Decision | Category |
|----|----------|----------|
| [AD1](#ad1-one-container-per-session) | One container per session | Architecture |
| [AD2](#ad2-container-id-format) | Container ID format | Architecture |
| [AD3](#ad3-per-user-r2-buckets) | Per-user R2 buckets | Architecture |
| [AD4](#ad4-periodic-rclone-bisync) | Periodic rclone bisync | Architecture |
| [AD5](#ad5-login-shell-autostart) | Login shell autostart | Architecture |
| [AD6](#ad6-kv-read-modify-write-races) | KV read-modify-write races | Architecture |
| [AD7](#ad7-pre-setup-public-endpoints) | Pre-setup public endpoints | Security |
| [AD8](#ad8-root-container-no-internal-auth) | Root container, no internal auth | Architecture |
| [AD9](#ad9-ressource_tier-spelling) | RESSOURCE_TIER spelling | UI/Frontend |
| [AD10](#ad10-open-setup-endpoint-before-first-configure) | Open setup endpoint before first configure | Security |
| [AD11](#ad11-suffix-pattern-cors-with-credentials) | Suffix-pattern CORS with credentials | Security |
| [AD12](#ad12-kv-based-setup-lock-non-atomic) | KV-based setup lock (non-atomic) | Security |
| [AD13](#ad13-per-user-scoped-r2-tokens) | Per-user scoped R2 tokens | Security |
| [AD14](#ad14-never-auto---resync-on-bisync-failure) | Never auto-`--resync` on bisync failure | Storage |
| [AD15](#ad15-tabconfigschema-allows-arbitrary-command-strings) | TabConfigSchema allows arbitrary command strings | UI/Frontend |
| [AD16](#ad16-entrypointsh-1090-lines-complexity) | entrypoint.sh ~1090 lines complexity | Architecture |
| [AD17](#ad17-collectmetrics-density) | collectMetrics density | Architecture |
| [AD18](#ad18-webgl-any-types-in-webgl-utilsts) | WebGL `any` types in webgl-utils.ts | UI/Frontend |
| [AD19](#ad19-splash-cursor-logicts-as-any-casts) | splash-cursor-logic.ts `as any` casts | UI/Frontend |
| [AD20](#ad20-toctou-in-containerlifecyclets) | TOCTOU in container/lifecycle.ts | Architecture |
| [AD21](#ad21-inconsistent-function-signatures) | Inconsistent function signatures | Architecture |
| [AD22](#ad22-jwks-30s-cache-staleness) | JWKS 30s cache staleness | Security |
| [AD23](#ad23-cors-origin-pattern-validation) | CORS origin pattern validation | Security |
| [AD24](#ad24-predictable-session-ids) | Predictable session IDs | Security |
| [AD25](#ad25-e2e-service-email-hardcoded) | E2E service email hardcoded | Security |
| [AD26](#ad26-stress-test-rate-limit-bypass) | Stress test rate-limit bypass | Security |
| [AD27](#ad27-server-side-prefix-delete) | Server-side prefix delete | Storage |
| [AD28](#ad28-stress-test-bypass-is-integration-only) | Stress test bypass is integration-only | Security |
| [AD29](#ad29-container-secrets-as-env-vars) | Container secrets as env vars | Security |
| [AD30](#ad30-worker-name-from-host-header) | Worker name from Host header | Security |
| [AD31](#ad31-root-container-is-intentional) | Root container is intentional | Architecture |
| [AD32](#ad32-encryption_key-is-optional) | ENCRYPTION_KEY is optional | Security |
| [AD33](#ad33-pre-setup-csrf-risk-accepted) | Pre-setup CSRF risk accepted | Security |
| [AD34](#ad34-websocket-auth-bypass-of-hono-middleware) | WebSocket auth bypass of Hono middleware | Security |
| [AD35](#ad35-splash-cursor-logicts-old-style-constructor-with-any-types) | splash-cursor-logic.ts old-style constructor with any types | UI/Frontend |
| [AD36](#ad36-websocket-origin-check-is-optional-for-non-browser-clients) | WebSocket Origin check is optional for non-browser clients | Security |
| [AD37](#ad37-kv-as-billing-read-cache--signal-and-sync-cf-015) | KV as billing read cache -- Signal and Sync (CF-015) | Billing |
| [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) | GitHub OIDC replaces CF Access in SaaS mode | Billing |
| [AD39](#ad39-max-users-capacity-cap-counts-paid-slots-only) | Max users capacity cap counts paid slots only | Billing |
| [AD40](#ad40-webhook-route-order-publicstripe-before-public) | Webhook route order (`/public/stripe` before `/public`) | Billing |
| [AD41](#ad41-custom-tier-uses-contact-flow-not-self-service-checkout) | Custom tier uses contact flow (not self-service checkout) | Billing |
| [AD42](#ad42-unauthenticated-first-setbucketname-call-cf-010) | Unauthenticated first setBucketName call (CF-010) | Security |

---

## Decisions

### AD1: One container per session

**Decision:** CPU isolation -- each tab gets full 1 vCPU instead of sharing.

Alternative was one container per user with multiplexed PTYs. Per-session containers avoid noisy-neighbor CPU contention between tabs running different agents, and simplify cleanup (destroy container = clean slate).

---

### AD2: Container ID format

**Decision:** `{bucketName}-{sessionId}`

Example: `codeflare-user-example-com-abc12345`. Deterministic from user email + session ID. Enables DO lookup without KV round-trip. `getContainerId()` must NEVER fallback on invalid sessionId -- that was root cause of orphaned containers.

---

### AD3: Per-user R2 buckets

**Decision:** Bucket name derived from email, auto-created on first login.

Isolation boundary: each user's files live in their own bucket. Simplifies deletion (empty + delete bucket). Bucket name sanitized from email (max 63 chars, S3-compatible). Per-user scoped R2 tokens (AD13) further restrict access.

---

### AD4: Periodic rclone bisync

**Decision:** Background daemon every 60s + final sync on shutdown.

Local disk for all file operations (fast I/O). Bisync daemon runs in background, syncing changes bidirectionally. SIGINT/SIGTERM trap runs final bisync before exit. Alternative (s3fs FUSE) was fragile and slow -- see Lessons Learned #1.

---

### AD5: Login shell autostart

**Decision:** `.bashrc` auto-starts the configured agent in workspace.

PTY spawns `bash -l` (login shell). `.bashrc` reads `TAB_CONFIG` env var and launches the configured agent. `MANUAL_TAB=1` env var skips autostart for user-created tabs.

---

### AD6: KV read-modify-write races

**Decision:** Last-writer-wins is acceptable; collectMetrics race mitigated.

Session PATCH/stop overlap is rare, rate limit off-by-one is minor, `lastAccessedAt` is best-effort. KV doesn't support atomic read-modify-write. Durable Objects would add latency for negligible consistency gain in this use case.

`collectMetrics` KV read-modify-write can revert session status. Mitigated: session status changes are only observed from the Dashboard, not during active terminal use. Sessions are never interrupted while in Terminal view.

---

### AD7: Pre-setup public endpoints

**Decision:** Short exposure window is acceptable risk.

Setup runs once during initial deploy. Pre-setup auth trusts spoofable email header -- bootstrap problem (can't require CF Access auth when CF Access isn't configured yet). Mitigated by rate limiting and short exposure window. See AD10 for full trade-off analysis.

---

### AD8: Root container, no internal auth

**Decision:** Network isolation via DO proxy is sufficient.

Root needed for rclone mount. Container auth token (random UUID per DO lifecycle) validates all proxied requests. Network boundary: only the DO can reach the container's port 8080. Wildcard CORS inside container is safe -- it's internal-only.

---

### AD9: RESSOURCE_TIER spelling

**Decision:** French/German "ressource" is intentional.

Consistent across all config (wrangler.toml, GitHub variables, TypeScript types). Changing would be a breaking API change affecting deployed instances. The spelling is a deliberate nod to the developer's language background.

---

### AD10: Open setup endpoint before first configure

**Decision:** Bootstrap problem -- no auth before auth is configured.

`/api/setup/configure` is public before `setup:complete` is written to KV. This allows the deployer to configure their instance without pre-existing auth infrastructure (Cloudflare Access isn't set up yet -- that's what setup configures).

**Trade-off**: A narrow window (seconds to minutes) exists where any actor could claim the deployment. Accepted because the target audience is self-hosted single-user/small-team deployments where the deployer is watching the process.

**Mitigation**: `setup:complete` KV flag prevents re-configuration. Rate limiting applies to setup routes.

**Future**: A one-time bootstrap secret injected at deploy time would close this window entirely.

---

### AD11: Suffix-pattern CORS with credentials

**Decision:** `matchesPattern()` with domain-boundary enforcement.

Default `ALLOWED_ORIGINS` includes `.workers.dev` as a suffix pattern, with `Access-Control-Allow-Credentials: true` on matching responses.

**Trade-off**: Any `*.workers.dev` subdomain passes the CORS check. Accepted because: `matchesPattern()` enforces domain boundaries (`evil-workers.dev` does NOT match), custom domains replace the wildcard, `ALLOWED_ORIGINS` is configurable, and CF Access JWT is the primary auth gate.

**Mitigation**: Setup adds `.workers.dev` suffix and `.{customDomain}` suffix to `setup:allowed_origins` in KV.

**Future**: Restricting credentialed CORS to exact known hosts would tighten the trust surface.

---

### AD12: KV-based setup lock (non-atomic)

**Decision:** Read-then-write pattern, acceptable for one-time setup.

Read `setup:complete`, check if false, perform setup, write true. Not atomic -- two simultaneous requests could both proceed.

**Trade-off**: Accepted because setup is a one-time operation by a single admin. Each sub-step (CF API calls) is individually idempotent -- duplicate execution produces the same result. Worst case is redundant API calls, not corrupted state.

**Future**: Moving to a Durable Object would provide strict serialization, deferred until there's evidence of the race occurring.

---

### AD13: Per-user scoped R2 tokens

**Decision:** Each container gets an R2 token scoped to its user's bucket only.

Replaces previous shared credential model. Token lifecycle:

1. **Creation**: `getOrCreateScopedR2Token()` creates token with Object Read+Write policy restricted to user's bucket
2. **Caching**: Token data cached in KV as `r2token:{email}` (encrypted via AES-256-GCM) -- survives container restarts
3. **Verification**: `verifyTokenExists()` validates cached tokens via `GET /tokens/{id}` before use. Only 404 invalidates; transient errors assume valid (prevents API blips from causing rclone 401s)
4. **Delivery**: Passed via `setBucketName` body -> container env vars -> rclone config
5. **Revocation**: `deleteScopedR2Token()` on user deletion

**Trade-off**: Requires `API Tokens: Edit` permission on deploy token (broader than ideal). Accepted because manual R2 credential management per user is operationally impractical.

---

### AD14: Never auto-`--resync` on bisync failure

**Decision:** `--resilient` + `--recover` for self-healing instead.

`--resync` makes both sides identical by copying the newer version of every file, then creates a fresh baseline. This permanently loses pending deletions -- if side A deleted a file and bisync fails before propagating, `--resync` resurrects it from side B.

**Instead**: `--resilient` (continue past non-critical errors) + `--recover` (reconstruct corrupted listings) + `--max-delete 100` (allow bulk deletions). Daemon retries in 60s on failure.

**Manual `--resync`** is safe in `establish_bisync_baseline()` on container startup because one-way restore runs first.

---

### AD15: TabConfigSchema allows arbitrary command strings

**Decision:** `z.string().max(200)` -- no additional security risk.

Users already have full root shell access inside their own ephemeral container. Restricting tab commands provides no additional security benefit since the container is their sandbox.

---

### AD16: entrypoint.sh ~1090 lines complexity

**Decision:** Battle-tested, rewrite risk > benefit.

Handles Alpine->Debian migration, PTY pre-warm, rclone sync orchestration, tab autostart, and graceful shutdown. Accumulated complexity reflects real-world edge cases discovered over months of production use. A rewrite risks reintroducing solved bugs for marginal readability gains.

---

### AD17: collectMetrics density

**Decision:** Extends AD6 scope -- alarm() context needs atomicity.

`collectMetrics` performs activity checking, health probing, and KV status updates in a single alarm callback. Splitting into separate alarms would require coordination logic more complex than the current monolithic approach. The alarm() context provides natural atomicity across these tightly coupled operations.

---

### AD18: WebGL `any` types in webgl-utils.ts

**Decision:** No standard TS definitions for WebGL extensions.

Extensions like `OES_texture_half_float`, `WEBGL_lose_context`, etc. have no official TypeScript definitions. The `any` casts are isolated to this single utility file and the WebGL API surface is stable. Adding custom type definitions would be maintenance burden with no runtime benefit.

---

### AD19: splash-cursor-logic.ts `as any` casts

**Decision:** Creative-coding adapted code with no upstream TS types.

Pointer tracking objects and WebGL shader uniforms in this creative-coding module have no typed definitions upstream. The code is adapted from a visual effect library. Type assertions are confined to this isolated module.

---

### AD20: TOCTOU in container/lifecycle.ts

**Decision:** Durable Objects are single-threaded per ID -- false positive.

Static analysis flags time-of-check-time-of-use patterns between KV reads and subsequent writes. However, Durable Objects guarantee that `alarm()` and `fetch()` handlers are serialized by the runtime -- no concurrent execution within a single DO instance. The TOCTOU pattern is architecturally impossible here.

---

### AD21: Inconsistent function signatures

**Decision:** Old helpers use positional args, new ones use options objects.

Legacy helper functions accept positional parameters while newer ones use destructured options objects. Normalizing all signatures risks caller regressions across the codebase. The inconsistency is cosmetic -- both styles are well-typed and documented.

---

### AD22: JWKS 30s cache staleness

**Decision:** Industry-standard tradeoff for key rotation.

The 30-second JWKS cache in `jwt.ts` means a rotated key might not be recognized for up to 30s. This is an industry-standard tradeoff -- Cloudflare Access uses key overlap periods during rotation, and shorter cache durations add latency to every JWT verification without meaningful security improvement.

---

### AD23: CORS origin pattern validation

**Decision:** Admin is trusted -- has full worker access.

Admin-configured CORS origin patterns stored in KV are not re-validated on every request read. The admin already has full worker access (can deploy code, modify secrets). Validating every KV-sourced pattern adds request overhead for zero additional security.

---

### AD24: Predictable session IDs

**Decision:** Session IDs are namespace keys, not secrets.

Session IDs are user-provided identifiers for KV namespacing, not authentication tokens. Security is JWT-based -- knowing a session ID without a valid JWT grants zero access. The `SESSION_ID_PATTERN` validates format, not entropy. Randomizing IDs would break user-friendly naming.

---

### AD25: E2E service email hardcoded

**Decision:** `e2e-service@codeflare.local` is a test identifier.

The `.local` TLD is RFC 6762 reserved and obviously non-production. The email is a test fixture seeded into KV for E2E authentication, not a secret. Extracting it to an environment variable adds configuration complexity for zero security benefit.

---

### AD26: Stress test rate-limit bypass

**Decision:** `STRESS_TEST_MODE=active` skips all rate limiting.

k6 stress tests share a single CF Access service token (single identity), so per-user rate limits (10/min sessions, 5/min containers, 30/min WebSocket) block meaningful load testing above ~5 VUs. Setting `STRESS_TEST_MODE=active` on the integration worker disables all rate-limit KV reads/writes at the top of the middleware, before any I/O. The value must be exactly `"active"` -- any other value (including `"true"`) keeps limits enforced. Only set on integration; production must never have this variable.

---

### AD27: Server-side prefix delete

**Decision:** Server-side list+batch delete via R2 S3 API instead of frontend recursive browse+delete.

Frontend folder deletion was subject to API rate limits (30/min browse, 20/min delete), causing failures for large folders. R2 has no native "delete prefix" API, and lifecycle rules (Days=0) take up to 24h. Server-side ListObjectsV2 + batch DeleteObjects (1000 keys/call) using `emptyR2Bucket()` is the fastest approach. No `[[r2_buckets]]` binding needed -- per-user dynamic buckets use account-level S3 credentials directly.

---

### AD28: Stress test bypass is integration-only

**Decision:** No CI guard needed -- GitHub Actions environment separation controls it.

`STRESS_TEST_MODE=active` disables all rate limiting. Only set via GitHub Actions workflow scoped to the `integration` environment. Production deployments use `environment: production` and never receive this variable. A repo admin could theoretically set it for production, but this requires deliberate action.

---

### AD29: Container secrets as env vars

**Decision:** Plaintext env vars acceptable for single-tenant containers.

Container DO injects R2 credentials, LLM API keys, and auth tokens as plaintext environment variables. Users already have full terminal access (`env` command). Secrets are: R2 credentials (bucket-scoped), LLM keys (user's own), container auth token (internal DO-to-container). Any process can read via `/proc/self/environ` but containers are single-tenant.

---

### AD30: Worker name from Host header

**Decision:** Host header parsing for `.workers.dev` domains during setup only.

Worker name derived from Host header for `.workers.dev` subdomains during first-time setup. Custom domains use `CLOUDFLARE_WORKER_NAME` env var instead. Exposure window: only during setup (minutes), requires CF Access JWT, setup is idempotent. Spoofed Host could theoretically direct to wrong worker name but requires authenticated access and extremely narrow window.

---

### AD31: Root container is intentional

**Decision:** rclone mount, tool installation, and user workspace access all require root.

The Dockerfile has no USER directive; all container processes run as root. Dropping privileges post-init via gosu was evaluated and rejected because tool installation (user-initiated npm install -g, etc.) and rclone FUSE mount operations continue throughout the container lifetime, not just during init. The security boundary is network isolation via the Durable Object proxy -- only the DO can reach the container's port 8080. Container auth token (random UUID per DO lifecycle) validates all proxied requests. User note: "this is by design."

---

### AD32: ENCRYPTION_KEY is optional

**Decision:** Optional encryption eases onboarding; operators accept plaintext KV storage as trade-off.

When ENCRYPTION_KEY is absent, LLM API keys, GitHub tokens, and Cloudflare API tokens are stored as plaintext JSON in KV with no warning. This is an intentional deployment-complexity trade-off. New deployers can get a running instance without generating and managing an encryption key. The target audience is self-hosted single-user/small-team deployments where the operator and the user are the same person. A startup warning when ENCRYPTION_KEY is absent is a recommended future improvement. Operators who want encryption set ENCRYPTION_KEY.

---

### AD33: Pre-setup CSRF risk accepted

**Decision:** Bootstrap window is seconds to minutes; AD10 trade-off applies.

createConditionalSetupAuth() calls next() directly when setup is not complete, bypassing the X-Requested-With CSRF check. AD10 accepts the open pre-setup endpoint as a bootstrap necessity. The pre-setup CSRF risk is accepted under the same rationale: the window is seconds to minutes, the self-hosted audience makes a drive-by CSRF attack from a third-party origin implausible, and the attacker would need to know the exact workers.dev URL during its unconfigured window. Adding Origin validation to the pre-setup path is a low-cost future hardening.

---

### AD34: WebSocket auth bypass of Hono middleware

**Decision:** workerd constraint -- WS upgrades cannot use Hono middleware; parallel auth path is manually synchronized.

WebSocket upgrades must be intercepted before the Hono middleware chain (documented workaround for cloudflare/workerd#2319). This creates a parallel auth path replicating authentication, CORS, rate limiting, and subscription-tier gating. The duplication is explicit and documented. Any change to the Hono middleware auth chain must be manually mirrored in the WebSocket handler. SaaS tier gating tests for the parallel path are tracked as a fix item.

---

### AD35: splash-cursor-logic.ts old-style constructor with any types

**Decision:** Vendored creative/WebGL code -- TypeScript coverage not worth the refactoring effort.

An old-style constructor function with `this: any` causes all downstream pointer/rendering functions to use `any` types. AD19 covers `as any` casts in this module. The constructor is adapted from a visual effect library. The entire module is isolated, has no production data path, and is invoked once per canvas element (not in a hot loop). Refactoring to a typed factory function would require significant rework of adapted code for marginal benefit.

---

### AD36: WebSocket Origin check is optional for non-browser clients

**Decision:** JWT auth is the security gate, not Origin -- CLI tools need originless connections.

The WebSocket upgrade handler in `terminal.ts` only requires the `Origin` header when `Sec-Fetch-Mode` is present (browser heuristic). CLI tools (websocat, wscat) omit `Sec-Fetch-Mode` and are intentionally allowed without Origin. The primary security gate is `authenticateRequest()` which validates JWT/session credentials -- Origin check is defense-in-depth for CSRF protection on browser connections only. An attacker omitting `Sec-Fetch-Mode` still cannot connect without a valid JWT.

---

### AD37: KV as billing read cache -- Signal and Sync (CF-015)

**Decision:** Webhooks signal; `syncSubscriptionState()` fetches latest from Stripe API and writes complete snapshot to KV.

Previous design had 6 webhook handlers incrementally patching KV fields, causing race conditions, silent tier update failures, and wrong emails. "Signal and Sync" pattern: Stripe is source of truth, KV is read cache. `lastSyncedAt` timestamp guard prevents stale overwrites. Concurrent webhooks are idempotent (both fetch same latest state). Price metadata on Stripe Price objects carries tier/mode, eliminating reverse lookups. `getEffectiveTier()` provides read-time enforcement with safe defaults. `past_due` grace period keeps paid tier while `billingPeriodEnd` is in the future.

---

### AD38: GitHub OIDC replaces CF Access in SaaS mode

**Decision:** CF Access costs $3/user/month beyond 50 users -- GitHub OIDC is free.

When `OAUTH_CLIENT_ID` is configured in SaaS mode, the Worker handles authentication directly via GitHub OAuth with HMAC-SHA256 session cookies. CF Access is bypassed at runtime. OAuth state uses HttpOnly cookies (not KV) to avoid eventual consistency issues. Only verified GitHub emails are accepted. The `codeflare_session` cookie is HttpOnly, Secure, SameSite=Lax with 1-hour TTL. Middleware in `index.ts` auto-refreshes when < 15 minutes remain -- active users stay logged in indefinitely. Expired cookie triggers frontend auto-redirect to `/` for re-authentication.

---

### AD39: Max users capacity cap counts paid slots only

**Decision:** `countPaidSlots()` excludes free/pending/blocked users from the cap.

The `setup:max_users` KV key limits subscribing users. Free tier users (4h/month, 1 session) use minimal resources and shouldn't block paid customers. `countPaidSlots()` counts admins + users with paid tiers (standard/advanced/max/unlimited) whose billing is active or trialing. Canceled users count until `billingPeriodEnd` expires. Unlimited free users allowed without hitting cap.

---

### AD40: Webhook route order (`/public/stripe` before `/public`)

**Decision:** Hono catch-all ordering is load-bearing.

Hono's `app.route('/public', publicRoutes)` catches all `/public/*` paths. The Stripe webhook at `/public/stripe/webhook` must be mounted first. Future `/public/*` sub-routes must also be mounted before the catch-all.

---

### AD41: Custom tier uses contact flow (not self-service checkout)

**Decision:** Enterprise tier -- "Let's talk" button sends admin email via Resend.

The Custom tier (unlimited compute, 5 sessions, custom SLA) is enterprise-grade. Renamed from "Team" to "Custom" -- `getTierConfig()` auto-migrates legacy `displayName: 'Team'` to `'Custom'` on read. `POST /api/auth/contact-team` (rate-limited 1/hour) sends inquiry email. Button changes to "We'll get in touch" (disabled) after click. No Stripe checkout for Custom tier.

---

### AD42: Unauthenticated first setBucketName call (CF-010)

**Decision:** Worker-only access is the effective security boundary -- DO binding is not externally reachable.

The first `/_internal/setBucketName` request is unauthenticated because the container auth token (random UUID per DO lifecycle) is generated after this call. The endpoint is only reachable via the Worker's internal Durable Object binding, not from external callers. For orphaned R2 tokens from failed KV writes, token ID is logged at creation time for manual revocation via CF dashboard. A periodic sweeper is deferred as a future improvement.

---

## Related Documentation

- [Architecture — System Components](../architecture.md#system-components) - Component overview
- [Architecture — Design Rationale](../architecture.md#design-rationale) - Architectural principles
- [Security — Authentication Gate](../security.md#authentication-gate) - Security model
- [Authentication — Auth Modes](../authentication.md#authentication-modes) - CF Access vs Direct GitHub OAuth
- [Mobile — Scroll Stability](../mobile.md#scroll-stability) - Mobile terminal design decisions
