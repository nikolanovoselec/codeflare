# Development & Deployment

Development setup, project file structure, and cost analysis.

**Audience:** Developers, Operators

## Contents

- [Enterprise Mode Secrets](#enterprise-mode-secrets)
- [Strict Gateway Egress (Enterprise Mode)](#strict-gateway-egress-enterprise-mode)
- [Development](#development)
- [File Structure](#file-structure)
- [Cost Analysis](#cost-analysis)

---

## Enterprise Mode Secrets

Enterprise Mode requires two GitHub Actions secrets in addition to the standard deploy credentials. Both are optional: when absent the deploy steps exit 0 and enterprise LLM routing is simply disabled.

| GitHub Actions Secret | Wrangler secret name | Purpose |
|-----------------------|---------------------|---------|
| `AIG_GATEWAY_URL` | `AIG_GATEWAY_URL` | AI Gateway base URL. Pushed to the Worker as a secret by the deploy workflow. |
| `AIG_TOKEN` | `AIG_TOKEN` | Cloudflare API token with the **Workers AI** permission — sent as `Authorization: Bearer` to the AI Gateway REST API. **Not** a gateway authentication token ("AI Gateway: Run") — see [Configuration - Enterprise Mode Secrets](configuration.md#enterprise-mode-secrets-optional) for the full warning. Pushed to the Worker as a secret by the deploy workflow. |

To enable Enterprise Mode:

1. Add `AIG_GATEWAY_URL` and `AIG_TOKEN` as GitHub Actions repository secrets (Settings → Secrets and variables → Actions).
2. Set the `ENTERPRISE_MODE` GitHub Actions repository **variable** to `active` (Settings → Secrets and variables → Actions → Variables tab).
3. Push to `main`. The deploy workflow reads `vars.ENTERPRISE_MODE` and passes it as `--var ENTERPRISE_MODE:active` to `wrangler deploy`, then pushes both secrets via `wrangler secret put`.

To disable Enterprise Mode: remove or clear the `ENTERPRISE_MODE` variable. The secrets can remain; without the variable the interceptor is never wired and they are unused.

> The `AIG_GATEWAY_URL` and `AIG_TOKEN` secrets are Worker secrets, not container env vars. They are never forwarded to containers. See [Security - Enterprise Mode](security.md#enterprise-mode-credential-containment-and-ca-trust) and [Configuration - Enterprise Mode Secrets](configuration.md#enterprise-mode-secrets-optional).

---

## Strict Gateway Egress (Enterprise Mode)

Strict Gateway Egress ([REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress)) has two parts. The **on/off toggle** is configured at **runtime**: it lives in the enterprise setup wizard and is persisted to KV (`setup:strict_egress`), so flipping it takes effect with no redeploy and needs **no new GitHub Actions variable or secret**. The **VPC binding** that backs it is deploy-time and **enterprise-only** (below).

**The VPC binding is injected automatically for enterprise deploys — no manual step.** The feature routes the container's **direct-internet** egress through a Workers VPC `[[vpc_networks]]` Fetcher binding (`binding = "EGRESS"`, `network_id = "cf1:network"`, `remote = true`); this deployment's own-account destinations (its R2 + account-scoped CF API / Browser Rendering) and the AI Gateway are exempt and egress direct, so R2 bisync does not depend on this binding; any other account's R2/CF host rides the binding/Gateway ([AD86](../decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)). It is committed **commented-out** in `wrangler.toml`, and `deploy.yml` uncomments it at deploy time **only when `ENTERPRISE_MODE=active`**.

It is kept commented in source so that (a) default/fork deploys, whose accounts have no Workers VPC / `cf1:network`, still deploy, and (b) the `vitest-pool-workers` test runtime (which reads `wrangler.toml`) does not try to open a remote binding with no CI credentials. Public egress through the Gateway requires only this binding plus the account's existing Zero Trust Gateway policies. On non-enterprise deploys the binding is absent, so `env.EGRESS` is undefined and direct-internet egress fails closed (503 `EGRESS_UNAVAILABLE`); the dormant state (toggle OFF or binding absent) is inert. This makes shipping the code OFF safe.

**Enable runbook (operator, not autonomous):**

1. Deploy to an enterprise environment (`ENTERPRISE_MODE=active`); `deploy.yml` injects the `EGRESS` binding and `wrangler deploy` validates it. Workers VPC is enabled by default on the account — no manual `wrangler.toml` edit is required.
2. Curate the account's existing Cloudflare Gateway policies so the container's required destinations are not caught by a block/DLP/isolate rule (codeflare never modifies these policies — see [Security](security.md#strict-gateway-egress-enterprise-mode)).
3. Verify long streaming transfers (e.g. a large `git clone` / packfile) survive the Gateway path.
4. Flip the wizard toggle ON (enterprise setup wizard → Strict Gateway Egress).

**Rollback** at any point is flipping the wizard toggle **OFF** (KV write, no redeploy); the catch-all is un-wired on the next container start and egress returns to the direct path.

---

## Development

```bash
npm install && cd web-ui && npm install && cd ..
npm run dev          # Run locally (requires Docker)
npm run lint         # Lint backend (oxlint)
npm run lint:fix     # Lint backend with auto-fix
npm run typecheck    # Type check backend
npm test             # Backend unit tests
npm run test:e2e     # E2E API tests
npm run test:e2e:ui  # E2E UI tests (Puppeteer)
npm run deploy       # DO NOT run locally -- deploys go through GitHub Actions (see CI/CD)
cd web-ui && npm run dev   # Frontend dev server
cd web-ui && npm run build # Frontend production build
```

## File Structure

```
codeflare/
├── src/               # Worker source (Hono router, routes, middleware, lib, Container DO)
├── e2e/               # E2E tests: API + UI (Puppeteer)
├── host/              # Terminal server (TypeScript) - HTTP/WS, PTY, activity tracking
├── web-ui/            # SolidJS frontend - components, stores, styles
├── scripts/           # Code generation (tutorial-seed, agent-seed, sourcemap fix)
├── tutorials/         # Tutorial content (Getting Started, Examples)
├── Dockerfile         # Multi-stage container image
├── entrypoint.sh      # Container startup script (sync, agent config, hooks)
├── wrangler.toml      # Cloudflare Workers + Containers configuration
├── vitest.config.ts   # Backend test config
└── vitest.e2e.config.ts # E2E test config
```

For the current tree, run `tree -L 2 -I node_modules` from the repo root.

### Intentional Schema Duplication (Bundle Boundary)

`src/lib/schemas.ts` (backend) and `web-ui/src/lib/schemas.ts` (frontend) contain similar Zod schemas for API response validation. This is intentional, not a DRY violation. The frontend (`web-ui/`) has its own Vite build pipeline and produces a separate bundle - it cannot import from the backend Workers module. Both schemas validate the same API contract but live in independent build targets.

### Critical Paths Inside Container

| Path | Purpose |
|------|---------|
| `/home/user` | User home directory |
| `/home/user/workspace` | Working directory (synced to R2) |
| `/home/user/.claude/` | Claude config and credentials |
| `/opt/codeflare/pi-agent/npm` | Image-local Pi extension npm seed cache (read-only at runtime) |
| `/home/user/.pi/agent/npm` | Pi extension npm runtime directory (copied from seed on startup) |
| `/home/user/.config/rclone/rclone.conf` | rclone configuration |
| `/tmp/sync-status.json` | Sync status (read by health server) |
| `/tmp/sync.log` | Sync log for debugging |

## Cost Analysis

Estimated monthly costs per active user based on Cloudflare Containers pricing.

### Per-Container Pricing

Parameters: 8h/day, 20 days/month = 160h = 576,000s active. Default tier (1 vCPU, 3 GiB, 6 GB). CPU usage: 20% average.

| Resource | Calculation | Free Tier | Billable | Rate | Cost |
|----------|-------------|-----------|----------|------|------|
| CPU (active usage) | 0.2 vCPU x 576,000s = 115,200 vCPU-s | 22,500 vCPU-s | 92,700 vCPU-s | $0.000020/vCPU-s | $1.85 |
| Memory (provisioned) | 3 GiB x 576,000s = 1,728,000 GiB-s | 90,000 GiB-s | 1,638,000 GiB-s | $0.0000025/GiB-s | $4.10 |
| Disk (provisioned) | 6 GB x 576,000s = 3,456,000 GB-s | 720,000 GB-s | 2,736,000 GB-s | $0.00000007/GB-s | $0.19 |
| Workers Paid plan | | | | | $5.00 |
| **Total** | | | | | **~$11.14/user/month** |

Notes:
- CPU billed on active usage only. Memory + disk billed on provisioned resources.
- Hibernated containers (after 30m idle) = zero cost
- R2: First 10 GB free, $0.015/GB/month after
- Pricing: [Cloudflare Containers Pricing](https://developers.cloudflare.com/containers/pricing/)

Cost scales per ACTIVE SESSION (each session = one container; a session has up to 6 terminal tabs sharing a single container). Idle containers hibernate after `sleepAfter` (default 30m, configurable 15m - 4h) of no user input. Hibernated containers = zero cost.

---

## Specification Coverage

- [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) - AIG_GATEWAY_URL and AIG_TOKEN pushed as Worker secrets at deploy time (AC1)
- [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress) - Strict Gateway Egress: runtime-KV toggle (no new GH var/secret), enterprise-only deploy-injected VPC binding, rollback = toggle OFF (AC8)
- [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline) - Deploy workflow trigger and pre-deploy pipeline
- [REQ-OPS-002](../../sdd/spec/operations.md#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push) - Docker image build, vulnerability scan, and registry push
- [REQ-OPS-013](../../sdd/spec/operations.md#req-ops-013-deploy-command-and-post-deploy-hooks) - Deploy command and post-deploy hooks
- [REQ-OPS-014](../../sdd/spec/operations.md#req-ops-014-container-binding-and-scaling-from-image) - Container binding and scaling from image

---

## Governed Mode migration (batch-status driven)

Enabling or disabling [Governed Mode](configuration.md#governed-mode-r2-sse-c-disable) (the R2 SSE-C toggle) is **not** a redeploy. Flipping the Setup-wizard toggle writes the KV policy immediately; each existing bucket is reconciled to the new regime **in the background, driven by the owner's dashboard `batch-status` poll** (`planRegimeReconcile` decides synchronously; `advanceMigration` scans the bucket in concurrency-6 slices under `waitUntil`, checkpointing a `start-after` key, and starts another list + slice only while one more fits before its ~22s work deadline, then releases the lease so it always exits before the ~30s platform kill), via a lossless in-place same-key server-side `CopyObject` re-encrypt with `MetadataDirective=REPLACE` ([AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile), supersedes [AD89](../decisions/README.md#ad89-governed-mode-deployment-wide-r2-sse-c-disable-via-a-kv-toggle-with-lossless-in-place-re-encrypt-migration)).

It does **not** run on the container-start path, so it can never block session creation. No data is deleted. **Migrations advance only while the dashboard is open and polling** — closing the tab pauses (never corrupts) an in-flight migration; reopening resumes it from the checkpoint.

Operational notes:

- **Admin confirmation.** The wizard requires an explicit confirmation before flipping, because the consequence is a re-encrypt of every bucket.
- **Sessions must stop (D1: no force-kill).**

    A flip waits for a bucket's running sessions to stop before migrating that bucket (`batch-status` reports `bucketMigrationPending`); the dashboard shows the New Session button disabled with "Migrating" once the migration begins. The admin should ask users to close sessions so their buckets converge promptly.
- **Gated + verified + self-healing.**

    While a bucket migrates, every R2 writer returns `409 BUCKET_MIGRATING` and running containers are drained (best-effort), so worker-routed writes can't store the wrong regime and a stray from a failed container drain is caught by the verification rescan + read self-heal; the regime commits only after a full verification HEAD-scan; reads stay up via a dual-regime fallback and a stray cross-regime object self-heals (`mixed-recovery`). It is idempotent/resumable (a single source-regime HEAD skips already-migrated objects via its `400/403` SSE-mismatch) and the per-chunk lease self-recovers a crashed pass.
- **Bounds.**

    The migration is slice-chunked + `start-after`-resumable; each poll invocation scans in concurrency-6 slices (each object = one source HEAD + one `CopyObject`), checkpointing the last-processed key after every chunk, and starts another list + slice only while one more fits before its ~22s work deadline (checking real elapsed time, reserving one list + slice's worst case ≈ `LIST + HEAD + COPY`) — or before the subrequest ceiling (`MAX_SUBREQUESTS`) — then releases the lease so the next poll resumes from the checkpoint. `WORK_DEADLINE_MS + MIGRATE_SLICE_MS < 30s` keeps the last started slice inside the platform `waitUntil` window. Per-op R2 timeouts AbortController-cancel a hung request so it can't stall a slice.

    A small-to-medium bucket completes migrate + verify in a single poll (seconds); a large bucket converges over successive polls. A single object over 5 GB (R2's single-`CopyObject` limit) is recorded and skipped so the rest of the bucket still converges, rather than wedging the pass.
- **Rollback.** Turning the toggle OFF re-encrypts buckets back to SSE-C the same way.
- **Recovery.**

    If a bucket is left mixed by an earlier failure, the next read of a stray object self-heals it (a `mixed-recovery` scan re-encrypts every stray to the committed regime). Verify with an R2 S3 HEAD-scan: every object reads under the committed regime's SSE-C headers.

## Related Documentation
- [CI/CD](deployment.md#ci-and-cd-reference) - GitHub Actions workflows and testing
- [Configuration](configuration.md) - Environment variables and secrets
- [Container](architecture.md#container-container-image) - Container image contents
- [Architecture](architecture.md) - System component overview

## CI and CD reference

GitHub Actions workflows, test suites, E2E infrastructure, and deployment pipeline.

**Audience:** Developers

## CI and CD — CI/CD (GitHub Actions)

Workflows covering deploy, testing, fuzzing, penetration testing, stress testing, supply chain security, and dependency pin maintenance. Additionally, GitHub's built-in **secret scanning** (with push protection) and **Dependabot security updates** are enabled at the repository level.

### CI and CD — Dependabot Configuration

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

**`bump-shadow-pins.yml`:** Tracks non-Dependabot pins: context-mode, graphify plugin version, Dockerfile binaries, Bun, the `consult-llm-mcp` Dockerfile global-install pin, the `chrome-devtools-mcp` Dockerfile baked-cache pin, every Pi preseed npm pin, and the vendored Impeccable skill bundle for Claude Code + Pi. Opens one PR per bump and regenerates matching lockfiles/agent seed when duplicated literals change. SHA256 checksums are invalidated on Dockerfile-binary bumps.

The Pi preseed job is data-driven: it diffs **every** dependency in `preseed/agents/pi/package.json` against npm latest — `@gotgenes/pi-subagents`, context-mode, and the five tool extensions (`@juicesharp/rpiv-advisor`, `@juicesharp/rpiv-ask-user-question`, `@juicesharp/rpiv-todo`, `pi-web-access`, `pi-mcp-adapter`). Each version is duplicated as a literal in entrypoint.sh (the Pi settings `required` install array — so context-mode is enabled by default and the extensions stay available regardless of the `/ctx` toggle), `codeflare-pi.ts`, the pinned-version test assertions, and the generated seed. Dependabot intentionally skips that directory, so this workflow keeps every copy aligned.

### CI and CD — GitHub Environments

| Environment | Used by | Trigger |
|-------------|---------|---------|
| `production` | `deploy.yml`, `pentest.yml` | Auto on push to `main`, or manual dispatch with `production` selected |
| `integration` | `deploy.yml`, `e2e.yml`, `stress-test.yml` | Manual dispatch with `integration` selected |
| `enterprise` | `deploy.yml`, `deploy-dockerhub.yml` | Manual dispatch with `enterprise` selected; deployable from any branch ([REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC7) |
| `enterprise integration` | `deploy.yml`, `deploy-dockerhub.yml` | Manual dispatch with `enterprise integration` selected; deployable from any branch; separate concurrency group from `integration` ([REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC7) |

### CI and CD — GitHub Secrets and Variables

**Secrets (repository-level):**

| Secret | Required | Used by | Purpose |
|--------|----------|---------|---------|
| `CLOUDFLARE_API_TOKEN` | Yes | `deploy.yml`, `e2e.yml` | Wrangler CLI auth, KV operations, container push, worker deploy, secret management |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | `deploy.yml`, `e2e.yml` | Identifies the Cloudflare account for all API operations |
| `RESEND_API_KEY` | If onboarding or SaaS mode active | `deploy.yml` | Notification emails via Resend (waitlist submissions + access requests) |
| `OAUTH_CLIENT_ID` | If onboarding or SaaS mode active | `deploy.yml` | GitHub OAuth app client id; injected as a worker `--var` for the sign-in flow |
| `OAUTH_CLIENT_SECRET` | If onboarding or SaaS mode active | `deploy.yml` | GitHub OAuth app client secret; set as a worker secret via `wrangler secret put` |
| `OAUTH_JWT_SECRET` | If onboarding or SaaS mode active | `deploy.yml` | Signs the post-OAuth session JWT; set as a worker secret via `wrangler secret put` |
| `CF_ACCESS_CLIENT_ID` | For E2E | `deploy.yml`, `e2e.yml` | CF Access service token ID for E2E auth |
| `CF_ACCESS_CLIENT_SECRET` | For E2E | `deploy.yml`, `e2e.yml` | CF Access service token secret; also used as `SERVICE_AUTH_SECRET` worker secret and KV seeding |
| `DOCKERHUB_USERNAME` | For Docker Hub fallback | `deploy-dockerhub.yml` | Docker Hub account that owns the image repo |
| `DOCKERHUB_TOKEN` | For Docker Hub fallback | `deploy-dockerhub.yml` | Access token (read+write+delete scope) for pushing images |

**Variables:**

| Variable | Default | Used by | Purpose | Default source |
|----------|---------|---------|---------|----------------|
| `CLOUDFLARE_WORKER_NAME` | `codeflare` | `deploy.yml`, `e2e.yml` | Worker name for deploy and E2E target resolution | Hardcoded fallback in workflow |
| `RUNNER` | `ubuntu-latest` | All workflows | GitHub Actions runner label (self-hosted support) | Hardcoded fallback in workflow |
| `E2E_BASE_URL` | - | `e2e.yml` | Base URL of deployed worker for E2E tests | Set per environment |
| `ONBOARDING_LANDING_PAGE` | `inactive` | `deploy.yml` | Enables the public landing + onboarding `/login` via `--var`; when `active`, also triggers GitHub OAuth provisioning, so the three `OAUTH_*` secrets above are required | Hardcoded fallback in workflow |
| `RESSOURCE_TIER` | unset (1 vCPU, 3 GiB, 6 GB) | `deploy.yml` | Container instance size (low/default/high/saas). All tiers default to 10 max instances | Defaults to `default` in deploy step |
| `MAX_INSTANCES` | unset (10) | `deploy.yml` | Override container max_instances. Must be a positive integer | Passed via env to avoid shell injection |
| `CLAUDE_CODE_CACHE_BUSTER` | `inactive` | `deploy.yml` | When `active`, writes `.cache-bust` to invalidate AI agent Docker layer | Not set by default |
| `MAX_SESSIONS_USER` | `3` | `deploy.yml` | Per-user session cap passed via `--var` | Omitted if unset (backend default applies) |
| `MAX_SESSIONS_ADMIN` | `10` | `deploy.yml` | Per-admin session cap passed via `--var` | Omitted if unset (backend default applies) |
| `PENTEST_TARGET` | - | `pentest.yml` | Base URL for penetration tests (e.g., `https://codeflare.ch`) | Set per `production` environment |
| `STRESS_TEST_CONCURRENCY` | `0` (disabled) | `stress-test.yml` | k6 virtual user scaling factor. When >0, scales VU targets proportionally and loosens latency thresholds. | Set per `integration` environment |

### CI and CD — Deploy Workflow Detail

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

### CI and CD — Test Workflow Detail

Two parallel jobs:
- **test**:
    - Lint (oxlint), build frontend, run backend tests, host hook tests (`node --test`), frontend tests, landing tests (`npm test` in `working-directory: landing` — Container-API render + unit tests)
    - generate Workers runtime types (`wrangler types`), typecheck both, dead code check (knip), `npm audit --audit-level=high --omit=dev` for backend and frontend
- **dependency-review**: Runs `actions/dependency-review-action` on PRs - blocks merging if new dependencies introduce known vulnerabilities

### CI and CD — E2E Workflow Detail

Sequential jobs with dependency chains: `setup` -> `e2e-api` -> `e2e-ui-desktop` -> `e2e-ui-mobile`:
1. **setup** job: Sets `SERVICE_AUTH_SECRET` on target worker, seeds E2E service user in KV, smoke-tests auth with retry loop (handles KV eventual consistency ~60s)
2. **e2e-api** job (depends on `setup`): Runs API test suite
3. **e2e-ui-desktop** job (depends on `setup` + `e2e-api`): Runs UI desktop tests. Installs Chrome via `npx puppeteer browsers install chrome` + system shared libraries
4. **e2e-ui-mobile** job (depends on `setup` + `e2e-ui-desktop`): Runs UI mobile tests with `E2E_MOBILE=1`. Failed runs upload screenshots/HTML as artifacts (5-day retention)

### CI and CD — Pentest Workflow Detail

Six parallel jobs, each running lightweight external probes against the production deployment using only `curl` and `openssl` (no heavy scanning tools). All jobs use the `production` GitHub environment and read `PENTEST_TARGET` from environment variables.

1. **security-headers**: Verifies presence of HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. Confirms `X-Powered-By` is absent.
2. **tls**: Confirms TLS 1.3 works, TLS 1.0/1.1 are rejected, HSTS preload is enabled, and the certificate has at least 14 days before expiry.
3. **auth-gate**: Sends unauthenticated requests to seven API endpoints and confirms they all require CF Access (302/401/403). Tests that injecting `cf-access-authenticated-user-email` headers does not bypass authentication.
4. **info-disclosure**: Probes for sensitive files (`/.env`, `/.git/config`, `/api/debug`), checks that responses contain no secrets or stack traces.
5. **injection**: Tests host header injection (spoofed `Host` returns 403), `X-Forwarded-Host` has no effect on content, CL/TE request smuggling is rejected, and path traversal payloads (`%2e%2e`, double-encoded, backslash, unicode) are blocked at the auth layer.
6. **http-methods**: Verifies TRACE returns 405 and WebSocket upgrade without authentication returns 302.

**Requires:** `PENTEST_TARGET` variable set in the `production` GitHub environment (e.g., `https://codeflare.ch`). See the full manual test report in [pentest.md](security.md#penetration-testing-reference).

---

## CI and CD — Testing

### CI and CD — Backend Tests

**Config:** `vitest.config.ts` with `@cloudflare/vitest-pool-workers` `cloudflareTest()` plugin - tests run in real Workers runtime (not Node.js). **Run:** `npm test` **Coverage:** v8 provider, thresholds: 50% statement/function/line, 40% branch.

**CI workerd crash guard:** `@cloudflare/vitest-pool-workers` 0.16.x crashes `workerd` at pool teardown after all tests pass — a known upstream flake. The backend test step in `.github/workflows/test.yml` (and the identical pre-deploy gate in `deploy.yml`) runs `npm test` once with `NO_COLOR=1`/`FORCE_COLOR=0` so the summary is plain text, then inspects the exit code: on a non-zero exit it accepts the run only when all four conditions hold — the crash fingerprint `[vitest-pool]: Worker cloudflare-pool emitted error.` is present, the summary reports an `Errors N error` line (the count is not pinned — per-file isolation emits one teardown crash per isolate, so a busy suite reports 2+), a `Tests N passed` line exists, and no `(Test Files|Tests) N failed` line exists.

Ordinary assertion failures (any `(Test Files|Tests) N failed` line) and incomplete runs fail the job immediately. No retry, no hardcoded error count. **Key patterns:** `vi.mock()` must be at module level BEFORE imports. Use `vi.hoisted()` for shared mutable state referenced by mock factories. `LOG_LEVEL: 'silent'` in miniflare bindings suppresses log noise. **Notable test files:** `kv-crypto.test.ts` (KV AES-256-GCM encryption + migration), `r2-sse.test.ts` (R2 SSE-C encryption).

### CI and CD — Frontend Tests

**Config:** `web-ui/vitest.config.ts` with jsdom + `@solidjs/testing-library`.
**Run:** `cd web-ui && npm test`
**Key patterns:** SolidJS stores use getter-based exports. Test by re-importing module after `vi.resetModules()`. Use `render()` from `@solidjs/testing-library` for component tests.

### CI and CD — Host Tests

**Config:** `host/package.json` with Node.js built-in test runner (`node --test`).
**Run:** `cd host && npm test` (also runs in CI via `node --test host/__tests__/*.test.js`)
**Scope:** PTY pre-warm readiness (first-output detection), activity tracker disconnect + input tracking, WebSocket input classification, server prewarm integration, entrypoint sync filter validation, server security, host module extraction, host fuzz tests, memory merge/cleanup, container memory tracking, entrypoint ECC validation, entrypoint hooks merge, metrics collection, session manager lifecycle, proactive memory injection (memory-context-inject.sh), graphify SessionStart three-tier fallback, graphify discipline preseed checks.

### CI and CD — Property-Based Fuzz Tests

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

### CI and CD — Vitest Configuration

Both root and `web-ui/` use Vitest v4.x with independent `node_modules` and separate configs. Root uses the `cloudflareTest()` plugin from `@cloudflare/vitest-pool-workers` v0.13+ (replaces the old `defineWorkersConfig()` pattern). Web-UI uses jsdom with `vite-plugin-solid`.

**Reporter:** all three Vitest configs (root, `web-ui/`, `landing/`) select the reporter from `process.env.CI`: `dot` (compact, dots + summary) in CI, `default` (full per-test output) locally. The CI workerd crash guard above and its `deploy.yml` counterpart grep only the final summary block and the pool-crash fingerprint line, both of which the `dot` reporter still prints, so the guard is unaffected by the switch.

### CI and CD — E2E API Tests

**Dir:** `e2e/api/` - API test files.
**Run:** `E2E_BASE_URL=https://your-app.example.com npm run test:e2e:api`
**Pattern:** Plain `fetch` via `apiRequest()` helper from `e2e/setup.ts`. No Puppeteer. Authenticates via `X-Service-Auth` header matching `SERVICE_AUTH_SECRET` worker secret.

Test files: `sessions`, `storage`, `storage-operations`, `user`, `preferences`, `setup-status`, `health`, `container`, `container-lifecycle`, `error-responses`, `rate-limiting`.

### CI and CD — E2E UI Tests

**Dir:** `e2e/ui/` - UI test files (run as desktop + mobile).
**Run:** `E2E_BASE_URL=https://your-app.example.com npm run test:e2e:ui`
**Mobile:** `E2E_MOBILE=1 E2E_BASE_URL=... npm run test:e2e:ui`
**Pattern:** Puppeteer + Vitest. Each suite creates a fresh page. Desktop viewport: 1280x720. Mobile viewport: 390x844 (iPhone-like).

Test files: `dashboard`, `session-lifecycle`, `header-navigation`, `settings-panel`, `storage`, `terminal-tabs`, `tiling`, `error-states`, `mobile-specific`.

### CI and CD — E2E Infrastructure

- **CF Access auth:** E2E API tests use `X-Service-Auth` header. UI tests use `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers via `setExtraHTTPHeaders`. CF Access intercepts browser navigation with login page - UI tests work around this by intercepting requests.
- **KV eventual consistency:** New KV entries take ~60s to propagate. E2E setup job includes retry loops with 15s waits. Test helpers use `waitForFunction` with generous timeouts.
- **CSS disable:** UI tests inject a `<style>` element via `evaluateOnNewDocument` that sets `transition: none !important; animation: none !important; scroll-behavior: auto !important` on all elements (`*, *::before, *::after`), disabling CSS transitions and animations for reliable element positioning in headless Chrome.
- **Screenshot artifacts:** Failed UI tests capture screenshots and HTML dumps to `e2e-artifacts/`. CI uploads these as artifacts with 5-day retention.
- **Suite prefix isolation:** Each E2E suite prefixes its test sessions with a unique identifier driven by the `E2E_SUITE` env var (default: `'default'`) to avoid cross-suite interference when running in parallel.

### CI and CD — E2E Service Token Setup

Step-by-step for running E2E tests against a deployed worker:

1. Create a CF Access service token in Cloudflare dashboard (Access > Service Tokens)
2. Set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` as GitHub repository secrets (under `integration` environment for E2E)
3. Deploy the worker (sets `SERVICE_AUTH_SECRET` automatically from `CF_ACCESS_CLIENT_SECRET`)
4. The deploy workflow seeds `e2e-service@codeflare.local` as admin in KV allowlist
5. Run E2E via `Actions > E2E Tests > Run workflow`

For local E2E development:
```bash
export CF_ACCESS_CLIENT_ID="<your-service-token-id>"
export CF_ACCESS_CLIENT_SECRET="<your-service-token-secret>"
export E2E_BASE_URL="https://your-app.example.com"
npm run test:e2e        # All E2E tests
npm run test:e2e:api    # API tests only
npm run test:e2e:ui     # UI desktop tests only
E2E_MOBILE=1 npm run test:e2e:ui  # UI mobile tests only
```

### CI and CD — E2E Test Maintenance

**Rule:** When modifying UI components or API routes, review and update corresponding E2E tests.

- **Source -> test mapping:** Session, storage, setup, and dashboard surfaces have corresponding E2E files.

  Key mappings are `src/routes/session/` -> `e2e/api/sessions.test.ts`, `src/routes/storage/` -> `e2e/api/storage.test.ts`, `src/routes/setup/` -> `e2e/api/setup-status.test.ts`, and `web-ui/.../Dashboard.tsx` -> `e2e/ui/dashboard.test.ts`. Run `grep -r 'data-testid' e2e/` to find referenced test IDs.
- **`data-testid` verification:** Every `data-testid` referenced in E2E tests must exist in the web-ui source. Grep to verify before committing.
- **Cleanup:** `afterAll` hooks handle test cleanup. If tests fail mid-run, manually restore: `npx wrangler kv key put "setup:complete" "true" --namespace-id <id> --remote`

---

## Stress testing reference

k6-based load testing against the integration worker. Three load suites run in parallel via the `stress-test.yml` GitHub Actions workflow; a fourth suite (`rate-limit-validation`) runs separately because it requires rate limits enabled rather than bypassed.

Implements [REQ-OPS-008](../../sdd/spec/operations.md#req-ops-008-stress-testing-validates-rate-limits-and-concurrency) (rate-limit + concurrency validation under high VU load).

**Audience:** Operators

## Stress testing — Prerequisites

1. **Integration worker deployed** with `STRESS_TEST_MODE=active` (disables all rate limits - required because all VUs share one service identity)
2. **GitHub `integration` environment** with secrets (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) and variables (`E2E_BASE_URL`, `CLOUDFLARE_WORKER_NAME`)
3. **Repository-level secrets** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (used by setup job to push `SERVICE_AUTH_SECRET` and seed KV via wrangler)
4. **`STRESS_TEST_CONCURRENCY`** variable set in the `integration` environment (optional, defaults to `0` which uses baseline VU counts)

## Stress testing — Running

Go to **Actions > Stress Test > Run workflow**. Select a suite or leave as `all`.

To scale concurrency, set `STRESS_TEST_CONCURRENCY` in **Settings > Environments > integration > Environment variables**:

| Value | Effect | Real-user equivalent |
|-------|--------|---------------------|
| `0` or unset | Baseline VU counts, normal think times, standard thresholds | ~50 users |
| `50` | 5-17x baseline VUs, reduced think times, loosened thresholds | ~1 000 users |
| `200` | 20-67x baseline VUs, minimal think times, loosened thresholds | ~4 000 users |
| `1000` | 100-333x baseline VUs, minimal think times, loosened thresholds | ~20 000 users |

## Stress testing — Test Suites

### Stress testing — API Throughput (`api-throughput.js`)

Sustained load + spike test across read-only API endpoints simulating dashboard polling behavior.

| Scenario | Duration | Base VUs | Operations |
|----------|----------|----------|------------|
| `sustained_load` | 4m (ramp up, hold, ramp down) | 10 | Dashboard poll: `GET /api/sessions` (list), `GET /api/sessions/batch-status` (single-call status check), Optional: `GET /api/user`, `GET /api/preferences`, `GET /api/storage/browse` |
| `spike` | 50s (starts at 4m30s) | 20 | Same as sustained_load |

**Thresholds:**

| Metric | Threshold |
|--------|-----------|
| `http_req_duration` p95 | <5s |
| `http_req_failed` | <5% |
| `errors` | <10% |
| `session_list_duration` p95 | <5s |

**Think time:** `think(4, 6)` seconds between poll cycles - matches real frontend's ~5s poll interval. Per cycle: user/preferences (30% chance), storage/browse (20% chance). Remaining 50% of cycles are dashboard-only polling.

### Stress testing — Session Lifecycle (`session-lifecycle.js`)

Create-read-delete cycle testing session churn with realistic delays between operations.

| Scenario | Duration | Base VUs | Operations |
|----------|----------|----------|------------|
| `session_churn` | 3m (ramp up, hold, ramp down) | 3 | `POST /api/sessions` (create), `GET /api/sessions` (list), `GET /api/sessions/:id` (get), `POST /api/sessions/:id/stop` (stop), `DELETE /api/sessions/:id` (delete) |

**Rate limits hit by this suite:**
- Session create: 10/min → max ~1.6 VUs without bypass
- Session delete: 10/min → max ~1.6 VUs without bypass
- Session stop: 10/min → max ~1.6 VUs without bypass

**Thresholds:**

| Metric | Threshold |
|--------|-----------|
| `session_create_duration` p95 | <5s |
| `session_delete_duration` p95 | <3s |
| `errors` | <15% |

**Think time:** `think(3, 8)` after create, `think(2, 5)` between list/get/stop, `think(5, 15)` before delete, `think(10, 30)` between full cycles. Models a user who creates a session, works for a while, then cleans up.

### Stress testing — Storage Operations (`storage-operations.js`)

Upload-browse-download-delete cycle simulating an interactive agent session with weighted random file sizes.

File size distribution:
- 60% small files (1 KB)
- 30% medium files (20 KB)
- 10% large files (50 KB)

Folder delete testing: ~20% of iterations also test server-side prefix delete by uploading 3 files into a folder, then deleting the folder via the `prefixes` parameter (R2 list + batch delete via API).

| Scenario | Duration | Base VUs | Operations |
|----------|----------|----------|------------|
| `storage_load` | 3m (ramp up, hold, ramp down) | 5 | `POST /api/storage/upload` (simple), `GET /api/storage/browse`, `GET /api/storage/download`, `POST /api/storage/delete` (keys for individual files; prefixes for folders) |

**Rate limits hit by this suite:**
- Storage upload: 60/min → supports up to 10 VUs at baseline
- Storage browse: 30/min → max ~5 VUs
- Storage download: 120/min → max ~20 VUs (not the bottleneck)
- Storage delete: 20/min → max ~3 VUs

**Thresholds:**

| Metric | Threshold |
|--------|-----------|
| `upload_duration` p95 | <10s |
| `download_duration` p95 | <5s |
| `browse_duration` p95 | <3s |
| `errors` | <15% |

**Think time:** `think(3, 8)` after upload, `think(2, 5)` between browse/download/delete, `think(5, 15)` between full cycles. Models a user editing files in an active Codeflare session. Folder prefix delete operations add `think(1, 3)` between folder setup and delete.

### Stress testing — Stress Test with Rate Limits (`rate-limit-validation.js`)

Validates that rate limits ARE enforced when `STRESS_TEST_MODE` is **not** set. Runs a single VU that bursts session creates past the configured limit and verifies 429 responses.

**Must be run separately** - select `rate-limit-validation` from the suite dropdown. Not included in `all` because the load test suites require rate limits to be off.

| Check | Pass condition |
|-------|---------------|
| Rate limit enforced | At least one 429 returned |
| Requests succeed before limit | Some 201s before hitting cap |
| Cap not exceeded | Successful creates ≤ rate limit cap |
| No server errors | Unexpected error rate < 5% |

**Prerequisite:** `STRESS_TEST_MODE` must NOT be set on the worker (or set to anything other than `"active"`).

## Stress testing — Session Lifecycle Rate Limits Detail

The session lifecycle suite hits multiple 10/min rate limits:

1. **Session create** (`POST /api/sessions`) - 10/min
2. **Session delete** (`DELETE /api/sessions/:id`) - 10/min
3. **Session stop** (`POST /api/sessions/:id/stop`) - 10/min

With 3 base VUs and each cycle taking ~20-60 seconds, the VUs are throttled by the 10/min cap (max ~1.6 VUs per operation). `STRESS_TEST_MODE=active` is essential for testing beyond this limit.

The test validates that:
- Sessions are created successfully (201)
- Sessions can be fetched (200)
- Sessions can be stopped (204)
- Sessions can be deleted (204)
- Error rates remain <15% throughout

## Stress testing — Think Time Model

All scripts use a `think(min, max)` helper that adds realistic pauses between operations:

```js
function think(min, max) {
  sleep(min + Math.random() * (max - min));
}
```

This produces uniformly distributed delays between `min` and `max` seconds, simulating real user behavior (reading output, deciding next action). When `STRESS_TEST_CONCURRENCY` is set and rate limits are bypassed, think times are reduced but not eliminated - the goal is sustained throughput, not a burst attack.

**Per-user behavior stays constant regardless of VU count.** Scaling `STRESS_TEST_CONCURRENCY` adds more virtual users running the same realistic interaction pattern. A single VU's think times, request sequences, and file sizes don't change - only the number of concurrent users increases.

## Stress testing — VU-to-Real-User Mapping

**50 VUs with realistic think times approximate 1 000-5 000 real concurrent users.**

The math: with think times of 4-15s between actions, each VU's effective request rate is ~0.1-0.2 req/s - matching real human behavior (load dashboard, read output, think, act). The multiplier comes from VUs hitting all endpoint types on every iteration while real users only touch 1-2 endpoints per interaction.

Each k6 virtual user generates more traffic than a real Codeflare user. A real user typically loads the dashboard (a few API calls), then works in a terminal (one WebSocket held for minutes), with occasional storage operations - roughly 1 request every 5-10 seconds during active use.

k6 VUs use realistic think times (4-15s between actions) but hit all endpoint types on every iteration. Real users only interact with 1-2 endpoints per session.

| Suite | Think time per cycle | Requests per cycle | Effective req/s per VU | Multiplier vs real user |
|-------|---------------------|-------------------|----------------------|------------------------|
| API throughput | 4-6s (dashboard poll) | 4-6 | ~1.0 | ~5-10x |
| Session lifecycle | 20-60s (create→delete) | 4 | ~0.1 | ~1-2x |
| Storage operations | 13-33s (upload→delete) | 4 | ~0.2 | ~2-3x |

**Rule of thumb: 1 VU ≈ 20-100 real users** (varies by suite). At `STRESS_TEST_CONCURRENCY=50`, the three suites running in parallel simulate load equivalent to roughly 1 000-5 000 concurrent Codeflare users.

## Stress testing — Concurrency Scaling

All scripts use the same scaling pattern:

```js
const CONCURRENCY = parseInt(__ENV.STRESS_TEST_CONCURRENCY || '0', 10);
const BASE_VUS = <N>;
const SCALE = CONCURRENCY > 0 ? CONCURRENCY / BASE_VUS : 1;
function scaled(vus) { return Math.max(1, Math.round(vus * SCALE)); }
```

When `STRESS_TEST_CONCURRENCY=0` (default), `SCALE=1` and all VU targets remain at baseline. When set to a positive number, VU targets scale proportionally. Example: `STRESS_TEST_CONCURRENCY=50` with `BASE_VUS=10` gives `SCALE=5`, so `scaled(10)=50` VUs.

Think times stay constant regardless of concurrency - scaling adds more users running the same realistic behavior, not faster robots.

## Stress testing — Rate Limit Bypass

All VUs share a single CF Access service token (single identity). Without bypass, per-user rate limits block meaningful load testing:

| Rate Limit | Limit | Effective VUs without bypass |
|------------|-------|------------------------------|
| Session create | 10/min | Max ~1.6 VUs (one cycle every 6 seconds) |
| Session delete | 10/min | Max ~1.6 VUs |
| Session stop | 10/min | Max ~1.6 VUs |
| Container start | 5/min | Max ~0.8 VUs |
| WebSocket connect | 30/min | Max ~5 VUs (one connection every 2 seconds) |
| Storage upload | 60/min | Max ~10 VUs |
| Storage browse | 30/min | Max ~5 VUs |

Setting `STRESS_TEST_MODE=active` on the integration worker disables all rate-limit checks. The bypass:

- Requires the exact string `"active"` as an environment variable/secret - any other value keeps limits enforced
- Skips rate-limit KV reads/writes before they are checked, with zero overhead
- Logs a one-time warning per isolate when activated (`STRESS_TEST_MODE is active - all HTTP rate limits bypassed`)
- Is implemented at:
  - **HTTP requests:** `src/middleware/rate-limit.ts` (checkRateLimit skipped)
  - **WebSocket connections:** `src/routes/terminal.ts` (checkRateLimit skipped)

**Production must never have `STRESS_TEST_MODE` set.** The flag should only be enabled on integration workers used for load testing.

## Stress testing — Configuration Reference

### Stress testing — Worker environment variable

| Variable | Where | Value | Purpose | Must be exact |
|----------|-------|-------|---------|---------------|
| `STRESS_TEST_MODE` | Integration worker only | `"active"` | Disables all rate limits | Yes - any other value (e.g., `"true"`, `"enabled"`) keeps limits enforced |

Set via one of:
```bash
# Option 1: Set as environment variable (one-time, this session)
wrangler secret put STRESS_TEST_MODE
# Paste: active

# Option 2: Set via command line at deploy time
wrangler deploy --var STRESS_TEST_MODE=active

# Option 3: Set in wrangler.toml
[env.integration]
vars = { STRESS_TEST_MODE = "active" }
```

After setting, re-deploy the worker for the variable to take effect:
```bash
wrangler deploy --env integration
```

### Stress testing — GitHub variables (integration environment)

| Variable | Default | Purpose |
|----------|---------|---------|
| `STRESS_TEST_CONCURRENCY` | `0` | k6 virtual user scaling factor |
| `E2E_BASE_URL` | - | Target worker URL |
| `CLOUDFLARE_WORKER_NAME` | - | Worker name for wrangler secret/KV operations |

### Stress testing — GitHub secrets

**Integration environment secrets:**

| Secret | Purpose |
|--------|---------|
| `CF_ACCESS_CLIENT_ID` | Service token ID for CF Access |
| `CF_ACCESS_CLIENT_SECRET` | Service token secret (also pushed as `SERVICE_AUTH_SECRET` and used as `X-Service-Auth` header) |

**Repository-level secrets** (used by setup job for wrangler):

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | Wrangler API access for `secret put` and KV operations |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account for wrangler commands |

## Stress testing — Workflow Architecture

```
stress-test.yml (workflow_dispatch)
  |
  +-- setup (verify target health + auth)
  |     |
  +--+--+-- api-throughput      (parallel)
  |  |  +-- session-lifecycle   (parallel)
  |  |  +-- storage-operations  (parallel)
  |  |
  +--+--+-- summary (aggregate results, check thresholds)
```

All 3 test jobs run in parallel after setup. The summary job downloads all result artifacts and fails the workflow if any k6 threshold was breached.

Results are uploaded as artifacts (retained 30 days).

## Stress testing — Results

### Stress testing — Latest Results (2026-03-07, 50 VUs)

All three suites passed every threshold at `STRESS_TEST_CONCURRENCY=50`. Run: [#22808941531](https://github.com/nikolanovoselec/codeflare/actions/runs/22808941531).

#### Stress testing — API Throughput

| Metric | avg | p95 | max | Result |
|--------|-----|-----|-----|--------|
| `http_req_duration` | 1.37s | 3.07s | 5.63s | PASS (<5s p95) |
| `health_duration` | 27ms | 40ms | 171ms | PASS (<1s p95) |
| `session_list_duration` | 2.55s | 3.11s | 5.63s | PASS (<5s p95) |
| `http_req_failed` | 0.00% | - | - | PASS (<5%) |
| `errors` | 0.00% | - | - | PASS |
| `checks` | 100.00% (7 729/7 729) | - | - | - |

#### Stress testing — Session Lifecycle

| Metric | avg | p95 | max | Result |
|--------|-----|-----|-----|--------|
| `session_create_duration` | 103ms | 199ms | 384ms | PASS (<5s p95) |
| `session_delete_duration` | 792ms | 1.64s | 5.21s | PASS (<3s p95) |
| `errors` | 0.00% | - | - | PASS (<15%) |
| `checks` | 100.00% (804/804) | - | - | - |

#### Stress testing — Storage Operations

| Metric | avg | p95 | max | Result |
|--------|-----|-----|-----|--------|
| `upload_duration` | 285ms | 459ms | 1.04s | PASS (<10s p95) |
| `download_duration` | 112ms | 149ms | 403ms | PASS (<5s p95) |
| `browse_duration` | 80ms | 97ms | 140ms | PASS (<3s p95) |
| `errors` | 3.44% (10/290) | - | - | PASS (<15%) |
| `checks` | 98.76% (1 116/1 130) | - | - | - |

At 50 VUs with realistic think times, this represents approximately **1 000-5 000 concurrent real users** worth of load.

### Stress testing — Files

| File | Purpose |
|------|---------|
| `e2e/stress/api-throughput.js` | API endpoint throughput + spike test |
| `e2e/stress/session-lifecycle.js` | Session CRUD churn test |
| `e2e/stress/storage-operations.js` | R2 storage upload/download/delete cycle |
| `e2e/stress/rate-limit-validation.js` | Rate limit enforcement validation |
| `.github/workflows/stress-test.yml` | CI workflow orchestration |
| `src/middleware/rate-limit.ts` | HTTP rate-limit middleware; `STRESS_TEST_MODE` bypass |
| `src/routes/terminal.ts` | WebSocket auth + rate-limit; `STRESS_TEST_MODE` bypass |
| `src/lib/rate-limit-core.ts` | Core rate-limit logic (KV + in-memory fallback) |
| `src/lib/constants.ts` | `WS_RATE_LIMIT_*` constants |

### Stress testing — Subscription and Timekeeper Considerations

The subscription system introduces endpoints and a Durable Object not yet covered by existing k6 suites.

#### Stress testing — Endpoints not yet stress-tested

| Endpoint | Method | Rate Limit | Notes |
|----------|--------|------------|-------|
| `/api/auth/subscribe` | POST | 3/min | Self-service tier selection; Turnstile required |
| `/api/auth/tiers` | GET | None | Returns subscribable tier config |
| `/api/usage` | GET | None | Queries Timekeeper DO with KV fallback |
| `/api/admin/tiers` | GET/PUT | None | Admin tier config; low traffic |
| `/api/auth/onboarding-config` | GET | None | Turnstile site key |

#### Stress testing — Timekeeper DO load characteristics

The Timekeeper DO receives pings every 60 seconds from each active container session:

- **Write amplification:** Each ping triggers DO storage writes plus a KV read for quota checks
- **Flush interval:** KV writes batch every 5 minutes via alarm (not per-ping)
- **Session eviction:** `sessionTotals` map caps at 30 entries to prevent unbounded growth
- **Fail-open design:** KV read failures during quota checks are non-fatal

#### Stress testing — Container start quota check

`validateSessionAndCheckLimits()` in `src/routes/container/lifecycle-validation.ts` performs a KV read at session start. With `STRESS_TEST_MODE=active`, usage quota enforcement is bypassed (same as rate limits).

---

## Manual verification checklist

Inspect repository settings and a staging workflow run, including job graph, logs, artifacts, and billing metrics where applicable; compare each observable result with every AC.

- [ ] [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline) — verify every acceptance criterion.
- [ ] [REQ-OPS-002](../../sdd/spec/operations.md#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push) — verify every acceptance criterion.
- [ ] [REQ-OPS-003](../../sdd/spec/operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit) — verify every acceptance criterion.
- [ ] [REQ-OPS-004](../../sdd/spec/operations.md#req-ops-004-e2e-test-workflow-setup-and-job-graph) — verify every acceptance criterion.
- [ ] [REQ-OPS-005](../../sdd/spec/operations.md#req-ops-005-weekly-pentest) — verify every acceptance criterion.
- [ ] [REQ-OPS-006](../../sdd/spec/operations.md#req-ops-006-idle-containers-hibernate-and-cost-zero) — verify every acceptance criterion.
- [ ] [REQ-OPS-007](../../sdd/spec/operations.md#req-ops-007-container-specs-configurable-per-environment) — verify every acceptance criterion.
- [ ] [REQ-OPS-008](../../sdd/spec/operations.md#req-ops-008-stress-testing-validates-rate-limits-and-concurrency) — verify every acceptance criterion.
- [ ] [REQ-OPS-009](../../sdd/spec/operations.md#req-ops-009-supply-chain-security-monitoring) — verify every acceptance criterion.
- [ ] [REQ-OPS-010](../../sdd/spec/operations.md#req-ops-010-graceful-container-shutdown-preserves-data) — verify every acceptance criterion.
- [ ] [REQ-OPS-011](../../sdd/spec/operations.md#req-ops-011-container-base-image-is-debian-bookworm-slim) — verify every acceptance criterion.
- [ ] [REQ-OPS-012](../../sdd/spec/operations.md#req-ops-012-per-environment-container-concurrency-limit) — verify every acceptance criterion.
- [ ] [REQ-OPS-013](../../sdd/spec/operations.md#req-ops-013-deploy-command-and-post-deploy-hooks) — verify every acceptance criterion.
- [ ] [REQ-OPS-014](../../sdd/spec/operations.md#req-ops-014-container-binding-and-scaling-from-image) — verify every acceptance criterion.
- [ ] [REQ-OPS-015](../../sdd/spec/operations.md#req-ops-015-e2e-per-suite-execution-and-artifact-handling) — verify every acceptance criterion.
- [ ] [REQ-OPS-016](../../sdd/spec/operations.md#req-ops-016-sleepafter-preference-persistence-and-lifecycle) — verify every acceptance criterion.
- [ ] [REQ-OPS-018](../../sdd/spec/operations.md#req-ops-018-weekly-fuzz-testing) — verify every acceptance criterion.
- [ ] [REQ-OPS-019](../../sdd/spec/operations.md#req-ops-019-security-posture-scanning-workflows) — verify every acceptance criterion.
