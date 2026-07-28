# Operations

CI/CD pipeline, testing strategy, deployment workflow, container sizing, and cost model.

**Domain owner:** GitHub Actions workflows, deploy.yml, container-image.yml, test.yml, pentest.yml, fuzz.yml, stress-test.yml

### Key Concepts

- **Deploy Pipeline** -- The `deploy.yml` workflow, gated on a green PR Checks run for the same SHA (workflow_run): prepare resolves the target, worker assets build in parallel with the container image (built, scanned, and pushed by the reusable `container-image.yml`, which reuses the existing image when its inputs are unchanged), then the deploy job applies config, runs `wrangler deploy`, and sets secrets in bulk. The single path from code to production.
- **CI/CD** -- Continuous integration via `test.yml` (PR checks), `codeql.yml` (static analysis), `scorecard.yml` (supply chain), and `fuzz.yml` (property-based testing). Continuous deployment via `deploy.yml`.
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

**Intent:** Production deployments are triggered automatically on every push to the `main` branch, with manual dispatch as fallback. Deploys are gated on a green PR Checks run for the exact SHA; the pipeline itself runs as staged jobs and does not re-run the test suite.

**Applies To:** User

**Acceptance Criteria:**

1. The deploy workflow triggers automatically on successful PR-check completion against the main branch. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual -->
2. The deploy workflow also supports manual dispatch to production, integration, enterprise, or enterprise integration. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual -->
3. The deploy pipeline stages target preparation, parallel worker-asset and container-image builds, and deployment. <!-- @impl: .github/workflows/deploy.yml::prepare --> <!-- @impl: .github/workflows/deploy.yml::build-worker --> <!-- @impl: .github/workflows/deploy.yml::container --> <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (manual deploys cannot skip tests) -->
4. Complete-image verification and deployment reuse compatible cached dependency and image-build work across runs. <!-- @impl: .github/workflows/test.yml::browser-ide-image --> <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-003 AC7: requires non-publishing complete-image smoke in the required status) -->
5. Frontend and landing assets are built once and handed to the deploy job as an artifact. <!-- @impl: .github/workflows/deploy.yml::build-worker --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (manual deploys cannot skip tests) -->
6. The KV namespace is resolved or created and applied to the deployment configuration. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) --> <!-- @manual -->
7. Manual deployment runs checks inline unless an explicitly selected successful PR Checks run has the same head and tested tree. <!-- @impl: .github/workflows/deploy.yml::verify-existing --> <!-- @impl: .github/workflows/deploy.yml::verify --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (manual deploys cannot skip tests) --> <!-- @test: host/__tests__/validate-pr-checks-run.test.js (exact-head PR Checks run validation) -->

**Constraints:**

- Automatic production deployment follows a successful main-branch PR check; manual dispatch supports production, integration, enterprise, and enterprise integration. A supplied verification run id fails closed if its repository, workflow, head, required summary, receipt identity, or tested tree differs.
- The CI runner label is configurable to support self-hosted runners.
- Concurrent dispatches are kept legible and independent by [REQ-OPS-026](#req-ops-026-concurrent-deploy-dispatches-are-legible-and-independently-verified).
- The deploy command, secret-setting, and post-deploy seed steps live in [REQ-OPS-013](#req-ops-013-deploy-command-and-post-deploy-hooks).
- Successful-path gating and no-op outcome failure live in [REQ-OPS-028](#req-ops-028-deploy-verification-and-outcome-gate).

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([deploy-requires-tests](../../host/__tests__/deploy-requires-tests.test.js))

**Status:** Implemented

---

### REQ-OPS-002: Docker image build, vulnerability scan, and registry push

**Intent:** Every deploy resolves a container image whose build inputs are content-hashed into its tag. Changed inputs trigger a build, a HIGH/CRITICAL vulnerability scan with allowlisted exceptions, and a push to the target registry; unchanged inputs reuse the already-scanned image. The pipeline fails before push on any unexcepted finding.

**Applies To:** User

**Acceptance Criteria:**

1. The container image is built in the CI runner whenever its inputs (Dockerfile COPY sources, weekly salt, cache-bust) produce a tag not yet present in the target registry; otherwise the existing image is reused without rebuild or rescan. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual -->
2. The built image is scanned for HIGH and CRITICAL severity vulnerabilities. <!-- @impl: .github/workflows/container-image.yml::severity = HIGH,CRITICAL --> <!-- @manual -->
3. Known vulnerability exceptions are tracked in a project-level allowlist. <!-- @manual -->
4. If the scan finds unexcepted vulnerabilities, the pipeline fails before push. <!-- @manual -->
5. The image is pushed to the selected registry (Cloudflare managed registry by default; Docker Hub as dispatch-selectable bypass); the content-address image tag is captured for downstream binding. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual -->

**Constraints:**

- The container-binding and scaling steps rebuild the registry URI from the image tag this REQ produces — the URI itself is never a workflow output, since it would embed a masked secret and be silently dropped; see [REQ-OPS-014](#req-ops-014-container-binding-and-scaling-from-image).
- The input hash covers every Dockerfile COPY source; a coverage guard disables reuse (forcing a fresh build) if a COPY source falls outside the hashed path set.
- The weekly hash salt bounds reuse: an unchanged image is rebuilt and rescanned at least once per ISO week.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-SEC-011](security.md#req-sec-011-container-image-scanned-for-cves-before-deploy)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-003: PR checks run lint, test, typecheck, and security audit

**Intent:** Every pull request to `main` must pass comprehensive quality checks before merge.

**Applies To:** User

**Acceptance Criteria:**

1. The PR-check workflow triggers on every pull request to the main or develop branch, on push to the main branch, on manual dispatch, and on a nightly schedule. <!-- @manual -->
2. The workflow runs lint and a dead-code check on the codebase. <!-- @manual -->
3. Every vitest suite runs through one composite action as parallel sharded jobs: four Workers-pool shards, an unsharded Node-runtime leg, three frontend shards, and landing; host tests run alongside. <!-- @impl: .github/actions/vitest-suite/action.yml::runs --> <!-- @manual -->
4. The workflow runs both backend and frontend typechecks. <!-- @manual -->
5. The workflow runs a high-severity security audit on production dependencies; PRs introducing dependencies with known vulnerabilities are blocked. <!-- @manual -->
6. A Browser IDE extension change cannot pass the required PR status unless its owned validation suite succeeds. <!-- @impl: .github/workflows/test.yml::browser-ide --> <!-- @impl: scripts/ci/suites.mjs::SUITES --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-003 AC6: Browser IDE extension suite ownership) -->
7. A Browser IDE image change cannot pass the required PR status unless a non-publishing complete-image smoke succeeds. <!-- @impl: .github/workflows/test.yml::browser-ide-image --> <!-- @test: host/__tests__/required-check-covers-every-lane.test.js (required status context covers every lane (test.yml summary job)) --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-003 AC7: requires non-publishing complete-image smoke in the required status) -->

**Constraints:**

- Quality checks do not run in the 1-vCPU development container; they run on CI runners.
- The CI runner label is configurable across all workflows.
- Lanes run in parallel, each gated by a path filter over the diff (all lanes run on manual dispatch); the `summary` job publishes the required `test` status context and fails on any failed or cancelled lane while passing skipped (unaffected) lanes.
- All lanes also run unconditionally on the nightly schedule, bypassing the path filter.
- The Workers pool runs several workers per shard; its teardown crash is a teardown bug, not a concurrency one, so the report and reconciliation gates in [REQ-OPS-023](#req-ops-023-suite-results-are-gated-on-machine-readable-reports) — not serialization — are what keep the result trustworthy.
- Coverage-threshold evidence is gated separately in [REQ-OPS-022](#req-ops-022-coverage-threshold-gate-fails-closed-on-missing-evidence); backend and frontend coverage run only when their path filter is affected or the workflow is a full run.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([required-check-covers-every-lane](../../host/__tests__/required-check-covers-every-lane.test.js)); workflow-trigger, lint, typecheck, and audit ACs verified manually

**Status:** Implemented

---

### REQ-OPS-005: Weekly pentest

**Intent:** Automated external pentest probes run on a weekly schedule to detect regressions in production security posture.

**Applies To:** User

**Acceptance Criteria:**

1. The pentest workflow runs weekly and on manual dispatch against the configured target URL in the production environment. <!-- @impl: .github/workflows/pentest.yml::tls --> <!-- @manual -->
2. The workflow runs six parallel probes using lightweight external tools (no active scanners) to minimize CI resource consumption. <!-- @manual -->
3. Six probe types cover response headers, TLS posture, authentication gates, information disclosure, injection vectors, and HTTP method handling; per-probe checklists live in [documentation/lanes/pentest.md](../../documentation/lanes/pentest.md#test-results). <!-- @manual -->
4. A legacy-TLS verdict is derived from the server's own answer to a handshake the probe issues itself. <!-- @impl: scripts/ci/tls-legacy-probe.py::probe --> <!-- @test: host/__tests__/tls-legacy-probe.test.js (passes when the server refuses the version with an alert) --> <!-- @test: host/__tests__/tls-legacy-probe.test.js (fails when the server accepts the version and returns a ServerHello) -->
5. An answer that does not establish whether the version is supported reports inconclusive rather than a pass. <!-- @impl: scripts/ci/tls-legacy-probe.py::probe --> <!-- @test: host/__tests__/tls-legacy-probe.test.js (is inconclusive, never a pass, on an alert that is not about the version) --> <!-- @test: host/__tests__/tls-legacy-probe.test.js (is inconclusive, never a pass, when nothing is listening) -->

**Constraints:**

- The pentest requires a configured target URL set in the production deployment environment.
- The pentest uses only lightweight external tools (no heavy active scanners) so weekly runs do not consume excessive CI budget.

**Priority:** P1

**Dependencies:** [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response), [REQ-SEC-009](security.md#req-sec-009-input-validation-at-system-boundaries), [REQ-SEC-010](security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints)

**Verification:** Automated test ([host/__tests__/tls-legacy-probe.test.js](../../host/__tests__/tls-legacy-probe.test.js))

**Status:** Implemented

---

### REQ-OPS-006: Idle containers hibernate and cost zero

**Intent:** Containers that are not actively in use must hibernate and incur zero compute cost. The cost model anchors the entire pricing strategy, so the hibernation guarantee is operator-facing.

**Applies To:** Admin

**Acceptance Criteria:**

1. Containers hibernate after a configurable idle period of no user input (default 30 minutes, settable range 15 minutes to 4 hours; a legacy `5m` value is still accepted for a pre-existing stored preference but is no longer offered in the picker). <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs --> <!-- @test: src/__tests__/container-metrics.test.ts (idle timeout resolution (REQ-OPS-006 AC1) / REQ-OPS-017 (sleepAfter fail-safe invariants)) -->
2. Hibernated containers consume zero CPU, memory, and disk cost. <!-- @impl: src/container/index.ts::collectMetrics --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
3. Active-container cost is approximately $11/user/month for a typical workload on the default tier. <!-- @manual -->

**Constraints:**

- CPU is billed on active usage only; Memory and disk are billed on provisioned resources during active time.
- R2 storage is billed by GB-month, with a free tier covering small workspaces.
- Cost scales per active session, not per user.
- Idle-timeout persistence + lifecycle mechanics live in [REQ-OPS-016](#req-ops-016-sleepafter-preference-persistence-and-lifecycle).
- Idle-timeout fail-safe invariants live in [REQ-OPS-017](#req-ops-017-sleepafter-fail-safe-invariants).

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-OPS-007: Container specs configurable per environment

**Intent:** Container resource allocation (CPU, memory, disk) must be configurable per deployment environment to balance cost and performance.

**Applies To:** Admin

**Acceptance Criteria:**

1. Container resource tier accepts four per-deployment values: low (0.25 vCPU / 1 GiB / 4 GB), default (1 vCPU / 3 GiB / 6 GB), saas (1 vCPU / 3 GiB / 6 GB), high (2 vCPU / 6 GiB / 12 GB). <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual -->
2. All tiers default to 10 concurrent instances. <!-- @manual -->
3. The concurrent-instance cap is overridable per deployment and must be a positive integer. <!-- @manual -->
4. Per-user concurrent session limits are configurable per deployment, with separate defaults for regular users (3) and admins (10). <!-- @impl: src/lib/constants.ts::getMaxSessions --> <!-- @manual -->
5. Tier and instance configuration is applied at deploy time, not at runtime. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (REQ-OPS-012: Per-environment container concurrency limit) -->

**Constraints:**

- The default resource tier is used when none is explicitly configured.
- The concurrent-instance cap is passed safely (no shell interpolation).
- Session limits omitted from the deploy fall back to backend defaults.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated test ([workflow-deploy-max-instances](../../host/__tests__/workflow-deploy-max-instances.test.js))

**Status:** Implemented

---

### REQ-OPS-008: Stress testing validates rate limits and concurrency

**Intent:** Load testing validates that rate limiting, session lifecycle, storage operations, and API throughput behave correctly under high load.

**Applies To:** User

**Acceptance Criteria:**

1. The stress-test workflow runs on manual dispatch against the integration environment. <!-- @test: host/__tests__/workflow-stress-test.test.js (REQ-OPS-008 AC1: stress-test workflow triggers on workflow_dispatch targeting the integration environment) --> <!-- @manual -->
2. Load tests cover API throughput, rate-limit validation, session lifecycle, and storage operations. <!-- @test: host/__tests__/workflow-stress-test.test.js (REQ-OPS-008 AC2: k6 stress tests cover API throughput, session lifecycle, storage operations, and rate-limit validation) --> <!-- @manual -->
3. Concurrency is configurable per run; disabled by default, latency thresholds loosen when enabled. <!-- @test: host/__tests__/workflow-stress-test.test.js (REQ-OPS-008: Stress testing validates rate limits and concurrency) --> <!-- @manual -->
4. In stress-test deployment mode, all HTTP and WebSocket rate limits are bypassed to allow high virtual-user counts through a single service-token identity. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (createRateLimiter / REQ-SEC-007 AC1 (factory keyed by bucketName with CF-Connecting-IP fallback) / REQ-SEC-007 AC2 (KV primary + in-memory fallback with TTL) / REQ-SEC-007 AC3 (429 with RATE_LIMIT_ERROR) / REQ-SEC-007 AC4 (X-RateLimit headers) / REQ-SEC-019 AC5 (STRESS_TEST_MODE bypass)) -->
5. A one-time warning is logged per worker instance when the rate-limit bypass activates. <!-- @impl: src/middleware/rate-limit.ts::createRateLimiter --> <!-- @test: src/__tests__/middleware/rate-limit.test.ts (REQ-OPS-008 AC5: one-time warning per isolate) -->
6. Stress-test mode must not be active alongside SaaS mode; the combination returns 503 to all requests. <!-- @test: src/__tests__/index.test.ts (Edge-level setup redirect) --> <!-- @manual -->

**Constraints:**

- Stress testing targets integration environments only.
- The rate-limit bypass incurs zero additional storage overhead.

**Priority:** P2

**Dependencies:** [REQ-SEC-007](security.md#req-sec-007-rate-limiting-infrastructure), [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated test ([rate-limit](../../src/__tests__/middleware/rate-limit.test.ts))

**Status:** Implemented

---

### REQ-OPS-009: Supply chain security monitoring

**Intent:** The project's open-source supply chain security posture must be continuously monitored and reported.

**Applies To:** User

**Acceptance Criteria:**

1. The OSSF Scorecard workflow runs on push to main and weekly. <!-- @manual -->
2. Scorecard results are uploaded to GitHub Security. <!-- @manual -->
3. Repository-level secret scanning with push protection is enabled. This is a repository-level GitHub setting verified out of band, not from source. <!-- @manual -->
4. Dependabot security updates are enabled at the repository level. This is a repository-level GitHub setting verified out of band, not from source. <!-- @manual -->

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

1. The container image declares a graceful-stop signal that the entrypoint trap can catch. <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC1: the container image declares STOPSIGNAL SIGINT) --> <!-- @manual -->
2. The container entrypoint's trap handler catches the graceful-stop signal. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC2: the container entrypoint trap handler catches SIGINT/SIGTERM signals) -->
3. The trap handler terminates the background sync daemon using a durable PID record as the sole mechanism. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC3: trap handler kills the sync daemon via PID file at /tmp/sync-daemon.pid) -->
4. A final bidirectional sync to R2 runs before exit, with deletion safeguards to prevent accidental mass deletion. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC4: final rclone bisync with --ignore-checksum --max-delete 100 runs to R2 before exit) -->
5. The shutdown sync runs even when the initial sync timed out. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC5: bisync-initialized flag is touched on the timeout path to ensure final bisync runs) -->
6. The terminal server is terminated after the final sync completes. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC6: terminal server is killed after the final sync completes) -->

**Constraints:**

- The sync daemon's PID record is the sole mechanism for shutdown; no in-memory fallback exists.
- The shutdown sync is bounded so a deletion storm cannot wipe R2.
- Shutdown kills the background init subshell before the pidfile sweep, then waits (capped, with the watchdog shortened to match) for the daemon's rclone to exit before the final sync, so the stale-lock guard never races a live process. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC5: the final sync waits for the daemon rclone to exit before it starts) -->

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated test ([entrypoint-shutdown](../../host/__tests__/entrypoint-shutdown.test.js))

**Status:** Implemented

---

### REQ-OPS-011: Container base image is Debian bookworm-slim

**Intent:** Reliable CLI agent execution requires a glibc-based Linux distribution (Alpine/musl caused crashes for some agents).

**Applies To:** Admin

**Acceptance Criteria:**

1. The container base image is a glibc-based Node.js 24 distribution (Debian bookworm-slim). <!-- @test: host/__tests__/dockerfile-base-image.test.js (REQ-OPS-011: Container base image is Debian bookworm-slim) --> <!-- @manual -->
2. All supported agent CLIs (Claude Code, Codex, Antigravity, Copilot, OpenCode) start without crashes. <!-- @test: host/__tests__/dockerfile-base-image.test.js (REQ-OPS-011 AC2 (precondition): agent CLI packages are present in the image for Claude Code, Codex, Antigravity, Copilot, OpenCode) --> <!-- @manual -->
3. Essential developer tools for terminal-based workflows are pre-installed. <!-- @test: host/__tests__/dockerfile-base-image.test.js (REQ-OPS-011 AC3: system packages include essential tools: git, ripgrep, neovim, tmux, fzf, jq, python) --> <!-- @manual -->

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

1. Operators can override the default concurrent-instance cap per deployment. <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (REQ-OPS-012: Per-environment container concurrency limit) --> <!-- @manual -->
2. The override is independent of resource tier. <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (REQ-OPS-012: Per-environment container concurrency limit) --> <!-- @manual -->
3. The override must be a positive integer. <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (REQ-OPS-012 AC3: MAX_INSTANCES must be a positive integer (enforced with regex validation)) --> <!-- @manual -->
4. The override is applied at deploy time as part of the deployment configuration. <!-- @test: host/__tests__/workflow-deploy-max-instances.test.js (REQ-OPS-012 AC4: MAX_INSTANCES is applied during deploy via wrangler.toml patching) --> <!-- @manual -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-013: Deploy command and post-deploy hooks

**Intent:** After the staged pipeline succeeds, the deploy job applies the worker name, runs `wrangler deploy`, sets worker secrets in one bulk call, and seeds the service user (stress-test identity) in KV so the deployed worker is fully configured and reachable.

**Applies To:** User

**Acceptance Criteria:**

1. The worker name is configurable per environment. <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (Setup Store) --> <!-- @manual -->
2. The worker is deployed with runtime configuration variables applied. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) --> <!-- @manual -->
3. Required worker secrets are written after deployment. <!-- @test: src/__tests__/setup-ac-coverage.test.ts (Setup AC Coverage) --> <!-- @manual -->
4. The service user (stress-test identity) is seeded into the allowlist when the CF Access service-token secret is configured. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-001 (two authentication modes) / REQ-AUTH-007 (JIT user provisioning in SaaS) / REQ-AUTH-012 (welcome email on provisioning)) -->

**Constraints:**

- Secrets are set after worker deployment, as secret writes target a worker that must already exist.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated test ([access](../../src/__tests__/lib/access.test.ts))

**Status:** Implemented

---

### REQ-OPS-014: Container binding and scaling from image

**Intent:** After the image is pushed, deployment binds it to the configured resource tier and instance limit, with cache-buster control over the agent layer; user sessions land on that bound container.

**Applies To:** User

**Acceptance Criteria:**

1. The deployment configuration is updated with the registry URI of the most recently pushed image so the deploy does not rebuild the container. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual -->
2. Container resource sizing is applied per the configured tier (low, default/saas, or high). <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual -->
3. All tiers default to 10 concurrent instances; the cap is overridable per deployment. <!-- @manual -->
4. The AI agent layer can be cache-busted on demand via a build variable so a fresh layer is rolled out without a full image rebuild. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Constraints:**

- The concurrent-instance cap is a positive integer and is passed safely (no shell interpolation).
- Resource tier is configured at deploy time, not at runtime.

**Priority:** P0

**Dependencies:** [REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push)

**Verification:** Automated test ([index](../../src/__tests__/container/index.test.ts))

**Status:** Implemented

---

### REQ-OPS-016: sleepAfter preference persistence and lifecycle

**Intent:** The user-configurable idle-timeout preference must survive container-orchestration resets; on startup the stored preference is validated; on shutdown it is cleaned up.

**Applies To:** Admin

**Acceptance Criteria:**

1. The idle-timeout preference is persisted durably so it survives container-orchestration resets. <!-- @impl: src/container/container-router.ts::dispatchInternalRoute --> <!-- @test: src/__tests__/container/lifecycle.test.ts (persists to DO storage on initial setBucketName) --> <!-- @test: src/__tests__/container/lifecycle.test.ts (loads from DO storage on construction (storage key: sleepAfter)) -->
2. The preference is persisted on both initial bucket configuration and any subsequent updates. <!-- @impl: src/container/container-router.ts::dispatchInternalRoute --> <!-- @test: src/__tests__/container/lifecycle.test.ts (persists to DO storage on initial setBucketName) --> <!-- @test: src/__tests__/container/lifecycle.test.ts (persists to DO storage on restart (409 path)) -->
3. On startup, the stored preference is loaded and validated. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/lifecycle.test.ts (loads from DO storage on construction (storage key: sleepAfter)) --> <!-- @test: src/__tests__/container/lifecycle.test.ts (rejects invalid values from storage and falls back to fail-safe 4h default) -->
4. On session destruction, the persisted preference is removed. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/lifecycle.test.ts (is cleaned up on destroy (storage key: sleepAfter)) -->

**Constraints:**

- Persisted preference values are schema-validated on load; invalid values are treated as missing and trigger the fail-safe fallback in [REQ-OPS-017](#req-ops-017-sleepafter-fail-safe-invariants).

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-hibernate-and-cost-zero)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-OPS-017: sleepAfter fail-safe invariants

**Intent:** Three invariants protect user work from a misconfigured or silently broken idle-detection layer: fail to the maximum (not minimum) on corruption, propagate preference changes within one cycle, and fail loudly rather than substituting a default. A container that dies before its configured timer destroys an hour of unpushed work and breaks the product's core promise.

**Applies To:** Admin

**Acceptance Criteria:**

1. The idle-detection layer fails safe toward preserving user work, not saving compute: when the configured idle timeout cannot be resolved (corrupt storage, a missing/garbage value, or a skipped pref-resolution path), it falls back to the maximum supported value (4h), never the minimum. <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs --> <!-- @impl: src/container/container-metrics.ts::SLEEP_AFTER_FALLBACK_MS = 14_400_000 --> <!-- @test: src/__tests__/lib/sleep-timer-defaults.test.ts (parseSleepAfterMs - fail-safe direction) -->
2. A change to the persisted idle-timeout preference takes effect within one idle-check cycle, regardless of which code path wrote it. <!-- @impl: src/container/index.ts::collectMetrics --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014: User-configurable auto-sleep timeout in Settings) -->
3. In-memory copies of the preference do not outlive a single idle-check cycle. <!-- @impl: src/container/index.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (refreshes idleTimeoutPref from storage on every tick) -->
4. On any missing or corrupt idle-timeout value, resolution substitutes the maximum supported value (4h) and logs the fallback, never a shorter default — so a resolution failure can only lengthen, never shorten, the user's effective timeout. <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs --> <!-- @test: src/__tests__/lib/sleep-timer-defaults.test.ts (parseSleepAfterMs - fail-safe direction) -->

**Constraints:**

- The fail-safe direction is chosen to preserve user work over billing efficiency.

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-hibernate-and-cost-zero), [REQ-OPS-016](#req-ops-016-sleepafter-preference-persistence-and-lifecycle)

**Verification:** Automated test ([container-metrics](../../src/__tests__/container-metrics.test.ts))

**Status:** Implemented

---

### REQ-OPS-018: Weekly fuzz testing

**Intent:** Property-based fuzz testing runs on a weekly schedule and on every PR to `main` to identify edge-case bugs in input parsing and state transitions.

**Applies To:** User

**Acceptance Criteria:**

1. The fuzz workflow runs on PRs to `main`, weekly (Sunday 04:00 UTC), and on `workflow_dispatch`. <!-- @manual -->
2. Fuzz testing uses fast-check with 50,000 iterations for property-based testing. <!-- @manual -->

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

1. A CodeQL static-analysis workflow runs on pushes to main, on PRs to main, and on a weekly schedule. Results are uploaded to GitHub Security. <!-- @manual -->
2. An OSSF Scorecard workflow runs a security-posture assessment on push to main and on a weekly schedule. <!-- @manual -->

**Constraints:**

- These workflows run independently of the per-PR quality gates in [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit); their cadence is push-to-main + weekly, not per-PR.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-020: Shadow-pin version bump automation

**Intent:** Every release pin outside a package manifest has one explicit weekly update owner and a fail-closed verification path.

**Applies To:** Operator

**Acceptance Criteria:**

1. Zoxide, yazi, lazygit, and SilverBullet each have a parallel release-check job. <!-- @impl: .github/workflows/bump-shadow-pins.yml::zoxide --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::yazi --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::lazygit --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::silverbullet --> <!-- @manual -->
2. Actionlint and Antigravity each have a dedicated release-check job. <!-- @impl: .github/workflows/bump-shadow-pins.yml::actionlint --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::antigravity-cli --> <!-- @manual -->
3. The official Claude extension and supported agent CLIs each have a dedicated bump job whose compatibility PR runs the owned verification path. <!-- @impl: .github/workflows/bump-shadow-pins.yml::agent-clis --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::claude-vscode-extension --> <!-- @impl: .github/dependabot.yml::updates --> <!-- @manual -->
4. A binary bump without an authoritative upstream checksum invalidates its pinned artifact checksum for operator verification. <!-- @impl: .github/workflows/bump-shadow-pins.yml::lazygit --> <!-- @manual -->
5. Actionlint resolves its release-manifest checksum and re-verifies the artifact. <!-- @impl: .github/workflows/bump-shadow-pins.yml::actionlint --> <!-- @manual -->
6. A bump branch is skipped when that tool and version already have one. <!-- @manual -->
7. Graphify, Bun, Pi extensions, Impeccable, consult-llm-mcp, chrome-devtools-mcp, and browser-run-mcp each have a dedicated release-check job or matrix. <!-- @impl: .github/workflows/bump-shadow-pins.yml::graphify --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::bun --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::impeccable --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::consult-llm-mcp --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::chrome-devtools-mcp --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::browser-run-mcp --> <!-- @manual -->

**Notes:** Workflow execution is verified manually per the [CI/CD lane](../../documentation/lanes/ci-cd.md).

**Constraints:** The owned Browser IDE extension's npm dependencies remain Dependabot-owned.

**Priority:** P2

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-025: Pi preseed bump artifact coherence

**Intent:** Updating a Pi-owned package pin cannot leave its lockfile or embedded seed stale, and regeneration cannot execute dependency lifecycle scripts.

**Applies To:** Operator

**Acceptance Criteria:**

1. The context-mode job bumps its Claude-plugin and Pi-prewarm pins atomically in one PR, and generated-artifact validation rejects drift. <!-- @impl: .github/workflows/bump-shadow-pins.yml::context-mode --> <!-- @manual -->
2. Context-mode and Pi-extension bumps regenerate the Pi package lock without executing runtime-layout package lifecycle scripts. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @impl: scripts/regenerate-pi-preseed-lock.mjs::packageDirectory --> <!-- @test: host/__tests__/pi-preseed-lockfile-regeneration.test.js (creates the lockfile without executing package lifecycle scripts) -->
3. Those jobs regenerate the embedded agent seed from the updated manifest and lockfile. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @manual -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-OPS-020](#req-ops-020-shadow-pin-version-bump-automation), [REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Automated test ([Automated lockfile test](../../host/__tests__/pi-preseed-lockfile-regeneration.test.js); workflow execution manual)

**Status:** Implemented

---

### REQ-OPS-021: Workflow-file static analysis

**Intent:** Defects in the CI workflows themselves — injection vectors, unpinned actions, invalid workflow files — are caught by automation instead of being discovered as failed or silently misbehaving runs.

**Applies To:** Operator

**Acceptance Criteria:**

1. A zizmor security audit runs on every pull request or push touching workflow files. <!-- @impl: .github/workflows/zizmor.yml::zizmor --> <!-- @manual -->
2. The audit's findings upload as SARIF to code scanning. <!-- @impl: .github/workflows/zizmor.yml::zizmor --> <!-- @manual -->
3. An actionlint check validates every workflow file using a checksum-pinned binary, catching errors GitHub reports only as jobless validation failures. <!-- @impl: .github/workflows/test.yml::workflow-audit --> <!-- @manual -->
4. The audit is merge-blocking: it runs inside the required status context and fails on any surviving finding, while a separate workflow records the same audit as SARIF for alert history. <!-- @impl: .github/workflows/test.yml::workflow-audit --> <!-- @manual -->

**Constraints:**

- The zizmor audit runs offline; its online known-vulnerable-actions audit fails fatally on advisory-API outages.
- Findings that are correct as written carry an inline suppression stating the reason, so they stop masking new findings; the auditor's own version is pinned rather than tracking latest.
- actionlint runs with its shellcheck integration enabled at `--severity=error` (syntax/error class only) to catch unparseable workflow `run:` scripts; its pyflakes integration stays disabled — deeper script hygiene is zizmor's concern.
- The actionlint version and checksum are a shadow pin: Dependabot cannot see them, so [REQ-OPS-020](#req-ops-020-shadow-pin-version-bump-automation) bumps them weekly.

**Priority:** P2

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-022: Coverage-threshold gate fails closed on missing evidence

**Intent:** A coverage run that dies before reporting, or that reports a threshold miss or a test failure, is never masked by the workerd-teardown-crash tolerance this lane needs in order to run at all.

**Applies To:** Operator

**Acceptance Criteria:**

1. The shared coverage action asserts the reporter produced its summary table before evaluating anything else, so a run that died before emitting coverage fails instead of passing on the absence of a failure string. <!-- @impl: scripts/ci/check-coverage-result.mjs::evaluateCoverageResult --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (fails closed on coverage evidence and bounds the backend crash exception) -->
2. A reported coverage-threshold miss is fatal regardless of exit status. <!-- @impl: scripts/ci/check-coverage-result.mjs::evaluateCoverageResult --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (fails closed on coverage evidence and bounds the backend crash exception) -->
3. A reported test failure inside the coverage run is fatal regardless of exit status. <!-- @impl: scripts/ci/check-coverage-result.mjs::evaluateCoverageResult --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (fails closed on coverage evidence and bounds the backend crash exception) -->
4. The known teardown-crash fingerprint is tolerated only for backend coverage and only after the table, test-failure, and threshold checks have all passed. <!-- @impl: scripts/ci/check-coverage-result.mjs::evaluateCoverageResult --> <!-- @impl: .github/actions/coverage-suite/action.yml::runs --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (fails closed on coverage evidence and bounds the backend crash exception) -->

**Constraints:**

- The fingerprint appears after every passing run of the Workers pool, so it can never be the sole condition for tolerating a non-zero exit.
- `set -o pipefail` is required: without it `npm test | tee` reports tee's status and a failed threshold check passes.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Automated — `src/__tests__/ci/suite-gates.test.ts` exercises coverage evidence failures and the bounded backend crash exception.

**Status:** Implemented

---

### REQ-OPS-023: Suite results are gated on machine-readable reports

**Intent:** A lane's verdict comes from a parsed report rather than an exit code or reporter prose, so a suite cannot pass by crashing in the right way, running nothing, or losing files to a mis-sharded run.

**Applies To:** Operator

**Acceptance Criteria:**

1. Every suite is gated on its machine-readable vitest JSON report: zero failures, no zero-test files, and a missing or corrupt report fails closed. <!-- @impl: scripts/ci/check-vitest-report.mjs::failedTests --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-023 AC1: vitest report gate) -->
2. A non-zero exit is accepted only for the suite that opts into Workers-pool teardown-crash tolerance, and only with the exact fingerprint. <!-- @impl: scripts/ci/check-vitest-report.mjs::tolerantOfPoolCrash --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-023 AC2: teardown-crash tolerance) -->
3. The aggregate job reconciles every suite's reports against that suite's test files in the tree, failing when a file ran nowhere or when a lane succeeded without uploading reports. <!-- @impl: scripts/ci/check-suite-completeness.mjs::SUITES --> <!-- @impl: scripts/ci/suites.mjs::SUITES --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-023 AC3: cross-suite completeness gate) -->

**Constraints:**

- Crash tolerance is opt-in per suite: only the Workers pool has the teardown bug, so a non-zero exit from the jsdom or Node suites stays fatal.
- Coverage-threshold evidence is gated separately in [REQ-OPS-022](#req-ops-022-coverage-threshold-gate-fails-closed-on-missing-evidence).

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Automated test ([suite-gates](../../src/__tests__/ci/suite-gates.test.ts))

**Status:** Implemented

---

### REQ-OPS-024: Worker bundle size is gated before it can fail a deploy

**Intent:** Cloudflare rejects an oversized Worker at deploy time, so without a pre-merge check the discovery point for "the bundle grew too much" is a failed production deploy. The gate moves that to the pull request that caused it.

**Applies To:** Operator

**Acceptance Criteria:**

1. The measured size comes from wrangler's own dry-run output — the same figure the platform applies — rather than an independently computed estimate that can drift from it. <!-- @impl: scripts/ci/check-bundle-size.mjs::matches --> <!-- @manual -->
2. A gzipped bundle over the configured budget fails the check. <!-- @impl: scripts/ci/check-bundle-size.mjs::gzipKiB --> <!-- @manual -->
3. Zero or more than one size measurement in the log fails the check rather than gating on whichever was printed first. <!-- @impl: scripts/ci/check-bundle-size.mjs::matches --> <!-- @manual -->
4. A budget that is missing, non-numeric or not positive fails the check; only an explicit opt-out sentinel skips enforcement. <!-- @impl: scripts/ci/check-bundle-size.mjs::budgetKiB --> <!-- @manual -->

**Constraints:**

- The budget sits below the platform limit with headroom, so ordinary feature work does not trip it while a step change still fails the PR.
- A budget parked at the platform limit would never fire.
- The dry run repoints the container image away from the Dockerfile, so measuring the bundle does not rebuild an image the container lane already builds.

**Priority:** P2

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-026: Concurrent deploy dispatches are legible and independently verified

**Intent:** Several environments are deployed off one branch in the same window. Every run rendered identically in the run list, and every dispatch's inline verification shared one concurrency group, so a second dispatch cancelled the first's verification and its deploy failed a gate the commit had actually passed.

**Applies To:** Operator

**Acceptance Criteria:**

1. The run title resolves and displays the environment being deployed, so dispatches are distinguishable in the run list without opening them. <!-- @impl: .github/workflows/deploy.yml::run-name --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (names each run after the environment it resolved) -->
2. Each dispatch verifies in its own concurrency group, keyed by that run's id, so a later dispatch cannot cancel an earlier one's verification and turn a verified commit into a failed gate. <!-- @impl: .github/workflows/deploy.yml::verify --> <!-- @impl: .github/workflows/test.yml::concurrency --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (gives each dispatch its own verify concurrency group) -->

**Constraints:**

- A called workflow inherits the caller's concurrency context, so the discriminator has to be supplied by the caller; the reusable workflow's own group cannot separate them.
- The discriminator defaults to empty, leaving the group unchanged for every other caller of the reusable workflow.

**Priority:** P2

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated test ([deploy-requires-tests](../../host/__tests__/deploy-requires-tests.test.js))

**Status:** Implemented

---

### REQ-OPS-027: code-server coupled-pin automation

**Intent:** A code-server release update preserves the immutable relationship between its artifact, embedded Code source, and compatibility evidence.

**Applies To:** Operator

**Acceptance Criteria:**

1. code-server has a dedicated bump job whose compatibility PR runs the Browser IDE verification path. <!-- @impl: .github/workflows/bump-shadow-pins.yml::code-server --> <!-- @impl: .github/workflows/test.yml::browser-ide --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (routes code-server bumps through one dedicated fail-closed updater) -->
2. The bump derives the embedded Code version and source commit from the immutable release gitlink. <!-- @impl: .github/workflows/bump-shadow-pins.yml::code-server --> <!-- @impl: scripts/ci/update-code-server-pins.mjs::updateCodeServerPins --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (updates every coupled runtime pin and invalidates the checksum atomically) -->
3. Updating the coupled pins invalidates the code-server artifact checksum for operator review. <!-- @impl: scripts/ci/update-code-server-pins.mjs::updateCodeServerPins --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (updates every coupled runtime pin and invalidates the checksum atomically) -->

**Constraints:**

- Release metadata is validated before it enters a write-enabled shell step.
- A checksum placeholder cannot pass the container build.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Automated test ([suite gates](../../src/__tests__/ci/suite-gates.test.ts)); complete-image Browser IDE lane

**Status:** Implemented

---

### REQ-OPS-028: Deploy verification and outcome gate

**Intent:** A deployment proceeds only after one authoritative verification path succeeds, and a run that deploys nothing cannot appear successful.

**Applies To:** Operator

**Acceptance Criteria:**

1. The deploy job runs only after exactly one authoritative verification path succeeds. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (allows exactly one authoritative verification path to reach deploy) -->
2. The final outcome fails when no deployment occurred. <!-- @impl: scripts/ci/assert-deploy-outcome.mjs::deployOutcome --> <!-- @impl: .github/workflows/deploy.yml::outcome --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (fails the outcome when no deployment occurred) -->

**Constraints:** Cancelled verification cannot be treated as successful verification.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated test ([deploy-requires-tests](../../host/__tests__/deploy-requires-tests.test.js)) exercises the authoritative-path truth table and deployed/no-deploy outcomes.

**Status:** Implemented

---
