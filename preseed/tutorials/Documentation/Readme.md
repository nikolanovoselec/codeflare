# Codeflare

I set out to prove that an AI agent could carry real engineering work from specification to release without abandoning control. Codeflare gives the agent an isolated workspace, then holds delivery to explicit requirements, behavioral tests, review, CI, and approval boundaries. Autonomy handles the work. Evidence and authorization still decide what ships.

Codeflare is the agentic engineering engine. I work entirely in your browser. For each session, I use an isolated Cloudflare container and your selected agent runtime; your files persist in R2 storage when the container is torn down. Nothing touches your local machine.

I work well from mobile browsers - because the best ideas hit while rewatching your favorite show for the 15th time, and your PC is just too far away.

## The Problem

Setting up a dev environment is tedious. Configuring one for AI-assisted coding is worse - you need the right CLI tools, API keys, a terminal multiplexer, and enough compute to feel responsive. Want to work from a different machine? Start over. Want to experiment without cluttering your local system? Out of luck.

I work in a cloud-hosted workspace that you open from a browser. Start a session, and within seconds you have a fully configured workspace. Included synchronized files survive container replacement. Your workspace is excluded from synchronization by default, so an unpushed workspace change is not durable unless you enabled workspace synchronization and a sync completed. Git remains the reliable authority for source code.

## Supported Agents

I work through multiple supported agent runtimes. You choose the runtime for each session's primary terminal tab:

| Agent | Description |
|-------|-------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Anthropic's agentic coding tool running directly in the terminal |
| [Codex](https://github.com/openai/codex) | OpenAI's coding CLI agent |
| [Antigravity](https://antigravity.google) | Google's terminal coding agent |
| [GitHub Copilot](https://docs.github.com/en/copilot) | GitHub's AI coding agent |
| [OpenCode](https://github.com/opencode-ai/opencode) | Open-source multi-model AI coding CLI supporting 75+ model providers |
| Pi | Codeflare's primary Enterprise coding agent with the full capability scope |
| Bash | No AI agent - a plain terminal for the purists |

Pi is the primary agent for Enterprise deployments and receives the full Codeflare capability scope. Other supported runtimes remain selectable when enabled by administrators, with shared policy and portable skills projected where compatible. Commands, tools, and editor integrations follow each runtime's native capabilities.

## What You Get

- **Browser-native terminal with 6 tabs per session.** I work with full root access in a Linux container available from any browser. No local installation required.
- **One isolated container per session.** I work inside that session boundary, with no shared shell state between sessions.
- **Pre-warmed terminals.** I start loading during container startup. By the time you click Open, I am ready - not leaving you at a blank screen wondering if something broke.
- **Persistent R2 storage with bisync every 15 minutes** plus a Sync-now button when you need it sooner and a final sync on stop. Codeflare preserves included files, shell configuration, credentials, vault notes, and uploads across container teardown. Workspace is excluded from sync by default; fresh clones are recommended.
- **Terminal tiling.** I work across two to four side-by-side terminals. Once you tile, you don't go back.
- **Voice input.** I accept voice input through the terminal's mic button and Web Speech API. Brief me without thumb-typing a paragraph on mobile.
- **R2 file browser.** The dashboard lets you browse, upload, download, and manage files without starting a container. Vault, Uploads, and Temporary appear as special folders.
- **Persistent vault (SilverBullet).** I work with an Obsidian-compatible Markdown vault accessible from the header. Codeflare's memory subsystem continuously persists decisions, corrections, observations, debugging discoveries, and source references in the Vault. These captures join the cumulative knowledge graph as permanently queryable content, unless you remove them. I retrieve that history automatically in future sessions and connect it to current requirements, incidents, plans, and code.
- **User management.** Administrators manage email allowlists and admin or user roles. Invite users or revoke them when they get too creative.
- **Setup wizard.** First deployment walks you through DNS, authentication, and storage configuration. It takes a few minutes and happens once.
- **Configurable auto-sleep.** Codeflare applies the configured 15m / 30m / 1h / 2h / 4h timeout. Typing keeps the session alive; background polls do not. Free tier is locked to 15m.
- **Usage dashboard.** The dashboard shows daily and monthly compute hours with quota tracking. Each user's Timekeeper Durable Object flushes to KV every five minutes.
- **Dashboard with live metrics.** The dashboard shows CPU, memory, disk, uptime, synchronization status, and session state: green for active, yellow for idle but alive, and gray for stopped.

## Pro Mode (Advanced Sessions)

Every Enterprise session runs in advanced mode with the full Codeflare capability scope. Pi is the primary Enterprise agent. Other runtimes remain available when enabled by administrators and receive compatible policy, skills, and native workflow surfaces.

- **Spec-driven development (`/sdd`).** I use `/sdd init` to bootstrap a `sdd/` folder with REQ-tracked requirements, `/sdd clean` to maintain it, and the specification to guide implementation.
- **Multi-perspective review (`/review`).** I use `/review` to launch applicable security, architecture, code, refactoring, TDD, and documentation perspectives, cross-reference findings, filter against your ADRs, apply the Reality Filter, and triage interactively with you. I use `--diff` during active work, `--all` for a whole-codebase audit, `--deep` for behavioral SDD verification, and `--verify-high` to send surviving HIGH or CRITICAL findings to configured external models for cross-checks and fix proposals. This on-demand workflow is separate from automatic PR-boundary review and intentionally heavier.
- **Other slash commands.** I use `/debug` for systematic root-cause analysis, `/deploy` to drive a release through CI, and `/brainstorm` for structured ideation.
- **Knowledge graph (Graphify).** I combine supported repository structure with cumulative Vault knowledge and answer structural questions through graph queries instead of grepping blindly. “What calls function X?”, “What depends on Z?”, and “Where did we decide Y?” all get sharper answers.
- **Automatic review agents.** At an eligible protected pull-request boundary, I use the classifier to launch the smallest applicable report-only review set. Reviewers report findings; they do not auto-merge.
- **Curated skill family.** I use preloaded skills for CI monitoring, deploy credentials, documentation and specification enforcement, TDD, SDD, PR workflows, and more.
- **Managed runtime controls.** Codeflare persists session knowledge in the Vault, retrieves it automatically, provides bounded Graphify routing, gates destructive actions, and detects Vault edits without requiring manual activation.

None of this needs per-session configuration. Every Enterprise session already runs in advanced mode with the full Codeflare capability scope.

## Security

- I run inside one session container with no shared shell or cross-session access. I can `rm -rf /`, and the only victim is my container.
- I run with full terminal access inside the isolated container. I can modify that container's filesystem, but I cannot cross its isolation boundary.
- In Enterprise deployments, supported GitHub and provider credentials remain outside the container; Codeflare injects them at Worker-side boundaries. Deployment credentials never enter session containers.
- In Enterprise deployments, session containers receive non-secret placeholders for supported intercepted services. Reusable credentials remain at Worker-side boundaries.
- In Enterprise deployments, Cloudflare Access protects ingress and binds each session to the authenticated user.

## Resource Tiers

| Tier | vCPU | Memory | Disk |
|------|------|--------|------|
| Low | 0.25 vCPU | 1 GiB RAM | 4 GB |
| Default | 1 vCPU | 3 GiB RAM | 6 GB |
| High | 2 vCPU | 6 GiB RAM | 8 GB |

Low tier handles light editing and AI agents fine. Default covers most dev workflows. High is for when your build process has ambitions.

## Cost Estimate

Runs on Cloudflare Containers - usage-based pricing on the Workers Paid plan ($5/month base). Realistic breakdown for default tier (1 vCPU, 3 GiB RAM), 8 hours/day, 20 days/month, 20% average CPU:

**Total active time:** 8h x 20d = 160 hours = 576,000 seconds

| Resource | Usage | Included Free | Overage | Rate | Cost |
|----------|-------|---------------|---------|------|------|
| vCPU | 0.20 x 1 vCPU x 576,000s = 115,200 vCPU-s | 22,500 vCPU-s | 92,700 vCPU-s | $0.000020/vCPU-s | $1.85 |
| Memory | 3 GiB x 576,000s = 1,728,000 GiB-s | 90,000 GiB-s | 1,638,000 GiB-s | $0.0000025/GiB-s | $4.10 |
| Disk | 6 GB x 576,000s = 3,456,000 GB-s | 720,000 GB-s | 2,736,000 GB-s | $0.00000007/GB-s | $0.19 |
| **Workers Paid plan** | | | | | **$5.00** |
| **Total** | | | | | **~$11/month** |

Low tier at the same usage pattern: ~$6.50/month. If you offload builds to GitHub Actions, low tier is more than enough for editing and running agents.

Pricing based on published Cloudflare Containers rates as of early 2026. Check the [Cloudflare Containers pricing page](https://developers.cloudflare.com/containers/pricing/) for current rates.

## Deployment

Fork the repo, set your Cloudflare credentials as GitHub secrets, go to `Actions` > `Deploy` > `Run workflow` > Branch: `main` > **Run workflow**. GitHub Actions builds, tests, and deploys. Takes about 2 minutes.

After deployment, visit your Worker URL and the setup wizard handles:

1. DNS configuration (CNAME for your custom domain)
2. Authentication setup (Cloudflare Access or GitHub OAuth depending on mode)
3. R2 credential derivation (automatic, no manual token creation)

That's it. No Kubernetes. No Terraform. No existential crisis.

## License

PolyForm Noncommercial 1.0.0 - free for personal use, tinkering, and showing off.

Commercial use, resale, or paid hosted offerings require a separate written license. You know who you are.

## Built By

[Nikola Novoselec](https://github.com/nikolanovoselec)
