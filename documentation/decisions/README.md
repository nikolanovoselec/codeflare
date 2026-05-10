<!-- doc-allow-large -->
<!-- doc-discipline note: per documentation-discipline.md the per-ADR budget is 100 lines. 49 ADR slots exist (AD1-AD49). 11 slots are redirect stubs that preserve inbound AD-N references: 6 merged into a canonical sibling on 2026-05-03 (AD7→AD10, AD17→AD6, AD19→AD18, AD28→AD26, AD33→AD10, AD35→AD18), and 5 reclassified out of the decision log on 2026-05-09 per the "What is NOT an ADR" rule (AD9→configuration.md, AD23→inline+security.md, AD24→inline+security.md, AD25→inline+security.md, AD31→inline+security.md). 38 ADRs carry active content (AD38 is superseded but preserved per the immutability rule). The combined file is over the implicit 100×49 budget but each individual active ADR is under the per-ADR cap. Splitting into 49 files would scatter related decisions and break inbound AD-N references throughout the codebase, so the unified file is the deliberately chosen shape. -->

# Architecture Decisions

Architecture Decision Records for Codeflare. Each decision documents a design trade-off with rationale. Referenced as AD1-AD49 throughout the codebase and documentation. 38 ADRs carry active content (AD38 superseded by AD48); 11 anchors are redirects (6 merged 2026-05-03, 5 reclassified 2026-05-09 per the documentation-discipline "What is NOT an ADR" rule).

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
| [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity) | KV read-modify-write races and `collectMetrics` atomicity | Architecture |
| [AD7](#ad7-merged-into-ad10) | _merged into AD10 — pre-setup public endpoints_ | Security |
| [AD8](#ad8-root-container-no-internal-auth) | Root container, no internal auth | Architecture |
| [AD9](#ad9-ressource_tier-spelling) | _reclassified - RESSOURCE_TIER spelling moved to configuration.md_ | (redirect) |
| [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) | Bootstrap window: pre-setup endpoints, CSRF, and Worker-name derivation | Security |
| [AD11](#ad11-suffix-pattern-cors-with-credentials) | Suffix-pattern CORS with credentials | Security |
| [AD12](#ad12-kv-based-setup-lock-non-atomic) | KV-based setup lock (non-atomic) | Security |
| [AD13](#ad13-per-user-scoped-r2-tokens) | Per-user scoped R2 tokens | Security |
| [AD14](#ad14-never-auto---resync-on-bisync-failure) | Never auto-`--resync` on bisync failure | Storage |
| [AD15](#ad15-tabconfigschema-allows-arbitrary-command-strings) | TabConfigSchema allows arbitrary command strings | UI/Frontend |
| [AD16](#ad16-entrypointsh-1090-lines-complexity) | entrypoint.sh ~1090 lines complexity | Architecture |
| [AD17](#ad17-merged-into-ad6) | _merged into AD6 — `collectMetrics` atomicity_ | Architecture |
| [AD18](#ad18-vendored-creative-webgl-code-uses-untyped-patterns) | Vendored creative/WebGL code uses untyped patterns | UI/Frontend |
| [AD19](#ad19-merged-into-ad18) | _merged into AD18 — splash-cursor-logic.ts `as any` casts_ | UI/Frontend |
| [AD20](#ad20-toctou-in-containerlifecyclets) | TOCTOU in container/lifecycle.ts | Architecture |
| [AD21](#ad21-inconsistent-function-signatures) | Inconsistent function signatures | Architecture |
| [AD22](#ad22-jwks-30s-cache-staleness) | JWKS 30s cache staleness | Security |
| [AD23](#ad23-cors-origin-pattern-validation) | _reclassified - CORS admin-trust moved to inline + security.md_ | (redirect) |
| [AD24](#ad24-predictable-session-ids) | _reclassified - session ID rationale moved to inline + security.md_ | (redirect) |
| [AD25](#ad25-e2e-service-email-hardcoded) | _reclassified - E2E test fixture moved to inline + security.md_ | (redirect) |
| [AD26](#ad26-stress-test-rate-limit-bypass-integration-only) | Stress test rate-limit bypass (integration-only) | Security |
| [AD27](#ad27-server-side-prefix-delete) | Server-side prefix delete | Storage |
| [AD28](#ad28-merged-into-ad26) | _merged into AD26 — integration-only environment scoping_ | Security |
| [AD29](#ad29-container-secrets-as-env-vars) | Container secrets as env vars | Security |
| [AD30](#ad30-worker-name-from-host-header) | Worker name from Host header | Security |
| [AD31](#ad31-root-container-is-intentional) | _reclassified - root-container rationale moved to inline + security.md_ | (redirect) |
| [AD32](#ad32-encryption_key-is-optional) | ENCRYPTION_KEY is optional | Security |
| [AD33](#ad33-merged-into-ad10) | _merged into AD10 — pre-setup CSRF risk_ | Security |
| [AD34](#ad34-websocket-auth-bypass-of-hono-middleware) | WebSocket auth bypass of Hono middleware | Security |
| [AD35](#ad35-merged-into-ad18) | _merged into AD18 — splash-cursor-logic.ts old-style constructor_ | UI/Frontend |
| [AD36](#ad36-websocket-origin-check-is-optional-for-non-browser-clients) | WebSocket Origin check is optional for non-browser clients | Security |
| [AD37](#ad37-kv-as-billing-read-cache--signal-and-sync-cf-015) | KV as billing read cache -- Signal and Sync (CF-015) | Billing |
| [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) | GitHub OIDC replaces CF Access in SaaS mode | Billing |
| [AD39](#ad39-max-users-capacity-cap-counts-paid-slots-only) | Max users capacity cap counts paid slots only | Billing |
| [AD40](#ad40-webhook-route-order-publicstripe-before-public) | Webhook route order (`/public/stripe` before `/public`) | Billing |
| [AD41](#ad41-custom-tier-uses-contact-flow-not-self-service-checkout) | Custom tier uses contact flow (not self-service checkout) | Billing |
| [AD42](#ad42-unauthenticated-first-setbucketname-call-cf-010) | Unauthenticated first setBucketName call (CF-010) | Security |
| [AD43](#ad43-parse-and-exclude-vanishing-files-before-escalating-to-nuke) | Parse-and-exclude vanishing files before escalating to nuke | Storage |
| [AD44](#ad44-sdd-three-mode-autonomy-with-conservative-judgment-resolution) | SDD three-mode autonomy with conservative JUDGMENT resolution | Architecture |
| [AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list) | User overrides recorded as ADRs, not skip-list | Architecture |
| [AD46](#ad46-review-reality-filter-as-phase-5) | `/review` Reality Filter as Phase 5 (stateful per-finding triage history) | Architecture |
| [AD47](#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy) | PTY keepalive as safety net only, not the idle policy | Architecture |
| [AD48](#ad48-oauth-state-replaced-by-hmac-signed-stateless-token) | OAuth state replaced by HMAC-signed stateless token | Security |

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

### AD6: KV read-modify-write races and `collectMetrics` atomicity

**Decision:** Last-writer-wins is acceptable for KV state; `collectMetrics` keeps activity, health, and KV updates inside a single `alarm()` callback for natural atomicity.

Session PATCH/stop overlap is rare, rate limit off-by-one is minor, `lastAccessedAt` is best-effort. KV doesn't support atomic read-modify-write. Durable Objects would add latency for negligible consistency gain in this use case.

`collectMetrics` KV read-modify-write can revert session status. Mitigated: session status changes are only observed from the Dashboard, not during active terminal use. Sessions are never interrupted while in Terminal view.

**`collectMetrics` density** (formerly AD17): the function performs activity checking, health probing, and KV status updates in a single `alarm()` callback. Splitting into separate alarms would require coordination logic more complex than the current monolithic approach. The `alarm()` context provides natural atomicity across these tightly coupled operations — same theme as the KV race trade-off above (accept the cheap option until evidence forces change).

---

### AD7: Merged into AD10

**Status:** Merged into [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) on 2026-05-03. Pre-setup public-endpoint risk acceptance is now consolidated under the bootstrap-window ADR alongside the related CSRF trade-off. Inbound `AD7` references in the codebase remain valid; this entry preserves the anchor.

---

### AD8: Root container, no internal auth

**Decision:** Network isolation via DO proxy is sufficient.

Root needed for rclone mount. Container auth token (random UUID per DO lifecycle) validates all proxied requests. Network boundary: only the DO can reach the container's port 8080. Wildcard CORS inside container is safe -- it's internal-only.

---

### AD9: RESSOURCE_TIER spelling

**Status:** Reclassified on 2026-05-09. Naming/spelling preserved for backward compatibility is not an architectural decision; documentation lives at [configuration.md "Container Specs"](../configuration.md#container-specs) with a do-not-rename note. Inbound `AD9` references in the codebase remain valid; this entry preserves the anchor.

---

### AD10: Bootstrap window: pre-setup endpoints, CSRF, and Worker-name derivation

**Decision:** A narrow pre-setup window (seconds to minutes) is the unavoidable shape of a self-hosted bootstrap; auth and CSRF protections are intentionally relaxed during it, mitigated by short exposure, rate limiting, and the `setup:complete` KV flag.

`/api/setup/configure` is public before `setup:complete` is written to KV. This allows the deployer to configure their instance without pre-existing auth infrastructure (Cloudflare Access isn't set up yet — that's what setup configures).

**Trade-off**: A narrow window (seconds to minutes) exists where any actor could claim the deployment. Accepted because the target audience is self-hosted single-user/small-team deployments where the deployer is watching the process.

**Mitigation**: `setup:complete` KV flag prevents re-configuration. Rate limiting applies to setup routes.

**Future**: A one-time bootstrap secret injected at deploy time would close this window entirely.

**Pre-setup public endpoints** (formerly AD7): the same risk acceptance covers all pre-setup endpoints, not just `/configure`. Setup runs once during initial deploy. Pre-setup auth trusts a spoofable email header — bootstrap problem (can't require CF Access auth when CF Access isn't configured yet). Mitigated by rate limiting and the same short exposure window.

**Pre-setup CSRF** (formerly AD33): `createConditionalSetupAuth()` calls `next()` directly when setup is not complete, bypassing the `X-Requested-With` CSRF check. The pre-setup CSRF risk is accepted under the same rationale as above: the window is seconds to minutes, the self-hosted audience makes a drive-by CSRF attack from a third-party origin implausible, and the attacker would need to know the exact `workers.dev` URL during its unconfigured window. Adding `Origin` validation to the pre-setup path is a low-cost future hardening that complements the bootstrap-secret idea above.

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

### AD17: Merged into AD6

**Status:** Merged into [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity) on 2026-05-03. The `collectMetrics` `alarm()`-context atomicity rationale is now part of the consolidated KV-races ADR. Inbound `AD17` references in the codebase remain valid; this entry preserves the anchor.

---

### AD18: Vendored creative/WebGL code uses untyped patterns

**Decision:** Both isolated WebGL utilities and adapted creative-coding modules use `any` types where upstream TS definitions don't exist; refactoring offers no runtime benefit and risks regressing battle-tested visual code.

**`webgl-utils.ts`**: extensions like `OES_texture_half_float`, `WEBGL_lose_context`, etc. have no official TypeScript definitions. The `any` casts are isolated to this single utility file and the WebGL API surface is stable. Adding custom type definitions would be maintenance burden with no runtime benefit.

**`splash-cursor-logic.ts` `as any` casts** (formerly AD19): pointer-tracking objects and WebGL shader uniforms in this creative-coding module have no typed definitions upstream. The code is adapted from a visual-effect library; type assertions are confined to this isolated module.

**`splash-cursor-logic.ts` old-style constructor with `any` types** (formerly AD35): an old-style constructor function with `this: any` causes all downstream pointer/rendering functions to use `any` types — it's the root cause of the casts above. The constructor is adapted from the same visual-effect library. The entire module is isolated, has no production data path, and is invoked once per canvas element (not in a hot loop). Refactoring to a typed factory function would require significant rework of adapted code for marginal benefit.

**Common rationale across all three surfaces**: vendored creative/WebGL code is type-foreign by design. The boundary at the module's import surface is what matters; internal `any` is acceptable when the module is small, isolated, and has no production data path.

---

### AD19: Merged into AD18

**Status:** Merged into [AD18](#ad18-vendored-creative-webgl-code-uses-untyped-patterns) on 2026-05-03. The `splash-cursor-logic.ts` `as any` rationale is now part of the consolidated vendored-creative-code ADR. Inbound `AD19` references in the codebase remain valid; this entry preserves the anchor.

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

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive accepted with admin-trust rationale; documented inline at `src/lib/cors-cache.ts` (the `isAllowedOrigin` docstring) and summarized in [security.md "Static-Analyzer False Positives"](../security.md#static-analyzer-false-positives). Inbound `AD23` references in the codebase remain valid; this entry preserves the anchor.

---

### AD24: Predictable session IDs

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive (analyzer treats session IDs as auth tokens, but they are KV namespace keys; JWT is the auth gate); documented inline at `src/lib/constants.ts:6` and summarized in [security.md "Session ID Validation"](../security.md#session-id-validation). Inbound `AD24` references in the codebase remain valid; this entry preserves the anchor.

---

### AD25: E2E service email hardcoded

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive (test fixture flagged as hardcoded credential); documented inline at `src/lib/access.ts:166` and summarized in [security.md "Static-Analyzer False Positives"](../security.md#static-analyzer-false-positives). Inbound `AD25` references in the codebase remain valid; this entry preserves the anchor.

---

### AD26: Stress test rate-limit bypass (integration-only)

**Decision:** `STRESS_TEST_MODE=active` skips all rate limiting; the variable is scoped to the GitHub Actions `integration` environment only.

k6 stress tests share a single CF Access service token (single identity), so per-user rate limits (10/min sessions, 5/min containers, 30/min WebSocket) block meaningful load testing above ~5 VUs. Setting `STRESS_TEST_MODE=active` on the integration worker disables all rate-limit KV reads/writes at the top of the middleware, before any I/O. The value must be exactly `"active"` — any other value (including `"true"`) keeps limits enforced.

**Integration-only scoping** (formerly AD28): no CI-level guard is needed because GitHub Actions environment separation controls it. The variable is only set via the workflow scoped to the `integration` environment. Production deployments use `environment: production` and never receive this variable. A repo admin could theoretically set it for production, but that requires deliberate action — the same trust model that already governs every other production secret.

---

### AD27: Server-side prefix delete

**Decision:** Server-side list+batch delete via R2 S3 API instead of frontend recursive browse+delete.

Frontend folder deletion was subject to API rate limits (30/min browse, 20/min delete), causing failures for large folders. R2 has no native "delete prefix" API, and lifecycle rules (Days=0) take up to 24h. Server-side ListObjectsV2 + batch DeleteObjects (1000 keys/call) using `emptyR2Bucket()` is the fastest approach. No `[[r2_buckets]]` binding needed -- per-user dynamic buckets use account-level S3 credentials directly.

---

### AD28: Merged into AD26

**Status:** Merged into [AD26](#ad26-stress-test-rate-limit-bypass-integration-only) on 2026-05-03. The integration-only environment-scoping rationale is now part of the consolidated `STRESS_TEST_MODE` ADR. Inbound `AD28` references in the codebase remain valid; this entry preserves the anchor.

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

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive (missing `USER` directive flagged as privilege issue) accepted with network-isolation rationale; documented inline in `Dockerfile` (search `SAST-false-positive`) and summarized in [security.md "Static-Analyzer False Positives"](../security.md#static-analyzer-false-positives). Inbound `AD31` references in the codebase remain valid; this entry preserves the anchor.

---

### AD32: ENCRYPTION_KEY is optional

**Decision:** Optional encryption eases onboarding; operators accept plaintext KV storage as trade-off.

When ENCRYPTION_KEY is absent, LLM API keys, GitHub tokens, and Cloudflare API tokens are stored as plaintext JSON in KV with no warning. This is an intentional deployment-complexity trade-off. New deployers can get a running instance without generating and managing an encryption key. The target audience is self-hosted single-user/small-team deployments where the operator and the user are the same person. A startup warning when ENCRYPTION_KEY is absent is a recommended future improvement. Operators who want encryption set ENCRYPTION_KEY.

---

### AD33: Merged into AD10

**Status:** Merged into [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) on 2026-05-03. Pre-setup CSRF risk acceptance is now consolidated under the bootstrap-window ADR. Inbound `AD33` references in the codebase remain valid; this entry preserves the anchor.

---

### AD34: WebSocket auth bypass of Hono middleware

**Decision:** workerd constraint -- WS upgrades cannot use Hono middleware; parallel auth path is manually synchronized.

WebSocket upgrades must be intercepted before the Hono middleware chain (documented workaround for cloudflare/workerd#2319). This creates a parallel auth path replicating authentication, CORS, rate limiting, and subscription-tier gating. The duplication is explicit and documented. Any change to the Hono middleware auth chain must be manually mirrored in the WebSocket handler. SaaS tier gating tests for the parallel path are tracked as a fix item.

---

### AD35: Merged into AD18

**Status:** Merged into [AD18](#ad18-vendored-creative-webgl-code-uses-untyped-patterns) on 2026-05-03. The old-style-constructor `this: any` rationale is now part of the consolidated vendored-creative-code ADR. Inbound `AD35` references in the codebase remain valid; this entry preserves the anchor.

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

**Status:** Superseded by [AD48](#ad48-oauth-state-replaced-by-hmac-signed-stateless-token) (2026-05-09) - oauth_state mechanism replaced

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

### AD43: Parse-and-exclude vanishing files before escalating to nuke

**Category:** Storage

**Decision:** When bisync fails with `lstat: no such file or directory`, parse the error output to identify the vanishing file, add it to a session-scoped exclusion filter, and retry — before escalating to `nuke_corrupted_r2_files`.

The race condition is: rclone lists a file at path X, then the file is deleted (by an agent, MCP auth cache cleanup, or any ephemeral write) before rclone can copy it. The file is gone; there is nothing to recover or repair. Nuking R2 objects is the wrong response — it targets corruption (wrong encryption key, size mismatch, bad object metadata), not transience. Retrying the exact same bisync command without excluding the file would hit the same error. The correct response is:

1. Parse `failed to open source object.*no such file` from rclone output.
2. Append `- <path>` to `/tmp/rclone-recovery-filters.txt` (session-scoped, never synced to R2).
3. Clear bisync lock files.
4. Retry the same operation (max 3 attempts per call site).

Non-workspace files are auto-excluded because they are config/cache files that will regenerate. Workspace files (user code) are not auto-excluded — they get a plain retry on the assumption the file reappeared after a save completed. Known ephemeral files (`.claude/mcp-*.json` — MCP auth cache with millisecond lifetime) are statically excluded from `RCLONE_FILTERS_COMMON` to prevent the race from occurring at all.

The recovery applies at both call sites: `establish_bisync_baseline()` (startup) and `bisync_with_r2()` (daemon). The filter file is initialized empty on every container start via `init_recovery_filters()`.

---

### AD44: SDD three-mode autonomy with conservative JUDGMENT resolution

**Category:** Architecture

**Decision:** Codeflare ships SDD (Spec-Driven Development) as a Pro feature with three autonomy modes (`interactive`, `auto`, `unleashed`), with a universal enforcement layer (`rules/spec-discipline.md`) inlined into every agent's instructions, and conservative JUDGMENT auto-resolution that never overwrites spec intent. The spec-reviewer and doc-updater agents are project-agnostic and detect `sdd/` automatically.

**Context:** A previous SDD workflow shipped as a skill + agent pair, but real-world use on a downstream project revealed several failure modes:

- changes.md grew to 2,517 lines / 159 entries because the spec-reviewer agent treated every commit as a "verification pass" event
- 16 of 91 requirements were marked Deprecated as a graveyard for never-built ideas instead of actual deprecations
- Status fields contained multi-line prose with commit SHAs
- Implementation details (hex codes, CSS class names, function names, file paths, env vars) leaked into REQs in 800+ places
- 35 of 37 Implemented REQs had no test coverage (the spec lied about verification)
- The micro-fix loop produced 485 commits for 5,976 lines of source code
- The doc-updater agent was hardcoded to Codeflare's specific file structure and couldn't help other projects
- Codex users got no agent enforcement (no agent files), Copilot users got no skill loading (skill mechanism is opaque)

**Alternatives considered:**

1. **Single mode** with strict enforcement and no auto-resolution. Rejected: too rigid for users who want walk-away workflows.
2. **Two modes** (interactive + auto). Rejected: users who trust the agent fully need a third mode that handles JUDGMENT calls without escalating; but auto would be unsafe if it auto-resolved JUDGMENT.
3. **Three modes with "code wins" auto-resolution in unleashed**. Rejected after design review (opus ultrathink): "code wins" overwrites spec intent and turns the spec into a passive description of whatever the code happens to do, defeating "single source of truth".
4. **Per-run change cap** (max 50 fixes per run). Rejected: contradicts the walk-away intent of unleashed mode.
5. **Dry-run gate by default** for /sdd clean. Rejected for unleashed mode: contradicts walk-away. Replaced by PR-based safety net (unleashed creates a new branch + PR; user reviews when they return).

**Rationale:**

- **Three modes** map to three user types: new SDD users (interactive), solo developers in steady-state (auto), trusting power users with PR review habits (unleashed).
- **Conservative JUDGMENT auto-resolution in unleashed**: doc-vs-spec conflicts mark BOTH sides as `Partial` with `Notes:` (never overwrite intent); oversized REQs shrink in place by extracting implementation prose to docs (never split, since LLMs cannot reliably preserve meaning when splitting); fake-Deprecated REQs move to README "Out of Scope" section (never delete, satisfying the existing "never delete" rule).
- **PR-based safety net** for unleashed mode: walk-away users get reviewable surface (PR description has full audit log), and rollback is "close the PR" — the working branch is never touched.
- **Universal enforcement layer** (`rules/spec-discipline.md`) inlined into every agent's instructions file ensures Codex (no agent files) and Copilot (no skill loading) get the same discipline as Claude.
- **Project-agnostic agent refactor**: spec-reviewer and doc-updater drop hardcoded Codeflare domain mappings and read `documentation/README.md` to discover the project's actual file structure. Both agents gate on `sdd/` existence — on non-SDD projects (vibe-coding mode) they exit silently and the post-push `git-push-review-reminder` hook also emits no reminder, so `git push` proceeds with zero review agents. `doc-updater` no longer auto-scaffolds `documentation/README.md` on non-SDD projects (previous behavior was too aggressive). Opt-in to the full workflow is binary: run `/sdd init` and all three review agents (code-reviewer, spec-reviewer, doc-updater) fire on every push; don't, and none do.
- **Sequential execution** (spec-reviewer first, doc-updater second) prevents race conditions on shared files.
- **2-round commit-cycle limit** with `[sdd-clean]` tag exclusion catches micro-fix spirals without crashing the rescue command itself.
- **`enforce_tdd` rule** (renamed from `auto_demote`, default `true`): spec-reviewer auto-demotes `Implemented` REQs without test coverage to `Partial`, detects `Planned`/`Partial` REQs whose source code exists but has no corresponding test (code-without-test finding), and runs test-quality heuristics (AC-count vs test-count ratio, tautology detection, skipped-test detection) on every push. Forced `true` in unleashed mode where the PR review is the safety net.
- **Plan Mode mandate**: `/sdd init`, `/sdd edit`, and `/sdd add` emit `EnterPlanMode` directives so spec-to-code transitions always go through Plan Mode (a built-in Claude Code primitive). The `/plan` custom slash command is removed — Plan Mode replaces it.
- **`Implements REQ-X-NNN` annotation convention**: source files must carry a comment naming the REQ they implement (e.g., `// Implements REQ-AUTH-001`). spec-reviewer greps for these annotations when running coverage checks; they are the bridge between source code and the spec.
- **Template scaffolding** in `references/templates/` lets `/sdd init` bootstrap any project with no external dependencies.

**Trade-offs accepted:**

- The unleashed mode's conservative defaults will sometimes mark a REQ as `Partial` when the user knows it's `Implemented` (e.g., visual design REQs without unit tests). The user records the override as a new ADR with an `Overrides: {rule_id}:{REQ-ID}` header and it's not re-attempted.
- The PR-based safety net adds friction for users who want true zero-touch (the PR has to be merged manually). Acceptable trade-off for the rollback story.
- The forbidden-content allowlist requires per-project tuning for projects that legitimately use vendor names, protocol names, or HTTP status codes in their REQs. Configurable via `sdd/config.yml`.

**Related requirements:**

- REQ-AGENT-005 (Pro mode preseed inventory)
- REQ-AGENT-006 (preseed bundle generation)
- REQ-AGENT-007 (per-agent adaptation pipeline)
- REQ-AGENT-014 (manifest as single source of truth)
- REQ-AGENT-021 (SDD workflow as Pro feature) — added in this overhaul

**Implementation references:**

- `preseed/agents/claude/rules/spec-discipline.md` (universal enforcement layer)
- `preseed/agents/claude/skills/spec-driven-development/SKILL.md` (workflow + modes documentation)
- `preseed/agents/claude/skills/spec-driven-development/references/templates/` (scaffolding templates for /sdd init)
- `preseed/agents/claude/agents/spec-reviewer.md` (project-agnostic spec-reviewer agent)
- `preseed/agents/claude/agents/doc-updater.md` (project-agnostic doc-updater agent)
- `preseed/agents/claude/commands/sdd.md` (sub-command dispatcher with help screen)

---

### AD45: User overrides recorded as ADRs, not skip-list

**Category:** Architecture

**Decision:** Remove `sdd/.user-overrides.md`. When the user resolves an automated SDD finding as "keep current behavior — this mechanism IS the contract", the resolution is recorded as a real ADR in `documentation/decisions/` carrying an `Overrides: {rule_id}:{REQ-ID}` header. spec-reviewer and doc-updater grep `documentation/decisions/**/*.md` for that header at the start of every run and skip matching findings — same machine behavior as the legacy skip list, but the architectural decision is now first-class.

**Context:** AD44 introduced the SDD review pipeline with `sdd/.user-overrides.md` as the place to record JUDGMENT resolutions ("don't re-attempt this fix; the user said no"). On a downstream `ai-news-digest` session, spec-reviewer flagged cookie-attribute mechanism leakage in REQ-AUTH-002 AC 1 (`__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`). The clean resolution was "the cookie attributes ARE the security contract — security reviewers grep these strings; rewriting to user-observable language loses the contract surface". Recording that as a one-line `User note:` field in `sdd/.user-overrides.md` worked for the agent but failed the human:

- The override file is invisible to anyone reading the codebase. It doesn't appear in any index, isn't referenced from `documentation/decisions/README.md`.
- Each entry is a load-bearing architectural choice ("we treat cookie attributes as the security contract") buried in a config-shaped file alongside test-skip notes.
- "Rationale" lives in a free-text User note field with no structure — no Context/Decision/Rationale/Consequences scaffolding, no link to the affected REQ, no date the decision was revisited.
- Six months later, nobody remembers what's in `.user-overrides.md` and re-litigates the same call because they couldn't find prior context.

**Alternatives considered:**

1. **Keep `sdd/.user-overrides.md` and just cross-link from `documentation/decisions/README.md`.** Rejected: still bifurcates decision storage. The cross-link rots.
2. **Keep the file but require structured fields (Context/Decision/Rationale/Consequences).** Rejected: this is the ADR template — at that point we are reinventing ADRs in `sdd/`, in the wrong lane.
3. **Move overrides into REQ frontmatter as a per-REQ `OverridesRules:` field.** Rejected: scatters the decision. Reading the REQ doesn't tell you *why* the rule was overridden — that's an architectural decision, not a REQ attribute. Future REQ refactors might drop the field unintentionally.
4. **The chosen approach: ADRs with `Overrides:` headers.** Same skip semantics, decision now lives where decisions live.

**Rationale:**

- ADRs already exist for this exact purpose in `documentation/decisions/`: structured, indexed, discoverable, treated as first-class history.
- The `**Overrides:**` line is a one-line parser anchor — spec-reviewer's grep pattern is `^(?:\*\*)?Overrides:?(?:\*\*)?\s*(.+?)\s*(?:\*\*)?$` (tolerates both plain and the project's universal bold-wrapped ADR field convention), splitting on commas — same skip key shape (`{rule_id}:{target_id}`) the legacy file used.
- Decisions can be revised with full Status history (`Accepted` → `Superseded by AD-M`) following existing ADR patterns. The legacy skip list had no such notion.
- ADRs are listed in `documentation/decisions/README.md`'s decision index, surfacing the override decisions in the same place where every other architectural call lives. Future contributors find them on first reading.
- `/sdd clean` migrates existing entries automatically: each line in any project's existing `sdd/.user-overrides.md` becomes a new ADR (Context/Decision/Rationale/Consequences scaffold pre-filled with the legacy `User note:` field; TODO placeholders in Rationale/Consequences asking the user to expand on first read), and the legacy file is deleted in the same commit. Tagged `[sdd-clean] migrate user-overrides to ADRs (issue codeflare#266)` so spec-reviewer's round-counter excludes it.

**Trade-offs accepted:**

- Migration adds one extra commit on the next `/sdd clean` for any project with existing override entries. Acceptable: it's a one-time cost, the migration is fully automatic, and each migrated ADR carries a TODO marker so the user knows to expand the rationale.
- ADRs are slightly heavier-weight than a one-line skip entry. Intentional: the friction is the point. If an override is "easy" to add, it gets added thoughtlessly. If it requires writing a real ADR, it gets thought about, which is what we want for an architectural decision.
- The `Overrides:` header is a soft contract — projects that hand-edit ADRs to remove the header silently lose the skip behavior. Acceptable: same shape as every other markdown-based agent contract in the project.

**Migration:**

- spec-reviewer Step 0d: greps `documentation/decisions/**/*.md` for `**Overrides:**` (regex `^(?:\*\*)?Overrides:?(?:\*\*)?\s*(.+?)\s*(?:\*\*)?$` — tolerates plain and bold-wrapped) instead of reading `sdd/.user-overrides.md`. Legacy file (if present) triggers a HIGH finding asking for migration.
- doc-updater Step 0c: same change.
- spec-discipline.md: drops `## User overrides` section, replaces with `## User overrides via ADRs` documenting the `Overrides:` header pattern.
- `/sdd clean` step 6/6a: auto-migrates legacy entries to ADRs.
- `/sdd init`: was never scaffolding `.user-overrides.md`; no change needed.
- SKILL.md, /sdd command help, and `documentation/decisions/README.md` AD44 trade-off bullet: drop references to the legacy file.

**Related requirements:**

- REQ-AGENT-021 (SDD workflow as Pro feature)

**Implementation references:**

- `preseed/agents/claude/rules/spec-discipline.md` (User overrides via ADRs section)
- `preseed/agents/claude/agents/spec-reviewer.md` (Step 0d, Phase 3 interactive override flow)
- `preseed/agents/claude/agents/doc-updater.md` (Step 0c)
- `preseed/agents/claude/commands/sdd.md` (USER OVERRIDES help section, /sdd clean step 6a migration)
- `preseed/agents/claude/skills/spec-driven-development/SKILL.md` (spec structure diagram)

**Issue:** [codeflare#266](https://github.com/nikolanovoselec/codeflare/issues/266)

---

### AD46: `/review` Reality Filter as Phase 5

**Status:** Accepted (2026-05-05)

**Context:** Empirical data from 5 successive `/review` cycles on the `ai-news-digest` codebase showed that finding count does not decrease as the codebase improves: cycle 4 fixed 67 real issues; cycle 5 still produced 71 active findings of which only 10 were real. Repeat-offender churn (`processOneChunk too long` flagged 3 cycles, `Date.now() lacks Clock seam` flagged 4 cycles), aspirational-rule clusters (15 `?raw` text-match files persisting after the rule was added), and severity inflation (HIGH used as the agent's internal scale, not user-impact) accounted for ~85% of cycle 5's noise. Triage cost was ~45 minutes for findings that should have taken 5 minutes. The pipeline's only memory was Phase 4's AD filter, which only catches findings that have an explicit ADR justifying the exact pattern - too narrow to absorb the long tail of "decided not to fix" calls.

**Decision:** Insert a new Phase 5 (Reality Filter) between Phase 4 (AD filtering) and the LLM verification + interactive triage phases. Phase 5 is a single Task agent that reads the AD-active findings, prior triage history (`sdd/.review-decisions.md`), full ADR bodies, MCP memory, recent git log, and `sdd/changes.md`, and re-evaluates every finding against five questions:

- **Q1** repeat-offender drop (location+category match in `.review-decisions` with no commits since)
- **Q2** memory-says-no drop (contradicts an MCP feedback memory)
- **Q3** cluster aggregation (≥3 same-category findings collapse into ONE cluster finding triaged once)
- **Q4** user-impact bar (re-evaluate severity against data-loss / money / access / security / CI-break - below-bar findings demote to a "Tech-Debt Surfaced" section, still triaged)
- **Q5** spec-vs-shipped truth-test (doc-drift findings must be verified by reading cited source)

Phase 5 produces a single output file `09-real-findings.md` with three sections: Real Findings, Tech-Debt Surfaced, and an Auto-Filtered audit log. The audit log is mandatory - every drop has a one-line reason keyed by which question dropped it. The orchestrator early-stops if Real + Tech-Debt totals are zero.

A new persistent file `sdd/.review-decisions.md` is committed to the repo and append-written by Phase 8 with every Defer/Ignore/Tech-Debt decision. Cluster-finding triage decisions expand to one entry per location at write time so Q1's per-location lookup remains a literal-string match in cycle N+1. The file is the **primary** source of triage history; the local-only `/home/user/Temporary/Review/` corpus is no longer load-bearing.

**Alternatives considered:**

1. **Inject memory into the 6 Phase 2 reviewers.** Rejected as the v1 approach: bigger blast radius (modifies 6 agent prompts), harder to measure, doesn't address repeat-offender churn or aspirational-rule clusters. Phase 5 is the incremental win; memory injection is a possible follow-up if Phase 5 doesn't shrink output enough.
2. **Extend Phase 4 AD filter to also drop findings whose REQ-X-NNN backlinks have a recent triage decision.** Rejected: AD filter's job is categorical ("this pattern is intentional"), not per-finding instance triage. Conflating the two muddies both filters and makes future debugging harder.
3. **Tighten the 6 reviewer agents' severity rubrics so they produce fewer findings.** Rejected: agents have an implicit incentive to produce findings (zero findings reads as "didn't try"). Tightening the rubric is a reasonable follow-up but doesn't solve the stateful-memory problem - cycle N still has no memory of cycle N-1's decisions. Phase 5 solves both.
4. **Write triage decisions into the existing `sdd/.review-needed.md`.** Rejected: `.review-needed.md` is for findings escalated for human review (cleared on resolution) - mixing it with permanent triage history blurs the file's purpose and breaks the "cleared on resolution" semantics.
5. **Promote durable `.review-decisions` patterns to ADRs automatically after N cycles.** Rejected: turns ADRs into "anything I deferred 3 times" instead of intentional design choices. User manually promotes when a pattern proves durable; the manual step preserves the architectural-decision concept.

**Rationale:**

- The proposal is empirically grounded: a hand-run of the Phase 5 prompt on cycle-5 data filtered 71 active findings to 10 real findings (14% pass rate) - the 4 source-bug fixes that actually mattered all survived. The fixture is publicly available at `https://gist.github.com/nikolanovoselec/060f6d3cbebe889864360835ee375a41` for regression testing.
- ADR vs `.review-decisions` is a clean lane separation: ADRs document permanent design choices (categorical, by rule, via `Overrides:` headers); `.review-decisions` records per-cycle, per-finding triage history (instance-level, by location+category). The two are complementary, not alternatives. Combining both as filter inputs is what makes 71 → 10 achievable.
- Single-file output (`09-real-findings.md` with three sections) keeps the cycle self-contained for debugging. The audit log lives next to the surviving findings so spot-checking a drop is one read, not two.
- Phase 5 is a single Task agent, mirroring the existing single-agent shape of Phases 3, 4, 6, 8, 9. No new architectural pattern.
- MCP knowledge graph is the primary memory system; `code-reviewer`'s tool allowlist is extended with `mcp__memory__search_nodes` and `mcp__memory__open_nodes` so the Reality Filter agent can query it directly. File-based `~/.claude/projects/.../memory/MEMORY.md` is a fallback when MCP is unreachable.
- Q3's cluster-aggregation threshold of 3 is the smallest "this is a pattern, not individual issues" count. Below 3 the user fixes the violations one by one; at 3+ the user wants a sweep PR. This replaces an earlier proposal of a magic ≥5 threshold with binary drop-to-appendix - the magic number was unjustified and the appendix had no sunset, so aspirational rules would stay quarantined forever.

**Trade-offs accepted:**

- Phase 5 adds one Task agent per `/review` invocation. On the cycle-5 fixture the agent ran in ~7 minutes and consumed ~150K tokens with ~47 file reads. Treated as "a 7th reviewer that synthesizes the other 6," the per-cycle cost increase is ~17%; the saving on triage time is ~40 minutes per cycle. Net positive after the first cycle.
- File renames are not tracked (literal path matching in Q1). Renames are rare; if one happens, the prior decision will not match and the finding gets surfaced fresh. The audit log makes this visible and the user can re-defer if appropriate. `git log --follow` was considered and rejected as overengineering for a rare event.
- The 3-cycle expectation (active CRITICAL/HIGH/MEDIUM trends to zero by the third successive run) is informational only - shown in the Phase 5 Cycle Health header. It is not a hard gate; cycle 3 with non-zero CRITICAL/HIGH/MEDIUM still completes normally. The user uses the metric to decide whether the filter needs re-tuning or new code is genuinely introducing real bugs faster than they get fixed.
- Phase numbering shifts: old phases 5-9 become 6-10. File numbering shifts: old `08-active-findings.md` stays as Phase 4's output, new `09-real-findings.md` is Phase 5, LLM-verified is `10-llm-verified.md`, triage is `11-triage-results.md`. One-time documentation churn; the new numbering is monotonic and each phase produces exactly one output number.

**Migration:**

- Existing projects with prior `/review` runs do not auto-migrate the local `/home/user/Temporary/Review/2026*/09-triage-results.md` corpus into `sdd/.review-decisions.md`. First run in the new pipeline starts the persistent log fresh; cycle 1 will produce no Q1 drops. The user can backfill manually if desired by hand-converting the most relevant prior decisions.
- The Reality Filter agent uses the `code-reviewer` subagent type with extended MCP memory tools. No new agent type is introduced.
- `/review` Phase 5 is mandatory; the orchestrator-level "Active = 0 → STOP" gate moves from Phase 4's tail to Phase 5's tail (so the cycle counter and audit log are always written, even on clean cycles).

**Related requirements:**

- REQ-AGENT-015 (`/review` command for multi-perspective codebase review) - AC1 and AC5 updated to reflect the Reality Filter pass and persistent `.review-decisions.md`.

**Implementation references:**

- `preseed/agents/claude/commands/review.md` (Phase 5 Reality Filter)
- `preseed/agents/claude/agents/code-reviewer.md` (MCP memory tools added to allowlist)
- `preseed/agents/claude/rules/spec-discipline.md` (`sdd/.review-decisions.md` added to "Files alongside sdd/")
- `preseed/agents/claude/skills/spec-driven-development/SKILL.md` (spec structure diagram)

**Issue:** [codeflare#271](https://github.com/nikolanovoselec/codeflare/issues/271)

---

### AD47: PTY keepalive as safety net only, not the idle policy

**Status:** Accepted (2026-05-09)

**Context:** The host process inside each container ran a per-PTY reaper at `PTY_KEEPALIVE_MS = 2700000` (45 min). When a session's WebSocket clients all disconnected (dashboard navigation 60s grace, backgrounded mobile tab dropping WS, network blip, laptop sleep), `Session.detach()` armed a 45-min `setTimeout`; on expiry the PTY was SIGTERMed, killing the `bash -l` and the child `claude` process. On reconnect, `Session.start()` re-spawned `bash -l` which re-launched `claude` from `.bashrc` (a fresh process with empty in-memory state, forcing the user to `/resume` from the on-disk JSONL transcript). Users with `sleepAfter` set to 2h experienced what felt like "Claude Code restarted" after roughly an hour of idle, even though the container itself was nowhere near the configured timeout. The reaper was unspec'd (no REQ, no prior ADR), introduced at initial release and never tuned.

The original justification considered was per-PTY RAM cleanup when one tab in a multi-tab session went idle while sibling tabs kept the container hot. That premise does not hold in codeflare: each tab is its own session with its own container DO and its own `lastInputAt`, so there is no "sibling tabs keep container alive while orphan PTY hoards RAM" case. Per-tab orphaning cannot occur because the container's `collectMetrics` reaches its idle threshold whenever no input is happening; at that point the entire container is stopped and every PTY in it dies along with it.

**Decision:** Keep the per-PTY reaper but reframe its role as a pure **safety net** for the case where `lastInputAt` tracking gets stuck (terminal server bug, stuck activity polling, broken `/activity` endpoint), and raise the floor to 120 minutes (equal to the maximum user-configurable `sleepAfter`). Concretely, change `PTY_KEEPALIVE_MS` default from `2700000` (45 min) to `7200000` (120 min) in `host/src/server.ts` and `host/src/session.ts`.

**Alternatives considered:**

1. **Remove the reaper entirely.** Rejected: leaves no recourse if `collectMetrics` ever silently fails to stop a container with a stuck `lastInputAt`. The cost of keeping the reaper is one `setTimeout` per orphaned session.
2. **Make `PTY_KEEPALIVE_MS` track the user's `sleepAfter` preference dynamically.** Rejected: requires plumbing `sleepAfter` from the container DO through `buildEnvVars` into the host process and re-arming the timer on preference change. The 120-min floor matches the maximum `sleepAfter` and saves the plumbing. A user with `sleepAfter=15m` whose container has stuck `lastInputAt` gets a slightly longer-lived orphan PTY than ideal, but the tradeoff is acceptable for a safety net that is not expected to fire in normal operation.
3. **Make the reaper kill only the agent process while keeping the shell alive, so context persists.** Rejected: the agent's in-memory state (conversation history, tool-use cache) is what `/resume` reloads from JSONL; killing only the agent and re-spawning still loses in-memory state. The user-facing symptom is identical to today's behavior, with extra plumbing for no gain.
4. **Bump to a smaller floor (e.g. 90 min).** Rejected: arbitrary midpoint with no principled basis. 120 min has a clear justification: it equals the maximum `sleepAfter` so the reaper is guaranteed not to fire before the container's authoritative idle-stop has had a chance to run.

**Rationale:**

- The user-facing idle contract is REQ-SESSION-004's `sleepAfter` (5m / 15m / 30m / 1h / 2h). The PTY reaper sits *below* that contract and must never undercut it. Setting the floor at the maximum `sleepAfter` ensures it cannot fire before the authoritative policy.
- The reaper's value is purely defensive: it prevents a single orphaned PTY from outliving its container forever in pathological scenarios (e.g., `lastInputAt` polling dies but the container DO doesn't notice). With a 120-min floor it still does that job; it just doesn't fire on the happy path.
- The change is one constant in two files; risk is bounded.

**Trade-offs accepted:**

- Users with `sleepAfter` < 2h will, in the rare case of stuck `lastInputAt`, see PTY orphans last up to 120 min instead of 45 min. The container would also be stuck (because `collectMetrics` is the trigger for both stop paths), so the practical impact is "container survives 75 extra minutes when something is broken". Acceptable because the user can manually stop the session from the dashboard.
- The default is hardcoded; a future operator who hits memory pressure on a long-orphaned PTY can still override via `PTY_KEEPALIVE_MS` env var. No new user-facing setting is added.

**Related requirements:**

- REQ-SESSION-004 (idle containers sleep after configurable timeout): the authoritative idle policy. AD47 documents that the PTY-level reaper is subordinate to and must never undercut this REQ.
- REQ-SESSION-005 (input-based idle detection via `lastInputAt`): the signal `collectMetrics` uses; the reaper is the safety net for cases where this signal gets stuck.

**Implementation references:**

- `host/src/server.ts:64` (`PTY_KEEPALIVE_MS` default)
- `host/src/session.ts:146` (`_ptyKeepaliveMs` fallback)
- `host/src/session.ts:296-319` (`detach()` arms the timer; `keepAliveTimeout` fires `kill()`)

---

### AD48: OAuth state replaced by HMAC-signed stateless token

**Status:** Accepted (2026-05-09)

**Supersedes:** [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) (oauth_state mechanism only; the broader GitHub OIDC-over-CF-Access decision in AD38 remains valid)

**Context:** AD38 specified that the OAuth CSRF state parameter was carried as an HttpOnly cookie (a random UUID, 5-minute TTL). The cookie was validated server-side by comparing the query-param value returned by GitHub against the stored cookie value. iOS WebKit's Intelligent Tracking Prevention (ITP) and third-party cookie restrictions in private-browsing modes silently drop the state cookie before the GitHub callback completes, breaking the OAuth flow for a meaningful fraction of mobile and privacy-conscious users.

**Decision:** Replace the HttpOnly state cookie with a stateless HMAC-signed token. The token is structured as `nonce.iat.sig` where `nonce` is a random value, `iat` is the issued-at Unix timestamp, and `sig` is an HMAC-SHA256 signature over `nonce.iat` using `OAUTH_JWT_SECRET`. The callback handler recomputes the signature and rejects tokens whose `iat` is outside a 30-minute window. No server-side state is stored; no cookie is required for the CSRF check.

**Alternatives considered:**

1. **Keep the cookie, add `SameSite=None; Secure`** to survive cross-site redirects. Rejected: does not help on iOS ITP, which drops third-party cookies regardless of SameSite attribute on the state-checking round-trip.
2. **Store state in KV with a 5-min TTL.** Rejected: AD38 explicitly chose cookies over KV to avoid eventual consistency lag on the Cloudflare edge. HMAC-signed tokens remove the need for any server-side state and are strictly better on both axes.
3. **State in the `state` query param only, validated by nonce replay prevention in KV.** Rejected: same KV consistency concern as option 2.

**Rationale:**

- Stateless HMAC tokens are immune to ITP and private-browsing cookie restrictions because they carry no server-side state -- nothing to look up, nothing to lose on a blocked cookie jar.
- The `iat`-window bound (30 min) gives the same CSRF protection as a short-lived cookie: a state token cannot be replayed after it expires.
- `OAUTH_JWT_SECRET` is already required for `codeflare_session` signing (AD38); reusing it for state signing adds no new secret-management surface.
- Failure path is explicit: state verification failure redirects to `/?error=session-expired` rather than a generic 500.

**Trade-offs accepted:**

- A compromised `OAUTH_JWT_SECRET` now also allows forging state tokens (not just session cookies). The attack surface increase is minimal -- an attacker with the secret could already forge sessions, which is the higher-value target.
- The 30-min window is longer than the previous 5-min cookie TTL. The trade-off is intentional: the broader window accommodates slow mobile networks and interrupted OAuth flows that previously forced re-login.

**Related requirements:** REQ-AUTH-005 (GitHub OAuth CSRF protection)

**Implementation references:**

- `src/routes/github-oauth.ts` (`generateState()`, `verifyState()`)

---

### AD49: context-mode delivered as preseed plugin, not runtime install

**Status:** Accepted (2026-05-10)

**Context:** [context-mode](https://github.com/mksglu/context-mode) reduces Claude Code's context-window pressure by routing tool calls through hooks that summarize before content lands in the conversation. It ships as an npm package whose Claude Code plugin metadata is normally written into the user's `~/.claude/plugins/` and `~/.claude/settings.json` by `claude plugin install context-mode`. During the first integration attempt (PR codeflare#293, since closed), a research subagent invoked that installer in the host's session and the upstream installer wrote `"matcher": null` for the SessionStart hook entry, which Claude Code 2.1.138 rejects with "Expected string, but received null", silently disabling every other hook in the file. The bug is recoverable for a single user but unacceptable as default behavior delivered to all paid users.

**Decision:** Ship context-mode in two layers with separate gating.

The **MCP server layer** exposes `ctx_*` helper tools to the agent so they can be called manually regardless of session mode. How the MCP server is registered depends on tier: Custom + Pro users receive it via the `mcpServers` block declared in the preseed `plugin.json`, which Claude Code's plugin loader reads automatically when the plugin folder is present. Non-Custom users have no plugin folder on disk, so `entrypoint.sh` injects the `mcpServers["context-mode"]` entry directly into `~/.claude.json` at session start. Both paths invoke the bare `context-mode` binary installed globally in the Docker image at build time (`npm install -g context-mode@<ver>` reading the version from `preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json`); no source is redistributed since the npm package is fetched from the public registry during image build.

The **plugin folder layer** delivers `~/.claude/plugins/context-mode/` (containing the plugin manifest and `hooks/hooks.json`) as a preseed asset, R2-bisync'd into the user's bucket only when the user's effective tier is `unlimited` (Custom) AND session mode is `advanced` (Pro). The R2 seed filter in `src/lib/r2-seed.ts:getConfigsForMode` strips the entire `.claude/plugins/context-mode/` subtree from the deploy set when the user's tier or mode does not qualify.

The container's `entrypoint.sh` detects the preseeded plugin manifest. When the manifest is present (Custom + Pro), the plugin loader has already registered the MCP server via `plugin.json`; `entrypoint.sh` skips the `~/.claude.json` injection entirely to avoid duplicate registration and instead adds `context-mode: true` to `enabledPlugins` so the four hooks (PreToolUse, PostToolUse, PreCompact, SessionStart) auto-route tool calls. When the manifest is absent (non-Custom tier), the entrypoint injects `mcpServers["context-mode"]` into `~/.claude.json` using the version pin and skips `enabledPlugins` (no auto-routing for non-Custom users).

The MCP layer is what users observe as "context-mode is always available"; the plugin layer is the premium behavior change reserved for Custom-tier Pro users.

**Alternatives considered:**

1. Runtime install via `claude plugin install context-mode`. Rejected: triggers the upstream `matcher: null` self-registration bug, breaks every other hook on session start, and ties Codeflare's hook config integrity to upstream release timing.
2. Runtime jq-merge of mcpServers + SETTINGS_CONFIG hooks in `entrypoint.sh` (PR codeflare#293's approach, closed). Rejected: configuration-as-shell-heredoc is harder to review than configuration-as-data, and doesn't match the operational model already used for `codeflare-hooks` and `codeflare-memory` (preseed plugins).
3. Use the upstream `claude-plugins-official` marketplace. Rejected: relies on an out-of-Codeflare registry path; we want plugin updates to land via Dependabot bumps to a single version pin reviewed and CI-tested before deploy.
4. Ship the npm package contents under preseed instead of relying on `npx`. Rejected: bloats R2 per user and offers no operational benefit since `npx -y context-mode@<pinned>` cache-resolves after first invocation.

**Rationale:**

- The preseed model is identical to how `codeflare-hooks` and `codeflare-memory` already ship: plugin-shaped data delivered via R2 bisync, enabled in `~/.claude.json`'s `enabledPlugins`, discovered by Claude Code on session start. Symmetry across all three plugins reduces operational surprise.
- Tier-gating at the seed-filter layer (worker-side) means the plugin folder never appears on disk for non-qualifying users. There is no need to sanitize a user's settings.json after the fact, and there is no reachable code path through which a non-qualifying user receives the plugin.
- The matcher-null bug (the entrypoint registered hooks correctly, but the upstream installer corrupted `~/.claude/settings.json` for the host user) is structurally impossible under this model: we never call `claude plugin install`, and the entrypoint never writes `matcher: null`.
- Plugin updates are a Dependabot PR bumping the version pin in `hooks/hooks.json` (mechanical four-line diff), reviewed and CI-gated like any other dependency.

**Trade-offs accepted:**

- The preseed plugin's `hooks/hooks.json` carries the pinned version four times (one per event command string). A future generator could fan this out from a single pin.
- First-call latency: resolved by codeflare#309. The Dockerfile bakes `npm install -g context-mode@<pinned>` into the image and patches the bundles, so the binary is on PATH from session start with no first-call download delay.
- A tier downgrade requires a reconcile pass (already triggered by `/api/preferences` PATCH and Stripe webhook handlers) to remove the plugin folder from R2. Until reconcile fires, a freshly-downgraded user could still load context-mode on next session, bounded to the next PATCH or webhook event.

**License posture (ELv2):** context-mode is licensed under Elastic License 2.0, which is source-available but explicitly prohibits providing the software as a hosted or managed service that gives third parties access to substantial features of the software. Codeflare's integration is sized to stay within ELv2's permitted-use envelope on three axes.

*No redistribution.* Codeflare does not redistribute context-mode source. The npm package is fetched from the npm registry at Docker image build time and installed globally; users receive a pre-built image, not the source. Our preseed contains only plugin metadata (`plugin.json`, `README.md`) which is our own configuration code, not context-mode's source.

*No commercial automation.* Commercial (non-Custom) users receive `mcpServers["context-mode"]` registration so `ctx_*` tools appear in the agent's tool list, but our preseed contains no skill, rule, agent definition, command, or hook that instructs Claude to invoke those tools. The agent's tool-selection is its own, exactly as it is for any other listed MCP tool. Codeflare provides no automation or routing layer for commercial users.

*Custom-tier auto-routing is admin-only.* The Custom (`unlimited`) tier with the auto-routing hooks is, in current product policy, an admin-only sandbox used for testing and personal development. ELv2 fully permits personal use. If the Custom tier ever opens to paying third parties with the auto-routing hooks active, that crosses the ELv2 line and requires either a commercial license from the upstream author (mksglu) or removal of the hook layer.

A future contributor who adds a SessionStart-style ctx_* nudge, a context-mode skill, an `Implements ctx_*` rule, or any other automation that pushes commercial users toward context-mode functionality must update this ADR before merging.

**Related requirements:** REQ-AGENT-005 (Pro mode skills/rules/agents/MCP, now also covers tier-gated context-mode delivery)

**Implementation references:**

- Preseed assets: `preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json` (bare manifest; matches `codeflare-memory`/`codeflare-hooks` shape), `preseed/agents/claude/plugins/context-mode/README.md`
- Manifest: `preseed/agents/claude/manifest.json` (two entries with `modes: ["advanced"]`)
- Runtime wiring: `entrypoint.sh` registers the `context-mode` MCP server in `~/.claude.json` (`command: "context-mode"`, no args) and appends four `context-mode hook claude-code <event>` commands to `~/.claude/settings.json` when the plugin manifest is present and `SESSION_MODE=advanced`. Mirrors the wiring path used by `codeflare-memory` and `codeflare-hooks`.
- Build-time install: the Dockerfile runs `npm install -g context-mode@<ver>` reading the version from `preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json`, then prepends a 2-line `createRequire` shim to both `cli.bundle.mjs` and `server.bundle.mjs` in the global install.
- esbuild ESM-bundle bug (codeflare#309): without the shim, `ctx_execute` and `ctx_batch_execute` fail on every dynamic `require('node:*')` with `Dynamic require of "node:fs" is not supported` because esbuild does not inject a CommonJS-require polyfill in `--format=esm` output. The bug reproduces under both Node and Bun ESM loaders, so a runtime swap from `npx` to `bunx` does not fix it. The build-time patch is the durable fix until upstream `mksglu/context-mode` ships a release with the esbuild banner.
- R2 seed tier filter: `src/lib/r2-seed.ts` (`getConfigsForMode(mode, contextModeEnabled)`, `getPreseedKeysNotInMode`, `reconcileAgentConfigs`)
- Worker-side tier gate: `src/routes/container/lifecycle.ts` (`contextModeEnabled = effectiveTier === 'unlimited' && sessionMode === 'advanced'`)
- Worker-side reconcile call sites: `src/routes/preferences.ts`, `src/routes/storage/seed.ts`, `src/routes/stripe-webhook.ts`
- Container-side detection: `entrypoint.sh` (`CONTEXT_MODE_MANIFEST` existence check; conditional `mcpServers["context-mode"]` jq merge; conditional `enabledPlugins["context-mode"]: true`)
- Tests: `src/__tests__/lib/r2-seed-context-mode.test.ts`, `host/__tests__/entrypoint-context-mode.test.js`

---

## Related Documentation

- [Architecture — System Components](../architecture.md#system-components) - Component overview
- [Architecture — Design Rationale](../architecture.md#design-rationale) - Architectural principles
- [Security — Authentication Gate](../security.md#authentication-gate) - Security model
- [Authentication — Auth Modes](../authentication.md#authentication-modes) - CF Access vs Direct GitHub OAuth
- [Mobile — Scroll Stability](../mobile.md#scroll-stability) - Mobile terminal design decisions
