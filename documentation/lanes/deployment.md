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
- [Specification Coverage](#specification-coverage)
- [Governed Mode migration (batch-status driven)](#governed-mode-migration-batch-status-driven)
- [Related Documentation](#related-documentation)

---

## Enterprise Mode Secrets

The enterprise GitHub Environment layout, activation variable, account overrides, AI Gateway fallback secrets, required token permissions, and deployment procedure are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private). This public lane intentionally does not duplicate non-default deployment credentials.

---

## Strict Gateway Egress (Enterprise Mode)

The enterprise-only binding procedure, Gateway policy preparation, verification steps, and rollback runbook are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private#strict-gateway-egress). The behavioral contract remains public in [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress).

---

## Production Rollback

**When:** The active production Worker deployment is faulty and a previous version remains compatible with current bindings and stored data.

**Prerequisites:** Run from the repository root with the production `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` exported, then confirm `npx wrangler whoami` names the production account. In the incident record, capture the failed user-flow step and its expected result before rollback.

**Command:** List successful production workflow runs and Worker deployments. Choose the newest deployment created before the faulty release whose timestamp matches a successful `Deploy` run, inspect that candidate, then pass its exact ID to rollback using the [Wrangler Worker commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/):

```sh
gh run list --workflow deploy.yml --branch main --status success --limit 10
npx wrangler deployments list
npx wrangler versions view <CANDIDATE_VERSION_ID>
npx wrangler rollback <CANDIDATE_VERSION_ID>
```

Cloudflare immediately creates a deployment that sends 100% of traffic to the selected version, as defined by its [rollback behavior](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).

**Verifies:** Confirm the active deployment, public health, and provider discovery:

```sh
npx wrangler deployments status
curl -fsS https://codeflare.ch/health
curl -fsS https://codeflare.ch/public/auth/providers | jq -e '.providers | type == "array"'
```

The status output names only the selected version at 100% traffic, `/health` succeeds, and provider discovery returns an array. Re-run the recorded failed step and confirm its expected result before closing the incident.

**Rollback:** If the selected version is incompatible with current bindings or stored data, revert the faulty source changes on a branch, open a pull request to `main`, wait for `PR Checks`, and merge it. The `.github/workflows/deploy.yml` workflow then rebuilds and deploys the reverted `main`; production dispatches from old SHAs are intentionally blocked. Worker rollback does not change connected resources or bindings. See [Cloudflare's rollback guidance](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).

---

## Development

```bash
npm install && cd web-ui && npm install && cd ..
npm run dev          # Run locally (requires Docker)
npm run lint         # Lint backend (oxlint)
npm run lint:fix     # Lint backend with auto-fix
npm run typecheck    # Type check backend
npm test             # Backend unit tests
npm run deploy       # DO NOT run locally -- deploys go through GitHub Actions (see CI/CD)
cd web-ui && npm run dev   # Frontend dev server
cd web-ui && npm run build # Frontend production build
```

## File Structure

```
codeflare/
├── src/               # Worker source (Hono router, routes, middleware, lib, Container DO)
├── stress/            # k6 load test suites
├── host/              # Terminal server (TypeScript) - HTTP/WS, PTY, activity tracking
├── web-ui/            # SolidJS frontend - components, stores, styles
├── scripts/           # Code generation (tutorial-seed, agent-seed, sourcemap fix)
├── tutorials/         # Tutorial content (Getting Started, Examples)
├── Dockerfile         # Multi-stage container image
├── entrypoint.sh      # Container startup script (sync, agent config, hooks)
├── wrangler.toml      # Cloudflare Workers + Containers configuration
├── vitest.config.ts   # Backend test config
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

The operator procedure, migration bounds, pause/resume behavior, verification, rollback, and recovery guidance are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private#governed-mode-migration). The public state-machine rationale remains in [AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile).

## Related Documentation
- [CI/CD](ci-cd.md) - GitHub Actions workflows and testing
- [Configuration](configuration.md) - Environment variables and secrets
- [Container](container.md#container-image) - Container image contents
- [Architecture](architecture.md) - System component overview
