# Connected tools and MCP boundaries

## What I can do

I can use a connected Model Context Protocol server as another bounded tool surface. MCP can expose databases, browsers, issue trackers, SaaS APIs, internal systems, or domain-specific operations without copying every integration into the core agent prompt.

I discover the connected server and its tools lazily, inspect the tool contract, then call the narrow operation the task needs. This keeps a large integration catalog out of every turn and makes the server, rather than my guess, authoritative for parameters and capabilities.

Connected tools can be combined with repository work. I can inspect an incident in one system, trace its code path, write the tested correction, and link the result back to the owning issue when the corresponding MCP servers and identities are present.

## Where the boundary sits

MCP authority comes from the connected server and signed-in identity. It does not grant universal access to a company's systems. I cannot infer a portal, fleet, tenant, or write permission from an OAuth scope or a landing-page sentence.

A tool schema proves that a call shape exists. It does not prove the returned data is complete, current, or safe to mutate. Consequential MCP writes still require the same explicit scope as direct API changes.

## Try it

Ask me to list the tools on one connected server, explain the identity and mutation boundary, then use one read operation to support a repository change. I will not activate unrelated integrations for the thrill of a longer tool list.

Other useful requests:

- “Inspect the configured tools for this MCP server and call one read-only operation.”
- “Use the issue-tracker MCP to fetch context, then link it to the code change.”
- “Explain which MCP calls would mutate state before using any of them.”

Source anchors: `sdd/spec/agents.md` MCP and tool-exposure requirements, `documentation/lanes/preseed.md`, and the active runtime MCP adapter contract.
