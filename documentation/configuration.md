# Configuration

Environment variables, secrets, CORS configuration, and API token permissions.

**Audience:** Operators

---

## Environment Variables

### Worker Environment

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `SERVICE_TOKEN_EMAIL` | Email for service token auth | TBD | no | Optional | TBD |
| `CLOUDFLARE_API_TOKEN` | R2 bucket creation | TBD | yes | Wrangler secret | TBD |
| `R2_ACCESS_KEY_ID` | R2 auth for containers | TBD | yes | Wrangler secret | TBD |
| `R2_SECRET_ACCESS_KEY` | R2 auth for containers | TBD | yes | Wrangler secret | TBD |
| `R2_ACCOUNT_ID` | R2 endpoint construction | TBD | no | Dynamic (env with KV fallback) | TBD |
| `R2_ENDPOINT` | S3-compatible endpoint | TBD | no | Dynamic (env with KV fallback) | TBD |
| `ALLOWED_ORIGINS` | CORS patterns (comma-separated) | TBD | no | wrangler.toml | TBD |
| `LOG_LEVEL` | Min log level (default: "info") | TBD | no | wrangler.toml | TBD |
| `ONBOARDING_LANDING_PAGE` | `"active"` enables public waitlist landing | TBD | no | wrangler.toml | TBD |
| `TURNSTILE_SECRET_KEY` | Optional direct Turnstile secret override | TBD | no | Optional | TBD |
| `RESEND_API_KEY` | Notification emails (waitlist, access requests, subscriptions, tier changes) | TBD | no | Optional | TBD |
| `RESEND_EMAIL` | Sender identity for notification emails (default: `Codeflare <onboarding@resend.dev>`) | TBD | no | Optional | TBD |
| `CLOUDFLARE_WORKER_NAME` | Worker name override for forks (set at deploy time via `--var`, also used at runtime by worker code) | TBD | yes | GitHub Actions variable / Worker runtime env | TBD |
| `MAX_SESSIONS_USER` | Per-user session cap (default: 3) | TBD | no | wrangler.toml | TBD |
| `MAX_SESSIONS_ADMIN` | Per-admin session cap (default: 10) | TBD | no | wrangler.toml | TBD |
| `MAX_USERS` | **Removed** — replaced by KV key `setup:max_users` (admin-configurable via User Management page). | TBD | no | — | TBD |
| `SERVICE_AUTH_SECRET` | Worker secret for E2E/CLI service auth (`X-Service-Auth` header) | TBD | no | Worker secret (optional) | TBD |
| `STRESS_TEST_MODE` | `"active"` disables all rate limits (integration only) | TBD | no | Worker env var | TBD |
| `SAAS_MODE` | `"active"` enables custom login page, auto-provisioning, admin approval | TBD | yes | GitHub Actions variable -> `--var` at deploy | TBD |
| `SAAS_EXTRA_IDPS` | Comma-separated IdP UUIDs for custom OIDC providers on login page | TBD | yes | GitHub Actions variable -> `--var` at deploy | TBD |
| `ENCRYPTION_KEY` | AES-256-GCM encryption key for `llm-keys:*`, `deploy-keys:*`, and `r2token:*` KV entries, also used as R2 SSE-C key | TBD | yes | Wrangler secret (optional) | TBD |

### Container Environment

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `R2_BUCKET_NAME` | User's personal bucket | TBD | no | Worker -> DO via `setBucketName` | TBD |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | rclone auth | Worker -> DO (preferred) or DO `this.env` fallback |
| `R2_ACCOUNT_ID` / `R2_ENDPOINT` | rclone endpoint | Worker -> DO or `getR2Config()` fallback |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 compatibility | Mirrors R2 keys |
| `TERMINAL_PORT` | Always 8080 | TBD | no | Hardcoded | TBD |
| `SYNC_MODE` | Sync strategy (`none`, `full`, or `metadata`) | TBD | no | Worker -> DO | TBD |
| `WORKSPACE_SYNC_ENABLED` | Whether workspace sync is enabled (`'true'`/`'false'`) | TBD | no | Worker via `setBucketName` | TBD |
| `TAB_CONFIG` | JSON array of terminal tab configurations | TBD | no | Worker -> DO | TBD |
| `TERMINAL_ID` | Unique ID for this terminal instance | TBD | no | Host terminal server | TBD |
| `CONTAINER_AUTH_TOKEN` | Auth token for container API calls, scoped to one DO lifecycle. See [security.md](./security.md#container-auth-token-req-sec-012). | TBD | no | Worker -> DO | TBD |
| `MANUAL_TAB` | Set to `1` for user-created tabs to skip autostart | TBD | no | Worker -> DO | TBD |
| `FAST_CLI_START` | Disables auto-update for all 5 AI tools when `'true'` (default) | TBD | no | Worker -> DO | TBD |
| `OPENAI_API_KEY` | OpenAI API key for consult-llm-mcp MCP server (optional) | TBD | no | Worker -> DO (from KV `llm-keys:{bucket}`) | TBD |
| `GEMINI_API_KEY` | Gemini API key for consult-llm-mcp MCP server (optional) | TBD | no | Worker -> DO (from KV `llm-keys:{bucket}`) | TBD |
| `ENCRYPTION_KEY` | AES-256 key (base64) for rclone SSE-C. Appended to `rclone.conf` as `sse_customer_key_base64`. | TBD | no | Worker -> DO (from `env.ENCRYPTION_KEY`) | TBD |
| `SESSION_MODE` | Session mode (`'default'` or `'advanced'`) — controls memory persistence and rclone filters | TBD | no | Worker -> DO via `setBucketName` | TBD |
| `NODE_COMPILE_CACHE` | V8 compile cache dir for faster Node.js CLI startup | TBD | no | Dockerfile ENV (`/root/.cache/node-compile-cache`) | TBD |
| `BROWSER` | Points to `open-url` shim that exits 1 | TBD | no | Dockerfile ENV (`/usr/local/bin/open-url`) | TBD |
| `SB_INDEX_PAGE` | Landing page when SilverBullet opens (case-sensitive page name, no `.md`). SB Go server defaults to `"index"` (lowercase); set to `Index` so the Codeflare dashboard loads on Vault button click. See [vault.md](./vault.md#silverbullet-editor-req-vault-005) (REQ-VAULT-005 AC9). | `Index` | no | `entrypoint.sh` `start_silverbullet_supervisor` | REQ-VAULT-005 |
| `USER_TIMEZONE` | IANA timezone string (e.g. `Europe/Zurich`) forwarded from the `userTimezone` preference. Controls timestamps in memory-capture filenames (`Raw/Sessions/{ISO_TS}-{SID_SHORT}.md`). Falls back to `$TZ`, then `/etc/timezone`, then UTC when absent. | (absent = UTC fallback) | no | Worker -> DO via `setBucketName`; read by `entrypoint.sh` memory-capture pipeline | REQ-SESSION-016, REQ-MEM-001 AC9 |

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
| `low` | `basic` (0.25 vCPU, 1 GiB, 4 GB) | TBD | no | 10 | Sub-1-vCPU workloads | TBD |
| default | 1 vCPU, 3 GiB, 6 GB | 10 | Baseline for node-pty + agent CLIs |
| `high` | 2 vCPU, 6 GiB, 8 GB | TBD | no | 10 | Higher parallelism | TBD |

Selected via the `RESSOURCE_TIER` GitHub Actions repo variable at deploy time (`low` / `default` / `high`). The misspelling (French/German "ressource") is intentional and preserved across `wrangler.toml`, GitHub Actions variables, and TypeScript types for backward compatibility with deployed instances. Do not "fix" the spelling; renaming requires a coordinated change across every deployment.

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
