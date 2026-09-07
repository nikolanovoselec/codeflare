# Cloudflare MCP Server Portals, Code Mode, and identity

## What I do

I bring information from your connected work systems into the engineering task: read a linked incident, compare its symptoms with the repository, or gather the documentation needed for a fix. You can ask for the result you need without learning each service's tool names.

I connect through Cloudflare MCP Server Portals, which extend Cloudflare Access to MCP clients. Each Portal is a Cloudflare Access application that gathers the MCP servers and tools approved for the signed-in user or agent. For ordinary interactive use, you sign in through managed OAuth with your Cloudflare Access identity. An administrator configures the Portal and its approved upstream servers. Autonomous agents use an authorized Access service token; ordinary users do not need to obtain one to ask me for help.

With Portal Code Mode enabled, I see only `portal_codemode_search` and `portal_codemode_execute`, regardless of how many upstream servers and tools are registered. I search for the definitions needed for the task, then execute and compose only those operations inside an isolated Dynamic Worker. The initial tool surface stays at two tools instead of loading every upstream schema into model context, sharply reducing token consumption as the Portal grows.

I combine the focused result with repository work: inspect an incident, trace its code path, implement the tested correction, and, with your authorization, link the outcome back to its owning system. Searching only for relevant operations leaves more room for the actual incident and code instead of hauling the full integration catalog through every turn.

## Where the boundary sits

Cloudflare Access authorizes entry to the Portal and filters which configured servers a user or service identity may reach. Each upstream server still owns its authorization: it may require the user's separate OAuth grant or use an administrator credential when configured. An Access service token represents a machine, not an end user, and cannot supply per-user OAuth.

Code Mode reduces context, not authority. Generated code reaches external systems only through Portal-provided tools, and every operation remains subject to Portal, upstream, and credential permissions. Consequential writes still require explicit user scope. Protect an upstream server separately if its direct URL must not bypass Portal policy.

## Try it

Ask me:

> Read this incident through my connected work system, compare it with the error path in this repository, and propose a fix plan. Do not update the incident or change code yet.

I discover the relevant approved operations and bring back the evidence the plan needs. If the upstream service needs your own OAuth grant, I explain that connection step rather than asking you to paste a token.

Other useful requests:

- “Find the connected documentation for this API and use it to review our integration.”
- “Compare the linked issue's acceptance criteria with this pull request.”
- “Draft an incident update from our findings. Show it to me before posting.”
