# Operations

CI/CD pipeline, testing strategy, deployment workflow, container sizing, and cost model.

**Domain owner:** GitHub Actions workflows, deploy.yml, container-image.yml, test.yml, pentest.yml, fuzz.yml, stress-test.yml

### Key Concepts

- **Deploy Pipeline** -- The `deploy.yml` workflow, gated on a green PR Checks run for the same SHA (workflow_run): prepare resolves the target, worker assets build in parallel with the container image (built, scanned, and pushed by the reusable `container-image.yml`, which reuses the existing image when its inputs are unchanged), then the deploy job applies config, runs `wrangler deploy`, sets secrets in bulk, and smoke-checks `/health`. The single path from code to production.
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
3. The deploy pipeline runs as staged jobs: prepare resolves the target, worker assets and the container image (build, scan, push) proceed in parallel, then the deploy job applies config, deploys, sets secrets, and smoke-checks health. <!-- @impl: .github/workflows/deploy.yml::prepare --> <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual -->
4. Dependencies are cached between runs for faster pipeline execution. <!-- @manual -->
5. Frontend and landing assets are built once and handed to the deploy job as an artifact; no deployment step runs unless the gating PR Checks run for the same SHA ended green (tests are not re-run in-deploy). <!-- @impl: .github/workflows/deploy.yml::build-worker --> <!-- @manual -->
6. The KV namespace is resolved or created and applied to the deployment configuration. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) --> <!-- @manual -->

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
3. The workflow runs the backend suite (four vitest shards, each pool parallel), frontend (build + tests), landing, and host suites as parallel jobs. <!-- @impl: .github/actions/backend-tests/action.yml --> <!-- @manual -->
4. The backend gate accepts a non-zero test-run exit only when the machine-readable vitest JSON report parses with more than zero tests, zero failures, and no zero-test files, and the log carries the exact Workers-pool teardown-crash fingerprint; a missing or corrupt report fails closed. <!-- @impl: scripts/ci/check-backend-test-report.mjs --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-003 AC4: backend test report gate) -->
5. The aggregate job reconciles the shard reports against the backend test files in the tree and fails when any file ran in no shard, or when the lane succeeded without uploading reports. <!-- @impl: scripts/ci/check-suite-completeness.mjs --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-OPS-003 AC5: cross-shard completeness gate) -->
6. The workflow runs both backend and frontend typechecks. <!-- @manual -->
7. The workflow runs a high-severity security audit on production dependencies; PRs introducing dependencies with known vulnerabilities are blocked. <!-- @manual -->

**Constraints:**

- Quality checks do not run in the 1-vCPU development container; they run on CI runners.
- The CI runner label is configurable across all workflows.
- Lanes run in parallel, each gated by a path filter over the diff (all lanes run on manual dispatch); the `summary` job publishes the required `test` status context and fails on any failed or cancelled lane while passing skipped (unaffected) lanes.
- All lanes also run unconditionally on the nightly schedule, bypassing the path filter.
- The Workers pool runs several workers per shard; its teardown crash is a teardown bug, not a concurrency one, so the gates in AC4 and AC5 — not serialization — are what keep the result trustworthy.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/ci/suite-gates.test.ts)

**Status:** Implemented

---

### REQ-OPS-005: Weekly pentest

**Intent:** Automated external pentest probes run on a weekly schedule to detect regressions in production security posture.

**Applies To:** User

**Acceptance Criteria:**

1. The pentest workflow runs weekly and on manual dispatch against the configured target URL in the production environment. <!-- @impl: .github/workflows/pentest.yml::tls --> <!-- @manual -->
2. The workflow runs six parallel probes using lightweight external tools (no active scanners) to minimize CI resource consumption. <!-- @manual -->
3. Six probe types cover response headers, TLS posture, authentication gates, information disclosure, injection vectors, and HTTP method handling; per-probe checklists live in [documentation/lanes/pentest.md](../../documentation/lanes/pentest.md#test-results). <!-- @manual -->

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

1. Containers hibernate after a configurable idle period of no user input (default 30 minutes, range 5 minutes to 2 hours). <!-- @impl: src/container/container-metrics.ts::parseSleepAfterMs --> <!-- @test: src/__tests__/container-metrics.test.ts (idle timeout resolution (REQ-OPS-006 AC1) / REQ-OPS-017 (sleepAfter fail-safe invariants)) -->
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

**Verification:** [Automated test](../../host/__tests__/workflow-deploy-max-instances.test.js)

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

**Verification:** [Automated test](../../src/__tests__/middleware/rate-limit.test.ts)

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

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [Automated test](../../host/__tests__/entrypoint-shutdown.test.js)

**Status:** Implemented

---

### REQ-OPS-011: Container base image is Debian bookworm-slim

**Intent:** Reliable CLI agent execution requires a glibc-based Linux distribution (Alpine/musl caused crashes for some agents).

**Applies To:** Admin

**Acceptance Criteria:**

1. The container base image is a glibc-based Node.js 24 distribution (Debian bookworm-slim). <!-- @test: host/__tests__/dockerfile-base-image.test.js (REQ-OPS-011: Container base image is Debian bookworm-slim) --> <!-- @manual -->
2. All supported agent CLIs (Claude Code, Codex, Antigravity, Copilot, OpenCode) start without crashes. <!-- @test: host/__tests__/dockerfile-base-image.test.js (REQ-OPS-011 AC2 (precondition): agent CLI packages are present in the image for Claude Code, Codex, Gemini CLI, Copilot, OpenCode) --> <!-- @manual -->
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

1. Operators can override the default concurrent-instance cap per deployment. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
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

**Verification:** [Automated test](../../src/__tests__/lib/access.test.ts)

**Status:** Implemented

---

### REQ-OPS-014: Container binding and scaling from image

**Intent:** After the image is pushed, the deploy workflow patches the registry URI into `wrangler.toml`, applies the resource tier and max-instance count, and offers cache-buster control over the AI agent layer. The bound Durable Object container is what user sessions land on.

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

**Verification:** [Automated test](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-OPS-016: sleepAfter preference persistence and lifecycle

**Intent:** The user-configurable idle-timeout preference must survive container-orchestration resets; on startup the stored preference is validated; on shutdown it is cleaned up.

**Applies To:** Admin

**Acceptance Criteria:**

1. The idle-timeout preference is persisted durably so it survives container-orchestration resets. <!-- @impl: src/container/container-router.ts::dispatchInternalRoute --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (sleepAfter persists across GET/PATCH round-trip) -->
2. The preference is persisted on both initial bucket configuration and any subsequent updates. <!-- @impl: src/container/container-router.ts::dispatchInternalRoute --> <!-- @test: src/__tests__/routes/session-sleep-timeout.test.ts (sleepAfter persists across GET/PATCH round-trip) -->
3. On startup, the stored preference is loaded and validated. <!-- @impl: src/container/index.ts::onStart --> <!-- @manual -->
4. On session destruction, the persisted preference is removed. <!-- @impl: src/container/index.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

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

**Intent:** Pinned versions living outside package.json — Dockerfile binaries, globally installed npm packages, and workflow-embedded tool pins — are invisible to Dependabot. A weekly workflow checks upstream releases and opens one PR per tool when a newer version is available, with SHA256 intentionally invalidated to force manual checksum verification before merge.

**Applies To:** Operator

**Acceptance Criteria:**

1. Watched Dockerfile binaries: zoxide, yazi, lazygit, silverbullet. Each has its own parallel job checking GitHub releases. <!-- @impl: .github/workflows/bump-shadow-pins.yml::ver --> <!-- @manual -->
2. The context-mode job atomically bumps its Claude-plugin and Pi-prewarm pins in one PR; build validation rejects drift. <!-- @impl: .github/workflows/bump-shadow-pins.yml::context-mode --> <!-- @manual -->
3. Each remaining non-Dependabot pin (bun, consult-llm-mcp, chrome-devtools-mcp, Browser Run MCP SDK, Impeccable, the Graphify plugin, actionlint, and each Pi extension) bumps in its own PR via a dedicated job or matrix leg. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::actionlint --> <!-- @manual -->
4. SHA256 checksum is reset to a placeholder on Dockerfile bumps, failing the build until the operator verifies it; the actionlint job instead resolves the checksum from the release manifest and re-verifies it against the downloaded artifact. <!-- @impl: .github/workflows/bump-shadow-pins.yml::lazygit --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::sum --> <!-- @manual -->
5. A bump branch is skipped if one already exists for that version (deduplication guard). <!-- @impl: .github/workflows/bump-shadow-pins.yml::branch --> <!-- @manual -->
6. The context-mode and pi-extensions jobs regenerate the Pi package lock without executing runtime-layout package lifecycle scripts. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @impl: scripts/regenerate-pi-preseed-lock.mjs::packageDirectory --> <!-- @test: host/__tests__/pi-preseed-lockfile-regeneration.test.js (creates the lockfile without executing package lifecycle scripts) -->
7. The same jobs regenerate the embedded agent seed from the updated manifest and lockfile. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @manual -->

**Notes:** Workflow execution (AC1-AC5, AC7) is verified manually per the [CI/CD lane](../../documentation/lanes/ci-cd.md); AC6's lockfile regeneration additionally carries automated lifecycle-suppression coverage.

**Constraints:** None.

**Priority:** P2

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/pi-preseed-lockfile-regeneration.test.js)

**Status:** Implemented

---

### REQ-OPS-021: Workflow-file static analysis

**Intent:** Defects in the CI workflows themselves — injection vectors, unpinned actions, invalid workflow files — are caught by automation instead of being discovered as failed or silently misbehaving runs.

**Applies To:** Operator

**Acceptance Criteria:**

1. A zizmor security audit runs on every pull request or push touching workflow files. <!-- @impl: .github/workflows/zizmor.yml::zizmor --> <!-- @manual -->
2. The audit's findings upload as SARIF to code scanning. <!-- @impl: .github/workflows/zizmor.yml::zizmor --> <!-- @manual -->
3. An actionlint check validates every workflow file using a checksum-pinned binary, catching errors GitHub reports only as jobless validation failures. <!-- @impl: .github/workflows/zizmor.yml::actionlint --> <!-- @manual -->
4. Both checks are informational: merges are gated by the `test` status context, not by this workflow. <!-- @manual -->

**Constraints:**

- The zizmor audit runs offline; its online known-vulnerable-actions audit fails fatally on advisory-API outages.
- actionlint's shellcheck and pyflakes integrations stay disabled — script hygiene is zizmor's concern.
- The actionlint version and checksum are a shadow pin: Dependabot cannot see them, so [REQ-OPS-020](#req-ops-020-shadow-pin-version-bump-automation) bumps them weekly.

**Priority:** P2

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented
