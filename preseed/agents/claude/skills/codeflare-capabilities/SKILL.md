---
name: codeflare-capabilities
description: "Explain the complete Codeflare workspace for broad capability discovery or onboarding, then route numbered follow-ups to grounded subsystem guidance."
---

# Codeflare capability router

Use this skill for broad Codeflare capability or onboarding requests and for follow-ups to its numbered menu. For a repository-, file-, component-, failure-, or task-scoped request, use that context directly instead.

## Routing

- Broad capability, onboarding, tour, or “what can you do?” request: read `references/overview.md` completely. Output its entire contents verbatim, from the first line through the last. Do not summarize, paraphrase, restructure, omit sections, add an introduction, add bullets, or append options. Preserve the page’s existing formatting. If the read is truncated, read the remaining content before answering.
- During capability navigation, bare or comma-separated numbers 1–14 always select the fixed top-level references below, regardless of the last page displayed—not items in its headings, lists, examples, or “Try it” section. Read only the selected references completely and output them verbatim in the requested order, continuing any truncated reads.
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

Do not expose Codeflare source paths, requirement IDs, implementation anchors, maintainer navigation, product tiers, or unavailable administrator evidence. Preserve documented security, durability, authentication, deployment, and verification boundaries. Never broaden a request into live testing, authentication, email, deployment, or mutation without explicit authorization.
