---
type: "query"
date: "2026-07-18T12:19:15.537192+00:00"
question: "Where is Pi context-mode lifecycle ownership implemented and how is it kept separate from other extensions?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["extensions/context-mode-runtime.ts", "manifest.json"]
---

# Q: Where is Pi context-mode lifecycle ownership implemented and how is it kept separate from other extensions?

## Answer

preseed/agents/pi/extensions/context-mode-runtime.ts owns the Pi context-mode lifecycle and is seeded independently through preseed/agents/pi/manifest.json; compact-context capability changes do not move or rewrite that owner.

## Outcome

- Signal: useful

## Source Nodes

- extensions/context-mode-runtime.ts
- manifest.json