# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly via GitHub's private vulnerability reporting feature on this repository.

**Do not open a public issue for security vulnerabilities.**

You can expect an initial response within 72 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

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
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Enforces HTTPS |
| `Content-Security-Policy` | Restrictive policy | Prevents XSS and injection |
| `X-Frame-Options` | `DENY` | Prevents clickjacking |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Permissions-Policy` | Restrictive | Disables unnecessary browser APIs |

### Rate Limiting

- **KV-backed per-user rate limiting** on API endpoints via `src/middleware/rate-limit.ts`.
- **WebSocket connection rate limiting:** `WS_RATE_LIMIT_WINDOW_MS = 60,000` with `WS_RATE_LIMIT_MAX_CONNECTIONS = 30` per window.
- **Session caps:** `MAX_SESSIONS_USER = 3` (default), `MAX_SESSIONS_ADMIN = 10` (default). Configurable via worker variables.

### Input Validation

- **Zod schemas** validate all API request bodies and parameters (backend: `src/lib/schemas.ts`, frontend: `web-ui/src/lib/schemas.ts`).
- **Body size limit:** 64 KiB on all `/api/*` routes. Storage upload routes are exempt for file uploads.
- **Session ID validation:** `SESSION_ID_PATTERN = /^[a-z0-9]{8,24}$/` — strict alphanumeric, length-bounded.
- **CORS enforcement:** `matchesPattern()` enforces domain boundaries with dot-prefix matching. `.workers.dev` matches `x.workers.dev` but NOT `evil-workers.dev`.

### Container Isolation

- **One container per session:** Each session runs in its own Cloudflare Container. No shared shells, no cross-session file access.
- **Per-user R2 buckets:** Storage is isolated per user. Bucket names are derived from sanitized email addresses (`codeflare-user-example-com`, max 63 chars).
- **Container auth tokens:** Each container DO lifecycle generates a random UUID (`crypto.randomUUID()`) injected into all proxied requests. The terminal server validates this token on every non-exempt path.
- **No credential passthrough:** API tokens and secrets never enter the container environment. R2 credentials are scoped per-user and per-session.

### Protected Paths

The following paths are protected from file operations within containers:

```
.claude/
.anthropic/
.ssh/
.config/
.claude.json
```

These paths are defined in `src/lib/constants.ts` as `PROTECTED_PATHS` and are enforced by storage route handlers.

### Supply Chain Security

Multiple layers of automated supply chain analysis:

| Tool | Workflow | What it checks |
|------|----------|---------------|
| **CodeQL** | `codeql.yml` | Static analysis for JS/TS vulnerabilities (XSS, injection, data flow issues). Runs on push, PRs, and weekly. |
| **OSSF Scorecard** | `scorecard.yml` | Repository security posture: branch protection, dependency pinning, CI best practices. Runs on push to main and weekly. |
| **Dependency Review** | `test.yml` | `actions/dependency-review-action` blocks PRs that introduce dependencies with known vulnerabilities. |
| **npm audit** | `test.yml` | `npm audit --audit-level=high` for both backend and frontend. Fails on HIGH+ severity advisories. |
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

### WebSocket Security

- **Route validation:** WebSocket upgrade requests are validated against allowed routes before Hono routing (workerd bug workaround).
- **Auth on connect:** WebSocket connections go through the same CF Access auth middleware as HTTP requests.
- **Container-scoped tokens:** WebSocket traffic proxied to containers includes the DO-scoped `Authorization: Bearer` token.
