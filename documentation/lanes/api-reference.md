# API Reference

Complete API endpoint reference for the Codeflare Worker.

**Audience:** Developers

## Contents

- [Session Management](#session-management)
- [Container Lifecycle](#container-lifecycle)
- [Terminal](#terminal)
- [User Management](#user-management)
- [Auth (SaaS Mode)](#auth-saas-mode)
- [Usage](#usage)
- [Admin](#admin)
- [Billing](#billing)
- [Deploy Keys](#deploy-keys)
- [Public (Unauthenticated)](#public-unauthenticated)
- [Setup](#setup)
- [Storage (R2 File Browser)](#storage-r2-file-browser)
- [Presets](#presets)
- [Preferences](#preferences)
- [LLM API Keys](#llm-api-keys)
- [Public (Onboarding)](#public-onboarding)
- [Health](#health)

---

### Common Response Headers

| Header | Description |
|--------|-------------|
| `X-Request-ID` | Unique request identifier (UUID) |
| `X-RateLimit-Limit` | Max requests per window (rate-limited endpoints) |
| `X-RateLimit-Remaining` | Requests remaining (rate-limited endpoints) |

### Error Response Format

```json
{ "error": "User-friendly message", "code": "ERROR_CODE" }
```

Codes: `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `CONTAINER_ERROR` (500), `AUTH_ERROR` (401), `FORBIDDEN` (403), `SETUP_ERROR` (400), `RATE_LIMIT_ERROR` (429), `QUOTA_EXCEEDED` (402), `CIRCUIT_BREAKER_OPEN` (503).

Note: `SETUP_ERROR` uses a different response shape: `{ success: false, steps, error, code }` instead of the standard `{ error, code }`.

### Session Management

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/sessions` | Session cookie | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard) | List sessions |
| POST | `/api/sessions` | Session cookie | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard) | Create session (rate limited) |
| GET | `/api/sessions/:id` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions) | Get session |
| PATCH | `/api/sessions/:id` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions), [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard) | Update session |
| DELETE | `/api/sessions/:id` | Session cookie | [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard), [REQ-SESSION-014](../../sdd/spec/session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings) | Delete session and destroy container |
| POST | `/api/sessions/:id/touch` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions) | Update lastAccessedAt |
| POST | `/api/sessions/:id/stop` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions), [REQ-SESSION-014](../../sdd/spec/session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings) | Stop session (KV 'stopped' + container.destroy()) |
| GET | `/api/sessions/:id/status` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions), [REQ-OPS-006](../../sdd/spec/operations.md#req-ops-006-idle-containers-hibernate-and-cost-zero) | Get session and container status |
| GET | `/api/sessions/batch-status` | Session cookie | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-OPS-006](../../sdd/spec/operations.md#req-ops-006-idle-containers-hibernate-and-cost-zero) | Batch status for all sessions (status, ptyActive, lastActiveAt, lastStartedAt, metrics, maxSessions, storageStats from KV cache, usage piggyback in SaaS mode) |

### Container Lifecycle

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| POST | `/api/container/start` | Session cookie | [REQ-SESSION-007](../../sdd/spec/session-lifecycle.md#req-session-007-running-session-count-limited-per-tier) | Start container (non-blocking) |
| POST | `/api/container/destroy` | Session cookie | [REQ-SESSION-014](../../sdd/spec/session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings) | Destroy container (SIGKILL) |
| GET | `/api/container/startup-status` | Session cookie | [REQ-SESSION-007](../../sdd/spec/session-lifecycle.md#req-session-007-running-session-count-limited-per-tier), [REQ-OPS-006](../../sdd/spec/operations.md#req-ops-006-idle-containers-hibernate-and-cost-zero) | Poll startup progress |
| GET | `/api/container/health` | Session cookie | [REQ-OPS-006](../../sdd/spec/operations.md#req-ops-006-idle-containers-hibernate-and-cost-zero) | Health check |

### Terminal

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| WS | `/api/terminal/:compoundId/ws` | Session cookie | [REQ-TERM-001](../../sdd/spec/terminal.md#req-term-001-up-to-6-terminal-tabs-per-session), [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002-websocket-connection-to-container-pty), [REQ-SESSION-012](../../sdd/spec/session-lifecycle.md#req-session-012-wake-loop-prevention) | Terminal WebSocket (compoundId format: `sessionId-terminalId`) |
| GET | `/api/terminal/:sessionId/status` | Session cookie | [REQ-TERM-004](../../sdd/spec/terminal.md#req-term-004-close-code-4503-is-authoritative-no-retry) | Connection status |

### User Management

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/user` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel) | Authenticated user info (includes `onboardingActive`, `onboardingComplete`) |
| POST | `/api/user/onboarding-complete` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-006](../../sdd/spec/authentication.md#req-auth-006-user-email-normalized) | Mark guided setup as visited (sets KV flag) |
| GET | `/api/user/r2-status` | Session cookie (admin-only routes require admin role) | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket) | R2 credential status for current user |
| POST | `/api/user/ensure-r2-token` | Session cookie (admin-only routes require admin role) | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket) | Create scoped R2 token if missing (rate limited) |
| GET | `/api/users` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel) | List allowed users (admin only) |
| DELETE | `/api/users/:email` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel) | Remove allowed user (admin only) |
| PATCH | `/api/users/:email` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel), [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel) | Update user tier/role (admin only) |

### Auth (SaaS Mode)

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/auth/providers` | varies | [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-008](../../sdd/spec/authentication.md#req-auth-008-session-cookie-auto-refresh) | List configured IdPs (public, no auth) |
| GET | `/api/auth/status` | varies | [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-SUB-018](../../sdd/spec/subscription.md#req-sub-018-usage-dashboard-page) | Auth status (tier, email, role, turnstile key, session/billing state) |
| GET | `/api/auth/tiers` | varies | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel) | Subscribable tier configs (requires identity) |
| GET | `/api/auth/onboarding-config` | varies | [REQ-AUTH-006](../../sdd/spec/authentication.md#req-auth-006-user-email-normalized) | Onboarding page config (turnstile key) |
| POST | `/api/auth/subscribe` | varies | [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003-free-tier-requires-no-payment) | Self-service tier selection (rate-limited 3/min) |
| POST | `/api/auth/request-access` | varies | [REQ-AUTH-006](../../sdd/spec/authentication.md#req-auth-006-user-email-normalized), [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) | Request access with Turnstile (rate-limited 3/hr) |
| POST | `/api/auth/contact-team` | varies | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel), [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) | Enterprise tier inquiry email (rate-limited 1/hr) |

### Usage

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/usage` | Session cookie | [REQ-SUB-018](../../sdd/spec/subscription.md#req-sub-018-usage-dashboard-page) | Current user's real-time usage (Timekeeper DO with KV fallback) |

### Admin

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/admin/tiers` | Admin role | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel), [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel) | Get current tier config (admin only) |
| PUT | `/api/admin/tiers` | Admin role | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel), [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel) | Update tier config (admin only, 8-tier array) |
| PUT | `/api/users/max-users` | Admin role | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel), [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel) | Set max users capacity cap (admin only) |

### Billing

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| POST | `/api/billing/checkout` | Session cookie | [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003-free-tier-requires-no-payment), [REQ-SUB-004](../../sdd/spec/subscription.md#req-sub-004-paid-tiers-integrate-with-stripe-checkout) | Create Stripe Checkout Session for paid tier (rate-limited 5/min) |
| GET | `/api/billing/status` | Session cookie | [REQ-SUB-016](../../sdd/spec/subscription.md#req-sub-016-customer-portal-and-plan-switching), [REQ-SUB-018](../../sdd/spec/subscription.md#req-sub-018-usage-dashboard-page) | Live billing state from Stripe (subscription, period, status) |
| POST | `/api/billing/portal` | Session cookie | [REQ-SUB-011](../../sdd/spec/subscription.md#req-sub-011-graceful-degradation-without-stripe) | Create Stripe Customer Portal session (rate-limited 5/min) |
| POST | `/api/billing/switch` | Session cookie | [REQ-SUB-011](../../sdd/spec/subscription.md#req-sub-011-graceful-degradation-without-stripe) | Deep-link portal for plan change confirmation (rate-limited 5/min) |
| POST | `/public/stripe/webhook` | Session cookie | [REQ-SUB-005](../../sdd/spec/subscription.md#req-sub-005-trial-is-compute-based-not-time-based), [REQ-SUB-015](../../sdd/spec/subscription.md#req-sub-015-stripe-webhook-signal-and-sync-pattern), [REQ-SUB-021](../../sdd/spec/subscription.md#req-sub-021-billing-cycle-alignment) | Stripe webhook handler (unauthenticated, HMAC-verified, rate-limited 100/min) |

### Deploy Keys

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/deploy-keys` | Session cookie | [REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token), [REQ-AGENT-018](../../sdd/spec/agents.md#req-agent-018-push-deploy-credential-management-ui) | Get encrypted deploy credentials (masked) |
| PUT | `/api/deploy-keys` | Session cookie | [REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token), [REQ-AGENT-018](../../sdd/spec/agents.md#req-agent-018-push-deploy-credential-management-ui) | Save/update deploy credentials (GitHub PAT, CF API token) |
| DELETE | `/api/deploy-keys` | Session cookie | [REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token), [REQ-AGENT-018](../../sdd/spec/agents.md#req-agent-018-push-deploy-credential-management-ui) | Erase all deploy credentials |

### Public (Unauthenticated)

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/public/auth/providers` | none | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence), [REQ-AUTH-008](../../sdd/spec/authentication.md#req-auth-008-session-cookie-auto-refresh) | Auth providers (outside CF Access gate) |
| GET | `/public/onboarding-config` | none | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence), [REQ-AUTH-006](../../sdd/spec/authentication.md#req-auth-006-user-email-normalized) | Turnstile site key + onboarding status |
| GET | `/public/tiers` | none | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence), [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel) | Public tier config (no session mode info) |
| POST | `/public/waitlist` | none | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence), [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) | Waitlist signup with Turnstile (rate-limited 1/day by IP) |

### Setup

The setup wizard configures a fresh Codeflare deployment. It provisions Cloudflare resources (R2 credentials, DNS records, Access applications) and stores the resulting configuration in Workers KV so the application can serve requests.

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| POST | `/api/setup/configure` | Public (pre-setup); admin (post-setup) | [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001-first-time-setup-requires-zero-pre-configuration), [REQ-SETUP-005](../../sdd/spec/setup.md#req-setup-005-post-setup-reconfiguration-requires-admin-auth) | Run the setup wizard (streams NDJSON progress) |
| GET | `/api/setup/status` | Public | [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001-first-time-setup-requires-zero-pre-configuration) | Whether setup is complete (always public) |
| GET | `/api/setup/detect-token` | Public (pre-setup); admin (post-setup) | [REQ-SETUP-005](../../sdd/spec/setup.md#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-SETUP-008](../../sdd/spec/setup.md#req-setup-008-setup-helper-endpoints-support-prefill-and-detection) | Detect and verify the Cloudflare API token |
| GET | `/api/setup/prefill` | Public (pre-setup); admin (post-setup) | [REQ-SETUP-005](../../sdd/spec/setup.md#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-SETUP-008](../../sdd/spec/setup.md#req-setup-008-setup-helper-endpoints-support-prefill-and-detection) | Prefill setup form from existing Access groups |

Conditional auth: before `setup:complete` is set in KV, every Setup endpoint except `/api/setup/status` is publicly reachable through the CSRF-gated bootstrap window (see AD10). Once setup is marked complete, the same endpoints require an admin-role session.

#### When Setup Runs

| Scenario | Auth requirement | Entry point |
|---|---|---|
| **First-time setup** (`setup:complete` not set in KV) | Public -- no authentication required | `POST /api/setup/configure` |
| **Reconfigure** (`setup:complete` is `"true"`) | Admin auth via Cloudflare Access | `POST /api/setup/configure` |

The conditional auth middleware in `src/routes/setup/index.ts` checks `KV.get('setup:complete')` on every request. When the value is `"true"`, the request must pass through `authMiddleware` and `requireAdmin` before reaching the configure handler.

#### Request Format

```
POST /api/setup/configure
Content-Type: application/json

{
  "customDomain":   "claude.example.com",
  "allowedUsers":   ["alice@example.com", "bob@example.com"],
  "adminUsers":     ["alice@example.com"],
  "allowedOrigins": [".example.com"]          // optional
}
```

Validation rules (enforced by Zod before streaming starts):

- `customDomain` -- non-empty string matching a valid domain pattern.
- `allowedUsers` -- non-empty array of valid email addresses.
- `adminUsers` -- non-empty array of valid emails; every admin must also appear in `allowedUsers`.
- `allowedOrigins` -- optional array of domain suffix patterns (each must start with `.`).

The Cloudflare API token is read from the `CLOUDFLARE_API_TOKEN` environment binding, not from the request body.

#### Configuration Steps

The configure endpoint runs steps sequentially, streaming progress over NDJSON.

**Step 1 -- `get_account`**

**Source:** `src/routes/setup/account.ts`

Calls `GET /accounts` on the Cloudflare API to retrieve the account ID associated with the API token. The first account in the response is used.

**Step 2 -- `derive_r2_credentials`**

**Source:** `src/routes/setup/credentials.ts`

Derives S3-compatible R2 credentials from the existing API token without needing extra permissions:

- **Access Key ID** = the token's own ID (from `GET /user/tokens/verify`).
- **Secret Access Key** = hex-encoded SHA-256 hash of the raw token value.

**Step 3 -- `set_secrets`**

**Source:** `src/routes/setup/secrets.ts`

Sets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as Worker secrets via `PUT /accounts/{id}/workers/scripts/{name}/secrets`.

If the API returns error code `10215` (latest version not deployed -- common after `wrangler versions upload`), the handler deploys the latest Worker version at 100% traffic and retries the secret write.

**Step 3a -- `cleanup_stale_users` (conditional)**

Runs only when reconfiguring and the new `allowedUsers` list has removed previously allowed users. Performs full cleanup of each stale user's KV entries and associated data.

**Step 4 -- `configure_custom_domain`**

**Source:** `src/routes/setup/custom-domain.ts`

1. **Zone resolution** -- looks up the Cloudflare zone ID by trying progressively shorter domain suffixes (supports ccTLDs like `.co.uk`).
2. **DNS upsert** -- creates or updates a proxied CNAME record pointing the custom domain to `{workerName}.{accountSubdomain}.workers.dev`.
3. **Worker route** -- creates the route pattern `{customDomain}/*` mapped to the worker script. Handles "already exists" errors by updating the existing route.

**Step 5 -- `create_access_app`**

**Source:** `src/routes/setup/access.ts`

**When GitHub OIDC is NOT configured** (default, onboarding, SaaS without `OAUTH_CLIENT_ID`):
1. Upserts two Cloudflare Access groups scoped to the worker name:
   - `{workerName}-admins` -- contains admin emails.
   - `{workerName}-users` -- contains non-admin allowed emails (created only when there are non-admin users).
2. Prunes legacy Access apps that used older domain patterns.
3. Creates or updates a self-hosted Access application protecting `/app/*` (primary), `/app`, `/api/*`, `/setup`, and `/setup/*` via the `destinations` field.
4. Upserts an "Allow users" policy referencing both groups.
5. Stores Access configuration in KV (audience tag, group IDs, auth domain).

**When GitHub OIDC IS configured** (`SAAS_MODE=active` + `OAUTH_CLIENT_ID`):
CF Access groups and policies are not created — the Worker handles authentication directly via GitHub OAuth session cookies. Admin users created via allowedUsers are assigned the Custom tier automatically.

**Step 6 -- `configure_turnstile` (conditional)**

**Source:** `src/routes/setup/turnstile.ts`

Runs only when the `ONBOARDING_LANDING_PAGE` env var is active OR SaaS mode is enabled. Creates or updates a Turnstile widget in `managed` mode for the custom domain (and the workers.dev hostname). Stores the site key and secret in KV.

**Step 7 -- `finalize`**

Writes final KV state and marks setup as complete.

#### NDJSON Stream Contract

The response uses content type `application/x-ndjson`. Each line is a self-contained JSON object terminated by `\n`.

**Progress messages**

```json
{"step":"get_account","status":"running"}
{"step":"get_account","status":"success"}
{"step":"derive_r2_credentials","status":"running"}
{"step":"derive_r2_credentials","status":"success"}
```

Status values for in-progress steps:

| Value | Meaning |
|---|---|
| `running` | Step has started |
| `success` | Step completed successfully |
| `error` | Step failed; includes an `error` field with the message |

**Completion message**

Every stream ends with exactly one completion object containing `done: true`.

**Success:**

```json
{
  "done": true,
  "success": true,
  "steps": [
    {"step":"get_account","status":"success"},
    {"step":"derive_r2_credentials","status":"success"},
    ...
  ],
  "workersDevUrl": "https://codeflare.account.workers.dev",
  "customDomainUrl": "https://claude.example.com"
}
```

**Failure:**

```json
{
  "done": true,
  "success": false,
  "steps": [
    {"step":"get_account","status":"success"},
    {"step":"derive_r2_credentials","status":"error","error":"Token verification failed"}
  ],
  "error": "Token verification failed"
}
```

**Detecting completion**

Read lines from the stream until you parse an object where `done === true`. Then check `success` to determine the outcome. The `steps` array provides the cumulative status of every step attempted, including which step failed and the error message.

**Detecting lock contention**

If another configure run is already in progress, the stream immediately emits:

```json
{"done":true,"success":false,"error":"Setup configuration is already in progress. Please wait and try again."}
```

No step progress messages are sent in this case.

#### Error Recovery

**Per-step retry**

Each Cloudflare API call is wrapped in `withSetupRetry` (exponential backoff, up to 3 total attempts with a 1 s base delay). `CircuitBreakerOpenError` is not retried because the circuit breaker is already open and retrying immediately would be wasteful.

**Step failure**

When any step throws, the error is caught by the top-level handler which:

1. Sends a completion message with `success: false` and the error details.
2. Releases the configure lock.
3. Closes the writable stream.

Partial progress from earlier successful steps remains in KV. Setup is **not** marked complete, so the next call to `/api/setup/configure` can retry from the beginning.

**Lock mechanism**

A KV-based lock prevents concurrent configure runs:

| Key | Value | TTL |
|---|---|---|
| `setup:configuring` | Unix timestamp (ms) as string | 300 s |

Before starting, the handler checks for an existing lock:

- If the lock exists and is less than 60 seconds old, the request is rejected immediately.
- If the lock exists but is older than 60 seconds, it is treated as stale and overridden (logged as a warning).
- The lock is deleted in the `finally` block regardless of success or failure.
- The KV TTL of 300 s acts as a safety net if the worker crashes before cleanup.

**How to retry**

The client can simply re-submit the same `POST /api/setup/configure` request. All steps are idempotent -- they create-or-update resources rather than assuming a clean slate. If a previous run partially completed, the retry will update existing resources and continue.

#### KV State Management

The following KV keys are written during setup. All keys use the `setup:` prefix.

| KV Key | Written by | Value |
|---|---|---|
| `setup:complete` | finalize | `"true"` |
| `setup:account_id` | finalize | Cloudflare account ID |
| `setup:r2_endpoint` | finalize | `https://{accountId}.r2.cloudflarestorage.com` |
| `setup:completed_at` | finalize | ISO 8601 timestamp |
| `setup:custom_domain` | post-step-5 | Lowercased custom domain |
| `setup:allowed_origins` | post-step-5 | JSON array of origin suffix patterns |
| `setup:onboarding_landing_page` | post-step-5 | `"active"` or `"inactive"` |
| `setup:configuring` | lock acquire | Unix timestamp (ms); deleted on completion |
| `setup:access_aud` | step 5 | Primary Access audience tag |
| `setup:access_aud_list` | step 5 | JSON array of audience tags |
| `setup:access_app_id` | step 5 | Access application ID |
| `setup:access_group_admin_id` | step 5 | Admin Access group ID |
| `setup:access_group_user_id` | step 5 | User Access group ID |
| `setup:access_group_admin_name` | step 5 | Admin group name (`{worker}-admins`) |
| `setup:access_group_user_name` | step 5 | User group name (`{worker}-users`) |
| `setup:auth_domain` | step 5 | Access organization auth domain |
| `setup:turnstile_site_key` | step 6 | Turnstile widget site key |
| `setup:turnstile_secret_key` | step 6 | Turnstile widget secret |
| `setup:idp_list` | step 5 | JSON array of IdP objects (id, type, name) |

User records are stored separately under the `user:{email}` key pattern with a JSON value containing `addedBy`, `addedAt`, `role` (`"admin"` or `"user"`), `subscriptionTier` (8 values), and legacy `accessTier`. Usage tracking data is stored at `timekeeper:{bucketName}`. Tier configuration is at `tiers:config`.

#### Authentication

**First-time setup**

When `setup:complete` is not set in KV, all setup endpoints are publicly accessible. This is necessary for bootstrapping -- no Access application exists yet to authenticate against.

**Subsequent reconfiguration**

Once `setup:complete` is `"true"`, the conditional auth middleware requires:

1. Valid authentication (CF Access JWT or OIDC session cookie, verified by `authMiddleware`).
2. The authenticated user must have the `admin` role (enforced by `requireAdmin`).

This applies to `POST /api/setup/configure`, `GET /api/setup/detect-token`, and `GET /api/setup/prefill`. The `GET /api/setup/status` endpoint is always public.

#### Helper Endpoints

**`GET /api/setup/status`**

Always public. Returns whether setup is complete and the custom domain if configured.

```json
{"configured": true, "customDomain": "claude.example.com", "saasMode": false}
```

**`GET /api/setup/detect-token`**

Checks whether `CLOUDFLARE_API_TOKEN` is present in the environment, verifies it against the Cloudflare API, and returns account info.

```json
{"detected": true, "valid": true, "account": {"id": "abc123", "name": "My Account"}}
```

**`GET /api/setup/prefill`**

Best-effort prefill for the setup form. Reads existing admin and user lists from Cloudflare Access groups (scoped by worker name). Does not prefill the custom domain.

In SaaS mode, returns empty arrays — admin enters everything manually.

```json
{"adminUsers": ["alice@example.com"], "allowedUsers": ["bob@example.com"]}
```

#### Rate Limiting

| Endpoint | Window | Max requests | Key prefix |
|---|---|---|---|
| `/api/setup/configure` | 60 s | 5 | `setup-configure` |
| `/api/setup/status` | 60 s | 30 | `setup-status` |
| `/api/setup/detect-token` | 60 s | 10 | `setup-detect-token` |
| `/api/setup/prefill` | 60 s | 10 | `setup-prefill` |

Note: `/api/setup/detect-token` and `/api/setup/prefill` are also subject to the shared `setupRateLimiter` (5/min, key prefix `setup-configure`) applied as middleware. The effective limit is 5/min for these endpoints during the setup flow.

### Storage (R2 File Browser)

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/storage/browse` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser) | List objects in R2 prefix |
| POST | `/api/storage/upload` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser), [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Upload file |
| GET | `/api/storage/download` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser), [REQ-SEC-013](../../sdd/spec/security.md#req-sec-013-content-disposition-hardening-on-downloads) | Download file |
| POST | `/api/storage/delete` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser) | Delete objects by key and/or prefix (server-side bulk delete) |
| GET | `/api/storage/preview` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser) | Preview file content (text files inline, others return metadata only) |
| GET | `/api/storage/stats` | Session cookie | [REQ-STOR-006](../../sdd/spec/storage.md#req-stor-006-storage-quota-enforced-per-tier-at-session-start), [REQ-STOR-014](../../sdd/spec/storage.md#req-stor-014-r2-storage-stats-caching) | File/folder counts (60s KV cache, refreshes from R2 on miss/stale) |
| POST | `/api/storage/seed/getting-started` | Session cookie | [REQ-STOR-009](../../sdd/spec/storage.md#req-stor-009-getting-started-docs-auto-seeded-on-first-session) | Seed tutorial docs |
| POST | `/api/storage/seed/agent-configs` | Session cookie | [REQ-AGENT-011](../../sdd/spec/agents.md#req-agent-011-agent-skills-rules-manually-recreatable-from-settings), [REQ-STOR-009](../../sdd/spec/storage.md#req-stor-009-getting-started-docs-auto-seeded-on-first-session) | Recreate AI agent skills & rules (overwrites, respects session mode) |
| POST | `/api/storage/upload/initiate` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Initiate multipart upload |
| POST | `/api/storage/upload/part` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Upload a single part (base64 body) |
| POST | `/api/storage/upload/complete` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Complete multipart upload |
| POST | `/api/storage/upload/abort` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Abort multipart upload |

### Presets

GET `/api/presets`, POST `/api/presets`, PATCH `/api/presets/:id` (rename), DELETE `/api/presets/:id`

### Preferences

GET `/api/preferences`, PATCH `/api/preferences`

`UserPreferences` fields: `lastAgentType` (AgentType, optional — last selected agent), `lastPresetId` (string, optional — last used preset), `workspaceSyncEnabled` (boolean, default: `false` — workspace sync toggle, disabled by default), `fastStartEnabled` (boolean, default: `true` — fast CLI start toggle), `sessionMode` (SessionMode, optional — default/advanced), `sleepAfter` (SleepAfterOption, optional — auto-sleep duration, see [Auto-sleep](container.md#auto-sleep-configurable-sleepafter)), `userTimezone` (string, optional — valid IANA timezone, max 64 chars; validated via `Intl.DateTimeFormat` round-trip, invalid zones return `ValidationError`; persisted to DO storage and forwarded to the container as `USER_TIMEZONE` env var so memory-capture filenames reflect the user's local time; takes effect on next session start — see [REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env) and [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) AC9). The `fastStartEnabled` preference maps to `FAST_CLI_START` env var in the container DO -- see [Fast Start](container.md#fast-start). **Side effect:** when `sessionMode` changes, `PATCH /api/preferences` calls `reconcileAgentConfigs(overwrite: true, cleanup: true)` to seed the correct preseed set for the new mode. Non-fatal — failure does not block the preference save. Implements [REQ-AGENT-004](../../sdd/spec/agents.md#req-agent-004-two-session-modes-standard-and-pro) AC4–AC5.

### LLM API Keys

GET `/api/llm-keys` — returns masked keys (`****` + last 4 chars), never full keys.
PUT `/api/llm-keys` — set or clear keys. Body: `{ openaiApiKey?: string | null, geminiApiKey?: string | null }`. `null` deletes the key, `undefined`/omitted = no change, string = set. Returns masked keys. When `ENCRYPTION_KEY` is set, values are encrypted with AES-256-GCM before KV storage.
DELETE `/api/llm-keys` — removes all LLM keys from KV.

Keys are stored in KV as `llm-keys:{bucketName}` and scoped per user (derived from auth). On container start, keys are read from KV and injected as `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars. The `entrypoint.sh` detects these env vars and configures the `consult-llm-mcp` MCP server in `~/.claude.json`. The LLM Keys accordion in Settings is only visible when the user can use advanced mode (`canUseAdvanced()`) AND has selected advanced session mode (`currentSessionMode() === 'advanced'`). Admins always qualify for advanced mode but must still select it.

### Public (Onboarding)

GET `/public/onboarding-config`, POST `/public/waitlist` (rate limited)

### Health

| Method | Endpoint | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/health` | None (auth-exempt — no `CONTAINER_AUTH_TOKEN` required) | [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition) AC1, AC2 | Direct host health check; available before CONTAINER_AUTH_TOKEN is wired up |
| GET | `/api/health` | Session cookie | [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition) AC1, AC2 | Worker-proxied alias for `/health` |

Both endpoints return the same JSON body:

```json
{
  "status": "healthy",
  "sessions": 0,
  "uptime": 42,
  "syncStatus": "idle",
  "syncError": null,
  "userPath": "/root",
  "prewarmReady": false,
  "initFlagObserved": false,
  "cpu": 12.5,
  "mem": 45.2,
  "hdd": 30.1,
  "timestamp": "2026-05-15T10:00:00.000Z"
}
```

**`initFlagObserved`** — `true` once the server has seen `/tmp/codeflare-init-complete` written by `entrypoint.sh` at the end of R2 sync. A session where `prewarmReady: false` and `initFlagObserved: false` indicates the init-complete flag was never written (sync hung, `jq` merge failed, etc.). See [Container Startup](container.md#startup-sequence) and [Troubleshooting](troubleshooting.md#container-stuck-at-waiting-for-services).

**`prewarmReady`** — `true` once the tab-1 PTY session has produced its first output (pre-warm complete).

---

## Related Documentation
- [Authentication](authentication.md#three-tier-auth-middleware) - Auth middleware details
- [Security](security.md#rate-limiting) - Rate limits per endpoint
- [Configuration](configuration.md#worker-environment) - Environment variables
