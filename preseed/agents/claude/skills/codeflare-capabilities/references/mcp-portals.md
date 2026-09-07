# Cloudflare MCP Server Portals, Code Mode, and identity

The repository rarely contains the whole problem. Acceptance criteria may live in an issue tracker, an incident in an operational system, and an API contract in connected documentation. Through approved MCP servers, I can bring that material into the same investigation as the code.

You ask for the work you need. I discover the relevant operations, gather their evidence, and connect it to the repository. You do not have to paste every record into chat or learn the tool names of every connected service.

## A governed entrance to the tool catalogue

A configured Cloudflare MCP Server Portal gathers approved MCP servers behind a Cloudflare Access application. For interactive use, you authenticate through the Portal's managed OAuth flow with your Access identity. The administrator owns the Portal configuration and the approved upstream servers.

Access policy determines which configured servers the user or service identity may reach. Each upstream retains its own authorization: it may require your separate OAuth grant or use an administrator-managed credential where configured.

That division lets a catalogue grow without treating admission to it as universal permission. A connected incident system exists because somebody configured and authorized it, not because MCP automatically opens every organizational application.

## Find the operations before loading their machinery

With Portal Code Mode enabled, the initial interface stays at two tools: `portal_codemode_search` and `portal_codemode_execute`.

I search for the definitions relevant to the task, then compose and execute those operations in an isolated Dynamic Worker. Hundreds of unrelated schemas do not need to occupy the conversation before I know which operation matters. More context remains for your code, the incident evidence, and the reasoning needed to connect them.

Composition also changes how I approach a task. I can retrieve a record, use its identifiers to obtain related information, and return the focused result rather than carrying an entire catalogue through a chain of prompts. External calls remain limited to Portal-provided tools and their permissions.

Code Mode reduces tool-schema overhead. It does not expand authority or make generated code trustworthy by default.

## Bring the result back into engineering

I can compare connected acceptance criteria with an implementation, relate an incident to a call path, or use an approved documentation source to assess an integration. The external record and the repository become evidence for one task.

If the work needs a follow-up in the originating system, I can prepare it from the actual findings. Posting a comment, changing a ticket, or performing another consequential write still needs your scope. Reading an incident is not implicit permission to update it.

When an upstream needs your OAuth grant, I explain that connection step. I do not ask you to paste a token or substitute another identity simply because the Portal itself admitted the request.

## Human and machine identities stay distinct

An authorized Access service token can admit an autonomous agent to the Portal. It represents a machine, not an end user, and cannot supply a user's separate OAuth grant. The upstream credential model must support the intended operation.

The Portal also does not automatically protect an upstream server's direct URL. If that URL must not bypass Portal policy, it needs its own protection. I keep that boundary explicit rather than assuming the front door secured every other entrance.

With the connections in place, I can work across approved systems while preserving their separate permissions. You get the relevant context in the engineering conversation without flattening the organization's access model into one shared integration credential.
