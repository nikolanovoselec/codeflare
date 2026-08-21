# Development & Deployment

Default deployment execution, verification, rollback, development references, and dated cost evidence.

**Audience:** Developers, Operators

**Owns:** when to deploy, operator action, verification, rollback, and public target boundaries. **Does not own:** workflow internals, source composition, or private environment procedures.

## Contents

- [Standard Deployment](#standard-deployment)
- [Enterprise Mode Secrets](#enterprise-mode-secrets)
- [Strict Gateway Egress (Enterprise Mode)](#strict-gateway-egress-enterprise-mode)
- [Production Rollback](#production-rollback)
- [Development Reference](#development-reference)
- [Source and Runtime Composition Aliases](#source-and-runtime-composition-aliases)
- [Cost Analysis](#cost-analysis)
- [Governed Mode migration (batch-status driven)](#governed-mode-migration-batch-status-driven)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

---

## Standard Deployment

**When:** Normal production promotion starts automatically after the reviewed `main` commit's required `PR Checks` workflow succeeds. Use a manual **production** dispatch only for an initial deployment or an intentional retry/recovery from `main`; manual integration dispatches may use another branch, but the workflow rejects a manual production target unless the ref is `main`.

**Prerequisites:** Confirm the intended commit is `origin/main`, every required exact-head check is green, and the production environment owns the expected public configuration. The repository must define stable `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, and `VAPID_PRIVATE_KEY` Actions secrets shared by every deployment environment; no GitHub Environment may override those names. The subject and public key use secret context to mask Actions step metadata, while only the private key is confidential at runtime. The [deployment workflow](../../.github/workflows/deploy.yml) fails before Worker deployment when a value is missing, whitespace-padded, malformed, or when the unpadded-base64url P-256 pair does not match ([REQ-OPS-013](../../sdd/spec/operations.md#req-ops-013-deploy-command-and-post-deploy-hooks), [REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries)).

Keep the private key out of Wrangler configuration and logs. Rotating the pair invalidates existing Push subscriptions across every environment and requires re-enrollment; follow [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private). For a manual retry, confirm the failed automatic run did not already promote the same tree.

**Action:** For normal promotion, retain the automatically triggered `Deploy` run. For initial deployment or retry, run GitHub's `Deploy` workflow from `main` with target **production**; the manual target defaults to integration. Never substitute a local Wrangler deploy. The workflow verifies the source tree, builds and scans the container image, publishes its digest, and deploys the Worker and binding. Workflow topology and permissions belong to [CI/CD](ci-cd.md#deploy-workflow-detail).

**Verify:** Retain the successful run URL and deployed commit, then verify the deployed origin explicitly:

```sh
CODEFLARE_URL=https://<production-host>
curl -fsS "$CODEFLARE_URL/public/auth/providers" | jq -e '.providers | type == "array"'
```

Exercise the changed user path after provider discovery returns the expected `{ providers: [...] }` envelope. Changes that affect sessions require creating and starting a disposable session, observing it reach `running`, opening its terminal or IDE route, and deleting it cleanly; a health response alone is insufficient.

**Rollback:** Stop and use [Production Rollback](#production-rollback) when a changed user path fails or the deployed version does not match the reviewed tree. Do not deploy another unreviewed tree as an incident workaround.

---

## Enterprise Mode Secrets

**Type:** Canonical private-operations alias.

The enterprise GitHub Environment layout, activation variable, account overrides, AI Gateway fallback secrets, required token permissions, and deployment procedure are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private). This public lane intentionally does not duplicate non-default deployment credentials.

---

## Strict Gateway Egress (Enterprise Mode)

**Type:** Canonical private-operations alias.

The enterprise-only binding procedure, Gateway policy preparation, verification steps, and rollback runbook are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private#strict-gateway-egress). The behavioral contract remains public in [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress).

---

## Production Rollback

**When:** The active production Worker deployment is faulty and a previous version remains compatible with current bindings and stored data.

**Prerequisites:** Run from the repository root with the production `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` exported, then confirm `npx wrangler whoami` names the production account. In the incident record, capture the failed user-flow step and its expected result before rollback.

**Command:** Record the version currently serving traffic first — it is both the version the incident is about and the baseline the post-rollback check compares against. Resolve `WORKER_NAME` from the successful Deploy run or production configuration (`CLOUDFLARE_WORKER_NAME`, default `codeflare`). Then list successful production workflow runs and that Worker's deployments, choose the newest deployment created before the faulty release whose timestamp matches a successful `Deploy` run, inspect that candidate, and pass it to rollback using the [Wrangler Worker commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/). `rollback` takes the **version** ID that `versions view` confirms, not a deployment ID:

```sh
WORKER_NAME="${CLOUDFLARE_WORKER_NAME:-codeflare}"
npx wrangler deployments status --name "$WORKER_NAME"
gh run list --workflow deploy.yml --branch main --status success --limit 10
npx wrangler deployments list --name "$WORKER_NAME"
npx wrangler versions view <CANDIDATE_VERSION_ID> --name "$WORKER_NAME"
npx wrangler rollback <CANDIDATE_VERSION_ID> --name "$WORKER_NAME"
```

Cloudflare immediately creates a deployment that sends 100% of traffic to the selected version, as defined by its [rollback behavior](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).

**Verifies:** Confirm the active deployment, public health, and provider discovery:

```sh
CODEFLARE_URL=https://<production-host>
npx wrangler deployments status --name "$WORKER_NAME"
curl -fsS "$CODEFLARE_URL/api/health" | jq -e '.status == "ok"'
curl -fsS "$CODEFLARE_URL/public/auth/providers" | jq -e '.providers | type == "array"'
```

The status output names only the selected version at 100% traffic and provider discovery returns an array. Re-run the recorded failed step and confirm its expected result before closing the incident.

**Rollback:** If the selected version is incompatible with current bindings or stored data, revert the faulty source changes on a branch, open a pull request to `main`, wait for `PR Checks`, and merge it. The `.github/workflows/deploy.yml` workflow then rebuilds and deploys the reverted `main`; production dispatches from old SHAs are intentionally blocked. Worker rollback does not change connected resources or bindings. See [Cloudflare's rollback guidance](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).

---

<a id="development"></a>
## Development Reference

**Prerequisites:** Use Node.js 22, install the root and affected package dependencies, and use local Docker/Wrangler only for development. Production deployment is workflow-owned.

```bash
npm install
(cd web-ui && npm install)
npm run dev
npm run lint
npm run lint:fix
npm run typecheck
npm test
(cd web-ui && npm run dev)
(cd web-ui && npm run build)
```

**Verifies:** The affected package starts or builds, lint/type checks complete, and behavioral suites pass where the environment supports them. GitHub Actions remains the authoritative exact-head result. Never run `npm run deploy` as a substitute for reviewed production promotion.

<a id="file-structure"></a>
<a id="intentional-schema-duplication-bundle-boundary"></a>
<a id="critical-paths-inside-container"></a>
## Source and Runtime Composition Aliases

The current repository/package map and intentional backend/frontend schema bundle boundary are owned by [Architecture Internals](architecture-internals.md#source-composition). Image and runtime paths—including workspace, agent configuration, Pi package cache, rclone configuration, and sync status/log files—are owned by [Container](container.md#runtime-paths). Run `tree -L 2 -I node_modules` from the repository root for a live tree rather than relying on a copied deployment inventory.

## Cost Analysis

Dated `2026-08-09` account example based on Cloudflare Containers pricing. This is not a universal per-user quote or a complete platform-cost estimate.

### Per-Container Pricing

Parameters: 8h/day, 20 days/month = 160h = 576,000s active. Default tier (1 vCPU, 3 GiB, 6 GB). CPU usage: 20% average.

| Resource | Calculation | Free Tier | Billable | Rate | Cost |
|----------|-------------|-----------|----------|------|------|
| CPU (active usage) | 0.2 vCPU x 576,000s = 115,200 vCPU-s | 22,500 vCPU-s | 92,700 vCPU-s | $0.000020/vCPU-s | $1.85 |
| Memory (provisioned) | 3 GiB x 576,000s = 1,728,000 GiB-s | 90,000 GiB-s | 1,638,000 GiB-s | $0.0000025/GiB-s | $4.10 |
| Disk (provisioned) | 6 GB x 576,000s = 3,456,000 GB-s | 720,000 GB-s | 2,736,000 GB-s | $0.00000007/GB-s | $0.19 |
| Workers Paid plan | | | | | $5.00 |
| **Dated account example total** | | | | | **~$11.14** |

Notes:
- CPU is billed on active usage; provisioned memory and local disk are billed while the Container is active.
- After Codeflare's stop completes and the Container goes to sleep, Container vCPU, provisioned-memory, and local-disk metering stops.
- This is not state-preserving hibernation: local disk is ephemeral and returns fresh; persistent files restore from R2.
- The `$5` Workers Paid minimum and Container inclusions are account-level and shared. They cannot be assigned universally to each user or session.
- Workers, Durable Objects, R2, requests, logs, storage, and network usage may still incur charges, so `$11.14` is not a total platform-cost estimate.
- The example assumes one account, one 160-hour active session, 1 vCPU, 3 GiB memory, 6 GB local disk, and 20% average CPU as of `2026-08-09`.
- Pricing: [Cloudflare Containers Pricing](https://developers.cloudflare.com/containers/pricing/)

Container resource usage scales per active session (each session is one container; up to six terminal tabs share it). Idle sessions stop after `sleepAfter` (default 30m, configurable 15m-4h) of no user input; durable state comes back from R2 on a later fresh Container.

---

## Governed Mode migration (batch-status driven)

**Type:** Canonical private-operations alias.

The operator procedure, migration bounds, pause/resume behavior, verification, rollback, and recovery guidance are maintained in [Codeflare private operations](https://github.com/nikolanovoselec/codeflare-private#governed-mode-migration). The public state-machine rationale remains in [AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile).

---

<a id="specification-coverage"></a>
## Requirement and Source Map

| Procedure / alias | Requirements | Source owner | Evidence |
|---|---|---|---|
| Automatic production promotion | [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-OPS-013](../../sdd/spec/operations.md#req-ops-013-deploy-command-and-post-deploy-hooks) | Deploy workflow | Exact-head workflow run and changed user-path verification |
| Image and binding promotion | [REQ-OPS-002](../../sdd/spec/operations.md#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push), [REQ-OPS-014](../../sdd/spec/operations.md#req-ops-014-container-binding-and-scaling-from-image) | Container-image and Deploy workflows | Digest, scan, provenance, deployment receipt |
| Production rollback | Operations SDD and Cloudflare version contract | Wrangler version/deployment surfaces | Selected version at 100% plus original failed-flow recovery |
| Enterprise/egress/governed aliases | [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress) | Private operations; public behavior remains in Enterprise/Security SDD | Private promotion/rollback evidence |

---

## Related Documentation
- [CI/CD](ci-cd.md) - GitHub Actions workflows and testing
- [Configuration](configuration.md) - Environment variables and secrets
- [Container](container.md#container-image) - Container image contents
- [Architecture](architecture.md) - System component overview
