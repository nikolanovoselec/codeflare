# MCP portals

Codeflare's product model describes MCP portals as a governed bridge between an agent and customer-connected tool servers. The intended shape puts many MCP servers behind one portal, applies signed-in-user and group policy, attributes calls, and may reduce a large tool surface to one code-mode entry point.

The active repository does not yet establish that description as a runtime implementation contract. It contains the product presentation and an administrative `mcp-portals.write` OAuth scope, but no SDD requirement or operator flow that proves a portal is deployed. Do not present MCP portals as available from those two facts.

What a user can try today is capability discovery. Inspect the current tool or MCP index. If a configured MCP server appears, make a read-only call such as fetching one assigned issue and confirm which identity and server handled it. That proves the visible integration, not an unseen portal. Move to a write only after reviewing the exact target and payload.

If the user asks how to deploy or administer an MCP portal, say that the current Codeflare repository does not contain a verified procedure. Use the customer's approved portal documentation and live configuration as authority, or report that the capability is not configured here.

Source anchors: `landing/src/content/site.ts` MCP product description, `landing/src/pages/index.astro`, `src/lib/oauth-scopes.ts`, and `documentation/lanes/configuration.md` MCP portal scope table.
