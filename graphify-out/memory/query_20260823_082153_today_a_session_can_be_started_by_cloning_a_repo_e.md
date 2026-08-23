---
type: "query"
date: "2026-08-23T08:21:53.065860+00:00"
question: "today a session can be started by cloning a repo e.g. into pi. when start session is stopped storage is wiped (ephemeral). restarting a stopped session like that means it comes up without the repo that was used to create it. can we make it so that resuming a session created by a clone also re-clones the repo?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["ClonePickerNewSession()", "Session", "container/lifecycle.ts", "container"]
---

# Q: today a session can be started by cloning a repo e.g. into pi. when start session is stopped storage is wiped (ephemeral). restarting a stopped session like that means it comes up without the repo that was used to create it. can we make it so that resuming a session created by a clone also re-clones the repo?

## Answer

Yes. Clone-created sessions already persist the validated repository and optional ref in the Session record in KV, and the Worker forwards them on each start. The gap is the idempotent Durable Object reconfiguration path: after a wake it keeps the persisted bucket identity but ignores the re-sent memory-only clone fields, so GIT_CLONE_REPO is absent from the new container. Reapplying those fields in memory on restart lets the established entrypoint clone a missing ephemeral workspace before agent startup; its existing collision guard leaves a restored or still-present workspace untouched. Credentials remain on the existing per-start injection path and are not added to persisted clone metadata.

## Outcome

- Signal: useful

## Source Nodes

- ClonePickerNewSession()
- Session
- container/lifecycle.ts
- container