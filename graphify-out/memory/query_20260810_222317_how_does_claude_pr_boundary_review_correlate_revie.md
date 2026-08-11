---
type: "query"
date: "2026-08-10T22:23:17.753680+00:00"
question: "How does Claude PR-boundary review correlate reviewer completion notifications, decide that all lanes returned, and permit the tool-free triage response? Trace spec-reviewer result delivery, Stop hook state, and the fix-turn transition."
contributor: "graphify"
outcome: "useful"
source_nodes: ["claude/agents/spec-reviewer.md", "review-enforcement.ts", "transitionState()"]
---

# Q: How does Claude PR-boundary review correlate reviewer completion notifications, decide that all lanes returned, and permit the tool-free triage response? Trace spec-reviewer result delivery, Stop hook state, and the fix-turn transition.

## Answer

Claude's Stop hook scans raw transcript terminal records in enforce-review-spawn.sh, while native background notifications can reach that transcript before they are delivered to the root model. The corrected lifecycle gives the first newly complete Stop one silent notification-delivery turn, permits Read/TaskOutput recovery, and only then accepts the tool-free triage table. Acknowledged FIX turns now commit and push accepted changes automatically, and git-push-review-reminder plus run-review-lane bind each lane to the PR-specific acknowledged-to-current range so successful delivery pushes auto-launch one incremental reviewer wave and one CI monitor without renewed consent or duplicate relaunches.

## Outcome

- Signal: useful

## Source Nodes

- claude/agents/spec-reviewer.md
- review-enforcement.ts
- transitionState()