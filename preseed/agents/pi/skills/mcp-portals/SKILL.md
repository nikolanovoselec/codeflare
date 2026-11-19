---
name: mcp-portals
description: "Use named MCP portals or discover remote tools missing from native capabilities."
---

# MCP portals

Codeflare Settings owns portal authentication; the native `pi-mcp-adapter` owns MCP connections, cached catalogues and deferred tools. This applies to default/basic and advanced Pi in every Codeflare deployment mode.

Load this router when the user names a portal or a remote task lacks a suitable native/managed tool. Unless the user requests a portal, keep known working native tools when they cover the task; portals are not a mandatory detour. Before claiming a remote capability is unavailable, follow discovery across the approved portal set and report missing coverage. Discovery does not authorize execution, login or configuration changes.

**Establish catalogue coverage for the entire configured owner-approved portal set before semantic selection.** Use valid cached discovery; connect only when live access or missing metadata requires it. Portal names identify connections, not capabilities. Missing connections mean partial catalogue coverage, never proof that a tool does not exist. `capability` searches registered Pi wrappers, not remote inner methods.

Load only the topic needed next:
- [Connect and bootstrap](../mcp-portal-connect/SKILL.md): Settings, non-secret connection status, reconnect and disconnect.
- [Discover tools](../mcp-portal-discovery/SKILL.md): native connection tools, activation, live JSON schemas, catalogue search and coverage.
- [Execute workflows](../mcp-portal-execution/SKILL.md): actual sanitized method names, sequential dependencies, parallel independent reads, partial failures and uncertain writes.

Never copy credentials, browser cookies or Access JWTs into Pi. Never create a second MCP client or use a shared admin token. Read the live wrapper schema before forming JSON. Portal-issued downstream authorization URLs remain bound to that same portal user/grant; preserve their context and request owner authorization rather than manufacturing a different grant.
