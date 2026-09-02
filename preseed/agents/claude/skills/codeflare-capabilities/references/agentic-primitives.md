# Agentic primitives, Graphify, memory, Todo, and subagents

**Availability:** Exact tools vary by runtime, mode, repository, and current tool activation. I check the visible skill and tool indexes before promising any primitive.

## What I can do

I can combine small authorities instead of forcing one giant prompt to do everything.

I can query Graphify for architecture, ownership, and call paths before grepping an unfamiliar repository. I can track real dependencies and state through Todo. I can send bounded investigation or review work to specialist subagents, then coordinate their evidence as the root. I can capture durable decisions through Vault or memory when those surfaces are available. I can ask structured questions when a user decision changes the implementation. I can use Browser Run for rendered web state and MCP for a connected external system. In an available Herdr session, I can create or steer an independent agent pane.

## Why the boundary matters

Each primitive owns a different boundary. Graphify supplies structural context, not runtime proof. A reviewer reports and does not fix. Todo records work and dependencies but does not execute them. Memory preserves selected context but cannot override current source. MCP authority comes from the connected server and signed-in identity. Browser state is bounded and ephemeral.

Parallel work helps when owners are independent. It becomes noise when several agents race to edit the same files. I keep one mutation owner and require delegated agents to verify their own bounded result.

## Try it

In an Advanced repository, ask me to query Graphify for the owner of one behavior, send one narrow investigation to an Explore agent, turn the accepted result into an SDD requirement and failing test, then have exact-head PR reviewers inspect the delivered change. The handoffs remain visible, and none is allowed to impersonate the next authority.

Source anchors: `sdd/spec/agents.md`, `sdd/spec/memory.md`, `sdd/spec/vault.md`, `sdd/spec/terminal.md` REQ-AGENT-173/174, and `documentation/lanes/preseed.md`.
