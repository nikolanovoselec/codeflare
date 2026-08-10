---
type: "architecture"
date: "2026-08-10T23:54:46.663266+00:00"
question: "How did the Claude memory-capture PreToolUse hook historically avoid blocking its own extraction child?"
contributor: "graphify"
outcome: "corrected"
source_nodes: ["memory-capture-block.sh", "REQ-MEM-012"]
---

# Q: How did the Claude memory-capture PreToolUse hook historically avoid blocking its own extraction child?

## Answer

The known-working c290a1f4 implementation created a session-local 600-second in-flight sentinel synchronously when Task or Agent launched subagent_type=memory-capture. While .vars and the sentinel coexisted, all parent and child tool calls passed, so the child first Read required no agent_id, agent_type, tool_use_id, or PostToolUse response metadata. Carrier removal cleaned the sentinel on the next hook call; stale sentinels expired and hard blocking resumed. August correlation-handshake commits replaced this and introduced the self-deadlock.

## Outcome

- Signal: corrected

## Source Nodes

- memory-capture-block.sh
- REQ-MEM-012