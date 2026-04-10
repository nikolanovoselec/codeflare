# API Reference

Complete API endpoint reference for the Codeflare Worker.

**Audience:** Developers

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

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create session (rate limited) |
| GET | `/api/sessions/:id` | Get session |
| PATCH | `/api/sessions/:id` | Update session |
| DELETE | `/api/sessions/:id` | Delete session and destroy container |
| POST | `/api/sessions/:id/touch` | Update lastAccessedAt |
| POST | `/api/sessions/:id/stop` | Stop session (KV 'stopped' + container.destroy()) |
| GET | `/api/sessions/:id/status` | Get session and container status |
| GET | `/api/sessions/batch-status` | Batch status for all sessions (status, ptyActive, lastActiveAt, lastStartedAt, metrics, maxSessions, storageStats from KV cache, usage piggyback in SaaS mode) |

### Container Lifecycle

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/container/start` | Start container (non-blocking) |
| POST | `/api/container/destroy` | Destroy container (SIGKILL) |
| GET | `/api/container/startup-status` | Poll startup progress |
| GET | `/api/container/health` | Health check |

### Terminal

| Method | Endpoint | Description |
|--------|----------|-------------|
| WS | `/api/terminal/:compoundId/ws` | Terminal WebSocket (compoundId format: `sessionId-terminalId`) |
| GET | `/api/terminal/:sessionId/status` | Connection status |

### User Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/user` | Authenticated user info (includes `onboardingActive`, `onboardingComplete`) |
| POST | `/api/user/onboarding-complete` | Mark guided setup as visited (sets KV flag) |
| GET | `/api/user/r2-status` | R2 credential status for current user |
| POST | `/api/user/ensure-r2-token` | Create scoped R2 token if missing (rate limited) |
| GET | `/api/users` | List allowed users (admin only) |
| DELETE | `/api/users/:email` | Remove allowed user (admin only) |
| PATCH | `/api/users/:email` | Update user tier/role (admin only) |

### Auth (SaaS Mode)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/providers` | List configured IdPs (public, no auth) |
| GET | `/api/auth/status` | Auth status (tier, email, role, turnstile key, session/billing state) |
| GET | `/api/auth/tiers` | Subscribable tier configs (requires identity) |
| GET | `/api/auth/onboarding-config` | Onboarding page config (turnstile key) |
| POST | `/api/auth/subscribe` | Self-service tier selection (rate-limited 3/min) |
| POST | `/api/auth/request-access` | Request access with Turnstile (rate-limited 3/hr) |
| POST | `/api/auth/contact-team` | Enterprise tier inquiry email (rate-limited 1/hr) |

### Usage

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/usage` | Current user's real-time usage (Timekeeper DO with KV fallback) |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/tiers` | Get current tier config (admin only) |
| PUT | `/api/admin/tiers` | Update tier config (admin only, 8-tier array) |
| PUT | `/api/users/max-users` | Set max users capacity cap (admin only) |

### Billing

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/billing/checkout` | Create Stripe Checkout Session for paid tier (rate-limited 5/min) |
| GET | `/api/billing/status` | Live billing state from Stripe (subscription, period, status) |
| POST | `/api/billing/portal` | Create Stripe Customer Portal session (rate-limited 5/min) |
| POST | `/api/billing/switch` | Deep-link portal for plan change confirmation (rate-limited 5/min) |
| POST | `/public/stripe/webhook` | Stripe webhook handler (unauthenticated, HMAC-verified, rate-limited 100/min) |

### Deploy Keys

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/deploy-keys` | Get encrypted deploy credentials (masked) |
| PUT | `/api/deploy-keys` | Save/update deploy credentials (GitHub PAT, CF API token) |
| DELETE | `/api/deploy-keys` | Erase all deploy credentials |

### Public (Unauthenticated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/public/auth/providers` | Auth providers (outside CF Access gate) |
| GET | `/public/onboarding-config` | Turnstile site key + onboarding status |
| GET | `/public/tiers` | Public tier config (no session mode info) |
| POST | `/public/waitlist` | Waitlist signup with Turnstile (rate-limited 1/day by IP) |

### Setup

The setup wizard configures a fresh Codeflare deployment. It provisions Cloudflare resources (R2 credentials, DNS records, Access applications) and stores the resulting configuration in Workers KV so the application can serve requests.

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

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/storage/browse` | List objects in R2 prefix |
| POST | `/api/storage/upload` | Upload file |
| GET | `/api/storage/download` | Download file |
| POST | `/api/storage/delete` | Delete objects by key and/or prefix (server-side bulk delete) |
| GET | `/api/storage/preview` | Preview file content (text files inline, others return metadata only) |
| GET | `/api/storage/stats` | File/folder counts (60s KV cache, refreshes from R2 on miss/stale) |
| POST | `/api/storage/seed/getting-started` | Seed tutorial docs |
| POST | `/api/storage/seed/agent-configs` | Recreate AI agent skills & rules (overwrites, respects session mode) |
| POST | `/api/storage/upload/initiate` | Initiate multipart upload |
| POST | `/api/storage/upload/part` | Upload a single part (base64 body) |
| POST | `/api/storage/upload/complete` | Complete multipart upload |
| POST | `/api/storage/upload/abort` | Abort multipart upload |

### Presets

GET `/api/presets`, POST `/api/presets`, PATCH `/api/presets/:id` (rename), DELETE `/api/presets/:id`

### Preferences

GET `/api/preferences`, PATCH `/api/preferences`

`UserPreferences` fields: `lastAgentType` (AgentType, optional — last selected agent), `lastPresetId` (string, optional — last used preset), `workspaceSyncEnabled` (boolean, default: `false` — workspace sync toggle, disabled by default), `fastStartEnabled` (boolean, default: `true` — fast CLI start toggle), `sessionMode` (SessionMode, optional — default/advanced), `sleepAfter` (SleepAfterOption, optional — auto-sleep duration, see [Auto-sleep](container.md#auto-sleep-configurable-sleepafter)). The `fastStartEnabled` preference maps to `FAST_CLI_START` env var in the container DO -- see [Fast Start](container.md#fast-start). **Side effect:** when `sessionMode` changes, `PATCH /api/preferences` calls `reconcileAgentConfigs(overwrite: true, cleanup: true)` to seed the correct preseed set for the new mode. Non-fatal — failure does not block the preference save. Implements [REQ-AGENT-004](../sdd/agents.md#req-agent-004) AC4–AC5.

### LLM API Keys

GET `/api/llm-keys` — returns masked keys (`****` + last 4 chars), never full keys.
PUT `/api/llm-keys` — set or clear keys. Body: `{ openaiApiKey?: string | null, geminiApiKey?: string | null }`. `null` deletes the key, `undefined`/omitted = no change, string = set. Returns masked keys. When `ENCRYPTION_KEY` is set, values are encrypted with AES-256-GCM before KV storage.
DELETE `/api/llm-keys` — removes all LLM keys from KV.

Keys are stored in KV as `llm-keys:{bucketName}` and scoped per user (derived from auth). On container start, keys are read from KV and injected as `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars. The `entrypoint.sh` detects these env vars and configures the `consult-llm-mcp` MCP server in `~/.claude.json`. The LLM Keys accordion in Settings is only visible when the user can use advanced mode (`canUseAdvanced()`) AND has selected advanced session mode (`currentSessionMode() === 'advanced'`). Admins always qualify for advanced mode but must still select it.

### Public (Onboarding)

GET `/public/onboarding-config`, POST `/public/waitlist` (rate limited)

### Health

GET `/health`, GET `/api/health`

---

## Related Documentation
- [Authentication](authentication.md#three-tier-auth-middleware) - Auth middleware details
- [Security](security.md#rate-limiting) - Rate limits per endpoint
- [Configuration](configuration.md#worker-environment) - Environment variables
