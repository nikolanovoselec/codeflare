# Configuration

Environment variables, secrets, CORS configuration, and API token permissions.

**Audience:** Operators

---

## Environment Variables

### Worker Environment

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `SERVICE_TOKEN_EMAIL` | Email for service token auth | — | no | Optional | [REQ-AUTH-003](../../sdd/spec/authentication.md#req-auth-003), [REQ-SETUP-003](../../sdd/spec/setup.md#req-setup-003) |
| `CLOUDFLARE_API_TOKEN` | R2 bucket creation | — | yes | Wrangler secret | [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001), [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002) |
| `R2_ACCESS_KEY_ID` | R2 auth for containers | — | yes | Wrangler secret | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001), [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002) |
| `R2_SECRET_ACCESS_KEY` | R2 auth for containers | — | yes | Wrangler secret | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001), [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002) |
| `R2_ACCOUNT_ID` | R2 endpoint construction | — | no | Dynamic (env with KV fallback) | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001), [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002) |
| `R2_ENDPOINT` | S3-compatible endpoint | — | no | Dynamic (env with KV fallback) | [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001), [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002) |
| `ALLOWED_ORIGINS` | CORS patterns (comma-separated) | — | no | wrangler.toml | [REQ-SEC-008](../../sdd/spec/security.md#req-sec-008), [REQ-OPS-008](../../sdd/spec/operations.md#req-ops-008) |
| `LOG_LEVEL` | Min log level (default: "info") | `info` | no | wrangler.toml | [REQ-OPS-008](../../sdd/spec/operations.md#req-ops-008) |
| `ONBOARDING_LANDING_PAGE` | `"active"` enables public waitlist landing | inactive | no | wrangler.toml | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012) |
| `TURNSTILE_SECRET_KEY` | Optional direct Turnstile secret override | — | no | Optional | [REQ-SETUP-002](../../sdd/spec/setup.md#req-setup-002), [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003) |
| `RESEND_API_KEY` | Notification emails (waitlist, access requests, subscriptions, tier changes) | — | no | Optional | [REQ-AUTH-011](../../sdd/spec/authentication.md#req-auth-011), [REQ-AUTH-012](../../sdd/spec/authentication.md#req-auth-012) |
| `RESEND_EMAIL` | Sender identity for notification emails (default: `Codeflare <onboarding@resend.dev>`) | `Codeflare <onboarding@resend.dev>` | no | Optional | [REQ-AUTH-012](../../sdd/spec/authentication.md#req-auth-012) |
| `CLOUDFLARE_WORKER_NAME` | Worker name override for forks (set at deploy time via `--var`, also used at runtime by worker code) | — | yes | GitHub Actions variable / Worker runtime env | [REQ-AUTH-001](../../sdd/spec/authentication.md#req-auth-001), [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001) |
| `MAX_SESSIONS_USER` | Per-user session cap (default: 3) | `3` | no | wrangler.toml | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001), [REQ-OPS-007](../../sdd/spec/operations.md#req-ops-007) |
| `MAX_SESSIONS_ADMIN` | Per-admin session cap (default: 10) | `10` | no | wrangler.toml | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001), [REQ-OPS-007](../../sdd/spec/operations.md#req-ops-007) |
| `MAX_USERS` | **Removed** — replaced by KV key `setup:max_users` (admin-configurable via User Management page). | — | no | — | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018), [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003) |
| `SERVICE_AUTH_SECRET` | Worker secret for E2E/CLI service auth (`X-Service-Auth` header) | — | no | Worker secret (optional) | [REQ-AUTH-003](../../sdd/spec/authentication.md#req-auth-003), [REQ-SETUP-003](../../sdd/spec/setup.md#req-setup-003) |
| `STRESS_TEST_MODE` | `"active"` disables all rate limits (integration only) | inactive | no | Worker env var | [REQ-OPS-007](../../sdd/spec/operations.md#req-ops-007), [REQ-SEC-019](../../sdd/spec/security.md#req-sec-019) |
| `SAAS_MODE` | `"active"` enables custom login page, auto-provisioning, admin approval | inactive | yes | GitHub Actions variable -> `--var` at deploy | [REQ-AUTH-001](../../sdd/spec/authentication.md#req-auth-001) |
| `SAAS_EXTRA_IDPS` | Comma-separated IdP UUIDs for custom OIDC providers on login page | — | yes | GitHub Actions variable -> `--var` at deploy | [REQ-AUTH-008](../../sdd/spec/authentication.md#req-auth-008) |
| `ENCRYPTION_KEY` | AES-256-GCM encryption key for `llm-keys:*`, `deploy-keys:*`, and `r2token:*` KV entries, also used as R2 SSE-C key | — | yes | Wrangler secret (optional) | [REQ-SEC-002](../../sdd/spec/security.md#req-sec-002), [REQ-SEC-005](../../sdd/spec/security.md#req-sec-005) |

### Container Environment

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `R2_BUCKET_NAME` | User's personal bucket | — | no | Worker -> DO via `setBucketName` | [REQ-SESSION-003](../../sdd/spec/session-lifecycle.md#req-session-003), [REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | rclone auth | Worker -> DO (preferred) or DO `this.env` fallback |
| `R2_ACCOUNT_ID` / `R2_ENDPOINT` | rclone endpoint | Worker -> DO or `getR2Config()` fallback |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 compatibility | Mirrors R2 keys |
| `TERMINAL_PORT` | Always 8080 | `8080` | no | Hardcoded | [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002) |
| `SYNC_MODE` | Sync strategy (`none`, `full`, or `metadata`). Derived from `workspaceSyncEnabled`: `false` -> `none`, `true` -> `full`. `metadata` is a legacy value not currently selectable from the UI. | `none` | no | Worker -> DO | [REQ-STOR-003](../../sdd/spec/storage.md#req-stor-003) |
| `WORKSPACE_SYNC_ENABLED` | Whether workspace sync is enabled (`'true'`/`'false'`). User-toggleable in Settings; opt-in because syncing `~/workspace/` slows every bisync cycle. | `'false'` | no | Worker via `setBucketName` | [REQ-STOR-003](../../sdd/spec/storage.md#req-stor-003) |
| `TAB_CONFIG` | JSON array of terminal tab configurations | — | no | Worker -> DO | [REQ-AGENT-002](../../sdd/spec/agents.md#req-agent-002), [REQ-AGENT-003](../../sdd/spec/agents.md#req-agent-003), [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002) |
| `TERMINAL_ID` | Unique ID for this terminal instance | — | no | Host terminal server | [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002) |
| `CONTAINER_AUTH_TOKEN` | Auth token for container API calls, scoped to one DO lifecycle. See [security.md](./security.md#container-auth-token-req-sec-012). | — | no | Worker -> DO | [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011), [REQ-SESSION-002](../../sdd/spec/session-lifecycle.md#req-session-002) |
| `MANUAL_TAB` | Set to `1` for user-created tabs to skip autostart | — | no | Worker -> DO | [REQ-TERM-006](../../sdd/spec/terminal.md#req-term-006) |
| `FAST_CLI_START` | Disables auto-update for all 5 AI tools when `'true'` (default) | `'true'` | no | Worker -> DO | [REQ-AGENT-012](../../sdd/spec/agents.md#req-agent-012) |
| `OPENAI_API_KEY` | OpenAI API key for consult-llm-mcp MCP server (optional) | — | no | Worker -> DO (from KV `llm-keys:{bucket}`) | [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009), [REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005) |
| `GEMINI_API_KEY` | Gemini API key for consult-llm-mcp MCP server (optional) | — | no | Worker -> DO (from KV `llm-keys:{bucket}`) | [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009), [REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006) |
| `ENCRYPTION_KEY` | AES-256 key (base64) for rclone SSE-C. Appended to `rclone.conf` as `sse_customer_key_base64`. | — | no | Worker -> DO (from `env.ENCRYPTION_KEY`) | [REQ-SEC-002](../../sdd/spec/security.md#req-sec-002), [REQ-SEC-005](../../sdd/spec/security.md#req-sec-005) |
| `SESSION_MODE` | Session mode (`'default'` or `'advanced'`) — controls memory persistence and rclone filters | `'default'` | no | Worker -> DO via `setBucketName` | [REQ-MEM-011](../../sdd/spec/memory.md#req-mem-011), [REQ-AGENT-003](../../sdd/spec/agents.md#req-agent-003) |
| `NODE_COMPILE_CACHE` | V8 compile cache dir for faster Node.js CLI startup | `/root/.cache/node-compile-cache` | no | Dockerfile ENV | [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001) |
| `BROWSER` | Points to `open-url` shim that exits 1 | `/usr/local/bin/open-url` | no | Dockerfile ENV | [REQ-AGENT-013](../../sdd/spec/agents.md#req-agent-013) |
| `SB_INDEX_PAGE` | Landing page when SilverBullet opens (case-sensitive page name, no `.md`). SB Go server defaults to `"index"` (lowercase); set to `Index` so the Codeflare dashboard loads on Vault button click. See [vault.md](./vault.md#silverbullet-editor-req-vault-005) (REQ-VAULT-012 AC2). | `Index` | no | `entrypoint.sh` `start_silverbullet_supervisor` | REQ-VAULT-012 |
| `USER_TIMEZONE` | IANA timezone string (e.g. `Europe/Zurich`) forwarded from the `userTimezone` preference. Controls timestamps in memory-capture filenames (`Raw/Sessions/{ISO_TS}-{SID_SHORT}.md`). Falls back to `$TZ`, then `/etc/timezone`, then UTC when absent. Malformed values (non-IANA shape, path-traversal strings) are silently dropped at the DO boundary by `normalizeIanaTz`; the variable is not emitted and the UTC fallback applies, so an operator debugging an unexpected UTC timestamp should check the source `userTimezone` preference value against the IANA shape (`^[A-Za-z][A-Za-z0-9+_/-]{0,63}$`). The primary validation lives at `PATCH /api/preferences` (Zod refine + `Intl.DateTimeFormat` round-trip, returns `ValidationError` on failure); the DO check is defence-in-depth. | (absent = UTC fallback) | no | Worker -> DO via `setBucketName`; read by `entrypoint.sh` memory-capture pipeline | REQ-SESSION-016, REQ-MEM-001 AC4 |

### Graphify Tooling

These env vars tune the graphify knowledge-graph build/update tooling. All are optional with safe defaults — the codeflare container ships them pinned to values verified safe for a 1-vCPU / 3.2 GB RAM container.

| Variable | Purpose | Default | Required | Consumed by | Implements |
|----------|---------|---------|----------|-------------|------------|
| `GRAPHIFY_SAFE_RLIMIT_KB` | Virtual-memory cap (KB) applied to `graphify update` via `ulimit -v`. Wraps the AST extraction so a runaway rebuild dies with ENOMEM rather than OOM-killing the codeflare session. | `1500000` (1.5 GB) | no | `preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh` | REQ-AGENT-023 |
| `GRAPHIFY_SAFE_WORKERS` | AST extraction subprocess count for `graphify update`. Forwarded to graphify as `GRAPHIFY_MAX_WORKERS`. Single-worker on a 1 vCPU container is safest. | `1` | no | `preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh` | REQ-AGENT-023 |
| `GRAPHIFY_SEMANTIC_MAX_PARALLEL` | Maximum number of semantic-extraction Task subagents dispatched per wave by the `/graphify` skill. Caps the parallel fan-out on full-semantic builds so a dense repo (with hundreds of non-code files) cannot flood the Task-tool concurrency or trip Anthropic API rate limits in a single burst. Higher values finish a build faster; lower values smooth the rate-limit / token-budget surface. | `10` | no | `preseed/agents/claude/skills/graphify/SKILL.md` Step B2 | (graphify skill operational knob) |

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
