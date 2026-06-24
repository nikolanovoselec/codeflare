---
type: "smoke-test"
date: "2026-06-23T12:21:47.921759+00:00"
question: "Smoke test: where are Pi Graphify native tools and safe update workflow implemented?"
contributor: "graphify"
source_nodes: ["graphify-native.ts", "graphify-helpers.ts", "safe-graphify-update.sh"]
---

# Q: Smoke test: where are Pi Graphify native tools and safe update workflow implemented?

## Answer

Graphify exact-node smoke succeeded against graphify-out/graph.json after rebuild. graphify_query('graphify-native.ts') found preseed/agents/pi/extensions/graphify-native.ts plus related helpers; graphify_explain('graphify-native.ts') resolved node ID extensions_graphify_native with resolveGraph, runGraphify, runResolved, repoGraphCandidate, and execute; graphify_path('graphify-native.ts','graphify-helpers.ts') returned a one-hop imports_from path. A broad natural-language query for key files was less useful and should be narrowed or use exact node labels.

## Source Nodes

- graphify-native.ts
- graphify-helpers.ts
- safe-graphify-update.sh