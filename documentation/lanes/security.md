# Security

Security architecture, encryption at rest, rate limiting, and hardening measures.

**Audience:** Operators, Security

For authentication modes and user identity flow, see [Authentication](authentication.md).

> For the vulnerability reporting policy, see [SECURITY.md](../../SECURITY.md).

---

## Contents

- [Authentication Gate](#authentication-gate)
- [Onboarding Access Request (OAuth-Gated)](#onboarding-access-request-oauth-gated)
- [API Token Containment](#api-token-containment)
- [Enterprise Mode: Credential Containment and CA Trust](#enterprise-mode-credential-containment-and-ca-trust)
- [GitHub Token Handling](#github-token-handling)
- [Container Auth Token (REQ-SEC-012)](#container-auth-token-req-sec-012)
- [Dual R2 Credential Architecture](#dual-r2-credential-architecture)
- [Graceful Shutdown](#graceful-shutdown)
- [Security Hardening (Pre-Launch Review)](#security-hardening-pre-launch-review)
- [Security Headers](#security-headers)
- [Session ID Validation](#session-id-validation)
- [Static-Analyzer False Positives](#static-analyzer-false-positives)
- [Body Limit](#body-limit)
- [Credential Encryption at Rest](#credential-encryption-at-rest)
- [Rate Limiting](#rate-limiting)

## Authentication Gate

All authenticated surfaces (`/app`, `/api`, `/setup`) are protected by one of two auth mechanisms depending on deployment mode:
- **Default/onboarding mode:** Cloudflare Access JWT verification (see [Authentication](authentication.md#authentication-modes) for Access application destination strategy)
- **SaaS mode (GitHub OIDC):** Worker-managed session cookies (`codeflare_session`, HMAC-SHA256). CF Access is bypassed at runtime when `OAUTH_CLIENT_ID` is configured.

In SaaS mode the Cloudflare service token (`CF-Access-Client-Id`/`CF-Access-Client-Secret`) is accepted only for unattended admin automation and is never treated as a user identity (see [AD68](../decisions/README.md#ad68-service-token-admin-bypass-must-be-environment-gated-and-hostname-restricted) and [REQ-AUTH-004](../../sdd/spec/authentication.md#req-auth-004-service-token-authentication-for-e2e-testing), [REQ-AUTH-011](../../sdd/spec/authentication.md#req-auth-011-auth-resolution-order)); user-facing surfaces still require a session cookie.

### Admin elevation via Access group (enterprise)

Admin authorization is normally a durable KV `role:'admin'` record (the Setup Admin Users list). In enterprise mode it can additionally be granted by Cloudflare Access group membership (`setup:enterprise_admin_access_group`), resolved **live** inside `requireAdmin` ([REQ-ENTERPRISE-014](../../sdd/spec/enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups)). Security properties: the get-identity membership check runs only on admin-gated routes (never the hot auth path) and short-circuits for an already-admin user, so the attack/cost surface is unchanged for non-admin traffic; the elevation lives only on the request context (no `role:'admin'` record is written), so removing a user from the group revokes admin access on the **next** request with no residue; and the check **fails closed** (treated as non-member) on any missing token, non-`*.cloudflareaccess.com` domain, or fetch error — an admin gate never elevates on uncertainty. The SSRF host guard on the get-identity domain is shared with the JIT gate ([REQ-ENTERPRISE-010](../../sdd/spec/enterprise-mode.md#req-enterprise-010-access-gated-jit-user-provisioning)).

## Onboarding Access Request (OAuth-Gated)

In onboarding mode, a GitHub OAuth callback that resolves to a non-approved user records an access request and emails the operators ([REQ-AUTH-021](../../sdd/spec/authentication.md#req-auth-021-onboarding-mode-sign-in-choices-and-access-request-flow)). This auto-request path applies **no** Turnstile re-challenge — unlike the public contact / waitlist relay ([REQ-LANDING-002](../../sdd/spec/landing.md#req-landing-002-demo-request-contact-pipeline)), where the submitter is anonymous and CAPTCHA is the abuse gate. Here the request is only reachable after a completed GitHub OAuth handshake, so the human is already IdP-authenticated and the GitHub identity is the abuse gate; a Turnstile prompt would be redundant. The four enterprise SSO buttons on the onboarding login page are contact-form deep links, not identity providers, and start no OIDC handshake.

The email dispatch detail (which helpers send the operator alert and the user receipt) is owned by [Architecture § Onboarding Access-Request Flow](architecture.md#onboarding-access-request-flow-req-auth-021). For security: delivery is best-effort and fire-and-forget — a Resend failure or a missing `RESEND_API_KEY` does not block the sign-in redirect, and the email body carries no internal system details. The branch never runs in SaaS mode (which keeps the `/app/subscribe` redirect) or enterprise mode.

## API Token Containment

The **master** `CLOUDFLARE_API_TOKEN` — the deploy / account-management token stored in Worker secrets (GitHub Secrets -> Worker secrets) — never enters the container. Containers receive R2 credentials (a scoped key pair) for storage, never that master token. A container *may* hold a separate, narrowly-scoped Browser Rendering token under the same `CLOUDFLARE_API_TOKEN` env-var name — a different credential entirely, described next.

The container's own `CLOUDFLARE_API_TOKEN` env var, when present, is a **different, narrowly-scoped** credential — the user- or admin-provided **Browser Rendering** token that powers browser-run — not the master deploy token. In enterprise mode the per-user "Push & Deploy" accordion is hidden, so this value is the admin-global Browser Rendering token configured once in the Setup wizard ([REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)): stored encrypted at rest (kv-crypto, AAD-bound to its KV key) and injected at session start by `applyEnterpriseBrowserToken`. Unlike the GitHub token (egress-injected so it never enters the container), this token is deliberately allowed inside the container because it is scoped to `Browser Rendering - Edit` only — it grants nothing the agent cannot already do through its own browser tools, so the blast radius of a prompt-injected read is one low-privilege capability (and its quota), never R2/Workers/DNS/account access. When no Browser Rendering token is configured the entire browser-run surface (the MCP servers, the Pi extension, and the `browser-run`/`browser-e2e` skills) is withheld from the agents.

## Enterprise Mode: Credential Containment and CA Trust

In Enterprise Mode, two additional invariants apply on top of the standard API token containment policy:

**No credentials in the container.** The AI Gateway URL (`AIG_GATEWAY_URL`) and gateway token (`AIG_TOKEN`) are Worker secrets that live exclusively in the `LlmInterceptor` WorkerEntrypoint. They are never emitted as container env vars, never logged, and never forwarded inside the container boundary. The container only receives `ENTERPRISE_MODE=active` (a non-secret deploy var) and a constant non-secret placeholder credential (`codeflare-enterprise`) that puts each agent CLI into API mode. The interceptor strips the placeholder (along with the container's `x-api-key`/`host`/`content-length`) before forwarding. On the REST API path (`api.cloudflare.com/.../ai/v1/*`) it re-authenticates with `AIG_TOKEN` as `Authorization: Bearer` (Workers AI scope); on the compat fallback path (`gateway.ai.cloudflare.com/.../compat/*`) it re-authenticates with `AIG_TOKEN` as `cf-aig-authorization: Bearer` (AI Gateway Run scope). In both cases the placeholder never reaches the AI provider or the gateway. This satisfies [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC3; the REST transport is recorded in [AD74](../decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api).

**Per-user attribution (email in gateway logs).** The interceptor stamps each forwarded request's `cf-aig-metadata` with the user's email (from a per-session DO prop), so the customer's AI Gateway analytics attribute usage to the real identity. This intentionally sends the IdP-verified email to the customer-owned gateway's logs — an enterprise attribution requirement that overrides the original opaque-bucket-id design ([REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC4) — and stays within the customer's own Cloudflare account.

**CA trust for TLS interception.** Platform outbound-HTTPS interception TLS-terminates the container's connections to LLM provider hosts and re-presents them with a certificate signed by the Cloudflare containers CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`). `entrypoint.sh` installs this CA into the system trust store (`update-ca-certificates`, which covers `curl`/`openssl`) and **persists** `NODE_EXTRA_CA_CERTS` and `REQUESTS_CA_BUNDLE` exports into `.bashrc` so the Node- and Python-based agent runtimes also trust the intercepted connections. The exports are written to `.bashrc` — not merely exported in the entrypoint process — because the agents run in PTYs the terminal server spawns later; those shells source `.bashrc` and do not inherit the entrypoint's environment, so a process-only export would never reach them. Without this step the agents' TLS clients reject the platform-presented certificate and LLM calls fail with an opaque connection error before the request ever reaches the interceptor (`curl` keeps working via the system store, which masks the cause). The CA is mounted by the platform at runtime — it is not embedded in the image — so a missing CA file (`$CF_CA_SRC not found`) is logged as a WARNING and LLM calls fail at the TLS layer rather than silently succeeding with an unverified cert.

**Cloudflare Access isolation.** Interception is platform-internal: the gateway traffic flows through the Worker environment and never traverses a public Cloudflare Access route. No Access policy can be applied to (or block) LLM traffic in flight.

**Per-user scoped R2 tokens:** Each container receives a scoped R2 API token restricted to its owner's bucket. Tokens are created on first login via `getOrCreateScopedR2Token()` in `r2-admin.ts` (called from `lifecycle-init.ts`), which calls `POST /accounts/{accountId}/tokens` with a bucket-specific Object Read + Write policy. Tokens are cached in KV as `r2token:{email}` (encrypted via AES-256-GCM when `ENCRYPTION_KEY` is set) and revoked on user deletion via `deleteScopedR2Token()`. This requires the `API Tokens: Edit` permission on the deploy token.

**R2 token verification:** Cached tokens are validated before use via `verifyTokenExists()` in `r2-admin.ts`. This calls `GET /accounts/{accountId}/tokens/{tokenId}` through the circuit breaker. Only a 404 response (token definitively deleted) invalidates the cache and triggers fresh token creation. Transient errors (429, 500, 502, network errors, circuit breaker open) assume the token is still valid - this prevents a Cloudflare API blip from unnecessarily deleting a valid KV entry and causing rclone 401 errors. The verification runs on every `getOrCreateScopedR2Token()` cache hit.

## GitHub Token Handling

The per-user GitHub token authorizes the agent to act with the user's full GitHub permissions (clone/push/PR/merge). Its handling reuses the same primitives as the policies above — encryption at rest and the enterprise egress-injection layer — so a prompt-injected agent or malicious dependency cannot exfiltrate a raw token.

**At rest.** The token lives in the existing encrypted deploy-keys KV entry (`DeployKeys.githubToken` at `deploy-keys:<bucket>`), encrypted with the same kv-crypto as other secrets (AES-256-GCM, AAD bound to the KV key); plaintext is used only when no `ENCRYPTION_KEY` is configured. It is never returned to the browser — `/api/github/repos` proxies GitHub server-side and status/list responses carry only non-secret metadata such as the login handle ([CON-GH-001](../../sdd/spec/constraints.md#con-gh-001-github-token-encrypted-at-rest-and-never-returned-to-the-browser), [REQ-GITHUB-002](../../sdd/spec/github.md#req-github-002-github-panel-and-repository-listing)).

**Provider/operator client secrets at rest (admin Setup, any mode).** Distinct from the per-user token, the GitHub provider's *client secret* and the Cloudflare OAuth client secret (the App/OAuth-app operator credentials) are configured in the admin-gated Setup wizard and stored encrypted in KV under `setup:github_app_client_secret` / `setup:github_oauth_client_secret` / `setup:cloudflare_oauth_client_secret` (AES-256-GCM, AAD bound to each KV key); the provider type and client ids are stored plain. They are resolved and decrypted server-side (`getGithubProvider` / `getCloudflareProvider`) and never returned to the browser — `GET /api/setup/prefill` returns only a per-credential `…ClientSecretSet` boolean. This is admin-gated in every mode (the GitHub provider config was originally enterprise-only). **Fail closed:** a secret submitted while no `ENCRYPTION_KEY` is configured is rejected at save (`400`) rather than written in plaintext, and a stored secret that cannot be decrypted is treated as unconfigured ([REQ-GITHUB-008](../../sdd/spec/github.md#req-github-008-enterprise-github-provider-configuration-via-setup), [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth)).

**Per-user Cloudflare OAuth token at rest (non-enterprise).** The Cloudflare access + refresh tokens from the per-user Connect-to-Cloudflare flow live in the same encrypted `deploy-keys:<bucket>` entry (Cloudflare fields, source `'oauth'`), never returned to the browser; `getValidCloudflareToken` refreshes on expiry and fails closed (never a stale token), and the OAuth state is HMAC-signed + single-use + bucket-bound (token-fixation CSRF defense). Enterprise has no Cloudflare OAuth ([REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth)).

**Enterprise egress injection (the security core).** In enterprise mode the container holds only a non-secret placeholder `GH_TOKEN` (`codeflare-enterprise`), identical for every user. A `GitHubInterceptor` WorkerEntrypoint sits on the container egress boundary, reusing the AI-Gateway `interceptOutboundHttps` layer (the Cloudflare containers CA is trusted container-wide, so TLS validates — see the CA-trust invariant above). For each outbound request to `github.com` / `api.github.com` it resolves and decrypts the user's token, strips any client-supplied auth (`authorization`, `x-api-key`, etc.), and stamps the correct credential: git over HTTPS gets `Authorization: Basic base64("x-access-token:"+token)`, while the REST API gets `Authorization: Bearer <token>` plus `X-GitHub-Api-Version: 2022-11-28`. It emits a per-user audit line. This satisfies [REQ-GITHUB-003](../../sdd/spec/github.md#req-github-003-enterprise-egress-injected-github-credentials) and reuses the egress layer per [AD81](../decisions/README.md#ad81-reuse-the-container-egress-injection-layer-for-per-user-github-tokens) ([CON-GH-002](../../sdd/spec/constraints.md#con-gh-002-the-real-github-token-never-enters-the-enterprise-container)).

**No cross-user spoofing.** User-scoping comes solely from `props.bucket`, bound at container wiring time, never from the request. A session can therefore only ever inject its own user's token, regardless of the placeholder value or any identity the request claims ([CON-GH-003](../../sdd/spec/constraints.md#con-gh-003-egress-injection-is-scoped-by-the-per-session-binding)).

**Fail closed.** When no valid token exists (not connected, or an expired App token that cannot be refreshed), the interceptor returns 401 and performs no upstream request — it never falls back to a stale token.

**Non-enterprise modes.** The real token reaches the container as `GH_TOKEN` via the existing deploy-keys path, unchanged ([REQ-GITHUB-006](../../sdd/spec/github.md#req-github-006-other-mode-container-transport)). This is documented honestly as leakage-hygiene, **not** agent-containment: the agent can read its own user's token (which that user already holds). Only enterprise mode keeps the real token out of the container.

**Revocation and offboarding.** `POST /api/github/disconnect` revokes the token at GitHub (App/OAuth sources) and clears the github fields from the deploy-keys entry; a manually-pasted PAT is cleared but never sent to GitHub's revoke endpoint (Codeflare does not own it). User offboarding (`user-cleanup.ts`) revokes and clears on the same path as the scoped R2 token, before the deploy-keys entry is deleted, so a leaked-but-not-yet-deleted token cannot outlive the account ([REQ-GITHUB-005](../../sdd/spec/github.md#req-github-005-disconnect-and-offboarding-revocation)).

## Container Auth Token (REQ-SEC-012)

A random shared secret is generated per DO lifecycle and proxied requests from the DO to the container include it in the `Authorization: Bearer` header. The terminal server (`host/src/server.ts`) validates the token on all non-exempt paths. Internal paths (`/health`, `/activity`) are whitelisted because `collectMetrics()` calls them directly via the SDK's private TCP plumbing (`ctx.container.getTcpPort(TERMINAL_SERVER_PORT).fetch(...)`), never through the public `fetch()` override -- so no `Authorization` header is injected. The whitelist is safe because these two paths expose no user data and no mutable container state.

**Threat model -- silent Unauthorized after DO wake (AC5/AC6):** Without lifecycle-scoped persistence, every DO wake from hibernation regenerates a fresh token while the container process retains the original value, breaking every subsequent proxied request with `{"error":"Unauthorized"}` until the user manually recreates the session. The terminal, vault, and every other in-container HTTP surface go silently unreachable.

**Mitigation:** The token is scoped to one DO lifecycle and survives hibernate/wake within that lifecycle; on `destroy()` it is cleared so the next session under the same DO ID starts fresh. Persistence mechanics (DO storage key, restore site, hibernate-window pinning, cleanup hook) live in [architecture.md](./architecture.md#container-do-container). The env-var name (`CONTAINER_AUTH_TOKEN`) is catalogued in [configuration.md](./configuration.md#environment-variables).

## Dual R2 Credential Architecture

Two types of R2 credentials serve different purposes:

**Worker-level R2 credentials** (setup wizard):
- Created during `POST /configure` step 2 (`handleDeriveR2Credentials`)
- `R2_ACCESS_KEY_ID` = API token ID (from `/user/tokens/verify`)
- `R2_SECRET_ACCESS_KEY` = SHA-256(API token value)
- Stored as worker secrets - used for bucket admin operations (create, empty, delete)
- If API token rotated, must re-run setup to regenerate

**Per-user scoped R2 tokens** (first login):
- Created via `getOrCreateScopedR2Token()` in `src/routes/container/lifecycle-init.ts`
- Calls `POST /accounts/{accountId}/tokens` with bucket-specific Object Read + Write policy
- Token ID = S3 Access Key ID, SHA-256(token value) = S3 Secret Access Key
- Cached in KV as `r2token:{email}` - survives container restarts
- Passed to container via `setBucketName` → container env vars → rclone config
- Revoked via `deleteScopedR2Token()` on user deletion
- Requires `API Tokens: Edit` permission on the deploy token

## Graceful Shutdown

`STOPSIGNAL SIGINT` in the Dockerfile. The `entrypoint.sh` trap handler catches SIGINT/SIGTERM, kills the sync daemon via PID file at `/tmp/sync-daemon.pid` (PID file is the sole mechanism - no in-memory PID variable fallback), runs a final `rclone bisync` (with `--ignore-checksum --max-delete 100`) to R2, and kills the terminal server. The bisync-initialized flag is touched on the timeout path as well (was previously missing, which caused shutdown to skip final bisync when initial sync timed out). This ensures no data loss on container stop.

## Security Hardening (Pre-Launch Review)

Fixes from 6 rounds of automated code review before 1500-user launch:

**Auth bypass prevention (CF-005):** `authConfigFetched` boolean sentinel in `access.ts` prevents KV transient errors from permanently degrading a post-setup deployment to the pre-setup header-trust model. Once KV auth config has been successfully fetched with real data (auth domain + aud), the pre-setup fallback that trusts `cf-access-authenticated-user-email` headers is permanently disabled for the isolate's lifetime. `resetAuthConfigCache()` clears the sentinel.

**STRESS_TEST_MODE enforcement (CF-001):** Global middleware in `src/index.ts` returns 503 when both `SAAS_MODE=active` and `STRESS_TEST_MODE=active` - a hard block, not just a warning. `STRESS_TEST_MODE` is only valid in integration/staging (where `SAAS_MODE` is unset); the rate-limit middleware also logs a one-time warning per isolate when the bypass activates, but production safety relies on the 503 here. See [REQ-OPS-008](../../sdd/spec/operations.md#req-ops-008-stress-testing-validates-rate-limits-and-concurrency) (AC6).

**Rate limiter fail-closed (CF-003/011):** `checkRateLimit` in `rate-limit-core.ts` accepts a `failClosed: boolean` parameter. When `true`, KV failure denies the request (503) instead of failing open via in-memory fallback. Applied to security-critical endpoints (Turnstile CAPTCHA verification, access-request). General resource-protection endpoints retain fail-open per [AD6](../decisions/README.md#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity).

**Encryption key warning (CF-017):** `warnIfNoEncryptionKey()` in `kv-crypto.ts` emits a CRITICAL structured log on first request when `ENCRYPTION_KEY` is absent. User credentials (LLM API keys, GitHub tokens, Cloudflare tokens) are stored as plaintext KV when the key is missing.

**Path traversal prevention (CF-012):** `validateKey()` in `storage/validation.ts` decodes URI-encoded sequences via `decodeURIComponent` before the `..` traversal check. Catches `%2E%2E` and double-encoded `%252E%252E` attacks. Malformed URI encoding throws `ValidationError`. Returns the decoded key so callers use the correct value for R2 operations.

**Blocked user subscribe guard:** `POST /api/auth/subscribe` checks `getEffectiveTier` at handler top and throws `ForbiddenError` for blocked users. Previously, blocked users with a valid OIDC session could self-upgrade to free tier.

**SaaS service-token guard:** `cf-access-client-id` header in `getUserFromRequest` is only trusted when `!isSaasModeActive()`. In SaaS mode there is no CF Access edge to validate this header, making it attacker-controlled.

**Session mode billing enforcement:** The stored `sessionMode` preference is clamped against the billing-resolved effective tier by `clampSessionModeToTier` in `src/lib/session-mode.ts` (implements [REQ-SEC-015](../../sdd/spec/security.md#req-sec-015-blocked-user-cannot-self-upgrade-subscription) AC2/AC3). Applied at container start (`lifecycle.ts`) and preferences save (`preferences.ts`). A canceled user with stale `sessionMode: 'advanced'` preference gets `'default'` because the free tier only allows `['default']`. Both call sites use `getEffectiveTier` (not raw JWT `subscriptionTier`).

**Concurrent cache dedup (CF-002):** Auth config fetch in `access.ts` wrapped in `pendingAuthConfigFetch` Promise sentinel (mirrors `pendingJWKSFetch` pattern from `jwt.ts`). Two concurrent cold-start requests reuse the in-flight fetch instead of issuing redundant KV reads. Sentinel cleared on TTL expiry and `resetAuthConfigCache()`.

## Security Headers

Applied to every response in `src/index.ts`:
- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`

HSTS is also applied to all redirect responses via `redirectWithHeaders()` helper in `src/index.ts`, including root redirect and setup redirect, ensuring browsers upgrade to HTTPS even on redirect hops. Preflight (OPTIONS) responses receive HSTS directly in the CORS middleware.

**Vault proxy exemption (CSP + same-origin framing only):** Proxied SilverBullet responses under `/api/vault/:sid/*` do not receive the default `Content-Security-Policy: default-src 'none'` because SilverBullet serves its own HTML with inline scripts/styles, web workers, and `eval`. Instead they receive `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`: enough to block cross-site framing while allowing the dashboard's authenticated same-origin hidden prewarm iframe. The exemption covers the pre-Hono vault proxy path only: route-validation errors and the `/api/vault/:sid/status` JSON endpoint still receive the full default set including CSP and `X-Frame-Options: DENY`. Implemented via `withSecurityHeaders(response, { csp: false, frame: 'sameorigin' })` in `src/index.ts`; see [REQ-SEC-008](../../sdd/spec/security.md#req-sec-008-security-headers-on-every-response).

**Cloudflare Web Analytics CSP allowance:** The default CSP permits the Web Analytics beacon with two narrow additions in `src/index.ts`: `static.cloudflareinsights.com` in `script-src` (the beacon loader `beacon.min.js`) and `cloudflareinsights.com` in `connect-src` (the beacon's telemetry POST endpoint). The beacon is injected as a manually-authored `<script src=...>` tag (gated on `PUBLIC_CF_BEACON_TOKEN`, see [configuration.md](./configuration.md#environment-variables)) specifically so the CSP does not have to be weakened with `'unsafe-inline'`: a script element with an allowlisted host is the strict-CSP-compatible alternative to Cloudflare's auto-injected inline snippet. Both allowances are unconditional — they remain in the header even when `PUBLIC_CF_BEACON_TOKEN` is unset and no beacon is emitted — so the CSP shape does not vary between builds.
## Session ID Validation

`SESSION_ID_PATTERN` (`/^[a-z0-9]{8,24}$/`) is enforced on terminal WebSocket upgrade and container lifecycle endpoints (`terminal.ts`, `container/lifecycle.ts`). Invalid session IDs are rejected with 400 before any DO interaction, preventing malformed IDs from creating orphaned Durable Objects.

Session IDs are KV namespace keys, not authentication tokens. Knowing a session ID without a valid JWT grants zero access. The pattern validates format, not entropy. Inline comment at `src/lib/constants.ts` documents this for SAST tools that flag the pattern as "predictable".

## Static-Analyzer False Positives

Codeflare's threat model places several patterns in scope for static-analysis tools that, in this codebase's specific architecture, are not vulnerabilities. The decisions are documented inline at the source site (search for `SAST-false-positive`) with a brief rationale. The summary:

| Pattern | Site | Why it's not a finding |
|---|---|---|
| Container runs as root (no `USER` directive) | `Dockerfile` (near `STOPSIGNAL`) | Network isolation via Durable Object proxy is the security boundary; only the DO can reach port 8080, and the per-DO container auth token validates every proxied request. Root is required for FUSE mount and runtime tool installation throughout the lifetime, not just init. |
| KV-stored CORS origin patterns not re-validated per request | `src/lib/cors-cache.ts` (`isAllowedOrigin`) | Admin already has full worker access (deploy code, modify secrets). Per-request re-validation adds overhead for zero benefit. |
| Predictable-looking session ID pattern | `src/lib/constants.ts` (`SESSION_ID_PATTERN`) | Session IDs are namespace keys, not auth tokens. JWT is the auth gate. |
| Hardcoded test email `e2e-service@codeflare.local` | `src/lib/access.ts` (service-token branch) | Test fixture using RFC 6762 reserved `.local` TLD. Auth gate is the worker secret, not the email string. |

Each row's rationale is also captured at the source site as an inline comment. To find every entry: `grep -rn "SAST-false-positive" .` - the literal token is the durable anchor, not the line numbers. New SAST findings that match one of these patterns can be silenced via the inline-comment convention rather than escalating to an ADR.

## Body Limit

64 KiB on all `/api/*` routes (storage routes exempt for file uploads).

## Credential Encryption at Rest

Optional encryption for all user secrets and workspace files, enabled by setting `ENCRYPTION_KEY` (base64-encoded 256-bit key). Generate with `openssl rand -base64 32`. Set as a GitHub Actions repository secret named `ENCRYPTION_KEY` - the deploy workflow passes it to the Worker via `wrangler secret put`.

### Key generation and setup

```bash
# Generate a cryptographically secure 32-byte key
openssl rand -base64 32
# Output example: oBmGaRVT1W84oLgeTGif09kBlXxJkMs9uaoiqnCTJC0=

# Add as GitHub Actions secret (Settings > Secrets and variables > Actions)
# Secret name: ENCRYPTION_KEY
# Secret value: <paste the base64 string>
```

The key must decode to exactly 32 bytes. Arbitrary strings, passwords, or non-base64 values are rejected at import time with a clear error.

### What gets encrypted

| Storage | KV key pattern | Data | Encryption |
|---------|---------------|------|------------|
| KV | `llm-keys:{bucket}` | OpenAI, Gemini API keys | AES-256-GCM |
| KV | `deploy-keys:{bucket}` | GitHub PAT or OAuth token, Cloudflare API token or OAuth access+refresh token (per-user connect), account ID | AES-256-GCM |
| KV | `r2token:{email}` | Scoped R2 access key, secret key, token ID | AES-256-GCM |
| KV | `setup:browser_render_token` | Enterprise admin-global Cloudflare Browser Rendering token | AES-256-GCM |
| KV | `setup:github_app_client_secret`, `setup:github_oauth_client_secret` | GitHub provider client secret (App / OAuth) — admin-gated, any mode | AES-256-GCM |
| KV | `setup:cloudflare_oauth_client_secret` | Cloudflare OAuth client secret — operator credential, admin-gated, non-enterprise | AES-256-GCM |
| R2 | All objects in user buckets | Workspace files, agent configs, credentials | SSE-C (AES-256) |

Everything else stays plaintext - no secrets in those entries. The exceptions in the `setup:*` namespace are the encrypted secret keys listed above (`setup:browser_render_token`, `setup:github_app_client_secret`, `setup:github_oauth_client_secret`, `setup:cloudflare_oauth_client_secret`); the rest of `setup:*` (provider type, client ids, route catalog, group routing, access groups) is non-secret config and stays plaintext.

### KV encryption (AES-256-GCM via Web Crypto API)

Implementation: `src/lib/kv-crypto.ts`

**Ciphertext format:** `v1:` + base64(12-byte random IV + AES-256-GCM ciphertext + 16-byte auth tag). The `v1:` prefix distinguishes encrypted values from plaintext JSON, enabling format evolution without breaking existing data.

**AAD (Additional Authenticated Data):** The KV key name (e.g., `llm-keys:codeflare-user-example-com`) is bound to the ciphertext as AAD. This prevents ciphertext from being copied between KV keys - decryption fails if the key name doesn't match.

**Key caching:** The CryptoKey is imported once per Worker isolate lifetime and cached in module-level state. Subsequent requests reuse the cached key without re-importing.

**API responses** always return masked values (`****` + last 4 chars), never plaintext keys - regardless of whether encryption is enabled.

### Transparent KV migration ([REQ-SEC-006](../../sdd/spec/security.md#req-sec-006-transparent-kv-encryption-migration))

When `ENCRYPTION_KEY` is enabled on an existing deployment with plaintext KV entries:

1. `getAndDecrypt()` reads the raw value as text
2. If value starts with `v1:` → decrypt with AES-256-GCM → return parsed JSON (fast path)
3. If value is valid JSON without `v1:` prefix → plaintext legacy entry → parse and return
4. Fire-and-forget: re-encrypt the plaintext value and write back to KV (`kv.put` runs asynchronously, never blocks the response)
5. Subsequent reads hit the fast decrypt path (step 2)

The write-back is fire-and-forget - if the KV write fails (transient error, rate limit), the caller still gets the correct data. Migration retries automatically on the next read. No data loss, no downtime.

**Race condition safety:** Two concurrent requests can both read the same plaintext entry and both write encrypted copies. This is safe because both workers encrypt the same plaintext - whichever write wins is equally valid. Real updates go through `encryptAndStore()` which always encrypts directly.

### R2 SSE-C encryption

Implementation: `src/lib/r2-sse.ts`

When `ENCRYPTION_KEY` is set, all R2 object operations include SSE-C headers:

| S3 operation | Route | Headers |
|-------------|-------|---------|
| PutObject | `upload.ts` (simple + multipart part) | `getSseHeaders()` |
| InitiateMultipartUpload | `upload.ts` | `getSseHeaders()` |
| GetObject | `download.ts`, `preview.ts` | `getSseHeaders()` |
| HeadObject | `preview.ts`, `r2-seed.ts` | `getSseHeaders()` |
| PutObject (seed) | `r2-seed.ts` | `getSseHeaders()` |

SSE-C headers: `x-amz-server-side-encryption-customer-algorithm: AES256`, `x-amz-server-side-encryption-customer-key: <base64 key>`, `x-amz-server-side-encryption-customer-key-MD5: <base64 MD5 of raw key bytes>`. The MD5 is computed via `node:crypto createHash('md5')`.

**Rclone integration:** `ENCRYPTION_KEY` is passed from Worker → Durable Object → container env var. In `entrypoint.sh`, when present, `sse_customer_key_base64` and `sse_customer_algorithm = AES256` are appended to `rclone.conf`. Rclone auto-computes the MD5 from the base64 key. All bisync operations (initial restore, periodic sync, shutdown sync) transparently encrypt/decrypt.

**Cloudflare dashboard impact:** With SSE-C enabled, files are visible in the R2 dashboard (names, sizes, metadata) but contents are unreadable - the dashboard doesn't have the encryption key. Downloads through the app work normally (Worker decrypts transparently).

## Rate Limiting

Per-user rate limiting via `createRateLimiter()` factory in `src/middleware/rate-limit.ts`. Keyed by `bucketName` (user identifier set by auth middleware), falls back to `CF-Connecting-IP` for unauthenticated requests.

**Storage:** Primary storage is Cloudflare KV with automatic TTL expiry (window duration + 60s buffer). When KV operations fail, falls back to an in-memory `Map` with periodic cleanup every 100 requests to prevent unbounded growth.

**Response Headers:** All rate-limited responses include:
- `X-RateLimit-Limit`: Maximum requests per window
- `X-RateLimit-Remaining`: Remaining requests in current window

When the limit is exceeded: HTTP 429 with `{ code: "RATE_LIMIT_ERROR", message: "Rate limit exceeded. Try again in N seconds." }`

**KV Key Pattern:** `{keyPrefix}:{userId}` - e.g., `storage-upload:codeflare-user-john-example-com`. Use `rl-` prefix when the key prefix would collide with application cache keys (e.g., `storage-stats` collides with the stats cache key `storage-stats:{bucketName}`, so the rate limiter uses `rl-storage-stats`).

**Rate limits per endpoint:**

| Endpoint | Method | Limit | Key Prefix |
|----------|--------|-------|-----------|
| `/api/storage/upload/*` | POST | 60/min | `storage-upload` |
| `/api/storage/delete` | POST | 20/min | `storage-delete` |
| `/api/storage/seed/*` | POST | 3/min | `storage-seed` |
| `/api/storage/download` | GET | 120/min | `storage-download` |
| `/api/storage/preview` | GET | 120/min | `storage-preview` |
| `/api/storage/browse` | GET | 30/min | `storage-browse` |
| `/api/storage/stats` | GET | 10/min | `rl-storage-stats` |
| `/api/sessions/:id` | DELETE | 10/min | `session-delete` |
| `/api/sessions/:id/stop` | POST | 10/min | `session-stop` |
| `/api/user/ensure-r2-token` | POST | 5/min | `ensure-r2-token` |
| `/api/sessions` | POST | 10/min | `session-create` |
| `/api/container/start` | POST | 5/min | `container-start` |
| `/api/users/:email` | DELETE | 20/min | `user-mutation` |
| `/api/setup/status` | GET | 30/min | `setup-status` |
| `/api/setup/detect-token` | GET | 10/min | `setup-detect-token` |
| `/api/setup/prefill` | GET | 10/min | `setup-prefill` |
| `/api/setup/configure` | POST | 5/min | `setup-configure` |
| `PATCH /api/preferences` | PATCH | 20/min | `preferences-patch` |
| `POST /api/auth/request-access` | POST | 3/hr | `request-access` |
| `POST /api/auth/subscribe` | POST | 3/min | `subscribe` |
| `POST /public/waitlist` | POST | 5/min | `waitlist-submit` |

### Adding a new rate limiter

```typescript
import { createRateLimiter } from '../../middleware/rate-limit';

const myRateLimiter = createRateLimiter({
  windowMs: 60_000,    // 1 minute window
  maxRequests: 10,     // max 10 requests per window
  keyPrefix: 'my-route', // KV key prefix (must not collide with app cache keys)
});

// Apply to all routes in a sub-app:
app.use('*', myRateLimiter);

// Or apply to a specific route inline:
app.post('/endpoint', myRateLimiter, async (c) => { ... });
```

### Stress Test Bypass

When `STRESS_TEST_MODE` is set to `"active"`, all HTTP and WebSocket rate limits are bypassed. This is intended for integration environments only, to allow k6 stress tests with high virtual user counts (1000+) through a single service token identity. The bypass skips all KV rate-limit reads/writes for zero overhead. A one-time warning is logged per isolate when the bypass activates.

### Content-Disposition Hardening

File download responses set `Content-Disposition: attachment` with sanitized filenames by default — special characters are stripped before encoding and filenames truncated to prevent header injection ([REQ-SEC-013](../../sdd/spec/security.md#req-sec-013-content-disposition-hardening-on-downloads)). When the caller passes `?disposition=inline`, the endpoint serves the file for in-browser viewing. To prevent stored-XSS against the app's own origin, the inline `Content-Type` is derived from the file extension via a strict allowlist (`safeInlineContentType` in `src/routes/storage/download.ts`: images and PDF keep their real type, everything else is forced to `text/plain; charset=utf-8`) rather than from R2's stored metadata, and `X-Content-Type-Options: nosniff` is always set on inline responses so the browser cannot sniff `text/plain` into executable HTML or SVG.

### Input Validation (atob)

Base64-encoded inputs are validated with try/catch around `atob()`. Invalid base64 returns 400 immediately rather than propagating decode errors.

### WebSocket Rate Limit (REQ-SEC-007)

30 connections per 60-second window per user (`WS_RATE_LIMIT_WINDOW_MS = 60000`, `WS_RATE_LIMIT_MAX_CONNECTIONS = 30`). Defined in `src/lib/constants.ts`.

**Check order in `handleWebSocketUpgrade`** (three pre-rate-limit gates, executed in this sequence):

1. **Session-stopped gate ([REQ-SEC-020](../../sdd/spec/security.md#req-sec-020-ws-upgrade-rate-limit-short-circuits) AC1):** WebSocket upgrade requests for sessions whose KV status is `stopped` are rejected immediately with close code 4503 (`container-stopped`) before the rate-limit counter is consulted. A browser reconnect storm against a hibernated or crashed container does not consume the user's 30-connection budget.

2. **Warm-up gate ([REQ-SEC-020](../../sdd/spec/security.md#req-sec-020-ws-upgrade-rate-limit-short-circuits) AC2):** After the stopped check, the worker peeks the container `/health` endpoint. If the container is up but still initializing (port 8080 bound but R2 sync and `.bashrc` autostart writes not yet complete), the host sets `terminalServiceReady=false` in the health response. The worker rejects the upgrade with close code 1013 (`container-warming-up`) before the rate-limit counter is consulted. This prevents reconnect storms during the ~10s cold-start window from consuming rate-limit budget and from spawning PTYs against pre-sync state (bare bash, no agent autostart). The `/health` probe is fail-open: any probe error or missing `terminalServiceReady` field falls through to the normal rate-limit path. The host server applies the same gate directly at the WebSocket accept layer ([REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition) AC2).

3. **Rate-limit check ([REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure)):** The 30 connections/60s window counter is only consulted after both gates above pass.

Implements [REQ-SEC-020](../../sdd/spec/security.md#req-sec-020-ws-upgrade-rate-limit-short-circuits) (with [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) providing the underlying rate-limit infrastructure).

### Vault Editor Rate Limit (REQ-VAULT-005 + REQ-SEC-007)

The vault editor proxy at `/api/vault/:sid/*` runs through `validateVaultRoute` -> `handleVaultRequest` in `src/routes/vault.ts`. WebSocket upgrades for SilverBullet's live-edit sync are rate-limited via the same `ws-connect:<email>` bucket as terminal WebSockets (30 connections per 60s window), sharing budget across both surfaces so a runaway editor reconnect cannot starve terminal use. Plain HTTP requests to the editor share the per-user HTTP rate-limit defaults.

Surface: [REQ-VAULT-005](../../sdd/spec/vault.md#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (proxy exists). Rate-limit infrastructure: [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) (shared bucket and 30/60s window).

### Session Limits ([REQ-SUB-013](../../sdd/spec/subscription.md#req-sub-013-concurrent-session-limits))

Per-user cap on concurrent running sessions, configurable by role via `MAX_SESSIONS_USER` (default: 3) and `MAX_SESSIONS_ADMIN` (default: 10) in `wrangler.toml`.

**Frontend-first enforcement:** The dashboard disables the start button when `isAtSessionLimit()` returns true (running + initializing sessions >= maxSessions). A popup explains the limit and which sessions to stop.

**Backend loose check:** `POST /api/container/start` counts KV sessions with `status === 'running'` under the user's prefix (excluding the current session to allow restarts). Returns 402 `QuotaExceededError` with the actual limit message if at or over the limit. This is a secondary guard -- the frontend prevents most limit violations before they reach the backend.

**`GET /api/sessions/batch-status`** returns `maxSessions` alongside `statuses` so the frontend stays in sync with the server-side limit without hardcoding defaults.

### Path Traversal Prevention ([REQ-SEC-010](../../sdd/spec/security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints))

Browse endpoint validates prefix parameter against directory traversal (`..` rejection) and protected path access via `validateKey()` in `src/routes/storage/validation.ts`.

### Container Image Scanning ([REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-container-image-scanned-for-cves-before-deploy))

Trivy scans Docker images for HIGH/CRITICAL vulnerabilities before deployment (in `deploy.yml` and `deploy-dockerhub.yml`). The scan runs with `ignore-unfixed: true`, so the deploy fails only on a HIGH/CRITICAL CVE that has an **available fix** and is not suppressed. Unfixed CVEs (blank Fixed Version — no upstream patch) cannot be remediated by rebuilding and are not gated; this stops the recurring breakage where a newly-published, unfixable base-image CVE would block every deploy until manually suppressed.

**Suppression policy (`.trivyignore`):** With `ignore-unfixed`, the allowlist is now for **fixable** CVEs that are consciously accepted — a fix exists but cannot be applied yet (typically a vendored CLI such as rclone/lazygit/an npm CLI fixed upstream but not yet rebuilt). A CVE is added only when all of:

1. **No untrusted-input path** — the vulnerable code is never reached with attacker-controlled input in the container (typically outbound-only CLI tools, or base-image / git-tooling dependencies never invoked on hostile archives, JSON, XML, or MIME).
2. **Impact is limited** — DoS only (CPU/memory exhaustion or panic), with no confidentiality or integrity impact in this container's context.
3. **The fix is not yet applicable** — it exists upstream but the vendored tool or base image has not rebuilt against it.

Every entry carries an inline comment recording the affected package, the impact, and which conditions apply. The allowlist is reviewed monthly and entries are removed once a fix reaches the image. (Pre-existing entries for unfixed CVEs are now redundant with `ignore-unfixed` but are left in place as a documented record.)

### Protected R2 Paths

**`PROTECTED_PATHS` is now empty** (`[]` in `src/lib/constants.ts`). Previously, paths like `.claude/`, `.anthropic/`, `.ssh/`, `.config/`, `.claude.json` were blocked from the web storage API. The protection was removed - all R2 paths are now accessible via browse, upload, and delete. The `validateKey()` function in `src/routes/storage/validation.ts` still checks the array but it's a no-op with an empty list.

---

## Specification Coverage

- [REQ-OPS-009](../../sdd/spec/operations.md#req-ops-009-supply-chain-security-monitoring) - Supply chain security monitoring
- [REQ-OPS-019](../../sdd/spec/operations.md#req-ops-019-security-posture-scanning-workflows) - Security-posture scanning workflows
- [REQ-AUTH-004](../../sdd/spec/authentication.md#req-auth-004-service-token-authentication-for-e2e-testing) - Service token authentication scoped to automation, not user identity (AD68)
- [REQ-AUTH-011](../../sdd/spec/authentication.md#req-auth-011-auth-resolution-order) - Auth resolution order: service token resolves to admin automation ahead of SaaS/Access (AD68)
- [REQ-AUTH-020](../../sdd/spec/authentication.md#req-auth-020-onboarding-mode-landing-integrated-login-shell) - Onboarding `/login` landing shell
- [REQ-AUTH-021](../../sdd/spec/authentication.md#req-auth-021-onboarding-mode-sign-in-choices-and-access-request-flow) - Onboarding access request is OAuth-gated (no Turnstile re-challenge); confirmation emails via Resend
- [REQ-SEC-001](../../sdd/spec/security.md#req-sec-001-authenticated-endpoints-reject-unauthenticated-requests) - Authenticated endpoints reject unauthenticated requests
- [REQ-SEC-003](../../sdd/spec/security.md#req-sec-003-per-user-r2-tokens-scoped-to-user-bucket) - Per-user R2 tokens scoped to user bucket
- [REQ-SEC-004](../../sdd/spec/security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract) - Credential encryption-at-rest cryptographic contract
- [REQ-SEC-006](../../sdd/spec/security.md#req-sec-006-transparent-kv-encryption-migration) - Transparent KV encryption migration
- [REQ-SEC-009](../../sdd/spec/security.md#req-sec-009-input-validation-at-system-boundaries) - Input validation at system boundaries
- [REQ-SEC-010](../../sdd/spec/security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints) - Path traversal prevention on storage endpoints
- [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-container-image-scanned-for-cves-before-deploy) - Container image scanned for CVEs before deploy
- [REQ-SEC-012](../../sdd/spec/security.md#req-sec-012-container-auth-token-per-do-lifecycle) - Container auth token per DO lifecycle
- [REQ-SEC-014](../../sdd/spec/security.md#req-sec-014-saas-service-token-header-not-trusted-in-saas-mode) - SaaS service-token header not trusted in SaaS mode
- [REQ-SEC-016](../../sdd/spec/security.md#req-sec-016-concurrent-cache-deduplication-for-auth-config) - Concurrent cache deduplication for auth config
- [REQ-SEC-018](../../sdd/spec/security.md#req-sec-018-credential-encryption-operational-policy) - Credential encryption operational policy
- [REQ-SEC-021](../../sdd/spec/security.md#req-sec-021-hsts-coverage-on-redirect-response-paths) - HSTS coverage on redirect response paths
- [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) - Outbound-interception LLM routing; gateway credentials never enter the container (AC3)
- [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) - Container-side CA trust and constant base-URLs
- [REQ-ENTERPRISE-009](../../sdd/spec/enterprise-mode.md#req-enterprise-009-enterprise-backend-route-hardening) - Enterprise backend route hardening (billing, tier-config, subscribe, Stripe webhook fail closed with 403)
- [REQ-ENTERPRISE-010](../../sdd/spec/enterprise-mode.md#req-enterprise-010-access-gated-jit-user-provisioning) - Access-gated JIT provisioning; get-identity gate fails closed on error or non-membership
- [REQ-ENTERPRISE-014](../../sdd/spec/enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups) - Admin elevation via Access group: live, context-only, fails closed; confined to admin routes
- [REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token) - Enterprise admin-configured Browser Rendering token (blast-radius rationale; why it is allowed inside the container)
- [REQ-GITHUB-002](../../sdd/spec/github.md#req-github-002-github-panel-and-repository-listing) - GitHub panel and repository listing (token never returned to the browser)
- [REQ-GITHUB-003](../../sdd/spec/github.md#req-github-003-enterprise-egress-injected-github-credentials) - Enterprise egress-injected GitHub credentials (GitHubInterceptor, AD81)
- [REQ-GITHUB-005](../../sdd/spec/github.md#req-github-005-disconnect-and-offboarding-revocation) - Disconnect and offboarding revocation
- [REQ-GITHUB-006](../../sdd/spec/github.md#req-github-006-other-mode-container-transport) - Other-mode container transport (leakage-hygiene characterisation)
- [REQ-GITHUB-008](../../sdd/spec/github.md#req-github-008-enterprise-github-provider-configuration-via-setup) - GitHub provider config, admin-gated any mode (client secret encrypted at rest, fail-closed without ENCRYPTION_KEY)
- [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) - Per-user Cloudflare OAuth + operator client secret (encrypted at rest, fail-closed, signed single-use state; enterprise excluded)

---

## Related Documentation
- [Authentication - Auth Modes](authentication.md#authentication-modes) - CF Access vs Direct GitHub OAuth
- [Configuration - GitHub Integration](configuration.md#github-integration) - GitHub App/OAuth env vars, GH_TOKEN placeholder, Browser Rendering token setup
- [Billing - Subscription Tiers](billing.md) - Tier-based access control
- [API Reference - Common Headers](api-reference.md#common-response-headers) - Security headers on responses
- [pentest.md](pentest.md) - Penetration testing results
- [stress-test.md](stress-test.md) - Load testing and rate limit validation
- [Troubleshooting](troubleshooting.md#common-failure-modes) - Common failure modes
- [Decisions](../decisions/README.md#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) - Security-related architecture decisions
