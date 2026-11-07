---
name: mcp-portal-discovery
description: Discover approved portal catalogues through the native MCP adapter and search live Code Mode definitions with explicit partial coverage.
disable-model-invocation: true
---

# Discover portal tools

First follow [connect/bootstrap](../mcp-portal-connect/SKILL.md). Never choose a portal by its name. A missing connection means incomplete catalogue coverage.

## Two discovery layers

1. Native `mcp` searches its cached registered-server catalogues. Use its live `search` schema to find the actual originating portal's Code Mode search/execute tools, then `describe` the exact returned name. Search-activated deferred tools may also be discovered and activated through `capability`. Names and collision handling belong to the adapter; never guess or truncate them.
2. The portal search tool searches the **remote inner catalogue**. Its upstream methods are not separate Pi tools; repeatedly searching `capability` for an inner method cannot discover them.

To call a discovered wrapper through the proxy, use `{"tool":"<exact returned search tool>","args":{}}` with schema-valid arguments. A direct activated wrapper receives only its own arguments, not this proxy envelope.

Read each discovered wrapper's **live JSON input schema first**. If it exposes `code: string`, a JSON call can look like this (adapt the schema, not just the name):

```json
{"code":"async () => { const tools = await codemode.tools(); return tools.filter(t => /issue|repository/i.test(JSON.stringify(t))); }"}
```

`codemode.tools()` is the search sandbox's catalogue API. Use the returned definitions to learn actual sanitized names, arguments and outputs. For an unfamiliar catalogue, inspect a small projection first, then return full definitions only for likely matches. Do not invent a schema from a remembered GitHub SDK method. This is the portal Code Mode contract, not the Agents SDK `createCodeTool` API.

Search independent connected catalogues in parallel where useful, but keep every result labelled with its originating portal ID, exact endpoint/configuration, search/execute wrapper and current schema. A schema from portal A is not executable through portal B. Do not conclude “no tool available” unless every approved portal has been searched successfully; otherwise report precisely the missing coverage.

An unavailable Code Mode wrapper may mean the portal is not configured for Code Mode, not that no upstream tools exist. Administration supports `?codemode=search_and_execute`; changing an endpoint requires a fresh matching grant. Ask the administrator rather than inventing a proxy.

## Authorization context

Definitions can expose writes without granting permission to perform them. The GitHub upstream registration uses the full `https://api.githubcopilot.com/mcp/` endpoint (not `/readonly`) and **Require user auth ON**. The owner's upstream grant and current-user approval still govern writes. Preserve any portal-issued downstream authorization URL and its portal context; never switch to a shared service/admin identity. Real downstream OAuth acceptance remains a hosted check, not a discovery claim.

Next: [execution](../mcp-portal-execution/SKILL.md).
