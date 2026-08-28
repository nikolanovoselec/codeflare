<h1 align="center">
  <img src="assets/documentation/logo-icon.svg" width="30" alt="Codeflare logo">
  Codeflare
</h1>

<p align="center">Build and ship software. Investigate and operate infrastructure. Keep both inside the controls your organization already trusts.</p>

<p align="center">
  <a href="https://github.com/nikolanovoselec/codeflare/releases/latest"><img src="https://img.shields.io/github/v/release/nikolanovoselec/codeflare?display_name=tag&amp;sort=semver" alt="Latest release"></a>
  <a href="https://github.com/nikolanovoselec/codeflare/actions/workflows/test.yml"><img src="https://github.com/nikolanovoselec/codeflare/actions/workflows/test.yml/badge.svg?branch=main" alt="PR Checks"></a>
  <a href="https://github.com/nikolanovoselec/codeflare/actions/workflows/codeql.yml"><img src="https://github.com/nikolanovoselec/codeflare/actions/workflows/codeql.yml/badge.svg?branch=main" alt="CodeQL"></a>
  <a href="https://github.com/nikolanovoselec/codeflare/actions/workflows/fuzz.yml"><img src="https://github.com/nikolanovoselec/codeflare/actions/workflows/fuzz.yml/badge.svg?branch=main" alt="Property-based fuzzing"></a>
</p>

<p align="center">
  <a href="#deploy-codeflare"><img src="https://img.shields.io/badge/deployment-self--operated-2563eb" alt="Self-operated deployment"></a>
  <a href="documentation/lanes/architecture.md"><img src="https://img.shields.io/badge/tenancy-single--tenant-7c3aed" alt="Single-tenant architecture"></a>
  <a href="documentation/lanes/architecture.md"><img src="https://img.shields.io/badge/runtime-Workers%20%2B%20Containers-F38020?logo=cloudflare&amp;logoColor=white" alt="Cloudflare Workers and Containers"></a>
  <a href="sdd/README.md"><img src="https://img.shields.io/badge/delivery-spec--driven-059669" alt="Spec-driven delivery"></a>
  <a href="documentation/lanes/security.md"><img src="https://img.shields.io/badge/security-Zero%20Trust-0891B2" alt="Zero Trust security"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-BE185D" alt="PolyForm Noncommercial license"></a>
</p>

<p align="center">
  <a href="https://codeflare.ch">codeflare.ch</a> ·
  <a href="documentation/README.md">Documentation</a> ·
  <a href="documentation/lanes/architecture.md">Architecture</a> ·
  <a href="SECURITY.md">Security</a>
</p>

![Codeflare product overview](assets/documentation/og.png)

This page is the product synopsis and default deployment entry point. Exact contracts, limits, implementation mechanics, and operator recovery procedures belong to the linked documentation lanes.

Most engineering agents stop at code. The awkward work remains with you: prepare the environment, watch the process, chase CI, handle review, deploy the result, and collect enough evidence to trust what happened. Infrastructure work is usually left out altogether.

Codeflare runs software delivery and infrastructure operations in isolated environments inside your Cloudflare account. Agents can inspect repositories, implement changes, open pull requests, repair CI, deploy applications, investigate systems, patch fleets, execute migrations, and verify the result. The runtime and isolation model is documented in [Architecture](documentation/lanes/architecture.md).

The agent gets room to work. Your controls stay in charge. GitHub still owns the merge. CI still owns verification. Infrastructure operations keep defined targets, rollout plans, stop conditions, and consequential approval points. Cloudflare Access controls admission, while your account owns compute, storage, model routing, and network policy. See [Security](documentation/lanes/security.md) for the trust boundaries.

<p align="center">
  <img src="assets/documentation/execution-software.gif" width="49%" alt="A Codeflare software delivery run">
  <img src="assets/documentation/execution-infrastructure.gif" width="49%" alt="A Codeflare infrastructure operation">
</p>

## What changes when the agent has the whole environment

A coding assistant can suggest a patch. Codeflare gives an agent the repository, terminal, tools, project rules, specialist agents, persistent context, GitHub access, and an optional Browser VS Code workspace. The same session can carry work from investigation to deployed verification instead of handing every boundary back to the engineer.

For software delivery, that means architecture, implementation, behavioral tests, documentation, pull requests, review responses, CI, deployment, and live checks can remain one traceable run.

For infrastructure operations, the agent can discover the estate, plan a bounded change, work through canaries and rollout gates, stop on defined conditions, and publish evidence. It does not receive a flat path around the organization's network or approval model. That would be automation theatre with a larger blast radius.

Deployed verification belongs in the same run. With Cloudflare Browser Rendering configured, Browser Run can read JavaScript-rendered public pages as Markdown or drive a live flow through Chrome DevTools for responsive checks, screenshots, and semantic investigation. Deterministic assertions remain in CI; the evidence model is documented in [CI/CD and Testing](documentation/lanes/ci-cd.md).

![Codeflare governed execution terminals](assets/documentation/bottleneck-grid.gif)

Codeflare's spec-driven development framework links requirements and acceptance criteria to implementation and behavioral evidence. Review happens at the pull-request boundary against the same change that CI sees. Findings return to the working session for correction. The engineer retains merge, production promotion, and consequential operational approval.

## Why run it in your own estate

Enterprise Codeflare is a single-tenant deployment in the customer's Cloudflare account. There is no Codeflare-operated shared execution plane that needs custody of source code, session storage, or agent credentials. The component and tenancy boundaries are documented in [Architecture](documentation/lanes/architecture.md).

Each session gets a separate ephemeral container, authenticated route, terminal set, and agent process tree. Trusted agents have broad power inside that container because useful engineering work requires it. Codeflare governs the boundaries around the work rather than pretending every shell command can be made harmless.

The customer chooses the identity provider, GitHub organization, storage regime, model routes, and egress policy. Existing branch protection and CI remain the delivery system. Destroying a session removes its transient processes and state, but it cannot undo a Git push, deployment, API call, synchronized file, or infrastructure change that already happened. [Security](documentation/lanes/security.md) documents that residual boundary.

## Bring the agent and model strategy you already have

Default, Onboarding, and SaaS deployments support Claude Code, Codex, GitHub Copilot, Pi, Google Antigravity, OpenCode, and Bash. Enterprise administrators choose from gateway-capable Pi and GitHub Copilot agents, with Bash always available.

Hosted model providers remain first-class. Supported enterprise traffic can be routed through Cloudflare AI Gateway in the customer's account, with route catalogs, model policy, context limits, and user attribution controlled there. [Codeflare Inference Mesh](https://github.com/nikolanovoselec/codeflare-inference-mesh) is an optional, separately deployed source for open models on customer-controlled GPU or CPU capacity.

<p align="center">
  <img src="assets/documentation/inference-mesh.gif" width="46%" alt="Codeflare Inference Mesh serving an agent session">
  <img src="assets/documentation/legacy-baseline.gif" width="52%" alt="Codeflare deriving a specification baseline from an existing repository">
</p>

Existing repositories do not need a ceremonial rewrite before agents can help. `/sdd init` derives a reviewable requirements baseline and source-linked knowledge graph from the implementation. `/sdd clean` reconciles specifications that have drifted from the code.

## Enterprise control without a second control plane

Cloudflare Access protects the deployment and can federate to the customer's identity provider and groups. Per-user R2 persistence carries selected data between disposable sessions. Workers KV holds control-plane state without waking idle containers, and session compute stops when unused; a later start restores selected durable files into fresh ephemeral local storage.

When configured, Strict Gateway Egress sends direct-internet HTTP, HTTPS, and WebSocket traffic through the customer's Cloudflare Gateway and denies raw TCP and UDP internet egress. It is off by default and has documented own-account Cloudflare exceptions. Enterprise GitHub and Browser Rendering credentials are injected only at their allowlisted egress boundary; one session cannot select another user's credential. See [Strict Gateway Egress](documentation/lanes/security.md#strict-gateway-egress-enterprise-mode) for the exact boundary.

`ENCRYPTION_KEY` enables AES-256-GCM protection for supported KV secrets and SSE-C for R2 objects. Governed Mode can make R2 content inspectable by customer security tooling while retaining Vault and KV secret encryption. These are technical controls, not a borrowed compliance badge. Codeflare makes no independent certification or universal audit-log claim. The storage contracts are documented in [Storage and Sync](documentation/lanes/storage-and-sync.md).

![Codeflare orchestration and agent observability](assets/documentation/observability.gif)

Operators can follow parallel agents, current work, review outcomes, CI state, session health, synchronization, and supported model usage without taking execution away from the engineer directing it.

![Codeflare attributed cost and usage ledger](assets/documentation/cost-ledger.gif)

## The workspace an agent actually needs

Every session arrives with organizational rules, reusable skills, specialist agents, approved tools, and repository context. Context loads when needed instead of occupying every prompt. Persistent notes and knowledge graphs carry decisions across disposable runtimes.

Managed Environment curation makes that content manageable out of band. A deployment points at a private release repository, a scoped read token, and a signing key; the operator publishes a signed, immutable release on its own schedule and each user's environment converges to it before the next session starts. Skills, rules, agents, and required Browser IDE extensions change without rebuilding Codeflare, and the image-baked preseed remains an independent fallback. The Worker verifies repository identity, asset digests, signature, and release sequence before any content reaches user storage; credentials never enter a session container. See [Managed Environment data flow](documentation/lanes/architecture.md#managed-environment-data-flow).

Codeflare's own curated content lives in [codeflare-curation](https://github.com/nikolanovoselec/codeflare-curation) (access required). Each operator points at their own repository instead.

![Codeflare session preload](assets/documentation/platform-preload.gif)

The browser workspace provides up to six terminal tabs, multi-pane layouts, MultiView for following several sessions, GitHub repository and pull-request workflows, per-user R2 persistence, and a mobile-oriented terminal that works without a local agent toolchain.

Advanced users choose Terminal or VS Code as the default for new sessions. Terminal sessions keep lazy Browser VS Code startup; VS Code sessions stay on the dashboard while code-server warms, then open only when the user clicks **Open**. Pi sessions receive native Codeflare Chat, editor Inline Chat, and **Review with Codeflare**. Claude sessions use Anthropic's pinned official panel. A bounded snapshot preserves theme, the selected web keyboard layout, Explorer expansion, and open files. Credentials, authentication, other User settings, extension state, editor databases, chat history, and logs remain temporary. See [Browser IDE architecture](documentation/lanes/architecture.md) for the owned state boundary.

![Codeflare Browser VS Code workspace](assets/documentation/browser-vscode.gif)

## Architecture in one minute

A Hono Worker authenticates HTTP and WebSocket traffic, serves application APIs, routes sessions, and applies control-plane policy. One Container Durable Object coordinates each session lifecycle. One Cloudflare Container provides that session's Linux environment, terminals, selected agent, and code-server process.

Workers KV stores control-plane records. Per-user R2 stores the explicitly selected persistent data. Enterprise egress interceptors keep supported credentials and model routes at the Worker boundary when their contracts require it. The detailed component model and request flows live in [Architecture](documentation/lanes/architecture.md); public API contracts live in the [API reference](documentation/lanes/api-reference.md).

## Security model and limits

Codeflare reduces standing and cross-session exposure around powerful agents. It does not claim that an unrestricted engineering agent is safe merely because it runs in a browser.

- Each session has its own container, authenticated route, lifecycle-scoped proxy token, terminal set, and agent process tree.
- Browser VS Code opens on a fixed workspace and rejects browser-supplied workspace selectors. The server snapshots the workspace choice when it creates the session, so changing the future default cannot convert existing sessions. This confines navigation, not terminal commands or trusted extensions.
- Workspace synchronization is opt-in. Git remains the recommended persistence path for source code; R2 synchronization is periodic, not transactional.
- Strict Gateway Egress is optional and carries a startup-availability trade-off. Review its exceptions before treating it as a mandatory DLP boundary.
- The initial setup endpoint is public until the deployment is claimed. Complete setup promptly and protect the initialization hostname afterward.

Read [Security](documentation/lanes/security.md), [Authentication](documentation/lanes/authentication.md), and the [security policy](SECURITY.md) before approving production use. Report vulnerabilities through the private route in `SECURITY.md`, not a public issue.

## Deploy Codeflare

### Before you begin

Use a Cloudflare account that can run Workers and Containers, a GitHub fork with Actions enabled, and the maintained minimum-scope operator token from [Configuration](documentation/lanes/configuration.md#cloudflare-api-token-operator). Licensed operators should complete the private [deployment quick start](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/quickstarts.md) for their selected mode. Production promotion and recovery run through reviewed GitHub workflows rather than local Wrangler commands.

### Default self-operated deployment

The public path creates a private single-tenant instance in four steps:

1. Fork this repository.
2. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions repository secrets. Use the maintained [operator token scope list](documentation/lanes/configuration.md#cloudflare-api-token-operator).
3. Run **Actions > Deploy > Run workflow** from `main` with the production target.
4. Open the Worker URL and complete the setup wizard for the custom domain, allowed users, administrators, R2 credentials, and Cloudflare Access resources.

The workflow provisions the shared Worker, KV control plane, and session container image in the operator's account. The setup wizard creates the configured Cloudflare Access application and policies; each user's R2 bucket is created when that user's container is first initialized. For a shared or production deployment, configure `ENCRYPTION_KEY` before storing provider or user credentials. Production deployment belongs to GitHub Actions; `npm run deploy` is not a substitute for the reviewed workflow. See [Architecture](documentation/lanes/architecture.md#bucket-creation-and-seeding) for the resource lifecycle.

### Verify the deployment

Retain the successful Deploy run and commit, confirm public health and provider discovery on the deployed origin, then exercise the changed user path. Session changes require creating, starting, opening, and deleting a disposable session; a health response alone is not deployment evidence. The executable checks and rollback procedure live in [Development & Deployment](documentation/lanes/deployment.md#standard-deployment).

### Enterprise deployment

Operators connect the customer's Cloudflare account, Access application and groups, GitHub organization, AI Gateway, storage regime, and optional Gateway egress policy. Subscription and billing surfaces are disabled; admitted users receive full-capability sessions under the deployment's active-agent policy ([Enterprise requirements](sdd/spec/enterprise-mode.md), [Enterprise operator runbook](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/enterprise.md)).

Exact enterprise secrets, operator token permissions, environment layouts, promotion checks, and rollback procedures live in the private [Codeflare operator library](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/README.md) (access required). They are intentionally not copied into the public repository.

## Verification and release discipline

This repository uses the same delivery controls it gives to agents. PR Checks cover lint, types, audits, backend and frontend behavior, host integration, dependency review, workflow analysis, bundle limits, and complete-image Browser IDE verification. Container publication verifies content-addressed inputs, scans fixable HIGH and CRITICAL findings, and emits an SBOM and provenance for fresh images. The maintained gate is documented in [CI/CD and Testing](documentation/lanes/ci-cd.md).

Published releases include deterministic source archives, checksums, keyless Sigstore bundles, and GitHub provenance. Deployment verifies the reviewed source tree before promoting Worker assets and the session image. Rollback begins from a known successful deployment and closes only when the original failed user flow passes. Release and rollback procedures live in [CI/CD and Testing](documentation/lanes/ci-cd.md) and [Deployment](documentation/lanes/deployment.md).

The complete evidence model is documented in [CI/CD and Testing](documentation/lanes/ci-cd.md). Historical probe evidence is in [Penetration Testing](documentation/lanes/pentest.md), and load procedures are in [Stress Testing](documentation/lanes/stress-test.md).

## Development

Install the root and frontend dependencies, then start the Worker development environment:

```bash
npm install
cd web-ui && npm install && cd ..
npm run dev
```

Package owners keep their own test suites:

```bash
npm test
(cd web-ui && npm test)
(cd landing && npm test)
(cd host && npm test)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch, test, and pull-request expectations.

## Documentation

- [Operator and developer documentation](documentation/README.md) covers configuration, deployment, authentication, storage, lifecycle, CI, troubleshooting, and internals.
- [The specification](sdd/README.md) owns required behavior, acceptance criteria, implementation anchors, behavioral evidence, constraints, and change history.
- [Getting Started](preseed/tutorials/Getting%20Started.md) introduces terminal sessions, persistence, and agent workflows.
- [Worked examples](preseed/tutorials/Examples/) cover specification-driven changes from small tasks through a complete application.
- [Architecture decisions](documentation/decisions/README.md) preserve the rationale and trade-offs behind consequential design choices.

## License

Codeflare is licensed under [PolyForm Noncommercial 1.0.0](LICENSE). It permits the noncommercial use described in its terms. Commercial use, resale, or a paid hosted offering requires a separate written license.
