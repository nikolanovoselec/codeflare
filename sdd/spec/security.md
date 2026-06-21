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

**Intent:** All protected surfaces (`/app`, `/api`, `/setup` post-first-configure) must deny access to unauthenticated users with an appropriate HTTP response.

**Applies To:** User

**Acceptance Criteria:**

1. Unauthenticated requests to protected paths (application pages, API endpoints, post-setup-completion setup endpoints) receive 401, 302, or 403 responses. <!-- @impl: src/lib/access.ts::authenticateRequest --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe) --> <!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest describe) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe) -->
2. In CF Access mode, requests without a valid CF Access session credential are rejected. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe) --> <!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest describe) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe) -->
3. In SaaS mode, requests without a valid SaaS session credential are rejected. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe) --> <!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest describe) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe) -->
4. Injecting the pre-setup header-trust signal does not bypass authentication after setup is complete. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe) --> <!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest describe) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe) -->
5. Transient storage failures during auth-config fetch do not permanently degrade authentication to the pre-setup trust model. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe) --> <!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest describe) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe) -->
6. All protected API endpoints reject unauthenticated requests. <!-- @impl: src/lib/access.ts::authenticateRequest --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe) --> <!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest describe) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe) -->
7. The setup-status endpoint is always public and returns only configuration status, no secrets. <!-- @impl: src/routes/setup/handlers.ts --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe) --> <!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest describe) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe) -->

**Constraints:**

- Pre-setup configuration endpoints required before first-run completion are intentionally public to allow initial configuration without authentication ([AD10](../../documentation/decisions/README.md#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation)).
- A dedicated service-token authentication path is checked first in all modes for E2E testing.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](authentication.md#req-auth-001-two-authentication-modes), [REQ-AUTH-010](authentication.md#req-auth-010-auth-bypass-prevention)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-SEC-002: API tokens never enter containers

**Intent:** The master Cloudflare API token must never be exposed inside container environments. Containers receive only scoped, per-user credentials.

**Applies To:** User

**Acceptance Criteria:**

1. The master Cloudflare API token is never exposed inside container environments. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → info-disclosure job) --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin describe) -->
2. Containers receive only per-user scoped R2 credentials (access key pair), never the master API token. <!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → info-disclosure job) --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin describe) -->
3. The container environment never carries the master API token. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → info-disclosure job) --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin describe) -->
4. R2 credentials passed to containers are scoped to the user's bucket (Object Read + Write only). <!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → info-disclosure job) --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (r2-admin describe) -->

**Constraints:**

- The Worker/DO acts as a security boundary between the API token and container-executed user code.

**Priority:** P0

**Dependencies:** [REQ-SEC-003](#req-sec-003-per-user-r2-tokens-scoped-to-user-bucket)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-SEC-003: Per-user R2 tokens scoped to user bucket

**Intent:** Each user's container receives an R2 API token restricted to that user's storage bucket, preventing cross-user data access.

**Applies To:** User

**Acceptance Criteria:**

1. The system creates a per-user Cloudflare API token scoped to that user's R2 bucket (Object Read + Write only). <!-- @impl: src/lib/r2-admin.ts::createScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (createScopedR2Token describe -> POST /accounts/{accountId}/tokens with bucket-scoped Object Read+Write policy + tokenId from result.id + secretAccessKey = SHA-256(result.value)) -->
2. Token credentials are derived deterministically so the token ID and a hash of the token value form an S3-compatible credential pair. <!-- @impl: src/lib/r2-admin.ts::createScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (createScopedR2Token describe -> POST /accounts/{accountId}/tokens with bucket-scoped Object Read+Write policy + tokenId from result.id + secretAccessKey = SHA-256(result.value)) -->
3. Tokens are cached per user (encrypted when operator-provided encryption is configured). <!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (getOrCreateScopedR2Token describe -> KV cache r2token:{email} + verifyTokenExists only invalidates on definitive 404 + transient errors preserve cache) -->
4. Cached tokens are validated before use; only a definitive 404 from the token-existence check invalidates the cache. <!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (getOrCreateScopedR2Token describe -> KV cache r2token:{email} + verifyTokenExists only invalidates on definitive 404 + transient errors preserve cache) -->
5. Transient verification errors assume the token is still valid to prevent unnecessary downstream auth failures. <!-- @impl: src/lib/r2-admin.ts::getOrCreateScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (getOrCreateScopedR2Token describe -> KV cache r2token:{email} + verifyTokenExists only invalidates on definitive 404 + transient errors preserve cache) -->
6. Tokens are revoked on user deletion. <!-- @impl: src/lib/r2-admin.ts::deleteScopedR2Token --> <!-- @test: src/__tests__/lib/r2-admin.test.ts (deleteScopedR2Token describe -> DELETE /accounts/{accountId}/tokens/{id} via CF API) --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (cleanupUserData -> reads r2token KV, calls deleteScopedR2Token with stored tokenId, deletes r2token KV entry -> AC6 wiring) -->
7. Token creation requires the upstream API permission to manage tokens on the deploy credential. <!-- @impl: src/lib/r2-admin.ts::createScopedR2Token --> <!-- coverage-gap: the upstream Cloudflare API enforces this (403 on insufficient token-management scope), not our code; verified operationally -->

**Constraints:**

- Token verification runs on every cache hit, not just on creation.
- Verification failures due to transient errors do not delete the cached token.

**Priority:** P0

**Dependencies:** [REQ-SEC-004](#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** [Integration test](../../src/__tests__/lib/r2-admin.test.ts)

**Status:** Implemented

---

### REQ-SEC-004: Credential encryption-at-rest cryptographic contract

**Intent:** When an operator provides an encryption key, the cryptographic contract for encryption-at-rest (key import shape, algorithm, ciphertext format, AAD binding, isolate caching) is fixed and pentest-verifiable.

**Applies To:** User

**Acceptance Criteria:**

1. The operator-provided encryption key must be a base64-encoded 256-bit value (exactly 32 bytes decoded). Non-base64 or wrong-length values are rejected at startup. <!-- @impl: src/lib/kv-crypto.ts::importEncryptionKey --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (importEncryptionKey describe) -->
2. Credential values (LLM keys, deploy keys, R2 tokens) are encrypted at rest with authenticated AES-256-GCM. <!-- @impl: src/lib/kv-crypto.ts::encryptForKV --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (importEncryptionKey describe) -->
3. Ciphertext carries a version prefix and a random IV per write, so re-encrypting the same plaintext produces a different ciphertext. <!-- @impl: src/lib/kv-crypto.ts::encryptForKV --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (encryptForKV / decryptFromKV describe) -->
4. The storage key name is bound as additional authenticated data, preventing ciphertext from being copied between storage keys. <!-- @impl: src/lib/kv-crypto.ts::encryptForKV --> <!-- @test: src/__tests__/security/kv-crypto-security.test.ts (REQ-SEC-004 describe -> AAD key-name binding (ciphertext non-portable) + non-secret entries stay plaintext + warnIfNoEncryptionKey CRITICAL log) --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (encryptForKV / decryptFromKV describe) -->
5. The encryption key is imported once per worker instance and reused for the instance's lifetime. <!-- @impl: src/lib/kv-crypto.ts::getOrImportKey --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (getOrImportKey describe) -->

**Constraints:**

- Changing the encryption key requires re-encrypting all credential values (see [REQ-SEC-006](#req-sec-006-transparent-kv-encryption-migration)).
- Operational masking, missing-key warning, and non-secret allowlist live in [REQ-SEC-018](#req-sec-018-credential-encryption-operational-policy).

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/security/kv-crypto-security.test.ts)

**Status:** Implemented

---

### REQ-SEC-005: R2 files encrypted at rest with SSE-C when operator configures an encryption key

**Intent:** When an operator provides an encryption key, all R2 object storage operations must use server-side encryption with customer-provided keys (SSE-C).

**Applies To:** User

**Acceptance Criteria:**

1. All R2 object operations (read, write, head, multipart) use SSE-C headers when an operator encryption key is configured. <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @impl: src/lib/r2-client.ts --> <!-- @test: src/__tests__/lib/r2-sse.test.ts (getSseHeaders describe -> 3 SSE-C headers x-amz-server-side-encryption-customer-{algorithm,key,key-MD5} present when ENCRYPTION_KEY set + empty when unset + MD5 = base64(MD5(raw key bytes)) deterministic with known-answer vectors) -->
2. The SSE-C scheme uses AES-256; the request carries the customer-provided key and a key-hash so the storage layer can verify integrity. <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @test: src/__tests__/lib/r2-sse.test.ts (getSseHeaders describe -> 3 SSE-C headers x-amz-server-side-encryption-customer-{algorithm,key,key-MD5} present when ENCRYPTION_KEY set + empty when unset + MD5 = base64(MD5(raw key bytes)) deterministic with known-answer vectors) -->
3. The encryption key is propagated from Worker to Durable Object to container as part of the session environment. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars describe -> emits ENCRYPTION_KEY when state._encryptionKey set, omits when null -> AC3 env-var forwarding + AC7 no-op when unset) -->
4. In containers, the sync configuration is extended with SSE-C settings so all R2 traffic carries the customer-provided key. <!-- @impl: entrypoint.sh::create_rclone_config --> <!-- @test: host/__tests__/entrypoint-sse-c-config.test.js (create_rclone_config describe -> harness runs the real entrypoint function and reads back generated rclone.conf; sse_customer_key_base64 + sse_customer_algorithm = AES256 appended when ENCRYPTION_KEY exported; absent when unset or empty -> AC4 entrypoint behavior, AC7 no-op path) -->
5. All bidirectional sync operations (initial restore, periodic sync, shutdown sync) transparently encrypt and decrypt without user action. <!-- @impl: entrypoint.sh::create_rclone_config --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (entrypoint.sh bisync daemon behavior describe -> bisync via rclone reads the configured rclone.conf (with or without SSE-C) and round-trips files -> AC5 transparent encrypt/decrypt during initial/periodic/shutdown sync) -->
6. Files are visible in the R2 dashboard (names, sizes, metadata) but contents are unreadable without the key. <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @test: src/__tests__/lib/r2-sse.test.ts (getSseHeaders describe -> 3 SSE-C headers x-amz-server-side-encryption-customer-{algorithm,key,key-MD5} present when ENCRYPTION_KEY set + empty when unset + MD5 = base64(MD5(raw key bytes)) deterministic with known-answer vectors) -->
7. When no operator encryption key is configured, R2 operations proceed without SSE-C (no code path changes). <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @test: src/__tests__/lib/r2-sse.test.ts (getSseHeaders describe -> 3 SSE-C headers x-amz-server-side-encryption-customer-{algorithm,key,key-MD5} present when ENCRYPTION_KEY set + empty when unset + MD5 = base64(MD5(raw key bytes)) deterministic with known-answer vectors) --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars describe -> emits ENCRYPTION_KEY when state._encryptionKey set, omits when null -> AC3 env-var forwarding + AC7 no-op when unset) --> <!-- @test: host/__tests__/entrypoint-sse-c-config.test.js (create_rclone_config describe -> harness runs the real entrypoint function and reads back generated rclone.conf; sse_customer_key_base64 + sse_customer_algorithm = AES256 appended when ENCRYPTION_KEY exported; absent when unset or empty -> AC4 entrypoint behavior, AC7 no-op path) -->

**Constraints:**

- Enabling SSE-C on an existing deployment requires re-uploading all existing unencrypted R2 objects with SSE-C.
- New deployments that enable encryption from the start require no migration.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Integration test](../../src/__tests__/lib/r2-sse.test.ts)

**Status:** Implemented

---

### REQ-SEC-006: Transparent KV encryption migration

**Intent:** Enabling encryption on an existing deployment with plaintext KV data must be seamless, with no downtime and no data loss.

**Applies To:** User

**Acceptance Criteria:**

1. Encrypted values (identified by the version prefix) are decrypted transparently on read. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (getAndDecrypt describe) -->
2. Legacy plaintext values without a version prefix are parsed directly. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (getAndDecrypt describe) -->
3. Plaintext reads trigger a background re-encryption write-back. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (getAndDecrypt describe) -->
4. Subsequent reads of the migrated value hit the fast decrypted path. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (getAndDecrypt round-trips when encrypted) -->
5. If the re-encryption write-back fails (transient error, rate limit), the caller still receives correct data. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/security/kv-crypto-security.test.ts (REQ-SEC-006 write-back failure describe -> returns correct data when migration write-back put() rejects + does not propagate as thrown error) --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (getAndDecrypt describe) -->
6. Two concurrent requests reading the same plaintext entry can both write encrypted copies safely (the result is equivalent regardless of which write wins). <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- coverage-gap: concurrent-write timing is not deterministically unit-testable; safety follows from each write being an independent valid encryption of the same plaintext (either decrypts to the same value) -->
7. Direct credential writes always store encrypted data without going through a migration path. <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (encryptAndStore describe) -->

**Constraints:**

- Migration is lazy (on-read), not batch. Complete migration happens gradually as values are accessed.
- No downtime or manual intervention required.

**Priority:** P0

**Dependencies:** [REQ-SEC-004](#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** [Automated test](../../src/__tests__/security/kv-crypto-security.test.ts)

**Status:** Implemented

---

### REQ-SEC-007: Rate-limiting infrastructure

**Intent:** The general rate-limit infrastructure (factory, key derivation, KV-with-in-memory-fallback storage, 429 response shape, advisory headers) underpins every per-endpoint policy in the system.

**Applies To:** User

**Acceptance Criteria:**

1. Rate limiting is keyed by authenticated user identity, with client IP as fallback for unauthenticated requests. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter describe) -->
2. Primary storage is persistent storage with automatic TTL expiry; the fallback is per-isolate in-memory with periodic cleanup. <!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit --> <!-- @test: src/__tests__/middleware/rate-limit-fallback.test.ts (rate-limit fallback describe) -->
3. Exceeded limits return HTTP 429 with a stable error code and a human-readable retry-time message. <!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit --> <!-- @test: src/__tests__/security/rate-limit-security.test.ts (REQ-SEC-007 describe -> 429 with RATE_LIMIT_ERROR code in body + fail-closed=true+KV throws=429 + fail-open=false (default)+KV throws=200) --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter describe) -->
4. All rate-limited responses include the standard rate-limit advisory headers. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter describe) -->

**Constraints:**

- Per-endpoint policy + fail-closed/fail-open semantics + stress-test bypass live in [REQ-SEC-019](#req-sec-019-per-endpoint-rate-limit-policy); WS-upgrade pre-rate-limit short-circuits live in [REQ-SEC-020](#req-sec-020-ws-upgrade-rate-limit-short-circuits).

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/security/rate-limit-security.test.ts)

**Status:** Implemented

---

### REQ-SEC-008: Security headers on every response

**Intent:** Every HTTP response must include standard security headers to prevent common web attacks (clickjacking, MIME sniffing, mixed content, leaked referrer, fingerprintable server software).

**Applies To:** User

**Acceptance Criteria:**

1. `Strict-Transport-Security` (HSTS) is present on all responses, including redirects and OPTIONS preflight responses. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 describe -> real worker.fetch against /health asserts Strict-Transport-Security + Content-Security-Policy + X-Content-Type-Options nosniff + X-Frame-Options DENY + Referrer-Policy + Permissions-Policy + X-Powered-By absent + HSTS on redirects) --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → security-headers job verifies all headers) -->
2. `Content-Security-Policy` is set. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 describe -> real worker.fetch against /health asserts Strict-Transport-Security + Content-Security-Policy + X-Content-Type-Options nosniff + X-Frame-Options DENY + Referrer-Policy + Permissions-Policy + X-Powered-By absent + HSTS on redirects) --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → security-headers job verifies all headers) --> <!-- @test: src/__tests__/security/early-return-security.test.ts (CF-001 vault early-return describe → proxied vault content has frame-ancestors CSP + SAMEORIGIN frame header, error responses carry full CSP → AC2/AC4 vault-proxy exemption) -->
3. `X-Content-Type-Options: nosniff` is set. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 describe -> real worker.fetch against /health asserts Strict-Transport-Security + Content-Security-Policy + X-Content-Type-Options nosniff + X-Frame-Options DENY + Referrer-Policy + Permissions-Policy + X-Powered-By absent + HSTS on redirects) --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → security-headers job verifies all headers) -->
4. `X-Frame-Options: DENY` is set on normal responses; proxied SilverBullet vault content may use `SAMEORIGIN` so the dashboard can run the authenticated hidden prewarm iframe without allowing cross-site framing. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 describe -> real worker.fetch against /health asserts Strict-Transport-Security + Content-Security-Policy + X-Content-Type-Options nosniff + X-Frame-Options DENY + Referrer-Policy + Permissions-Policy + X-Powered-By absent + HSTS on redirects) --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → security-headers job verifies all headers) --> <!-- @test: src/__tests__/security/early-return-security.test.ts (CF-001 vault early-return describe → proxied vault content has frame-ancestors CSP + SAMEORIGIN frame header, error responses carry full CSP → AC2/AC4 vault-proxy exemption) -->
5. `Referrer-Policy: strict-origin-when-cross-origin` is set. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 describe -> real worker.fetch against /health asserts Strict-Transport-Security + Content-Security-Policy + X-Content-Type-Options nosniff + X-Frame-Options DENY + Referrer-Policy + Permissions-Policy + X-Powered-By absent + HSTS on redirects) --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → security-headers job verifies all headers) -->
6. `Permissions-Policy` is set. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 describe -> real worker.fetch against /health asserts Strict-Transport-Security + Content-Security-Policy + X-Content-Type-Options nosniff + X-Frame-Options DENY + Referrer-Policy + Permissions-Policy + X-Powered-By absent + HSTS on redirects) --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → security-headers job verifies all headers) -->
7. `X-Powered-By` header is absent. <!-- @impl: src/index.ts::withSecurityHeaders --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-SEC-008 describe -> real worker.fetch against /health asserts Strict-Transport-Security + Content-Security-Policy + X-Content-Type-Options nosniff + X-Frame-Options DENY + Referrer-Policy + Permissions-Policy + X-Powered-By absent + HSTS on redirects) --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → security-headers job verifies all headers) -->

**Constraints:**

- Headers are applied globally; every response path inherits them.
- Preflight (OPTIONS) responses receive HSTS directly in the CORS middleware.
- Coverage of non-standard response paths (redirect responses, helper-emitted responses) lives in [REQ-SEC-021](#req-sec-021-hsts-coverage-on-redirect-response-paths).
- Proxied SilverBullet vault content uses `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'` so same-origin prewarm works while cross-site framing stays blocked.
- Vault route-validation errors and `/api/vault/:sid/status` still carry the full default security header set.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/security/security-headers.test.ts)

**Status:** Implemented

---

### REQ-SEC-009: Input validation at system boundaries

**Intent:** All external input (user requests, API parameters, file paths) must be validated before processing to prevent injection, traversal, and corruption.

**Applies To:** User

**Acceptance Criteria:**

1. Request bodies are validated before handler logic executes. <!-- @impl: src/lib/request-helpers.ts::parseJsonBody --> <!-- @impl: src/lib/schemas.ts --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → injection job) --> <!-- @test: host/__tests__/workflow-files.test.js (fuzz workflow describe → property-based input validation) -->
2. Setup wizard inputs (domain, emails, origins) are validated with shape-specific patterns. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → injection job) --> <!-- @test: host/__tests__/workflow-files.test.js (fuzz workflow describe → property-based input validation) -->
3. Session IDs are validated against the canonical format (8-24 lowercase alphanumeric characters) on every entry point. Invalid IDs are rejected with 400 before any session-side interaction. <!-- @impl: src/lib/constants.ts::SESSION_ID_PATTERN --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → injection job) --> <!-- @test: host/__tests__/workflow-files.test.js (fuzz workflow describe → property-based input validation) -->
4. Malformed base64 inputs are rejected with 400 immediately. <!-- @impl: src/routes/storage/upload.ts --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → injection job) --> <!-- @test: host/__tests__/workflow-files.test.js (fuzz workflow describe → property-based input validation) -->
5. API routes enforce a 64 KiB body limit (storage routes exempt for file uploads). <!-- @impl: src/index.ts --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → injection job) --> <!-- @test: host/__tests__/workflow-files.test.js (fuzz workflow describe → property-based input validation) -->
6. Email addresses are normalized before any lookup, comparison, or derivation operation. <!-- @impl: src/lib/access.ts::getBucketName --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → injection job) --> <!-- @test: host/__tests__/workflow-files.test.js (fuzz workflow describe → property-based input validation) -->

**Constraints:**

- Validation errors return structured error responses with a stable validation error code and HTTP 400.
- Validation rules are enforced independently at each tier (Worker and UI) due to separate build pipelines.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-SEC-010: Path traversal prevention on storage endpoints

**Intent:** Storage API endpoints must prevent directory traversal attacks that could access files outside the user's bucket scope.

**Applies To:** User

**Acceptance Criteria:**

1. Storage paths are URI-decoded before the parent-directory traversal check so encoded traversal sequences are caught. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-010 describe -> validateKey decodes URI before traversal check + %2E%2E rejected + lone % throws ValidationError + decoded key returned) -->
2. Both single- and double-encoded parent-directory sequences are rejected. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-010 describe -> validateKey decodes URI before traversal check + %2E%2E rejected + lone % throws ValidationError + decoded key returned) -->
3. Malformed URI encoding is rejected with a validation error. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-010 describe -> validateKey decodes URI before traversal check + %2E%2E rejected + lone % throws ValidationError + decoded key returned) -->
4. The validator returns the decoded key so callers operate on the value the user sees, not the encoded request form. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-010 describe -> validateKey decodes URI before traversal check + %2E%2E rejected + lone % throws ValidationError + decoded key returned) -->
5. The browse endpoint validates the prefix parameter against parent-directory traversal. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: src/__tests__/routes/storage-browse.test.ts (browse rejects prefix path traversal) -->
6. Path-traversal payloads (percent-encoded, double-encoded, backslash, unicode variants) are rejected. <!-- @impl: src/routes/storage/validation.ts::validateKey --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → injection job, path-traversal payloads) -->

**Constraints:**

- A protected-paths allowlist is supported but empty by default; all storage paths are accessible via the web storage API.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/security/storage-security.test.ts)

**Status:** Implemented

---

### REQ-SEC-011: Container image scanned for CVEs before deploy

**Intent:** Every container image must be scanned for known vulnerabilities before being deployed to production.

**Applies To:** User

**Acceptance Criteria:**

1. Container images are scanned for HIGH and CRITICAL severity vulnerabilities in the deploy workflow. <!-- @impl: .github/workflows/deploy.yml --> <!-- @impl: .github/workflows/deploy-dockerhub.yml --> <!-- @test: host/__tests__/workflow-files.test.js (container image pipeline describe → trivy scan job) -->
2. Known vulnerability exceptions are tracked in a project-level allowlist. <!-- @impl: .trivyignore --> <!-- @test: host/__tests__/workflow-files.test.js (container image pipeline describe → trivy scan job) -->
3. The deploy pipeline fails if the scan finds a HIGH/CRITICAL vulnerability that has an available fix and is not suppressed in the project allowlist; unfixed CVEs (no upstream fix available) are excluded from the gate automatically. <!-- @impl: .github/workflows/deploy.yml --> <!-- @test: host/__tests__/workflow-files.test.js (container image pipeline describe → trivy scan job) -->
4. Scanning occurs after image build and before push to the container registry. <!-- @impl: .github/workflows/deploy.yml --> <!-- @test: host/__tests__/workflow-files.test.js (container image pipeline describe → trivy scan job) -->

**Constraints:**

- Image scanning is part of the deploy pipeline, not a runtime check.
- The vulnerability-exception allowlist is reviewed periodically.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-SEC-012: Container auth token per DO lifecycle

**Intent:** Each Durable Object lifecycle generates a unique auth token for container communication, preventing unauthorized access to container endpoints.

**Applies To:** User

**Acceptance Criteria:**

1. A unique auth token is generated per Durable Object lifecycle and injected into the container environment. <!-- @impl: src/container/index.ts::container --> <!-- @impl: host/src/server.ts --> <!-- @test: src/__tests__/container/index.test.ts (persists a freshly-generated containerAuthToken so subsequent wakes restore it -> CONTAINER_AUTH_TOKEN env var matches uuid regex and gets storage-put under key "containerAuthToken" -> AC1 random UUID per DO + env-var) -->
2. All proxied requests from the Worker to the container include the token as a bearer credential. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SEC-012 AC2: proxied non-internal request gets Authorization Bearer injected before super.fetch -> superFetchSpy assertion on forwarded Request header) -->
3. The container's terminal server validates the bearer credential on all non-exempt paths. <!-- @impl: host/src/auth-check.ts::checkContainerAuth --> <!-- @test: host/__tests__/server-auth-check.test.js (checkContainerAuth describe -> non-exempt paths require matching Bearer + 503 when token unset + 401 on missing/wrong/empty Bearer + 200 on match -> AC3 terminal validates token on non-exempt paths) -->
4. A small set of health-check paths (health and activity) are auth-exempt because they are reached over an internal probe path that bypasses the proxy; both paths expose no user data and no mutable state. <!-- @impl: host/src/auth-check.ts::AUTH_EXEMPT_PATHS --> <!-- @test: host/__tests__/server-auth-check.test.js (REQ-SEC-012 AC4: only /health and /activity are auth-exempt describe -> AUTH_EXEMPT_PATHS contains exactly these two + both allowed without token) -->
5. The token survives container hibernate/wake cycles within a single Durable Object lifecycle, so a rehydrated session still authenticates successfully without recreating the container. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (restores containerAuthToken from storage so DO wake does not desync from a running container -> PRIOR_TOKEN preserved through constructor + storage.put NOT called with new UUID -> AC5 token survives hibernate/wake) -->
6. On Durable Object destruction the persisted token is cleared so the next lifecycle starts with a fresh token. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SEC-012 AC6: destroy() clears persisted containerAuthToken so next session starts fresh -> storage.delete called with "containerAuthToken" + in-memory _containerAuthToken nulled -> AC6 no cross-lifecycle reuse) -->

**Constraints:**

- The token is unique per DO lifecycle, persisted across hibernate/wake cycles within that lifecycle.
- Token is never exposed to the client.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Integration test](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-SEC-013: Content-Disposition hardening on downloads

**Intent:** File download responses must prevent header injection attacks via sanitized filenames.

**Applies To:** User

**Acceptance Criteria:**

1. File download responses use `Content-Disposition: attachment` with sanitized filenames. <!-- @impl: src/routes/storage/download.ts::buildContentDisposition --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → header-injection job, filename sanitization) -->
2. Special characters are stripped from filenames. <!-- @impl: src/routes/storage/download.ts::buildContentDisposition --> <!-- @test: src/__tests__/security/storage-security.test.ts (REQ-SEC-013 describe -> download.ts uses attachment disposition type + CRLF stripping in buildContentDisposition + quotes/backslashes stripped (structural audit; buildContentDisposition not exported)) --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → header-injection job, filename sanitization) -->
3. Header-injection control characters are stripped from filenames. <!-- @impl: src/routes/storage/download.ts::buildContentDisposition --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → header-injection job, filename sanitization) -->

**Constraints:**

- Applies to all file download endpoints in storage routes.

**Priority:** P0

**Dependencies:** [REQ-SEC-009](#req-sec-009-input-validation-at-system-boundaries)

**Verification:** [Automated test](../../src/__tests__/security/storage-security.test.ts)

**Status:** Implemented

---

### REQ-SEC-014: SaaS service-token header not trusted in SaaS mode

**Intent:** The `cf-access-client-id` header must not be trusted as an authentication mechanism in SaaS mode where no CF Access edge validates it.

**Applies To:** User

**Acceptance Criteria:**

1. The CF Access client-id header is only trusted in non-SaaS deployments where a CF Access edge actually validates it. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/security/access-security.test.ts (REQ-SEC-014 describe -> cf-access-client-id trusted only when !SAAS_MODE + SaaS mode ignores attacker-controlled cf-access-client-id (no email/auth produced)) --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → cf-access-client-id spoofing in SaaS mode) -->
2. In SaaS mode the header is attacker-controlled and is ignored. <!-- @impl: src/lib/onboarding.ts::isSaasModeActive --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → cf-access-client-id spoofing in SaaS mode) -->

**Constraints:**

- This guard applies only to the CF Access client ID header; service-token validation is governed separately.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](authentication.md#req-auth-001-two-authentication-modes)

**Verification:** [Automated test](../../src/__tests__/security/access-security.test.ts)

**Status:** Implemented

---

### REQ-SEC-015: Blocked user cannot self-upgrade subscription

**Intent:** Users with a blocked subscription tier must not be able to bypass the block by accessing subscription endpoints.

**Applies To:** User

**Acceptance Criteria:**

1. The subscribe endpoint rejects blocked users at handler entry. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @impl: src/routes/auth.ts --> <!-- @impl: src/routes/container/lifecycle.ts --> <!-- @impl: src/routes/preferences.ts --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (REQ-SEC-015 AC1 -> blocked user gets 403 even when requesting a valid subscribable tier -> AC1 handler-entry getEffectiveTier check) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (REQ-SEC-015 AC1 -> blocked user gets 403 even requesting the free tier (no escape via downgrade) -> AC1 KV state preserved) -->
2. The session mode the user can run with is clamped against the billing-resolved effective tier at both container start and preferences save. <!-- @impl: src/lib/session-mode.ts::clampSessionModeToTier --> <!-- @test: src/__tests__/lib/session-mode.test.ts (clampSessionModeToTier describe -> AC2 blocked/pending/standard tiers strip advanced + advanced/unlimited tiers preserve advanced -> AC2 container-start clamp behavior matrix) --> <!-- @test: src/__tests__/routes/preferences.test.ts (sessionMode preference describe -> REQ-SEC-015 AC2 (preferences save) SaaS-mode non-Pro user gets 400 trying to PATCH sessionMode=advanced -> AC2 preferences-save rejection + KV-not-mutated assertion) -->
3. A canceled user with a stale advanced-mode preference is downgraded to default mode because their effective tier no longer permits advanced. <!-- @impl: src/lib/session-mode.ts::clampSessionModeToTier --> <!-- @test: src/__tests__/lib/session-mode.test.ts (clampSessionModeToTier describe -> AC3 canceled user with stale sessionMode=advanced is clamped to default -> AC3 canceled-user stale-advanced downgrade) -->
4. Both container start and preferences save resolve the effective tier from billing state, not from a stored or token-side tier value. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (REQ-SEC-015 AC4 -> user with undefined subscriptionTier but accessTier=blocked is rejected -> AC4 getEffectiveTier fallback path) -->

**Constraints:**

- Tier enforcement is in the Worker, not in the container.
- Effective tier resolution accounts for both subscription status and billing state.

**Priority:** P0

**Dependencies:** [REQ-SUB-012](subscription.md#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** [Integration test](../../src/__tests__/routes/auth-subscribe.test.ts)

**Status:** Implemented

---

### REQ-SEC-016: Concurrent cache deduplication for auth config

**Intent:** Multiple concurrent cold-start requests must not issue redundant KV reads for authentication configuration.

**Applies To:** User

**Acceptance Criteria:**

1. Concurrent cold-start requests share a single in-flight auth-config fetch; no redundant storage reads are issued. <!-- @impl: src/lib/access.ts::loadAuthConfig --> <!-- @impl: src/lib/jwt.ts --> <!-- @test: src/__tests__/security/access-security.test.ts (REQ-SEC-016 describe -> two concurrent getUserFromRequest issue exactly one setup:auth_domain KV read + sequential warm-cache no re-read + resetAuthConfigCache forces re-read) --> <!-- @test: src/__tests__/lib/auth-config-fetch-dedup.test.ts (10 concurrent requests → single KV read round) -->
2. Two concurrent cold-start requests reuse the in-flight fetch instead of issuing parallel storage reads. <!-- @impl: src/lib/access.ts::loadAuthConfig --> <!-- @test: src/__tests__/lib/auth-config-fetch-dedup.test.ts (10 concurrent requests → single KV read round) -->
3. The cached auth config expires on TTL and can be explicitly invalidated, forcing a fresh storage read. <!-- @impl: src/lib/access.ts::resetAuthConfigCache --> <!-- @test: src/__tests__/lib/auth-config-fetch-dedup.test.ts (10 concurrent requests → single KV read round) -->

**Constraints:**

- Deduplication is per-isolate, not cross-isolate.

**Priority:** P0

**Dependencies:** [REQ-AUTH-010](authentication.md#req-auth-010-auth-bypass-prevention)

**Verification:** [Automated test](../../src/__tests__/security/access-security.test.ts)

**Status:** Implemented

---

### REQ-SEC-018: Credential encryption operational policy

**Intent:** The encryption-at-rest contract needs operational hardening at the API and observability layers: responses always mask secrets, missing-key configuration is loud enough to catch in production logs, and the plaintext-allowlist is explicit so future KV keys are categorised on purpose, not by accident.

**Applies To:** User

**Acceptance Criteria:**

1. API responses always return masked values (last 4 characters only); the plaintext value is never returned. <!-- @impl: src/lib/request-helpers.ts::maskSecret --> <!-- @test: src/__tests__/lib/request-helpers.test.ts (maskSecret describe) -->
2. When no operator encryption key is configured, a CRITICAL-severity warning is emitted on the first request. <!-- @impl: src/lib/kv-crypto.ts::warnIfNoEncryptionKey --> <!-- @test: src/__tests__/lib/warn-if-no-encryption-key.test.ts (warnIfNoEncryptionKey describe) -->
3. Non-secret persistent storage entries (preferences, sessions, user records, setup state, storage stats) remain plaintext. <!-- @impl: src/lib/kv-crypto.ts --> <!-- @test: src/__tests__/lib/warn-if-no-encryption-key.test.ts (plaintext KV allowlist describe) -->

**Constraints:**

- The plaintext allowlist is explicit. New KV namespaces are encrypted by default; adding to the plaintext allowlist requires a security-review sign-off.

**Priority:** P0

**Dependencies:** [REQ-SEC-004](#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** [Automated test](../../src/__tests__/lib/request-helpers.test.ts)

**Status:** Implemented

---

### REQ-SEC-019: Per-endpoint rate-limit policy

**Intent:** Specific endpoint families have specific limits (WebSocket, session caps), and security-critical endpoints fail closed while resource-protection endpoints fail open. Stress-test mode bypasses everything with a warning so load testing can saturate without changing code.

**Applies To:** User

**Acceptance Criteria:**

1. WebSocket connections are rate-limited at 30 per 60-second window per user. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/lib/cross-package-constants.test.ts (Cross-Package Constants describe → AC1 WS 30/60s budget) -->
2. Per-user concurrent session caps are enforced: 3 for standard users, 10 for admins. <!-- @impl: src/lib/constants.ts::getMaxSessions --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (Session limits describe → AC2 MAX_SESSIONS) -->
3. Security-critical endpoints (request-access, Turnstile verification) use fail-closed rate limiting: persistent-storage failure returns 503 instead of allowing the request. <!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit --> <!-- @test: src/__tests__/middleware/rate-limit-fallback.test.ts (checkRateLimit failClosed semantics describe → AC3 fail-closed) -->
4. General resource-protection endpoints use fail-open rate limiting (per [AD6](../../documentation/decisions/README.md#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity)). <!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit --> <!-- @test: src/__tests__/middleware/rate-limit-fallback.test.ts (rate-limit fallback describe → AC4 fail-open) -->
5. In stress-test deployment mode, all rate limits are bypassed with a one-time warning per worker instance. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter describe → AC5 STRESS_TEST_MODE bypass) -->

**Constraints:**

- Stress-test mode must not be active in SaaS deployments; the combination returns 503 to all requests.

**Priority:** P0

**Dependencies:** [REQ-SEC-007](#req-sec-007-rate-limiting-infrastructure)

**Verification:** [Automated test](../../src/__tests__/lib/cross-package-constants.test.ts)

**Status:** Implemented

---

### REQ-SEC-020: WS-upgrade rate-limit short-circuits

**Intent:** WebSocket reconnect storms during container hibernation or warm-up must not exhaust the user's 30/60s WS budget. Two pre-rate-limit gates short-circuit the upgrade with explicit close codes so the client can back off without losing its budget.

**Applies To:** User

**Acceptance Criteria:**

1. WebSocket upgrade requests for stopped sessions are rejected before the WS rate-limit check runs, so a reconnect storm against a hibernated container does not consume the user's 30/60s WS budget. The close code conveys "container stopped" to the client. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @impl: src/lib/rate-limit-core.ts::checkRateLimit --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (CF-015 Stopped session returns 4503 describe) -->
2. WebSocket upgrade requests are rejected before the rate-limit check when the container's terminal service is not yet ready; the close code conveys "container warming up". The readiness probe is best-effort: probe errors fall through to the normal rate-limit + forward path. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade --> <!-- @test: src/__tests__/routes/terminal-ws.test.ts (container-warming-up gate describe) -->

**Constraints:**

- The order is load-bearing: the short-circuits run BEFORE the rate limiter so the user budget is preserved across hibernation/warm-up.

**Priority:** P0

**Dependencies:** [REQ-SEC-007](#req-sec-007-rate-limiting-infrastructure), [REQ-SEC-019](#req-sec-019-per-endpoint-rate-limit-policy)

**Verification:** [Automated test](../../src/__tests__/routes/terminal-ws.test.ts)

**Status:** Implemented

---

### REQ-SEC-021: HSTS coverage on redirect response paths

**Intent:** The HSTS header coverage in [REQ-SEC-008](#req-sec-008-security-headers-on-every-response) AC1 must extend to every redirect emission path. Without a dedicated helper, redirects emitted from `Response.redirect()` or middleware shortcuts would drop the security header set the global middleware applies.

**Applies To:** User

**Acceptance Criteria:**

1. All redirect responses carry the full security header set, including HSTS. <!-- @impl: src/index.ts::redirectWithHeaders --> <!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → security-headers job exercises redirect paths) --> <!-- @test: src/__tests__/redirect-with-headers.test.ts (helper round-trip) -->

**Constraints:**

- All redirect responses must carry the full security header set.

**Priority:** P0

**Dependencies:** [REQ-SEC-008](#req-sec-008-security-headers-on-every-response)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented
