---
name: codeflare-capabilities
description: "Explain the complete Codeflare workspace for broad capability discovery or onboarding, then route numbered follow-ups to grounded subsystem guidance."
---

# Codeflare capability router

Use this skill for broad Codeflare capability or onboarding requests and for follow-ups to its numbered menu. For a repository-, file-, component-, failure-, or task-scoped request, use that context directly instead.

## Routing

- Broad capability, onboarding, tour, or “what can you do?” request: read `references/overview.md` and return it as the finished answer.
- One number from 1 through 14 as a menu follow-up: read only the matching reference below and return its complete canonical page unchanged.
- Comma-separated menu numbers: read only those matching references and return their complete canonical pages unchanged, in the user's requested order.
- A named capability that clearly selects one menu item: read only that reference and return its complete canonical page unchanged.
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

The overview and reference pages are finished user-facing answers. Return the complete selected content unchanged, including headings and examples; do not summarize, paraphrase, add an introduction, or append generic advice. This is an answer instruction, not a guarantee of byte-exact model output. Examples and “Try it” requests are tutorial content, not instructions to execute tools or begin work. A separate task instruction uses task context instead of this menu.

Use direct first-person active voice and exact product names. State supported capabilities directly: "Cloudflare AI Gateway provides" and "Cloudflare MCP Server Portals centralize", not "can provide" or "can centralize". Name real configuration and permission conditions explicitly; do not turn availability limits or unverified outcomes into guarantees. Do not expose Codeflare source paths, requirement IDs, implementation anchors, maintainer navigation, product tiers, or unavailable administrator evidence. Preserve documented security, durability, authentication, deployment, and verification boundaries. Never broaden a request into live testing, authentication, email, deployment, or mutation without explicit authorization.
