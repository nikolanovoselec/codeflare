# <img src="assets/documentation/logo-icon.svg" width="28" align="absmiddle" alt="Codeflare logo"> Codeflare

![Codeflare: the agentic engineering engine. Governed engineering agents inside your own estate.](assets/documentation/og.png)

**A customer-operated engineering control plane for governed AI agents.**

Codeflare runs engineering agents inside your own estate, under your identity, source-control, CI, inference, and security boundaries. Engineers define intent, steer execution, inspect evidence, and approve the outcome; agents build, test, review, and operate without creating a shadow toolchain.

Enterprise deployment is the primary model: a single-tenant Codeflare instance runs in the customer's Cloudflare account and connects to the customer's GitHub organization, Cloudflare Access policies, AI Gateway, storage, and optional private inference capacity. Codeflare is software the customer operates—not a vendor-hosted control plane in the source-code or model-traffic path.

![Codeflare on a foldable tablet](assets/documentation/mobile-foldable.jpg)
*One governed run from intent to approval, available through a browser without a local engineering toolchain.*

**Enterprise deployment:** see the [private deployment repository](https://github.com/nikolanovoselec/codeflare-private) (access required). A public demonstration is available at [codeflare.ch](https://codeflare.ch).

---

## Why enterprises deploy Codeflare

| Enterprise priority | What Codeflare provides |
|---|---|
| **Engineering guardrails and DLP** | Specification, TDD, CI, and specialist review gates keep changes aligned with approved intent. Separately, customer-owned AI Gateway and optional strict egress apply the customer's existing model and web-traffic guardrails, DLP, and allow/block policies. |
| **FinOps attribution and route control** | Model requests carry user and matched-group attribution into the customer's AI Gateway. Global and per-group route catalogs constrain approved model routes, defaults, reasoning, and context windows; container usage scales to zero when sessions stop. |
| **Encryption and Zero Trust isolation** | Cloudflare Access gates entry, each session receives an isolated ephemeral container, and enterprise model credentials remain Worker-side. Optional AES-256-GCM/SSE-C encryption and Governed Mode provide explicit storage regimes with verified migration rather than silent data loss. |
| **Operational visibility and evidence** | Operators retain GitHub Actions logs and artifacts, SBOM/scan evidence, session resource metrics, Cloudflare dashboards, and AI Gateway analytics in systems they control. Codeflare does not require a separate proprietary observability backend. |
| **Governed inference routing** | Agents use customer-approved dynamic routes through the customer's AI Gateway. [Inference Mesh](#codeflare-inference-mesh) is optional private capacity for open models; hosted providers remain first-class defaults or fallbacks. |
| **Enterprise SSO and authorization** | Cloudflare Access federates the customer's corporate identity provider. Access JWTs, customer-managed user/admin groups, just-in-time provisioning, and live group checks govern entry and administration without a separate Codeflare identity silo. |
| **Browser VS Code and terminal workspace** | Engineers observe and intervene through code-server, terminal tabs, tiling, live resource status, and native Pi or official Claude editor integration. The workspace remains inside the session container rather than on the endpoint device. |
| **Enforced engineering lifecycle** | Requirements, acceptance criteria, behavioral tests, documentation, review, and CI are one contract. Drift is a blocking finding routed back for correction before human approval. |

These controls are implemented with Cloudflare primitives, but the product boundary is the governed engineering lifecycle: customer-owned identity, policy, inference, evidence, and data.

### Supported agents

Every session comes pre-loaded with your choice of agent:

| Agent | Description |
|---|---|
| [Antigravity](https://antigravity.google/docs/cli-overview) | Google's terminal coding agent (beta) |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Anthropic's agentic CLI |
| [Codex](https://github.com/openai/codex) | OpenAI's coding agent |
| [GitHub Copilot](https://docs.github.com/en/copilot) | GitHub's AI coding agent |
| [OpenCode](https://github.com/opencode-ai/opencode) | Open-source coding agent (beta) |
| [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | Extensible coding agent |
| Bash | For the purists |

*Pro mode—cross-session memory, a queryable knowledge graph, curated skills, and spec-driven workflows—runs full-strength on Claude Code and Pi. Other agents receive the rules and agent definitions; the deepest Pro capabilities are Claude/Pi-native.*

---

## Contents

- [Why enterprises deploy Codeflare](#why-enterprises-deploy-codeflare)
- [Engineering control plane](#engineering-control-plane)
- [Deployment models](#deployment-models)
- [Architecture](#architecture)
- [Enterprise deployment](#enterprise-deployment)
- [Community/default deployment quick start](#communitydefault-deployment-quick-start)
- [Configuration](#configuration)
  - [Default mode](#default-mode-what-you-get-with-zero-extra-config)
  - [Advanced deployment modes](#advanced-deployment-modes)
- [Security](#security)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Documentation](#documentation)
- [Codeflare Inference Mesh](#codeflare-inference-mesh)
- [License](#license)

---

## Engineering control plane

![Dashboard](assets/documentation/dashboard.png)
*Manage sessions, browse persistent storage, and monitor live resource usage — all from one view.*

**Governed execution.**

- Requirements and acceptance criteria define approved intent before implementation.
- Behavioral tests, specialist review lanes, documentation checks, and CI enforce that contract at pull-request boundaries.
- Agents work through the customer's repositories and branch protections; humans retain merge and operational approval.
- Pro sessions preload organizational rules, skills, specialist agents, cross-session memory, and a queryable project/Vault knowledge graph.

**The engineering workspace.**

- Browser-native terminal with 6 tabs per session and tiling mode (2–4 terminals side by side within one session).
- **VS Code in the browser** *(Pro sessions)* — opens code-server on the session's fixed workspace behind existing authentication. Worker and host reject public workspace selectors, keeping the URL clean ([REQ-IDE-001](sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-012](sdd/spec/browser-ide.md#req-ide-012-fixed-clean-browser-ide-workspace-selection), [REQ-IDE-015](sdd/spec/browser-ide.md#req-ide-015-fixed-workspace-projection-and-clean-browser-ide-url)).
- Pi and Claude get editor-native integrations without attaching to terminal tab 1: account-free Chat named **Codeflare** and the official Claude panel. Unsupported agents load no extension ([REQ-IDE-005](sdd/spec/browser-ide.md#req-ide-005-selected-native-ide-agent)).
- **Review with Codeflare** replaces the account-backed upstream Code Review action ([REQ-IDE-011](sdd/spec/browser-ide.md#req-ide-011-file-review-with-codeflare), [REQ-IDE-013](sdd/spec/browser-ide.md#req-ide-013-account-backed-code-review-suppression), [REQ-IDE-014](sdd/spec/browser-ide.md#req-ide-014-active-editor-review-with-codeflare)).
- The editor lazy-starts on first open, restarts after interruption, and stops with the session, so no editor process runs until it is used ([REQ-IDE-003](sdd/spec/browser-ide.md#req-ide-003-ide-lifecycle-and-availability)).
- Theme, Explorer expansion, and canonical in-workspace open files persist through a bounded snapshot. Databases, extension state, credentials, chat history, and logs remain ephemeral ([REQ-IDE-002](sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-016](sdd/spec/browser-ide.md#req-ide-016-ui-state-capture-and-restore-ordering)).
- **MultiView** — view several running sessions side by side in one workspace. It's a virtual view over sessions you already have: no new session is created, and no existing session's lifecycle is affected.
- One isolated ephemeral container per session. Terminals, trusted extensions, and agents retain their intended root-container filesystem access; the container and authenticated proxy are the isolation boundary.
- Persistent R2 storage with bisync every 15 minutes, a manual Sync-now button, and a final sync on stop. Sync conflicts are reconciled automatically on the next cycle.
- Pre-warmed terminals — the agent is loaded before you open the tab.
- Fast Start — agent auto-updates are disabled by default for instant startup; toggle in Settings.
- Set your API key once; it syncs across sessions.
- Live per-session CPU/memory/disk metrics and a three-color status (active / idle / stopped).
- Usage dashboard — daily and monthly compute hours and quota remaining, tracked by a per-user Timekeeper Durable Object.
- Configurable auto-sleep — containers stop after inactivity (15m / 30m / 1h / 2h / 4h). The timer is input-aware: it resets only on real terminal input, not reconnects or background polls.
- CPU cost scales to zero when idle — you pay for what you use.

**For your agent (Pro mode).**

- **SilverBullet vault** — every Pro session ships a browser-native note editor at `~/Vault/`. Notes, decisions, and transcripts bisync to R2 (covered by `ENCRYPTION_KEY` when set) and are IndexedDB-encrypted at rest with a zero-UI per-session key.
- **Cross-session memory** — conversation context is auto-captured every 15 prompts into the vault, so the next session opens with full recall of prior decisions — even on a different device.
- **Knowledge graph** — a queryable semantic graph (Graphify) over project source and vault content, reachable in Claude via `mcp__graphify__*` and in Pi via native `graphify_query`, `graphify_path`, and `graphify_explain` tools.

**Enterprise and platform integrations.**

- **GitHub organization integration** — browse and clone repositories, use `git push` and `gh`, and keep agent changes inside existing CI and branch protection. Enterprise deployments can use the privately documented GitHub App path; OAuth remains available for other modes.
- **Cloudflare Access integration** — validate Access JWTs, reference customer-managed groups, provision eligible users just in time, and resolve admin authorization from configured groups.
- **AI Gateway integration** — intercept supported agent model traffic Worker-side, strip placeholder credentials, attach bounded user/group metadata, and apply global or per-group dynamic-route policy.
- **Strict Gateway egress** *(optional)* — route direct-internet HTTP, HTTPS, and WebSocket traffic through the customer's existing Cloudflare Gateway policies; unavailable configured egress fails closed.
- **Native Cloudflare resource integration** *(optional convenience)* — connected users can deploy Workers and manage D1, R2, KV, and DNS from an authenticated session.
- **Guided onboarding** — configure identity, repositories, agents, routing, and deployment-specific controls without requiring each engineer to build a workstation image.

![Codeflare on a phone](assets/documentation/mobile-phone.jpg)
*Strongly optimized for mobile. Swipe up/down with the keyboard open to navigate like arrow keys; swipe left/right to scroll terminal text.*

---

## Deployment models

1. **Enterprise** — customer-operated, single-tenant, unlimited advanced mode with billing bypass. Cloudflare Access, customer-managed groups, AI Gateway interception, per-group route policy, optional strict Gateway egress, and Governed Mode are configured for the customer's estate.
2. **Default/self-operated** — single-tenant deployment with unlimited users and Pro sessions using the standard Access setup. Fork the repository, add two deployment secrets, and run the setup wizard.
3. **SaaS** — optional multi-tenant mode with subscriptions, tiered plans, just-in-time provisioning, approval workflow, and per-user usage metering.

Enterprise and advanced-mode configuration is maintained in [codeflare-private](https://github.com/nikolanovoselec/codeflare-private) (access required). Codeflare's supported internal deployment target is the customer's Cloudflare account; multi-cloud and on-premises control-plane deployment are not claimed.

---

## Architecture

![Codeflare IDE](assets/documentation/hero-ide-fullscreen.png)
*Six terminal tabs, split tiling, and your dev tools — in a disposable container you didn't have to configure.*

Codeflare separates policy from execution. Cloudflare Access authenticates the user; a session Durable Object owns one ephemeral container; the Worker and host proxy expose only authenticated session surfaces; GitHub remains the change and approval system; AI Gateway remains the inference policy and attribution boundary; R2/KV retain customer-owned state and configuration.

Supported enterprise deployments run these components in the customer's Cloudflare account. Native Cloudflare services are implementation and deployment details—not a requirement to move engineering governance, model policy, or operational evidence into a Codeflare-hosted SaaS. Full internals are documented in [architecture.md](documentation/lanes/architecture.md), [authentication.md](documentation/lanes/authentication.md), [security.md](documentation/lanes/security.md), and the [enterprise specification](sdd/spec/enterprise-mode.md).

---

## Enterprise deployment

Enterprise rollout starts from the private deployment configuration rather than the public two-secret quick start. Operators connect the customer's Cloudflare account, Access application and groups, GitHub organization, AI Gateway, storage regime, and—when required—strict Gateway egress and Governed Mode. Promotion remains gated by repository CI, image scanning, immutable deployment evidence, and environment-specific verification.

See [codeflare-private](https://github.com/nikolanovoselec/codeflare-private) for the deployment runbook and configuration surface (access required).

---

## Community/default deployment quick start

The public path remains available for evaluation, personal use, and standard self-operated deployments. Four steps produce a working single-tenant Default-mode instance.

### 1. Fork this repo

### 2. Add the two required secrets

In your fork: **Settings → Secrets and variables → Actions → New repository secret**. Add each as a separate secret.

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Create a custom token — see [API token scopes](#api-token-scopes) |
| `CLOUDFLARE_ACCOUNT_ID` | Any zone's overview page in the [Cloudflare dashboard](https://dash.cloudflare.com/) |

These two are the **only** required configuration. Everything in [Configuration](#configuration) is optional.

### 3. Deploy

**Actions → Deploy → Run workflow → Branch: `main` → Run workflow.** GitHub Actions builds, tests, and deploys to Cloudflare Workers (~2 minutes). Future pushes to `main` deploy automatically.

### 4. Run the setup wizard

Find your worker URL at [dash.cloudflare.com](https://dash.cloudflare.com/) → **Compute → Workers & Pages →** your worker (default name: `codeflare`, so `codeflare.<your-subdomain>.workers.dev`). Open it; the wizard verifies your token, configures a custom domain and allowed users, and sets up authentication via Cloudflare Access.

![Guided setup](assets/documentation/guided-setup.png)
*Connect your accounts and pick an agent. No prior Cloudflare or GitHub knowledge required.*

That's it, you're live. You'll need an active subscription to at least one supported agent; log in directly from the terminal.

> To let users connect their own GitHub and Cloudflare accounts (automatic `git push` / `wrangler` deploy from a session), an admin registers one OAuth app per provider and enters the credentials in the wizard — see the [private deployment docs](https://github.com/nikolanovoselec/codeflare-private) (access required).

<details>
<summary><strong id="api-token-scopes">API token scopes</strong></summary>

Create a custom token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).

**Required** — the minimum to deploy and run:

| Scope | Permission | Access | Why |
|---|---|---|---|
| Account | Account Settings | Read | Setup wizard reads account metadata |
| Account | Workers Scripts | Edit | Deploys the Worker |
| Account | Workers KV Storage | Edit | Session metadata and configuration |
| Account | Workers R2 Storage | Edit | Per-user persistent file storage |
| Account | Containers | Edit | Manages ephemeral session containers |
| Account | Access: Apps and Policies | Edit | Creates the Access application gating `/app` and `/api` |
| Account | Access: Organizations, Identity Providers, and Groups | Edit | Creates admin and user groups |
| Account | API Tokens | Edit | Creates per-user scoped R2 tokens |
| Zone | Zone | Read | Discovers your domain for custom-domain setup |
| Zone | DNS | Edit | Adds DNS records for the custom domain |
| Zone | Workers Routes | Edit | Routes your domain to the Worker |

</details>

---

## Configuration

> The two secrets from [step 2](#2-add-the-two-required-secrets) are sufficient only for the public Default-mode path. Enterprise, SaaS, Onboarding, and advanced policy configuration are maintained separately in [codeflare-private](https://github.com/nikolanovoselec/codeflare-private) (access required).

### Default mode: what you get with zero extra config

With **only** the two required secrets, your instance runs in Default mode:

- **Single-tenant**, authenticated by **Cloudflare Access** (the wizard creates the Access app, groups, and policies).
- **Every user is unlimited** — no subscription tiers, no billing, no quota enforcement; Pro mode is available.
- **All seven agents** selectable (six AI agents plus Bash).
- **Persistent R2 storage** per user, bisync every 15 minutes.
- Limits: **3 sessions/user**, **10/admin**; up to **10 concurrent containers**; **1 vCPU / 3 GiB / 6 GB** each.
- Root (`/`) redirects to the app — no public landing page.

Most self-hosters never need anything below this line.

### Advanced deployment modes

Beyond Default mode, Codeflare runs in **Enterprise**, **Onboarding**, and **SaaS** modes—see [Deployment models](#deployment-models). Setup and configuration for these modes is maintained privately in **[codeflare-private](https://github.com/nikolanovoselec/codeflare-private)** (access required).

---

## Security

Defense-in-depth throughout; full detail in [security.md](documentation/lanes/security.md).

- **Identity boundary** — Cloudflare Access JWT verification gates authenticated surfaces. Enterprise entry and administration can reference customer-managed Access groups; Codeflare does not claim a separate direct SAML/OIDC or SCIM integration.
- **Session isolation** — one root container per session with authenticated Worker-to-container routing and no shared shell. This is a container boundary, not a restriction on intended terminal, trusted-extension, or agent filesystem access inside that container.
- **Model credential containment** — Enterprise AI Gateway coordinates and tokens remain Worker-side; containers receive only non-secret route hints and placeholders. Other modes can inject user-authorized GitHub, Cloudflare, or model credentials into sessions, so credential-free containers are not claimed universally.
- **Strict egress** *(enterprise, optional)* — direct-internet traffic uses the customer's existing Gateway policies when enabled. Codeflare does not create or replace those policies, and missing configured egress fails closed.
- **Encryption at rest** — `ENCRYPTION_KEY` enables AES-256-GCM for protected KV values and SSE-C for R2 objects. Enterprise Governed Mode can intentionally disable R2 SSE-C for customer security scanning through a gated, verified, resumable regime migration; KV secret encryption remains separate.
- **Evidence and visibility** — GitHub Actions logs and artifacts, CodeQL, dependency review, SBOM/attestation, Trivy, session metrics, Cloudflare dashboards, and AI Gateway analytics remain available in customer-owned systems.
- **Application hardening** — HSTS, CSP, framing controls, rate limits, boundary validation, and a 64 KiB API body limit protect exposed routes.
- **Continuous testing** — weekly external probes cover authentication, security headers, TLS posture, injection, information disclosure, and HTTP methods. See [Penetration Testing](documentation/lanes/pentest.md#test-results).

Report a vulnerability via [SECURITY.md](SECURITY.md).

---

## Testing

```bash
npm test                     # Backend tests
cd web-ui && npm test        # Frontend tests
cd host && npm test          # Host tests (prewarm, activity tracker)
```

See [CI/CD & Testing](documentation/lanes/ci-cd.md#testing) for the full suite.

---

## CI/CD

| Workflow | Trigger | Purpose |
|---|---|---|
| `deploy.yml` | Green PR Checks on `main` / manual | Staged deploy: worker assets in parallel with the container image (reused when inputs unchanged), then deploy |
| `container-image.yml` | Called by `deploy.yml` | Reusable container build + Trivy scan + push (Cloudflare registry or Docker Hub bypass) |
| `test.yml` | Pull requests, push to `main`, nightly | Parallel path-filtered lanes: lint, sharded suites, typechecks, audits, dependency review, and complete-image Browser IDE native-agent verification |
| `zizmor.yml` | Workflow changes | Static security audit of the GitHub Actions workflows |
| `codeql.yml` | Push, PRs, weekly | CodeQL static analysis |
| `scorecard.yml` | Push to `main`, weekly, manual | OSSF Scorecard |
| `fuzz.yml` | PRs, weekly, manual | Property-based fuzzing (fast-check) |
| `pentest.yml` | Weekly (Mon 05:00 UTC), manual | Automated external penetration testing |
| `stress-test.yml` | Manual | k6 load testing against the integration worker |

See [CI/CD & Testing](documentation/lanes/ci-cd.md) for full documentation.

---

## Documentation

- **`documentation/`** — [architecture](documentation/lanes/architecture.md), [API reference](documentation/lanes/api-reference.md), [security](documentation/lanes/security.md), [configuration](documentation/lanes/configuration.md), [billing](documentation/lanes/billing.md), and [more](documentation/README.md).
- **`preseed/tutorials/Getting Started.md`** — tabs, tiling, file persistence, and three paths forward depending on how much hand-holding you want.
- **`preseed/tutorials/Examples/`** — spec-driven project examples from Hello World to a full blog platform. Hand one to your agent and go.

<details>
<summary><strong>Local development</strong></summary>

```bash
npm install
cd web-ui && npm install && cd ..
npm run dev
```

</details>

<details>
<summary><strong>Troubleshooting: Cloudflare WAF blocking API requests</strong></summary>

On a Cloudflare Pro plan (or higher) with Managed Rulesets enabled, the WAF may block legitimate API calls.

**Symptom:** a wall of HTML in your terminal where a simple confirmation (e.g. "session deleted") should be, informing you that you've been blocked.

**Fix:** in your domain's **Security → Analytics → Events**, find the blocked request (Action taken: *Block*), open the rule that triggered it, and disable it.

</details>

---

## Codeflare Inference Mesh

[Codeflare Inference Mesh](https://github.com/nikolanovoselec/codeflare-inference-mesh) pools spare GPUs and CPUs into optional private inference capacity for open models. Codeflare can route approved agent workloads to that endpoint while hosted providers remain first-class defaults or fallbacks. Inference Mesh is a separate deployment and is not required for Codeflare's customer-owned AI Gateway routing.

---

## License

PolyForm Noncommercial 1.0.0 — free for personal use, tinkering, and showing off.

Commercial use, resale, or paid hosted offerings require a separate written license.
