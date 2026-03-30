# Configuration

Environment variables, secrets, CORS configuration, and API token permissions.

**Audience:** Operators

---

## Environment Variables

### Worker Environment

| Variable | Purpose | Source |
|----------|---------|--------|
| `SERVICE_TOKEN_EMAIL` | Email for service token auth | Optional |
| `CLOUDFLARE_API_TOKEN` | R2 bucket creation | Wrangler secret |
| `R2_ACCESS_KEY_ID` | R2 auth for containers | Wrangler secret |
| `R2_SECRET_ACCESS_KEY` | R2 auth for containers | Wrangler secret |
| `R2_ACCOUNT_ID` | R2 endpoint construction | Dynamic (env with KV fallback) |
| `R2_ENDPOINT` | S3-compatible endpoint | Dynamic (env with KV fallback) |
| `ALLOWED_ORIGINS` | CORS patterns (comma-separated) | wrangler.toml |
| `LOG_LEVEL` | Min log level (default: "info") | wrangler.toml |
| `ONBOARDING_LANDING_PAGE` | `"active"` enables public waitlist landing | wrangler.toml |
| `TURNSTILE_SECRET_KEY` | Optional direct Turnstile secret override | Optional |
| `RESEND_API_KEY` | Notification emails (waitlist, access requests, subscriptions, tier changes) | Optional |
| `RESEND_EMAIL` | Sender identity for notification emails (default: `Codeflare <onboarding@resend.dev>`) | Optional |
| `CLOUDFLARE_WORKER_NAME` | Worker name override for forks (set at deploy time via `--var`, also used at runtime by worker code) | GitHub Actions variable / Worker runtime env |
| `MAX_SESSIONS_USER` | Per-user session cap (default: 3) | wrangler.toml |
| `MAX_SESSIONS_ADMIN` | Per-admin session cap (default: 10) | wrangler.toml |
| `MAX_USERS` | **Removed** — replaced by KV key `setup:max_users` (admin-configurable via User Management page). | — |
| `SERVICE_AUTH_SECRET` | Worker secret for E2E/CLI service auth (`X-Service-Auth` header) | Worker secret (optional) |
| `STRESS_TEST_MODE` | `"active"` disables all rate limits (integration only) | Worker env var |
| `SAAS_MODE` | `"active"` enables custom login page, auto-provisioning, admin approval | GitHub Actions variable -> `--var` at deploy |
| `SAAS_EXTRA_IDPS` | Comma-separated IdP UUIDs for custom OIDC providers on login page | GitHub Actions variable -> `--var` at deploy |
| `ENCRYPTION_KEY` | AES-256-GCM encryption key for `llm-keys:*`, `deploy-keys:*`, and `r2token:*` KV entries, also used as R2 SSE-C key | Wrangler secret (optional) |

### Container Environment

| Variable | Purpose | Source |
|----------|---------|--------|
| `R2_BUCKET_NAME` | User's personal bucket | Worker -> DO via `setBucketName` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | rclone auth | Worker -> DO (preferred) or DO `this.env` fallback |
| `R2_ACCOUNT_ID` / `R2_ENDPOINT` | rclone endpoint | Worker -> DO or `getR2Config()` fallback |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 compatibility | Mirrors R2 keys |
| `TERMINAL_PORT` | Always 8080 | Hardcoded |
| `SYNC_MODE` | Sync strategy (`none`, `full`, or `metadata`) | Worker -> DO |
| `WORKSPACE_SYNC_ENABLED` | Whether workspace sync is enabled (`'true'`/`'false'`) | Worker via `setBucketName` |
| `TAB_CONFIG` | JSON array of terminal tab configurations | Worker -> DO |
| `TERMINAL_ID` | Unique ID for this terminal instance | Host terminal server |
| `CONTAINER_AUTH_TOKEN` | Auth token for container API calls | Worker -> DO |
| `MANUAL_TAB` | Set to `1` for user-created tabs to skip autostart | Worker -> DO |
| `FAST_CLI_START` | Disables auto-update for all 5 AI tools when `'true'` (default) | Worker -> DO |
| `OPENAI_API_KEY` | OpenAI API key for consult-llm-mcp MCP server (optional) | Worker -> DO (from KV `llm-keys:{bucket}`) |
| `GEMINI_API_KEY` | Gemini API key for consult-llm-mcp MCP server (optional) | Worker -> DO (from KV `llm-keys:{bucket}`) |
| `ENCRYPTION_KEY` | AES-256 key (base64) for rclone SSE-C. Appended to `rclone.conf` as `sse_customer_key_base64`. | Worker -> DO (from `env.ENCRYPTION_KEY`) |
| `SESSION_MODE` | Session mode (`'default'` or `'advanced'`) — controls memory persistence and rclone filters | Worker -> DO via `setBucketName` |
| `NODE_COMPILE_CACHE` | V8 compile cache dir for faster Node.js CLI startup | Dockerfile ENV (`/root/.cache/node-compile-cache`) |
| `BROWSER` | Points to `open-url` shim that exits 1 | Dockerfile ENV (`/usr/local/bin/open-url`) |

---

## Secrets

Repository: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, optional `RESEND_API_KEY`

Worker secrets lifecycle: deploy sets `CLOUDFLARE_API_TOKEN`, setup writes `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, Turnstile keys stored in KV. **Worker-level R2 credentials are derived from the API token** (used for bucket admin operations like create/empty/delete). Per-user scoped R2 tokens are separate — created on first login, independent of the master token but revoked when the API token changes. If the token is rotated, setup must be re-run.

## CORS

Dynamic: setup wizard adds custom domain + `.workers.dev` to KV. `ALLOWED_ORIGINS` env var is static fallback.

`R2_ACCOUNT_ID` and `R2_ENDPOINT` resolved dynamically (env vars with KV fallback).

## Container Specs

| Tier | Config | Max Instances | Notes |
|------|--------|---------------|-------|
| `low` | `basic` (0.25 vCPU, 1 GiB, 4 GB) | 10 | Sub-1-vCPU workloads |
| default | 1 vCPU, 3 GiB, 6 GB | 10 | Baseline for node-pty + agent CLIs |
| `high` | 2 vCPU, 6 GiB, 8 GB | 10 | Higher parallelism |

Base image: Node.js 24 Debian (bookworm-slim).

## API Token Permissions

### Account Permissions

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

### Zone Permissions

| Permission | Access | Required | Why |
|-----------|--------|----------|-----|
| Zone | Read | Yes | Zone ID resolution |
| DNS | Edit | Yes | Proxied CNAME |
| Workers Routes | Edit | Yes | Worker route upsert |

---

## Related Documentation
- [Container](container.md#auto-sleep) - Container startup and auto-sleep configuration
- [Authentication](authentication.md#environment-variables-for-saas-mode) - SaaS mode variables
- [Security](security.md#credential-encryption-at-rest) - Encryption key details
- [CI/CD](ci-cd.md#github-secrets-and-variables) - CI secrets and variables
