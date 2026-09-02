# CI/CD & Testing

GitHub Actions workflows, test suites, and deployment pipeline.

**Audience:** Developers

**Owns:** workflow triggers, permissions, job topology, gates, artifacts, and historical run evidence. **Does not own:** operator deployment steps, private environment values, or Pi review-session mechanics.

## Contents

- [Workflow Catalogue](#workflow-catalogue)
- [Merge and Promotion Gates](#merge-and-promotion-gates)
- [Deployment Pipeline Contract](#deployment-pipeline-contract)
- [Pull Request Verification](#pull-request-verification)
- [Scheduled Security Probes](#scheduled-security-probes)
- [Test Suite Catalogue](#test-suite-catalogue)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Decisions](#related-decisions)
- [Related Documentation](#related-documentation)

---

<a id="cicd-github-actions"></a>
## Workflow Catalogue

Workflows covering deploy, testing, fuzzing, penetration testing, stress testing, supply chain security, workflow auditing, and dependency pin maintenance. Additionally, GitHub's built-in **secret scanning** (with push protection) and **Dependabot security updates** are enabled at the repository level.

### Dependabot Configuration

Dependabot runs weekly against `develop` for seven npm directories: `/`, `/.github/npm-tools/wrangler`, `/image/oxlint`, `/web-ui`, `/host`, `/landing`, and `/openvscode/agent-sidebar`. It also covers Docker images and GitHub Actions. Every npm ecosystem declares a `cooldown` of 7 days by default and 30 days for majors. Docker and GitHub Actions use their supported seven-day default cooldown. The waiting period gives the ecosystem time to revoke a malicious release before automation proposes it. <!-- @impl: .github/dependabot.yml::updates -->

The root npm lane owns application Wrangler. Container Image instead uses the dedicated `/.github/npm-tools/wrangler` manifest and committed lock, installed with `npm ci`; its separate Dependabot lane owns that privileged workflow pin. Stress Test no longer installs Wrangler or mutates deployment state.

**Node Docker image major updates are ignored.** The `docker.io/library/node` and `public.ecr.aws/docker/library/node` images are pinned to suppress semver-major proposals. Dependabot would otherwise propose Node Current (odd, non-LTS) releases such as Node 25. Node major upgrades are handled manually when a new LTS version is released (even major: 22, 24, 26, ...).

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `deploy.yml` | `workflow_run` when PR Checks complete green on `main` + `workflow_dispatch` (production/integration/enterprise/enterprise integration; `registry` selector cloudflare/dockerhub; optional advanced `verified_run_id`) | Automatically reuses a successful exact-head, exact-tree PR Checks receipt or falls back to inline checks, then runs staged `prepare` → (`build-worker` ∥ `container`) → `deploy`. |
| `container-image.yml` | `workflow_call` (from `deploy.yml`) | Builds, scans with Trivy, and pushes for the selected registry and coding-agent CLIs. Images use `in-<input-hash>` tags. An unchanged digest is reused only after provenance verifies against this workflow; otherwise it builds and scans fresh. Selected agents and a weekly salt participate in identity. |
| `sign-release.yml` | GitHub release publication + recovery `workflow_dispatch` with an existing tag | Validates that a semantic-version release tag is reachable from `main`, creates a deterministic source archive and checksum manifest, keylessly signs both with Sigstore, records GitHub build provenance, and uploads the four verifiable assets to that release. |
| `test.yml` | PRs to `main` or `develop`, push to `main`, `merge_group`, `workflow_dispatch`, and `workflow_call` | Runs parallel path-filtered quality, typecheck, audit, bundle, coverage, backend, frontend, landing, host, and dependency-review lanes. Fail-closed actions shard Workers, frontend, and host tests. Required `test` fails failed or cancelled lanes and passes unaffected skipped lanes. |
| `nightly-pr-checks.yml` | Nightly schedule (03:30 UTC) | Calls `test.yml` under the distinct `Nightly PR Checks` identity. All lanes run, while Deploy continues listening only to main-push `PR Checks` and therefore receives no nightly no-op event. |
| `promotion-source.yml` | PRs to `main` or `master` | Publishes the required `Develop promotion source` status and fails unless the PR head is the canonical repository's exact `develop` branch ([REQ-OPS-036](../../sdd/spec/operations.md#req-ops-036-develop-only-main-promotion)). |
| `zizmor.yml` | PRs touching workflow surfaces, pushes to `main` touching those surfaces, and `workflow_dispatch` | Records audit SARIF for alert history. The separately selected `workflow-audit` lane in `test.yml` blocks pull requests; the standalone branch filter is not a bypass. Its zizmor version is pinned because the action otherwise defaults to `latest`. |
| `codeql.yml` | Push to `main`, PRs to `main` or `develop`, weekly (Monday 06:00 UTC) | Scans JavaScript and TypeScript and uploads SARIF ([REQ-OPS-019](../../sdd/spec/operations.md#req-ops-019-security-posture-scanning-workflows)). Its config excludes vendored Impeccable scripts, which are refreshed wholesale by shadow-pin bumps and do not run in the production request path. |
| `fuzz.yml` | PRs to `main` or `develop`, weekly (Sunday 04:00 UTC) + `workflow_dispatch` | Property-based fuzzing with fast-check (50,000 iterations), using the same lock-keyed bounded-retry dependency installer as PR Checks ([REQ-OPS-018](../../sdd/spec/operations.md#req-ops-018-weekly-fuzz-testing)). |
| `scorecard.yml` | Push to `main`, weekly (Monday 06:00 UTC) + `workflow_dispatch` | OSSF Scorecard security posture assessment on the default branch, publishes results and uploads SARIF. A manual dispatch from another branch exits successfully with an explicit unsupported-ref summary because Scorecard rejects non-default branches. |
| `pentest.yml` | Weekly (Monday 05:00 UTC) + `workflow_dispatch` | External black-box penetration testing: security headers, TLS, auth gate, info disclosure, injection attacks, HTTP methods |
| `stress-test.yml` | `workflow_dispatch` | Read-only validation plus k6 stress tests from `stress/` (API throughput, session lifecycle, storage operations, rate-limit validation) against an already provisioned integration worker. Configurable concurrency via `STRESS_TEST_CONCURRENCY`. |
| `bump-shadow-pins.yml` | Weekly (Monday 06:00 UTC) + `workflow_dispatch` | Tracks non-Dependabot pins: context-mode, graphify, checksum-backed binaries including uv, shared-lock npm tools, Pi preseed npm pins, Browser Run MCP, the vendored Impeccable bundle, code-server plus its Code gitlink, Antigravity, and `actionlint`/`zizmor`. |

Additional details:

**Docker Hub bypass (`registry: dockerhub`):** the former `deploy-dockerhub.yml` near-copy is replaced by a `registry` dispatch input on `deploy.yml`; `container-image.yml` pushes to Docker Hub instead of `registry.cloudflare.com` when the managed registry drops connections mid-upload. Requires `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` secrets and (after first push) flipping the auto-created Docker Hub repo to Public so the Cloudflare container runtime can pull without auth. Before the Trivy scan the workflow frees runner disk — removes prior images (keeping the scan target) and prunes dangling layers — so the image export does not exhaust the Docker data root on a persistent self-hosted runner (the `RUNNER` Actions variable; defaults to `ubuntu-latest`).

**`bump-shadow-pins.yml`:** Tracks context-mode, graphify, checksum-backed Docker binaries and uv, the shared npm-tools tree (agent CLIs, Bun, `consult-llm-mcp`, `chrome-devtools-mcp`), Browser Run MCP's dedicated lock, every Pi preseed npm pin, the vendored Impeccable bundle, code-server plus its Code gitlink, Antigravity, and the pinned `actionlint` and `zizmor` binaries.

Each bump opens its own PR. Shared npm cooldown candidates pass through one strict numeric-semver comparator before any branch is created: a candidate older than or equal to the current pin is a normal skip, while malformed versions fail closed. This prevents a recently pinned release from being downgraded merely because the cooldown's newest eligible release is older ([REQ-OPS-033](../../sdd/spec/operations.md#req-ops-033-lock-backed-npm-bump-coherence) AC3).

Npm bump jobs update the owning manifest and delegate committed-lock regeneration to `scripts/regenerate-npm-package-lock.mjs`, which suppresses lifecycle scripts and reapplies bounded integrity corrections ([REQ-OPS-033](../../sdd/spec/operations.md#req-ops-033-lock-backed-npm-bump-coherence) AC2). The privileged Claude lock also requires all eight platform-specific packages to match the exact CLI manifest pin, preventing `npm ci` from receiving a partially advanced release family ([REQ-OPS-054](../../sdd/spec/operations.md#req-ops-054-committed-npm-runtime-lock-integrity) AC2). Pi changes additionally regenerate the embedded seed because the committed payload differs deliberately from flattened runtime npm layout; runtime-agent bumps move both the direct prewarm dependency and its override so npm cannot retain a stale peer resolution ([REQ-OPS-025](../../sdd/spec/operations.md#req-ops-025-pi-preseed-bump-artifact-coherence)).

Checksum jobs either resolve authoritative release digests or deliberately invalidate the old digest for review. Actionlint resolves `checksums.txt`; SilverBullet verifies its release archive, extracts the matching native service worker, and updates the Docker pin plus `src/routes/vault/native-sw.ts` atomically. Zizmor and actionlint share `.github/workflow-tool-pins.json`, validated by `scripts/ci/workflow-tool-pins.mjs`; both consuming workflows read that manifest, while weekly bumps change only the non-workflow data file ([REQ-OPS-041](../../sdd/spec/operations.md#req-ops-041-least-privilege-workflow-tool-pin-updates)).

**`bump-shadow-pins.yml` permissions:** top-level is `contents: read`; each job that pushes a bump branch and opens a PR elevates itself to `contents: write` + `pull-requests: write`, while `pi-extensions-discover` stays read-only (it only lists package names). Zizmor and actionlint deliberately avoid changing `.github/workflows/**`, so the standard GitHub Actions token can push their pin-only branches without workflow-write permission. No job persists credentials — `actions/checkout` would otherwise write the token into `.git/config`, where every later step could read it, including install scripts run by lockfile-regenerating jobs — so checkouts set `persist-credentials: false` and the push authenticates explicitly instead (zizmor `artipacked`). Branch-existence probes use unauthenticated `ls-remote`, which works because the repository is public.

The code-server job validates upstream release tags against a strict version pattern, derives the packaged code-server commit and embedded Code version from the immutable release artifact, cross-checks package/product identity, derives the Code source commit from the tag's immutable `lib/vscode` gitlink, and invalidates the archive checksum before creating a bump. Its write-enabled shell steps receive the validated version and derived branch through quoted environment variables, so release metadata is never parsed as shell source ([REQ-OPS-027](../../sdd/spec/operations.md#req-ops-027-code-server-coupled-pin-automation)).

The `pi-extensions` bump is data-driven: `pi-extensions-discover` lists every dependency in `preseed/agents/pi/package.json` except context-mode. That set is `@gotgenes/pi-subagents` plus seven managed extensions: the three `@juicesharp` packages, `@narumitw/pi-goal`, `@narumitw/pi-usage`, `pi-web-access`, and `pi-mcp-adapter`. A `fail-fast: false` matrix gives each package its own bump leg and PR; the dedicated `context-mode` job owns its coupled copies.

Each package version also appears in `entrypoint.sh`, pinned-version tests, and the generated seed. Dependabot intentionally skips the Pi preseed directory, so Shadow Pins updates every owning copy together.

<a id="keyless-release-signing"></a>
### Keyless release signing ([REQ-OPS-034](../../sdd/spec/operations.md#req-ops-034-github-release-signing-eligibility), [REQ-OPS-035](../../sdd/spec/operations.md#req-ops-035-keyless-signed-release-artifacts))

Published `vMAJOR.MINOR.PATCH` releases receive a deterministic `codeflare-vMAJOR.MINOR.PATCH.tar.gz`, `SHA256SUMS`, and a `.sigstore.json` bundle for each file. The workflow delegates validation, archive construction, signing, and upload to the executable `scripts/ci/sign-release.sh` boundary, whose observable exits and artifacts are tested with controlled command dependencies. The signing job rejects drafts, malformed tags, and commits not reachable from `main`. A manual dispatch must run from `main`, accepts only an existing release tag, and reruns the same deterministic path, so recovery does not create or retarget releases.

Cosign obtains a short-lived certificate from GitHub's OIDC identity; Codeflare stores no private signing key or signing password. GitHub artifact attestations independently bind the archive and checksum manifest to the repository, workflow, and source revision. This source-release evidence complements rather than replaces the container-image provenance created during deployment. <!-- @impl: .github/workflows/sign-release.yml::sign -->

After downloading all four assets from a release, verify the checksum and Sigstore bundles:

```bash
sha256sum --check SHA256SUMS
cosign verify-blob "codeflare-${TAG}.tar.gz" \
  --bundle "codeflare-${TAG}.tar.gz.sigstore.json" \
  --certificate-identity-regexp '^https://github.com/nikolanovoselec/codeflare/.github/workflows/sign-release.yml@refs/(tags/v[0-9]+\\.[0-9]+\\.[0-9]+|heads/main)$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github.com/nikolanovoselec/codeflare/.github/workflows/sign-release.yml@refs/(tags/v[0-9]+\\.[0-9]+\\.[0-9]+|heads/main)$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
gh attestation verify "codeflare-${TAG}.tar.gz" --repo nikolanovoselec/codeflare
```

Set `TAG` to the downloaded release tag, including its leading `v`. The signature check proves the workflow identity; the checksum manifest alone does not. Implements [REQ-OPS-034](../../sdd/spec/operations.md#req-ops-034-github-release-signing-eligibility) and [REQ-OPS-035](../../sdd/spec/operations.md#req-ops-035-keyless-signed-release-artifacts).

## Merge and Promotion Gates

### GitHub Environments

| Environment | Used by | Trigger |
|-------------|---------|---------|
| `production` | `deploy.yml`, `pentest.yml` | Auto on push to `main`, or manual dispatch with `production` selected |
| `integration` | `deploy.yml`, `stress-test.yml` | Manual dispatch with `integration` selected |

The non-default enterprise environments, account overrides, and dispatch procedure are maintained in [Deployment modes and environments](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/modes-and-environments.md) and the [Enterprise deployment runbook](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/enterprise.md).

`production` is restricted to `main` by a deployment branch policy, mirroring the in-workflow branch guard in `deploy.yml` so a dispatch from any other ref cannot reach it. It carries no required-reviewer rule: a green PR Checks run is the gate, and the reviewer approval it replaced was self-approval by the sole maintainer, which paused three separate jobs without adding assurance.

### Branch protection

| Branch | Required checks | Bypass |
|--------|-----------------|--------|
| `main` | `test`, `CodeQL`, `Property-based fuzzing`, `Develop promotion source` | none |
| `develop` | none before push; CI remains observable after push | none |

GitHub rulesets [`13219234`](https://github.com/nikolanovoselec/codeflare/settings/rules/13219234) (`main`) and [`19216590`](https://github.com/nikolanovoselec/codeflare/settings/rules/19216590) (`develop`) are authoritative. Operators can verify their complete settings with `gh api repos/nikolanovoselec/codeflare/rulesets/<id>`.

`main` requires squash-only pull requests, blocks deletion and non-fast-forward updates, dismisses stale reviews, and requires the latest branch state to carry its complete check set. It additionally requires `Develop promotion source`, so GitHub may display a feature-to-main or fork-`develop` PR but cannot merge it. The active `develop` ruleset instead permits direct fast-forward pushes while blocking deletion and non-fast-forward updates ([REQ-OPS-037](../../sdd/spec/operations.md#req-ops-037-develop-direct-fast-forward-repairs)). CI remains observable after direct pushes where workflow triggers apply, and force-reset synchronization stays prohibited. Neither ruleset requires approving reviews because Codeflare currently has one maintainer; self-approval would add delay without independent assurance.

Workflow references are SHA-pinned repository-wide (`sha_pinning_required`); a `uses:` on a tag or branch is rejected at the Actions level rather than caught in review.

### GitHub Secrets and Variables

A default deployment requires only these repository secrets:

| Secret | Used by | Purpose |
|--------|---------|---------|
| `CLOUDFLARE_API_TOKEN` | `deploy.yml`, `container-image.yml` | Wrangler authentication, resource setup, image push, and Worker deploy |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml`, `container-image.yml` | Identifies the target Cloudflare account |

Non-default mode credentials, optional deployment variables, environment overrides, fallback registries, and service credentials are maintained in [Shared settings](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/reference/core-settings.md) and [Deployment verification](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/verification/deployment-testing.md). This public lane intentionally does not duplicate that operational matrix.

<a id="deploy-workflow-detail"></a>
## Deployment Pipeline Contract

**Workflow permissions:** top-level is `contents: read` in [PR Checks](../../.github/workflows/test.yml) and [Deploy](../../.github/workflows/deploy.yml). PR Checks never build container images and receive no package-cache permission. Deployment's `container` job receives `packages: write` to import and publish the GHCR BuildKit cache, plus `id-token: write` and `attestations: write`; only fresh-image runs invoke provenance attestation. Login failure disables cache use, and export errors do not fail the image build. <!-- @impl: .github/workflows/deploy.yml::container --> <!-- @impl: .github/workflows/container-image.yml::image -->

Job graph: `verify-existing` → optional `verify` → `prepare` → (`build-worker` ∥ `container`) → `deploy` → `outcome`. Every manual dispatch searches successful PR Checks runs for the dispatched SHA, newest first, and validates each run's repository, workflow, head, completed result, required `test` job, and immutable tested-tree receipt against the deploy checkout. A valid receipt skips inline PR Checks; no valid retained receipt triggers them. The optional advanced `verified_run_id` checks only that run and fails closed instead of falling back. <!-- @impl: .github/workflows/deploy.yml::verify-existing -->

`workflow_run` already carries its exact green gate. After verification succeeds, `outcome` fails an eligible non-cancelled run in which nothing was deployed, so a green Deploy means a deploy happened. Workflow cancellation remains cancelled without forcing `outcome` to run. The same-repository green-`push` gate is repeated on every downstream gated job because a job skipped via `if:` counts as success for `needs:` resolution. Same-environment deploys queue rather than cancelling an active mutating run; different environments keep independent concurrency groups. <!-- @impl: .github/workflows/deploy.yml::outcome --> <!-- @impl: scripts/ci/assert-deploy-outcome.mjs::deployOutcome -->

(Implements [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-OPS-026](../../sdd/spec/operations.md#req-ops-026-concurrent-deploy-dispatches-are-legible-and-independently-verified), [REQ-OPS-028](../../sdd/spec/operations.md#req-ops-028-deploy-verification-and-outcome-gate), [REQ-OPS-029](../../sdd/spec/operations.md#req-ops-029-automatic-manual-deploy-verification-reuse), [REQ-OPS-031](../../sdd/spec/operations.md#req-ops-031-trusted-deployment-container-build-cache), and [REQ-OPS-042](../../sdd/spec/operations.md#req-ops-042-retained-container-image-provenance).)

The run title (`run-name`) resolves and displays the deploy target (production / enterprise / enterprise integration / integration) plus the source ref, so the Actions list and `gh run list` answer "what did this deploy to?" without opening the run. The inline `verify` job passes its own `github.run_id` to `test.yml` as `concurrency_key`, which is appended to that workflow's concurrency group — without it, dispatching two environment deploys off one branch puts both inline verifies in the same group and the second cancels the first, surfacing as a cancelled run that deployed nothing.

1. **prepare** — blocks production dispatches from non-main branches; resolves the environment name, checkout ref (the exact SHA whose PR Checks ended green), worker name, cache-bust flag, and environment-scoped `CODING_AGENTS` selection once for all downstream jobs.
2. **build-worker** — builds frontend, then landing (`landing/` → `web-ui/dist/landing/`; order matters — the web-ui build wipes `dist/`), uploads `web-ui/dist` as a 1-day artifact.
3. **container** — calls `container-image.yml` to build, scan, and push the image, or to reuse an existing one:
   - Hashes `Dockerfile`, ignore/scan policy, `entrypoint.sh`, `host/package.json`, `host/package-lock.json`, `host/tsconfig.json`, `host/src/`, `openvscode/`, `preseed/`, seed, npm platform-pruning, and image-smoke scripts, the Pi lockstep verifier, the canonical selected-agent set, and the ISO week.
   - Changes under `host/__tests__/` do not invalidate the deployment image.
   - If `in-<hash>` already exists, the workflow resolves its registry digest and cryptographically verifies GitHub provenance against `container-image.yml`. Only then is build/scan/push skipped; deployment binds that digest. Missing or invalid provenance falls back to a fresh image.
   - Fresh-image smoke records complete image bytes and identity as evidence; image size has no fixed deployment-failing ceiling.

     Reuse preserves the original scan and uploaded SBOM without regenerating them, but verifies the retained digest's signed provenance before trusting that evidence. The first deployment under a new ISO-week identity rebuilds and rescans an unchanged image, bounding a reused CVE verdict to seven days without claiming an unconditional scheduled rebuild.
   - Otherwise buildx uses the deployment-owned GHCR cache and retains plain layer-timing evidence for 14 days. See [REQ-OPS-050](../../sdd/spec/operations.md#req-ops-050-hosted-image-build-critical-path-optimization).
   - Pi extensions are copied after dependency layers but before Jiti prewarm. Browser IDE artifacts and generated seeds assemble after unrelated runtime installs. See [REQ-OPS-050](../../sdd/spec/operations.md#req-ops-050-hosted-image-build-critical-path-optimization).
   - Login failure disables cache use; export errors are ignored without failing or restarting the image build.
   - PR Checks never authenticate to this cache.
   - The base image comes from the AWS ECR Public Node mirror to avoid Docker Hub anonymous pull limits.
   - Before scan or push, the locally loaded image runs the packaged Pi/Claude/empty-inventory, cold-readiness, process, resource, and prefixed-proxy smoke gates.
   - Locked Trivy primes daily vulnerability and Java databases, copies them into isolated caches, then starts scan, SBOM, and Wrangler preparation concurrently. See [REQ-OPS-052](../../sdd/spec/operations.md#req-ops-052-concurrent-image-security-preparation).
   - The workflow awaits all three, applies `ignore-unfixed: true` plus `.trivyignore`, validates the bounded verdict, and uploads the SBOM before push. See [Security §Container Image Scanning](security.md#container-image-scanning-req-sec-011) and [REQ-OPS-052](../../sdd/spec/operations.md#req-ops-052-concurrent-image-security-preparation).
   - When immutable artifacts lag a fixable dependency, the image overlays one exact integrity-verified artifact across every affected path, then verifies each installed version and runtime operation before scan or push. <!-- @impl: Dockerfile::NODE_TAR_VERSION --> <!-- @impl: Dockerfile::PACOTE_VERSION --> See [REQ-OPS-046](../../sdd/spec/operations.md#req-ops-046-fixable-dependencies-in-immutable-runtime-artifacts).
   - The current node-tar 7.5.21 overlay removes CVE-2026-73566 from npm and code-server without weakening Trivy. Remove it when both upstream artifacts carry that floor directly. <!-- @impl: Dockerfile::NODE_TAR_VERSION --> See [REQ-OPS-046](../../sdd/spec/operations.md#req-ops-046-fixable-dependencies-in-immutable-runtime-artifacts).
   - The current pacote 21.5.1 overlay removes CVE-2026-9496 from the Node image's bundled npm. Remove it when the pinned Node artifact carries that floor directly. <!-- @impl: Dockerfile::PACOTE_VERSION --> See [REQ-OPS-046](../../sdd/spec/operations.md#req-ops-046-fixable-dependencies-in-immutable-runtime-artifacts).
   - Push runs in a bounded retry loop (30 attempts, 30s apart); a COPY-coverage guard disables reuse if a Dockerfile COPY source ever falls outside the hashed path set.
   - The hashed path set also covers `.dockerignore` and `.trivyignore`: a deleted CVE suppression previously left the reuse tag unchanged, so the image was reused and the scan that would now fail never ran.
   - Registry credentials are step-scoped and masked before use, so the third-party build and scan actions never receive them.
4. **deploy** — deploys the worker off the pre-built artifacts:
   - Downloads the dist artifact, resolves/creates the KV namespace, and patches `wrangler.toml`.
   - Applies worker name and container tier from `RESSOURCE_TIER` (low=basic 0.25vCPU/1GiB/4GB, default/saas=1vCPU/3GiB/6GB, high=2vCPU/6GiB/12GB; all tiers default to 10 max instances, `MAX_INSTANCES` overrides) and points `image` at the pre-pushed registry URI.
   - Runs `npx wrangler deploy` with `--var` runtime config inside the same bounded retry loop (30×30s — a transient CF control-plane error such as 100146 "Worker version not found" never wastes the completed build).
   - Uploads all worker secrets in **one `wrangler secret bulk` call** (`CLOUDFLARE_API_TOKEN`, optional `SERVICE_AUTH_SECRET`, mode-gated Resend/Stripe/OAuth/AIG secrets, optional `ENCRYPTION_KEY`).
     - When service auth is configured, a bounded retry seeds its service user; failure leaves deployment red.
   - Finally prunes old registry images via `scripts/ci/prune-registry.mjs` — best-effort, digest-alias-protected; keeps the 10 newest tags, the deployed tag, and any tag whose creation time failed to resolve.
   - The unresolved-creation-time hold is fail-closed — a flaked config-blob fetch never deletes a potentially recent image; such tags become prunable again once a later run resolves them.
   - Always (even on failure) publishes a **Deploy summary** table (environment, worker, image tag, whether the image was reused) to the run summary.

Application test suites are not re-run in deployment—the exact SHA already passed PR Checks. Deployment separately owns packaged-image smoke because it is the only workflow that builds the image. That smoke executes every deploy-selected agent launcher's version command inside the built image with a ten-second timeout; missing, crashing, non-zero, or timed-out launchers fail the image job.

<a id="test-workflow-detail"></a>
## Pull Request Verification

Path-gated workload lanes run at maximum parallelism after the `changes` classifier, with no container build in PR Checks. Backend and frontend matrices explicitly expose all nine and three legs concurrently. The required summary is the only fan-in. The reproducible target is an affected exact-head PR Checks run under three minutes; run `31314628668` completed its affected gate in 90 seconds and the workflow in 91 seconds ([REQ-OPS-045](../../sdd/spec/operations.md#req-ops-045-parallel-pr-checks-performance)).

- **changes:** `dorny/paths-filter` classifies the diff into `backend`, `webui`, `landing`, `host`, `ide`, and `workflows`. `changes.outputs.full` means "no diff was filtered, run everything".
  - If GitHub cannot produce the PR-files diff, exact checked-out commits are verified locally and every lane runs. API failure can add work but never skip coverage. <!-- @impl: scripts/ci/path-filter-fallback.sh::changed_files --> <!-- @test: host/__tests__/nightly-pr-checks-routing.test.js (REQ-OPS-003: executes the fallback against exact commits and emits every lane) -->
  - The [nightly wrapper](../../sdd/spec/operations.md#req-ops-043-isolated-nightly-full-matrix-verification) skips filtering and runs the full matrix without matching Deploy's `PR Checks` trigger.
- **quality** — agent-seed drift guard, oxlint (backend + frontend), knip dead-code check (both), `npm audit --package-lock-only --audit-level=high --omit=dev` (both, independent of restored `node_modules`) ([REQ-OPS-003](../../sdd/spec/operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit)), and a `bash -n` syntax pass over every tracked shell script.
- **typecheck** — `wrangler types` then `tsc --noEmit` for backend and frontend.
- **backend-tests** — eight duration-weighted Workers jobs plus a Node-runtime leg, all via `.github/actions/vitest-suite` ([Backend Tests](#backend-tests) has the fail-closed gate).
- **frontend-tests** — three `vitest --shard` jobs through the same action, so the jsdom suite gets the identical report gate. Only shard 1 also runs `npm run build`, a production-breakage check rather than a test dependency.
- **landing-tests** — Container-API render + unit tests, plus `astro build` so a broken production build fails the PR rather than the deploy.
- **host-tests** — `node --test` over a selection reconciled against `host/__tests__/ci-excluded.txt`, failing if the selection is empty or executes zero assertions; installs rclone for the sync-filter behavioral tests.
- **browser-ide:** clean-installs under Node 22.21.1, audits the owned extension's pinned dependencies and licenses, typechecks, deterministically bundles native Pi Chat, and runs Pi context/RPC/approval plus official-Claude configuration behavior with coverage and a gated JSON report.
- **dependency-review** — blocks merging when new dependencies introduce known vulnerabilities ([REQ-OPS-053](../../sdd/spec/operations.md#req-ops-053-dependency-review-evidence-exceptions)).
- **workflow-audit** — checksum-pinned `zizmor` + `actionlint` binaries over `.github/**`, running inside the required `test` context ([REQ-OPS-021](../../sdd/spec/operations.md#req-ops-021-workflow-file-static-analysis)).

Dependency Review limits license exceptions to six exact Codex platform releases whose lock metadata declares Apache-2.0, so later versions require review. Available OpenSSF scores stay visible; unavailable upstream scores remain informational ([REQ-OPS-053](../../sdd/spec/operations.md#req-ops-053-dependency-review-evidence-exceptions)).

The rclone, zizmor, and actionlint release archives are cached by OS, architecture, version, and checksum. A lane downloads its archive only when absent, and checksum validation rejects a restored mismatch before extraction or execution ([REQ-OPS-045](../../sdd/spec/operations.md#req-ops-045-parallel-pr-checks-performance)).

- **bundle-size** — `wrangler deploy --dry-run` against a patched config, gated on `scripts/ci/check-bundle-size.mjs` ([REQ-OPS-024](../../sdd/spec/operations.md#req-ops-024-worker-bundle-size-is-gated-before-it-can-fail-a-deploy)).
- **coverage-backend / coverage-frontend** — run for affected package pull requests and full runs. Global floors remain authoritative; pull requests also apply bounded changed-line LCOV floors (80% backend, 70% frontend).
- **summary** — required `test` context; rejects failed or cancelled relevant lanes and publishes the current exact-tree receipt.

**Why the filters are broad:** the shared anchor—pipeline files, root manifests, both vitest node-suite files, and lint/dead-code rulesets—sits in every filter, so anything that can change what a lane means re-runs every lane. `host` additionally takes all of `.github/**`, because its tests assert on other workflows. Container inputs still select source-level IDE, host, and shell validation, but image construction itself waits for deployment.

**Why shard count is the lever:** each backend shard runs its Workers pool across several workers (`maxWorkers` in `vitest.config.ts`, capped at 4 because every worker is a full workerd + miniflare instance). Most of a shard's wall clock is per-file transform and isolate setup, roughly half of it in the main process where extra workers cannot help — and that half divides across shards.

**Why workflow-audit runs its own binary:** zizmor exits 12 on any finding, so a template-injection or credential-persistence defect fails the merge rather than surfacing later as an alert nobody reads (this repo carried 60 such alerts before they were swept). `zizmor-action`'s failure semantics depend on whether it is uploading SARIF, and a gate must be unambiguous about when it fires. Findings that are correct-as-written carry an inline `# zizmor: ignore[rule]` with the reason, on the finding's own line.

The post-refactor audit requires no Zizmor scope change: the blocking lane audits all of `.github/`, while standalone SARIF runs whenever workflows, composite actions, or the shared tool pin changes. Both resolve the same validated Zizmor version; workflow-support JavaScript remains under its owning tests rather than being misclassified as workflow syntax ([REQ-OPS-021](../../sdd/spec/operations.md#req-ops-021-workflow-file-static-analysis)).

**Why bundle-size patches the config:** Cloudflare rejects an oversized Worker at deploy time, so without this the discovery point is a failed production deploy. The patch repoints `[[containers]].image` away from `./Dockerfile`, because otherwise the dry run *builds the container image* that `container-image.yml` already builds and content-addresses — roughly three minutes of duplicated work for a number printed before the build starts.

**What summary reconciles:** every suite's coverage via `scripts/ci/check-suite-completeness.mjs` (see [Backend Tests](#backend-tests)), publishing a test-result table through `scripts/ci/render-test-summary.mjs` to the run summary.

### PR Exact-Head Monitoring

PR-boundary eligibility, exact-head target resolution, and CI-monitor recovery are owned by [Preseed — Resetting Review-Spawn Checkpoints](preseed.md#resetting-review-spawn-checkpoints).

<a id="pentest-workflow-detail"></a>
## Scheduled Security Probes

One validation job constrains `PENTEST_TARGET` to an HTTPS DNS origin, then fans six lightweight external probes out in parallel against that exact output using only `curl` and `openssl` (no heavy scanning tools). Paths, credentials, IP/single-label hosts, queries, fragments, and control characters fail before any probe runs. Only the validator and TLS jobs receive repository-read permission because they check out owned validation scripts.

1. **security-headers**: Verifies presence of HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. Confirms `X-Powered-By` is absent.
2. **tls**: Confirms TLS 1.3 works, TLS 1.0/1.1 are rejected, HSTS preload is enabled, and the certificate has at least 14 days before expiry.
3. **auth-gate**: Sends unauthenticated requests to seven API endpoints and confirms they all require CF Access (302/401/403). Tests that injecting `cf-access-authenticated-user-email` headers does not bypass authentication.
4. **info-disclosure**: Probes for sensitive files (`/.env`, `/.git/config`, `/api/debug`), checks that responses contain no secrets or stack traces.
5. **injection**: Tests host header injection (spoofed `Host` returns 403), `X-Forwarded-Host` has no effect on content, CL/TE request smuggling is rejected, and path traversal payloads (`%2e%2e`, double-encoded, backslash, unicode) are blocked at the auth layer.
6. **http-methods**: Verifies TRACE returns 405 and WebSocket upgrade without authentication returns 302.

**Requires:** `PENTEST_TARGET` variable set in the `production` GitHub environment (e.g., `https://codeflare.ch`). See the full manual test report in [pentest.md](pentest.md).

---

<a id="testing"></a>
## Test Suite Catalogue

### Backend Tests

**Config:** `vitest.config.ts` with `@cloudflare/vitest-pool-workers` `cloudflareTest()` plugin - tests run in real Workers runtime (not Node.js). **Run:** `npm test` **Coverage:** istanbul provider — the v8 provider profiles through the Node host's V8 inspector, which cannot see inside workerd isolates and reports a flat 0% for this suite. Thresholds live in each suite's own vitest config and are enforced by the path-specific `coverage-backend` and `coverage-frontend` lanes; full nightly/manual/merge-queue runs execute both. An affected tree is checked before merge, so a regression fails before merge: gated post-merge only, a dip turned `test` red on `main` after the fact and `deploy.yml` then silently declined to deploy an already-merged commit ([REQ-OPS-022](../../sdd/spec/operations.md#req-ops-022-coverage-threshold-gate-fails-closed-on-missing-evidence)).

Measured 2026-07-20 on the first run that ever executed them: backend 90.2% statements / 82.7% branches, web-ui 77.4% / 66.0%. Thresholds sit ~2 points under those, because the previous 53/43 and 32/27 sat 37 and 45 points below actual and would have passed a suite with most of its tests deleted. Pull requests also check changed executable production lines represented in LCOV at practical package floors (80% backend, 70% frontend), never 100% per file. The checker ignores deletions and test-only changes, follows rename destinations, bounds diff/report size and changed-line count, and fails closed when a changed production file has no report record.

The frontend coverage job reserves these Administration material-state owners for user-owned Integration validation; backend contracts, shared frontend infrastructure, and every other production file remain gated ([REQ-OPS-022](../../sdd/spec/operations.md#req-ops-022-coverage-threshold-gate-fails-closed-on-missing-evidence)):

- `web-ui/src/components/admin/ActivityPage.tsx`
- `web-ui/src/components/admin/AdministrationLayout.tsx`
- `web-ui/src/components/admin/AdministrationOverview.tsx`
- `web-ui/src/components/admin/AnalyticsPage.tsx`
- `web-ui/src/components/admin/AnalyticsUserDetail.tsx`
- `web-ui/src/components/admin/EnvironmentAreaFields.tsx`
- `web-ui/src/components/admin/EnvironmentIndex.tsx`
- `web-ui/src/components/admin/ReportsPage.tsx`
- `web-ui/src/components/admin/environment-areas.ts`

**Protected rendered verification:** Browser-only visual claims are not represented by CSS-source regexes or a repository-owned browser framework. The deployment-time `browser-e2e` agent verifies the protected deployment at phone, tablet, and desktop widths. For the Wave 9 contracts it records: login core content visible before auth promises settle; the armed Vault control retaining its success computed color under sticky touch hover; the Kitt scanner remaining unclipped with its beam inside the dashboard panel overflow geometry; and WebGL context loss retiring SplashCursor while the dark app-root surface remains visible. The deploy/PR evidence links the protected target and browser-run artifact; no Playwright package, config, workflow, or scripted E2E suite is added.

**CI workerd crash guard (fail-closed):** `@cloudflare/vitest-pool-workers` crashes `workerd` at pool teardown after all tests pass — a known upstream limitation of WebSockets + Durable Objects under per-file storage isolation, still present on 0.18.x/vitest 4 (the documented alternative `--max-workers=1 --no-isolate` crashes this suite at collection). Serializing the pool never fixed it — the crash is at teardown, not a concurrency race — so the pool runs parallel and the gate, not serialization, is what makes the result trustworthy. The shared coverage action tolerates that fingerprint for backend coverage only after it has confirmed a coverage table was produced, no test failed, and no threshold was missed ([REQ-OPS-022](../../sdd/spec/operations.md#req-ops-022-coverage-threshold-gate-fails-closed-on-missing-evidence)).

The composite action `.github/actions/vitest-suite` runs every vitest suite: backend shards, the Node leg, frontend shards, landing, and the Browser IDE extension. It invokes the suite's npm script (optionally with `--shard`) with `--reporter=dot --reporter=json`, then gates via `scripts/ci/check-vitest-report.mjs` on the **machine-readable JSON report**, never on reporter prose: a zero exit still requires a parsed report with >0 tests and 0 failures (catches silently-empty runs).

A non-zero exit is accepted only when the report parses with >0 tests, 0 failed tests, 0 failed suites, AND the log carries the exact fingerprint `[vitest-pool]: Worker cloudflare-pool emitted error.`. A missing or corrupt report, an unknown error, or any failed test fails the job. Crash tolerance is opt-in per suite (`tolerate-pool-crash`), because only the Workers pool has that bug ([REQ-OPS-023](../../sdd/spec/operations.md#req-ops-023-suite-results-are-gated-on-machine-readable-reports)) — a non-zero exit from the jsdom or Node suites stays fatal. Deploy does not re-run tests, so the guard lives only here.

**Dependency installs** go through `.github/actions/install-deps` (lockfile-keyed cache, `npm ci --prefer-offline --no-audit --no-fund` only on a miss, each attempt wrapped in `timeout` so a *hung* registry connection is retried rather than waited on forever, plus `NODE_COMPILE_CACHE` for the V8 bytecode cache Node 22+ shares between processes). Every lane used to copy-paste that pair and they drifted; one action means one cache-key convention.

**Cross-suite completeness gate (fail-closed):** a per-run gate can only vouch for files it was handed, so `scripts/ci/check-suite-completeness.mjs` runs in the `summary` job and reconciles the union of every report against the test files actually in the tree, for each suite registered in `scripts/ci/suites.mjs` ([REQ-OPS-023](../../sdd/spec/operations.md#req-ops-023-suite-results-are-gated-on-machine-readable-reports)).

A file lost to a mis-shard, a stale exclude, or a worker dying mid-run fails the required context instead of passing as a smaller-but-green run. It also fails when a lane reported success yet uploaded no reports (a flaked artifact download cannot silently disarm the gate), and when two shards both claim the same file — a split disagreement, whose mirror image is a file nobody ran. `vitest.node-suite.mjs` is the single list of Node-runtime backend tests, shared by both vitest configs and this gate.

**Key patterns:** `vi.mock()` must be at module level BEFORE imports. Use `vi.hoisted()` for shared mutable state referenced by mock factories. `LOG_LEVEL: 'silent'` in miniflare bindings suppresses log noise. **Notable test files:** `kv-crypto.test.ts` (KV AES-256-GCM encryption + migration), `r2-sse.test.ts` (R2 SSE-C encryption).

**File-size discipline:** the former >1,500-line test files are split along describe boundaries (`routes/setup*.test.ts` ×5, `container/{index,enterprise-llm,lifecycle}.test.ts`, `lib/agent-seed-{manifest,multi-agent,pi-memory}.test.ts`, `fuzz/{input-validation,replicated-helpers,runtime-config}.fuzz.test.ts`). Shared scaffolding is replicated per file because `vi.mock` hoisting is per module.

### Frontend Tests

**Config:** `web-ui/vitest.config.ts` with jsdom + `@solidjs/testing-library`.
**Run:** `cd web-ui && npm test`
**Key patterns:** SolidJS stores use getter-based exports. Test by re-importing module after `vi.resetModules()`. Use `render()` from `@solidjs/testing-library` for component tests.

### Host Tests

**Config:** `host/package.json` with Node.js built-in test runner (`node --test`).
**Run:** `cd host && npm test` (also runs in CI via `node --test host/__tests__/*.test.js`, minus the container-only tests listed in `host/__tests__/ci-excluded.txt`)
**Scope:** PTY pre-warm readiness (first output starts a fixed 1.5-second settlement period), activity tracker disconnect + input tracking, WebSocket input classification, server prewarm integration, entrypoint sync filter validation, server security, host module extraction, host fuzz tests, memory merge/cleanup, container memory tracking, entrypoint ECC validation, entrypoint hooks merge, metrics collection, session manager lifecycle, proactive memory injection (memory-context-inject.sh), graphify hook wiring and retirement migration, graphify discipline preseed checks.

### Property-Based Fuzz Tests

**Library:** [fast-check](https://github.com/dubzzz/fast-check). **CI:** `fuzz.yml` runs 50,000 iterations on PRs to `main` or `develop`, weekly, and manual dispatch ([REQ-OPS-018](../../sdd/spec/operations.md#req-ops-018-weekly-fuzz-testing)).
**Local:** Default 1,000 iterations. Override with `FAST_CHECK_NUM_RUNS=50000`.

| Suite | File | What it covers |
|-------|------|----------------|
| Backend | `src/__tests__/fuzz/input-validation.fuzz.test.ts` | XML injection/parsing, getBucketName, validateKey (path traversal, null bytes, encoding tricks), KV namespacing, ReDoS, circuit breaker state machine, compound session-ID parsing |
| Backend | `src/__tests__/fuzz/replicated-helpers.fuzz.test.ts` | Replicated non-exported helpers (normalizeEmail, getCookieValue, extractTag, isRetryable), error types, type guards |
| Backend | `src/__tests__/fuzz/runtime-config.fuzz.test.ts` | TabConfigSchema, logger, toApiSession, cache-reset state machine, error-type constructors, content-type helpers, session-mode config filtering, managed-release monotonic activation and same-sequence identity conflicts |
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

<a id="specification-coverage"></a>
## Requirement and Source Map

Exhaustive Operations status remains in `sdd/spec/operations.md`. Workflow sections carry clause-local links; this map records the maintained gate families.

| Gate family | Requirements | Source owner | Evidence |
|---|---|---|---|
| PR classification and required summary | [REQ-OPS-003](../../sdd/spec/operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit), [REQ-OPS-045](../../sdd/spec/operations.md#req-ops-045-parallel-pr-checks-performance) | `.github/workflows/test.yml` | Machine-readable reports, exact-tree summary, and `host/__tests__/ci-workflow-hardening.test.js` cache behavior |
| Coverage/result completeness | [REQ-OPS-022](../../sdd/spec/operations.md#req-ops-022-coverage-threshold-gate-fails-closed-on-missing-evidence), [REQ-OPS-023](../../sdd/spec/operations.md#req-ops-023-suite-results-are-gated-on-machine-readable-reports) | composite suite actions and CI scripts | Report/artifact reconciliation tests |
| Build and promotion | [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001-deploy-workflow-trigger-and-pre-deploy-pipeline), [REQ-OPS-002](../../sdd/spec/operations.md#req-ops-002-docker-image-build-vulnerability-scan-and-registry-push), [REQ-OPS-028](../../sdd/spec/operations.md#req-ops-028-deploy-verification-and-outcome-gate), [REQ-OPS-050](../../sdd/spec/operations.md#req-ops-050-hosted-image-build-critical-path-optimization), [REQ-OPS-052](../../sdd/spec/operations.md#req-ops-052-concurrent-image-security-preparation) | deploy/container-image workflows | Tested-tree receipt, BuildKit timing, scan/SBOM evidence, image digest, deployment outcome |
| Supply-chain automation | REQ-OPS-020/021/025/027/032 and release requirements | shadow-pin, CodeQL, Scorecard, release workflows | Workflow contracts and generated-artifact tests |
| Nightly/fuzz/probe/stress | REQ-OPS-018/043/044 and REQ-OPS-005 | dedicated workflows | Dated run receipts; specialist lanes own execution interpretation |
| Provenance and reuse | [REQ-OPS-042](../../sdd/spec/operations.md#req-ops-042-retained-container-image-provenance), REQ-OPS-026/029 | image/deploy receipts | Content-addressed artifact and run validation |

---

## Related Decisions

- [AD112](../decisions/README.md#ad112-ci-runs-as-parallel-path-filtered-lanes-and-deploys-reuse-content-addressed-container-images) - Parallel path-filtered CI lanes, fail-closed JSON test gate, staged deploy with content-addressed container reuse, scripted e2e removal
- [AD114](../decisions/README.md#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration) - Native Pi Chat, exact official Claude package, and complete-image compatibility lane

---

## Related Documentation
- [Deployment](deployment.md) - Development commands and file structure
- [Configuration](configuration.md#secrets) - Worker secrets and variables
- [pentest.md](pentest.md) - Penetration testing results
- [stress-test.md](stress-test.md) - Load testing guide
