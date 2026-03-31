# Operations

CI/CD pipeline, testing strategy, deployment workflow, container sizing, and cost model.

**Domain owner:** GitHub Actions workflows, deploy.yml, test.yml, e2e.yml, pentest.yml, fuzz.yml, stress-test.yml

### Key Concepts

- **Deploy Pipeline** -- The `deploy.yml` workflow that runs on push to `main`: install, build, test, typecheck, Docker build, scan, push, deploy, set secrets. The single path from code to production.
- **CI/CD** -- Continuous integration via `test.yml` (PR checks), `codeql.yml` (static analysis), `scorecard.yml` (supply chain), and `fuzz.yml` (property-based testing). Continuous deployment via `deploy.yml`.
- **E2E Testing** -- End-to-end test suite (`e2e.yml`) that runs against a deployed worker, covering API, desktop UI, and mobile UI flows. Authenticates via service token, not browser OAuth.
- **Container Tier** -- Resource allocation profiles (`low`, `default`, `saas`, `high`) that control CPU, memory, and disk per container. Selected via the `RESSOURCE_TIER` GitHub Actions variable and applied by patching `wrangler.toml` at deploy time.

### Out of Scope

- Multi-cloud deployment (Codeflare deploys exclusively to Cloudflare Workers and Containers)
- Custom CI runners (workflows use GitHub-hosted runners with optional self-hosted runner label via `RUNNER` variable)
- Monitoring and alerting dashboards (operational visibility is through GitHub Actions logs and Cloudflare dashboard)

### Domain Dependencies

- **Security** -- CVE scanning (REQ-OPS-002) depends on Trivy integration; pentest (REQ-OPS-005) validates security requirements
- **Session Lifecycle** -- Container specs (REQ-OPS-007) define the resource constraints that session containers run under

---

## REQ-OPS-001: Deploy triggered by push to main

**Intent:** Production deployments are triggered automatically on every push to the `main` branch, with manual dispatch as fallback for both production and integration environments.

**Acceptance Criteria:**
1. `deploy.yml` triggers on push to `main` and `workflow_dispatch` (with environment selection: production or integration).
2. The deploy pipeline runs end-to-end: install dependencies, build, test, typecheck, Docker build, scan, push, deploy, set secrets.
3. Dependencies are cached via `actions/cache` for faster runs.
4. Frontend is built, and both backend and frontend tests and typechecks run before any deployment steps.
5. KV namespace is resolved or created and patched into `wrangler.toml`.
6. Worker name is applied from the `CLOUDFLARE_WORKER_NAME` variable.
7. Final deployment uses `npx wrangler deploy` with `--var` for runtime configuration.
8. Worker secrets (`CLOUDFLARE_API_TOKEN`, optional `SERVICE_AUTH_SECRET`, optional `RESEND_API_KEY`) are set after deploy.
9. E2E service user is seeded in KV allowlist when `CF_ACCESS_CLIENT_SECRET` is present.

**Constraints:**
- Two GitHub environments: `production` (auto on push to main) and `integration` (manual dispatch only).
- `RUNNER` variable controls the GitHub Actions runner label (supports self-hosted runners).

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test (deploy.yml pipeline success on push to main)

**Status:** Implemented

---

## REQ-OPS-002: Docker image built, scanned, and deployed to Cloudflare

**Intent:** Every deploy builds a Docker image, scans it for vulnerabilities, and pushes it to the Cloudflare container registry before deploying the Worker.

**Acceptance Criteria:**
1. Docker image is built locally in the CI runner.
2. Trivy scans the image for HIGH and CRITICAL severity vulnerabilities.
3. Known exceptions are tracked in `.trivyignore`.
4. If Trivy finds unexcepted vulnerabilities, the pipeline fails before push.
5. Image is pushed to Cloudflare registry via `wrangler containers push`, and the registry URI is extracted.
6. `wrangler.toml` `image` field is patched to the registry URI (avoids Docker rebuild on deploy).
7. Container resource tier is applied from `RESSOURCE_TIER` variable: low (0.25 vCPU / 1 GiB / 4 GB), default/saas (1 vCPU / 3 GiB / 6 GB), high (2 vCPU / 6 GiB / 8 GB).
8. All tiers default to 10 max instances; `MAX_INSTANCES` variable overrides if set.
9. Optional cache busting for Claude Unleashed layer via `CLAUDE_UNLEASHED_CACHE_BUSTER` variable.

**Constraints:**
- `MAX_INSTANCES` must be a positive integer, passed via env to avoid shell injection.
- `RESSOURCE_TIER` is a GitHub Actions variable, not a secret.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-OPS-001, REQ-SEC-011
**Verification:** Automated test (deploy.yml Trivy scan + container push steps)

**Status:** Implemented

---

## REQ-OPS-003: PR checks run lint, test, typecheck, and security audit

**Intent:** Every pull request to `main` must pass comprehensive quality checks before merge.

**Acceptance Criteria:**
1. `test.yml` triggers on PRs to `main` and `workflow_dispatch`.
2. Two parallel jobs run: `test` and `dependency-review`.
3. The `test` job runs: lint (oxlint), build frontend, run backend + frontend tests, typecheck both, dead code check (knip), and `npm audit --audit-level=high --omit=dev` for backend and frontend.
4. The `dependency-review` job runs `actions/dependency-review-action` to block PRs introducing dependencies with known vulnerabilities.
5. `codeql.yml` runs CodeQL static analysis for JavaScript/TypeScript on pushes to `main`, PRs to `main`, and weekly (Monday 06:00 UTC). Results are uploaded as SARIF to GitHub Security.
6. `scorecard.yml` runs OSSF Scorecard security posture assessment on push to `main` and weekly (Monday 06:00 UTC).

**Constraints:**
- Tests, builds, linting, and typechecking must NOT run locally in the development container (1 vCPU limitation). All quality checks run in GitHub Actions.
- `RUNNER` variable controls the runner label across all workflows.

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test (test.yml runs on every PR to main)

**Status:** Implemented

---

## REQ-OPS-004: E2E tests on deployed worker

**Intent:** End-to-end tests verify the deployed worker functions correctly for API operations, desktop UI, and mobile UI.

**Acceptance Criteria:**
1. `e2e.yml` triggers on `workflow_dispatch` with environment selection (integration or production).
2. Four sequential jobs with dependency chains: `setup` -> `e2e-api` -> `e2e-ui-desktop` -> `e2e-ui-mobile`.
3. The `setup` job sets `SERVICE_AUTH_SECRET` on the target worker, seeds the E2E service user in KV, and smoke-tests auth with a retry loop (handles KV eventual consistency ~60s).
4. The `e2e-api` job runs the API test suite (~55 tests across 12 files).
5. The `e2e-ui-desktop` job runs UI desktop tests (~75 tests across 10 files, Puppeteer with Chrome).
6. The `e2e-ui-mobile` job runs UI mobile tests with `E2E_MOBILE=1`.
7. Failed UI test runs upload screenshots and HTML as artifacts (5-day retention).
8. `E2E_BASE_URL` variable is set per environment to target the correct deployed worker.

**Constraints:**
- E2E tests authenticate via `X-Service-Auth` header (service token), not browser-based auth flows.
- UI tests require Chrome installation via `npx puppeteer browsers install chrome` + system shared libraries.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-OPS-001, REQ-SEC-012
**Verification:** Integration test (e2e.yml workflow dispatch against deployed worker)

**Status:** Implemented

---

## REQ-OPS-005: Weekly pentest and fuzz testing

**Intent:** Automated security testing runs on a weekly schedule to detect regressions in security posture and identify edge-case bugs.

**Acceptance Criteria:**
1. `pentest.yml` runs weekly (Monday 05:00 UTC) and on `workflow_dispatch` against the `PENTEST_TARGET` URL in the production environment.
2. Pentest runs 6 parallel jobs using lightweight external probes (`curl` and `openssl` only):
   - `security-headers`: Verifies HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy present; `X-Powered-By` absent.
   - `tls`: Confirms TLS 1.3 works, TLS 1.0/1.1 rejected, HSTS preload enabled, certificate >= 14 days validity.
   - `auth-gate`: Verifies 7 API endpoints require authentication (302/401/403). Tests email header injection bypass.
   - `info-disclosure`: Probes `/.env`, `/.git/config`, `/api/debug` for sensitive data. Confirms no stack traces in responses.
   - `injection`: Tests host header injection, `X-Forwarded-Host` effect, CL/TE request smuggling, path traversal payloads.
   - `http-methods`: Verifies TRACE returns 405, WebSocket upgrade without auth returns 302.
3. `fuzz.yml` runs on PRs to `main`, weekly (Sunday 04:00 UTC), and on `workflow_dispatch`.
4. Fuzz testing uses fast-check with 50,000 iterations for property-based testing.

**Constraints:**
- Pentest requires `PENTEST_TARGET` variable set in the `production` GitHub environment.
- Pentest uses only `curl` and `openssl` (no heavy scanning tools) to minimize CI resource usage.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SEC-008, REQ-SEC-009, REQ-SEC-010
**Verification:** Automated test (pentest.yml and fuzz.yml scheduled runs)

**Status:** Implemented

---

## REQ-OPS-006: Idle containers cost zero

**Intent:** Containers that are not actively in use must hibernate and incur zero compute cost.

**Acceptance Criteria:**
1. Containers hibernate after `sleepAfter` duration of no user input (default 30 minutes, configurable 5 minutes to 2 hours).
2. Hibernated containers consume zero CPU, memory, and disk cost.
3. The `sleepAfter` preference is persisted to Durable Object storage to survive DO resets.
4. Both `setBucketName` paths (initial and subsequent) persist `sleepAfter` to storage.
5. The DO constructor loads `sleepAfter` from storage with validation on startup.
6. `destroy()` cleans up the persisted `sleepAfter` value.
7. Cost per active container (default tier: 1 vCPU, 3 GiB, 6 GB) at 160h/month active usage with 20% average CPU is approximately $11.14/user/month including the Workers Paid plan.

**Constraints:**
- CPU is billed on active usage only. Memory and disk are billed on provisioned resources during active time.
- R2 storage: first 10 GB free, $0.015/GB/month after.
- Cost scales per active session, not per user. Each session = one container; a session has up to 6 terminal tabs sharing a single container.

**Applies To:** Admin
**Priority:** P0
**Dependencies:** None
**Verification:** Manual check (cost monitoring via Cloudflare dashboard)

**Status:** Implemented

---

## REQ-OPS-007: Container specs configurable per environment

**Intent:** Container resource allocation (CPU, memory, disk) must be configurable per deployment environment to balance cost and performance.

**Acceptance Criteria:**
1. `RESSOURCE_TIER` GitHub Actions variable controls container sizing with four tiers:
   - `low`: 0.25 vCPU, 1 GiB memory, 4 GB disk (basic)
   - `default`: 1 vCPU, 3 GiB memory, 6 GB disk
   - `saas`: 1 vCPU, 3 GiB memory, 6 GB disk (same as default)
   - `high`: 2 vCPU, 6 GiB memory, 8 GB disk
2. All tiers default to 10 max instances.
3. `MAX_INSTANCES` variable overrides the max instances count if set (must be a positive integer).
4. `MAX_SESSIONS_USER` (default 3) and `MAX_SESSIONS_ADMIN` (default 10) control per-user concurrent session limits, configurable via GitHub Actions variables.
5. Tier configuration is applied during the deploy workflow by patching `wrangler.toml`.

**Constraints:**
- `RESSOURCE_TIER` defaults to `default` if unset.
- `MAX_INSTANCES` is passed via env to avoid shell injection.
- Session limits are passed to the Worker via `--var` (omitted if unset, so backend defaults apply).

**Applies To:** Admin
**Priority:** P1
**Dependencies:** REQ-OPS-001
**Verification:** Automated test (deploy.yml verifies wrangler.toml patching)

**Status:** Implemented

---

## REQ-OPS-008: Stress testing validates rate limits and concurrency

**Intent:** Load testing validates that rate limiting, session lifecycle, storage operations, and WebSocket concurrency behave correctly under high load.

**Acceptance Criteria:**
1. `stress-test.yml` triggers on `workflow_dispatch` against the integration environment.
2. k6 stress tests cover API throughput, session lifecycle, storage operations, and WebSocket concurrency.
3. `STRESS_TEST_CONCURRENCY` variable (default 0 = disabled) scales virtual user targets proportionally and loosens latency thresholds when set above 0.
4. When `STRESS_TEST_MODE=active` on the target worker, all HTTP and WebSocket rate limits are bypassed to allow high VU counts through a single service token identity.
5. A one-time warning is logged per isolate when the rate limit bypass activates.
6. `STRESS_TEST_MODE` must not be active alongside `SAAS_MODE` (enforced by global middleware returning 503).

**Constraints:**
- Stress testing is for integration environments only.
- Rate limit bypass skips all KV rate-limit reads/writes for zero overhead.

**Applies To:** User
**Priority:** P2
**Dependencies:** REQ-SEC-007, REQ-OPS-001
**Verification:** Integration test (stress-test.yml manual dispatch against integration)

**Status:** Implemented

---

## REQ-OPS-009: Supply chain security monitoring

**Intent:** The project's open-source supply chain security posture must be continuously monitored and reported.

**Acceptance Criteria:**
1. `scorecard.yml` runs OSSF Scorecard on push to `main` and weekly (Monday 06:00 UTC).
2. Results are published and uploaded as SARIF to GitHub Security.
3. GitHub's built-in secret scanning (with push protection) is enabled at the repository level.
4. Dependabot security updates are enabled at the repository level.
5. `npm audit --audit-level=high --omit=dev` runs for both backend and frontend in PR checks.
6. `actions/dependency-review-action` blocks PRs that introduce dependencies with known vulnerabilities.

**Constraints:**
- Supply chain monitoring is continuous (push-triggered + weekly), not on-demand.
- Secret scanning push protection prevents secrets from being committed.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-OPS-003
**Verification:** Automated test (scorecard.yml and dependency-review in test.yml)

**Status:** Implemented

---

## REQ-OPS-010: Graceful container shutdown preserves data

**Intent:** Container shutdown must complete a final sync to R2 before termination to prevent data loss.

**Acceptance Criteria:**
1. `STOPSIGNAL SIGINT` is set in the Dockerfile.
2. The `entrypoint.sh` trap handler catches SIGINT/SIGTERM signals.
3. The trap handler kills the sync daemon via PID file at `/tmp/sync-daemon.pid` (PID file is the sole mechanism).
4. A final `rclone bisync` (with `--ignore-checksum --max-delete 100`) runs to R2 before exit.
5. The bisync-initialized flag is touched on the timeout path to ensure the final bisync runs even when initial sync timed out.
6. The terminal server is killed after the final sync completes.

**Constraints:**
- No in-memory PID variable fallback for the sync daemon; PID file is the sole mechanism.
- `--max-delete 100` prevents accidental mass deletion during shutdown sync.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-STOR-001
**Verification:** Integration test (E2E verifies data persists across session restart)

**Status:** Implemented

---

## REQ-OPS-011: Container base image is Debian bookworm-slim

**Intent:** Reliable CLI agent execution requires a glibc-based Linux distribution (Alpine/musl caused crashes for some agents).

**Acceptance Criteria:**
1. Dockerfile uses `node:24-bookworm-slim` as base image.
2. All agent CLIs (Claude Code, Codex, Gemini CLI, Copilot, OpenCode) start without crashes.
3. System packages include essential tools (git, gh, ripgrep, fd, neovim, tmux, fzf, yazi, lazygit).

**Constraints:**
- None

**Applies To:** Admin
**Priority:** P1
**Dependencies:** None
**Verification:** Integration test

**Status:** Implemented

---

## REQ-OPS-012: Per-environment container concurrency limit

**Intent:** Operators can control how many containers run concurrently per environment independently of resource tier.

**Acceptance Criteria:**
1. `MAX_INSTANCES` GitHub Actions variable overrides the default 10 max instances.
2. Independent of `RESSOURCE_TIER`.
3. Must be a positive integer.
4. Applied during deploy via `wrangler.toml` patching.

**Constraints:**
- None

**Applies To:** Admin
**Priority:** P1
**Dependencies:** REQ-OPS-001
**Verification:** Integration test

**Status:** Implemented
