# CI/CD & Testing

GitHub Actions workflows, test suites, and deployment pipeline.

**Audience:** Developers

## Contents

- [CI/CD (GitHub Actions)](#cicd-github-actions)
- [Testing](#testing)
- [Specification Coverage](#specification-coverage)
- [Related Decisions](#related-decisions)
- [Related Documentation](#related-documentation)

---

## CI/CD (GitHub Actions)

Workflows covering deploy, testing, fuzzing, penetration testing, stress testing, supply chain security, workflow auditing, and dependency pin maintenance. Additionally, GitHub's built-in **secret scanning** (with push protection) and **Dependabot security updates** are enabled at the repository level.

### Dependabot Configuration

Dependabot runs weekly against the `develop` branch for four npm package directories (`/`, `/web-ui`, `/host`, `/landing`), Docker images, and GitHub Actions. Every ecosystem declares a `cooldown` (7 days default, 30 for majors — 7 is zizmor's floor for `default-days`): the npm compromise pattern is publish-malicious-version and wait for automation to pull it within hours, so a waiting period lets the ecosystem revoke a bad release before a bot proposes it. The stress workflow installs Wrangler from the root `package.json` devDependency, so the root npm Dependabot lane owns the Wrangler version rather than a second workflow-local pin.

**Node Docker image major updates are ignored.** The `docker.io/library/node` and `public.ecr.aws/docker/library/node` images are pinned to suppress semver-major proposals. Dependabot would otherwise propose Node Current (odd, non-LTS) releases such as Node 25. Node major upgrades are handled manually when a new LTS version is released (even major: 22, 24, 26, ...).

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `deploy.yml` | `workflow_run` when PR Checks complete green on `main` + `workflow_dispatch` (production/integration/enterprise/enterprise integration; `registry` selector cloudflare/dockerhub) | Staged pipeline `prepare` → (`build-worker` ∥ `container` via `container-image.yml`) → `deploy`: applies config, deploys, sets secrets in bulk, smoke-checks `/health`, and prunes the registry. |
| `container-image.yml` | `workflow_call` (from `deploy.yml`) | Reusable container build → Trivy scan → push, parameterized by registry (Cloudflare managed registry, or Docker Hub as connection-drop bypass). Tags images `in-<input-hash>` and **reuses the existing already-scanned image when inputs are unchanged**, skipping the multi-GB build+scan; a weekly hash salt bounds reuse at seven days. |
| `test.yml` | PRs to `main` or `develop`, push to `main`, `merge_group`, `workflow_dispatch` + nightly schedule (all lanes) | Parallel path-filtered lanes: quality (lint/knip/audit/seed-drift), typecheck, workflow audit, bundle size, coverage (non-PR), every vitest suite through one fail-closed action (four backend shards, a Node leg, three frontend shards, landing), host, dependency-review. The `summary` job (check name `test`, the required branch-protection context) fails on any failed/cancelled lane and passes skipped (unaffected) lanes. |
| `zizmor.yml` | PRs and pushes touching `.github/**` + `workflow_dispatch` | Records the workflow security audit as SARIF in code scanning, so the alert history is preserved. It only records — the blocking check is the `workflow-audit` lane in `test.yml`. Its zizmor version is pinned (the action defaults to `latest`, which floats the auditor). |
| `codeql.yml` | Push to `main`, PRs to `main`, weekly (Monday 06:00 UTC) | Scans JavaScript and TypeScript and uploads SARIF. Its config excludes vendored Impeccable scripts, which are refreshed wholesale by shadow-pin bumps and do not run in the production request path. |
| `fuzz.yml` | PRs to `main`, weekly (Sunday 04:00 UTC) + `workflow_dispatch` | Property-based fuzzing with fast-check (50,000 iterations) |
| `scorecard.yml` | Push to `main`, weekly (Monday 06:00 UTC) + `workflow_dispatch` | OSSF Scorecard security posture assessment, publishes results and uploads SARIF |
| `pentest.yml` | Weekly (Monday 05:00 UTC) + `workflow_dispatch` | External black-box penetration testing: security headers, TLS, auth gate, info disclosure, injection attacks, HTTP methods |
| `stress-test.yml` | `workflow_dispatch` | k6 stress tests from `stress/` (API throughput, session lifecycle, storage operations, rate-limit validation) against integration worker. Configurable concurrency via `STRESS_TEST_CONCURRENCY` variable. |
| `bump-shadow-pins.yml` | Weekly (Monday 06:00 UTC) + `workflow_dispatch` | Tracks non-Dependabot pins: context-mode, graphify plugin version, Dockerfile binaries, Bun, the `consult-llm-mcp` Dockerfile global-install pin, the `chrome-devtools-mcp` Dockerfile baked-cache pin, every Pi preseed npm pin, the vendored Impeccable skill bundle for Claude Code + Pi, and the `actionlint` + `zizmor` versions pinned in `test.yml` / `zizmor.yml`. |

Additional details:

**Docker Hub bypass (`registry: dockerhub`):** the former `deploy-dockerhub.yml` near-copy is replaced by a `registry` dispatch input on `deploy.yml`; `container-image.yml` pushes to Docker Hub instead of `registry.cloudflare.com` when the managed registry drops connections mid-upload. Requires `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` secrets and (after first push) flipping the auto-created Docker Hub repo to Public so the Cloudflare container runtime can pull without auth. Before the Trivy scan the workflow frees runner disk — removes prior images (keeping the scan target) and prunes dangling layers — so the image export does not exhaust the Docker data root on a persistent self-hosted runner (the `RUNNER` Actions variable; defaults to `ubuntu-latest`).

**`bump-shadow-pins.yml`:** Tracks non-Dependabot pins: context-mode, graphify plugin version, Dockerfile binaries, Bun, the `consult-llm-mcp` Dockerfile global-install pin, the `chrome-devtools-mcp` Dockerfile baked-cache pin, every Pi preseed npm pin, the vendored Impeccable skill bundle for Claude Code + Pi, and the `actionlint` + `zizmor` versions pinned in `test.yml` / `zizmor.yml`. Opens one PR per bump and regenerates matching lockfiles/agent seed when duplicated literals change. Pi lockfile-only regeneration goes through `scripts/regenerate-pi-preseed-lock.mjs`, which suppresses lifecycle scripts because the committed payload layout differs deliberately from the flattened runtime npm layout. SHA256 checksums are invalidated on Dockerfile-binary bumps; the `actionlint` job is the exception - upstream publishes a `checksums.txt`, so the job resolves the new hash, re-verifies it against the downloaded artifact, and commits a merge-ready pin.

**`bump-shadow-pins.yml` permissions:** top-level is `contents: read`; each job that pushes a bump branch and opens a PR elevates itself to `contents: write` + `pull-requests: write`, while `pi-extensions-discover` stays read-only (it only lists package names). No job persists checkout credentials — the default would leave the token in `.git/config` for every later step, including the install scripts `npm ci` runs in the lockfile-regenerating jobs — so checkouts set `persist-credentials: false` and the push authenticates explicitly instead (zizmor `artipacked`). Branch-existence probes use unauthenticated `ls-remote`, which works because the repository is public.

The OpenVSCode job validates upstream release tags against a strict version pattern before creating outputs. Its write-enabled shell steps receive the validated version and derived branch through quoted environment variables, so release metadata is never parsed as shell source ([REQ-OPS-020](../../sdd/spec/operations.md#req-ops-020-shadow-pin-version-bump-automation)).

The `pi-extensions` bump is data-driven: the `pi-extensions-discover` job lists **every** dependency in `preseed/agents/pi/package.json` except context-mode (`@gotgenes/pi-subagents` and the five tool extensions: `@juicesharp/rpiv-advisor`, `@juicesharp/rpiv-ask-user-question`, `@juicesharp/rpiv-todo`, `pi-web-access`, `pi-mcp-adapter`), and a `fail-fast: false` matrix diffs each against npm latest and bumps it in its own leg and PR; context-mode is owned separately by the `context-mode:` job. Each version is duplicated as a literal in entrypoint.sh (context-mode in the disabled-by-default package set; the extensions in the always-on `required` set), the pinned-version test assertions (`host/__tests__/pi-settings-packages.test.js`), and the generated seed. Dependabot intentionally skips that directory, so this workflow keeps every copy aligned.

### GitHub Environments

| Environment | Used by | Trigger |
|-------------|---------|---------|
| `production` | `deploy.yml`, `pentest.yml` | Auto on push to `main`, or manual dispatch with `production` selected |
| `integration` | `deploy.yml`, `stress-test.yml` | Manual dispatch with `integration` selected |

The non-default enterprise environments, account overrides, and dispatch procedure are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private).

### GitHub Secrets and Variables

A default deployment requires only these repository secrets:

| Secret | Used by | Purpose |
|--------|---------|---------|
| `CLOUDFLARE_API_TOKEN` | `deploy.yml`, `container-image.yml` | Wrangler authentication, resource setup, image push, and Worker deploy |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml`, `container-image.yml` | Identifies the target Cloudflare account |

Non-default mode credentials, optional deployment variables, environment overrides, fallback registries, and service credentials are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private). This public lane intentionally does not duplicate that operational matrix.

### Deploy Workflow Detail

**Workflow permissions:** top-level is `contents: read` (read-only default); the `container` job adds `actions: write` (required only for `type=gha` BuildKit cache writes). Code-scanning least-privilege hardening (#56).

Job graph: `prepare` → (`build-worker` ∥ `container`) → `deploy`. The pwn-request gate (workflow_run must be a same-repo `push` event that concluded green) is repeated on every job because a job skipped via `if:` counts as success for `needs:` resolution.

1. **prepare** — blocks production dispatches from non-main branches; resolves the environment name, checkout ref (the exact SHA whose PR Checks ended green), worker name, and cache-bust flag once for all downstream jobs.
2. **build-worker** — builds frontend, then landing (`landing/` → `web-ui/dist/landing/`; order matters — the web-ui build wipes `dist/`), uploads `web-ui/dist` as a 1-day artifact.
3. **container** — calls `container-image.yml` to build, scan, and push the image, or to reuse an existing one:
   - Computes the image input hash over every Dockerfile COPY source (`Dockerfile`, `entrypoint.sh`, `host/`, `preseed/`, seed scripts, `src/lib/agent-seed.generated.ts`) plus an ISO-week salt.
   - If `in-<hash>` already exists in the target registry, the already-scanned image is reused and build/scan/push are skipped.
   - Otherwise buildx builds with a `type=gha` layer cache; the base image comes from `public.ecr.aws/docker/library/node:24-bookworm-slim` (AWS ECR Public mirror avoids Docker Hub anonymous pull rate limits).
   - Trivy scans HIGH/CRITICAL with `ignore-unfixed: true` and `.trivyignore` for consciously accepted fixable CVEs (daily-cached vuln DB) — see [Security §Container Image Scanning](security.md#container-image-scanning-req-sec-011).
   - Push runs in a bounded retry loop (30 attempts, 30s apart); a COPY-coverage guard disables reuse if a Dockerfile COPY source ever falls outside the hashed path set.
4. **deploy** — deploys the worker off the pre-built artifacts:
   - Downloads the dist artifact, resolves/creates the KV namespace, and patches `wrangler.toml`.
   - Applies worker name and container tier from `RESSOURCE_TIER` (low=basic 0.25vCPU/1GiB/4GB, default/saas=1vCPU/3GiB/6GB, high=2vCPU/6GiB/8GB; all tiers default to 10 max instances, `MAX_INSTANCES` overrides) and points `image` at the pre-pushed registry URI.
   - Runs `npx wrangler deploy` with `--var` runtime config inside the same bounded retry loop (30×30s — a transient CF control-plane error such as 100146 "Worker version not found" never wastes the completed build).
   - Uploads all worker secrets in **one `wrangler secret bulk` call** (`CLOUDFLARE_API_TOKEN`, optional `SERVICE_AUTH_SECRET`, mode-gated Resend/Stripe/OAuth/AIG secrets, optional `ENCRYPTION_KEY`); seeds the service user in KV when a service-auth secret is configured.
   - **Smoke-checks `GET /health`** (public route, 5 attempts) against the environment's `E2E_BASE_URL` variable; anything but 200 fails the deploy, except a zone-edge bot-mitigation 403 (impossible from the worker on this public route), which passes with a warning.
   - Finally prunes old registry images via `scripts/ci/prune-registry.mjs` — best-effort, digest-alias-protected; keeps the 10 newest tags, the deployed tag, and any tag whose creation time failed to resolve.
   - The unresolved-creation-time hold is fail-closed — a flaked config-blob fetch never deletes a potentially recent image; such tags become prunable again once a later run resolves them.
   - Always (even on failure) publishes a **Deploy summary** table (environment, worker, image tag, whether the image was reused, health-smoke outcome) to the run summary.

Tests are not re-run anywhere in this workflow — the `workflow_run` gate already proved a green PR Checks run for the exact deployed SHA.

### Test Workflow Detail

Parallel jobs, all gated by a `changes` path-filter job (every lane runs on `workflow_dispatch` and the nightly schedule):

- **changes** — `dorny/paths-filter` classifies the diff into `backend`, `webui`, `landing`, `host`; pipeline files (`test.yml`, `.github/actions/**`, `scripts/ci/**`, root package manifests) are in every filter so pipeline changes re-run everything.
- **quality** — agent-seed drift guard, oxlint (backend + frontend), knip dead-code check (both), `npm audit --audit-level=high --omit=dev` (both).
- **typecheck** — `wrangler types` then `tsc --noEmit` for backend and frontend.
- **backend-tests** — four `vitest --shard` jobs plus a Node-runtime leg, all via `.github/actions/vitest-suite` ([Backend Tests](#backend-tests) has the fail-closed gate). Each shard runs its Workers pool across several workers (`maxWorkers` in `vitest.config.ts`, capped at 4 because every worker is a full workerd + miniflare instance). Shard count is the dominant lever: most of a shard's wall clock is per-file transform and isolate setup, roughly half of it in the main process where extra workers cannot help, and that half divides across shards.
- **frontend-tests** — three `vitest --shard` jobs through the same action, so the jsdom suite gets the identical JSON-report gate the backend has. Only shard 1 runs `npm run build`; the build is a production-breakage check, not a test dependency.
- **frontend-tests** — web-ui build + vitest. **landing-tests** — Container-API render + unit tests. **host-tests** — `node --test` with the container-only exclusion list read from `host/__tests__/ci-excluded.txt`; installs rclone for the sync-filter behavioral tests.
- **dependency-review** — `actions/dependency-review-action` on PRs; blocks merging if new dependencies introduce known vulnerabilities.
- **workflow-audit** — checksum-pinned `zizmor` + `actionlint` binaries over `.github/**`. This is the *gate*: zizmor exits 12 on any finding, and the lane is inside the required `test` context, so a new template-injection or credential-persistence defect fails the merge rather than landing and appearing in an alert list later (this repo carried 60 such alerts before they were swept). Its own binary rather than `zizmor-action` because the action's failure semantics depend on whether it is uploading SARIF, and a gate must be unambiguous about when it fires. Findings that are correct-as-written carry an inline `# zizmor: ignore[rule]` with the reason — the directive must sit *on* the finding's line, not above it.
- **bundle-size** — `wrangler deploy --dry-run` against a patched config, gated on `scripts/ci/size-budgets.mjs`. Cloudflare rejects an oversized Worker at deploy time, so without this the discovery point is a failed production deploy. The patch repoints `[[containers]].image` away from `./Dockerfile`: otherwise the dry run *builds the container image*, which `container-image.yml` already builds and content-addresses — ~3 minutes of duplicated work for a number printed before the build starts.
- **summary** — check name `test` (the required branch-protection context). Fails when any needed lane failed or was cancelled; passes skipped lanes (their area was untouched). Reconciles every suite's coverage (`scripts/ci/check-suite-completeness.mjs`, see [Backend Tests](#backend-tests)) and publishes a test-result table (`scripts/ci/render-test-summary.mjs`) to the run summary.

### PR Exact-Head Monitoring

PR-boundary eligibility, exact-head target resolution, and CI-monitor recovery are owned by [Preseed — Resetting Review-Spawn Checkpoints](preseed.md#resetting-review-spawn-checkpoints).

### Pentest Workflow Detail

Six parallel jobs, each running lightweight external probes against the production deployment using only `curl` and `openssl` (no heavy scanning tools). All jobs use the `production` GitHub environment and read `PENTEST_TARGET` from environment variables.

1. **security-headers**: Verifies presence of HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. Confirms `X-Powered-By` is absent.
2. **tls**: Confirms TLS 1.3 works, TLS 1.0/1.1 are rejected, HSTS preload is enabled, and the certificate has at least 14 days before expiry.
3. **auth-gate**: Sends unauthenticated requests to seven API endpoints and confirms they all require CF Access (302/401/403). Tests that injecting `cf-access-authenticated-user-email` headers does not bypass authentication.
4. **info-disclosure**: Probes for sensitive files (`/.env`, `/.git/config`, `/api/debug`), checks that responses contain no secrets or stack traces.
5. **injection**: Tests host header injection (spoofed `Host` returns 403), `X-Forwarded-Host` has no effect on content, CL/TE request smuggling is rejected, and path traversal payloads (`%2e%2e`, double-encoded, backslash, unicode) are blocked at the auth layer.
6. **http-methods**: Verifies TRACE returns 405 and WebSocket upgrade without authentication returns 302.

**Requires:** `PENTEST_TARGET` variable set in the `production` GitHub environment (e.g., `https://codeflare.ch`). See the full manual test report in [pentest.md](pentest.md).

---

## Testing

### Backend Tests

**Config:** `vitest.config.ts` with `@cloudflare/vitest-pool-workers` `cloudflareTest()` plugin - tests run in real Workers runtime (not Node.js). **Run:** `npm test` **Coverage:** istanbul provider — the v8 provider profiles through the Node host's V8 inspector, which cannot see inside workerd isolates and reports a flat 0% for this suite. Thresholds live in each suite's own vitest config and are enforced by the `coverage` lane (post-merge and nightly, not per-PR — see above). Measured 2026-07-20 on the first run that ever executed them: backend 90.2% statements / 82.7% branches, web-ui 77.4% / 66.0%. Thresholds sit ~2 points under those, because the previous 53/43 and 32/27 sat 37 and 45 points below actual and would have passed a suite with most of its tests deleted.

**CI workerd crash guard (fail-closed):** `@cloudflare/vitest-pool-workers` crashes `workerd` at pool teardown after all tests pass — a known upstream limitation of WebSockets + Durable Objects under per-file storage isolation, still present on 0.18.x/vitest 4 (the documented alternative `--max-workers=1 --no-isolate` crashes this suite at collection). Serializing the pool never fixed it — the crash is at teardown, not a concurrency race — so the pool runs parallel and the gate, not serialization, is what makes the result trustworthy.

The composite action `.github/actions/vitest-suite` is how **every** suite runs — backend shards, the Node leg, frontend shards, landing. It invokes the suite's npm script (optionally with `--shard`) with `--reporter=dot --reporter=json`, then gates via `scripts/ci/check-vitest-report.mjs` on the **machine-readable JSON report**, never on reporter prose: a zero exit still requires a parsed report with >0 tests and 0 failures (catches silently-empty runs); a non-zero exit is accepted only when the report parses with >0 tests, 0 failed tests, 0 failed suites, AND the log carries the exact fingerprint `[vitest-pool]: Worker cloudflare-pool emitted error.`. A missing or corrupt report, an unknown error, or any failed test fails the job. Crash tolerance is opt-in per suite (`tolerate-pool-crash`), because only the Workers pool has that bug — a non-zero exit from the jsdom or Node suites stays fatal. Deploy does not re-run tests, so the guard lives only here.

**Dependency installs** go through `.github/actions/install-deps` (lockfile-keyed cache, `npm ci --prefer-offline --no-audit --no-fund` only on a miss, each attempt wrapped in `timeout` so a *hung* registry connection is retried rather than waited on forever, plus `NODE_COMPILE_CACHE` for the V8 bytecode cache Node 22+ shares between processes). Every lane used to copy-paste that pair and they drifted; one action means one cache-key convention.

**Cross-suite completeness gate (fail-closed):** a per-run gate can only vouch for files it was handed, so `scripts/ci/check-suite-completeness.mjs` runs in the `summary` job and reconciles the union of every report against the test files actually in the tree, for each suite registered in `scripts/ci/suites.mjs`. A file lost to a mis-shard, a stale exclude, or a worker dying mid-run fails the required context instead of passing as a smaller-but-green run. It also fails when a lane reported success yet uploaded no reports (a flaked artifact download cannot silently disarm the gate), and when two shards both claim the same file — a split disagreement, whose mirror image is a file nobody ran. `vitest.node-suite.mjs` is the single list of Node-runtime backend tests, shared by both vitest configs and this gate.

**Key patterns:** `vi.mock()` must be at module level BEFORE imports. Use `vi.hoisted()` for shared mutable state referenced by mock factories. `LOG_LEVEL: 'silent'` in miniflare bindings suppresses log noise. **Notable test files:** `kv-crypto.test.ts` (KV AES-256-GCM encryption + migration), `r2-sse.test.ts` (R2 SSE-C encryption).

**File-size discipline:** the former >1,500-line test files are split along describe boundaries (`routes/setup*.test.ts` ×5, `container/{index,enterprise-llm,lifecycle}.test.ts`, `lib/agent-seed-{manifest,multi-agent,pi-memory}.test.ts`, `fuzz/{input-validation,replicated-helpers,runtime-config}.fuzz.test.ts`). Shared scaffolding is replicated per file because `vi.mock` hoisting is per module.

### Frontend Tests

**Config:** `web-ui/vitest.config.ts` with jsdom + `@solidjs/testing-library`.
**Run:** `cd web-ui && npm test`
**Key patterns:** SolidJS stores use getter-based exports. Test by re-importing module after `vi.resetModules()`. Use `render()` from `@solidjs/testing-library` for component tests.

### Host Tests

**Config:** `host/package.json` with Node.js built-in test runner (`node --test`).
**Run:** `cd host && npm test` (also runs in CI via `node --test host/__tests__/*.test.js`, minus the container-only tests listed in `host/__tests__/ci-excluded.txt`)
**Scope:** PTY pre-warm readiness (first-output detection), activity tracker disconnect + input tracking, WebSocket input classification, server prewarm integration, entrypoint sync filter validation, server security, host module extraction, host fuzz tests, memory merge/cleanup, container memory tracking, entrypoint ECC validation, entrypoint hooks merge, metrics collection, session manager lifecycle, proactive memory injection (memory-context-inject.sh), graphify SessionStart three-tier fallback, graphify discipline preseed checks.

### Property-Based Fuzz Tests

**Library:** [fast-check](https://github.com/dubzzz/fast-check). **CI:** `fuzz.yml` runs 50,000 iterations on PRs to main, weekly, and manual dispatch.
**Local:** Default 1,000 iterations. Override with `FAST_CHECK_NUM_RUNS=50000`.

| Suite | File | What it covers |
|-------|------|----------------|
| Backend | `src/__tests__/fuzz/input-validation.fuzz.test.ts` | XML injection/parsing, getBucketName, validateKey (path traversal, null bytes, encoding tricks), KV namespacing, ReDoS, circuit breaker state machine, compound session-ID parsing |
| Backend | `src/__tests__/fuzz/replicated-helpers.fuzz.test.ts` | Replicated non-exported helpers (normalizeEmail, getCookieValue, extractTag, isRetryable), error types, type guards |
| Backend | `src/__tests__/fuzz/runtime-config.fuzz.test.ts` | TabConfigSchema, logger, toApiSession, cache-reset state machine, error-type constructors, content-type helpers, session-mode config filtering |
| Frontend | `web-ui/src/__tests__/fuzz/frontend-fuzz.test.ts` | md5 (custom impl), isActionableUrl (ReDoS resistance), cleanupMapByPrefix (Map iteration+deletion) |
| Host | `host/__tests__/fuzz-host.test.js` | getPrewarmConfig (untrusted tab config), createActivityTracker (idle shutdown state machine) |
| Backend | `src/__tests__/fuzz/vault-migration.fuzz.test.ts` | validateVaultRoute (exactly-one-outcome token XOR session XOR 400; bare-path rejection; Upgrade-header case), getVaultBucketToken (32-hex shape, deterministic, distinct from session-id namespace), graftVaultKeyRecovery (throws on anchor-less input; single-shot), resolveReadRegime + getRegimeState (KV-garbage hardening), parseSessionMessages (adversarial JSONL), isChildSessionFirstLine, isVaultExcludedPath segment-awareness |
| Frontend | `web-ui/src/__tests__/fuzz/terminal-link-provider.fuzz.test.ts` | registerMultiLineLinkProvider driven through the real registration path against fuzzed buffers — never throws / calls back exactly once, every emitted link is a well-formed http(s) URL with ordered range + activate handler, wall-clock ReDoS bound on adversarial wrapped URL rows |

**Test selection criteria:** Every test must exercise real production code (no replicas) on an untrusted input boundary (user input, API responses, WebSocket data, env vars). Tests that verify framework guarantees (Zod safeParse), language features (class inheritance), or trivial formatters are excluded.

**Bugs found by fuzzing:**
- `getBucketName` trailing hyphen for long worker names (`src/lib/access.ts`)
- Null byte bypass in `validateKey` (`src/routes/storage/validation.ts`)
- `prewarm-config.ts` crash on non-string tab command (`host/src/prewarm-config.ts`)
- `toError`/`toErrorMessage` crash on objects with throwing `toString()` (`src/lib/error-types.ts`)

### Vitest Configuration

Both root and `web-ui/` use Vitest v4.x with independent `node_modules` and separate configs. Root uses the `cloudflareTest()` plugin from `@cloudflare/vitest-pool-workers` v0.13+ (replaces the old `defineWorkersConfig()` pattern). Web-UI uses jsdom with `vite-plugin-solid`.

**Reporter:** all three Vitest configs (root, `web-ui/`, `landing/`) select the reporter from `process.env.CI`: `dot` (compact, dots + summary) in CI, `default` (full per-test output) locally. The CI backend run additionally passes `--reporter=json --outputFile.json=...` on the command line so the crash-guard gate reads structured counts instead of grepping reporter text.

---

## Specification Coverage

- [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline) - Deploy workflow trigger and staged pipeline
- [REQ-OPS-002](../../sdd/spec/operations.md#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push) - Docker image build, vulnerability scan, and registry push
- [REQ-OPS-003](../../sdd/spec/operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit) - PR checks run lint, test, typecheck, and security audit
- [REQ-OPS-018](../../sdd/spec/operations.md#req-ops-018-weekly-fuzz-testing) - Weekly fuzz testing
- [REQ-OPS-020](../../sdd/spec/operations.md#req-ops-020-shadow-pin-version-bump-automation) - Shadow-pin version bump automation
- [REQ-OPS-021](../../sdd/spec/operations.md#req-ops-021-workflow-file-static-analysis) - Workflow-file static analysis (zizmor + actionlint, informational)

---

## Related Decisions

- [AD112](../decisions/README.md#ad112-ci-runs-as-parallel-path-filtered-lanes-and-deploys-reuse-content-addressed-container-images) - Parallel path-filtered CI lanes, fail-closed JSON test gate, staged deploy with content-addressed container reuse, scripted e2e removal

---

## Related Documentation
- [Deployment](deployment.md) - Development commands and file structure
- [Configuration](configuration.md#secrets) - Worker secrets and variables
- [pentest.md](pentest.md) - Penetration testing results
- [stress-test.md](stress-test.md) - Load testing guide
