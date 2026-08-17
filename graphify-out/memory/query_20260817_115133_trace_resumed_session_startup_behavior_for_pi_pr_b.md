---
type: "query"
date: "2026-08-17T11:51:33.394374+00:00"
question: "Trace resumed-session startup behavior for Pi PR-boundary review enforcement. Where are ask_user questions generated to acknowledge a head or trigger review, what persisted exact-head state suppresses them, and what could cause the same question to repeat across normal resumed sessions? Focus on existing code only."
contributor: "graphify"
outcome: "useful"
source_nodes: ["review-enforcement.ts", "launchBoundaryPlan", "persistedBoundary"]
---

# Q: Trace resumed-session startup behavior for Pi PR-boundary review enforcement. Where are ask_user questions generated to acknowledge a head or trigger review, what persisted exact-head state suppresses them, and what could cause the same question to repeat across normal resumed sessions? Focus on existing code only.

## Answer

The only prompt is ctx.ui.select in launchBoundaryPlan. While streaming, sendLaunchMessage queues followUp delivery, but pr-boundary-evaluated is persisted immediately and the plan is not yet transcript-visible. Later Git/GitHub commands have new tool-use IDs and prompt again; resume explicitly bypasses same-head plan suppression. Minimal in-place fix: enrich the existing evaluated transcript entry with repo/PR/head disposition, claim one runtime-local exact-head identity before queueing, never bypass a visible same-head plan on resume, and recover accepted-but-undelivered launch or acknowledgement without prompting. Cancellation remains unresolved and may prompt again.

## Outcome

- Signal: useful

## Source Nodes

- review-enforcement.ts
- launchBoundaryPlan
- persistedBoundary