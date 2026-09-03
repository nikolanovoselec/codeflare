# Operations

CI/CD pipeline, testing strategy, deployment workflow, container sizing, and cost model.

**Domain owner:** GitHub Actions workflows, deploy.yml, container-image.yml, sign-release.yml, test.yml, pentest.yml, fuzz.yml, stress-test.yml

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

**Intent:** Production deployments are triggered automatically on every push to the `main` branch, with manual dispatch as fallback. Deploys are gated on a green PR Checks run for the exact SHA; the staged pipeline reuses exact-tree evidence when available instead of repeating the test suite.

**Applies To:** User

**Acceptance Criteria:**

1. The deploy workflow triggers automatically from successful main-push PR Checks. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/nightly-pr-checks-routing.test.js (nightly PR Checks routing) --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (manual deploys cannot skip tests) -->
2. The deploy workflow also supports manual dispatch to production, integration, enterprise, or enterprise integration. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual -->
3. The deploy pipeline stages target preparation, parallel worker-asset and container-image builds, and deployment. <!-- @impl: .github/workflows/deploy.yml::prepare --> <!-- @impl: .github/workflows/deploy.yml::build-worker --> <!-- @impl: .github/workflows/deploy.yml::container --> <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (manual deploys cannot skip tests) -->
4. Frontend and landing assets are built once and handed to the deploy job as an artifact. <!-- @impl: .github/workflows/deploy.yml::build-worker --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (manual deploys cannot skip tests) -->
5. The KV namespace is resolved or created and applied to the deployment configuration. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) --> <!-- @manual -->

**Constraints:**

- Automatic production deployment follows a successful main-branch PR check; manual dispatch supports production, integration, enterprise, and enterprise integration.
- Manual-dispatch verification reuse and fallback are owned by [REQ-OPS-029](#req-ops-029-automatic-manual-deploy-verification-reuse).
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

**Intent:** Every deploy resolves a container image whose build inputs are content-hashed into its tag. Changed inputs trigger a build, a HIGH/CRITICAL vulnerability scan with allowlisted exceptions, and a push to the target registry. The pipeline fails before push on any unexcepted finding.

**Applies To:** User

**Acceptance Criteria:**

1. The CI runner builds the image when its hashed inputs and weekly salt produce a registry-missing tag. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: host/__tests__/container-image-input-hash.test.js (deployment container image input hash) -->
2. A cache-bust forces an image rebuild without changing the content-addressed tag. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual -->
3. The built image is scanned for HIGH and CRITICAL severity vulnerabilities. <!-- @impl: .github/workflows/container-image.yml::severity = HIGH,CRITICAL --> <!-- @manual -->
4. Known vulnerability exceptions are tracked in a project-level allowlist. <!-- @impl: scripts/ci/validate-trivy-result.mjs::validateTrivyResult --> <!-- @test: host/__tests__/trivy-exception-gate.test.js (Trivy bounded exception gate) --> <!-- @manual -->
5. The pipeline fails before push on an unexcepted vulnerability or when a bounded exception is missing, duplicated, additional, or differs from its reviewed artifact, package path, package URL, package, installed version, fixed version, or severity. <!-- @impl: scripts/ci/validate-trivy-result.mjs::validateTrivyResult --> <!-- @test: host/__tests__/trivy-exception-gate.test.js (Trivy bounded exception gate) --> <!-- @manual -->
6. The image is pushed to the selected registry (Cloudflare managed registry by default; Docker Hub as dispatch-selectable bypass); the content-address image tag is captured for downstream binding. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual -->
7. A freshly built image passes packaged Pi/Claude inventory, cold-readiness, process, resource, and prefixed-proxy smoke before vulnerability scan or push. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::main --> <!-- @test: host/__tests__/coding-agent-selection.test.js (REQ-OPS-002 AC7: packaged-image smoke activates an extension through its VS Code EventEmitter shim) --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-002 AC7 + REQ-OPS-003 AC7: PR Checks never build images and deployment runs every packaged smoke gate) -->

**Constraints:**

- The container-binding and scaling steps rebuild the registry URI from the image tag this REQ produces — the URI itself is never a workflow output, since it would embed a masked secret and be silently dropped; see [REQ-OPS-014](#req-ops-014-container-binding-and-scaling-from-image).
- The hash covers copied production paths, Dockerfile, deployment image workflow, ignore and scan policy, and the weekly salt.
- Cache-bust disables reuse without changing the content-addressed tag.
- A COPY coverage gap disables reuse.
- The weekly hash salt gives unchanged inputs a new image identity on the first deployment of each ISO week.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-SEC-011](security.md#req-sec-011-container-image-scanned-for-cves-before-deploy)

**Verification:** Automated workflow-ownership tests; deployment image evidence

**Status:** Implemented

---

### REQ-OPS-046: Fixable dependencies in immutable runtime artifacts

**Intent:** Fixable vulnerable dependencies embedded in immutable upstream artifacts must be replaced without weakening the image vulnerability gate, and the packaged image must prove each replacement is loadable and operational.

**Applies To:** User

**Acceptance Criteria:**

1. Each fixable vulnerable dependency in an immutable runtime is replaced at every affected path from an exact integrity-verified package artifact. <!-- @impl: Dockerfile::NODE_TAR_VERSION --> <!-- @impl: Dockerfile::PACOTE_VERSION --> <!-- @manual: Dispatch a fresh integration image build and confirm each overlay integrity check succeeds before extraction. -->
2. Before scan or push, packaged-image smoke verifies the fixed version at every affected runtime path. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyNodeTarRuntimes --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPacoteRuntime --> <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: host/__tests__/coding-agent-selection.test.js (REQ-OPS-046 AC2-AC4: packaged-image smoke rejects broken node-tar runtimes) --> <!-- @test: host/__tests__/coding-agent-selection.test.js (REQ-OPS-046 AC2-AC3: packaged-image smoke rejects a broken npm pacote overlay) --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-002 AC7 + REQ-OPS-003 AC7: PR Checks never build images and deployment runs every packaged smoke gate) -->
3. Packaged-image smoke loads each replacement through every affected runtime path. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyNodeTarRuntimes --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyPacoteRuntime --> <!-- @test: host/__tests__/coding-agent-selection.test.js (REQ-OPS-046 AC2-AC4: packaged-image smoke rejects broken node-tar runtimes) --> <!-- @test: host/__tests__/coding-agent-selection.test.js (REQ-OPS-046 AC2-AC3: packaged-image smoke rejects a broken npm pacote overlay) -->
4. Each archive-capable replacement completes an archive creation and extraction round trip. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyNodeTarRuntimes --> <!-- @test: host/__tests__/coding-agent-selection.test.js (REQ-OPS-046 AC2-AC4: packaged-image smoke rejects broken node-tar runtimes) --> <!-- @manual: Confirm fresh-image smoke reports both node-tar paths before Trivy scan and image push. -->

**Constraints:**

- The overlay is removed once every upstream immutable artifact carries at least the fixed version directly.
- Vulnerability exceptions remain governed by [REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push) and [REQ-SEC-011](security.md#req-sec-011-container-image-scanned-for-cves-before-deploy).

**Priority:** P0

**Dependencies:** [REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push), [REQ-SEC-011](security.md#req-sec-011-container-image-scanned-for-cves-before-deploy)

**Verification:** Automated overlay-contract and packaged-runtime-smoke tests; deployment image evidence

**Status:** Implemented

---

### REQ-OPS-003: PR checks run lint, test, typecheck, and security audit

**Intent:** Every pull request to `main` must pass comprehensive quality checks before merge.

**Applies To:** User

**Acceptance Criteria:**

1. PR Checks runs for pull requests to main or develop, pushes to main, and manual dispatches. <!-- @impl: .github/workflows/test.yml::pull_request --> <!-- @test: host/__tests__/nightly-pr-checks-routing.test.js (nightly PR Checks routing) -->
2. The workflow runs lint and a dead-code check on the codebase. <!-- @manual -->
3. A failing owned backend, frontend, landing, or host test lane prevents the required `test` status from passing. <!-- @impl: .github/workflows/test.yml::summary --> <!-- @test: host/__tests__/required-check-covers-every-lane.test.js (required status context covers every lane (test.yml summary job)) -->
4. The workflow runs both backend and frontend typechecks. <!-- @manual -->
5. The workflow blocks PRs when either production dependency lockfile contains a high-severity vulnerability. <!-- @impl: .github/workflows/test.yml::quality --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (audits production lockfiles without depending on restored node_modules trees) --> <!-- @manual -->
6. A Browser IDE extension change cannot pass the required PR status unless its owned validation suite succeeds. <!-- @impl: .github/workflows/test.yml::browser-ide --> <!-- @impl: scripts/ci/suites.mjs::SUITES --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-003 AC6: Browser IDE extension suite ownership) -->
7. PR Checks never build, scan, run, or publish the session container image; the deployment image workflow owns the complete-image build, packaged smoke, vulnerability scan, SBOM, and push. <!-- @impl: .github/workflows/test.yml::summary --> <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-002 AC7 + REQ-OPS-003 AC7: PR Checks never build images and deployment runs every packaged smoke gate) -->

**Constraints:**

- Quality checks do not run in the 1-vCPU development container; they run on CI runners.
- The CI runner label is configurable across all workflows.
- Lanes run in parallel and are gated by a path filter; manual dispatch runs every lane.
- If GitHub cannot generate the diff, the fallback verifies the exact local base/head commits and selects every lane. <!-- @impl: scripts/ci/path-filter-fallback.sh::changed_files --> <!-- @test: host/__tests__/nightly-pr-checks-routing.test.js (REQ-OPS-003: executes the fallback against exact commits and emits every lane) -->
- The `summary` job publishes the required `test` status, failing for failed or cancelled lanes and passing skipped lanes.
- The Workers pool runs several workers per shard; its teardown crash is a teardown bug, not a concurrency one, so the report and reconciliation gates in [REQ-OPS-023](#req-ops-023-suite-results-are-gated-on-machine-readable-reports) — not serialization — are what keep the result trustworthy.
- Coverage-threshold evidence is gated separately in [REQ-OPS-022](#req-ops-022-coverage-threshold-gate-fails-closed-on-missing-evidence); backend and frontend coverage run only when their path filter is affected or the workflow is a full run.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated tests ([required-check-covers-every-lane](../../host/__tests__/required-check-covers-every-lane.test.js), [nightly-pr-checks-routing](../../host/__tests__/nightly-pr-checks-routing.test.js), [workflow hardening](../../host/__tests__/ci-workflow-hardening.test.js)); lint, typecheck, and audit ACs verified in CI

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
6. Target validation rejects paths, credentials, IP or single-label hosts, control characters, queries, and fragments. <!-- @impl: scripts/ci/normalize-https-origin.mjs::raw --> <!-- @impl: scripts/ci/normalize-https-origin.mjs::url.username --> <!-- @impl: scripts/ci/normalize-https-origin.mjs::url.pathname --> <!-- @impl: scripts/ci/normalize-https-origin.mjs::isIP --> <!-- @test: host/__tests__/normalize-https-origin.test.js (pentest target normalization) -->
7. All six probes consume the target job's single normalized output. <!-- @impl: .github/workflows/pentest.yml::target --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (shared CI components) -->

**Constraints:**

- The pentest requires a configured target URL set in the production deployment environment.
- The pentest uses only lightweight external tools (no heavy active scanners) so weekly runs do not consume excessive CI budget.

**Priority:** P1

**Dependencies:** [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response), [REQ-SEC-009](security.md#req-sec-009-input-validation-at-system-boundaries), [REQ-SEC-010](security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints)

**Verification:** Automated tests ([tls-legacy-probe](../../host/__tests__/tls-legacy-probe.test.js), [normalize-https-origin](../../host/__tests__/normalize-https-origin.test.js), [ci-workflow-hardening](../../host/__tests__/ci-workflow-hardening.test.js))

**Status:** Implemented

---

### REQ-OPS-006: Idle containers stop metered container resources

**Intent:** Containers that are not actively in use must stop and go to sleep so Container vCPU, provisioned-memory, and local-disk metering ends. The cost model is operator-facing and distinguishes Container metering from the rest of the Cloudflare platform.

**Applies To:** Admin

**Acceptance Criteria:**

1. Containers stop after a configurable idle period of no user input (default 30 minutes, settable range 15 minutes to 4 hours; a legacy `5m` value is still accepted for a pre-existing stored preference but is no longer offered in the picker). <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs --> <!-- @test: src/__tests__/container-metrics.test.ts (idle timeout resolution (REQ-OPS-006 AC1) / REQ-OPS-017 (sleepAfter fail-safe invariants)) -->
2. After Codeflare stops a Container and it sleeps, its vCPU, provisioned-memory, and local-disk metering stops. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @manual: Record the Container's vCPU, provisioned-memory, and local-disk usage in Cloudflare analytics; let Codeflare idle-stop it; confirm it is sleeping and all three usage totals stop increasing while it remains stopped. -->
3. Local disk is ephemeral and restart restores durable files from R2. <!-- @manual -->
4. Workers, Durable Objects, R2, requests, logs, storage, and network may still incur charges. <!-- @manual -->
5. Under the documented dated workload assumptions, the estimate is `$11.14` and excludes shared account-level platform cost. <!-- @manual: Recalculate against the dated assumptions and current Cloudflare pricing before using the example operationally. -->

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

**Verification:** Automated tests ([rate-limit](../../src/__tests__/middleware/rate-limit.test.ts), [workflow-stress-test](../../host/__tests__/workflow-stress-test.test.js), [ci-workflow-hardening](../../host/__tests__/ci-workflow-hardening.test.js))

**Status:** Implemented

---

### REQ-OPS-009: Supply chain security monitoring

**Intent:** The project's open-source supply chain security posture must be continuously monitored and reported.

**Applies To:** User

**Acceptance Criteria:**

1. The OSSF Scorecard workflow runs on push to main and weekly. <!-- @manual -->
2. Scorecard results are uploaded to GitHub Security. <!-- @manual -->
3. A manual dispatch on the repository default branch runs Scorecard. <!-- @impl: .github/workflows/scorecard.yml::scorecard --> <!-- @test: host/__tests__/scorecard-workflow.test.js (REQ-OPS-009: Scorecard default-branch dispatch routing) -->
4. A non-default manual dispatch records an explicit successful no-op instead of invoking Scorecard's unsupported branch path. <!-- @impl: .github/workflows/scorecard.yml::unsupported-ref --> <!-- @test: host/__tests__/scorecard-workflow.test.js (REQ-OPS-009: Scorecard default-branch dispatch routing) -->
5. Repository-level secret scanning with push protection is enabled. This is a repository-level GitHub setting verified out of band, not from source. <!-- @manual -->
6. Dependabot security updates are enabled at the repository level. This is a repository-level GitHub setting verified out of band, not from source. <!-- @manual -->

**Constraints:**

- Push-triggered and weekly scans provide continuous monitoring; default-branch manual dispatch remains available for explicit rescans.
- Secret-scanning push protection prevents secrets from being committed.
- High-severity dependency audits and dependency-review enforcement are owned by [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit); not duplicated here.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Automated workflow-routing tests for AC3 and AC4; manual checks for AC1, AC2, AC5, and AC6.

**Status:** Implemented

---

### REQ-OPS-010: Graceful container shutdown preserves data

**Intent:** Container shutdown must complete a final sync to R2 before termination to prevent data loss.

**Applies To:** User

**Acceptance Criteria:**

1. The container image declares a graceful-stop signal that the entrypoint trap can catch. <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC1: the container image declares STOPSIGNAL SIGINT) --> <!-- @manual -->
2. The container entrypoint's trap handler catches the graceful-stop signal. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC2: the container entrypoint trap handler catches SIGINT/SIGTERM signals) -->
3. The trap handler terminates the background sync daemon using a durable PID record as the sole mechanism. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC3 / REQ-OPS-048 AC1: trap handler kills services through protected runtime PID files) -->
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
2. Every agent CLI selected for the deployment executes its version command inside the built image with a ten-second timeout; a missing, crashing, non-zero, or timed-out launcher fails the image job. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifySelectedAgentLaunchers --> <!-- @test: host/__tests__/coding-agent-selection.test.js (the packaged-image smoke starts selected launchers and requires omitted launchers to be absent) -->
3. Essential developer tools for terminal-based workflows are pre-installed. <!-- @test: host/__tests__/dockerfile-base-image.test.js (REQ-OPS-011 AC3: system packages include essential tools: git, ripgrep, neovim, tmux, fzf, jq, python) --> <!-- @manual -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated test

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
4. The service user is seeded only when a service-auth secret is configured. <!-- @impl: scripts/ci/seed-service-user.sh::CF_ACCESS_CLIENT_SECRET --> <!-- @test: host/__tests__/seed-service-user.test.js (does nothing when neither service-auth secret is configured) --> <!-- @test: host/__tests__/seed-service-user.test.js (writes the fixed admin identity once when the first attempt succeeds) -->
5. Three failed seed attempts fail deployment instead of publishing partial configuration as successful. <!-- @impl: scripts/ci/seed-service-user.sh::attempt --> <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/seed-service-user.test.js (fails after three unsuccessful writes) -->
6. Deployment permits notification sender configuration to be absent; when any sender field is configured, all three fields must be present, valid, whitespace-trimmed, and internally consistent before Worker promotion. <!-- @impl: scripts/ci/validate-vapid-config.mjs::validateSubject --> <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (allows notifications to be omitted and validates a configured matching P-256 keypair before Worker promotion) -->
7. Deployment logs identify whether notification fields are configured without printing their values. <!-- @impl: scripts/ci/validate-vapid-config.mjs::required --> <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (rejects partial, whitespace, malformed, and mismatched configuration without printing key values) -->

**Notes:** Partial pending a successful deployment record showing accepted sender configuration, value-free logs, a public-only config response, and off/on re-enrollment after controlled key rotation.

**Constraints:**

- Worker secrets are written after worker creation.
- Absent service auth skips seeding; configured seeding fails closed.
- Notification sender configuration is optional and all-or-none, with one repository-level identity shared across deployment environments.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated tests ([seed-service-user](../../host/__tests__/seed-service-user.test.js), [notification deployment contract](../../host/__tests__/deploy-requires-tests.test.js), [ci-workflow-hardening](../../host/__tests__/ci-workflow-hardening.test.js)); deployment evidence

**Status:** Partial

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
4. On session destruction, the persisted preference is removed. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/lifecycle.test.ts (REQ-SESSION-027 AC1/AC4-AC5: destroy preserves credentials, drains before sync, and clears storage) -->

**Constraints:**

- Persisted preference values are schema-validated on load; invalid values are treated as missing and trigger the fail-safe fallback in [REQ-OPS-017](#req-ops-017-sleepafter-fail-safe-invariants).

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-stop-metered-container-resources)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-OPS-017: sleepAfter fail-safe invariants

**Intent:** Three invariants protect user work from a misconfigured or silently broken idle-detection layer: fail to the maximum (not minimum) on corruption, propagate preference changes within one cycle, and fail loudly rather than substituting a default. A container that dies before its configured timer destroys an hour of unpushed work and breaks the product's core promise.

**Applies To:** Admin

**Acceptance Criteria:**

1. An unresolved idle-timeout preference falls back to the maximum supported four hours, preserving user work. <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs --> <!-- @impl: src/container/container-metrics.ts::SLEEP_AFTER_FALLBACK_MS = 14_400_000 --> <!-- @test: src/__tests__/lib/sleep-timer-defaults.test.ts (parseSleepAfterMs - fail-safe direction) -->
2. Every idle-check tick resolves the persisted preference afresh; a valid change takes effect within that cycle regardless of which code path wrote it. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (REQ-SESSION-014: User-configurable auto-sleep timeout in Settings) -->
3. In-memory copies of the preference do not outlive a single idle-check cycle. <!-- @impl: src/container/index.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (refreshes idleTimeoutPref from storage on every tick) -->
4. On any missing, unsupported, malformed, or failed idle-timeout read, resolution substitutes the maximum supported value (4h), replaces stale cached state, and logs the fallback, never a shorter default — so a resolution failure can only lengthen, never shorten, the user's effective timeout. <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs --> <!-- @test: src/__tests__/lib/sleep-timer-defaults.test.ts (parseSleepAfterMs - fail-safe direction) -->

**Constraints:**

- The fail-safe direction is chosen to preserve user work over billing efficiency.

**Priority:** P0

**Dependencies:** [REQ-OPS-006](#req-ops-006-idle-containers-stop-metered-container-resources), [REQ-OPS-016](#req-ops-016-sleepafter-preference-persistence-and-lifecycle)

**Verification:** Automated test ([container-metrics](../../src/__tests__/container-metrics.test.ts))

**Status:** Implemented

---

### REQ-OPS-018: Weekly fuzz testing

**Intent:** Property-based fuzz testing runs on a weekly schedule and on every PR to either protected branch to identify edge-case bugs in input parsing and state transitions.

**Applies To:** User

**Acceptance Criteria:**

1. The fuzz workflow runs on PRs to `main` and `develop`. <!-- @impl: .github/workflows/fuzz.yml::pull_request = branches: [main, develop] --> <!-- @test: host/__tests__/develop-required-checks.test.js (REQ-OPS-018/019: protected branch required-check triggers) -->
2. Fuzz testing uses fast-check with 50,000 iterations for property-based testing. <!-- @manual -->
3. The fuzz workflow runs weekly (Sunday 04:00 UTC). <!-- @manual -->
4. The fuzz workflow supports `workflow_dispatch`. <!-- @manual -->
5. Root, frontend, and host fuzz dependencies use the shared lock-keyed, bounded-retry installer before their suites execute. <!-- @impl: .github/actions/install-deps/action.yml::runs --> <!-- @impl: .github/workflows/fuzz.yml::fuzz --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (shared CI components) --> <!-- @test: host/__tests__/install-deps.test.js (shared dependency installer contract) -->
6. Managed release activation fuzzing preserves a newer compatible winner. <!-- @impl: src/lib/remote-curation-cache.ts::activateCachedManagedRelease --> <!-- @test: src/__tests__/fuzz/runtime-config.fuzz.test.ts (never replaces a newer compatible active release with an older candidate) -->
7. Managed release activation fuzzing rejects conflicting identity at the same sequence. <!-- @impl: src/lib/remote-curation-cache.ts::activateCachedManagedRelease --> <!-- @test: src/__tests__/fuzz/runtime-config.fuzz.test.ts (rejects conflicting release identity at the same sequence) -->

**Constraints:** Extended runs retain the workflow timeout; dependency installation remains bounded and retryable.

**Priority:** P1

**Dependencies:** [REQ-SEC-008](security.md#req-sec-008-security-headers-on-every-response), [REQ-SEC-009](security.md#req-sec-009-input-validation-at-system-boundaries), [REQ-SEC-010](security.md#req-sec-010-path-traversal-prevention-on-storage-endpoints)

**Verification:** Automated protected-branch trigger and shared-installer contracts; CI evidence for the extended iteration count and scheduled/manual routes.

**Status:** Implemented

---

### REQ-OPS-019: Security-posture scanning workflows

**Intent:** Independent security-posture assessment workflows must continuously evaluate the codebase against known-vulnerability patterns and supply-chain risk indicators, outside the per-PR quality gates.

**Applies To:** User

**Acceptance Criteria:**

1. CodeQL runs on pushes to `main`. <!-- @manual -->
2. CodeQL runs on a weekly schedule. <!-- @manual -->
3. CodeQL uploads results to GitHub Security. <!-- @manual -->
4. OSSF Scorecard runs a security-posture assessment on pushes to `main`. <!-- @manual -->
5. OSSF Scorecard runs on a weekly schedule. <!-- @manual -->
6. CodeQL runs on PRs to `main` and `develop`. <!-- @impl: .github/workflows/codeql.yml::pull_request = branches: [main, develop] --> <!-- @test: host/__tests__/develop-required-checks.test.js (REQ-OPS-018/019: protected branch required-check triggers) -->
7. CodeQL initialization, autobuild, and analysis run one compatible action release rather than mixing state formats across releases. <!-- @impl: .github/workflows/codeql.yml::github/codeql-action --> <!-- @test: host/__tests__/develop-required-checks.test.js (REQ-OPS-019 AC7: CodeQL init, autobuild, and analyze use one compatible action release) -->

**Constraints:**

- These workflows run independently of the per-PR quality gates in [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit).
- CodeQL supplies its required status to pull requests for both protected branches.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Automated protected-branch CodeQL trigger contract for AC6 and release-coherence contract for AC7; manual verification for AC1 through AC5.

**Status:** Implemented

---

<a id="req-ops-020-agent-toolchain-shadow-pin-freshness"></a>
### REQ-OPS-020: Shadow-pin version bump automation

**Intent:** Every release pin outside a package manifest has one explicit weekly update owner and a fail-closed verification path.

**Applies To:** Operator

**Acceptance Criteria:**

1. Zoxide, yazi, and lazygit each have a parallel release-check job. <!-- @impl: .github/workflows/bump-shadow-pins.yml::zoxide --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::yazi --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::lazygit --> <!-- @manual -->
2. Actionlint and Antigravity each have a dedicated release-check job. <!-- @impl: .github/workflows/bump-shadow-pins.yml::actionlint --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::antigravity-cli --> <!-- @manual -->
3. The official Claude extension and supported agent CLIs each have a dedicated bump job whose compatibility PR runs the owned verification path. <!-- @impl: .github/workflows/bump-shadow-pins.yml::agent-clis --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::claude-vscode-extension --> <!-- @impl: .github/dependabot.yml::updates --> <!-- @manual -->
4. A binary bump without an authoritative upstream checksum invalidates its pinned artifact checksum for operator verification. <!-- @impl: .github/workflows/bump-shadow-pins.yml::lazygit --> <!-- @manual -->
5. Actionlint resolves its release-manifest checksum and re-verifies the artifact. <!-- @impl: .github/workflows/bump-shadow-pins.yml::actionlint --> <!-- @manual -->
6. A bump branch is skipped when that tool and version already have one. <!-- @manual -->
7. Graphify, Bun, Pi extensions, Impeccable, consult-llm-mcp, chrome-devtools-mcp, browser-run-mcp, and uv each have a dedicated release-check job or matrix. <!-- @impl: .github/workflows/bump-shadow-pins.yml::graphify --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::bun --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::impeccable --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::consult-llm-mcp --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::chrome-devtools-mcp --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::browser-run-mcp --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::uv --> <!-- @manual -->

**Notes:** Third-party release execution is verified manually per the [CI/CD lane](../../documentation/lanes/ci-cd.md); owned updater boundaries are automated where listed.

**Constraints:** The owned Browser IDE extension's npm dependencies remain Dependabot-owned.

**Priority:** P2

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-055: Herdr release integration

**Intent:** Herdr release updates preserve one coherent binary identity and fail before deployment when the packaged API is incompatible.

**Applies To:** Operator

**Acceptance Criteria:**

1. Herdr has one weekly release-check job that skips an existing bump branch for the same release. <!-- @impl: .github/workflows/bump-shadow-pins.yml::herdr --> <!-- @test: host/__tests__/dockerfile-dependency-integrity.test.js (keeps current Herdr pins coherent and wires release and packaged-runtime jobs) --> <!-- @manual -->
2. A Herdr bump advances its version, commit, checksum, provenance, launcher pin, and packaged API check in one pull request. <!-- @impl: .github/workflows/bump-shadow-pins.yml::herdr --> <!-- @manual: Review the files changed by a generated Herdr bump pull request. -->
3. Packaged-image CI rejects a Herdr release whose consumed pane-scroll or agent-status subscription API is incompatible. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual: Container-image CI executes the pinned Herdr binary's schema command and enforces the consumed fields, subscription type, and semantic statuses. -->

**Constraints:** Herdr remains a coordinated GitHub release binary outside Dependabot ownership.

**Priority:** P1

**Dependencies:** [REQ-OPS-020](#req-ops-020-shadow-pin-version-bump-automation)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-041: Least-privilege workflow-tool pin updates

**Intent:** Routine workflow-tool bumps remain pushable by the standard GitHub Actions token without granting automation permission to rewrite workflow logic.

**Applies To:** Operator

**Acceptance Criteria:**

1. Zizmor and actionlint bumps update only their validated non-workflow pin manifest, allowing the least-privilege GitHub Actions token to push their branches without workflow-write permission. <!-- @impl: scripts/ci/workflow-tool-pins.mjs::updateWorkflowToolPin --> <!-- @impl: scripts/ci/workflow-tool-pins.mjs::stageDefaultManifest --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::zizmor --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::actionlint --> <!-- @test: host/__tests__/workflow-tool-pins.test.js (REQ-OPS-041: least-privilege workflow-tool pin updates) -->

**Constraints:** GitHub Actions referenced through `uses:` remain pinned directly to immutable commits in workflow files.

**Priority:** P1

**Dependencies:** [REQ-OPS-020](#req-ops-020-shadow-pin-version-bump-automation), [REQ-OPS-021](#req-ops-021-workflow-file-static-analysis)

**Verification:** Automated workflow-tool pin CLI tests; manual release-job verification

**Status:** Implemented

---

<a id="req-ops-033-generated-seed-and-prewarm-lock-integrity"></a>
### REQ-OPS-033: Lock-Backed NPM Bump Coherence

**Intent:** Automated npm release bumps must reject stale inputs and move each exact manifest pin with its owning committed lock.

**Applies To:** Operator

**Acceptance Criteria:**

1. For non-Pi packages, the shared manifest updater changes only the requested dependency after an exact current-value match. <!-- @impl: scripts/update-npm-tool-manifests.mjs::updateNpmToolManifests --> <!-- @test: host/__tests__/npm-tool-manifest-update.test.js (REQ-OPS-033: lock-backed npm bump manifest updates) -->
2. Npm-tool bump jobs regenerate and commit each changed manifest's owning lock through one lifecycle-safe helper. <!-- @impl: scripts/regenerate-npm-package-lock.mjs::packageDirectory --> <!-- @impl: scripts/update-pi-runtime-artifacts.mjs::updatePiRuntimeArtifacts --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::context-mode --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::bun --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::consult-llm-mcp --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::chrome-devtools-mcp --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::browser-run-mcp --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::agent-clis --> <!-- @test: host/__tests__/npm-package-lock-regeneration.test.js (REQ-OPS-033: lifecycle-safe npm lockfile regeneration) -->
3. Every shared npm-cooldown caller opens a bump for a strictly newer numeric semantic version. <!-- @impl: scripts/ci/semver-forward.mjs::strictSemverUpgrade --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @test: host/__tests__/semver-forward.test.js (strictSemverUpgrade) --> <!-- @test: host/__tests__/semver-forward.test.js (shadow-pin workflow forward-only routing) -->
4. Equal or older npm-cooldown candidates do not open a bump. <!-- @impl: scripts/ci/semver-forward.mjs::strictSemverUpgrade --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @test: host/__tests__/semver-forward.test.js (strictSemverUpgrade) --> <!-- @test: host/__tests__/semver-forward.test.js (shadow-pin workflow forward-only routing) -->
5. Malformed npm-cooldown candidates fail before mutation. <!-- @impl: scripts/ci/semver-forward.mjs::strictSemverUpgrade --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @test: host/__tests__/semver-forward.test.js (strictSemverUpgrade) --> <!-- @test: host/__tests__/semver-forward.test.js (shadow-pin workflow forward-only routing) -->

**Constraints:** Package updates remain subject to the configured supply-chain cooldown and normal PR review.

**Priority:** P2

**Dependencies:** [REQ-OPS-020](#req-ops-020-shadow-pin-version-bump-automation)

**Verification:** Automated manifest-update, lifecycle-safe lock-regeneration, and forward-only semantic-version tests; workflow execution manual

**Status:** Implemented

---

<a id="req-ops-054-committed-npm-runtime-lock-integrity"></a>
### REQ-OPS-054: Committed NPM Runtime Lock Integrity

**Intent:** Committed npm runtime locks must preserve reviewed dependency security floors and release-family coherence.

**Applies To:** Operator

**Acceptance Criteria:**

1. Every affected committed runtime lock resolves reviewed dependency security floors, including undici 8.9.0 in both Pi runtime trees and ip-address 10.3.1 or later in all three affected runtime trees. <!-- @impl: preseed/npm-tools/package-lock.json::node_modules/undici --> <!-- @impl: preseed/agents/pi/package-lock.json::node_modules/undici --> <!-- @impl: preseed/agents/claude/browser-run-mcp/package-lock.json::node_modules/ip-address --> <!-- @test: host/__tests__/dockerfile-dependency-integrity.test.js (pins patched versions across every affected committed runtime tree) -->
2. Every Claude platform package in the privileged npm runtime lock matches the exact Claude CLI manifest pin. <!-- @impl: preseed/npm-tools/package-lock.json::node_modules/@anthropic-ai/claude-code --> <!-- @test: host/__tests__/dockerfile-dependency-integrity.test.js (locks every Claude platform package at the exact CLI release) -->
3. The Browser Run MCP, shared npm-tools, and Pi runtime locks resolve fast-uri 3.1.6 or later. <!-- @impl: preseed/agents/claude/browser-run-mcp/package-lock.json::node_modules/fast-uri = 3.1.6 --> <!-- @impl: preseed/npm-tools/package-lock.json::node_modules/fast-uri = 3.1.6 --> <!-- @impl: preseed/agents/pi/package-lock.json::node_modules/fast-uri = 3.1.6 --> <!-- @test: host/__tests__/dockerfile-dependency-integrity.test.js (pins patched versions across every affected committed runtime tree) -->

**Constraints:** Runtime-lock changes remain subject to normal PR review.

**Priority:** P2

**Dependencies:** [REQ-OPS-033](#req-ops-033-lock-backed-npm-bump-coherence)

**Verification:** Automated committed runtime-lock integrity tests

**Status:** Implemented

---

### REQ-OPS-032: SilverBullet coupled-release automation

**Intent:** A SilverBullet release bump moves the server binary, authoritative digest, and vendored native worker as one verified unit so browser and server releases cannot drift.

**Applies To:** Operator

**Acceptance Criteria:**

1. The dedicated SilverBullet release job resolves the latest linux server archive and accepts only its authoritative asset integrity digest. <!-- @impl: .github/workflows/bump-shadow-pins.yml::silverbullet --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (resolves the authoritative release digest through the workflow command boundary) -->
2. Applying the bump atomically updates the server version, artifact digest, vendored worker bytes, worker version annotation, and worker drift hash. <!-- @impl: .github/workflows/bump-shadow-pins.yml::silverbullet --> <!-- @impl: scripts/ci/update-silverbullet-pins.mjs::updateSilverBulletPins --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-032: SilverBullet coupled-pin automation) -->

**Constraints:**

- The downloaded archive is checksum-verified before execution, and its served version must match the release before its worker is accepted.
- Malformed metadata, an incomplete pin contract, or a worker without cache-bypassing precache fails closed.

**Priority:** P1

**Dependencies:** [REQ-OPS-020](#req-ops-020-shadow-pin-version-bump-automation), [REQ-VAULT-017](vault.md#req-vault-017-silverbullet-native-service-worker)

**Verification:** Automated test ([suite gates](../../src/__tests__/ci/suite-gates.test.ts)); complete-image verification

**Status:** Implemented

---

### REQ-OPS-025: Pi preseed bump artifact coherence

**Intent:** Updating a Pi-owned package pin cannot leave its lockfile or embedded seed stale, and regeneration cannot execute dependency lifecycle scripts.

**Applies To:** Operator

**Acceptance Criteria:**

1. The context-mode job bumps its Claude-plugin and Pi-prewarm pins atomically in one PR, and generated-artifact validation rejects drift. <!-- @impl: .github/workflows/bump-shadow-pins.yml::context-mode --> <!-- @manual -->
2. Context-mode and Pi-extension bumps regenerate the Pi package lock without executing runtime-layout package lifecycle scripts. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @impl: scripts/regenerate-npm-package-lock.mjs::packageDirectory --> <!-- @test: host/__tests__/npm-package-lock-regeneration.test.js (REQ-OPS-033: lifecycle-safe npm lockfile regeneration) -->
3. Those jobs regenerate the embedded agent seed from the updated manifest and lockfile. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @manual -->
4. A Pi runtime-agent bump updates the shared image-tools lock, both prewarm dependency/override pins and lock, bundled-dependency integrity corrections, and embedded seed atomically. <!-- @impl: .github/workflows/bump-shadow-pins.yml::agent-clis --> <!-- @impl: scripts/update-pi-runtime-artifacts.mjs::updatePiRuntimeArtifacts --> <!-- @test: host/__tests__/npm-tool-manifest-update.test.js (REQ-OPS-025 AC4: updates every Pi runtime and prewarm artifact through one fail-closed operation) -->
5. A Pi-extension bump updates every matching exact-version sentinel. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-AGENT-155 AC7: Caveman participates in coherent Pi extension shadow bumps) -->
6. Goal and Plan package bumps run their exact-version transforms before opening a PR. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-AGENT-111: pi-goal shadow bumps preflight the locked review-control patch) --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-AGENT-152: Plan Mode shadow bumps execute the locked tool-policy preflight) -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-OPS-020](#req-ops-020-shadow-pin-version-bump-automation), [REQ-OPS-033](#req-ops-033-lock-backed-npm-bump-coherence), [REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Automated test ([Automated lockfile test](../../host/__tests__/npm-package-lock-regeneration.test.js); workflow execution manual)

**Status:** Implemented

---

### REQ-OPS-021: Workflow-file static analysis

**Intent:** Defects in the CI workflows themselves — injection vectors, unpinned actions, invalid workflow files — are caught by automation instead of being discovered as failed or silently misbehaving runs.

**Applies To:** Operator

**Acceptance Criteria:**

1. The standalone zizmor SARIF audit runs on every pull request touching workflow files and on workflow-touching pushes to `main`; the required `workflow-audit` lane separately enforces the merge gate through PR Checks. <!-- @impl: .github/workflows/zizmor.yml::zizmor --> <!-- @impl: .github/workflows/test.yml::workflow-audit --> <!-- @test: host/__tests__/develop-required-checks.test.js (REQ-OPS-021 AC1: audits workflow changes on pull requests and main pushes and gates merges through workflow-audit) -->
2. The audit's findings upload as SARIF to code scanning. <!-- @impl: .github/workflows/zizmor.yml::zizmor --> <!-- @manual -->
3. An actionlint check validates every workflow file using a checksum-pinned binary, catching errors GitHub reports only as jobless validation failures. <!-- @impl: .github/workflows/test.yml::workflow-audit --> <!-- @manual -->
4. The merge-blocking audit runs inside the required status context and fails on any surviving finding, while the branch-filtered standalone workflow records the same audit as SARIF for alert history. <!-- @impl: .github/workflows/test.yml::workflow-audit --> <!-- @impl: .github/workflows/zizmor.yml::zizmor --> <!-- @manual -->

**Constraints:**

- The zizmor audit runs offline; its online known-vulnerable-actions audit fails fatally on advisory-API outages.
- Correct findings carry reasoned inline suppressions, and the auditor version is pinned.
- actionlint runs with its shellcheck integration enabled at `--severity=error` (syntax/error class only) to catch unparseable workflow `run:` scripts; its pyflakes integration stays disabled — deeper script hygiene is zizmor's concern.
- The actionlint version and checksum are a shadow pin: Dependabot cannot see them, so [REQ-OPS-020](#req-ops-020-shadow-pin-version-bump-automation) bumps them weekly.

**Priority:** P2

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-OPS-022: Coverage-threshold gate fails closed on missing evidence

**Intent:** Every affected pull request runs the existing package coverage gate, and coverage evidence fails closed when it is missing, malformed, below the practical global floor, or below the bounded changed-production-line floor.

**Applies To:** Operator

**Acceptance Criteria:**

1. The shared coverage action asserts the reporter produced its summary table before evaluating anything else, so a run that died before emitting coverage fails instead of passing on the absence of a failure string. <!-- @impl: scripts/ci/check-coverage-result.mjs::evaluateCoverageResult --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (fails closed on coverage evidence and bounds the backend crash exception) -->
2. A reported coverage-threshold miss is fatal regardless of exit status. <!-- @impl: scripts/ci/check-coverage-result.mjs::evaluateCoverageResult --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (fails closed on coverage evidence and bounds the backend crash exception) -->
3. A reported test failure inside the coverage run is fatal regardless of exit status. <!-- @impl: scripts/ci/check-coverage-result.mjs::evaluateCoverageResult --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (fails closed on coverage evidence and bounds the backend crash exception) -->
4. The known teardown-crash fingerprint is tolerated only for backend coverage and only after the table, test-failure, and threshold checks have all passed. <!-- @impl: scripts/ci/check-coverage-result.mjs::evaluateCoverageResult --> <!-- @impl: .github/actions/merge-coverage/action.yml::Merge shard coverage and enforce thresholds --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (fails closed on coverage evidence and bounds the backend crash exception) -->
5. Pull requests run backend and frontend coverage when their package path is affected; push, merge-group, scheduled, and manually dispatched full runs retain both package threshold gates. <!-- @impl: .github/workflows/test.yml::coverage-backend --> <!-- @impl: .github/workflows/test.yml::coverage-frontend --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-022 AC5: merges affected package coverage only after matrix tests) -->
6. Affected pull-request packages enforce bounded changed-production-line coverage against sub-100% floors and fail closed on missing, malformed, or incomplete evidence, except the closed Administration material-state UI owners assigned to user-owned Integration validation. <!-- @impl: scripts/ci/check-coverage-result.mjs::evaluateChangedLineCoverage --> <!-- @impl: .github/actions/merge-coverage/action.yml::Merge shard coverage and enforce thresholds --> <!-- @impl: .github/workflows/test.yml::coverage-frontend --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (REQ-OPS-022 AC6: bounded changed-production-line LCOV gate) -->

**Constraints:**

- The fingerprint appears after every passing run of the Workers pool, so it can never be the sole condition for tolerating a non-zero exit.
- `set -o pipefail` is required: without it `npm test | tee` reports tee's status and a failed threshold check passes.
- Changed-line enforcement is package-scoped and thresholded; it does not require 100% coverage per file and does not replace the existing global thresholds.
- Changed-line evidence follows destination paths for renames; deletions and test-only changes require no evidence.
- Manual-validation exceptions do not extend to backend contracts, shared frontend infrastructure, or non-Administration production code.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Automated tests ([suite-gates](../../src/__tests__/ci/suite-gates.test.ts), [workflow hardening](../../host/__tests__/ci-workflow-hardening.test.js)); exercise package coverage routing, coverage evidence failures, the bounded backend crash exception, and changed-line LCOV handling.

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
3. Deployments targeting the same environment are serialized without cancelling the active run, so a newer run cannot interrupt worker, secret, KV, or registry mutation mid-sequence. <!-- @impl: .github/workflows/deploy.yml::concurrency --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (deployment workflow safety) -->

**Constraints:** Called verification uses a per-run discriminator; deploy serialization remains environment-scoped.

**Priority:** P2

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated test ([deploy-requires-tests](../../host/__tests__/deploy-requires-tests.test.js))

**Status:** Implemented

---

### REQ-OPS-027: code-server coupled-pin automation

**Intent:** A code-server release update preserves the immutable relationship between its artifact, embedded Code source, and compatibility evidence.

**Applies To:** Operator

**Acceptance Criteria:**

1. code-server has a dedicated bump job whose compatibility PR runs the Browser IDE verification path. <!-- @impl: .github/workflows/bump-shadow-pins.yml::code-server --> <!-- @impl: .github/workflows/test.yml::browser-ide --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (routes owned Browser IDE paths through the workflow classifier while leaving docs-only changes inert) -->
2. The bump derives the packaged code-server commit and embedded Code version from the immutable release artifact. <!-- @impl: .github/workflows/bump-shadow-pins.yml::code-server --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (derives and cross-checks packaged provenance through the workflow command boundary) -->
3. The packaged code-server and Code metadata must agree with the product metadata before their pins are emitted. <!-- @impl: .github/workflows/bump-shadow-pins.yml::code-server --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (derives and cross-checks packaged provenance through the workflow command boundary) -->
4. The bump derives the embedded Code source commit from the immutable release gitlink. <!-- @impl: .github/workflows/bump-shadow-pins.yml::code-server --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (derives and cross-checks packaged provenance through the workflow command boundary) -->
5. Updating the coupled pins invalidates the code-server artifact checksum for operator review. <!-- @impl: scripts/ci/update-code-server-pins.mjs::updateCodeServerPins --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (updates every coupled runtime pin and invalidates the checksum atomically) -->

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
2. After an authoritative verification path succeeds, the final outcome job fails when no deployment occurred in a non-cancelled run. <!-- @impl: scripts/ci/assert-deploy-outcome.mjs::deployOutcome --> <!-- @impl: .github/workflows/deploy.yml::outcome --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (fails the outcome when no deployment occurred) -->

**Constraints:** Cancelled verification cannot count as successful verification, and workflow cancellation remains cancelled without forcing the outcome job to run.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline)

**Verification:** Automated test ([deploy-requires-tests](../../host/__tests__/deploy-requires-tests.test.js)) exercises the authoritative-path truth table, workflow-cancellation stop, and deployed/no-deploy outcomes.

**Status:** Implemented

---

### REQ-OPS-029: Automatic manual-deploy verification reuse

**Intent:** A manual deployment safely reuses existing exact-tree verification without requiring the operator to identify a workflow run.

**Applies To:** Operator

**Acceptance Criteria:**

1. Manual dispatch evaluates successful PR Checks runs for the dispatched head in descending creation order and reuses the first run with a valid exact-tree receipt. <!-- @impl: scripts/ci/validate-pr-checks-run.mjs::discoverSuccessfulRunIds --> <!-- @impl: .github/workflows/deploy.yml::verify-existing --> <!-- @test: host/__tests__/validate-pr-checks-run.test.js (automatic exact-tree PR Checks CLI resolution) -->
2. When no automatically discovered receipt validates, manual deployment runs PR Checks inline. <!-- @impl: scripts/ci/validate-pr-checks-run.mjs::resolveReusablePrChecksRun --> <!-- @impl: .github/workflows/deploy.yml::verify --> <!-- @test: host/__tests__/validate-pr-checks-run.test.js (automatic exact-tree PR Checks CLI resolution) --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (manual deploys cannot skip tests) --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-029 AC2: inline deploy verification grants every reusable-workflow permission) -->
3. An optional explicit run id checks only that run and fails closed instead of falling back. <!-- @impl: scripts/ci/validate-pr-checks-run.mjs::resolveReusablePrChecksRun --> <!-- @impl: .github/workflows/deploy.yml::verify-existing --> <!-- @test: host/__tests__/validate-pr-checks-run.test.js (automatic exact-tree PR Checks CLI resolution) --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (manual deploys cannot skip tests) -->

**Constraints:** Reuse requires the expected repository, workflow, head, required summary, receipt identity, and tested tree; status alone is insufficient.

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit), [REQ-OPS-028](#req-ops-028-deploy-verification-and-outcome-gate)

**Verification:** Automated test (host tests execute the resolver CLI through a fake GitHub boundary and evaluate the workflow gates).

**Status:** Implemented

---

### REQ-OPS-034: GitHub release signing eligibility

**Intent:** Release signing must accept only published or explicitly recovered source releases that belong to protected `main`.

**Applies To:** Operator

**Acceptance Criteria:**

1. Publishing a GitHub release starts signing automatically. <!-- @impl: .github/workflows/sign-release.yml::sign --> <!-- @test: host/__tests__/release-signing-workflow.test.js (REQ-OPS-034/REQ-OPS-035: keyless GitHub release signing) -->
2. An explicit tag input can recover or repeat signing for an existing release. <!-- @impl: .github/workflows/sign-release.yml::sign --> <!-- @test: host/__tests__/release-signing-workflow.test.js (REQ-OPS-034/REQ-OPS-035: keyless GitHub release signing) -->
3. Signing accepts only an exact semantic-version tag that names an existing non-draft release reachable from `main`. <!-- @impl: scripts/ci/sign-release.sh::validate_release_source --> <!-- @test: host/__tests__/release-signing-workflow.test.js (accepts only an existing semantic release reachable from main) -->
4. Recovery signing accepts dispatches only from `main`. <!-- @impl: scripts/ci/sign-release.sh::validate_release_source --> <!-- @test: host/__tests__/release-signing-workflow.test.js (accepts only an existing semantic release reachable from main) -->

**Constraints:** Repeated recovery signs the same validated tag commit.

**Priority:** P1

**Dependencies:** [REQ-OPS-019](#req-ops-019-security-posture-scanning-workflows)

**Verification:** Automated release-boundary tests and an observed signing run on a published release

**Status:** Implemented

---

### REQ-OPS-035: Keyless signed release artifacts

**Intent:** Every eligible source release provides artifacts whose origin, exact source revision, and post-publication integrity can be verified without a stored signing key.

**Applies To:** Release consumer

**Acceptance Criteria:**

1. The validated tag commit produces a deterministic, tag-prefixed source archive and checksum manifest. <!-- @impl: scripts/ci/sign-release.sh::build_release_assets --> <!-- @test: host/__tests__/release-signing-workflow.test.js (builds deterministic assets, signs both, and uploads the owned set) -->
2. Signing uses short-lived GitHub OIDC identity and reads no repository signing key or password. <!-- @impl: .github/workflows/sign-release.yml::sign --> <!-- @test: host/__tests__/release-signing-workflow.test.js (REQ-OPS-034/REQ-OPS-035: keyless GitHub release signing) --> <!-- @test: host/__tests__/release-signing-workflow.test.js (builds deterministic assets, signs both, and uploads the owned set) -->
3. The archive and checksum manifest receive self-contained Sigstore bundles. <!-- @impl: scripts/ci/sign-release.sh::sign_release_assets --> <!-- @test: host/__tests__/release-signing-workflow.test.js (builds deterministic assets, signs both, and uploads the owned set) -->
4. GitHub build-provenance attestations bind both release assets to the release workflow, repository, and exact source revision. <!-- @impl: .github/workflows/sign-release.yml::sign --> <!-- @test: host/__tests__/release-signing-workflow.test.js (REQ-OPS-034/REQ-OPS-035: keyless GitHub release signing) -->
5. The archive, checksum manifest, and both bundles upload to the matching release only after signing and attestation succeed. <!-- @impl: scripts/ci/sign-release.sh::upload_release_assets --> <!-- @test: host/__tests__/release-signing-workflow.test.js (builds deterministic assets, signs both, and uploads the owned set) -->

**Constraints:**

- Release signing is separate from deployment container provenance; neither substitutes for the other.
- Workflow dependencies and the Cosign release are immutable pins reviewed in source.
- The signing job alone receives least-privilege write, identity, and attestation permissions; repository-wide permissions remain read-only.
- The GitHub API token is step-scoped to release validation and upload; archive construction, installer, signing, and attestation steps do not receive it. <!-- @test: host/__tests__/ci-workflow-hardening.test.js (least-privilege workflow boundaries) -->
- A repeated recovery dispatch replaces only the four assets owned by this workflow.

**Priority:** P1

**Dependencies:** [REQ-OPS-034](#req-ops-034-github-release-signing-eligibility)

**Verification:** Automated artifact-boundary tests and an observed signing run on a published release

**Status:** Implemented

---

### REQ-OPS-036: Develop-only main promotion

**Intent:** Protected production branches accept promotion only from the reviewed `develop` branch, so feature branches cannot bypass the integration boundary.

**Applies To:** Maintainer

**Acceptance Criteria:**

1. Pull requests targeting `main` or `master` receive a `Develop promotion source` status check. <!-- @impl: .github/workflows/promotion-source.yml::promotion-source --> <!-- @test: host/__tests__/promotion-source.test.js (REQ-OPS-036: protected main promotion source) -->
2. The check succeeds only when the pull request head is the canonical repository's exact `develop` branch. <!-- @impl: .github/workflows/promotion-source.yml::promotion-source --> <!-- @test: host/__tests__/promotion-source.test.js (REQ-OPS-036: protected main promotion source) -->
3. Each existing `main` or `master` ruleset requires the `Develop promotion source` status before merge. <!-- @manual: Inspect the active GitHub ruleset and confirm `Develop promotion source` is required without bypass. -->

**Constraints:**

- GitHub permits creating other pull requests.
- The required status blocks noncanonical promotions from merging.
- A fork branch named `develop` cannot satisfy the promotion check.
- The validation command consumes pull-request metadata through environment variables and never executes branch or repository names as shell code.
- The policy check uses only event metadata and receives no repository permission. <!-- @test: host/__tests__/ci-workflow-hardening.test.js (least-privilege workflow boundaries) -->

**Priority:** P0

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Automated workflow and validator behavior for AC1 and AC2; live ruleset inspection for AC3

**Status:** Implemented

---

### REQ-OPS-037: Develop direct fast-forward repairs

**Intent:** Maintainers can repair the integration branch directly without weakening production promotion or allowing destructive history changes.

**Applies To:** Maintainer

**Acceptance Criteria:**

1. The active `develop` ruleset permits direct pushes without a pull-request requirement. <!-- @manual: Inspect GitHub ruleset 19216590 and confirm no pull_request rule. -->
2. The active `develop` ruleset does not require pre-push status contexts. <!-- @manual: Inspect GitHub ruleset 19216590 and confirm no required_status_checks rule. -->
3. The active `develop` ruleset blocks branch deletion. <!-- @manual: Inspect GitHub ruleset 19216590 and confirm the deletion rule. -->
4. The active `develop` ruleset blocks non-fast-forward updates. <!-- @manual: Inspect GitHub ruleset 19216590 and confirm the non_fast_forward rule. -->

**Constraints:** Production promotion remains governed by [REQ-OPS-036](#req-ops-036-develop-only-main-promotion).

**Priority:** P1

**Dependencies:** [REQ-OPS-036](#req-ops-036-develop-only-main-promotion)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-OPS-038: Build-selected coding-agent CLIs

**Intent:** An operator can build a smaller deployment image containing only the shared coding-agent launchers that environment offers.

**Applies To:** Operator

**Acceptance Criteria:**

1. An environment-scoped deployment value selects a non-empty subset of supported coding agents. <!-- @impl: .github/workflows/deploy.yml::prepare --> <!-- @impl: scripts/ci/coding-agent-selection.mjs::resolveCodingAgents --> <!-- @test: host/__tests__/coding-agent-selection.test.js (REQ-OPS-038: deployment coding-agent selection) -->
2. An absent or empty environment-scoped deployment value preserves the full supported coding-agent set; deployment normalizes that case before invoking the selector. <!-- @impl: .github/workflows/deploy.yml::prepare --> <!-- @impl: scripts/ci/coding-agent-selection.mjs::resolveCodingAgents --> <!-- @test: host/__tests__/coding-agent-selection.test.js (defaults to every coding agent and canonicalizes a configured subset) --> <!-- @test: host/__tests__/coding-agent-selection.test.js (passes the environment-scoped selection through deployment and image identity) -->
3. An explicitly empty selector input or any unknown selection fails before image construction. <!-- @impl: scripts/ci/coding-agent-selection.mjs::resolveCodingAgents --> <!-- @test: host/__tests__/coding-agent-selection.test.js (rejects empty explicit sets and unknown agent names) -->
4. Equivalent selections produce one canonical image identity. <!-- @impl: .github/workflows/container-image.yml::hash --> <!-- @test: host/__tests__/container-image-input-hash.test.js (deployment container image input hash) -->
5. Different selected sets produce different image identities. <!-- @impl: .github/workflows/container-image.yml::hash --> <!-- @test: host/__tests__/container-image-input-hash.test.js (deployment container image input hash) -->

**Constraints:** Package versions remain exact, lock-backed or checksum-pinned inputs governed by normal bump review.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents), [REQ-OPS-014](#req-ops-014-container-binding-and-scaling-from-image)

**Verification:** Automated selector and image-identity tests

**Status:** Implemented

---

### REQ-OPS-040: Selected coding-agent packaging

**Intent:** The image packages exactly the shared coding-agent launchers selected by the operator.

**Applies To:** Operator

**Acceptance Criteria:**

1. Every selected lock-backed npm agent launcher is installed. <!-- @impl: Dockerfile::CODEFLARE_CODING_AGENTS --> <!-- @impl: scripts/ci/coding-agent-selection.mjs::selectedNpmManifest --> <!-- @test: host/__tests__/coding-agent-selection.test.js (derives an npm manifest containing only selected coding agents plus shared tools) --> <!-- @manual: Inspect selected packaged-image agentVersions evidence. -->
2. Every omitted npm agent launcher is absent. <!-- @impl: Dockerfile::CODEFLARE_CODING_AGENTS --> <!-- @impl: scripts/ci/coding-agent-selection.mjs::selectedNpmManifest --> <!-- @test: host/__tests__/coding-agent-selection.test.js (derives an npm manifest containing only selected coding agents plus shared tools) --> <!-- @manual: Inspect omitted packaged-image agentVersions evidence. -->
3. The Antigravity launcher is installed only when selected. <!-- @impl: Dockerfile::CODEFLARE_CODING_AGENTS --> <!-- @manual: Inspect packaged-image agentVersions evidence for selections with and without Antigravity. -->
4. Installed npm agents retain only their canonical Linux x64 runtime payloads; alternate operating-system, architecture, baseline, and musl payloads are removed before image commit. <!-- @impl: scripts/ci/prune-npm-platform-artifacts.mjs::pruneNpmPlatformArtifacts --> <!-- @impl: Dockerfile::CODEFLARE_CODING_AGENTS --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifySelectedAgentPackages --> <!-- @test: host/__tests__/npm-platform-pruning.test.js (REQ-OPS-040: Linux coding-agent package pruning) --> <!-- @test: host/__tests__/coding-agent-selection.test.js (the complete-image smoke rejects alternate platform packages after pruning) --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-002 AC7 + REQ-OPS-003 AC7: PR Checks never build images and deployment runs every packaged smoke gate) -->

**Constraints:** Every packaged launcher remains exact-version lock-backed or checksum-pinned.

**Priority:** P1

**Dependencies:** [REQ-OPS-038](#req-ops-038-build-selected-coding-agent-clis), [REQ-OPS-033](#req-ops-033-lock-backed-npm-bump-coherence)

**Verification:** Automated manifest and platform-pruning tests; reduced complete-image deployment evidence

**Status:** Implemented

---

### REQ-OPS-039: Reduced-image capability preservation

**Intent:** Reducing shared agent launchers does not remove unrelated tools or platform-owned fast-start and Browser IDE capabilities.

**Applies To:** Operator

**Acceptance Criteria:**

1. Shared non-agent npm tools remain installed for every valid selection. <!-- @impl: scripts/ci/coding-agent-selection.mjs::selectedNpmManifest --> <!-- @test: host/__tests__/coding-agent-selection.test.js (derives an npm manifest containing only selected coding agents plus shared tools) -->
2. Pi extension startup remains prewarmed even when the shared Pi launcher is omitted. <!-- @impl: Dockerfile::PI_CODING_AGENT_DIR --> <!-- @manual: Run complete-image smoke for a selection without Pi and inspect prewarm evidence. -->
3. Native Pi and official Claude Browser IDE inventories remain packaged for every selection. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::main --> <!-- @manual: Run complete-image smoke for a reduced selection and inspect native inventory evidence. -->
4. Packaged-image verification starts every selected launcher. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifySelectedAgentLaunchers --> <!-- @test: host/__tests__/coding-agent-selection.test.js (the packaged-image smoke starts selected launchers and requires omitted launchers to be absent) -->
5. Packaged-image verification rejects an omitted launcher that remains on the shared path. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifySelectedAgentLaunchers --> <!-- @test: host/__tests__/coding-agent-selection.test.js (the packaged-image smoke starts selected launchers and requires omitted launchers to be absent) -->
6. Deployment records complete-image byte size as evidence. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual: Inspect image_bytes in complete-image deployment evidence. -->
7. Deployment does not reject an image against a fixed byte ceiling. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual: Inspect complete-image deployment policy for the absence of a fixed ceiling. -->

**Constraints:** Selection affects shared coding-agent launchers only; prewarm and native IDE assets remain platform-owned.

**Priority:** P1

**Dependencies:** [REQ-OPS-038](#req-ops-038-build-selected-coding-agent-clis), [REQ-IDE-005](browser-ide.md#req-ide-005-selected-native-ide-agent)

**Verification:** Automated manifest and packaged-smoke behavior tests; complete-image deployment evidence

**Status:** Implemented

---

### REQ-OPS-031: Trusted deployment container build cache

**Intent:** Deployment can reuse trusted container build work without exposing mutable cache state to pull requests.

**Applies To:** Contributor

**Acceptance Criteria:**

1. Deployment imports and exports one GHCR BuildKit cache reference. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-031 AC1 + AC2 + AC5: deployment alone imports and publishes the shared cache) -->
2. PR Checks neither authenticate to nor read or write the shared mutable cache. <!-- @impl: .github/workflows/test.yml::summary --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-031 AC3: PR Checks never authenticate to the container cache) -->
3. Fork pull requests and Dependabot therefore receive no container-cache credentials. <!-- @impl: .github/workflows/test.yml::summary --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-031 AC3: PR Checks never authenticate to the container cache) -->
4. Shared-cache login unavailability does not fail deployment image builds. <!-- @impl: scripts/ci/container-build-cache-policy.mjs::sharedCacheEnabled --> <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-031 AC4: cache login unavailability cannot block deployment image builds) -->
5. Deployment cache-export unavailability does not fail the image build. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-031 AC1 + AC2 + AC5: deployment alone imports and publishes the shared cache) -->

**Constraints:**

- Pull-request jobs receive no Cloudflare or Docker Hub deployment credentials.
- Shared cache use is optional and never replaces deployment's complete-image smoke, vulnerability scan, SBOM, digest, provenance, or attestation gates.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push)

**Verification:** Automated test (workflow-structure and fake-Docker tests execute cache-enabled and cache-unavailable build paths and assert the exact import/export arguments and permissions).

**Status:** Implemented

---

### REQ-OPS-042: Retained container image provenance

**Intent:** A retained image can bypass build and scan only when its exact registry digest carries verifiable Codeflare build provenance.

**Applies To:** Operator

**Acceptance Criteria:**

1. Reuse selection operates on a digest-pinned registry URI. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: host/__tests__/container-image-reuse-provenance.test.js (fails closed on missing provenance or malformed identities) -->
2. Provenance verifies against Codeflare's reusable image workflow and SLSA provenance predicate. <!-- @impl: scripts/ci/verify-container-provenance.sh::SIGNER_WORKFLOW --> <!-- @test: host/__tests__/container-image-reuse-provenance.test.js (cryptographically verifies the digest against the owned reusable workflow) -->
3. Successful verification publishes reuse. <!-- @impl: scripts/ci/select-container-reuse.sh::reused=true --> <!-- @test: host/__tests__/container-image-reuse-provenance.test.js (publishes reuse only when provenance verification succeeds) -->
4. A reused deployment binds the exact verified digest rather than its mutable tag. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/container-image-reuse-provenance.test.js (binds retained deployments to the verified digest instead of the mutable tag) -->
5. Failed verification publishes no reuse. <!-- @impl: scripts/ci/select-container-reuse.sh::Existing image has no valid Codeflare build provenance --> <!-- @test: host/__tests__/container-image-reuse-provenance.test.js (publishes reuse only when provenance verification succeeds) -->
6. Build, packaged smoke, vulnerability scan, and push are each gated on no reuse. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: host/__tests__/container-image-reuse-provenance.test.js (gates required fresh-image stages on no reuse) -->

**Constraints:** Cache bust and uncovered Dockerfile sources disable reuse before provenance selection; registry credentials remain short-lived and step-scoped; retained-image deployment requires the exported verified digest.

**Priority:** P0

**Dependencies:** [REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push), [REQ-SEC-011](security.md#req-sec-011-container-image-scanned-for-cves-before-deploy)

**Verification:** Automated provenance and reuse-selection boundary tests; deployment image evidence

**Status:** Implemented

---

### REQ-OPS-043: Isolated nightly full-matrix verification

**Intent:** Nightly verification reuses the complete PR Checks matrix without sharing the workflow identity that authorizes production deployment.

**Applies To:** Maintainer

**Acceptance Criteria:**

1. A separately named workflow schedules the reusable PR Checks matrix nightly at 03:30 UTC. <!-- @impl: .github/workflows/nightly-pr-checks.yml::full-matrix --> <!-- @test: host/__tests__/nightly-pr-checks-routing.test.js (keeps scheduled verification outside the deploy-triggering workflow identity) -->
2. The nightly call runs the canonical full matrix without copying its lanes. <!-- @impl: .github/workflows/nightly-pr-checks.yml::full-matrix --> <!-- @test: host/__tests__/nightly-pr-checks-routing.test.js (calls the canonical full matrix without copying any test lane) -->
3. Deploy continues listening only to the direct `PR Checks` workflow identity. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/nightly-pr-checks-routing.test.js (keeps scheduled verification outside the deploy-triggering workflow identity) -->

**Constraints:** The required `test` context and direct PR Checks entry points remain unchanged; the nightly caller receives no secrets.

**Priority:** P1

**Dependencies:** [REQ-OPS-001](#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Automated workflow-routing contract; next scheduled-run evidence

**Status:** Implemented

---

### REQ-OPS-044: Read-only stress target verification

**Intent:** Stress Test validates an already provisioned integration deployment without repairing or mutating it before measurement.

**Applies To:** Operator

**Acceptance Criteria:**

1. Stress Test writes its configured target through the validated HTTPS-origin output boundary. <!-- @impl: scripts/ci/normalize-https-origin.mjs::appendFileSync --> <!-- @impl: .github/workflows/stress-test.yml::setup --> <!-- @test: host/__tests__/normalize-https-origin.test.js (writes a validated named workflow output when requested) --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (limits stress setup to probe credentials and validated target steps) -->
2. Smoke verification consumes the validated target output. <!-- @impl: .github/workflows/stress-test.yml::setup --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (limits stress setup to probe credentials and validated target steps) -->
3. Setup contains only checkout, Node setup, target normalization, and smoke verification steps. <!-- @impl: .github/workflows/stress-test.yml::setup --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (limits stress setup to probe credentials and validated target steps) -->
4. Setup receives only the three service-auth probe credentials. <!-- @impl: .github/workflows/stress-test.yml::setup --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (limits stress setup to probe credentials and validated target steps) -->

**Constraints:** The workflow targets integration only; Deploy owns service-auth secret and service-user provisioning.

**Priority:** P2

**Dependencies:** [REQ-OPS-008](#req-ops-008-stress-testing-validates-rate-limits-and-concurrency), [REQ-OPS-013](#req-ops-013-deploy-command-and-post-deploy-hooks)

**Verification:** Automated target-output and workflow-boundary tests; stress-run evidence

**Status:** Implemented

---

### REQ-OPS-045: Parallel PR Checks performance

**Intent:** Affected pull requests receive complete required-check feedback within the operational target without serializing independent workloads.

**Applies To:** Maintainer

**Acceptance Criteria:**

1. An affected exact-head PR Checks run completes within three minutes. Exact-head run `31314628668` completed the affected gate in 90 seconds and the workflow in 91 seconds. <!-- @manual: Confirm the monitored exact-head PR Checks run and affected gate both complete in under three minutes; retain the run ID and elapsed durations as reproducible evidence. -->
2. Every affected workload starts directly after classification. <!-- @impl: .github/workflows/test.yml::jobs --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-045 AC2: starts every affected workload directly after classification) -->
3. Backend, frontend, and host matrices expose every configured leg concurrently. <!-- @impl: .github/workflows/test.yml::backend-tests --> <!-- @impl: .github/workflows/test.yml::frontend-tests --> <!-- @impl: .github/workflows/test.yml::host-tests --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-045 AC3: exposes every backend, frontend, and host matrix leg concurrently) -->
4. Changes to shared landing runtime source trigger the landing verification lane as well as their owning source lane. <!-- @impl: .github/workflows/test.yml::landing --> <!-- @impl: .github/workflows/test.yml::backend --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (REQ-OPS-045 AC4: runs landing verification when the shared design-ready gate changes) -->
5. An unchanged, valid external tool archive is reused without a network download. <!-- @impl: .github/workflows/test.yml::workflow-audit --> <!-- @impl: .github/workflows/test.yml::host-tests --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (REQ-OPS-045 AC5: downloads a missing archive once and reuses the valid archive) -->
6. A corrupted or mismatched restored external tool archive is rejected before extraction or execution. <!-- @impl: .github/workflows/test.yml::workflow-audit --> <!-- @impl: .github/workflows/test.yml::host-tests --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (REQ-OPS-045 AC6: rejects a corrupted restored archive before extraction or execution) -->

**Constraints:** Path filtering may skip unaffected lanes; full-run coverage policy remains owned by [REQ-OPS-022](#req-ops-022-coverage-threshold-gate-fails-closed-on-missing-evidence).

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit), [REQ-OPS-022](#req-ops-022-coverage-threshold-gate-fails-closed-on-missing-evidence)

**Verification:** Automated direct-start, matrix-concurrency, cache-reuse, and integrity-rejection tests; manual exact-head duration check

**Status:** Implemented

---

### REQ-OPS-047: Cleanup-safe synchronization state

**Intent:** Clearing disposable temporary files must not break synchronization in a running container.

**Applies To:** Operator

**Acceptance Criteria:**

1. Required synchronization state remains outside disposable temporary storage. <!-- @impl: entrypoint.sh::CODEFLARE_RUNTIME_ROOT --> <!-- @impl: host/src/runtime-paths.ts::SYNC_RUNTIME_DIR --> <!-- @test: host/__tests__/runtime-paths.test.js (keeps required host runtime paths outside disposable /tmp) -->
2. Baseline sync uses its protected work directory after disposable files are cleared. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/runtime-paths.test.js (REQ-OPS-047 AC2: passes the protected rclone workdir through establish_bisync_baseline after disposable cleanup) -->
3. Periodic sync uses its protected work directory after disposable files are cleared. <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/runtime-paths.test.js (REQ-OPS-047 AC3: passes the protected rclone workdir through bisync_with_r2 after disposable cleanup) -->
4. The cadence daemon invokes periodic sync from that state. <!-- @impl: entrypoint.sh::start_sync_daemon --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)) -->
5. Manual sync requests use the protected daemon PID and status files. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (REQ-SESSION-011 AC2: the production adapter reads the PID, delivers SIGUSR1, reads status, and returns 200) -->
6. Sync health reporting reads the protected status file. <!-- @impl: host/src/metrics.ts::getSyncStatus --> <!-- @test: host/__tests__/metrics.test.js (returns parsed sync status from file) -->
7. Final sync uses the same protected daemon state as manual sync. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (REQ-SESSION-011 AC2: signals the daemon and waits for syncing-to-success before returning 200) -->

**Constraints:** Synchronization runtime state remains container-scoped and is not synced to R2. Build-stage files and disposable caches or counters may remain under `/tmp`.

**Priority:** P0

**Dependencies:** [REQ-OPS-010](#req-ops-010-graceful-container-shutdown-preserves-data), [REQ-STOR-002](storage.md#req-stor-002-bidirectional-sync-with-r2)

**Verification:** Runtime-path, baseline, cadence, trigger, health, and final-sync tests

**Status:** Implemented

---

### REQ-OPS-048: Cleanup-safe service and Browser IDE state

**Intent:** Clearing disposable temporary files must not break service lifecycle or Browser IDE continuity.

**Applies To:** Operator

**Acceptance Criteria:**

1. Shutdown reads service PID files from protected runtime storage. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010 AC3 / REQ-OPS-048 AC1: trap handler kills services through protected runtime PID files) -->
2. Host health reports live readiness independently of disposable files. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/request-router.test.js (REQ-OPS-048 AC2: serves /health auth-exempt and reads readiness flags live) -->
3. Browser IDE restart requests use the protected trigger file. <!-- @impl: host/src/vscode-proxy.ts::requestOpenvscodeStart --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-OPS-048 AC3: writes the protected restart trigger on first call) -->
4. Browser IDE data and extension roots remain in protected runtime storage. <!-- @impl: entrypoint.sh::_openvscode_launch_once --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (REQ-IDE-039 AC1 / REQ-OPS-048 AC4: code-server uses protected data and extension roots) -->
5. Extension state capture remains operational through its protected session paths. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence --> <!-- @test: openvscode/agent-sidebar/test/extension-persistence.test.ts (REQ-IDE-016 AC4 + REQ-IDE-036 AC4+AC5+AC6 + REQ-IDE-038 AC5 + REQ-OPS-048 AC5: capture preserves state) -->

**Constraints:** Service and Browser IDE runtime data remains container-scoped and is not synced to R2.

**Priority:** P0

**Dependencies:** [REQ-OPS-010](#req-ops-010-graceful-container-shutdown-preserves-data), [REQ-IDE-003](browser-ide.md#req-ide-003-ide-lifecycle-and-availability)

**Verification:** Shutdown, readiness, restart-trigger, editor-launch, and state-capture tests

**Status:** Implemented

---

### REQ-OPS-049: Cleanup-safe coordination and background work

**Intent:** Clearing disposable temporary files must not break agent coordination or background monitoring.

**Applies To:** Operator

**Acceptance Criteria:**

1. Context-mode preload scratch remains under the protected runtime temporary root. <!-- @impl: entrypoint.sh::configure_pi_jiti_runtime_cache --> <!-- @test: host/__tests__/entrypoint-context-mode-runtime.test.js (REQ-OPS-049 AC1: routes context-mode preload scratch through protected runtime TMPDIR) -->
2. Claude active-repository publication acquires the protected global graph lock. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::/run/codeflare/locks/graphify-global.lock --> <!-- @test: host/__tests__/graphify-active-repo.test.js (REQ-VAULT-014 AC1/AC2 / REQ-OPS-049 AC2: reconciles a repo switch under one protected lock) -->
3. Pi memory and Vault publication acquires the protected global graph lock. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::GLOBAL_GRAPH_LOCK --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-VAULT-004 / REQ-OPS-049 AC3: memory-vault.ts publishes through the protected global graph lock) -->
4. Attached Claude CI monitoring creates no script, PID, or result-log artifact in disposable storage. <!-- @impl: preseed/agents/claude/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @manual -->

**Constraints:** Coordination locks remain container-scoped and are not synced to R2; attached monitor state remains task-scoped.

**Priority:** P0

**Dependencies:** [REQ-VAULT-004](vault.md#req-vault-004-unified-global-knowledge-graph), [REQ-AGENT-070](agents.md#req-agent-070-claude-on-demand-ci-monitoring-policy)

**Verification:** Automated and manual verification

**Status:** Implemented

---

### REQ-OPS-050: Hosted image-build critical-path optimization

**Intent:** Fresh container image assembly retains expensive dependency layers while producing bounded timing evidence on the standard GitHub-hosted runner.

**Applies To:** Operator

**Acceptance Criteria:**

1. Pi extension-only edits retain the expensive Pi dependency/toolchain layer while still invalidating extension Jiti prewarm. <!-- @impl: Dockerfile::preseed/agents/pi/extensions --> <!-- @manual: Confirm exact-head BuildKit output reuses the Pi dependency layer and rebuilds extension prewarm after an extension-only edit. -->
2. Browser IDE source and generated seed edits retain unrelated runtime dependency layers while still invalidating their late final-image assembly. <!-- @impl: Dockerfile::openvscode-agent-sidebar-builder --> <!-- @impl: Dockerfile::agent-seed bake materialized --> <!-- @manual: Confirm exact-head BuildKit output reuses unrelated dependency layers and rebuilds late IDE and seed assembly. -->
3. Every fresh build uploads plain BuildKit output as bounded layer-timing evidence. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual: Confirm the exact-head deployment retains the uploaded BuildKit timing artifact. -->

**Constraints:** The pipeline stays on `ubuntu-latest`; no self-hosted or larger-runner dependency is introduced.

**Priority:** P1

**Dependencies:** [REQ-OPS-031](#req-ops-031-shared-deployment-buildkit-cache)

**Verification:** Exact-head fresh-image cache and timing evidence

**Status:** Implemented

---

### REQ-OPS-051: Image-owned Oxlint lifecycle

**Intent:** Every session image provides one exact-pinned Oxlint installation without coupling it to managed runtime compatibility.

**Applies To:** Operator

**Acceptance Criteria:**

1. The image-owned Oxlint manifest contains one exact pin. <!-- @impl: image/oxlint/package.json::oxlint --> <!-- @test: host/__tests__/dockerfile-dependency-integrity.test.js (image-owned Oxlint has an exact pin and complete committed integrity tree) -->
2. The dedicated Oxlint lock matches that manifest and contains a complete integrity tree. <!-- @impl: image/oxlint/package-lock.json::packages --> <!-- @test: host/__tests__/dockerfile-dependency-integrity.test.js (image-owned Oxlint has an exact pin and complete committed integrity tree) -->
3. Packaged-image smoke executes Oxlint and verifies its exact version. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyOxlintRuntime --> <!-- @test: host/__tests__/coding-agent-selection.test.js (REQ-OPS-051 AC3: packaged-image smoke executes exact image-owned Oxlint) -->
4. Oxlint remains outside managed and shared runtime manifests. <!-- @impl: scripts/agent-seed-core.mjs::MANAGED_RUNTIME_LOCK_PATHS --> <!-- @impl: preseed/npm-tools/package.json::dependencies --> <!-- @impl: preseed/agents/pi/package.json::dependencies --> <!-- @test: host/__tests__/dockerfile-dependency-integrity.test.js (image-owned Oxlint stays outside managed and shared runtime manifests) -->
5. The dedicated Oxlint lock receives cooldown-backed weekly dependency updates. <!-- @impl: .github/dependabot.yml::/image/oxlint --> <!-- @test: host/__tests__/dockerfile-dependency-integrity.test.js (image-owned Oxlint has dedicated weekly dependency automation) -->

**Constraints:** Oxlint remains outside the managed seed and shared npm-tool manifest.

**Priority:** P1

**Dependencies:** [REQ-OPS-039](#req-ops-039-reduced-image-capability-preservation)

**Verification:** Packaged-image smoke; dependency-integrity and dependency-automation tests

**Status:** Implemented

---

### REQ-OPS-052: Concurrent image security preparation

**Intent:** Independent image-security and publication prerequisites run concurrently without weakening vulnerability enforcement, SBOM retention, or scan-before-push ordering.

**Applies To:** Operator

**Acceptance Criteria:**

1. After one vulnerability-database preparation, vulnerability scanning, CycloneDX generation, and registry-tool preparation run concurrently and are all awaited. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual: Confirm exact-head job timing shows all three prerequisites overlap and complete before enforcement. -->
2. A failure from vulnerability scanning, CycloneDX generation, or registry-tool preparation blocks image publication. <!-- @impl: scripts/ci/image-prerequisite-gate.sh::wait_for_image_prerequisites --> <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @test: host/__tests__/container-image-speed.test.js (blocks publication when any concurrent image prerequisite fails) -->
3. Bounded vulnerability validation completes before image push. <!-- @impl: scripts/ci/validate-trivy-result.mjs::validateTrivyResult --> <!-- @test: host/__tests__/trivy-exception-gate.test.js (Trivy bounded exception gate) -->
4. The SBOM uploads before image push, preserving the inventory if later publication fails. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual: Confirm exact-head job ordering uploads the SBOM before image publication. -->
5. Trivy scratch and database-cache directories are writable by the runner account. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual: Confirm exact-head scan and SBOM processes write successfully to their isolated scratch and cache directories. -->
6. Daily Trivy database-cache metadata restores without an ownership or timestamp warning. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual: Confirm a fresh deployment restores the daily Trivy DB cache without a tar ownership or timestamp warning. -->
7. Concurrent Trivy image traversals complete without a shared cache-lock collision. <!-- @impl: .github/workflows/container-image.yml::image --> <!-- @manual: Confirm exact-head concurrent scan and SBOM generation complete without a cache-lock error. -->

**Constraints:** Image push remains strictly after packaged smoke, vulnerability enforcement, and SBOM generation.

**Priority:** P1

**Dependencies:** [REQ-OPS-002](#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push), [REQ-OPS-050](#req-ops-050-hosted-image-build-critical-path-optimization)

**Verification:** Behavioral prerequisite-failure tests; exact-head workflow order, scan, and SBOM evidence

**Status:** Implemented

---

### REQ-OPS-053: Dependency-review evidence exceptions

**Intent:** Dependency Review retains vulnerability, license, and OpenSSF evidence while narrowly handling verified upstream metadata gaps.

**Applies To:** Maintainer

**Acceptance Criteria:**

1. Vulnerability checks, license checks, and available OpenSSF scores remain enabled. <!-- @impl: .github/workflows/test.yml::dependency-review --> <!-- @test: host/__tests__/develop-required-checks.test.js (REQ-OPS-053: dependency-review evidence policy) -->
2. License exceptions contain only the six exact Codex platform package releases whose committed lock metadata declares Apache-2.0. <!-- @impl: .github/workflows/test.yml::dependency-review --> <!-- @test: host/__tests__/develop-required-checks.test.js (REQ-OPS-053: dependency-review evidence policy) --> <!-- @test: host/__tests__/dockerfile-dependency-integrity.test.js (Codex platform license exceptions match exact Apache-2.0 lock metadata) -->
3. A future Codex platform version does not inherit the current license exception. <!-- @impl: .github/workflows/test.yml::dependency-review --> <!-- @test: host/__tests__/develop-required-checks.test.js (REQ-OPS-053: dependency-review evidence policy) -->

**Constraints:** Unknown OpenSSF scores remain visible and informational; Codeflare does not fabricate or suppress unavailable upstream scores.

**Priority:** P1

**Dependencies:** [REQ-OPS-003](#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)

**Verification:** Dependency Review configuration and committed-lock metadata tests

**Status:** Implemented

---

### REQ-OPS-056: Non-destructive D1 deployment boundary

**Intent:** Historical usage storage is created and migrated before a D1-aware Worker deploy through the established deployment credential.

**Applies To:** Operator

**Acceptance Criteria:**

1. Every deployment environment owns one exact `${WORKER_NAME}-usage` database bound once as `USAGE_DB`; account-specific IDs are never committed. <!-- @impl: wrangler.toml::USAGE_DB --> <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 --> <!-- @test: src/__tests__/ci/usage-d1-deploy.test.ts (D1 deployment boundary (REQ-OPS-056)) -->
2. Deploy preflight requires the established deployment credential, proves D1 list permission, and stops before mutation on missing or insufficient credentials. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: src/__tests__/ci/usage-d1-deploy.test.ts (D1 deployment boundary (REQ-OPS-056)) -->
3. Successful listing resolves one exact database, creates only when absent, rejects duplicate names, and fails closed on list errors. <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 --> <!-- @test: src/__tests__/ci/usage-d1-deploy.test.ts (D1 deployment boundary (REQ-OPS-056)) -->
4. The temporary Wrangler configuration contains exactly one resolved binding, generated Worker types validate, and committed additive migrations run before Worker deployment. <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 --> <!-- @impl: migrations/usage/0001_initial.sql::usage_users --> <!-- @test: src/__tests__/ci/usage-d1-deploy.test.ts (D1 deployment boundary (REQ-OPS-056)) -->
5. Migration failure leaves the deployed Worker unchanged; later Worker failure leaves an additive database that the prior Worker safely ignores. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: src/__tests__/ci/usage-d1-deploy.test.ts (D1 deployment boundary (REQ-OPS-056)) -->
6. Existing KV, R2, Durable Object state, users, sessions, and containers are never reset or migrated by D1 provisioning. <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 --> <!-- @test: src/__tests__/ci/usage-d1-deploy.test.ts (D1 deployment boundary (REQ-OPS-056)) -->
7. After deployment, the established credential remains available to existing Worker runtime operations. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: host/__tests__/ci-workflow-hardening.test.js (REQ-OPS-056 AC7: preserves the established credential through deployment and Worker secret upload) -->

**Constraints:** GitHub Actions cannot create or widen its own secret. Missing D1 permission is an external blocker.

**Priority:** P0

**Dependencies:** [REQ-OPS-013](#req-ops-013-deploy-command-and-post-deploy-hooks), [AD150](../../documentation/decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records)

**Verification:** Fake-Wrangler behavioral tests for preflight, resolution, creation, migration, and fail-closed ordering

**Status:** Implemented

---

### REQ-OPS-057: Bounded administration operation envelope

**Intent:** Administration and analytics remain affordable and observable at 2,000 active developers with three sessions each.

**Applies To:** Operator

**Acceptance Criteria:**

1. Stable visible session status polls every 60 seconds, transitions poll every five seconds, hidden pages stop polling, and recursive scheduling prevents overlap. <!-- @impl: web-ui/src/stores/session-polling.ts::startSessionListPolling --> <!-- @manual -->
2. Batch status always returns core status, reads usage only for `include=usage`, reads storage only for `include=storage`, and rejects unknown include values. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @impl: web-ui/src/api/client.ts::getBatchSessionStatus --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-OPS-057 AC2: closed optional batch-status reads) -->
3. Analytics, Reports, and Activity read only on navigation, filters, explicit refresh, or run reconnect; none background-polls. <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage --> <!-- @impl: web-ui/src/components/admin/ReportsPage.tsx::ReportsPage --> <!-- @impl: web-ui/src/components/admin/ActivityPage.tsx::ActivityPage --> <!-- @manual -->
4. Production and Enterprise use `head_sampling_rate = 0.05`; Integration targets retain `1`, successful pings emit no custom logs, and structured failures remain discoverable. <!-- @impl: scripts/ci/set-head-sampling.mjs::setHeadSampling --> <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: src/__tests__/ci/usage-d1-deploy.test.ts (observability deployment boundary (REQ-OPS-057)) -->
5. Sampled D1 metrics record rows read, rows written, and SQL duration without user or secret material. <!-- @impl: src/lib/admin-usage.ts::writeUsageHistory --> <!-- @test: src/__tests__/lib/admin-usage.test.ts (logs bounded D1 metrics without user or secret material (REQ-OPS-057 AC5)) -->
6. CI models 2,000 active users and three sessions, enforcing one sub-4-KB state write and zero KV reads per positive ping plus the approved D1 row ceilings. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @impl: src/timekeeper/accounting.ts::applyPositiveDelta --> <!-- @test: src/__tests__/timekeeper/accounting-load.test.ts (historical accounting operation fixture (REQ-OPS-057 AC6)) -->
7. Integration exception-visibility evidence is a required rollout gate before sampled Production promotion, and account operation and spend alerts must precede Production history enablement. <!-- @impl: documentation/lanes/administration-analytics.md::Integration acceptance checklist --> <!-- @manual -->

**Constraints:** Cloudflare platform capacity remains contractually external. No queue, cache, coordinator, or second database is introduced for cost control.

**Priority:** P1

**Dependencies:** [REQ-SUB-025](subscription.md#req-sub-025-durable-historical-usage-accounting), [REQ-OPS-056](#req-ops-056-non-destructive-d1-deployment-boundary)

**Verification:** Automated optional-read, logging-config, and representative-load tests; polling and exception visibility evidence remains required from Integration before goal completion

**Status:** Implemented

---
