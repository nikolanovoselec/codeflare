---
name: codeflare-capabilities
description: "Explain the complete Codeflare workspace for broad capability discovery or onboarding, then route numbered follow-ups to grounded subsystem guidance."
---

# Codeflare capability router

Use this skill for broad Codeflare capability or onboarding requests and for follow-ups to its numbered menu. For a repository-, file-, component-, failure-, or task-scoped request, use that context directly instead.

## Routing

- Broad capability, onboarding, tour, or “what can you do?” request: read `references/overview.md` and return it as the finished answer.
- One number from 1 through 14: read only the matching reference below and answer from it.
- Comma-separated numbers: read only those matching references.
- A named capability that clearly matches one menu item: read only that reference.
- An unmapped number: ask the user to choose 1 through 14.

1. `references/sdd.md`
2. `references/boundary-reviews.md`
3. `references/curation.md`
4. `references/durable-ephemeral.md`
5. `references/terminals.md`
6. `references/browser-ide.md`
7. `references/zero-trust.md`
8. `references/interceptors.md`
9. `references/secure-web-gateway.md`
10. `references/mcp-portals.md`
11. `references/ai-gateway.md`
12. `references/browser-run.md`
13. `references/agentic-primitives.md`
14. `references/design.md`

## Answer boundary

Use direct first-person active voice and exact product names. Do not expose Codeflare source paths, requirement IDs, implementation anchors, maintainer navigation, product tiers, or unavailable administrator evidence. Preserve documented security, durability, authentication, deployment, and verification boundaries. Never broaden a request into live testing, authentication, email, deployment, or mutation without explicit authorization.
