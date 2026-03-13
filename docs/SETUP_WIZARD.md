# Setup Wizard

The setup wizard configures a fresh Codeflare deployment. It provisions Cloudflare
resources (R2 credentials, DNS records, Access applications) and stores the resulting
configuration in Workers KV so the application can serve requests.

## When it runs

| Scenario | Auth requirement | Entry point |
|---|---|---|
| **First-time setup** (`setup:complete` not set in KV) | Public -- no authentication required | `POST /api/setup/configure` |
| **Reconfigure** (`setup:complete` is `"true"`) | Admin auth via Cloudflare Access | `POST /api/setup/configure` |

The conditional auth middleware in `src/routes/setup/index.ts` checks
`KV.get('setup:complete')` on every request. When the value is `"true"`, the
request must pass through `authMiddleware` and `requireAdmin` before reaching
the configure handler.

## Request format

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
- `adminUsers` -- non-empty array of valid emails; every admin must also
  appear in `allowedUsers`.
- `allowedOrigins` -- optional array of domain suffix patterns (each must
  start with `.`).

The Cloudflare API token is read from the `CLOUDFLARE_API_TOKEN` environment
binding, not from the request body.

## Step flow

The configure endpoint runs steps sequentially, streaming progress over NDJSON.

### Step 1 -- `get_account`

**Source:** `src/routes/setup/account.ts`

Calls `GET /accounts` on the Cloudflare API to retrieve the account ID
associated with the API token. The first account in the response is used.

### Step 2 -- `derive_r2_credentials`

**Source:** `src/routes/setup/credentials.ts`

Derives S3-compatible R2 credentials from the existing API token without
needing extra permissions:

- **Access Key ID** = the token's own ID (from `GET /user/tokens/verify`).
- **Secret Access Key** = hex-encoded SHA-256 hash of the raw token value.

### Step 3 -- `set_secrets`

**Source:** `src/routes/setup/secrets.ts`

Sets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as Worker secrets via
`PUT /accounts/{id}/workers/scripts/{name}/secrets`.

If the API returns error code `10215` (latest version not deployed -- common
after `wrangler versions upload`), the handler deploys the latest Worker
version at 100 % traffic and retries the secret write.

### Step 3a -- `cleanup_stale_users` (conditional)

Runs only when reconfiguring and the new `allowedUsers` list has removed
previously allowed users. Performs full cleanup of each stale user's KV
entries and associated data.

### Step 4 -- `configure_custom_domain`

**Source:** `src/routes/setup/custom-domain.ts`

1. **Zone resolution** -- looks up the Cloudflare zone ID by trying
   progressively shorter domain suffixes (supports ccTLDs like `.co.uk`).
2. **DNS upsert** -- creates or updates a proxied CNAME record pointing
   the custom domain to `{workerName}.{accountSubdomain}.workers.dev`.
3. **Worker route** -- creates the route pattern `{customDomain}/*` mapped
   to the worker script. Handles "already exists" errors by updating the
   existing route.

### Step 5 -- `create_access_app`

**Source:** `src/routes/setup/access.ts`

1. Upserts two Cloudflare Access groups scoped to the worker name:
   - `{workerName}-admins` -- contains admin emails.
   - `{workerName}-users` -- contains non-admin allowed emails (created
     only when there are non-admin users).
2. Prunes legacy Access apps that used older domain patterns.
3. Creates or updates a self-hosted Access application protecting
   `/app/*` (primary), `/app`, `/api/*`, `/setup`, and `/setup/*` via
   the `destinations` field.
4. Upserts an "Allow users" policy referencing both groups.
5. Stores Access configuration in KV (audience tag, group IDs, auth
   domain).

### Step 6 -- `configure_turnstile` (conditional)

**Source:** `src/routes/setup/turnstile.ts`

Runs only when the `ONBOARDING_LANDING_PAGE` env var is active. Creates or
updates a Turnstile widget in `managed` mode for the custom domain (and the
workers.dev hostname). Stores the site key and secret in KV.

### Step 7 -- `finalize`

Writes final KV state and marks setup as complete. See [State
management](#state-management) for the full list of keys.

## NDJSON stream contract

The response uses content type `application/x-ndjson`. Each line is a
self-contained JSON object terminated by `\n`.

### Progress messages

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

### Completion message

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

### Detecting completion

Read lines from the stream until you parse an object where `done === true`.
Then check `success` to determine the outcome. The `steps` array provides the
cumulative status of every step attempted, including which step failed and the
error message.

### Detecting lock contention

If another configure run is already in progress, the stream immediately emits:

```json
{"done":true,"success":false,"error":"Setup configuration is already in progress. Please wait and try again."}
```

No step progress messages are sent in this case.

## Error recovery

### Per-step retry

Each Cloudflare API call is wrapped in `withSetupRetry` (exponential backoff,
up to 3 total attempts with a 1 s base delay). `CircuitBreakerOpenError` is
not retried because the circuit breaker is already open and retrying
immediately would be wasteful.

### Step failure

When any step throws, the error is caught by the top-level handler which:

1. Sends a completion message with `success: false` and the error details.
2. Releases the configure lock (see below).
3. Closes the writable stream.

Partial progress from earlier successful steps remains in KV. Setup is **not**
marked complete, so the next call to `/api/setup/configure` can retry from the
beginning.

### Lock mechanism

A KV-based lock prevents concurrent configure runs:

| Key | Value | TTL |
|---|---|---|
| `setup:configuring` | Unix timestamp (ms) as string | 300 s |

Before starting, the handler checks for an existing lock:

- If the lock exists and is less than 60 seconds old, the request is rejected
  immediately.
- If the lock exists but is older than 60 seconds, it is treated as stale and
  overridden (logged as a warning).
- The lock is deleted in the `finally` block regardless of success or failure.
- The KV TTL of 300 s acts as a safety net if the worker crashes before
  cleanup.

### How to retry

The client can simply re-submit the same `POST /api/setup/configure` request.
All steps are idempotent -- they create-or-update resources rather than
assuming a clean slate. If a previous run partially completed, the retry will
update existing resources and continue.

## State management

The following KV keys are written during setup. All keys use the `setup:`
prefix.

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

User records are stored separately under the `user:{email}` key pattern with
a JSON value containing `addedBy`, `addedAt`, and `role` (`"admin"` or
`"user"`).

## Authentication

### First-time setup

When `setup:complete` is not set in KV, all setup endpoints are publicly
accessible. This is necessary for bootstrapping -- no Access application
exists yet to authenticate against.

### Subsequent reconfiguration

Once `setup:complete` is `"true"`, the conditional auth middleware requires:

1. A valid Cloudflare Access JWT (verified by `authMiddleware`).
2. The authenticated user must have the `admin` role (enforced by
   `requireAdmin`).

This applies to `POST /api/setup/configure`, `GET /api/setup/detect-token`,
and `GET /api/setup/prefill`. The `GET /api/setup/status` endpoint is always
public.

## Helper endpoints

### `GET /api/setup/status`

Always public. Returns whether setup is complete and the custom domain if
configured.

```json
{"configured": true, "customDomain": "claude.example.com"}
```

### `GET /api/setup/detect-token`

Checks whether `CLOUDFLARE_API_TOKEN` is present in the environment, verifies
it against the Cloudflare API, and returns account info.

```json
{"detected": true, "valid": true, "account": {"id": "abc123", "name": "My Account"}}
```

### `GET /api/setup/prefill`

Best-effort prefill for the setup form. Reads existing admin and user lists
from Cloudflare Access groups (scoped by worker name). Does not prefill the
custom domain.

```json
{"adminUsers": ["alice@example.com"], "allowedUsers": ["bob@example.com"]}
```

## Rate limiting

| Endpoint | Window | Max requests | Key prefix |
|---|---|---|---|
| `/api/setup/configure` | 60 s | 5 | `setup-configure` |
| `/api/setup/status` | 60 s | 30 | `setup-status` |
| `/api/setup/detect-token` | 60 s | 5 \* | `setup-detect-token` |
| `/api/setup/prefill` | 60 s | 5 \* | `setup-prefill` |

\* detect-token and prefill have endpoint-specific limiters at 10/min, but are also subject to the shared `setupRateLimiter` (5/min, key prefix `setup-configure`) applied as middleware. The effective limit is 5/min.
