---
type: "query"
date: "2026-06-23T12:10:11.955881+00:00"
question: "Post-upgrade smoke: did graphify 0.8.45 update and query Codeflare's graph successfully?"
contributor: "graphify"
source_nodes: ["scripts_build_graphify_ast"]
---

# Q: Post-upgrade smoke: did graphify 0.8.45 update and query Codeflare's graph successfully?

## Answer

Yes. safe-graphify-update rebuilt graphify-out with 10836 nodes and 19382 edges; local-graphify-labels applied 825 labels and regenerated graph.html plus callflow.html; validation found 0 duplicate node ids and 0 dangling edges; graphify explain build-graphify-ast.sh resolved to preseed/agents/pi/scripts/build-graphify-ast.sh.

## Source Nodes

- scripts_build_graphify_ast