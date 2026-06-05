# Configuration

Environment variables, secrets, CORS configuration, and API token permissions.

**Audience:** Operators

---

## Contents

- [Environment Variables](#environment-variables)
- [Secrets](#secrets)
- [CORS](#cors)
- [Container Specs](#container-specs)
- [API Token Permissions](#api-token-permissions)

## Environment Variables

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
| `ONBOARDING_LANDING_PAGE` | `"active"` enables public waitlist landing | inactive | no | wrangler.toml | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence) |
| `TURNSTILE_SECRET_KEY` | Optional direct Turnstile secret override | - | no | Optional | [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile), [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003-free-tier-requires-no-payment) |
| `RESEND_API_KEY` | Notification emails (waitlist, access requests, subscriptions, tier changes) | - | no | Optional | [REQ-AUTH-011](../../sdd/spec/authentication.md#req-auth-011-auth-resolution-order), [REQ-AUTH-012](../../sdd/spec/authentication.md#req-auth-012-welcome-email-on-first-login) |
| `RESEND_EMAIL` | Sender identity for notification emails (default: `Codeflare <onboarding@resend.dev>`) | `Codeflare <onboarding@resend.dev>` | no | Optional | [REQ-AUTH-012](../../sdd/spec/authentication.md#req-auth-012-welcome-email-on-first-login) |
| `CLOUDFLARE_WORKER_NAME` | Worker name override for forks (set at deploy time via `--var`, also used at runtime by worker code) | - | yes | GitHub Actions variable / Worker runtime env | [REQ-AUTH-001](../../sdd/spec/authentication.md#req-auth-001-two-authentication-modes), [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001-first-time-setup-requires-zero-pre-configuration) |
| `MAX_SESSIONS_USER` | Per-user session cap (default: 3) | `3` | no | wrangler.toml | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-OPS-007](../../sdd/spec/operations.md#req-ops-007-container-specs-configurable-per-environment) |
| `MAX_SESSIONS_ADMIN` | Per-admin session cap (default: 10) | `10` | no | wrangler.toml | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-OPS-007](../../sdd/spec/operations.md#req-ops-007-container-specs-configurable-per-environment) |
| `MAX_USERS` | **Removed** - replaced by KV key `setup:max_users` (admin-configurable via User Management page). | - | no | - | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel), [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003-free-tier-requires-no-payment) |
| `SERVICE_AUTH_SECRET` | Worker secret for E2E/CLI service auth (`X-Service-Auth` header) | - | no | Worker secret (optional) | [REQ-AUTH-003](../../sdd/spec/authentication.md#req-auth-003-cf-access-mode-for-all-other-deployments), [REQ-SETUP-003](../../sdd/spec/setup.md#req-setup-003-three-deployment-modes) |
| `STRESS_TEST_MODE` | `"active"` disables all rate limits (integration only) | inactive | no | Worker env var | [REQ-OPS-007](../../sdd/spec/operations.md#req-ops-007-container-specs-configurable-per-environment), [REQ-SEC-019](../../sdd/spec/security.md#req-sec-019-per-endpoint-rate-limit-policy) |
| `SAAS_MODE` | `"active"` enables custom login page, auto-provisioning, admin approval | inactive | yes | GitHub Actions variable -> `--var` at deploy | [REQ-AUTH-001](../../sdd/spec/authentication.md#req-auth-001-two-authentication-modes) |
| `SAAS_EXTRA_IDPS` | Comma-separated IdP UUIDs for custom OIDC providers on login page | - | yes | GitHub Actions variable -> `--var` at deploy | [REQ-AUTH-008](../../sdd/spec/authentication.md#req-auth-008-session-cookie-auto-refresh) |
| `ENCRYPTION_KEY` | AES-256-GCM encryption key for `llm-keys:*`, `deploy-keys:*`, and `r2token:*` KV entries, also used as R2 SSE-C key | - | yes | Wrangler secret (optional) | [REQ-SEC-002](../../sdd/spec/security.md#req-sec-002-api-tokens-never-enter-containers), [REQ-SEC-005](../../sdd/spec/security.md#req-sec-005-r2-files-encrypted-at-rest-with-sse-c-when-operator-configures-an-encryption-key) |
| `ENTERPRISE_MODE` | `"active"` forces all users to unlimited tier + Pro mode, hides billing UI, restricts agent roster to `{copilot, pi, bash}` (OpenAI-wire-format agents only; Claude Code excluded), and enables outbound-HTTPS interception to the AI Gateway REST API. Unset = standard tier/billing behaviour unchanged. | inactive | no | GitHub Actions variable -> `--var` at deploy | [REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-003](../../sdd/spec/enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode) |
| `AIG_LANGUAGE_MODEL` | Enterprise only: the gateway model id / dynamic route the gateway should use (e.g. `dynamic/<route>`, `openai/gpt-4.1`, `aws-bedrock/…`). A single non-secret routing hint, **Worker-only** — the `LlmInterceptor` stamps it onto each agent request's `model` field on egress (route-pinning); it is never injected into the container (agents use a fixed slash-free handle `codeflare`). Unset ⇒ the model the agent sent is forwarded as-is. | - | no | GitHub Actions variable -> `--var` at deploy (enterprise) | [REQ-ENTERPRISE-007](../../sdd/spec/enterprise-mode.md#req-enterprise-007-gateway-route-pinning), [REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) |

### Container Environment

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `R2_BUCKET_NAME` | User's personal bucket | - | no | Worker -> DO via `setBucketName` | [REQ-SESSION-003](../../sdd/spec/session-lifecycle.md#req-session-003-r2-bucket-mounted-and-synced-on-start), [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | rclone auth | - | no | Worker -> DO (preferred) or DO `this.env` fallback | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket) |
| `R2_ACCOUNT_ID` / `R2_ENDPOINT` | rclone endpoint | - | no | Worker -> DO or `getR2Config()` fallback | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 compatibility | - | no | Mirrors R2 keys | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket) |
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
| `PI_NPM_PRESEED` | Path to image-local Pi extension npm seed cache | `/opt/codeflare/pi-agent/npm` | no | Dockerfile | [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents) |
| `PI_NPM_DIR` | Path to user-home Pi extension npm directory | `$USER_HOME/.pi/agent/npm` | no | entrypoint | [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents) |
| `OPENAI_API_KEY` | OpenAI API key for consult-llm-mcp MCP server (optional) | - | no | Worker -> DO (from KV `llm-keys:{bucket}`) | [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv), [REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) |
| `GEMINI_API_KEY` | Gemini API key for consult-llm-mcp MCP server (optional) | - | no | Worker -> DO (from KV `llm-keys:{bucket}`) | [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv), [REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) |
| `ENCRYPTION_KEY` | AES-256 key (base64) for rclone SSE-C. Appended to `rclone.conf` as `sse_customer_key_base64`. | - | no | Worker -> DO (from `env.ENCRYPTION_KEY`) | [REQ-SEC-002](../../sdd/spec/security.md#req-sec-002-api-tokens-never-enter-containers), [REQ-SEC-005](../../sdd/spec/security.md#req-sec-005-r2-files-encrypted-at-rest-with-sse-c-when-operator-configures-an-encryption-key) |
| `SESSION_MODE` | Session mode (`'default'` or `'advanced'`) - controls memory persistence and rclone filters | `'default'` | no | Worker -> DO via `setBucketName` | [REQ-MEM-011](../../sdd/spec/memory.md#req-mem-011-session-mode-storage-resolution-and-propagation), [REQ-AGENT-003](../../sdd/spec/agents.md#req-agent-003-agent-cli-auto-started-in-tab-1) |
| `NODE_COMPILE_CACHE` | V8 compile cache dir for faster Node.js CLI startup | `/root/.cache/node-compile-cache` | no | Dockerfile ENV | [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents) |
| `BROWSER` | Points to `open-url` shim that exits 1 | `/usr/local/bin/open-url` | no | Dockerfile ENV | [REQ-AGENT-013](../../sdd/spec/agents.md#req-agent-013-browser-shim-for-oauth-flows) |
| `SB_INDEX_PAGE` | Landing page when SilverBullet opens (case-sensitive page name, no `.md`). SB Go server defaults to `"index"` (lowercase); set to `Index` so the Codeflare dashboard loads on Vault button click. See [vault.md](./vault.md#silverbullet-editor-req-vault-005) ([REQ-VAULT-012](../../sdd/spec/vault.md#req-vault-012-vault-button-render-and-readiness-gating) AC2). | `Index` | no | `entrypoint.sh` `start_silverbullet_supervisor` | [REQ-VAULT-012](../../sdd/spec/vault.md#req-vault-012-vault-button-render-and-readiness-gating) |
| `USER_TIMEZONE` | IANA timezone string (e.g. `Europe/Zurich`) forwarded from the `userTimezone` preference. Controls timestamps in memory-capture filenames (`Raw/Sessions/{ISO_TS}-{SID_SHORT}.md`). Falls back to `$TZ`, then `/etc/timezone`, then UTC when absent. Malformed values (non-IANA shape, path-traversal strings) are silently dropped at the DO boundary by `normalizeIanaTz`; the variable is not emitted and the UTC fallback applies, so an operator debugging an unexpected UTC timestamp should check the source `userTimezone` preference value against the IANA shape (`^[A-Za-z][A-Za-z0-9+_/-]{0,63}$`). The primary validation lives at `PATCH /api/preferences` (Zod refine + `Intl.DateTimeFormat` round-trip, returns `ValidationError` on failure); the DO check is defence-in-depth. | (absent = UTC fallback) | no | Worker -> DO via `setBucketName`; read by `entrypoint.sh` memory-capture pipeline | [REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env), [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) AC4 |
| `CODEFLARE_MEMORY_MODEL` | Optional fidelity pin (no hardcoded model name) for the Pi memory-capture and Vault-extract subagents. When set, `memory-vault.ts` passes it as the `model` option to `service.spawn(...)` for the `memory-capture` and `vault-extract` subagents so capture/extraction runs on a higher-fidelity model per [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad). When unset, no model override is passed and the subagents inherit the session model. Pi-only lever; the Claude path pins the model in agent-definition frontmatter instead. | (unset = inherit session model) | no | `~/.pi/agent/extensions/memory-vault.ts` | [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) |

### Graphify Tooling

These env vars tune the graphify knowledge-graph build/update tooling. All are optional with safe defaults - the codeflare container ships them pinned to values verified safe for a 1-vCPU / 3.2 GB RAM container.

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `GRAPHIFY_SAFE_RLIMIT_KB` | Virtual-memory cap (KB) applied to bounded Graphify update/build wrappers via `ulimit -v`. Wraps Graphify extraction/update so a runaway rebuild dies with ENOMEM rather than OOM-killing the codeflare session. | `1500000` (1.5 GB) | no | `preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh`; `preseed/agents/pi/scripts/safe-graphify-update.sh`; `preseed/agents/pi/scripts/build-graphify-ast.sh`; `preseed/agents/pi/scripts/build-graphify-architecture.sh` | [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) |
| `GRAPHIFY_SAFE_WORKERS` | Graphify extraction/update subprocess count. Forwarded to graphify as `GRAPHIFY_MAX_WORKERS`. Single-worker on a 1 vCPU container is safest. | `1` | no | `preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh`; `preseed/agents/pi/scripts/safe-graphify-update.sh`; `preseed/agents/pi/scripts/build-graphify-ast.sh`; `preseed/agents/pi/scripts/build-graphify-architecture.sh` | [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) |
| `GRAPHIFY_BUILD_TIMEOUT` | Timeout in seconds for Pi first-build wrappers before they abort rather than monopolizing the 1-vCPU session. Applies to both full AST and architecture graph builds. | `240` | no | `preseed/agents/pi/scripts/build-graphify-ast.sh`; `preseed/agents/pi/scripts/build-graphify-architecture.sh` | [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) |
| `GRAPHIFY_ARCH_EXTRA_EXCLUDES` | Additional shell-split gitignore-style patterns appended to Pi Architecture graph filters when a repo needs local noise reduction beyond the generic tests/docs/generated/config exclusions. | (unset) | no | `preseed/agents/pi/scripts/build-graphify-architecture.sh` | [REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch) |
| `GRAPHIFY_ARCH_KEEP_ISOLATES` | When truthy (`1`, `true`, `yes`), keeps isolated files in Pi Architecture graph output instead of omitting them from the module dependency map. | unset (omit isolates) | no | `preseed/agents/pi/scripts/build-graphify-architecture.sh` | [REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch) |
| `GRAPHIFY_SEMANTIC_MAX_PARALLEL` | Maximum number of semantic-extraction Task subagents dispatched per wave by the `/graphify` skill. Caps the parallel fan-out on full-semantic builds so a dense repo (with hundreds of non-code files) cannot flood the Task-tool concurrency or trip Anthropic API rate limits in a single burst. Higher values finish a build faster; lower values smooth the rate-limit / token-budget surface. | `10` | no | `preseed/agents/claude/skills/graphify/SKILL.md` Step B2 | (graphify skill operational knob) |

---

## Secrets

Repository: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, optional `RESEND_API_KEY`

Worker secrets lifecycle: deploy sets `CLOUDFLARE_API_TOKEN`, setup writes `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, Turnstile keys stored in KV. **Worker-level R2 credentials are derived from the API token** (used for bucket admin operations like create/empty/delete). Per-user scoped R2 tokens are separate - created on first login, independent of the master token but revoked when the API token changes. If the token is rotated, setup must be re-run.

### Enterprise Mode Secrets (optional)

| Secret | Purpose | Set via |
|--------|---------|---------|
| `AIG_GATEWAY_URL` | Customer AI Gateway base URL (e.g. `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/`). The `LlmInterceptor` parses the `<account>` and `<gateway>` ids from this URL to build the REST API endpoint and the `cf-aig-gateway-id` header — it is the single source of both ([REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)). When absent or unparseable, enterprise LLM routing fails closed (503) even if `ENTERPRISE_MODE=active`. | GitHub Actions secret -> `wrangler secret put AIG_GATEWAY_URL` (deploy.yml) |
| `AIG_TOKEN` | **Cloudflare API token with the "Workers AI" permission** (`Read` scope). Sent as `Authorization: Bearer` to `api.cloudflare.com/.../ai/v1/*`. See the warning below — two common credential types are rejected with `error 10000`. Read exclusively by `LlmInterceptor`; never injected into the container. | GitHub Actions secret -> `wrangler secret put AIG_TOKEN` (deploy.yml) |

Both secrets are optional and silently skipped when absent; a deployment without them behaves identically to a non-enterprise deployment regardless of the `ENTERPRISE_MODE` variable. See [Architecture - Enterprise LLM Routing](architecture.md#enterprise-llm-routing-enterprise-mode) and [Deployment - Enterprise Secrets](deployment.md#enterprise-mode-secrets).

> **AIG_TOKEN credential type — important.** The `/ai/v1/*` endpoint is in the **Workers AI** namespace; it takes a standard Cloudflare API token in `Authorization`, not a gateway authentication token. **Two types are rejected with `error 10000`:** (a) an AI Gateway *authentication* token minted in the gateway's own settings (works only on the deprecated `gateway.ai.cloudflare.com` path), and (b) a CF API token scoped to **"AI Gateway: Run"** (wrong permission for this endpoint — confirmed 2026-06-05). The `cfut_` prefix is shared across all CF API token types and does **not** indicate scope — verify the permission label, not the prefix. **Do not use the gateway's "Authenticated Gateway" → "Create authentication token" button**: despite Cloudflare's docs pointing at it, that button mints an "AI Gateway: Run" token which this endpoint rejects. Create the token **manually** with the **Workers AI** permission. See [AD74](decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api) for full rationale.

## CORS

Dynamic: setup wizard adds custom domain + `.workers.dev` to KV. `ALLOWED_ORIGINS` env var is static fallback.

`R2_ACCOUNT_ID` and `R2_ENDPOINT` resolved dynamically (env vars with KV fallback).

## Container Specs

| Tier | Config | Max Instances | Notes |
|------|--------|---------------|-------|
| `low` | `basic` (0.25 vCPU, 1 GiB, 4 GB) | 10 | Sub-1-vCPU workloads |
| default | 1 vCPU, 3 GiB, 6 GB | 10 | Baseline for node-pty + agent CLIs |
| `high` | 2 vCPU, 6 GiB, 8 GB | 10 | Higher parallelism |

Selected via the `RESSOURCE_TIER` GitHub Actions repo variable at deploy time (`low` / `default` / `high`). The misspelling (French/German "ressource") is intentional and preserved across `wrangler.toml`, GitHub Actions variables, and TypeScript types for backward compatibility with deployed instances. Do not "fix" the spelling; renaming requires a coordinated change across every deployment.

Base image: Node.js 24 Debian (bookworm-slim).

## API Token Permissions

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

### Cloudflare API Token (User)

Users connect their Cloudflare account by creating an API token. Codeflare offers three scope tiers -- choose based on what you build:

| Scope | Minimal | Recommended | Advanced | Why |
|---|---|---|---|---|
| **Workers Scripts: Edit** | yes | yes | yes | Deploy Workers and manage secrets |
| **Workers KV Storage: Edit** | yes | yes | yes | KV namespace management |
| **Workers R2 Storage: Edit** | yes | yes | yes | Object storage for user data |
| **D1: Edit** | yes | yes | yes | SQL database management |
| **Workers Routes: Edit** | yes | yes | yes | Route traffic to Workers |
| **Account Settings: Read** | yes | yes | yes | Account ID discovery |
| **Zone: Read** | yes | yes | yes | Zone ID resolution |
| **DNS: Edit** | - | yes | yes | Manage DNS records for custom domains |
| **Access: Apps and Policies: Edit** | - | yes | yes | Cloudflare Access applications |
| **Access: Orgs, IdPs, and Groups: Edit** | - | yes | yes | Access groups and identity providers |
| **Cloudflare Pages: Edit** | - | - | yes | Deploy static sites and full-stack apps |
| **Containers: Edit** | - | - | yes | Container lifecycle management |
| **API Tokens: Edit** | - | - | yes | Create/revoke scoped tokens programmatically |
| **Queues: Edit** | - | - | yes | Message queue management |
| **Workers AI: Edit** | - | - | yes | Inference and model management |
| **Workers AI: Read** | - | - | yes | Read-only inference access |
| **Vectorize: Edit** | - | - | yes | Vector database for AI embeddings |
| **Turnstile: Edit** | - | - | yes | CAPTCHA widget management |
| **Workers Builds Configuration: Edit** | - | - | yes | CI/CD build pipeline configuration |
| **Workers Observability: Edit** | - | - | yes | Logs, traces, and monitoring |
| **Workers R2 Data Catalog: Edit** | - | - | yes | R2 bucket metadata and catalog |
| **Workers Agents Configuration: Edit** | - | - | yes | Cloudflare Agents configuration |
| **Browser Rendering: Edit** | - | - | yes | Browser Run WebFetch fallback: Claude Code via `chrome-devtools-mcp` MCP server; Pi via native `browser-run.ts` extension (REST Quick Actions). Advanced mode only; no-op when token absent. (REQ-BROWSER-002) |

The connect flow pre-fills the Cloudflare dashboard token creation form with the correct permissions for the selected tier. Cloudflare API tokens do not expire by default but can be set to expire during creation. Scope tokens to specific accounts and zones, or use "All accounts" and "All zones" for convenience. Implements [REQ-AGENT-028](../../sdd/spec/agents.md#req-agent-028-deploy-credential-token-creation-ux) AC2.

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
- You can scope tokens to specific repositories or all repositories. For a cloud IDE, "All repositories" is typical since you may create new repos from sessions.

---

## Specification Coverage

- [REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) - ENTERPRISE_MODE forces unlimited tier and Pro mode
- [REQ-ENTERPRISE-003](../../sdd/spec/enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode) - Agent allowlist in Enterprise Mode
- [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) - Outbound-interception LLM routing to customer AI Gateway (AIG_GATEWAY_URL, AIG_TOKEN)
- [REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) - Deploy-time AIG secrets and ENTERPRISE_MODE var (AIG_GATEWAY_URL, AIG_TOKEN, AIG_LANGUAGE_MODEL)
- [REQ-ENTERPRISE-007](../../sdd/spec/enterprise-mode.md#req-enterprise-007-gateway-route-pinning) - Gateway route-pinning (AIG_LANGUAGE_MODEL)
- [REQ-BROWSER-002](../../sdd/spec/browser-run.md#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template) - Browser Rendering scope in the Cloudflare token template
- [REQ-OPS-012](../../sdd/spec/operations.md#req-ops-012-per-environment-container-concurrency-limit) - Per-environment container concurrency limit
- [REQ-SETUP-004](../../sdd/spec/setup.md#req-setup-004-setup-is-idempotent) - Setup is idempotent
- [REQ-SETUP-006](../../sdd/spec/setup.md#req-setup-006-setup-streams-progress-via-ndjson) - Setup streams progress via NDJSON
- [REQ-SETUP-007](../../sdd/spec/setup.md#req-setup-007-custom-domain-with-dns-validation) - Custom domain with DNS validation
- [REQ-SETUP-009](../../sdd/spec/setup.md#req-setup-009-subscribe-page-with-tier-selection) - Subscribe page with tier selection
- [REQ-SETUP-010](../../sdd/spec/setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page) - Social-share preview metadata on the public landing page
- [REQ-SETUP-011](../../sdd/spec/setup.md#req-setup-011-setup-stream-completion-payload-contract) - Setup stream completion payload contract

---

## Related Documentation
- [Container](container.md#auto-sleep-configurable-sleepafter) - Container startup and auto-sleep configuration
- [Authentication](authentication.md#environment-variables-for-saas-mode) - SaaS mode variables
- [Security](security.md#credential-encryption-at-rest) - Encryption key details
- [CI/CD](ci-cd.md#github-secrets-and-variables) - CI secrets and variables
