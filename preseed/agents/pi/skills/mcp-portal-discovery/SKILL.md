---
name: mcp-portal-discovery
description: Bootstrap all approved portals, activate exact registered Pi wrappers and search live Code Mode catalogues with explicit partial coverage.
disable-model-invocation: true
---

# Discover portal tools

First follow [connect/bootstrap](../mcp-portal-connect/SKILL.md). Never choose a portal by its name. A missing connection means incomplete catalogue coverage.

## Two discovery layers

1. `capability` searches/activates **registered Pi tools**. For each connected portal, find its actual prefixed `portal_codemode_search` and `portal_codemode_execute` wrappers. Prefix sanitization/collision handling is stock-extension-owned; never guess or truncate the registered name.
2. The search wrapper searches the **remote portal catalogue**. Its upstream methods are not separate registered Pi tools, so repeatedly searching `capability` for an inner method will not find one.

Read each activated wrapper's **live JSON input schema first**. If it exposes `code: string`, a JSON call can look like this (adapt the schema, not just the name):

```json
{"code":"async () => { const tools = await codemode.tools(); return tools.filter(t => /issue|repository/i.test(JSON.stringify(t))); }"}
```

`codemode.tools()` is the search sandbox's catalogue API. Use the returned definitions to learn actual sanitized names, arguments and outputs. For an unfamiliar catalogue, inspect a small projection first, then return full definitions only for likely matches. Do not invent a schema from a remembered GitHub SDK method. This is the portal Code Mode contract, not the Agents SDK `createCodeTool` API.

Search independent connected catalogues in parallel where useful, but keep every result labelled with its originating portal ID, exact endpoint/configuration, search/execute wrapper and current schema. A schema from portal A is not executable through portal B. Do not conclude “no tool available” unless every approved portal has been searched successfully; otherwise report precisely the missing coverage.

An unavailable Code Mode wrapper may mean the portal is not configured for Code Mode, not that no upstream tools exist. Administration supports `?codemode=search_and_execute`; changing an endpoint requires a fresh matching grant. Ask the administrator rather than inventing a proxy.

## Authorization context

Definitions can expose writes without granting permission to perform them. The GitHub upstream registration uses the full `https://api.githubcopilot.com/mcp/` endpoint (not `/readonly`) and **Require user auth ON**. The owner's upstream grant and current-user approval still govern writes. Preserve any portal-issued downstream authorization URL and its portal context; never switch to a shared service/admin identity. Real downstream OAuth acceptance remains a hosted check, not a discovery claim.

Next: [execution](../mcp-portal-execution/SKILL.md).
