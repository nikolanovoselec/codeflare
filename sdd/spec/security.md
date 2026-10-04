# Security

Security requirements for authentication enforcement, credential isolation, encryption, rate limiting, input validation, and hardening.

**Domain owner:** Worker middleware layer

### Key Concepts

- **Authentication Gate** -- Middleware that rejects unauthenticated requests to protected surfaces (application pages, API endpoints, and the setup wizard).
- **Rate Limiting** -- Per-user request throttling backed by persistent storage with in-memory fallback. Keyed by authenticated user identity, with client IP as fallback for unauthenticated requests. Fail-closed for security endpoints, fail-open for resource endpoints.
- **Encryption at Rest** -- Authenticated AES-256-GCM encryption of credential values stored in persistent storage. Ciphertext carries a version prefix so future schemes can be added without breaking reads.
- **SSE-C** -- Server-Side Encryption with Customer-Provided Keys. R2 objects are encrypted via the SSE-C scheme. Files are visible in the dashboard but contents are unreadable without the key.
- **Security Headers** -- Standard HTTP response headers (HSTS, CSP, X-Frame-Options, etc.) applied globally to prevent common web attacks.

### Out of Scope

- WAF rules and DDoS protection (handled by Cloudflare's edge network)
- Penetration testing automation (pentest.yml is a lightweight probe suite, not a full pentest tool)
- Certificate management (handled by Cloudflare's edge TLS termination)
- R2 bulk-nuke workflow for SSE-C encryption migration (removed; vault bootstrap-hop handles per-session key setup without bulk wipe)

### Domain Dependencies

- **Authentication** -- Auth enforcement ([REQ-SEC-001](#req-sec-001-authenticated-endpoints-reject-unauthenticated-requests)) depends on auth mode resolution from the Authentication domain
- **Storage** -- R2 encryption ([REQ-SEC-005](#req-sec-005-r2-files-encrypted-at-rest-with-sse-c-when-operator-configures-an-encryption-key)) depends on R2 bucket operations from the Storage domain
- **Subscription** -- Tier-based rate limits and blocked-user enforcement ([REQ-SEC-015](#req-sec-015-blocked-user-cannot-self-upgrade-subscription)) depend on effective tier resolution from the Subscription domain

---

### REQ-SEC-001: Authenticated endpoints reject unauthenticated requests

**Intent:** Protected data and mutation boundaries (`/api` and post-first-configure setup APIs) must deny unauthenticated access. The static SPA shell may remain publicly deliverable; it exposes no protected data and its API calls still authenticate.

**Applies To:** User

**Acceptance Criteria:**

1. Unauthenticated requests to protected API and post-setup configuration endpoints receive 401, 302, or 403 responses. Static application routes may return the public SPA shell, but protected data is unavailable until its API requests authenticate. <!-- @impl: src/lib/access.ts::authenticateRequest --> <!-- @impl: src/index.ts::default --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-001 (two authentication modes) / REQ-AUTH-007 (JIT user provisioning in SaaS) / REQ-AUTH-012 (welcome email on provisioning)) -->
2. In CF Access mode, requests without a valid CF Access session credential are rejected. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-001 (two authentication modes) / REQ-AUTH-007 (JIT user provisioning in SaaS) / REQ-AUTH-012 (welcome email on provisioning)) -->
3. In SaaS mode, requests without a valid SaaS session credential are rejected. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-001 (two authentication modes) / REQ-AUTH-007 (JIT user provisioning in SaaS) / REQ-AUTH-012 (welcome email on provisioning)) -->
4. Injecting the pre-setup header-trust signal does not bypass authentication after setup is complete. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-001 (two authentication modes) / REQ-AUTH-007 (JIT user provisioning in SaaS) / REQ-AUTH-012 (welcome email on provisioning)) -->
5. Transient storage failures during auth-config fetch do not permanently degrade authentication to the pre-setup trust model. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-001 (two authentication modes) / REQ-AUTH-007 (JIT user provisioning in SaaS) / REQ-AUTH-012 (welcome email on provisioning)) -->
6. The setup-status endpoint is always public and returns only configuration status, no secrets. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @manual -->

**Constraints:**

- Pre-setup configuration endpoints required before first-run completion are intentionally public to allow initial configuration without authentication ([AD10](../../documentation/decisions/README.md#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation)).
- A dedicated service-token authentication path is checked first in all modes for E2E testing.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](authentication.md#req-auth-001-two-authentication-modes), [REQ-AUTH-010](authentication.md#req-auth-010-auth-bypass-prevention)

**Verification:** Automated test ([access](../../src/__tests__/lib/access.test.ts))

**Status:** Implemented

---

### REQ-SEC-002: API tokens never enter containers

**Intent:** The master Cloudflare API token must never be exposed inside container environments. Containers receive only scoped, per-user credentials.

**Applies To:** User

**Acceptance Criteria:**

1. The master Cloudflare API token is never exposed inside container environments. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC2 (createBucketIfNotExists is idempotent and race-safe)) -->
2. Containers receive only per-user scoped R2 credentials (access key pair), never the master API token. <!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC2 (createBucketIfNotExists is idempotent and race-safe)) -->
3. R2 credentials passed to containers are scoped to the user's bucket (Object Read + Write only). <!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC2 (createBucketIfNotExists is idempotent and race-safe)) -->

**Constraints:**

- The Worker/DO acts as a security boundary between the API token and container-executed user code.
- Per-user Cloudflare OAuth tokens never enter non-enterprise containers; only a placeholder does, and the Worker injects refreshed credentials at the Cloudflare API boundary ([REQ-AGENT-078](agents.md#req-agent-078-cloudflare-oauth-token-refreshed-at-the-apicloudflarecom-boundary)).
- This boundary mirrors enterprise Browser Rendering credential isolation in [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container).

**Priority:** P0

**Dependencies:** [REQ-SEC-003](#req-sec-003-per-user-r2-tokens-scoped-to-user-bucket)

**Verification:** Automated test ([r2-admin](../../src/__tests__/lib/r2-admin.test.ts))

**Status:** Implemented

---

### REQ-SEC-003: Per-user R2 tokens scoped to user bucket

**Intent:** Each user's container receives an R2 API token restricted to that user's storage bucket, preventing cross-user data access.

**Applies To:** User

**Acceptance Criteria:**

1. The system creates a per-user Cloudflare API token scoped to that user's R2 bucket (Object Read + Write only). <!-- @impl: src/lib/r2-admin.ts::createScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC2 (createBucketIfNotExists is idempotent and race-safe)) -->
2. Token credentials are derived deterministically so the token ID and a hash of the token value form an S3-compatible credential pair. <!-- @impl: src/lib/r2-admin.ts::createScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC2 (createBucketIfNotExists is idempotent and race-safe)) -->
3. Tokens are cached per user (encrypted when operator-provided encryption is configured). <!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (should return cached token from KV r2token:{email} if exists and token is valid) -->
4. Cached tokens are validated before use; only a definitive 404 from the token-existence check invalidates the cache. <!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC2 (createBucketIfNotExists is idempotent and race-safe)) -->
5. Transient verification errors assume the token is still valid to prevent unnecessary downstream auth failures. <!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC2 (createBucketIfNotExists is idempotent and race-safe)) -->
6. Tokens are revoked on user deletion. <!-- @impl: src/lib/r2-admin.ts::deleteScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (should DELETE to CF API /accounts/{id}/tokens/{tokenId} (not /r2/tokens)) -->
7. Token creation requires the upstream API permission to manage tokens on the deploy credential. <!-- @impl: src/lib/r2-admin.ts::createScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin / REQ-SEC-003 (per-user R2 tokens scoped to user bucket) / REQ-SESSION-003 (R2 bucket mounted and synced on start) / REQ-STOR-001 AC2 (createBucketIfNotExists is idempotent and race-safe)) -->

**Constraints:**

- Token verification runs on every cache hit, not just on creation.
- Verification failures due to transient errors do not delete the cached token.

**Priority:** P0

**Dependencies:** [REQ-SEC-004](#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Automated test ([Integration test](../../src/__tests__/lib/r2-admin.test.ts))

**Status:** Implemented

---

### REQ-SEC-004: Credential encryption-at-rest cryptographic contract

**Intent:** When an operator provides an encryption key, the cryptographic contract for encryption-at-rest (key import shape, algorithm, ciphertext format, AAD binding, isolate caching) is fixed and pentest-verifiable.

**Applies To:** User

**Acceptance Criteria:**

1. The operator-provided encryption key must be a base64-encoded 256-bit value (exactly 32 bytes decoded). Non-base64 or wrong-length values are rejected at startup. <!-- @impl: src/lib/kv-crypto.ts::importEncryptionKey --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (kv-crypto / REQ-SEC-004 (credential encryption-at-rest cryptographic contract) / REQ-SEC-006 (transparent KV encryption migration)) -->
2. Credential values (LLM keys, deploy keys, R2 tokens) are encrypted at rest with authenticated encryption. <!-- @impl: src/lib/kv-crypto.ts::encryptForKV --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (kv-crypto / REQ-SEC-004 (credential encryption-at-rest cryptographic contract) / REQ-SEC-006 (transparent KV encryption migration)) -->
3. Ciphertext carries a version prefix and a random IV per write, so re-encrypting the same plaintext produces a different ciphertext. <!-- @impl: src/lib/kv-crypto.ts::encryptForKV --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (encryptForKV / decryptFromKV / REQ-SEC-004 AC3 (v1: prefix ciphertext format) / REQ-SEC-004 AC4 (AAD binding to KV key)) -->
4. The storage key name is bound as additional authenticated data, preventing ciphertext from being copied between storage keys. <!-- @impl: src/lib/kv-crypto.ts::encryptForKV --> <!-- @test: src/__tests__/security/kv-crypto-security.test.ts (REQ-SEC-004 AC4: KV key name bound as AAD) -->
5. The encryption key is imported once per worker instance and reused for the instance's lifetime. <!-- @impl: src/lib/kv-crypto.ts::getOrImportKey --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (kv-crypto / REQ-SEC-004 (credential encryption-at-rest cryptographic contract) / REQ-SEC-006 (transparent KV encryption migration)) -->

**Constraints:**

- Changing the encryption key requires re-encrypting all credential values (see [REQ-SEC-006](#req-sec-006-transparent-kv-encryption-migration)).
- Operational masking, missing-key warning, and non-secret allowlist live in [REQ-SEC-018](#req-sec-018-credential-encryption-operational-policy).

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([kv-crypto-security](../../src/__tests__/security/kv-crypto-security.test.ts))

**Status:** Implemented

---

### REQ-SEC-005: R2 files encrypted at rest with SSE-C when operator configures an encryption key

**Intent:** When an operator provides an encryption key, all R2 object storage operations must use server-side encryption with customer-provided keys (SSE-C).

**Applies To:** User

**Acceptance Criteria:**

1. All R2 object operations (read, write, head, multipart) use SSE-C headers when an operator encryption key is configured. <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @test: src/__tests__/lib/r2-sse.test.ts (r2-sse / REQ-SEC-005 (R2 credentials never logged or exposed)) -->
2. The SSE-C scheme uses AES-256; the request carries the customer-provided key and a key-hash so the storage layer can verify integrity. <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @test: src/__tests__/lib/r2-sse.test.ts (returns 3 SSE-C headers when ENCRYPTION_KEY is set) -->
3. The encryption key is propagated from Worker to Durable Object to container as part of the session environment. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
4. In containers, the sync configuration is extended with SSE-C settings so all R2 traffic carries the customer-provided key. <!-- @impl: entrypoint.sh::create_rclone_config --> <!-- @test: host/__tests__/entrypoint-governed-sync.test.js (REQ-ENTERPRISE-018: rclone.conf under Governed Mode (entrypoint.sh create_rclone_config)) -->
5. All bidirectional sync operations (initial restore, periodic sync, shutdown sync) transparently encrypt and decrypt without user action. <!-- @impl: entrypoint.sh::create_rclone_config --> <!-- @manual: With SSE-C enabled, create and edit a file across two sessions and confirm it restores without an encryption prompt. -->
6. Files are visible in the R2 dashboard (names, sizes, metadata) but contents are unreadable without the key. <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @test: src/__tests__/lib/r2-sse.test.ts (returns 3 SSE-C headers when ENCRYPTION_KEY is set) -->
7. When no operator encryption key is configured, R2 operations proceed without SSE-C (no code path changes). <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->

**Constraints:**

- Enabling SSE-C on an existing deployment requires re-uploading all existing unencrypted R2 objects with SSE-C.
- New deployments that enable encryption from the start require no migration.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated test ([Integration test](../../src/__tests__/lib/r2-sse.test.ts))

**Status:** Implemented

---

### REQ-SEC-006: Transparent KV encryption migration

**Intent:** Enabling encryption on an existing deployment with plaintext KV data must be seamless, with no downtime and no data loss.

**Applies To:** User

**Acceptance Criteria:**

1. Encrypted values (identified by the version prefix) are decrypted transparently on read. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (getAndDecrypt / REQ-SEC-006 AC1 (v1: detection) / REQ-SEC-006 AC2 (plaintext legacy parse) / REQ-SEC-006 AC3 (fire-and-forget re-encrypt) / REQ-SEC-006 AC5 (write-back failure resilience)) -->
2. Legacy plaintext values without a version prefix are parsed directly. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (getAndDecrypt / REQ-SEC-006 AC1 (v1: detection) / REQ-SEC-006 AC2 (plaintext legacy parse) / REQ-SEC-006 AC3 (fire-and-forget re-encrypt) / REQ-SEC-006 AC5 (write-back failure resilience)) -->
3. Plaintext reads trigger a background re-encryption write-back. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (getAndDecrypt / REQ-SEC-006 AC1 (v1: detection) / REQ-SEC-006 AC2 (plaintext legacy parse) / REQ-SEC-006 AC3 (fire-and-forget re-encrypt) / REQ-SEC-006 AC5 (write-back failure resilience)) -->
4. Subsequent reads decrypt the migrated encrypted value without triggering another migration write-back. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (round-trips with getAndDecrypt when encrypted) -->
5. If the re-encryption write-back fails (transient error, rate limit), the caller still receives correct data. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/security/kv-crypto-security.test.ts (REQ-SEC-006 AC5: write-back failure returns correct data to caller) -->
6. Two concurrent requests reading the same plaintext entry can both write encrypted copies safely (the result is equivalent regardless of which write wins). <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (kv-crypto / REQ-SEC-004 (credential encryption-at-rest cryptographic contract) / REQ-SEC-006 (transparent KV encryption migration)) -->
7. Direct credential writes always store encrypted data without going through a migration path. <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (kv-crypto / REQ-SEC-004 (credential encryption-at-rest cryptographic contract) / REQ-SEC-006 (transparent KV encryption migration)) -->

**Constraints:**

- Migration is lazy (on-read), not batch; Complete migration happens gradually as values are accessed.
- No downtime or manual intervention required.

**Priority:** P0

**Dependencies:** [REQ-SEC-004](#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Automated test ([kv-crypto-security](../../src/__tests__/security/kv-crypto-security.test.ts))

**Status:** Implemented

---

### REQ-SEC-007: Rate-limiting infrastructure

**Intent:** The general rate-limit infrastructure (factory, key derivation, KV-with-in-memory-fallback storage, 429 response shape, advisory headers) underpins every per-endpoint policy in the system.

**Applies To:** User

**Acceptance Criteria:**

1. Rate limiting is keyed by authenticated user identity, with client IP as fallback for unauthenticated requests. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter / REQ-SEC-007 AC1 (factory keyed by bucketName with CF-Connecting-IP fallback) / REQ-SEC-007 AC2 (KV primary + in-memory fallback with TTL) / REQ-SEC-007 AC3 (429 with RATE_LIMIT_ERROR) / REQ-SEC-007 AC4 (X-RateLimit headers) / REQ-SEC-019 AC5 (STRESS_TEST_MODE bypass)) -->
2. Primary storage is persistent storage with automatic TTL expiry; the fallback is per-isolate in-memory with periodic cleanup. <!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit --> <!-- @test: src/__tests__/middleware/rate-limit-fallback.test.ts (rate-limit fallback on KV failure / REQ-SEC-007 AC2 (KV primary, in-memory fallback with periodic cleanup) / REQ-SEC-019 AC4 (general resource-protection endpoints fail open)) -->
3. Exceeded limits return HTTP 429 with a stable error code and a human-readable retry-time message. <!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit --> <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @impl: src/lib/error-types.ts::RateLimitError --> <!-- @test: src/__tests__/security/rate-limit-security.test.ts (REQ-SEC-007 AC3: 429 response body contains RATE_LIMIT_ERROR code) -->
4. All rate-limited responses include the standard rate-limit advisory headers. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter / REQ-SEC-007 AC1 (factory keyed by bucketName with CF-Connecting-IP fallback) / REQ-SEC-007 AC2 (KV primary + in-memory fallback with TTL) / REQ-SEC-007 AC3 (429 with RATE_LIMIT_ERROR) / REQ-SEC-007 AC4 (X-RateLimit headers) / REQ-SEC-019 AC5 (STRESS_TEST_MODE bypass)) -->

**Constraints:**

- Per-endpoint policy + fail-closed/fail-open semantics + stress-test bypass live in [REQ-SEC-019](#req-sec-019-per-endpoint-rate-limit-policy); WS-upgrade pre-rate-limit short-circuits live in [REQ-SEC-020](#req-sec-020-ws-upgrade-rate-limit-short-circuits).

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([rate-limit-security](../../src/__tests__/security/rate-limit-security.test.ts))

**Status:** Implemented

---

### REQ-SEC-008: Security headers on every response

**Intent:** Every HTTP response must include standard security headers to prevent common web attacks (clickjacking, MIME sniffing, mixed content, leaked referrer, fingerprintable server software).

**Applies To:** User

**Acceptance Criteria:**

1. `Strict-Transport-Security` (HSTS) is present on all responses, including redirects and OPTIONS preflight responses. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 AC1: Strict-Transport-Security is present on all responses) -->
2. `Content-Security-Policy` is set. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 AC2: Content-Security-Policy is set) -->
3. `X-Content-Type-Options: nosniff` is set. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008: Security headers on every worker response) -->
4. Normal responses use `X-Frame-Options: DENY`; authenticated SilverBullet and Browser IDE proxy responses may use `SAMEORIGIN`. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/early-return-security.test.ts (CF-001: security headers on pre-Hono early-return responses) -->
5. `Referrer-Policy: strict-origin-when-cross-origin` is set. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008: Security headers on every worker response) -->
6. The authenticated SPA permits microphone input only to the same origin while camera and geolocation remain denied; other Worker responses deny microphone access. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @impl: src/index.ts::fetch --> <!-- @test: src/__tests__/index.test.ts (permits the SPA Vault bootstrap frame, Gravatar probe, and same-origin microphone at %s) -->
7. `X-Powered-By` header is absent. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 AC7: X-Powered-By header is absent) -->

**Constraints:**

- Headers are applied globally; every response path inherits them.
- Preflight (OPTIONS) responses receive HSTS directly in the CORS middleware.
- Coverage of non-standard response paths (redirect responses, helper-emitted responses) lives in [REQ-SEC-021](#req-sec-021-hsts-coverage-on-redirect-response-paths).
- Proxied SilverBullet vault content uses `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'` so same-origin prewarm works while cross-site framing stays blocked.
- Vault route-validation errors and `/api/vault/:sid/status` still carry the full default security header set.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([security-headers](../../src/__tests__/security/security-headers.test.ts))

**Status:** Implemented

---

### REQ-SEC-009: Input validation at system boundaries

**Intent:** All external input (user requests, API parameters, file paths) must be validated before processing to prevent injection, traversal, and corruption.

**Applies To:** User

**Acceptance Criteria:**

1. Request bodies are validated before handler logic executes. <!-- @impl: src/lib/request-helpers.ts::parseJsonBody --> <!-- @test: src/__tests__/lib/request-helpers.test.ts (returns the validated typed value when a schema is given and the body is valid) -->
2. Setup wizard inputs (domain, emails, origins) are validated with shape-specific patterns. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @manual -->
3. Session IDs are validated against the canonical format (8-24 lowercase alphanumeric characters) on every entry point. Invalid IDs are rejected with 400 before any session-side interaction. <!-- @impl: src/lib/constants.ts::SESSION_ID_PATTERN --> <!-- @test: src/__tests__/routes/terminal.test.ts (returns 400 errorResponse for invalid session ID format) -->
4. Malformed base64 inputs are rejected with 400 immediately. <!-- @manual -->
5. API routes enforce a 64 KiB body limit (storage routes exempt for file uploads). <!-- @impl: src/index.ts::bodyLimit --> <!-- @manual -->
6. Email addresses are normalized before any lookup, comparison, or derivation operation. <!-- @impl: src/lib/access.ts::getBucketName --> <!-- @test: src/__tests__/lib/access.test.ts (normalizes authenticated email before allowlist lookup) -->

**Constraints:**

- Validation errors return structured error responses with a stable validation error code and HTTP 400.
- Validation rules are enforced independently at each tier (Worker and UI) due to separate build pipelines.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-010: Path traversal prevention on storage endpoints

**Intent:** Storage API endpoints must prevent directory traversal attacks that could access files outside the user's bucket scope.

**Applies To:** User

**Acceptance Criteria:**

1. Storage paths are URI-decoded before the parent-directory traversal check so encoded traversal sequences are caught. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-010 AC1/AC2: URI-decoded traversal attacks are caught) -->
2. A single URI-decode catches single-encoded parent-directory sequences (`..`); a double-encoded sequence (`%252E%252E`) decodes only once to an inert literal segment (`%2E%2E`) that is used verbatim as an R2 object key and never re-decoded, so it cannot traverse. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-010 AC2: double-encoded %252E%252E decodes once to an inert literal, used verbatim and never re-decoded) -->
3. Malformed URI encoding is rejected with a validation error. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-010 AC3: malformed URI encoding throws ValidationError) -->
4. The validator returns the decoded key so callers operate on the value the user sees, not the encoded request form. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-010 AC4: validateKey returns decoded key for callers) -->
5. The browse endpoint validates the prefix parameter against parent-directory traversal. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/routes/storage-browse.test.ts (rejects prefix with path traversal (..) with 400) -->

**Constraints:**

- A protected-paths allowlist is supported but empty by default; all storage paths are accessible via the web storage API.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([storage-security](../../src/__tests__/security/storage-security.test.ts))

**Status:** Implemented

---

### REQ-SEC-011: Container image scanned for CVEs before deploy

**Intent:** Every container image must be scanned for known vulnerabilities before being deployed to production.

**Applies To:** User

**Acceptance Criteria:**

1. Container images are scanned for HIGH and CRITICAL severity vulnerabilities in the reusable container-image workflow invoked by every deploy. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual -->
2. Known vulnerability exceptions are tracked in a project-level allowlist. <!-- @impl: scripts/ci/validate-trivy-result.mjs::validateTrivyResult --> <!-- @test: host/__tests__/trivy-exception-gate.test.js (Trivy bounded exception gate) --> <!-- @manual -->
3. The deploy pipeline fails before push for an unexcepted fixable HIGH/CRITICAL vulnerability; a missing, duplicated, additional, or identity-mismatched bounded exception; or a runtime below the required `libpcre2-8-0`, `libde265-0` or `libevent-core-2.1-7` security floor (`10.42-1+deb12u2`, `1.0.11-1+deb12u3` and `2.1.12-stable-8+deb12u1`, respectively). <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @impl: scripts/ci/validate-trivy-result.mjs::validateTrivyResult --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyCodeServerRuntime --> <!-- @test: host/__tests__/trivy-exception-gate.test.js (Trivy bounded exception gate) --> <!-- @manual -->
4. Scanning occurs after image build and before push to the container registry; a pushed image is therefore always scanned-green at push time. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual -->
5. Vulnerabilities with no available upstream fix are excluded from the deployment gate automatically. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: host/__tests__/trivy-exception-gate.test.js (Trivy bounded exception gate) -->
6. Every unexpected-finding diagnostic includes Trivy's package path and package URL when the scanner supplies them. <!-- @impl: scripts/ci/validate-trivy-result.mjs::validateTrivyResult --> <!-- @test: host/__tests__/trivy-exception-gate.test.js (reports every unexpected and missing finding together) -->
7. A successful gate emits the scanner-provided package path and package URL for every accepted occurrence so reviewed identities can be audited and path-bound without weakening the exception. <!-- @impl: scripts/ci/validate-trivy-result.mjs::main --> <!-- @test: host/__tests__/trivy-exception-gate.test.js (emits scanner identities for every accepted occurrence) -->

**Constraints:**

- Image scanning is part of the deploy pipeline, not a runtime check.
- The vulnerability-exception allowlist is reviewed periodically.
- Retire a tuple when its runtime dependency is patched; absence then passes, while recurrence is an unexpected finding. <!-- @test: host/__tests__/trivy-exception-gate.test.js (accepts a patched image without the retired npm brace finding) --> <!-- @test: host/__tests__/trivy-exception-gate.test.js (rejects recurrence of the retired npm brace vulnerability) -->
- Identical-input deploys reuse the already-pushed (already-scanned) image without rescanning; the input-hash tag carries a weekly salt, so any reused image was scanned green within the past seven days.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated test ([Trivy bounded exception gate](../../host/__tests__/trivy-exception-gate.test.js)); remaining scan behavior verified manually

**Status:** Implemented

---

### REQ-SEC-012: Container auth token per DO lifecycle

**Intent:** Each Durable Object lifecycle generates and retains a unique auth token for container communication, then clears it before the next lifecycle.

**Applies To:** User

**Acceptance Criteria:**

1. A unique auth token is generated per Durable Object lifecycle and injected into the container environment. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
2. The token survives container hibernate/wake cycles within a single Durable Object lifecycle, so a rehydrated session still authenticates successfully without recreating the container. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
3. On Durable Object destruction the persisted token is cleared so the next lifecycle starts with a fresh token. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SEC-012 AC3: destroy() clears persisted containerAuthToken so next session under same DO ID starts fresh) -->

**Constraints:**

- The token is unique per DO lifecycle, persisted across hibernate/wake cycles within that lifecycle.
- Token is never exposed to the client.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([Integration test](../../src/__tests__/container/index.test.ts))

**Status:** Implemented

---

<a id="req-sec-022-terminal-server-bearer-authentication"></a>
### REQ-SEC-022: Container proxy bearer validation

**Intent:** Worker-to-container requests carry a lifecycle token that the terminal server validates before serving non-exempt paths.

**Applies To:** User

**Acceptance Criteria:**

1. All proxied requests from the Worker to the container include the token as a bearer credential. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SEC-022 AC1: proxied non-internal request gets Authorization: Bearer <containerAuthToken> injected before super.fetch) -->
2. The container's terminal server validates the bearer credential on every non-exempt HTTP path. <!-- @impl: host/src/auth-check.ts::checkContainerAuth --> <!-- @test: host/__tests__/server-auth-check.test.js (REQ-SEC-022 AC2: protected paths require a matching Bearer token) -->
3. Only the health and activity paths are auth-exempt; both expose no user data and no mutable state. <!-- @impl: host/src/auth-check.ts::AUTH_EXEMPT_PATHS --> <!-- @test: host/__tests__/server-auth-check.test.js (REQ-SEC-022 AC3: only /health and /activity are auth-exempt) -->
4. The terminal server validates the bearer credential before routing every WebSocket upgrade. <!-- @impl: host/src/upgrade-dispatcher.ts::createUpgradeDispatcher --> <!-- @test: host/__tests__/browser-ide-upgrade.test.js (REQ-SEC-022 AC4: rejects a missing container bearer before opening a code-server socket) -->
5. Raw-port notification drains set the stored lifecycle token as an explicit Bearer header; a missing or wrong header is rejected before the body is parsed, and the drain path never joins the auth-exempt set. <!-- @impl: src/container/container-metrics.ts::drainAgentEvents --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: src/__tests__/container/container-metrics-drain.test.ts (POSTs the exact request with the stored lifecycle Bearer and bounded signal) --> <!-- @test: host/__tests__/request-router.test.js (returns 401 before parsing a headerless drain body) --> <!-- @manual: On a deployed live container, submit a headerless drain and confirm 401 occurs before body parsing, then confirm the DO-issued Bearer reaches the same route. -->

**Notes:** Partial pending a deployed live-container record of headerless and wrong-Bearer `401` responses before body parsing and successful access with that lifecycle's DO-issued Bearer.

**Constraints:**

- The token is unique per DO lifecycle, persisted across hibernate/wake cycles within that lifecycle.
- Token is never exposed to the client.

**Priority:** P0

**Dependencies:** [REQ-SEC-012](#req-sec-012-container-auth-token-per-do-lifecycle)

**Verification:** Automated container and host authentication tests; deployed raw-port rejection and authenticated-drain acceptance.

**Status:** Partial

---

### REQ-SEC-023: Agent notification capability boundaries

**Intent:** Notification routes isolate each user's Push capabilities and expose no private sender or subscription material.

**Applies To:** User

**Acceptance Criteria:**

1. Notification enrollment and removal require authenticated user context. <!-- @impl: src/routes/notifications.ts::app --> <!-- @test: src/__tests__/routes/notifications.test.ts (REQ-TERM-025 AC1-AC6 / REQ-SEC-023 AC1-AC4/AC7: notification routes) -->
2. One user cannot read or change another user's device capabilities. <!-- @impl: src/routes/notifications.ts::app --> <!-- @impl: src/lib/kv-keys.ts::getPushSubKey --> <!-- @test: src/__tests__/routes/notifications.test.ts (REQ-TERM-025 AC1-AC6 / REQ-SEC-023 AC1-AC4/AC7: notification routes) -->
3. Malformed, oversized, insecure, or unsupported subscriptions are rejected before they can be stored or used for delivery. <!-- @impl: src/routes/notifications.ts::parsePushSubscription --> <!-- @test: src/__tests__/routes/notifications.test.ts (rejects unknown providers, insecure endpoints, malformed keys, extra fields, and oversized bodies) -->
4. Application logs, analytics, responses, and route errors never contain Push endpoints or encryption keys. <!-- @impl: src/routes/notifications.ts::app --> <!-- @test: src/__tests__/routes/notifications.test.ts (does not log or return endpoint and key capability material on validation failure) -->
5. User deletion removes all notification enrollments owned by that user. <!-- @impl: src/lib/user-cleanup.ts::deleteUserKvEntries --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (REQ-AUTH-018 AC3: follows paginated push-subscription cursors until complete) -->
6. The VAPID private key exists only as a deployment secret. <!-- @impl: src/types.ts::Env --> <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (sources every VAPID field from Actions secret context so step metadata stays masked) -->
7. The authenticated notification config route returns only the public key when all sender fields exist, and reports unavailable without exposing secret state when any field is absent. <!-- @impl: src/routes/notifications.ts::app --> <!-- @test: src/__tests__/routes/notifications.test.ts (returns only the public VAPID key from authenticated config) --> <!-- @test: src/__tests__/routes/notifications.test.ts (reports config unavailable when the %s is absent) -->

**Notes:** Partial pending deployed subscription-isolation observations on desktop, Android-class, and installed iOS PWA devices.

**Constraints:**

- The container receives no Worker, user, or Push subscription credential.
- Sender secrets and subscription capabilities never enter response or log data.

**Priority:** P0

**Dependencies:** [REQ-SEC-022](#req-sec-022-terminal-server-bearer-authentication), [REQ-AUTH-018](authentication.md#req-auth-018-user-management-admin-panel)

**Verification:** Automated route, cleanup, and deployment tests plus deployed subscription-isolation checks.

**Status:** Partial

---

### REQ-SEC-024: Agent notification delivery trust boundaries

**Intent:** Drained events, sender dependency, payloads, and fan-out remain fixed, bounded, and derived from trusted Codeflare records.

**Applies To:** User

**Acceptance Criteria:**

1. The DO rejects invalid or display-shaped drain fields and enriches valid events only from its session ID and KV Session record. <!-- @impl: src/container/container-metrics.ts::validateAgentEvents --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SEC-024 AC1 / D3: rejects invalid version, kind, age, count, and display-shaped fields) -->
2. Provider-accepted and expired-subscription outcomes are terminal. <!-- @impl: src/lib/push-sender.ts::sendAgentEventPushes --> <!-- @test: src/__tests__/lib/push-sender.test.ts (deletes 404/410 subscriptions and treats that terminal outcome as processed) -->
3. The sender wrapper never logs library errors containing capability material. <!-- @impl: src/lib/push-sender.ts::sendAgentEventPushes --> <!-- @test: src/__tests__/lib/push-sender.test.ts (retains transient failures for re-offer and never deletes their subscription) -->
4. Push payload and click targets use canonical same-origin session paths; invalid versions, absolute targets, and cross-origin targets produce no display or navigation. <!-- @impl: web-ui/public/agent-notifications-sw.js::push --> <!-- @impl: web-ui/public/agent-notifications-sw.js::notificationclick --> <!-- @test: web-ui/src/__tests__/lib/agent-notification-worker.test.ts (REQ-TERM-027 AC1-AC2 / REQ-SEC-024 AC4: agent notification service worker push) --> <!-- @test: web-ui/src/__tests__/lib/agent-notification-worker.test.ts (REQ-TERM-027 AC3: canonical notification click navigation) -->
5. Queue, drain, subscription, payload, and fan-out bounds confine fixed notifications to the originating user. <!-- @impl: host/src/agent-events.ts::AGENT_EVENT_LIMITS --> <!-- @impl: src/lib/push-sender.ts::sendAgentEventPushes --> <!-- @test: host/__tests__/agent-events.test.js (REQ-TERM-028 AC1-AC4 / H4 and queue lifecycle bounds) --> <!-- @test: src/__tests__/lib/push-sender.test.ts (bounds events, subscriptions, and total fan-out) -->
6. Transient or timed-out provider outcomes remain eligible for bounded retry. <!-- @impl: src/lib/push-sender.ts::sendAgentEventPushes --> <!-- @test: src/__tests__/lib/push-sender.test.ts (retains transient failures for re-offer and never deletes their subscription) --> <!-- @test: src/__tests__/lib/push-sender.test.ts (aborts a provider request that never settles and retains the event for re-offer) -->

**Notes:** Partial pending deployed fixed-content, canonical same-origin click, global-suppression, bounded pickup-residue, and no-wake/no-idle-extension observations.

**Constraints:**

- The host queue remains authoritative until ACK; DO pending-ACK state is instance-local.
- Terminal OSC is configuration provenance, not cryptographic provenance.
- Push delivery uses standard WebCrypto and outbound HTTPS fetch only.
- The sender dependency remains exact-pinned to integrity-backed `edgepush@0.1.1`. <!-- @impl: package-lock.json::node_modules/edgepush --> <!-- @test: host/__tests__/dockerfile-dependency-integrity.test.js (REQ-SEC-024 dependency constraint: edgepush is exact-pinned with committed integrity) -->

**Priority:** P0

**Dependencies:** [REQ-SEC-022](#req-sec-022-terminal-server-bearer-authentication), [REQ-SEC-023](#req-sec-023-agent-notification-capability-boundaries)

**Verification:** Automated host, sender, service-worker, and dependency-integrity tests plus deployed physical-device acceptance.

**Status:** Partial

---

### REQ-SEC-013: Content-Disposition hardening on downloads

**Intent:** File download responses must prevent header injection attacks via sanitized filenames.

**Applies To:** User

**Acceptance Criteria:**

1. File download responses use `Content-Disposition: attachment` with sanitized filenames. <!-- @impl: src/routes/storage/download.ts::buildContentDisposition --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-013: Content-Disposition is built safely) -->
2. Special characters are stripped from filenames. <!-- @impl: src/routes/storage/download.ts::buildContentDisposition --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-013: Content-Disposition is built safely) -->
3. Header-injection control characters are stripped from filenames. <!-- @impl: src/routes/storage/download.ts::buildContentDisposition --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-013: Content-Disposition is built safely) -->

**Constraints:**

- Applies to all file download endpoints in storage routes.

**Priority:** P0

**Dependencies:** [REQ-SEC-009](#req-sec-009-input-validation-at-system-boundaries)

**Verification:** Automated test ([storage-security](../../src/__tests__/security/storage-security.test.ts))

**Status:** Implemented

---

### REQ-SEC-014: SaaS service-token header not trusted in SaaS mode

**Intent:** The `cf-access-client-id` header must not be trusted as an authentication mechanism in SaaS mode where no CF Access edge validates it.

**Applies To:** User

**Acceptance Criteria:**

1. The CF Access client-id header is only trusted in non-SaaS deployments where a CF Access edge actually validates it. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/security/access-security.test.ts (REQ-SEC-014 AC1/AC2: cf-access-client-id is NOT trusted in SaaS mode) -->
2. In SaaS mode the header is attacker-controlled and is ignored. <!-- @impl: src/lib/onboarding.ts::isSaasModeActive --> <!-- @test: src/__tests__/security/access-security.test.ts (REQ-SEC-014 AC2: cf-access-client-id is ignored when SAAS_MODE=active (attacker-controlled)) -->

**Constraints:**

- This guard applies only to the CF Access client ID header; service-token validation is governed separately.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](authentication.md#req-auth-001-two-authentication-modes)

**Verification:** Automated test ([access-security](../../src/__tests__/security/access-security.test.ts))

**Status:** Implemented

---

### REQ-SEC-015: Blocked user cannot self-upgrade subscription

**Intent:** Users with a blocked subscription tier must not be able to bypass the block by accessing subscription endpoints.

**Applies To:** User

**Acceptance Criteria:**

1. The subscribe endpoint rejects blocked users at handler entry. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (POST /auth/subscribe) -->
2. Effective session mode is clamped against billing tier before managed-release status, reconciliation, container start, and preference persistence. <!-- @impl: src/lib/session-mode.ts::resolveEffectiveSessionMode --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (reports upgrading when a downgraded SaaS user has advanced managed content applied) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (reconciles and stamps the entitlement-clamped mode for a downgraded SaaS user) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (blocks a downgraded SaaS user whose applied managed release still uses advanced mode) -->
3. A canceled user with a stale advanced-mode preference is downgraded to default mode because their effective tier no longer permits advanced. <!-- @impl: src/lib/session-mode.ts::clampSessionModeToTier --> <!-- @test: src/__tests__/lib/session-mode.test.ts (clampSessionModeToTier / REQ-SEC-015 (AC2 clamp at container start + AC3 canceled-user stale advanced => default)) --> <!-- @test: src/__tests__/routes/storage-seed-managed.test.ts (reconciles and stamps the entitlement-clamped mode for a downgraded SaaS user) -->
4. Both container start and preferences save resolve the effective tier from billing state, not from a stored or token-side tier value. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (POST /auth/subscribe) -->

**Constraints:**

- Tier enforcement is in the Worker, not in the container.
- Effective tier resolution accounts for both subscription status and billing state.

**Priority:** P0

**Dependencies:** [REQ-SUB-012](subscription.md#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated test ([Integration test](../../src/__tests__/routes/auth-subscribe.test.ts))

**Status:** Implemented

---

### REQ-SEC-018: Credential encryption operational policy

**Intent:** The encryption-at-rest contract needs operational hardening at the API and observability layers: responses always mask secrets, missing-key configuration is loud enough to catch in production logs, and the plaintext-allowlist is explicit so future KV keys are categorised on purpose, not by accident.

**Applies To:** User

**Acceptance Criteria:**

1. API responses always return masked values (last 4 characters only); the plaintext value is never returned. <!-- @impl: src/lib/request-helpers.ts::maskSecret --> <!-- @test: src/__tests__/lib/request-helpers.test.ts (maskSecret / REQ-SEC-018 AC1 (API responses always return masked values)) -->
2. When no operator encryption key is configured, a CRITICAL-severity warning is emitted on the first request. <!-- @impl: src/lib/kv-crypto.ts::warnIfNoEncryptionKey --> <!-- @test: src/__tests__/lib/warn-if-no-encryption-key.test.ts (warnIfNoEncryptionKey / REQ-SEC-018 AC2 (CRITICAL log fires once per isolate when ENCRYPTION_KEY absent)) -->
3. Non-secret persistent storage entries (preferences, sessions, user records, setup state, storage stats) remain plaintext. <!-- @test: src/__tests__/lib/warn-if-no-encryption-key.test.ts (plaintext KV allowlist / REQ-SEC-018 AC3 (non-secret KV entries remain plaintext; secrets encrypted by default)) --> <!-- @manual -->

**Constraints:**

- The plaintext allowlist is explicit; New KV namespaces are encrypted by default; adding to the plaintext allowlist requires a security-review sign-off.

**Priority:** P0

**Dependencies:** [REQ-SEC-004](#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Automated test

**Status:** Implemented

---

<a id="req-sec-019-websocket-connection-rate-limiting"></a>
### REQ-SEC-019: Per-endpoint rate-limit policy

**Intent:** Specific endpoint families have specific limits (WebSocket, session caps), and security-critical endpoints fail closed while resource-protection endpoints fail open. Stress-test mode bypasses everything with a warning so load testing can saturate without changing code.

**Applies To:** User

**Acceptance Criteria:**

1. WebSocket connections are rate-limited at 30 per 60-second window per user. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (WebSocket rate limit enforced when STRESS_TEST_MODE is unset) -->
2. Per-user concurrent-session limits are checked best effort: the default role-based values are 3 for standard users and 10 for stored admins, while simultaneous starts may exceed the observed limit because KV admission is not atomic. <!-- @impl: src/lib/constants.ts::getMaxSessions --> <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (Session limits / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN with env overrides) / REQ-SEC-019 AC2 (per-user concurrent session caps)) --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (REQ-SESSION-007 AC6 / REQ-SUB-013 AC5: simultaneous starts can exceed the best-effort limit) -->
3. Security-critical endpoints (request-access, Turnstile verification) use fail-closed rate limiting: on persistent-storage failure the request is denied with a 429 rate-limit error (`RATE_LIMIT_ERROR`) instead of being allowed through. <!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit --> <!-- @test: src/__tests__/middleware/rate-limit-fallback.test.ts (checkRateLimit failClosed semantics / REQ-SEC-019 AC3 (security-critical endpoints fail closed when KV is unavailable instead of fail-open)) -->
4. General resource-protection endpoints use fail-open rate limiting (per [AD6](../../documentation/decisions/README.md#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity)). <!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit --> <!-- @test: src/__tests__/middleware/rate-limit-fallback.test.ts (rate-limit fallback on KV failure / REQ-SEC-007 AC2 (KV primary, in-memory fallback with periodic cleanup) / REQ-SEC-019 AC4 (general resource-protection endpoints fail open)) -->
5. In stress-test deployment mode, HTTP and WebSocket rate limits are bypassed with one shared warning per worker instance. <!-- @impl: src/middleware/rate-limit.ts::warnStressTestBypass --> <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter / REQ-SEC-007 AC1 (factory keyed by bucketName with CF-Connecting-IP fallback) / REQ-SEC-007 AC2 (KV primary + in-memory fallback with TTL) / REQ-SEC-007 AC3 (429 with RATE_LIMIT_ERROR) / REQ-SEC-007 AC4 (X-RateLimit headers) / REQ-SEC-019 AC5 (STRESS_TEST_MODE bypass)) -->

**Constraints:**

- Stress-test mode must not be active in SaaS deployments; the combination returns 503 to all requests.
- The session limit is a resource-protection check, not an atomic security boundary; [REQ-SESSION-007](session-lifecycle.md#req-session-007-running-session-count-limited-per-tier) owns its semantics.

**Priority:** P0

**Dependencies:** [REQ-SEC-007](#req-sec-007-rate-limiting-infrastructure)

**Verification:** Automated test ([cross-package-constants](../../src/__tests__/lib/cross-package-constants.test.ts))

**Status:** Implemented

---

### REQ-SEC-020: WS-upgrade rate-limit short-circuits

**Intent:** WebSocket reconnect storms during container hibernation or warm-up must not exhaust the user's 30/60s WS budget. Owner-scoped D1 lifecycle alone confirms a stop; Container SDK state and current readiness gate retryable transport before rate limiting. The container forward is time-bounded so a hung or unreachable container fails fast instead of leaving the client connecting for tens of seconds.

**Applies To:** User

**Acceptance Criteria:**

1. A verified surviving workload after coordinator reconstruction forwards through no-start despite a transient SDK stopped flag, following authenticated owner-scoped D1 authorization. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (REQ-SESSION-012 AC4: a surviving runtime with stale SDK stopped state forwards health and authenticated terminal without starting) -->
2. Owner-scoped D1 `stopping` or `stopped` produces definitive 4503 before any SDK probe, container forward, or WS rate-limit use, even if the SDK would report healthy. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (REQ-SESSION-012 AC3 / REQ-SEC-020 AC2: D1 %s closes 4503 without probing a healthy SDK container) -->
3. A running or healthy container whose terminal service is not ready returns retryable close code 1013 before rate limiting and forwarding. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (returns 1013 close without burning rate-limit when /health reports terminalServiceReady=false) -->
4. A failed no-start health verification returns retryable 1013 without forwarding the WebSocket or consuming its rate-limit budget. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @impl: src/lib/container-helpers.ts::safeCheckContainerHealth --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (returns retryable 1013 without rate-limit use when the existing runtime is unavailable) --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (REQ-SESSION-012 AC2 / REQ-SEC-020 AC4: D1 %s remains retryable despite transient SDK stop) --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (returns retryable 1013 without forwarding or rate-limit use when /health fails) -->
5. A healthy container's WebSocket forward answers or fails within ten seconds. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @impl: src/lib/constants.ts::CONTAINER_WS_FORWARD_TIMEOUT_MS --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (fast-fails with a 101 close (not an indefinite hang) when the container WS forward never answers) -->
6. Terminal-ID authorization runs only after authentication and persisted session lookup: classic permits IDs `1` through `6`, Herdr permits only `1`, and missing/invalid mode resolves classic. <!-- @impl: src/routes/terminal.ts::isTerminalIdAllowed --> <!-- @test: src/__tests__/routes/terminal-route-validate.test.ts (mode-aware terminal authorization) -->
7. A D1 read failure cannot invent a definitive stopped close. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (D1 read outage does not invent an authoritative stopped close) -->

**Constraints:**

- Authenticate and check owner-scoped D1 before the no-start probe, verify survival before rate limiting, and bound the forward.
- Reading persisted Container SDK state must not start or wake the container; SDK state alone cannot veto verified survival or authorize a definitive stop.

**Priority:** P0

**Dependencies:** [REQ-SEC-007](#req-sec-007-rate-limiting-infrastructure), [REQ-SEC-019](#req-sec-019-per-endpoint-rate-limit-policy)

**Verification:** Automated test ([terminal-ws](../../src/__tests__/routes/terminal-ws.test.ts))

**Status:** Implemented

---

### REQ-SEC-021: HSTS coverage on redirect response paths

**Intent:** The HSTS coverage in [REQ-SEC-008](#req-sec-008-security-headers-on-every-response) AC1 must extend to every direct or middleware redirect path.

**Applies To:** User

**Acceptance Criteria:**

1. All redirect responses carry the full security header set, including HSTS. <!-- @impl: src/index.ts::redirectWithHeaders --> <!-- @test: src/__tests__/redirect-with-headers.test.ts (redirectWithHeaders) -->

**Constraints:**

- All redirect responses must carry the full security header set.

**Priority:** P0

**Dependencies:** [REQ-SEC-008](#req-sec-008-security-headers-on-every-response)

**Verification:** Automated test ([redirect-with-headers](../../src/__tests__/redirect-with-headers.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-009: Enterprise Backend Route Hardening

**Intent:** Hiding a SaaS or admin surface in the frontend is not sufficient; in Enterprise Mode the corresponding routes must fail closed so the disabled capabilities cannot be reached by direct API call, URL manipulation, or a stray external event.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the user-management routes (`GET`/`PUT`/`DELETE`/`PATCH` under `/api/users`) return 403 and perform no mutation; user administration is delegated entirely to Cloudflare Access. <!-- @impl: src/routes/users.ts::app --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC1: /api/users fails closed in enterprise mode) -->
2. In enterprise mode, the billing action routes (`POST /api/billing/checkout`, `/api/billing/portal`, `/api/billing/switch`) return 403 before their route-specific limiters, and `GET /api/billing/status` returns an empty/disabled billing state without contacting Stripe. <!-- @impl: src/routes/billing.ts::default --> <!-- @test: src/__tests__/routes/billing.test.ts (DEEP-22-004: enterprise billing guards precede action limiters) -->
3. In enterprise mode, the self-serve routes `POST /api/auth/subscribe` and `POST /api/auth/request-access` return 403 before their route-specific limiters and send no email. <!-- @impl: src/routes/auth.ts::default --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (DEEP-22-005: SaaS subscribe requests remain rate-limited) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (DEEP-22-005: enterprise subscribe guard remains 403 after the SaaS limiter budget) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (DEEP-22-005: enterprise request-access guard runs before its fail-closed limiter) -->
4. In enterprise mode, the Stripe webhook route acknowledges the event before the SaaS limiter without mutating any user's tier or billing state, so a late or stray Stripe event cannot downgrade an enterprise user. <!-- @impl: src/routes/stripe-webhook.ts::default --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (DEEP-22-006: enterprise webhook acknowledgement precedes limiter) -->
5. When `ENTERPRISE_MODE` is set, the admin tier/subscription configuration routes return 403 (there is a single effective tier, `unlimited`, for all users). <!-- @impl: src/routes/admin/tiers.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC5: admin tier config routes 403 in enterprise mode) -->
6. When `ENTERPRISE_MODE` is set, `PATCH /api/preferences` is **not** fail-closed: the SaaS advanced-mode entitlement gate is bypassed so any user may select Pro, and the effective session mode is forced to Pro regardless of the stored value. <!-- @impl: src/lib/session-mode.ts::clampSessionModeToTier --> <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC6: PATCH /api/preferences is not fail-closed in enterprise mode) --> <!-- @test: src/__tests__/routes/preferences-enterprise.test.ts (AC2 (REQ-ENTERPRISE-001): PATCH response reports advanced under enterprise while persisting the raw preference) -->
7. When `ENTERPRISE_MODE` is unset, every route above behaves byte-identically to current behavior. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC7: flag unset is byte-identical to current behavior) -->

**Constraints:**

- All guards consult the single `isEnterpriseMode(env)` resolver ([REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC4); no route reads the raw binding.
- Action endpoints fail closed with 403; the read-only billing-status endpoint returns an empty state (200) so non-enterprise clients that still poll it do not error.
- These guards are defense-in-depth behind the frontend suppression in [REQ-ENTERPRISE-008](setup.md#req-enterprise-008-enterprise-frontend-surface-suppression); neither layer alone is sufficient.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-002](subscription.md#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded), [REQ-ENTERPRISE-008](setup.md#req-enterprise-008-enterprise-frontend-surface-suppression)

**Verification:** Automated test ([enterprise-route-hardening](../../src/__tests__/routes/enterprise-route-hardening.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-016: Strict Gateway Egress

**Intent:** An enterprise admin can force the container's **direct-internet** HTTP/HTTPS egress through the customer's Cloudflare (Zero Trust) Gateway — over the Workers VPC `EGRESS` binding — with one setup-wizard toggle, so every agent call to the outside world is subject to the account's existing egress policies. Only THIS deployment's own Cloudflare account destinations (its R2 + account-scoped CF API / Browser Rendering) are exempt and egress direct — they are codeflare's own control-plane backends, not the agent's external reach; any OTHER account's host rides the Gateway, closing the cross-account exfiltration channel ([AD86](../../documentation/decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)). A deployment with the toggle OFF (the default) is byte-identical to today.

**Applies To:** System

**Acceptance Criteria:**

1. Enterprise setup presents a default-off strict-egress toggle, persists explicit active or inactive values, and never writes it outside enterprise mode. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @impl: src/routes/setup/index.ts::strictGatewayEgress --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (Strict gateway egress toggle (REQ-ENTERPRISE-016)) --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (strict gateway egress (REQ-ENTERPRISE-016)) --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-016: persists the toggle as active when true (EGRESS bound)) --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-016: persists the toggle as inactive when false) --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-016: never writes the toggle in non-enterprise mode (regression)) -->
2. Enabling strict egress is rejected before any write when `EGRESS` is unbound. <!-- @impl: src/routes/setup/index.ts::strictGatewayEgress --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-016: refuses to enable the toggle when EGRESS is unbound (no brick)) -->
3. `GET /api/setup/prefill` round-trips the toggle: a seeded strict-egress setting prefills `true`, an absent key prefills `false`, and it is omitted from a non-enterprise prefill. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-ENTERPRISE-016: strict gateway egress prefill) -->
4. The toggle is resolved by a single gate-then-read helper = enterprise mode AND KV `SETUP_KEYS.STRICT_EGRESS === 'active'`, defaulting OFF when the key is absent or when the KV read throws, and never reading KV in a non-enterprise deploy. <!-- @impl: src/lib/controller-egress.ts::hasStrictGatewayEgress --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016: hasStrictGatewayEgress) -->
5. Strict egress registers a pre-start catch-all below per-host interceptors; disabled and non-enterprise modes register no catch-all. <!-- @impl: src/container/container-interception.ts::strictEgress --> <!-- @impl: src/container/container-interception.ts::wireContainerInterception --> <!-- @test: src/__tests__/container/enterprise-llm.test.ts (enterprise LLM interception wiring (REQ-ENTERPRISE-011)) -->
6. Disabled or non-enterprise mode leaves GitHub transport, container egress, and configuration behavior unchanged and performs no strict-egress KV access. <!-- @impl: src/lib/controller-egress.ts::hasStrictGatewayEgress --> <!-- @impl: src/container/container-interception.ts::wireContainerInterception --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
7. When strict egress is ON, the container is started with direct internet disabled, so the Containers platform allows only ports 80/443 + Cloudflare DNS and DENIES all raw TCP/UDP egress at the platform boundary the container cannot manipulate. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Constraints:**

- The global admin toggle is stored explicitly as `active` or `inactive`, read directly from KV, and never threaded through session configuration.
- Per-host LLM/GitHub interceptors take precedence over the transparent catch-all `EgressController`; denied hosts and allowed-host policy retain the SDK's established precedence.
- Existing Cloudflare Gateway traffic policies remain authoritative; Codeflare does not create or modify them.
- Only this deployment's account-scoped R2 and Cloudflare API or Browser Rendering destinations egress directly; absent account identity and every other account ride the Gateway ([AD86](../../documentation/decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)).
- The LLM interceptor always egresses directly; GitHub and other external destinations use `EGRESS`.
- The enterprise-only Workers VPC `EGRESS` binding is injected only for active enterprise deploys; default, fork, and test deployments remain unaffected, and unavailable egress fails closed.
- `EGRESS` carries HTTP, HTTPS, and WebSocket traffic; upgrades use the fresh-socket bridge specified by [REQ-ENTERPRISE-023](#req-enterprise-023-strict-gateway-egress-controller-transport).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-004](models-and-routing.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](setup.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var), [REQ-ENTERPRISE-012](setup.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)

**Verification:** Automated test ([setup persistence](../../src/__tests__/routes/setup.test.ts), [prefill](../../src/__tests__/routes/setup/handlers.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts), [container catch-all wiring + enableInternet](../../src/__tests__/container/index.test.ts), and [strict-gate resolver tests](../../src/__tests__/lib/controller-egress.test.ts). The `[[vpc_networks]]` `EGRESS` binding is deploy-time config (a Constraint: enterprise-only, committed commented-out and injected by `deploy.yml` when `ENTERPRISE_MODE=active`) — verified at deploy time, not unit-testable.)

**Status:** Implemented

---

### REQ-ENTERPRISE-023: Strict Gateway Egress Controller Transport

**Intent:** When Strict Gateway Egress is active, the catch-all egress controller transparently proxies direct-internet traffic through the Gateway while preserving the deployment's own Cloudflare control-plane paths.

**Applies To:** System

**Acceptance Criteria:**

1. The strict-egress controller transparently proxies every destination except this account's own R2. It adds no authorization or identity header, preserves caller authorization and cookies, strips only hop-by-hop headers, and does not follow redirects. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-ENTERPRISE-016 / AD86: EgressController account-scoped exemption (own account direct, all else Gateway)) -->
2. Only this deployment's account-scoped R2 endpoint and Cloudflare API account path bypass the strict-egress binding; every other account uses the binding. <!-- @impl: src/lib/controller-egress.ts::isAccountScopedDestination --> <!-- @impl: src/lib/controller-egress.ts::isOwnAccountR2 --> <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016 / AD86: isAccountScopedDestination (own account only)) -->
3. **WebSocket proxying (bridged).** WebSocket upgrades reaching the strict-egress catch-all are forwarded **transparently** through the account-scoped selector, then **bridged** through a fresh client/server pair that forwards messages, closure, and errors in both directions. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-ENTERPRISE-016: EgressController bridges WebSocket upgrades (catch-all fallback)) -->
4. **Container holds no real R2 key (strict only).** When strict is active, a non-secret placeholder R2 access key/secret is emitted into the container instead of the real key. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: src/lib/constants.ts::ENTERPRISE_R2_KEY_PLACEHOLDER --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
5. Before any upstream send, the strict-egress controller rejects loopback, RFC 1918/private, link-local (including `169.254.169.254`), unspecified, and IPv4-mapped prohibited IPv6 targets with `403 EGRESS_TARGET_BLOCKED` and performs no fetch. Public IPv6 literals remain permitted. <!-- @impl: src/lib/controller-egress.ts::isDisallowedEgressHost --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016: isDisallowedEgressHost SSRF guard) -->
6. Unbound strict egress makes direct-internet and GitHub paths return `503 EGRESS_UNAVAILABLE` without fallback; this account's own platform destinations and LLM routing remain direct and independent of the strict-egress binding. <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016: controllerFetch transport selection) -->

**Constraints:**

- `EgressController` remains a transparent proxy, not an identity-stamping interceptor.
- Only this deployment's own account-scoped Cloudflare control-plane destinations bypass `env.EGRESS`; other accounts ride the Gateway.
- Direct-internet failures fail closed when strict egress is active and the binding is unavailable.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-ENTERPRISE-026](#req-enterprise-026-strict-r2-interception-preserves-user-bucket-authority), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)

**Verification:** Automated test ([controller-egress resolver/transport/SSRF/account-scoped](../../src/__tests__/lib/controller-egress.test.ts), [EgressController transparent proxy + fail-closed + account-scoped passthrough + WebSocket](../../src/__tests__/egress-controller.test.ts), [container catch-all wiring + account-id prop](../../src/__tests__/container/index.test.ts), and [container env vars placeholder R2 key](../../src/__tests__/container/container-env.test.ts).)

**Status:** Implemented

---

### REQ-ENTERPRISE-026: Strict R2 Interception Preserves User-Bucket Authority

**Intent:** Strict egress re-signs own-account R2 traffic only for the session's bound bucket and only with that user's scoped credential, preserving the per-user storage boundary outside the root container.

**Applies To:** System

**Acceptance Criteria:**

1. Path-style and virtual-hosted own-account R2 requests are accepted only when they identify the session's exact bound bucket. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (accepts the bound bucket in virtual-hosted R2 form and signs with its scoped key) --> <!-- @test: src/__tests__/egress-controller.test.ts (re-signs the bound bucket with scoped credentials and trusted parent SSE-C while preserving streaming) -->
2. A request for another path-style or virtual-hosted bucket returns `403 EGRESS_R2_BUCKET_FORBIDDEN` before signing or forwarding. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (rejects another virtual-hosted bucket in the same account before signing or forwarding) --> <!-- @test: src/__tests__/egress-controller.test.ts (rejects another path-style bucket in the same account before signing or forwarding) -->
3. An accepted request is re-signed only with the session's bucket-scoped credential; the placeholder signature is discarded and deployment-wide R2 credentials are never used. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/container/container-interception.ts::strictEgress --> <!-- @test: src/__tests__/egress-controller.test.ts (re-signs the bound bucket with scoped credentials and trusted parent SSE-C while preserving streaming) -->
4. Re-signing preserves the streaming payload hash and replaces caller-provided SSE-C headers with trusted parent-owned values. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (re-signs the bound bucket with scoped credentials and trusted parent SSE-C while preserving streaming) -->
5. Missing scoped credentials return `503 EGRESS_R2_NOT_CONFIGURED` before any upstream send and never fall back to deployment-wide credentials. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (fails closed when scoped credentials are missing instead of falling back to deployment credentials) -->
6. A validated complete replacement pair becomes the authority for subsequent intercepted requests, including after a Durable Object wake or in an already-wired warm container. <!-- @impl: src/container/container-router.ts::handleSetBucketName --> <!-- @impl: src/container/container-interception.ts::refreshStrictEgressInterception --> <!-- @test: src/__tests__/container/container-router.test.ts (restores scoped R2 credentials from the validated restart payload after a Durable Object wake) --> <!-- @test: src/__tests__/container/container-router.test.ts (REQ-ENTERPRISE-026: refreshes warm strict interception with a changed scoped pair) -->
7. The in-memory pair changes only after a complete validated replacement is installed as the warm catch-all; otherwise the prior pair remains unchanged. <!-- @impl: src/container/container-router.ts::handleSetBucketName --> <!-- @impl: src/container/container-interception.ts::refreshStrictEgressInterception --> <!-- @test: src/__tests__/container/container-router.test.ts (rejects invalid restart credentials without replacing the in-memory scoped pair) --> <!-- @test: src/__tests__/container/container-router.test.ts (rejects a partial restart credential pair without mutating prior credentials) --> <!-- @test: src/__tests__/container/container-router.test.ts (REQ-ENTERPRISE-026: preserves the prior pair when warm catch-all replacement fails) -->

**Constraints:**

- Scoped credentials and the bound bucket remain Worker-side interceptor props; the strict container receives placeholders only.
- Governed Mode controls SSE-C behavior, not R2 signer authority.

**Priority:** P0

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-SEC-003](security.md#req-sec-003-per-user-r2-tokens-scoped-to-user-bucket)

**Verification:** Automated test ([bound-bucket authorization and scoped signing](../../src/__tests__/egress-controller.test.ts) and [atomic restart restoration](../../src/__tests__/container/container-router.test.ts).)

**Status:** Implemented

---

### REQ-ENTERPRISE-024: Strict Gateway Egress Host-Specific Interceptor Routing

**Intent:** Host-specific interceptors keep their credential-stamping responsibilities under Strict Gateway Egress: GitHub rides the Gateway, while Cloudflare AI Gateway remains a platform-native direct path.

**Applies To:** System

**Acceptance Criteria:**

1. Strict GitHub egress swaps only the upstream transport to the strict-egress binding; credential injection, no-spoof scoping, manual redirects, and response hygiene remain unchanged. Toggle-off traffic uses global fetch. <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-ENTERPRISE-016: strict gateway egress transport swap) -->
2. LLM interception does NOT swap — AI Gateway (`api.cloudflare.com` / `gateway.ai.cloudflare.com`) is a platform-native Cloudflare primitive, so its upstream forward ALWAYS egresses direct via global `fetch`, independent of the toggle and strict-egress binding ([AD86](../../documentation/decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)). <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-016 / AD86: AI Gateway is platform-native — always direct egress, never cf1:network) -->

**Constraints:**

- GitHub is external direct-internet egress and fails closed when strict egress is active without an `EGRESS` binding.
- AI Gateway remains platform-native Cloudflare control-plane egress and never depends on the `EGRESS` binding.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-ENTERPRISE-023](#req-enterprise-023-strict-gateway-egress-controller-transport), [REQ-ENTERPRISE-004](models-and-routing.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)

**Verification:** Automated test ([GitHub transport swap](../../src/__tests__/github-interceptor.test.ts) and [LLM always-direct (AI Gateway platform-native)](../../src/__tests__/llm-interceptor.test.ts).)

**Status:** Implemented

---

### REQ-ENTERPRISE-027: Managed-resource admission and transport

**Intent:** Enterprise sessions admit protected managed resources only from verified applied identity and transport that identity without moving authority into the container.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Session admission compares desired release, sequence, effective mode, extension digest, resource policy, and path digest with the applied stamp. A mismatch returns managed-update-pending before bucket or container work. <!-- @impl: src/routes/container/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (blocks a desired and applied resource-policy mismatch before bucket work) -->
2. Protected start requires Enterprise Strict Gateway Egress and its binding, then requires fresh verification of exact user-bucket policy identity before container work. <!-- @impl: src/routes/container/lifecycle.ts::app --> <!-- @impl: src/lib/managed-r2-policy.ts::readVerifiedManagedR2Policy --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (verifies protected bucket policy without cache and transports only its identity) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (blocks corrupt protected policy before container work) -->
3. Authenticated lifecycle transport uses one normalized policy enum, one path digest, and the existing curation release digest. <!-- @impl: src/lib/container-config-schema.ts::SetBucketNameBodySchema --> <!-- @impl: src/routes/container/lifecycle-init.ts::buildSetBucketNameBody --> <!-- @test: src/__tests__/lib/container-config-schema.test.ts (accepts mutable only with a null managed path identity) -->
4. Invalid policy identity combinations do not cross the Worker-to-DO boundary. <!-- @impl: src/lib/container-config-schema.ts::SetBucketNameBodySchema --> <!-- @impl: src/container/container-router.ts::handleSetBucketName --> <!-- @test: src/__tests__/lib/container-config-schema.test.ts (requires the curation release and managed path digests for both protected modes) --> <!-- @test: src/__tests__/container/container-router.test.ts (rejects injected policy digests when policy mode is omitted) --> <!-- @test: src/__tests__/container/container-router.test.ts (rejects injected policy digests when policy mode is omitted) -->
5. A warm Durable Object refreshes strict interception before committing changed bucket, scoped credential, policy, release, or path-digest security state. <!-- @impl: src/container/container-router.ts::handleSetBucketName --> <!-- @impl: src/container/container-interception.ts::refreshStrictEgressInterception --> <!-- @test: src/__tests__/container/container-router.test.ts (refreshes warm strict interception when only policy identity changes) -->
6. Explicit mutable identity clears stale protected state. <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @test: src/__tests__/container/container-env.test.ts (clears protected state and env on an explicit mutable warm reset) -->
7. The container receives only non-authoritative policy identity hints; policy bytes and scoped credentials remain Worker-side. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (emits protected identity without exposing Worker-held scoped credentials) -->

**Constraints:** Durable Objects do not persist policy bytes or make authorization decisions.

**Priority:** P0

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-STOR-030](storage.md#req-stor-030-managed-resource-policy-loading)

**Verification:** Automated admission, schema, transport, and warm-refresh tests

**Status:** Implemented

---

### REQ-ENTERPRISE-028: Managed-resource request classification

**Intent:** The Worker classifies every own-bucket S3 mutation before scoped signing without changing ordinary reads or adjacent personal paths.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. The classifier allows reads and listing for the bound user bucket. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (allows reads and listing while denying cross-bucket targets) -->
2. Exact-path and exclusive-root mutations are denied across path-style, virtual-host, multipart, tagging, metadata-replacement, and copy destinations. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (denies protected mutation %s %s) -->
3. Malformed, ambiguous, bucket-level, or noncanonical mutation targets fail closed without double decoding. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (decodes exactly once and rejects malformed, noncanonical, backslash, duplicate-control, and empty mutations) -->
4. Multi-delete accepts bounded, uncompressed strict XML with no namespace or the canonical S3 namespace and at most 1,000 keys. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (denies a whole mixed multi-delete and forwards exact ordinary bytes) --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (fails closed above the multi-delete byte and key-count bounds) --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (fails closed on malformed, compressed, or ambiguous multi-delete) -->
5. A protected or uncertain multi-delete key denies the whole request. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (denies a whole mixed multi-delete and forwards exact ordinary bytes) -->
6. Approved multi-delete bytes are forwarded unchanged. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (denies a whole mixed multi-delete and forwards exact ordinary bytes) -->

**Constraints:** Classification runs before scoped signing and decodes keys exactly once.

**Priority:** P0

**Dependencies:** [REQ-STOR-028](storage.md#req-stor-028-canonical-managed-resource-persistence-policy), [REQ-STOR-032](storage.md#req-stor-032-exclusive-managed-resource-boundaries)

**Verification:** Automated addressing, mutation-form, canonical-key, multi-delete, and adjacent-path tests

**Status:** Implemented

---

### REQ-ENTERPRISE-029: Managed-resource Egress enforcement

**Intent:** Egress applies verified policy with the exact scoped user credential and fails closed before forwarding protected mutations.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Egress derives policy location and identity only from Worker state. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (loads policy with scoped credentials and denies protected mutation before user forwarding) -->
2. Policy reads use only the scoped user key. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (loads policy with scoped credentials and denies protected mutation before user forwarding) -->
3. Approved user requests use only the scoped user key. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (signs approved adjacent mutation only with the scoped user key) -->
4. Missing or mismatched policy returns S3 XML `503` without forwarding the mutation. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (returns S3 503 and never forwards mutation when policy loading fails) -->
5. Protected mutation returns S3 XML `403` before user forwarding. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (loads policy with scoped credentials and denies protected mutation before user forwarding) -->
6. Policy decisions log only operation, identity/hash prefixes, request ID, and reason. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (loads policy with scoped credentials and denies protected mutation before user forwarding) --> <!-- @test: src/__tests__/egress-controller.test.ts (signs approved adjacent mutation only with the scoped user key) --> <!-- @test: src/__tests__/egress-controller.test.ts (returns S3 503 and never forwards mutation when policy loading fails) -->

**Constraints:** Worker interception immediately before scoped signing is authoritative.

**Priority:** P0

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-ENTERPRISE-026](#req-enterprise-026-strict-r2-interception-preserves-user-bucket-authority), [REQ-ENTERPRISE-027](#req-enterprise-027-managed-resource-admission-and-transport), [REQ-ENTERPRISE-028](#req-enterprise-028-managed-resource-request-classification), [REQ-STOR-030](storage.md#req-stor-030-managed-resource-policy-loading)

**Verification:** Automated scoped-policy-read, scoped-forwarding, policy-failure, protected-denial, and privacy-safe logging tests

**Status:** Implemented

---
