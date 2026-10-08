# CI/CD & Testing

GitHub Actions workflows, test verdicts, deployment pipeline, security-probe methodology, and load-testing methodology.

**Audience:** Developers, Operators, Security reviewers

**Owns:** workflow triggers, permissions, job topology, gates, artifacts, suite methods, thresholds and interpretation limits. **Does not own:** product capacity guarantees, API limits, security-control policy, operator promotion/rollback, private environment values or Pi review-session mechanics.

## Contents

- [Workflow Catalogue](#workflow-catalogue)
- [Merge and Promotion Gates](#merge-and-promotion-gates)
- [Deployment Pipeline Contract](#deployment-pipeline-contract)
- [Pull Request Verification](#pull-request-verification)
- [Security Probes](#security-probes)
- [Load Testing](#load-testing)
- [Test Suite Catalogue](#test-suite-catalogue)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Decisions](#related-decisions)
- [Related Documentation](#related-documentation)

<a id="cicd-github-actions"></a>
## Workflow Catalogue

GitHub repository settings separately enable secret scanning with push protection and Dependabot security updates; source cannot prove live settings.

### Dependabot Configuration

Dependabot runs weekly against `develop` for `/`, `/.github/npm-tools/wrangler`, `/image/oxlint`, `/web-ui`, `/host`, `/landing` and `/openvscode/agent-sidebar`, plus Docker and Actions. Npm cooldown is seven days by default and thirty for majors; Docker/Actions use their supported seven-day default. <!-- @impl: .github/dependabot.yml::updates --> Root npm owns application Wrangler; the dedicated workflow Wrangler manifest/committed lock owns Container Image's privileged pin and is installed by `npm ci`. Stress Test does not install Wrangler or mutate deployment state.

Node Docker major proposals are ignored; Node LTS migration is manual, not an automatic move to Current.

| Workflow | Trigger | Contract |
|---|---|---|
| `deploy.yml` | Green main-push PR Checks `workflow_run`; manual four-target dispatch, registry selector, optional `verified_run_id` | Exact-head/tree reuse or inline checks, prepare → parallel asset/image jobs → deploy → outcome; no Gate 1 fixture dispatch |
| `container-image.yml` | Reusable call from Deploy | Input-hash/weekly identity; provenance-verified digest reuse or fresh build/smoke/scan/SBOM/push |
| `sign-release.yml` | Published GitHub release; existing-tag recovery dispatch | Main-reachable semantic tag, deterministic archive/checksum, keyless signatures and provenance |
| `test.yml` | PR to main/develop, main push, merge_group, manual/reusable call | Parallel path-filtered lanes, fail-closed report/coverage/completeness and required `test` summary |
| `nightly-pr-checks.yml` | Daily 03:30 UTC | Full reusable matrix under distinct identity, not a Deploy-authorizing event |
| `promotion-source.yml` | PR to main/master | Required canonical-repository exact `develop` head check (REQ-OPS-036) |
| `zizmor.yml` | Workflow-surface PR/main-push and manual | SARIF history; required blocking audit is separately inside PR Checks |
| `codeql.yml` | Main push, main/develop PR, Monday 06:00 UTC | JavaScript/TypeScript analysis; vendored Impeccable scripts excluded from wholesale upstream analysis (REQ-OPS-019) |
| `fuzz.yml` | Main/develop PR, Sunday 04:00 UTC, manual | 50,000 fast-check iterations, shared bounded installer (REQ-OPS-018) |
| `scorecard.yml` | Main push, Monday 06:00 UTC, manual | Default-branch posture/SARIF; non-default dispatch is explicit successful unsupported-ref no-op |
| `pentest.yml` | Monday 05:00 UTC, manual | Six external lightweight probes, normalized production-environment target and issue reporting |
| `stress-test.yml` | Manual | Read-only target setup, then selected mutating k6 integration workloads; opposite mode prerequisites make `all` unsuitable |
| `bump-shadow-pins.yml` | Monday 06:00 UTC, manual | Governed non-Dependabot release pins and coupled artifacts |

**Registry bypass:** `registry: dockerhub` uses the same Deploy/Image workflows rather than a duplicate. It requires the private registry credentials and a public pullable repository after first push. The scan preparation frees runner disk, preserves the target image and prunes dangling layers. Current runner defaults are pinned `ubuntu-24.04`, with supported explicit `RUNNER` overrides; they are not `ubuntu-latest`.

### Shadow-pin ownership and mutation boundaries

The workflow owns context-mode, graphify, checksum-backed binaries/uv, shared npm tools and agent CLIs, Browser Run MCP's dedicated lock, Pi preseed pins, Impeccable, code-server/Code gitlink, official Claude extension, Antigravity, Herdr, actionlint and zizmor. Each candidate opens its own PR.

Strict numeric semver comparison skips older/equal cooldown candidates and fails malformed candidates before branch mutation ([REQ-OPS-033](../../sdd/spec/operations.md#req-ops-033-lock-backed-npm-bump-coherence)). Npm jobs update the owning manifest and use `scripts/regenerate-npm-package-lock.mjs` with lifecycle scripts disabled and bounded integrity corrections. All eight Claude platform packages match the exact CLI manifest pin (REQ-OPS-054). Pi bumps align direct dependency/override, both owning runtime manifests/locks, installation specifications and embedded seed (REQ-OPS-025). Flattened installed npm layout is not the committed seed layout.

Checksums resolve authoritative release digests or deliberately invalidate the previous checksum for review. SilverBullet verifies the archive/server version and atomically updates Docker pins and the vendored native worker. Actionlint resolves `checksums.txt`. Zizmor/actionlint read one validated `.github/workflow-tool-pins.json`; bumping that data file avoids workflow-write permission (REQ-OPS-041).

Top-level permission is `contents: read`; only branch/PR-writing jobs elevate to `contents: write` and `pull-requests: write`. `pi-extensions-discover` remains read-only. Herdr and workflow-tool bumps do not rewrite workflows, and Herdr packaged-version checking derives exact output from committed provenance (REQ-OPS-055). Checkouts use `persist-credentials: false`; pushes authenticate explicitly and public branch probes use unauthenticated `ls-remote`.

The code-server job validates release versions, extracts/cross-checks artifact package/product commit and Code version, derives the embedded Code source commit from the immutable gitlink, and invalidates the checksum. Validated metadata enters quoted environment variables, never shell source (REQ-OPS-027).

Pi extension discovery reads every preseed dependency except context-mode. The current eleven-package set comprises the Pi coding agent, Pi subagents, three `@juicesharp` packages, three `@narumitw` workflow packages, pi-evaluate, pi-web-access and pi-mcp-adapter. Independent `fail-fast: false` legs bump manifest, entrypoint pins, pinned-version evidence and generated seed. Goal/Plan candidates must run their exact-version transforms before publication; source-layout drift fails the candidate instead of opening an unverified pin PR. Candidate-transform acceptance remains qualified by REQ-OPS-025, not by version prose in this reference.

Impeccable's one-minute no-container PR lane verifies pinned source, compiles the exact raster/wait logic into probes, reproduces upstream regressions, and verifies idle-grace/no-symlink fixes. Deployment still compiles/tests the complete binary before publication; bundle refresh rejects an engine the image has not adopted (REQ-AGENT-163/164/181, REQ-OPS-058/059).

<a id="keyless-release-signing"></a>
<a id="keyless-release-signing-req-ops-034-req-ops-035"></a>
### Keyless release signing

[REQ-OPS-034](../../sdd/spec/operations.md#req-ops-034-github-release-signing-eligibility) and [REQ-OPS-035](../../sdd/spec/operations.md#req-ops-035-keyless-signed-release-artifacts) govern the four assets: deterministic `codeflare-vMAJOR.MINOR.PATCH.tar.gz`, `SHA256SUMS`, and one `.sigstore.json` bundle per file. `scripts/ci/sign-release.sh` validates source, builds, signs and uploads; drafts, malformed tags and commits not reachable from main fail. Recovery runs only from main and accepts an existing tag without creating/retargeting releases.

GitHub OIDC supplies a short-lived Cosign certificate; no stored signing key/password is required. Independent artifact attestations bind archive/checksum to repository/workflow/source. Source signatures do not replace deployment image provenance. <!-- @impl: .github/workflows/sign-release.yml::sign -->

After downloading all four assets, set `TAG` to the release's leading-v tag:

```bash
sha256sum --check SHA256SUMS
cosign verify-blob "codeflare-${TAG}.tar.gz" \
  --bundle "codeflare-${TAG}.tar.gz.sigstore.json" \
  --certificate-identity-regexp '^https://github\.com/nikolanovoselec/codeflare/\.github/workflows/sign-release\.yml@refs/(tags/v[0-9]+\.[0-9]+\.[0-9]+|heads/main)$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/nikolanovoselec/codeflare/\.github/workflows/sign-release\.yml@refs/(tags/v[0-9]+\.[0-9]+\.[0-9]+|heads/main)$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
gh attestation verify "codeflare-${TAG}.tar.gz" --repo nikolanovoselec/codeflare
```

Checksum integrity alone does not prove signer identity.

## Merge and Promotion Gates

### GitHub Environments

`production` is used by Deploy/Pentest; `integration` by Deploy/Stress Test. Only Deploy's green main-push path automatically promotes. Probe schedules and stress dispatches are not deployments. Non-default account/environments belong to private [modes and environments](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/modes-and-environments.md) and [Enterprise deployment](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/enterprise.md).

Production's branch policy permits main only and mirrors the workflow guard. It has no required reviewer rule; exact-head checks are the gate.

### Branch protection

| Branch | Required checks before protected merge/push | History boundary |
|---|---|---|
| main | `test`, `CodeQL`, `Property-based fuzzing`, `Develop promotion source` | Squash PR only, complete latest-state checks, stale-review dismissal, no deletion/non-fast-forward or bypass |
| develop | No pre-push PR/status requirement | Direct fast-forward repair allowed; no deletion/non-fast-forward or bypass |

Rulesets [13219234](https://github.com/nikolanovoselec/codeflare/settings/rules/13219234) and [19216590](https://github.com/nikolanovoselec/codeflare/settings/rules/19216590) are live authority, inspectable with `gh api repos/nikolanovoselec/codeflare/rulesets/<id>`. Neither requires approving reviews under the current single-maintainer configuration. A feature-to-main or fork-`develop` PR may exist but cannot satisfy canonical promotion (REQ-OPS-036/037). Workflow `uses:` references are repository-wide SHA-required.

`test.yml` supports `merge_group`, but that alone does not make the merge queue usable: other required checks need appropriate queue triggers too. Do not infer queue readiness from the trigger catalogue.

### GitHub Secrets and Variables

Default deployment uses repository `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Configuration owns public contracts; optional/non-default operational matrices remain private in [Shared settings](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/reference/core-settings.md) and [Deployment verification](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/verification/deployment-testing.md).

<a id="deploy-workflow-detail"></a>
## Deployment Pipeline Contract

Top-level PR Checks/Deploy permission is `contents: read`. PR Checks receives no container-cache credentials. Deploy's container job alone receives `packages: write`, `id-token: write` and `attestations: write`; only fresh-image runs create provenance. Login failure disables cache and export errors do not restart/fail builds. <!-- @impl: .github/workflows/deploy.yml::container --> <!-- @impl: .github/workflows/container-image.yml::image -->

Graph: `verify-existing` → optional `verify` → `prepare` → (`build-worker` ∥ `container`) → `deploy` → `outcome`. No retired Gate 1 fixture dispatch. <!-- @impl: .github/workflows/deploy.yml::outcome --> Manual dispatch discovers successful head-matching PR Checks newest-first, validates repository/workflow/head/completed result/required test job and immutable tested-tree receipt, and reuses the first valid receipt. No valid retained receipt runs inline checks; explicit `verified_run_id` checks only that run and fails closed without fallback. <!-- @impl: .github/workflows/deploy.yml::verify-existing -->

The automatic path already carries its exact green gate. Same-repository successful push checks are repeated downstream because an `if:`-skipped dependency is not an authorization gate. Eligible non-cancelled verified runs that deploy nothing fail `outcome`; cancellation remains cancelled. Same-environment mutations serialize without cancelling active work; different environments have distinct concurrency. <!-- @impl: .github/workflows/deploy.yml::outcome --> <!-- @impl: scripts/ci/assert-deploy-outcome.mjs::deployOutcome --> Run names expose target/ref and inline verification uses the dispatch run ID as a concurrency discriminator (REQ-OPS-001/026/028/029/031/042; REQ-OPERATOR-009).

1. **prepare:** rejects non-main production dispatch; resolves exact SHA, environment, Worker, cache bust and canonical selected-agent set once.
2. **build-worker:** web UI first, then landing into `web-ui/dist/landing/` because the UI build wipes `dist`; one-day dist artifact.
3. **container:** input identity covers Dockerfile, workflow/ignore/scan policy, entrypoint, host production manifests/config/source, IDE/preseed/seed, npm pruning, image smoke, Pi lockstep verification, canonical agents and ISO week.
   - Host tests do not invalidate the image. An existing tag is reusable only after registry-digest provenance verifies against `container-image.yml`; deployment binds that exact digest. Invalid/missing provenance, cache bust or uncovered COPY disables reuse.
   - Fresh images record complete byte size with no fixed byte-ceiling rejection. Reuse retains original scan/SBOM, not a new scan. First deploy under a new ISO-week identity rebuilds/rescans, rather than claiming an unconditional weekly deployment.
   - BuildKit cache/layer timing remains deployment-owned; plain timing evidence is retained fourteen days. Late Pi extensions still invalidate Jiti prewarm while retaining dependency layers; IDE/generated-seed assembly does not invalidate unrelated installs (REQ-OPS-050).
   - Node bases resolve approved immutable manifests through `mirror.gcr.io/library/node`; embedded IDE stages retain their separately pinned Node 22.21.1 boundary. Publication still requires construction/smoke/scan/provenance, not availability checks alone (REQ-OPS-011).
   - Before scan/push, run selected launcher version commands with ten-second bounds plus Pi/Claude/empty-inventory, cold-readiness, process, resource and prefixed-proxy smoke.
   - Locked Trivy primes daily vulnerability/Java databases, then scan, CycloneDX SBOM and registry-tool preparation run concurrently against isolated writable caches. All are awaited; prerequisite failure blocks publication.
   - Apply `ignore-unfixed: true` and reviewed `.trivyignore`, validate exact bounded exceptions, upload SBOM, then push (REQ-OPS-052; [Security gate](security.md#container-image-scanning-req-sec-011)).
   - Immutable artifacts with fixable embedded dependencies receive exact integrity-verified overlays at every affected path; smoke checks versions and operation/archive round trips before scanning (REQ-OPS-046).
   - The current node-tar 7.5.21 and pacote 21.5.1 overlays retire only when upstream artifacts carry the fixed floor directly. <!-- @impl: Dockerfile::NODE_TAR_VERSION --> <!-- @impl: Dockerfile::PACOTE_VERSION --> <!-- @impl: Dockerfile::NODE_TAR_VERSION --> <!-- @impl: Dockerfile::PACOTE_VERSION -->
   - Push retries thirty times at thirty-second intervals. COPY coverage guards reuse; ignore/scan policy is hashed. Registry credentials are masked/step-scoped away from build/scan actions.
4. **deploy:** downloads assets, resolves/creates KV, prepares one environment-local usage D1 binding and additive migrations, patches Worker/container configuration, and applies reviewed authorization/config before Worker promotion (REQ-OPS-056/060).
   - `RESSOURCE_TIER`: low 0.25 vCPU/1 GiB/4 GB, default or saas 1 vCPU/3 GiB/6 GB, high 2 vCPU/6 GiB/12 GB; default max instances ten, positive `MAX_INSTANCES` override. This is deployment allocation, not capacity certification.
   - Binds the selected registry image/digest; Wrangler deploy retries thirty times/thirty seconds without wasting the completed build.
   - One secret-bulk call follows Worker creation; optional mode-gated secrets remain Configuration/private-owned. Configured service auth gets bounded fail-closed user seeding; absent service auth skips it. Optional VAPID is all-or-none and validated before promotion.
   - Best-effort registry pruning retains ten newest tags, deployed tag, aliases of its digest and unresolved-creation-time tags. Uncertain creation time never authorizes deletion.
   - Always publishes environment/Worker/image/reuse summary.

Application suites are not rerun after exact-tree verification. Packaged-image smoke is independently deployment-owned because PR Checks builds no image. A green deployment receipt is not proof that every changed protected user path works; [Deployment](deployment.md#standard-deployment) owns post-secrets verification.

<a id="test-workflow-detail"></a>
## Pull Request Verification

After classification every affected workload starts directly; required summary is the fan-in. Backend/frontend/host matrices expose their configured legs concurrently. REQ-OPS-045's affected exact-head feedback target is under three minutes, not a user-runtime guarantee.

- **changes:** backend, webui, landing, host, pi, ide, workflows and production dependencies; `full` means no filtering. PR checkout uses depth2; push filtering retains full history. If GitHub diff fails, fetch any missing exact base/head commits at depth1, verify both and select all lanes, never silently skip. <!-- @impl: scripts/ci/path-filter-fallback.sh::changed_files --> <!-- @test: host/__tests__/nightly-pr-checks-routing.test.js (REQ-OPS-003: executes the fallback against exact commits and emits every lane) --> Nightly skips filtering under its distinct identity.
- **quality:** seed drift, backend/frontend oxlint/knip, `bash -n` over tracked shell scripts (REQ-OPS-003).
- **typecheck:** Wrangler types and backend/frontend `tsc --noEmit`.
- **backend-tests:** twelve duration-weighted Workers shards plus native/flue/rest Node legs through the shared suite action.
- **frontend-tests:** four duration-weighted test groups through the same action. <!-- @impl: .github/workflows/test.yml::frontend-tests -->
- **frontend-build:** independent frontend production-build gate, separate from the test matrix. <!-- @impl: .github/workflows/test.yml::frontend-build -->
- **landing-tests:** rendering/unit tests plus Astro production build.
- **host-tests:** nonempty, nonzero-assertion Node-runner selection reconciled against `ci-excluded.txt`; rclone for real sync-filter behavior. Approved Ubuntu sandbox package sources and real sandbox probe remain required.
- **browser-ide:** clean Node 22.21.1 install, owned dependency/license audit, typecheck, deterministic bundle, context/RPC/approval and official Claude behavior, coverage and JSON gate.
- **dependency-review:** fail-closed PR vulnerability/license checks with visible available OpenSSF scores; six exact Codex platform license exceptions backed by Apache-2.0 lock metadata, not future-version exceptions (REQ-OPS-053).
- **workflow-audit:** pinned/checksummed zizmor/actionlint over `.github/**` inside required `test`; standalone SARIF is not a bypass (REQ-OPS-021).
- **impeccable-engine:** pinned-source focused native regressions, one-minute timeout, no image build (REQ-OPS-058).
- **bundle-size:** Wrangler dry-run with container configuration repointed away from Dockerfile; one unambiguous measurement, valid positive budget or explicit opt-out sentinel (REQ-OPS-024).
- **coverage:** affected-package and full-run global floors plus bounded changed-production-line LCOV floors, backend 80%, frontend 70% (REQ-OPS-022).
- **summary:** rejects failed/cancelled relevant lanes, accepts unaffected skipped lanes, reconciles suite evidence and publishes exact-tree receipt.

PR Dependency Review is dependency-security evidence for that reviewed tree and its main squash result; post-merge checks do not repeat registry-backed audits. Explicit full dispatch retains bounded one-minute fail-closed lockfile-only registry audits. Tool archives cache by OS/architecture/version/checksum and reject restored mismatch before execution (REQ-OPS-045).

Shared pipeline/manifests/config/selection rules occur in broad filters so a meaning-changing file reselects all lanes. Container inputs select source IDE/host/shell validation but construction waits for Deploy. Workers are workerd/miniflare isolates; shard parallelism divides per-file setup/transform work that extra local workers cannot eliminate.

Zizmor gate exits nonzero on surviving findings; justified suppressions stay on the finding line. Blocking audit scope remains `.github/`; support JavaScript remains under owning tests. Bundle-size patching avoids duplicated image construction. Summary publishes parsed suite results with `scripts/ci/render-test-summary.mjs` and reconciles coverage of the tree with `scripts/ci/check-suite-completeness.mjs`.

### PR Exact-Head Monitoring

[Preseed — Review completion prompt or FIX is missing](preseed.md#review-completion-prompt-or-fix-is-missing) owns session boundary eligibility, exact-head resolution and recovery, not this workflow lane. Retired checkpoint files are not a recovery mechanism.

<a id="security-probes"></a>
<a id="scheduled-security-probes"></a>
<a id="security-probe-and-penetration-test-evidence"></a>
<a id="pentest-workflow-detail"></a>
<a id="current-weekly-probe-contract"></a>
<a id="test-results"></a>
## Security Probes

Distinct named owner for current security-probe methods formerly in `pentest.md` (REQ-OPS-005). Monday 05:00 UTC/manual `pentest.yml` uses a production-environment `PENTEST_TARGET`; one target job normalizes the origin and six external jobs consume that exact output. Probes use lightweight curl, openssl and the owned Python legacy-TLS handshake helper, not a heavy scanner. <!-- @impl: .github/workflows/pentest.yml::jobs -->

### Target normalization

`normalize-https-origin.mjs` accepts HTTP, HTTPS or a bare DNS host, normalizes to HTTPS and rejects credentials, non-root paths, query/fragment, controls/padded whitespace, IP/single-label/malformed DNS names and invalid port zero. This is syntax normalization, not an allowlist or proof of DNS/port reachability. Use the configured intended public target; do not infer deployment identity from a historical report. Target/TLS jobs receive repository-read permission; the separate report job also has read plus issues-write. Other probes receive no repository permission.

### Security-header probe <!-- @impl: .github/workflows/pentest.yml::security-headers -->

HEAD `/` requires HSTS `max-age`, CSP, framing, `nosniff`, referrer and permissions headers and rejects `X-Powered-By`. It proves the tested response's header patterns, not every route's semantic policy. [Security](security.md#security-headers) owns controls/route exceptions.

### TLS probe <!-- @impl: .github/workflows/pentest.yml::tls -->

TLS 1.3 and exactly TLS 1.2 must return HTTP 200/302. Owned direct ClientHello probes require server-originated legacy-version refusal for TLS 1.0/1.1; accepted ServerHello fails, and close/unclassified alert/malformed record/no answer is inconclusive and fails, never a pass. HSTS must be present; preload is reported when present but is not a separate workflow failure boundary. Certificate validity must be at least fourteen days. Target normalization and the direct legacy-TLS helper support explicit host:port. The certificate-expiry and CL/TE openssl steps instead append `:443` and do not correctly handle non-default ports; use the intended default-port origin for the whole workflow. This documents a method limitation, not a runtime or workflow repair.

### Authentication-gate probe <!-- @impl: .github/workflows/pentest.yml::auth-gate -->

Samples `/api/sessions`, `/api/storage/files/`, `/api/users`, `/api/preferences`, `/api/container/health`: require 302/401/403, not 404. `/api/setup/status` separately requires 200 without secret-shaped response text. Spoofed identity headers must not bypass the sessions gate. This is a sample, not the dated report's complete protected endpoint inventory, nor proof of authenticated authorization.

### Information-disclosure probe <!-- @impl: .github/workflows/pentest.yml::info-disclosure -->

`/.env`, `/.git/config`, `/.git/HEAD`, `/api/debug`, `/api/internal` fail on 200, no response (000), or secret-shaped body. Invalid-session error prose is checked for stack/path signatures. A SPA 200 on a sensitive-file path fails this current method even if it contains no secret; the old dated observation is not the current pass boundary.

### Injection probe <!-- @impl: .github/workflows/pentest.yml::injection -->

Spoofed Host requires 403/421. `X-Forwarded-Host` must leave response content unchanged. CL/TE probe requires explicit 400/501 rejection. Four encoded URL traversal forms accept 302/400/401/403/404; delete traversal bodies require 302/401/403. Auth-layer rejection and URL 404 do not prove downstream authenticated storage validation or exhaustive parser safety.

### HTTP-method probe <!-- @impl: .github/workflows/pentest.yml::http-methods -->

TRACE requires 405/403. An unauthenticated terminal upgrade requires 302/401/403. The workflow's `/api/terminal/ws` request is a boundary sample, not the canonical authenticated session WebSocket endpoint catalogue.

### Failure reporting

An always-running report job treats any target/probe non-success as failed, opens/comments one exact-title tracking issue, and closes it after later green. Explicit `GH_REPO` is required because that job has no checkout. Scheduled failure is therefore visible operational state, not only an Actions result.

### Coverage and limitations

One unauthenticated origin; no certification of authenticated business logic, account/provider authority, all routes, rate-limit correctness, container isolation or absence of vulnerabilities. Use owning behavioral suites and specialist review. Network/body comparison heuristics have narrower guarantees than ideal exhaustive tests; source-backed constraints above must not be widened into product guarantees.

<a id="penetration-test-report"></a>
<a id="historical-evidence"></a>
<a id="report-2026-03-06"></a>
<a id="historical-report--2026-03-06"></a>
<a id="summary"></a>
### Immutable probe evidence aliases

The retired lane's dated report and summary remain only at [original report](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#historical-report--2026-03-06) and [original summary](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#summary). No present certification, report body or new report collection is created. Original subfragment aliases below retain only immutable navigation:

<a id="tools"></a>
[Tools](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#tools)

<a id="observations"></a>
[Observations](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#observations)

<a id="1-authentication-gate"></a>
[Authentication observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#1-authentication-gate)

<a id="2-header-spoofing"></a>
[Header spoofing observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#2-header-spoofing)

<a id="3-path-traversal"></a>
[Traversal observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#3-path-traversal)

<a id="4-cors-configuration"></a>
[CORS observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#4-cors-configuration)

<a id="5-security-headers-req-sec-008"></a>
[Header observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#5-security-headers-req-sec-008)

<a id="6-tls"></a>
[TLS observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#6-tls)

<a id="7-information-disclosure"></a>
[Disclosure observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#7-information-disclosure)

<a id="8-host-header-injection"></a>
[Host observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#8-host-header-injection)

<a id="9-http-request-smuggling"></a>
[Smuggling observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#9-http-request-smuggling)

<a id="10-endpoint-fuzzing"></a>
[Fuzz observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#10-endpoint-fuzzing)

<a id="11-http-methods"></a>
[Method observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#11-http-methods)

<a id="12-technology-stack"></a>
[Stack observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#12-technology-stack)

<a id="13-rate-limiting"></a>
[Unauthenticated limit observation](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#13-rate-limiting)

<a id="findings-summary"></a>
[Findings summary](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/pentest.md#findings-summary)

<a id="load-testing"></a>
<a id="stress-testing"></a>
## Load Testing

Distinct named owner for current k6 methods formerly in `stress-test.md`; REQ-OPS-008 owns workflow methods and REQ-OPS-044 non-mutating setup. Load measurement is not a supported-user count, production capacity guarantee or canonical rate-limit policy.

<a id="prerequisites"></a>
### Target Modes and Preconditions

Prepare an authorized integration worker through reviewed [Deployment](deployment.md#standard-deployment), not this workflow. Three intended high-load workloads use exact `STRESS_TEST_MODE=active`; enforcement validation uses inactive bypass. Deployment owns matching service-auth secret and fail-closed seed for `e2e-service@codeflare.local`. Integration owns `E2E_BASE_URL`, CF Access client ID/secret and optional `OAUTH_E2E_TEST_SECRET` setup fallback. Optional `STRESS_TEST_CONCURRENCY` defaults zero.

Setup normalizes target, requires public provider discovery 200 and authenticated `/api/sessions` 200 with four bounded retries/fifteen-second waits. It has only checkout, Node, normalization and smoke steps, no resource/deploy repair. Suite traffic is not read-only.

**Credential limitation:** Setup supports OAuth-secret fallback, but current k6 files use `CF_ACCESS_CLIENT_SECRET` for `X-Service-Auth` and do not read `OAUTH_E2E_TEST_SECRET`; setup success alone cannot prove fallback-only suite authentication.

<a id="running"></a>
### Execution Runbooks

<a id="load-suites-against-a-bypass-enabled-target"></a>
**Load:** Record target commit, origin, resource profile, service identity and active bypass. Select `api-throughput`, `session-lifecycle` or `storage-operations` explicitly in Actions → Stress Test. Confirm normalized target/auth, selected thresholds and artifact identity. Abort on wrong target/profile/mode/identity; do not redeploy/repair from the measurement workflow. Session/storage cleanup is attempted, not guaranteed after cancellation/errors/throttled deletion. Throughput/preferences validation changes preferences and does not restore them; use a disposable service identity and check residual records/files/preferences afterward.

<a id="rate-limit-validation-against-a-rate-limited-target"></a>
**Rate limits:** Prepare inactive bypass and select only `rate-limit-validation`. Observe before-limit success, 429 and suite verdict without unexpected status. Cleanup created test sessions where possible and verify leftovers explicitly.

<a id="unsupported-all-selector"></a>
**Unsupported `all`:** Source defaults to and selects all four jobs, which share one unchanged target and opposite intended modes. It cannot prove both intended high-load and enforcement contracts. Load scripts themselves do not assert bypass; their 429 short-circuits/counter floors can allow partial measurements under limits. A green `all` must not be interpreted as high-load saturation plus enforcement proof. No runtime/workflow fix is proposed here.

<a id="test-suites"></a>
### Suite Contracts

#### API Throughput (`api-throughput.js`) <!-- @impl: stress/api-throughput.js::options --> <!-- @impl: stress/api-throughput.js::default -->

Mostly reads, with occasional `PATCH /api/preferences` writes. `sustained_load`: 30s to scaled five, 1m to scaled ten, 2m hold, 30s down; spike starts 4m30s and lasts 50s (10s up, 30s hold, 10s down) at scaled ten. Each cycle requests public `/api/health`, sessions and batch-status; 30% also gets user/preferences and 20% of those cycles patches mode; 20% browses storage. Independent random choices can overlap. Think time uniformly 4–6s.

| Gate | Fixed threshold |
|---|---|
| HTTP request p95 | <5s |
| HTTP failed rate | <5% |
| `errors` | <10% |
| `health_duration` p95 | <1s |
| `session_list_duration` p95 | <5s |

The scripted approximately-five-second dashboard pattern is not the current product polling contract: stable visible session status now uses sixty-second polling, transitions five seconds, hidden pages stop (REQ-OPS-057). Individual check failures are not universally aggregated into a `checks` threshold in this suite.

#### Session Lifecycle (`session-lifecycle.js`) <!-- @impl: stress/session-lifecycle.js::options --> <!-- @impl: stress/session-lifecycle.js::default -->

Three-minute create/list/get/delete churn: 30s up, 2m hold, 30s down at baseline three. It does not start containers, stop sessions or exercise terminal readiness. Think ranges: 3–8s after create, 2–5s before get, 5–15s before delete and 10–30s between cycles.

| Gate | Fixed threshold |
|---|---|
| Create p95 | <5s |
| Delete p95 | <3s |
| `errors` | <15% |
| `sessions_created` | >0 |
| `sessions_deleted` | >0 |

429 creates/deletes are counted and sleep fifteen seconds before returning; floors prevent empty-success verdicts. Creation requires 201; deletion 200/204. List/get checks exist but no global checks threshold makes every read check individually fatal. A failed/throttled delete can leave a created session.

#### Storage Operations (`storage-operations.js`) <!-- @impl: stress/storage-operations.js::options --> <!-- @impl: stress/storage-operations.js::default -->

Three-minute 30s/2m/30s workload at baseline five (initial ramp target three). Simple upload/browse/download/delete with 60% 1-KB, 30% 20-KB, 10% 50-KB payloads. About 20% of iterations additionally upload three folder objects and delete their prefix. Think ranges: 3–8s after upload, 2–5s between browse/download/delete, 5–15s between cycles, and 1–3s before folder deletion.

| Gate | Fixed threshold |
|---|---|
| Upload p95 | <10s |
| Download p95 | <5s |
| Browse p95 | <3s |
| `errors` | <15% |
| `files_uploaded` | >0 |

429 uploads sleep ten seconds/return; successful-upload count prevents empty-success verdict. Browse/download/delete and folder checks are reported, but no global checks gate turns every check into a failing verdict and custom `errors` records upload outcomes only. Deletion/content persistence coverage must not be overstated.

#### Stress Test with Rate Limits (`rate-limit-validation.js`) <!-- @impl: stress/rate-limit-validation.js::options --> <!-- @impl: stress/rate-limit-validation.js::sessionLimitTest --> <!-- @impl: stress/rate-limit-validation.js::preferencesLimitTest -->

One VU/one session scenario (max three minutes) bursts fifteen creates against scripted cap ten. One VU preferences scenario starts at 3m10s (max two minutes) bursts twenty-five patches against scripted cap twenty. These are suite assumptions to reconcile with [API Reference](api-reference.md), not a second endpoint policy owner.

`rate_limit_429s count>0`, `checks rate>0.99`, and `unexpected_errors rate<0.05` gate. Session checks require some 201s, at least one 429, successful creates ≤ ten and 429 advisory information. Preferences checks require at least one 429, not a separate success/cap assertion. `unexpected_errors` only receives true on unexpected statuses, so any recorded unexpected status fails rather than representing a measured five-percent tolerance. Cleanup reads `{ sessions: [...] }`, attempts deletion of `ratelimit-test-*` and warns on parse failure; it is not transactional and can encounter delete limits. Mode preferences are not restored.

<a id="session-lifecycle-rate-limits-detail"></a>
#### Session Lifecycle Rate Limits Detail

Current create/delete limits are API-owned. A shared service identity aggregates every VU into one limiter key; intended saturation measurement needs bypass. Stop, container-start and WebSocket behavior are not exercised by this CRUD suite. Counter floors prove nonempty create/delete observations, not representative capacity or complete cleanup.

### Load Model

#### Think Time Model

All load scripts sleep uniformly `min + random * (max-min)` seconds. Concurrency changes VU targets only, not per-VU request sequencing, random file distribution or think times.

<a id="vu-to-real-user-mapping"></a>
#### Load Interpretation Limits

VU counts are workload inputs. No conversion to real users or supported capacity is maintained. Interpret request rate, latency/error distributions, exact suite revision, target resource profile/configuration and identity. Request-rate examples are only rough scripted estimates; network time/random branches mean they are not guarantees. Dated runs prove only the tested revision/configuration/workload.

<a id="concurrency-input"></a>
#### Concurrency Scaling

`CONCURRENCY = parseInt(value || '0', 10)`; per-suite `SCALE = positive ? CONCURRENCY / BASE_VUS : 1`; each target is `max(1, round(vus * SCALE))`. Baselines are ten/three/five. Zero/unset keeps baseline; fifty/two hundred/one thousand scale target VUs proportionally. Current scripts retain all fixed thresholds under positive concurrency; the old prose claiming loosened thresholds contradicts source and REQ-OPS-008 AC3 remains an explicit unresolved normative ambiguity, not silently changed here.

<a id="rate-limit-bypass"></a>
### Target Safety and Rate-Limit Bypass

Only exact `active` skips HTTP/WS limiter storage and emits one shared isolate warning. SaaS plus stress is invalid and returns 503. This is an operator-prepared integration mode, **not** a source-enforced hostname restriction; production must never enable it. [Security](security.md#rate-limiting) owns bypass/failure posture; [API Reference](api-reference.md) owns exact limits. Session/quota admission bypass is Session Lifecycle/Billing-owned, not a CI guarantee.

<a id="configuration-reference"></a>
### Configuration and Workflow Aliases

<a id="worker-environment-variable"></a>
<a id="github-variables-integration-environment"></a>
<a id="github-secrets"></a>
Configuration owns Worker `STRESS_TEST_MODE`; private deployment owns preparation. Integration workflow variable `STRESS_TEST_CONCURRENCY` defaults zero and `E2E_BASE_URL` identifies normalized origin. Probe credentials are CF Access client ID/secret and optional OAuth setup fallback; secrets are not copied into documentation.

#### Workflow Architecture

Setup → four selected-or-all parallel jobs → always-running summary. Summary rejects failed/cancelled suite jobs, permits deselected skipped jobs, downloads `stress-*`, requires at least one results file and a thresholds key, and rejects any serialized false threshold. This text gate is not a proof that every selected job's artifact is individually reconciled; k6 job exits and reported thresholds are the verdict boundaries. Result artifacts retain thirty days; no report collection is maintained.

<a id="results"></a>
<a id="results-and-historical-evidence"></a>
<a id="latest-results-2026-03-07-50-vus"></a>
<a id="historical-results-2026-03-07-workflow-and-suite-definitions-50-vus"></a>
### Immutable load evidence aliases

Historical measurements remain at [the original result](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/stress-test.md#latest-results-2026-03-07-50-vus), with its existing [Actions run](https://github.com/nikolanovoselec/codeflare/actions/runs/22808941531). They are not current capacity or current enforcement evidence. No dated metrics are duplicated here.

<a id="api-throughput"></a>
[Original throughput result](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/stress-test.md#api-throughput)

<a id="session-lifecycle"></a>
[Original lifecycle result](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/stress-test.md#session-lifecycle)

<a id="storage-operations"></a>
[Original storage result](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/stress-test.md#storage-operations)

#### Files

`stress/api-throughput.js`, `session-lifecycle.js`, `storage-operations.js`, `rate-limit-validation.js` own workload implementation; `stress-test.yml` orchestrates. Middleware/terminal route/core/constants own actual limiter behavior and values, referenced from Security/API owners rather than inventoried as a second policy.

<a id="endpoints-not-yet-stress-tested"></a>
<a id="timekeeper-do-load-characteristics"></a>
<a id="container-start-quota-check"></a>
#### Subscription and Timekeeper Considerations

Current suites do not exercise subscription/tiers/usage/admin/onboarding-config load, active-container Timekeeper ping accounting or quota enforcement. Subscription owns those runtime contracts. Old sixty-second ping/KV quota/cap prose is not a current implementation guarantee; REQ-OPS-057's representative accounting fixture is distinct CI evidence, not coverage from these k6 workloads.

<a id="testing"></a>
## Test Suite Catalogue

### Backend Tests

Root `vitest.config.ts` uses real Workers runtime via `@cloudflare/vitest-pool-workers` `cloudflareTest()`, not Node. `npm test`; Istanbul coverage because host V8 cannot profile workerd isolates. Floors remain source-owned in package configs; affected PRs/full runs enforce them before promotion. Changed-line LCOV excludes deletions/test-only changes, follows rename destinations, bounds diff/report/line counts and fails absent production records.

Closed Administration material-state owners assigned to user-owned Integration validation are `ActivityPage.tsx`, `AdministrationLayout.tsx`, `AdministrationOverview.tsx`, `AnalyticsPage.tsx`, `AnalyticsUserDetail.tsx`, `EnvironmentAreaFields.tsx`, `EnvironmentIndex.tsx`, `ReportsPage.tsx` and `environment-areas.ts` under `web-ui/src/components/admin/`. Exceptions do not extend to backend/shared infrastructure/other production code (REQ-OPS-022).

Protected rendered behavior uses deployment-time browser-e2e evidence on phone/tablet/desktop: login content visible before auth settlement, armed Vault success color under sticky touch hover, unclipped Kitt beam geometry, and SplashCursor retirement on WebGL loss with stable dark surface. CSS-source patterns do not prove rendering and no repository browser framework is added by this method.

The known Workers teardown fingerprint is accepted for opted-in suites only after parsed nonempty report/no failed tests/suites; coverage additionally requires table/no threshold miss. Missing/corrupt report, unknown nonzero exit or test failure remains fatal. `.github/actions/vitest-suite` runs dot plus JSON reporter and invokes `scripts/ci/check-vitest-report.mjs`, not prose grep. jsdom/Node nonzero exits stay fatal (REQ-OPS-022/023).

Shared `.github/actions/install-deps` uses lock-keyed cache, bounded/retried `npm ci --prefer-offline --no-audit --no-fund` on misses and Node compile cache. Summary reconciles all registered `scripts/ci/suites.mjs` test files against reports; missing/duplicate files and successful lanes without reports fail. `vitest.node-suite.mjs` is shared Node ownership, not duplicated exclude lists.

Use module-level `vi.mock` before imports, `vi.hoisted` for mock-factory mutable state, and silent miniflare logging. Crypto suites exercise KV AES-GCM/migration and R2 SSE-C. Large tests are split along describe boundaries; hoisted scaffolding remains per-file rather than unsafe shared initialization.

### Frontend Tests

`web-ui/vitest.config.ts`, jsdom/`@solidjs/testing-library`; `cd web-ui && npm test`. Getter-based Solid stores are reimported after `vi.resetModules`; render components through the library.

### Host Tests

`host/package.json` Node runner; `cd host && npm test`. CI excludes image-only cases through the maintained exclusion ledger. Covers PTY fixed 1.5-second first-output settlement, activity/input tracking, host HTTP/WS/proxy security, sync filters, lifecycle/memory/metrics, entrypoint/agent configuration, graph hooks and migration. Package references own detailed inventories.

### Property-Based Fuzz Tests

fast-check; workflow fifty thousand iterations, local default one thousand and `FAST_CHECK_NUM_RUNS` override. Owned suites cover backend input-validation, helper/runtime configuration, managed monotonic activation/conflicts, Vault parsing/routing/regimes, frontend adversarial data and terminal-link boundaries, and host prewarm/activity. Tests should exercise production untrusted boundaries, not language/framework guarantees or replica helpers. The retained `replicated-helpers` suite name is existing inventory, not permission to add replica tests.

<a id="bugs-found-by-fuzzing"></a>
**Bugs found by fuzzing:** preserved historical alias only at [original CI subsection](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/ci-cd.md#property-based-fuzz-tests); discoveries are not a present campaign history here.

### Vitest Configuration

Root/web-ui use separate installs/configs of Vitest v4; root Workers plugin versus frontend jsdom/Solid. Root/web-ui/landing choose dot in CI and default locally; suite action supplies JSON report for machine-readable gating.

<a id="specification-coverage"></a>
## Requirement and Source Map

SDD records retain exact IDs/statuses/AC/constraints/evidence. This map does not upgrade manual/Partial acceptance.

| Family | Requirements | Source | Evidence |
|---|---|---|---|
| PR gates | OPS-003/022/023/024/045/053/058 | test workflow, suite actions, CI scripts | Reports, completeness, coverage, exact-tree receipt |
| Deployment/artifacts | OPS-001/002/013/014/026/028/029/031/042/050/052/056/060/061 | Deploy/Image | Provenance/digest, scan/SBOM, order/outcome |
| Promotion | OPS-036/037 | promotion-source and GitHub rulesets | Validator plus live rulesets |
| Supply chain/release | OPS-009/019/020/021/025/027/032/033/034/035/041/054/055/059 | Dedicated workflows/pin helpers | Generated artifacts, release/image receipts |
| Security probes | OPS-005 | pentest and owned target/TLS helpers | Exact run and tracking issue; bounded unauthenticated observations |
| Load methods | OPS-008/044 | stress workflow and four scripts | Selected mode-compatible k6 result, not capacity certification |
| Nightly/fuzz | OPS-018/043 | Reusable matrix/fuzz | Full-run/iteration evidence |
| Product behavior | Session/Storage/Agents/Security/Billing requirements | Actual runtime owners | Owning behavioral suites; not guaranteed by CI methods alone |

## Related Decisions

- [AD112](../decisions/README.md#ad112-ci-runs-as-parallel-path-filtered-lanes-and-deploys-reuse-content-addressed-container-images)
- [AD114](../decisions/README.md#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration)

## Related Documentation

- [Deployment](deployment.md) — operator execution/verification/rollback
- [Configuration](configuration.md#secrets) — public variables/secrets
- [Security](security.md) — controls, exceptions, failure posture
- [API Reference](api-reference.md) — endpoints and exact limits
- [Troubleshooting](troubleshooting.md) — diagnostic recovery
