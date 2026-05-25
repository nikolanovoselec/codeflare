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
<!-- @test: host/__tests__/workflow-files.test.js (deploy workflow describe → trigger + pre-deploy job graph → AC1-AC5) -->

**Intent:** Production deployments are triggered automatically on every push to the `main` branch, with manual dispatch as fallback. The pre-deploy stage installs dependencies, builds, and runs tests before any artifact reaches Cloudflare.

**Applies To:** User

**Acceptance Criteria:**

1. The deploy workflow triggers automatically on successful PR-check completion against the main branch.
2. The deploy workflow also supports manual dispatch with environment selection (production or integration).
3. The deploy pipeline runs end-to-end: install dependencies, build, test, typecheck, build the container image, scan it, push it, deploy, and set secrets.
4. Dependencies are cached between runs for faster pipeline execution.
5. Frontend is built, and both backend and frontend tests and typechecks run before any deployment steps.
6. The KV namespace is resolved or created and applied to the deployment configuration.

**Constraints:**

- Two deployment environments are supported: production (auto on push to main) and integration (manual dispatch only).
- The CI runner label is configurable to support self-hosted runners.
- The deploy command, secret-setting, and post-deploy seed steps live in [REQ-OPS-013](#req-ops-013-deploy-command-and-post-deploy-hooks).

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-013: Deploy command and post-deploy hooks

<!-- @impl: .github/workflows/deploy.yml -->
<!-- @test: host/__tests__/workflow-files.test.js (deploy workflow describe → wrangler deploy + secrets + E2E seed → AC1-AC4) -->

**Intent:** After the pre-deploy pipeline succeeds, the workflow applies the worker name, runs `wrangler deploy`, sets worker secrets, and seeds the E2E service user in KV so the deployed worker is fully configured and reachable.

**Applies To:** User

**Acceptance Criteria:**

1. The worker name is configurable per environment.
2. The worker is deployed with runtime configuration variables applied.
3. Required worker secrets are written after deployment.
4. The E2E service user is seeded into the allowlist when the CF Access service-token secret is configured.

**Constraints:**

- Secrets are set after worker deployment, as secret writes target a worker that must already exist.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-002: Docker image build, vulnerability scan, and registry push

<!-- @impl: .github/workflows/deploy.yml -->
<!-- @impl: Dockerfile -->
<!-- @impl: .trivyignore -->
<!-- @test: host/__tests__/workflow-files.test.js (container image pipeline describe → build + trivy + push → AC1-AC5) -->

**Intent:** Every deploy builds a Docker image, scans it for HIGH/CRITICAL vulnerabilities with allowlisted exceptions, and pushes the resulting artifact to the Cloudflare container registry. The pipeline fails before push on any unexcepted finding.

**Applies To:** User

**Acceptance Criteria:**

1. The container image is built in the CI runner on every deploy.
2. The built image is scanned for HIGH and CRITICAL severity vulnerabilities.
3. Known vulnerability exceptions are tracked in a project-level allowlist.
4. If the scan finds unexcepted vulnerabilities, the pipeline fails before push.
5. The built image is pushed to the Cloudflare container registry; the resulting registry URI is captured for downstream binding.

**Constraints:**

- The container-binding and scaling steps consume the registry URI from this REQ; see [REQ-OPS-014](#req-ops-014-container-binding-and-scaling-from-image).

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-SEC-011](security.md#req-sec-011-container-image-scanned-for-cves-before-deploy)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-014: Container binding and scaling from image

<!-- @impl: .github/workflows/deploy.yml -->
<!-- @test: host/__tests__/workflow-files.test.js (container image pipeline describe → wrangler.toml patch + tier + max-instances + cache-buster → AC1-AC4) -->

**Intent:** After the image is pushed, the deploy workflow patches the registry URI into `wrangler.toml`, applies the resource tier and max-instance count, and offers cache-buster control over the AI agent layer. The bound Durable Object container is what user sessions land on.

**Applies To:** User

**Acceptance Criteria:**

1. The deployment configuration is updated with the registry URI of the most recently pushed image so the deploy does not rebuild the container.
2. Container resource sizing is applied per the configured tier (low, default/saas, or high).
3. All tiers default to 10 concurrent instances; the cap is overridable per deployment.
4. The AI agent layer can be cache-busted on demand via a build variable so a fresh layer is rolled out without a full image rebuild.

**Constraints:**

- The concurrent-instance cap is a positive integer and is passed safely (no shell interpolation).
- Resource tier is configured at deploy time, not at runtime.

**Priority:** P0

**Dependencies:** [REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-003: PR checks run lint, test, typecheck, and security audit

<!-- @impl: .github/workflows/test.yml -->
<!-- @test: host/__tests__/workflow-files.test.js (PR Checks workflow describe → lint + test + typecheck + audit + dependency-review jobs → AC1-AC7) -->

**Intent:** Every pull request to `main` must pass comprehensive quality checks before merge.

**Applies To:** User

**Acceptance Criteria:**

1. The PR-check workflow triggers on every pull request to the main branch and on manual dispatch.
2. The workflow runs lint on the codebase.
3. The workflow builds the frontend.
4. The workflow runs both backend and frontend test suites.
5. The workflow runs both backend and frontend typechecks.
6. The workflow runs a dead-code check on the codebase.
7. The workflow runs a high-severity security audit on production dependencies; PRs introducing dependencies with known vulnerabilities are blocked.

**Constraints:**

- Quality checks do not run in the 1-vCPU development container; they run on CI runners.
- The CI runner label is configurable across all workflows.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-019: Security-posture scanning workflows

<!-- @impl: .github/workflows/codeql.yml -->
<!-- @impl: .github/workflows/scorecard.yml -->
<!-- @test: host/__tests__/workflow-files.test.js (PR Checks workflow describe → codeql + scorecard jobs → AC1-AC2) -->

**Intent:** Independent security-posture assessment workflows must continuously evaluate the codebase against known-vulnerability patterns and supply-chain risk indicators, outside the per-PR quality gates.

**Applies To:** User

**Acceptance Criteria:**

1. A CodeQL static-analysis workflow runs on pushes to main, on PRs to main, and on a weekly schedule. Results are uploaded to GitHub Security.
2. An OSSF Scorecard workflow runs a security-posture assessment on push to main and on a weekly schedule.

**Constraints:**

- These workflows run independently of the per-PR quality gates in [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit); their cadence is push-to-main + weekly, not per-PR.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-020: Shadow-pin version bump automation

<!-- @impl: .github/workflows/bump-shadow-pins.yml -->
<!-- @test: host/__tests__/workflow-files.test.js (shadow-pin bump workflow describe -> AC1-AC4) -->

**Intent:** Pinned binary versions in Dockerfile and npm packages outside package.json are invisible to Dependabot. A weekly workflow checks upstream releases and opens one PR per tool when a newer version is available, with SHA256 intentionally invalidated to force manual checksum verification before merge.

**Applies To:** Operator

**Acceptance Criteria:**

1. Watched Dockerfile binaries: zoxide, yazi, lazygit, silverbullet. Each has its own parallel job checking GitHub releases.
2. Watched npm packages: context-mode (canonical version in plugin.json, echoed in entrypoint.sh fallback and hooks.json).
3. SHA256 checksum is reset to a placeholder on Dockerfile bumps, causing Docker build failure until the operator verifies and updates the hash.
4. A bump branch is skipped if one already exists for that version (deduplication guard).

**Constraints:** None.

**Priority:** P2

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

<!-- @test: host/__tests__/workflow-e2e.test.js (REQ-OPS-004 describe -> workflow_dispatch+job-graph+SERVICE_AUTH_SECRET+E2E_BASE_URL -> AC1..AC4) -->
### REQ-OPS-004: E2E test workflow setup and job graph

<!-- @impl: .github/workflows/e2e.yml -->

**Intent:** The e2e workflow runs end-to-end tests against a deployed environment. The setup stage primes the worker for service-token auth and the job graph sequences setup before the per-suite test jobs.

**Applies To:** User

**Acceptance Criteria:**

1. The E2E workflow runs on manual dispatch with an environment selector (integration or production).
2. Jobs run as a four-stage chain: setup, API tests, desktop UI tests, mobile UI tests.
3. The setup stage provisions the service-token secret on the target worker, seeds the E2E service user, and smoke-tests auth with a retry loop to absorb storage eventual-consistency lag.
4. The target URL is configurable per environment so the same workflow can run against integration or production.

**Constraints:**

- E2E tests authenticate via the service-token header rather than browser-based flows.
- Per-suite test execution + artifact handling live in [REQ-OPS-015](#req-ops-015-e2e-per-suite-execution-and-artifact-handling).

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-SEC-012](security.md#req-sec-012-container-auth-token-per-do-lifecycle)

**Verification:** [Integration test](../../host/__tests__/workflow-e2e.test.js)

**Status:** Implemented

---

<!-- @test: host/__tests__/workflow-e2e.test.js (REQ-OPS-015 describe -> per-suite npm scripts+E2E_MOBILE=1+failure-only artifact upload+5-day retention -> AC1..AC4) -->
### REQ-OPS-015: E2E per-suite execution and artifact handling

<!-- @impl: .github/workflows/e2e.yml -->
<!-- @test: host/__tests__/workflow-e2e.test.js + host/__tests__/workflow-files.test.js (REQ-OPS-015 E2E per-suite execution describes -> AC1/AC2/AC3/AC4 API + desktop UI + mobile UI jobs + artifact 5-day retention) -->

**Intent:** Each E2E suite (API, desktop UI, mobile UI) runs as its own job in the e2e workflow. Failed UI runs persist screenshots and HTML so the user can diagnose what the deployed worker actually rendered.

**Applies To:** User

**Acceptance Criteria:**

1. The API test suite runs as its own job.
2. The desktop UI test suite runs as its own job, in a Chromium browser.
3. The mobile UI test suite runs as its own job, in mobile emulation mode.
4. Failed UI test runs upload screenshots and HTML as artifacts with a five-day retention.

**Constraints:**

- UI tests require a Chromium browser and supporting system libraries in the runner environment.

**Priority:** P1

**Dependencies:** [REQ-OPS-004](#req-ops-004-e2e-test-workflow-setup-and-job-graph)

**Verification:** [Integration test](../../host/__tests__/workflow-e2e.test.js)

**Status:** Implemented

---

### REQ-OPS-005: Weekly pentest

<!-- @impl: .github/workflows/pentest.yml -->
<!-- @test: host/__tests__/workflow-files.test.js (pentest workflow describe → 6-probe job graph + cron + dispatch → AC1-AC3) -->

**Intent:** Automated external pentest probes run on a weekly schedule to detect regressions in production security posture.

**Applies To:** User

**Acceptance Criteria:**

1. The pentest workflow runs weekly and on manual dispatch against the configured target URL in the production environment.
2. The workflow runs six parallel probes using lightweight external tools (no active scanners) to minimize CI resource consumption.
3. Six probe types cover response headers, TLS posture, authentication gates, information disclosure, injection vectors, and HTTP method handling; per-probe checklists live in [documentation/lanes/pentest.md](../../documentation/lanes/pentest.md).

**Constraints:**

- The pentest requires a configured target URL set in the production deployment environment.
- The pentest uses only lightweight external tools (no heavy active scanners) so weekly runs do not consume excessive CI budget.

**Priority:** P1

**Dependencies:** [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response), [REQ-SEC-009](security.md#req-sec-009-input-validation-at-system-boundaries), [REQ-SEC-010](security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-018: Weekly fuzz testing

<!-- @impl: .github/workflows/fuzz.yml -->
<!-- @test: host/__tests__/workflow-files.test.js (fuzz workflow describe → fast-check 50000 iterations + cron + PR trigger → AC1-AC2) -->

**Intent:** Property-based fuzz testing runs on a weekly schedule and on every PR to `main` to identify edge-case bugs in input parsing and state transitions.

**Applies To:** User

**Acceptance Criteria:**

1. The fuzz workflow runs on PRs to `main`, weekly (Sunday 04:00 UTC), and on `workflow_dispatch`.
2. Fuzz testing uses fast-check with 50,000 iterations for property-based testing.

**Constraints:**

- Fuzz iteration count is calibrated to keep PR-blocking jobs under the 10-minute CI budget; weekly runs are unbounded.

**Priority:** P1

**Dependencies:** [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response), [REQ-SEC-009](security.md#req-sec-009-input-validation-at-system-boundaries), [REQ-SEC-010](security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

### REQ-OPS-006: Idle containers hibernate and cost zero

<!-- @impl: src/container/index.ts -->
<!-- @impl: src/container/container-metrics.ts -->
<!-- @test: src/__tests__/container-metrics.test.ts (idle timeout resolution AC8/AC9 describe -> AC1 configurable idle period) + src/__tests__/container/index.test.ts (onStop lifecycle + collectMetrics idle-stop describes -> AC2 hibernated zero-cost) -->

**Intent:** Containers that are not actively in use must hibernate and incur zero compute cost. The cost model anchors the entire pricing strategy, so the hibernation guarantee is operator-facing.

**Applies To:** Admin

**Acceptance Criteria:**

1. Containers hibernate after a configurable idle period of no user input (default 30 minutes, range 5 minutes to 2 hours).
2. Hibernated containers consume zero CPU, memory, and disk cost.
3. Active-container cost is approximately $11/user/month for a typical workload on the default tier.

**Constraints:**

- CPU is billed on active usage only. Memory and disk are billed on provisioned resources during active time.
- R2 storage is billed by GB-month, with a free tier covering small workspaces.
- Cost scales per active session, not per user.
- Idle-timeout persistence + lifecycle mechanics live in [REQ-OPS-016](#req-ops-016-sleepafter-preference-persistence-and-lifecycle).
- Idle-timeout fail-safe invariants live in [REQ-OPS-017](#req-ops-017-sleepafter-fail-safe-invariants).

**Priority:** P0

**Dependencies:** None.

**Verification:** Manual check

**Notes:** Hibernation cost guarantee is verified manually against billing-period invoices.

**Status:** Implemented

---

### REQ-OPS-016: sleepAfter preference persistence and lifecycle

<!-- @impl: src/container/index.ts -->
<!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014 AC4 describe -> AC1/AC2 sleepAfter persisted in KV across initial set and updates) + src/__tests__/routes/container-restart-prefs.test.ts (REQ-SESSION-008 AC3 describe -> AC3 stored preference loaded on startup) + src/__tests__/container/index.test.ts (destroy describe -> AC4 preference removed on session destruction) -->

**Intent:** The user-configurable idle-timeout preference must survive container-orchestration resets; on startup the stored preference is validated; on shutdown it is cleaned up.

**Applies To:** Admin

**Acceptance Criteria:**

1. The idle-timeout preference is persisted durably so it survives container-orchestration resets.
2. The preference is persisted on both initial bucket configuration and any subsequent updates.
3. On startup, the stored preference is loaded and validated.
4. On session destruction, the persisted preference is removed.

**Constraints:**

- Persisted preference values are schema-validated on load; invalid values are treated as missing and trigger the fail-safe fallback in [REQ-OPS-017](#req-ops-017-sleepafter-fail-safe-invariants).

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-hibernate-and-cost-zero)

**Verification:** [Automated test](../../src/__tests__/routes/session-sleep-timeout.test.ts)

**Notes:** Preference persistence and lifecycle are covered by `src/__tests__/container/index.test.ts` (DO setBucketName + constructor reload + destroy paths).

**Status:** Implemented

---

### REQ-OPS-017: sleepAfter fail-safe invariants

<!-- @impl: src/container/index.ts -->
<!-- @test: src/__tests__/container-metrics.test.ts (idle timeout resolution AC8/AC9 describe -> AC1/AC4 fail-safe to 2h on corruption + fail-loud-not-substitute) + src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014 AC4 describe -> AC2 preference change takes effect within one cycle) -->

**Intent:** Three invariants protect user work from a misconfigured or silently broken idle-detection layer: fail to the maximum (not minimum) on corruption, propagate preference changes within one cycle, and fail loudly rather than substituting a default. A container that dies before its configured timer destroys an hour of unpushed work and breaks the product's core promise.

**Applies To:** Admin

**Acceptance Criteria:**

1. The idle-detection layer fails safe in the direction of preserving user work, not minimizing compute. When the configured idle timeout cannot be resolved (storage corrupted, schema-validated value missing, parser fed garbage, code path skipped the user-pref resolution), the system falls back to the maximum supported value (2h) rather than the minimum.
2. A change to the persisted idle-timeout preference takes effect within one idle-check cycle, regardless of which code path wrote it.
3. In-memory copies of the preference do not outlive a single idle-check cycle.
4. Any code path that hands the resolved idle timeout to the container init must fail loudly when the value is missing, rather than substituting a fallback. The user's configured timer is never silently replaced by a shorter default.

**Constraints:**

- The fail-safe direction is chosen to preserve user work over billing efficiency.

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-hibernate-and-cost-zero), [REQ-OPS-016](#req-ops-016-sleepafter-preference-persistence-and-lifecycle)

**Verification:** [Automated test](../../src/__tests__/container-metrics.test.ts)

**Notes:** Fail-safe invariants are covered by `src/__tests__/container/container-metrics.test.ts` and `src/__tests__/container/index.test.ts`.

**Status:** Implemented

---

### REQ-OPS-007: Container specs configurable per environment

<!-- @impl: .github/workflows/deploy.yml -->
<!-- @impl: wrangler.toml -->
<!-- @test: host/__tests__/workflow-files.test.js (deploy workflow describe → RESSOURCE_TIER + MAX_INSTANCES + MAX_SESSIONS_USER/ADMIN patching → AC1-AC5) -->

**Intent:** Container resource allocation (CPU, memory, disk) must be configurable per deployment environment to balance cost and performance.

**Applies To:** Admin

**Acceptance Criteria:**

1. Container resource tier is configurable per deployment and accepts four values: low (0.25 vCPU / 1 GiB / 4 GB), default (1 vCPU / 3 GiB / 6 GB), saas (1 vCPU / 3 GiB / 6 GB), high (2 vCPU / 6 GiB / 8 GB).
2. All tiers default to 10 concurrent instances.
3. The concurrent-instance cap is overridable per deployment and must be a positive integer.
4. Per-user concurrent session limits are configurable per deployment, with separate defaults for regular users (3) and admins (10).
5. Tier and instance configuration is applied at deploy time, not at runtime.

**Constraints:**

- The default resource tier is used when none is explicitly configured.
- The concurrent-instance cap is passed safely (no shell interpolation).
- Session limits omitted from the deploy fall back to backend defaults.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

<!-- @test: host/__tests__/workflow-stress-test.test.js (REQ-OPS-008 describe -> workflow_dispatch+k6 suites+STRESS_TEST_CONCURRENCY default 0 -> AC1,AC2,AC3 workflow YAML shape) -->
<!-- @test: src/__tests__/middleware/rate-limit.test.ts (stress test mode bypass describe -> bypasses rate limit + does NOT access KV + still enforces when unset -> AC4 behavioural bypass) -->
<!-- @test: src/__tests__/middleware/rate-limit.test.ts (REQ-OPS-008 AC5 one-time warning per isolate describe -> logs exactly one warning across many bypassed requests + no warning when STRESS_TEST_MODE unset -> AC5 vi.resetModules + logger spy proves single warn) -->
<!-- @test: src/__tests__/index.test.ts (REQ-OPS-008 AC6 SAAS_MODE+STRESS_TEST_MODE conflict guard describe -> 503 + misconfiguration message + only-one-active passes through + string==active only -> AC6 worker.fetch integration) -->
### REQ-OPS-008: Stress testing validates rate limits and concurrency

<!-- @impl: .github/workflows/stress-test.yml -->
<!-- @impl: src/middleware/rate-limit.ts -->
<!-- @impl: src/index.ts -->
<!-- @impl: src/lib/rate-limit-core.ts -->
<!-- @test: host/__tests__/workflow-stress-test.test.js (workflow shape + manual dispatch describe -> AC1-AC3) + src/__tests__/index.test.ts (REQ-OPS-008 AC6 SAAS+STRESS conflict guard describe -> AC6) + src/__tests__/middleware/rate-limit.test.ts (stress test mode bypass + REQ-OPS-008 AC5 one-time warning describes -> AC4/AC5) -->

**Intent:** Load testing validates that rate limiting, session lifecycle, storage operations, and WebSocket concurrency behave correctly under high load.

**Applies To:** User

**Acceptance Criteria:**

1. The stress-test workflow runs on manual dispatch against the integration environment.
2. Load tests cover API throughput, session lifecycle, storage operations, and WebSocket concurrency.
3. Concurrency is configurable per run; disabled by default, latency thresholds loosen when enabled.
4. In stress-test deployment mode, all HTTP and WebSocket rate limits are bypassed to allow high virtual-user counts through a single service-token identity.
5. A one-time warning is logged per worker instance when the rate-limit bypass activates.
6. Stress-test mode must not be active alongside SaaS mode; the combination returns 503 to all requests.

**Constraints:**

- Stress testing targets integration environments only.
- The rate-limit bypass incurs zero additional storage overhead.

**Priority:** P2

**Dependencies:** [REQ-SEC-007](security.md#req-sec-007-rate-limiting-infrastructure), [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** [Integration test](../../host/__tests__/workflow-stress-test.test.js)

**Status:** Implemented

---

### REQ-OPS-009: Supply chain security monitoring

<!-- @impl: .github/workflows/scorecard.yml -->
<!-- @impl: .github/workflows/test.yml -->
<!-- @test: host/__tests__/workflow-files.test.js (PR Checks workflow describe → scorecard cron + npm audit + dependency-review jobs → AC1-AC6) -->

**Intent:** The project's open-source supply chain security posture must be continuously monitored and reported.

**Applies To:** User

**Acceptance Criteria:**

1. The OSSF Scorecard workflow runs on push to main and weekly.
2. Scorecard results are uploaded to GitHub Security.
3. Repository-level secret scanning with push protection is enabled.
4. Dependabot security updates are enabled at the repository level.

**Constraints:**

- Supply chain monitoring is continuous (push-triggered + weekly), not on-demand.
- Secret-scanning push protection prevents secrets from being committed.
- High-severity dependency audits and dependency-review enforcement are owned by [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit); not duplicated here.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** [Automated test](../../host/__tests__/workflow-files.test.js)

**Status:** Implemented

---

<!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 describe -> STOPSIGNAL SIGINT + trap shutdown_handler + pidfile kill + final bisync flags + bisync-initialized flag + TERMINAL_PID kill -> AC1..AC6 shell shape) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (entrypoint.sh bisync daemon behavior (real) describe -> daemon-side cadence + SIGUSR1 + recovery + --resync fallback -> AC4 daemon runtime) -->
<!-- @test: src/__tests__/container/index.test.ts (destroy describe -> SIGTERM + poll ctx.container.running + super.destroy fallback -> AC2/AC6 DO-side wiring) -->
### REQ-OPS-010: Graceful container shutdown preserves data

<!-- @impl: Dockerfile -->
<!-- @impl: entrypoint.sh::shutdown_handler -->
<!-- @impl: entrypoint.sh::bisync_with_r2 -->

**Intent:** Container shutdown must complete a final sync to R2 before termination to prevent data loss.

**Applies To:** User

**Acceptance Criteria:**

1. The container image declares a graceful-stop signal that the entrypoint trap can catch.
2. The container entrypoint's trap handler catches the graceful-stop signal.
3. The trap handler terminates the background sync daemon using a durable PID record as the sole mechanism.
4. A final bidirectional sync to R2 runs before exit, with deletion safeguards to prevent accidental mass deletion.
5. The shutdown sync runs even when the initial sync timed out.
6. The terminal server is terminated after the final sync completes.

**Constraints:**

- The sync daemon's PID record is the sole mechanism for shutdown; no in-memory fallback exists.
- The shutdown sync is bounded so a deletion storm cannot wipe R2.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Integration test](../../host/__tests__/entrypoint-shutdown.test.js)

**Status:** Implemented

---

<!-- @test: host/__tests__/dockerfile-base-image.test.js (REQ-OPS-011 describe -> FROM bookworm-slim+npm global installs+system packages+fd-find symlink -> AC1..AC3) -->
### REQ-OPS-011: Container base image is Debian bookworm-slim

<!-- @impl: Dockerfile -->

**Intent:** Reliable CLI agent execution requires a glibc-based Linux distribution (Alpine/musl caused crashes for some agents).

**Applies To:** Admin

**Acceptance Criteria:**

1. The container base image is a glibc-based Node.js 24 distribution (Debian bookworm-slim).
2. All supported agent CLIs (Claude Code, Codex, Gemini CLI, Copilot, OpenCode) start without crashes.
3. Essential developer tools for terminal-based workflows are pre-installed.

**Constraints:** None.

**Priority:** P1

**Dependencies:** None.

**Verification:** [Integration test](../../host/__tests__/dockerfile-base-image.test.js)

**Status:** Implemented

---

<!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (REQ-OPS-012 describe -> MAX_INSTANCES_OVERRIDE+tier-independence+positive-integer regex+wrangler.toml patching -> AC1..AC4) -->
### REQ-OPS-012: Per-environment container concurrency limit

<!-- @impl: .github/workflows/deploy.yml -->
<!-- @impl: wrangler.toml -->
<!-- @test: host/__tests__/workflow-deploy-max-instances.test.js + host/__tests__/workflow-files.test.js (Per-environment container concurrency describe -> AC1/AC2/AC3/AC4 operator override + tier independence + positive integer + deploy-time apply) -->

**Intent:** Operators can control how many containers run concurrently per environment independently of resource tier.

**Applies To:** Admin

**Acceptance Criteria:**

1. Operators can override the default concurrent-instance cap per deployment.
2. The override is independent of resource tier.
3. The override must be a positive integer.
4. The override is applied at deploy time as part of the deployment configuration.

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** [Integration test](../../host/__tests__/workflow-deploy-max-instances.test.js)

**Status:** Implemented
