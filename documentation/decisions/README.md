
# Architecture Decisions

Architecture Decision Records for Codeflare. Each decision documents a design trade-off with rationale. Referenced as [AD1](#ad1-one-container-per-session) through [AD81](#ad81-reuse-the-container-egress-injection-layer-for-per-user-github-tokens) throughout the codebase and documentation. Most ADRs carry active content; a few are superseded ([AD4](#ad4-periodic-rclone-bisync) by [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers) + [AD57](#ad57-135-second-shutdown-budget-for-final-bisync); [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) by [AD48](#ad48-oauth-state-replaced-by-hmac-signed-stateless-token); [AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list) and [AD50](#ad50-unified-adr-file-with-structural-doc-allow-large-exemption) by [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features); [AD64](#ad64-durable-review-lanes-load-extensions-additively-behind-the-noextensions-shield) by [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes); [AD65](#ad65-gemini-cli-replaced-by-antigravity-agy)'s no-preseed-lane clause by [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored)) or are redirect anchors (merged or reclassified per the documentation-discipline "What is NOT an ADR" rule).

**Audience:** Developers

---

## Decision Index

| ID | Decision | Category |
|----|----------|----------|
| [AD1](#ad1-one-container-per-session) | One container per session | Architecture |
| [AD2](#ad2-container-id-format) | Container ID format | Architecture |
| [AD3](#ad3-per-user-r2-buckets) | Per-user R2 buckets | Architecture |
| [AD4](#ad4-periodic-rclone-bisync) | _superseded by [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers) (cadence) + [AD57](#ad57-135-second-shutdown-budget-for-final-bisync) (shutdown budget)_ | (superseded) |
| [AD5](#ad5-login-shell-autostart) | Login shell autostart | Architecture |
| [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity) | KV read-modify-write races and `collectMetrics` atomicity | Architecture |
| [AD7](#ad7-merged-into-ad10) | _merged into [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) - pre-setup public endpoints_ | Security |
| [AD8](#ad8-root-container-no-internal-auth) | Root container, no internal auth | Architecture |
| [AD9](#ad9-ressource_tier-spelling) | _reclassified - RESSOURCE_TIER spelling moved to configuration.md_ | (redirect) |
| [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) | Bootstrap window: pre-setup endpoints, CSRF, and Worker-name derivation | Security |
| [AD11](#ad11-suffix-pattern-cors-with-credentials) | Suffix-pattern CORS with credentials | Security |
| [AD12](#ad12-kv-based-setup-lock-non-atomic) | KV-based setup lock (non-atomic) | Security |
| [AD13](#ad13-per-user-scoped-r2-tokens) | Per-user scoped R2 tokens | Security |
| [AD14](#ad14-never-auto---resync-on-bisync-failure) | Never auto-`--resync` on bisync failure | Storage |
| [AD15](#ad15-tabconfigschema-allows-arbitrary-command-strings) | TabConfigSchema allows arbitrary command strings | UI/Frontend |
| [AD16](#ad16-entrypointsh-1090-lines-complexity) | entrypoint.sh ~1090 lines complexity | Architecture |
| [AD17](#ad17-merged-into-ad6) | _merged into [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity) - `collectMetrics` atomicity_ | Architecture |
| [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) | Vendored creative/WebGL code uses untyped patterns | UI/Frontend |
| [AD19](#ad19-merged-into-ad18) | _merged into [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) - splash-cursor-logic.ts `as any` casts_ | UI/Frontend |
| [AD20](#ad20-toctou-in-containerlifecyclets) | TOCTOU in container/lifecycle.ts | Architecture |
| [AD21](#ad21-inconsistent-function-signatures) | Inconsistent function signatures | Architecture |
| [AD22](#ad22-jwks-30s-cache-staleness) | JWKS 30s cache staleness | Security |
| [AD23](#ad23-cors-origin-pattern-validation) | _reclassified - CORS admin-trust moved to inline + security.md_ | (redirect) |
| [AD24](#ad24-predictable-session-ids) | _reclassified - session ID rationale moved to inline + security.md_ | (redirect) |
| [AD25](#ad25-e2e-service-email-hardcoded) | _reclassified - E2E test fixture moved to inline + security.md_ | (redirect) |
| [AD26](#ad26-stress-test-rate-limit-bypass-integration-only) | Stress test rate-limit bypass (integration-only) | Security |
| [AD27](#ad27-server-side-prefix-delete) | Server-side prefix delete | Storage |
| [AD28](#ad28-merged-into-ad26) | _merged into [AD26](#ad26-stress-test-rate-limit-bypass-integration-only) - integration-only environment scoping_ | Security |
| [AD29](#ad29-container-secrets-as-env-vars) | Container secrets as env vars | Security |
| [AD30](#ad30-worker-name-from-host-header) | Worker name from Host header | Security |
| [AD31](#ad31-root-container-is-intentional) | _reclassified - root-container rationale moved to inline + security.md_ | (redirect) |
| [AD32](#ad32-encryption_key-is-optional) | ENCRYPTION_KEY is optional | Security |
| [AD33](#ad33-merged-into-ad10) | _merged into [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) - pre-setup CSRF risk_ | Security |
| [AD34](#ad34-websocket-auth-bypass-of-hono-middleware) | WebSocket auth bypass of Hono middleware | Security |
| [AD35](#ad35-merged-into-ad18) | _merged into [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) - splash-cursor-logic.ts old-style constructor_ | UI/Frontend |
| [AD36](#ad36-websocket-origin-check-is-optional-for-non-browser-clients) | WebSocket Origin check is optional for non-browser clients | Security |
| [AD37](#ad37-kv-as-billing-read-cache----signal-and-sync-cf-015) | KV as billing read cache -- Signal and Sync (CF-015) | Billing |
| [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) | GitHub OIDC replaces CF Access in SaaS mode | Billing |
| [AD39](#ad39-max-users-capacity-cap-counts-paid-slots-only) | Max users capacity cap counts paid slots only | Billing |
| [AD40](#ad40-webhook-route-order-publicstripe-before-public) | Webhook route order (`/public/stripe` before `/public`) | Billing |
| [AD41](#ad41-custom-tier-uses-contact-flow-not-self-service-checkout) | Custom tier uses contact flow (not self-service checkout) | Billing |
| [AD42](#ad42-unauthenticated-first-setbucketname-call-cf-010) | Unauthenticated first setBucketName call (CF-010) | Security |
| [AD43](#ad43-parse-and-exclude-vanishing-files-before-escalating-to-nuke) | Parse-and-exclude vanishing files before escalating to nuke | Storage |
| [AD44](#ad44-sdd-three-mode-autonomy-with-conservative-judgment-resolution) | SDD three-mode autonomy with conservative JUDGMENT resolution | Architecture |
| [AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list) | _superseded by [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) -- override mechanism ripped out_ | (superseded) |
| [AD46](#ad46-review-reality-filter-as-phase-5) | `/review` Reality Filter as Phase 5 (stateful per-finding triage history) | Architecture |
| [AD47](#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy) | PTY keepalive as safety net only, not the idle policy | Architecture |
| [AD48](#ad48-oauth-state-replaced-by-hmac-signed-stateless-token) | OAuth state replaced by HMAC-signed stateless token | Security |
| [AD49](#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install) | context-mode delivered as preseed plugin, not runtime install | Architecture |
| [AD50](#ad50-unified-adr-file-with-structural-doc-allow-large-exemption) | _superseded by [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) -- doc-allow-large hatch ripped out_ | (superseded) |
| [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) | Rip out six overengineered SDD framework features | Architecture |
| [AD52](#ad52-graphify-mcp-available-everywhere-discipline-advanced-only) | Graphify MCP available everywhere, discipline advanced-only | Architecture |
| [AD53](#ad53-graphify-hot-reload-wrapper-with-multi-repo-sentinel-tracking) | Graphify hot-reload wrapper with multi-repo sentinel tracking | Architecture |
| [AD54](#ad54-vault-directory-must-use-a-non-hidden-basename) | Vault directory must use a non-hidden basename | Storage |
| [AD55](#ad55-codeflare-brands-the-vault-editor-via-preseed-managed-stylesmd) | Codeflare brands the vault editor via preseed-managed STYLES.md | Architecture |
| [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers) | 15-minute bisync cadence with manual triggers (fan-out safe under newer-mtime-wins) | Storage |
| [AD57](#ad57-135-second-shutdown-budget-for-final-bisync) | 135-second shutdown budget for final bisync | Storage |
| [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) | Sonnet (not haiku) for memory capture, plus jq-prefilter and chunked-scratchpad pipeline | Memory |
| [AD59](#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key) | Zero-UI vault encryption with per-session DO-storage key | Security |
| [AD60](#ad60-pi-memory-capture-reuses-the-ad58-contract-and-transcript-prefilter) | Pi memory capture reuses the [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) contract and transcript prefilter | Memory |
| [AD61](#ad61-pi-review-ships-as-a-dedicated-native-skill) | Pi `/review` ships as a dedicated native skill (Claude commands do not deploy to Pi) | Architecture |
| [AD62](#ad62-pi-model-name-genericization-with-codeflare_memory_model-lever) | Pi model-name genericization with `CODEFLARE_MEMORY_MODEL` lever | Architecture |
| [AD63](#ad63-pi-safe-graphify-updatesh-is-a-thin-bounded-upstream-update-wrapper) | Pi `safe-graphify-update.sh` is a thin bounded upstream-update wrapper | Architecture |
| [AD64](#ad64-durable-review-lanes-load-extensions-additively-behind-the-noextensions-shield) | _superseded by [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes) -- lanes now run as detached headless Pi processes_ | (superseded) |
| [AD65](#ad65-gemini-cli-replaced-by-antigravity-agy) | Gemini CLI replaced by Antigravity (agy) _(no-preseed-lane clause superseded by [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored))_ | Architecture |
| [AD66](#ad66-security-sensitive-rate-limiters-fail-closed-on-kv-outage) | Security-sensitive rate limiters fail closed on KV outage | Security |
| [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored) | Antigravity reads the Gemini CLI config tree; preseed lane restored | Architecture |
| [AD68](#ad68-service-token-admin-bypass-must-be-environment-gated-and-hostname-restricted) | Service-token admin bypass must be environment-gated and hostname-restricted | Security |
| [AD69](#ad69-silverbullet-vault-runs-its-native-service-worker-for-persistent-encrypted-client-indexing) | SilverBullet vault runs its native service worker for persistent, encrypted client indexing (SB v2 has no server-side index) | Architecture |
| [AD70](#ad70-container-exit-writes-kv-stopped-no-read-side-reconciliation) | Container exit writes KV `stopped`; no read-side reconciliation | Architecture |
| [AD71](#ad71-preseed-corpus-statically-imported-into-the-worker-bundle-bound-by-compressed-bundle-size-ci-guarded) | Preseed corpus statically imported into the Worker bundle; bound by compressed bundle size, CI-guarded | Architecture |
| [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) | Outbound-HTTPS interception over a Worker-side LLM proxy for enterprise gateway routing | Architecture, Security |
| [AD73](#ad73-workersdev-enabled-on-every-deployment-for-setup-wizard-bootstrap) | workers.dev enabled on every deployment for setup-wizard bootstrap | Security |
| [AD74](#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api) | Enterprise LLM transport on the AI Gateway REST API (amends [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing)) | Architecture, Security |
| [AD75](#ad75-pi-graphify-tools-replaced-by-a-first-party-native-extension) | Pi graphify tools replaced by a first-party native extension (`graphify-native.ts`); `@gaodes/pi-graphify` removed | Architecture |
| [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes) | Durable review lanes run as detached headless Pi processes | Agents |
| [AD77](#ad77-enterprise-vault-service-worker-reached-via-a-higher-precedence-access-bypass-app) | Enterprise vault service-worker reached via a higher-precedence Access bypass app | Architecture, Security |
| [AD78](#ad78-pr-boundary-review-lanes-run-in-parallel-report-only-reviewers) | PR-boundary review lanes run in parallel (report-only reviewers) | Agents |
| [AD79](#ad79-image-baked-pi-extension-transpile-cache) | Image-baked Pi extension transpile cache | Performance |
| [AD80](#ad80-pi-pr-boundary-merge-gate-is-report-only-and-defended-in-depth) | Pi PR-boundary merge gate is report-only and defended in depth | Agents |
| [AD81](#ad81-reuse-the-container-egress-injection-layer-for-per-user-github-tokens) | Reuse the container egress-injection layer for per-user GitHub tokens | Architecture, Security |

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

Isolation boundary: each user's files live in their own bucket. Simplifies deletion (empty + delete bucket). Bucket name sanitized from email (max 63 chars, S3-compatible). Per-user scoped R2 tokens ([AD13](#ad13-per-user-scoped-r2-tokens)) further restrict access.

---

### AD4: Periodic rclone bisync

**Category:** Architecture
**Status:** Superseded by [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers) (cadence rationale) and [AD57](#ad57-135-second-shutdown-budget-for-final-bisync) (shutdown budget).

**Decision:** Background daemon every 60s + final sync on shutdown. Superseded cadence rationale: see [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers) (now 15min). Superseded shutdown budget rationale: see [AD57](#ad57-135-second-shutdown-budget-for-final-bisync) (now an awaited live drain within a 120s budget before stop, 135s DO destroy hard cap; the SIGTERM trap is only a backstop -- see the Revision in AD57).

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

**Update (2026-06-02, [AD70](#ad70-container-exit-writes-kv-stopped-no-read-side-reconciliation)):** the specific Dashboard-side revert this note worried about was the read-side `reconcileStaleStatus` heuristic (a separate later addition), which inferred `stopped` from a stale `metrics.updatedAt` heartbeat and could falsely kick a still-live session. That heuristic was removed in [codeflare#153](https://github.com/nikolanovoselec/codeflare/issues/153); KV `status` is now authoritative and written on every container exit, so the Dashboard renders it verbatim with no reconciliation. The remaining `collectMetrics` RMW concern (overlapping writes to the same record) is unchanged and still last-writer-wins.

**`collectMetrics` density** (formerly [AD17](#ad17-merged-into-ad6)): the function performs activity checking, health probing, and KV status updates in a single `alarm()` callback. Splitting into separate alarms would require coordination logic more complex than the current monolithic approach. The `alarm()` context provides natural atomicity across these tightly coupled operations - same theme as the KV race trade-off above (accept the cheap option until evidence forces change).

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

`/api/setup/configure` is public before `setup:complete` is written to KV. This allows the deployer to configure their instance without pre-existing auth infrastructure (Cloudflare Access isn't set up yet - that's what setup configures).

**Trade-off**: A narrow window (seconds to minutes) exists where any actor could claim the deployment. Accepted because the target audience is self-hosted single-user/small-team deployments where the deployer is watching the process.

**Mitigation**: `setup:complete` KV flag prevents re-configuration. Rate limiting applies to setup routes.

**Future**: A one-time bootstrap secret injected at deploy time would close this window entirely.

**Pre-setup public endpoints** (formerly [AD7](#ad7-merged-into-ad10)): the same risk acceptance covers all pre-setup endpoints, not just `/configure`. Setup runs once during initial deploy. Pre-setup auth trusts a spoofable email header - bootstrap problem (can't require CF Access auth when CF Access isn't configured yet). Mitigated by rate limiting and the same short exposure window.

**Pre-setup CSRF** (formerly [AD33](#ad33-merged-into-ad10)): `createConditionalSetupAuth()` calls `next()` directly when setup is not complete, bypassing the `X-Requested-With` CSRF check. The pre-setup CSRF risk is accepted under the same rationale as above: the window is seconds to minutes, the self-hosted audience makes a drive-by CSRF attack from a third-party origin implausible, and the attacker would need to know the exact `workers.dev` URL during its unconfigured window. Adding `Origin` validation to the pre-setup path is a low-cost future hardening that complements the bootstrap-secret idea above.

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

**`splash-cursor-logic.ts` `as any` casts** (formerly [AD19](#ad19-merged-into-ad18)): pointer-tracking objects and WebGL shader uniforms in this creative-coding module have no typed definitions upstream. The code is adapted from a visual-effect library; type assertions are confined to this isolated module.

**`splash-cursor-logic.ts` old-style constructor with `any` types** (formerly [AD35](#ad35-merged-into-ad18)): an old-style constructor function with `this: any` causes all downstream pointer/rendering functions to use `any` types - it's the root cause of the casts above. The constructor is adapted from the same visual-effect library. The entire module is isolated, has no production data path, and is invoked once per canvas element (not in a hot loop). Refactoring to a typed factory function would require significant rework of adapted code for marginal benefit.

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

k6 stress tests share a single CF Access service token (single identity), so per-user rate limits (10/min sessions, 5/min containers, 30/min WebSocket) block meaningful load testing above ~5 VUs. Setting `STRESS_TEST_MODE=active` on the integration worker disables all rate-limit KV reads/writes at the top of the middleware, before any I/O. The value must be exactly `"active"` - any other value (including `"true"`) keeps limits enforced.

**Integration-only scoping** (formerly [AD28](#ad28-merged-into-ad26)): no CI-level guard is needed because GitHub Actions environment separation controls it. The variable is only set via the workflow scoped to the `integration` environment. Production deployments use `environment: production` and never receive this variable. A repo admin could theoretically set it for production, but that requires deliberate action - the same trust model that already governs every other production secret.

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

**Decision:** When bisync fails with `lstat: no such file or directory`, parse the error output to identify the vanishing file, add it to a session-scoped exclusion filter, and retry - before escalating to `nuke_corrupted_r2_files`.

The race condition is: rclone lists a file at path X, then the file is deleted (by an agent, MCP auth cache cleanup, or any ephemeral write) before rclone can copy it. The file is gone; there is nothing to recover or repair. Nuking R2 objects is the wrong response - it targets corruption (wrong encryption key, size mismatch, bad object metadata), not transience. Retrying the exact same bisync command without excluding the file would hit the same error. The correct response is:

1. Parse `failed to open source object.*no such file` from rclone output.
2. Append `- <path>` to `/tmp/rclone-recovery-filters.txt` (session-scoped, never synced to R2).
3. Clear bisync lock files.
4. Retry the same operation (max 3 attempts per call site).

Non-workspace files are auto-excluded because they are config/cache files that will regenerate. Workspace files (user code) are not auto-excluded - they get a plain retry on the assumption the file reappeared after a save completed. Known ephemeral files (`.claude/mcp-*.json` - MCP auth cache with millisecond lifetime) are statically excluded from `RCLONE_FILTERS_COMMON` to prevent the race from occurring at all.

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
- **PR-based safety net** for unleashed mode: walk-away users get reviewable surface (PR description has full audit log), and rollback is "close the PR" - the working branch is never touched.
- **Universal enforcement layer** (`rules/spec-discipline.md`) inlined into every agent's instructions file ensures Codex (no agent files) and Copilot (no skill loading) get the same discipline as Claude.
- **Project-agnostic agent refactor**: spec-reviewer and doc-updater drop hardcoded Codeflare domain mappings and read `documentation/README.md` to discover the project's actual file structure. Both agents gate on `sdd/` existence - on non-SDD projects (vibe-coding mode) they exit silently and the post-push `git-push-review-reminder` hook also emits no reminder, so `git push` proceeds with zero review agents. `doc-updater` no longer auto-scaffolds `documentation/README.md` on non-SDD projects (previous behavior was too aggressive). Opt-in to the full workflow is binary: run `/sdd init` and all three review agents (code-reviewer, spec-reviewer, doc-updater) fire on every push; don't, and none do.
- **Sequential execution in `/sdd clean`** prevents shared-file races because `/sdd clean` applies fixes inline and docs depend on the just-fixed spec.
- **PR-boundary review differs** because reviewers are report-only and run in parallel; see [AD78](#ad78-pr-boundary-review-lanes-run-in-parallel-report-only-reviewers).
- **2-round commit-cycle limit** with `[sdd-clean]` tag exclusion catches micro-fix spirals without crashing the rescue command itself.
- **`enforce_tdd` rule** (renamed from `auto_demote`, default `true`): spec-reviewer auto-demotes `Implemented` REQs without test coverage to `Partial`, detects `Planned`/`Partial` REQs whose source code exists but has no corresponding test (code-without-test finding), and runs test-quality heuristics (AC-count vs test-count ratio, tautology detection, skipped-test detection) on every push. Forced `true` in unleashed mode where the PR review is the safety net.
- **Plan Mode mandate**: `/sdd init`, `/sdd edit`, and `/sdd add` emit `EnterPlanMode` directives so spec-to-code transitions always go through Plan Mode (a built-in Claude Code primitive). The `/plan` custom slash command is removed - Plan Mode replaces it.
- **Template scaffolding** in `references/templates/` lets `/sdd init` bootstrap any project with no external dependencies.

**Trade-offs accepted:**

- The PR-based safety net adds friction for users who want true zero-touch (the PR has to be merged manually). Acceptable trade-off for the rollback story.
- The forbidden-content allowlist requires per-project tuning for projects that legitimately use vendor names, protocol names, or HTTP status codes in their REQs. Configurable via `sdd/config.yml`.

**Related requirements:**

- [REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) (Pro mode preseed inventory)
- [REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) (preseed bundle generation)
- [REQ-AGENT-007](../../sdd/spec/agents.md#req-agent-007-multi-agent-adaptation-pipeline) (per-agent adaptation pipeline)
- [REQ-AGENT-014](../../sdd/spec/agents.md#req-agent-014-manifest-driven-preseed-pipeline) (manifest as single source of truth)
- [REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability) (SDD workflow as Pro feature) - added in this overhaul

**Implementation references:**

- `preseed/agents/claude/rules/spec-discipline.md` (universal enforcement layer)
- `preseed/agents/claude/skills/spec-driven-development/SKILL.md` (workflow + modes documentation)
- `preseed/agents/claude/skills/spec-driven-development/references/templates/` (scaffolding templates for /sdd init)
- `preseed/agents/claude/agents/spec-reviewer.md` (project-agnostic spec-reviewer agent)
- `preseed/agents/claude/agents/doc-updater.md` (project-agnostic doc-updater agent)
- `preseed/agents/claude/commands/sdd.md` (sub-command dispatcher with help screen)

---

### AD45: User overrides recorded as ADRs, not skip-list

**Status:** Superseded by [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) (2026-05-12). The override-via-ADR mechanism was ripped out alongside five other overengineered SDD features. There is now no per-rule override mechanism at all -- if a finding keeps re-firing, fix the rule or the REQ. Body removed on trim-to-tombstone; this anchor is retained for inbound references. See [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) for the rip-out rationale.

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

- [REQ-AGENT-015](../../sdd/spec/agents.md#req-agent-015-review-command-for-multi-perspective-codebase-review) (`/review` command for multi-perspective codebase review) - AC1 and AC5 updated to reflect the Reality Filter pass and persistent `.review-decisions.md`.

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

- The user-facing idle contract is [REQ-SESSION-004](../../sdd/spec/session-lifecycle.md#req-session-004-idle-containers-sleep-after-configurable-timeout)'s `sleepAfter` (5m / 15m / 30m / 1h / 2h). The PTY reaper sits *below* that contract and must never undercut it. Setting the floor at the maximum `sleepAfter` ensures it cannot fire before the authoritative policy.
- The reaper's value is purely defensive: it prevents a single orphaned PTY from outliving its container forever in pathological scenarios (e.g., `lastInputAt` polling dies but the container DO doesn't notice). With a 120-min floor it still does that job; it just doesn't fire on the happy path.
- The change is one constant in two files; risk is bounded.

**Trade-offs accepted:**

- Users with `sleepAfter` < 2h will, in the rare case of stuck `lastInputAt`, see PTY orphans last up to 120 min instead of 45 min. The container would also be stuck (because `collectMetrics` is the trigger for both stop paths), so the practical impact is "container survives 75 extra minutes when something is broken". Acceptable because the user can manually stop the session from the dashboard.
- The default is hardcoded; a future operator who hits memory pressure on a long-orphaned PTY can still override via `PTY_KEEPALIVE_MS` env var. No new user-facing setting is added.

**Related requirements:**

- [REQ-SESSION-004](../../sdd/spec/session-lifecycle.md#req-session-004-idle-containers-sleep-after-configurable-timeout) (idle containers sleep after configurable timeout): the authoritative idle policy. [AD47](#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy) documents that the PTY-level reaper is subordinate to and must never undercut this REQ.
- [REQ-SESSION-005](../../sdd/spec/session-lifecycle.md#req-session-005-input-based-idle-detection) (input-based idle detection via `lastInputAt`): the signal `collectMetrics` uses; the reaper is the safety net for cases where this signal gets stuck.

**Implementation references:**

- `host/src/server.ts` (`PTY_KEEPALIVE_MS` default)
- `host/src/session.ts` (`_ptyKeepaliveMs` fallback)
- `host/src/session.ts` (`detach()` arms the timer; `keepAliveTimeout` fires `kill()`)

---

### AD48: OAuth state replaced by HMAC-signed stateless token

**Status:** Accepted (2026-05-09)

**Supersedes:** [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) (oauth_state mechanism only; the broader GitHub OIDC-over-CF-Access decision in [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) remains valid)

**Context:** [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) specified that the OAuth CSRF state parameter was carried as an HttpOnly cookie (a random UUID, 5-minute TTL). The cookie was validated server-side by comparing the query-param value returned by GitHub against the stored cookie value. iOS WebKit's Intelligent Tracking Prevention (ITP) and third-party cookie restrictions in private-browsing modes silently drop the state cookie before the GitHub callback completes, breaking the OAuth flow for a meaningful fraction of mobile and privacy-conscious users.

**Decision:** Replace the HttpOnly state cookie with a stateless HMAC-signed token. The token is structured as `nonce.iat.sig` where `nonce` is a random value, `iat` is the issued-at Unix timestamp, and `sig` is an HMAC-SHA256 signature over `nonce.iat` using `OAUTH_JWT_SECRET`. The callback handler recomputes the signature and rejects tokens whose `iat` is outside a 30-minute window. No server-side state is stored; no cookie is required for the CSRF check.

**Alternatives considered:**

1. **Keep the cookie, add `SameSite=None; Secure`** to survive cross-site redirects. Rejected: does not help on iOS ITP, which drops third-party cookies regardless of SameSite attribute on the state-checking round-trip.
2. **Store state in KV with a 5-min TTL.** Rejected: [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) explicitly chose cookies over KV to avoid eventual consistency lag on the Cloudflare edge. HMAC-signed tokens remove the need for any server-side state and are strictly better on both axes.
3. **State in the `state` query param only, validated by nonce replay prevention in KV.** Rejected: same KV consistency concern as option 2.

**Rationale:**

- Stateless HMAC tokens are immune to ITP and private-browsing cookie restrictions because they carry no server-side state -- nothing to look up, nothing to lose on a blocked cookie jar.
- The `iat`-window bound (30 min) gives the same CSRF protection as a short-lived cookie: a state token cannot be replayed after it expires.
- `OAUTH_JWT_SECRET` is already required for `codeflare_session` signing ([AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode)); reusing it for state signing adds no new secret-management surface.
- Failure path is explicit: state verification failure redirects to `/?error=session-expired` rather than a generic 500.

**Trade-offs accepted:**

- A compromised `OAUTH_JWT_SECRET` now also allows forging state tokens (not just session cookies). The attack surface increase is minimal -- an attacker with the secret could already forge sessions, which is the higher-value target.
- The 30-min window is longer than the previous 5-min cookie TTL. The trade-off is intentional: the broader window accommodates slow mobile networks and interrupted OAuth flows that previously forced re-login.

**Related requirements:** [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth) (GitHub OAuth CSRF protection)

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

**Related requirements:** [REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) (Pro mode skills/rules/agents/MCP, now also covers tier-gated context-mode delivery)

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

**Status:** Superseded by [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) (2026-05-12). The `<!-- doc-allow-large -->` hatch mechanism this ADR relied on was ripped out. The unified ADR file is preserved for the same anchor-stability reason, but the budget rule no longer offers a per-file opt-out -- the file-size finding is now a known LOW that the operator defers via `sdd/.review-decisions.md` if at all.

**Decision (still in effect):** All ADRs live in a single `decisions/README.md`. AD-N identifiers are referenced throughout the codebase, so splitting into one file per ADR would mean rewriting every inbound `README.md#ad-N` anchor for no product value. The file-size overage is an accepted, known LOW the operator defers; per-ADR budget enforcement still applies, so any new ADR over the per-ADR cap is split or compressed. Only the `<!-- doc-allow-large -->` hatch-exemption machinery was superseded ([AD51](#ad51-rip-out-six-overengineered-sdd-framework-features)).

---

### AD51: Rip out six overengineered SDD framework features

**Status:** Accepted (2026-05-12)
**Supersedes:** [AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list), [AD50](#ad50-unified-adr-file-with-structural-doc-allow-large-exemption)

**Category:** Architecture

**Context:** A third-wave architect review of the SDD framework after the second-wave fixes surfaced 30 findings. Per-finding triage on the highest-severity ones revealed that several of the framework features themselves -- not bugs in their implementation but the features as designed -- were adding surface area without proportionate value. User feedback during triage was unambiguous: "overengineered bullshit, remove all commit category idiocity", "wtf is this overengineered shit now". The decision was to rip the six worst offenders before continuing to act on architect findings on what remained.

**Decision:** Remove the following six features from the SDD framework:

1. **ADR Overrides skip-list** ([AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list)). The `Overrides: {rule}:{target}` ADR header that spec-reviewer / doc-updater parsed at the start of every run to skip matching findings. If a finding keeps re-firing, fix the underlying rule or REQ -- no per-rule bypass.
2. **Hatch markers + audit** ([AD50](#ad50-unified-adr-file-with-structural-doc-allow-large-exemption) and supporting machinery). `<!-- sdd-allow-large -->`, `<!-- doc-allow-large -->`, and `<!-- doc-template-exempt -->` markers plus the Pass 6 / Pass 10 ADR-cross-check audit. Oversized files produce a finding; the operator defers via `sdd/.review-decisions.md` if appropriate.
3. **REQ split-proposal mode**. spec-reviewer draft files at `sdd/.split-proposals/{REQ-ID}.md` consumed by `/sdd clean` on `**Status:** Approved`. Oversized REQs shrink in place; the user splits manually when actually needed.
4. **Out-of-Scope collision check**. Full-spec pass cross-referencing `## Out of Scope` bullets against shipped REQs with content-word-overlap heuristics. Spec drift is normal-quality work, not a separate detector.
5. **Anti-spiral "category" matching**. Round counter required `≥2 commits on the same target REQ-ID or category` parsed from the commit subject's `fix(spec): {category}` infix. Simplified to `≥2 of the last 3 lane-scoped commits` -- same protection, no parser.
6. **`Implements REQ-X-NNN` annotation enforcement**. code-reviewer flagged source files implementing a REQ's behavior without the annotation. spec-reviewer CQ-2 cross-walked source annotations against REQ ACs. Annotations remain a human-discoverability convention but are no longer flagged. The test-name-based coverage check is the load-bearing signal.

doc-discipline drops from twelve passes to ten (deleted Pass 6 hatch audit and Pass 10 hatch overuse). spec-discipline drops CQ-2, CQ-4, and CQ-6 (kept and renumbered CQ-1/CQ-3/CQ-5 to CQ-1/CQ-2/CQ-3). `/sdd clean` drops the legacy `sdd/.user-overrides.md` migration step. `/sdd mode` no longer lists recent ADR overrides.

**Consequences:** Smaller surface for both the agent author and the human operator. [AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list) and [AD50](#ad50-unified-adr-file-with-structural-doc-allow-large-exemption) are marked Superseded but preserved for anchor stability. Architect findings that still need addressing on the remaining surface (six HIGH fixes from the third-wave review) are tracked separately. The framework now has: `/sdd init`, `/sdd clean`, `/sdd mode`, the three-agent PR-boundary pipeline, transition state, and the three discipline rules (spec / doc / tdd). That is the entire surface.

**Issue:** Architect review triage 2026-05-12; user authorization in conversation.

---

### AD52: Graphify MCP available everywhere, discipline advanced-only

**Status:** Accepted (2026-05-14)

**Category:** Architecture

**Context:** Graphify (upstream `graphifyy` Python package, Apache-2.0) turns a folder into a queryable knowledge graph and exposes it via an MCP server (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`). Integrating it into Codeflare required a tier-gating decision: every preseed plugin so far chose between "advanced-only" (codeflare-memory, codeflare-hooks) and "custom-tier-only" (context-mode via [AD49](#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install)). Graphify did not fit either bucket cleanly. The MCP server itself is harmless ambient capability that any session benefits from when the user reaches for it; the discipline that says "use the graph before grepping" is what produces token savings and is what changes agent behaviour.

**Decision:** Split delivery on a discipline-vs-capability axis, not on tier:

- **Plugin folder + `plugin.json` + MCP server registration**: ships in both `default` and `advanced` session modes. The `graphify` MCP server is registered in `~/.claude.json` whenever the preseed manifest is present, which is every paid tier.
- **SessionStart context-injection hook, PostToolUse-on-clone triage hook, `graph-first.md` rule, and `graphify/SKILL.md`**: ship in `advanced` session mode only. These are the load-bearing pieces that teach the agent to use the graph proactively.

Tier-gating is not part of the decision: graphify ships uniformly across standard, advanced, max, and custom paid tiers. The discipline gating is keyed only on session mode.

**Consequences:**
- Default session mode users CAN reach for graphify by name (CLI on PATH, MCP tools exposed) but do not get nudged toward it. No SessionStart reminder, no triage on clone, no rule in `~/.claude/rules/`.
- Advanced session mode users get the full discipline: the agent reads `GRAPH_REPORT.md` at session start when a graph exists, prompts on clone, prefers focused MCP queries over Grep for architecture questions, and gets a PreToolUse soft-nudge when reaching for Grep/Glob (or the context-mode grep-equivalents `ctx_search`/`ctx_batch_execute`) in a repo that has a graph.
- Image cost (~220 MB for Python + tree-sitter wheels) is paid by every container regardless of mode, justified by one-time build cost vs. universal capability.
- Coexists cleanly with context-mode ([AD49](#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install)) without depending on it. Graphify's own subagent-chunking model is the load-bearing context-bounding mechanism for `/graphify` extraction; context-mode routing through `ctx_execute` is bonus per-subagent savings when present. The `enforce-ctx-mode.sh` Bash whitelist gets `graphify` added (in custom tier where the file ships) but no behaviour depends on that whitelist for other tiers. The graph-first soft-nudge hook covers both tier paths: `Grep`/`Glob` matchers fire in non-custom tier where those tools are not denied; `mcp__context-mode__ctx_search`/`ctx_batch_execute` matchers fire in custom tier where the agent is routed through ctx for grep-equivalents.
- The MCP server registration is keyed on `GRAPHIFY_MANIFEST` presence rather than `SESSION_MODE`, so the "capability everywhere" half is enforced by the manifest gate rather than a mode check.
- Persistence model: graphify artifacts (`graphify-out/`) live in the repo, not in R2. Repo owners commit `graphify-out/graph.json`, `GRAPH_REPORT.md`, and `graph.html` to git; the working tree gets them on clone and contributors inherit both the graph and a browser-openable interactive visualization for free. Repos without push permission keep the graph local-only and ephemeral. R2 bisync explicitly excludes `**/graphify-out/**`. The container image registers the graphify semantic merge driver globally (`git config --global merge.graphify.driver`) so any repo that wires `graphify-out/graph.json merge=graphify` in its `.gitattributes` gets auto-resolution of concurrent `graph.json` edits without manual JSON intervention. SKILL guidance instructs the agent on first build to add the canonical `.gitignore` block (regenerable build outputs under `graphify-out/`, the `.graphify_*` working-tree intermediates the build creates mid-run, and per-machine markers) and the merge-driver attribute line to `.gitattributes`. The full pattern list and rationale live in `/graphify` SKILL.md note 3; `documentation/container.md` mirrors the explanation.
- Obsidian stub vault is deliberately gitignored: `graphify-out/obsidian/` is a per-node markdown vault that gives an Obsidian-app user a familiar graph-browse UI, but every `graphify update .` rerun rewrites centrality + community-label frontmatter across all those files, producing PR diffs in the thousands of files for one structural change. The standalone `graph.html` covers the casual-browse use case in any browser without needing Obsidian installed, and a developer who actually wants the Obsidian workflow can regenerate the stub vault locally from `graph.json` in seconds. The trade-off keeps PR signal clean at the cost of one local command for the rare power-user.

**Alternative considered:** Match context-mode ([AD49](#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install)) and gate the whole thing on custom tier. Rejected: graphify's MCP query tools are cheap, structurally bounded, and useful even when no discipline rule pushes the agent toward them. Hiding the capability behind a tier wall would have been more conservative but would have wasted the build-time install for the 99% of paid users who are not on custom tier.

**Issue:** [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify); PR #354.

---

### AD53: Graphify hot-reload wrapper with multi-repo sentinel tracking

**Status:** Accepted (2026-05-14)

**Category:** Architecture

**Context:** Two problems surfaced after [AD52](#ad52-graphify-mcp-available-everywhere-discipline-advanced-only) shipped. First, upstream `graphify.serve` `sys.exit(1)`s when `graphify-out/graph.json` is missing at startup. Codeflare sessions start with an empty workspace and a user typically clones one or more repos mid-session, so the MCP server died on every fresh session and there was no way to restart Claude Code without losing the container (killing the session kills the Durable Object). Second, sessions typically hold 2-3 cloned repos; the MCP server is one persistent process and has no native notion of "the current repo." When the agent moved between repos via Bash `cd`, ctx_execute, git/gh clone, or simply by editing files in a different directory, the wrapper bound G to whichever path resolved first at startup and never switched, silently returning wrong-repo answers.

**Decision:** Two coupled mechanisms:

1. **`graphify-mcp-lazy.py` wrapper** ships to both `default` and `advanced` session modes (ambient capability, paired with the MCP registration per [AD52](#ad52-graphify-mcp-available-everywhere-discipline-advanced-only)). The wrapper monkey-patches `graphify.serve._load_graph` to return a `LazyGraph` (subclass of `nx.DiGraph` so `isinstance` checks in graphify and networkx pass cleanly). LazyGraph starts empty, then a daemon watcher thread polls the active graph file every `GRAPHIFY_POLL_SECONDS` (default 2s); on mtime change, it builds a fresh `nx.DiGraph` and swaps the underlying `_node`/`_adj`/`_pred`/`_succ`/`graph` dict members atomically under a lock so concurrent readers (graphify's tool handlers running on the main thread) never see a half-mutated graph. The tool list stays static (the upstream graphify tools); only G's contents swap.

2. **`graphify-active-repo.sh` PostToolUse hook** ships to `advanced` session mode only. It writes the agent's current repo root to a sentinel at `~/.cache/codeflare-hooks/graphify-active-cwd`. Matcher set is `Bash | Edit | Write | Read | NotebookEdit | mcp__context-mode__ctx_execute | mcp__context-mode__ctx_execute_file | mcp__context-mode__ctx_batch_execute` because the cwd signal differs by tool surface and tier: Bash uses Claude Code's session cwd which updates on `cd`; Edit/Write/Read provide an absolute `file_path` that the hook walks up to find a `.git/` or `graphify-out/` ancestor; ctx_execute variants need the shell snippet parsed for `cd X` because Claude Code's session cwd never sees changes inside ctx_execute subshells. The wrapper polls the sentinel and rebinds G when it changes. When the sentinel is absent (default mode, or before the first hook fires), the wrapper falls back to the freshest mtime across `CODEFLARE_WORKSPACE/*/graphify-out/graph.json`.

**Consequences:**
- Sessions starting empty no longer require a Claude Code restart to bring graphify online. The MCP shows as connected from the first prompt; tool calls return empty (`Nodes: 0`) until a graph appears.
- Multi-repo precision is advanced-only. Default-mode users typing `/graphify` explicitly for a single repo get correct answers via the freshest-mtime fallback; default-mode users juggling multiple graphs would get wrong-repo answers, but that path is rare-by-design (no SKILL or clone-prompt is preseeded to push them toward multi-graph builds).
- Per-branch graphs are not supported. The wrapper reads `<repo>/.git/HEAD` only for an informative stderr log line on rebind. Users run `graphify update` after a checkout; the wrapper's mtime watcher picks up the rebuild within 2 seconds. Forking graphify upstream to model branches was rejected as out of scope and orthogonal to the codeflare integration.
- Reader-safety is load-bearing: an earlier draft used `G.clear()` + `G.add_nodes_from()` and crashed graphify tool handlers mid-iteration under the exact workload the wrapper was built for (`graphify update` immediately followed by `query_graph`). The atomic dict-swap pattern resolves this without forking graphify or wrapping the tool handlers.
- Sentinel race under concurrent batch-execute hooks is acceptable: last writer wins, wrapper converges within 2 seconds. Hook only rewrites on change so mtime churn is bounded.

**Alternative considered:** Spawn one MCP server per repo on first `cd` into it. Rejected because Claude Code does not natively support per-cwd MCP servers, the spawn/teardown logic would have to live in `entrypoint.sh` with `proc` watching, and the wrapper-based approach lets a single process handle every repo in the session at the cost of one short stderr log line per rebind.

**Alternative considered:** Pass repo path as an explicit MCP tool argument on every call. Rejected because graphify's upstream tool handlers query G in closure and would need rewriting; relying on the agent to remember a `repo_path` arg every invocation would silently degrade in practice.

**Issue:** [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify).

---

### AD54: Vault directory must use a non-hidden basename

**Category:** Storage

**Status:** Accepted

**Context:** The original vault path was `/home/user/.user_vault/`. SilverBullet's disk walker (`server/disk_space_primitives.go` `FetchFileList`) aborts the directory walk immediately when the root directory's basename begins with `.`, returning an empty file listing even when notes are present on disk. This is not a configurable behaviour in SilverBullet 2.8 -- it is hardcoded in the Go source. The result was that opening the vault in the editor showed no files at all despite a populated directory on disk.

**Decision:** The vault directory is renamed to `/home/user/Vault/` (non-hidden basename). All references in entrypoint.sh, bisync filters, preseed scripts, agent rules, Worker route, audits, and tests are updated in the same commit. The internal identifier `init_user_vault()` and the `--as user_vault` global-graph tag are preserved (no manifest migration needed). R2 is a clean cutover for the single existing user; prior `.user_vault/` content in R2 is abandoned rather than migrated.

**Constraint (permanent):** The vault directory must never be renamed to a dot-prefixed basename. Any future relocation of the vault must preserve a non-hidden basename or the SilverBullet disk walker will silently return an empty file list. This constraint is documented in `documentation/lanes/vault.md#directory-layout` and enforced by the `host/__audits__/entrypoint-vault.audit.js` structural audit (checks that the supervisor command references `$HOME/Vault`, not `$HOME/.user_vault` or any other hidden path).

**Consequences:**
- SilverBullet correctly walks and indexes all vault files after rename.
- The path `/home/user/Vault/` is visible in `ls /home/user/` output (non-hidden), which is the desired UX: users can see the vault directory without `ls -a`.
- The bisync filter gains `+ Vault/**` (replacing `+ .user_vault/**`). Filter order is preserved: vault include comes before the global `- **/graphify-out/**` exclude so the vault's own `graphify-out/` subdirectory is included in sync.

**Alternative considered:** Configure SilverBullet via `SB_SPACE_FOLDER` or a command-line flag to skip the hidden-basename check. Rejected: the check is not configurable in SilverBullet 2.8's Go source; patching the binary was out of scope.

**Alternative considered:** Mount the dot-prefixed directory into a non-hidden path via bind mount or symlink. Rejected: adds fragile entrypoint complexity and bisync would still see the original dot-prefixed path. A clean rename is simpler and permanent.

**Related REQ:** [REQ-VAULT-001](../../sdd/spec/vault.md#req-vault-001-persistent-vault-directory-survives-across-sessions).

---

### AD55: Codeflare brands the vault editor via preseed-managed STYLES.md

**Category:** Architecture

**Status:** Accepted

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

**Related REQ:** [REQ-VAULT-001](../../sdd/spec/vault.md#req-vault-001-persistent-vault-directory-survives-across-sessions) (AC7 lists the four preseed-authoritative pages including STYLES.md).

---

### AD56: 15-minute bisync cadence with manual triggers

**Category:** Storage

**Status:** Accepted (2026-05-18)

**Context:** The periodic rclone bisync daemon ran every 60 seconds, producing ~1440 invocations per session per day even on idle sessions. Each invocation does at minimum one LIST on each side plus N HEADs across both encrypted and unencrypted configs; for users with multiple active sessions the R2 operation count scaled into terabytes/month of metadata traffic and Class A operations. The dominant cost was not transferred bytes but listing overhead on idle sessions.

Three options were considered: (a) keep 60s, (b) inotify-driven local-flush plus a 15-minute ceiling, (c) pure 15-minute cadence with explicit user-driven triggers. Option (b) was initially recommended for its sub-minute convergence on active sessions, but the Claude-projects directory writes session transcripts continuously and would trigger the inotify wake on every keystroke; restricting inotify to specific folders added complexity without clearly winning over option (c). Option (c) was chosen for simplicity.

**Decision:** The periodic bisync runs every 15 minutes. Three trigger points cover the gap:

1. **15-minute wall clock** -- the daemon's `sleep` is interruptible by SIGUSR1, otherwise wakes after 900 seconds.
2. **Manual UI trigger** -- the storage panel's Sync-now button posts to `POST /api/sessions/sync`, which fans out per-session triggers across all the authenticated user's running sessions.
3. **Final sync at shutdown** -- the Container DO drains a fresh bisync via an awaited `POST /internal/final-sync` while the container is still running, BEFORE signalling stop (the SIGTERM trap is now only a backstop, since the platform SIGKILLs ~3s after stop) ([REQ-STOR-005](../../sdd/spec/storage.md#req-stor-005-graceful-shutdown-performs-final-sync), [REQ-SESSION-011](../../sdd/spec/session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync), [AD57](#ad57-135-second-shutdown-budget-for-final-bisync)).

An earlier draft of this ADR included a fourth trigger ("upload-side auto-trigger" -- fire-and-forget fan-out on every R2 PUT through the storage panel). It was removed: a single 20-file drag-drop produced 20 separate KV-enumeration + fan-out RPCs, blowing Worker subrequest budget for a feature the Sync-now button + 15-minute cadence already cover at lower cost. The container-side SIGUSR1 trap coalesces to at most one in-flight + one queued bisync regardless, so the only thing the upload-side trigger ever gave us was Worker-layer waste.

The daemon's SIGUSR1 trap is coalescing: signals received during a running bisync set a rerun-requested flag rather than queueing, so N signals during one cycle produce exactly one rerun after the current cycle completes.

**Why fan-out across sessions is safe (and serial would not be better):**

- bisync uses `--conflict-resolve newer`. Newest-mtime-wins is commutative and associative on absolute mtime: for any file with versions across N sessions, the final R2 state is always `max(mtime_1, ..., mtime_N)` regardless of order.
- The system already runs in this concurrent mode every 60 seconds today for any user with multiple active sessions -- the existing `--check-sync=false / --resilient / --recover / --ignore-checksum / --max-delete 100` flag set was added precisely to harden bisync against listing divergence from concurrent writers. Manual fan-out introduces no new concurrency model.
- R2 (S3-compatible) guarantees atomic per-object writes. Concurrent LISTs from different sessions see slightly different snapshots, but each individual file is either fully old or fully new -- never partial.
- Serial fan-out would be ~Nx slower with no different outcome. Worse, the "winner" under serial would depend on which session the Worker happened to schedule first, replacing a mathematically deterministic max-mtime outcome with an arbitrary one.

**Consequences:**
- Estimated ~14x reduction in R2 ops on idle sessions (96 cycles/day vs 1440).
- Ungraceful exit (OOM, container eviction, kernel panic) can lose up to 15 minutes of work. Graceful exit (idle stop, explicit delete, user stop) remains safe via the awaited final-sync drain before stop ([AD57](#ad57-135-second-shutdown-budget-for-final-bisync) Revision).
- Multi-tab convergence latency widens from <=60s to <=15min unless the user clicks Sync-now.
- Storage-panel-after-terminal-write freshness widens to <=15min unless the user clicks Sync-now.
- Tier-uniform: free, standard, advanced, max, and custom paid tiers all run on the same cadence.

**Alternative considered:** inotify-driven local-flush with a 15-minute ceiling. Rejected: requires either watching the whole filesystem (Claude-projects flooding) or per-folder include lists (complexity that pure 15-min plus Sync-now avoids). The simplicity win outweighed the sub-minute convergence loss for active sessions.

**Alternative considered:** Activity-gated 60s plus 15-min idle fallback. Rejected: same complexity floor as inotify without the upside; misses out-of-band writes (vault editor on host).

**Related REQ:** [REQ-STOR-003](../../sdd/spec/storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers) (rewritten in this change), [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui) (manual trigger surface).

---

### AD57: 135-second shutdown budget for final bisync

**Category:** Storage

**Status:** Accepted (2026-05-18)

**Context:** The pre-existing Container DO `destroy()` budget was 75 seconds (vault rollout had already raised it from 25s -> 75s when vault edits in the last seconds before shutdown were silently truncated by the SDK's SIGKILL mid-bisync). The entrypoint shutdown handler's watchdog was 60 seconds (50s SIGTERM + 10s SIGKILL), nested cleanly inside the 75s DO budget with 15s buffer for clean process exit.

Under the new 15-minute cadence ([AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers)), any single bisync run can accumulate more changes than under the old 60s cadence -- in the worst case, up to ~15 minutes of writes since the last sync. The 60s shutdown watchdog is therefore too tight: large vault edits or workspace deletes accumulated over a long idle window can routinely exceed 60s on the final bisync, triggering the watchdog's SIGKILL mid-write and leaving R2 in a partial state.

**Decision:** Raise the shutdown chain by 60 seconds at both layers:

- **entrypoint shutdown_handler watchdog**: 50s SIGTERM + 10s SIGKILL -> 108s SIGTERM + 12s SIGKILL (120 seconds total).
- **Container DO `destroy()` timeout**: 75_000ms -> 135_000ms (120s bisync + 15s clean-exit buffer, preserving the existing 15s margin between the entrypoint giving up and the SDK SIGKILL).

The DO's `_shutdownStartedAt` telemetry already logs `shutdownElapsedMs` on `onStop()`. Augment with a `logger.warn` at 110 seconds elapsed so any session approaching the new budget surfaces in logs and we can bump again if real-world bisyncs routinely exceed 110s.

**Revision (2026-06-04) -- the final sync moved off the SIGTERM trap onto an awaited live drain:** The original decision assumed the entrypoint's SIGTERM trap would run the final bisync inside the 108s/120s grace, with the 135s DO budget nested cleanly around it. Production proved that assumption false: the platform SIGKILLs the container ~3 seconds after the DO signals stop, never honoring the 108s SIGTERM grace. The logs are unambiguous -- `shutdownElapsedMs:2960`, `Graceful shutdown complete elapsed:3000`, and `onStop` firing at 16.824 BEFORE `Graceful shutdown complete` at 16.864 (the container dies before `superDestroy()`). The trap's final bisync was therefore always cut off, and under the 15-minute cadence ([AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers)) that meant a session stopped or deleted shortly after edits lost everything since the last cadence sync (observed: a session deleted then recreated under the same agent was missing its last few minutes of work). Manual and cadence syncs worked precisely because they run while the container is fully alive (SIGUSR1 to the daemon), not during the kill grace.

The fix is the synchronous-drain RPC the "Alternative considered" below originally rejected: before signalling stop, the DO drains a fresh bisync while the container is still running and the DO holds teardown open. `drainFinalSync` (container-metrics.ts) calls a new awaitable host endpoint `POST /internal/final-sync` (host/src/server.ts) that triggers the daemon via SIGUSR1 and blocks until that run reaches a terminal status; completion is detected by a monotonic epoch-ms `ts` stamp on `sync-status.json` plus a `syncing` emission before each daemon run, so the endpoint waits for OUR triggered run (`syncing` stamped strictly after the trigger, then `success`/`failed`) and ignores an already-in-flight bisync. `destroy()` awaits the drain (120s budget, best-effort) before `stop('SIGTERM')`; idle-stop and quota-stop in `collectMetrics` drain identically; STOP and DELETE both route through `destroy()` so they behave identically by construction. The 135s teardown hard-cap and the 110s warn threshold are unchanged and now bound the drain-then-stop sequence (120s sync + 15s stop). The SIGTERM trap is retained as a best-effort backstop, not the primary mechanism. The cost is that a deliberate stop/delete now blocks up to ~120s in the worst case (large unsynced accumulation) to guarantee no loss -- the same user-accepted floor the original budget already implied, now actually enforced. See [REQ-SESSION-011](../../sdd/spec/session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync).

**Revision (2026-06-10) -- the host endpoint's internal timeout was inverted *below* the DO budget:** The 2026-06-04 live-drain fix was still losing the last edits on delete in production. Root cause, confirmed in code: the in-container final-sync endpoint capped its own poll loop at `INTERNAL_TIMEOUT_MS = 115_000` -- *below* the DO's 120s drain budget (the comment literally read "just under the DO's 120s budget"). For any final bisync landing in the 115-120s band -- exactly the long-idle sessions AD56's 15-minute cadence produces -- the host returned 504 first, `drainFinalSyncAudited` mapped it to `incomplete`, and the session deleted with unsynced edits. Every prior "raise the budget" attempt raised numbers on the wrong side of the inverted ceiling, and a regression test (`host/__tests__/final-sync-endpoint.test.js`) even asserted the inversion (`INTERNAL_TIMEOUT_MS < 120_000`) as an invariant, so any correct fix would have failed CI -- a large part of why this survived ~10 attempts. **Fix:** the host endpoint timeout is raised strictly ABOVE the DO budget (`125_000`), so the DO's `AbortSignal(120s)` is the sole authoritative ceiling; the guard test now asserts host `> 120_000`; and `finalSyncAudit` additionally records the final-sync HTTP status + reason + session id so a residual non-completed sync is queryable post-mortem. Per the product decision, a genuinely >135s sync still deletes (data loss accepted past the hard cap) -- but it is now audited, not silent. A suspected rclone state-wedge (held lock / stale `.lst` poisoning the next session) was ruled out: those live in `~/.cache/rclone/bisync`, which is both ephemeral per container and excluded from R2 sync (`--filter "- .cache/**"`), so a fresh session cannot inherit a wedged baseline -- no entrypoint change was warranted.

**Revision (2026-06-10, later the same day) -- the drain never reached the timeout machinery at all: it 401'd at the in-container auth gate on every single stop/delete.** Live-incident forensics (integration, full Workers Observability history) showed every teardown drain failing in ~51-300ms with HTTP 401 -- and **zero successful teardown final syncs ever recorded in ≥30 days of logs**, before AND after the budget-inversion fix shipped. Root cause: both drains (`drainFinalSyncAudited` on delete, `drainFinalSync` on idle/quota-stop) called the host with a bare `port.fetch('http://localhost/internal/final-sync')`. The raw TCP-port fetch bypasses the DO's public `fetch()` override -- the only place the `Authorization: Bearer` header is injected (the reason `/health` and `/activity` are explicitly auth-exempt in `host/src/auth-check.ts`; `/internal/final-sync` is not) -- so the host's auth gate rejected the drain before the final-sync handler ever ran. Compounding it on the delete path, `destroy()` wipes `containerAuthToken` from storage and memory *before* the drain fires (REQ-SESSION-009 resurrection-guard ordering), so even an auth-aware drain would have had no token to send. The manual storage-panel "Sync R2" button always worked because it routes through the worker's authenticated container fetch -- the working reference path that exposed the contrast. **Fix:** `destroy()` captures the token before the storage clear (alongside the audit session id) and passes it to the drain; both drains now set `Authorization: Bearer <token>` (the idle/quota-stop path reads the still-intact token from DO storage). The budget-inversion fix above remains correct and necessary -- but it was unreachable behind this 401; the auth header is the prerequisite for any of the timeout machinery to matter. REQ-SESSION-011 AC8 pins the behavior; tests assert the header on both paths and that the delete-path token is the pre-clear capture.

**Consequences:**
- Final bisync has headroom for the worst-case 15-minute accumulation.
- Session-delete UX shows a "Saving final changes to storage..." spinner up to ~130 seconds before reporting success. The session-delete handler in `src/routes/session/crud.ts` already awaits `container.destroy()` end-to-end, so no fire-and-forget fix is required.
- The 2-minute SIGKILL is the user-accepted floor: anything still running at 120 seconds is hard-killed and the last writes accepted as potentially lost.
- If telemetry shows shutdownElapsedMs P95 exceeds 110 seconds in production, the budget can be raised again to 150s/165s without architectural change -- the warn threshold gives early signal.

**Alternative considered:** Telemetry-first canary -- ship the 15-min cadence behind an env var, gather shutdownElapsedMs P95/P99 for one week, then commit to the budget. Rejected by the user: the 2-minute budget plus SIGKILL is the explicit floor; if it is not enough, the warn threshold and post-merge telemetry will tell us within 24 hours.

**Alternative considered (originally rejected, ADOPTED 2026-06-04 -- see Revision above):** Block container destruction on an explicit "prepare-shutdown" RPC that runs the final bisync synchronously and only returns on completion. This was rejected in the original decision on the premise that "the existing trap-driven shutdown already runs the final bisync." That premise was wrong -- the trap is cut off by the ~3s platform SIGKILL -- so the awaited drain (`POST /internal/final-sync`) is now the primary mechanism and the trap is the backstop. Extending the budget alone never helped because the budget governs the DO's wait, not the container's lifetime after stop is signalled.

**Related REQ:** [REQ-STOR-005](../../sdd/spec/storage.md#req-stor-005-graceful-shutdown-performs-final-sync) (AC4 + AC5 codify the new budget).

---

### AD58: Sonnet for memory capture, with prefilter and scratchpad

**Category:** Memory

**Status:** Accepted (2026-05-18)

**Context:** [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault)'s capture pipeline ran haiku as the background subagent and read raw transcript JSONL directly. Two problems emerged in production:

1. **Recency bias.** A 1466-line transcript is ~3.8 MB of JSONL; ~99% of those bytes are `tool_use` and `tool_result` records. Haiku reading the raw stream burned its working memory on tool I/O and produced a capture summarising only the most recent topic. Bench: a session that ran 6 hours of R2-bisync design work yielded a 1431-byte note covering just the final 15 minutes' stop-hook mechanics; the substantive arc was lost.
2. **Confabulated citations.** Even after prefilter+chunking removed the recency bias, haiku invented adjacent ADR numbers in benchmarking (`AD58`, `AD59` cited in a note where the actual references were `AD56` + `AD57`). For a memory subsystem whose value is "queryable cross-session truth," false citations are worse than missing ones - they pollute the unified graph and mislead future agents that match on the wrong ID.

**Decision:** Three coupled changes that ship as one PR:

- **Prefilter pipeline.** New `prefilter-transcript.sh` runs a `jq` filter that drops tool_use/tool_result/thinking blocks, slash-command wrappers, task-notifications, hook feedback, resume markers, and meta records. Output is NDJSON of `{role, text, ts}` per kept entry. On the benchmark transcript: 3.8 MB raw → 50 KB clean (76× reduction).
- **Chunked scratchpad.** The capture agent splits the clean NDJSON into chunks of ~20 entries (`chunk-aa.md`, `chunk-ab.md`, ...), processes each chunk in turn, and appends per-chunk observations to a scratchpad file before synthesising the final note. The scratchpad becomes working memory; recency bias is structurally prevented because each chunk gets equal attention.
- **Model: sonnet, not haiku.** The capture agent runs at sonnet tier. Same-input bench against haiku: sonnet produced 52 bullets vs 30, cited 15 commit SHAs verbatim (haiku cited 0), and invented zero IDs vs haiku's 2. The model is bound at the agent-file level via frontmatter in `preseed/agents/claude/agents/memory-capture.md` (and `vault-extract.md` for the vault path); hook directives instruct the main agent not to pass a model override to the Task tool, so the pin cannot be silently downgraded by a caller.

Three smaller decisions bundled in:

- **Timezone for capture filenames** is resolved at capture time from `$USER_TIMEZONE` env var, then `$TZ`, then `/etc/timezone`, falling back to UTC. No hardcoded zone -- codeflare is forkable and users live everywhere. The container clock is typically UTC; the Dashboard auto-syncs the browser's IANA timezone to the `userTimezone` preference on mount ([REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env) AC5), so captures record the user's actual wall-clock time (filenames like `2026-05-18T14-22-15+0200-...md`) on the next session start after first login.
- **Prefilter script joins the manifest.** Adding `plugins/codeflare-memory/scripts/prefilter-transcript.sh` to `preseed/agents/claude/manifest.json` so it ships through the standard agent-seed pipeline. Otherwise the capture agent would call a script that does not exist in production.
- **Marker filter** explicitly excludes string content beginning with `<` (slash-command + task-notification wrappers), `Stop hook` (stop-hook feedback synthetic injection), `This session is being continued` (resume header), and `[Request interrupted` (interrupt notice). These were all leaking into the haiku's view of "real user prompts" before this pass.

**Consequences:**
- Capture cost rises ~3x per fire (haiku → sonnet pricing). The capture fires at most once per 15 real user prompts, so a typical long session triggers it 1-5 times. Absolute cost is cents per session - well worth the fidelity gain.
- Capture latency rises modestly: chunked-scratchpad introduces N+1 LLM round-trips per fire (one per chunk plus the synthesis pass). On the benchmark the haiku run took ~88 s end-to-end; sonnet with the new pipeline ~228 s. The agent runs in the background via `executionCtx.waitUntil`, so user-facing latency is unchanged.
- Vault notes are denser (5-10 KB typical vs 1-2 KB before). SilverBullet renders all of them fine; the unified graph picks up more concept nodes per capture, which improves cross-session retrieval recall.
- Stale `Raw/Sessions/` files written by the old pipeline are not migrated. They remain as historical record; future captures use the new format.

**Alternative considered:** Keep haiku and ratchet the prompt harder ("only cite IDs verbatim"). Rejected because haiku's confabulation is a model-level behaviour, not a prompt-comprehension issue; tightening the prompt reduces inventions on the margin but does not eliminate them, and the false-citation cost dominates the haiku cost saving.

**Alternative considered:** Prefilter only (keep haiku). Rejected as a half-measure: prefilter fixes recency bias, but the citation-accuracy gap (haiku invents IDs; sonnet doesn't) remains uncovered.

**Alternative considered:** Capture model gated by env var (default haiku, advanced users override to sonnet). Rejected as unnecessary mechanism - capture quality is a system-wide property, and the cost difference at the actual capture cadence is negligible. Per-user opt-out can be added later if cost telemetry shows it matters.

**Related REQ:** [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) (capture pipeline contract), [REQ-MEM-008](../../sdd/spec/memory.md#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline) (preseed manifest includes the new script).

---

### AD59: Zero-UI vault encryption with per-session DO-storage key

**Category:** Security
**Status:** Accepted (2026-05-18)

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

**Related REQ:** [REQ-VAULT-008](../../sdd/spec/vault.md#req-vault-008-zero-ui-vault-encryption) (zero-UI vault encryption + cold-start payload + IDB lifecycle), [REQ-VAULT-005](../../sdd/spec/vault.md#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (Worker proxy exposes vault editor).

---

### AD60: Pi memory capture reuses the AD58 contract and transcript prefilter

**Category:** Memory

**Status:** Accepted (2026-05-29)

**Context:** [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) raised Claude-side memory-capture quality with three coupled changes (jq prefilter, chunked scratchpad, sonnet-tier model) because the background capture agent was reading raw transcript JSONL, burning its working memory on tool I/O, and confabulating citations. Making Pi a first-class codeflare resident meant Pi had to capture memory at the same fidelity. The Pi extension previously carried a thin inline capture contract embedded in `memory-vault.ts` and sliced the raw last-40 transcript entries, which reproduced exactly the two failure modes [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) fixed: recency bias from raw tool records and weak citation discipline.

**Decision:** Pi memory capture reuses the [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) capture contract rather than maintaining a divergent Pi-specific one. Two full contracts are deployed as Pi-native preseed assets: `preseed/agents/pi/prompts/memory-agent-prompt.md` (the capture-agent contract) and `preseed/agents/pi/prompts/vault-extract-prompt.md` (the Vault-graph extraction contract). The generator maps `prompts/` to `.pi/agent/prompts/`, so both land at `~/.pi/agent/prompts/*.md`. `memory-vault.ts` no longer embeds an inline contract; it reads these files at spawn time. The raw last-40 transcript slice is replaced by a prefilter that keeps only user and assistant text and drops tool-call and thinking blocks before the capture subagent is spawned, mirroring [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)'s jq prefilter intent on the Pi tool surface.

**Consequences:**
- Pi captures inherit the [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)-grade contract verbatim, so cross-session memory written from Pi sessions carries the same citation discipline and arc-coverage as Claude sessions; both populate the same unified graph.
- The capture contract has a single owner in source. A future change to the [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) contract updates the Claude agent files and the Pi prompts from the same intent; the Pi copies are deployed prompts, not a fork.
- The prefilter shifts work to spawn time. The transcript is reduced to user/assistant text before the subagent reads it, so the subagent never sees raw tool I/O and recency bias is structurally prevented as on the Claude path.
- Stale captures written by the old thin-contract Pi path are not migrated; they remain as historical record.
- Later refinement ([REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) AC8, 2026-05-30): the prefilter input is the durable on-disk session transcript Pi persists for `/resume`, read via `ctx.sessionManager.getSessionFile()` and parsed by `parseSessionMessages` - not the volatile in-memory message buffer the original Pi path used. That buffer was empty immediately after a Pi reload/resume, so the first capture-boundary prompt produced a hollow "no substantive content" note even though the full session JSONL was on disk; reading the persisted file fixed it, and a skip-empty guard now suppresses the capture rather than writing a placeholder note.

**Alternative considered:** Keep the thin inline Pi contract and ratchet its prompt. Rejected for the same reason [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) rejected prompt-only tightening: recency bias is a function of feeding raw tool records to the model, not a prompt-comprehension gap, and a divergent contract drifts from the [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) source of truth over time.

**Related REQ:** [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) (conversation context automatically captured to Vault).

---

### AD61: Pi `/review` ships as a dedicated native skill

**Category:** Architecture

**Status:** Accepted (2026-05-29)

**Context:** The Claude `/review` UX is a slash command (`preseed/agents/claude/commands/review.md`) carrying a multi-phase review workflow. Slash commands are a Claude Code primitive; the generator does not deploy commands to other agents (see the "Excluded from non-CC transformed assets" list in [preseed.md](../lanes/preseed.md#multi-agent-preseed)). On Pi this left the user-invoked `/review` workflow with no home: PR-boundary enforcement was covered by `review-enforcement.ts`, and the transformed `git-review-pipeline` skill carries the enforcement spine, but neither reproduces the full user-driven review flow (scope flags, phased perspectives, reality-filter triage) that the Claude command provides.

**Decision:** Ship the Pi `/review` workflow as a dedicated Pi-native skill at `preseed/agents/pi/skills/review/SKILL.md` (full 11-phase workflow), deployed to `~/.pi/agent/skills/review/SKILL.md`. The native skill is distinct from `review-enforcement.ts` (PR-boundary HEAD watching) and from the transformed `git-review-pipeline` enforcement skill: the skill owns the user-requested review UX, while the enforcement extension owns the automatic PR-boundary gate. The Pi `review/SKILL.md` joins the Pi manifest as a native skill override so the generator does not also emit a transformed copy of any same-named Claude skill into the Pi skill set.

**Consequences:**
- Pi users get the full `/review` flow at parity with the Claude command, expressed in Pi-native tool and subagent vocabulary.
- The Pi-native skill count rises to two (graphify + review); both are native overrides the generator excludes from the transformed-skill emit for Pi.
- The review surface is split by responsibility on Pi: the native skill is the user-invoked path, `review-enforcement.ts` is the automatic PR-boundary path, and they do not duplicate each other's logic.

**Alternative considered:** Transform the Claude `/review` command into a Pi instruction file. Rejected because commands are deliberately excluded from non-CC transforms, and a command is a different surface from a skill; folding command prose into the single Pi instructions file would bury an on-demand workflow in always-on context.

**Alternative considered:** Rely solely on `git-review-pipeline` for both enforcement and user-invoked review on Pi. Rejected because the enforcement spine does not carry the phased user-review UX (scope flags, per-perspective passes, reality-filter), so Pi users would lose the `/review` experience entirely.

**Related REQ:** [REQ-AGENT-015](../../sdd/spec/agents.md#req-agent-015-review-command-for-multi-perspective-codebase-review) (`/review` command for multi-perspective codebase review), [REQ-AGENT-044](../../sdd/spec/agents.md#req-agent-044-review-agent-discipline-enforcement) (review-agent discipline enforcement).

---

### AD62: Pi model-name genericization with `CODEFLARE_MEMORY_MODEL` lever

**Category:** Architecture

**Status:** Accepted (2026-05-29)

**Context:** Codeflare is forkable and runs six AI tools; hardcoding a specific model name (for example a `sonnet` or `haiku` literal) into Pi-bound prose or extension code couples the deployment to one vendor's model lineup and goes stale as model names change. [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) pins the capture model for Claude via agent-definition frontmatter, but Pi subagents are spawned programmatically from `memory-vault.ts`, and the generator strips the `model` frontmatter field for runtimes that do not support it. Pi therefore needed a model-selection mechanism that names no model in the shipped artifact.

**Decision:** Two coupled changes. (1) Genericize model references in Pi-bound prose: Pi-facing documentation and extension code describe model selection by role ("higher-fidelity model", "session model") rather than by literal model name. The generator removes `model` frontmatter for runtimes that do not support it while preserving Pi subagent model pins where the runtime does. (2) Introduce the optional `CODEFLARE_MEMORY_MODEL` container env var (documented in [configuration.md](../lanes/configuration.md#container-environment)). When set, `memory-vault.ts` passes it as the `model` option to `service.spawn(...)` for the `memory-capture` and `vault-extract` subagents; when unset, no override is passed and the subagents inherit the session model. The lever pins capture/extract fidelity per [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) without a hardcoded model name anywhere in the preseed.

**Consequences:**
- The Pi preseed artifact names no specific model. An operator who wants [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)-grade capture fidelity on Pi sets one env var; the default behavior (inherit session model) is sensible with no configuration.
- Fork-friendliness is preserved: a fork running a different model lineup sets `CODEFLARE_MEMORY_MODEL` to whatever its highest-fidelity model is, with no source edit.
- The Claude and Pi capture paths reach the same outcome ([AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) fidelity) through runtime-appropriate mechanisms: frontmatter pin on Claude, env-var lever on Pi.
- The lever is capture-scoped. It does not change the session's primary model and is read only by the memory/Vault-extract spawn path.

**Alternative considered:** Hardcode the [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) model literal into the Pi extension. Rejected because it staleness-couples the fork to one vendor's naming and contradicts the no-hardcoded-model-name discipline; a model rename would silently break or mislabel the pin.

**Alternative considered:** Reuse `SESSION_MODE` or another existing variable to imply the capture model. Rejected as overloading: `SESSION_MODE` already controls memory persistence and rclone filters, and conflating model fidelity with session mode would make both harder to reason about.

**Related REQ:** [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) (conversation context automatically captured to Vault), [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents) (support multiple AI coding agents).

---

### AD63: Pi `safe-graphify-update.sh` is a thin bounded upstream-update wrapper

**Category:** Architecture

**Status:** Accepted (2026-05-29); revised (2026-06-02)

**Context:** [AD53](#ad53-graphify-hot-reload-wrapper-with-multi-repo-sentinel-tracking)'s graphify hot-reload wrapper hardens `graphify update` on the 1 vCPU container by capping virtual memory (`ulimit -v`) and worker count so a runaway AST rebuild dies with ENOMEM instead of OOM-killing the session. Earlier Pi guidance added a divergent two-step wrapper that ran extra clustering/report logic after `graphify update`. That divergence proved brittle as upstream Graphify gained the desired extract/build/cluster/label/report/html pipeline: Codeflare-specific post-processing risked stale IDs, duplicate edges, and drift from official `safishamsi/graphify` output.

**Decision:** The Pi wrapper stays only as a safety envelope around upstream `graphify update`. It resolves the target repository, applies the bounded resource environment (`GRAPHIFY_MAX_WORKERS`, `GRAPHIFY_SAFE_RLIMIT_KB`, and `GRAPHIFY_VIZ_NODE_LIMIT`), then delegates graph output to Graphify. It does not hand-edit graph JSON, normalize imports, apply Codeflare-specific allowlists, or run a custom cluster pass. First-time Pi full AST builds use `build-graphify-ast.sh`, which calls Graphify's own detect/extract/build/cluster/report/export modules for the missing-graph case. Pi Architecture graph builds use `build-graphify-architecture.sh`, which applies generic noise filters and projects Graphify's symbol graph into file/module dependencies for navigation. Full semantic builds have Pi Agent subagents write Graphify-schema cache chunks/local fragments, recreate a fresh AST-only baseline, and merge cached/new semantic data without passing semantic source files as `prune_sources` (Graphify prunes after adding). Community labels are written by the active Pi main session to `.graphify_labels.json`, then local Graphify module calls regenerate graph/report/html from existing community assignments. Build, update, and label-apply paths generate `callflow.html` next to `graph.html`.

**Consequences:**
- Codeflare keeps the 1-vCPU safety limits without forking Graphify's output semantics.
- Graph IDs, clusters, report contents, HTML visualization, and community labels stay compatible with upstream Graphify.
- Pi and Claude Graphify behavior converge around official Graphify flows; Pi-specific code exists only for runtime prompting, architecture-scope filtering/projection, cache production by session agents, active-repo fallback, and resource bounds.
- The structural gate in `codeflare-pi.ts` remains fail-open: a missing or failed graph never blocks user work.

**Alternative considered:** Keep the previous fail-closed/two-step Pi wrapper. Rejected because the custom post-processing duplicated upstream responsibilities and could reintroduce stale/duplicated graph structure after Graphify upgrades.

**Alternative considered:** Run bare `graphify update` without a wrapper. Rejected because the 1-vCPU Codeflare container still needs bounded memory and worker defaults to avoid crashing the session.

**Related REQ:** [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) (knowledge-graph capability via graphify), [REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch) (graphify build-mode dispatch).

---

### AD64: Durable review lanes load extensions additively behind the `noExtensions` shield

**Category:** Architecture

**Status:** Superseded by [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes) (2026-06-08)

**Context:** PR-boundary review enforcement ([REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)/053/054) runs each lane as an in-process `createAgentSession` (`review-jobs.ts::runDurableLane`) with `DefaultResourceLoader({ noExtensions: true })`. That shield exists because extension factories run synchronously during load (pi's `loader.js` `await factory(api)`), and `review-enforcement.ts`'s factory writes a process-global run token (`__codeflareReviewEnforcementRun`) at load time; if a lane loaded that extension in the same process it would overwrite the token and silently disable the **main** session's enforcement (the merge gate). `@gotgenes/pi-subagents` similarly couples in-process state. But the blunt `noExtensions: true` also stripped every useful capability, leaving lanes with only the 7 built-in tools: reviewers had no `graphify_*`, no `ctx_*`, and none of `codeflare-pi`'s guards. A transient `gh pr view` failure once dropped the merge gate by mis-classifying a live head as stale (the "failure #13" referenced in `review-helpers.ts`); `classifyReviewHead` now separates `stale` from `unknown` to keep the gate fail-closed, and the durable `.git/`-persisted state makes that classification recoverable.

**Decision:** Keep `noExtensions: true` and load capabilities **additively** via `additionalExtensionPaths` (which still load under `noExtensions`): always the graphify package, the `context-mode` package only when enabled in Pi settings (so lanes inherit `/ctx on`), and `codeflare-pi.ts` as a local file (for the local-build blocker, attribution gate, and graphify-first gate). `review-enforcement` and `@gotgenes/pi-subagents` are never added, so neither clobbers the main session. Lane source selection is the pure `review-job-helpers.ts::laneExtensionSources`. `codeflare-pi`'s `session_start` global-graph merge is skipped inside lanes via a `globalThis.__codeflareReviewLaneDepth` counter set by `runDurableLane`, avoiding a redundant `graphify global add` subprocess per lane on the 1 vCPU container.

**Consequences:**
- Reviewers gain graphify and (when enabled) context-mode, and run under the same build-blocker/graphify-first gates as the main agent.
- The `noExtensions` shield is load-bearing and must stay; a future maintainer must not "simplify" by removing it, because that reloads `review-enforcement`'s clobbering factory in-process.
- `extensionsOverride` cannot substitute for this: it filters after factories have already run, so it cannot prevent the load-time global clobber.
- graphify tools spawn bounded Python; lanes are steered (system prompt) to read-only `graphify_query/path/explain`.

**Alternative considered:** Remove `noExtensions` and filter `review-enforcement` out with `extensionsOverride`. Rejected: factories run during load, so the clobber happens before the filter.

**Alternative considered:** Self-guard `review-enforcement` to no-op when loaded in a lane. Rejected as the primary mechanism: it does not cover `@gotgenes/pi-subagents`' in-process coupling, and the additive allowlist is simpler and strictly scopes what a lane can load.

**Related REQ:** [REQ-AGENT-060](../../sdd/spec/agents.md#req-agent-060-pi-durable-review-lane-tool-surface) (durable review lane tool surface), [REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch) (PR-boundary lane classification and dispatch), [REQ-AGENT-054](../../sdd/spec/agents.md#req-agent-054-pi-durable-review-lane-failure-handling) (durable lane failure handling).

---

### AD65: Gemini CLI replaced by Antigravity (agy)

**Category:** Architecture

**Status:** Accepted (2026-05-30); the no-preseed-lane clause is superseded by [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored) (2026-06-01).

**Context:** `@google/gemini-cli` (npm, `gemini` command) was removed from the Dockerfile and entrypoint. The replacement is Antigravity (`agy`), Google's successor CLI, installed via `curl -fsSL https://antigravity.google/cli/install.sh | bash` as a Go-native binary. Because `agy` is not an npm package it is excluded from the V8 compile-cache warm-up step (same as `opencode`). The `~/.gemini/settings.json` auto-update suppressor written by Fast Start is also removed; `agy` has no equivalent config-file suppressor mechanism at this time.

**Decision:** Install Antigravity via its official curl installer in the Dockerfile. Do not add it to the npm `install -g` line. ~~Antigravity gets no preseed adaptation lane (it has no stable config-file convention to target).~~ (Superseded by [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored): agy reads the Gemini CLI `~/.gemini/` config tree, so the lane was restored.) The `--filter "- .gemini/tmp/**"` rclone filter excludes only agy's transient tmp dir; the seeded `~/.gemini/` config does sync.

**Consequences:**
- The Gemini CLI interactive agent (`gemini`) is no longer available in containers; users needing the Google AI agent use `agy` instead.
- The Gemini *API* (GEMINI_API_KEY, `/api/llm-keys` geminiApiKey, consult-llm model selector) is unaffected - it is a separate provider, not the CLI agent.
- ~~No preseed documents are generated for Antigravity; it gets no per-agent document set.~~ Superseded by [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored): an adapted `.gemini/` lane is generated.

**Related REQ:** [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents) (agent CLI pre-install).

---

### AD66: Security-sensitive rate limiters fail closed on KV outage

**Category:** Security

**Status:** Accepted (2026-05-31)

**Context:** `checkRateLimit` ([rate-limit-core.ts](../../src/lib/rate-limit-core.ts)) uses KV as the primary store with a per-isolate in-memory fallback when KV operations fail. The default posture is fail-open: when KV is unreachable, the in-memory map allows the request and the limit is enforced only within a single isolate. Cloudflare fans a Worker out across many isolates, so under a KV outage the effective limit multiplies by the isolate count, silently defeating the limiter. For general resource-protection limiters (UX throttles, read endpoints) this degraded-mode allowance is acceptable. For security-sensitive limiters guarding unauthenticated or mutating endpoints (Turnstile-backed access-request, subscribe, the Stripe webhook), a fail-open KV outage is an availability-for-security trade that lets an attacker amplify abuse precisely when the store is degraded.

**Decision:** Security-sensitive `createRateLimiter` sites pass `failClosed: true`, which makes `checkRateLimit` deny the request (429 with a 60s `Retry-After`) when the KV operation throws, instead of falling back to the per-isolate in-memory map. Purely cosmetic / UX limiters keep the default fail-open posture so a KV blip does not lock users out of read paths. The Stripe webhook limiter ([stripe-webhook.ts](../../src/routes/stripe-webhook.ts)) is `failClosed` because it is an unauthenticated mutation endpoint; the request-access limiter is already `failClosed`. The 429 path also emits advisory `Retry-After` and `X-RateLimit-*` headers set on the Hono context before the `RateLimitError` throw, which survive into the `app.onError` response.

**Consequences:**
- Under a KV outage, security-sensitive endpoints return 429 rather than silently allowing fan-out-multiplied traffic; this is a deliberate availability cost on those few endpoints.
- General limiters are unchanged and still degrade open, so a KV blip does not break read-heavy UX.
- A future maintainer adding a limiter on an auth/mutation/unauthenticated endpoint must set `failClosed: true`; the default remains fail-open by design.

**Alternative considered:** Make every limiter fail closed. Rejected because a transient KV outage would then 429 read paths and degrade UX for no security benefit on endpoints that are not abuse-sensitive.

**Alternative considered:** Replace the per-isolate in-memory fallback with a Durable Object counter to keep a single global count during KV outages. Rejected as disproportionate: it adds a DO round-trip to the hot path of every limited request for a degraded-mode edge case the fail-closed flag already covers correctly.

**Related REQ:** [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) (rate-limiting infrastructure - KV primary with in-memory fallback, 429 with advisory headers).

---

### AD67: Antigravity reads the Gemini CLI config tree; preseed lane restored

**Category:** Architecture

**Status:** Accepted (2026-06-01)

**Context:** [AD65](#ad65-gemini-cli-replaced-by-antigravity-agy) replaced the Gemini CLI agent with Antigravity (`agy`) and asserted that `agy` "has no stable config-file convention to target," so the seed generator's `gemini` adaptation lane was deleted. That premise was wrong. Antigravity is Go-native and curl-installed, but it inherits the Gemini CLI configuration tree: Google's migration guidance states that `~/.gemini/GEMINI.md` is "automatically loaded and enforced across all workspaces" and global skills under `~/.gemini/skills/` "load automatically," both unchanged from Gemini CLI. The `GEMINI.md` -> `AGENTS.md` and `.gemini/skills` -> `.agents/skills` renames apply only to per-workspace (repo-root) config; the home-directory global config that codeflare seeds is unaffected. The deletion was silently masked because the pre-AD65 lane's `.gemini/` output persisted in user R2 buckets and was bisynced back, so `agy` kept reading codeflare's skills/rules even though the generator no longer produced them.

**Decision:** Restore the adaptation lane in `scripts/generate-agent-seed.mjs`, keyed `antigravity`, targeting the home config tree: rules concatenate into `~/.gemini/GEMINI.md`, skills into `~/.gemini/skills/<name>/SKILL.md`, and subagents into `~/.gemini/agents/*.md`. Claude tool names remap to the Gemini CLI vocabulary (`Read`->`read_file`, `Write`->`write_file`, `Edit`->`replace`, `Bash`->`run_shell_command`, `Grep`->`search_file_content`, `Glob`->`glob`). The lane needs no seeding-layer change: `getConfigsForMode` filters by session mode only, not agent type, so every agent's documents seed together and each agent reads its own config dir.

**Consequences:**
- Antigravity sessions receive codeflare's adapted rules, skills, and subagents from a generated source of truth instead of stale bisynced R2 artifacts that drift from the manifest.
- The supersession is partial: AD65's curl-install / no-npm / no-V8-warmup decisions still stand; only the no-preseed-lane clause is reversed.
- A maintainer changing the seeded agent roster must keep the `.gemini` paths home-directory-scoped; the workspace-level `.gemini` -> `.agents` rename does not apply to what codeflare seeds.

**Related REQ:** [REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) (single-source preseed generation), [REQ-AGENT-007](../../sdd/spec/agents.md#req-agent-007-multi-agent-adaptation-pipeline) (multi-agent adaptation pipeline).

---

### AD68: Service-token admin bypass must be environment-gated and hostname-restricted

**Category:** Security

**Status:** Accepted (2026-06-01)

**Context:** `getUserFromRequest` in `src/lib/access.ts` (~L170-205) validates a custom `X-Service-Auth` header against the `SERVICE_AUTH_SECRET` worker secret, checked FIRST - before SaaS GitHub OIDC and before CF Access JWT verification. The header exists because CF Access injects a JWT for service tokens whose audience does not match the app's `access_aud` and strips `CF-Access-Client-Secret` from forwarded requests, so the custom header is the only reliable service-token signal. On a constant-time match the function returns `{ email, authenticated: true, role: 'admin' }` - the caller is trusted as an admin without any KV allowlist lookup. The bypass is active whenever `SERVICE_AUTH_SECRET` is present and carries no environment guard: there is no check that the deployment is a stress-test or integration environment, no refusal when `SAAS_MODE` is `active`, and no restriction on which hostname the request targeted. The secret is intended for k6 stress tests and E2E runs (see [AD26](#ad26-stress-test-rate-limit-bypass-integration-only)), but nothing structurally prevents the same admin-granting path from being honored on a production SaaS deployment if the secret were ever set there.

**Decision:** The service-token admin bypass must be gated behind `STRESS_TEST_MODE`, never honored when `SAAS_MODE === 'active'`, and hostname-restricted to the non-production test surfaces. This records the accepted direction; the implementation is tracked separately in [codeflare#130](https://github.com/nikolanovoselec/codeflare/issues/130) and is NOT applied in this branch. Concretely, the accepted shape is: short-circuit the `X-Service-Auth` check entirely unless `STRESS_TEST_MODE` is set to its active sentinel (matching the AD26 rate-limit bypass gate), refuse the bypass on any request where SaaS mode is active so a production SaaS worker can never mint an admin identity from the header, and bind acceptance to the expected test hostnames so a misdirected request to the production host cannot exercise the path.

**Consequences:**
- A production SaaS deployment that inadvertently receives `SERVICE_AUTH_SECRET` no longer grants `role: 'admin'` from a forged-or-leaked `X-Service-Auth` header, because the `SAAS_MODE === 'active'` refusal and the `STRESS_TEST_MODE` gate both fail closed.
- The stress-test and E2E flows are unaffected: those environments already set `STRESS_TEST_MODE` and run against the integration hostname, so the bypass continues to work exactly where it is needed.
- Environment separation stops being the only control: the bypass is now defense-in-depth (env scoping at deploy time PLUS a runtime guard in the auth path), aligning the service-token surface with the trust model the rest of the auth chain already enforces.
- Until [codeflare#130](https://github.com/nikolanovoselec/codeflare/issues/130) lands, the current behavior stands and the residual risk is mitigated only by GitHub Actions environment scoping of the secret (same posture as [AD26](#ad26-stress-test-rate-limit-bypass-integration-only)).

**Related REQ:** [REQ-AUTH-004](../../sdd/spec/authentication.md#req-auth-004-service-token-authentication-for-e2e-testing) (service-token authentication), [REQ-AUTH-011](../../sdd/spec/authentication.md#req-auth-011-auth-resolution-order) (authentication resolution order).

---

### AD69: SilverBullet vault runs its native service worker for persistent, encrypted client indexing

**Category:** Architecture

**Status:** Accepted (2026-06-01)

**Context:** Within a single browser SilverBullet (SB) rebuilds its IndexedDB index from scratch on every cold load ([codeflare#445](https://github.com/nikolanovoselec/codeflare/issues/445)): a browser restart against a still-running session, same `:sid`, same encryption key, re-crawls and re-indexes the entire vault over HTTP. Three independent signals confirm the cause. (1) Runtime console logs show the space read path is `evented -> checked -> http_space_primitives` (straight to network, no local datastore primitive), the boot logs `Not loading space scripts, since full indexing has not completed yet`, and only `sb_data_*` ever appears in IndexedDB, never `sb_files_*`. (2) SilverBullet 2.8.1 source (`client/service_worker.ts`, `client/boot.ts`) shows the sync engine and the persistent local file store (`sb_files_*`) live exclusively in SB's real service worker; codeflare replaces that worker with `VAULT_KEY_SHIM_SERVICE_WORKER_JS` (`src/routes/vault-html.ts`), a key-bridge-only shim with no fetch handler, so the local file mirror is never created and SB has no resumable snapshot. (3) SB v2's architecture keeps the query index in the browser (client Datastore / IndexedDB); the server stores only raw files plus an RPC surface and has **no server-side query index**, so a "thin client, nothing on the browser" model is not achievable with stock SB 2.8 - the index, which carries page content, is unavoidably a browser artifact.

Two facts from the SB 2.8.1 source reshape the fix. First, SB's real service worker **natively** implements `set-encryption-key` / `get-encryption-key` over an in-SW `encryptionKeyMemoryStore`; the codeflare shim merely re-implements behaviour SB already ships, and the bootstrap-hop's `postMessage` works against the real worker unchanged. Second, the shim exists only because SB's real worker fails to install under codeflare's auth gate: its `install` handler runs `cache.addAll(precacheFiles)`, which rejects on any non-2xx response, and per the existing `isServiceWorkerRegistration` comment one precached path (the vault root) 302-redirects to the bootstrap-hop when the bootstrap cookie is absent, hanging `navigator.serviceWorker.ready`. Separately, two encryption layers already coexist and are independent of SB's mode: rclone R2 SSE-C (`ENCRYPTION_KEY`, `entrypoint.sh`) encrypts the vault at rest in R2, and [AD59](#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key) / [REQ-VAULT-008](../../sdd/spec/vault.md#req-vault-008-zero-ui-vault-encryption) client-side IDB encryption (`vaultKey`) protects the unavoidable browser index against profile theft (BitLocker-grade).

**Empirical validation (2026-06-01):** a headless-Chrome (puppeteer) probe against the in-container SB server confirmed the mechanism directly. Against raw SB - real service worker, codeflare key-shim out of the path - both `sb_data_*` and `sb_files_*` IndexedDB stores are created, and a reload re-indexes **zero** files (`Initial index complete, loading full page list via index.`) rather than the full re-crawl observed under the shim (hundreds of `Indexing file` lines per load in production console captures). This proves SB's native service worker is the persistence layer and that suppressing it via the key-shim is the direct cause of #445. The probe covers the SB-native half only; the codeflare-proxy half (serving the real worker past the auth gate and the `/` bootstrap-302) remains to be verified on the integration deployment, since the Worker's Cloudflare bindings cannot be faithfully reproduced locally.

**Integration finding (2026-06-01, `SB-fix`):** the first integration deploy served the native worker WITHOUT the recovery graft (to observe). It reproduced the keyless-`.auth` bounce predicted below - but on **cold boot**, not only after idle. Reading the vendored 2.8.1 worker explains why: it not only holds the key in module memory (lost on idle-termination) but actively flushes it `5s` after the last client disconnects (`"No more clients, flushing encryption key", y=void 0`). During the bootstrap-hop -> `location.replace('/')` transition the client count momentarily drops, so the key can be gone before the shell boots. The graft is therefore mandatory for cold boot too, not just the mobile idle case. A first attempt grafted only the `get-encryption-key` handler and STILL bounced to `.auth` - because that is not the path that fails. The actual trigger is the worker's **`config`** message handler: when the client posts `config` with codeflare-injected `enableClientEncryption:true` while `y` is empty, the gate `if(t.enableClientEncryption&&!y)` posts `auth-error` -> client navigates to `.auth` (console: "Supposed to use encryption, but no phrase set yet, auth error"). It reads `y` directly, never asking `get-encryption-key`. So `graftVaultKeyRecovery` (`src/routes/vault-native-sw.ts`) injects a shared `__cfRecover()` helper (re-fetch + decode from `/.vault-key`) and calls it at BOTH `y`-empty failure points - the `config` auth-gate (the load-bearing one) and the `get-encryption-key` reply - before either gives up. An `activate`-handler graft remains unnecessary. The same deploy also resolved the `/.client/*` precache-auth question (the other half of the decision below): the native worker reached `activated` and SB booted under its control, which can only happen if `install` -> `cache.addAll(precacheFiles)` resolved, i.e. the `/` and `/.client/*` precache fetches all returned 2xx. Service-worker `fetch()` carries same-origin credentials, so the precache fetches send the session cookie and pass the normal auth chain - no static-asset exemption is required. The exemption is therefore NOT implemented; the precache-auth exemption ([REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker), the native-SW contract) stays reserved as a fallback only if a future browser strips credentials on precache fetches.

**Verified (2026-06-01, mobile, integration):** the final deploy (graft at both checkpoints) cleared the bug end-to-end. Console: "47 client files cached" (precache OK), "Activating new service worker!", "[Service Worker] Using IndexedDB database sb_files_..." (the persistent SW-context store, ABSENT under the shim - the direct #445 fix), "Recovered encryption key from codeflare" (the graft fired because the hop's posted key had already been flushed), no `auth-error` / `.auth` redirect, and the sync engine running "[Sync] Completed: 0 operations" cycles. The one-time first-load index (81 `Indexing file` lines) populates `sb_files_*`; the store now persists, so subsequent cold loads are incremental. AD69 is fully realized: `VAULT_KEY_SHIM_SERVICE_WORKER_JS` and its tests have been removed. REQ-VAULT-008 and REQ-VAULT-013 moved to Implemented.

**Decision:** Keep SB in sync mode and run SB's **native** service worker in place of the key-shim, so the client index persists and indexing is incremental (resolving #445), while preserving client-side encryption (AD59). The implementation, integration-iterated on the `SB-fix` branch: serve SB's real `service_worker.js` for the registration GET via Worker-side container auth (the credential-stripped registration GET cannot pass the user-cookie chain); make `cache.addAll` succeed by not 302-redirecting service-worker-context fetches of the shell path to the bootstrap-hop, and by auth-exempting the static client-bundle asset paths (open-source SB frontend bytes, zero user data - the same safety basis as the existing `service_worker.js` bypass), while data endpoints (`.fs/`, `.config`, file content) stay auth-gated; retain the bootstrap-hop solely for encryption-key delivery, since the real worker's `set-encryption-key` handler is native. Critically, the codeflare-served worker must NOT be SB's stock worker: SB's native worker has no key auto-recovery (its `get-encryption-key` returns only the in-memory key, and SB boot hard-redirects to `.auth` and throws when the worker has none), whereas the current shim adds `.vault-key` recovery (fetch `GET .vault-key` on `activate` and on a keyless `get-encryption-key`) for [REQ-VAULT-008](../../sdd/spec/vault.md#req-vault-008-zero-ui-vault-encryption) AC7. Cold boots are covered because the session-scoped bootstrap cookie re-runs the hop (and its `set-encryption-key` post), but a mid-session service-worker idle-termination - relevant on the mobile-first surface - would leave the native worker keyless and break the encrypted open. So codeflare must serve SB's real worker WITH the shim's `.vault-key` recovery grafted into its key-empty checkpoints - the `config` auth-gate AND the `get-encryption-key` reply (the integration finding above showed the `config` gate is the one that actually fires, and that an `activate` graft is unnecessary) - keeping both the native sync engine and the keyless-recovery. Note encrypted persistence itself is unaffected: `EncryptedKvPrimitives` wraps values inside the same `sb_data_*` / `sb_files_*` stores, so the proven `sb_files_*` creation and incremental reload hold with encryption on. Retire `VAULT_KEY_SHIM_SERVICE_WORKER_JS` once the grafted real-worker path is verified on integration. Validation is integration-only (service-worker install and sync behaviour are not meaningfully unit-testable): verified by a cold reload showing incremental sync rather than full reindex, and DevTools showing `sb_files_*` present.

`SB_DISABLE_SERVICE_WORKER` and `SB_READ_ONLY` are rejected. Disabling the worker does not move the index server-side (SB v2 has none), still re-indexes client-side, and removes the SW-hosted encryption key store - leaving the browser index in **plaintext**, strictly worse for the AD59 threat model. `SB_READ_ONLY` disables all writes, which the vault cannot accept.

**Consequences:**
- #445 resolved: `sb_files_*` persists and sync becomes incremental, eliminating the cold-boot full reindex; the per-load broken-wikilink 404 walk (342 distinct dangling `[[links]]` in `Raw/Sessions/*.md` captures) collapses from every-load to once-per-change.
- Client-side encryption (AD59 / REQ-VAULT-008) is preserved and now clearly load-bearing rather than redundant: SB v2 forces a content-bearing index into the browser, so encrypting it is justified, and R2 SSE-C continues to protect the at-rest copy independently.
- New auth surface: the static client-bundle asset paths become auth-exempt. The exemption MUST be enumerated precisely during implementation so no user-data path (`.fs/`, `.config`, attachments) is ever exempted; it is bounded to open-source frontend bytes.
- Offline editing returns as a side effect of restoring sync mode. Not required by the user, but not harmful.
- Risk: the real ~97KB worker interacts with the live vault auth chain, and a prior attempt (`silverbullet-index` branch) stalled on boot timeouts. Mitigated by integration-only rollout and keeping the shim available as a one-line revert until the native path is proven.

**Related REQ:** [REQ-VAULT-008](../../sdd/spec/vault.md#req-vault-008-zero-ui-vault-encryption) (zero-UI vault encryption), [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker) (SilverBullet native service worker), [REQ-VAULT-013](../../sdd/spec/vault.md#req-vault-013-silverbullet-subpath-adapter) (SilverBullet subpath adapter), [REQ-VAULT-015](../../sdd/spec/vault.md#req-vault-015-vault-idb-lifecycle-and-listing-filters) (vault IDB lifecycle). Supersedes the shim rationale documented in [vault.md - Service Worker registration noop bypass](../lanes/vault.md#service-worker-registration-noop-bypass). Tracks [codeflare#445](https://github.com/nikolanovoselec/codeflare/issues/445).

---

### AD70: Container exit writes KV `stopped`; no read-side reconciliation

**Category:** Architecture

**Status:** Accepted (2026-06-02)

**Context:** Two user-facing symptoms shared one defect. (1) A live session was falsely flipped to `stopped` and the user bounced to the dashboard; reopening showed "Starting session" then instantly green. (2) A container that exited unexpectedly (crash, deploy-roll, or platform idle-reap) dangled as `running` in KV forever and had to be deleted by hand. Production observability (96h) proved the chain: when a container exits via an unexpected path the SDK (`@cloudflare/containers` v0.3.5) calls `onError()`, **not** `onStop()`; `onError` only logged, `collectMetrics`'s `!running` branch only logged-and-returned, and `onStop` (which does write `stopped`) was never invoked. So KV dangled at `running` and the heartbeat `metrics.updatedAt` froze. A read-side heuristic, `reconcileStaleStatus` (added in [#459](https://github.com/nikolanovoselec/codeflare/pull/459)), then inferred `stopped` from the stale heartbeat age on the dashboard poll - which is exactly what produced the false kick on still-live sessions whose alarm loop had legitimately paused. The June 1→2 incident was a deploy (the user's agent merging a PR to main) that rolled the container → `Container error` with no KV write. Over 96h the SDK `onActivityExpired` fired 0 times (the `sleepAfter='24h'` pin holds), 69/72 clean stops were manual `destroy()`, and 7 `Container error` events each leaked a dangling session.

**Decision:** Make KV `status` the single authoritative source of truth and delete the read-side guess. (a) `onError()` writes `stopped` via the shared `updateKvStatus()` helper, guarded on `!ctx.container.running` so a transient startup error cannot flip a still-starting container. (b) `collectMetrics()`'s `!running` branch writes `stopped` on the next 60s tick as the catch-all for any exit the hooks missed. (c) `reconcileStaleStatus` and its `STALE_RUNNING_MS` constant are removed; all five call sites (`routes/session/{crud,lifecycle}.ts`, `routes/container/lifecycle.ts`) return the raw KV status. `metrics.updatedAt` / `m.u` is **kept** but is display-only (metrics-staleness), never a liveness signal. Safety rests on `updateKvStatus` re-reading sessionId/bucketName from DO storage and the session from KV on every call, and `destroy()` clearing those identifiers first - so a post-destroy write no-ops instead of resurrecting a deleted record (the same invariant as [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity)). Whether a session should **survive** a deploy at all (container persistence across Worker versions) is explicitly out of scope.

**Consequences:**
- Dangling `running` is eliminated: a container that exits for any reason converges to `stopped` within ~60s without manual deletion.
- The false kick is eliminated at the root: with no heartbeat-age heuristic, a live-but-idle session can never be inferred `stopped` from a paused alarm loop.
- The dashboard becomes a pure mirror of KV `status`; the frontend `running→stopped` disposal path (REQ-SESSION-010 AC7) stays, but now fires on the authoritative KV status written on exit (REQ-SESSION-018 AC1) rather than a read-side guess.
- Trade-off: a brief, accurate `stopped` can appear during a failed start before `onStart()` re-asserts `running`. Acceptable - it reflects reality.

**Related REQ:** [REQ-SESSION-018](../../sdd/spec/session-lifecycle.md#req-session-018-persisted-status-is-authoritative-on-container-exit) (persisted status authoritative on container exit) and [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard) (session status observable from dashboard). Tracks [codeflare#153](https://github.com/nikolanovoselec/codeflare/issues/153). Refines [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity).

---

### AD71: Preseed corpus statically imported into the Worker bundle; bound by compressed bundle size, CI-guarded

**Category:** Architecture

**Status:** Accepted (2026-06-03)

**Context:** The agent preseed corpus (`src/lib/agent-seed.generated.ts`, ~3.9 MB on disk / ~1 MB gzipped) is statically imported at module top level: `src/lib/r2-seed.ts` does `import { AGENTS_SEEDED_CONFIGS } from './agent-seed.generated'`. A static top-level import lands the full corpus in the Worker bundle that is shipped on every deploy, so the corpus competes for the same byte budget as application code. Cloudflare Workers enforces the limit on the **gzipped** bundle, and the paid-plan ceiling is 10 MB gzipped, so the relevant bound is the ~1 MB gzipped contribution of this corpus against that 10 MB headroom, not the 3.9 MB on-disk figure.

**Decision:** Accept the static import for now. The corpus is read once at seed time and the static import keeps the seed path synchronous and simple, which is worth the bundle cost while the gzipped corpus is ~1 MB against a 10 MB gzipped ceiling. The bound MUST be guarded by a CI check on the gzipped Worker bundle size so the corpus cannot silently grow the bundle toward the ceiling between deploys. The structural escape hatch, taken as the gzipped bundle approaches the ceiling, is to stop statically importing the corpus: either relocate it to R2 and fetch it at seed time, or convert the top-level import to a lazy `await import('./agent-seed.generated')` so it is only pulled when seeding actually runs. Either path removes the corpus from the always-shipped bundle.

**Consequences:**
- The corpus ships in every Worker bundle and is counted against the gzipped size limit; a CI bundle-size check is the guardrail that keeps this from regressing.
- The seed path stays synchronous and simple while the corpus is small relative to the ceiling.
- Trade-off: corpus growth is bounded by deploy mechanics rather than by application need; once the CI check trends toward the ceiling, the R2-relocation / lazy-`import()` escape hatch must be taken rather than raising the budget.

**Related REQ/finding:** Recorded from finding CF-011 (preseed corpus bundle-size bound). Relates to [AD3](#ad3-per-user-r2-buckets) (per-user R2 buckets) as the R2-relocation target for the escape hatch.

---

### AD72: Outbound-HTTPS interception over a Worker-side LLM proxy for enterprise gateway routing

**Category:** Architecture, Security

**Status:** Accepted (2026-06-05). Interception mechanism stands; its upstream transport (gateway endpoint, auth header, agent set) is amended by [AD74](#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api).

**Context:** Enterprise Mode must route all agent LLM traffic (Claude, Copilot, Pi) through the customer's AI Gateway without exposing gateway credentials to the container or creating a new public HTTP route. Three approaches were evaluated:

1. **Worker-side `/llm-proxy` route:** A public Worker route that the container calls instead of the real provider. The container env would need the Worker's own URL (a non-secret), but the route is publicly reachable over Cloudflare Access, adding an Access-policy attack surface and a round-trip through the internet. The route also requires rewriting every agent's base-URL to point at the Worker, and every agent would need a container-env credential to authenticate against that route.

2. **Credential injection into the container:** Pass `AIG_GATEWAY_URL` and `AIG_TOKEN` directly to the container via env vars and let each agent use them directly. This keeps the gateway URL and token accessible from within the container, contradicting the operator's expectation that gateway credentials stay out of user-reachable surfaces (terminal, any future agent file-read path).

3. **Platform outbound-HTTPS interception (`ctx.container.interceptOutboundHttps` + `ctx.exports`):** The Container DO wires a `WorkerEntrypoint` (`LlmInterceptor`) into the platform's outbound-HTTPS interception mechanism. The platform TLS-terminates the container's connections to the real provider hosts and delivers them to the interceptor. The interceptor forwards to the AI Gateway with the real credentials. The gateway URL and token live only in the Worker environment; the container never sees them. The container communicates with the real provider host as if it were not intercepted — no base-URL rewrite, no new auth surface.

**Decision:** Use platform outbound-HTTPS interception (option 3). The `LlmInterceptor` WorkerEntrypoint is exported from `src/index.ts` and wired via `ctx.container.interceptOutboundHttps` in `src/container/index.ts::setupEnterpriseInterception`. `ctx.exports` is default-on at compat date `2026-02-05`; no `enable_ctx_exports` flag is needed (the earlier draft constraint referencing that flag was removed before implementation).

**Consequences:**

- Gateway credentials (`AIG_GATEWAY_URL`, `AIG_TOKEN`) never enter the container. The container only receives `ENTERPRISE_MODE=active` (a non-secret deploy var) and a constant non-secret placeholder credential for CLI initialization.
- The container must trust the Cloudflare containers CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) so TLS-intercepted connections validate. `entrypoint.sh` installs it on every Enterprise Mode boot.
- No new public Worker route is created; gateway traffic is platform-internal and cannot be targeted by external requests or CF Access policies.
- When `ENTERPRISE_MODE` is unset, `interceptOutboundHttps` is never called, and the codebase is byte-identical to a non-enterprise deployment (no interception overhead, no CA install).
- Trade-off accepted: the platform interception mechanism is Cloudflare-specific. If the project were ever migrated off Cloudflare Containers, enterprise gateway routing would need a different mechanism (likely option 1 or 2).

**Related:** [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [Architecture - Enterprise LLM Routing](../lanes/architecture.md#enterprise-llm-routing), [Security - Enterprise Mode](../lanes/security.md#enterprise-mode-credential-containment-and-ca-trust).

### AD73: workers.dev enabled on every deployment for setup-wizard bootstrap

**Category:** Security

**Status:** Accepted (2026-06-05)

**Context:** The setup wizard bootstraps on the `<worker>.<account>.workers.dev` URL — on a fresh deploy that is the only reachable host, because the custom domain does not exist until the wizard provisions it. An earlier config set `workers_dev = false` to lock the deployment to the custom domain only (citing OAuth host-mismatch risk and a larger auth surface). That is a chicken-and-egg break: a first-time deploy into a fresh account — most importantly an Enterprise tenant in a separate Cloudflare account — has no custom domain and therefore no URL at all, so the wizard can never run. Disabling workers.dev makes initial setup impossible.

**Decision:** Set `workers_dev = true` in `wrangler.toml` for every deployment and every environment (production, integration, enterprise, and any future target). The workers.dev URL is the mandatory bootstrap host the wizard runs on; after it provisions a custom domain, normal traffic flows through that domain while the workers.dev URL remains the always-available bootstrap/fallback host. The earlier enterprise-only deploy-time `sed` that flipped the flag was removed in favor of this single source of truth.

**Consequences:**

- Initial setup works on any fresh deploy, including a brand-new Cloudflare account, with no manual custom-domain step first.
- Every deployment also exposes a public `*.workers.dev` URL alongside its custom domain. This does not bypass authentication: every protected route is gated regardless of host — Cloudflare Access in default/enterprise mode, GitHub-OIDC session cookies in SaaS mode (see [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation), [AD68](#ad68-service-token-admin-bypass-must-be-environment-gated-and-hostname-restricted)).
- **Operator responsibility:** turning on Cloudflare Access for the `*.workers.dev` hostname is the operator's job, not the deployment's. The deploy enables the URL but cannot attach an Access policy to it; in CF Access mode the operator must enable Cloudflare Access on the workers.dev hostname in the Cloudflare dashboard so the bootstrap URL is not left open after setup. (The wizard configures Access for the custom domain; the workers.dev host is the operator's to protect.)
- The `.workers.dev` CORS allowance is an already-accepted, bounded trade-off ([AD11](#ad11-suffix-pattern-cors-with-credentials)): dot-prefixed matching prevents `evilworkers.dev`, and custom domains supersede the wildcard after setup.
- The pre-setup window (before auth is configured) is the same bounded bootstrap window analyzed in [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation): seconds-to-minutes, operator/self-hosted audience, idempotent setup.

**Related:** [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation), [AD11](#ad11-suffix-pattern-cors-with-credentials), [AD68](#ad68-service-token-admin-bypass-must-be-environment-gated-and-hostname-restricted), [Architecture](../lanes/architecture.md), [Configuration](../lanes/configuration.md).

### AD74: Enterprise LLM transport on the AI Gateway REST API

**Category:** Architecture, Security

**Status:** Accepted (2026-06-05)

**Context:** [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) established platform outbound-HTTPS interception as the enterprise LLM transport, forwarding intercepted provider traffic to the customer's AI Gateway. The original implementation targeted the gateway's legacy endpoints on `gateway.ai.cloudflare.com` — the OpenAI-compatible `/compat/chat/completions` path and the provider-native `/anthropic/v1/messages` path, authenticated with the `cf-aig-authorization` header. Cloudflare has since **deprecated** those paths (they "continue to work for existing integrations") and recommends the REST API at `api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/*` (standard `Authorization` header) for new integrations. Building enterprise on a deprecated surface was latent migration debt; a live smoke test against the `codeflare-enterprise` gateway confirmed the REST API supports everything the transport needs — dynamic routing via `model: "dynamic/<route>"`, SSE streaming, `cf-aig-metadata` attribution, BYOK + Workers AI. A second finding shaped the design: the REST API requires author-prefixed model ids (`anthropic/claude-…`) on its Anthropic-compatible `/ai/v1/messages` endpoint, while Claude Code emits a bare `claude-…` model — which would force the interceptor to buffer-and-rewrite each request body, breaking the zero-copy passthrough. Every other enterprise agent (Copilot, Pi) speaks the OpenAI chat-completions format and can reach any backend — native Anthropic/OpenAI, Amazon Bedrock, or Workers AI — through the one OpenAI-compatible REST endpoint by model id, with no rewrite.

**Decision:** Migrate the `LlmInterceptor` transport off the deprecated `/compat` + `/anthropic` paths onto the REST API at `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/*`, authenticated with the standard `Authorization: Bearer <AIG_TOKEN>` header and routed with `cf-aig-gateway-id`. The account id and gateway id are parsed from the existing `AIG_GATEWAY_URL` secret (no new binding). **Drop Claude Code from the enterprise agent set** ([REQ-ENTERPRISE-003](../../sdd/spec/enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode)): with only OpenAI-wire-format agents remaining, the interceptor needs no format translation and intercepts only `api.openai.com`. It performs one targeted request edit — **gateway route-pinning** (see amendment below) — substituting only the `model` field; the response is always streamed zero-copy. The interception mechanism from [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) is unchanged — only the upstream target, auth header, and agent set change.

**Consequences:**

- The transport is on Cloudflare's recommended, non-deprecated surface; no migration debt.
- The response is a zero-copy streaming passthrough. The request body is passed through except for gateway route-pinning, which substitutes only the `model` field on a (small) chat request; no format translation or response buffering occurs because the agent set is OpenAI-format-only.
- ~~Backend selection — native provider, Amazon Bedrock, Workers AI, or a dynamic route with rate-limit/budget/fallback — is entirely gateway-side via the route id in `AIG_LANGUAGE_MODEL` (e.g. `dynamic/<route>`), which the interceptor stamps onto each request (route-pinning, below). Agents carry only a fixed slash-free handle, never the route id.~~ codeflare holds no provider keys; BYOK lives in the gateway. *(Route selection superseded by the catalog-driven routing amendment 2026-06-09 below: backend selection is now mapped from the Setup-configured catalog via `loadRouteCatalog`, and `AIG_LANGUAGE_MODEL` is removed.)*
- `api.anthropic.com` is no longer intercepted and Claude Code is not selectable in enterprise mode; Anthropic models remain available via Copilot/Pi by model id.
- The `AIG_TOKEN` and `AIG_GATEWAY_URL` *bindings* are reused (no new secret or deploy var): the URL is now also parsed for account + gateway, and the token moves from the `cf-aig-authorization` header to `Authorization`. **The token's required type/scope changes, however.** The `/ai/v1/*` endpoint takes a Cloudflare API token in `Authorization`, **not** the `cf-aig-authorization` gateway *authentication* token the deprecated `/compat` path used (the REST API rejects that type with `error 10000`). Live testing 2026-06-05 pinned down the operative permission: the `/ai/v1/*` surface is the **Workers AI** namespace, so a CF API token with **Workers AI** (`Read`/`Edit`) succeeds end-to-end through the gateway's dynamic route, while a token scoped only to **`AI Gateway: Run`** is *also* rejected with `error 10000`. Cloudflare's docs phrase the requirement loosely as "a Cloudflare API token that has AI Gateway permission" and point operators at the gateway's **Create authentication token** button ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) · [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)) — but that button mints an **`AI Gateway: Run`** token (confirmed by the operator, twice) which this endpoint rejects, so it is the wrong tool here. The empirically-confirmed permission is **Workers AI**, created manually as a CF API token. An operator migrating an existing enterprise deploy must reissue `AIG_TOKEN` accordingly (see [configuration.md](../lanes/configuration.md#enterprise-mode-secrets-optional)).
- Flag-unset parity preserved: when `ENTERPRISE_MODE` is unset the interceptor is never instantiated and non-enterprise behavior is byte-identical.
- Operator dependency: third-party models require BYOK provider keys (or Unified Billing) configured on the gateway; a dynamic route is the recommended way to consume BYOK keys with availability/rate-limit/budget control.

**Route-pinning amendment (2026-06-05):** A gateway route is invoked by sending `model: dynamic/<route>` in the request body. Configuring that id *in the container* failed for Pi: Pi parses a slash in a model id as `provider/model`, so `dynamic/codeflare-enterprise` bound to a built-in provider (amazon-bedrock — falsely "authenticated" by the container's R2 S3 keys, which are exported under the generic `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` names) and was signed as a SigV4 call that never reached `api.openai.com` — empty gateway logs, looking like a broken route. Resolution: the route id stays a **Worker-only var** (`AIG_LANGUAGE_MODEL`, no longer fanned into the container); agents are configured with a fixed slash-free handle (`codeflare`) so they reliably route to `api.openai.com`; and the `LlmInterceptor` rewrites the request `model` to `AIG_LANGUAGE_MODEL` on egress (only for `/chat/completions` and `/responses`; non-JSON or model-less bodies pass through untouched). This keeps the route name out of the container entirely and lets the operator change routes by editing one Worker var with no agent reconfig. Pi is additionally pinned via `~/.pi/agent/settings.json` `defaultProvider`/`defaultModel` so it is gateway-bound zero-touch; Copilot's BYOK uses the complete 3-var contract (`COPILOT_PROVIDER_BASE_URL` + `COPILOT_PROVIDER_API_KEY` + `COPILOT_MODEL`=handle), with `GH_TOKEN` left in place for GitHub-hosted features (the documented fallback if Copilot ever ignores BYOK is `COPILOT_OFFLINE=true`).

**Dual-transport amendment (2026-06-07):** The migration above moved the transport onto the REST API as Cloudflare's "recommended, non-deprecated surface" — but the 2026-06-05 smoke test that justified it only exercised OpenAI + Workers AI. A later live evaluation (selecting Gemini through a dynamic route) found the REST API at `api.cloudflare.com/.../ai/v1/*` **does not carry the `google-ai-studio` provider**: every Gemini model id returns `404 Model not found`, and a dynamic route resolving to a Google node returns the masked `404 Model execution failed`. The same model/route works on the **deprecated** `gateway.ai.cloudflare.com/v1/{acct}/{gw}/compat/chat/completions` path (confirmed against a sibling Worker using BYOK + `cf-aig-authorization`). So Cloudflare's recommended REST surface is, today, *less capable* than the deprecated compat surface. Resolution: the `LlmInterceptor` now uses **both transports** — it sends to the REST API first and, only on a `404` for a model-routable request, **replays the (buffered) request to the compat path**. The retry is safe because a 404 is a complete error body, not a started stream (no double-billing, no truncation), and harmless on genuine failures (worst case: one extra fast round-trip). As Cloudflare migrates providers onto the REST API the 404 stops and traffic rides the REST API automatically — no code change. **Token-scope consequence (supersedes the `AIG_TOKEN` consequence above):** because the two transports authenticate differently — REST API via `Authorization: Bearer` (Workers AI scope), compat via `cf-aig-authorization: Bearer` (AI Gateway Run scope) — `AIG_TOKEN` must now carry **BOTH** Workers AI **and** AI Gateway Run permissions (a token with only one is rejected by the other transport with `error 10000`). This narrows the original "no migration debt" consequence: the transport still depends on the deprecated compat path for any provider not yet on the REST API (Google today), until Cloudflare closes the gap.

**Compat field-strip + email attribution amendment (2026-06-07):** Two further consequences surfaced once Gemini traffic actually reached `google-ai-studio` via the compat leg. (1) Non-OpenAI providers reject OpenAI-only request fields: Google returns `400 Invalid JSON payload received. Unknown name store` (and would next reject `prompt_cache_key`). Cloudflare's compat layer forwards these fields verbatim, so the interceptor strips `store` and `prompt_cache_key` **only on the compat replay** — the REST/OpenAI leg keeps them, so OpenAI prompt caching (which does not depend on `store`) is unaffected. (2) Per-user attribution: `cf-aig-metadata.user` now carries the IdP-verified **email** (from the container DO's `_userEmail`, falling back to the bucket id) rather than the opaque bucket id, so the customer's gateway analytics attribute usage to a real identity. This intentionally overrides REQ-ENTERPRISE-004's original "does not expose the user's email" wording — an accepted enterprise attribution requirement; the email stays within the customer-owned Cloudflare account.

**Catalog-driven routing + multi-group attribution amendment (2026-06-09):** Two changes supersede earlier mechanisms in this ADR. (1) **Route selection moves from the single `AIG_LANGUAGE_MODEL` Worker var to a Setup-configured catalog** ([REQ-ENTERPRISE-012](../../sdd/spec/enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)): the setup wizard persists an unlimited route list plus one optional default `route:reasoning` in KV (`setup:dynamic_routes`, `setup:default_route`), editable with no redeploy; `AIG_LANGUAGE_MODEL` and its `deploy.yml` plumbing are **removed**. The `LlmInterceptor` now maps the agent's slash-free handle to `dynamic/<route>` from the catalog (`loadRouteCatalog`), failing safe to the resolved default on an unknown handle — superseding both the route-pinning amendment's single-var stamp and the `AIG_LANGUAGE_MODEL` backend-selection consequence above. The catalog/default/reasoning are fanned to the container (`ENTERPRISE_ROUTE_CATALOG` / `ENTERPRISE_DEFAULT_ROUTE` / `ENTERPRISE_DEFAULT_REASONING`) so Pi's `models.json` lists every route (switchable via `/model`, `reasoning: true`, `defaultThinkingLevel` pinned from the default route's grade) and Copilot launches on the default route only (GitHub #3282 — Copilot cannot enumerate multiple BYOK models, so route switching is a relaunch). (2) **Per-group attribution supersedes the single-group `cf-aig-metadata` stamp**: the resolver now returns ALL matched Access groups and the interceptor stamps one `group_<sanitized>=1` tag per group plus `user`, dropping the scalar `group` key, within CF's 5-entry metadata cap (`user` + up to 4 groups, deterministic truncation in configured order with a warn). Per-group KEYS — not a CSV value — because the AI Gateway log/route filter operators are equals/not-equals only (no `contains`), so each `group_*` key is independently equals-filterable to build per-group Dynamic-Route if/else conditions ([REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC4). `sanitizeGroupKey` lowercases + replaces non-alphanumerics + appends a djb2 hash suffix so distinct names never collide on a sanitized key.

**Alternative considered — Cloudflare Access-based gateway auth (rejected):** Cloudflare's "identity-driven budgets" announcement (2026-06-05) proposes putting Cloudflare Access in front of the gateway so it derives caller identity from the Access JWT instead of caller-supplied metadata — pitched as removing the gateway token and "honor-system metadata headers." Evaluated as a replacement for `AIG_TOKEN` + Worker-stamped `cf-aig-metadata` and rejected on four grounds. (1) The REST API at `api.cloudflare.com/.../ai/v1/*` still *requires* a Cloudflare API token per request — it is Cloudflare's control-plane API, not a hostname an operator can front with their own Access application; the identity-aware integration attaches to the legacy `gateway.ai.cloudflare.com` endpoint this ADR deliberately migrated off. (2) codeflare's caller is a machine-to-machine `WorkerEntrypoint` with no interactive browser/JWT flow; the non-interactive Access credential is a service token (a client-id/secret pair) — another static secret, one identity per token, with no containment gain over the Worker-only secret model already established in [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing). (3) codeflare runs many end-users behind one Worker credential, so a single Access identity cannot carry per-user attribution; per-user spend limits key on `cf-aig-metadata` (the gateway splits budgets on a metadata field — codeflare stamps `{ user: <email>, group: <access-group> }`), so the metadata path is retained regardless. (4) codeflare's metadata is not honor-system — the Worker stamps it from a server-side DO prop and strips any container-supplied value, so the container cannot forge it. Identity-driven budgets are additionally a closed beta. Net: keep `AIG_TOKEN` + Worker-stamped `cf-aig-metadata`; per-user budgets are achieved today via gateway spend-limit rules splitting on the `cf-aig-metadata` `user` field.

**Related:** [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) (interception mechanism, unchanged), [REQ-ENTERPRISE-003](../../sdd/spec/enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode), [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var), [REQ-ENTERPRISE-007](../../sdd/spec/enterprise-mode.md#req-enterprise-007-gateway-route-pinning).

---

### AD75: Pi graphify tools replaced by a first-party native extension

**Category:** Architecture

**Status:** Accepted (2026-06-08)

**Context:** Pi has no MCP client, so the graphify query tools (`graphify_query`/`graphify_path`/`graphify_explain`) were exposed on Pi through the third-party `@gaodes/pi-graphify` npm wrapper plus a never-consumed `mcp.json`. The wrapper re-implemented graphify query logic independently of the Claude MCP-server path, so Pi and Claude could diverge in ranking/output from the same graph, and it added an npm dependency (plus the transitive `@gaodes/pi-utils-ui`) that `bump-shadow-pins.yml` had to track and that re-baked the image on every upstream bump. <!-- @impl: preseed/agents/pi/extensions/graphify-native.ts::resolveGraph -->

**Decision:** Replace `@gaodes/pi-graphify` with a first-party native Pi extension, `preseed/agents/pi/extensions/graphify-native.ts`, registered via `pi.registerTool` (mirroring `browser-run.ts`). It shells the same `graphify` CLI that Claude's MCP server runs (`graphify.serve._query_graph_text`), so both agents query through one engine with identical ranking and output. Delete the dead `preseed/agents/pi/mcp.json` and its seed path-mapping and context-mode strip-branch.

**Consequences:**

- Pi and Claude graphify queries share one engine — no divergent third-party reimplementation.
- The Pi npm closure shrinks by `@gaodes/pi-graphify` (and the transitive `@gaodes/pi-utils-ui`); `bump-shadow-pins.yml` and `dependabot.yml` no longer track it.
- Graph resolution is codified in source: the session/job cwd repo's `graphify-out/graph.json` wins, then the same-repo active sentinel graph, then the merged global graph (`~/.graphify/global-graph.json`); a graphless session fails soft with a "build a graph first" message.
- Durable review lanes load `graphify-native.ts` via explicit `-e`, plus `review-lane-guards.ts` and settings-enabled context-mode, so reviewers keep graphify tools without loading `codeflare-pi.ts` or recursive review enforcement.
- The `save-result` feedback loop is restored in both agents' graphify skills, which move to the `references/` progressive-disclosure layout.
- Clone-time triage (detect graph, prompt build/update/skip) is unchanged in both agents — only the query-tool provider changed.

**Implements:** [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-024](../../sdd/spec/agents.md#req-agent-024-advanced-session-mode-graph-first-discipline).

**Related:** [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes) (durable review lanes run detached).

---

### AD76: Durable review lanes run as detached headless Pi processes

**Category:** Agents

**Status:** Accepted (2026-06-08)

**Supersedes:** [AD64](#ad64-durable-review-lanes-load-extensions-additively-behind-the-noextensions-shield)

**Context:** In-process `createAgentSession` lanes could die when the spawning Pi session exited, leaving `.git/codeflare-review-jobs/<head>/` stuck `running`. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::recoverDurableReviewLaneState -->

**Decision:** Launch each durable lane as a detached `pi --mode json -p --no-session --no-extensions --no-context-files` child with stdin from `/dev/null`. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane -->

Load only explicit `-e` extensions: `graphify-native.ts`, `review-lane-guards.ts`, and settings-enabled context-mode. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::laneExtensionSources -->

**Consequences:**

- Lanes survive the spawning session and are reaped from disk. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::reapDurableReviewLanes -->
- The idle reaper advances and finalizes durable jobs without a user turn. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::autonomousReviewReaperTick -->
- Reviewers get a bounded inspection tool allowlist: bash for git/gh inspection, graphify tools, local-build blockers, and optional `ctx_search`.
- Lanes do not load `codeflare-pi.ts`, `review-enforcement`, or `@gotgenes/pi-subagents`.

**Related:** [REQ-AGENT-054](../../sdd/spec/agents.md#req-agent-054-pi-durable-review-lane-failure-handling), [REQ-AGENT-060](../../sdd/spec/agents.md#req-agent-060-pi-durable-review-lane-tool-surface), [REQ-AGENT-061](../../sdd/spec/agents.md#req-agent-061-pi-idle-durable-review-reaper).

---

### AD77: Enterprise vault service-worker reached via a higher-precedence Access bypass app

**Category:** Architecture, Security

**Status:** Accepted (2026-06-09)

**Context:** In Enterprise Mode the setup wizard provisions a **host-scoped** Cloudflare Access application ([REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC5) so the session cookie covers every path. SilverBullet's vault editor registers a native service worker by fetching `/api/vault/:sid/service_worker.js` — a browser-initiated registration fetch that carries **no credentials** (browsers omit them on SW script fetches). The host-wide Access app therefore 302s that fetch to the IdP login *before* the Worker runs, so the Worker's own credential-less SW short-circuit ([REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker)) never executes and SilverBullet cannot register its worker (confirmed live: `curl` → 302 to `*.cloudflareaccess.com`). The SW script bytes are non-sensitive — the per-session encryption key arrives later via `postMessage` — so the path can safely skip Access.

**Decision:** During enterprise setup, auto-provision a **second, higher-precedence** Access application + policy scoped to `<domain>/api/vault/*/service_worker.js` with `decision: 'bypass'` and `include: [{ everyone: {} }]`, so that one path resolves to the Worker (which then serves the version-locked native SW) instead of the host-wide Access 302. The app id is stored in KV (`setup:access_sw_bypass_app_id`). Provisioning is **best-effort and self-healing**: it never aborts the already-succeeded host-wide Access setup, persists the app id only after the bypass policy succeeds, and rolls back a freshly-created app if the policy step fails — because a `self_hosted` Access app with no policy DENIES its path, which would be worse than the 302 it fixes.

**Rationale:** A second, higher-precedence app is the least-privilege fix: it carves out exactly one non-sensitive path and leaves the host-wide Access protection untouched on every other path. The best-effort + rollback design means a provisioning failure degrades to the original 302 rather than a half-provisioned deny-all state.

**Alternatives considered:**

- **A `bypass` policy inside the host-wide app (rejected):** Access can scope a bypass policy to a path within the existing app, but that means mutating the wizard-provisioned host-wide app in place — risking the main session-auth destination — and gives no clean rollback target. A separate app owns its own id in KV (`setup:access_sw_bypass_app_id`) and is independently deletable, which is exactly what the rollback-on-policy-failure path relies on.
- **A Worker-side bypass with no Access app (rejected):** REQ-VAULT-017 already serves the SW credential-less inside the Worker, but Access enforces at the Cloudflare edge and 302s the fetch *before* the Worker runs, so a Worker-only change never sees the request. The bypass must live in Access.

**Consequences:**

- The enterprise vault editor registers its service worker and works behind Access with no operator action.
- One extra Access app per enterprise deployment, scoped to a single non-sensitive path; its precedence must stay above the host-wide app (verified in-dashboard).
- A failed provision degrades to the pre-fix behavior (SW 302) with a `logger.warn`, never a half-provisioned deny-all app; re-running setup re-attempts it.
- Flag-unset parity: non-enterprise deployments are path-scoped (`/app/*`) already and reach the SW path, so no bypass app is created.

**Related:** [REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC6, [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker).

---

### AD78: PR-boundary review lanes run in parallel (report-only reviewers)

**Category:** Agents

**Status:** Accepted (2026-06-09)

**Context:** At a PR-boundary the SDD pipeline dispatches three review lanes — `code-reviewer` (source), `spec-reviewer` (`sdd/`), and `doc-updater` (`documentation/` + root `README.md`). The original design ran them **sequentially**: `spec-reviewer` first, then `doc-updater`, on the rationale that the reviewers *edited* their lanes in place and `doc-updater` had to validate REQ cross-references against the spec `spec-reviewer` had just moved (the race-condition concern recorded in [AD44](#ad44-sdd-three-mode-autonomy-with-conservative-judgment-resolution)). Both engines encoded that ordering: Pi's `durableReviewInitialLanes` withheld `doc-updater` from the initial wave and `review-enforcement.ts` spawned it on `spec-reviewer` completion; Claude's `enforce-review-spawn.sh` demanded `doc-updater` only after `spec-reviewer` acked, sequenced via a `PIPELINE_COMPLETE` marker. That auto-fix model has since been superseded: the review agents are now **report-only** — each writes findings to its own durable result file under `.git/sdd-review-results/<head>/<lane>.md` and the **main session** applies every fix. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::reviewResultPath --> With the reviewers no longer mutating the spec/docs, the ordering rationale no longer holds, yet the sequential gate remained — adding a full `spec-reviewer` round of latency to every PR-boundary before `doc-updater` even started.

**Decision:** Dispatch all three review lanes **in parallel** at a PR-boundary. The reviewers' write targets are disjoint durable result files and read-only with respect to each other's domain, so there is no shared-write race and no ordering dependency. Pi: `durableReviewInitialLanes` returns every lane and `durableReviewEligibleLanes` drops the doc-waits-for-spec gate; the `spec-reviewer`-completion → `doc-updater`-spawn trigger in `review-enforcement.ts` is removed (it would double-spawn). <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::durableReviewInitialLanes --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::durableReviewEligibleLanes --> Claude: `enforce-review-spawn.sh` demands all three in the parallel MISSING block and acks the head on `all_required_lanes_completed_for_current_head` (the per-lane `PIPELINE_COMPLETE` sequencing is gone); `git-push-review-reminder.sh` emits a single parallel directive. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::all_required_lanes_completed_for_current_head --> **`/sdd clean` is explicitly excluded** — it *applies* fixes inline (not report-only), so it keeps the AD44 sequential order (spec-enforce before doc-enforce), since doc cross-references depend on the just-fixed spec.

**Rationale:** Parallelism is correct precisely because the reviewers are report-only: the only thing that made sequencing necessary (in-place edits to a shared source of truth) was removed when fix-application moved to the main session. Running the lanes concurrently cuts PR-boundary review latency from "slowest lane + spec-reviewer" to "slowest single lane" with identical coverage and zero added race surface.

**Alternatives considered:**

- **Keep the sequential gate (rejected):** it bought nothing once the reviewers stopped editing — `doc-updater` reads the *committed* spec, not an in-flight `spec-reviewer` edit — and cost a full lane of serial latency on every PR-boundary.
- **Parallelize `/sdd clean` too (rejected):** `/sdd clean` applies fixes inline, so doc cross-references genuinely depend on the just-fixed spec; parallelizing it would reintroduce the exact race AD44 guards against. The report-only/apply-inline distinction is the dividing line.

**Consequences:**

- PR-boundary review completes faster; the three lane result files are produced concurrently and the main session applies fixes from all of them.
- Pi's `pending.json` retains the now-vestigial `docPromptSent` field for backward-compat with in-flight review jobs serialized under the old sequential-dispatch model (jobs where `spec-reviewer` had completed but `doc-updater` had not yet been spawned); it is no longer read for sequencing. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::PendingReview -->
- `/sdd clean` behavior is unchanged.

**Related:** [REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch) AC4/AC5, [AD44](#ad44-sdd-three-mode-autonomy-with-conservative-judgment-resolution) (the `/sdd clean` sequential order this decision deliberately preserves), [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes).

---

### AD79: Image-baked Pi extension transpile cache

**Category:** Performance

**Status:** Accepted (2026-06-10)

**Context:** The 2026-06-10 preseed bundle grew Pi's loaded extension set from 1 npm package to 6 (context-mode enabled by default + four tool extensions). Pi loads every extension through jiti (`moduleCache: false`); jiti caches transpiles on disk under `$TMPDIR/jiti` because no `node_modules` directory sits next to `~/.pi/agent/extensions/` (and this pi build ignores a path-valued `JITI_FS_CACHE` env — verified empirically). `/tmp` starts empty in every fresh container, so **every session cold-transpiled the full extension graph before Pi's first PTY output** — measured live at ~9s cold vs ~4s warm. The host pre-warm (REQ-SESSION-015) treats first PTY output as its readiness signal with a 20s hard cap; the cold transpile pushed it past the cap, doubling perceived session startup (15s → 30-35s, user-reported).

**Decision:** Bake a warmed jiti cache into the image. A Dockerfile layer runs a throwaway `pi -p` at build with `TMPDIR` redirected, against an agent dir that mirrors the runtime layout (npm symlinked to the image preseed cache; package list **derived** from the preseed `package.json`, never duplicated), then moves the result to `/opt/codeflare/jiti-cache` and **fails the build if the cache is empty**. The entrypoint symlinks `/tmp/jiti` → the baked cache at boot (the same pattern as the npm preseed `node_modules` symlink). <!-- @impl: Dockerfile --> <!-- @impl: entrypoint.sh --> All coding agents — pi included — stay `@latest` (user policy: agents auto-update at every deploy); the bake remains self-consistent under `@latest` because the warm run executes with the exact pi installed in the same build, so the cache is always generated by the same pi/jiti that consumes it at runtime. (One residual cold path: a Fast-Start-disabled session runs `pi update` at start, and a pi that updates past the image version may miss the baked cache — it then transpiles cold once, which is the pre-existing Fast-Start-disabled cost profile.)

**Rationale:** jiti's cache is content-addressed (source hash), so entries baked at build hit at runtime even though the R2-seeded extensions land at a different path with fresh mtimes (seeding is verbatim — verified). Validated end-to-end in the live container: 153/153 cache hits, 3.8s extension load through the symlinked baked cache, zero rewrites. The empty-cache build guard turns "a pi CLI change broke the warm-up" into a visible build failure instead of a silent production startup regression.

**Alternatives considered:**

- **`JITI_FS_CACHE=<path>` env (rejected):** ignored by this jiti build — entries land in `$TMPDIR/jiti` regardless (tested).
- **Lazy/deferred extension loading upstream (rejected for now):** requires pi-core changes; the cache bake achieves the same perceived latency without forking load semantics.
- **Raising the pre-warm 20s cap (rejected):** treats the symptom; sessions would still pay the cold transpile, just behind a quieter gate.
- **Pinning the pi version for bisectability (rejected by user policy):** coding agents auto-update at deploy is the product stance; the accepted tradeoff is that a pi-core change and a code change can land in the same deploy. The empty-cache build guard and the AC5 structural tests bound the startup-regression risk specifically.

**Consequences:**

- First Pi launch in a fresh container loads warm (~4s); pre-warm settles on real output, under its cap.
- A preseed package bump automatically re-warms the right set (derived list); each deploy re-warms against whatever pi `@latest` resolves to.
- The V8 compile cache (`NODE_COMPILE_CACHE`, already baked for `--version` paths) additionally gains the extension-graph entries from the same warm run.

**Related:** [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition) AC5, [AD57](#ad57-135-second-shutdown-budget-for-final-bisync) (the same incident's data-loss half).

---

### AD80: Pi PR-boundary merge gate is report-only and defended in depth

**Category:** Architecture

**Status:** Accepted (2026-06-11)

**Context:** A Fable-5 deep review of the Pi PR-boundary review subsystem found the merge gate (the `onAgentStart`/`tool_call` interceptor that blocks `gh pr merge` until the reviewed head is acked) was the weakest-covered layer, and raised two questions that are genuinely product decisions rather than defects. (1) **What does "reviewed" mean for the gate?** `durableReviewAckReady` opens the gate once all required lanes have *produced a result*, regardless of severity — three lane reports that each contain CRITICAL findings still ack the head and let the merge proceed. (2) **How strong should the interception be?** The Pi gate is a hard pre-block (it returns `{block: true}` and the merge tool never runs), unlike Claude, whose enforcement is retroactive (a PostToolUse directive + a Stop-hook turn-block with a 5-strike fail-open) — the merge command actually executes and Claude reacts after, leaning entirely on a `gh pr view`-at-turn-end truth layer.

**Decision:** (1) **Report-only semantics.** The gate blocks until the required reviewers have *run* (their head is acked), NOT until their findings are *addressed*. The lanes are advisory (AD78): they surface findings; acting on them is the user's call. "Merge blocked until review" means "until review *ran*", and `/review-skip` is the explicit user override. (2) **Defense in depth.** Pi keeps its hard pre-block — strengthened so it evaluates the PR the merge command actually targets (`mergeCommandTarget` → a specific number/URL/branch/`--repo`, not just the cwd branch), fails *closed* on a readable-but-malformed PR or a transient `gh` failure while any unacked review (pending, latched-breaker, or outstanding-offer head) exists, and recognises `--auto` and wrapper-prefixed (`timeout`/`env`/`command`/`nice`) forms. On TOP of the pre-block, Pi now also runs Claude's retroactive model as a backstop: after any `gh pr merge`-shaped command runs, if the PR is observed MERGED while its head was never acked, it emits a loud, durable `merge_completed_unreviewed` audit + toast. The pre-block stops the common cases; the retroactive layer catches what no anchor can (`bash -c '…'`, `xargs`, server-side `--auto`). The whole gate decision is the pure, unit-tested `mergeGateDecision`. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::mergeGateDecision --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::mergeCommandTarget --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::onAgentStart -->

**Rationale:** Verdict-gating (blocking the merge until CRITICAL/HIGH findings clear) would make the gate authoritative over a process that is deliberately advisory, would need an override path and a severity contract, and would diverge from Claude's engine — keeping both engines "reviewers ran, not findings fixed" keeps them coherent. Defense in depth is the right answer to "the regex is the gate" for merges: detection has the reconcile backstop, but a single missed merge is unreviewed, so the gate needs both a stronger pre-block AND a retroactive truth layer rather than an ever-more-baroque pre-block regex.

**Alternatives considered:**

- **Block the merge on unaddressed CRITICAL/HIGH (rejected):** stronger, but makes the gate authoritative over advisory lanes, needs a spec + tests + an override path, and diverges from Claude. Revisit if findings are routinely ignored.
- **Pre-block only, no retroactive layer (rejected):** leaves `bash -c`/`xargs`/`--auto` as silent unreviewed-merge holes.
- **Match `gh pr merge` anywhere in the command for the gate (rejected):** over-blocks on mentions (`grep 'gh pr merge'`); the wrapper-word anchor plus the retroactive audit covers the realistic forms without the false-block tax.

**Consequences:**

- The merge gate's correctness is pinned by `mergeGateDecision` unit tests; the inline handler is thin wiring.
- An unreviewed merge that bypasses the pre-block is no longer silent — it leaves a durable audit and a visible toast.
- A reviewed head with unaddressed CRITICAL findings can still be merged; the findings are surfaced, not enforced. If that proves too weak, AD80 is the place to revisit.

**Related:** [REQ-AGENT-055](../../sdd/spec/agents.md#req-agent-055-pi-pr-boundary-review-window-advancement), [REQ-AGENT-058](../../sdd/spec/agents.md#req-agent-058-pr-boundary-review-reconciliation-and-missed-event-recovery), [AD78](#ad78-pr-boundary-review-lanes-run-in-parallel-report-only-reviewers).

---

### AD81: Reuse the container egress-injection layer for per-user GitHub tokens

**Decision:** In enterprise mode, authenticate the agent's GitHub traffic by injecting the user's token at the container egress boundary — reusing the existing AI-Gateway `interceptOutboundHttps` layer — rather than placing the token in the container. `github.com` and `api.github.com` are registered for outbound interception; a `GitHubInterceptor` WorkerEntrypoint resolves and decrypts the per-user token (`DeployKeys.githubToken`, keyed by the bound session's `bucket`), strips the container's placeholder credential, and stamps the real one. The container holds only a non-secret placeholder `GH_TOKEN`.

**Context:** The agent must act with the user's full GitHub permissions (clone/push/PR/merge), but a prompt-injected agent or a malicious dependency could exfiltrate a raw token from the container environment. Codeflare already runs the platform egress-injection pattern for AI keys (placeholder in container → real secret stamped at the Worker boundary, with the Cloudflare containers CA trusted container-wide). Extending it to the GitHub hosts is ~90% reuse and covers git-over-HTTPS and the REST API uniformly — both are HTTPS to github hosts — which dissolves the "token in the container / `gh` has no per-call broker" problem.

**Consequences:**

- Enterprise gets real anti-exfiltration: the real token never enters the container; `printenv` shows only the placeholder, and a session can only ever inject its own user's token (scoping is by the per-session interceptor binding, never the request).
- Non-enterprise (SaaS / other) modes keep the existing deploy-keys→`GH_TOKEN` path — the real token is in the container env, documented as leakage-hygiene, not agent-containment (the user already holds that token). Short-lived GitHub App tokens cap the exfiltration value there.
- The interceptor resolves the token per request (supporting GitHub App refresh and connect-mid-session); a short in-isolate cache bounds KV reads.
- Alternatives rejected: a git credential-helper callback (covers git but not `gh`/REST, and the agent can still request the token — security by obscurity); placing the real `GH_TOKEN` in the enterprise container (defeats the no-secret-in-container guarantee).

**Related:** [REQ-GITHUB-003](../../sdd/spec/github.md#req-github-003-enterprise-egress-injected-github-credentials), [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [CON-GH-002](../../sdd/spec/constraints.md#con-gh-002-the-real-github-token-never-enters-the-enterprise-container), [CON-GH-003](../../sdd/spec/constraints.md#con-gh-003-egress-injection-is-scoped-by-the-per-session-binding).

---

## Related Documentation

- [Architecture - System Components](../lanes/architecture.md#system-components) - Component overview
- [Architecture - Design Rationale](../lanes/architecture.md#design-rationale) - Architectural principles
- [Security - Authentication Gate](../lanes/security.md#authentication-gate) - Security model
- [Authentication - Auth Modes](../lanes/authentication.md#authentication-modes) - CF Access vs Direct GitHub OAuth
- [Mobile - Scroll Stability](../lanes/mobile.md#scroll-stability) - Mobile terminal design decisions
- [Vault - Directory Layout](../lanes/vault.md#directory-layout) - Vault path, hidden-root constraint, special folders
