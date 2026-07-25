---
type: "query"
date: "2026-07-23T17:29:51.089868+00:00"
question: "Why can Pi PR-boundary triage finish without acknowledgement or a FIX follow-up?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["review-enforcement.ts", "reviewTranscriptFacts()", "sendFixFollowUp()", "REQ-AGENT-098: Pi Review Triage Acknowledgement Barrier"]
---

# Q: Why can Pi PR-boundary triage finish without acknowledgement or a FIX follow-up?

## Answer

The review extension records the protected PR boundary and launches reviewer lanes. acknowledgeCompletedReview acknowledges only when reviewTranscriptFacts reports every required lane terminal and finds a structural triage table after the last terminal result, then sendFixFollowUp emits the separate FIX turn. The parser currently treats only native subagent-notification custom messages as terminal. When the root waits through get_subagent_result, those successful public tool results can be the only durable completion evidence, so the lanes remain in-flight, the acknowledgement SHA stays stale, and no FIX follow-up is sent. Terminal correlation must accept both native success notifications and successful get_subagent_result results bound to the exact launched agent and lane.

## Outcome

- Signal: useful

## Source Nodes

- review-enforcement.ts
- reviewTranscriptFacts()
- sendFixFollowUp()
- REQ-AGENT-098: Pi Review Triage Acknowledgement Barrier