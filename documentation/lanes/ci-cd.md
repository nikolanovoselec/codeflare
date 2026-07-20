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

Dependabot runs weekly against the `develop` branch for four npm package directories (`/`, `/web-ui`, `/host`, `/landing`), Docker images, and GitHub Actions. The stress workflow installs Wrangler from the root `package.json` devDependency, so the root npm Dependabot lane owns the Wrangler version rather than a second workflow-local pin.

**Node Docker image major updates are ignored.** The `docker.io/library/node` and `public.ecr.aws/docker/library/node` images are pinned to suppress semver-major proposals. Dependabot would otherwise propose Node Current (odd, non-LTS) releases such as Node 25. Node major upgrades are handled manually when a new LTS version is released (even major: 22, 24, 26, ...).

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `deploy.yml` | `workflow_run` when PR Checks complete green on `main` + `workflow_dispatch` (production/integration/enterprise/enterprise integration; `registry` selector cloudflare/dockerhub) | Staged pipeline `prepare` → (`build-worker` ∥ `container` via `container-image.yml`) → `deploy`: applies config, deploys, sets secrets in bulk, smoke-checks `/health`, and prunes the registry. |
| `container-image.yml` | `workflow_call` (from `deploy.yml`) | Reusable container build → Trivy scan → push, parameterized by registry (Cloudflare managed registry, or Docker Hub as connection-drop bypass). Tags images `in-<input-hash>` and **reuses the existing already-scanned image when inputs are unchanged**, skipping the multi-GB build+scan; a weekly hash salt bounds reuse at seven days. |
| `test.yml` | PRs to `main` or `develop`, push to `main` + `workflow_dispatch` | Parallel path-filtered lanes: quality (lint/knip/audit/seed-drift), typecheck, backend tests (two vitest shards with the fail-closed gate), frontend, landing, host, dependency-review. The `summary` job (check name `test`, the required branch-protection context) fails on any failed/cancelled lane and passes skipped (unaffected) lanes. |
| `zizmor.yml` | PRs and pushes touching `.github/**` + `workflow_dispatch` | Static security audit of the workflows themselves (template injection, pwn-request vectors, unpinned actions); SARIF to code scanning. Informational, not a required check. |
| `codeql.yml` | Push to `main`, PRs to `main`, weekly (Monday 06:00 UTC) | Scans JavaScript and TypeScript and uploads SARIF. Its config excludes vendored Impeccable scripts, which are refreshed wholesale by shadow-pin bumps and do not run in the production request path. |
| `fuzz.yml` | PRs to `main`, weekly (Sunday 04:00 UTC) + `workflow_dispatch` | Property-based fuzzing with fast-check (50,000 iterations) |
| `scorecard.yml` | Push to `main`, weekly (Monday 06:00 UTC) + `workflow_dispatch` | OSSF Scorecard security posture assessment, publishes results and uploads SARIF |
| `pentest.yml` | Weekly (Monday 05:00 UTC) + `workflow_dispatch` | External black-box penetration testing: security headers, TLS, auth gate, info disclosure, injection attacks, HTTP methods |
| `stress-test.yml` | `workflow_dispatch` | k6 stress tests from `stress/` (API throughput, session lifecycle, storage operations, rate-limit validation) against integration worker. Configurable concurrency via `STRESS_TEST_CONCURRENCY` variable. |
| `bump-shadow-pins.yml` | Weekly (Monday 06:00 UTC) + `workflow_dispatch` | Tracks non-Dependabot pins: context-mode, graphify plugin version, Dockerfile binaries, Bun, the `consult-llm-mcp` Dockerfile global-install pin, the `chrome-devtools-mcp` Dockerfile baked-cache pin, every Pi preseed npm pin, and the vendored Impeccable skill bundle for Claude Code + Pi. |

Additional details:

**Docker Hub bypass (`registry: dockerhub`):** the former `deploy-dockerhub.yml` near-copy is replaced by a `registry` dispatch input on `deploy.yml`; `container-image.yml` pushes to Docker Hub instead of `registry.cloudflare.com` when the managed registry drops connections mid-upload. Requires `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` secrets and (after first push) flipping the auto-created Docker Hub repo to Public so the Cloudflare container runtime can pull without auth. Before the Trivy scan the workflow frees runner disk — removes prior images (keeping the scan target) and prunes dangling layers — so the image export does not exhaust the Docker data root on a persistent self-hosted runner (the `RUNNER` Actions variable; defaults to `ubuntu-latest`).

**`bump-shadow-pins.yml`:** Tracks non-Dependabot pins: context-mode, graphify plugin version, Dockerfile binaries, Bun, the `consult-llm-mcp` Dockerfile global-install pin, the `chrome-devtools-mcp` Dockerfile baked-cache pin, every Pi preseed npm pin, and the vendored Impeccable skill bundle for Claude Code + Pi. Opens one PR per bump and regenerates matching lockfiles/agent seed when duplicated literals change. Pi lockfile-only regeneration goes through `scripts/regenerate-pi-preseed-lock.mjs`, which suppresses lifecycle scripts because the committed payload layout differs deliberately from the flattened runtime npm layout. SHA256 checksums are invalidated on Dockerfile-binary bumps.

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
3. **container** — calls `container-image.yml`: computes the image input hash over every Dockerfile COPY source (`Dockerfile`, `entrypoint.sh`, `host/`, `preseed/`, seed scripts, `src/lib/agent-seed.generated.ts`) plus an ISO-week salt; if `in-<hash>` already exists in the target registry the already-scanned image is reused and build/scan/push are skipped. Otherwise: buildx with `type=gha` layer cache (base image pulled from `public.ecr.aws/docker/library/node:24-bookworm-slim` — AWS ECR Public mirror avoids Docker Hub anonymous pull rate limits), Trivy scan (HIGH/CRITICAL, `ignore-unfixed: true`, `.trivyignore` for consciously accepted fixable CVEs — see [Security §Container Image Scanning](security.md#container-image-scanning-req-sec-011), daily-cached vuln DB), push with a bounded retry loop (30 attempts, 30s apart). A COPY-coverage guard disables reuse if a Dockerfile COPY source ever falls outside the hashed path set.
4. **deploy** — downloads the dist artifact; resolves/creates the KV namespace and patches `wrangler.toml`; applies worker name and container tier from `RESSOURCE_TIER` (low=basic 0.25vCPU/1GiB/4GB, default/saas=1vCPU/3GiB/6GB, high=2vCPU/6GiB/8GB; all tiers default to 10 max instances, `MAX_INSTANCES` overrides); points `image` at the pre-pushed registry URI; runs `npx wrangler deploy` with `--var` runtime config inside the same bounded retry loop (30×30s — a transient CF control-plane error such as 100146 "Worker version not found" never wastes the completed build); uploads all worker secrets in **one `wrangler secret bulk` call** (`CLOUDFLARE_API_TOKEN`, optional `SERVICE_AUTH_SECRET`, mode-gated Resend/Stripe/OAuth/AIG secrets, optional `ENCRYPTION_KEY`); seeds the service user in KV when a service-auth secret is configured; **smoke-checks `GET /health`** (public route, 5 attempts) against the environment's `E2E_BASE_URL` variable and fails the deploy if it never returns 200; finally prunes old registry images via `scripts/ci/prune-registry.mjs` (best-effort, digest-alias-protected, keeps the 10 newest tags plus the deployed tag).

Tests are not re-run anywhere in this workflow — the `workflow_run` gate already proved a green PR Checks run for the exact deployed SHA.

### Test Workflow Detail

Parallel jobs, all gated by a `changes` path-filter job (every lane runs on `workflow_dispatch`):

- **changes** — `dorny/paths-filter` classifies the diff into `backend`, `webui`, `landing`, `host`; pipeline files (`test.yml`, `.github/actions/**`, `scripts/ci/**`, root package manifests) are in every filter so pipeline changes re-run everything.
- **quality** — agent-seed drift guard, oxlint (backend + frontend), knip dead-code check (both), `npm audit --audit-level=high --omit=dev` (both).
- **typecheck** — `wrangler types` then `tsc --noEmit` for backend and frontend.
- **backend-tests** — two `vitest --shard` jobs through the composite action `.github/actions/backend-tests` (see [Backend Tests](#backend-tests) for the fail-closed gate). Shards halve the wall-clock of the suite that `maxWorkers: 1` forces serial. Shard 1 also carries the unsharded Pi-extension Node suite (`vitest.node.config.ts`) under the same JSON gate.
- **frontend-tests** — web-ui build + vitest. **landing-tests** — Container-API render + unit tests. **host-tests** — `node --test` with the container-only exclusion list read from `host/__tests__/ci-excluded.txt`; installs rclone for the sync-filter behavioral tests.
- **dependency-review** — `actions/dependency-review-action` on PRs; blocks merging if new dependencies introduce known vulnerabilities.
- **summary** — check name `test` (the required branch-protection context). Fails when any needed lane failed or was cancelled; passes skipped lanes (their area was untouched).

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

**Config:** `vitest.config.ts` with `@cloudflare/vitest-pool-workers` `cloudflareTest()` plugin - tests run in real Workers runtime (not Node.js). **Run:** `npm test` **Coverage:** v8 provider, thresholds: 50% statement/function/line, 40% branch.

**CI workerd crash guard (fail-closed):** `@cloudflare/vitest-pool-workers` crashes `workerd` at pool teardown after all tests pass — a known upstream limitation of WebSockets + Durable Objects under per-file storage isolation, still present on 0.18.x/vitest 4 (the documented alternative `--max-workers=1 --no-isolate` crashes this suite at collection).

The composite action `.github/actions/backend-tests` runs `npm test` (optionally with `--shard`) with `--reporter=dot --reporter=json`, then gates via `scripts/ci/check-backend-test-report.mjs` on the **machine-readable JSON report**, never on reporter prose: a zero exit still requires a parsed report with >0 tests and 0 failures (catches silently-empty runs); a non-zero exit is accepted only when the report parses with >0 tests, 0 failed tests, 0 failed suites, AND the log carries the exact fingerprint `[vitest-pool]: Worker cloudflare-pool emitted error.`. A missing or corrupt report, an unknown error, or any failed test fails the job. Deploy does not re-run tests, so the guard lives only here.

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

---

## Related Decisions

- [AD112](../decisions/README.md#ad112-ci-runs-as-parallel-path-filtered-lanes-and-deploys-reuse-content-addressed-container-images) - Parallel path-filtered CI lanes, fail-closed JSON test gate, staged deploy with content-addressed container reuse, scripted e2e removal

---

## Related Documentation
- [Deployment](deployment.md) - Development commands and file structure
- [Configuration](configuration.md#secrets) - Worker secrets and variables
- [pentest.md](pentest.md) - Penetration testing results
- [stress-test.md](stress-test.md) - Load testing guide
