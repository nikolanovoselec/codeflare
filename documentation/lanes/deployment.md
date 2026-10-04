# Development & Deployment

Default deployment execution, verification, rollback, and development references.

**Audience:** Developers, Operators

**Owns:** when to deploy, operator action, verification, rollback, and public target boundaries. **Does not own:** workflow internals, source composition, or private environment procedures.

## Contents

- [Standard Deployment](#standard-deployment)
- [Dormant Review enrollment](#dormant-review-enrollment)
- [Enterprise Mode Secrets](#enterprise-mode-secrets)
- [Strict Gateway Egress (Enterprise Mode)](#strict-gateway-egress-enterprise-mode)
- [Production Rollback](#production-rollback)
- [Development Reference](#development-reference)
- [Source and Runtime Composition Aliases](#source-and-runtime-composition-aliases)
- [Historical Cost Alias](#cost-analysis)
- [Governed Mode migration (batch-status driven)](#governed-mode-migration-batch-status-driven)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

---

## Standard Deployment

**When:** Normal production promotion starts automatically after the reviewed `main` commit's required `PR Checks` workflow succeeds. Use a manual **production** dispatch only for an initial deployment or an intentional retry/recovery from `main`; manual integration dispatches may use another branch, but the workflow rejects a manual production target unless the ref is `main`.

**Prerequisites:** Confirm the intended commit is `origin/main`, every required exact-head check is green, and the established `CLOUDFLARE_API_TOKEN` has D1 Edit plus its existing deployment permissions. Migration runs before Worker promotion. Historical database identity, restore boundaries, and retention belong to [Billing](billing.md#d1-database-and-migrations); routine Administration belongs to [Configuration](configuration.md). [REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary) owns migration safety. Integration acceptance and account operation/spend alerts remain prerequisites for sampled Production history rollout under [REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope).

Web Push is optional. To enable it, define `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, and `VAPID_PRIVATE_KEY` as one complete repository-level Actions secret group shared by every deployment environment; no GitHub Environment may override those names. The subject and public key use secret context to mask Actions step metadata, while only the private key is confidential at runtime. The [deployment workflow](../../.github/workflows/deploy.yml) accepts the wholly absent group but fails before Worker deployment when configuration is partial, whitespace-padded, malformed, or when the unpadded-base64url P-256 pair does not match ([REQ-OPS-013](../../sdd/spec/operations.md#req-ops-013-deploy-command-and-post-deploy-hooks), [REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries)).

Without the group, Push delivery and the Settings enrollment control are unavailable. When configured, keep the private key out of Wrangler configuration and logs. Rotating the pair invalidates existing Push subscriptions across every environment and requires re-enrollment; follow [Shared settings and Web Push identity](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/reference/core-settings.md). For a manual retry, confirm the failed automatic run did not already promote the same tree.

**Action:** For normal promotion, retain the automatically triggered `Deploy` run. For initial deployment or retry, run GitHub's `Deploy` workflow from `main` with target **production**; the manual target defaults to integration. Never substitute a local Wrangler deploy. The workflow verifies the source tree, builds/scans or provenance-verifies a retained container image, publishes/binds its digest, and deploys the Worker and binding. Workflow topology and permissions belong to [CI/CD](ci-cd.md#deploy-workflow-detail).

**Verify:** Retain the successful run URL and deployed commit. After secret upload and service-user provisioning, confirm the final version serves 100% of traffic and verify the deployed origin explicitly:

```sh
CODEFLARE_URL=https://<production-host>
curl -fsS "$CODEFLARE_URL/public/auth/providers" | jq -e '.providers | type == "array"'
```

Exercise the changed user path after provider discovery returns the expected `{ providers: [...] }` envelope. Changes that affect sessions require creating and starting a disposable session, observing it reach `running`, opening its terminal or IDE route, and deleting it cleanly; a health response alone is insufficient.

**Rollback:** Stop and use [Production Rollback](#production-rollback) when a changed user path fails or the deployed version does not match the reviewed tree. Do not deploy another unreviewed tree as an incident workaround.

---

## Dormant Review enrollment

This procedure verifies **inactive** trust, not remote activation. Production use, activation and live publication require separate authorization and end-to-end proof. <!-- @impl: src/operators/boundary-action-installation.ts::verifyBoundaryWorkflow -->

1. Configure `OPERATOR_REVIEW_EXECUTABLE_SHA` to the exact tested Codeflare runtime commit.
2. Configure `OPERATOR_REVIEW_ORIGINS` with precisely `dev`, `integration` and `production` HTTPS origins maintained by the installer, never derived from a target PR or request. Missing or unverified configuration denies enrollment.
3. Use a platform administrator's current Codeflare GitHub connection with repository workflow-write permission, authenticated Access and CSRF protection.
4. Submit the target to `POST /api/operator-management/boundary-actions/propose`:

```json
{
  "repositoryUrl": "https://github.com/OWNER/REPO",
  "protectedRef": "refs/heads/main",
  "installationId": "APPROVED_CONDUCTOR_INSTALLATION"
}
```

5. Inspect and merge the ordinary proposal PR under the target repository's protected-branch policy. This documentation does not authorize that merge.
6. Submit the same target to `POST /api/operator-management/boundary-actions/verify`. Codeflare rereads protected-base workflow ID, path and bytes before storing an **inactive** binding.
7. A pending PR, successful test or verification cannot start Review or grant Action claim authority. An inactive binding permits local review only without a competing active Review binding.
8. Independently verify the maintained runtime pin, target installation and live publication before claiming live acceptance.

---

## Enterprise Mode Secrets

**Type:** Canonical private-runbook redirect.

The enterprise GitHub Environment layout, activation variable, account overrides, AI Gateway fallback secrets, required token permissions, and deployment procedure are maintained in the [Enterprise deployment runbook](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/enterprise.md). This public lane intentionally does not duplicate non-default deployment credentials.

---

## Strict Gateway Egress (Enterprise Mode)

**Type:** Canonical private-runbook redirect.

The enterprise-only binding procedure, Gateway policy preparation, verification steps, and rollback runbook are maintained in the [Strict Gateway Egress runbook](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/operations/strict-gateway-egress.md). The behavioral contract remains public in [Security](security.md#strict-gateway-egress-enterprise-mode) and [REQ-ENTERPRISE-016](../../sdd/spec/security.md#req-enterprise-016-strict-gateway-egress).

---

## Production Rollback

**When:** The active production Worker deployment is faulty and a previous version remains compatible with current bindings and stored data.

**Prerequisites:** Obtain explicit incident authorization. Run from the repository root with the production `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` exported, then confirm `npx wrangler whoami` names the production account. Record the failed user-flow step and expected result. Worker rollback does not roll back resources, bindings, or additive D1 migrations.

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

**Rollback:** If incompatible, correct or revert source on a branch and follow protected promotion through canonical `develop` to `main`, required checks, and an authorized merge. A feature-to-main PR cannot satisfy `Develop promotion source`. Main-push checks then authorize automatic deployment; old-SHA production dispatches are intentionally blocked. This reference authorizes no merge or incident action. See [Cloudflare's rollback guidance](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).

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

These are command references, not permission to run local checks in a constrained agent session. GitHub Actions supplies authoritative exact-head results. Never run `npm run deploy` as a substitute for reviewed production promotion.

<a id="file-structure"></a>
<a id="intentional-schema-duplication-bundle-boundary"></a>
<a id="critical-paths-inside-container"></a>
## Source and Runtime Composition Aliases

The current repository/package map and intentional backend/frontend schema bundle boundary are owned by [Architecture](architecture.md#source-composition). Image and runtime paths—including workspace, agent configuration, Pi package cache, rclone configuration, and sync status/log files—are owned by [Container](container.md#runtime-paths). Run `tree -L 2 -I node_modules` from the repository root for a live tree rather than relying on a copied deployment inventory.

<a id="cost-analysis"></a>
<a id="per-container-pricing"></a>
## Historical Cost Alias

The dated account arithmetic remains only in [the immutable original cost example](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/deployment.md#cost-analysis). It is not current pricing, a per-user quote, or a complete platform-cost estimate. [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/) is authoritative. [Billing](billing.md) owns metering distinctions; [Container](container.md) owns ephemeral runtime and recovery. The complete REQ-OPS-006 record, including its dated-estimate AC, remains unchanged in Operations.

---

## Governed Mode migration (batch-status driven)

**Type:** Canonical private-runbook redirect.

The operator procedure, migration bounds, pause/resume behavior, verification, rollback, and recovery guidance are maintained in the [Governed Mode migration runbook](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/operations/governed-mode-migration.md). The public state-machine rationale remains in [AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile).

---

<a id="specification-coverage"></a>
## Requirement and Source Map

| Procedure / alias | Requirements | Source owner | Evidence |
|---|---|---|---|
| Automatic production promotion | [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-OPS-013](../../sdd/spec/operations.md#req-ops-013-deploy-command-and-post-deploy-hooks) | Deploy workflow | Exact-head workflow run and changed user-path verification |
| Image and binding promotion | [REQ-OPS-002](../../sdd/spec/operations.md#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push), [REQ-OPS-014](../../sdd/spec/operations.md#req-ops-014-container-binding-and-scaling-from-image) | Container-image and Deploy workflows | Digest, scan, provenance, deployment receipt |
| Production rollback | Operations SDD and Cloudflare version contract | Wrangler version/deployment surfaces | Selected version at 100% plus original failed-flow recovery |
| Enterprise/egress/governed aliases | [REQ-ENTERPRISE-004](../../sdd/spec/models-and-routing.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-016](../../sdd/spec/security.md#req-enterprise-016-strict-gateway-egress) | Private operations; public behavior remains in Models/Security/Storage SDD | Private promotion/rollback evidence |

---



### REQ-OPS-011 preserved clauses

The authoritative Node source, immutable indices and Linux amd64 manifest boundary are [REQ-OPS-011 AC5](../../sdd/spec/agents.md#req-ops-011-container-base-image-is-debian-bookworm-slim); deployment evidence must cover that boundary plus the existing image build, packaged smoke, CVE scan, provenance and push gates.

### REQ-OPS-054 preserved clauses

The authoritative NAT64 classification and undici decompression floors, override and regeneration constraints are [REQ-OPS-054](../../sdd/spec/operations.md#req-ops-054-committed-npm-runtime-lock-integrity). Verify committed lock integrity and clean packaged-runtime installation separately; static pin agreement is not deployment or alert-clearance evidence.

## Related Documentation
- [CI/CD](ci-cd.md) - GitHub Actions workflows and testing
- [Configuration](configuration.md) - Environment variables and secrets
- [Container](container.md#container-image) - Container image contents
- [Architecture](architecture.md) - System component overview
