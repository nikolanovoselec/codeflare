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

1. The deploy workflow triggers automatically on successful PR-check completion against the main branch. <!-- @impl: .github/workflows/deploy.yml::deploy -->
2. The deploy workflow also supports manual dispatch to production, integration, enterprise, or enterprise integration. <!-- @impl: .github/workflows/deploy.yml::deploy -->
3. The deploy pipeline runs end-to-end: install dependencies, build, test, typecheck, build the container image, scan it, push it, deploy, and set secrets. <!-- @impl: .github/workflows/deploy.yml::deploy -->
4. Dependencies are cached between runs for faster pipeline execution.
5. Frontend is built, and both backend and frontend tests and typechecks run before any deployment steps; the shared backend launcher preserves the test process exit status, so any assertion, collection, runtime, worker-pool, or incomplete-suite error blocks deployment. <!-- @impl: .github/workflows/deploy.yml::Run backend tests --> <!-- @impl: .github/workflows/deploy-dockerhub.yml::Run backend tests --> <!-- @impl: scripts/run-backend-tests.sh::run_backend_tests --> <!-- @test: host/__tests__/backend-test-launcher.test.js (backend test launcher preserves a crashed suite nonzero exit despite pass-looking output) -->
6. The KV namespace is resolved or created and applied to the deployment configuration. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- Automatic production deployment follows a successful main-branch PR check; manual dispatch supports production, integration, enterprise, and enterprise integration.
- The CI runner label is configurable to support self-hosted runners.
- The deploy command, secret-setting, and post-deploy seed steps live in [REQ-OPS-013](#req-ops-013-deploy-command-and-post-deploy-hooks).

**Priority:** P0

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-002: Docker image build, vulnerability scan, and registry push

**Intent:** Every deploy builds a Docker image, scans it for HIGH/CRITICAL vulnerabilities with allowlisted exceptions, and pushes the resulting artifact to the Cloudflare container registry. The pipeline fails before push on any unexcepted finding.

**Applies To:** User

**Acceptance Criteria:**

1. The container image is built in the CI runner on every deploy. <!-- @impl: .github/workflows/deploy.yml::deploy -->
2. The built image is scanned for HIGH and CRITICAL severity vulnerabilities. <!-- @impl: .github/workflows/deploy.yml::severity = HIGH,CRITICAL -->
3. Known vulnerability exceptions are tracked in a project-level allowlist.
4. If the scan finds unexcepted vulnerabilities, the pipeline fails before push.
5. The built image is pushed to the Cloudflare container registry; the resulting registry URI is captured for downstream binding. <!-- @impl: .github/workflows/deploy.yml::deploy -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- The container-binding and scaling steps consume the registry URI from this REQ; see [REQ-OPS-014](#req-ops-014-container-binding-and-scaling-from-image).

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-SEC-011](security.md#req-sec-011-container-image-scanned-for-cves-before-deploy)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-003: PR checks run lint, test, typecheck, and security audit

**Intent:** Every pull request to `main` must pass comprehensive quality checks before merge.

**Applies To:** User

**Acceptance Criteria:**

1. The PR-check workflow triggers on every pull request to the main branch and on manual dispatch.
2. The workflow runs lint on the codebase. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
3. The workflow builds the frontend.
4. The workflow runs both backend and frontend test suites; the backend step preserves the test process exit status, so any assertion, collection, runtime, worker-pool, or incomplete-suite error fails the check even when other assertions passed. Workers tests use one worker with shared storage, matching Cloudflare's documented WebSocket + Durable Object workaround. <!-- @impl: .github/workflows/test.yml::Run backend tests --> <!-- @impl: scripts/run-backend-tests.sh::run_backend_tests --> <!-- @impl: vitest.config.ts::test --> <!-- @test: host/__tests__/backend-test-launcher.test.js (backend test launcher preserves a crashed suite nonzero exit despite pass-looking output) -->
5. The workflow runs both backend and frontend typechecks.
6. The workflow runs a dead-code check on the codebase. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
7. The workflow runs a high-severity security audit on production dependencies; PRs introducing dependencies with known vulnerabilities are blocked.

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- Quality checks do not run in the 1-vCPU development container; they run on CI runners.
- The CI runner label is configurable across all workflows.

**Priority:** P0

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-004: E2E test workflow setup and job graph

**Intent:** The e2e workflow runs end-to-end tests against a deployed environment. The setup stage primes the worker for service-token auth and the job graph sequences setup before the per-suite test jobs.

**Applies To:** User

**Acceptance Criteria:**

1. The E2E workflow runs on manual dispatch with an environment selector (integration or production). <!-- @test: host/__tests__/workflow-e2e.test.js (REQ-OPS-004 AC1: workflow triggers on workflow_dispatch with environment selection (integration or production)) -->
2. Jobs run as a four-stage chain: setup, API tests, desktop UI tests, mobile UI tests. <!-- @impl: .github/workflows/e2e.yml::target --> <!-- @test: host/__tests__/workflow-e2e.test.js (REQ-OPS-015: E2E per-suite execution and artifact handling) -->
3. The setup stage provisions the service-token secret on the target worker, seeds the E2E service user, and smoke-tests auth with a retry loop to absorb storage eventual-consistency lag. <!-- @impl: .github/workflows/e2e.yml::setup --> <!-- @test: host/__tests__/workflow-e2e.test.js (REQ-OPS-004 AC3: setup job sets SERVICE_AUTH_SECRET, seeds E2E service user in KV, smoke-tests auth with retry loop) -->
4. The target URL is configurable per environment so the same workflow can run against integration or production. <!-- @impl: .github/workflows/e2e.yml::target --> <!-- @test: host/__tests__/workflow-e2e.test.js (REQ-OPS-004: E2E test workflow setup and job graph) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- E2E tests authenticate via the service-token header.
- Per-suite test execution + artifact handling live in [REQ-OPS-015](#req-ops-015-e2e-per-suite-execution-and-artifact-handling).

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-SEC-012](security.md#req-sec-012-container-auth-token-per-do-lifecycle)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-005: Weekly pentest

**Intent:** Automated external pentest probes run on a weekly schedule to detect regressions in production security posture.

**Applies To:** User

**Acceptance Criteria:**

1. The pentest workflow runs weekly and on manual dispatch against the configured target URL in the production environment. <!-- @impl: .github/workflows/pentest.yml::tls -->
2. The workflow runs six parallel probes using lightweight external tools (no active scanners) to minimize CI resource consumption.
3. Six probe types cover response headers, TLS posture, authentication gates, information disclosure, injection vectors, and HTTP method handling; per-probe checklists live in [documentation/lanes/pentest.md](../../documentation/lanes/pentest.md#test-results).

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- The pentest requires a configured target URL set in the production deployment environment.
- The pentest uses only lightweight external tools (no heavy active scanners) so weekly runs do not consume excessive CI budget.

**Priority:** P1

**Dependencies:** [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response), [REQ-SEC-009](security.md#req-sec-009-input-validation-at-system-boundaries), [REQ-SEC-010](security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-006: Idle containers hibernate and cost zero

**Intent:** Containers that are not actively in use must hibernate and incur zero compute cost. The cost model anchors the entire pricing strategy, so the hibernation guarantee is operator-facing.

**Applies To:** Admin

**Acceptance Criteria:**

1. Containers hibernate after a configurable idle period of no user input (default 30 minutes, range 5 minutes to 2 hours). <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs --> <!-- @test: src/__tests__/container-metrics.test.ts (idle timeout resolution (REQ-OPS-006 AC8/AC9) / REQ-OPS-017 (sleepAfter fail-safe invariants)) -->
2. Hibernated containers consume zero CPU, memory, and disk cost. <!-- @impl: src/container/index.ts::collectMetrics --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
3. Active-container cost is approximately $11/user/month for a typical workload on the default tier.

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- CPU is billed on active usage only; Memory and disk are billed on provisioned resources during active time.
- R2 storage is billed by GB-month, with a free tier covering small workspaces.
- Cost scales per active session, not per user.
- Idle-timeout persistence + lifecycle mechanics live in [REQ-OPS-016](#req-ops-016-sleepafter-preference-persistence-and-lifecycle).
- Idle-timeout fail-safe invariants live in [REQ-OPS-017](#req-ops-017-sleepafter-fail-safe-invariants).

**Priority:** P0

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-007: Container specs configurable per environment

**Intent:** Container resource allocation (CPU, memory, disk) must be configurable per deployment environment to balance cost and performance.

**Applies To:** Admin

**Acceptance Criteria:**

1. Container resource tier accepts four per-deployment values: low (0.25 vCPU / 1 GiB / 4 GB), default (1 vCPU / 3 GiB / 6 GB), saas (1 vCPU / 3 GiB / 6 GB), high (2 vCPU / 6 GiB / 12 GB). <!-- @impl: .github/workflows/deploy.yml::deploy -->
2. All tiers default to 10 concurrent instances.
3. The concurrent-instance cap is overridable per deployment and must be a positive integer.
4. Per-user concurrent session limits are configurable per deployment, with separate defaults for regular users (3) and admins (10). <!-- @impl: src/lib/constants.ts::getMaxSessions -->
5. Tier and instance configuration is applied at deploy time, not at runtime. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (REQ-OPS-012: Per-environment container concurrency limit) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- The default resource tier is used when none is explicitly configured.
- The concurrent-instance cap is passed safely (no shell interpolation).
- Session limits omitted from the deploy fall back to backend defaults.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-008: Stress testing validates rate limits and concurrency

**Intent:** Load testing validates that rate limiting, session lifecycle, storage operations, and API throughput behave correctly under high load.

**Applies To:** User

**Acceptance Criteria:**

1. The stress-test workflow runs on manual dispatch against the integration environment. <!-- @test: host/__tests__/workflow-stress-test.test.js (REQ-OPS-008 AC1: stress-test workflow triggers on workflow_dispatch targeting the integration environment) -->
2. Load tests cover API throughput, rate-limit validation, session lifecycle, and storage operations. <!-- @test: host/__tests__/workflow-stress-test.test.js (REQ-OPS-008 AC2: k6 stress tests cover API throughput, session lifecycle, storage operations, and rate-limit validation) -->
3. Concurrency is configurable per run; disabled by default, latency thresholds loosen when enabled. <!-- @test: host/__tests__/workflow-stress-test.test.js (REQ-OPS-008: Stress testing validates rate limits and concurrency) -->
4. In stress-test deployment mode, all HTTP and WebSocket rate limits are bypassed to allow high virtual-user counts through a single service-token identity. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter / REQ-SEC-007 AC1 (factory keyed by bucketName with CF-Connecting-IP fallback) / REQ-SEC-007 AC2 (KV primary + in-memory fallback with TTL) / REQ-SEC-007 AC3 (429 with RATE_LIMIT_ERROR) / REQ-SEC-007 AC4 (X-RateLimit headers) / REQ-SEC-019 AC5 (STRESS_TEST_MODE bypass)) -->
5. A one-time warning is logged per worker instance when the rate-limit bypass activates. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (REQ-OPS-008 AC5: one-time warning per isolate) -->
6. Stress-test mode must not be active alongside SaaS mode; the combination returns 503 to all requests. <!-- @test: src/__tests__/index.test.ts (Edge-level setup redirect) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- Stress testing targets integration environments only.
- The rate-limit bypass incurs zero additional storage overhead.

**Priority:** P2

**Dependencies:** [REQ-SEC-007](security.md#req-sec-007-rate-limiting-infrastructure), [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-009: Supply chain security monitoring

**Intent:** The project's open-source supply chain security posture must be continuously monitored and reported.

**Applies To:** User

**Acceptance Criteria:**

1. The OSSF Scorecard workflow runs on push to main and weekly.
2. Scorecard results are uploaded to GitHub Security.
3. Repository-level secret scanning with push protection is enabled. This is a repository-level GitHub setting verified out of band, not from source.
4. Dependabot security updates are enabled at the repository level. This is a repository-level GitHub setting verified out of band, not from source.

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- Supply chain monitoring is continuous (push-triggered + weekly), not on-demand.
- Secret-scanning push protection prevents secrets from being committed.
- High-severity dependency audits and dependency-review enforcement are owned by [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit); not duplicated here.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-010: Graceful container shutdown preserves data

**Intent:** Container shutdown must complete a final sync to R2 before termination to prevent data loss.

**Applies To:** User

**Acceptance Criteria:**

1. The container image declares a graceful-stop signal that the entrypoint trap can catch. <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC1: the container image declares STOPSIGNAL SIGINT) -->
2. The container entrypoint's trap handler catches the graceful-stop signal. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC2: the container entrypoint trap handler catches SIGINT/SIGTERM signals) -->
3. The trap handler terminates the background sync daemon using a durable PID record as the sole mechanism. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC3: trap handler kills the sync daemon via PID file at /tmp/sync-daemon.pid) -->
4. A final bidirectional sync to R2 runs before exit, with deletion safeguards to prevent accidental mass deletion. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC4: final rclone bisync with --ignore-checksum --max-delete 100 runs to R2 before exit) -->
5. The shutdown sync runs even when the initial sync timed out. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC5: bisync-initialized flag is touched on the timeout path to ensure final bisync runs) -->
6. The terminal server is terminated after the final sync completes. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC6: terminal server is killed after the final sync completes) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- The sync daemon's PID record is the sole mechanism for shutdown; no in-memory fallback exists.
- The shutdown sync is bounded so a deletion storm cannot wipe R2.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-011: Container base image is Debian bookworm-slim

**Intent:** Reliable CLI agent execution requires a glibc-based Linux distribution (Alpine/musl caused crashes for some agents).

**Applies To:** Admin

**Acceptance Criteria:**

1. The container base image is a glibc-based Node.js 24 distribution (Debian bookworm-slim). <!-- @test: host/__tests__/dockerfile-base-image.test.js (REQ-OPS-011: Container base image is Debian bookworm-slim) -->
2. All supported agent CLIs (Claude Code, Codex, Antigravity, Copilot, OpenCode) start without crashes. <!-- @test: host/__tests__/dockerfile-base-image.test.js (REQ-OPS-011 AC2 (precondition): agent CLI packages are present in the image for Claude Code, Codex, Gemini CLI, Copilot, OpenCode) -->
3. Essential developer tools for terminal-based workflows are pre-installed. <!-- @test: host/__tests__/dockerfile-base-image.test.js (REQ-OPS-011 AC3: system packages include essential tools: git, ripgrep, neovim, tmux, fzf, jq, python) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:** None.

**Priority:** P1

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-012: Per-environment container concurrency limit

**Intent:** Operators can control how many containers run concurrently per environment independently of resource tier.

**Applies To:** Admin

**Acceptance Criteria:**

1. Operators can override the default concurrent-instance cap per deployment. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. The override is independent of resource tier. <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (REQ-OPS-012: Per-environment container concurrency limit) -->
3. The override must be a positive integer. <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (REQ-OPS-012 AC3: MAX_INSTANCES must be a positive integer (enforced with regex validation)) -->
4. The override is applied at deploy time as part of the deployment configuration. <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (REQ-OPS-012 AC4: MAX_INSTANCES is applied during deploy via wrangler.toml patching) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-013: Deploy command and post-deploy hooks

**Intent:** After the pre-deploy pipeline succeeds, the workflow applies the worker name, runs `wrangler deploy`, sets worker secrets, and seeds the E2E service user in KV so the deployed worker is fully configured and reachable.

**Applies To:** User

**Acceptance Criteria:**

1. The worker name is configurable per environment. <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (Setup Store) -->
2. The worker is deployed with runtime configuration variables applied. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
3. Required worker secrets are written after deployment. <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) -->
4. The E2E service user is seeded into the allowlist when the CF Access service-token secret is configured. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-001 (two authentication modes) / REQ-AUTH-007 (JIT user provisioning in SaaS) / REQ-AUTH-012 (welcome email on provisioning)) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- Secrets are set after worker deployment, as secret writes target a worker that must already exist.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-014: Container binding and scaling from image

**Intent:** After the image is pushed, the deploy workflow patches the registry URI into `wrangler.toml`, applies the resource tier and max-instance count, and offers cache-buster control over the AI agent layer. The bound Durable Object container is what user sessions land on.

**Applies To:** User

**Acceptance Criteria:**

1. The deployment configuration is updated with the registry URI of the most recently pushed image so the deploy does not rebuild the container. <!-- @impl: .github/workflows/deploy.yml::deploy -->
2. Container resource sizing is applied per the configured tier (low, default/saas, or high). <!-- @impl: .github/workflows/deploy.yml::deploy -->
3. All tiers default to 10 concurrent instances; the cap is overridable per deployment.
4. The AI agent layer can be cache-busted on demand via a build variable so a fresh layer is rolled out without a full image rebuild. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- The concurrent-instance cap is a positive integer and is passed safely (no shell interpolation).
- Resource tier is configured at deploy time, not at runtime.

**Priority:** P0

**Dependencies:** [REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-015: E2E per-suite execution and artifact handling

**Intent:** Each E2E suite (API, desktop UI, mobile UI) runs as its own job in the e2e workflow. Failed UI runs persist screenshots and HTML so the user can diagnose what the deployed worker actually rendered.

**Applies To:** User

**Acceptance Criteria:**

1. The API test suite runs as its own job. <!-- @impl: .github/workflows/e2e.yml::e2e-api --> <!-- @test: host/__tests__/workflow-e2e.test.js (REQ-OPS-015 AC1: e2e-api job runs the API test suite) -->
2. The desktop UI test suite runs as its own job, in a Chromium browser. <!-- @impl: .github/workflows/e2e.yml::e2e-ui-desktop --> <!-- @test: host/__tests__/workflow-e2e.test.js (REQ-OPS-015 AC2: e2e-ui-desktop job runs UI desktop tests with Puppeteer/Chrome) -->
3. The mobile UI test suite runs as its own job, in mobile emulation mode. <!-- @impl: .github/workflows/e2e.yml::e2e-ui-mobile --> <!-- @test: host/__tests__/workflow-e2e.test.js (REQ-OPS-015 AC3: e2e-ui-mobile job runs UI mobile tests with E2E_MOBILE=1) -->
4. Failed UI test runs upload screenshots and HTML as artifacts with a five-day retention. <!-- @test: host/__tests__/workflow-e2e.test.js (REQ-OPS-015 AC4: failed UI test runs upload screenshots and HTML as artifacts with 5-day retention) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- UI tests require a Chromium browser and supporting system libraries in the runner environment.

**Priority:** P1

**Dependencies:** [REQ-OPS-004](#req-ops-004-e2e-test-workflow-setup-and-job-graph)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-016: sleepAfter preference persistence and lifecycle

**Intent:** The user-configurable idle-timeout preference must survive container-orchestration resets; on startup the stored preference is validated; on shutdown it is cleaned up.

**Applies To:** Admin

**Acceptance Criteria:**

1. The idle-timeout preference is persisted durably so it survives container-orchestration resets. <!-- @impl: src/container/container-router.ts::dispatchInternalRoute --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (sleepAfter persists across GET/PATCH round-trip) -->
2. The preference is persisted on both initial bucket configuration and any subsequent updates. <!-- @impl: src/container/container-router.ts::dispatchInternalRoute --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (sleepAfter persists across GET/PATCH round-trip) -->
3. On startup, the stored preference is loaded and validated. <!-- @impl: src/container/index.ts::onStart -->
4. On session destruction, the persisted preference is removed. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- Persisted preference values are schema-validated on load; invalid values are treated as missing and trigger the fail-safe fallback in [REQ-OPS-017](#req-ops-017-sleepafter-fail-safe-invariants).

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-hibernate-and-cost-zero)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-017: sleepAfter fail-safe invariants

**Intent:** Three invariants protect user work from a misconfigured or silently broken idle-detection layer: fail to the maximum (not minimum) on corruption, propagate preference changes within one cycle, and fail loudly rather than substituting a default. A container that dies before its configured timer destroys an hour of unpushed work and breaks the product's core promise.

**Applies To:** Admin

**Acceptance Criteria:**

1. The idle-detection layer fails safe toward preserving user work, not saving compute: when the configured idle timeout cannot be resolved (corrupt storage, a missing/garbage value, or a skipped pref-resolution path), it falls back to the maximum supported value (4h), never the minimum. <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs --> <!-- @impl: src/container/container-metrics.ts::SLEEP_AFTER_FALLBACK_MS = 14_400_000 --> <!-- @test: src/__tests__/lib/sleep-timer-defaults.test.ts (parseSleepAfterMs - fail-safe direction) -->
2. A change to the persisted idle-timeout preference takes effect within one idle-check cycle, regardless of which code path wrote it. <!-- @impl: src/container/index.ts::collectMetrics --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014: User-configurable auto-sleep timeout in Settings) -->
3. In-memory copies of the preference do not outlive a single idle-check cycle. <!-- @impl: src/container/index.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (refreshes idleTimeoutPref from storage on every tick) -->
4. Any code path that hands the resolved idle timeout to the container init must fail loudly when the value is missing, rather than substituting a fallback. The user's configured timer is never silently replaced by a shorter default. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container-metrics.test.ts (Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)) -->

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

1. The fuzz workflow runs on PRs to `main`, weekly (Sunday 04:00 UTC), and on `workflow_dispatch`.
2. Fuzz testing uses fast-check with 50,000 iterations for property-based testing.

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- Fuzz iteration count is calibrated to keep PR-blocking jobs under the 10-minute CI budget; weekly runs are unbounded.

**Priority:** P1

**Dependencies:** [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response), [REQ-SEC-009](security.md#req-sec-009-input-validation-at-system-boundaries), [REQ-SEC-010](security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-019: Security-posture scanning workflows

**Intent:** Independent security-posture assessment workflows must continuously evaluate the codebase against known-vulnerability patterns and supply-chain risk indicators, outside the per-PR quality gates.

**Applies To:** User

**Acceptance Criteria:**

1. A CodeQL static-analysis workflow runs on pushes to main, on PRs to main, and on a weekly schedule. Results are uploaded to GitHub Security.
2. An OSSF Scorecard workflow runs a security-posture assessment on push to main and on a weekly schedule.

**Notes:** Manual verification procedures are documented in the [deployment checklist](../../documentation/lanes/deployment.md#manual-verification-checklist).

**Constraints:**

- These workflows run independently of the per-PR quality gates in [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit); their cadence is push-to-main + weekly, not per-PR.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-020: Shadow-pin version bump automation

**Intent:** Pinned binary versions in Dockerfile and npm packages outside package.json are invisible to Dependabot. A weekly workflow checks upstream releases and opens one PR per tool when a newer version is available, with SHA256 intentionally invalidated to force manual checksum verification before merge.

**Applies To:** Operator

**Acceptance Criteria:**

1. Watched Dockerfile binaries: zoxide, yazi, lazygit, silverbullet. Each has its own parallel job checking GitHub releases. <!-- @impl: .github/workflows/bump-shadow-pins.yml::ver -->
2. The context-mode job atomically bumps its Claude-plugin and Pi-prewarm pins in one PR; build validation rejects drift. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-preseed -->
3. Dedicated jobs bump the remaining Pi preseed packages, bun, consult-llm-mcp, chrome-devtools-mcp, Browser Run MCP SDK, Impeccable bundles, and Graphify plugin version and description. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-preseed -->
4. SHA256 checksum is reset to a placeholder on Dockerfile bumps, causing Docker build failure until the operator verifies and updates the hash. <!-- @impl: .github/workflows/bump-shadow-pins.yml::lazygit -->
5. A bump branch is skipped if one already exists for that version (deduplication guard). <!-- @impl: .github/workflows/bump-shadow-pins.yml::branch -->
6. The context-mode and generic Pi-preseed jobs regenerate the Pi package lock without executing runtime-layout package lifecycle scripts, then regenerate the embedded seed from the updated manifest and lockfile. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-preseed --> <!-- @impl: scripts/regenerate-pi-preseed-lock.mjs::packageDirectory --> <!-- @test: host/__tests__/pi-preseed-lockfile-regeneration.test.js (creates the lockfile without executing package lifecycle scripts) -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** None.

**Verification:** Automated lifecycle-suppression coverage plus scheduled/manual workflow execution

**Status:** Implemented
