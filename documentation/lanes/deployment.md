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

**The VPC binding is injected automatically for enterprise deploys — no manual step.** The feature routes the container's **direct-internet** egress through a Workers VPC `[[vpc_networks]]` Fetcher binding (`binding = "EGRESS"`, `network_id = "cf1:network"`, `remote = true`); this deployment's own-account destinations (its R2 + account-scoped CF API / Browser Rendering) and the AI Gateway are exempt and egress direct, so R2 bisync does not depend on this binding; any other account's R2/CF host rides the binding/Gateway ([AD86](../decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)). It is committed **commented-out** in `wrangler.toml`, and `deploy.yml` uncomments it at deploy time **only when `ENTERPRISE_MODE=active`**. It is kept commented in source so that (a) default/fork deploys, whose accounts have no Workers VPC / `cf1:network`, still deploy, and (b) the `vitest-pool-workers` test runtime (which reads `wrangler.toml`) does not try to open a remote binding with no CI credentials. Public egress through the Gateway requires only this binding plus the account's existing Zero Trust Gateway policies. On non-enterprise deploys the binding is absent, so `env.EGRESS` is undefined and direct-internet egress fails closed (503 `EGRESS_UNAVAILABLE`); the dormant state (toggle OFF or binding absent) is inert. This makes shipping the code OFF safe.

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

Cost scales per ACTIVE SESSION (each session = one container; a session has up to 6 terminal tabs sharing a single container). Idle containers hibernate after `sleepAfter` (default 30m, configurable 5m - 2h) of no user input. Hibernated containers = zero cost.

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

Enabling or disabling [Governed Mode](configuration.md#governed-mode-r2-sse-c-disable) (the R2 SSE-C toggle) is **not** a redeploy. Flipping the Setup-wizard toggle writes the KV policy immediately; each existing bucket is reconciled to the new regime **in the background, driven by the owner's dashboard `batch-status` poll** (`planRegimeReconcile` decides synchronously; `advanceMigration` scans the bucket in concurrency-6 slices under `waitUntil`, checkpointing a `start-after` key, and starts another list + slice only while one more fits before its ~22s work deadline, then releases the lease so it always exits before the ~30s platform kill), via a lossless in-place same-key server-side `CopyObject` re-encrypt with `MetadataDirective=REPLACE` ([AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile), supersedes [AD89](../decisions/README.md#ad89-governed-mode-deployment-wide-r2-sse-c-disable-via-a-kv-toggle-with-lossless-in-place-re-encrypt-migration)). It does **not** run on the container-start path, so it can never block session creation. No data is deleted. **Migrations advance only while the dashboard is open and polling** — closing the tab pauses (never corrupts) an in-flight migration; reopening resumes it from the checkpoint.

Operational notes:

- **Admin confirmation.** The wizard requires an explicit confirmation before flipping, because the consequence is a re-encrypt of every bucket.
- **Sessions must stop (D1: no force-kill).** A flip waits for a bucket's running sessions to stop before migrating that bucket (`batch-status` reports `bucketMigrationPending`); the dashboard shows the New Session button disabled with "Migrating" once the migration begins. The admin should ask users to close sessions so their buckets converge promptly.
- **Gated + verified + self-healing.** While a bucket migrates, every R2 writer returns `409 BUCKET_MIGRATING` and running containers are drained (best-effort), so worker-routed writes can't store the wrong regime and a stray from a failed container drain is caught by the verification rescan + read self-heal; the regime commits only after a full verification HEAD-scan; reads stay up via a dual-regime fallback and a stray cross-regime object self-heals (`mixed-recovery`). It is idempotent/resumable (a single source-regime HEAD skips already-migrated objects via its `400/403` SSE-mismatch) and the per-chunk lease self-recovers a crashed pass.
- **Bounds.** The migration is slice-chunked + `start-after`-resumable; each poll invocation scans in concurrency-6 slices (each object = one source HEAD + one `CopyObject`), checkpointing the last-processed key after every chunk, and starts another list + slice only while one more fits before its ~22s work deadline (checking real elapsed time, reserving one slice's worst case ≈ `HEAD + COPY`) — or before the subrequest ceiling (`MAX_SUBREQUESTS`) — then releases the lease so the next poll resumes from the checkpoint. `WORK_DEADLINE_MS + MIGRATE_SLICE_MS < 30s` keeps the last started slice inside the platform `waitUntil` window. Per-op R2 timeouts AbortController-cancel a hung request so it can't stall a slice. A small-to-medium bucket completes migrate + verify in a single poll (seconds); a large bucket converges over successive polls. A single object over 5 GB (R2's single-`CopyObject` limit) is recorded and skipped so the rest of the bucket still converges, rather than wedging the pass.
- **Rollback.** Turning the toggle OFF re-encrypts buckets back to SSE-C the same way.
- **Recovery.** If a bucket is left mixed by an earlier failure, the next read of a stray object self-heals it (a `mixed-recovery` scan re-encrypts every stray to the committed regime). Verify with an R2 S3 HEAD-scan: every object reads under the committed regime's SSE-C headers.

## Related Documentation
- [CI/CD](ci-cd.md) - GitHub Actions workflows and testing
- [Configuration](configuration.md) - Environment variables and secrets
- [Container](container.md#container-image) - Container image contents
- [Architecture](architecture.md) - System component overview
