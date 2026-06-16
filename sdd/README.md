# Codeflare Specification

Codeflare is the enterprise agentic engine: it runs autonomous AI coding agents in isolated containers on Cloudflare's edge. Each session spins up a dedicated container pre-loaded with the user's choice of agent (Claude Code, Codex, Antigravity, GitHub Copilot, OpenCode, Pi, or Bash), provides a browser-native terminal accessible from any device, and tears itself down when idle. Files persist in per-user R2 storage via bidirectional sync; containers do not. The product targets teams who want zero-setup AI coding from any screen -- phone, tablet, or laptop -- without touching their local machine.

## Principles

1. **Isolation per session** -- Every session runs in its own container. No shared shells, no cross-session access. An agent can `rm -rf /` and the only victim is itself.

2. **Files persist, containers don't** -- R2 storage survives container teardown. Containers are ephemeral and disposable. Bisync runs every 15 minutes with a manual Sync-now trigger and a final sync on stop, so work is never lost even if a session dies before `git push`.

3. **Zero setup** -- Four steps from fork to live deployment (fork, set two secrets, deploy, run wizard). No Kubernetes, no Terraform, no local installs. Users connect GitHub and Cloudflare once; every subsequent session is pre-authenticated.

4. **Mobile-first** -- Strongly optimized for phone and tablet use. Touch input, virtual keyboard handling, swipe gestures for arrow key navigation, scroll stability fixes for Samsung/Android quirks. The best commits happen from places without desks.

5. **Scale to zero** -- Containers hibernate after configurable idle timeout (5m-2h, input-aware). No sessions means no bill. Cost scales linearly with actual compute usage, not provisioned capacity.

6. **Agent-agnostic, Claude-optimized** -- Multiple agents supported with identical container infrastructure. Pro mode features (knowledge graph memory, curated skills, advanced workflows) are designed for Claude Code; other agents receive rules and definitions but may not support all capabilities.

7. **Stateless dashboard, stateful containers** -- Dashboard status endpoints are pure KV reads with zero Durable Object contact, preserving container hibernation. The DO owns session lifecycle; the Worker owns routing and auth; KV owns state visibility.

## Actors

| Actor | Description |
|-------|-------------|
| User | A developer using Codeflare to run AI coding agents in browser-based sessions |
| Admin | An operator who deployed Codeflare and manages users, tiers, and configuration |

## Domains

| Domain | Description | Priority | Status |
|--------|-------------|----------|--------|
| [Session Lifecycle](spec/session-lifecycle.md) | Container creation, idle detection, auto-sleep, restart | P0 | Active |
| [Authentication](spec/authentication.md) | Dual auth (CF Access + GitHub OIDC), user provisioning | P0 | Active |
| [Terminal](spec/terminal.md) | PTY, WebSocket, multi-tab, tiling, keyboard | P0 | Active |
| [Mobile](spec/mobile.md) | Touch input, virtual keyboard, scroll stability | P2 | Active |
| [Storage](spec/storage.md) | R2 persistence, rclone bisync, quotas | P0 | Active |
| [Subscription](spec/subscription.md) | Tiers, billing, usage tracking, quotas | P1 | Active |
| [Agents](spec/agents.md) | Multi-agent support, preseed, session modes | P1 | Active |
| [GitHub](spec/github.md) | Connect GitHub, repo panel, clone-into-session, enterprise egress-injected git auth | P1 | Active |
| [Enterprise Mode](spec/enterprise-mode.md) | Deploy-time enterprise instance, subscription bypass, Worker-side LLM proxy | P1 | Active |
| [Browser Run](spec/browser-run.md) | Real-browser WebFetch fallback via Cloudflare Browser Run | P2 | Active |
| [Setup](spec/setup.md) | Onboarding wizard, deployment modes, DNS | P1 | Active |
| [Landing](spec/landing.md) | Public enterprise landing page, mode-aware serving, contact pipeline | P1 | Active |
| [Security](spec/security.md) | Auth enforcement, encryption, rate limiting, headers | P0 | Active |
| [Operations](spec/operations.md) | CI/CD, testing, deployment, cost | P1 | Active |
| [Memory](spec/memory.md) | Vault-based cross-session memory, automatic capture, hook delivery | P2 | Active |
| [Vault](spec/vault.md) | Persistent obsidian-style notes, unified graphify graph, SilverBullet editor | P2 | Active |

## Support files

The `sdd/spec/` directory also holds these non-domain files (no `REQ-*` of their own):

| File | Purpose |
|------|---------|
| [constraints.md](spec/constraints.md) | Global `CON-*` constraints referenced by REQ Dependencies |
| [glossary.md](spec/glossary.md) | Canonical terminology |
| [changes.md](spec/changes.md) | Product changelog (user-facing spec changes) |
| [pending.md](spec/pending.md) | TODOs / known gaps not yet ready to be REQs |
| [config.yml](spec/config.yml) | SDD autonomy mode and enforcement config |
| `.review-queue.md` | Live PR-boundary review queue (open findings only) |
| `.review-decisions.md` | Log of resolved review decisions |

## Out of Scope

- **Server-side rendering** -- The frontend is a SolidJS SPA served as static assets. No SSR, no hydration complexity.
- **Multi-user collaboration** -- Each session is single-user. No shared terminals, no real-time collaboration, no pair programming within a session.
- **Local execution** -- Codeflare does not run on the user's machine. No desktop app, no Electron wrapper, no local Docker mode.
- **Custom container images** -- All sessions use the same Dockerfile. Users cannot bring their own base image or install system packages that persist across sessions (though they can install packages within a session).
- **Database hosting** -- No managed PostgreSQL, MySQL, or MongoDB. KV and D1 are available via Cloudflare integration, but Codeflare itself uses KV only.
- **Long-running services** -- Containers are for interactive coding sessions, not for hosting web servers or background workers. They hibernate on idle and stop on inactivity.
- **Node.js APIs in the Worker** -- The Worker runs on Cloudflare's web-standard runtime. No `fs`, `child_process`, `net`, or other Node.js-specific APIs (except via `nodejs_compat` flag for specific modules).

## How This Spec Works

1. New requirements are added to the relevant domain file
2. Each requirement has an ID, intent, acceptance criteria, and constraints
3. Implementation is planned from the spec via Plan Mode
4. After implementation, documentation is updated
5. Tests verify acceptance criteria
