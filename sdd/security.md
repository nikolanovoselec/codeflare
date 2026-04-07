# Security

Security requirements for authentication enforcement, credential isolation, encryption, rate limiting, input validation, and hardening.

**Domain owner:** Worker (Hono middleware, access.ts, rate-limit.ts, kv-crypto.ts, r2-sse.ts, validation.ts)

### Key Concepts

- **Authentication Gate** -- Middleware that rejects unauthenticated requests to protected surfaces (`/app`, `/api`, `/setup`). Enforced in `access.ts` via `getUserFromRequest()`.
- **Rate Limiting** -- Per-user request throttling backed by KV with in-memory fallback. Keyed by bucket name (authenticated) or `CF-Connecting-IP` (unauthenticated). Fail-closed for security endpoints, fail-open for resource endpoints.
- **Encryption at Rest** -- AES-256-GCM encryption of KV values (credentials, tokens) using a base64-encoded 256-bit `ENCRYPTION_KEY`. Ciphertext format: `v1:` + base64(IV + ciphertext + tag).
- **SSE-C** -- Server-Side Encryption with Customer-Provided Keys. R2 objects are encrypted via S3-compatible `x-amz-server-side-encryption-customer-*` headers. Files are visible in the dashboard but contents are unreadable without the key.
- **Security Headers** -- Standard HTTP response headers (HSTS, CSP, X-Frame-Options, etc.) applied globally in `src/index.ts` middleware to prevent common web attacks.

### Out of Scope

- WAF rules and DDoS protection (handled by Cloudflare's edge network)
- Penetration testing automation (pentest.yml is a lightweight probe suite, not a full pentest tool)
- Certificate management (handled by Cloudflare's edge TLS termination)

### Domain Dependencies

- **Authentication** -- Auth enforcement (REQ-SEC-001) depends on auth mode resolution from the Authentication domain
- **Storage** -- R2 encryption (REQ-SEC-005) depends on R2 bucket operations from the Storage domain
- **Subscription** -- Tier-based rate limits and blocked-user enforcement (REQ-SEC-015) depend on effective tier resolution from the Subscription domain

---

## REQ-SEC-001: Authenticated endpoints reject unauthenticated requests

**Intent:** All protected surfaces (`/app`, `/api`, `/setup` post-first-configure) must deny access to unauthenticated users with an appropriate HTTP response.

**Acceptance Criteria:**
1. Unauthenticated requests to `/app/*`, `/api/*`, and `/setup/*` (after setup is complete) receive 401, 302, or 403 responses.
2. In CF Access mode, requests without a valid `CF_Authorization` cookie or `cf-access-jwt-assertion` header are rejected.
3. In SaaS (GitHub OIDC) mode, requests without a valid `codeflare_session` cookie are rejected.
4. Injecting `cf-access-authenticated-user-email` headers does NOT bypass authentication after setup is complete.
5. The `authConfigFetched` sentinel in `access.ts` prevents KV transient errors from permanently degrading to the pre-setup header-trust model.
6. Automated pentest (`pentest.yml` auth-gate job) verifies seven API endpoints require authentication.
7. `GET /api/setup/status` is always public (returns only configuration status, no secrets).

**Constraints:**
- Pre-setup endpoints (`/api/setup/configure` before first completion) are intentionally public to solve the bootstrap problem (AD10).
- Service token auth (`X-Service-Auth` header) is checked first in all modes for E2E testing.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-AUTH-001, REQ-AUTH-010
**Verification:** Automated test (pentest.yml auth-gate job)

**Status:** Implemented

---

## REQ-SEC-002: API tokens never enter containers

**Intent:** The master Cloudflare API token must never be exposed inside container environments. Containers receive only scoped, per-user credentials.

**Acceptance Criteria:**
1. `CLOUDFLARE_API_TOKEN` stays in the Worker/DO environment (GitHub Secrets -> Worker secrets).
2. Containers receive only per-user scoped R2 credentials (access key pair), never the master API token.
3. The container environment variables do not include `CLOUDFLARE_API_TOKEN`.
4. R2 credentials passed to containers are scoped to the user's bucket (Object Read + Write only).

**Constraints:**
- The Worker/DO acts as a security boundary between the API token and container-executed user code.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SEC-003
**Verification:** Automated test (pentest.yml info-disclosure job)

**Status:** Implemented

---

## REQ-SEC-003: Per-user R2 tokens scoped to user bucket

**Intent:** Each user's container receives an R2 API token restricted to that user's storage bucket, preventing cross-user data access.

**Acceptance Criteria:**
1. `getOrCreateScopedR2Token()` in `r2-admin.ts` creates a per-user token via `POST /accounts/{accountId}/tokens` with a bucket-specific Object Read + Write policy.
2. Token ID serves as the S3 Access Key ID; SHA-256 of the token value serves as the S3 Secret Access Key.
3. Tokens are cached in KV as `r2token:{email}` (encrypted when `ENCRYPTION_KEY` is set).
4. Cached tokens are validated before use via `verifyTokenExists()` (GET request through circuit breaker). Only a definitive 404 invalidates the cache.
5. Transient errors (429, 500, 502, network errors, circuit breaker open) assume the token is still valid to prevent unnecessary rclone 401 errors.
6. Tokens are revoked on user deletion via `deleteScopedR2Token()`.
7. Token creation requires the `API Tokens: Edit` permission on the deploy token.

**Constraints:**
- Token verification runs on every `getOrCreateScopedR2Token()` cache hit, not just on creation.
- Verification failures due to transient errors do not delete the cached token.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SEC-004
**Verification:** Integration test (E2E session start verifies container receives scoped credentials)

**Status:** Implemented

---

## REQ-SEC-004: Credential encryption at rest when ENCRYPTION_KEY configured

**Intent:** When an operator provides an encryption key, all user secrets stored in KV must be encrypted at rest using AES-256-GCM.

**Acceptance Criteria:**
1. `ENCRYPTION_KEY` is a base64-encoded 256-bit key (exactly 32 bytes decoded). Non-base64 or wrong-length values are rejected at import.
2. KV values for `llm-keys:{bucket}`, `deploy-keys:{bucket}`, and `r2token:{email}` are encrypted with AES-256-GCM via Web Crypto API.
3. Ciphertext format is `v1:` + base64(12-byte random IV + ciphertext + 16-byte auth tag).
4. The KV key name is bound as AAD (Additional Authenticated Data), preventing ciphertext from being copied between KV keys.
5. The CryptoKey is imported once per Worker isolate lifetime and cached.
6. API responses always return masked values (`****` + last 4 chars), never plaintext keys.
7. When `ENCRYPTION_KEY` is absent, `warnIfNoEncryptionKey()` emits a CRITICAL structured log on the first request.
8. Non-secret KV entries (`user-prefs:*`, `session:*`, `user:*`, `setup:*`, `storage-stats:*`) remain plaintext.

**Constraints:**
- Key is generated via `openssl rand -base64 32` and stored as a GitHub Actions secret.
- Key pipeline: GitHub Secret -> `wrangler secret put` -> Worker env -> CryptoKey import.

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test (unit tests for kv-crypto.ts encrypt/decrypt round-trip)

**Status:** Implemented

---

## REQ-SEC-005: R2 files encrypted via SSE-C when ENCRYPTION_KEY configured

**Intent:** When an operator provides an encryption key, all R2 object storage operations must use server-side encryption with customer-provided keys (SSE-C).

**Acceptance Criteria:**
1. All R2 PutObject, GetObject, HeadObject, and InitiateMultipartUpload operations include SSE-C headers when `ENCRYPTION_KEY` is set.
2. SSE-C headers include `x-amz-server-side-encryption-customer-algorithm: AES256`, the base64 key, and the base64 MD5 of raw key bytes.
3. `ENCRYPTION_KEY` is passed from Worker to Durable Object to container as an environment variable.
4. In containers, `entrypoint.sh` appends `sse_customer_key_base64` and `sse_customer_algorithm = AES256` to `rclone.conf`.
5. All rclone bisync operations (initial restore, periodic sync, shutdown sync) transparently encrypt/decrypt.
6. Files are visible in the R2 dashboard (names, sizes, metadata) but contents are unreadable without the key.
7. When `ENCRYPTION_KEY` is not set, R2 operations proceed without SSE-C headers (no code path changes).

**Constraints:**
- Enabling SSE-C on an existing deployment requires re-uploading all existing unencrypted R2 objects with SSE-C headers.
- New deployments that set `ENCRYPTION_KEY` from the start require no migration.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-STOR-001
**Verification:** Integration test (E2E storage operations verify encrypted round-trip)

**Status:** Implemented

---

## REQ-SEC-006: Transparent KV encryption migration

**Intent:** Enabling encryption on an existing deployment with plaintext KV data must be seamless, with no downtime and no data loss.

**Acceptance Criteria:**
1. `getAndDecrypt()` detects encrypted values by the `v1:` prefix and decrypts them.
2. Plaintext JSON values without the `v1:` prefix are parsed directly (legacy path).
3. Plaintext values trigger a fire-and-forget re-encryption write-back to KV.
4. Subsequent reads of the migrated value hit the fast decrypt path.
5. If the write-back fails (transient error, rate limit), the caller still receives correct data.
6. Two concurrent requests reading the same plaintext entry can both write encrypted copies safely (both encrypt the same plaintext; whichever write wins is equally valid).
7. Real updates via `encryptAndStore()` always encrypt directly (no migration path needed).

**Constraints:**
- Migration is lazy (on-read), not batch. Complete migration happens gradually as values are accessed.
- No downtime or manual intervention required.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SEC-004
**Verification:** Automated test (unit tests for plaintext-to-encrypted migration path)

**Status:** Implemented

---

## REQ-SEC-007: Rate limiting on all mutation endpoints

**Intent:** Every endpoint that creates, modifies, or deletes resources must be rate-limited to prevent abuse and resource exhaustion.

**Acceptance Criteria:**
1. Rate limiting is implemented via `createRateLimiter()` factory, keyed by `bucketName` (user identifier) with `CF-Connecting-IP` fallback for unauthenticated requests.
2. Primary storage is Cloudflare KV with automatic TTL expiry (window + 60s buffer). Fallback is an in-memory `Map` with periodic cleanup every 100 requests.
3. Exceeded limits return HTTP 429 with `{ code: "RATE_LIMIT_ERROR", message: "Rate limit exceeded. Try again in N seconds." }`.
4. All rate-limited responses include `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers.
5. WebSocket connections are rate-limited at 30 per 60-second window per user.
6. Per-user concurrent session caps are enforced: `MAX_SESSIONS_USER` (default 3), `MAX_SESSIONS_ADMIN` (default 10).
7. Security-critical endpoints (`request-access`, Turnstile verification) use fail-closed rate limiting (KV failure returns 503 instead of allowing the request).
8. General resource-protection endpoints use fail-open rate limiting (per AD6).
9. When `STRESS_TEST_MODE=active`, all rate limits are bypassed with a one-time warning per isolate.

**Constraints:**
- KV key prefixes must not collide with application cache keys (use `rl-` prefix where collision exists).
- `STRESS_TEST_MODE` must not be active alongside `SAAS_MODE` (global middleware returns 503).

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test (unit tests for rate limiter + pentest.yml injection job)

**Status:** Implemented

---

## REQ-SEC-008: Security headers on every response

**Intent:** Every HTTP response must include standard security headers to prevent common web attacks.

**Acceptance Criteria:**
1. `Strict-Transport-Security` (HSTS) is present on all responses, including redirects and OPTIONS preflight responses.
2. `Content-Security-Policy` is set.
3. `X-Content-Type-Options: nosniff` is set.
4. `X-Frame-Options: DENY` is set.
5. `Referrer-Policy: strict-origin-when-cross-origin` is set.
6. `Permissions-Policy` is set.
7. `X-Powered-By` header is absent.
8. HSTS is applied on redirect responses via `redirectWithHeaders()` helper, including root redirect and setup redirect.
9. Automated pentest (`pentest.yml` security-headers job) verifies all header presence and `X-Powered-By` absence.

**Constraints:**
- Headers are applied in `src/index.ts` global middleware.
- Preflight (OPTIONS) responses receive HSTS directly in the CORS middleware.

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test (pentest.yml security-headers job)

**Status:** Implemented

---

## REQ-SEC-009: Input validation at system boundaries

**Intent:** All external input (user requests, API parameters, file paths) must be validated before processing to prevent injection, traversal, and corruption.

**Acceptance Criteria:**
1. Request bodies are validated with Zod schemas before handler logic executes.
2. Setup wizard inputs (domain, emails, origins) are validated via Zod with specific patterns (valid domain, valid email, origin suffix starting with `.`).
3. Session IDs are validated against `SESSION_ID_PATTERN` (`/^[a-z0-9]{8,24}$/`) on terminal WebSocket upgrade and container lifecycle endpoints. Invalid IDs are rejected with 400 before any DO interaction.
4. Base64-encoded inputs are validated with try/catch around `atob()`. Invalid base64 returns 400 immediately.
5. `/api/*` routes enforce a 64 KiB body limit (storage routes exempt for file uploads).
6. Email addresses are trimmed and lowercased before KV lookup, role resolution, and bucket name derivation.

**Constraints:**
- Validation errors return structured error responses with `code: "VALIDATION_ERROR"` (400).
- Schema duplication between backend (`src/lib/schemas.ts`) and frontend (`web-ui/src/lib/schemas.ts`) is intentional due to separate build pipelines.

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test (fuzz.yml property-based tests + pentest.yml injection job)

**Status:** Implemented

---

## REQ-SEC-010: Path traversal prevention on storage endpoints

**Intent:** Storage API endpoints must prevent directory traversal attacks that could access files outside the user's bucket scope.

**Acceptance Criteria:**
1. `validateKey()` in `storage/validation.ts` decodes URI-encoded sequences via `decodeURIComponent` before the `..` traversal check.
2. Double-encoded attacks (`%252E%252E`) and standard encoded attacks (`%2E%2E`) are both caught.
3. Malformed URI encoding throws `ValidationError`.
4. The function returns the decoded key so callers use the correct value for R2 operations.
5. Browse endpoint validates the prefix parameter against `..` rejection.
6. Automated pentest (`pentest.yml` injection job) tests path traversal payloads (`%2e%2e`, double-encoded, backslash, unicode) and confirms they are blocked.

**Constraints:**
- `PROTECTED_PATHS` is currently empty (all R2 paths accessible via the web storage API). The `validateKey()` function still checks the array but it is a no-op.

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test (pentest.yml injection job)

**Status:** Implemented

---

## REQ-SEC-011: Container image scanned for CVEs before deploy

**Intent:** Every container image must be scanned for known vulnerabilities before being deployed to production.

**Acceptance Criteria:**
1. Trivy scans Docker images for HIGH and CRITICAL severity vulnerabilities in the `deploy.yml` workflow.
2. Known exceptions are listed in `.trivyignore`.
3. The deploy pipeline fails if Trivy finds unexcepted HIGH/CRITICAL vulnerabilities.
4. Scanning occurs after Docker image build and before push to Cloudflare registry.

**Constraints:**
- Trivy scanning is part of the CI/CD pipeline, not a runtime check.
- Exceptions in `.trivyignore` must be reviewed periodically.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-OPS-001
**Verification:** Automated test (deploy.yml Trivy scan step)

**Status:** Implemented

---

## REQ-SEC-012: Container auth token per DO lifecycle

**Intent:** Each Durable Object lifecycle generates a unique auth token for container communication, preventing unauthorized access to container endpoints.

**Acceptance Criteria:**
1. A random UUID is generated per DO lifecycle and passed to the container as `CONTAINER_AUTH_TOKEN` environment variable.
2. All proxied HTTP requests from the DO to the container include the token in the `Authorization: Bearer` header.
3. The terminal server validates this token on all non-exempt paths.
4. Auth-exempt paths (`/health`, `/activity`) are whitelisted at the terminal server because `collectMetrics()` calls them directly via `ctx.container.getTcpPort(TERMINAL_SERVER_PORT).fetch(...)`. That path enters the container over the SDK's private TCP plumbing and never runs through the DO's public `fetch()` override, so the `Authorization: Bearer` header injection does not happen. Whitelisting these two internal-health paths is safe because they expose no user data and no mutable container state.

**Constraints:**
- The token is unique per DO lifecycle, not per session or per request.
- Token is never exposed to the client.

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Integration test (E2E verifies container rejects requests without valid token)

**Status:** Implemented

---

## REQ-SEC-013: Content-Disposition hardening on downloads

**Intent:** File download responses must prevent header injection attacks via sanitized filenames.

**Acceptance Criteria:**
1. File download responses use `Content-Disposition: attachment` with sanitized filenames.
2. Special characters are stripped from filenames.
3. Filenames are truncated to prevent header injection.

**Constraints:**
- Applies to all file download endpoints in storage routes.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SEC-009
**Verification:** Automated test (pentest.yml injection job)

**Status:** Implemented

---

## REQ-SEC-014: SaaS service-token header not trusted in SaaS mode

**Intent:** The `cf-access-client-id` header must not be trusted as an authentication mechanism in SaaS mode where no CF Access edge validates it.

**Acceptance Criteria:**
1. `cf-access-client-id` header in `getUserFromRequest` is only trusted when `!isSaasModeActive()`.
2. In SaaS mode, the header is attacker-controlled (no CF Access edge to validate it) and must be ignored.

**Constraints:**
- This guard applies only to the CF Access client ID header, not to the `X-Service-Auth` header which has its own validation.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-AUTH-001
**Verification:** Automated test (pentest.yml auth-gate job)

**Status:** Implemented

---

## REQ-SEC-015: Blocked user cannot self-upgrade subscription

**Intent:** Users with a blocked subscription tier must not be able to bypass the block by accessing subscription endpoints.

**Acceptance Criteria:**
1. `POST /api/auth/subscribe` checks `getEffectiveTier` at handler entry and throws `ForbiddenError` for blocked users.
2. `resolveSessionMode` result is clamped against the billing-resolved effective tier at both container start and preferences save.
3. A canceled user with stale `sessionMode: 'advanced'` preference receives `'default'` because the free tier only allows `['default']`.
4. Both container start (`lifecycle.ts`) and preferences save (`preferences.ts`) use `getEffectiveTier` (not raw JWT `subscriptionTier`).

**Constraints:**
- Tier enforcement is in the Worker, not in the container.
- Effective tier resolution accounts for both subscription status and billing state.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SUB-012
**Verification:** Integration test (E2E verifies blocked user receives 403 on subscribe)

**Status:** Implemented

---

## REQ-SEC-016: Concurrent cache deduplication for auth config

**Intent:** Multiple concurrent cold-start requests must not issue redundant KV reads for authentication configuration.

**Acceptance Criteria:**
1. Auth config fetch in `access.ts` is wrapped in a `pendingAuthConfigFetch` Promise sentinel.
2. Two concurrent cold-start requests reuse the in-flight fetch instead of issuing redundant KV reads.
3. The sentinel is cleared on TTL expiry and `resetAuthConfigCache()`.
4. The pattern mirrors `pendingJWKSFetch` in `jwt.ts`.

**Constraints:**
- Deduplication is per-isolate, not cross-isolate.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-AUTH-010
**Verification:** Automated test (unit test for concurrent fetch deduplication)

**Status:** Implemented

---

## REQ-SEC-017: R2 bucket nuke workflow for encryption migration

**Intent:** When enabling R2 SSE-C encryption, existing unencrypted files must be purged because they become unreadable with SSE-C enabled.

**Acceptance Criteria:**
1. Manual `workflow_dispatch` GitHub Action deletes all objects in all R2 buckets for an environment.
2. Requires explicit confirmation.
3. Must be run BEFORE enabling `ENCRYPTION_KEY` for SSE-C.
4. Documented as a one-time migration step.

**Constraints:**
- None

**Applies To:** Admin
**Priority:** P1
**Dependencies:** REQ-SEC-005
**Verification:** Manual check

**Status:** Implemented
