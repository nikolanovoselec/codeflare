# Contributing to Codeflare

Use this guide to prepare a change, choose the relevant checks, and submit a pull request to the public Codeflare repository. Product setup belongs in the [README](README.md); verification details belong in [CI/CD and Testing](documentation/lanes/ci-cd.md).

- [Choose the right scope](#choose-the-right-scope)
- [Set up a working copy](#set-up-a-working-copy)
- [Find the source](#find-the-source)
- [Make a focused change](#development-workflow)
- [Verify your change](#running-tests)
- [Submit and respond to review](#submitting-changes)
- [License and contribution policy](#license)

## Choose the right scope

For bugs, proposals, and codebase questions, open an issue in this repository. Describe the expected behavior, what you observed, and the relevant version or commit. Do not include credentials, customer data, or private deployment details.

**For suspected vulnerabilities, do not open a public issue.** Use the reporting route in [SECURITY.md](SECURITY.md).

| Contribution | Public contribution path |
|---|---|
| Worker, frontend, container host, compiler, or runtime | Change the relevant Codeflare source, tests, and public documentation. |
| Landing or Browser IDE package | Start with the [Landing reference](landing/README.md) or [Browser IDE reference](openvscode/README.md). Keep system-wide contracts in their owning documentation. |
| Documentation | Update the existing document that owns the subject; link to it rather than duplicating its contract. |
| Image-baked agent fallback or shared agent infrastructure | State whether the change affects the baked fallback, compiler, runtime, or shared sources. Explain the compatibility and alignment implications in the PR. |
| Deployment-managed content or private operations | Describe the public behavior or interface impact in a Codeflare issue or PR. Maintainers coordinate any private changes and publishing separately. |

Public contributors do not need access to private curation or operator repositories, and are not expected to run private workflows. Managed content and non-default operational procedures have private owners; they are not public contribution prerequisites. Keep secrets and private operational instructions out of this repository.

Codeflare owns the compiler, runtime, seed ABI, runtime dependency locks, and baked seed. Deployment-managed content is maintained separately; editing the baked fallback alone does not update an active managed deployment. Required shared-source alignment must not be left stale: identify affected copies for maintainer coordination. Source changes, signed publication, and runtime activation are separate stages; a public PR does not establish that private publication or deployment has occurred.

## Set up a working copy

### Runtime and package requirements

Use Git, GitHub access to your fork, and Node.js with npm appropriate to the package and verification lane you are changing. There is no single repository-wide Node version:

- The [PR Checks workflow](.github/workflows/test.yml) selects Node 22 for several backend/frontend jobs and uses governed patch pins for other jobs, including Node 26 for host tests.
- The [workflow tool pins](.github/workflow-tool-pins.json) own the governed CI patches. Use the workflow to determine which pin applies; not every job consumes a patch pin.
- The [Browser IDE extension manifest](openvscode/agent-sidebar/package.json) declares its own Node engine. That embedded extension requirement is distinct from the host CI runtime.

Read the affected package manifest, committed lockfile, and corresponding workflow job before installing. These references describe source requirements, not a qualified workstation support matrix or a guarantee that every integration path works locally.

### Fork and branch

Fork the [public Codeflare repository](https://github.com/nikolanovoselec/codeflare) on GitHub. Then clone your fork and create a feature branch from upstream `develop`:

```bash
git clone https://github.com/<your-username>/codeflare.git
cd codeflare
git remote add upstream https://github.com/nikolanovoselec/codeflare.git
git fetch upstream develop
git switch -c fix/describe-your-change upstream/develop
```

For an existing clone, reuse its upstream remote if already configured. Use a descriptive branch prefix such as `feat/`, `fix/`, `refactor/`, `test/`, or `docs/`.

### Install only what you need

The commands below are for a contributor workstation. In a managed Codeflare agent session, follow the [managed execution boundary](#managed-execution-and-ci) instead.

**All examples below start at the repository root**, unless explicitly labelled otherwise. Parenthesized package commands run in independent subshells, so they do not change the working directory for the next command.

Install root dependencies:

```bash
npm ci
```

Then select only the packages needed for your change or its checks; this is not a mandatory all-package checklist:

```bash
(cd web-ui && npm ci)
(cd host && npm ci)
(cd landing && npm ci)
(cd openvscode/agent-sidebar && npm ci)
```

`npm ci` installs from the committed lockfile and may run lifecycle scripts, including native dependency setup. Do not regenerate lockfiles incidentally. Intentional dependency updates must keep the owning manifest and lockfile coherent and follow the repository's dependency workflow.

Local overrides are described in [`.dev.vars.example`](.dev.vars.example). Some development paths require configured services or credentials; integration deployment requires authorized credentials and is separate from ordinary contribution setup. Never commit real values.

## Find the source

| Path | Owns |
|---|---|
| `src/` | Cloudflare Worker routes, authentication, storage, and Durable Objects |
| `web-ui/` | SolidJS application and terminal UI |
| `host/` | Container terminal server and host integration tests |
| `landing/` | Astro landing pages and browser behavior |
| `openvscode/` | Browser IDE extension and agent projection packages |
| `preseed/` | Image-baked workspace content and agent fallback inputs |
| `scripts/` | Seed generation, compilation, and maintenance utilities |
| `stress/` | k6 integration workloads; not routine workstation checks |
| `.github/workflows/` | Public CI, release, and deployment workflows |
| `sdd/` | Requirements, acceptance criteria, and evidence anchors |
| `documentation/` | Canonical technical references and architecture decisions |

See [Architecture](documentation/lanes/architecture.md) for system boundaries. A documentation **lane** is the existing reference that owns one subject. A **REQ** is a stable requirement in the [specification](sdd/README.md), with acceptance criteria and links to implementation and test evidence.

<a id="development"></a>
## Development Workflow

### Requirements and behavioral evidence

For a functional behavior change, map the complete intended behavior to the owning requirements before editing implementation. Update the acceptance criteria first, add the complete failing behavioral test suite for the approved change in one test-only phase, then implement to green. Record the failing-test evidence, keep tests and the green implementation together in the submitted change, and obtain final exact-head CI. Follow the current task's approved CI sequence rather than pushing an incomplete RED-only batch. Keep changed `@impl` and `@test` anchors adjacent to the acceptance criteria they support; leave no touched requirement partially satisfied.

Tests must observe the required behavior, not merely match source text, private calls, or implementation structure. Exact copy or structure assertions are appropriate only when they are intentional contracts with a related observable outcome.

Do not manufacture failing tests or impose RED/GREEN on documentation, wording, formatting, workflow maintenance, or dependency/version changes that do not change specified functional behavior. Use the appropriate existing checks and CI gates for those changes.

### Implementation and documentation

Keep each PR focused. Preserve unrelated work and behavior; avoid drive-by refactors and formatting churn. Update the owning documentation lane and package reference when their contracts change, and update `sdd/spec/changes.md` when required product behavior changes.

Generated, vendored, archived, and runtime-payload files must be changed through their generator or owning upstream workflow. Read the relevant source and configuration before editing generated output. For agent infrastructure shared with managed content, identify required alignment and compatibility work rather than assuming automatic synchronization.

Follow surrounding formatting. TypeScript, SolidJS signals, Hono routing, and Zod boundary validation are established patterns in their respective packages. **oxlint is the configured linter**, not a replacement formatting policy; do not introduce unrelated formatting tools or changes.

### Workstation development servers

Run these long-lived processes in **separate terminals**, each starting at the repository root. They are package entry points, not a complete integration-environment recipe.

Terminal 1 — Worker development server through Wrangler:

```bash
npm run dev
```

Terminal 2 — frontend Vite development server:

```bash
(cd web-ui && npm run dev)
```

## Running Tests

### Managed execution and CI

The following commands document package scripts for contributor workstations. They do not authorize local execution in a managed Codeflare agent session. In managed sessions, [AGENTS.md](AGENTS.md) requires the [safe-local-checks route](preseed/agents/claude/skills/safe-local-checks/SKILL.md) for approved bounded local checks; installs, servers, package test scripts, builds, and type checks remain CI-only. Do not bypass those restrictions to follow a workstation example.

GitHub Actions is authoritative for full verification against the exact PR head. Its diff classification selects the affected lanes and reconciles their reports. A local result is supplemental evidence, not an equivalent CI verdict or deployed integration acceptance. See the [CI catalogue](documentation/lanes/ci-cd.md) for current gates and coverage limits.

### Workers and Node are separate root suites

From the repository root on a contributor workstation:

```bash
# Workers behavioral suite; npm automatically runs pretest first.
npm test

# Separate Node-owned suite; prepare explicitly before this named script.
npm run pretest
npm run test:node
```

The [Workers configuration](vitest.config.ts) excludes files owned by the [Node configuration](vitest.node.config.ts). `npm test` alone therefore does not cover the root Node suite. Choose both when the change spans their contracts.

Root `pretest` generates tutorial and agent seed files and checks Pi extensions; it can update generated source files. The `test:node` script does **not** automatically invoke `pretest`. CI explicitly prepares seeds before running it and also creates the assets directory required by Wrangler. Consult the corresponding workflow job for additional suite inputs; the two commands above do not reproduce the complete CI job. Review generated changes rather than treating preparation as read-only.

<a id="rate-limit-tests"></a>
<a id="subscription-and-usage-tests"></a>
### Verification by change

Every command in this table starts at the repository root. Select the affected suites and checks; this table is not a substitute for CI's complete diff classification.

| Change | Workstation package command or check | Reference |
|---|---|---|
| Worker routes, auth, storage, usage, or Durable Objects | `npm test`; affected root lint/type checks | [Backend tests](documentation/lanes/ci-cd.md#backend-tests) |
| Node-owned root behavior, generated seeds, or CI gate scripts | `npm run pretest` followed by `npm run test:node`; affected static checks | [Node suite configuration](vitest.node.config.ts) |
| Frontend behavior | `(cd web-ui && npm test)`; frontend lint/type checks | [Frontend tests](documentation/lanes/ci-cd.md#frontend-tests) |
| Container host, entrypoint, or documentation contracts | `(cd host && npm test)` with the required host inputs | [Host tests](documentation/lanes/ci-cd.md#host-tests) |
| Landing package | `(cd landing && npm test)` | [Landing verification](landing/README.md#develop-and-verify) |
| Browser IDE extension or Claude projection | `(cd openvscode/agent-sidebar && npm test)`; package dependency/type checks | [Browser IDE verification](openvscode/README.md#develop-and-verify) |
| Rate-limit or load-model behavior | Affected backend suites; k6 only as separately authorized integration work | [Load-testing safety](documentation/lanes/ci-cd.md#load-testing) |

Host CI installs root and host dependencies plus inspected Pi inputs, prepares additional runtime/sandbox dependencies, and applies an image-only exclusion ledger. A bare host package run does not reproduce that environment or complete-image checks. Do not interpret unavailable prerequisites or retired transport workloads as passing evidence. Integration and Enterprise Integration acceptance remain separate requirements where applicable.

### Lint and type checks

These are workstation package commands, all starting at the repository root:

```bash
npm run lint
(cd web-ui && npm run lint)
npm run typecheck
(cd web-ui && npm run typecheck)
```

Other packages expose different scripts; use their manifests and package references rather than assuming every package has the same checks.

## Submitting Changes

Use the commit format `<type>: <description>`, where the type is `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, or `ci`. Keep the description specific to the change.

Open a public pull request from your feature branch against **`develop`**. Include:

- **What and why:** the problem and the focused correction.
- **Behavior and ownership:** affected packages, REQ links when applicable, and public documentation updates.
- **Verification:** checks actually run, their outcomes, and the head they cover. List checks not run and why; do not present planned checks as completed evidence.
- **Boundaries:** known limitations, integration acceptance still needed, and any maintainer-owned private coordination. Do not include private values or procedures.

Respond to review findings, explain disagreements with evidence, and apply accepted corrections within the PR's scope. After updates, obtain checks for the updated head; an earlier green run does not verify later changes. Required workflows classify the diff and evaluate the affected lint, type, test, security, dependency, workflow, and package lanes.

Managed Codeflare agents also follow the [PR-boundary review protocol](preseed/agents/pi/skills/git-review-pipeline/SKILL.md). Those agent mechanics are not an additional private-access requirement for public contributors. Check and promotion details remain in [CI/CD and Testing](documentation/lanes/ci-cd.md#merge-and-promotion-gates); this guide does not establish an approval count or review turnaround guarantee.

## Security

Report vulnerabilities through [SECURITY.md](SECURITY.md), not public issues or PRs. Keep sensitive reproduction evidence in the private reporting channel specified there.

Production security probes are operator-controlled, not routine PR verification. Any live probe requires explicit authorization and operator coordination; do not trigger production probes as a contribution check. The [security-probe methodology](documentation/lanes/ci-cd.md#security-probes) describes their limited coverage. Probe results do not replace affected tests or integration acceptance and are not security certification.

## License

Codeflare is licensed under [PolyForm Noncommercial 1.0.0](LICENSE).

By submitting a contribution, you agree that your work will be distributed under the same license.

Commercial use, resale, or paid hosted offerings require a separate written license from the maintainer.

## Questions and references

Open an issue in this repository for questions about public contribution scope, architecture, or the development process. Private repository access is not required to ask for maintainer coordination.

- [README](README.md) — product overview and default setup
- [Documentation index](documentation/README.md) — technical ownership and references
- [Specification](sdd/README.md) — required behavior and evidence
- [CI/CD and Testing](documentation/lanes/ci-cd.md) — verification gates and limitations
- [Security policy](SECURITY.md) — vulnerability reporting
