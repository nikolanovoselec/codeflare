---
type: "query"
date: "2026-08-03T00:14:19.679202+00:00"
question: "why isnt pr boundary reviews triggering?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["registerReviewEnforcement()", "classifyReviewBoundaryCommand()", "boundaryContext()"]
---

# Q: why isnt pr boundary reviews triggering?

## Answer

The PR and push commands used a multi-line shell block with 'cd /tmp/codeflare-deps' followed by the boundary command on the next line. active-repo-memory.ts updates the effective cwd only when cd is chained with &&; a newline-separated cd marks later invocations uncertain. resolveShellInvocationRepo() then returns undefined, so registerReviewEnforcement() exits before querying the protected PR or sending pr-boundary-launch-plan. Use the tool cwd parameter or 'cd /tmp/codeflare-deps && git push ...' for future boundaries.

## Outcome

- Signal: useful

## Source Nodes

- registerReviewEnforcement()
- classifyReviewBoundaryCommand()
- boundaryContext()