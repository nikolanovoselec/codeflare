# MCP tools and portal boundary

**Availability:** A configured MCP server is available only when it appears in the current tool index and its authentication succeeds. Codeflare's broader MCP portal presentation is **not established** as a runtime contract by the active repository.

## What I can do now

I can inspect the current MCP or tool index, connect to a configured server through the available gateway, describe its tools, and make a bounded call under that server's actual identity and permissions. I start read-only where possible. Before a write, I show the exact target and payload because “the MCP can do it” is not an authorization model.

A useful proof is concrete: fetch one assigned issue, document, or record and confirm which server and signed-in identity handled the call. That proves the visible integration. It does not prove an unseen shared portal, group policy, code-mode sandbox, or universal audit path.

## What is not established

The product presentation describes an MCP portal that could put many tool servers behind one endpoint, apply user and group policy, attribute calls, and reduce a large surface to one code-mode entry point. The active Codeflare repository contains that presentation and an administrative `mcp-portals.write` OAuth scope, but no owning SDD runtime requirement or operator procedure proves that such a portal is deployed.

If you ask me to administer one, I will use the customer's approved portal documentation and live configuration. If neither exists, I will report that boundary instead of improvising a deployment procedure.

## Try it

Ask me to list currently configured MCP servers. Choose one visible server and request one read-only operation. Then inspect returned identity and provenance before allowing a mutation.

Source anchors: `landing/src/content/site.ts`, `landing/src/pages/index.astro`, `src/lib/oauth-scopes.ts`, and the MCP portal scope table in `documentation/lanes/configuration.md`.
