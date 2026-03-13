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

Codeflare delegates authentication entirely to **Cloudflare Access**:

- **User authentication:** CF Access validates identity via configured identity providers (Google, GitHub, etc.) and issues JWTs. The worker verifies JWTs against CF Access JWKS endpoints using RS256.
- **Service tokens:** E2E tests and automated systems authenticate via `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers, or via `X-Service-Auth` header matching the `SERVICE_AUTH_SECRET` worker secret.
- **Email normalization:** User emails are trimmed and lowercased before KV lookup to prevent casing-based bypass.
- **KV allowlist:** Only users present in the KV allowlist can access the application. Role-based access control (admin/user) determines session limits and management capabilities.

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
- **Session caps:** `MAX_SESSIONS_USER = 3` (default), `MAX_SESSIONS_ADMIN = 10` (default). Configurable via worker variables.
- **Stress test bypass:** When `STRESS_TEST_MODE` is set to `"active"`, all rate limits (HTTP and WebSocket) are bypassed. This variable is **only set on the integration worker** for k6 load testing. Production workers must never have this variable set. The bypass requires the exact string `"active"` — no other value disables rate limiting.

### Input Validation

- **Zod schemas** validate all API request bodies and parameters (backend: `src/lib/schemas.ts`, frontend: `web-ui/src/lib/schemas.ts`).
- **Body size limit:** 64 KiB on all `/api/*` routes. Storage upload routes are exempt for file uploads.
- **Session ID validation:** `SESSION_ID_PATTERN = /^[a-z0-9]{8,24}$/` - strict alphanumeric, length-bounded.
- **CORS enforcement:** `matchesPattern()` enforces domain boundaries with dot-prefix matching. `.workers.dev` matches `x.workers.dev` but NOT `evil-workers.dev`.

### Container Isolation

- **One container per session:** Each session runs in its own Cloudflare Container. No shared shells, no cross-session file access.
- **Per-user R2 buckets:** Storage is isolated per user. Bucket names are derived from sanitized email addresses (`codeflare-user-example-com`, max 63 chars).
- **Container auth tokens:** Each container DO lifecycle generates a random UUID (`crypto.randomUUID()`) injected into all proxied requests. The terminal server validates this token on every non-exempt path.
- **No admin credential passthrough:** The admin API token (`CLOUDFLARE_API_TOKEN`) never enters containers. R2 credentials injected into containers are per-user scoped tokens with bucket-level permission boundaries.

### Storage Isolation

The `PROTECTED_PATHS` array in `src/lib/constants.ts` is deliberately empty. Each user's storage is bucket-scoped (isolated per user via sanitized email-derived bucket names), and users already have unrestricted terminal access to the same files inside their container. Path-level restrictions within a user's own bucket would add complexity without meaningful security benefit.

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
- **`.workers.dev` wildcard:** The app allows any `*.workers.dev` origin by design. This is required because the initial setup flow runs on a `*.workers.dev` URL before a custom domain is configured, and the setup wizard persists `.workers.dev` to KV as an allowed origin. `matchesPattern()` enforces domain boundaries so `evil-workers.dev` does not match. The CF Access JWT cookie defaults to `SameSite=Lax`, which blocks cross-origin credentialed `fetch()` requests. This is an accepted design tradeoff documented in Architecture Decisions (AD11).

### WebSocket Security

- **Route validation:** WebSocket upgrade requests are validated against allowed routes before Hono routing (workerd bug workaround).
- **Auth on connect:** WebSocket connections go through the same CF Access auth middleware as HTTP requests.
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

A weekly CI workflow (`pentest.yml`) runs external black-box security tests against the production deployment, validating security headers, TLS, auth gates, info disclosure, injection resistance, and HTTP methods. Run manually via `Actions` > `Pentest` > `Run workflow`. See [PENTEST.md](PENTEST.md) for the complete report covering all 13 test categories.
