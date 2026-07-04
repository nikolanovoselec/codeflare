# Configuration

Environment variables, secrets, CORS configuration, and API token permissions, organized by deployment mode.

**Audience:** Operators

Codeflare runs in four deployment modes. **Default mode** is self-contained — a single-developer fork needs only the configuration in that section. **Onboarding**, **SaaS**, and **Enterprise** are additive layers that document only the extra configuration each requires on top of Default. The **Reference** section (user token scopes, tooling, spec coverage) applies to every mode.

---

## Contents

- [Default mode](#default-mode)
  - [Worker Environment](#worker-environment)
  - [Container Environment](#container-environment)
  - [Secrets](#secrets)
  - [CORS](#cors)
  - [Container Specs](#container-specs)
  - [Cloudflare API Token (Operator)](#cloudflare-api-token-operator)
  - [Cloudflare Connect (OAuth)](#cloudflare-connect-oauth)
  - [GitHub Integration](#github-integration)
- [Onboarding mode](#onboarding-mode)
- [SaaS mode](#saas-mode)
- [Enterprise mode](#enterprise-mode)
  - [Enterprise Mode Secrets (optional)](#enterprise-mode-secrets-optional)
  - [Enterprise Mode Runtime Configuration](#enterprise-mode-runtime-configuration)
  - [Enterprise Access Group Configuration](#enterprise-access-group-configuration)
  - [Admin Access Group Configuration](#admin-access-group-configuration)
  - [Governed Mode (R2 SSE-C disable)](#governed-mode-r2-sse-c-disable)
- [Reference](#reference)

---

## Default mode

### Worker Environment

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `SERVICE_TOKEN_EMAIL` | Email for service token auth | - | no | Optional | [REQ-AUTH-003](../../sdd/spec/authentication.md#req-auth-003-cf-access-mode-for-all-other-deployments), [REQ-SETUP-003](../../sdd/spec/setup.md#req-setup-003-three-deployment-modes) |
| `CLOUDFLARE_API_TOKEN` | R2 bucket creation | - | yes | Wrangler secret | [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001-first-time-setup-requires-zero-pre-configuration), [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile) |
| `R2_ACCESS_KEY_ID` | R2 auth for containers | - | yes | Wrangler secret | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile) |
| `R2_SECRET_ACCESS_KEY` | R2 auth for containers | - | yes | Wrangler secret | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile) |
| `R2_ACCOUNT_ID` | R2 endpoint construction | - | no | Dynamic (env with KV fallback) | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile) |
| `R2_ENDPOINT` | S3-compatible endpoint | - | no | Dynamic (env with KV fallback) | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile) |
| `ALLOWED_ORIGINS` | CORS patterns (comma-separated) | - | no | wrangler.toml | [REQ-SEC-008](../../sdd/spec/security.md#req-sec-008-security-headers-on-every-response), [REQ-OPS-008](../../sdd/spec/operations.md#req-ops-008-stress-testing-validates-rate-limits-and-concurrency) |
| `LOG_LEVEL` | Min log level (default: "info") | `info` | no | wrangler.toml | [REQ-OPS-008](../../sdd/spec/operations.md#req-ops-008-stress-testing-validates-rate-limits-and-concurrency) |
| `CLOUDFLARE_WORKER_NAME` | Worker name override for forks (set at deploy time via `--var`, also used at runtime by worker code) | - | yes | GitHub Actions variable / Worker runtime env | [REQ-AUTH-001](../../sdd/spec/authentication.md#req-auth-001-two-authentication-modes), [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001-first-time-setup-requires-zero-pre-configuration) |
| `MAX_SESSIONS_USER` | Per-user session cap (default: 3) | `3` | no | wrangler.toml | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-OPS-007](../../sdd/spec/operations.md#req-ops-007-container-specs-configurable-per-environment) |
| `MAX_SESSIONS_ADMIN` | Per-admin session cap (default: 10) | `10` | no | wrangler.toml | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-OPS-007](../../sdd/spec/operations.md#req-ops-007-container-specs-configurable-per-environment) |
| `MAX_USERS` | **Removed** - replaced by KV key `setup:max_users` (admin-configurable via User Management page). | - | no | - | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel), [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003-free-tier-requires-no-payment) |
| `SERVICE_AUTH_SECRET` | Worker secret for E2E/CLI service auth (`X-Service-Auth` header) | - | no | Worker secret (optional) | [REQ-AUTH-003](../../sdd/spec/authentication.md#req-auth-003-cf-access-mode-for-all-other-deployments), [REQ-SETUP-003](../../sdd/spec/setup.md#req-setup-003-three-deployment-modes) |
| `STRESS_TEST_MODE` | `"active"` disables all rate limits (integration only) | inactive | no | Worker env var | [REQ-OPS-007](../../sdd/spec/operations.md#req-ops-007-container-specs-configurable-per-environment), [REQ-SEC-019](../../sdd/spec/security.md#req-sec-019-per-endpoint-rate-limit-policy) |
| `ENCRYPTION_KEY` | AES-256-GCM encryption key for `llm-keys:*`, `deploy-keys:*`, and `r2token:*` KV entries; R2 SSE-C key; and the HKDF master input from which the per-bucket vault client-side encryption key is derived (`HKDF-SHA256(ENCRYPTION_KEY, info=bucketName)` — vault bootstrap fails 500 if absent, see [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)) | - | yes | Wrangler secret (optional) | [REQ-SEC-002](../../sdd/spec/security.md#req-sec-002-api-tokens-never-enter-containers), [REQ-SEC-005](../../sdd/spec/security.md#req-sec-005-r2-files-encrypted-at-rest-with-sse-c-when-operator-configures-an-encryption-key), [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) |

### Container Environment

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `R2_BUCKET_NAME` | User's personal bucket | - | no | Worker -> DO via `setBucketName` | [REQ-SESSION-003](../../sdd/spec/session-lifecycle.md#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | rclone auth. **Enterprise strict-egress only:** the non-secret placeholder `codeflare-enterprise` (`ENTERPRISE_R2_KEY_PLACEHOLDER`) — the real R2 key never enters the container; the `EgressController` strips it and re-signs own-account R2 with the worker-held key. Non-enterprise / strict-off keeps the real key. | - | no | Worker -> DO (preferred) or DO `this.env` fallback | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress) |
| `R2_ACCOUNT_ID` / `R2_ENDPOINT` | rclone endpoint | - | no | Worker -> DO or `getR2Config()` fallback | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | **Not emitted in any mode.** S3-compat duplicates of the R2 keys with no consumer (rclone reads creds from rclone.conf built from `R2_*`); their only effect was surfacing Pi's built-in `amazon-bedrock` provider in `/model`, so they were dropped everywhere ([REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC7). `R2_*` are authoritative. | - | no | (removed) | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Non-enterprise: a PAT session sends its real token; an **OAuth** session gets only the placeholder `codeflare-oauth`, refreshed worker-side at the `api.cloudflare.com` boundary ([REQ-AGENT-078](../../sdd/spec/agents.md#req-agent-078-cloudflare-oauth-token-refreshed-at-the-apicloudflarecom-boundary); see [security](security.md#non-enterprise-cloudflare-oauth-token)). **Enterprise:** no deploy token — `CLOUDFLARE_API_TOKEN` is the browser-run placeholder `codeflare-enterprise` ([REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)); `CLOUDFLARE_ACCOUNT_ID` is the non-secret Browser Rendering account. | - | no | Worker -> DO | [REQ-AGENT-078](../../sdd/spec/agents.md#req-agent-078-cloudflare-oauth-token-refreshed-at-the-apicloudflarecom-boundary), [REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-SEC-002](../../sdd/spec/security.md#req-sec-002-api-tokens-never-enter-containers) |
| `TERMINAL_PORT` | Always 8080 | `8080` | no | Hardcoded | [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002-websocket-connection-to-container-pty) |
| `SYNC_MODE` | Sync strategy (`none`, `full`, or `metadata`). Derived from `workspaceSyncEnabled`: `false` -> `none`, `true` -> `full`. `metadata` is a legacy value not currently selectable from the UI. | `none` | no | Worker -> DO | [REQ-STOR-003](../../sdd/spec/storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers) |
| `WORKSPACE_SYNC_ENABLED` | Whether workspace sync is enabled (`'true'`/`'false'`). User-toggleable in Settings; opt-in because syncing `~/workspace/` slows every bisync cycle. | `'false'` | no | Worker via `setBucketName` | [REQ-STOR-003](../../sdd/spec/storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers) |
| `TAB_CONFIG` | JSON array of terminal tab configurations | - | no | Worker -> DO | [REQ-AGENT-002](../../sdd/spec/agents.md#req-agent-002-agent-selection-at-session-creation), [REQ-AGENT-003](../../sdd/spec/agents.md#req-agent-003-agent-cli-auto-started-in-tab-1), [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002-websocket-connection-to-container-pty) |
| `TERMINAL_ID` | Unique ID for this terminal instance | - | no | Host terminal server | [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002-websocket-connection-to-container-pty) |
| `CONTAINER_AUTH_TOKEN` | Auth token for container API calls, scoped to one DO lifecycle. See [security.md](./security.md#container-auth-token-req-sec-012). | - | no | Worker -> DO | [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-container-image-scanned-for-cves-before-deploy), [REQ-SESSION-002](../../sdd/spec/session-lifecycle.md#req-session-002-one-container-per-session-isolation) |
| `MANUAL_TAB` | Set to `1` for user-created tabs to skip autostart | - | no | Worker -> DO | [REQ-TERM-006](../../sdd/spec/terminal.md#req-term-006-user-created-tabs-start-with-plain-bash) |
| `FAST_CLI_START` | Disables auto-update for all 6 AI tools when `'true'` (default); when `'false'`, update suppressors are removed and Pi runs `pi update` during startup | `'true'` | no | Worker -> DO | [REQ-AGENT-012](../../sdd/spec/agents.md#req-agent-012-fast-cli-start-configurable) |
| `PI_OFFLINE` | Disables Pi network checks when `1`; set by entrypoint when `FAST_CLI_START=true` | `1` (via entrypoint) | no | Dockerfile ENV / entrypoint | [REQ-AGENT-012](../../sdd/spec/agents.md#req-agent-012-fast-cli-start-configurable) |
| `PI_SKIP_VERSION_CHECK` | Suppresses Pi version check when `1`; set by entrypoint when `FAST_CLI_START=true` | `1` (via entrypoint) | no | Dockerfile ENV / entrypoint | [REQ-AGENT-012](../../sdd/spec/agents.md#req-agent-012-fast-cli-start-configurable) |
| `CONTEXT_MODE_BRIDGE_IDLE_MS` | Not force-set by codeflare. `0` disables the bridge idle-reaper entirely (subagent bridge helpers never self-release); unset/inherited lets context-mode's own foreground/subagent split (upstream #868) keep the interactive bridge quiet while subagents keep the default ~3-min reaper | unset (context-mode default) | no | entrypoint / `context-mode-runtime.ts` (clears any inherited value) | [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC6 |
| `PI_NPM_PRESEED` | Path to image-local Pi extension npm seed cache | `/opt/codeflare/pi-agent/npm` | no | Dockerfile | [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents) |
| `PI_NPM_DIR` | Path to user-home Pi extension npm directory | `$USER_HOME/.pi/agent/npm` | no | entrypoint | [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents) |
| `CODEFLARE_OPENAI_API_KEY` | OpenAI API key for the consult-llm-mcp MCP server (optional). Injected under a `CODEFLARE_` namespace so coding agents (Pi, opencode, antigravity) cannot auto-detect it as their own credential; the entrypoint maps it back to the bare `OPENAI_API_KEY` ONLY inside the server's scoped `env`. Not injected in enterprise mode. | - | no | Worker -> DO (from KV `llm-keys:{bucket}`) | [REQ-AGENT-031](../../sdd/spec/agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity), [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv) |
| `CODEFLARE_GEMINI_API_KEY` | Gemini API key for the consult-llm-mcp MCP server (optional). Namespaced like `CODEFLARE_OPENAI_API_KEY`; mapped back to the bare `GEMINI_API_KEY` ONLY inside the server's scoped `env`. Not injected in enterprise mode. | - | no | Worker -> DO (from KV `llm-keys:{bucket}`) | [REQ-AGENT-031](../../sdd/spec/agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity), [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv) |
| `ENCRYPTION_KEY` | AES-256 key (base64) for rclone SSE-C. Appended to `rclone.conf` as `sse_customer_key_base64`. **Omitted in Governed Mode** (`R2_SSE_DISABLED`, [REQ-ENTERPRISE-018](../../sdd/spec/enterprise-mode.md#req-enterprise-018-governed-mode-toggle-and-configuration-surface)): SSE-C is off there so rclone never uses it, so this shared key is not placed in the container. Under strict egress + Governed Mode the container then holds no real secret but `CONTAINER_AUTH_TOKEN`. | - | no | Worker -> DO (from `env.ENCRYPTION_KEY`; not in Governed Mode) | [REQ-SEC-002](../../sdd/spec/security.md#req-sec-002-api-tokens-never-enter-containers), [REQ-SEC-005](../../sdd/spec/security.md#req-sec-005-r2-files-encrypted-at-rest-with-sse-c-when-operator-configures-an-encryption-key), [REQ-ENTERPRISE-018](../../sdd/spec/enterprise-mode.md#req-enterprise-018-governed-mode-toggle-and-configuration-surface) |
| `SESSION_MODE` | Session mode (`'default'` or `'advanced'`) - controls memory persistence and rclone filters | `'default'` | no | Worker -> DO via `setBucketName` | [REQ-MEM-011](../../sdd/spec/memory.md#req-mem-011-session-mode-storage-resolution-and-propagation), [REQ-AGENT-003](../../sdd/spec/agents.md#req-agent-003-agent-cli-auto-started-in-tab-1) |
| `NODE_COMPILE_CACHE` | V8 compile cache dir for faster Node.js CLI startup | `/root/.cache/node-compile-cache` | no | Dockerfile ENV | [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents) |
| `BROWSER` | Points to `open-url` shim that exits 1 | `/usr/local/bin/open-url` | no | Dockerfile ENV | [REQ-AGENT-013](../../sdd/spec/agents.md#req-agent-013-browser-shim-for-oauth-flows) |
| `SB_INDEX_PAGE` | Landing page when SilverBullet opens (case-sensitive page name, no `.md`). SB Go server defaults to `"index"` (lowercase); set to `Index` so the Codeflare dashboard loads on Vault button click. See [vault.md](./vault.md#silverbullet-editor-req-vault-005) ([REQ-VAULT-012](../../sdd/spec/vault.md#req-vault-012-vault-button-render-and-dashboard-landing) AC3). | `Index` | no | `entrypoint.sh` `start_silverbullet_supervisor` | [REQ-VAULT-012](../../sdd/spec/vault.md#req-vault-012-vault-button-render-and-dashboard-landing) |
| `USER_TIMEZONE` | IANA timezone string (e.g. | (absent = UTC fallback) | no | Worker -> DO via `setBucketName`; read by `entrypoint.sh` memory-capture pipeline | [REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env), [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) AC4 |
| `CODEFLARE_MEMORY_MODEL` | Optional fidelity pin (no hardcoded model name) for the Pi memory-capture and Vault-extract subagents. | (unset = inherit session model) | no | `~/.pi/agent/extensions/memory-vault.ts` | [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) |

Additional details:

**`USER_TIMEZONE`:** IANA timezone string (e.g. `Europe/Zurich`) forwarded from the `userTimezone` preference. Controls timestamps in memory-capture filenames (`Raw/Sessions/{ISO_TS}-{SID_SHORT}.md`). Falls back to `$TZ`, then `/etc/timezone`, then UTC when absent. Malformed values (non-IANA shape, path-traversal strings) are silently dropped at the DO boundary by `normalizeIanaTz`; the variable is not emitted and the UTC fallback applies, so an operator debugging an unexpected UTC timestamp should check the source `userTimezone` preference value against the IANA shape (`^[A-Za-z][A-Za-z0-9+_/-]{0,63}$`). The primary validation lives at `PATCH /api/preferences` (Zod refine + `Intl.DateTimeFormat` round-trip, returns `ValidationError` on failure); the DO check is defence-in-depth.

**`CODEFLARE_MEMORY_MODEL`:** Optional fidelity pin (no hardcoded model name) for the Pi memory-capture and Vault-extract subagents. When set, `memory-vault.ts` passes it as the `model` option to `service.spawn(...)` for the `memory-capture` and `vault-extract` subagents so capture/extraction runs on a higher-fidelity model per [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad). When unset, no model override is passed and the subagents inherit the session model. Pi-only lever; the Claude path pins the model in agent-definition frontmatter instead.

### Secrets

Repository: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, optional `RESEND_API_KEY`

Worker secrets lifecycle: deploy sets `CLOUDFLARE_API_TOKEN`, setup writes `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, Turnstile keys stored in KV. **Worker-level R2 credentials are derived from the API token** (used for bucket admin operations like create/empty/delete). Per-user scoped R2 tokens are separate - created on first login, independent of the master token but revoked when the API token changes. If the token is rotated, setup must be re-run.

### CORS

Dynamic: setup wizard adds custom domain + `.workers.dev` to KV. `ALLOWED_ORIGINS` env var is static fallback.

`R2_ACCOUNT_ID` and `R2_ENDPOINT` resolved dynamically (env vars with KV fallback).

### Container Specs

| Tier | Config | Max Instances | Notes |
|------|--------|---------------|-------|
| `low` | `basic` (0.25 vCPU, 1 GiB, 4 GB) | 10 | Sub-1-vCPU workloads |
| default | 1 vCPU, 3 GiB, 6 GB | 10 | Baseline for node-pty + agent CLIs |
| `high` | 2 vCPU, 6 GiB, 12 GB | 10 | Higher parallelism |

Selected via the `RESSOURCE_TIER` GitHub Actions repo variable at deploy time (`low` / `default` / `high`). The misspelling (French/German "ressource") is intentional and preserved across `wrangler.toml`, GitHub Actions variables, and TypeScript types for backward compatibility with deployed instances. Do not "fix" the spelling; renaming requires a coordinated change across every deployment.

Base image: Node.js 24 Debian (bookworm-slim).

### Cloudflare API Token (Operator)

These are the permissions required for the Cloudflare API token used by the deploy workflow and worker runtime. Codeflare recommends using the **"Edit Cloudflare Workers"** template when creating the token, then adding the additional scopes listed below.

#### Account Permissions

| Permission | Access | Required | Why |
|-----------|--------|----------|-----|
| Account Settings | Read | Yes | Account ID discovery |
| Workers Scripts | Edit | Yes | Deploy worker + secrets |
| Workers KV Storage | Edit | Yes | KV namespace management |
| Workers R2 Storage | Edit | Yes | Per-user R2 buckets |
| Containers | Edit | Yes | Container lifecycle |
| Access: Apps and Policies | Edit | Yes | Managed Access app |
| Access: Organizations, Identity Providers, and Groups | Edit | Yes | Access groups + auth_domain |
| Turnstile | Edit | Only if onboarding active | Turnstile widget |
| API Tokens | Edit | Yes | Create/revoke per-user scoped R2 tokens |

#### Zone Permissions

| Permission | Access | Required | Why |
|-----------|--------|----------|-----|
| Zone | Read | Yes | Zone ID resolution |
| DNS | Edit | Yes | Proxied CNAME |
| Workers Routes | Edit | Yes | Worker route upsert |

#### Additional Scopes You May Need

If your agent asks for additional permissions, you can add them by editing your token in the [Cloudflare dashboard](https://dash.cloudflare.com/profile/api-tokens):

| Permission | Level | When Needed |
|---|---|---|
| D1 | Edit | Creating and managing D1 databases |
| DNS | Edit | Managing DNS records for custom domains |
| Zone | Read | Required alongside DNS for zone resolution |
| Turnstile | Edit | Creating CAPTCHA widgets |
| Access: Apps and Policies | Edit | Managing Cloudflare Access applications |
| Access: Organizations | Edit | Managing Access groups and identity providers |
| API Tokens | Edit | Managing other API tokens programmatically |

Cloudflare API tokens do not expire by default but can be set to expire during creation. You can scope tokens to specific accounts and zones, or use "All accounts" and "All zones" for convenience.

### Cloudflare Connect (OAuth)

In non-enterprise modes a user connects their own Cloudflare account via OAuth (mirroring the GitHub connect), so the per-user deploy token is obtained without pasting a dashboard-created API token ([REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth)). `GET /api/cloudflare/connect` + its callback + `POST /api/cloudflare/disconnect` are `authMiddleware`-only (reachable from Guided Setup + the Settings accordion, not tier-gated). The token/refresh/expiry persist across the existing `deploy-keys:<bucket>` Cloudflare fields (source `'oauth'`, encrypted); `getValidCloudflareToken` refreshes on expiry and fails closed; `applyCloudflareOAuthToken` injects the valid token into the container env on session start. **Enterprise has no Cloudflare OAuth** — `getCloudflareProvider` returns null there and the routes fail closed; enterprise keeps the admin-global Browser Rendering token ([REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)).

**Operator OAuth client (Setup wizard → KV; admin).** The operator registers one Cloudflare OAuth Application and enters its client id + secret in the admin-gated Setup wizard; each user then authorizes their own account.

| KV key | Purpose |
|--------|---------|
| `setup:cloudflare_oauth_client_id` | Cloudflare OAuth client id (plain). |
| `setup:cloudflare_oauth_client_secret` | Cloudflare OAuth client secret (encrypted at rest; fail-closed without `ENCRYPTION_KEY`). |

**Client authentication method (`invalid_client` gotcha).** Codeflare exchanges the authorization code using **`client_secret_post`** (client id + secret in the form body) — Cloudflare's token endpoint supports it. The operator's OAuth Application must therefore be registered with `token_endpoint_auth_method = client_secret_post`. If the client is registered as a **public client (`none`)** or as `client_secret_basic`, Cloudflare's token endpoint rejects the exchange with `401 invalid_client` ("the client supports authentication method 'none', but 'client_secret_post' was requested; configure the client's token_endpoint_auth_method to accept 'client_secret_post'") and the connect flow stays unconnected. The exact `error_description` is now surfaced in the connect logs (previously an opaque "returned 401"). Reconfigure the client's auth method on the Cloudflare side; codeflare does not need a code change for `client_secret_post`.

**Scopes.** The connect URL carries a tier (minimal/recommended/advanced); the server maps it to the OAuth `scope` using **dot-notation scope IDs** from Cloudflare's OAuth catalog (`GET /client/v4/oauth/scopes` — `<resource>.<read|write>` form, e.g. `workers-scripts.write`, `account-settings.read`, `ai.write`; **not** the colon-style API-token permission-group keys), always including `offline_access` for a refresh token, from the server-side catalog in `src/lib/oauth-scopes.ts`. The operator's OAuth client must be registered with at least the **Advanced superset**, since per-connect requests can only narrow within the registered scopes. For a per-scope dashboard display-name lookup (Cloudflare's picker shows descriptive names; the scope ID appears only after saving) and the `zone-access.write` vs `access.write` duplicate-label gotcha, see the [OAuth scope registration table](../../README.md#selecting-these-scopes-on-the-cloudflare-dashboard) in the root README.

### GitHub Integration

The GitHub panel lets a connected user browse and clone their repositories and lets the in-session agent act with the user's GitHub permissions. The repo panel is available in every mode and renders whenever GitHub is enabled — there is no session-tier gate; it is the default right-column face on every session (the Connect card included until connected). **Connect/disconnect are decoupled from GitHub being enabled** — they are `authMiddleware`-only, reachable by any authenticated user from Guided Setup + the Settings accordion even when the panel is not shown ([REQ-GITHUB-007](../../sdd/spec/github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise)).

Connect uses one of two providers, selected by precedence ([REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage)): a configured **GitHub App** takes precedence over the **OAuth App**. With neither configured the integration is unavailable and `/api/github/connect` returns `503 GITHUB_NOT_CONFIGURED`.

**Provider configuration (Setup wizard → KV; admin, any mode)** ([REQ-GITHUB-008](../../sdd/spec/github.md#req-github-008-enterprise-github-provider-configuration-via-setup)). The provider + credentials are configured in the admin-gated Setup wizard in **every** mode (originally enterprise-only; enterprise admins additionally have no GitHub-Actions/Cloudflare-secret access). An admin picks GitHub App or OAuth App and enters the client id (stored plain) + client secret (stored encrypted) under dedicated KV keys. `getGithubProvider` (async) resolves these KV values first in every mode, falling back to the env-var pairs below only when KV is unconfigured. Separate key pairs per provider mean switching providers in the wizard preserves the other's credentials.

A blank secret on re-save keeps the stored one; a secret submitted with no `ENCRYPTION_KEY` is rejected (`400`) rather than written in plaintext, and a stored secret that cannot be decrypted is treated as unconfigured (fails closed). `GET /api/setup/prefill` echoes the provider type, both client ids, and a per-provider `…ClientSecretSet` flag, never the secret. Mirrors the admin-global Browser Rendering token ([REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)).

| KV key | Purpose |
|--------|---------|
| `setup:github_provider_type` | `'app'` or `'oauth'` — the selected provider (plain). |
| `setup:github_app_client_id` / `setup:github_app_client_secret` | GitHub App credentials (id plain, secret encrypted). |
| `setup:github_oauth_client_id` / `setup:github_oauth_client_secret` | OAuth App credentials (id plain, secret encrypted). |

The env-var pairs below are the fallback provider source when no Setup config exists (any mode):

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `GITHUB_APP_CLIENT_ID` | GitHub App client ID. Non-secret; the preferred Connect provider when set. Env-var fallback (non-enterprise, or enterprise before Setup config). | - | no | wrangler.toml `[vars]` | [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage) |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App client secret. Pairs with `GITHUB_APP_CLIENT_ID` for the code-for-token exchange. Env-var fallback (non-enterprise, or enterprise before Setup config). | - | no | Wrangler secret (never in wrangler.toml) | [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage) |
| `GITHUB_HOST` | Web host for OAuth authorize/token. Override only for GitHub Enterprise Server-style hosts. | `github.com` | no | wrangler.toml | [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage) |
| `GITHUB_API_HOST` | REST API host. Override paired with `GITHUB_HOST`. | `api.github.com` | no | wrangler.toml | [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage) |

**OAuth callback domain** ([REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-021](../../sdd/spec/authentication.md#req-auth-021-onboarding-mode-sign-in-choices-and-access-request-flow)): `OAUTH_CLIENT_ID` selects Direct GitHub OAuth for SaaS login and onboarding `/login` sign-in. A classic GitHub OAuth App allows one callback URL, so each deployment domain needs its own App with `https://<domain>/auth/github/callback`; sharing an App redirects users to the registered domain.

`OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` (documented in [Onboarding mode](#onboarding-variables-and-secrets)) are reused as the OAuth-App Connect provider whenever Setup has no GitHub provider config and no GitHub App env pair is configured ([REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage)).

**Token storage.** No new KV key is introduced. The token is stored in the existing per-user encrypted deploy-keys entry as `DeployKeys.githubToken` at `deploy-keys:<bucket>`, encrypted via the existing kv-crypto (plaintext fallback when no `ENCRYPTION_KEY`). A `githubTokenSource` marker distinguishes `'app' | 'oauth' | 'pat'`; App tokens additionally carry a refresh token and expiry.

**Container transport** ([REQ-GITHUB-006](../../sdd/spec/github.md#req-github-006-other-mode-container-transport)). In non-enterprise modes the real token flows to the container as `GH_TOKEN` via the existing deploy-keys path, unchanged. In enterprise mode the container instead receives the non-secret placeholder `GH_TOKEN` = `codeflare-enterprise` (the `ENTERPRISE_GH_TOKEN_PLACEHOLDER` code constant, **not** a configured value); the real token is injected at the container egress boundary (see the [security](security.md) and [architecture](architecture.md) lanes).

**Provider registration permissions** (set at app registration, not via config). The GitHub App requests Contents R/W, Pull requests R/W, Workflows W, and Metadata R. The OAuth App's `scope` is derived per connect from the selected tier (default `repo read:org workflow`; see [REQ-GITHUB-007](../../sdd/spec/github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise)). Enterprise GitHub Apps must be **internal** to the customer's enterprise, since EMU users cannot authorize third-party apps.

## Onboarding mode

Onboarding mode (`ONBOARDING_LANDING_PAGE` = active) serves the public waitlist landing and the integrated `/login` sign-in, adding the following on top of Default mode. The OAuth sign-in secrets and Resend email are shared with SaaS mode.

### Onboarding variables and secrets

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `ONBOARDING_LANDING_PAGE` | `"active"` enables public waitlist landing | inactive | no | wrangler.toml | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence) |
| `TURNSTILE_SECRET_KEY` | Optional direct Turnstile secret override | - | no | Optional | [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile), [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003-free-tier-requires-no-payment) |
| `RESEND_API_KEY` | Notification emails (waitlist, access requests, subscriptions, tier changes). In onboarding mode also sends the access-request admin notification and user confirmation; absent ⇒ that send is skipped without blocking the login redirect. | - | no | Optional | [REQ-AUTH-011](../../sdd/spec/authentication.md#req-auth-011-auth-resolution-order), [REQ-AUTH-012](../../sdd/spec/authentication.md#req-auth-012-welcome-email-on-first-login), [REQ-AUTH-021](../../sdd/spec/authentication.md#req-auth-021-onboarding-mode-sign-in-choices-and-access-request-flow) |
| `RESEND_EMAIL` | Sender identity for notification emails (default: `Codeflare <onboarding@resend.dev>`) | `Codeflare <onboarding@resend.dev>` | no | Optional | [REQ-AUTH-012](../../sdd/spec/authentication.md#req-auth-012-welcome-email-on-first-login), [REQ-AUTH-021](../../sdd/spec/authentication.md#req-auth-021-onboarding-mode-sign-in-choices-and-access-request-flow) |
| `OAUTH_CLIENT_ID` | GitHub OAuth app client ID for Worker-managed OAuth. | - | yes | Wrangler secret | [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-021](../../sdd/spec/authentication.md#req-auth-021-onboarding-mode-sign-in-choices-and-access-request-flow) |
| `OAUTH_CLIENT_SECRET` | GitHub OAuth app client secret, used in the code-for-token exchange during the callback. | - | yes | Wrangler secret | [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-021](../../sdd/spec/authentication.md#req-auth-021-onboarding-mode-sign-in-choices-and-access-request-flow) |
| `OAUTH_JWT_SECRET` | HMAC-SHA256 secret signing the session cookie and the OAuth state token. Missing value throws `AuthError` (fail-loud, no silent CF Access fallthrough). | - | yes | Wrangler secret | [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-021](../../sdd/spec/authentication.md#req-auth-021-onboarding-mode-sign-in-choices-and-access-request-flow) |
| `PUBLIC_CF_BEACON_TOKEN` | Cloudflare Web Analytics beacon token, read at landing-page build time by `landing/src/layouts/BaseLayout.astro`. When set, the beacon `<script>` (`static.cloudflareinsights.com/beacon.min.js`) is injected into every landing page; when unset, the beacon is omitted entirely. The matching CSP allowances in `src/index.ts` are unconditional (present even when the token is unset). See [security.md](./security.md#security-headers). | - | no | Landing build (`import.meta.env`) | [REQ-LANDING-001](../../sdd/spec/landing.md#req-landing-001-mode-aware-public-landing-serving), [REQ-SEC-008](../../sdd/spec/security.md#req-sec-008-security-headers-on-every-response) |

### SEO / Discoverability

No environment variable governs the discoverability documents ([REQ-LANDING-003](../../sdd/spec/landing.md#req-landing-003-landing-social-share-and-search-metadata)); these are operator-facing constants and assets, called out here because a fork or alternate-domain deployment must know they exist.

- **Canonical origin**

    the `robots.txt` / `sitemap.xml` / `llms.txt` served by the Worker, and the JSON-LD + canonical/OG tags emitted by the landing, all use the origin **hardcoded** to `https://codeflare.ch` (`CANONICAL_ORIGIN` in `src/lib/seo.ts`, mirrored in `landing/src/layouts/BaseLayout.astro`). This is intentional: an integration/staging host must not advertise itself as canonical or get indexed as duplicate content. A fork that deploys to a different root domain must update this constant before shipping.
- **OG / social-share image** — served as a static asset from `web-ui/public/og.png` (1200x630) at `/og.png`, with the editable source at `web-ui/public/og.svg`. Replace these to customise the social-share card.
- **Mode gating** — the root documents are served only when the public marketing landing is active (SaaS or onboarding mode); default/enterprise (private app) deployments return a disallow-all `robots.txt` and 404 the sitemap/llms, so a private deployment is never advertised to crawlers.

## SaaS mode

SaaS mode (`SAAS_MODE` = active) adds a custom login page, GitHub-OAuth auto-provisioning, and admin approval on top of Default mode. It reuses the OAuth sign-in secrets and Resend email from [Onboarding mode](#onboarding-variables-and-secrets).

### SaaS variables and secrets

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `SAAS_MODE` | `"active"` enables custom login page, auto-provisioning, admin approval | inactive | yes | GitHub Actions variable -> `--var` at deploy | [REQ-AUTH-001](../../sdd/spec/authentication.md#req-auth-001-two-authentication-modes) |
| `SAAS_EXTRA_IDPS` | Comma-separated IdP UUIDs for custom OIDC providers on login page | - | yes | GitHub Actions variable -> `--var` at deploy | [REQ-AUTH-008](../../sdd/spec/authentication.md#req-auth-008-session-cookie-auto-refresh) |

## Enterprise mode

Enterprise mode (`ENTERPRISE_MODE` = active) forces all users to the unlimited tier and Pro mode, authenticates via Cloudflare Access, and routes agent LLM traffic through the customer's AI Gateway via outbound interception, adding the following on top of Default mode.

### Enterprise mode variables

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `ENTERPRISE_MODE` | `"active"` forces all users to unlimited tier + Pro mode, hides billing UI, restricts agent roster to `{copilot, pi, bash}` (OpenAI-wire-format agents only; Claude Code excluded), and enables outbound-HTTPS interception to the AI Gateway REST API. Unset = standard tier/billing behaviour unchanged. | inactive | no | GitHub Actions variable -> `--var` at deploy | [REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-003](../../sdd/spec/enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode) |
| Dynamic-route catalog (`setup:dynamic_routes`, `setup:default_route`) | Enterprise only: gateway dynamic routes (`string[]`, **≥1 required** — wizard blocks Continue, `configure` returns `400` otherwise); the first route added is the default `route:reasoning`. Set in the **setup wizard**, stored in KV (no redeploy); the `LlmInterceptor` maps the slash-free handle to `dynamic/<route>` on egress. (Replaces `AIG_LANGUAGE_MODEL`.) | - | no | Setup wizard -> KV (enterprise) | [REQ-ENTERPRISE-012](../../sdd/spec/enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-007](../../sdd/spec/enterprise-mode.md#req-enterprise-007-gateway-route-pinning) |
| Per-route context windows (`setup:route_context_windows`) | Enterprise only: JSON `{route: tokens}` map of each dynamic route's model context window (positive ints). Set per route in the **setup wizard** (prefilled with `256000`, editable + resettable), stored in KV (no redeploy), fanned as `ENTERPRISE_ROUTE_CONTEXT_WINDOWS` to Pi's `models.json`. Absent routes default to `256000`. | `256000` per route | no | Setup wizard -> KV (enterprise) | [REQ-ENTERPRISE-022](../../sdd/spec/enterprise-mode.md#req-enterprise-022-per-route-context-windows-for-dynamic-routes), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) |

### Enterprise Mode Secrets (optional)

| Secret | Purpose | Set via |
|--------|---------|---------|
| `AIG_GATEWAY_URL` | Customer AI Gateway base URL in the gateway form `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>` (the parser reads the `/v1/{account_id}/{gateway_id}` segments). | GitHub Actions secret -> `wrangler secret put AIG_GATEWAY_URL` (deploy.yml) |
| `AIG_TOKEN` | **Cloudflare API token carrying BOTH "Workers AI" and "AI Gateway: Run" permissions** (dual transport — [AD74](../decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api)). | GitHub Actions secret -> `wrangler secret put AIG_TOKEN` (deploy.yml) |

Additional details:

**`AIG_GATEWAY_URL`:** Customer AI Gateway base URL in the gateway form `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>` (the parser reads the `/v1/{account_id}/{gateway_id}` segments). The `LlmInterceptor` derives the account id and gateway id from it, builds the REST API URL (`https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1/*`) from the account id, and stamps the gateway id in the `cf-aig-gateway-id` header ([REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)). The compat path (`gateway.ai.cloudflare.com`) is used as a 404 fallback when a provider is absent from the REST API ([AD74](../decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api), dual-transport amendment). When absent or unparseable, enterprise LLM routing fails closed (503) even if `ENTERPRISE_MODE=active`.

**`AIG_TOKEN`:** **Cloudflare API token carrying BOTH "Workers AI" and "AI Gateway: Run" permissions** (dual transport — [AD74](../decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api)). The interceptor sends it as `Authorization: Bearer` to the REST API (`api.cloudflare.com/.../ai/v1/*`, uses the Workers AI scope) and as `cf-aig-authorization: Bearer` to the compat fallback (`gateway.ai.cloudflare.com/.../compat/*`, uses the AI Gateway Run scope). See the warning below. Read exclusively by `LlmInterceptor`; never injected into the container.

Both secrets are an **optional fallback**: the AI Gateway URL + token are normally configured in the Setup wizard and persisted in KV (`setup:aig_gateway_url` / `setup:aig_token`, see below), and `getAigConfig` resolves KV first, then these deploy secrets ([REQ-ENTERPRISE-017](../../sdd/spec/enterprise-mode.md#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)). When neither source is set, a deployment behaves identically to a non-enterprise deployment regardless of the `ENTERPRISE_MODE` variable. See [Architecture - Enterprise LLM Routing](architecture.md#enterprise-llm-routing-enterprise-mode) and [Deployment - Enterprise Secrets](deployment.md#enterprise-mode-secrets).

**AIG_TOKEN credential type — important.** Enterprise LLM traffic uses two AI Gateway transports with different auth. One Cloudflare API token must carry **both** permissions: **Workers AI** for the REST API `/ai/v1/*` (`Authorization: Bearer`) and **"AI Gateway: Run"** for the compat path (`cf-aig-authorization: Bearer`).

A token missing either permission is rejected by the corresponding transport with `error 10000`. The REST API rejects an "AI Gateway: Run"-only token, and the compat path rejects a Workers-AI-only token; both were confirmed against the `codeflare-enterprise` gateway.

The `cfut_` prefix is shared across all CF API token types and does **not** indicate scope. Verify the permission labels, not the prefix.

Create the token **manually** with **both** Workers AI and AI Gateway: Run permissions. The gateway's "Authenticated Gateway" → "Create authentication token" button mints an AI-Gateway-Run-only token, which covers compat but **not** the REST API. See [AD74](../decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api) for full rationale.

### Enterprise Mode Runtime Configuration

KV values written by the setup wizard that can be changed without redeploying the Worker. Unlike `ENTERPRISE_MODE` (deploy-time), these are operator-configurable at runtime. Most are non-sensitive preferences containing no credentials; the exception is the AI Gateway token (`setup:aig_token`, [REQ-ENTERPRISE-017](../../sdd/spec/enterprise-mode.md#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)), which is a credential **stored encrypted** (same kv-crypto as the Browser Rendering token) and never returned to the browser. Re-run setup to change them.

| KV key | Purpose | Set via |
|--------|---------|---------|
| `setup:enterprise_access_group` | Comma/newline-separated list of Cloudflare Access group names/ids (any-of gate). When set, JIT provisioning admits only users in a configured group (non-members: 403); matched groups are forwarded to AI Gateway metadata. See [details](#enterprise-access-group-configuration) below. | Setup wizard → KV (re-run setup to change; no redeploy) |
| `setup:enterprise_admin_access_group` | Comma/newline-separated list of Cloudflare Access group names/ids whose members are granted admin (= Setup / user-administration) access, parallel to the email-based Admin Users list. Resolved live per-request in `requireAdmin` (never the hot auth path); excluded from per-group routing. See [details](#admin-access-group-configuration) below. | Setup wizard → KV (re-run setup to change; no redeploy) |
| `setup:dynamic_routes` | JSON string array of AI Gateway dynamic-route handles that the interceptor maps to `dynamic/<name>` and exposes to container agents as selectable routes. | Setup wizard → KV (re-run setup to change; no redeploy) |
| `setup:default_route` | JSON `{route, reasoning}` default route. When unset, runtime resolves the first catalog route with reasoning `off`; when set, `route` must exist in `setup:dynamic_routes`. | Setup wizard → KV (re-run setup to change; no redeploy) |
| `setup:route_context_windows` | JSON `{route: tokens}` map of each dynamic route's context window (positive ints; default `256000` per route when absent). Fanned to the container as `ENTERPRISE_ROUTE_CONTEXT_WINDOWS` for Pi's `models.json`. `configure` deletes the key when the map is empty. See [REQ-ENTERPRISE-022](../../sdd/spec/enterprise-mode.md#req-enterprise-022-per-route-context-windows-for-dynamic-routes). | Setup wizard → KV (re-run setup to change; no redeploy) |
| `setup:group_routing` | Optional JSON map `{ [group]: { routes: string[], defaultRoute, reasoning } }` of per-Access-group route overrides. | Setup wizard → KV (re-run setup to change; no redeploy) |
| `setup:strict_egress` | Enterprise only: Strict Gateway Egress on/off toggle (`'active'`/`'inactive'`, **default OFF**). | Setup wizard → KV (re-run setup to change; no redeploy) |
| `setup:downloads_disabled` | Enterprise only: view-only-storage toggle (`'active'`/`'inactive'`, **default OFF**). | Setup wizard → KV (re-run setup to change; no redeploy) |
| `setup:aig_gateway_url` | Enterprise only: the customer's AI Gateway base URL (non-secret, gateway form `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>`). Wizard-first source for the gateway coordinates, with the deploy-time `AIG_GATEWAY_URL` secret as a fallback (`getAigConfig` resolves KV first, env second — [REQ-ENTERPRISE-017](../../sdd/spec/enterprise-mode.md#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)). | Setup wizard → KV (re-run setup to change; no redeploy) |
| `setup:aig_token` | Enterprise only: the AI Gateway token, **encrypted at rest** (kv-crypto, AAD bound to the key), masked on prefill, no-clobber on blank. | Setup wizard → KV (re-run setup to change; no redeploy) |

Additional details:

**`setup:group_routing`:** Optional JSON map `{ [group]: { routes: string[], defaultRoute, reasoning } }` of per-Access-group route overrides. A session resolves the first of its matched groups (in configured order) with a non-empty entry, else the global catalog; `configure` rejects a group whose default isn't in its routes, whose routes aren't a subset of `setup:dynamic_routes`, or whose key isn't a configured group, and deletes an empty map. See [REQ-ENTERPRISE-013](../../sdd/spec/enterprise-mode.md#req-enterprise-013-per-group-dynamic-routing).

**`setup:strict_egress`:** Enterprise only: Strict Gateway Egress on/off toggle (`'active'`/`'inactive'`, **default OFF**). When ON, the container's **direct-internet** HTTP/HTTPS egress (and WebSocket) is forced through the Workers VPC `EGRESS` binding → the account's Cloudflare Gateway, while only THIS deployment's own-account destinations (its R2 + account-scoped CF API / Browser Rendering) are exempt and egress direct; any other account's R2/CF host rides the Gateway ([AD86](../decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)); **fails closed** (503) for direct-internet egress when the binding is unbound, and rollback is flipping it OFF. Mechanics + the `developers.cloudflare.com` allowlist note (for the bundled CF skills' retrieval) in [security.md](./security.md#strict-gateway-egress-enterprise-mode) + [deployment.md](./deployment.md#strict-gateway-egress-enterprise-mode); contract in [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress).

**`setup:downloads_disabled`:** Enterprise only: view-only-storage toggle (`'active'`/`'inactive'`, **default OFF**). When ON, `GET /api/storage/download` blocks file downloads (attachment → `403`) and allows only inline view of viewable types (text/Markdown/HTML-as-text/images/PDF); non-viewable blobs are `403` even inline, so bulk exfiltration (zipping a repo and downloading it) is prevented. Enforced **server-side**; the Storage Panel also hides the Download button (UX only). Upload/delete unaffected. Contract in [REQ-ENTERPRISE-019](../../sdd/spec/enterprise-mode.md#req-enterprise-019-view-only-storage-download-disable); mechanics in [security.md](./security.md#view-only-storage-enterprise-anti-exfil).

**`setup:aig_token`:** Enterprise only: the AI Gateway token, **encrypted at rest** (kv-crypto, AAD bound to the key), masked on prefill, no-clobber on blank. Wizard-first, with the deploy-time `AIG_TOKEN` secret as a fallback. Must carry both Workers AI + AI Gateway Run scopes (see the `AIG_TOKEN` note above). Read only via `getAigConfig`; never returned to the browser, never injected into the container ([REQ-ENTERPRISE-017](../../sdd/spec/enterprise-mode.md#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)).

### Container Environment (enterprise-only)

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `NODE_EXTRA_CA_CERTS` | Enterprise only: path to the Cloudflare containers CA cert so Node-based agents (Copilot, Pi) trust the platform-intercepted TLS. Prepended to `.bashrc` by `entrypoint.sh` so login-shell PTYs inherit it (a process-only export does not reach the agents). | (unset off-enterprise) | no | `entrypoint.sh` (enterprise block) → `.bashrc` | [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) |
| `SSL_CERT_FILE` | Enterprise only: path to the system CA bundle (`/etc/ssl/certs/ca-certificates.crt`) so OpenSSL/Python pick up the containers CA after `update-ca-certificates`. Prepended to `.bashrc`. | (unset off-enterprise) | no | `entrypoint.sh` (enterprise block) → `.bashrc` | [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) |
| `REQUESTS_CA_BUNDLE` | Enterprise only: same path as `SSL_CERT_FILE`; consumed by Python `requests` to override its bundled CA. Prepended to `.bashrc`. | (unset off-enterprise) | no | `entrypoint.sh` (enterprise block) → `.bashrc` | [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) |
| `COPILOT_PROVIDER_BASE_URL` | Enterprise only: Copilot BYOK base URL (`https://api.openai.com/v1`, intercepted → gateway). Prepended to `.bashrc` so the copilot PTY inherits it; absent ⇒ Copilot ignores the gateway and falls back to a GitHub login. | (unset off-enterprise) | no | `entrypoint.sh` (enterprise block) → `.bashrc` | [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC3 |
| `COPILOT_PROVIDER_API_KEY` | Enterprise only: non-secret placeholder credential (`codeflare-enterprise`) that puts Copilot in BYOK/API mode; the interceptor strips it and stamps gateway auth. Prepended to `.bashrc`. | (unset off-enterprise) | no | `entrypoint.sh` (enterprise block) → `.bashrc` | [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC3 |
| `COPILOT_MODEL` | Enterprise only: fixed slash-free model handle (`codeflare`) Copilot sends; the `LlmInterceptor` rewrites it to the real gateway route on egress ([REQ-ENTERPRISE-007](../../sdd/spec/enterprise-mode.md#req-enterprise-007-gateway-route-pinning)). Prepended to `.bashrc`. | (unset off-enterprise) | no | `entrypoint.sh` (enterprise block) → `.bashrc` | [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC3 |
| `COPILOT_PROVIDER_MAX_PROMPT_TOKENS` | Enterprise only: prompt-token budget advertised to Copilot so it doesn't warn (`Model "codeflare" is not in the built-in catalog`) and fall back to default limits. | (unset off-enterprise) | no | `entrypoint.sh` (enterprise block) → `.bashrc` | [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC3 |
| `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS` | Enterprise only: max output tokens advertised to Copilot (`128000`, gpt-5.5). Pairs with `COPILOT_PROVIDER_MAX_PROMPT_TOKENS` to silence the "not in catalog" warning and right-size context. Prepended to `.bashrc`. | (unset off-enterprise) | no | `entrypoint.sh` (enterprise block) → `.bashrc` | [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC3 |
| `ENTERPRISE_ROUTE_CATALOG` | Enterprise only: JSON `string[]` of the Setup-configured dynamic-route names (`container-env.ts` fans `state._routeCatalog` when enterprise AND non-empty). `entrypoint.sh` builds Pi's `models.json` listing every route so `/model` offers the whole catalog. The credential / gateway URL / token are never fanned — the `LlmInterceptor` maps the slash-free handle → `dynamic/<route>` on egress. | (unset off-enterprise or empty catalog) | no | `entrypoint.sh` (enterprise block) | [REQ-ENTERPRISE-012](../../sdd/spec/enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1 |
| `ENTERPRISE_DEFAULT_ROUTE` | Enterprise only: the default route name (`state._defaultRoute`; unset ⇒ first catalog route). `entrypoint.sh` pins Pi's `defaultModel` and Copilot's `COPILOT_MODEL` to it so agents start on the configured default; a user `/model` change is re-asserted each start. | (unset off-enterprise or no default) | no | `entrypoint.sh` (enterprise block) | [REQ-ENTERPRISE-012](../../sdd/spec/enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1 |
| `ENTERPRISE_DEFAULT_REASONING` | Enterprise only: the default route's reasoning grade (e.g. `medium`, `off`; `state._defaultReasoning`, unset ⇒ off). `entrypoint.sh` sets Pi's `defaultThinkingLevel` from it. | (unset off-enterprise or no reasoning configured) | no | `entrypoint.sh` (enterprise block) | [REQ-ENTERPRISE-012](../../sdd/spec/enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1 |
| `ENTERPRISE_ROUTE_CONTEXT_WINDOWS` | Enterprise only: JSON `{route: tokens}` map of per-route context windows (`state._routeContextWindows`, fanned when enterprise AND non-empty). `entrypoint.sh` sets each Pi `models.json` model's `contextWindow` from it, defaulting to `256000` for any route absent from the map, so Pi does not fall back to its built-in 128k default. | (unset off-enterprise or empty map) | no | `entrypoint.sh` (enterprise block) | [REQ-ENTERPRISE-022](../../sdd/spec/enterprise-mode.md#req-enterprise-022-per-route-context-windows-for-dynamic-routes), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1/AC4 |

Additional details:

**`COPILOT_PROVIDER_MAX_PROMPT_TOKENS`:** Enterprise only: prompt-token budget advertised to Copilot so it doesn't warn (`Model "codeflare" is not in the built-in catalog`) and fall back to default limits. Set to `920000` — a conservative prompt budget inside gpt-5.5's `1,050,000` context, leaving `130,000` for the `128,000` output limit (~2k safety margin). Because `codeflare` is a dynamic route, this reflects gpt-5.5 (the primary Copilot always hits). Prepended to `.bashrc`.

### Enterprise Access Group Configuration

`setup:enterprise_access_group` accepts a comma- or newline-separated list of Cloudflare Access group names or IDs. A user in **any** configured group is admitted (any-of gate); a user in no configured group receives 403 (fail-closed). When the key is unset, any user the Access application policy admits is provisioned on their valid Access JWT alone.

Every matched group is forwarded to the customer's AI Gateway as a per-group `cf-aig-metadata.group_<sanitized>_<hash>=1` tag (alongside `cf-aig-metadata.user` = the user's email), within CF's 5-entry metadata cap (`user` + up to 4 groups, excess truncated deterministically in configured order), so gateway rules can branch routing, cost, and rate-limit policies per group ([REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC4). No group metadata is stamped when no groups are configured. The same matched-group list also drives per-group dynamic routing when configured ([REQ-ENTERPRISE-013](../../sdd/spec/enterprise-mode.md#req-enterprise-013-per-group-dynamic-routing)).

**Tag-key format (what you see in AI Gateway logs and what your Dynamic Route must filter on).** The metadata key is `group_<sanitized>_<hash>`, not the raw group name, and its value is always `1`. Example: the Access group `codeflare_admins` is stamped as `group_codeflare_admins_150f5d1` with value `1` — in the AI Gateway log it reads `group_codeflare_admins_150f5d1:1`. The key is built by `sanitizeGroupKey` (`src/llm-interceptor.ts`) in two parts: `<sanitized>` is the group name lower-cased with every run of non-`[a-z0-9]` characters collapsed to `_` (so `Dev Team` → `dev_team`), and `<hash>` is a deterministic djb2 hash of the **original** name in base-36.

The hash is appended to **every** group, even one that needs no sanitizing like `codeflare_admins`, because sanitizing is lossy: `Dev Team` and `dev-team` both reduce to `dev_team` and would collide, so the hash keeps each source group's tag unique (`group_dev_team_1da57e3` vs `group_dev_team_gbnce0`). Consequence for operators: a Dynamic Route's per-group condition must equals-match the **full hashed key** as it appears in the logs (`group_codeflare_admins_150f5d1 == 1`), never the bare name (`group_codeflare_admins`), which will never match. Copy the exact key from a request's metadata in the AI Gateway log.

The value is matched **case-sensitively** against the group name or ID exactly as it appears in the Cloudflare dashboard — a mismatch denies every user. Prefer the immutable Access group **ID** over the display name: membership is matched against the group's id, name, or email, and a display name can be renamed or reused.

See [User Provisioning — Enterprise Mode Provisioning](user-provisioning.md#enterprise-mode-provisioning), [REQ-ENTERPRISE-010](../../sdd/spec/enterprise-mode.md#req-enterprise-010-access-gated-jit-user-provisioning) (group-gated JIT provisioning), and [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) (gateway metadata forwarding).

### Admin Access Group Configuration

`setup:enterprise_admin_access_group` accepts a comma- or newline-separated list of Cloudflare Access group names or IDs (same format as `setup:enterprise_access_group`) whose members are granted **admin** access — Setup, user administration, and every other admin-gated route — in addition to the email-based Admin Users list. Leave it unset to keep admin access limited to the named admins.

Membership is resolved **live** on each admin-gated request (a single Cloudflare Access get-identity call) inside `requireAdmin`, never in the hot authentication path, and it short-circuits for a user already resolved as admin — so non-admin requests and non-admin routes carry no extra cost, and removing a user from the group revokes their admin access on the very next request. The elevation lives only on the request context (no KV `role:'admin'` record is written), and the check fails closed (treated as non-member) on any missing token, non-`*.cloudflareaccess.com` domain, or fetch error.

Admin groups widen the entry gate too: when `setup:enterprise_access_group` is set, membership is tested against the **union** of user-access + admin groups, so an admin in no user-access group is still admitted; admin groups never arm the entry gate by themselves. Admin groups are **excluded from per-group routing** — only user-access groups appear in `setup:group_routing`. See [REQ-ENTERPRISE-014](../../sdd/spec/enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups) and [Authentication — Admin authorization](authentication.md).

### Governed Mode (R2 SSE-C disable)

Governed Mode is an enterprise-only, **default-OFF** policy that disables R2 SSE-C deployment-wide so corporate-owned bucket data is readable/scannable by the company's own security tooling (REQ-ENTERPRISE-018, [AD89](../decisions/README.md#ad89-governed-mode-deployment-wide-r2-sse-c-disable-via-a-kv-toggle-with-lossless-in-place-re-encrypt-migration)).

- **Where it is set:** the Setup wizard "Data Governance" toggle, persisted in KV at `setup:r2_sse_disabled` (`'active'`/`'inactive'`; absent ⇒ OFF). No redeploy is needed to flip it. Enterprise-only — never written in non-enterprise mode.
- **`ENCRYPTION_KEY` is unaffected as a secret.** The key keeps serving the vault HKDF master and secret-at-rest KV crypto; Governed Mode gates only the R2 SSE-C header path. Disabling SSE-C does not weaken secret storage or the vault.
- **Container env var `R2_SSE_DISABLED`.**

    When a bucket's resolved regime is plaintext, the Worker forwards `R2_SSE_DISABLED=true` to the container (alongside the existing R2 vars). `entrypoint.sh` then omits the `sse_customer_key_*` block from `rclone.conf` and sets `disable_checksum = false` so the delta sync can compare by content. The var is omitted (SSE-C on) by default — byte-identical to before.

Flipping the toggle triggers a lossless re-encrypt of each bucket in the background, driven by the owner's dashboard `batch-status` poll in verified resumable chunks (never on the container-start path); see the [Deployment lane](deployment.md#governed-mode-migration-batch-status-driven).

## Reference

Cross-cutting configuration that applies to every deployment mode.

### Cloudflare API Token (User)

Users connect their Cloudflare account by creating an API token. Codeflare offers three scope tiers -- choose based on what you build:

| Scope | Scope ID | Minimal | Recommended | Advanced | Why |
|---|---|---|---|---|---|
| **Workers Scripts: Edit** | `workers-scripts.write` | yes | yes | yes | Deploy Workers and manage secrets |
| **Workers KV Storage: Edit** | `workers-kv-storage.write` | yes | yes | yes | KV namespace management |
| **Workers R2 Storage: Edit** | `workers-r2.write` | yes | yes | yes | Object storage for user data |
| **D1: Edit** | `d1.write` | yes | yes | yes | SQL database management |
| **Workers Routes: Edit** | `workers-routes.write` | yes | yes | yes | Route traffic to Workers |
| **Account Settings: Read** | `account-settings.read` | yes | yes | yes | Account ID discovery |
| **User Details: Read** | `user-details.read` | yes | yes | yes | Resolve the connecting account |
| **Zone: Read** | `zone.read` | yes | yes | yes | Zone ID resolution |
| **DNS: Edit** | `dns.write` | - | yes | yes | Manage DNS records for custom domains |
| **Access: Apps and Policies: Edit** | `zone-access.write` | - | yes | - | Cloudflare Access apps (combined; advanced uses the granular scopes below) |
| **Access: Orgs, IdPs, and Groups: Edit** | `access-acct.write` | - | yes | - | Access identity (combined; advanced uses the granular scopes below) |
| **Cloudflare Pages: Edit** | `page.write` | - | - | yes | Deploy static sites and full-stack apps |
| **Containers: Edit** | `containers.write` | - | - | yes | Container lifecycle management |
| **Queues: Edit** | `queues.write` | - | - | yes | Message queue management |
| **Workers Pipelines: Edit** | `pipelines.write` | - | - | yes | Streaming ETL pipelines |
| **Workers R2 Data Catalog: Edit** | `r2-catalog.write` | - | - | yes | R2 bucket metadata and catalog |
| **Workers Builds Configuration: Edit** | `workers-ci.write` | - | - | yes | CI/CD build pipeline configuration |
| **Workers Observability: Edit** | `workers-observability.write` | - | - | yes | Logs, traces, and monitoring |
| **Workers Tail: Read** | `workers-tail.read` | - | - | yes | Live-tail Worker logs |
| **Workers Agents Configuration: Edit** | `cf-agents.write` | - | - | yes | Cloudflare Agents configuration |
| **Secrets Store: Edit** | `secrets-store.write` | - | - | yes | Account-level secrets store |
| **Workers AI: Edit** | `ai.write` | - | - | yes | Inference and model management |
| **Workers AI: Read** | `ai.read` | - | - | yes | Read-only inference access |
| **AI Gateway: Edit** | `agw.write` | - | - | yes | AI Gateway routing and config |
| **Vectorize: Edit** | `vectorize.write` | - | - | yes | Vector database for AI embeddings |
| **Browser Rendering: Edit** | `browser-rendering.write` | - | - | yes | Browser Run (REST + CDP), both agents |
| **Turnstile: Edit** | `challenge-widgets.write` | - | - | yes | CAPTCHA widget management |
| **Zero Trust: Edit** | `teams.write` | - | - | yes | Cloudflare Zero Trust |
| **Access: Organizations: Edit** | `access-org.write` | - | - | yes | Access organization config |
| **Access: Identity Providers: Edit** | `access-idp.write` | - | - | yes | Access IdP config |
| **Access: Groups: Edit** | `access-group.write` | - | - | yes | Access group config |
| **Access: Apps: Edit** | `access-app.write` | - | - | yes | Access application config |
| **Access: Policies: Edit** | `access-policy.write` | - | - | yes | Access policy config |
| **Access: Audit Logs: Read** | `access-audit-log.read` | - | - | yes | Access audit log read |
| **Access: Device Posture: Edit** | `access-device-posture.write` | - | - | yes | Device posture config |
| **Access: Service Tokens: Edit** | `access-service-token.write` | - | - | yes | Access service tokens |
| **Cloudflare One Connectors: Edit** | `teams-connectors.write` | - | - | yes | Cloudflare One connectors |
| **Cloudflare One Networks: Edit** | `teams-networks.write` | - | - | yes | Cloudflare One networks |
| **Cloudflare Tunnel: Edit** | `argotunnel.write` | - | - | yes | Named tunnels (cloudflared) |
| **Cloudflare WAN: Edit** | `magic-wan.write` | - | - | yes | Magic WAN configuration |
| **Connectivity Directory: Admin** | `connectivity-directory.admin` | - | - | yes | Connectivity directory admin |
| **Firewall (Magic): Edit** | `magic-firewall.write` | - | - | yes | Magic Firewall policy |
| **Firewall Policy Packet Captures: Edit** | `pcaps-api.write` | - | - | yes | Packet capture management |
| **Logs: Edit** | `logs.write` | - | - | yes | Logpush / logs configuration |
| **MCP Portals: Edit** | `mcp-portals.write` | - | - | yes | MCP portal management |
| **Account Firewall Access Rules: Edit** | `account-firewall-access-rules.write` | - | - | yes | Account firewall access rules |
| **Account WAF: Edit** | `account-waf.write` | - | - | yes | Account-level WAF |
| **SSL and Certificates: Edit** | `account-ssl-and-certificates.write` | - | - | yes | SSL/TLS certificate management |
| **Zone WAF: Edit** | `zone-waf.write` | - | - | yes | Zone-level WAF |

**Operator setup.** The OAuth client must be registered with the full **Advanced superset** above — a per-connect request can only narrow within the client's registered scopes ([REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth)). Three requested capabilities have **no OAuth scope** and are intentionally omitted (they need a classic API token): **OAuth Clients: Edit**, **API Tokens: Edit**, **Network flow: Admin**. `Logs: Edit` resolves to `logs.write` (the account-scoped `account-logs.write` is rejected by the authorize flow); `Firewall (Magic): Edit` uses `magic-firewall.write`. Advanced uses the granular Access scopes; Recommended keeps the two combined ones.

Additional details:

****Browser Rendering: Edit**:** Browser Run, two surfaces for both agents. READ (cheap one-shot markdown/content/scrape via REST Quick Actions): Claude Code via the `browser-run` MCP server (`/opt/codeflare/browser-run-mcp/`); Pi via native `browser-run.ts` + `browser-run-helpers.ts`. INTERACTIVE (navigate/click/screenshot via the CDP `/devtools` WebSocket): Claude Code via `chrome-devtools-mcp` in `~/.claude.json`; Pi via `chrome-devtools` bridged through `pi-mcp-adapter` in `~/.pi/agent/mcp.json`. Advanced mode only; no-op when token absent. (REQ-BROWSER-002, REQ-BROWSER-005, REQ-BROWSER-006)

The connect flow pre-fills the Cloudflare dashboard token creation form with the correct permissions for the selected tier. Cloudflare API tokens do not expire by default but can be set to expire during creation. Scope tokens to specific accounts and zones, or use "All accounts" and "All zones" for convenience. Implements [REQ-AGENT-028](../../sdd/spec/agents.md#req-agent-028-deploy-credential-token-creation-ux) AC2.

**Enterprise mode:** the per-user "Push & Deploy" accordion is hidden, so an admin instead sets one Cloudflare **Browser Rendering** token (+ account id) in the Setup wizard, applied to every session. It is stored encrypted (`setup:browser_render_token`; account id at `setup:browser_render_account_id`) and is the only Cloudflare credential a session receives in enterprise. See [REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token).

### GitHub Fine-Grained PAT (User)

Users connect their GitHub account by creating a fine-grained personal access token. Codeflare offers three scope tiers -- choose based on your workflow:

- **Minimal** -- just git access
- **Recommended** -- full development workflow (repos, PRs, CI, deploy)
- **Advanced** -- everything, including GitHub Copilot

You can adjust scopes anytime from your [GitHub token settings](https://github.com/settings/tokens).

#### Repository Permissions

| Scope | Minimal | Recommended | Advanced | Why |
|---|---|---|---|---|
| Contents: Write | yes | yes | yes | Push/pull code, manage branches and tags |
| Metadata: Read | yes | yes | yes | Basic repo info (always granted) |
| Pull Requests: Write | - | yes | yes | Create, review, and merge pull requests |
| Actions: Read | - | yes | yes (Write) | View CI workflow runs and logs |
| Workflows: Write | - | yes | yes | Create and modify `.github/workflows/` files |
| Administration: Write | - | yes | yes | Create/delete repositories, manage settings |
| Secrets: Write | - | yes | yes | Set GitHub Actions secrets (e.g., deploy credentials) |
| Actions Variables: Write | - | - | yes | Set GitHub Actions variables |
| Issues: Write | - | - | yes | Create and manage issues |
| Deployments: Write | - | - | yes | Manage deployment statuses |
| Environments: Write | - | - | yes | Manage deployment environments and secrets |
| Pages: Write | - | - | yes | Configure GitHub Pages |
| Commit Statuses: Write | - | - | yes | Set commit status checks |
| Webhooks: Write | - | - | yes | Manage repository webhooks |
| Merge Queues: Write | - | - | yes | Manage merge queue entries |
| Security Events: Write | - | - | yes | Access code scanning and security alerts |
| Custom Properties: Write | - | - | yes | Set custom properties on repositories |
| Discussions: Write | - | - | yes | Create and manage discussions |

#### Account Permissions

| Scope | Minimal | Recommended | Advanced | Why |
|---|---|---|---|---|
| Emails: Read | - | - | yes | Read email for git identity |
| Copilot Requests: Read | - | - | yes | Required for GitHub Copilot CLI |

#### Notes

- **GitHub Copilot** requires the Advanced tier. The `user_copilot_requests: read` account scope is needed for the Copilot CLI to authenticate.
- Fine-grained PATs expire after 90 days by default. You can change the expiration during creation.
- You can scope tokens to specific repositories or all repositories. For Codeflare, "All repositories" is typical since agents may create new repositories from within a session.

### Graphify Tooling

These env vars tune the graphify knowledge-graph build/update tooling. All are optional with safe defaults - the codeflare container ships them pinned to values verified safe for a 1-vCPU / 3.2 GB RAM container.

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `GRAPHIFY_SAFE_RLIMIT_KB` | Virtual-memory cap (KB) applied to bounded Graphify update/build wrappers via `ulimit -v`. Wraps Graphify extraction/update so a runaway rebuild dies with ENOMEM rather than OOM-killing the codeflare session. | `1500000` (1.5 GB) | no | `preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh`; `preseed/agents/pi/scripts/safe-graphify-update.sh`; `preseed/agents/pi/scripts/build-graphify-ast.sh`; `preseed/agents/pi/scripts/build-graphify-architecture.sh` | [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) |
| `GRAPHIFY_SAFE_WORKERS` | Graphify extraction/update subprocess count. Forwarded to graphify as `GRAPHIFY_MAX_WORKERS`. Single-worker on a 1 vCPU container is safest. | `1` | no | `preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh`; `preseed/agents/pi/scripts/safe-graphify-update.sh`; `preseed/agents/pi/scripts/build-graphify-ast.sh`; `preseed/agents/pi/scripts/build-graphify-architecture.sh` | [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) |
| `GRAPHIFY_BUILD_TIMEOUT` | Timeout in seconds for Pi first-build wrappers before they abort rather than monopolizing the 1-vCPU session. Applies to both full AST and architecture graph builds. | `240` | no | `preseed/agents/pi/scripts/build-graphify-ast.sh`; `preseed/agents/pi/scripts/build-graphify-architecture.sh` | [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) |
| `GRAPHIFY_ARCH_EXTRA_EXCLUDES` | Additional shell-split gitignore-style patterns appended to Pi Architecture graph filters when a repo needs local noise reduction beyond the generic tests/docs/generated/config exclusions. | (unset) | no | `preseed/agents/pi/scripts/build-graphify-architecture.sh` | [REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch) |
| `GRAPHIFY_ARCH_KEEP_ISOLATES` | When truthy (`1`, `true`, `yes`), keeps isolated files in Pi Architecture graph output instead of omitting them from the module dependency map. | unset (omit isolates) | no | `preseed/agents/pi/scripts/build-graphify-architecture.sh` | [REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch) |
| `GRAPHIFY_SEMANTIC_MAX_PARALLEL` | Maximum number of semantic-extraction Task subagents dispatched per wave by the `/graphify` skill. | `10` | no | `preseed/agents/claude/skills/graphify/SKILL.md` Step B2 | (graphify skill operational knob) |

Additional details:

**`GRAPHIFY_SEMANTIC_MAX_PARALLEL`:** Maximum number of semantic-extraction Task subagents dispatched per wave by the `/graphify` skill. Caps the parallel fan-out on full-semantic builds so a dense repo (with hundreds of non-code files) cannot flood the Task-tool concurrency or trip Anthropic API rate limits in a single burst. Higher values finish a build faster; lower values smooth the rate-limit / token-budget surface.

### Specification Coverage

- [REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) - ENTERPRISE_MODE forces unlimited tier and Pro mode
- [REQ-ENTERPRISE-018](../../sdd/spec/enterprise-mode.md#req-enterprise-018-governed-mode-toggle-and-configuration-surface) - Governed Mode toggle and configuration surface (setup:r2_sse_disabled; ENCRYPTION_KEY omitted when active)
- [REQ-ENTERPRISE-003](../../sdd/spec/enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode) - Agent allowlist in Enterprise Mode
- [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) - Outbound-interception LLM routing to customer AI Gateway (AIG_GATEWAY_URL, AIG_TOKEN)
- [REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) - Deploy-time AIG secrets and ENTERPRISE_MODE var (AIG_GATEWAY_URL, AIG_TOKEN; now an optional fallback)
- [REQ-ENTERPRISE-017](../../sdd/spec/enterprise-mode.md#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard) - AI Gateway configured in the Setup wizard (setup:aig_gateway_url, setup:aig_token; KV-first, deploy-secret fallback)
- [REQ-ENTERPRISE-007](../../sdd/spec/enterprise-mode.md#req-enterprise-007-gateway-route-pinning) - Gateway route-pinning (catalog-driven handle -> dynamic/<route> mapping)
- [REQ-ENTERPRISE-012](../../sdd/spec/enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list) - Setup-configured dynamic-route catalog and access-group list (KV, no redeploy)
- [REQ-ENTERPRISE-013](../../sdd/spec/enterprise-mode.md#req-enterprise-013-per-group-dynamic-routing) - Per-group dynamic routing (setup:group_routing, first-match by configured order)
- [REQ-ENTERPRISE-010](../../sdd/spec/enterprise-mode.md#req-enterprise-010-access-gated-jit-user-provisioning) - Access-gated JIT user provisioning (setup:enterprise_access_group)
- [REQ-ENTERPRISE-014](../../sdd/spec/enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups) - Admin access via Cloudflare Access groups (setup:enterprise_admin_access_group)
- [REQ-ENTERPRISE-019](../../sdd/spec/enterprise-mode.md#req-enterprise-019-view-only-storage-download-disable) - View-Only Storage: enterprise anti-exfil toggle (setup:downloads_disabled), attachment downloads blocked (403), inline view of allowlisted types only
- [REQ-AUTH-020](../../sdd/spec/authentication.md#req-auth-020-onboarding-mode-landing-integrated-login-shell) - Onboarding login shell
- [REQ-AUTH-021](../../sdd/spec/authentication.md#req-auth-021-onboarding-mode-sign-in-choices-and-access-request-flow) - Onboarding OAuth secrets and access-request confirmation email (Resend)
- [REQ-BROWSER-002](../../sdd/spec/browser-run.md#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template) - Browser Rendering scope in the Cloudflare token template
- [REQ-BROWSER-005](../../sdd/spec/browser-run.md#req-browser-005-claude-browser-run-mcp-server-read-surface-parity) - Claude browser-run MCP server (read-surface parity)
- [REQ-BROWSER-006](../../sdd/spec/browser-run.md#req-browser-006-pi-interactive-browser-via-chrome-devtools-through-the-pi-mcp-adapter) - Pi interactive browser via chrome-devtools through the pi-mcp-adapter
- [REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token) - Enterprise admin-configured Browser Rendering token (Setup wizard)
- [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage) - GitHub token capture and storage (App vs OAuth precedence; GITHUB_APP_CLIENT_ID/SECRET, GITHUB_HOST, GITHUB_API_HOST)
- [REQ-GITHUB-006](../../sdd/spec/github.md#req-github-006-other-mode-container-transport) - Other-mode container transport (GH_TOKEN via the deploy-keys path)
- [REQ-GITHUB-008](../../sdd/spec/github.md#req-github-008-enterprise-github-provider-configuration-via-setup) - GitHub provider configuration via Setup, admin-gated any mode (setup:github_*, KV-first resolution)
- [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) - Cloudflare Connect (OAuth): operator client (setup:cloudflare_oauth_client_*) + per-user token, tier->scope
- [REQ-GITHUB-007](../../sdd/spec/github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise) - Broaden the panel gate beyond enterprise (connect decoupled from panel gate; advanced-session entitlement moved to dashboard frontend)
- [REQ-OPS-012](../../sdd/spec/operations.md#req-ops-012-per-environment-container-concurrency-limit) - Per-environment container concurrency limit
- [REQ-SETUP-004](../../sdd/spec/setup.md#req-setup-004-setup-is-idempotent) - Setup is idempotent
- [REQ-SETUP-006](../../sdd/spec/setup.md#req-setup-006-setup-streams-progress-via-ndjson) - Setup streams progress via NDJSON
- [REQ-SETUP-007](../../sdd/spec/setup.md#req-setup-007-custom-domain-with-dns-validation) - Custom domain with DNS validation
- [REQ-SETUP-009](../../sdd/spec/setup.md#req-setup-009-subscribe-page-with-tier-selection) - Subscribe page with tier selection
- [REQ-SETUP-010](../../sdd/spec/setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page) - Social-share preview metadata on the public landing page
- [REQ-SETUP-011](../../sdd/spec/setup.md#req-setup-011-setup-stream-completion-payload-contract) - Setup stream completion payload contract

## Related Documentation
- [Container](container.md#auto-sleep-configurable-sleepafter) - Container startup and auto-sleep configuration
- [Authentication](authentication.md#environment-variables-for-saas-mode) - SaaS mode variables
- [Security](security.md#credential-encryption-at-rest) - Encryption key details
- [CI/CD](ci-cd.md#github-secrets-and-variables) - CI secrets and variables
