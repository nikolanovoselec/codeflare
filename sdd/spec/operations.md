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

### REQ-OPS-001: Deploy workflow trigger and pre-deploy pipeline

<!-- @impl: .github/workflows/deploy.yml -->

**Intent:** Production deployments are triggered automatically on every push to the `main` branch, with manual dispatch as fallback. The pre-deploy stage installs dependencies, builds, and runs tests before any artifact reaches Cloudflare.

**Applies To:** User

**Acceptance Criteria:**

1. The deploy workflow triggers on push to `main` and `workflow_dispatch` (with environment selection: production or integration).
2. The deploy pipeline runs end-to-end: install dependencies, build, test, typecheck, Docker build, scan, push, deploy, set secrets.
3. Dependencies are cached via `actions/cache` for faster runs.
4. Frontend is built, and both backend and frontend tests and typechecks run before any deployment steps.
5. KV namespace is resolved or created and patched into `wrangler.toml`.

**Constraints:**

- Two GitHub environments: `production` (auto on push to main) and `integration` (manual dispatch only).
- `RUNNER` variable controls the GitHub Actions runner label (supports self-hosted runners).
- The deploy command, secret-setting, and post-deploy seed steps live in [REQ-OPS-013](#req-ops-013-deploy-command-and-post-deploy-hooks).

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test (deploy.yml pre-deploy job success on push to main)

**Status:** Partial

---

### REQ-OPS-013: Deploy command and post-deploy hooks

<!-- @impl: .github/workflows/deploy.yml -->

**Intent:** After the pre-deploy pipeline succeeds, the workflow applies the worker name, runs `wrangler deploy`, sets worker secrets, and seeds the E2E service user in KV so the deployed worker is fully configured and reachable.

**Applies To:** User

**Acceptance Criteria:**

1. Worker name is applied from the `CLOUDFLARE_WORKER_NAME` variable.
2. Final deployment uses `npx wrangler deploy` with `--var` for runtime configuration.
3. Worker secrets (`CLOUDFLARE_API_TOKEN`, optional `SERVICE_AUTH_SECRET`, optional `RESEND_API_KEY`) are set after deploy.
4. E2E service user is seeded in KV allowlist when `CF_ACCESS_CLIENT_SECRET` is present.

**Constraints:**

- Secret setting runs AFTER `wrangler deploy` because secret writes are a no-op on workers that don't yet exist.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated test (deploy.yml deploy + post-deploy steps success on push to main)

**Status:** Partial

---

### REQ-OPS-002: Docker image build, vulnerability scan, and registry push

<!-- @impl: .github/workflows/deploy.yml -->
<!-- @impl: Dockerfile -->
<!-- @impl: .trivyignore -->

**Intent:** Every deploy builds a Docker image, scans it for HIGH/CRITICAL vulnerabilities with allowlisted exceptions, and pushes the resulting artifact to the Cloudflare container registry. The pipeline fails before push on any unexcepted finding.

**Applies To:** User

**Acceptance Criteria:**

1. Docker image is built locally in the CI runner.
2. Trivy scans the image for HIGH and CRITICAL severity vulnerabilities.
3. Known exceptions are tracked in `.trivyignore`.
4. If Trivy finds unexcepted vulnerabilities, the pipeline fails before push.
5. Image is pushed to Cloudflare registry via `wrangler containers push`, and the registry URI is extracted.

**Constraints:**

- The container-binding and scaling steps consume the registry URI from this REQ; see [REQ-OPS-014](#req-ops-014-container-binding-and-scaling-from-image).

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), REQ-SEC-011

**Verification:** Automated test (deploy.yml Trivy scan + container push steps)

**Status:** Partial

---

### REQ-OPS-014: Container binding and scaling from image

<!-- @impl: .github/workflows/deploy.yml -->

**Intent:** After the image is pushed, the deploy workflow patches the registry URI into `wrangler.toml`, applies the resource tier and max-instance count, and offers cache-buster control over the AI agent layer. The bound Durable Object container is what user sessions land on.

**Applies To:** User

**Acceptance Criteria:**

1. `wrangler.toml` `image` field is patched to the registry URI (avoids Docker rebuild on deploy).
2. Container resource tier is applied from `RESSOURCE_TIER` variable: low (0.25 vCPU / 1 GiB / 4 GB), default/saas (1 vCPU / 3 GiB / 6 GB), high (2 vCPU / 6 GiB / 8 GB).
3. All tiers default to 10 max instances; `MAX_INSTANCES` variable overrides if set.
4. Optional cache busting for the AI agent layer via `CLAUDE_CODE_CACHE_BUSTER` variable.

**Constraints:**

- `MAX_INSTANCES` must be a positive integer, passed via env to avoid shell injection.
- `RESSOURCE_TIER` is a GitHub Actions variable, not a secret.

**Priority:** P0

**Dependencies:** [REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push)

**Verification:** Automated test (deploy.yml image-patch and resource-tier steps succeed)

**Status:** Partial

---

### REQ-OPS-003: PR checks run lint, test, typecheck, and security audit

<!-- @impl: .github/workflows/test.yml -->
<!-- @impl: .github/workflows/codeql.yml -->
<!-- @impl: .github/workflows/scorecard.yml -->

**Intent:** Every pull request to `main` must pass comprehensive quality checks before merge.

**Applies To:** User

**Acceptance Criteria:**

1. The PR-check workflow triggers on PRs to `main` and `workflow_dispatch`.
2. Two parallel jobs run: `test` and `dependency-review`.
3. The `test` job runs: lint (oxlint), build frontend, run backend + frontend tests, typecheck both, dead code check (knip), and `npm audit --audit-level=high --omit=dev` for backend and frontend.
4. The `dependency-review` job runs `actions/dependency-review-action` to block PRs introducing dependencies with known vulnerabilities.
5. A CodeQL static-analysis workflow runs for JavaScript/TypeScript on pushes to `main`, PRs to `main`, and weekly (Monday 06:00 UTC). Results are uploaded as SARIF to GitHub Security.
6. An OSSF Scorecard workflow runs security-posture assessment on push to `main` and weekly (Monday 06:00 UTC).

**Constraints:**

- Tests, builds, linting, and typechecking must NOT run locally in the development container (1 vCPU limitation). All quality checks run in GitHub Actions.
- `RUNNER` variable controls the runner label across all workflows.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test (test.yml runs on every PR to main)

**Status:** Partial

---

### REQ-OPS-004: E2E test workflow setup and job graph

<!-- @impl: .github/workflows/e2e.yml -->

**Intent:** The e2e workflow runs end-to-end tests against a deployed environment. The setup stage primes the worker for service-token auth and the job graph sequences setup before the per-suite test jobs.

**Applies To:** User

**Acceptance Criteria:**

1. The E2E workflow triggers on `workflow_dispatch` with environment selection (integration or production).
2. Four sequential jobs with dependency chains: `setup` -> `e2e-api` -> `e2e-ui-desktop` -> `e2e-ui-mobile`.
3. The `setup` job sets `SERVICE_AUTH_SECRET` on the target worker, seeds the E2E service user in KV, and smoke-tests auth with a retry loop (handles KV eventual consistency ~60s).
4. `E2E_BASE_URL` variable is set per environment to target the correct deployed worker.

**Constraints:**

- E2E tests authenticate via `X-Service-Auth` header (service token), not browser-based auth flows.
- The per-suite test execution + artifact handling live in [REQ-OPS-015](#req-ops-015-e2e-per-suite-execution-and-artifact-handling).

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), REQ-SEC-012

**Verification:** Integration test (e2e.yml setup job + auth smoke)

**Status:** Implemented

---

### REQ-OPS-015: E2E per-suite execution and artifact handling

<!-- @impl: .github/workflows/e2e.yml -->

**Intent:** Each E2E suite (API, desktop UI, mobile UI) runs as its own job in the e2e workflow. Failed UI runs persist screenshots and HTML so the user can diagnose what the deployed worker actually rendered.

**Applies To:** User

**Acceptance Criteria:**

1. The `e2e-api` job runs the API test suite (~55 tests across 12 files).
2. The `e2e-ui-desktop` job runs UI desktop tests (~75 tests across 10 files, Puppeteer with Chrome).
3. The `e2e-ui-mobile` job runs UI mobile tests with `E2E_MOBILE=1`.
4. Failed UI test runs upload screenshots and HTML as artifacts (5-day retention).

**Constraints:**

- UI tests require Chrome installation via `npx puppeteer browsers install chrome` + system shared libraries.

**Priority:** P1

**Dependencies:** [REQ-OPS-004](#req-ops-004-e2e-test-workflow-setup-and-job-graph)

**Verification:** Integration test (e2e.yml per-suite jobs against deployed worker)

**Status:** Implemented

---

### REQ-OPS-005: Weekly pentest

<!-- @impl: .github/workflows/pentest.yml -->

**Intent:** Automated external pentest probes run on a weekly schedule to detect regressions in production security posture.

**Applies To:** User

**Acceptance Criteria:**

1. The pentest workflow runs weekly (Monday 05:00 UTC) and on `workflow_dispatch` against the `PENTEST_TARGET` URL in the production environment.
2. Pentest runs 6 parallel jobs using lightweight external probes restricted to `curl` and `openssl` invocations.
3. Probe coverage spans response headers, TLS posture, authentication gates, information disclosure, injection vectors, and HTTP method handling (per-probe checks enumerated in Constraints).

**Constraints:**

- Pentest requires `PENTEST_TARGET` variable set in the `production` GitHub environment.
- Pentest uses only `curl` and `openssl` (no heavy scanning tools) to minimize CI resource usage.
- Per-probe checks:
   - `security-headers`: Verifies HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy present; `X-Powered-By` absent.
   - `tls`: Confirms TLS 1.3 works, TLS 1.0/1.1 rejected, HSTS preload enabled, certificate >= 14 days validity.
   - `auth-gate`: Verifies 7 API endpoints require authentication (302/401/403). Tests email header injection bypass.
   - `info-disclosure`: Probes `/.env`, `/.git/config`, `/api/debug` for sensitive data. Confirms no stack traces in responses.
   - `injection`: Tests host header injection, `X-Forwarded-Host` effect, CL/TE request smuggling, path traversal payloads.
   - `http-methods`: Verifies TRACE returns 405, WebSocket upgrade without auth returns 302.

**Priority:** P1

**Dependencies:** REQ-SEC-008, REQ-SEC-009, REQ-SEC-010

**Verification:** Automated test (pentest.yml scheduled runs)

**Status:** Partial

---

### REQ-OPS-018: Weekly fuzz testing

<!-- @impl: .github/workflows/fuzz.yml -->

**Intent:** Property-based fuzz testing runs on a weekly schedule and on every PR to `main` to identify edge-case bugs in input parsing and state transitions.

**Applies To:** User

**Acceptance Criteria:**

1. The fuzz workflow runs on PRs to `main`, weekly (Sunday 04:00 UTC), and on `workflow_dispatch`.
2. Fuzz testing uses fast-check with 50,000 iterations for property-based testing.

**Constraints:**

- Fuzz iteration count is calibrated to keep PR-blocking jobs under the 10-minute CI budget; weekly runs are unbounded.

**Priority:** P1

**Dependencies:** REQ-SEC-008, REQ-SEC-009, REQ-SEC-010

**Verification:** Automated test (fuzz.yml scheduled and PR runs)

**Status:** Partial

---

### REQ-OPS-006: Idle containers hibernate and cost zero

<!-- @impl: src/container/index.ts -->
<!-- @impl: src/container/container-metrics.ts -->

**Intent:** Containers that are not actively in use must hibernate and incur zero compute cost. The cost model anchors the entire pricing strategy, so the hibernation guarantee is operator-facing.

**Applies To:** Admin

**Acceptance Criteria:**

1. Containers hibernate after `sleepAfter` duration of no user input (default 30 minutes, configurable 5 minutes to 2 hours).
2. Hibernated containers consume zero CPU, memory, and disk cost.
3. Cost per active container (default tier: 1 vCPU, 3 GiB, 6 GB) at 160h/month active usage with 20% average CPU is approximately $11.14/user/month including the Workers Paid plan.

**Constraints:**

- CPU is billed on active usage only. Memory and disk are billed on provisioned resources during active time.
- R2 storage: first 10 GB free, $0.015/GB/month after.
- Cost scales per active session, not per user. Each session = one container; a session has up to 6 terminal tabs sharing a single container.
- The sleepAfter persistence + lifecycle mechanics live in [REQ-OPS-016](#req-ops-016-sleepafter-preference-persistence-and-lifecycle).
- The fail-safe invariants (fail-to-max, 60s propagation, fail-loud-on-missing) live in [REQ-OPS-017](#req-ops-017-sleepafter-fail-safe-invariants).

**Priority:** P0

**Dependencies:** None.

**Verification:** Manual check (cost monitoring via Cloudflare dashboard)

**Status:** Implemented

---

### REQ-OPS-016: sleepAfter preference persistence and lifecycle

<!-- @impl: src/container/index.ts -->

**Intent:** The user-configurable `sleepAfter` preference must survive Durable Object resets, both initial and subsequent setBucketName paths must persist it, the constructor must reload it with validation, and destroy must clean it up. Without persistence the preference would silently snap back to default on every DO restart.

**Applies To:** Admin

**Acceptance Criteria:**

1. The `sleepAfter` preference is persisted to Durable Object storage to survive DO resets.
2. Both `setBucketName` paths (initial and subsequent) persist `sleepAfter` to storage.
3. The DO constructor loads `sleepAfter` from storage with validation on startup.
4. `destroy()` cleans up the persisted `sleepAfter` value.

**Constraints:**

- Persisted preference values are schema-validated on load; invalid values are treated as missing and trigger the fail-safe fallback in REQ-OPS-017.

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-hibernate-and-cost-zero)

**Verification:** Manual check (DO restart preserves the user-set timeout)

**Status:** Implemented

---

### REQ-OPS-017: sleepAfter fail-safe invariants

<!-- @impl: src/container/index.ts -->

**Intent:** Three invariants protect user work from a misconfigured or silently broken idle-detection layer: fail to the maximum (not minimum) on corruption, propagate preference changes within one cycle, and fail loudly rather than substituting a default. A container that dies before its configured timer destroys an hour of unpushed work and breaks the product's core promise.

**Applies To:** Admin

**Acceptance Criteria:**

1. The idle-detection layer fails safe in the direction of preserving user work, not minimizing compute. When the configured `sleepAfter` cannot be resolved (storage corrupted, schema-validated value missing, parser fed garbage, code path skipped the user-pref resolution), the system falls back to the maximum supported value (2h) rather than the minimum.
2. A change to the persisted `sleepAfter` preference takes effect within one 60-second idle-check cycle, regardless of which code path wrote it. Stale in-memory copies of the preference cannot outlive a single cycle.
3. Any code path that hands the resolved `sleepAfter` to the container init must fail loudly when the value is missing, rather than substituting a fallback. The user's configured timer (e.g., 2h) is never silently replaced by a shorter default.

**Constraints:**

- Fail-safe defaults trade billing efficiency for user-trust: a container that lives slightly longer than configured costs the operator a few cents; a container that dies before configured destroys an hour of unpushed user work and breaks the product's core promise.

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-hibernate-and-cost-zero), [REQ-OPS-016](#req-ops-016-sleepafter-preference-persistence-and-lifecycle)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-007: Container specs configurable per environment

<!-- @impl: .github/workflows/deploy.yml -->
<!-- @impl: wrangler.toml -->

**Intent:** Container resource allocation (CPU, memory, disk) must be configurable per deployment environment to balance cost and performance.

**Applies To:** Admin

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

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-triggered-by-push-to-main)

**Verification:** Automated test (deploy.yml verifies wrangler.toml patching)

**Status:** Partial

---

### REQ-OPS-008: Stress testing validates rate limits and concurrency

<!-- @impl: .github/workflows/stress-test.yml -->
<!-- @impl: src/lib/rate-limit-core.ts -->

**Intent:** Load testing validates that rate limiting, session lifecycle, storage operations, and WebSocket concurrency behave correctly under high load.

**Applies To:** User

**Acceptance Criteria:**

1. The stress-test workflow triggers on `workflow_dispatch` against the integration environment.
2. k6 stress tests cover API throughput, session lifecycle, storage operations, and WebSocket concurrency.
3. `STRESS_TEST_CONCURRENCY` variable (default 0 = disabled) scales virtual user targets proportionally and loosens latency thresholds when set above 0.
4. When `STRESS_TEST_MODE=active` on the target worker, all HTTP and WebSocket rate limits are bypassed to allow high VU counts through a single service token identity.
5. A one-time warning is logged per isolate when the rate limit bypass activates.
6. `STRESS_TEST_MODE` must not be active alongside `SAAS_MODE` (enforced by global middleware returning 503).

**Constraints:**

- Stress testing is for integration environments only.
- Rate limit bypass skips all KV rate-limit reads/writes for zero overhead.

**Priority:** P2

**Dependencies:** REQ-SEC-007, [REQ-OPS-001](#req-ops-001-deploy-triggered-by-push-to-main)

**Verification:** Integration test (stress-test.yml manual dispatch against integration)

**Status:** Implemented

---

### REQ-OPS-009: Supply chain security monitoring

<!-- @impl: .github/workflows/scorecard.yml -->
<!-- @impl: .github/workflows/test.yml -->

**Intent:** The project's open-source supply chain security posture must be continuously monitored and reported.

**Applies To:** User

**Acceptance Criteria:**

1. The Scorecard workflow runs OSSF Scorecard on push to `main` and weekly (Monday 06:00 UTC).
2. Results are published and uploaded as SARIF to GitHub Security.
3. GitHub's built-in secret scanning (with push protection) is enabled at the repository level.
4. Dependabot security updates are enabled at the repository level.
5. `npm audit --audit-level=high --omit=dev` runs for both backend and frontend in PR checks.
6. `actions/dependency-review-action` blocks PRs that introduce dependencies with known vulnerabilities.

**Constraints:**

- Supply chain monitoring is continuous (push-triggered + weekly), not on-demand.
- Secret scanning push protection prevents secrets from being committed.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Automated test (scorecard.yml and dependency-review in test.yml)

**Status:** Partial

---

### REQ-OPS-010: Graceful container shutdown preserves data

<!-- @impl: Dockerfile -->
<!-- @impl: entrypoint.sh::shutdown_handler -->
<!-- @impl: entrypoint.sh::bisync_with_r2 -->

**Intent:** Container shutdown must complete a final sync to R2 before termination to prevent data loss.

**Applies To:** User

**Acceptance Criteria:**

1. The container image declares `STOPSIGNAL SIGINT`.
2. The container entrypoint's trap handler catches SIGINT/SIGTERM signals.
3. The trap handler kills the sync daemon via PID file at `/tmp/sync-daemon.pid` (PID file is the sole mechanism).
4. A final `rclone bisync` (with `--ignore-checksum --max-delete 100`) runs to R2 before exit.
5. The bisync-initialized flag is touched on the timeout path to ensure the final bisync runs even when initial sync timed out.
6. The terminal server is killed after the final sync completes.

**Constraints:**

- No in-memory PID variable fallback for the sync daemon; PID file is the sole mechanism.
- `--max-delete 100` prevents accidental mass deletion during shutdown sync.

**Priority:** P0

**Dependencies:** REQ-STOR-001

**Verification:** Integration test (E2E verifies data persists across session restart)

**Status:** Implemented

---

### REQ-OPS-011: Container base image is Debian bookworm-slim

<!-- @impl: Dockerfile -->

**Intent:** Reliable CLI agent execution requires a glibc-based Linux distribution (Alpine/musl caused crashes for some agents).

**Applies To:** Admin

**Acceptance Criteria:**

1. The container base image is `public.ecr.aws/docker/library/node:24-bookworm-slim` (AWS ECR Public mirror).
2. All agent CLIs (Claude Code, Codex, Gemini CLI, Copilot, OpenCode) start without crashes.
3. System packages include essential tools (git, gh, ripgrep, fd, neovim, tmux, fzf, yazi, lazygit).

**Constraints:** None.

**Priority:** P1

**Dependencies:** None.

**Verification:** Integration test

**Status:** Implemented

---

### REQ-OPS-012: Per-environment container concurrency limit

<!-- @impl: .github/workflows/deploy.yml -->
<!-- @impl: wrangler.toml -->

**Intent:** Operators can control how many containers run concurrently per environment independently of resource tier.

**Applies To:** Admin

**Acceptance Criteria:**

1. `MAX_INSTANCES` GitHub Actions variable overrides the default 10 max instances.
2. Independent of `RESSOURCE_TIER`.
3. Must be a positive integer.
4. Applied during deploy via `wrangler.toml` patching.

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-triggered-by-push-to-main)

**Verification:** Integration test

**Status:** Implemented
