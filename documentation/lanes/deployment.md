# Development & Deployment

Development setup, project file structure, and cost analysis.

**Audience:** Developers, Operators

## Contents

- [Enterprise Mode Secrets](#enterprise-mode-secrets)
- [Strict Gateway Egress (Enterprise Mode)](#strict-gateway-egress-enterprise-mode)
- [Production Rollback](#production-rollback)
- [Development](#development)
- [File Structure](#file-structure)
- [Cost Analysis](#cost-analysis)
- [Manual verification checklist](#manual-verification-checklist)

---

## Enterprise Mode Secrets

The enterprise GitHub Environment layout, activation variable, account overrides, AI Gateway fallback secrets, required token permissions, and deployment procedure are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private). This public lane intentionally does not duplicate non-default deployment credentials.

---

## Strict Gateway Egress (Enterprise Mode)

The enterprise-only binding procedure, Gateway policy preparation, verification steps, and rollback runbook are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private#strict-gateway-egress). The behavioral contract remains public in [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress).

---

## Production Rollback

**When:** The active production Worker deployment is faulty and the previous version remains compatible with current bindings and stored data.

**Command:** Run `npx wrangler rollback`, then select the last known-good Worker version. Cloudflare immediately creates a deployment that sends 100% of traffic to that version.

**Verifies:** Confirm the selected version receives 100% traffic, then check the production `/health` endpoint and the affected user flow.

**Rollback:** If the selected version is incompatible with current bindings or stored data, redeploy the previously active commit. Worker rollbacks do not change connected resources or bindings. See [Cloudflare's rollback guidance](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).

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

The operator procedure, migration bounds, pause/resume behavior, verification, rollback, and recovery guidance are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private#governed-mode-migration). The public state-machine rationale remains in [AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile).

## Related Documentation
- [CI/CD](ci-cd.md) - GitHub Actions workflows and testing
- [Configuration](configuration.md) - Environment variables and secrets
- [Container](container.md#container-image) - Container image contents
- [Architecture](architecture.md) - System component overview
