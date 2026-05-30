
# Architecture Decisions

Architecture Decision Records for Codeflare. Each decision documents a design trade-off with rationale. Referenced as AD1-AD64 throughout the codebase and documentation. 49 ADRs carry active content (AD4 superseded by AD56 + AD57; AD38 superseded by AD48; AD45 and AD50 superseded by AD51); 11 anchors are redirects (6 merged 2026-05-03, 5 reclassified 2026-05-09 per the documentation-discipline "What is NOT an ADR" rule).

**Audience:** Developers

---

## Decision Index

| ID | Decision | Category |
|----|----------|----------|
| [AD1](#ad1-one-container-per-session) | One container per session | Architecture |
| [AD2](#ad2-container-id-format) | Container ID format | Architecture |
| [AD3](#ad3-per-user-r2-buckets) | Per-user R2 buckets | Architecture |
| [AD4](#ad4-periodic-rclone-bisync) | _superseded by AD56 (cadence) + AD57 (shutdown budget)_ | (superseded) |
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
| [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) | Vendored creative/WebGL code uses untyped patterns | UI/Frontend |
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
| [AD37](#ad37-kv-as-billing-read-cache----signal-and-sync-cf-015) | KV as billing read cache -- Signal and Sync (CF-015) | Billing |
| [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) | GitHub OIDC replaces CF Access in SaaS mode | Billing |
| [AD39](#ad39-max-users-capacity-cap-counts-paid-slots-only) | Max users capacity cap counts paid slots only | Billing |
| [AD40](#ad40-webhook-route-order-publicstripe-before-public) | Webhook route order (`/public/stripe` before `/public`) | Billing |
| [AD41](#ad41-custom-tier-uses-contact-flow-not-self-service-checkout) | Custom tier uses contact flow (not self-service checkout) | Billing |
| [AD42](#ad42-unauthenticated-first-setbucketname-call-cf-010) | Unauthenticated first setBucketName call (CF-010) | Security |
| [AD43](#ad43-parse-and-exclude-vanishing-files-before-escalating-to-nuke) | Parse-and-exclude vanishing files before escalating to nuke | Storage |
| [AD44](#ad44-sdd-three-mode-autonomy-with-conservative-judgment-resolution) | SDD three-mode autonomy with conservative JUDGMENT resolution | Architecture |
| [AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list) | _superseded by AD51 -- override mechanism ripped out_ | (superseded) |
| [AD46](#ad46-review-reality-filter-as-phase-5) | `/review` Reality Filter as Phase 5 (stateful per-finding triage history) | Architecture |
| [AD47](#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy) | PTY keepalive as safety net only, not the idle policy | Architecture |
| [AD48](#ad48-oauth-state-replaced-by-hmac-signed-stateless-token) | OAuth state replaced by HMAC-signed stateless token | Security |
| [AD49](#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install) | context-mode delivered as preseed plugin, not runtime install | Architecture |
| [AD50](#ad50-unified-adr-file-with-structural-doc-allow-large-exemption) | _superseded by AD51 -- doc-allow-large hatch ripped out_ | (superseded) |
| [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) | Rip out six overengineered SDD framework features | Architecture |
| [AD52](#ad52-graphify-mcp-available-everywhere-discipline-advanced-only) | Graphify MCP available everywhere, discipline advanced-only | Architecture |
| [AD53](#ad53-graphify-hot-reload-wrapper-with-multi-repo-sentinel-tracking) | Graphify hot-reload wrapper with multi-repo sentinel tracking | Architecture |
| [AD54](#ad54-vault-directory-must-use-a-non-hidden-basename) | Vault directory must use a non-hidden basename | Storage |
| [AD55](#ad55-codeflare-brands-the-vault-editor-via-preseed-managed-stylesmd) | Codeflare brands the vault editor via preseed-managed STYLES.md | Architecture |
| [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers) | 15-minute bisync cadence with manual triggers (fan-out safe under newer-mtime-wins) | Storage |
| [AD57](#ad57-135-second-shutdown-budget-for-final-bisync) | 135-second shutdown budget for final bisync | Storage |
| [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) | Sonnet (not haiku) for memory capture, plus jq-prefilter and chunked-scratchpad pipeline | Memory |
| [AD59](#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key) | Zero-UI vault encryption with per-session DO-storage key | Security |
| [AD60](#ad60-pi-memory-capture-reuses-the-ad58-contract-and-transcript-prefilter) | Pi memory capture reuses the AD58 contract and transcript prefilter | Memory |
| [AD61](#ad61-pi-review-ships-as-a-dedicated-native-skill) | Pi `/review` ships as a dedicated native skill (Claude commands do not deploy to Pi) | Architecture |
| [AD62](#ad62-pi-model-name-genericization-with-codeflare_memory_model-lever) | Pi model-name genericization with `CODEFLARE_MEMORY_MODEL` lever | Architecture |
| [AD63](#ad63-pi-safe-graphify-updatesh-is-fail-closed-and-two-step) | Pi `safe-graphify-update.sh` is fail-closed and two-step | Architecture |
| [AD64](#ad64-durable-review-lanes-load-extensions-additively-behind-the-noextensions-shield) | Durable review lanes load extensions additively behind the `noExtensions` shield | Agents |

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

**Category:** Architecture
**Status:** Superseded by AD56 (cadence rationale) and AD57 (shutdown budget).

**Decision:** Background daemon every 60s + final sync on shutdown. Superseded cadence rationale: see AD56 (now 15min). Superseded shutdown budget rationale: see AD57 (now 120s watchdog within a 135s DO destroy budget).

Local disk for all file operations (fast I/O). Bisync daemon runs in background, syncing changes bidirectionally; manual triggers via SIGUSR1 (storage panel Sync-now button). SIGINT/SIGTERM trap runs final bisync before exit. Alternative (s3fs FUSE) was fragile and slow -- see Lessons Learned #1.

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

**Status:** Reclassified on 2026-05-09. Naming/spelling preserved for backward compatibility is not an architectural decision; documentation lives at [configuration.md "Container Specs"](../lanes/configuration.md#container-specs) with a do-not-rename note. Inbound `AD9` references in the codebase remain valid; this entry preserves the anchor.

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

**Status:** Merged into [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) on 2026-05-03. The `splash-cursor-logic.ts` `as any` rationale is now part of the consolidated vendored-creative-code ADR. Inbound `AD19` references in the codebase remain valid; this entry preserves the anchor.

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

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive accepted with admin-trust rationale; documented inline at `src/lib/cors-cache.ts` (the `isAllowedOrigin` docstring) and summarized in [security.md "Static-Analyzer False Positives"](../lanes/security.md#static-analyzer-false-positives). Inbound `AD23` references in the codebase remain valid; this entry preserves the anchor.

---

### AD24: Predictable session IDs

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive (analyzer treats session IDs as auth tokens, but they are KV namespace keys; JWT is the auth gate); documented inline at `src/lib/constants.ts:6` and summarized in [security.md "Session ID Validation"](../lanes/security.md#session-id-validation). Inbound `AD24` references in the codebase remain valid; this entry preserves the anchor.

---

### AD25: E2E service email hardcoded

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive (test fixture flagged as hardcoded credential); documented inline at `src/lib/access.ts:166` and summarized in [security.md "Static-Analyzer False Positives"](../lanes/security.md#static-analyzer-false-positives). Inbound `AD25` references in the codebase remain valid; this entry preserves the anchor.

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

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive (missing `USER` directive flagged as privilege issue) accepted with network-isolation rationale; documented inline in `Dockerfile` (search `SAST-false-positive`) and summarized in [security.md "Static-Analyzer False Positives"](../lanes/security.md#static-analyzer-false-positives). Inbound `AD31` references in the codebase remain valid; this entry preserves the anchor.

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

**Status:** Merged into [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) on 2026-05-03. The old-style-constructor `this: any` rationale is now part of the consolidated vendored-creative-code ADR. Inbound `AD35` references in the codebase remain valid; this entry preserves the anchor.

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
- **Template scaffolding** in `references/templates/` lets `/sdd init` bootstrap any project with no external dependencies.

**Trade-offs accepted:**

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

**Status:** Superseded by AD51 (2026-05-12). The override-via-ADR mechanism described below was ripped out alongside five other overengineered SDD features. There is now no per-rule override mechanism at all -- if a finding keeps re-firing, fix the rule or the REQ.

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

**Related requirements:** REQ-AUTH-002 (GitHub OAuth CSRF protection)

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
- Bun for executor perf: Bun is installed globally in the image (`npm install -g bun`). context-mode autodetects Bun on first run and uses it as the JS/TS subprocess runtime for `ctx_execute` / `ctx_batch_execute`. Bun starts short-lived JS subprocesses faster than Node, which adds up across hook-heavy sessions. No spec contract on the perf delta - if a Bun release regresses, context-mode falls back to Node. Bun is a perf-only addition; the shim above is what fixes #309.
- esbuild ESM-bundle bug (codeflare#309): without the shim, `ctx_execute` and `ctx_batch_execute` fail on every dynamic `require('node:*')` with `Dynamic require of "node:fs" is not supported` because esbuild does not inject a CommonJS-require polyfill in `--format=esm` output. The bug reproduces under both Node and Bun ESM loaders, so a runtime swap from `npx` to `bunx` does not fix it. The build-time patch is the durable fix until upstream `mksglu/context-mode` ships a release with the esbuild banner.
- R2 seed tier filter: `src/lib/r2-seed.ts` (`getConfigsForMode(mode, contextModeEnabled)`, `getPreseedKeysNotInMode`, `reconcileAgentConfigs`)
- Worker-side tier gate: `src/routes/container/lifecycle.ts` (`contextModeEnabled = effectiveTier === 'unlimited' && sessionMode === 'advanced'`)
- Worker-side reconcile call sites: `src/routes/preferences.ts`, `src/routes/storage/seed.ts`, `src/routes/stripe-webhook.ts`
- Container-side detection: `entrypoint.sh` (`CONTEXT_MODE_MANIFEST` existence check; conditional `mcpServers["context-mode"]` jq merge; conditional `enabledPlugins["context-mode"]: true`)
- Tests: `src/__tests__/lib/r2-seed-context-mode.test.ts`, `host/__tests__/entrypoint-context-mode.test.js`, `host/__tests__/context-mode-version-pin.test.js`

### AD50: Unified ADR file with structural doc-allow-large exemption

**Status:** Superseded by AD51 (2026-05-12). The `<!-- doc-allow-large -->` hatch mechanism this ADR relied on was ripped out. The unified ADR file is preserved for the same anchor-stability reason, but the budget rule no longer offers a per-file opt-out -- the file-size finding is now a known LOW that the operator defers via `sdd/.review-decisions.md` if at all.

**Context:** The `documentation-discipline.md` per-ADR soft budget is 100 lines. 49 ADR slots exist (AD1-AD49). 11 slots are redirect stubs that preserve inbound AD-N references (6 merged 2026-05-03, 5 reclassified 2026-05-09). 38 ADRs carry active content; each individual active ADR is under the 100-line per-ADR cap. The combined file exceeds the implicit aggregate budget. doc-updater would ordinarily flag this as a MEDIUM finding.

**Decision:** Keep all ADRs in a single `decisions/README.md` file. Originally relied on `<!-- doc-allow-large: AD50 -->` for explicit exemption; that mechanism is now gone, so the file-budget finding simply persists as known tech-debt.

**Rationale:** AD-N identifiers are referenced throughout the codebase (`decisions/README.md#ad44`, `decisions/README.md#ad47`, etc.) in source comments, doc cross-references, and ADR Supersedes fields. Splitting into 49 files would require renaming every inbound anchor from `README.md#ad-N` to `adr-N.md#ad-N` across the entire codebase and documentation corpus - a mechanical change with high surface area and no product value. Individual ADRs are under their per-ADR budget; the file-level overage is inherent to the count of active decisions, not to any single ADR being too long. The correct granularity for the budget rule is per-ADR, not per-file.

**Consequences:** The Decision Index at the top of this file remains the navigation entry point. Per-ADR budget enforcement still applies: any new ADR that exceeds 100 lines must be split or compressed.

---

### AD51: Rip out six overengineered SDD framework features

**Status:** Accepted (2026-05-12)
**Supersedes:** AD45, AD50

**Category:** Architecture

**Context:** A third-wave architect review of the SDD framework after the second-wave fixes surfaced 30 findings. Per-finding triage on the highest-severity ones revealed that several of the framework features themselves -- not bugs in their implementation but the features as designed -- were adding surface area without proportionate value. User feedback during triage was unambiguous: "overengineered bullshit, remove all commit category idiocity", "wtf is this overengineered shit now". The decision was to rip the six worst offenders before continuing to act on architect findings on what remained.

**Decision:** Remove the following six features from the SDD framework:

1. **ADR Overrides skip-list** (AD45). The `Overrides: {rule}:{target}` ADR header that spec-reviewer / doc-updater parsed at the start of every run to skip matching findings. If a finding keeps re-firing, fix the underlying rule or REQ -- no per-rule bypass.
2. **Hatch markers + audit** (AD50 and supporting machinery). `<!-- sdd-allow-large -->`, `<!-- doc-allow-large -->`, and `<!-- doc-template-exempt -->` markers plus the Pass 6 / Pass 10 ADR-cross-check audit. Oversized files produce a finding; the operator defers via `sdd/.review-decisions.md` if appropriate.
3. **REQ split-proposal mode**. spec-reviewer draft files at `sdd/.split-proposals/{REQ-ID}.md` consumed by `/sdd clean` on `**Status:** Approved`. Oversized REQs shrink in place; the user splits manually when actually needed.
4. **Out-of-Scope collision check**. Full-spec pass cross-referencing `## Out of Scope` bullets against shipped REQs with content-word-overlap heuristics. Spec drift is normal-quality work, not a separate detector.
5. **Anti-spiral "category" matching**. Round counter required `≥2 commits on the same target REQ-ID or category` parsed from the commit subject's `fix(spec): {category}` infix. Simplified to `≥2 of the last 3 lane-scoped commits` -- same protection, no parser.
6. **`Implements REQ-X-NNN` annotation enforcement**. code-reviewer flagged source files implementing a REQ's behavior without the annotation. spec-reviewer CQ-2 cross-walked source annotations against REQ ACs. Annotations remain a human-discoverability convention but are no longer flagged. The test-name-based coverage check is the load-bearing signal.

doc-discipline drops from twelve passes to ten (deleted Pass 6 hatch audit and Pass 10 hatch overuse). spec-discipline drops CQ-2, CQ-4, and CQ-6 (kept and renumbered CQ-1/CQ-3/CQ-5 to CQ-1/CQ-2/CQ-3). `/sdd clean` drops the legacy `sdd/.user-overrides.md` migration step. `/sdd mode` no longer lists recent ADR overrides.

**Consequences:** Smaller surface for both the agent author and the human operator. AD45 and AD50 are marked Superseded but preserved for anchor stability. Architect findings that still need addressing on the remaining surface (six HIGH fixes from the third-wave review) are tracked separately. The framework now has: `/sdd init`, `/sdd clean`, `/sdd mode`, the three-agent PR-boundary pipeline, transition state, and the three discipline rules (spec / doc / tdd). That is the entire surface.

**Issue:** Architect review triage 2026-05-12; user authorization in conversation.

---

### AD52: Graphify MCP available everywhere, discipline advanced-only

**Status:** Accepted (2026-05-14)

**Category:** Architecture

**Context:** Graphify (upstream `graphifyy` Python package, Apache-2.0) turns a folder into a queryable knowledge graph and exposes it via an MCP server (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`). Integrating it into Codeflare required a tier-gating decision: every preseed plugin so far chose between "advanced-only" (codeflare-memory, codeflare-hooks) and "custom-tier-only" (context-mode via AD49). Graphify did not fit either bucket cleanly. The MCP server itself is harmless ambient capability that any session benefits from when the user reaches for it; the discipline that says "use the graph before grepping" is what produces token savings and is what changes agent behaviour.

**Decision:** Split delivery on a discipline-vs-capability axis, not on tier:

- **Plugin folder + `plugin.json` + MCP server registration**: ships in both `default` and `advanced` session modes. The `graphify` MCP server is registered in `~/.claude.json` whenever the preseed manifest is present, which is every paid tier.
- **SessionStart context-injection hook, PostToolUse-on-clone triage hook, `graph-first.md` rule, and `graphify/SKILL.md`**: ship in `advanced` session mode only. These are the load-bearing pieces that teach the agent to use the graph proactively.

Tier-gating is not part of the decision: graphify ships uniformly across standard, advanced, max, and custom paid tiers. The discipline gating is keyed only on session mode.

**Consequences:**
- Default session mode users CAN reach for graphify by name (CLI on PATH, MCP tools exposed) but do not get nudged toward it. No SessionStart reminder, no triage on clone, no rule in `~/.claude/rules/`.
- Advanced session mode users get the full discipline: the agent reads `GRAPH_REPORT.md` at session start when a graph exists, prompts on clone, prefers focused MCP queries over Grep for architecture questions, and gets a PreToolUse soft-nudge when reaching for Grep/Glob (or the context-mode grep-equivalents `ctx_search`/`ctx_batch_execute`) in a repo that has a graph.
- Image cost (~220 MB for Python + tree-sitter wheels) is paid by every container regardless of mode, justified by one-time build cost vs. universal capability.
- Coexists cleanly with context-mode (AD49) without depending on it. Graphify's own subagent-chunking model is the load-bearing context-bounding mechanism for `/graphify` extraction; context-mode routing through `ctx_execute` is bonus per-subagent savings when present. The `enforce-ctx-mode.sh` Bash whitelist gets `graphify` added (in custom tier where the file ships) but no behaviour depends on that whitelist for other tiers. The graph-first soft-nudge hook covers both tier paths: `Grep`/`Glob` matchers fire in non-custom tier where those tools are not denied; `mcp__context-mode__ctx_search`/`ctx_batch_execute` matchers fire in custom tier where the agent is routed through ctx for grep-equivalents.
- The MCP server registration is keyed on `GRAPHIFY_MANIFEST` presence rather than `SESSION_MODE`, so the "capability everywhere" half is enforced by the manifest gate rather than a mode check.
- Persistence model: graphify artifacts (`graphify-out/`) live in the repo, not in R2. Repo owners commit `graphify-out/graph.json`, `GRAPH_REPORT.md`, and `graph.html` to git; the working tree gets them on clone and contributors inherit both the graph and a browser-openable interactive visualization for free. Repos without push permission keep the graph local-only and ephemeral. R2 bisync explicitly excludes `**/graphify-out/**`. The container image registers the graphify semantic merge driver globally (`git config --global merge.graphify.driver`) so any repo that wires `graphify-out/graph.json merge=graphify` in its `.gitattributes` gets auto-resolution of concurrent `graph.json` edits without manual JSON intervention. SKILL guidance instructs the agent on first build to add the canonical `.gitignore` block (17 patterns: five regenerable build outputs under `graphify-out/`, ten `.graphify_*` working-tree intermediates the build creates mid-run, two per-machine markers) and the merge-driver attribute line to `.gitattributes`. The full pattern list and rationale live in `/graphify` SKILL.md note 3; `documentation/container.md` mirrors the explanation.
- Obsidian stub vault is deliberately gitignored: `graphify-out/obsidian/` is a 2000+-file per-node markdown vault that gives an Obsidian-app user a familiar graph-browse UI, but every `graphify update .` rerun rewrites centrality + community-label frontmatter across all those files, producing PR diffs in the thousands of files for one structural change. The standalone `graph.html` covers the casual-browse use case in any browser without needing Obsidian installed, and a developer who actually wants the Obsidian workflow can regenerate the stub vault locally from `graph.json` in seconds. The trade-off keeps PR signal clean at the cost of one local command for the rare power-user.

**Alternative considered:** Match context-mode (AD49) and gate the whole thing on custom tier. Rejected: graphify's MCP query tools are cheap, structurally bounded, and useful even when no discipline rule pushes the agent toward them. Hiding the capability behind a tier wall would have been more conservative but would have wasted the build-time install for the 99% of paid users who are not on custom tier.

**Issue:** REQ-AGENT-023; PR #354.

---

### AD53: Graphify hot-reload wrapper with multi-repo sentinel tracking

**Status:** Accepted (2026-05-14)

**Category:** Architecture

**Context:** Two problems surfaced after AD52 shipped. First, upstream `graphify.serve` `sys.exit(1)`s when `graphify-out/graph.json` is missing at startup. Codeflare sessions start with an empty workspace and a user typically clones one or more repos mid-session, so the MCP server died on every fresh session and there was no way to restart Claude Code without losing the container (killing the session kills the Durable Object). Second, sessions typically hold 2-3 cloned repos; the MCP server is one persistent process and has no native notion of "the current repo." When the agent moved between repos via Bash `cd`, ctx_execute, git/gh clone, or simply by editing files in a different directory, the wrapper bound G to whichever path resolved first at startup and never switched, silently returning wrong-repo answers.

**Decision:** Two coupled mechanisms:

1. **`graphify-mcp-lazy.py` wrapper** ships to both `default` and `advanced` session modes (ambient capability, paired with the MCP registration per AD52). The wrapper monkey-patches `graphify.serve._load_graph` to return a `LazyGraph` (subclass of `nx.DiGraph` so `isinstance` checks in graphify and networkx pass cleanly). LazyGraph starts empty, then a daemon watcher thread polls the active graph file every `GRAPHIFY_POLL_SECONDS` (default 2s); on mtime change, it builds a fresh `nx.DiGraph` and swaps the underlying `_node`/`_adj`/`_pred`/`_succ`/`graph` dict members atomically under a lock so concurrent readers (graphify's tool handlers running on the main thread) never see a half-mutated graph. The tool list stays static (the upstream 7 tools); only G's contents swap.

2. **`graphify-active-repo.sh` PostToolUse hook** ships to `advanced` session mode only. It writes the agent's current repo root to a sentinel at `~/.cache/codeflare-hooks/graphify-active-cwd`. Matcher set is `Bash | Edit | Write | Read | NotebookEdit | mcp__context-mode__ctx_execute | mcp__context-mode__ctx_execute_file | mcp__context-mode__ctx_batch_execute` because the cwd signal differs by tool surface and tier: Bash uses Claude Code's session cwd which updates on `cd`; Edit/Write/Read provide an absolute `file_path` that the hook walks up to find a `.git/` or `graphify-out/` ancestor; ctx_execute variants need the shell snippet parsed for `cd X` because Claude Code's session cwd never sees changes inside ctx_execute subshells. The wrapper polls the sentinel and rebinds G when it changes. When the sentinel is absent (default mode, or before the first hook fires), the wrapper falls back to the freshest mtime across `CODEFLARE_WORKSPACE/*/graphify-out/graph.json`.

**Consequences:**
- Sessions starting empty no longer require a Claude Code restart to bring graphify online. The MCP shows `connected · 7 tools` from the first prompt; tool calls return empty (`Nodes: 0`) until a graph appears.
- Multi-repo precision is advanced-only. Default-mode users typing `/graphify` explicitly for a single repo get correct answers via the freshest-mtime fallback; default-mode users juggling multiple graphs would get wrong-repo answers, but that path is rare-by-design (no SKILL or clone-prompt is preseeded to push them toward multi-graph builds).
- Per-branch graphs are not supported. The wrapper reads `<repo>/.git/HEAD` only for an informative stderr log line on rebind. Users run `graphify update` after a checkout; the wrapper's mtime watcher picks up the rebuild within 2 seconds. Forking graphify upstream to model branches was rejected as out of scope and orthogonal to the codeflare integration.
- Reader-safety is load-bearing: an earlier draft used `G.clear()` + `G.add_nodes_from()` and crashed graphify tool handlers mid-iteration under the exact workload the wrapper was built for (`graphify update` immediately followed by `query_graph`). The atomic dict-swap pattern resolves this without forking graphify or wrapping the tool handlers.
- Sentinel race under concurrent batch-execute hooks is acceptable: last writer wins, wrapper converges within 2 seconds. Hook only rewrites on change so mtime churn is bounded.

**Alternative considered:** Spawn one MCP server per repo on first `cd` into it. Rejected because Claude Code does not natively support per-cwd MCP servers, the spawn/teardown logic would have to live in `entrypoint.sh` with `proc` watching, and the wrapper-based approach lets a single process handle every repo in the session at the cost of one short stderr log line per rebind.

**Alternative considered:** Pass repo path as an explicit MCP tool argument on every call. Rejected because graphify's upstream tool handlers query G in closure and would need rewriting; relying on the agent to remember a `repo_path` arg every invocation would silently degrade in practice.

**Issue:** REQ-AGENT-023.

---

### AD54: Vault directory must use a non-hidden basename

**Category:** Storage

**Status:** Active

**Context:** The original vault path was `/home/user/.user_vault/`. SilverBullet's disk walker (`server/disk_space_primitives.go` `FetchFileList`) aborts the directory walk immediately when the root directory's basename begins with `.`, returning an empty file listing even when notes are present on disk. This is not a configurable behaviour in SilverBullet 2.8 -- it is hardcoded in the Go source. The result was that opening the vault in the editor showed no files at all despite a populated directory on disk.

**Decision:** The vault directory is renamed to `/home/user/Vault/` (non-hidden basename). All references in entrypoint.sh, bisync filters, preseed scripts, agent rules, Worker route, audits, and tests are updated in the same commit. The internal identifier `init_user_vault()` and the `--as user_vault` global-graph tag are preserved (no manifest migration needed). R2 is a clean cutover for the single existing user; prior `.user_vault/` content in R2 is abandoned rather than migrated.

**Constraint (permanent):** The vault directory must never be renamed to a dot-prefixed basename. Any future relocation of the vault must preserve a non-hidden basename or the SilverBullet disk walker will silently return an empty file list. This constraint is documented in `documentation/lanes/vault.md#directory-layout` and enforced by the `host/__audits__/entrypoint-vault.audit.js` structural audit (checks that the supervisor command references `$HOME/Vault`, not `$HOME/.user_vault` or any other hidden path).

**Consequences:**
- SilverBullet correctly walks and indexes all vault files after rename.
- The path `/home/user/Vault/` is visible in `ls /home/user/` output (non-hidden), which is the desired UX: users can see the vault directory without `ls -a`.
- The bisync filter gains `+ Vault/**` (replacing `+ .user_vault/**`). Filter order is preserved: vault include comes before the global `- **/graphify-out/**` exclude so the vault's own `graphify-out/` subdirectory is included in sync.

**Alternative considered:** Configure SilverBullet via `SB_SPACE_FOLDER` or a command-line flag to skip the hidden-basename check. Rejected: the check is not configurable in SilverBullet 2.8's Go source; patching the binary was out of scope.

**Alternative considered:** Mount the dot-prefixed directory into a non-hidden path via bind mount or symlink. Rejected: adds fragile entrypoint complexity and bisync would still see the original dot-prefixed path. A clean rename is simpler and permanent.

**Related REQ:** REQ-VAULT-001.

---

### AD55: Codeflare brands the vault editor via preseed-managed STYLES.md

**Category:** Architecture

**Status:** Active

**Context:** SilverBullet supports custom editor themes via a `STYLES.md` page at the vault root tagged `#meta/styles`. Without a managed theme, the editor renders SilverBullet's default visual language, which has no codeflare identity (different palette, different fonts, different border treatments from the rest of the codeflare UI). The vault is a user-owned space inside a user-owned R2 bucket; allowing per-user theme customisation would let the editor drift visually from the rest of codeflare, but defaulting to no theme would make the editor feel grafted-on rather than native.

**Decision:** `STYLES.md` is a preseed-managed, always-overwritten file. Codeflare owns its content; `init_user_vault()` syncs it from `/opt/silverbullet-preseed/STYLES.md` on every container boot, gated so identical files are not rewritten. Users cannot customise the editor theme by editing `STYLES.md` in-place inside SilverBullet -- edits are silently reverted on the next session start. Theme changes must go through a `preseed/silverbullet/STYLES.md` change in the repo. The shipped theme mirrors the codeflare design tokens (`web-ui/src/styles/design-tokens.css`): zinc dark palette, Inter sans / JetBrains Mono code, blue accent (HSL 217 / 91% / 60%).

The initial implementation defined only `--cf-*`-namespaced custom properties on `:root`, on the (incorrect) assumption that SilverBullet would consume them. SilverBullet 2.x reads its own `--root-*`, `--ui-accent-*`, `--top-*`, `--button-*`, `--editor-*`, `--modal-*`, `--panel-*`, `--editor-wiki-link-*` variables instead (verified against `client/styles/theme.scss` in the 2.8.0 source), so the original theme had zero visual effect: STYLES.md shipped but the editor still rendered SilverBullet's default palette. The fix wires all SB variables under `html[data-theme="dark"]` and keeps the `--cf-*` palette as a local token layer the SB variables consume. The `--cf-*` indirection is retained for readability (`--root-background-color: var(--cf-bg-base)` is easier to maintain than a raw hex value sprinkled across 80 declarations).

**Consequences:**
- The vault editor reflects codeflare branding consistently across users and sessions; switching between codeflare UI and SilverBullet feels native rather than grafted.
- Users who want custom styling cannot achieve it without forking the project or opening a PR to `preseed/silverbullet/STYLES.md`. This is the explicit trade-off: brand consistency over per-user theming.
- Preseed theme updates propagate to all users on next session boot with no per-user migration.
- The always-overwrite contract is documented in `documentation/lanes/vault.md` (three-tier durability) and in the in-vault `README.md` so users discover the constraint before hand-editing.
- The variable-namespace lesson is preserved in-source as a header comment in `STYLES.md` so future maintainers do not regress to a `--cf-*`-only theme; visual-regression smoke is documented in `documentation/lanes/vault.md` First-session Expectations (zinc base, blue accent, Inter body, JetBrains Mono code).

**Alternative considered:** Ship `STYLES.md` as recreate-if-missing only, preserving user edits. Rejected: the same user who deletes `index.md` or `CONFIG.md` and expects automatic recovery (the always-overwrite contract for those files) would not expect `STYLES.md` to behave differently. Mixing tiers within the same set of preseed pages was deemed more confusing than the cost of disallowing in-place theme edits.

**Alternative considered:** Use SilverBullet's `theme:` setting in `.silverbullet/config.yaml` instead of a separate `STYLES.md` page. Rejected: the bootstrap `config.yaml` carries only the runtime essentials (indexPage, defaultMode); a 200-line CSS payload belongs in a markdown page where the `#meta/styles` tag is SilverBullet's canonical extension point.

**Related REQ:** REQ-VAULT-001 (AC7 lists the four preseed-authoritative pages including STYLES.md).

---

### AD56: 15-minute bisync cadence with manual triggers

**Category:** Storage

**Status:** Active (2026-05-18)

**Context:** The periodic rclone bisync daemon ran every 60 seconds, producing ~1440 invocations per session per day even on idle sessions. Each invocation does at minimum one LIST on each side plus N HEADs across both encrypted and unencrypted configs; for users with multiple active sessions the R2 operation count scaled into terabytes/month of metadata traffic and Class A operations. The dominant cost was not transferred bytes but listing overhead on idle sessions.

Three options were considered: (a) keep 60s, (b) inotify-driven local-flush plus a 15-minute ceiling, (c) pure 15-minute cadence with explicit user-driven triggers. Option (b) was initially recommended for its sub-minute convergence on active sessions, but the Claude-projects directory writes session transcripts continuously and would trigger the inotify wake on every keystroke; restricting inotify to specific folders added complexity without clearly winning over option (c). Option (c) was chosen for simplicity.

**Decision:** The periodic bisync runs every 15 minutes. Three trigger points cover the gap:

1. **15-minute wall clock** -- the daemon's `sleep` is interruptible by SIGUSR1, otherwise wakes after 900 seconds.
2. **Manual UI trigger** -- the storage panel's Sync-now button posts to `POST /api/sessions/sync`, which fans out per-session triggers across all the authenticated user's running sessions.
3. **Final sync at shutdown** -- the entrypoint's SIGTERM trap runs `bisync_with_r2` inside the 120-second watchdog before the Container DO destroys (REQ-STOR-005, AD57).

An earlier draft of this ADR included a fourth trigger ("upload-side auto-trigger" -- fire-and-forget fan-out on every R2 PUT through the storage panel). It was removed: a single 20-file drag-drop produced 20 separate KV-enumeration + fan-out RPCs, blowing Worker subrequest budget for a feature the Sync-now button + 15-minute cadence already cover at lower cost. The container-side SIGUSR1 trap coalesces to at most one in-flight + one queued bisync regardless, so the only thing the upload-side trigger ever gave us was Worker-layer waste.

The daemon's SIGUSR1 trap is coalescing: signals received during a running bisync set a rerun-requested flag rather than queueing, so N signals during one cycle produce exactly one rerun after the current cycle completes.

**Why fan-out across sessions is safe (and serial would not be better):**

- bisync uses `--conflict-resolve newer`. Newest-mtime-wins is commutative and associative on absolute mtime: for any file with versions across N sessions, the final R2 state is always `max(mtime_1, ..., mtime_N)` regardless of order.
- The system already runs in this concurrent mode every 60 seconds today for any user with multiple active sessions -- the existing `--check-sync=false / --resilient / --recover / --ignore-checksum / --max-delete 100` flag set was added precisely to harden bisync against listing divergence from concurrent writers. Manual fan-out introduces no new concurrency model.
- R2 (S3-compatible) guarantees atomic per-object writes. Concurrent LISTs from different sessions see slightly different snapshots, but each individual file is either fully old or fully new -- never partial.
- Serial fan-out would be ~Nx slower with no different outcome. Worse, the "winner" under serial would depend on which session the Worker happened to schedule first, replacing a mathematically deterministic max-mtime outcome with an arbitrary one.

**Consequences:**
- Estimated ~14x reduction in R2 ops on idle sessions (96 cycles/day vs 1440).
- Ungraceful exit (OOM, container eviction, kernel panic) can lose up to 15 minutes of work. Graceful exit (idle stop, explicit delete, SIGTERM) remains safe via the final-bisync trap (AD57).
- Multi-tab convergence latency widens from <=60s to <=15min unless the user clicks Sync-now.
- Storage-panel-after-terminal-write freshness widens to <=15min unless the user clicks Sync-now.
- Tier-uniform: free, standard, advanced, max, and custom paid tiers all run on the same cadence.

**Alternative considered:** inotify-driven local-flush with a 15-minute ceiling. Rejected: requires either watching the whole filesystem (Claude-projects flooding) or per-folder include lists (complexity that pure 15-min plus Sync-now avoids). The simplicity win outweighed the sub-minute convergence loss for active sessions.

**Alternative considered:** Activity-gated 60s plus 15-min idle fallback. Rejected: same complexity floor as inotify without the upside; misses out-of-band writes (vault editor on host).

**Related REQ:** REQ-STOR-003 (rewritten in this change), REQ-STOR-015 (manual trigger surface).

---

### AD57: 135-second shutdown budget for final bisync

**Category:** Storage

**Status:** Active (2026-05-18)

**Context:** The pre-existing Container DO `destroy()` budget was 75 seconds (vault rollout had already raised it from 25s -> 75s when vault edits in the last seconds before shutdown were silently truncated by the SDK's SIGKILL mid-bisync). The entrypoint shutdown handler's watchdog was 60 seconds (50s SIGTERM + 10s SIGKILL), nested cleanly inside the 75s DO budget with 15s buffer for clean process exit.

Under the new 15-minute cadence (AD56), any single bisync run can accumulate more changes than under the old 60s cadence -- in the worst case, up to ~15 minutes of writes since the last sync. The 60s shutdown watchdog is therefore too tight: large vault edits or workspace deletes accumulated over a long idle window can routinely exceed 60s on the final bisync, triggering the watchdog's SIGKILL mid-write and leaving R2 in a partial state.

**Decision:** Raise the shutdown chain by 60 seconds at both layers:

- **entrypoint shutdown_handler watchdog**: 50s SIGTERM + 10s SIGKILL -> 108s SIGTERM + 12s SIGKILL (120 seconds total).
- **Container DO `destroy()` timeout**: 75_000ms -> 135_000ms (120s bisync + 15s clean-exit buffer, preserving the existing 15s margin between the entrypoint giving up and the SDK SIGKILL).

The DO's `_shutdownStartedAt` telemetry already logs `shutdownElapsedMs` on `onStop()`. Augment with a `logger.warn` at 110 seconds elapsed so any session approaching the new budget surfaces in logs and we can bump again if real-world bisyncs routinely exceed 110s.

**Consequences:**
- Final bisync has headroom for the worst-case 15-minute accumulation.
- Session-delete UX shows a "Saving final changes to storage..." spinner up to ~130 seconds before reporting success. The session-delete handler at `src/routes/session/crud.ts:194-220` already awaits `container.destroy()` end-to-end, so no fire-and-forget fix is required.
- The 2-minute SIGKILL is the user-accepted floor: anything still running at 120 seconds is hard-killed and the last writes accepted as potentially lost.
- If telemetry shows shutdownElapsedMs P95 exceeds 110 seconds in production, the budget can be raised again to 150s/165s without architectural change -- the warn threshold gives early signal.

**Alternative considered:** Telemetry-first canary -- ship the 15-min cadence behind an env var, gather shutdownElapsedMs P95/P99 for one week, then commit to the budget. Rejected by the user: the 2-minute budget plus SIGKILL is the explicit floor; if it is not enough, the warn threshold and post-merge telemetry will tell us within 24 hours.

**Alternative considered:** Block container destruction on an explicit "prepare-shutdown" RPC that runs the final bisync synchronously and only returns on completion. Rejected: the existing trap-driven shutdown already runs the final bisync; adding a separate RPC adds a second code path with the same semantics. The simpler change is to extend the existing budget.

**Related REQ:** REQ-STOR-005 (AC4 + AC5 codify the new budget).

---

### AD58: Sonnet for memory capture, with prefilter and scratchpad

**Category:** Memory

**Status:** Active (2026-05-18)

**Context:** REQ-MEM-001's capture pipeline ran haiku as the background subagent and read raw transcript JSONL directly. Two problems emerged in production:

1. **Recency bias.** A 1466-line transcript is ~3.8 MB of JSONL; ~99% of those bytes are `tool_use` and `tool_result` records. Haiku reading the raw stream burned its working memory on tool I/O and produced a capture summarising only the most recent topic. Bench: a session that ran 6 hours of R2-bisync design work yielded a 1431-byte note covering just the final 15 minutes' stop-hook mechanics; the substantive arc was lost.
2. **Confabulated citations.** Even after prefilter+chunking removed the recency bias, haiku invented adjacent ADR numbers in benchmarking (`AD58`, `AD59` cited in a note where the actual references were `AD56` + `AD57`). For a memory subsystem whose value is "queryable cross-session truth," false citations are worse than missing ones — they pollute the unified graph and mislead future agents that match on the wrong ID.

**Decision:** Three coupled changes that ship as one PR:

- **Prefilter pipeline.** New `prefilter-transcript.sh` runs a `jq` filter that drops tool_use/tool_result/thinking blocks, slash-command wrappers, task-notifications, hook feedback, resume markers, and meta records. Output is NDJSON of `{role, text, ts}` per kept entry. On the benchmark transcript: 3.8 MB raw → 50 KB clean (76× reduction).
- **Chunked scratchpad.** The capture agent splits the clean NDJSON into chunks of ~20 entries (`chunk-aa.md`, `chunk-ab.md`, ...), processes each chunk in turn, and appends per-chunk observations to a scratchpad file before synthesising the final note. The scratchpad becomes working memory; recency bias is structurally prevented because each chunk gets equal attention.
- **Model: sonnet, not haiku.** The capture agent runs at sonnet tier. Same-input bench against haiku: sonnet produced 52 bullets vs 30, cited 15 commit SHAs verbatim (haiku cited 0), and invented zero IDs vs haiku's 2. The model is bound at the agent-file level via frontmatter in `preseed/agents/claude/agents/memory-capture.md` (and `vault-extract.md` for the vault path); hook directives instruct the main agent not to pass a model override to the Task tool, so the pin cannot be silently downgraded by a caller.

Three smaller decisions bundled in:

- **Timezone for capture filenames** is resolved at capture time from `$USER_TIMEZONE` env var, then `$TZ`, then `/etc/timezone`, falling back to UTC. No hardcoded zone -- codeflare is forkable and users live everywhere. The container clock is typically UTC; the Dashboard auto-syncs the browser's IANA timezone to the `userTimezone` preference on mount (REQ-SESSION-016 AC5), so captures record the user's actual wall-clock time (filenames like `2026-05-18T14-22-15+0200-...md`) on the next session start after first login.
- **Prefilter script joins the manifest.** Adding `plugins/codeflare-memory/scripts/prefilter-transcript.sh` to `preseed/agents/claude/manifest.json` so it ships through the standard agent-seed pipeline. Otherwise the capture agent would call a script that does not exist in production.
- **Marker filter** explicitly excludes string content beginning with `<` (slash-command + task-notification wrappers), `Stop hook` (stop-hook feedback synthetic injection), `This session is being continued` (resume header), and `[Request interrupted` (interrupt notice). These were all leaking into the haiku's view of "real user prompts" before this pass.

**Consequences:**
- Capture cost rises ~3x per fire (haiku → sonnet pricing). The capture fires at most once per 15 real user prompts, so a typical long session triggers it 1-5 times. Absolute cost is cents per session — well worth the fidelity gain.
- Capture latency rises modestly: chunked-scratchpad introduces N+1 LLM round-trips per fire (one per chunk plus the synthesis pass). On the benchmark the haiku run took ~88 s end-to-end; sonnet with the new pipeline ~228 s. The agent runs in the background via `executionCtx.waitUntil`, so user-facing latency is unchanged.
- Vault notes are denser (5-10 KB typical vs 1-2 KB before). SilverBullet renders all of them fine; the unified graph picks up more concept nodes per capture, which improves cross-session retrieval recall.
- Stale `Raw/Sessions/` files written by the old pipeline are not migrated. They remain as historical record; future captures use the new format.

**Alternative considered:** Keep haiku and ratchet the prompt harder ("only cite IDs verbatim"). Rejected because haiku's confabulation is a model-level behaviour, not a prompt-comprehension issue; tightening the prompt reduces inventions on the margin but does not eliminate them, and the false-citation cost dominates the haiku cost saving.

**Alternative considered:** Prefilter only (keep haiku). Rejected as a half-measure: prefilter fixes recency bias, but the citation-accuracy gap (haiku invents IDs; sonnet doesn't) remains uncovered.

**Alternative considered:** Capture model gated by env var (default haiku, advanced users override to sonnet). Rejected as unnecessary mechanism — capture quality is a system-wide property, and the cost difference at the actual capture cadence is negligible. Per-user opt-out can be added later if cost telemetry shows it matters.

**Related REQ:** REQ-MEM-001 (capture pipeline contract), REQ-MEM-008 (preseed manifest includes the new script).

---

### AD59: Zero-UI vault encryption with per-session DO-storage key

**Category:** Security
**Status:** Active (2026-05-18)

**Context:** SilverBullet's IndexedDB cache stores every vault file as plaintext on the user's browser profile. Three concerns are coupled: (1) SB cold-start is ~30s on every new session because the per-`:sid` URL produces a new IDB hash every time; (2) plaintext IDB exposes vault content to anyone with read access to the user's browser profile (backup leak, profile theft, ransomware scan); (3) deleted sessions leave orphan IDBs that grow monotonically against the per-origin quota. The team wanted encryption-at-rest without adding a passphrase UI (it would create a "forgotten passphrase" support load and the vault is already coupled to the codeflare login).

**Decision:** Each session's Container DO mints a 32-byte random key on first boot, persists in `ctx.storage`, and exposes it via an RPC method `ensureVaultKey()`. The Worker `/.config` proxy fetches the key via RPC and injects it into SilverBullet's BootConfig. A Worker-side `<script>` injection into the shell HTML exposes `window.__codeflareVaultBoot` carrying the key, raised sync concurrency, and lazy-path prefixes for the SB client to consume. The frontend nukes the per-session IDB on session DELETE and runs an orphan-sweep on Dashboard mount.

**Threat model (BitLocker-grade, not Bitwarden-grade):**
- DEFEATS: offline disk attacks - recovered/stolen browser profile, leaked filesystem backup, ransomware filesystem scan, forensic IDB extraction from a powered-off machine.
- DOES NOT DEFEAT: anyone with an authenticated browser tab on the codeflare origin (they can read `window.__codeflareVaultBoot` directly from page JS); the codeflare Worker operator (the key crosses the Worker on every request); a compromised Cloudflare edge.

**Consequences:**
- Vault contents in IndexedDB become AES ciphertext rather than plaintext markdown - a recovered profile no longer leaks notes.
- The encryption is forward-secret: `container.destroy()` (session DELETE) wipes both the DO key and the browser IDB, so deletion is unrecoverable even by the user.
- The key MUST NOT rotate mid-session - rotation would orphan all existing IDB ciphertext and force re-sync on every container restart, defeating the cold-start optimisation.
- The key is per-session, so cross-session reads remain isolated (each `:sid` has its own IDB hash).
- Worker-side script injection is fragile: a future SB upstream change to the shell HTML template could break the `</head>` insertion point. The fail-safe is "return HTML unchanged" so a missed injection degrades to a passphrase prompt rather than a white screen.

**Alternative considered:** Per-user passphrase derived via PBKDF2 from the codeflare password. Rejected - adds a "forgotten passphrase" recovery flow that requires the user to re-enter their vault password on every fresh device, defeating the always-on coupling to the codeflare session.

**Alternative considered:** Build SilverBullet from source with native encryption support baked in. Rejected - Deno toolchain in the image adds ~400MB and locks codeflare to a fork rather than tracking SB upstream. Runtime injection through the already-text-rewriting Worker proxy is the lowest-overhead option.

**Alternative considered:** Server-side encryption only (rclone bisync to R2 SSE-C, leave IDB plaintext). Rejected - R2 SSE-C already covers at-rest on R2; the gap is the browser cache, which is where the new requirement lives.

**Related REQ:** REQ-VAULT-008 (zero-UI vault encryption + cold-start payload + IDB lifecycle), REQ-VAULT-005 (Worker proxy exposes vault editor).

---

### AD60: Pi memory capture reuses the AD58 contract and transcript prefilter

**Category:** Memory

**Status:** Active (2026-05-29)

**Context:** AD58 raised Claude-side memory-capture quality with three coupled changes (jq prefilter, chunked scratchpad, sonnet-tier model) because the background capture agent was reading raw transcript JSONL, burning its working memory on tool I/O, and confabulating citations. Making Pi a first-class codeflare resident meant Pi had to capture memory at the same fidelity. The Pi extension previously carried a thin inline capture contract embedded in `memory-vault.ts` and sliced the raw last-40 transcript entries, which reproduced exactly the two failure modes AD58 fixed: recency bias from raw tool records and weak citation discipline.

**Decision:** Pi memory capture reuses the AD58 capture contract rather than maintaining a divergent Pi-specific one. Two full contracts are deployed as Pi-native preseed assets: `preseed/agents/pi/prompts/memory-agent-prompt.md` (the capture-agent contract) and `preseed/agents/pi/prompts/vault-extract-prompt.md` (the Vault-graph extraction contract). The generator maps `prompts/` to `.pi/agent/prompts/`, so both land at `~/.pi/agent/prompts/*.md`. `memory-vault.ts` no longer embeds an inline contract; it reads these files at spawn time. The raw last-40 transcript slice is replaced by a prefilter that keeps only user and assistant text and drops tool-call and thinking blocks before the capture subagent is spawned, mirroring AD58's jq prefilter intent on the Pi tool surface.

**Consequences:**
- Pi captures inherit the AD58-grade contract verbatim, so cross-session memory written from Pi sessions carries the same citation discipline and arc-coverage as Claude sessions; both populate the same unified graph.
- The capture contract has a single owner in source. A future change to the AD58 contract updates the Claude agent files and the Pi prompts from the same intent; the Pi copies are deployed prompts, not a fork.
- The prefilter shifts work to spawn time. The transcript is reduced to user/assistant text before the subagent reads it, so the subagent never sees raw tool I/O and recency bias is structurally prevented as on the Claude path.
- Stale captures written by the old thin-contract Pi path are not migrated; they remain as historical record.
- Later refinement (REQ-MEM-001 AC8, 2026-05-30): the prefilter input is the durable on-disk session transcript Pi persists for `/resume`, read via `ctx.sessionManager.getSessionFile()` and parsed by `parseSessionMessages` - not the volatile in-memory message buffer the original Pi path used. That buffer was empty immediately after a Pi reload/resume, so the first capture-boundary prompt produced a hollow "no substantive content" note even though the full session JSONL was on disk; reading the persisted file fixed it, and a skip-empty guard now suppresses the capture rather than writing a placeholder note.

**Alternative considered:** Keep the thin inline Pi contract and ratchet its prompt. Rejected for the same reason AD58 rejected prompt-only tightening: recency bias is a function of feeding raw tool records to the model, not a prompt-comprehension gap, and a divergent contract drifts from the AD58 source of truth over time.

**Related REQ:** REQ-MEM-001 (conversation context automatically captured to Vault).

---

### AD61: Pi `/review` ships as a dedicated native skill

**Category:** Architecture

**Status:** Active (2026-05-29)

**Context:** The Claude `/review` UX is a slash command (`preseed/agents/claude/commands/review.md`) carrying a multi-phase review workflow. Slash commands are a Claude Code primitive; the generator does not deploy commands to other agents (see the "Excluded from non-CC transformed assets" list in [preseed.md](../lanes/preseed.md#multi-agent-preseed)). On Pi this left the user-invoked `/review` workflow with no home: PR-boundary enforcement was covered by `review-enforcement.ts`, and the transformed `git-review-pipeline` skill carries the enforcement spine, but neither reproduces the full user-driven review flow (scope flags, phased perspectives, reality-filter triage) that the Claude command provides.

**Decision:** Ship the Pi `/review` workflow as a dedicated Pi-native skill at `preseed/agents/pi/skills/review/SKILL.md` (full 11-phase workflow), deployed to `~/.pi/agent/skills/review/SKILL.md`. The native skill is distinct from `review-enforcement.ts` (PR-boundary HEAD watching) and from the transformed `git-review-pipeline` enforcement skill: the skill owns the user-requested review UX, while the enforcement extension owns the automatic PR-boundary gate. The Pi `review/SKILL.md` joins the Pi manifest as a native skill override so the generator does not also emit a transformed copy of any same-named Claude skill into the Pi skill set.

**Consequences:**
- Pi users get the full `/review` flow at parity with the Claude command, expressed in Pi-native tool and subagent vocabulary.
- The Pi-native skill count rises to two (graphify + review); both are native overrides the generator excludes from the transformed-skill emit for Pi.
- The review surface is split by responsibility on Pi: the native skill is the user-invoked path, `review-enforcement.ts` is the automatic PR-boundary path, and they do not duplicate each other's logic.

**Alternative considered:** Transform the Claude `/review` command into a Pi instruction file. Rejected because commands are deliberately excluded from non-CC transforms, and a command is a different surface from a skill; folding command prose into the single Pi instructions file would bury an on-demand workflow in always-on context.

**Alternative considered:** Rely solely on `git-review-pipeline` for both enforcement and user-invoked review on Pi. Rejected because the enforcement spine does not carry the phased user-review UX (scope flags, per-perspective passes, reality-filter), so Pi users would lose the `/review` experience entirely.

**Related REQ:** REQ-AGENT-015 (`/review` command for multi-perspective codebase review), REQ-AGENT-044 (review-agent discipline enforcement).

---

### AD62: Pi model-name genericization with `CODEFLARE_MEMORY_MODEL` lever

**Category:** Architecture

**Status:** Active (2026-05-29)

**Context:** Codeflare is forkable and runs six AI tools; hardcoding a specific model name (for example a `sonnet` or `haiku` literal) into Pi-bound prose or extension code couples the deployment to one vendor's model lineup and goes stale as model names change. AD58 pins the capture model for Claude via agent-definition frontmatter, but Pi subagents are spawned programmatically from `memory-vault.ts`, and the generator strips the `model` frontmatter field for runtimes that do not support it. Pi therefore needed a model-selection mechanism that names no model in the shipped artifact.

**Decision:** Two coupled changes. (1) Genericize model references in Pi-bound prose: Pi-facing documentation and extension code describe model selection by role ("higher-fidelity model", "session model") rather than by literal model name. The generator removes `model` frontmatter for runtimes that do not support it while preserving Pi subagent model pins where the runtime does. (2) Introduce the optional `CODEFLARE_MEMORY_MODEL` container env var (documented in [configuration.md](../lanes/configuration.md#container-environment)). When set, `memory-vault.ts` passes it as the `model` option to `service.spawn(...)` for the `memory-capture` and `vault-extract` subagents; when unset, no override is passed and the subagents inherit the session model. The lever pins capture/extract fidelity per AD58 without a hardcoded model name anywhere in the preseed.

**Consequences:**
- The Pi preseed artifact names no specific model. An operator who wants AD58-grade capture fidelity on Pi sets one env var; the default behavior (inherit session model) is sensible with no configuration.
- Fork-friendliness is preserved: a fork running a different model lineup sets `CODEFLARE_MEMORY_MODEL` to whatever its highest-fidelity model is, with no source edit.
- The Claude and Pi capture paths reach the same outcome (AD58 fidelity) through runtime-appropriate mechanisms: frontmatter pin on Claude, env-var lever on Pi.
- The lever is capture-scoped. It does not change the session's primary model and is read only by the memory/Vault-extract spawn path.

**Alternative considered:** Hardcode the AD58 model literal into the Pi extension. Rejected because it staleness-couples the fork to one vendor's naming and contradicts the no-hardcoded-model-name discipline; a model rename would silently break or mislabel the pin.

**Alternative considered:** Reuse `SESSION_MODE` or another existing variable to imply the capture model. Rejected as overloading: `SESSION_MODE` already controls memory persistence and rclone filters, and conflating model fidelity with session mode would make both harder to reason about.

**Related REQ:** REQ-MEM-001 (conversation context automatically captured to Vault), REQ-AGENT-001 (support multiple AI coding agents).

---

### AD63: Pi `safe-graphify-update.sh` is fail-closed and two-step

**Category:** Architecture

**Status:** Active (2026-05-29)

**Context:** AD53's graphify hot-reload wrapper hardens `graphify update` on the 1 vCPU container by capping virtual memory (`ulimit -v`) and worker count so a runaway AST rebuild dies with ENOMEM instead of OOM-killing the session. The Claude wrapper (`preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh`) is a single-step `graphify update` invocation. The Pi wrapper, deployed to `~/.pi/agent/scripts/safe-graphify-update.sh`, runs in a different launch context (Pi extension dispatch, where the working directory and environment are not guaranteed to match the Claude hook environment) and feeds a structural gate in `codeflare-pi.ts`. Applying the Claude wrapper's fail-open posture verbatim risked silently updating against the wrong directory or proceeding with an unbounded address space if the `ulimit` call failed.

**Decision:** The Pi wrapper deliberately diverges from the Claude single-step wrapper on two axes. (1) Fail-closed hardening: a `cd` guard aborts if the target repository directory cannot be entered, the `RLIMIT_AS` `ulimit` is fail-closed (if the limit cannot be applied the wrapper aborts rather than running unbounded), a `command -v graphify` check aborts when the CLI is absent, and `GRAPHIFY_VIZ_NODE_LIMIT=100000` is re-exported so the visualization is always generated. (2) Two-step execution: the wrapper runs `graphify update` (AST extraction) and then a cluster-only pass, rather than the Claude wrapper's single `update`. Separately, `codeflare-pi.ts`'s `graphSummary` skips graphs over 30 MB and applies a 5-second git timeout, and the structural gate that consumes the wrapper fails open (a missing or failed graph never blocks the user) even though the wrapper itself fails closed.

**Consequences:**
- A misresolved working directory or a failed memory cap aborts the Pi update with a clear error instead of corrupting the graph or risking an OOM, which matters more on Pi because the launch context is less constrained than the Claude hook environment.
- The two-step update keeps the cluster data fresh as a distinct pass, so the structural gate reads a consistent graph.
- The two wrappers intentionally differ. The divergence is documented here so a future maintainer does not "unify" them and reintroduce the fail-open behavior on the Pi launch path.
- Layering is deliberate: the wrapper fails closed (correctness of the build), while the `codeflare-pi.ts` structural gate fails open (never lock the user out). The 30 MB skip and 5-second git timeout bound the gate's own cost on large repos.

**Alternative considered:** Share one wrapper between Claude and Pi. Rejected because the launch contexts differ (hook environment vs Pi extension dispatch) and the Pi path needs the `cd` guard and fail-closed `ulimit` that the Claude single-step path does not; a shared wrapper would either over-constrain Claude or under-protect Pi.

**Alternative considered:** Make the Pi wrapper fail-open like the Claude one and rely on the `codeflare-pi.ts` gate to absorb failures. Rejected because fail-open at the wrapper means a failed memory cap runs unbounded and a misresolved directory updates the wrong graph silently; the gate's fail-open is about not blocking the user, not about tolerating a corrupt build.

**Related REQ:** REQ-AGENT-023 (knowledge-graph capability via graphify), REQ-AGENT-043 (graphify build-mode dispatch).

---

### AD64: Durable review lanes load extensions additively behind the `noExtensions` shield

**Category:** Architecture

**Status:** Active (2026-05-30)

**Context:** PR-boundary review enforcement (REQ-AGENT-040/053/054) runs each lane as an in-process `createAgentSession` (`review-jobs.ts::runDurableLane`) with `DefaultResourceLoader({ noExtensions: true })`. That shield exists because extension factories run synchronously during load (pi's `loader.js` `await factory(api)`), and `review-enforcement.ts`'s factory writes a process-global run token (`__codeflareReviewEnforcementRun`) at load time; if a lane loaded that extension in the same process it would overwrite the token and silently disable the **main** session's enforcement (the merge gate). `@gotgenes/pi-subagents` similarly couples in-process state. But the blunt `noExtensions: true` also stripped every useful capability, leaving lanes with only the 7 built-in tools: reviewers had no `graphify_*`, no `ctx_*`, and none of `codeflare-pi`'s guards. A transient `gh pr view` failure once dropped the merge gate by mis-classifying a live head as stale (the "failure #13" referenced in `review-helpers.ts`); `classifyReviewHead` now separates `stale` from `unknown` to keep the gate fail-closed, and the durable `.git/`-persisted state makes that classification recoverable.

**Decision:** Keep `noExtensions: true` and load capabilities **additively** via `additionalExtensionPaths` (which still load under `noExtensions`): always the graphify package, the `context-mode` package only when enabled in Pi settings (so lanes inherit `/ctx on`), and `codeflare-pi.ts` as a local file (for the local-build blocker, attribution gate, and graphify-first gate). `review-enforcement` and `@gotgenes/pi-subagents` are never added, so neither clobbers the main session. Lane source selection is the pure `review-job-helpers.ts::laneExtensionSources`. `codeflare-pi`'s `session_start` global-graph merge is skipped inside lanes via a `globalThis.__codeflareReviewLaneDepth` counter set by `runDurableLane`, avoiding a redundant `graphify global add` subprocess per lane on the 1 vCPU container.

**Consequences:**
- Reviewers gain graphify and (when enabled) context-mode, and run under the same build-blocker/graphify-first gates as the main agent.
- The `noExtensions` shield is load-bearing and must stay; a future maintainer must not "simplify" by removing it, because that reloads `review-enforcement`'s clobbering factory in-process.
- `extensionsOverride` cannot substitute for this: it filters after factories have already run, so it cannot prevent the load-time global clobber.
- graphify tools spawn bounded Python; lanes are steered (system prompt) to read-only `graphify_query/path/explain`.

**Alternative considered:** Remove `noExtensions` and filter `review-enforcement` out with `extensionsOverride`. Rejected: factories run during load, so the clobber happens before the filter.

**Alternative considered:** Self-guard `review-enforcement` to no-op when loaded in a lane. Rejected as the primary mechanism: it does not cover `@gotgenes/pi-subagents`' in-process coupling, and the additive allowlist is simpler and strictly scopes what a lane can load.

**Related REQ:** REQ-AGENT-053 (durable review status/result/fix loop, AC8), REQ-AGENT-040 (PR-boundary lane classification and dispatch), REQ-AGENT-054 (durable lane failure handling).

---

### AD65: Gemini CLI replaced by Antigravity (agy)

**Category:** Architecture

**Status:** Active (2026-05-30)

**Context:** `@google/gemini-cli` (npm, `gemini` command) was removed from the Dockerfile and entrypoint. The replacement is Antigravity (`agy`), Google's successor CLI, installed via `curl -fsSL https://antigravity.google/cli/install.sh | bash` as a Go-native binary. Because `agy` is not an npm package it is excluded from the V8 compile-cache warm-up step (same as `opencode`). The `~/.gemini/settings.json` auto-update suppressor written by Fast Start is also removed; `agy` has no equivalent config-file suppressor mechanism at this time.

**Decision:** Install Antigravity via its official curl installer in the Dockerfile. Do not add it to the npm `install -g` line. Antigravity gets no preseed adaptation lane (it has no stable config-file convention to target). The legacy `--filter "- .gemini/tmp/**"` rclone filter is retained as a harmless no-op to avoid bisync filter-list churn.

**Consequences:**
- The Gemini CLI interactive agent (`gemini`) is no longer available in containers; users needing the Google AI agent use `agy` instead.
- The Gemini *API* (GEMINI_API_KEY, `/api/llm-keys` geminiApiKey, consult-llm model selector) is unaffected - it is a separate provider, not the CLI agent.
- No preseed documents are generated for Antigravity; the per-agent document total drops from 370 to 312.

**Related REQ:** REQ-AGENT-001 (agent CLI pre-install).

---

## Related Documentation

- [Architecture — System Components](../lanes/architecture.md#system-components) - Component overview
- [Architecture — Design Rationale](../lanes/architecture.md#design-rationale) - Architectural principles
- [Security — Authentication Gate](../lanes/security.md#authentication-gate) - Security model
- [Authentication — Auth Modes](../lanes/authentication.md#authentication-modes) - CF Access vs Direct GitHub OAuth
- [Mobile — Scroll Stability](../lanes/mobile.md#scroll-stability) - Mobile terminal design decisions
- [Vault — Directory Layout](../lanes/vault.md#directory-layout) - Vault path, hidden-root constraint, special folders
