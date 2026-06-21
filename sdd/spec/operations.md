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

- **Security** -- CVE scanning ([REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push)) depends on Trivy integration; pentest ([REQ-OPS-005](#req-ops-005-weekly-pentest)) validates security requirements
- **Session Lifecycle** -- Container specs ([REQ-OPS-007](#req-ops-007-container-specs-configurable-per-environment)) define the resource constraints that session containers run under

---

### REQ-OPS-001: Deploy workflow trigger and pre-deploy pipeline

**Intent:** Production deployments are triggered automatically on every push to the `main` branch, with manual dispatch as fallback. The pre-deploy stage installs dependencies, builds, and runs tests before any artifact reaches Cloudflare.

**Applies To:** User

**Acceptance Criteria:**

1. The deploy workflow triggers automatically on successful PR-check completion against the main branch. <!-- @impl: .github/workflows/deploy.yml --> <!-- @test: host/__tests__/workflow-files.test.js (deploy trigger + pre-deploy job graph) -->
2. The deploy workflow also supports manual dispatch with environment selection (production or integration). <!-- @impl: .github/workflows/deploy.yml --> <!-- @test: host/__tests__/workflow-files.test.js (deploy trigger + pre-deploy job graph) -->
3. The deploy pipeline runs end-to-end: install dependencies, build, test, typecheck, build the container image, scan it, push it, deploy, and set secrets. <!-- @impl: .github/workflows/deploy.yml --> <!-- @test: host/__tests__/workflow-files.test.js (deploy trigger + pre-deploy job graph) -->
4. Dependencies are cached between runs for faster pipeline execution. <!-- @impl: .github/workflows/deploy.yml::Cache root node_modules --> <!-- @test: host/__tests__/workflow-files.test.js (deploy trigger + pre-deploy job graph) -->
5. Frontend is built, and both backend and frontend tests and typechecks run before any deployment steps. <!-- @impl: .github/workflows/deploy.yml::Build frontend --> <!-- @test: host/__tests__/workflow-files.test.js (deploy trigger + pre-deploy job graph) -->
6. The KV namespace is resolved or created and applied to the deployment configuration. <!-- @impl: .github/workflows/deploy.yml::Resolve KV namespace --> <!-- coverage-gap: CI deploy-workflow step (deploy.yml); verified at deploy time, not unit-testable -->

**Constraints:**

- Two deployment environments are supported: production (auto on push to main) and integration (manual dispatch only).
- The CI runner label is configurable to support self-hosted runners.
- The deploy command, secret-setting, and post-deploy seed steps live in [REQ-OPS-013](#req-ops-013-deploy-command-and-post-deploy-hooks).

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-002: Docker image build, vulnerability scan, and registry push

**Intent:** Every deploy builds a Docker image, scans it for HIGH/CRITICAL vulnerabilities with allowlisted exceptions, and pushes the resulting artifact to the Cloudflare container registry. The pipeline fails before push on any unexcepted finding.

**Applies To:** User

**Acceptance Criteria:**

1. The container image is built in the CI runner on every deploy. <!-- @impl: .github/workflows/deploy.yml::Build container image --> <!-- @impl: Dockerfile --> <!-- @test: host/__tests__/workflow-files.test.js (container image build + trivy + push) -->
2. The built image is scanned for HIGH and CRITICAL severity vulnerabilities. <!-- @impl: .github/workflows/deploy.yml::Scan container image for vulnerabilities = HIGH,CRITICAL --> <!-- @test: host/__tests__/workflow-files.test.js (container image build + trivy + push) -->
3. Known vulnerability exceptions are tracked in a project-level allowlist. <!-- @impl: .trivyignore --> <!-- @test: host/__tests__/workflow-files.test.js (container image build + trivy + push) -->
4. If the scan finds unexcepted vulnerabilities, the pipeline fails before push. <!-- @impl: .github/workflows/deploy.yml::Scan container image for vulnerabilities --> <!-- @test: host/__tests__/workflow-files.test.js (container image build + trivy + push) -->
5. The built image is pushed to the Cloudflare container registry; the resulting registry URI is captured for downstream binding. <!-- @impl: .github/workflows/deploy.yml::Push image to Cloudflare registry --> <!-- @test: host/__tests__/workflow-files.test.js (container image build + trivy + push) -->

**Constraints:**

- The container-binding and scaling steps consume the registry URI from this REQ; see [REQ-OPS-014](#req-ops-014-container-binding-and-scaling-from-image).

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-SEC-011](security.md#req-sec-011-container-image-scanned-for-cves-before-deploy)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-003: PR checks run lint, test, typecheck, and security audit

**Intent:** Every pull request to `main` must pass comprehensive quality checks before merge.

**Applies To:** User

**Acceptance Criteria:**

1. The PR-check workflow triggers on every pull request to the main branch and on manual dispatch. <!-- @impl: .github/workflows/test.yml --> <!-- @test: host/__tests__/workflow-files.test.js (PR Checks lint + test + typecheck + audit + dependency-review jobs) -->
2. The workflow runs lint on the codebase. <!-- @impl: .github/workflows/test.yml::Lint backend --> <!-- @test: host/__tests__/workflow-files.test.js (PR Checks lint + test + typecheck + audit + dependency-review jobs) -->
3. The workflow builds the frontend. <!-- @impl: .github/workflows/test.yml::Build frontend --> <!-- @test: host/__tests__/workflow-files.test.js (PR Checks lint + test + typecheck + audit + dependency-review jobs) -->
4. The workflow runs both backend and frontend test suites; the backend step may accept a non-zero `npm test` exit only when the log shows the known Workers-pool teardown-crash fingerprint as the single reported error, at least one test passed, and no failed-test tokens are present — never when actual test failures occurred. <!-- @impl: .github/workflows/test.yml::Run backend tests --> <!-- @test: host/__tests__/workflow-files.test.js (PR Checks lint + test + typecheck + audit + dependency-review jobs) -->
5. The workflow runs both backend and frontend typechecks. <!-- @impl: .github/workflows/test.yml::Type check backend --> <!-- @test: host/__tests__/workflow-files.test.js (PR Checks lint + test + typecheck + audit + dependency-review jobs) -->
6. The workflow runs a dead-code check on the codebase. <!-- @impl: .github/workflows/test.yml::Dead code check (backend) --> <!-- @test: host/__tests__/workflow-files.test.js (PR Checks lint + test + typecheck + audit + dependency-review jobs) -->
7. The workflow runs a high-severity security audit on production dependencies; PRs introducing dependencies with known vulnerabilities are blocked. <!-- @impl: .github/workflows/test.yml::Security audit (backend) --> <!-- @test: host/__tests__/workflow-files.test.js (PR Checks lint + test + typecheck + audit + dependency-review jobs) -->

**Constraints:**

- Quality checks do not run in the 1-vCPU development container; they run on CI runners.
- The CI runner label is configurable across all workflows.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-004: E2E test workflow setup and job graph

**Intent:** The e2e workflow runs end-to-end tests against a deployed environment. The setup stage primes the worker for service-token auth and the job graph sequences setup before the per-suite test jobs.

**Applies To:** User

**Acceptance Criteria:**

1. The E2E workflow runs on manual dispatch with an environment selector (integration or production). <!-- @impl: .github/workflows/e2e.yml --> <!-- @test: host/__tests__/workflow-e2e.test.js (workflow_dispatch + job-graph + SERVICE_AUTH_SECRET + E2E_BASE_URL) -->
2. Jobs run as a four-stage chain: setup, API tests, desktop UI tests, mobile UI tests. <!-- @impl: .github/workflows/e2e.yml --> <!-- @test: host/__tests__/workflow-e2e.test.js (workflow_dispatch + job-graph + SERVICE_AUTH_SECRET + E2E_BASE_URL) -->
3. The setup stage provisions the service-token secret on the target worker, seeds the E2E service user, and smoke-tests auth with a retry loop to absorb storage eventual-consistency lag. <!-- @impl: .github/workflows/e2e.yml::setup --> <!-- @test: host/__tests__/workflow-e2e.test.js (workflow_dispatch + job-graph + SERVICE_AUTH_SECRET + E2E_BASE_URL) -->
4. The target URL is configurable per environment so the same workflow can run against integration or production. <!-- @impl: .github/workflows/e2e.yml::Resolve target worker --> <!-- @test: host/__tests__/workflow-e2e.test.js (workflow_dispatch + job-graph + SERVICE_AUTH_SECRET + E2E_BASE_URL) -->

**Constraints:**

- E2E tests authenticate via the service-token header rather than browser-based flows.
- Per-suite test execution + artifact handling live in [REQ-OPS-015](#req-ops-015-e2e-per-suite-execution-and-artifact-handling).

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-SEC-012](security.md#req-sec-012-container-auth-token-per-do-lifecycle)

**Verification:** [Integration test](../../host/__tests__/workflow-e2e.test.js)

**Status:** Implemented

---

### REQ-OPS-005: Weekly pentest

**Intent:** Automated external pentest probes run on a weekly schedule to detect regressions in production security posture.

**Applies To:** User

**Acceptance Criteria:**

1. The pentest workflow runs weekly and on manual dispatch against the configured target URL in the production environment. <!-- @impl: .github/workflows/pentest.yml --> <!-- @test: host/__tests__/workflow-files.test.js (pentest 6-probe job graph + cron + dispatch) -->
2. The workflow runs six parallel probes using lightweight external tools (no active scanners) to minimize CI resource consumption. <!-- @impl: .github/workflows/pentest.yml --> <!-- @test: host/__tests__/workflow-files.test.js (pentest 6-probe job graph + cron + dispatch) -->
3. Six probe types cover response headers, TLS posture, authentication gates, information disclosure, injection vectors, and HTTP method handling; per-probe checklists live in [documentation/lanes/pentest.md](../../documentation/lanes/pentest.md). <!-- @impl: .github/workflows/pentest.yml --> <!-- @test: host/__tests__/workflow-files.test.js (pentest 6-probe job graph + cron + dispatch) -->

**Constraints:**

- The pentest requires a configured target URL set in the production deployment environment.
- The pentest uses only lightweight external tools (no heavy active scanners) so weekly runs do not consume excessive CI budget.

**Priority:** P1

**Dependencies:** [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response), [REQ-SEC-009](security.md#req-sec-009-input-validation-at-system-boundaries), [REQ-SEC-010](security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-006: Idle containers hibernate and cost zero

**Intent:** Containers that are not actively in use must hibernate and incur zero compute cost. The cost model anchors the entire pricing strategy, so the hibernation guarantee is operator-facing.

**Applies To:** Admin

**Acceptance Criteria:**

1. Containers hibernate after a configurable idle period of no user input (default 30 minutes, range 5 minutes to 2 hours). <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs --> <!-- @test: src/__tests__/container-metrics.test.ts (configurable idle period) -->
2. Hibernated containers consume zero CPU, memory, and disk cost. <!-- @impl: src/container/index.ts::collectMetrics --> <!-- @test: src/__tests__/container/index.test.ts (onStop lifecycle + collectMetrics idle-stop hibernated zero-cost) -->
3. Active-container cost is approximately $11/user/month for a typical workload on the default tier. <!-- coverage-gap: cost projection metric, no implementing source symbol; verified against billing-period invoices (Manual) -->

**Constraints:**

- CPU is billed on active usage only. Memory and disk are billed on provisioned resources during active time.
- R2 storage is billed by GB-month, with a free tier covering small workspaces.
- Cost scales per active session, not per user.
- Idle-timeout persistence + lifecycle mechanics live in [REQ-OPS-016](#req-ops-016-sleepafter-preference-persistence-and-lifecycle).
- Idle-timeout fail-safe invariants live in [REQ-OPS-017](#req-ops-017-sleepafter-fail-safe-invariants).

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/container/index.test.ts), Manual (zero-cost guarantee checked against billing-period invoices)

**Status:** Implemented

---

### REQ-OPS-007: Container specs configurable per environment

**Intent:** Container resource allocation (CPU, memory, disk) must be configurable per deployment environment to balance cost and performance.

**Applies To:** Admin

**Acceptance Criteria:**

1. Container resource tier is configurable per deployment and accepts four values: low (0.25 vCPU / 1 GiB / 4 GB), default (1 vCPU / 3 GiB / 6 GB), saas (1 vCPU / 3 GiB / 6 GB), high (2 vCPU / 6 GiB / 12 GB). <!-- @impl: .github/workflows/deploy.yml::Apply container resource tier --> <!-- @impl: wrangler.toml --> <!-- @test: host/__tests__/workflow-files.test.js (deploy RESSOURCE_TIER + MAX_INSTANCES + MAX_SESSIONS patching) -->
2. All tiers default to 10 concurrent instances. <!-- @impl: .github/workflows/deploy.yml::Apply container resource tier = MAX_INSTANCES=10 --> <!-- @test: host/__tests__/workflow-files.test.js (deploy RESSOURCE_TIER + MAX_INSTANCES + MAX_SESSIONS patching) -->
3. The concurrent-instance cap is overridable per deployment and must be a positive integer. <!-- @impl: .github/workflows/deploy.yml::Apply container resource tier --> <!-- @test: host/__tests__/workflow-files.test.js (deploy RESSOURCE_TIER + MAX_INSTANCES + MAX_SESSIONS patching) -->
4. Per-user concurrent session limits are configurable per deployment, with separate defaults for regular users (3) and admins (10). <!-- @impl: src/lib/constants.ts::getMaxSessions --> <!-- @test: host/__tests__/workflow-files.test.js (deploy RESSOURCE_TIER + MAX_INSTANCES + MAX_SESSIONS patching) -->
5. Tier and instance configuration is applied at deploy time, not at runtime. <!-- @impl: .github/workflows/deploy.yml::Apply container resource tier --> <!-- @test: host/__tests__/workflow-files.test.js (deploy RESSOURCE_TIER + MAX_INSTANCES + MAX_SESSIONS patching) -->

**Constraints:**

- The default resource tier is used when none is explicitly configured.
- The concurrent-instance cap is passed safely (no shell interpolation).
- Session limits omitted from the deploy fall back to backend defaults.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-008: Stress testing validates rate limits and concurrency

**Intent:** Load testing validates that rate limiting, session lifecycle, storage operations, and API throughput behave correctly under high load.

**Applies To:** User

**Acceptance Criteria:**

1. The stress-test workflow runs on manual dispatch against the integration environment. <!-- @impl: .github/workflows/stress-test.yml --> <!-- @test: host/__tests__/workflow-stress-test.test.js (workflow_dispatch + k6 suites + STRESS_TEST_CONCURRENCY default 0) -->
2. Load tests cover API throughput, rate-limit validation, session lifecycle, and storage operations. <!-- @impl: .github/workflows/stress-test.yml --> <!-- @test: host/__tests__/workflow-stress-test.test.js (workflow_dispatch + k6 suites + STRESS_TEST_CONCURRENCY default 0) -->
3. Concurrency is configurable per run; disabled by default, latency thresholds loosen when enabled. <!-- @impl: .github/workflows/stress-test.yml --> <!-- @test: host/__tests__/workflow-stress-test.test.js (workflow_dispatch + k6 suites + STRESS_TEST_CONCURRENCY default 0) -->
4. In stress-test deployment mode, all HTTP and WebSocket rate limits are bypassed to allow high virtual-user counts through a single service-token identity. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @impl: src/lib/rate-limit-core.ts --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (stress test mode bypass: bypasses rate limit + does NOT access KV + still enforces when unset) -->
5. A one-time warning is logged per worker instance when the rate-limit bypass activates. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (one-time warning per isolate across many bypassed requests) -->
6. Stress-test mode must not be active alongside SaaS mode; the combination returns 503 to all requests. <!-- @impl: src/index.ts --> <!-- @test: src/__tests__/index.test.ts (SAAS_MODE + STRESS_TEST_MODE conflict guard returns 503) -->

**Constraints:**

- Stress testing targets integration environments only.
- The rate-limit bypass incurs zero additional storage overhead.

**Priority:** P2

**Dependencies:** [REQ-SEC-007](security.md#req-sec-007-rate-limiting-infrastructure), [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** [Integration test](../../host/__tests__/workflow-stress-test.test.js)

**Status:** Implemented

---

### REQ-OPS-009: Supply chain security monitoring

**Intent:** The project's open-source supply chain security posture must be continuously monitored and reported.

**Applies To:** User

**Acceptance Criteria:**

1. The OSSF Scorecard workflow runs on push to main and weekly. <!-- @impl: .github/workflows/scorecard.yml --> <!-- @test: host/__tests__/workflow-files.test.js (scorecard cron + push-to-main trigger) -->
2. Scorecard results are uploaded to GitHub Security. <!-- @impl: .github/workflows/scorecard.yml::Upload to GitHub Security --> <!-- @test: host/__tests__/workflow-files.test.js (scorecard upload to GitHub Security) -->
3. Repository-level secret scanning with push protection is enabled. This is a repository-level GitHub setting verified out of band, not from source. <!-- coverage-gap: repository-level GitHub setting (secret scanning + push protection), verified out of band, not from source -->
4. Dependabot security updates are enabled at the repository level. This is a repository-level GitHub setting verified out of band, not from source. <!-- coverage-gap: repository-level GitHub setting (Dependabot security updates), verified out of band, not from source -->

**Constraints:**

- Supply chain monitoring is continuous (push-triggered + weekly), not on-demand.
- Secret-scanning push protection prevents secrets from being committed.
- High-severity dependency audits and dependency-review enforcement are owned by [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit); not duplicated here.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-010: Graceful container shutdown preserves data

**Intent:** Container shutdown must complete a final sync to R2 before termination to prevent data loss.

**Applies To:** User

**Acceptance Criteria:**

1. The container image declares a graceful-stop signal that the entrypoint trap can catch. <!-- @impl: Dockerfile = STOPSIGNAL SIGINT --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (STOPSIGNAL SIGINT) -->
2. The container entrypoint's trap handler catches the graceful-stop signal. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (trap shutdown_handler) --> <!-- @test: src/__tests__/container/index.test.ts (destroy: SIGTERM DO-side wiring) -->
3. The trap handler terminates the background sync daemon using a durable PID record as the sole mechanism. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (pidfile kill) -->
4. A final bidirectional sync to R2 runs before exit, with deletion safeguards to prevent accidental mass deletion. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (final bisync flags) --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (daemon-side cadence + recovery + --resync fallback) -->
5. The shutdown sync runs even when the initial sync timed out. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (bisync-initialized flag) -->
6. The terminal server is terminated after the final sync completes. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (TERMINAL_PID kill) --> <!-- @test: src/__tests__/container/index.test.ts (destroy: super.destroy fallback) -->

**Constraints:**

- The sync daemon's PID record is the sole mechanism for shutdown; no in-memory fallback exists.
- The shutdown sync is bounded so a deletion storm cannot wipe R2.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Integration test](../../host/__tests__/entrypoint-shutdown.test.js)

**Status:** Implemented

---

### REQ-OPS-011: Container base image is Debian bookworm-slim

**Intent:** Reliable CLI agent execution requires a glibc-based Linux distribution (Alpine/musl caused crashes for some agents).

**Applies To:** Admin

**Acceptance Criteria:**

1. The container base image is a glibc-based Node.js 24 distribution (Debian bookworm-slim). <!-- @impl: Dockerfile = node:24-bookworm-slim --> <!-- @test: host/__tests__/dockerfile-base-image.test.js (FROM bookworm-slim) -->
2. All supported agent CLIs (Claude Code, Codex, Antigravity, Copilot, OpenCode) start without crashes. <!-- @impl: Dockerfile --> <!-- @test: host/__tests__/dockerfile-base-image.test.js (npm global agent CLI installs) -->
3. Essential developer tools for terminal-based workflows are pre-installed. <!-- @impl: Dockerfile --> <!-- @test: host/__tests__/dockerfile-base-image.test.js (system packages + fd-find symlink) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** None.

**Verification:** [Integration test](../../host/__tests__/dockerfile-base-image.test.js)

**Status:** Implemented

---

### REQ-OPS-012: Per-environment container concurrency limit

**Intent:** Operators can control how many containers run concurrently per environment independently of resource tier.

**Applies To:** Admin

**Acceptance Criteria:**

1. Operators can override the default concurrent-instance cap per deployment. <!-- @impl: .github/workflows/deploy.yml::Apply container resource tier --> <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (MAX_INSTANCES_OVERRIDE operator override) -->
2. The override is independent of resource tier. <!-- @impl: .github/workflows/deploy.yml::Apply container resource tier --> <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (tier independence) -->
3. The override must be a positive integer. <!-- @impl: .github/workflows/deploy.yml::Apply container resource tier --> <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (positive-integer regex) -->
4. The override is applied at deploy time as part of the deployment configuration. <!-- @impl: .github/workflows/deploy.yml::Apply container resource tier --> <!-- @impl: wrangler.toml --> <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (wrangler.toml patching at deploy time) --> <!-- @test: host/__tests__/workflow-files.test.js (deploy-time apply) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** [Integration test](../../host/__tests__/workflow-deploy-max-instances.test.js)

**Status:** Implemented

---

### REQ-OPS-013: Deploy command and post-deploy hooks

**Intent:** After the pre-deploy pipeline succeeds, the workflow applies the worker name, runs `wrangler deploy`, sets worker secrets, and seeds the E2E service user in KV so the deployed worker is fully configured and reachable.

**Applies To:** User

**Acceptance Criteria:**

1. The worker name is configurable per environment. <!-- @impl: .github/workflows/deploy.yml::Apply worker name to wrangler config --> <!-- @test: host/__tests__/workflow-files.test.js (wrangler deploy + secrets + E2E seed) -->
2. The worker is deployed with runtime configuration variables applied. <!-- @impl: .github/workflows/deploy.yml::Deploy to Cloudflare --> <!-- @test: host/__tests__/workflow-files.test.js (wrangler deploy + secrets + E2E seed) -->
3. Required worker secrets are written after deployment. <!-- @impl: .github/workflows/deploy.yml::Set API token as worker secret --> <!-- @test: host/__tests__/workflow-files.test.js (wrangler deploy + secrets + E2E seed) -->
4. The E2E service user is seeded into the allowlist when the CF Access service-token secret is configured. <!-- @impl: .github/workflows/deploy.yml::Set service auth secret for E2E testing (optional) --> <!-- @test: host/__tests__/workflow-files.test.js (wrangler deploy + secrets + E2E seed) -->

**Constraints:**

- Secrets are set after worker deployment, as secret writes target a worker that must already exist.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-014: Container binding and scaling from image

**Intent:** After the image is pushed, the deploy workflow patches the registry URI into `wrangler.toml`, applies the resource tier and max-instance count, and offers cache-buster control over the AI agent layer. The bound Durable Object container is what user sessions land on.

**Applies To:** User

**Acceptance Criteria:**

1. The deployment configuration is updated with the registry URI of the most recently pushed image so the deploy does not rebuild the container. <!-- @impl: .github/workflows/deploy.yml::Point wrangler.toml to pre-pushed image --> <!-- @test: host/__tests__/workflow-files.test.js (wrangler.toml patch + tier + max-instances + cache-buster) -->
2. Container resource sizing is applied per the configured tier (low, default/saas, or high). <!-- @impl: .github/workflows/deploy.yml::Apply container resource tier --> <!-- @test: host/__tests__/workflow-files.test.js (wrangler.toml patch + tier + max-instances + cache-buster) -->
3. All tiers default to 10 concurrent instances; the cap is overridable per deployment. <!-- @impl: .github/workflows/deploy.yml::Apply container resource tier = MAX_INSTANCES=10 --> <!-- @test: host/__tests__/workflow-files.test.js (wrangler.toml patch + tier + max-instances + cache-buster) -->
4. The AI agent layer can be cache-busted on demand via a build variable so a fresh layer is rolled out without a full image rebuild. <!-- @impl: .github/workflows/deploy.yml::Generate cache buster (optional — force fresh npm install) --> <!-- @test: host/__tests__/workflow-files.test.js (wrangler.toml patch + tier + max-instances + cache-buster) -->

**Constraints:**

- The concurrent-instance cap is a positive integer and is passed safely (no shell interpolation).
- Resource tier is configured at deploy time, not at runtime.

**Priority:** P0

**Dependencies:** [REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-015: E2E per-suite execution and artifact handling

**Intent:** Each E2E suite (API, desktop UI, mobile UI) runs as its own job in the e2e workflow. Failed UI runs persist screenshots and HTML so the user can diagnose what the deployed worker actually rendered.

**Applies To:** User

**Acceptance Criteria:**

1. The API test suite runs as its own job. <!-- @impl: .github/workflows/e2e.yml::e2e-api --> <!-- @test: host/__tests__/workflow-e2e.test.js (e2e-api per-suite job) -->
2. The desktop UI test suite runs as its own job, in a Chromium browser. <!-- @impl: .github/workflows/e2e.yml::e2e-ui-desktop --> <!-- @test: host/__tests__/workflow-e2e.test.js (e2e-ui-desktop per-suite job) -->
3. The mobile UI test suite runs as its own job, in mobile emulation mode. <!-- @impl: .github/workflows/e2e.yml::e2e-ui-mobile --> <!-- @test: host/__tests__/workflow-e2e.test.js (e2e-ui-mobile E2E_MOBILE=1 per-suite job) -->
4. Failed UI test runs upload screenshots and HTML as artifacts with a five-day retention. <!-- @impl: .github/workflows/e2e.yml::Upload E2E artifacts --> <!-- @test: host/__tests__/workflow-e2e.test.js (failure-only artifact upload + 5-day retention) --> <!-- @test: host/__tests__/workflow-files.test.js (e2e.yml artifact handling for failed suites) -->

**Constraints:**

- UI tests require a Chromium browser and supporting system libraries in the runner environment.

**Priority:** P1

**Dependencies:** [REQ-OPS-004](#req-ops-004-e2e-test-workflow-setup-and-job-graph)

**Verification:** [Integration test](../../host/__tests__/workflow-e2e.test.js)

**Status:** Implemented

---

### REQ-OPS-016: sleepAfter preference persistence and lifecycle

**Intent:** The user-configurable idle-timeout preference must survive container-orchestration resets; on startup the stored preference is validated; on shutdown it is cleaned up.

**Applies To:** Admin

**Acceptance Criteria:**

1. The idle-timeout preference is persisted durably so it survives container-orchestration resets. <!-- @impl: src/container/container-router.ts::dispatchInternalRoute --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (sleepAfter persisted in KV across initial set and updates) -->
2. The preference is persisted on both initial bucket configuration and any subsequent updates. <!-- @impl: src/container/container-router.ts::dispatchInternalRoute --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (sleepAfter persisted in KV across initial set and updates) -->
3. On startup, the stored preference is loaded and validated. <!-- @impl: src/container/index.ts::onStart --> <!-- @test: src/__tests__/routes/container-restart-prefs.test.ts (stored preference loaded on startup) -->
4. On session destruction, the persisted preference is removed. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (destroy: preference removed on session destruction) -->

**Constraints:**

- Persisted preference values are schema-validated on load; invalid values are treated as missing and trigger the fail-safe fallback in [REQ-OPS-017](#req-ops-017-sleepafter-fail-safe-invariants).

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-hibernate-and-cost-zero)

**Verification:** [Automated test](../../src/__tests__/routes/session-sleep-timeout.test.ts), [DO lifecycle paths](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-OPS-017: sleepAfter fail-safe invariants

**Intent:** Three invariants protect user work from a misconfigured or silently broken idle-detection layer: fail to the maximum (not minimum) on corruption, propagate preference changes within one cycle, and fail loudly rather than substituting a default. A container that dies before its configured timer destroys an hour of unpushed work and breaks the product's core promise.

**Applies To:** Admin

**Acceptance Criteria:**

1. The idle-detection layer fails safe in the direction of preserving user work, not minimizing compute. When the configured idle timeout cannot be resolved (storage corrupted, schema-validated value missing, parser fed garbage, code path skipped the user-pref resolution), the system falls back to the maximum supported value (2h) rather than the minimum. <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs = SLEEP_AFTER_FALLBACK_MS = 7_200_000 --> <!-- @test: src/__tests__/container-metrics.test.ts (fail-safe to 2h on corruption) -->
2. A change to the persisted idle-timeout preference takes effect within one idle-check cycle, regardless of which code path wrote it. <!-- @impl: src/container/index.ts::collectMetrics --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (preference change takes effect within one cycle) -->
3. In-memory copies of the preference do not outlive a single idle-check cycle. <!-- @impl: src/container/index.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (refreshes idleTimeoutPref from storage on every tick) -->
4. Any code path that hands the resolved idle timeout to the container init must fail loudly when the value is missing, rather than substituting a fallback. The user's configured timer is never silently replaced by a shorter default. <!-- @impl: src/container/index.ts --> <!-- @test: src/__tests__/container-metrics.test.ts (fail-loud-not-substitute) -->

**Constraints:**

- The fail-safe direction is chosen to preserve user work over billing efficiency.

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-hibernate-and-cost-zero), [REQ-OPS-016](#req-ops-016-sleepafter-preference-persistence-and-lifecycle)

**Verification:** [Automated test](../../src/__tests__/container-metrics.test.ts)

**Status:** Implemented

---

### REQ-OPS-018: Weekly fuzz testing

**Intent:** Property-based fuzz testing runs on a weekly schedule and on every PR to `main` to identify edge-case bugs in input parsing and state transitions.

**Applies To:** User

**Acceptance Criteria:**

1. The fuzz workflow runs on PRs to `main`, weekly (Sunday 04:00 UTC), and on `workflow_dispatch`. <!-- @impl: .github/workflows/fuzz.yml --> <!-- @test: host/__tests__/workflow-files.test.js (fuzz cron + PR trigger) -->
2. Fuzz testing uses fast-check with 50,000 iterations for property-based testing. <!-- @impl: .github/workflows/fuzz.yml::Run backend fuzz tests (extended iterations) = FAST_CHECK_NUM_RUNS: '50000' --> <!-- @test: host/__tests__/workflow-files.test.js (fast-check 50000 iterations) -->

**Constraints:**

- Fuzz iteration count is calibrated to keep PR-blocking jobs under the 10-minute CI budget; weekly runs are unbounded.

**Priority:** P1

**Dependencies:** [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response), [REQ-SEC-009](security.md#req-sec-009-input-validation-at-system-boundaries), [REQ-SEC-010](security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-019: Security-posture scanning workflows

**Intent:** Independent security-posture assessment workflows must continuously evaluate the codebase against known-vulnerability patterns and supply-chain risk indicators, outside the per-PR quality gates.

**Applies To:** User

**Acceptance Criteria:**

1. A CodeQL static-analysis workflow runs on pushes to main, on PRs to main, and on a weekly schedule. Results are uploaded to GitHub Security. <!-- @impl: .github/workflows/codeql.yml --> <!-- @test: host/__tests__/workflow-files.test.js (codeql + scorecard jobs) -->
2. An OSSF Scorecard workflow runs a security-posture assessment on push to main and on a weekly schedule. <!-- @impl: .github/workflows/scorecard.yml --> <!-- @test: host/__tests__/workflow-files.test.js (codeql + scorecard jobs) -->

**Constraints:**

- These workflows run independently of the per-PR quality gates in [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit); their cadence is push-to-main + weekly, not per-PR.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-020: Shadow-pin version bump automation

**Intent:** Pinned binary versions in Dockerfile and npm packages outside package.json are invisible to Dependabot. A weekly workflow checks upstream releases and opens one PR per tool when a newer version is available, with SHA256 intentionally invalidated to force manual checksum verification before merge.

**Applies To:** Operator

**Acceptance Criteria:**

1. Watched Dockerfile binaries: zoxide, yazi, lazygit, silverbullet. Each has its own parallel job checking GitHub releases. <!-- @impl: .github/workflows/bump-shadow-pins.yml --> <!-- @test: host/__tests__/workflow-files.test.js (shadow-pin bump workflow) -->
2. Watched npm packages: context-mode (canonical version in plugin.json, echoed in entrypoint.sh fallback and hooks.json); the Pi preseed dependencies `@gotgenes/pi-subagents` and `context-mode`, pinned in `preseed/agents/pi/package.json` (+ `package-lock.json`, with `@gotgenes/pi-subagents` also a literal in entrypoint.sh), bumped together by the `pi-preseed` job; `consult-llm-mcp`, pinned as a `npm install -g` literal in the Dockerfile, bumped by the `consult-llm-mcp` job; and `@modelcontextprotocol/sdk`, pinned exact in `preseed/agents/claude/browser-run-mcp/package.json` (the Claude-side Browser Run MCP server; no lockfile, not Dependabot-covered), bumped by the `browser-run-mcp` job. Watched PyPI packages: graphifyy, whose canonical pin lives in `preseed/agents/claude/plugins/graphify/.claude-plugin/plugin.json` (read by the Dockerfile via `jq`, so there is no Dockerfile literal to bump); its job bumps both the `.version` and the `graphifyy@X.Y.Z` description string there. <!-- @impl: .github/workflows/bump-shadow-pins.yml --> <!-- @test: host/__tests__/workflow-files.test.js (shadow-pin bump workflow) -->
3. SHA256 checksum is reset to a placeholder on Dockerfile bumps, causing Docker build failure until the operator verifies and updates the hash. <!-- @impl: .github/workflows/bump-shadow-pins.yml::Apply bump --> <!-- @test: host/__tests__/workflow-files.test.js (shadow-pin bump workflow) -->
4. A bump branch is skipped if one already exists for that version (deduplication guard). <!-- @impl: .github/workflows/bump-shadow-pins.yml::Skip if a branch for this version already exists --> <!-- @test: host/__tests__/workflow-files.test.js (shadow-pin bump workflow) -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented
