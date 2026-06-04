# Development & Deployment

Development setup, project file structure, and cost analysis.

**Audience:** Developers, Operators

## Contents

- [Enterprise Mode Secrets](#enterprise-mode-secrets)
- [Development](#development)
- [File Structure](#file-structure)
- [Cost Analysis](#cost-analysis)

---

## Enterprise Mode Secrets

Enterprise Mode requires two GitHub Actions secrets in addition to the standard deploy credentials. Both are optional: when absent the deploy steps exit 0 and enterprise LLM routing is simply disabled.

| GitHub Actions Secret | Wrangler secret name | Purpose |
|-----------------------|---------------------|---------|
| `AIG_GATEWAY_URL` | `AIG_GATEWAY_URL` | AI Gateway base URL. Pushed to the Worker as a secret by the deploy workflow. |
| `AIG_TOKEN` | `AIG_TOKEN` | AI Gateway bearer token. Pushed to the Worker as a secret by the deploy workflow. |

To enable Enterprise Mode:

1. Add `AIG_GATEWAY_URL` and `AIG_TOKEN` as GitHub Actions repository secrets (Settings → Secrets and variables → Actions).
2. Set the `ENTERPRISE_MODE` GitHub Actions repository **variable** to `active` (Settings → Secrets and variables → Actions → Variables tab).
3. Push to `main`. The deploy workflow reads `vars.ENTERPRISE_MODE` and passes it as `--var ENTERPRISE_MODE:active` to `wrangler deploy`, then pushes both secrets via `wrangler secret put`.

To disable Enterprise Mode: remove or clear the `ENTERPRISE_MODE` variable. The secrets can remain; without the variable the interceptor is never wired and they are unused.

> The `AIG_GATEWAY_URL` and `AIG_TOKEN` secrets are Worker secrets, not container env vars. They are never forwarded to containers. See [Security - Enterprise Mode](security.md#enterprise-mode-credential-containment-and-ca-trust) and [Configuration - Enterprise Mode Secrets](configuration.md#enterprise-mode-secrets-optional).

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
- [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline) - Deploy workflow trigger and pre-deploy pipeline
- [REQ-OPS-002](../../sdd/spec/operations.md#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push) - Docker image build, vulnerability scan, and registry push
- [REQ-OPS-013](../../sdd/spec/operations.md#req-ops-013-deploy-command-and-post-deploy-hooks) - Deploy command and post-deploy hooks
- [REQ-OPS-014](../../sdd/spec/operations.md#req-ops-014-container-binding-and-scaling-from-image) - Container binding and scaling from image

---

## Related Documentation
- [CI/CD](ci-cd.md) - GitHub Actions workflows and testing
- [Configuration](configuration.md) - Environment variables and secrets
- [Container](container.md#container-image) - Container image contents
- [Architecture](architecture.md) - System component overview
