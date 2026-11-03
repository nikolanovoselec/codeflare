---
name: pi-mcp-adapter
description: Use configured MCP servers through pi-mcp-extension when no native tool covers the required external capability.
disable-model-invocation: true
---

# MCP Servers (Pi)

`pi-mcp-extension` owns configured MCP servers. Prefer native tools when they cover the task. The historical skill path remains stable; there is no `mcp` proxy.

## Discover, connect, activate

1. Discover and activate `mcp_status` through `capability` using its exact name, then inspect configured server names and states. Search/activation alone does not connect a server.
2. When the task authorizes using the server, activate `mcp_connect` and call it with `{ name: "<configured server>" }`. Lazy servers start only on explicit connection. Consult requires the explicit-user-request gate in the `consult-llm` skill.
3. Search registered tools with `capability`, inspect the discovered tool schema, and activate the exact returned name. Names use sanitized `mcp_<server>_<tool>` with collision handling; never guess a qualified name or reuse old proxy arguments.
4. Call the activated direct tool with its actual input schema. A connected server can still have inactive tools because another extension controls exposure; resolve exact-tool activation rather than repeatedly reconnecting.

`mcp_list_resources` and `mcp_read_resource` cover resources. User commands include `/mcp`, `/mcp:start`, `/mcp:stop`, and `/mcp:auth`. Global configuration is `<agent dir>/mcp.json`; trusted projects may override it through `.pi/mcp.json`. Builtin MCP stays disabled so there is one lifecycle owner.

## Lifetime and errors

- Managed MCP requests have a fixed 360000 ms per-call budget. Progress does not extend it. Navigation uses an explicit 120000 ms timeout when supported by the live schema.
- Lazy connections persist until stop, shutdown, or failure; this extension has no idle disconnect. Browser Run's configured `keep_alive=360000` independently governs remote browser inactivity, not website authentication.
- The extension reconnects failed transports for future calls. An uncertain failed tool call is not automatically safe to repeat: verify its outcome before any retry, especially mutations. Never replay a mutating operation merely because reconnection succeeded.
- Do not add health pings or retention/auth workarounds. Preserve configured command, CA, credentials and retention. Never print configuration secrets, headers, cookies or credential-bearing URLs.
- Connection/auth errors do not authorize login. Interactive owner authentication requires explicit current-user authorization for that site and flow.

## Configuration handoff boundary

Only selected legacy stdio environment literals are translated: an old `!!` prefix loses exactly one `!`. New `mcp.json` literals are never decoded. Selected legacy command-backed values or old environment interpolation require explicit conversion; preparation fails closed without evaluating them or partially writing configuration. Do not execute a secret resolver, print the expression, or copy old expression text into the new literal schema as a workaround. A valid new destination takes precedence over unsupported expressions in the displaced adapter file.
