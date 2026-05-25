# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly via [GitHub's private vulnerability reporting](https://github.com/nikolanovoselec/codeflare/security/advisories/new).

**Do not open a public issue for security vulnerabilities.**

You can expect an initial response within 72 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

For more information, see [GitHub's guide on privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

## Security Architecture

### Authentication

Codeflare supports two authentication modes:

- **Cloudflare Access (default/onboarding mode):** CF Access validates identity via configured identity providers (Google, GitHub, etc.) and issues JWTs. The worker verifies JWTs against CF Access JWKS endpoints using RS256.
- **GitHub OIDC (SaaS mode):** When `OAUTH_CLIENT_ID` is configured, the Worker handles authentication directly via GitHub OAuth with HMAC-SHA256 session cookies (`codeflare_session`, HttpOnly, Secure, SameSite=Lax, 1-hour TTL). Only verified GitHub emails are accepted. Cookie auto-refreshes when < 15 minutes remain.
- **Service tokens:** E2E tests and automated systems authenticate via `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers, or via `X-Service-Auth` header matching the `SERVICE_AUTH_SECRET` worker secret.
- **Email normalization:** User emails are trimmed and lowercased before KV lookup to prevent casing-based bypass.
- **Three-tier access control** enforced via middleware:
  - `requireIdentity`: Authenticates request only, permits all users (pending, standard, advanced, blocked).
  - `requireActiveUser`: Authenticates + enforces subscription tier gating when SaaS mode is active. Pending/blocked users receive 403 error. Active tiers: `free`, `trial`, `standard`, `advanced`, `max`, `unlimited`, or `undefined` (non-SaaS backward compat).
  - `requireAdmin`: Requires `role: 'admin'`. Must follow requireIdentity or requireActiveUser.
- **SaaS mode (JIT provisioning):** When `SAAS_MODE=active`, new users are auto-provisioned with `pending` tier. Redirects pending users to `/app/subscribe` on HTML requests, or returns 403 with code `PENDING` on API requests. Blocked users receive 403 with code `BLOCKED`.
- **Self-service subscription:** Pending users choose a subscription tier (free, standard, advanced, max, unlimited) at `/app/subscribe`. Cloudflare Turnstile CAPTCHA protects the subscription form for new subscriptions (plan changes by already-subscribed users skip Turnstile). Trial periods are configurable per tier and enforced server-side.
- **Subscription tier-based access control:** 8-tier system (blocked/pending/free/trial/standard/advanced/max/unlimited) controls monthly compute hours, max concurrent sessions, allowed session modes, pricing, and trial eligibility. Quota enforcement is server-side only — frontend displays are informational. Service tokens are treated as `unlimited` tier. Non-SaaS deployments resolve all users to `unlimited`.
- **Pro mode dual-gate:** Access to Pro (advanced) session mode requires both (1) a tier that supports advanced mode (`advanced`, `max`, `unlimited`, or unset) AND (2) `subscribedMode === 'advanced'` in the user's KV record at `user:{email}`. The `subscribedMode` field is set by `POST /api/auth/subscribe` and is NOT changed by the Settings session mode toggle. This prevents users from bypassing subscription by toggling the Settings preference -- the gate checks what they paid for (`subscribedMode`), not what they selected in Settings (`sessionMode`).
- **Usage quota enforcement:** Monthly compute hours are enforced at session start (HTTP 402 when quota exceeded) and mid-session via Timekeeper DO ping. Server-side only — cannot be bypassed by frontend manipulation. When quota is exceeded mid-session, containers are gracefully shut down via `SIGTERM`.
- **Session limits:** Tier-based (`maxSessions` per tier config), with env var fallback via `MAX_SESSIONS_USER` (default 3) and `MAX_SESSIONS_ADMIN` (default 10). Enforced at container creation time.

### Security Headers

Every response from the worker includes the following security headers:

| Header | Value | Purpose |
|--------|-------|---------|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Enforces HTTPS (2-year max-age with preload) |
| `Content-Security-Policy` | `default-src 'none'` (API responses); `default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' wss:; img-src 'self' data: https://www.gravatar.com; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` (HTML responses) | Prevents XSS and injection |
| `X-Frame-Options` | `DENY` | Prevents clickjacking |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` | Disables unnecessary browser APIs |

### Rate Limiting

- **KV-backed per-user rate limiting** on API endpoints via `src/middleware/rate-limit.ts`.
- **WebSocket connection rate limiting:** `WS_RATE_LIMIT_WINDOW_MS = 60,000` with `WS_RATE_LIMIT_MAX_CONNECTIONS = 30` per window.
- **Subscribe endpoint rate limiting:** `POST /api/auth/subscribe` is rate limited to 3 requests per minute per user via `subscribeRateLimiter` in `src/routes/auth.ts`.
- **Session caps:** `MAX_SESSIONS_USER = 3` (default), `MAX_SESSIONS_ADMIN = 10` (default). Configurable via worker variables. In SaaS mode, tier-based `maxSessions` overrides env var defaults.
- **Stress test bypass:** When `STRESS_TEST_MODE` is set to `"active"`, all rate limits (HTTP and WebSocket) are bypassed. This variable is **only set on the integration worker** for k6 load testing. Production workers must never have this variable set. The bypass requires the exact string `"active"` — no other value disables rate limiting.

### Input Validation

- **Zod schemas** validate all API request bodies and parameters (backend: `src/lib/schemas.ts`, frontend: `web-ui/src/lib/schemas.ts`).
- **Body size limit:** 64 KiB on all `/api/*` routes. Storage upload routes are exempt for file uploads.
- **Session ID validation:** `SESSION_ID_PATTERN = /^[a-z0-9]{8,24}$/` - strict alphanumeric, length-bounded.
- **CORS enforcement:** `matchesPattern()` enforces domain boundaries with dot-prefix matching. `.workers.dev` matches `x.workers.dev` but NOT `evil-workers.dev`.

### CSRF Protection

- **X-Requested-With header:** All state-changing requests (POST, PUT, DELETE, PATCH) require the `X-Requested-With` header. This is validated by `authenticateRequest()` in `src/lib/access.ts` before request processing, preventing cross-site form submission attacks.

### Container Isolation

- **One container per session:** Each session runs in its own Cloudflare Container. No shared shells, no cross-session file access.
- **Per-user R2 buckets:** Storage is isolated per user. Bucket names are derived from sanitized email addresses (format: `{workerName}-{email-sanitized}`, e.g., `codeflare-alice-example-com` for `alice@example.com`, max 63 chars).
- **Container auth tokens:** Each container DO lifecycle generates a random UUID (`crypto.randomUUID()`) injected into all proxied requests. The terminal server validates this token on every non-exempt path.
- **No admin credential passthrough:** The admin API token (`CLOUDFLARE_API_TOKEN`) never enters containers. R2 credentials injected into containers are per-user scoped tokens with bucket-level permission boundaries.

### Storage Isolation

The `PROTECTED_PATHS` array in `src/lib/constants.ts` is deliberately empty. Each user's storage is bucket-scoped (isolated per user via sanitized email-derived bucket names), and users already have unrestricted terminal access to the same files inside their container. Path-level restrictions within a user's own bucket would add complexity without meaningful security benefit.

### Email System (Resend)

- **Provider:** Resend API (`https://api.resend.com/emails`) for all outbound emails (welcome, subscription, tier change, admin notifications).
- **Secrets:** `RESEND_API_KEY` (required for email functionality) and `RESEND_EMAIL` (optional sender address, defaults to `Codeflare <onboarding@resend.dev>`).
- **HTML injection prevention:** All user-supplied values interpolated into email HTML bodies are escaped via `escapeXml()` in `src/lib/xml-utils.ts` before rendering.
- **Non-fatal:** Email sending never throws — `sendEmail()` returns boolean success. API errors are logged server-side but never leak to the user. Callers fire-and-forget via `waitUntil`.
- **Timeout:** All Resend API calls use `AbortSignal.timeout(10_000)` to prevent hanging requests.
- **No PII in logs:** Email send failures log the recipient address and subject but never log email body content.

### Usage Tracking (Timekeeper DO)

- **One DO per user:** Each user has a dedicated Timekeeper Durable Object identified by their bucket name. No cross-user data access.
- **Identity binding:** The first ping sets the `bucketName` and `email` on the DO. Subsequent pings with mismatched identity return HTTP 403.
- **Delta clamping:** Each ping computes a delta from the previous session total, clamped to `MAX_DELTA_PER_PING` (300 seconds / 5 minutes) to prevent usage spikes from corrupt data.
- **Crash resilience:** `pendingSeconds`, `sessionTotals`, `bucketName`, and `email` are persisted to DO storage. On restart, state is restored via `blockConcurrencyWhile`.
- **Fail-open quota check:** If KV reads fail during a Timekeeper ping, the quota check is skipped (fail-open) to avoid blocking active sessions on transient errors.
- **Session eviction:** When quota is exceeded mid-session, the container DO sends `SIGTERM` to the container process, allowing graceful cleanup.

### Supply Chain Security

Multiple layers of automated supply chain analysis:

| Tool | Workflow | What it checks |
|------|----------|---------------|
| **CodeQL** | `codeql.yml` | Static analysis for JS/TS vulnerabilities (XSS, injection, data flow issues). Runs on push, PRs, and weekly. |
| **OSSF Scorecard** | `scorecard.yml` | Repository security posture: branch protection, dependency pinning, CI best practices. Runs on push to main and weekly. |
| **Dependency Review** | `test.yml` | `actions/dependency-review-action` blocks PRs that introduce dependencies with known vulnerabilities. |
| **npm audit** | `test.yml` | `npm audit --audit-level=high --omit=dev` for both backend and frontend. Fails on HIGH+ severity advisories in production dependencies. Dev-only vulnerabilities (e.g. transitive devDep issues in undici/yauzl) are excluded. |
| **Trivy** | `deploy.yml` | Container image vulnerability scanning (HIGH/CRITICAL severity). Blocks deploy on findings. Uses `.trivyignore` for accepted risks. |
| **Dependabot** | `.github/dependabot.yml` | Automated dependency update PRs for npm (backend, frontend, host), Docker, and GitHub Actions. |

### GitHub Security Features

Enabled at the repository level (Settings > Code security and analysis):

| Feature | Status | What it does |
|---------|--------|-------------|
| **Private vulnerability reporting** | Enabled | Community can report security issues privately to maintainers. |
| **Dependency graph** | Enabled | Maps all dependencies for vulnerability tracking. |
| **Dependabot alerts** | Enabled | Notifies of vulnerable dependencies with remediation advice. |
| **Dependabot security updates** | Enabled | Automatically opens PRs to patch vulnerable dependencies. |
| **Grouped security updates** | Enabled | Batches Dependabot fix PRs into one per package manager. |
| **Secret scanning** | Enabled | Detects accidentally committed secrets (API keys, tokens, credentials). |
| **Push protection** | Enabled | Blocks pushes that contain detected secrets before they reach the repository. |
| **CodeQL (Advanced setup)** | Enabled | Static analysis with Copilot Autofix for suggested remediation. |
| **Check runs threshold** | Security: High+, Standard: Errors only | Blocks merges on high-severity security findings. |

### CORS Policy

- **Static origins:** Configured via `ALLOWED_ORIGINS` worker variable (comma-separated patterns).
- **Dynamic origins:** Additional origins loaded from KV (`cors-cache.ts`), refreshed on cache miss.
- **Pattern matching:** Dot-prefixed patterns enable suffix matching (e.g., `.workers.dev`). Non-prefixed patterns require exact match.
- **`.workers.dev` wildcard:** The app allows any `*.workers.dev` origin by design. This is required because the initial setup flow runs on a `*.workers.dev` URL before a custom domain is configured, and the setup wizard persists `.workers.dev` to KV as an allowed origin. `matchesPattern()` enforces domain boundaries so `evil-workers.dev` does not match. Auth cookies default to `SameSite=Lax` (both CF Access `CF_Authorization` and GitHub OIDC `codeflare_session`), which blocks cross-origin credentialed `fetch()` requests. This is an accepted design tradeoff documented in Architecture Decisions (AD11).

### WebSocket Security

- **Route validation:** WebSocket upgrade requests are validated against allowed routes before Hono routing (workerd bug workaround).
- **Auth on connect:** WebSocket connections go through the same authentication as HTTP requests (CF Access JWT or OIDC session cookie depending on mode).
- **Container-scoped tokens:** WebSocket traffic proxied to containers includes the DO-scoped `Authorization: Bearer` token.

### Push & Deploy Credentials

Users can connect their GitHub and Cloudflare accounts via Settings > Push & Deploy. Tokens are stored and injected into container sessions as environment variables.

**Storage:**
- Tokens are stored in Cloudflare KV, encrypted at rest with AES-256-GCM.
- Tokens are validated against provider APIs (GitHub, Cloudflare) before storage. Invalid or revoked tokens are rejected.

**Injection:**
- Tokens are injected as environment variables at container startup: `GH_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Container isolation ensures tokens are per-user. A user's tokens are only injected into their own sessions.

**Token scope and expiry:**
- GitHub tokens are fine-grained PATs with scoped repository access and 90-day expiry.
- Cloudflare API tokens follow the same scoping principle as the deployment token (minimum required permissions).

**Access control:**
- Tokens are only accessible to the authenticated user who stored them. KV keys are scoped by user identity.
- The admin API token (`CLOUDFLARE_API_TOKEN` used by the Worker itself) remains separate and is never injected into containers.

### Automated Penetration Testing

A weekly CI workflow (`pentest.yml`) runs external black-box security tests against the production deployment, validating security headers, TLS, auth gates, info disclosure, injection resistance, and HTTP methods. Run manually via `Actions` > `Pentest` > `Run workflow`. See [Penetration Testing](documentation/lanes/pentest.md) for the complete report covering all 13 test categories.

**Related Documentation:**
- [Security Reference](documentation/security.md) - Security model, rate limiting, and encryption
- [Architecture Decisions](documentation/decisions/README.md) - Design trade-offs and rationale
- [Stress Testing](documentation/lanes/stress-test.md) - Load testing methodology and rate limit validation
- [CONTRIBUTING.md](CONTRIBUTING.md) - Development workflow and guidelines
