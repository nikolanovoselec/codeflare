# Codeflare Specification

Codeflare is the agentic engineering engine: it runs autonomous AI coding agents in isolated containers on Cloudflare's edge. Each session spins up a dedicated container pre-loaded with the user's choice of agent (Claude Code, Codex, Antigravity, GitHub Copilot, OpenCode, Pi, or Bash), provides a browser-native terminal accessible from any device, and tears itself down when idle. Files persist in per-user R2 storage via bidirectional sync; containers do not. The product targets teams who want zero-setup AI coding from any screen -- phone, tablet, or laptop -- without touching their local machine.

## Principles

1. **Isolation per session** -- Every session runs in its own container. No shared shells, no cross-session access. An agent can `rm -rf /` and the only victim is itself.

2. **Files persist, containers don't** -- Selected files persist in R2; containers and local disk are ephemeral. Lifecycle sync, the manual Sync-now trigger, and a bounded final drain reduce loss, but sync is periodic rather than transactional and abrupt failure can lose changes not yet persisted. Git remains the preferred source-code authority.

3. **Zero setup** -- Four steps from fork to live deployment (fork, set two secrets, deploy, run wizard). No Kubernetes, no Terraform, no local installs. Users connect GitHub and Cloudflare once; every subsequent session is pre-authenticated.

4. **Mobile-first** -- Strongly optimized for phone and tablet use. Touch input, virtual keyboard handling, swipe gestures for arrow key navigation, scroll stability fixes for Samsung/Android quirks. The best commits happen from places without desks.

5. **Scale Container metering down** -- Containers stop after a configurable idle timeout (15m-4h, input-aware). Once Codeflare's stop completes and the Container sleeps, Container vCPU, provisioned-memory, and local-disk metering ends; ephemeral local disk returns fresh. Other Cloudflare platform usage can still incur charges.

6. **Agent-aware parity** -- Multiple agents share the container infrastructure, while manifests and runtime adapters deliver only capabilities each agent supports. Claude and Pi carry the richest advanced workflow surfaces; other agents intentionally differ where commands, skills, tools, or transport are unavailable.

7. **Durable authority without dashboard wakeups** -- Owner-scoped dashboard status reads use the complete D1 session catalog without waking containers or contacting their Durable Objects. The session runtime drives generation-fenced transitions and observations; D1 owns persisted lifecycle truth. Worker routing and authentication remain separate, and unrelated KV preferences or credentials do not become session authority.

8. **Stable behavioral domains** -- The seventeen domains below are canonical. Extend the owning requirement instead of creating a specification for a repair, transport adapter, deployment mode or implementation phase. Requirement IDs retain their original namespaces when relocated; acceptance criteria, constraints, statuses, fragment aliases and evidence anchors remain attached to their obligations.

## Actors

| Actor | Description |
|-------|-------------|
| User | A developer using Codeflare to run AI coding agents in browser-based sessions |
| Admin | An operator who deployed Codeflare and manages users, tiers, and configuration |

## Public/private ownership

This specification remains authoritative for observable product behavior, security boundaries, and implementation contracts. Exact deployment values, credential placement, provider registration, customer preparation, migrations, verification, and rollback are private operator concerns. Follow the owning runbook instead of copying those values into a public requirement.

| Operator concern | Private owner |
|------------------|---------------|
| Fork-to-deploy prerequisites by mode | [Deployment quick starts](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/quickstarts.md) |
| Deployment modes and GitHub Environments | [Modes and environments](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/modes-and-environments.md) |
| Shared secrets, optional variables, and Web Push identity | [Shared settings](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/reference/core-settings.md) |
| Enterprise rollout, promotion, and rollback | [Enterprise deployment](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/enterprise.md) |
| GitHub and user OAuth provider registration | [GitHub provider](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/integrations/github-provider.md) and [user OAuth](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/integrations/user-oauth.md) |
| Managed Environment rollout and recovery | [Managed Environment](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/operations/managed-environment.md) |
| Strict egress or Governed Mode migration | [Strict Gateway Egress](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/operations/strict-gateway-egress.md) and [Governed Mode migration](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/operations/governed-mode-migration.md) |
| Deployment acceptance evidence | [Deployment testing](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/verification/deployment-testing.md) |

When a public behavior change affects one of these operator contracts, update both repositories in the same work. Keep the public REQ and its anchors here; keep operational values and procedures in the linked private owner.

## Domains

| Domain | Description | Priority | Status |
|--------|-------------|----------|--------|
| [Session Lifecycle](spec/session-lifecycle.md) | Complete D1 authority, runtime generations, startup, idle policy, recovery and teardown | P0 | Active |
| [Authentication](spec/authentication.md) | Verified identity, authentication, authorization, provisioning and account admission | P0 | Active |
| [Terminal](spec/terminal.md) | PTY/WebSocket, classic/Herdr ownership, MultiView, notifications and mobile compatibility | P0 | Active |
| [Storage](spec/storage.md) | R2 persistence, reconciliation, managed paths, conflicts and encryption-regime integration | P0 | Active |
| [Subscription](spec/subscription.md) | Entitlement, payment, live quota accounting, historical usage and reporting | P1 | Active |
| [Agents](spec/agents.md) | Agent selection, manifests, compiler projection, runtime adaptation and managed delivery | P1 | Active |
| [GitHub](spec/github.md) | Account connection, repositories, cloning/restoration and mediated credentials | P1 | Active |
| [Models & Routing](spec/models-and-routing.md) | Target identity, discovery, evidence, reasoning, transport, replay, caching and publication | P1 | Active |
| [Operators](spec/operators.md) | Packages, catalog/installations, grants, activities, parent capabilities and publication fencing | P0 | Active |
| [Browser Run](spec/browser-run.md) | Agent-facing remote browser reads and interactive capabilities, separate from Browser IDE | P2 | Active |
| [Setup & Administration](spec/setup.md) | Bootstrap, deployment-mode configuration, administrative drafts, checks and application | P1 | Active |
| [Landing](spec/landing.md) | Public website, mode-aware serving, contact pipeline and landing-owned presentation | P1 | Active |
| [Security](spec/security.md) | Trust boundaries, credential isolation, cryptography, limiting and browser controls | P0 | Active |
| [Operations](spec/operations.md) | Delivery, artifact integrity, automated verification and promotion gates | P1 | Active |
| [Memory](spec/memory.md) | Conversation capture, retrieval, preservation and cross-session context | P2 | Active |
| [Vault](spec/vault.md) | Notes/editor, ingestion, extraction transactions and knowledge-graph publication | P2 | Active |
| [Browser IDE](spec/browser-ide.md) | Session-isolated editor, agent/edit transactions, extension continuity and workspace ownership | P2 | Active |

The Operators domain also owns its normative registry/package/capability contract appendix. Concrete wire schemas remain contracts; they are not a separate implementation-phase domain. Enterprise-only conditions remain explicit in their owning requirements rather than forming a catchall specification.

## Support files

The `sdd/spec/` directory also holds these non-domain files (no `REQ-*` of their own). Configuration and review-ledger paths are tooling contracts; historical changelogs are not additional requirement domains:

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
- **Database hosting** -- No managed PostgreSQL, MySQL, or MongoDB. Codeflare uses KV, R2, Durable Object storage, and one D1 database for its own control, persistence, live accounting, historical usage, and report delivery state; user projects may provision other Cloudflare storage independently.
- **Long-running services** -- Containers are for interactive coding sessions, not for hosting web servers or background workers. They stop and go to sleep on inactivity; persistent files come back from R2 rather than local-disk hibernation.
- **Node.js APIs in the Worker** -- The Worker runs on Cloudflare's web-standard runtime. No `fs`, `child_process`, `net`, or other Node.js-specific APIs (except via `nodejs_compat` flag for specific modules).

## How This Spec Works

1. Add or amend behavior in the owning domain requirement; preserve stable REQ fragments.
2. State observable acceptance criteria and constraints before implementation.
3. Write a behavioral test that fails when the required implementation is absent or broken.
4. Keep changed `@impl` and `@test` anchors adjacent to the acceptance criteria they support.
5. Update owned documentation and `spec/changes.md` with the behavior change.
6. Do not mark a touched requirement Implemented while any changed acceptance criterion is partial or unsupported.
