---
type: "query"
date: "2026-08-23T13:36:39.775640+00:00"
question: "How are Claude manifest paths transformed into target runtimes, and can an arbitrary top-level third-party license file fan out?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["classifyFile", "agent-seed-core.mjs"]
---

# Q: How are Claude manifest paths transformed into target runtimes, and can an arbitrary top-level third-party license file fan out?

## Answer

agent-seed-core.mjs classifyFile accepts only hooks/, commands/, plugins/, rules/, skills/, and agents/; an arbitrary top-level path fails classification. Every portable skills/** source file is emitted beneath each supported target's skills prefix, so a shared license can fan out once by living under a non-discoverable skills/_licenses path, while per-skill LICENSE files fan out once per skill per runtime.

## Outcome

- Signal: useful

## Source Nodes

- classifyFile
- agent-seed-core.mjs