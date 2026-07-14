# CI/CD & Testing

GitHub Actions workflows, test suites, E2E infrastructure, and deployment pipeline.

**Audience:** Developers

## Contents

- [CI/CD (GitHub Actions)](#cicd-github-actions)
- [Testing](#testing)

---

## CI/CD (GitHub Actions)

Workflows covering deploy, testing, fuzzing, penetration testing, stress testing, supply chain security, and dependency pin maintenance. Additionally, GitHub's built-in **secret scanning** (with push protection) and **Dependabot security updates** are enabled at the repository level.

### Dependabot Configuration

Dependabot runs weekly against the `develop` branch for four npm package directories (`/`, `/web-ui`, `/host`, `/landing`), Docker images, and GitHub Actions. The E2E and stress workflows install Wrangler from the root `package.json` devDependency, so the root npm Dependabot lane owns the Wrangler version rather than a second workflow-local pin.

**Node Docker image major updates are ignored.** The `docker.io/library/node` and `public.ecr.aws/docker/library/node` images are pinned to suppress semver-major proposals. Dependabot would otherwise propose Node Current (odd, non-LTS) releases such as Node 25. Node major upgrades are handled manually when a new LTS version is released (even major: 22, 24, 26, ...).

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `deploy.yml` | `workflow_run` when PR Checks complete green on `main` + `workflow_dispatch` (production/integration/enterprise/enterprise integration) | Full pipeline: tests, typecheck, Docker build, Trivy vulnerability scan, wrangler deploy, worker secrets. Deploy only fires after checks pass - eliminates the parallel-trigger race where a broken merge could deploy before checks failed. |
| `test.yml` | PRs to `main` or `develop`, push to `main` + `workflow_dispatch` | Runs lint, tests, typecheck, build verification, dead-code and dependency checks. The host lane installs rclone. A green push-to-main run signals deploy; the open develop-to-main PR supplies develop coverage. |
| `e2e.yml` | `workflow_dispatch` (integration/production) | E2E tests against deployed worker - sequential jobs with dependency chains: `setup` -> `e2e-api` -> `e2e-ui-desktop` -> `e2e-ui-mobile` |
| `codeql.yml` | Push to `main`, PRs to `main`, weekly (Monday 06:00 UTC) | Scans JavaScript and TypeScript and uploads SARIF. Its config excludes vendored Impeccable scripts, which are refreshed wholesale by shadow-pin bumps and do not run in the production request path. |
| `fuzz.yml` | PRs to `main`, weekly (Sunday 04:00 UTC) + `workflow_dispatch` | Property-based fuzzing with fast-check (50,000 iterations) |
| `scorecard.yml` | Push to `main`, weekly (Monday 06:00 UTC) + `workflow_dispatch` | OSSF Scorecard security posture assessment, publishes results and uploads SARIF |
| `pentest.yml` | Weekly (Monday 05:00 UTC) + `workflow_dispatch` | External black-box penetration testing: security headers, TLS, auth gate, info disclosure, injection attacks, HTTP methods |
| `stress-test.yml` | `workflow_dispatch` | k6 stress tests (API throughput, session lifecycle, storage operations, rate-limit validation) against integration worker. Configurable concurrency via `STRESS_TEST_CONCURRENCY` variable. |
| `deploy-dockerhub.yml` | `workflow_dispatch` (production/integration/enterprise/enterprise integration) | Fallback deploy pipeline near-identical to `deploy.yml` but pushes the container image to Docker Hub instead of `registry.cloudflare.com`. |
| `bump-shadow-pins.yml` | Weekly (Monday 06:00 UTC) + `workflow_dispatch` | Tracks non-Dependabot pins: context-mode, graphify plugin version, Dockerfile binaries, Bun, the `consult-llm-mcp` Dockerfile global-install pin, the `chrome-devtools-mcp` Dockerfile baked-cache pin, every Pi preseed npm pin, and the vendored Impeccable skill bundle for Claude Code + Pi. |

Additional details:

**`deploy-dockerhub.yml`:** Fallback deploy pipeline near-identical to `deploy.yml` but pushes the container image to Docker Hub instead of `registry.cloudflare.com`. Used when the Cloudflare managed registry drops connections mid-upload. Before the Trivy scan it frees disk on the runner — prunes the local build cache, removes stale `*-container` images (keeping the image being scanned), and prunes dangling layers — so the scan's image export does not exhaust the Docker data root when using a persistent self-hosted runner (the `RUNNER` Actions variable; defaults to `ubuntu-latest`). The build itself caches via `type=gha`, so this does not cause cold builds. Requires `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` secrets.

**`bump-shadow-pins.yml`:** Tracks non-Dependabot pins: context-mode, graphify plugin version, Dockerfile binaries, Bun, the `consult-llm-mcp` Dockerfile global-install pin, the `chrome-devtools-mcp` Dockerfile baked-cache pin, every Pi preseed npm pin, and the vendored Impeccable skill bundle for Claude Code + Pi. Opens one PR per bump and regenerates matching lockfiles/agent seed when duplicated literals change. Pi lockfile-only regeneration goes through `scripts/regenerate-pi-preseed-lock.mjs`, which suppresses lifecycle scripts because the committed payload layout differs deliberately from the flattened runtime npm layout. SHA256 checksums are invalidated on Dockerfile-binary bumps.

The OpenVSCode job validates upstream release tags against a strict version pattern before creating outputs. Its write-enabled shell steps receive the validated version and derived branch through quoted environment variables, so release metadata is never parsed as shell source ([REQ-OPS-020](../../sdd/spec/operations.md#req-ops-020-shadow-pin-version-bump-automation)).

The Pi preseed job is data-driven: it diffs **every** dependency in `preseed/agents/pi/package.json` against npm latest — `@gotgenes/pi-subagents`, context-mode, and the five tool extensions (`@juicesharp/rpiv-advisor`, `@juicesharp/rpiv-ask-user-question`, `@juicesharp/rpiv-todo`, `pi-web-access`, `pi-mcp-adapter`). Each version is duplicated as a literal in entrypoint.sh (the Pi settings `required` install array — so context-mode is enabled by default and the extensions stay available regardless of the `/ctx` toggle), `codeflare-pi.ts`, the pinned-version test assertions, and the generated seed. Dependabot intentionally skips that directory, so this workflow keeps every copy aligned.

### GitHub Environments

| Environment | Used by | Trigger |
|-------------|---------|---------|
| `production` | `deploy.yml`, `pentest.yml` | Auto on push to `main`, or manual dispatch with `production` selected |
| `integration` | `deploy.yml`, `e2e.yml`, `stress-test.yml` | Manual dispatch with `integration` selected |

The non-default enterprise environments, account overrides, and dispatch procedure are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private).

### GitHub Secrets and Variables

A default deployment requires only these repository secrets:

| Secret | Used by | Purpose |
|--------|---------|---------|
| `CLOUDFLARE_API_TOKEN` | `deploy.yml`, `e2e.yml` | Wrangler authentication, resource setup, image push, and Worker deploy |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml`, `e2e.yml` | Identifies the target Cloudflare account |

Non-default mode credentials, optional deployment variables, environment overrides, fallback registries, and E2E service credentials are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private). This public lane intentionally does not duplicate that operational matrix.

### Deploy Workflow Detail

**Workflow permissions:** top-level is `contents: read` (read-only default); the `deploy` job adds `actions: write` (required only for `type=gha` BuildKit cache writes). Code-scanning least-privilege hardening (#56).

1. Install dependencies (cached via `actions/cache`)
2. Build frontend, then build landing page (`landing/` → `web-ui/dist/landing/`; order matters — the web-ui build wipes `dist/`), run backend + frontend + landing tests, generate Workers runtime types (`wrangler types`), typecheck both
3. Resolve/create KV namespace, patch `wrangler.toml` with KV ID
4. Apply worker name and container tier from `RESSOURCE_TIER` (low=basic 0.25vCPU/1GiB/4GB, default/saas=1vCPU/3GiB/6GB, high=2vCPU/6GiB/8GB). All tiers default to 10 max instances; `MAX_INSTANCES` variable overrides if set
5. Optionally generate `.cache-bust` for AI agent layer
6. Build Docker image locally (base image pulled from `public.ecr.aws/docker/library/node:24-bookworm-slim` - AWS ECR Public mirror avoids Docker Hub anonymous pull rate limits on shared runners)
7. Scan with Trivy (HIGH/CRITICAL severity, `ignore-unfixed: true`; `.trivyignore` for fixable CVEs consciously accepted — see [Security §Container Image Scanning](security.md#container-image-scanning-req-sec-011))
8. Push image to Cloudflare registry via `wrangler containers push` (wrapped in a bounded retry loop — up to 30 attempts, 30s apart — for transient registry/control-plane push failures), extract registry URI
9. Patch `wrangler.toml` `image` field to registry URI (skips Docker rebuild on deploy)
10. Deploy with `npx wrangler deploy` passing `--var` for runtime config.

      Wrapped in the same bounded retry loop (up to 30 attempts, 30s apart) so a transient CF control-plane error — e.g. 100146 "Worker version not found", or a 500 on container-app image swap — never wastes the completed build; a hard `exit 1` follows exhaustion. `deploy-dockerhub.yml` applies the identical pattern to its `docker push` and `wrangler deploy` steps.
11. Set worker secrets: `CLOUDFLARE_API_TOKEN`, optional `SERVICE_AUTH_SECRET` (E2E), optional `RESEND_API_KEY`
12. Seed E2E service user in KV allowlist when `CF_ACCESS_CLIENT_SECRET` is present

### Test Workflow Detail

Two parallel jobs:
- **test**:
    - Lint (oxlint), build frontend, run backend tests, host hook tests (`node --test`), frontend tests, landing tests (`npm test` in `working-directory: landing` — Container-API render + unit tests)
    - generate Workers runtime types (`wrangler types`), typecheck both, dead code check (knip), `npm audit --audit-level=high --omit=dev` for backend and frontend
- **dependency-review**: Runs `actions/dependency-review-action` on PRs - blocks merging if new dependencies introduce known vulnerabilities

### E2E Workflow Detail

Sequential jobs with dependency chains: `setup` -> `e2e-api` -> `e2e-ui-desktop` -> `e2e-ui-mobile`:
1. **setup** job: Sets `SERVICE_AUTH_SECRET` on target worker, seeds E2E service user in KV, smoke-tests auth with retry loop (handles KV eventual consistency ~60s)
2. **e2e-api** job (depends on `setup`): Runs API test suite
3. **e2e-ui-desktop** job (depends on `setup` + `e2e-api`): Runs UI desktop tests. Installs Chrome via `npx puppeteer browsers install chrome` + system shared libraries
4. **e2e-ui-mobile** job (depends on `setup` + `e2e-ui-desktop`): Runs UI mobile tests with `E2E_MOBILE=1`. Failed runs upload screenshots/HTML as artifacts (5-day retention)

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

**CI workerd crash guard:** `@cloudflare/vitest-pool-workers` 0.16.x crashes `workerd` at pool teardown after all tests pass — a known upstream flake. The backend test step in `.github/workflows/test.yml` (and the identical pre-deploy gate in `deploy.yml`) runs `npm test` once with `NO_COLOR=1`/`FORCE_COLOR=0` so the summary is plain text, then inspects the exit code: on a non-zero exit it accepts the run only when all four conditions hold — the crash fingerprint `[vitest-pool]: Worker cloudflare-pool emitted error.` is present, the summary reports an `Errors N error` line (the count is not pinned — per-file isolation emits one teardown crash per isolate, so a busy suite reports 2+), a `Tests N passed` line exists, and no `(Test Files|Tests) N failed` line exists.

Ordinary assertion failures (any `(Test Files|Tests) N failed` line) and incomplete runs fail the job immediately. No retry, no hardcoded error count. **Key patterns:** `vi.mock()` must be at module level BEFORE imports. Use `vi.hoisted()` for shared mutable state referenced by mock factories. `LOG_LEVEL: 'silent'` in miniflare bindings suppresses log noise. **Notable test files:** `kv-crypto.test.ts` (KV AES-256-GCM encryption + migration), `r2-sse.test.ts` (R2 SSE-C encryption).

### Frontend Tests

**Config:** `web-ui/vitest.config.ts` with jsdom + `@solidjs/testing-library`.
**Run:** `cd web-ui && npm test`
**Key patterns:** SolidJS stores use getter-based exports. Test by re-importing module after `vi.resetModules()`. Use `render()` from `@solidjs/testing-library` for component tests.

### Host Tests

**Config:** `host/package.json` with Node.js built-in test runner (`node --test`).
**Run:** `cd host && npm test` (also runs in CI via `node --test host/__tests__/*.test.js`)
**Scope:** PTY pre-warm readiness (first-output detection), activity tracker disconnect + input tracking, WebSocket input classification, server prewarm integration, entrypoint sync filter validation, server security, host module extraction, host fuzz tests, memory merge/cleanup, container memory tracking, entrypoint ECC validation, entrypoint hooks merge, metrics collection, session manager lifecycle, proactive memory injection (memory-context-inject.sh), graphify SessionStart three-tier fallback, graphify discipline preseed checks.

### Property-Based Fuzz Tests

**Library:** [fast-check](https://github.com/dubzzz/fast-check). **CI:** `fuzz.yml` runs 50,000 iterations on PRs to main, weekly, and manual dispatch.
**Local:** Default 1,000 iterations. Override with `FAST_CHECK_NUM_RUNS=50000`.

| Suite | File | What it covers |
|-------|------|----------------|
| Backend | `src/__tests__/fuzz/input-validation.fuzz.test.ts` | XML injection/parsing, getBucketName, validateKey (path traversal, null bytes, encoding tricks), KV namespacing, ReDoS, circuit breaker state machine, error types, logger, content-type helpers |
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

**Reporter:** all three Vitest configs (root, `web-ui/`, `landing/`) select the reporter from `process.env.CI`: `dot` (compact, dots + summary) in CI, `default` (full per-test output) locally. The CI workerd crash guard above and its `deploy.yml` counterpart grep only the final summary block and the pool-crash fingerprint line, both of which the `dot` reporter still prints, so the guard is unaffected by the switch.

### E2E API Tests

**Dir:** `e2e/api/` - API test files.
**Run:** `E2E_BASE_URL=https://your-app.example.com npm run test:e2e:api`
**Pattern:** Plain `fetch` via `apiRequest()` helper from `e2e/setup.ts`. No Puppeteer. Authenticates via `X-Service-Auth` header matching `SERVICE_AUTH_SECRET` worker secret.

Test files: `sessions`, `storage`, `storage-operations`, `user`, `preferences`, `setup-status`, `health`, `container`, `container-lifecycle`, `error-responses`, `rate-limiting`.

### E2E UI Tests

**Dir:** `e2e/ui/` - UI test files (run as desktop + mobile).
**Run:** `E2E_BASE_URL=https://your-app.example.com npm run test:e2e:ui`
**Mobile:** `E2E_MOBILE=1 E2E_BASE_URL=... npm run test:e2e:ui`
**Pattern:** Puppeteer + Vitest. Each suite creates a fresh page. Desktop viewport: 1280x720. Mobile viewport: 390x844 (iPhone-like).

Test files: `dashboard`, `session-lifecycle`, `header-navigation`, `settings-panel`, `storage`, `terminal-tabs`, `tiling`, `error-states`, `mobile-specific`.

### E2E Infrastructure

- **CF Access auth:** E2E API tests use `X-Service-Auth` header. UI tests use `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers via `setExtraHTTPHeaders`. CF Access intercepts browser navigation with login page - UI tests work around this by intercepting requests.
- **KV eventual consistency:** New KV entries take ~60s to propagate. E2E setup job includes retry loops with 15s waits. Test helpers use `waitForFunction` with generous timeouts.
- **CSS disable:** UI tests inject a `<style>` element via `evaluateOnNewDocument` that sets `transition: none !important; animation: none !important; scroll-behavior: auto !important` on all elements (`*, *::before, *::after`), disabling CSS transitions and animations for reliable element positioning in headless Chrome.
- **Screenshot artifacts:** Failed UI tests capture screenshots and HTML dumps to `e2e-artifacts/`. CI uploads these as artifacts with 5-day retention.
- **Suite prefix isolation:** Each E2E suite prefixes its test sessions with a unique identifier driven by the `E2E_SUITE` env var (default: `'default'`) to avoid cross-suite interference when running in parallel.

### E2E Service Token Setup

The deployed-worker credential matrix, Cloudflare Access service-token procedure, environment placement, and local E2E environment setup are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private). Public documentation retains the test behavior and suite structure without publishing operational credentials.

### E2E Test Maintenance

**Rule:** When modifying UI components or API routes, review and update corresponding E2E tests.

- **Source -> test mapping:** Session, storage, setup, and dashboard surfaces have corresponding E2E files.

  Key mappings are `src/routes/session/` -> `e2e/api/sessions.test.ts`, `src/routes/storage/` -> `e2e/api/storage.test.ts`, `src/routes/setup/` -> `e2e/api/setup-status.test.ts`, and `web-ui/.../Dashboard.tsx` -> `e2e/ui/dashboard.test.ts`. Run `grep -r 'data-testid' e2e/` to find referenced test IDs.
- **`data-testid` verification:** Every `data-testid` referenced in E2E tests must exist in the web-ui source. Grep to verify before committing.
- **Cleanup:** `afterAll` hooks handle test cleanup. If tests fail mid-run, manually restore: `npx wrangler kv key put "setup:complete" "true" --namespace-id <id> --remote`

---

## Specification Coverage

- [REQ-OPS-003](../../sdd/spec/operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit) - PR checks run lint, test, typecheck, and security audit
- [REQ-OPS-004](../../sdd/spec/operations.md#req-ops-004-e2e-test-workflow-setup-and-job-graph) - E2E test workflow setup and job graph
- [REQ-OPS-015](../../sdd/spec/operations.md#req-ops-015-e2e-per-suite-execution-and-artifact-handling) - E2E per-suite execution and artifact handling
- [REQ-OPS-018](../../sdd/spec/operations.md#req-ops-018-weekly-fuzz-testing) - Weekly fuzz testing
- [REQ-OPS-020](../../sdd/spec/operations.md#req-ops-020-shadow-pin-version-bump-automation) - Shadow-pin version bump automation

---

## Related Documentation
- [Deployment](deployment.md) - Development commands and file structure
- [Configuration](configuration.md#secrets) - Worker secrets and variables
- [pentest.md](pentest.md) - Penetration testing results
- [stress-test.md](stress-test.md) - Load testing guide
