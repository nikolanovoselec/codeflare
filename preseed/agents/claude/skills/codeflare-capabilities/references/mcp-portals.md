# Cloudflare MCP Server Portals, Code Mode, and identity

## What I can do

I connect through Cloudflare MCP Server Portals, which extend Cloudflare Access to MCP clients. Each Portal is a Cloudflare Access application that gathers the MCP servers and tools approved for the signed-in user or agent. Interactive clients authenticate through managed OAuth with the user's Cloudflare Access identity; autonomous agents can use an authorized Access service token.

With the Portal's Code Mode `search_and_execute` interface, I see only `portal_codemode_search` and `portal_codemode_execute`, regardless of how many upstream servers and tools are registered. I search for the definitions needed for the task, then execute and compose only those operations inside an isolated Dynamic Worker. The initial tool surface stays at two tools instead of loading every upstream schema into model context, sharply reducing token consumption as the Portal grows.

I can combine the focused result with repository work: inspect an incident, trace its code path, implement the tested correction, and link the outcome back to its owning system without hauling the full integration catalog through every turn.

## Where the boundary sits

Cloudflare Access authorizes entry to the Portal and filters which configured servers a user or service identity may reach. Each upstream server still owns its authorization: it may require the user's separate OAuth grant or use an administrator credential when configured. An Access service token represents a machine, not an end user, and cannot supply per-user OAuth.

Code Mode reduces context, not authority. Generated code reaches external systems only through Portal-provided tools, and every operation remains subject to Portal, upstream, and credential permissions. Consequential writes still require explicit user scope. Protect an upstream server separately if its direct URL must not bypass Portal policy.

## Try it

Paste this request:

> Through my connected Cloudflare MCP Server Portal, use Code Mode search to find the smallest read-only tool relevant to this repository. State the Portal identity boundary and the upstream credential mode supported by available evidence without guessing, then execute only that tool and return the evidence useful to my current task.
