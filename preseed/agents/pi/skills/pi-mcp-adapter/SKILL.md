---
name: pi-mcp-adapter
description: Use configured MCP servers through the native adapter proxy or discovered deferred tools when no native capability covers the task.
disable-model-invocation: true
---

# MCP adapter (Pi)

`pi-mcp-adapter` is the sole managed MCP connection/tool owner; builtin MCP and the replacement extension stay disabled. Prefer native tools when they cover the task. For managed portals, load [MCP portals](../mcp-portals/SKILL.md): Codeflare Settings owns OAuth, not Pi.

## Discover, connect and call

1. Activate the exact `mcp` tool through `capability`, inspect its live schema, and call `{}` to inspect configured servers and catalogue coverage. Names identify connections, never relevance.
2. Use valid cached catalogues without keeping connections alive. When live access or missing metadata requires an authorized connection, use `{"connect":"<configured server>"}`. Consult requires the explicit-user-request gate in `consult-llm`.
3. Search using `{"search":"<capability words>","limit":12,"offset":0}`; inspect a returned definition using `{"describe":"<exact returned tool name>"}`. Never manufacture prefixes, names or argument schemas.
4. Execute with `{"tool":"<exact returned tool name>","args":{}}`, filling arguments from that live definition. Search-activated direct tools can also be found and activated through `capability`; activation alone does not establish a connection or permission.

Global configuration is `<agent dir>/mcp-adapter.json`; trusted project overrides follow upstream precedence. `/mcp-adapter` manages connections; managed portal authorization still belongs in Codeflare Settings. Do not use Pi's `/mcp-auth` for managed portals or copy credentials between clients.

## Lifetime, timeouts and errors

- Managed lazy connections disconnect after ten idle minutes; checks run every thirty seconds. Active calls and protocol operations prevent idle shutdown. The deadline is a minimum, not an exact disconnect instant. The next call reconnects; cached discovery remains available.
- Managed MCP request timeout is `360000` ms. The adapter resets it on progress; supported elicitation can pause it. It is not a fixed total workflow deadline. Task timeouts apply to individual task requests.
- For browser navigation, supply `120000` ms when the live tool schema supports it. Browser provider retention, MCP idle lifetime, request timeout and website authentication are separate.
- Do not add health pings or auth/retention workarounds. Preserve configured commands, CA, custom overrides, headers and credentials. Never print secrets or credential-bearing URLs.
- An expired MCP session can reconnect, but an uncertain failed write is not safe to repeat. Read back its outcome before considering another mutation.
- Managed `MCP_RECONNECT_REQUIRED` means inspect/reconnect the portal in Settings; switching clients or reconnecting transport does not prove the grant is repaired. Interactive login requires explicit current-user authorization.

## Configuration ownership

Startup selects one managed package and prepares its native configuration. A guarded handoff preserves displaced originals and unrelated servers without importing OAuth stores. Ambiguous selection, unsafe paths, conflicting entries or unsupported literal conversions fail closed with a content-free warning. Do not execute secret expressions or hand-edit settings to bypass that boundary.
