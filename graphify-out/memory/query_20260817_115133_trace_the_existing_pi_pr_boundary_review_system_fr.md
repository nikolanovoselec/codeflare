---
type: "query"
date: "2026-08-17T11:51:33.234165+00:00"
question: "Trace the existing Pi PR-boundary review system from git push or PR create through initial review-plan delivery, reviewer/CI launch recording, settled reminder recovery, triage acknowledgement, and queued FIX follow-up. Focus on review-enforcement.ts and existing persistence/state files. Identify conditions where a reminder or FIX follow-up can fail to fire."
contributor: "graphify"
outcome: "useful"
source_nodes: ["review-enforcement.ts", "review-helpers.ts", "launchBoundaryPlan", "acknowledgeCompletedReview"]
---

# Q: Trace the existing Pi PR-boundary review system from git push or PR create through initial review-plan delivery, reviewer/CI launch recording, settled reminder recovery, triage acknowledgement, and queued FIX follow-up. Focus on review-enforcement.ts and existing persistence/state files. Identify conditions where a reminder or FIX follow-up can fail to fire.

## Answer

Proven gaps are lifecycle durability, not missing architecture: failed-but-side-effectful gh pr create results are discarded; pr-boundary-evaluated is persisted before queued followUp plans become transcript-visible; latest raw Git candidates can hide the latest completed review window from acknowledgement; checkout startup of an existing session is classified as startup rather than resume; and ACK can be written before FIX followUp is durable. Minimal fixes reuse currentReview, TranscriptFacts, existing custom entries, ACK files, and agent_settled recovery: reconcile only ambiguous PR-create errors, record exact-head evaluated disposition, preserve latest review window separately, recognize existing-session startup, and resend a proven ACK-written/FIX-missing handoff once.

## Outcome

- Signal: useful

## Source Nodes

- review-enforcement.ts
- review-helpers.ts
- launchBoundaryPlan
- acknowledgeCompletedReview