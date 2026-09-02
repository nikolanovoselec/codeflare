# Agentic primitives

Codeflare gives an agent more than a shell. The exact set depends on runtime and mode, but the platform can combine specialist subagents, repository knowledge graphs, durable Vault memory, structured user questions, task tracking, MCP tools, browser research, CI monitors, adversarial evaluation, and Herdr-controlled agent panes.

Use each primitive for the boundary it owns:

- Ask a specialist subagent to investigate or review independently, then let the root coordinate the result.
- Query Graphify for architecture and call paths before grepping a large unfamiliar repository.
- Use Todo for multi-step work with real dependencies, not as ceremonial narration.
- Capture durable decisions in Vault when they must outlive the container.
- Use Browser Run for rendered web state and MCP for a connected external system.
- In a Herdr session, create or steer another agent pane when independent work can genuinely proceed in parallel.

Try this sequence in an Advanced repository: ask Graphify where a behavior is owned, send one bounded investigation to an Explore agent, turn the accepted result into an SDD requirement and failing test, then have the PR boundary reviewers inspect the delivered head. Every handoff has a different authority. Flattening all of it into one giant agent prompt defeats the point.

Do not promise a primitive merely because Codeflare supports it somewhere. Check the current skill index, tool list, terminal mode, and configured MCP servers first.

Source anchors: `sdd/spec/agents.md`, `sdd/spec/memory.md`, `sdd/spec/vault.md`, `sdd/spec/terminal.md` REQ-AGENT-173/174, and `documentation/lanes/preseed.md`.
