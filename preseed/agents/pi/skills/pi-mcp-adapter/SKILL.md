---
name: pi-mcp-adapter
description: Reach configured MCP (Model Context Protocol) servers from Pi via a single mcp proxy tool. Use when a task needs a capability exposed by an MCP server (databases, SaaS APIs, chrome-devtools, etc.). Works regardless of whether context-mode is on.
---

# MCP Adapter (Pi)

Bridges external **MCP servers** into Pi through one small **`mcp`** proxy tool (≈200 tokens of context instead of hundreds of raw tools). Servers connect lazily on first use and disconnect after idle. Works independently of context-mode — toggling `/ctx` does not affect it.

## When to use

- The task needs a capability that a configured **MCP server** exposes (a database, a SaaS API, a domain tool, chrome-devtools, GitHub, etc.) and there is no native Pi tool for it.
- You want to discover what an attached MCP server can do — search/list/describe through the `mcp` proxy first, then call the specific tool.

## When NOT to use

- A native Pi tool already covers it (`bash`, `edit`, `read`, `web_search`, the `ctx_*` tools) — prefer the native tool; the proxy is only for capabilities Pi otherwise lacks.
- No MCP servers are configured — the proxy has nothing to reach. MCP servers are declared in the adapter's `mcpServers` config; without that config there is nothing to call.

## Notes

- Specific high-value tools can be promoted from the proxy to first-class Pi tools via `directTools` in the server config, so they appear directly in the tool list.
- The MCP server (not the adapter) validates arguments; a malformed call surfaces the server's own error.
