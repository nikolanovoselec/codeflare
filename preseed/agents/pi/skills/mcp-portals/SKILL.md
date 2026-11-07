---
name: mcp-portals
description: Discover and use configured MCP portal tools through Code Mode; connect portals, search their live catalogues, and execute JavaScript tool workflows.
---

# MCP portals

Codeflare Settings owns portal authentication; the native `pi-mcp-adapter` owns MCP connections, cached catalogues and deferred tools. This applies to default/basic and advanced Pi in every Codeflare deployment mode.

**Establish catalogue coverage for the entire configured owner-approved portal set before semantic selection.** Use valid cached discovery; connect only when live access or missing metadata requires it. Portal names identify connections, not capabilities. Missing connections mean partial catalogue coverage, never proof that a tool does not exist. `capability` searches registered Pi wrappers, not remote inner methods.

Load only the topic needed next:
- [Connect and bootstrap](../mcp-portal-connect/SKILL.md): Settings, non-secret connection status, reconnect and disconnect.
- [Discover tools](../mcp-portal-discovery/SKILL.md): native connection tools, activation, live JSON schemas, catalogue search and coverage.
- [Execute workflows](../mcp-portal-execution/SKILL.md): actual sanitized method names, sequential dependencies, parallel independent reads, partial failures and uncertain writes.

Never copy credentials, browser cookies or Access JWTs into Pi. Never create a second MCP client or use a shared admin token. Read the live wrapper schema before forming JSON. Portal-issued downstream authorization URLs remain bound to that same portal user/grant; preserve their context and request owner authorization rather than manufacturing a different grant.
