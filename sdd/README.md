# Codeflare Specification

Codeflare is the agentic engineering engine: it runs autonomous AI coding agents in isolated containers on Cloudflare's edge. Each session spins up a dedicated container pre-loaded with the user's choice of agent (Claude Code, Codex, Antigravity, GitHub Copilot, OpenCode, Pi, or Bash), provides a browser-native terminal accessible from any device, and tears itself down when idle. Files persist in per-user R2 storage via bidirectional sync; containers do not. The product targets teams who want zero-setup AI coding from any screen -- phone, tablet, or laptop -- without touching their local machine.

## Principles

1. **Isolation per session** -- Every session runs in its own container. No shared shells, no cross-session access. An agent can `rm -rf /` and the only victim is itself.

2. **Files persist, containers don't** -- Selected files persist in R2; containers and local disk are ephemeral. Lifecycle sync, the manual Sync-now trigger, and a bounded final drain reduce loss, but sync is periodic rather than transactional and abrupt failure can lose changes not yet persisted. Git remains the preferred source-code authority.

3. **Zero setup** -- Four steps from fork to live deployment (fork, set two secrets, deploy, run wizard). No Kubernetes, no Terraform, no local installs. Users connect GitHub and Cloudflare once; every subsequent session is pre-authenticated.

4. **Mobile-first** -- Strongly optimized for phone and tablet use. Touch input, virtual keyboard handling, swipe gestures for arrow key navigation, scroll stability fixes for Samsung/Android quirks. The best commits happen from places without desks.

5. **Scale Container metering down** -- Containers stop after a configurable idle timeout (15m-4h, input-aware). Once Codeflare's stop completes and the Container sleeps, Container vCPU, provisioned-memory, and local-disk metering ends; ephemeral local disk returns fresh. Other Cloudflare platform usage can still incur charges.

6. **Agent-aware parity** -- Multiple agents share the container infrastructure, while manifests and runtime adapters deliver only capabilities each agent supports. Claude and Pi carry the richest advanced workflow surfaces; other agents intentionally differ where commands, skills, tools, or transport are unavailable.

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
| [Terminal](spec/terminal.md) | PTY, WebSocket, classic/Herdr ownership, MultiView, keyboard | P0 | Active |
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
| [Browser IDE](spec/browser-ide.md) | Per-session code-server editor, session-isolated, Worker-proxied | P2 | Active |

## Support files

The `sdd/spec/` directory also holds these non-domain files (no `REQ-*` of their own):

| File | Purpose |
|------|---------|
| [constraints.md](spec/constraints.md) | Global `CON-*` constraints referenced by REQ Dependencies |
| [glossary.md](spec/glossary.md) | Canonical terminology |
| [changes.md](spec/changes.md) | Current product changelog (user-facing spec changes) |
| [changes-archive-2026-07.md](spec/changes-archive-2026-07.md) | Archived product changelog through 2026-07-17 |
| [changes-archive-2026-08.md](spec/changes-archive-2026-08.md) | Safety backup before the 2026-08 SDD cleanup |
| [config.yml](spec/config.yml) | SDD autonomy mode and enforcement config |
| `.review-queue.md` | Live PR-boundary review queue (open findings only) |

One support file lives at the `sdd/` root (the path is the `/review` skill's triage-history contract):

| File | Purpose |
|------|---------|
| [.review-decisions.md](.review-decisions.md) | Disposition ledger for reviewed-and-kept findings (audit trail) |

## Out of Scope

- **Server-side rendering** -- The frontend is a SolidJS SPA served as static assets. No SSR, no hydration complexity.
- **Multi-user collaboration** -- Each session is single-user. No shared terminals, no real-time collaboration, no pair programming within a session.
- **Local execution** -- Codeflare does not run on the user's machine. No desktop app, no Electron wrapper, no local Docker mode.
- **Custom container images** -- All sessions use the same Dockerfile. Users cannot bring their own base image or install system packages that persist across sessions (though they can install packages within a session).
- **Database hosting** -- No managed PostgreSQL, MySQL, or MongoDB. Codeflare uses KV, R2, and Durable Object storage for its own control, persistence, and accounting state; user projects may provision other Cloudflare storage independently.
- **Long-running services** -- Containers are for interactive coding sessions, not for hosting web servers or background workers. They stop and go to sleep on inactivity; persistent files come back from R2 rather than local-disk hibernation.
- **Node.js APIs in the Worker** -- The Worker runs on Cloudflare's web-standard runtime. No `fs`, `child_process`, `net`, or other Node.js-specific APIs (except via `nodejs_compat` flag for specific modules).

## How This Spec Works

1. Add or amend behavior in the owning domain requirement; preserve stable REQ fragments.
2. State observable acceptance criteria and constraints before implementation.
3. Write a behavioral test that fails when the required implementation is absent or broken.
4. Keep changed `@impl` and `@test` anchors adjacent to the acceptance criteria they support.
5. Update owned documentation and `spec/changes.md` with the behavior change.
6. Do not mark a touched requirement Implemented while any changed acceptance criterion is partial or unsupported.
