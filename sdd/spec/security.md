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

### REQ-SEC-001: Authenticated endpoints reject unauthenticated requests

<!-- @impl: src/lib/access.ts::getUserFromRequest -->
<!-- @impl: src/lib/access.ts::authenticateRequest -->
<!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe) -->
<!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest describe) -->
<!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe) -->

**Intent:** All protected surfaces (`/app`, `/api`, `/setup` post-first-configure) must deny access to unauthenticated users with an appropriate HTTP response.

**Applies To:** User

**Acceptance Criteria:**

1. Unauthenticated requests to `/app/*`, `/api/*`, and `/setup/*` (after setup is complete) receive 401, 302, or 403 responses.
2. In CF Access mode, requests without a valid `CF_Authorization` cookie or `cf-access-jwt-assertion` header are rejected.
3. In SaaS (GitHub OIDC) mode, requests without a valid `codeflare_session` cookie are rejected.
4. Injecting `cf-access-authenticated-user-email` headers does NOT bypass authentication after setup is complete.
5. The `authConfigFetched` sentinel prevents KV transient errors from permanently degrading to the pre-setup header-trust model.
6. The pentest workflow's auth-gate job verifies seven API endpoints require authentication.
7. `GET /api/setup/status` is always public (returns only configuration status, no secrets).

**Constraints:**

- Pre-setup endpoints (`/api/setup/configure` before first completion) are intentionally public to solve the bootstrap problem (AD10).
- Service token auth (`X-Service-Auth` header) is checked first in all modes for E2E testing.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](authentication.md#req-auth-001-two-authentication-modes), [REQ-AUTH-010](authentication.md#req-auth-010-auth-bypass-prevention)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-002: API tokens never enter containers

<!-- @impl: src/container/container-env.ts -->
<!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token -->
<!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → info-disclosure job) -->
<!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin describe) -->

**Intent:** The master Cloudflare API token must never be exposed inside container environments. Containers receive only scoped, per-user credentials.

**Applies To:** User

**Acceptance Criteria:**

1. `CLOUDFLARE_API_TOKEN` stays in the Worker/DO environment (GitHub Secrets -> Worker secrets).
2. Containers receive only per-user scoped R2 credentials (access key pair), never the master API token.
3. The container environment variables do not include `CLOUDFLARE_API_TOKEN`.
4. R2 credentials passed to containers are scoped to the user's bucket (Object Read + Write only).

**Constraints:**

- The Worker/DO acts as a security boundary between the API token and container-executed user code.

**Priority:** P0

**Dependencies:** [REQ-SEC-003](#req-sec-003-per-user-r2-tokens-scoped-to-user-bucket)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-003: Per-user R2 tokens scoped to user bucket

<!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token -->
<!-- @impl: src/lib/r2-admin.ts::createScopedR2Token -->
<!-- @impl: src/lib/r2-admin.ts::deleteScopedR2Token -->

**Intent:** Each user's container receives an R2 API token restricted to that user's storage bucket, preventing cross-user data access.

**Applies To:** User

**Acceptance Criteria:**

1. `getOrCreateScopedR2Token()` creates a per-user token via `POST /accounts/{accountId}/tokens` with a bucket-specific Object Read + Write policy.
2. Token ID serves as the S3 Access Key ID; SHA-256 of the token value serves as the S3 Secret Access Key.
3. Tokens are cached in KV as `r2token:{email}` (encrypted when `ENCRYPTION_KEY` is set).
4. Cached tokens are validated before use via `verifyTokenExists()` (GET request through circuit breaker). Only a definitive 404 invalidates the cache.
5. Transient errors (429, 500, 502, network errors, circuit breaker open) assume the token is still valid to prevent unnecessary rclone 401 errors.
6. Tokens are revoked on user deletion via `deleteScopedR2Token()`.
7. Token creation requires the `API Tokens: Edit` permission on the deploy token.

**Constraints:**

- Token verification runs on every `getOrCreateScopedR2Token()` cache hit, not just on creation.
- Verification failures due to transient errors do not delete the cached token.

**Priority:** P0

**Dependencies:** [REQ-SEC-004](#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/security/kv-crypto-security.test.ts (REQ-SEC-004 describe -> AAD key-name binding (ciphertext non-portable) + non-secret entries stay plaintext + warnIfNoEncryptionKey CRITICAL log -> AC4,7,8) -->
### REQ-SEC-004: Credential encryption-at-rest cryptographic contract

<!-- @impl: src/lib/kv-crypto.ts::importEncryptionKey -->
<!-- @impl: src/lib/kv-crypto.ts::encryptForKV -->
<!-- @impl: src/lib/kv-crypto.ts::decryptFromKV -->
<!-- @test: src/__tests__/lib/kv-crypto.test.ts (importEncryptionKey describe → AC1/AC2) -->
<!-- @test: src/__tests__/lib/kv-crypto.test.ts (encryptForKV / decryptFromKV describe → AC3/AC4) -->
<!-- @test: src/__tests__/lib/kv-crypto.test.ts (getOrImportKey describe → AC5) -->

**Intent:** When an operator provides an encryption key, the cryptographic contract for encryption-at-rest (key import shape, algorithm, ciphertext format, AAD binding, isolate caching) is fixed and pentest-verifiable.

**Applies To:** User

**Acceptance Criteria:**

1. `ENCRYPTION_KEY` is a base64-encoded 256-bit key (exactly 32 bytes decoded). Non-base64 or wrong-length values are rejected at import.
2. KV values for `llm-keys:{bucket}`, `deploy-keys:{bucket}`, and `r2token:{email}` are encrypted with AES-256-GCM via Web Crypto API.
3. Ciphertext format is `v1:` + base64(12-byte random IV + ciphertext + 16-byte auth tag).
4. The KV key name is bound as AAD (Additional Authenticated Data), preventing ciphertext from being copied between KV keys.
5. The CryptoKey is imported once per Worker isolate lifetime and cached.

**Constraints:**

- Key is generated via `openssl rand -base64 32` and stored as a GitHub Actions secret.
- Key pipeline: GitHub Secret -> `wrangler secret put` -> Worker env -> CryptoKey import.
- The operational masking + missing-key warning + non-secret allowlist live in [REQ-SEC-018](#req-sec-018-credential-encryption-operational-policy).

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-018: Credential encryption operational policy

<!-- @impl: src/lib/kv-crypto.ts::warnIfNoEncryptionKey -->
<!-- @test: src/__tests__/lib/request-helpers.test.ts (maskSecret describe → AC1) -->
<!-- @test: src/__tests__/lib/warn-if-no-encryption-key.test.ts (warnIfNoEncryptionKey describe → AC2) -->
<!-- @test: src/__tests__/lib/warn-if-no-encryption-key.test.ts (plaintext KV allowlist describe → AC3) -->

**Intent:** The encryption-at-rest contract needs operational hardening at the API and observability layers: responses always mask secrets, missing-key configuration is loud enough to catch in production logs, and the plaintext-allowlist is explicit so future KV keys are categorised on purpose, not by accident.

**Applies To:** User

**Acceptance Criteria:**

1. API responses always return masked values (`****` + last 4 chars), never plaintext keys.
2. When `ENCRYPTION_KEY` is absent, `warnIfNoEncryptionKey()` emits a CRITICAL structured log on the first request.
3. Non-secret KV entries (`user-prefs:*`, `session:*`, `user:*`, `setup:*`, `storage-stats:*`) remain plaintext.

**Constraints:**

- The plaintext allowlist is explicit. New KV namespaces are encrypted by default; adding to the plaintext allowlist requires a security-review sign-off.

**Priority:** P0

**Dependencies:** [REQ-SEC-004](#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-005: R2 files encrypted via SSE-C when ENCRYPTION_KEY configured

<!-- @impl: src/lib/r2-sse.ts -->
<!-- @impl: src/lib/r2-client.ts -->
<!-- @impl: entrypoint.sh::create_rclone_config -->

**Intent:** When an operator provides an encryption key, all R2 object storage operations must use server-side encryption with customer-provided keys (SSE-C).

**Applies To:** User

**Acceptance Criteria:**

1. All R2 PutObject, GetObject, HeadObject, and InitiateMultipartUpload operations include SSE-C headers when `ENCRYPTION_KEY` is set.
2. SSE-C headers include `x-amz-server-side-encryption-customer-algorithm: AES256`, the base64 key, and the base64 MD5 of raw key bytes.
3. `ENCRYPTION_KEY` is passed from Worker to Durable Object to container as an environment variable.
4. In containers, the entrypoint appends `sse_customer_key_base64` and `sse_customer_algorithm = AES256` to `rclone.conf`.
5. All rclone bisync operations (initial restore, periodic sync, shutdown sync) transparently encrypt/decrypt.
6. Files are visible in the R2 dashboard (names, sizes, metadata) but contents are unreadable without the key.
7. When `ENCRYPTION_KEY` is not set, R2 operations proceed without SSE-C headers (no code path changes).

**Constraints:**

- Enabling SSE-C on an existing deployment requires re-uploading all existing unencrypted R2 objects with SSE-C headers.
- New deployments that set `ENCRYPTION_KEY` from the start require no migration.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/security/kv-crypto-security.test.ts (REQ-SEC-006 write-back failure describe -> returns correct data when migration write-back put() rejects + does not propagate as thrown error -> AC5) -->
### REQ-SEC-006: Transparent KV encryption migration

<!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt -->
<!-- @impl: src/lib/kv-crypto.ts::encryptAndStore -->
<!-- @test: src/__tests__/lib/kv-crypto.test.ts (getAndDecrypt describe → AC1/AC2/AC3/AC5) -->
<!-- @test: src/__tests__/lib/kv-crypto.test.ts (encryptAndStore describe → AC7) -->

**Intent:** Enabling encryption on an existing deployment with plaintext KV data must be seamless, with no downtime and no data loss.

**Applies To:** User

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

**Priority:** P0

**Dependencies:** [REQ-SEC-004](#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/security/rate-limit-security.test.ts (REQ-SEC-007 describe -> 429 with RATE_LIMIT_ERROR code in body + fail-closed=true+KV throws=429 + fail-open=false (default)+KV throws=200 -> AC3,7,8) -->
### REQ-SEC-007: Rate-limiting infrastructure

<!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit -->
<!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter describe → AC1/AC3/AC4) -->
<!-- @test: src/__tests__/middleware/rate-limit-fallback.test.ts (rate-limit fallback describe → AC2) -->

**Intent:** The general rate-limit infrastructure (factory, key derivation, KV-with-in-memory-fallback storage, 429 response shape, advisory headers) underpins every per-endpoint policy in the system.

**Applies To:** User

**Acceptance Criteria:**

1. Rate limiting is implemented via `createRateLimiter()` factory, keyed by `bucketName` (user identifier) with `CF-Connecting-IP` fallback for unauthenticated requests.
2. Primary storage is Cloudflare KV with automatic TTL expiry (window + 60s buffer). Fallback is an in-memory `Map` with periodic cleanup every 100 requests.
3. Exceeded limits return HTTP 429 with `{ code: "RATE_LIMIT_ERROR", message: "Rate limit exceeded. Try again in N seconds." }`.
4. All rate-limited responses include `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers.

**Constraints:**

- KV key prefixes must not collide with application cache keys (use `rl-` prefix where collision exists).
- Per-endpoint policy + fail-closed/fail-open semantics + stress-test bypass live in [REQ-SEC-019](#req-sec-019-per-endpoint-rate-limit-policy); WS-upgrade pre-rate-limit short-circuits live in [REQ-SEC-020](#req-sec-020-ws-upgrade-rate-limit-short-circuits).

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-019: Per-endpoint rate-limit policy

<!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit -->
<!-- @test: src/__tests__/lib/cross-package-constants.test.ts (Cross-Package Constants describe → AC1 WS 30/60s budget) -->
<!-- @test: src/__tests__/routes/container-lifecycle.test.ts (Session limits describe → AC2 MAX_SESSIONS) -->
<!-- @test: src/__tests__/middleware/rate-limit-fallback.test.ts (checkRateLimit failClosed semantics describe → AC3 fail-closed) -->
<!-- @test: src/__tests__/middleware/rate-limit-fallback.test.ts (rate-limit fallback describe → AC4 fail-open) -->
<!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter describe → AC5 STRESS_TEST_MODE bypass) -->

**Intent:** Specific endpoint families have specific limits (WebSocket, session caps), and security-critical endpoints fail closed while resource-protection endpoints fail open. Stress-test mode bypasses everything with a warning so load testing can saturate without changing code.

**Applies To:** User

**Acceptance Criteria:**

1. WebSocket connections are rate-limited at 30 per 60-second window per user.
2. Per-user concurrent session caps are enforced: `MAX_SESSIONS_USER` (default 3), `MAX_SESSIONS_ADMIN` (default 10).
3. Security-critical endpoints (`request-access`, Turnstile verification) use fail-closed rate limiting (KV failure returns 503 instead of allowing the request).
4. General resource-protection endpoints use fail-open rate limiting (per AD6).
5. When `STRESS_TEST_MODE=active`, all rate limits are bypassed with a one-time warning per isolate.

**Constraints:**

- `STRESS_TEST_MODE` must not be active alongside `SAAS_MODE` (global middleware returns 503).

**Priority:** P0

**Dependencies:** [REQ-SEC-007](#req-sec-007-rate-limiting-infrastructure)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-020: WS-upgrade rate-limit short-circuits

<!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit -->
<!-- @test: src/__tests__/routes/terminal-ws.test.ts (CF-015 Stopped session returns 4503 describe → AC1) -->
<!-- @test: src/__tests__/routes/terminal-ws.test.ts (container-warming-up gate describe → AC2) -->

**Intent:** WebSocket reconnect storms during container hibernation or warm-up must not exhaust the user's 30/60s WS budget. Two pre-rate-limit gates short-circuit the upgrade with explicit close codes so the client can back off without losing its budget.

**Applies To:** User

**Acceptance Criteria:**

1. WebSocket upgrade requests for sessions with KV status `stopped` are rejected via close code 4503 BEFORE the WS rate-limit check runs, so a reconnect storm against a hibernated container does not consume the user's 30/60s budget.
2. WebSocket upgrade requests are rejected via close code 1013 (reason `container-warming-up`) BEFORE the WS rate-limit check when the worker observes `terminalServiceReady=false` in the container `/health` probe response, so a reconnect storm during container warm-up does not consume the user's 30/60s budget. The `/health` probe is best-effort: any probe error or missing field falls through to the normal rate-limit + forward path.

**Constraints:**

- The order is load-bearing: the short-circuits run BEFORE the rate limiter so the user budget is preserved across hibernation/warm-up.

**Priority:** P0

**Dependencies:** [REQ-SEC-007](#req-sec-007-rate-limiting-infrastructure), [REQ-SEC-019](#req-sec-019-per-endpoint-rate-limit-policy)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 describe -> real worker.fetch against /health asserts Strict-Transport-Security + Content-Security-Policy + X-Content-Type-Options nosniff + X-Frame-Options DENY + Referrer-Policy + Permissions-Policy + X-Powered-By absent + HSTS on redirects -> AC1..AC7) -->
### REQ-SEC-008: Security headers on every response

<!-- @impl: src/index.ts -->
<!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → security-headers job verifies all headers) -->

**Intent:** Every HTTP response must include standard security headers to prevent common web attacks (clickjacking, MIME sniffing, mixed content, leaked referrer, fingerprintable server software).

**Applies To:** User

**Acceptance Criteria:**

1. `Strict-Transport-Security` (HSTS) is present on all responses, including redirects and OPTIONS preflight responses.
2. `Content-Security-Policy` is set.
3. `X-Content-Type-Options: nosniff` is set.
4. `X-Frame-Options: DENY` is set.
5. `Referrer-Policy: strict-origin-when-cross-origin` is set.
6. `Permissions-Policy` is set.
7. `X-Powered-By` header is absent.

**Constraints:**

- Headers are applied in `src/index.ts` global middleware.
- Preflight (OPTIONS) responses receive HSTS directly in the CORS middleware.
- Coverage of non-standard response paths (redirect responses, helper-emitted responses) lives in [REQ-SEC-021](#req-sec-021-hsts-coverage-on-redirect-response-paths).

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-021: HSTS coverage on redirect response paths

<!-- @impl: src/index.ts::redirectWithHeaders -->
<!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → security-headers job exercises redirect paths) -->
<!-- @test: src/__tests__/redirect-with-headers.test.ts (helper round-trip) -->

**Intent:** The HSTS header coverage in REQ-SEC-008 AC1 must extend to every redirect emission path. Without a dedicated helper, redirects emitted from `Response.redirect()` or middleware shortcuts would drop the security header set the global middleware applies.

**Applies To:** User

**Acceptance Criteria:**

1. HSTS is applied on redirect responses via `redirectWithHeaders()` helper, including root redirect and setup redirect.

**Constraints:**

- Every code path that issues a redirect MUST route through `redirectWithHeaders()`; bare `Response.redirect()` is an anti-pattern (caught by spec-reviewer when found in source).

**Priority:** P0

**Dependencies:** [REQ-SEC-008](#req-sec-008-security-headers-on-every-response)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-009: Input validation at system boundaries

<!-- @impl: src/lib/schemas.ts -->
<!-- @impl: src/lib/constants.ts::SESSION_ID_PATTERN -->
<!-- @impl: src/lib/access.ts::getBucketName -->
<!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → injection job) -->
<!-- @test: host/__tests__/workflow-files.test.js (fuzz workflow describe → property-based input validation) -->

**Intent:** All external input (user requests, API parameters, file paths) must be validated before processing to prevent injection, traversal, and corruption.

**Applies To:** User

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

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-010 describe -> validateKey decodes URI before traversal check + %2E%2E rejected + lone % throws ValidationError + decoded key returned -> AC1..AC4) -->
### REQ-SEC-010: Path traversal prevention on storage endpoints

<!-- @impl: src/routes/storage/validation.ts::validateKey -->
<!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → injection job, path-traversal payloads → AC6) -->

**Intent:** Storage API endpoints must prevent directory traversal attacks that could access files outside the user's bucket scope.

**Applies To:** User

**Acceptance Criteria:**

1. `validateKey()` decodes URI-encoded sequences via `decodeURIComponent` before the `..` traversal check.
2. Double-encoded attacks (`%252E%252E`) and standard encoded attacks (`%2E%2E`) are both caught.
3. Malformed URI encoding throws `ValidationError`.
4. The function returns the decoded key so callers use the correct value for R2 operations.
5. Browse endpoint validates the prefix parameter against `..` rejection.
6. The pentest workflow's injection job tests path traversal payloads (`%2e%2e`, double-encoded, backslash, unicode) and confirms they are blocked.

**Constraints:**

- `PROTECTED_PATHS` is currently empty (all R2 paths accessible via the web storage API). The `validateKey()` function still checks the array but it is a no-op.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-011: Container image scanned for CVEs before deploy

<!-- @impl: .github/workflows/deploy.yml -->
<!-- @impl: .trivyignore -->
<!-- @test: host/__tests__/workflow-files.test.js (container image pipeline describe → trivy scan job → AC1/AC2/AC3/AC4) -->

**Intent:** Every container image must be scanned for known vulnerabilities before being deployed to production.

**Applies To:** User

**Acceptance Criteria:**

1. Trivy scans Docker images for HIGH and CRITICAL severity vulnerabilities in the deploy workflow.
2. Known exceptions are listed in `.trivyignore`.
3. The deploy pipeline fails if Trivy finds unexcepted HIGH/CRITICAL vulnerabilities.
4. Scanning occurs after Docker image build and before push to Cloudflare registry.

**Constraints:**

- Trivy scanning is part of the CI/CD pipeline, not a runtime check.
- Exceptions in `.trivyignore` must be reviewed periodically.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-012: Container auth token per DO lifecycle

<!-- @impl: src/container/index.ts -->
<!-- @impl: host/src/server.ts -->

**Intent:** Each Durable Object lifecycle generates a unique auth token for container communication, preventing unauthorized access to container endpoints.

**Applies To:** User

**Acceptance Criteria:**

1. A random UUID is generated per DO lifecycle and passed to the container as `CONTAINER_AUTH_TOKEN` environment variable.
2. All proxied HTTP requests from the DO to the container include the token in the `Authorization: Bearer` header.
3. The terminal server validates this token on all non-exempt paths.
4. Auth-exempt paths (`/health`, `/activity`) are whitelisted at the terminal server because `collectMetrics()` calls them directly via `ctx.container.getTcpPort(TERMINAL_SERVER_PORT).fetch(...)`, which enters the container over the SDK's private TCP plumbing and never runs through the DO's public `fetch()` override, so the `Authorization: Bearer` header injection does not happen; whitelisting these two internal-health paths is safe because they expose no user data and no mutable container state.
5. The token survives DO hibernate/wake cycles for the duration of one DO lifecycle: after the DO is evicted from memory and rehydrated on a later request, the next proxied request still authenticates successfully against the container's running env var, with no user-visible `Unauthorized` response and no need to recreate the session.
6. On DO destruction the persisted token is cleared, so the next session under the same DO ID starts with a fresh token (no cross-lifecycle reuse).

**Constraints:**

- The token is unique per DO lifecycle, persisted across hibernate/wake cycles within that lifecycle.
- Token is never exposed to the client.

**Priority:** P0

**Dependencies:** None.

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-013 describe -> download.ts uses attachment disposition type + CRLF stripping in buildContentDisposition + quotes/backslashes stripped (structural audit; buildContentDisposition not exported) -> AC2,3) -->
### REQ-SEC-013: Content-Disposition hardening on downloads

<!-- @impl: src/routes/storage/download.ts -->
<!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → header-injection job, filename sanitization → AC1/AC2/AC3) -->

**Intent:** File download responses must prevent header injection attacks via sanitized filenames.

**Applies To:** User

**Acceptance Criteria:**

1. File download responses use `Content-Disposition: attachment` with sanitized filenames.
2. Special characters are stripped from filenames.
3. Filenames are truncated to prevent header injection.

**Constraints:**

- Applies to all file download endpoints in storage routes.

**Priority:** P0

**Dependencies:** [REQ-SEC-009](#req-sec-009-input-validation-at-system-boundaries)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/security/access-security.test.ts (REQ-SEC-014 describe -> cf-access-client-id trusted only when !SAAS_MODE + SaaS mode ignores attacker-controlled cf-access-client-id (no email/auth produced) -> AC1,2) -->
### REQ-SEC-014: SaaS service-token header not trusted in SaaS mode

<!-- @impl: src/lib/access.ts::getUserFromRequest -->
<!-- @impl: src/lib/onboarding.ts::isSaasModeActive -->
<!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → cf-access-client-id spoofing in SaaS mode → AC1/AC2) -->

**Intent:** The `cf-access-client-id` header must not be trusted as an authentication mechanism in SaaS mode where no CF Access edge validates it.

**Applies To:** User

**Acceptance Criteria:**

1. `cf-access-client-id` header in `getUserFromRequest` is only trusted when `!isSaasModeActive()`.
2. In SaaS mode, the header is attacker-controlled (no CF Access edge to validate it) and must be ignored.

**Constraints:**

- This guard applies only to the CF Access client ID header, not to the `X-Service-Auth` header which has its own validation.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](authentication.md#req-auth-001-two-authentication-modes)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-015: Blocked user cannot self-upgrade subscription

<!-- @impl: src/routes/auth.ts -->
<!-- @impl: src/lib/subscription.ts::getEffectiveTier -->
<!-- @impl: src/routes/preferences.ts -->

**Intent:** Users with a blocked subscription tier must not be able to bypass the block by accessing subscription endpoints.

**Applies To:** User

**Acceptance Criteria:**

1. `POST /api/auth/subscribe` checks `getEffectiveTier` at handler entry and throws `ForbiddenError` for blocked users.
2. `resolveSessionMode` result is clamped against the billing-resolved effective tier at both container start and preferences save.
3. A canceled user with stale `sessionMode: 'advanced'` preference receives `'default'` because the free tier only allows `['default']`.
4. Both container start and preferences save use `getEffectiveTier` (not raw JWT `subscriptionTier`).

**Constraints:**

- Tier enforcement is in the Worker, not in the container.
- Effective tier resolution accounts for both subscription status and billing state.

**Priority:** P0

**Dependencies:** [REQ-SUB-012](subscription.md#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/security/access-security.test.ts (REQ-SEC-016 describe -> two concurrent getUserFromRequest issue exactly one setup:auth_domain KV read + sequential warm-cache no re-read + resetAuthConfigCache forces re-read -> AC1,2,3) -->
### REQ-SEC-016: Concurrent cache deduplication for auth config

<!-- @impl: src/lib/access.ts::resetAuthConfigCache -->
<!-- @impl: src/lib/jwt.ts -->
<!-- @test: src/__tests__/lib/auth-config-fetch-dedup.test.ts (10 concurrent requests → single KV read round → AC1/AC2/AC3) -->

**Intent:** Multiple concurrent cold-start requests must not issue redundant KV reads for authentication configuration.

**Applies To:** User

**Acceptance Criteria:**

1. The auth-config fetch is wrapped in a `pendingAuthConfigFetch` Promise sentinel.
2. Two concurrent cold-start requests reuse the in-flight fetch instead of issuing redundant KV reads.
3. The sentinel is cleared on TTL expiry and `resetAuthConfigCache()`.
4. The pattern mirrors the `pendingJWKSFetch` sentinel used for JWKS cold-start fetches.

**Constraints:**

- Deduplication is per-isolate, not cross-isolate.

**Priority:** P0

**Dependencies:** [REQ-AUTH-010](authentication.md#req-auth-010-auth-bypass-prevention)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-017: R2 bucket nuke workflow for encryption migration

<!-- @impl: .github/workflows/deploy.yml -->

**Intent:** When enabling R2 SSE-C encryption, existing unencrypted files must be purged because they become unreadable with SSE-C enabled.

**Applies To:** Admin

**Acceptance Criteria:**

1. Manual `workflow_dispatch` GitHub Action deletes all objects in all R2 buckets for an environment.
2. Requires explicit confirmation.
3. Must be run BEFORE enabling `ENCRYPTION_KEY` for SSE-C.
4. Documented as a one-time migration step.

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-SEC-005](#req-sec-005-r2-files-encrypted-via-sse-c-when-encryption_key-configured)

**Verification:** Manual check

**Status:** Implemented
